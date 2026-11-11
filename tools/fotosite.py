#!/usr/bin/env python3
"""Fotoalbum-generator.

Gebruik (vanuit de projectmap):
  .venv/bin/python tools/fotosite.py add "10. Photos/2026/2026.11.07_Naam" --title "..." --place "..." --category Natuur
  .venv/bin/python tools/fotosite.py sync [slug]     # foto's (opnieuw) verwerken uit iCloud
  .venv/bin/python tools/fotosite.py build           # HTML opnieuw maken in docs/
  .venv/bin/python tools/fotosite.py serve           # lokaal bekijken op http://localhost:8765 (met test-API)
  .venv/bin/python tools/fotosite.py publish -m "Nieuw album"   # sync + build + commit + push

Originelen worden alleen gelezen, nooit aangepast.
"""
import argparse
import datetime as dt
import html
import json
import re
import shutil
import subprocess
import sys
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
OUT = ROOT / "docs"
DATA = ROOT / "data" / "albums"
DETS = ROOT / "data" / "determinaties"
CATALOG = ROOT / "albums.json"
SITE = ROOT / "site.json"
ICLOUD = Path.home() / "Library/Mobile Documents/com~apple~CloudDocs"

SM = 900      # lange zijde rasterfoto
LG = 2560     # lange zijde grote weergave + download
OG = (1200, 630)

RATING_RE = re.compile(r"\((\d?)\*\)")
NUM_RE = re.compile(r"-(\d+)(?:\(\d?\*\))?\.jpe?g$", re.I)
XMP_RATING_RE = re.compile(rb'xmp:Rating(?:="|>)(-?\d)')

MONTHS = ["januari", "februari", "maart", "april", "mei", "juni", "juli",
          "augustus", "september", "oktober", "november", "december"]
DAYS = ["maandag", "dinsdag", "woensdag", "donderdag", "vrijdag", "zaterdag", "zondag"]


# ---------------------------------------------------------------- helpers
def load_json(p, default):
    return json.loads(p.read_text("utf-8")) if p.exists() else default


def save_json(p, data):
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", "utf-8")


def slugify(s):
    s = re.sub(r"([a-z])([A-Z])", r"\1 \2", s)
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def split_camel(s):
    return re.sub(r"([a-z])([A-Z])", r"\1 \2", s).replace("_", " ").strip()


def long_date(d):
    return f"{d.day} {MONTHS[d.month - 1]} {d.year}"


def day_label(d):
    return f"{DAYS[d.weekday()].capitalize()} {d.day} {MONTHS[d.month - 1]}"


def date_range_label(a, b):
    if a == b:
        return long_date(a)
    if a.year == b.year and a.month == b.month:
        return f"{a.day}–{b.day} {MONTHS[a.month - 1]} {a.year}"
    if a.year == b.year:
        return f"{a.day} {MONTHS[a.month - 1]} – {b.day} {MONTHS[b.month - 1]} {a.year}"
    return f"{long_date(a)} – {long_date(b)}"


def esc(s):
    return html.escape(str(s or ""), quote=True)


def rating_of(path):
    m = RATING_RE.search(path.name)
    if m:
        return int(m.group(1) or 0)
    with open(path, "rb") as f:
        m = XMP_RATING_RE.search(f.read(256 * 1024))
    return int(m.group(1)) if m else 0


def fmt_exposure(v):
    v = float(v)
    if v <= 0:
        return None
    if v >= 1:
        return f"{v:g} s"
    return f"1/{round(1 / v)} s"


def exif_info(im):
    ex = im.getexif()
    sub = ex.get_ifd(0x8769)
    out = {}
    model = ex.get(272)
    if model:
        out["camera"] = str(model).strip()
    lens = sub.get(0xA434)
    if lens:
        out["lens"] = str(lens).strip()
    parts = []
    fl = sub.get(37386)
    if fl:
        parts.append(f"{float(fl):g} mm")
    fn = sub.get(33437)
    if fn:
        parts.append(f"f/{float(fn):g}")
    et = sub.get(33434)
    if et:
        e = fmt_exposure(et)
        if e:
            parts.append(e)
    iso = sub.get(34855)
    if iso:
        parts.append(f"ISO {iso}")
    if parts:
        out["settings"] = " · ".join(parts)
    taken = sub.get(36867) or ex.get(306)
    if taken:
        try:
            out["taken"] = dt.datetime.strptime(str(taken), "%Y:%m:%d %H:%M:%S").isoformat()
        except ValueError:
            pass
    return out


