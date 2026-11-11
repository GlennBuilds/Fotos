/* Fotoalbum — beheerpagina: meldingen koppelen + overzicht likes/reacties (alleen voor Glenn). */
(() => {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* privémodus */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* */ } },
  };
  const SITE = JSON.parse($("#site-data").textContent);
  const LOCAL = ["localhost", "127.0.0.1"].includes(location.hostname);
  const API = (LOCAL ? "/api" : (SITE.api || "")).replace(/\/$/, "");

  // Nieuwere versie van de site online? Dan meteen verversen. (GitHub bewaart pagina's anders tot 10 minuten.)
  function checkVersion(script) {
    try {
      const u = new URL(location.href);
      if (u.searchParams.has("v")) { u.searchParams.delete("v"); history.replaceState(history.state, "", u.pathname + u.search + u.hash); }
    } catch (e) { /* */ }
    const me = SITE.v || "", s = document.querySelector(`script[src*="assets/${script}"]`);
    if (!me || !s || ["localhost", "127.0.0.1"].includes(location.hostname)) return;
    const url = new URL("../versie.json", s.src).href;
    let busy = false;
    const run = () => {
      if (busy || document.hidden) return;
      busy = true;
      fetch(`${url}?t=${Date.now()}`, { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          busy = false;
          if (!d || !d.v || d.v <= me) return;
          if (document.documentElement.classList.contains("lb-open") || [...document.querySelectorAll("textarea, input")].some((x) => x.value && x.type !== "hidden" && x.name !== "website" && x.name !== "name")) return; // niet midden in iets
          let tried = "";
          try { tried = sessionStorage.getItem("fa_v") || ""; sessionStorage.setItem("fa_v", d.v); } catch (e) { /* */ }
          if (tried === d.v) return; // al één keer geprobeerd: niet blijven herladen
          const next = new URL(location.href);
          next.searchParams.set("v", d.v);
          location.replace(next.href);
        })
        .catch(() => { busy = false; });
    };
    run();
    document.addEventListener("visibilitychange", run);
  }
  checkVersion("beheer.js");
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const ub64 = (s) => { s = s.replace(/-/g, "+").replace(/_/g, "/"); s += "=".repeat((4 - (s.length % 4)) % 4); return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); };
  let token = store.get("fa_owner");

  // Beginscherm-app: bij het opstarten naar de albums gaan; beheer open je via de knop.
  const isStandalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  let started = null;
  try { started = sessionStorage.getItem("fa_started"); sessionStorage.setItem("fa_started", "1"); } catch (e) { started = "1"; }
  if (isStandalone && !started && token && !document.referrer && !location.hash) { location.replace("../"); return; }

  const prevSeen = Number(store.get("fa_seen")) || 0;

  async function api(path, opts = {}) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (opts.body) headers["Content-Type"] = "application/json";
    const r = await fetch(API + path, { method: opts.method || "GET", headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
    let d = {};
    try { d = await r.json(); } catch (e) { /* */ }
    if (r.status === 401) { token = null; store.del("fa_owner"); }
    if (!r.ok) throw new Error(d.error || "Er ging iets mis.");
    return d;
  }

  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const pushOk = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

  async function currentSub() {
    if (!pushOk) return null;
    const reg = await navigator.serviceWorker.getRegistration("../");
    return reg ? reg.pushManager.getSubscription() : null;
  }

  async function renderSetup() {
    const box = $("#setup");
    const sub = await currentSub();
    if (!token) {
      box.innerHTML = `<h2>Koppel dit toestel</h2>
        <p class="muted">Vul de koppelcode in die je van Claude hebt gekregen.</p>
        <form id="pair" class="pair"><input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="123456" required>
        <button class="btn dark" type="submit">Koppelen</button></form><p class="err" id="err"></p>`;
      $("#pair").addEventListener("submit", async (e) => {
        e.preventDefault();
        try {
          const d = await api("/owner/pair", { method: "POST", body: { code: e.target.code.value, label: navigator.userAgent.slice(0, 80) } });
          token = d.token; store.set("fa_owner", token);
          render();
        } catch (err) { $("#err").textContent = err.message; }
      });
      return;
    }
    if (!pushOk && ios && !standalone) {
      box.innerHTML = `<h2>Eerst op je beginscherm</h2>
        <p>Op iPhone werken meldingen alleen vanuit het beginscherm:</p>
        <ol class="steps"><li>Tik onderin Safari op <b>Deel</b> <span class="muted">(vierkant met pijl)</span></li>
        <li>Kies <b>Zet op beginscherm</b> en tik op <b>Voeg toe</b></li>
        <li>Open <b>Fotoalbum</b> vanaf je beginscherm en tik daar op <b>Meldingen aanzetten</b></li></ol>`;
      return;
    }
    if (!pushOk) {
      box.innerHTML = `<h2>Meldingen</h2><p class="muted">Deze browser ondersteunt geen pushmeldingen.</p>`;
      return;
    }
    if (sub && Notification.permission === "granted") {
      box.innerHTML = `<h2>Meldingen staan aan ✓</h2>
        <p class="muted">Je krijgt meteen een melding bij elke like en reactie.</p>
        <p><button class="btn dark" id="test" type="button">Stuur testmelding</button></p><p class="err" id="err"></p>`;
      $("#test").addEventListener("click", async () => {
        try { const d = await api("/owner/test", { method: "POST" }); $("#err").textContent = d.sent ? "Verstuurd ✓" : "Niet aangekomen: " + (d.errors || []).join("; "); }
        catch (err) { $("#err").textContent = err.message; }
      });
      return;
    }
    box.innerHTML = `<h2>Meldingen aanzetten</h2>
      <p class="muted">Krijg een melding als iemand een foto liket of reageert.</p>
      <p><button class="btn dark" id="enable" type="button">Meldingen aanzetten</button></p><p class="err" id="err"></p>`;
    $("#enable").addEventListener("click", async () => {
      try {
        const perm = await Notification.requestPermission();
        if (perm !== "granted") throw new Error("Meldingen zijn niet toegestaan. Zet ze aan bij Instellingen › Meldingen › Fotoalbum.");
        const reg = await navigator.serviceWorker.register("../sw.js", { scope: "../" });
        await navigator.serviceWorker.ready;
        const s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: ub64(SITE.vapid) });
        await api("/owner/subscribe", { method: "POST", body: { subscription: s.toJSON() } });
        await api("/owner/test", { method: "POST" });
        render();
      } catch (err) { $("#err").textContent = err.message; }
    });
  }

  // ---- overzicht: tijdlijn per dag → per persoon, of per foto
  const TZ = "Europe/Amsterdam";
  const dayFmt = new Intl.DateTimeFormat("nl-NL", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
  const timeFmt = new Intl.DateTimeFormat("nl-NL", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
  const dayKey = (ts) => dayFmt.format(ts);
  function dayLabel(ts) {
    const k = dayKey(ts);
    if (k === dayKey(Date.now())) return "Vandaag";
    if (k === dayKey(Date.now() - 86400000)) return "Gisteren";
    const o = { timeZone: TZ, weekday: "long", day: "numeric", month: "long" };
    if (new Date(ts).getFullYear() !== new Date().getFullYear()) o.year = "numeric";
    const s = new Date(ts).toLocaleDateString("nl-NL", o);
    return s[0].toUpperCase() + s.slice(1);
  }
  const plural = (n, one, more) => `${n} ${n === 1 ? one : more}`;
  const ANON = "Iemand zonder naam";
  const isNew = (ts) => prevSeen && ts > prevSeen;
  const TABS = { tijd: "Tijdlijn", persoon: "Per persoon", foto: "Per foto" };
  let tab = TABS[store.get("fa_beheer_tab")] ? store.get("fa_beheer_tab") : "tijd";
  let meta = null;
  async function siteMeta() {
    if (meta) return meta;
    const get = (u) => fetch(u, { cache: "no-cache" }).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
    const [titles, names] = await Promise.all([get("../albums.json"), get("../fotonamen.json")]);
    return (meta = { titles, names });
  }
  function thumb(photo, m, cls = "") {
    const [a, id] = photo.split("/");
    const label = m.names[photo] || `Foto ${id}`;
    return `<a class="tl-thumb${cls}" href="../album/${esc(a)}/#${esc(id)}" title="${esc(label)}"><img src="../img/${esc(a)}/${esc(id)}-sm.jpg" alt="${esc(label)}" loading="lazy"></a>`;
  }

  function timelineHtml(d, m) {
    const days = new Map();
    const add = (ts, pk, who, push) => {
      const k = dayKey(ts);
      if (!days.has(k)) days.set(k, { ts, people: new Map() });
      const day = days.get(k);
      day.ts = Math.max(day.ts, ts);
      if (!day.people.has(pk)) day.people.set(pk, { who: "", likes: [], comments: [], first: ts, last: ts });
      const p = day.people.get(pk);
      p.first = Math.min(p.first, ts); p.last = Math.max(p.last, ts);
      if (!p.who && who) p.who = who;
      push(p);
    };
    d.likes.forEach((l) => add(l.created, l.pk, l.wie, (p) => p.likes.push(l)));
    d.comments.forEach((c) => add(c.created, c.name.trim() ? `n:${c.name.trim().toLowerCase()}` : `r:${c.id}`, c.name, (p) => p.comments.push(c)));
    if (!days.size) return `<p class="muted tl-empty">Nog geen likes of reacties.</p>`;
    const MAX = 15;
    return [...days.values()].sort((a, b) => b.ts - a.ts).map((day) => {
      const cards = [...day.people.values()].sort((a, b) => b.last - a.last).map((p) => {
        const likes = p.likes.sort((a, b) => a.created - b.created);
        const albums = [...new Set([...likes, ...p.comments].map((x) => m.titles[x.album] || x.album))];
        const sum = [likes.length ? `${plural(likes.length, "foto", "foto's")} leuk` : "", p.comments.length ? plural(p.comments.length, "reactie", "reacties") : "", albums.join(", ")].filter(Boolean).join(" · ");
        const t1 = timeFmt.format(p.first), t2 = timeFmt.format(p.last);
        const nieuw = [...likes, ...p.comments].some((x) => isNew(x.created));
        const thumbs = likes.length ? `<div class="tl-thumbs">${likes.map((l, i) => thumb(l.photo, m, i >= MAX ? " hide" : "")).join("")}${likes.length > MAX ? `<button class="tl-more" type="button">+${likes.length - MAX}</button>` : ""}</div>` : "";
        const coms = p.comments.length ? `<ul class="tl-comments">${p.comments.sort((a, b) => a.created - b.created).map((c) => `<li>${thumb(c.photo, m)}<div><p>${esc(c.text)}</p><small>${timeFmt.format(c.created)} · ${esc(m.names[c.photo] || `foto ${c.photo.split("/")[1]}`)}</small></div></li>`).join("")}</ul>` : "";
        return `<section class="owner-card tl-card">
          <div class="tl-head"><div>${nieuw ? '<span class="new">Nieuw</span>' : ""}<b>${esc(p.who || ANON)}</b></div><span>${t1 === t2 ? t1 : `${t1} – ${t2}`}</span></div>
          <p class="tl-sum">${esc(sum)}</p>${thumbs}${coms}</section>`;
      }).join("");
      return `<h2>${esc(dayLabel(day.ts))}</h2>${cards}`;
    }).join("");
  }

  function perPhotoHtml(d, m) {
    const per = {};
    d.likes.forEach((l) => (per[l.photo] = per[l.photo] || { photo: l.photo, album: l.album, names: [], last: 0 }).names.push(l.wie || ANON));
    d.likes.forEach((l) => (per[l.photo].last = Math.max(per[l.photo].last, l.created)));
    const rows = Object.values(per).sort((a, b) => b.names.length - a.names.length || a.photo.split("/")[1] - b.photo.split("/")[1]);
    if (!rows.length) return `<p class="muted tl-empty">Nog geen likes.</p>`;
    return `<h2>Meeste likes eerst</h2><ul class="per-photo">${rows.map((p) => {
      const id = p.photo.split("/")[1];
      return `<li>${thumb(p.photo, m, " thumb")}<div><div>${isNew(p.last) ? '<span class="new">Nieuw</span>' : ""}<b>${plural(p.names.length, "like", "likes")}</b><span class="muted"> · ${esc(m.names[p.photo] || `Foto ${id}`)}</span></div>
        <div class="names">${p.names.map(esc).join(", ")}</div></div></li>`;
    }).join("")}</ul>`;
  }

  // per persoon (zoals het eerdere overzicht): per album wie welke foto's leuk vond
  function perPersonHtml(d, m) {
    const albums = {};
    d.likes.forEach((l) => {
      const a = (albums[l.album] = albums[l.album] || {});
      const p = (a[l.pk] = a[l.pk] || { pk: l.pk, who: "", ids: [], last: 0 });
      if (!p.who && l.wie) p.who = l.wie;
      p.ids.push(l.photo.split("/")[1]);
      p.last = Math.max(p.last, l.created);
    });
    const html = Object.entries(albums).map(([album, people]) => {
      const rows = Object.values(people).sort((a, b) => b.last - a.last);
      const total = rows.reduce((n, p) => n + p.ids.length, 0);
      return `<section class="owner-card"><h3><a href="../album/${esc(album)}/">${esc(m.titles[album] || album)}</a><small>${plural(total, "like", "likes")}</small></h3>
        <ul class="people">${rows.map((p) => `<li><div class="who">${isNew(p.last) ? '<span class="new">Nieuw</span>' : ""}<b>${esc(p.who || ANON)}</b>${p.who ? "" : `<span class="muted"> · toestel ${esc(p.pk.slice(2, 8))}</span>`}<span class="muted"> · ${plural(p.ids.length, "like", "likes")} · ${ago(p.last)}</span></div>
          <div class="fotos">${p.ids.sort((a, b) => a - b).map((id) => `<a href="../album/${esc(album)}/#${esc(id)}" title="${esc(m.names[`${album}/${id}`] || "")}">${esc(id)}</a>`).join("")}</div></li>`).join("")}</ul></section>`;
    }).join("");
    return html || `<p class="muted tl-empty">Nog geen likes.</p>`;
  }
  function ago(ts) {
    const min = Math.round((Date.now() - ts) / 60000);
    if (min < 1) return "zojuist";
    if (min < 60) return `${min} min geleden`;
    const h = Math.round(min / 60); if (h < 24) return `${h} uur geleden`;
    return new Date(ts).toLocaleDateString("nl-NL", { day: "numeric", month: "long" });
  }
  const bodyHtml = (d, m) => (tab === "foto" ? perPhotoHtml(d, m) : tab === "persoon" ? perPersonHtml(d, m) : timelineHtml(d, m));

  async function renderDash() {
    const box = $("#dash");
    if (!token) { box.hidden = true; return; }
    box.hidden = false;
    if (!box.innerHTML) box.innerHTML = `<p class="muted">Laden…</p>`;
    try {
      const [d, m] = await Promise.all([api("/owner/timeline"), siteMeta()]);
      const people = new Set(d.likes.map((l) => l.pk)).size;
      box.innerHTML = `<div class="segmented tl-tabs" role="group" aria-label="Weergave">
          ${Object.entries(TABS).map(([k, v]) => `<button class="chip" type="button" data-tab="${k}" aria-pressed="${tab === k}">${v}</button>`).join("")}</div>
        <p class="tl-total">${plural(d.likes.length, "like", "likes")} van ${plural(people, "persoon", "personen")} · ${plural(d.comments.length, "reactie", "reacties")}</p>
        <div id="tl-body">${bodyHtml(d, m)}</div>`;
      box.querySelectorAll(".tl-tabs .chip").forEach((b) => b.addEventListener("click", () => {
        tab = b.dataset.tab; store.set("fa_beheer_tab", tab);
        box.querySelectorAll(".tl-tabs .chip").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
        $("#tl-body").innerHTML = bodyHtml(d, m);
      }));
      box.addEventListener("click", (e) => {
        const more = e.target.closest(".tl-more");
        if (more) more.parentElement.classList.add("open");
      });
      store.set("fa_seen", String(Date.now()));
    } catch (err) { box.innerHTML = `<p class="err">${esc(err.message)}</p>`; if (!token) render(); }
  }

  function render() { renderSetup(); renderDash(); }
  render();
  document.addEventListener("visibilitychange", () => { if (!document.hidden && token) renderDash(); });
})();
