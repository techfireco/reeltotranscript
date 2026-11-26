import secrets
import tempfile
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

from backend.app import SESSION, create_app
from backend.media import canonical_url, extract_youtube_id, parse_youtube_captions, select_youtube_track, validate_language
from backend.store import Problem

ORIGIN = "https://example.test"


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.app = create_app(dict(DATA_DIR=self.temp.name, WORK_DIR=self.temp.name + "/jobs",
                                   PUBLIC_ORIGIN=ORIGIN, GOOGLE_CLIENT_ID="test", GOOGLE_CLIENT_SECRET="test",
                                   TURNSTILE_SITE_KEY="test", TURNSTILE_SECRET="test"))
        self.db = self.app.extensions["ledger"]
        self.client = self.app.test_client()

    def sign_in(self, client, subject="reader"):
        login = client.get("/auth/login", base_url=ORIGIN)
        state = parse_qs(urlsplit(login.location).query)["state"][0]
        profile = {"email_verified": True, "sub": subject}
        with patch("backend.app.provider_json", side_effect=[{"access_token": "test"}, profile]):
            result = client.get("/auth/callback", query_string={"state": state, "code": "test"}, base_url=ORIGIN)
        self.assertEqual(result.location, "/")
        self.assertIn("HttpOnly", str(result.headers))
        self.assertIn("Secure", str(result.headers))

    def submit(self, client, key=None):
        return client.post("/api/transcriptions", base_url=ORIGIN, json={"url": "https://www.instagram.com/reels/Example/"},
                           headers={"Origin": ORIGIN, "Idempotency-Key": key or secrets.token_hex(16),
                                    "X-Challenge-Token": "test"})

    def poll(self, client, job):
        for _ in range(100):
            res = client.get("/api/transcriptions/" + job, base_url=ORIGIN)
            if res.json["state"] != "running":
                return res.json
            time.sleep(0.01)
        self.fail("Job did not finish")

    def test_login_permissions_and_public_routes(self):
        self.assertEqual(self.submit(self.client).status_code, 401)
        self.assertEqual(self.client.get("/api/session", base_url=ORIGIN).json["signedIn"], False)
        self.assertEqual(self.client.post("/auth/logout", base_url=ORIGIN).status_code, 403)
        for path in ("/admin", "/api/resolve-reel", "/api/stream", "/missing-page"):
            res = self.client.get(path, base_url=ORIGIN)
            self.assertEqual(res.status_code, 404)
            self.assertNotIn("Access-Control-Allow-Origin", res.headers)
            res.close()
        res = self.client.get("/", base_url=ORIGIN.replace("https:", "http:"))
        self.assertEqual(res.status_code, 308)
        self.assertTrue(res.location.startswith(ORIGIN))
        self.assertIn("frame-ancestors 'none'", res.headers["Content-Security-Policy"])
        self.assertEqual(self.client.get("/auth/callback?code=test", base_url=ORIGIN).location, "/?signin=failed")

    def test_account_quota_results_and_retries(self):
        other_browser = self.app.test_client()
        unrelated = self.app.test_client()
        self.sign_in(self.client)
        self.sign_in(other_browser)
        self.sign_in(unrelated, "different")
        with patch("backend.app.provider_json", return_value=dict(success=True, hostname="example.test", action="transcribe")), \
             patch("backend.app.transcribe", return_value={"text": "Hello", "chunks": []}):
            first_key = secrets.token_hex(16)
            res = self.submit(self.client, first_key)
            self.assertEqual(res.status_code, 202)
            job = res.json["id"]
            self.assertEqual(self.poll(self.client, job)["text"], "Hello")
            self.assertEqual(self.submit(other_browser, first_key).json["id"], job)
            self.assertEqual(unrelated.get("/api/transcriptions/" + job, base_url=ORIGIN).status_code, 404)
            for client in (other_browser, self.client):
                self.poll(client, self.submit(client).json["id"])
            self.assertEqual(self.submit(other_browser).status_code, 429)
            self.assertEqual(unrelated.get("/api/session", base_url=ORIGIN).json["remaining"], 3)
        self.client.post("/auth/logout", base_url=ORIGIN, headers={"Origin": ORIGIN})
        self.assertFalse(self.client.get("/api/session", base_url=ORIGIN).json["signedIn"])

    def test_challenge_validation_and_failure_refund(self):
        self.sign_in(self.client)
        with patch("backend.app.provider_json", return_value={"success": False}):
            self.assertEqual(self.submit(self.client).status_code, 403)
        with patch("backend.app.provider_json", return_value=dict(success=True, hostname="example.test", action="transcribe")), \
             patch("backend.app.transcribe", side_effect=ValueError):
            job = self.submit(self.client).json["id"]
            self.assertEqual(self.poll(self.client, job)["remaining"], 3)
            self.assertEqual(list((Path(self.temp.name) / "jobs").iterdir()), [])

    def test_racing_the_last_credit_and_midnight_rollover(self):
        for _ in range(2):
            job, _ = self.db.reserve("owner", secrets.token_hex(16))
            self.db.finish(job, "done")
        def attempt(_):
            try:
                job, _ = self.db.reserve("owner", secrets.token_hex(16))
                self.db.finish(job, "done")
                return True
            except Problem:
                return False
        with ThreadPoolExecutor(max_workers=8) as pool:
            self.assertEqual(sum(pool.map(attempt, range(12))), 1)
        self.assertEqual(self.db.remaining("owner"), 0)
        with patch("backend.store.today", return_value="2099-01-01"):
            self.assertEqual(self.db.remaining("owner"), 3)

    def test_language_selection_validation_and_dispatch(self):
        self.assertEqual(validate_language(None), "auto")
        self.assertEqual(validate_language(""), "auto")
        for lang in ("auto", "en", "hi", "hinglish"):
            self.assertEqual(validate_language(lang), lang)
        with self.assertRaises(ValueError):
            validate_language("fr-invalid")

        self.sign_in(self.client)
        seen = []

        def fake_transcribe(folder, url, language="auto"):
            seen.append((url, language))
            return {"text": "Kal subah meeting hai", "chunks": [], "language": language}

        with patch("backend.app.provider_json", return_value=dict(success=True, hostname="example.test", action="transcribe")), \
             patch("backend.app.transcribe", side_effect=fake_transcribe):
            bad = self.client.post("/api/transcriptions?language=invalid", base_url=ORIGIN,
                                   json={"url": "https://www.instagram.com/reels/Example/"},
                                   headers={"Origin": ORIGIN, "Idempotency-Key": secrets.token_hex(16),
                                            "X-Challenge-Token": "test"})
            self.assertEqual(bad.status_code, 400)
            self.assertEqual(self.client.get("/api/session", base_url=ORIGIN).json["remaining"], 3)

            res1 = self.client.post("/api/transcriptions?language=hinglish", base_url=ORIGIN,
                                    json={"url": "https://www.instagram.com/reels/Example/"},
                                    headers={"Origin": ORIGIN, "Idempotency-Key": secrets.token_hex(16),
                                             "X-Challenge-Token": "test"})
            self.assertEqual(res1.status_code, 202)
            self.assertEqual(self.poll(self.client, res1.json["id"])["language"], "hinglish")

            res2 = self.client.post("/api/transcriptions?language=hi", base_url=ORIGIN,
                                    data=b"FAKEVIDEO", content_type="application/octet-stream",
                                    headers={"Origin": ORIGIN, "Idempotency-Key": secrets.token_hex(16),
                                             "X-Challenge-Token": "test"})
            self.assertEqual(res2.status_code, 202)
            self.assertEqual(self.poll(self.client, res2.json["id"])["language"], "hi")

        self.assertEqual(seen, [("https://www.instagram.com/reel/Example/", "hinglish"), ("", "hi")])

    def test_youtube_url_parsing_track_selection_and_captions(self):
        self.assertEqual(canonical_url("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s"), "https://www.youtube.com/watch?v=dQw4w9WgXcQ")
        self.assertEqual(canonical_url("https://youtu.be/dQw4w9WgXcQ?si=share123"), "https://www.youtube.com/watch?v=dQw4w9WgXcQ")
        self.assertEqual(canonical_url("https://www.youtube.com/live/dQw4w9WgXcQ"), "https://www.youtube.com/watch?v=dQw4w9WgXcQ")
        self.assertEqual(canonical_url("https://www.youtube.com/shorts/jNQXAC9IVRw"), "https://www.youtube.com/shorts/jNQXAC9IVRw/")
        self.assertEqual(extract_youtube_id("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), "dQw4w9WgXcQ")
        self.assertEqual(extract_youtube_id("https://www.instagram.com/reel/Example/"), None)
        with self.assertRaises(ValueError):
            canonical_url("https://www.youtube.com/watch?v=bad")

        tracks = [
            {"languageCode": "hi", "kind": "asr", "baseUrl": "https://www.youtube.com/api/timedtext?v=x&lang=hi"},
            {"languageCode": "en", "baseUrl": "https://www.youtube.com/api/timedtext?v=x&lang=en"},
        ]
        self.assertEqual(select_youtube_track(tracks, "hi")["languageCode"], "hi")
        self.assertEqual(select_youtube_track(tracks, "en")["languageCode"], "en")
        self.assertEqual(select_youtube_track(tracks, "auto")["languageCode"], "en")

        json3 = '{"events":[{"tStartMs":1000,"dDurationMs":6000,"segs":[{"utf8":"Hello "},{"utf8":"world\\n"}]},{"tStartMs":2500,"aAppend":1,"segs":[{"utf8":"\\n"}]},{"tStartMs":3000,"dDurationMs":2000,"segs":[{"utf8":"Next &amp; line"}]}]}'
        chunks = parse_youtube_captions(json3)
        self.assertEqual(chunks, [
            {"timestamp": [1.0, 3.0], "text": "Hello world"},
            {"timestamp": [3.0, 5.0], "text": "Next & line"},
        ])

        xml_tt3 = '<?xml version="1.0" encoding="utf-8" ?><timedtext format="3"><body><p t="1500" d="1000"><s>First line</s></p></body></timedtext>'
        self.assertEqual(parse_youtube_captions(xml_tt3), [{"timestamp": [1.5, 2.5], "text": "First line"}])
        with self.assertRaises(ValueError):
            parse_youtube_captions('<!DOCTYPE foo><text start="0" dur="1">hi</text>')

    def test_safe_problem_message_surfaced_on_failure(self):
        self.sign_in(self.client)
        with patch("backend.app.provider_json", return_value=dict(success=True, hostname="example.test", action="transcribe")), \
             patch("backend.app.transcribe", side_effect=Problem(422, "Custom safe error")):
            job = self.submit(self.client).json["id"]
            res = self.poll(self.client, job)
            self.assertEqual(res["state"], "failed")
            self.assertEqual(res["error"], "Custom safe error")
            self.assertEqual(res["remaining"], 3)