# ---------------------------------------------------------------- sync
def sync_album(album, force=False):
    from PIL import Image, ImageOps

    src = ICLOUD / album["source"]
    if not src.is_dir():
        sys.exit(f"Bronmap niet gevonden: {src}")
    slug = album["slug"]
    min_rating = int(album.get("min_rating", 3))
    img_dir = OUT / "img" / slug
    img_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = DATA / f"{slug}.json"
    old = {p["id"]: p for p in load_json(manifest_path, {"photos": []})["photos"]}

    files = sorted(p for p in src.iterdir() if p.suffix.lower() in (".jpg", ".jpeg") and not p.name.startswith("."))
    photos = []
    for f in files:
        r = rating_of(f)
        if r < min_rating:
            continue
        m = NUM_RE.search(f.name)
        pid = m.group(1) if m else slugify(f.stem)[:40]
        sm_p, lg_p = img_dir / f"{pid}-sm.jpg", img_dir / f"{pid}-lg.jpg"
        mtime = int(f.stat().st_mtime)
        prev = old.get(pid)
        if prev and not force and prev.get("src_mtime") == mtime and sm_p.exists() and lg_p.exists():
            prev["rating"] = r
            photos.append(prev)
            continue
        print(f"  verwerken: {f.name}")
        with Image.open(f) as im:
            info = exif_info(im)
            icc = im.info.get("icc_profile")
            im = ImageOps.exif_transpose(im)
            if im.mode != "RGB":
                im = im.convert("RGB")
            lg = im.copy()
            lg.thumbnail((LG, LG), Image.LANCZOS)
            lg.save(lg_p, "JPEG", quality=84, optimize=True, progressive=True, icc_profile=icc)
            sm = lg.copy()
            sm.thumbnail((SM, SM), Image.LANCZOS)
            sm.save(sm_p, "JPEG", quality=80, optimize=True, progressive=True, icc_profile=icc)
        photos.append({
            "id": pid, "file": f.name, "src_mtime": mtime, "rating": r,
            "w": lg.width, "h": lg.height, "sw": sm.width, "sh": sm.height, **info,
        })

    photos.sort(key=lambda p: (p.get("taken") or "", int(p["id"]) if p["id"].isdigit() else 0))
    keep = {p["id"] for p in photos}
    for f in img_dir.glob("*.jpg"):
        stem = f.stem.rsplit("-", 1)[0]
        if f.name != "og.jpg" and stem not in keep:
            f.unlink()
    make_og(album, photos, img_dir)
    save_json(manifest_path, {"slug": slug, "photos": photos})
    print(f"{slug}: {len(photos)} foto's (≥{min_rating}★)")


def pick_cover(album, photos):
    if album.get("cover"):
        for p in photos:
            if p["id"] == str(album["cover"]):
                return p
    landscape = [p for p in photos if p["w"] >= p["h"]] or photos
    return max(landscape, key=lambda p: (p["rating"], -photos.index(p)))


def make_og(album, photos, img_dir):
    from PIL import Image, ImageOps
    if not photos:
        return
    cover = pick_cover(album, photos)
    with Image.open(img_dir / f"{cover['id']}-lg.jpg") as im:
        og = ImageOps.fit(im, OG, Image.LANCZOS)
        og.save(img_dir / "og.jpg", "JPEG", quality=78, optimize=True, progressive=True)


# ---------------------------------------------------------------- build
ICON = {
    "arrow": '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
    "back": '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12H5M11 6l-6 6 6 6"/></svg>',
    "search": '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
    "pin": '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>',
    "chev": '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 4.5 7.5 12l7.5 7.5"/></svg>',
    "chevr": '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4.5 16.5 12 9 19.5"/></svg>',
    "mark": '<svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="13"/><path d="M16 3v9M28.4 12l-8.6 2.8M23.6 26.5l-5.3-7.3M8.4 26.5l5.3-7.3M3.6 12l8.6 2.8"/></svg>',
}


