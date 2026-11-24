"""Media processing subprocess. Only transcript text and timing information go to stdout."""
import json
import os
import re
import resource
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlsplit

MAX_BYTES = 25 * 1024 * 1024
MAX_SECONDS = 180


def canonical_url(raw):
    if not isinstance(raw, str) or len(raw) > 2048:
        raise ValueError
    parts = urlsplit(raw.strip())
    if parts.scheme != "https" or parts.netloc != parts.hostname:
        raise ValueError
    rules = [
        (("instagram.com", "www.instagram.com"), r"/(reels?|p)/([\w-]{1,64})/?", "www.instagram.com"),
        (("youtube.com", "www.youtube.com", "m.youtube.com"), r"/(shorts)/([\w-]{11})/?", "www.youtube.com"),
        (("youtu.be",), r"/([\w-]{11})/?", "www.youtube.com"),
        (("tiktok.com", "www.tiktok.com"), r"/(@[\w.]{1,32}/video)/(\d{1,24})/?", "www.tiktok.com"),
    ]
    for hosts, pattern, host in rules:
        match = re.fullmatch(pattern, parts.path, re.ASCII)
        if parts.hostname in hosts and match:
            groups = match.groups()
            if len(groups) == 2:
                prefix, code = groups
                return f"https://{host}/{'reel' if prefix == 'reels' else prefix}/{code}/"
            else:
                code = groups[0]
                return f"https://{host}/shorts/{code}/"
    raise ValueError


def command(args, timeout):
    subprocess.run(args, check=True, timeout=timeout, stdin=subprocess.DEVNULL,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def process(folder, url):
    resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_BYTES, MAX_BYTES))
    media = folder / "input"
    if url:
        platform_args = ["--impersonate", "chrome"] if urlsplit(url).hostname == "www.instagram.com" else []
        command(["yt-dlp", *platform_args, "--ignore-config", "--no-playlist", "--no-cache-dir",
                 "--socket-timeout", "12", "--retries", "1", "--max-filesize", str(MAX_BYTES),
                 "--match-filter", f"!is_live & duration <=? {MAX_SECONDS}", "--no-part",
                 "-f", "ba[protocol=https]/b[acodec!=none][protocol=https]",
                 "-o", str(media), "--", canonical_url(url)], 70)
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
    from faster_whisper import WhisperModel
    model = WhisperModel(os.environ.get("WHISPER_MODEL", "base"), device="cpu",
                         compute_type="int8", cpu_threads=2, local_files_only=True)
    segments, _ = model.transcribe(str(wav), beam_size=1, vad_filter=True)
    chunks = [{"timestamp": [s.start, s.end], "text": s.text.strip()} for s in segments if s.text.strip()]
    if not chunks:
        raise ValueError
    return {"text": " ".join(s["text"] for s in chunks), "chunks": chunks}


if __name__ == "__main__":
    try:
        print(json.dumps(process(Path(sys.argv[1]), sys.argv[2])))
    except Exception as e:
        import traceback
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)
