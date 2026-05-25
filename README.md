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

## Setup

Frontend hier ist statisches HTML/JS, kein Build-Schritt. Service-Worker
bringt App-Shell-Cache und Push-Empfang mit.

```bash
python -m http.server 8000   # für lokale Tests; live läuft es auf GitHub Pages
```

Vollständige Einrichtung (mkcert, Caddy, Express, Bonjour, Tailscale,
NSSM-Dienste): siehe `family-pwa-server` (privates Repo).

Auf jedem Endgerät einmalig die mkcert-CA installieren über die Seite unter
[`setup/`](setup/).

Ultraschall-Bibliothek (`vendor/ggwave/ggwave.js`) wird nicht mitgeliefert —
siehe [`vendor/ggwave/README.md`](vendor/ggwave/README.md). Ohne sie bleibt
die Ultraschall-Funktion ausgeblendet, der Rest läuft normal.

## Versionierung

`src/config.js` → `APP_VERSION` und `sw.js` → `VERSION` werden bei jedem
Deploy gemeinsam hochgezählt; die Info-Subapp zeigt beide an.

## Deployment

GitHub Pages via Actions ([`.github/workflows/pages.yml`](.github/workflows/pages.yml)).
