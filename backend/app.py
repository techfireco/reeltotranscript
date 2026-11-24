import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, urlopen

from flask import Flask, abort, jsonify, redirect, request, send_from_directory
from werkzeug.exceptions import HTTPException

from .media import MAX_BYTES, canonical_url
from .store import Problem, Store, digest

ROOT = Path(__file__).resolve().parent.parent
SESSION = "__Host-rtt-session"
FLOW = "__Host-rtt-login"
COOKIE = dict(secure=True, httponly=True, samesite="Lax", path="/")
ERROR = "Could not transcribe this clip. Check that it is public, contains speech, and is under three minutes."


def provider_json(endpoint, fields=None, headers=None):
    payload = urlencode(fields).encode() if fields is not None else None
    req = Request(endpoint, data=payload, headers=headers or {})
    try:
        with urlopen(req, timeout=10) as res:
            return json.loads(res.read(65536))
    except Exception:
        raise Problem(503, "Verification is temporarily unavailable. Please try again.")


def challenge(verifier):
    return base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()


def transcribe(folder, url):
    # A timed-out downloader and all its children are killed together.
    child_env = {k: os.environ[k] for k in ("PATH", "HOME", "LANG", "HF_HOME", "WHISPER_MODEL") if k in os.environ}
    proc = subprocess.Popen([sys.executable, "-m", "backend.media", str(folder), url],
                            cwd=ROOT, start_new_session=True, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, env=child_env)
    try:
        data, _ = proc.communicate(timeout=240)
    finally:
        if proc.poll() is None:
            os.killpg(proc.pid, signal.SIGKILL)
            proc.wait()
    if proc.returncode or len(data) > 512_000:
        raise ValueError
    return json.loads(data)