def page(site, *, title, description, og_image, url, root, body_class, body, data_json, manifest=None, script="app.js"):
    full_title = f"{title} · {site['title']}" if title != site["title"] else f"{site['title']} · {site['owner']}"
    return f"""<!doctype html>
<html lang="nl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>{esc(full_title)}</title>
<meta name="description" content="{esc(description)}">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#000000" media="(prefers-color-scheme: dark)">
<meta property="og:type" content="website">
<meta property="og:site_name" content="{esc(site['title'])} · {esc(site['owner'])}">
<meta property="og:title" content="{esc(title)}">
<meta property="og:description" content="{esc(description)}">
<meta property="og:url" content="{esc(url)}">
<meta property="og:image" content="{esc(og_image)}">
<meta property="og:image:width" content="{OG[0]}">
<meta property="og:image:height" content="{OG[1]}">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="{root}assets/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="{root}assets/icon-180.png">
<link rel="manifest" href="{manifest or (root + 'manifest.webmanifest')}">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Fotoalbum">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<link rel="stylesheet" href="{root}assets/style.css?v={site['_v']}">
</head>
<body class="{body_class}">
{body}
<script type="application/json" id="site-data">{json.dumps({"api": site.get("api", ""), "title": site["title"], "owner": site["owner"], "vapid": site.get("vapid", "")}, ensure_ascii=False)}</script>
<script type="application/json" id="page-data">{data_json}</script>
<script src="{root}assets/{script}?v={site['_v']}" defer></script>
</body>
</html>
"""


def header(site, root, back=False):
    if back:
        return f"""<header class="topbar">
  <div class="wrap topbar-in">
    <a class="back" href="{root}">{ICON["chev"]}<span>Albums</span></a>
  </div>
</header>"""
    return f"""<header class="topbar">
  <div class="wrap topbar-in">
    <a class="brand" href="{root}">{esc(site['title'])}</a>
  </div>
</header>"""


def footer(site):
    year = dt.date.today().year
    return f"""<footer class="footer"><div class="wrap">
  <p>© {year} {esc(site['owner'])}</p>
</div></footer>"""


def album_meta(album, photos):
    dates = sorted({dt.date.fromisoformat(p["taken"][:10]) for p in photos if p.get("taken")})
    if not dates:
        d = dt.date.fromisoformat(album["slug"][:10])
        dates = [d]
    return dates[0], dates[-1]


def json_for_script(obj):
    return json.dumps(obj, ensure_ascii=False).replace("</", "<\\/")


