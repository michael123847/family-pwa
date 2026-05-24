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
  - *Hauschat* — Familien-Messenger; zwei Übertragungswege (siehe unten)
  - *KI-Assistent* — Chat mit einem lokalen Sprachmodell (Ollama auf dem
    Heim-Server). Modell-Dropdown zur Auswahl aus den installierten
    Ollama-Modellen; nur im Heim-WLAN verfügbar.
  - *Share* — Allzweck-Dateiablage auf dem Heim-Server (jeder Dateityp, max.
    10 MB pro Datei). Originale Dateinamen bleiben erhalten; Ordner-Modell
    wie bei Fotos (max. 2 Ebenen). Bei Namens-Konflikt fragt die App im
    Windows-Stil: Ersetzen / Beide behalten / Abbrechen.
  - *Info* — Diagnose: App-/Service-Worker-Version, Server- und Mikrofon-Status,
    Geräteinfo, Knopf „Cache leeren & neu laden"
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

## Hauschat — zwei Übertragungswege

Ein gemeinsamer Nachrichten-Thread für alle Familiengeräte:

1. **Server-Relay** — Nachrichten laufen über den Heim-Server (48 h
   Aufbewahrung). Standardweg im Heim-WLAN.
2. **Ultraschall (P2P)** — bei aktiviertem Ultraschall-Modus wird die Nachricht
   zusätzlich als Tonsignal ausgesendet; nahe Geräte dekodieren sie über das
   Mikrofon. Funktioniert **ganz ohne Netzwerk** (fremdes WLAN, Flugzeug).

Der Ultraschall-Teil nutzt die [ggwave](https://github.com/ggerganov/ggwave)-
Bibliothek. Deren Datei wird **nicht** mitgeliefert — sie muss einmal in
`vendor/ggwave/` abgelegt werden, siehe [`vendor/ggwave/README.md`](vendor/ggwave/README.md).
Fehlt sie, ist die Ultraschall-Funktion einfach ausgeblendet; der Rest läuft normal.

Die Ultraschall-Logik ist als wiederverwendbare Einheit ausgelagert
([`src/ultrasoundChannel.js`](src/ultrasoundChannel.js)) — andere Subapps können
sie ebenfalls nutzen.

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

## Versionierung

`src/config.js` → `APP_VERSION` und `sw.js` → `VERSION` werden bei jedem Deploy
gemeinsam hochgezählt (gleicher Wert). Die Info-Subapp zeigt beide an — so lässt
sich auf jedem Gerät prüfen, welcher Stand wirklich geladen ist.

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
│   ├── config.js             # App-Version, URLs, Auth-Parameter (keine Standortdaten)
│   ├── localBridge.js        # Verbindung zum Heim-Server
│   ├── siteConfig.js         # Standort-Config (Wetter/Haltestellen) holen + cachen
│   ├── ultrasound.js         # Low-Level: Data-over-Sound-Codec (ggwave)
│   ├── ultrasoundChannel.js  # Wiederverwendbare P2P-Ultraschall-Einheit
│   └── modules/
│       ├── weather.js, transit.js, background.js   # Home
│       ├── todo.js                                 # TODO
│       ├── swatch.js                               # Farbe
│       ├── photos.js                               # Fotos
│       ├── hauschat.js                             # Hauschat
│       ├── ai.js                                   # KI-Assistent (Ollama-Proxy)
│       ├── share.js                                # Share (Allzweck-Dateiablage)
│       └── info.js                                 # Info
├── vendor/ggwave/            # ggwave-Bibliothek für Ultraschall (separat ablegen)
├── setup/                    # CA-Zertifikat-Installationsseite
└── tools/make-hash.html      # Passwort-Hash-Generator
```
