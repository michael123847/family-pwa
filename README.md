# Family PWA

Eine installierbare Progressive Web App als Familien-Infozentrale — gehostet
öffentlich auf GitHub Pages.

Das öffentliche Frontend enthält **keine** privaten Daten. Standortdaten
(Wetter, Haltestellen) und alle Inhalte (TODO-Liste, Fotos, Hauschat) laufen
über einen privaten Heim-Server — siehe Repo **`family-pwa-server`**.

## Funktionen

- **Home** — Familienbild, 3-Tage-Wetter, nächste ÖV-Abfahrten
- **TODO** — gemeinsame Einkaufs-/Aufgabenliste, offline-fähig mit Sync
- **Diverses**
  - *Farbe* — RGB-Farbwähler mit Harmonie-Paletten
  - *Hauschat* — kleiner Familien-Messenger über den Heim-Server
- **Fotos** — Galerie mit Up- und Download

## Architektur

```
Browser (diese PWA, GitHub Pages)
        │
        │  öffentliche APIs:  open-meteo.com · transport.opendata.ch
        │  privater Server:   https://<heim-server>:8443  (nur im Heim-WLAN)
        ▼
   family-pwa-server  (privates Repo, Heim-PC)
```

Wetter und Abfahrten nutzen öffentliche APIs direkt. Der Standort (Koordinaten,
Haltestellen) wird einmalig vom Heim-Server geholt und lokal gecacht — er steht
nicht in diesem öffentlichen Repo.

## Zugang

Beim ersten Öffnen fragt die App eine Passphrase ab (PBKDF2-Gate). Den
zugehörigen Hash erzeugt man lokal mit [`tools/make-hash.html`](tools/make-hash.html)
und trägt ihn in [`src/config.js`](src/config.js) als `EXPECTED_HASH_B64` ein —
derselbe Wert dient dem Heim-Server als `PWA_TOKEN`.

Damit die Geräte dem TLS-Zertifikat des Heim-Servers vertrauen, muss einmalig
das CA-Zertifikat installiert werden — dafür die Seite unter [`setup/`](setup/)
aufrufen.

## Lokal testen

ES-Module brauchen `http://` (kein `file://`):

```bash
python -m http.server 8000
# Browser: http://localhost:8000
```

## Deployment

GitHub Pages via Actions — der Workflow [`.github/workflows/pages.yml`](.github/workflows/pages.yml)
deployt bei jedem Push auf `main`. In den Repo-Settings: Pages → Source = GitHub Actions.

## Struktur

```
family-pwa/
├── index.html, style.css, manifest.webmanifest
├── sw.js                     # Service Worker (Offline-Shell)
├── src/
│   ├── main.js               # Einstieg: Passwort-Gate → boot
│   ├── app.js                # Tab-/Subpage-Navigation, Modul-Start
│   ├── auth.js               # PBKDF2-Passwort-Gate
│   ├── config.js             # URLs, Auth-Parameter (keine Standortdaten)
│   ├── localBridge.js        # Verbindung zum Heim-Server
│   ├── siteConfig.js         # Standort-Config vom Server holen + cachen
│   └── modules/              # weather, transit, todo, swatch, photos, hauschat, background
├── setup/                    # CA-Zertifikat-Installationsseite
└── tools/make-hash.html      # Passwort-Hash-Generator
```