def build():
    site = load_json(SITE, {})
    site["_v"] = dt.datetime.now().strftime("%Y%m%d%H%M")
    base = site["base_url"].rstrip("/") + "/"
    catalog = load_json(CATALOG, [])
    albums = []
    for a in catalog:
        man = load_json(DATA / f"{a['slug']}.json", None)
        if not man or not man["photos"]:
            print(f"  overgeslagen (nog niet gesynct): {a['slug']}")
            continue
        photos = man["photos"]
        detfile = load_json(DETS / f"{a['slug']}.json", {"fotos": {}})
        dets, same = detfile.get("fotos", {}), detfile.get("zelfde_vondst", {})
        for p in photos:
            p.pop("sp", None)
            if p["id"] in dets:
                p["sp"] = dets[p["id"]]
            elif same.get(p["id"]) in dets:
                p["sp"] = {**dets[same[p["id"]]], "via": same[p["id"]]}
            if p.get("sp", {}).get("verborgen"):
                p.pop("sp")
        first, last = album_meta(a, photos)
        cover = pick_cover(a, photos)
        albums.append({**a, "photos": photos, "first": first, "last": last, "cover_p": cover,
                       "date_label": date_range_label(first, last)})
    albums.sort(key=lambda a: a["first"], reverse=True)

    # assets
    (OUT / "assets").mkdir(parents=True, exist_ok=True)
    for f in (SRC / "assets").iterdir():
        if f.is_file():
            shutil.copy2(f, OUT / "assets" / f.name)
    (OUT / ".nojekyll").write_text("")

    # album pages
    live = set()
    for i, a in enumerate(albums):
        newer = albums[i - 1] if i > 0 else None
        older = albums[i + 1] if i + 1 < len(albums) else None
        write_album(site, base, a, newer, older)
        live.add(a["slug"])
    for d in (OUT / "album").glob("*") if (OUT / "album").exists() else []:
        if d.is_dir() and d.name not in live:
            shutil.rmtree(d)
    for d in (OUT / "img").glob("*") if (OUT / "img").exists() else []:
        if d.is_dir() and d.name not in live:
            shutil.rmtree(d)
    write_home(site, base, albums)
    write_pwa(site, base)
    save_json(OUT / "albums.json", {x["slug"]: x["title"] for x in albums})  # gebruikt door worker voor meldingen
    save_json(OUT / "fotonamen.json", {f"{x['slug']}/{p['id']}": p["sp"].get("nl") or p["sp"]["sci"]
                                       for x in albums for p in x["photos"] if p.get("sp")})  # soortnamen in meldingen
    write_404(site, base)
    print(f"Gebouwd: {len(albums)} album(s) → {OUT}")


def card(a, root, big=False):
    c = a["cover_p"]
    img = f"{root}img/{a['slug']}/{c['id']}-{'lg' if big else 'sm'}.jpg"
    search = " ".join([a["title"], a.get("place", ""), a.get("category", ""), a["date_label"], a.get("description", "")]
                      + [f"{p['sp'].get('nl', '')} {p['sp']['sci']}" for p in a["photos"] if p.get("sp")])
    search = unicodedata.normalize("NFKD", search.lower()).encode("ascii", "ignore").decode()
    sub = " · ".join(x for x in [a.get("place"), a["date_label"]] if x)
    return f"""<a class="card" href="{root}album/{a['slug']}/" data-cat="{esc(a.get('category', ''))}" data-search="{esc(search)}">
  <img src="{img}" alt="" loading="lazy" decoding="async" width="{c['sw']}" height="{c['sh']}">
  <span class="card-shade"></span>
  <span class="card-count">{len(a['photos'])}</span>
  <span class="card-text"><h3>{esc(a['title'])}</h3><p>{esc(sub)}</p></span>
</a>"""


def write_home(site, base, albums):
    root = ""
    body = [header(site, root)]
    total = sum(len(a["photos"]) for a in albums)
    if albums:
        h = albums[0]
        c = h["cover_p"]
        meta = " · ".join(x for x in [h.get("place"), h["date_label"], f"{len(h['photos'])} foto's"] if x)
        body.append(f"""<section class="hero">
  <a class="hero-link" href="album/{h['slug']}/" aria-label="Bekijk album {esc(h['title'])}">
    <img src="img/{h['slug']}/{c['id']}-lg.jpg" alt="" width="{c['w']}" height="{c['h']}" fetchpriority="high">
    <div class="hero-shade"></div>
    <div class="wrap hero-text">
      <span class="eyebrow">Nieuw album</span>
      <h1>{esc(h['title'])}</h1>
      <p class="hero-meta">{esc(meta)}</p>
      <span class="glass-btn">Bekijk album {ICON['chevr']}</span>
    </div>
  </a>
</section>""")
    cats = sorted({a.get("category", "") for a in albums if a.get("category")})
    years = sorted({a["first"].year for a in albums}, reverse=True)
    chips = "".join(f'<button class="chip" type="button" data-cat="{esc(c)}" aria-pressed="false">{esc(c)}</button>' for c in cats)
    yearnav = ""
    if len(years) > 1:
        yearnav = '<nav class="years" aria-label="Spring naar jaar">' + "".join(
            f'<a href="#jaar-{y}">{y}</a>' for y in years) + "</nav>"
    body.append(f"""<main class="wrap home">
  <div class="home-head">
    <div>
      <h2 class="large-title">Albums</h2>
      <p class="subtitle">{len(albums)} album{'s' if len(albums) != 1 else ''} · {total} foto's</p>
    </div>
    {yearnav}
  </div>
  <div class="toolbar">
    <div class="segmented" role="group" aria-label="Filter op soort">
      <button class="chip" type="button" data-cat="" aria-pressed="true">Alles</button>{chips}
    </div>
    <label class="search">{ICON['search']}<input id="search" type="search" placeholder="Zoeken" autocomplete="off"></label>
  </div>""")
    for y in years:
        ys = [a for a in albums if a["first"].year == y]
        cards = "\n".join(card(a, root) for a in ys)
        body.append(f"""  <section class="year" id="jaar-{y}">
    <h2 class="year-h"><span>{y}</span><small>{len(ys)} album{'s' if len(ys) != 1 else ''}</small></h2>
    <div class="cards">{cards}</div>
  </section>""")
    body.append('  <p id="empty" class="empty" hidden>Geen albums gevonden.</p>\n</main>')
    body.append(footer(site))
    og = f"{base}img/{albums[0]['slug']}/og.jpg" if albums else ""
    out = page(site, title=site["title"], description=site.get("tagline", ""), og_image=og, url=base, root=root,
               body_class="page-home", body="\n".join(body), data_json="{}")
    (OUT / "index.html").write_text(out, "utf-8")


