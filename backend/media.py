"""Media processing subprocess. Only transcript text and timing information go to stdout."""
import html
import http.cookiejar
import json
import os
import re
import resource
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import urlsplit

MAX_BYTES = 25 * 1024 * 1024
MAX_SECONDS = 180
YOUTUBE_ID_RE = re.compile(r"[\w-]{11}", re.ASCII)

LANGUAGE_MODELS = {
    "auto": ("WHISPER_MODEL", "base", None),
    "en": ("WHISPER_MODEL", "base", "en"),
    "hi": ("WHISPER_MODEL_HI", "collabora/faster-whisper-small-hindi", "hi"),
    "hinglish": ("WHISPER_MODEL_HINGLISH", "abhayhadez/anchor-hinglish-apex-ct2", "en"),
}

USER_ERRORS = {
    "YOUTUBE_BOT_CHECK": (
        "YouTube blocked automated requests from this cloud server IP. "
        "Add SUPADATA_API_KEY, YOUTUBE_PROXY, or /data/cookies.txt in Coolify, or upload the video file."
    ),
    "YOUTUBE_NO_CAPTIONS": (
        "This YouTube video does not have captions available, and exceeds the 3-minute limit for AI audio transcription."
    ),
    "YOUTUBE_UNAVAILABLE": "Could not access this YouTube video. Make sure it is public.",
}


class MediaError(Exception):
    """Controlled user-facing media failure safe to surface in API responses."""


def validate_language(raw):
    if raw is None or raw == "":
        return "auto"
    if not isinstance(raw, str) or raw not in LANGUAGE_MODELS:
        raise ValueError
    return raw


def extract_youtube_id(url):
    if not url:
        return None
    parts = urlsplit(url)
    host = (parts.hostname or "").lower()
    if host == "youtu.be":
        m = re.fullmatch(r"/([\w-]{11})/?", parts.path, re.ASCII)
        return m.group(1) if m else None
    if host in ("youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"):
        if parts.path == "/watch":
            vid = urllib.parse.parse_qs(parts.query).get("v", [""])[0]
            return vid if YOUTUBE_ID_RE.fullmatch(vid) else None
        m = re.fullmatch(r"/(?:shorts|live|embed)/([\w-]{11})/?", parts.path, re.ASCII)
        return m.group(1) if m else None
    return None


def canonical_url(raw):
    if not isinstance(raw, str) or len(raw) > 2048:
        raise ValueError
    parts = urlsplit(raw.strip())
    if parts.scheme != "https" or parts.netloc != parts.hostname:
        raise ValueError
    host = (parts.hostname or "").lower()
    if host == "youtu.be":
        match = re.fullmatch(r"/([\w-]{11})/?", parts.path, re.ASCII)
        if match:
            return f"https://www.youtube.com/watch?v={match.group(1)}"
        raise ValueError
    if host in ("youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"):
        if parts.path == "/watch":
            vid = urllib.parse.parse_qs(parts.query).get("v", [""])[0]
            if YOUTUBE_ID_RE.fullmatch(vid):
                return f"https://www.youtube.com/watch?v={vid}"
            raise ValueError
        match = re.fullmatch(r"/(shorts|live|embed)/([\w-]{11})/?", parts.path, re.ASCII)
        if match:
            kind, vid = match.groups()
            if kind == "shorts":
                return f"https://www.youtube.com/shorts/{vid}/"
            return f"https://www.youtube.com/watch?v={vid}"
        raise ValueError
    rules = [
        (("instagram.com", "www.instagram.com"), r"/(reels?|p)/([\w-]{1,64})/?", "www.instagram.com"),
        (("tiktok.com", "www.tiktok.com"), r"/(@[\w.]{1,32}/video)/(\d{1,24})/?", "www.tiktok.com"),
    ]
    for hosts, pattern, canonical_host in rules:
        match = re.fullmatch(pattern, parts.path, re.ASCII)
        if host in hosts and match:
            prefix, code = match.groups()
            return f"https://{canonical_host}/{'reel' if prefix == 'reels' else prefix}/{code}/"
    raise ValueError


