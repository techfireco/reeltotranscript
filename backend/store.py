"""Persistent admission control for the single application instance."""
import hashlib
import secrets
import sqlite3
import time
from contextlib import contextmanager
from datetime import datetime
from zoneinfo import ZoneInfo

IST = ZoneInfo("Asia/Kolkata")


class Problem(Exception):
    def __init__(self, status, message):
        self.status = status
        super().__init__(message)


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def today():
    return datetime.now(IST).date().isoformat()


class Store:
    def __init__(self, path):
        self.path = path
        with self.connection() as db:
            db.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, owner TEXT, expires INTEGER);
                CREATE TABLE IF NOT EXISTS limits(bucket TEXT PRIMARY KEY, count INTEGER, expires INTEGER);
                CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, owner TEXT, day TEXT, request_id TEXT,
                    state TEXT, created INTEGER, UNIQUE(owner, request_id));
                CREATE INDEX IF NOT EXISTS owner_day ON jobs(owner, day);
                UPDATE jobs SET state='failed' WHERE state='running';
            """)

    @contextmanager
    def connection(self):
        db = sqlite3.connect(self.path, timeout=5)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def session(self, token):
        with self.connection() as db:
            row = db.execute("SELECT owner FROM sessions WHERE token=? AND expires>?",
                             (digest(token), time.time())).fetchone()
            return row["owner"] if row else None

    def login(self, subject):
        token = secrets.token_urlsafe(32)
        with self.connection() as db:
            db.execute("INSERT INTO sessions VALUES (?, ?, ?)",
                       (digest(token), digest("google:" + subject), time.time() + 7 * 86400))
        return token

    def logout(self, token):
        with self.connection() as db:
            db.execute("DELETE FROM sessions WHERE token=?", (digest(token),))

    def rate(self, key, limit, seconds):
        now = int(time.time())
        with self.connection() as db:
            result = db.execute("""
                INSERT INTO limits VALUES (?, 1, ?) ON CONFLICT(bucket) DO UPDATE SET
                count=CASE WHEN expires<=? THEN 1 ELSE count+1 END,
                expires=CASE WHEN expires<=? THEN excluded.expires ELSE expires END
                WHERE expires<=? OR count<? RETURNING count
            """, (key, now + seconds, now, now, now, limit)).fetchone()
            if not result:
                raise Problem(429, "Too many requests. Please try again later.")

    def remaining(self, owner):
        with self.connection() as db:
            used = self.used(db, owner, today())
        return max(0, 3 - used)

    @staticmethod
    def used(db, owner, day):
        return db.execute("SELECT count(*) FROM jobs WHERE owner=? AND day=? AND state IN ('done','running')",
                          (owner, day)).fetchone()[0]

    def reserve(self, owner, key):
        day = today()
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            prior = db.execute("SELECT id FROM jobs WHERE owner=? AND request_id=?", (owner, key)).fetchone()
            if prior:
                return prior[0], False
            if self.used(db, owner, day) >= 3:
                raise Problem(429, "Your three daily transcriptions are used. Try again after midnight IST.")
            if db.execute("SELECT 1 FROM jobs WHERE owner=? AND state='running'", (owner,)).fetchone():
                raise Problem(409, "A transcription is already running for this account.")
            if db.execute("SELECT count(*) FROM jobs WHERE state='running'").fetchone()[0] >= 2:
                raise Problem(503, "Both transcription slots are busy. Try again shortly.")
            job = secrets.token_hex(16)
            db.execute("INSERT INTO jobs VALUES (?,?,?,?,?,?)", (job, owner, day, key, "running", time.time()))
            return job, True

    def find(self, owner, job):
        with self.connection() as db:
            return db.execute("SELECT state FROM jobs WHERE id=? AND owner=?", (job, owner)).fetchone()

    def finish(self, job, state):
        with self.connection() as db:
            db.execute("UPDATE jobs SET state=? WHERE id=? AND state='running'", (state, job))

    def prune(self):
        now = time.time()
        with self.connection() as db:
            db.execute("DELETE FROM limits WHERE expires<=?", (now,))
            db.execute("DELETE FROM sessions WHERE expires<=?", (now,))
            db.execute("DELETE FROM jobs WHERE created<? AND state!='running'", (now - 2 * 86400,))
