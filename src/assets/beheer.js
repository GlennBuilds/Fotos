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
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const ub64 = (s) => { s = s.replace(/-/g, "+").replace(/_/g, "/"); s += "=".repeat((4 - (s.length % 4)) % 4); return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); };
  let token = store.get("fa_owner");

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
        <p class="muted">Je krijgt een melding bij reacties (direct) en likes (gebundeld per 10 minuten).</p>
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

  function ago(ts) {
    const m = Math.round((Date.now() - ts) / 60000);
    if (m < 1) return "zojuist";
    if (m < 60) return `${m} min geleden`;
    const h = Math.round(m / 60); if (h < 24) return `${h} uur geleden`;
    return new Date(ts).toLocaleDateString("nl-NL", { day: "numeric", month: "long" });
  }

  async function renderDash() {
    const box = $("#dash");
    if (!token) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = `<p class="muted">Laden…</p>`;
    try {
      const d = await api("/owner/overview");
      const base = SITE.base || "../";
      const byAlbum = {};
      d.likes.forEach((r) => (byAlbum[r.album] = byAlbum[r.album] || []).push(r));
      const likeHtml = Object.entries(byAlbum).map(([album, rows]) => {
        const total = rows.reduce((a, r) => a + r.likes, 0);
        return `<section class="owner-card"><h3><a href="../album/${esc(album)}/">${esc(d.titles[album] || album)}</a><small>${total} likes</small></h3>
          <ul class="people">${rows.map((r) => {
            const fotos = String(r.fotos || "").split(",").filter(Boolean).sort((a, b) => a - b);
            return `<li><div class="who"><b>${esc(r.wie)}</b>${r.wie === "Anoniem" ? `<span class="muted"> · toestel ${esc(r.toestel)}</span>` : ""}<span class="muted"> · ${r.likes} ${r.likes === 1 ? "like" : "likes"} · ${ago(r.laatst)}</span></div>
              <div class="fotos">${fotos.map((f) => `<a href="../album/${esc(album)}/#${esc(f)}">${esc(f)}</a>`).join("")}</div></li>`;
          }).join("")}</ul></section>`;
      }).join("") || `<p class="muted">Nog geen likes.</p>`;
      const comHtml = d.comments.length ? `<ul class="comments">${d.comments.map((c) => {
        const id = c.photo.split("/")[1];
        return `<li><div class="who"><b>${esc(c.name)}</b><span class="muted"> · ${ago(c.created)} · <a href="../album/${esc(c.album)}/#${esc(id)}">${esc(d.titles[c.album] || c.album)}, foto ${esc(id)}</a></span></div><p>${esc(c.text)}</p></li>`;
      }).join("")}</ul>` : `<p class="muted">Nog geen reacties.</p>`;
      box.innerHTML = `<h2>Wie heeft er geliket</h2>${likeHtml}<h2>Reacties</h2>${comHtml}`;
    } catch (err) { box.innerHTML = `<p class="err">${esc(err.message)}</p>`; if (!token) render(); }
  }

  function render() { renderSetup(); renderDash(); }
  render();
  document.addEventListener("visibilitychange", () => { if (!document.hidden && token) renderDash(); });
})();