def write_album(site, base, a, newer, older):
    root = "../../"
    slug = a["slug"]
    photos = a["photos"]
    url = f"{base}album/{slug}/"
    # groepeer per dag als het album meerdere dagen beslaat
    groups = {}
    for p in photos:
        d = p.get("taken", "")[:10] or "?"
        groups.setdefault(d, []).append(p)
    multi = len(groups) > 1

    sections = []
    for n, (d, ps) in enumerate(groups.items(), 1):
        tiles = []
        for p in ps:
            ar = p["sw"] / p["sh"]
            tiles.append(
                f'<a class="tile" href="#{p["id"]}" data-id="{p["id"]}" style="--ar:{ar:.4f};flex-grow:{ar * 100:.2f}">'
                f'<img src="{root}img/{slug}/{p["id"]}-sm.jpg" alt="Foto {p["id"]}" loading="lazy" decoding="async" '
                f'width="{p["sw"]}" height="{p["sh"]}"><span class="badges"></span></a>')
        head = ""
        if multi and d != "?":
            dd = dt.date.fromisoformat(d)
            head = f'<h2 class="day-h">{esc(day_label(dd))}<small>{len(ps)} foto\'s</small></h2>'
        sections.append(f'<section class="day">{head}<div class="grid">{"".join(tiles)}</div></section>')

    def nav_card(x, label):
        if not x:
            return "<span></span>"
        c = x["cover_p"]
        return (f'<a class="nav-card" href="{root}album/{x["slug"]}/"><img src="{root}img/{x["slug"]}/{c["id"]}-sm.jpg" alt="" loading="lazy">'
                f'<span><small>{label}</small><b>{esc(x["title"])}</b><em>{esc(x["date_label"])}</em></span></a>')

    nsp = len({p["sp"]["sci"] for p in photos if p.get("sp") and p["sp"].get("niveau", "Soort") in ("Soort", "Soortgroep")})
    sub = " · ".join(x for x in [a.get("place"), a["date_label"], f"{len(photos)} foto's", f"{nsp} soorten" if nsp else ""] if x)
    desc = f'<p class="lead">{esc(a["description"])}</p>' if a.get("description") else ""
    body = f"""{header(site, root, back=True)}
<main class="wrap album">
  <header class="album-head">
    <h1>{esc(a['title'])}</h1>
    <p class="album-sub">{esc(sub)}</p>
    {desc}
    <p class="album-stats" hidden></p>
  </header>
  {''.join(sections)}
  <nav class="album-nav" aria-label="Andere albums">{nav_card(newer, 'Volgend album')}{nav_card(older, 'Vorig album')}</nav>
</main>
{footer(site)}"""
    data = {
        "slug": slug, "title": a["title"], "date": a["date_label"], "url": url,
        "photos": [{k: p[k] for k in ("id", "w", "h", "camera", "lens", "settings", "taken", "sp") if p.get(k)} for p in photos],
        "dl": f"{a['first'].isoformat()}_{re.sub(r'[^A-Za-z0-9]+', '', a['title'].title())}",
    }
    descr = " · ".join(x for x in [a.get("place"), a["date_label"], f"{len(photos)} foto's"] if x)
    out = page(site, title=a["title"], description=descr, og_image=f"{base}img/{slug}/og.jpg", url=url, root=root,
               body_class="page-album", body=body, data_json=json_for_script(data))
    d = OUT / "album" / slug
    d.mkdir(parents=True, exist_ok=True)
    (d / "index.html").write_text(out, "utf-8")


