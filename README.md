# Fotoalbum

Statische fotosite voor familie en vrienden: https://glennbuilds.github.io/Fotos/

- `albums.json` – welke albums er zijn (bronmap in iCloud, titel, plek, categorie, minimum sterren)
- `tools/fotosite.py` – verwerkt foto's (verkleind, zonder metadata/GPS) en bouwt `docs/`
- `docs/` – de gepubliceerde site (GitHub Pages)
- `worker/` – Cloudflare Worker + D1 voor likes en reacties

```bash
.venv/bin/python tools/fotosite.py add "10. Photos/2026/2026.11.07_Naam" --title "Titel" --place "Plek" --category Natuur
.venv/bin/python tools/fotosite.py publish -m "Nieuw album"
```