TRACK_PREFS = {
    "en": ["en"],
    "hi": ["hi"],
    "hinglish": ["en", "hi"],
    "auto": [],
}

INNERTUBE_CLIENTS = (
    ("IOS", "20.10.4", "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 17_5_1 like Mac OS X;)"),
    ("ANDROID", "20.10.38", "com.google.android.youtube/20.10.38 (Linux; U; Android 14)"),
)


def proxy_url():
    return (os.getenv("YOUTUBE_PROXY") or os.getenv("PROXY_URL") or "").strip()


def build_youtube_opener():
    handlers = []
    proxy = proxy_url()
    if proxy:
        handlers.append(urllib.request.ProxyHandler({"http": proxy, "https": proxy}))
    cookie_file = Path(os.getenv("DATA_DIR", "/data")) / "cookies.txt"
    if cookie_file.is_file():
        jar = http.cookiejar.MozillaCookieJar()
        try:
            jar.load(str(cookie_file), ignore_discard=True, ignore_expires=True)
            handlers.append(urllib.request.HTTPCookieProcessor(jar))
        except Exception:
            pass
    return urllib.request.build_opener(*handlers)


def select_youtube_track(tracks, language):
    if not tracks:
        return None
    prefs = TRACK_PREFS.get(language, [])
    for is_asr in (False, True):
        for target in prefs:
            for track in tracks:
                code = (track.get("languageCode") or "").lower()
                if (track.get("kind") == "asr") == is_asr and (code == target or code.startswith(target + "-")):
                    return track
    for track in tracks:
        if track.get("kind") != "asr":
            return track
    return tracks[0]


def finalize_chunks(raw_cues):
    cleaned = []
    for start, end, text in raw_cues:
        clean = re.sub(r"\s+", " ", html.unescape(text).replace("\n", " ")).strip()
        if clean:
            s = max(0.0, float(start))
            cleaned.append([s, max(float(end), s + 0.2), clean])
    chunks = []
    for idx, (start, end, clean) in enumerate(cleaned):
        if idx + 1 < len(cleaned):
            next_start = cleaned[idx + 1][0]
            if next_start > start and end > next_start:
                end = next_start
        end = max(end, start + 0.2)
        chunks.append({"timestamp": [round(start, 2), round(end, 2)], "text": clean})
    return chunks


def parse_youtube_captions(raw):
    text = raw.lstrip()
    if not text:
        return []
    raw_cues = []
    if text.startswith("{"):
        data = json.loads(text)
        for event in data.get("events", []):
            segs = event.get("segs")
            if not segs:
                continue
            cue = "".join(seg.get("utf8", "") for seg in segs)
            start = event.get("tStartMs", 0) / 1000.0
            dur = max(event.get("dDurationMs", 2000), 200) / 1000.0
            raw_cues.append((start, start + dur, cue))
    elif text.startswith("<"):
        if "<!" in text[:512]:
            raise ValueError("Unsupported XML declaration")
        root = ET.fromstring(text)
        for node in root.iter():
            if node.tag == "p" and "t" in node.attrib:
                start = int(node.attrib["t"]) / 1000.0
                dur = max(int(node.attrib.get("d", 2000)), 200) / 1000.0
                raw_cues.append((start, start + dur, "".join(node.itertext())))
            elif node.tag == "text" and "start" in node.attrib:
                start = float(node.attrib["start"])
                dur = max(float(node.attrib.get("dur", 2.0)), 0.2)
                raw_cues.append((start, start + dur, "".join(node.itertext())))
    return finalize_chunks(raw_cues)