def write_pwa(site, base):
    shutil.copy2(SRC / "sw.js", OUT / "sw.js")
    icons = [{"src": f"assets/icon-{n}.png", "sizes": f"{n}x{n}", "type": "image/png"} for n in (192, 512)]
    save_json(OUT / "manifest.webmanifest", {
        "id": "./", "name": f"{site['title']} · {site['owner']}", "short_name": site["title"], "lang": "nl",
        "start_url": "./", "scope": "./", "display": "standalone",
        "background_color": "#ffffff", "theme_color": "#ffffff", "icons": icons})
    d = OUT / "beheer"
    d.mkdir(parents=True, exist_ok=True)
    save_json(d / "manifest.webmanifest", {
        "id": "./beheer/", "name": "Fotoalbum beheer", "short_name": site["title"], "lang": "nl",
        "start_url": "../", "scope": "../", "display": "standalone",
        "background_color": "#f5f5f7", "theme_color": "#f5f5f7",
        "icons": [{**i, "src": "../" + i["src"]} for i in icons]})
    body = f"""{header(site, "../", back=True)}
<main class="wrap owner">
  <header class="owner-head"><h1>Beheer</h1><button class="back" id="refresh" type="button" onclick="location.reload()">Vernieuwen</button></header>
  <section id="setup" class="owner-card setup"></section>
  <section id="dash" hidden></section>
</main>"""
    out = page(site, title="Beheer", description="", og_image="", url=base + "beheer/", root="../", body_class="page-owner",
               body=body, data_json="{}", manifest="manifest.webmanifest", script="beheer.js")
    (d / "index.html").write_text(out, "utf-8")


def write_404(site, base):
    body = f"""{header(site, base)}
<main class="wrap notfound"><h1>Deze pagina bestaat niet (meer)</h1><p><a class="btn" href="{base}">Naar de albums</a></p></main>"""
    out = page(site, title="Niet gevonden", description="", og_image="", url=base, root=base, body_class="page-404",
               body=body, data_json="{}")
    (OUT / "404.html").write_text(out, "utf-8")


# ---------------------------------------------------------------- cli
def cmd_add(args):
    catalog = load_json(CATALOG, [])
    src = args.folder
    p = Path(src)
    if p.is_absolute():
        src = str(p.relative_to(ICLOUD))
    name = Path(src).name
    m = re.match(r"(\d{4})[.\-_](\d{2})[.\-_](\d{2})[_ -]?(.*)", name)
    date = f"{m.group(1)}-{m.group(2)}-{m.group(3)}" if m else dt.date.today().isoformat()
    rest = m.group(4) if m else name
    title = args.title or split_camel(rest)
    slug = args.slug or f"{date}-{slugify(title)}"
    if any(a["slug"] == slug for a in catalog):
        sys.exit(f"Album bestaat al: {slug}")
    album = {"slug": slug, "source": src, "title": title, "place": args.place or "", "category": args.category or "",
             "description": args.description or "", "min_rating": args.min_rating, "cover": args.cover}
    catalog.append(album)
    save_json(CATALOG, catalog)
    sync_album(album)
    build()


