// Like-meldingen: één melding per persoon per dag (vaste tag → wordt bijgewerkt i.p.v. gestapeld),
// met de dagstand van die persoon. Pas versturen als die persoon even klaar is met liken.
export const QUIET = 5 * 60000;     // zoveel stilte na de laatste like
export const MAX_WAIT = 30 * 60000; // maar nooit langer wachten dan dit na de eerste nieuwe like

const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Amsterdam", year: "numeric", month: "2-digit", day: "2-digit" });
export const amsDay = (ms) => dayFmt.format(new Date(ms)); // JJJJ-MM-DD in Nederlandse tijd

export const personKey = (r) => (r.name && r.name.trim() ? `n:${r.name.trim().toLowerCase()}` : `c:${r.client}`);

const uniq = (arr) => [...new Set(arr)];
const fotos = (n) => (n === 1 ? "een foto" : `${n} foto's`);

// rows: likes van de laatste ±36 uur {photo, album, client, name, created}, oplopend op tijd.
// state: { base, people: {persoon: tijdstip laatst gemelde like} }.
// Geeft per persoon die klaar is een melding terug (niets wordt hier verstuurd of opgeslagen).
export function planDigests(rows, state, now, { titles = {}, names = {}, siteUrl = "" } = {}) {
  const byPerson = new Map();
  for (const r of rows) {
    const k = personKey(r);
    if (!byPerson.has(k)) byPerson.set(k, []);
    byPerson.get(k).push(r);
  }
  const out = [];
  for (const [key, list] of byPerson) {
    const seen = state.people[key] ?? state.base;
    const fresh = list.filter((r) => r.created > seen);
    if (!fresh.length) continue;
    const first = Math.min(...fresh.map((r) => r.created));
    const last = Math.max(...fresh.map((r) => r.created));
    if (now - last < QUIET && now - first < MAX_WAIT) continue; // nog bezig

    const day = amsDay(last);
    const dayRows = list.filter((r) => amsDay(r.created) === day || r.created > seen);
    const dayPhotos = uniq(dayRows.map((r) => r.photo));
    const newPhotos = uniq(fresh.map((r) => r.photo));
    const named = list.find((r) => r.name && r.name.trim());
    const who = named ? named.name.trim() : "Iemand (zonder naam)";
    const when = day === amsDay(now) ? "vandaag" : "gisteren";

    const albums = uniq(dayRows.map((r) => r.album)).map((a) => titles[a] || a);
    const soorten = uniq(newPhotos.map((p) => names[p]).filter(Boolean));
    const lijst = soorten.length
      ? soorten.slice(0, 3).join(", ") + (soorten.length > 3 || newPhotos.some((p) => !names[p]) ? " …" : "")
      : "";
    const nieuw = newPhotos.length < dayPhotos.length ? `${newPhotos.length} nieuw${lijst ? ": " : ""}` : "";
    const body = [albums.join(", "), nieuw + lijst].filter(Boolean).join(" · ");

    const [slug, id] = newPhotos[0].split("/");
    out.push({
      key,
      upTo: last,
      title: `❤️ ${who} vond ${when} ${fotos(dayPhotos.length)} leuk`,
      body,
      tag: `likes-${day}-${key}`,
      url: newPhotos.length === 1 ? `${siteUrl}album/${slug}/#${id}` : `${siteUrl}beheer/`,
    });
  }
  return out;
}