def fetch_supadata_transcript(video_id, language, api_key):
    params = {"url": f"https://www.youtube.com/watch?v={video_id}", "text": "false"}
    if language in ("en", "hi"):
        params["lang"] = language
    endpoint = "https://api.supadata.ai/v1/transcript?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(endpoint, headers={"x-api-key": api_key, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=20) as res:
            payload = json.loads(res.read(4 * 1024 * 1024).decode("utf-8", "ignore"))
    except urllib.error.HTTPError as exc:
        if exc.code in (404, 206):
            return None
        raise MediaError(USER_ERRORS["YOUTUBE_UNAVAILABLE"])
    content = payload.get("content")
    if isinstance(content, list) and content:
        raw_cues = [
            (item.get("offset", 0) / 1000.0, (item.get("offset", 0) + max(item.get("duration", 2000), 200)) / 1000.0, item.get("text", ""))
            for item in content if isinstance(item, dict)
        ]
        chunks = finalize_chunks(raw_cues)
        if chunks:
            return {
                "text": " ".join(c["text"] for c in chunks),
                "chunks": chunks,
                "language": language,
                "detectedLanguage": payload.get("lang"),
                "source": "youtube_captions",
            }
    return None


def fetch_youtube_transcript(video_id, language):
    api_key = os.getenv("SUPADATA_API_KEY", "").strip()
    if api_key:
        supadata = fetch_supadata_transcript(video_id, language, api_key)
        if supadata:
            return supadata

    opener = build_youtube_opener()
    bot_blocked = False
    for cname, cver, ua in INNERTUBE_CLIENTS:
        payload = json.dumps({"context": {"client": {"clientName": cname, "clientVersion": cver}}, "videoId": video_id}).encode()
        req = urllib.request.Request(
            "https://www.youtube.com/youtubei/v1/player?prettyPrint=false",
            data=payload,
            headers={"Content-Type": "application/json", "User-Agent": ua},
        )
        try:
            with opener.open(req, timeout=12) as res:
                player = json.loads(res.read(2 * 1024 * 1024).decode("utf-8", "ignore"))
        except urllib.error.HTTPError as exc:
            if exc.code in (403, 429):
                bot_blocked = True
            continue
        except Exception:
            continue

        ps = player.get("playabilityStatus", {})
        status = ps.get("status")
        if status == "LOGIN_REQUIRED":
            bot_blocked = True
            continue
        if status != "OK":
            continue

        tracks = player.get("captions", {}).get("playerCaptionsTracklistRenderer", {}).get("captionTracks", [])
        duration_sec = int(player.get("videoDetails", {}).get("lengthSeconds") or 0)
        if not tracks:
            if 0 < duration_sec <= MAX_SECONDS:
                return None
            raise MediaError(USER_ERRORS["YOUTUBE_NO_CAPTIONS"])

        track = select_youtube_track(tracks, language)
        base_url = track.get("baseUrl", "")
        parsed = urlsplit(base_url)
        if parsed.scheme != "https" or parsed.hostname not in ("www.youtube.com", "youtube.com"):
            continue
        qs = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
        qs["fmt"] = ["json3"]
        cap_url = urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path, urllib.parse.urlencode(qs, doseq=True), ""))
        try:
            cap_req = urllib.request.Request(cap_url, headers={"User-Agent": ua})
            with opener.open(cap_req, timeout=12) as cap_res:
                chunks = parse_youtube_captions(cap_res.read(4 * 1024 * 1024).decode("utf-8", "ignore"))
        except urllib.error.HTTPError as exc:
            if exc.code in (403, 429):
                bot_blocked = True
            continue
        if chunks:
            return {
                "text": " ".join(c["text"] for c in chunks),
                "chunks": chunks,
                "language": language,
                "detectedLanguage": track.get("languageCode"),
                "source": "youtube_captions",
            }
        if 0 < duration_sec <= MAX_SECONDS:
            return None
        raise MediaError(USER_ERRORS["YOUTUBE_NO_CAPTIONS"])

    if bot_blocked:
        raise MediaError(USER_ERRORS["YOUTUBE_BOT_CHECK"])
    return None