def lookup_species(sci):
    """Nederlandse naam + soortpagina via de openbare zoekfunctie van waarneming.nl."""
    import urllib.parse
    import urllib.request
    base = re.sub(r"\s+(sl|s\.l\.)\b.*$", "", sci).strip()
    genus_only = base.endswith(" spec.") or base.endswith(" sp.")
    q = base.replace(" spec.", "").replace(" sp.", "")
    if genus_only:
        return {}  # de zoekfunctie kent geen geslachten; geen gok doen
    req = urllib.request.Request(
        "https://waarneming.nl/api/v1/species/search/?" + urllib.parse.urlencode({"q": q}),
        headers={"Accept-Language": "nl", "User-Agent": "Fotoalbum (persoonlijk)"})
    with urllib.request.urlopen(req, timeout=20) as r:
        res = json.load(r).get("results", [])
    hit = next((x for x in res if x.get("scientific_name", "").lower() == q.lower()), None)
    if not hit:
        return {}
    nl = hit.get("name") or ""
    if nl.lower() == hit.get("scientific_name", "").lower():
        nl = ""
    return {"nl": nl, "url": hit.get("permalink", ""), "group": hit.get("group_name", "")}


def cmd_determinaties_inat(args):
    """iNaturalist-lijst (tab-gescheiden): Foto | Wetenschappelijke naam | Nederlandse naam | Status iNaturalist.
    Foto mag een reeks zijn (15-17). Vervangt de namen; 'zelfde_vondst' blijft staan."""
    path = DETS / f"{args.slug}.json"
    out = load_json(path, {"bron": "", "fotos": {}})
    old = out.get("fotos", {})
    fotos, n = {}, 0
    levels = {"geslacht": "Geslacht", "familie": "Familie", "orde": "Orde", "klasse": "Klasse"}
    for line in Path(args.xlsx).read_text(encoding="utf-8").splitlines():
        cols = [c.strip() for c in line.split("\t")]
        if len(cols) < 4 or not re.match(r"^\d+(-\d+)?$", cols[0]):
            continue
        rng, sci, nl, status = cols[:4]
        a, _, b = rng.partition("-")
        ids = [str(i) for i in range(int(a), int(b or a) + 1)]
        niveau = "Soort"
        m = re.match(r"^(.*?)\s*\((\w+)\)$", sci)
        if m and m.group(2).lower() in levels:
            sci, niveau = m.group(1), levels[m.group(2).lower()]
        elif m:  # bv. "Spinnenweb (Araneae)": geen soort, alleen een groep
            sci, niveau = m.group(2), "Groep"
        elif " sectie " in sci:
            niveau = "Sectie"
        nl = "" if nl in ("-", "–") else nl
        removed = status.lower().startswith("verwijderd")
        url = ""
        if niveau == "Soort" and not removed:
            prev = old.get(ids[0], {})
            if prev.get("url") and prev.get("niveau") in ("Soort", "Soortgroep"):
                url = prev["url"]  # zelfde vondst, zelfde soortpagina (ook als de wetenschappelijke naam vernieuwd is)
            else:
                url = lookup_species(sci).get("url", "")
        for pid in ids:
            fotos[pid] = {"sci": sci, "nl": nl, "url": url, "niveau": niveau, "bron": "iNaturalist", "status": status,
                          "zeker": status.lower() == "research grade"}
            if removed:
                fotos[pid]["verborgen"] = True
            n += 1
            print(f"  foto {pid}: {nl or sci} ({niveau}, {status}){'' if url or niveau != 'Soort' or removed else ' – geen soortpagina gevonden'}")
    gone = sorted(set(old) - set(fotos), key=int)
    if gone:
        print(f"  niet meer in de lijst, naam vervalt: {', '.join(gone)}")
    out["bron"] = f"iNaturalist ({Path(args.xlsx).name})"
    out["fotos"] = fotos
    save_json(path, out)
    print(f"{n} determinaties opgeslagen voor {args.slug}")


