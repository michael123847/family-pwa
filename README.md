# Family PWA

Installierbare Progressive Web App als Familien-Infozentrale. Öffentliches
Frontend auf GitHub Pages, alle Daten auf einem privaten Heim-Server
(`family-pwa-server`, privates Repo).

Dieses Repo enthält **keine** privaten Daten, **keine** IPs und **keine**
Zugangsschlüssel.

## Funktionen

- **Home** — Familienbild, 3-Tage-Wetter, nächste ÖV-Abfahrten
- **TODO** — gemeinsame Liste, offline-fähig
- **Fotos** — Galerie mit Ordnern (Up/Download)
- **Hauschat** — Familien-Messenger, optionale Push-Benachrichtigungen,
  Ultraschall-Fallback via [ggwave](https://github.com/ggerganov/ggwave)
- **KI-Assistent** — Chat mit lokalem Ollama-Modell, screen-lock-resistent
- **Share** — Allzweck-Dateiablage, ≤ 10 MB
- **Farbe / Info** — Hilfsmittel & Diagnose

Rollen-basiert (Visitor / Family / Power / Admin) — die ersten beiden ohne
Server-Zugriff.

## Repo-Layout

Seit der Mai-2026-Reorg:

```
family-pwa/
├── LICENSE                ← MIT
├── README.md
├── .github/workflows/     ← Pages-Deploy (publisht ./public)
├── public/                ← alles, was an den Browser ausgeliefert wird
│   ├── index.html
│   ├── style.css
│   ├── sw.js
│   ├── manifest.webmanifest
│   ├── src/               ← App-Code
│   ├── vendor/ggwave/     ← Ultraschall-Bibliothek (MIT)
│   └── setup/             ← Root-CA-Download für Endgeräte
└── archive/               ← lokales, gitignored Material (Legacy-Code, Notizen)
```

## Setup

Frontend ist statisches HTML/JS, kein Build-Schritt. Service-Worker bringt
App-Shell-Cache und Push-Empfang mit.

```bash
cd public && python -m http.server 8000   # lokale Tests; live läuft es auf GitHub Pages
```

Vollständige Einrichtung (mkcert, Caddy, Express, Bonjour, Tailscale,
NSSM-Dienste): siehe `family-pwa-server` (privates Repo).

Auf jedem Endgerät einmalig die mkcert-CA installieren über die Seite unter
[`public/setup/`](public/setup/) (live URL: `<eure-pages-domain>/setup/`).

Ultraschall-Bibliothek (`public/vendor/ggwave/ggwave.js`) wird nicht
mitgeliefert — siehe [`public/vendor/ggwave/README.md`](public/vendor/ggwave/README.md).
Ohne sie bleibt die Ultraschall-Funktion ausgeblendet, der Rest läuft normal.

## Versionierung

`public/src/config.js` → `APP_VERSION` und `public/sw.js` → `VERSION` werden
bei jedem Deploy gemeinsam hochgezählt; die Info-Subapp zeigt beide an.

## Deployment

GitHub Pages via Actions ([`.github/workflows/pages.yml`](.github/workflows/pages.yml)).
Workflow uploadet `./public` als Pages-Artefakt — der Repo-Root (README,
LICENSE, archive/) bleibt unsichtbar für Besucher.