def command(args, timeout):
    res = subprocess.run(args, timeout=timeout, stdin=subprocess.DEVNULL,
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if res.returncode != 0:
        if res.stderr:
            sys.stderr.write(f"[Subprocess {args[0]} Error]: {res.stderr}\n")
        raise subprocess.CalledProcessError(res.returncode, args, output=res.stdout, stderr=res.stderr)


def process(folder, url, language="auto"):
    lang_key = validate_language(language)
    env_name, default_model, whisper_lang = LANGUAGE_MODELS[lang_key]
    canonical = canonical_url(url) if url else ""
    yt_id = extract_youtube_id(canonical)
    if yt_id:
        yt_result = fetch_youtube_transcript(yt_id, lang_key)
        if yt_result:
            return yt_result
    resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_BYTES, MAX_BYTES))
    media = folder / "input"
    if url:
        platform_args = ["--impersonate", "chrome"] if urlsplit(canonical).hostname == "www.instagram.com" else []
        cookie_file = Path(os.getenv("DATA_DIR", "/data")) / "cookies.txt"
        cookie_args = ["--cookies", str(cookie_file)] if cookie_file.is_file() else []
        proxy = proxy_url()
        proxy_args = ["--proxy", proxy] if proxy else []
        command(["yt-dlp", *platform_args, *cookie_args, *proxy_args, "--ignore-config", "--no-playlist", "--no-cache-dir",
                 "--socket-timeout", "12", "--retries", "1", "--max-filesize", str(MAX_BYTES),
                 "--match-filter", f"!is_live & duration <=? {MAX_SECONDS}", "--no-part",
                 "-f", "ba[protocol=https]/b[acodec!=none][protocol=https]",
                 "-o", str(media), "--", canonical], 70)
    if not media.is_file() or not 0 < media.stat().st_size <= MAX_BYTES:
        raise ValueError
    # Restrict the demuxers before probing. Playlists and network protocols are excluded.
    wav = folder / "audio.wav"
    command(["ffmpeg", "-nostdin", "-v", "error", "-xerror", "-protocol_whitelist", "file",
             "-format_whitelist", "mov,matroska,webm,wav,mp3", "-threads", "1", "-i", str(media),
             "-map", "0:a:0", "-vn", "-sn", "-dn", "-map_metadata", "-1", "-ac", "1", "-ar", "16000",
             "-t", str(MAX_SECONDS + 1), "-c:a", "pcm_s16le", str(wav)], 35)
    import wave
    with wave.open(str(wav), "rb") as audio:
        if not 0 < audio.getnframes() <= MAX_SECONDS * audio.getframerate():
            raise ValueError
    model_ref = os.environ.get(env_name) or default_model
    local_only = model_ref.startswith("/") or Path(model_ref).is_dir()
    from faster_whisper import WhisperModel
    model = WhisperModel(model_ref, device="cpu", compute_type="int8",
                         cpu_threads=2, local_files_only=local_only)
    segments, info = model.transcribe(str(wav), language=whisper_lang, beam_size=1, vad_filter=True)
    chunks = [{"timestamp": [s.start, s.end], "text": s.text.strip()} for s in segments if s.text.strip()]
    if not chunks:
        raise ValueError
    return {
        "text": " ".join(s["text"] for s in chunks),
        "chunks": chunks,
        "language": lang_key,
        "detectedLanguage": getattr(info, "language", None),
        "source": "whisper",
    }


if __name__ == "__main__":
    try:
        lang = sys.argv[3] if len(sys.argv) > 3 else "auto"
        print(json.dumps(process(Path(sys.argv[1]), sys.argv[2], lang)))
    except MediaError as exc:
        print(json.dumps({"error": str(exc)}))
        sys.exit(2)
    except Exception:
        import traceback
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)