def cmd_determinaties(args):
    if not str(args.xlsx).lower().endswith((".xlsx", ".xlsm")):
        return cmd_determinaties_inat(args)
    import openpyxl
    wb = openpyxl.load_workbook(args.xlsx, data_only=True)
    ws = wb["Determinaties"] if "Determinaties" in wb.sheetnames else wb.worksheets[0]
    header_row = None
    for row in ws.iter_rows(min_row=1, max_row=20):
        vals = [str(c.value or "").strip().lower() for c in row]
        if "foto" in vals and any("wetenschappelijke" in v for v in vals):
            header_row = row[0].row
            cols = {v: i for i, v in enumerate(vals)}
            break
    if not header_row:
        sys.exit("Kopregel met 'Foto' en 'wetenschappelijke naam' niet gevonden.")
    ci = lambda key: next(i for v, i in cols.items() if key in v)
    c_foto, c_file, c_sci, c_lvl, c_stat = ci("foto"), ci("bestandsnaam"), ci("wetenschappelijke"), ci("niveau"), ci("status")
    out = load_json(DETS / f"{args.slug}.json", {"bron": "", "fotos": {}})
    out["bron"] = Path(args.xlsx).name
    n = 0
    for row in ws.iter_rows(min_row=header_row + 1, values_only=True):
        if not row[c_foto] or not row[c_sci]:
            continue
        m = NUM_RE.search(str(row[c_file] or ""))
        pid = m.group(1) if m else str(row[c_foto])
        sci = str(row[c_sci]).strip()
        info = lookup_species(sci)
        out["fotos"][pid] = {
            "sci": sci, "nl": info.get("nl", ""), "url": info.get("url", ""),
            "niveau": str(row[c_lvl] or "").strip(), "zeker": "onzeker" not in str(row[c_stat] or "").lower(),
        }
        n += 1
        print(f"  foto {pid}: {sci} → {info.get('nl') or '(geen Nederlandse naam)'}")
    save_json(DETS / f"{args.slug}.json", out)
    print(f"{n} determinaties opgeslagen voor {args.slug}")


def cmd_sync(args):
    for a in load_json(CATALOG, []):
        if not args.slug or a["slug"] == args.slug:
            sync_album(a, force=args.force)


def cmd_publish(args):
    cmd_sync(argparse.Namespace(slug=None, force=False))
    build()
    subprocess.run(["git", "add", "-A"], cwd=ROOT, check=True)
    if subprocess.run(["git", "diff", "--cached", "--quiet"], cwd=ROOT).returncode == 0:
        print("Niets nieuws om te publiceren.")
        return
    subprocess.run(["git", "commit", "-q", "-m", args.message], cwd=ROOT, check=True)
    subprocess.run(["git", "push", "-q"], cwd=ROOT, check=True)
    print("Gepubliceerd. GitHub Pages is binnen ~1 minuut bijgewerkt.")


def main():
    ap = argparse.ArgumentParser(description="Fotoalbum-generator")
    sp = ap.add_subparsers(dest="cmd", required=True)
    a = sp.add_parser("add")
    a.add_argument("folder")
    a.add_argument("--title")
    a.add_argument("--place")
    a.add_argument("--category")
    a.add_argument("--description")
    a.add_argument("--slug")
    a.add_argument("--cover")
    a.add_argument("--min-rating", type=int, default=3)
    dp = sp.add_parser("determinaties")
    dp.add_argument("slug")
    dp.add_argument("xlsx")
    s = sp.add_parser("sync")
    s.add_argument("slug", nargs="?")
    s.add_argument("--force", action="store_true")
    sp.add_parser("build")
    sv = sp.add_parser("serve")
    sv.add_argument("--port", type=int, default=8765)
    pb = sp.add_parser("publish")
    pb.add_argument("-m", "--message", default="Fotoalbum bijgewerkt")
    args = ap.parse_args()
    if args.cmd == "add":
        cmd_add(args)
    elif args.cmd == "sync":
        cmd_sync(args)
    elif args.cmd == "determinaties":
        cmd_determinaties(args)
    elif args.cmd == "build":
        build()
    elif args.cmd == "serve":
        from devserver import serve
        serve(OUT, args.port, ROOT / ".dev" / "dev.sqlite")
    elif args.cmd == "publish":
        cmd_publish(args)


if __name__ == "__main__":
    main()
