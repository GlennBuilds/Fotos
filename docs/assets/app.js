/* Fotoalbum — interactie */
(() => {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* privémodus */ } },
  };
  const SITE = JSON.parse($("#site-data").textContent);
  const LOCAL = ["localhost", "127.0.0.1"].includes(location.hostname);
  const API = (LOCAL ? "/api" : (SITE.api || "")).replace(/\/$/, "");

  const clientId = (() => {
    let id = store.get("fa_client");
    if (!id) {
      id = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));
      store.set("fa_client", id);
    }
    return id;
  })();

  async function api(path, opts = {}) {
    const init = { method: opts.method || "GET", headers: {} };
    if (opts.body) { init.body = JSON.stringify(opts.body); init.headers["Content-Type"] = "application/json"; }
    const r = await fetch(API + path, init);
    let data = {};
    try { data = await r.json(); } catch (e) { /* leeg */ }
    if (!r.ok) throw new Error(data.error || "Er ging iets mis, probeer het later nog eens.");
    return data;
  }

  const I = {
    heart: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20.5s-7.5-4.6-9.3-9.4C1.4 7.6 3.7 4 7.3 4c2 0 3.6 1.1 4.7 2.7C13.1 5.1 14.7 4 16.7 4c3.6 0 5.9 3.6 4.6 7.1-1.8 4.8-9.3 9.4-9.3 9.4z"/></svg>',
    talk: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5h16v10H9l-5 4v-14z"/></svg>',
    down: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/></svg>',
    share: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V4M8 8l4-4 4 4M5 13v6h14v-6"/></svg>',
    info: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.5v.5"/></svg>',
    close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    prev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>',
    next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>',
  };

  let toastT;
  function toast(msg) {
    let t = $(".toast");
    if (!t) { t = document.createElement("div"); t.className = "toast"; t.setAttribute("role", "status"); document.body.append(t); }
    t.textContent = msg;
    requestAnimationFrame(() => t.classList.add("show"));
    clearTimeout(toastT);
    toastT = setTimeout(() => t.classList.remove("show"), 2200);
  }
  const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const norm = (s) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");

  function timeAgo(ts) {
    const s = Math.max(1, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return "zojuist";
    const m = Math.round(s / 60); if (m < 60) return `${m} min geleden`;
    const h = Math.round(m / 60); if (h < 24) return `${h} uur geleden`;
    const d = Math.round(h / 24); if (d < 7) return d === 1 ? "gisteren" : `${d} dagen geleden`;
    return new Date(ts).toLocaleDateString("nl-NL", { day: "numeric", month: "long", year: "numeric" });
  }
  function avatarColor(name) {
    let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
    return `hsl(${h} 55% 72%)`;
  }

  /* ------------------------------------------------------------ home */
  function initHome() {
    const chips = $$(".chip");
    const q = $("#search");
    const cards = $$(".card[data-cat]");
    const years = $$(".year");
    let cat = "";
    function apply() {
      const term = norm((q && q.value || "").trim());
      let shown = 0;
      cards.forEach((c) => {
        const ok = (!cat || c.dataset.cat === cat) && (!term || c.dataset.search.includes(term));
        c.hidden = !ok; if (ok) shown++;
      });
      years.forEach((y) => { y.hidden = !$$(".card:not([hidden])", y).length; });
      $("#empty").hidden = shown > 0;
    }
    chips.forEach((ch) => ch.addEventListener("click", () => {
      cat = ch.dataset.cat;
      chips.forEach((x) => x.setAttribute("aria-pressed", String(x === ch)));
      apply();
    }));
    if (q) q.addEventListener("input", apply);
  }

  /* ------------------------------------------------------------ album */
  function initAlbum() {
    const A = JSON.parse($("#page-data").textContent);
    const photos = A.photos;
    const root = "../../";
    const key = (p) => `${A.slug}/${p.id}`;
    const src = (p, size) => `${root}img/${A.slug}/${p.id}-${size}.jpg`;
    const state = { likes: {}, comments: {}, mine: new Set(), on: !!API };
    const tiles = new Map($$(".tile").map((t) => [t.dataset.id, t]));

    /* lightbox opbouwen */
    const lb = document.createElement("div");
    lb.className = "lb"; lb.hidden = true;
    lb.setAttribute("role", "dialog"); lb.setAttribute("aria-modal", "true"); lb.setAttribute("aria-label", "Fotoweergave");
    lb.innerHTML = `
      <div class="lb-stage">
        <div class="lb-top"><span class="lb-count"></span><button class="lb-btn lb-close" aria-label="Sluiten">${I.close}</button></div>
        <button class="lb-btn lb-nav lb-prev" aria-label="Vorige foto">${I.prev}</button>
        <button class="lb-btn lb-nav lb-next" aria-label="Volgende foto">${I.next}</button>
        <figure class="lb-fig"><img class="lb-img" alt=""><div class="lb-pop">${I.heart}</div></figure>
        <div class="lb-bar">
          <button class="lb-act like" aria-pressed="false" aria-label="Vind ik leuk">${I.heart}<span class="n">0</span></button>
          <button class="lb-act talk" aria-expanded="false" aria-label="Reacties">${I.talk}<span class="n">0</span></button>
          <a class="lb-act dl" download aria-label="Download">${I.down}<span class="lbl">Download</span></a>
          <button class="lb-act share" aria-label="Deel deze foto">${I.share}<span class="lbl">Delen</span></button>
          <button class="lb-act info" aria-expanded="false" aria-label="Foto-info">${I.info}</button>
        </div>
      </div>
      <aside class="lb-panel" aria-label="Reacties en info">
        <div class="lb-panel-head"><h2>Reacties</h2><button class="lb-btn lb-pclose" aria-label="Paneel sluiten">${I.close}</button></div>
        <div class="lb-panel-body">
          <div class="lb-exif"></div>
          <ol class="lb-comments"></ol>
          <p class="lb-note"></p>
        </div>
        <form class="lb-form" autocomplete="on">
          <input class="hp" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">
          <textarea name="text" rows="2" maxlength="1000" placeholder="Schrijf een reactie…" required></textarea>
          <div class="row"><input name="name" maxlength="40" placeholder="Je naam" autocomplete="given-name" required><button type="submit">Plaatsen</button></div>
        </form>
      </aside>`;
    document.body.append(lb);
    const el = {
      img: $(".lb-img", lb), count: $(".lb-count", lb), prev: $(".lb-prev", lb), next: $(".lb-next", lb),
      like: $(".like", lb), talk: $(".talk", lb), dl: $(".dl", lb), share: $(".share", lb), info: $(".info", lb),
      pop: $(".lb-pop", lb), exif: $(".lb-exif", lb), list: $(".lb-comments", lb), note: $(".lb-note", lb),
      form: $(".lb-form", lb), title: $(".lb-panel-head h2", lb), stage: $(".lb-stage", lb),
    };
    if (!state.on) { el.like.hidden = true; el.talk.hidden = true; el.form.hidden = true; }
    el.form.elements.name.value = store.get("fa_name") || "";

    let cur = -1, pushed = false, lastFocus = null, panelMode = null;

    function paintTile(p) {
      const t = tiles.get(p.id); if (!t) return;
      const l = state.likes[key(p)] || 0, c = state.comments[key(p)] || 0;
      const b = $(".badges", t);
      b.innerHTML = (l ? `<span class="h">${I.heart}${l}</span>` : "") + (c ? `<span>${I.talk}${c}</span>` : "");
      t.classList.toggle("has-badges", !!(l || c));
    }
    function paintHead() {
      const s = $(".album-stats"); if (!s || !state.on) return;
      const l = Object.values(state.likes).reduce((a, b) => a + b, 0);
      const c = Object.values(state.comments).reduce((a, b) => a + b, 0);
      const on = document.documentElement.classList.contains("show-counts");
      s.innerHTML = `<span class="h">${I.heart}${l} ${l === 1 ? "like" : "likes"}</span><span>${I.talk}${c} ${c === 1 ? "reactie" : "reacties"}</span>` +
        `<button class="switch" type="button" role="switch" aria-checked="${on}"><i></i>Toon bij foto's</button>`;
      s.hidden = !(l || c);
    }
    function setCounts(on) {
      document.documentElement.classList.toggle("show-counts", on);
      store.set("fa_counts", on ? "1" : "0");
      const b = $(".album-stats .switch");
      if (b) b.setAttribute("aria-checked", String(on));
    }
    document.documentElement.classList.toggle("show-counts", store.get("fa_counts") === "1");
    const statsEl = $(".album-stats");
    if (statsEl) statsEl.addEventListener("click", (e) => {
      if (e.target.closest(".switch")) setCounts(!document.documentElement.classList.contains("show-counts"));
    });
    function paintActions() {
      const p = photos[cur]; if (!p) return;
      const k = key(p);
      el.like.setAttribute("aria-pressed", String(state.mine.has(k)));
      $(".n", el.like).textContent = state.likes[k] || 0;
      $(".n", el.talk).textContent = state.comments[k] || 0;
    }

    async function loadStats() {
      if (!state.on) return;
      try {
        const d = await api(`/stats?album=${encodeURIComponent(A.slug)}&client=${encodeURIComponent(clientId)}`);
        state.likes = d.likes || {}; state.comments = d.comments || {}; state.mine = new Set(d.mine || []);
        photos.forEach(paintTile); paintHead(); paintActions();
      } catch (e) { /* likes tijdelijk niet beschikbaar */ }
    }

    function show(i, dir = 0) {
      cur = (i + photos.length) % photos.length;
      const p = photos[cur];
      el.count.innerHTML = `<b>${cur + 1}</b> / ${photos.length}`;
      el.prev.disabled = cur === 0; el.next.disabled = cur === photos.length - 1;
      const small = src(p, "sm"), large = src(p, "lg");
      el.img.classList.add("fade");
      el.img.src = small;
      el.img.alt = `${A.title} — foto ${cur + 1}`;
      el.img.width = p.w; el.img.height = p.h;
      requestAnimationFrame(() => el.img.classList.remove("fade"));
      const big = new Image();
      big.onload = () => { if (photos[cur] === p) el.img.src = large; };
      big.src = large;
      [photos[cur + 1], photos[cur - 1]].forEach((n) => { if (n) new Image().src = src(n, "lg"); });
      el.dl.href = large;
      el.dl.setAttribute("download", `${A.dl}_${p.id}.jpg`);
      const ex = [];
      if (p.taken) {
        const d = new Date(p.taken);
        ex.push(`<b>${d.toLocaleDateString("nl-NL", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}, ${d.toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" })}</b>`);
      }
      if (p.camera) ex.push(`<span>${escHtml(p.camera)}${p.lens ? " · " + escHtml(p.lens) : ""}</span>`);
      if (p.settings) ex.push(`<span>${escHtml(p.settings)}</span>`);
      el.exif.innerHTML = ex.join("");
      paintActions();
      const hash = `#${p.id}`;
      if (location.hash !== hash) history.replaceState(history.state, "", hash);
      if (panelMode === "talk") loadComments();
    }

    function open(i) {
      lastFocus = document.activeElement;
      if (!pushed) { history.pushState({ lb: 1 }, "", `#${photos[i].id}`); pushed = true; }
      lb.hidden = false;
      document.documentElement.classList.add("lb-open");
      requestAnimationFrame(() => lb.classList.add("show"));
      const pref = store.get("fa_panel");
      if (pref && window.innerWidth > 820 && (pref === "info" || state.on)) setPanel(pref, false); else setPanel(null, false);
      show(i);
      $(".lb-close", lb).focus({ preventScroll: true });
    }
    function close(fromPop = false) {
      if (lb.hidden || !lb.classList.contains("show")) return;
      lb.classList.remove("show");
      document.documentElement.classList.remove("lb-open");
      const t = tiles.get(photos[cur].id);
      setTimeout(() => { lb.hidden = true; el.img.removeAttribute("src"); }, 200);
      if (!fromPop && pushed) { pushed = false; history.back(); }
      else if (!fromPop) history.replaceState(null, "", location.pathname + location.search);
      pushed = false;
      if (t) { t.scrollIntoView({ block: "nearest" }); (t || lastFocus).focus({ preventScroll: true }); }
    }

    function setPanel(mode, remember = true) {
      panelMode = mode;
      lb.classList.toggle("panel-open", !!mode);
      el.talk.setAttribute("aria-expanded", String(mode === "talk"));
      el.info.setAttribute("aria-expanded", String(mode === "info"));
      const talk = mode === "talk";
      el.title.textContent = talk ? "Reacties" : "Over deze foto";
      el.list.hidden = !talk; el.note.hidden = !talk; el.form.hidden = !talk || !state.on;
      if (remember && window.innerWidth > 820) store.set("fa_panel", mode || "");
      if (talk) loadComments();
    }

    let loadSeq = 0;
    async function loadComments() {
      if (!state.on) return;
      const p = photos[cur], seq = ++loadSeq;
      el.list.innerHTML = ""; el.note.textContent = "Reacties laden…";
      try {
        const d = await api(`/comments?photo=${encodeURIComponent(key(p))}`);
        if (seq !== loadSeq) return;
        renderComments(d.comments || []);
        state.comments[key(p)] = (d.comments || []).length; paintActions(); paintTile(p); paintHead();
      } catch (e) { if (seq === loadSeq) el.note.textContent = e.message; }
    }
    function renderComments(list) {
      el.list.innerHTML = list.map((c) => `<li><span class="avatar" style="background:${avatarColor(c.name)}">${escHtml(c.name.trim().charAt(0).toUpperCase())}</span>
        <div><div class="who">${escHtml(c.name)}<time datetime="${new Date(c.created).toISOString()}">${timeAgo(c.created)}</time></div><p>${escHtml(c.text)}</p></div></li>`).join("");
      el.note.textContent = list.length ? "" : "Nog geen reacties. Wees de eerste!";
    }

    async function toggleLike(viaDouble = false) {
      if (!state.on) return;
      const p = photos[cur], k = key(p);
      const was = state.mine.has(k);
      if (viaDouble) { el.pop.classList.remove("go"); void el.pop.offsetWidth; el.pop.classList.add("go"); if (was) return; }
      was ? state.mine.delete(k) : state.mine.add(k);
      state.likes[k] = Math.max(0, (state.likes[k] || 0) + (was ? -1 : 1));
      paintActions(); paintTile(p); paintHead();
      try {
        const d = await api("/like", { method: "POST", body: { photo: k, client: clientId } });
        state.likes[k] = d.count; d.liked ? state.mine.add(k) : state.mine.delete(k);
      } catch (e) {
        was ? state.mine.add(k) : state.mine.delete(k);
        state.likes[k] = Math.max(0, (state.likes[k] || 0) + (was ? 1 : -1));
        toast(e.message);
      }
      paintActions(); paintTile(p); paintHead();
    }

    el.form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const f = el.form.elements, btn = $("button", el.form);
      const name = f.name.value.trim(), text = f.text.value.trim();
      if (!name || !text) return;
      store.set("fa_name", name);
      btn.disabled = true;
      const p = photos[cur];
      try {
        await api("/comments", { method: "POST", body: { photo: key(p), name, text, client: clientId, website: f.website.value } });
        f.text.value = "";
        await loadComments();
        el.list.lastElementChild && el.list.lastElementChild.scrollIntoView({ block: "nearest", behavior: "smooth" });
      } catch (e) { toast(e.message); }
      btn.disabled = false;
    });

    /* events */
    tiles.forEach((t, id) => t.addEventListener("click", (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey) return;
      e.preventDefault(); open(photos.findIndex((p) => p.id === id));
    }));
    $(".lb-close", lb).addEventListener("click", () => close());
    $(".lb-pclose", lb).addEventListener("click", () => setPanel(null));
    el.prev.addEventListener("click", () => cur > 0 && show(cur - 1));
    el.next.addEventListener("click", () => cur < photos.length - 1 && show(cur + 1));
    el.like.addEventListener("click", () => toggleLike());
    el.talk.addEventListener("click", () => setPanel(panelMode === "talk" ? null : "talk"));
    el.info.addEventListener("click", () => setPanel(panelMode === "info" ? null : "info"));
    el.share.addEventListener("click", async () => {
      const url = A.url + `#${photos[cur].id}`;
      if (navigator.share) { try { await navigator.share({ title: A.title, url }); } catch (e) { /* geannuleerd */ } return; }
      try { await navigator.clipboard.writeText(url); toast("Link gekopieerd"); } catch (e) { prompt("Kopieer de link:", url); }
    });
    el.img.addEventListener("dblclick", () => toggleLike(true));
    let lastTap = 0;
    el.img.addEventListener("touchend", (e) => {
      const now = Date.now();
      if (now - lastTap < 300) { e.preventDefault(); toggleLike(true); lastTap = 0; } else lastTap = now;
    });

    let sx = 0, sy = 0, st = 0, multi = false;
    el.stage.addEventListener("touchstart", (e) => {
      multi = e.touches.length > 1; if (multi) return;
      sx = e.touches[0].clientX; sy = e.touches[0].clientY; st = Date.now();
    }, { passive: true });
    el.stage.addEventListener("touchend", (e) => {
      if (multi || (window.visualViewport && window.visualViewport.scale > 1.01)) return;
      const t = e.changedTouches[0], dx = t.clientX - sx, dy = t.clientY - sy;
      if (Date.now() - st > 800) return;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.3) { dx < 0 ? el.next.click() : el.prev.click(); }
      else if (dy > 90 && Math.abs(dy) > Math.abs(dx) * 1.5 && e.target.closest(".lb-fig")) close();
    }, { passive: true });

    document.addEventListener("keydown", (e) => {
      if (lb.hidden || e.target.closest("input, textarea")) return;
      if (e.key === "ArrowRight") el.next.click();
      else if (e.key === "ArrowLeft") el.prev.click();
      else if (e.key === "Escape") { panelMode && window.innerWidth <= 820 ? setPanel(null) : close(); }
      else if (e.key.toLowerCase() === "l") toggleLike();
    });
    window.addEventListener("popstate", () => {
      const i = photos.findIndex((p) => `#${p.id}` === location.hash);
      if (i < 0) { pushed = false; close(true); } else if (lb.hidden) { pushed = true; open(i); } else show(i);
    });

    loadStats();
    const start = photos.findIndex((p) => `#${p.id}` === location.hash);
    if (start >= 0) {
      history.replaceState(null, "", location.pathname + location.search);
      open(start);
    }
  }

  if (document.body.classList.contains("page-home")) initHome();
  if (document.body.classList.contains("page-album")) initAlbum();
})();
