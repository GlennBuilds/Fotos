"""Lokale testserver: serveert docs/ en een test-API (zelfde gedrag als worker/index.js) met SQLite."""
import json
import re
import sqlite3
import time
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

PHOTO_RE = re.compile(r"^[a-z0-9-]{1,80}/[a-z0-9-]{1,40}$")
ALBUM_RE = re.compile(r"^[a-z0-9-]{1,80}$")


def db_open(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(str(path), check_same_thread=False)
    schema = (Path(__file__).resolve().parent.parent / "worker" / "schema.sql").read_text()
    db.executescript(schema)
    return db


class Handler(SimpleHTTPRequestHandler):
    db = None

    def log_message(self, fmt, *args):
        pass

    def send_json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        try:
            return json.loads(self.rfile.read(n) or b"{}")
        except ValueError:
            return {}

    def do_GET(self):
        u = urlparse(self.path)
        if not u.path.startswith("/api/"):
            # GitHub Pages draait onder /Fotos/: lokaal serveren we vanaf /
            return super().do_GET()
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        route = u.path[4:]
        if route == "/stats":
            album, client = q.get("album", ""), q.get("client", "")
            if not ALBUM_RE.match(album):
                return self.send_json(400, {"error": "Ongeldig album"})
            likes = dict(self.db.execute("SELECT photo, COUNT(*) FROM likes WHERE album=? GROUP BY photo", (album,)))
            com = dict(self.db.execute("SELECT photo, COUNT(*) FROM comments WHERE album=? AND hidden=0 GROUP BY photo", (album,)))
            mine = [r[0] for r in self.db.execute("SELECT photo FROM likes WHERE album=? AND client=?", (album, client))]
            return self.send_json(200, {"likes": likes, "comments": com, "mine": mine})
        if route == "/comments":
            photo = q.get("photo", "")
            if not PHOTO_RE.match(photo):
                return self.send_json(400, {"error": "Ongeldige foto"})
            rows = self.db.execute("SELECT id, name, text, created FROM comments WHERE photo=? AND hidden=0 ORDER BY created", (photo,))
            return self.send_json(200, {"comments": [dict(zip(("id", "name", "text", "created"), r)) for r in rows]})
        return self.send_json(404, {"error": "Niet gevonden"})

    def do_POST(self):
        route = urlparse(self.path).path[4:]
        b = self.body()
        photo, client = str(b.get("photo", "")), str(b.get("client", ""))[:64]
        if not PHOTO_RE.match(photo) or len(client) < 8:
            return self.send_json(400, {"error": "Ongeldig verzoek"})
        album = photo.split("/")[0]
        now = int(time.time() * 1000)
        if route == "/like":
            cur = self.db.execute("DELETE FROM likes WHERE photo=? AND client=?", (photo, client))
            liked = cur.rowcount == 0
            if liked:
                self.db.execute("INSERT INTO likes (photo, album, client, created) VALUES (?,?,?,?)", (photo, album, client, now))
            self.db.commit()
            n = self.db.execute("SELECT COUNT(*) FROM likes WHERE photo=?", (photo,)).fetchone()[0]
            return self.send_json(200, {"count": n, "liked": liked})
        if route == "/comments":
            if b.get("website"):
                return self.send_json(200, {"ok": True})
            name, text = str(b.get("name", "")).strip()[:40], str(b.get("text", "")).strip()[:1000]
            if not name or not text:
                return self.send_json(400, {"error": "Vul je naam en een reactie in."})
            recent = self.db.execute("SELECT COUNT(*) FROM comments WHERE client=? AND created>?", (client, now - 600000)).fetchone()[0]
            if recent >= 8:
                return self.send_json(429, {"error": "Even rustig aan — probeer het zo nog eens."})
            cur = self.db.execute("INSERT INTO comments (photo, album, name, text, client, created) VALUES (?,?,?,?,?,?)",
                                  (photo, album, name, text, client, now))
            self.db.commit()
            return self.send_json(200, {"comment": {"id": cur.lastrowid, "name": name, "text": text, "created": now}})
        return self.send_json(404, {"error": "Niet gevonden"})


def serve(out_dir, port, db_path):
    Handler.db = db_open(db_path)
    httpd = ThreadingHTTPServer(("127.0.0.1", port), partial(Handler, directory=str(out_dir)))
    print(f"Fotoalbum lokaal: http://localhost:{port}/  (Ctrl+C om te stoppen)", flush=True)
    httpd.serve_forever()
