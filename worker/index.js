// Fotoalbum-API: likes en reacties. Cloudflare Worker + D1 (gratis tier).
// Endpoints (zelfde gedrag als tools/devserver.py):
//   GET    /stats?album=<slug>&client=<id>   -> { likes:{photo:n}, comments:{photo:n}, mine:[photo] }
//   POST   /like      { photo, client }      -> { count, liked }   (toggle)
//   GET    /comments?photo=<slug>/<id>       -> { comments:[...] }
//   POST   /comments  { photo, name, text, client, website } -> { comment }
//   GET    /admin/recent        (Authorization: Bearer ADMIN_KEY) -> laatste 100 reacties
//   DELETE /admin/comments/<id> (Authorization: Bearer ADMIN_KEY) -> verbergt reactie

import { sendPush, b64u } from "./push.js";

const PHOTO_RE = /^[a-z0-9-]{1,80}\/[a-z0-9-]{1,40}$/;
const ALBUM_RE = /^[a-z0-9-]{1,80}$/;

// ---- meldingen
let titleCache = null, titleCacheAt = 0;
async function albumTitle(env, slug) {
  try {
    if (!titleCache || Date.now() - titleCacheAt > 3600000) {
      const r = await fetch(env.SITE_URL + "albums.json", { cf: { cacheTtl: 300 } });
      titleCache = r.ok ? await r.json() : {};
      titleCacheAt = Date.now();
    }
  } catch (e) { titleCache = titleCache || {}; }
  return titleCache[slug] || slug.replace(/^\d{4}-\d{2}-\d{2}-/, "").replace(/-/g, " ");
}
// Melding naar Glenns gekoppelde toestellen (eigen web push, zie push.js).
async function notify(env, { title, message, click, tag }) {
  const res = await sendPush(env, { title, body: message, url: click, tag });
  if (res.errors.length) console.log("push fouten", JSON.stringify(res.errors));
  return { ...res, status: res.sent > 0 ? 200 : 503 };
}

const sha256hex = async (s) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");

// Eigenaar = admin-sleutel of een via koppelcode uitgegeven toesteltoken.
async function isOwner(req, env) {
  const auth = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/, "");
  if (!auth) return false;
  if (env.ADMIN_KEY && auth === env.ADMIN_KEY) return true;
  const row = await env.DB.prepare("SELECT 1 AS ok FROM owners WHERE token_hash=?").bind(await sha256hex(auth)).first("ok");
  return !!row;
}
const photoUrl = (env, photo) => {
  const [slug, id] = photo.split("/");
  return `${env.SITE_URL}album/${slug}/#${id}`;
};

// Soortnamen per foto (uit de site, gemaakt door fotosite.py build) voor in meldingen.
let namesCache = null, namesCacheAt = 0;
async function photoNames(env) {
  try {
    if (!namesCache || Date.now() - namesCacheAt > 3600000) {
      const r = await fetch(env.SITE_URL + "fotonamen.json", { cf: { cacheTtl: 300 } });
      namesCache = r.ok ? await r.json() : {};
      namesCacheAt = Date.now();
    }
  } catch (e) { namesCache = namesCache || {}; }
  return namesCache;
}
// Melding per like (direct). Vaste tag per persoon+foto: aan/uit/aan geeft geen stapel meldingen.
async function likeNotify(env, photo, album, who) {
  const [title, names] = await Promise.all([albumTitle(env, album), photoNames(env)]);
  const id = photo.split("/")[1];
  return notify(env, {
    title: `❤️ ${who || "Iemand"} vond een foto leuk`,
    message: `${names[photo] || `Foto ${id}`} · ${title}`,
    tag: `l-${photo}-${(who || "").toLowerCase()}`,
    click: photoUrl(env, photo),
  });
}
const saveName = (db, client, name, now) =>
  db.prepare("INSERT INTO clients (client, name, updated) VALUES (?,?,?) ON CONFLICT(client) DO UPDATE SET name=excluded.name, updated=excluded.updated")
    .bind(client, name, now).run();
const cleanName = (n) => String(n || "").replace(/\s+/g, " ").trim().slice(0, 40);

// Eén persoon = alle toestellen met dezelfde naam (hoofdletters/spaties maken niet uit); zonder naam = het toestel zelf.
const PERSON = "CASE WHEN c.name IS NOT NULL AND trim(c.name) <> '' THEN 'n:' || lower(trim(c.name)) ELSE 'c:' || l.client END";
async function nameOf(db, client) {
  return (await db.prepare("SELECT name FROM clients WHERE client=?").bind(client).first("name")) || "";
}
async function personClients(db, client, name) {
  if (!name) return [client];
  const r = await db.prepare("SELECT client FROM clients WHERE lower(trim(name)) = lower(trim(?))").bind(name).all();
  return [...new Set([client, ...r.results.map((x) => x.client)])];
}
const inList = (arr) => arr.map(() => "?").join(",");
async function photoCount(db, photo) {
  return db.prepare(`SELECT COUNT(DISTINCT ${PERSON}) AS n FROM likes l LEFT JOIN clients c ON c.client=l.client WHERE l.photo=?`)
    .bind(photo).first("n");
}