def create_app(settings=None):
    app = Flask(__name__, static_folder=None)
    app.config.update(
        PUBLIC_ORIGIN=os.getenv("PUBLIC_ORIGIN", "https://reeltotranscript.com"),
        DATA_DIR=os.getenv("DATA_DIR", "var"), WORK_DIR=os.getenv("WORK_DIR", "/tmp/rtt-jobs"),
        GOOGLE_CLIENT_ID=os.getenv("GOOGLE_CLIENT_ID"), GOOGLE_CLIENT_SECRET=os.getenv("GOOGLE_CLIENT_SECRET"),
        TURNSTILE_SITE_KEY=os.getenv("TURNSTILE_SITE_KEY"), TURNSTILE_SECRET=os.getenv("TURNSTILE_SECRET"),
        MAX_CONTENT_LENGTH=MAX_BYTES, SEND_FILE_MAX_AGE_DEFAULT=0,
    )
    app.config.update(settings or {})
    cfg = app.config
    dev_mode = bool(os.getenv("DEV_MODE") == "1" or cfg.get("DEV_MODE"))
    origin = urlsplit(cfg["PUBLIC_ORIGIN"])
    if not dev_mode and (origin.scheme != "https" or origin.path or origin.username or origin.query or origin.fragment or not origin.hostname):
        raise ValueError("PUBLIC_ORIGIN must be an HTTPS origin")
    data_dir = Path(cfg["DATA_DIR"])
    data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    store = Store(data_dir / "accounts.sqlite")
    work = Path(cfg["WORK_DIR"])
    work.mkdir(parents=True, exist_ok=True, mode=0o700)
    for stale in work.glob("rtt-*"):
        if stale.is_dir() and not stale.is_symlink():
            shutil.rmtree(stale)
    pool = ThreadPoolExecutor(max_workers=2)
    results = {}
    lock = threading.Lock()

    def maintain():
        store.prune()
        with lock:
            for key, (expiry, _) in list(results.items()):
                if expiry <= time.monotonic():
                    del results[key]

    def sweeper():
        while True:
            time.sleep(30)
            maintain()

    threading.Thread(target=sweeper, daemon=True).start()
    app.extensions["ledger"] = store

    def ready():
        if dev_mode:
            return True
        return all(cfg.get(k) for k in ("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "TURNSTILE_SITE_KEY", "TURNSTILE_SECRET"))

    session_cookie = "rtt-session" if dev_mode else SESSION
    cookie_flags = dict(httponly=True, samesite="Lax", path="/", secure=False if dev_mode else True)

    def account():
        owner = store.session(request.cookies.get(SESSION, "") or request.cookies.get("rtt-session", ""))
        if not owner:
            raise Problem(401, "Please sign in to transcribe.")
        return owner

    @app.before_request
    def boundary():
        if dev_mode:
            return
        if request.host.lower() != origin.netloc.lower():
            abort(400)
        if not request.is_secure and request.headers.get("X-Forwarded-Proto") != "https":
            return redirect(cfg["PUBLIC_ORIGIN"] + request.path, 308)
        if request.method == "POST" and request.headers.get("Origin") != cfg["PUBLIC_ORIGIN"]:
            abort(403)

    @app.after_request
    def headers(response):
        response.headers.update({
            "Content-Security-Policy": "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; "
                "frame-src https://challenges.cloudflare.com; connect-src 'self' https://challenges.cloudflare.com; "
                "style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; "
                "form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests",
            "Strict-Transport-Security": "max-age=31536000",
            "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY",
            "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
            "Cache-Control": "public, max-age=31536000, immutable" if request.path.startswith("/_astro/") and response.status_code == 200 else "no-store",
        })
        return response

    @app.errorhandler(Problem)
    def problem(exc):
        return jsonify(error=str(exc)), exc.status

    @app.errorhandler(HTTPException)
    def http_error(exc):
        if exc.code == 404 and not request.path.startswith(("/api/", "/auth/")):
            return send_from_directory(ROOT / "dist", "404.html"), 404
        messages = {400: "Invalid request.", 403: "Request denied.", 404: "Resource unavailable.",
                    405: "Method unavailable.", 413: "File exceeds the 25 MiB limit."}
        return jsonify(error=messages.get(exc.code, "Request could not be processed.")), exc.code

    @app.errorhandler(Exception)
    def unexpected(_exc):
        app.logger.error("Unexpected request failure")
        return jsonify(error="Service temporarily unavailable."), 503

    @app.get("/api/session")
    def session_info():
        owner = store.session(request.cookies.get(SESSION, "") or request.cookies.get("rtt-session", ""))
        return jsonify(signedIn=bool(owner), available=ready(), remaining=store.remaining(owner) if owner else None,
                       siteKey=("1x00000000000000000000AA" if dev_mode else cfg["TURNSTILE_SITE_KEY"]) if owner else None)

    @app.get("/auth/login")
    def login():
        if not ready():
            return redirect("/?signin=unavailable")
        if dev_mode:
            response = redirect("/?signin=success")
            response.set_cookie(session_cookie, store.login("local-dev-user"), max_age=7 * 86400, **cookie_flags)
            return response
        # The deployment accepts ingress only from its tunnel connector.
        client = request.headers.get("CF-Connecting-IP") or request.remote_addr or "unknown"
        store.rate("login-global", 300, 60)
        store.rate("login:" + digest(client), 15, 300)
        verifier = secrets.token_urlsafe(48)
        params = dict(client_id=cfg["GOOGLE_CLIENT_ID"], redirect_uri=cfg["PUBLIC_ORIGIN"] + "/auth/callback",
                      response_type="code", scope="openid email", state=digest("state:" + verifier),
                      code_challenge=challenge(verifier), code_challenge_method="S256")
        response = redirect("https://accounts.google.com/o/oauth2/v2/auth?" + urlencode(params))
        response.set_cookie(FLOW, verifier, max_age=600, **COOKIE)
        return response

    @app.get("/auth/callback")
    def callback():
        verifier = request.cookies.get(FLOW, "")
        state = request.args.get("state", "")
        code = request.args.get("code", "")
        response = redirect("/?signin=failed")
        response.delete_cookie(FLOW, **COOKIE)
        if not ready() or not verifier or not code or len(code) > 4096 or not hmac.compare_digest(
                state.encode(), digest("state:" + verifier).encode()):
            return response
        try:
            tokens = provider_json("https://oauth2.googleapis.com/token", dict(
                code=code, client_id=cfg["GOOGLE_CLIENT_ID"], client_secret=cfg["GOOGLE_CLIENT_SECRET"],
                redirect_uri=cfg["PUBLIC_ORIGIN"] + "/auth/callback", code_verifier=verifier, grant_type="authorization_code"))
            profile = provider_json("https://openidconnect.googleapis.com/v1/userinfo",
                                    headers={"Authorization": "Bearer " + tokens["access_token"]})
            if profile.get("email_verified") is not True or not isinstance(profile.get("sub"), str) or not profile["sub"]:
                return response
            store.logout(request.cookies.get(SESSION, ""))
            response.headers["Location"] = "/"
            response.set_cookie(SESSION, store.login(profile["sub"]), max_age=7 * 86400, **COOKIE)
        except (Problem, KeyError):
            pass
        return response

    @app.post("/auth/logout")
    def logout():
        store.logout(request.cookies.get(SESSION, "") or request.cookies.get("rtt-session", ""))
        response = jsonify(ok=True)
        response.delete_cookie(session_cookie, **cookie_flags)
        return response

    def run(job, folder, url):
        state = "failed"
        try:
            result = transcribe(folder, url)
            with lock:
                results[job] = (time.monotonic() + 900, result)
            state = "done"
        except Exception:
            pass
        finally:
            shutil.rmtree(folder, ignore_errors=True)
            store.finish(job, state)

    @app.post("/api/transcriptions")
    def submit():
        owner = account()
        store.rate("submit:" + owner, 10, 600)
        key = request.headers.get("Idempotency-Key", "")
        if not re.fullmatch(r"[a-zA-Z0-9-]{16,64}", key):
            abort(400)
        mime = request.mimetype
        url = ""
        if mime == "application/json":
            if request.content_length is None or request.content_length > 4096:
                abort(413)
            body = request.get_json()
            try:
                url = canonical_url(body.get("url") if isinstance(body, dict) else None)
            except ValueError:
                raise Problem(400, "Enter a public Instagram Reel, TikTok video or YouTube Shorts link.")
        elif mime != "application/octet-stream":
            raise Problem(415, "Choose a supported audio or video file.")
        elif request.content_length is None or not 0 < request.content_length <= MAX_BYTES:
            raise Problem(413, "Choose a file of up to 25 MiB.")
        token = request.headers.get("X-Challenge-Token", "")
        if not dev_mode:
            if not ready() or not 0 < len(token) <= 2048:
                raise Problem(403, "Complete the verification and try again.")
            verify = provider_json("https://challenges.cloudflare.com/turnstile/v0/siteverify",
                                   dict(secret=cfg["TURNSTILE_SECRET"], response=token))
            if verify.get("success") is not True or verify.get("hostname") != origin.hostname or verify.get("action") != "transcribe":
                raise Problem(403, "Verification expired. Please try again.")
        job, fresh = store.reserve(owner, key)
        if fresh:
            folder = None
            try:
                folder = Path(tempfile.mkdtemp(prefix="rtt-", dir=work))
                if not url:
                    with (folder / "input").open("xb") as out:
                        shutil.copyfileobj(request.stream, out, 64 * 1024)
                pool.submit(run, job, folder, url)
            except Exception:
                if folder:
                    shutil.rmtree(folder, ignore_errors=True)
                store.finish(job, "failed")
                raise
        return jsonify(id=job), 202

    @app.get("/api/transcriptions/<job>")
    def status(job):
        owner = account()
        store.rate("poll:" + owner, 120, 60)
        row = store.find(owner, job)
        if not row:
            abort(404)
        if row["state"] == "done":
            with lock:
                expires, result = results.get(job, (0, None))
            if expires <= time.monotonic():
                raise Problem(410, "This transcript has expired.")
            return jsonify(state="done", **result, remaining=store.remaining(owner))
        return jsonify(state=row["state"], error=ERROR if row["state"] == "failed" else None,
                       remaining=store.remaining(owner))

    @app.get("/")
    @app.get("/<path:path>")
    def site(path=""):
        if path.rstrip("/") == "reel-audio-extractor":
            return redirect("/instagram-reel-to-text/", 301)
        if path.startswith(("api/", "auth/")):
            abort(404)
        dist = ROOT / "dist"
        if not path or re.fullmatch(r"[a-z0-9-]+/?", path):
            file = dist / path / "index.html"
            if file.is_file():
                return send_from_directory(dist, file.relative_to(dist))
        if path.startswith("_astro/") or path in {"theme.js", "favicon.svg", "robots.txt", "sitemap-0.xml", "sitemap-index.xml"}:
            return send_from_directory(dist, path)
        abort(404)

    return app
