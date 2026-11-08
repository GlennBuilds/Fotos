// Fotoalbum-API: likes en reacties. Cloudflare Worker + D1 (gratis tier).
// Endpoints (zelfde gedrag als tools/devserver.py):
//   GET    /stats?album=<slug>&client=<id>   -> { likes:{photo:n}, comments:{photo:n}, mine:[photo] }
//   POST   /like      { photo, client }      -> { count, liked }   (toggle)
//   GET    /comments?photo=<slug>/<id>       -> { comments:[...] }
//   POST   /comments  { photo, name, text, client, website } -> { comment }
//   GET    /admin/recent        (Authorization: Bearer ADMIN_KEY) -> laatste 100 reacties
//   DELETE /admin/comments/<id> (Authorization: Bearer ADMIN_KEY) -> verbergt reactie

const PHOTO_RE = /^[a-z0-9-]{1,80}\/[a-z0-9-]{1,40}$/;
const ALBUM_RE = /^[a-z0-9-]{1,80}$/;

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin") || "";
    const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
    const cors = {
      "Access-Control-Allow-Origin": allowed.includes(origin) ? origin : allowed[0] || "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    };
    const json = (code, obj) =>
      new Response(JSON.stringify(obj), { status: code, headers: { "Content-Type": "application/json", ...cors } });
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "");
    const q = url.searchParams;
    const db = env.DB;

    try {
      if (req.method === "GET" && path === "/stats") {
        const album = q.get("album") || "", client = q.get("client") || "";
        if (!ALBUM_RE.test(album)) return json(400, { error: "Ongeldig album" });
        const [l, c, m] = await db.batch([
          db.prepare("SELECT photo, COUNT(*) AS n FROM likes WHERE album=? GROUP BY photo").bind(album),
          db.prepare("SELECT photo, COUNT(*) AS n FROM comments WHERE album=? AND hidden=0 GROUP BY photo").bind(album),
          db.prepare("SELECT photo FROM likes WHERE album=? AND client=?").bind(album, client),
        ]);
        const toMap = (r) => Object.fromEntries(r.results.map((x) => [x.photo, x.n]));
        return json(200, { likes: toMap(l), comments: toMap(c), mine: m.results.map((x) => x.photo) });
      }

      if (req.method === "GET" && path === "/comments") {
        const photo = q.get("photo") || "";
        if (!PHOTO_RE.test(photo)) return json(400, { error: "Ongeldige foto" });
        const r = await db
          .prepare("SELECT id, name, text, created FROM comments WHERE photo=? AND hidden=0 ORDER BY created")
          .bind(photo).all();
        return json(200, { comments: r.results });
      }

      if (req.method === "POST" && (path === "/like" || path === "/comments")) {
        let b = {};
        try { b = await req.json(); } catch (e) { /* leeg */ }
        const photo = String(b.photo || ""), client = String(b.client || "").slice(0, 64);
        if (!PHOTO_RE.test(photo) || client.length < 8) return json(400, { error: "Ongeldig verzoek" });
        const album = photo.split("/")[0];
        const now = Date.now();

        if (path === "/like") {
          const del = await db.prepare("DELETE FROM likes WHERE photo=? AND client=?").bind(photo, client).run();
          const liked = del.meta.changes === 0;
          if (liked) {
            await db.prepare("INSERT OR IGNORE INTO likes (photo, album, client, created) VALUES (?,?,?,?)")
              .bind(photo, album, client, now).run();
          }
          const n = await db.prepare("SELECT COUNT(*) AS n FROM likes WHERE photo=?").bind(photo).first("n");
          return json(200, { count: n, liked });
        }

        if (b.website) return json(200, { ok: true }); // honeypot voor spambots
        const name = String(b.name || "").trim().slice(0, 40);
        const text = String(b.text || "").trim().slice(0, 1000);
        if (!name || !text) return json(400, { error: "Vul je naam en een reactie in." });
        const recent = await db.prepare("SELECT COUNT(*) AS n FROM comments WHERE client=? AND created>?")
          .bind(client, now - 600000).first("n");
        if (recent >= 8) return json(429, { error: "Even rustig aan — probeer het zo nog eens." });
        const r = await db
          .prepare("INSERT INTO comments (photo, album, name, text, client, created) VALUES (?,?,?,?,?,?)")
          .bind(photo, album, name, text, client, now).run();
        return json(200, { comment: { id: r.meta.last_row_id, name, text, created: now } });
      }

      if (path.startsWith("/admin/")) {
        const auth = req.headers.get("Authorization") || "";
        if (!env.ADMIN_KEY || auth !== `Bearer ${env.ADMIN_KEY}`) return json(401, { error: "Geen toegang" });
        if (req.method === "GET" && path === "/admin/recent") {
          const r = await db.prepare("SELECT * FROM comments ORDER BY created DESC LIMIT 100").all();
          return json(200, { comments: r.results });
        }
        const m = path.match(/^\/admin\/comments\/(\d+)$/);
        if (req.method === "DELETE" && m) {
          await db.prepare("UPDATE comments SET hidden=1 WHERE id=?").bind(Number(m[1])).run();
          return json(200, { ok: true });
        }
      }
      return json(404, { error: "Niet gevonden" });
    } catch (e) {
      return json(500, { error: "Er ging iets mis, probeer het later nog eens." });
    }
  },
};