export default {

  async fetch(req, env, ctx) {
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
        const me = client ? await nameOf(db, client) : "";
        const [l, c, m] = await db.batch([
          db.prepare(`SELECT l.photo, COUNT(DISTINCT ${PERSON}) AS n FROM likes l LEFT JOIN clients c ON c.client=l.client WHERE l.album=? GROUP BY l.photo`).bind(album),
          db.prepare("SELECT photo, COUNT(*) AS n FROM comments WHERE album=? AND hidden=0 GROUP BY photo").bind(album),
          db.prepare("SELECT DISTINCT l.photo FROM likes l LEFT JOIN clients c ON c.client=l.client WHERE l.album=? AND (l.client=? OR (? <> '' AND lower(trim(c.name)) = lower(trim(?))))")
            .bind(album, client, me, me),
        ]);
        const toMap = (r) => Object.fromEntries(r.results.map((x) => [x.photo, x.n]));
        return json(200, { likes: toMap(l), comments: toMap(c), mine: m.results.map((x) => x.photo), name: me });
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
          let likeName = cleanName(b.name);
          const before = await nameOf(db, client);
          let welcome = false;
          if (likeName && likeName.toLowerCase() !== before.toLowerCase()) {
            // nieuwe naam op dit toestel: bestaat deze persoon al (ander toestel)? dan herkennen en dezelfde schrijfwijze gebruiken
            const known = await db.prepare("SELECT name FROM clients WHERE lower(trim(name)) = lower(trim(?)) AND client <> ? ORDER BY updated DESC LIMIT 1")
              .bind(likeName, client).first("name");
            if (known) { welcome = true; likeName = known; }
            await saveName(db, client, likeName, now);
          }
          const me = likeName || before;
          const devices = await personClients(db, client, me);
          const has = await db.prepare(`SELECT COUNT(*) AS n FROM likes WHERE photo=? AND client IN (${inList(devices)})`)
            .bind(photo, ...devices).first("n");
          // 'like' = gewenste stand (nieuwe site); zonder 'like' (oude versie in cache) = omschakelen
          const want = typeof b.like === "boolean" ? b.like : has === 0;
          if (want && !has) {
            await db.prepare("INSERT OR IGNORE INTO likes (photo, album, client, created) VALUES (?,?,?,?)")
              .bind(photo, album, client, now).run();
            ctx.waitUntil(likeNotify(env, photo, album, me).catch(() => {}));
          } else if (!want && has) {
            await db.prepare(`DELETE FROM likes WHERE photo=? AND client IN (${inList(devices)})`).bind(photo, ...devices).run();
          }
          return json(200, { count: await photoCount(db, photo), liked: want, welcome: welcome ? me : "", name: me });
        }

        if (b.website) return json(200, { ok: true }); // honeypot voor spambots
        const name = cleanName(b.name);
        const text = String(b.text || "").trim().slice(0, 1000);
        if (!name || !text) return json(400, { error: "Vul je naam en een reactie in." });
        const recent = await db.prepare("SELECT COUNT(*) AS n FROM comments WHERE client=? AND created>?")
          .bind(client, now - 600000).first("n");
        if (recent >= 8) return json(429, { error: "Even rustig aan — probeer het zo nog eens." });
        const r = await db
          .prepare("INSERT INTO comments (photo, album, name, text, client, created) VALUES (?,?,?,?,?,?)")
          .bind(photo, album, name, text, client, now).run();
        await saveName(db, client, name, now);
        ctx.waitUntil(albumTitle(env, album).then((t) => notify(env, {
          title: `💬 ${name} · ${t}`,
          message: text,
          tag: `c-${photo}`,
          click: photoUrl(env, photo),
        })).catch(() => {}));
        return json(200, { comment: { id: r.meta.last_row_id, name, text, created: now } });
      }

      // ---- eigenaar: koppelen met eenmalige code (aangemaakt door Claude in meta.pair_code = "123456|verloopt_ms")
      if (req.method === "POST" && path === "/owner/pair") {
        let b = {};
        try { b = await req.json(); } catch (e) { /* leeg */ }
        const code = String(b.code || "").replace(/\D/g, "");
        const stored = await db.prepare("SELECT value FROM meta WHERE key='pair_code'").first("value");
        const [want, exp, usesLeft] = String(stored || "").split("|");
        const tries = Number(await db.prepare("SELECT value FROM meta WHERE key='pair_tries'").first("value")) || 0;
        if (!want || Date.now() > Number(exp) || tries >= 10) return json(400, { error: "Deze koppelcode is verlopen of al gebruikt. Vraag een nieuwe aan." });
        if (code !== want) {
          await db.prepare("INSERT INTO meta (key, value) VALUES ('pair_tries', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
            .bind(String(tries + 1)).run();
          return json(400, { error: "Onjuiste koppelcode." });
        }
        const token = b64u(crypto.getRandomValues(new Uint8Array(32)));
        await db.batch([
          db.prepare("INSERT INTO owners (token_hash, label, created) VALUES (?,?,?)")
            .bind(await sha256hex(token), String(b.label || "").slice(0, 80), Date.now()),
          // code mag binnen de geldigheid een paar keer gebruikt worden (Safari en beginscherm-app hebben aparte opslag)
          Number(usesLeft) > 1
            ? db.prepare("UPDATE meta SET value=? WHERE key='pair_code'").bind(`${want}|${exp}|${Number(usesLeft) - 1}`)
            : db.prepare("DELETE FROM meta WHERE key IN ('pair_code', 'pair_tries')"),
        ]);
        return json(200, { token });
      }

      if (path.startsWith("/owner/") || path.startsWith("/admin/")) {
        if (!(await isOwner(req, env))) return json(401, { error: "Geen toegang" });
        const route = path.replace(/^\/(owner|admin)/, "");
        if (req.method === "POST" && route === "/subscribe") {
          let b = {};
          try { b = await req.json(); } catch (e) { /* leeg */ }
          const s = b.subscription || {};
          const keys = s.keys || {};
          if (!/^https:\/\//.test(s.endpoint || "") || !keys.p256dh || !keys.auth) return json(400, { error: "Ongeldig abonnement" });
          await db.prepare("INSERT INTO push_subs (endpoint, p256dh, auth, created) VALUES (?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh, auth=excluded.auth")
            .bind(s.endpoint, keys.p256dh, keys.auth, Date.now()).run();
          return json(200, { ok: true });
        }
        if (req.method === "POST" && (route === "/test" || route === "/test-notify")) {
          return json(200, await notify(env, { title: "✅ Meldingen staan aan", message: "Je krijgt nu een melding bij nieuwe likes en reacties.", click: env.SITE_URL, tag: "test" }));
        }
        // tijdlijn voor de beheerpagina: per persoon per foto één like (eerste tijdstip) + reacties
        if (req.method === "GET" && route === "/timeline") {
          const [l, c] = await db.batch([
            db.prepare(`SELECT l.photo, l.album, ${PERSON} AS pk, COALESCE(MAX(c.name), '') AS wie, MIN(l.created) AS created ` +
              "FROM likes l LEFT JOIN clients c ON c.client=l.client GROUP BY l.photo, pk ORDER BY created DESC LIMIT 5000"),
            db.prepare("SELECT id, photo, album, name, text, created FROM comments WHERE hidden=0 ORDER BY created DESC LIMIT 1000"),
          ]);
          return json(200, { likes: l.results, comments: c.results });
        }
        if (req.method === "GET" && route === "/activity") {
          const since = Number(q.get("since")) || 0;
          const [l, c] = await db.batch([
            db.prepare(`SELECT COUNT(*) AS n FROM (SELECT DISTINCT l.photo, ${PERSON} FROM likes l LEFT JOIN clients c ON c.client=l.client WHERE l.created>?)`).bind(since),
            db.prepare("SELECT COUNT(*) AS n FROM comments WHERE created>? AND hidden=0").bind(since),
          ]);
          return json(200, { likes: l.results[0].n, comments: c.results[0].n });
        }
        if (req.method === "GET" && route === "/overview") {
          const [l, c] = await db.batch([
            db.prepare("SELECT l.album, COALESCE(MAX(c.name), 'Anoniem') AS wie, MIN(l.client) AS client, COUNT(DISTINCT l.photo) AS likes, MAX(l.created) AS laatst, " +
              "GROUP_CONCAT(DISTINCT substr(l.photo, instr(l.photo, '/') + 1)) AS fotos, COUNT(DISTINCT l.client) AS toestellen FROM likes l LEFT JOIN clients c ON c.client=l.client " +
              `GROUP BY l.album, ${PERSON} ORDER BY laatst DESC`),
            db.prepare("SELECT id, photo, album, name, text, created FROM comments WHERE hidden=0 ORDER BY created DESC LIMIT 50"),
          ]);
          const albums = [...new Set([...l.results, ...c.results].map((r) => r.album))];
          const titles = Object.fromEntries(await Promise.all(albums.map(async (a) => [a, await albumTitle(env, a)])));
          const likes = l.results.map(({ client, ...r }) => ({ ...r, toestel: client.slice(0, 6) }));
          return json(200, { titles, likes, comments: c.results, site: env.SITE_URL });
        }
        if (req.method === "GET" && route === "/likes") {
          const r = await db.prepare(
            "SELECT l.album, COALESCE(MAX(c.name), 'anoniem (' || substr(MIN(l.client),1,6) || ')') AS wie, COUNT(DISTINCT l.photo) AS likes, " +
            `COUNT(DISTINCT l.client) AS toestellen, MAX(l.created) AS laatst FROM likes l LEFT JOIN clients c ON c.client=l.client GROUP BY l.album, ${PERSON} ORDER BY laatst DESC`).all();
          return json(200, { likes: r.results });
        }
        if (req.method === "GET" && route === "/recent") {
          const r = await db.prepare("SELECT * FROM comments ORDER BY created DESC LIMIT 100").all();
          return json(200, { comments: r.results });
        }
        const m = route.match(/^\/comments\/(\d+)$/);
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
