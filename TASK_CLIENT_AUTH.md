# Aufgabe: Client — Dual-URL + Enrollment-Flow (Teil D)

> Aufgabenbeschreibung für eine Claude-Code-Session. **Vollständig lesen, dann
> umsetzen.** Kein Vorwissen-Kontext vorhanden — alles Nötige steht hier.
> Zwei Repos sind beteiligt; diese Session betrifft ausschliesslich **`family-pwa`**.

---

## 1. Projektübersicht

### Tech-Stack

- **Vanilla JavaScript, ES-Module** — kein TypeScript, kein Build-Schritt, kein npm
- Hosted auf **GitHub Pages**: `https://michael123847.github.io/family-pwa/`
- Service Worker (`sw.js`) für Offline-Caching
- Lokaler Heim-Server unter `https://192.168.1.187:8443` (Caddy + Express)
- Tailscale-Zugang unter `https://<hostname>.tail-xxxx.ts.net:8443` (neu)

### Relevante Dateien

```
index.html                   — App-Shell, alle Seiten/Subpages als <div>
style.css                    — Alle Styles
sw.js                        — Service Worker (VERSION-String + SHELL_ASSETS)
manifest.webmanifest
src/
  main.js                    — Einstiegspunkt: ensureAuthenticated() → boot()
  app.js                     — boot(): Tab-Navigation, Module initialisieren
  config.js                  — Zentrale Konfiguration (URLs, App-Version)
  auth.js                    — PBKDF2-Gate: wird durch Enrollment ersetzt
  localBridge.js             — isLocalAvailable(), authHeaders(), invalidateLocal()
  siteConfig.js              — Lädt /api/config vom Server
  modules/
    todo.js                  — TODO-Liste
    photos.js                — Foto-Galerie
    hauschat.js              — Familien-Messenger
    background.js            — Familienfoto (Hintergrundbild)
    weather.js               — Wetter (open-meteo, kein Server)
    transit.js               — Abfahrten (opendata.ch, kein Server)
    info.js                  — App-Info & Diagnose
    swatch.js                — Farbwähler (kein Server)
    audiotest.js             — Audiotest (kein Server)
    ai.js                    — KI-Assistent (Ollama-Proxy via lokalem Server)
```

### Aktueller Auth-Flow (`main.js`)

```js
import { ensureAuthenticated } from './auth.js';
import { boot } from './app.js';

async function main() {
  await ensureAuthenticated(); // zeigt Passphrase-Dialog wenn kein Token
  boot();
}
main();
```

`auth.js` leitet per PBKDF2 einen Token aus einer Passphrase ab und vergleicht
ihn mit `CONFIG.AUTH.EXPECTED_HASH_B64`. Der abgeleitete Hash **ist** der Bearer-Token.

### Aktuelles `config.js` (Auszug)

```js
export const CONFIG = {
  APP_VERSION: 'v21',
  LOCAL_BASE:        'https://192.168.1.187:8443',  // ← wird ersetzt
  LOCAL_HEALTH_PATH: '/api/health',
  LOCAL_TODO_PATH:   '/api/todos',
  LOCAL_PHOTOS_PATH: '/api/photos',
  LOCAL_CHAT_PATH:   '/api/chat',
  LOCAL_CONFIG_PATH: '/api/config',
  LOCAL_BG_PATH:     '/assets/family-bg.jpg',
  LOCAL_AI_PATH:     '/api/ai/chat',
  HEALTH_TIMEOUT_MS: 1500,
  // weitere Felder ...
  AUTH: {                          // ← wird entfernt
    SALT: '...',
    ITERATIONS: 200_000,
    HASH_BITS: 256,
    EXPECTED_HASH_B64: '...',
  },
};
```

### Aktuelles `localBridge.js`

```js
let _available = null;
let _lastCheck = 0;
const TTL = 30_000;

export function authHeaders() {
  const t = getToken();  // aus auth.js: localStorage 'pwa.auth.token'
  return t ? { Authorization: 'Bearer ' + t } : {};
}

export async function isLocalAvailable() {
  // Cache-TTL 30s; Health-Check mit AbortController-Timeout 1.5s
  // Setzt _available und _lastCheck
}

export function invalidateLocal() { _available = null; }
```

---

## 2. Was zu tun ist

### 2.1 `config.js` anpassen

`LOCAL_BASE` ersetzen durch zwei URLs:

```js
LAN_BASE: 'https://192.168.1.187:8443',    // LAN-IP (oder Hostname T14_23)
TS_BASE:  'https://<hostname>.tail-xxxx.ts.net:8443', // Tailscale-Name
```

Den `AUTH`-Block vollständig entfernen.

Den Tailscale-Hostnamen erfährst du aus `config.json` im Server-Repo
(dort wird er nach Tailscale-Installation eingetragen) oder frage den Nutzer.

### 2.2 `localBridge.js` erweitern — Dual-URL-Logik

Dies ist die zentrale Änderung. `localBridge.js` muss:

1. **Base-URL-Wahl:** Beim Start (und bei `online`-Events) zuerst `LAN_BASE`
   probieren (1–2s Timeout). Erfolg → `LAN_BASE` nutzen. Fehlschlag → `TS_BASE`.
2. **Aktive Basis-URL** als Modul-Variable cachen (analog zum bisherigen `_available`).
3. **`getBaseUrl()`** exportieren — alle Module holen die URL hier, statt
   `CONFIG.LOCAL_BASE` direkt zu nutzen.
4. **`isLocalAvailable()`** bleibt, prüft ob irgendein Server erreichbar ist
   (LAN oder Tailscale).

Grundstruktur:

```js
let _baseUrl   = null;   // 'lan' | 'tailscale' | null
let _lastCheck = 0;
const TTL = 30_000;

/** Gibt die aktive Basis-URL zurück (LAN bevorzugt, Tailscale als Fallback). */
export function getBaseUrl() {
  if (_baseUrl === 'lan')       return CONFIG.LAN_BASE;
  if (_baseUrl === 'tailscale') return CONFIG.TS_BASE;
  return CONFIG.LAN_BASE; // Default beim allerersten Aufruf vor dem Check
}

async function detectBaseUrl() {
  const now = Date.now();
  if (_baseUrl !== null && now - _lastCheck < TTL) return;
  _lastCheck = now;

  // LAN zuerst
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), CONFIG.HEALTH_TIMEOUT_MS);
    const r = await fetch(CONFIG.LAN_BASE + CONFIG.LOCAL_HEALTH_PATH, {
      signal: ctrl.signal, cache: 'no-store', credentials: 'omit',
      headers: authHeaders(),
    });
    if (r.ok) { _baseUrl = 'lan'; return; }
  } catch {}

  // Tailscale-Fallback
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 4000); // längerer Timeout für WAN
    const r = await fetch(CONFIG.TS_BASE + CONFIG.LOCAL_HEALTH_PATH, {
      signal: ctrl.signal, cache: 'no-store', credentials: 'omit',
      headers: authHeaders(),
    });
    if (r.ok) { _baseUrl = 'tailscale'; return; }
  } catch {}

  _baseUrl = null; // nicht erreichbar
}

export async function isLocalAvailable() {
  await detectBaseUrl();
  return _baseUrl !== null;
}

export function invalidateLocal() { _baseUrl = null; _lastCheck = 0; }
```

### 2.3 Module anpassen

Alle Module, die `CONFIG.LOCAL_BASE` verwenden, müssen auf `getBaseUrl()` umstellen.
Das sind:

| Modul | Aktuell | Neu |
|---|---|---|
| `todo.js` | `CONFIG.LOCAL_BASE + CONFIG.LOCAL_TODO_PATH` | `getBaseUrl() + CONFIG.LOCAL_TODO_PATH` |
| `photos.js` | `CONFIG.LOCAL_BASE + CONFIG.LOCAL_PHOTOS_PATH` | `getBaseUrl() + CONFIG.LOCAL_PHOTOS_PATH` |
| `hauschat.js` | `CONFIG.LOCAL_BASE + CONFIG.LOCAL_CHAT_PATH` | `getBaseUrl() + CONFIG.LOCAL_CHAT_PATH` |
| `background.js` | `CONFIG.LOCAL_BASE + CONFIG.LOCAL_BG_PATH` | `getBaseUrl() + CONFIG.LOCAL_BG_PATH` |
| `siteConfig.js` | `CONFIG.LOCAL_BASE + CONFIG.LOCAL_CONFIG_PATH` | `getBaseUrl() + CONFIG.LOCAL_CONFIG_PATH` |
| `ai.js` | `CONFIG.LOCAL_BASE + CONFIG.LOCAL_AI_PATH` | `getBaseUrl() + CONFIG.LOCAL_AI_PATH` |

**Wichtig:** Die URL darf nicht einmal beim Modulstart fest gecacht werden —
`getBaseUrl()` muss **bei jedem API-Call** aufgerufen werden, da sich LAN/TS
zwischen Calls ändern kann.

Falsch: `const PHOTOS_URL = getBaseUrl() + CONFIG.LOCAL_PHOTOS_PATH;` (Modulstart)
Richtig: `const url = getBaseUrl() + CONFIG.LOCAL_PHOTOS_PATH;` (innerhalb der Funktion)

### 2.4 `auth.js` ersetzen — Enrollment-Flow

`auth.js` hatte zwei öffentliche Funktionen:
- `getToken()` — liest `localStorage['pwa.auth.token']`
- `clearToken()` — löscht `localStorage['pwa.auth.token']`
- `ensureAuthenticated()` — zeigt Passphrase-Dialog bis Token valide

Neu: `auth.js` behält `getToken()` und `clearToken()` (gleicher localStorage-Key
`pwa.auth.token` — **keine Migration nötig**, der Key ändert sich nicht).
`ensureAuthenticated()` wird durch `ensureEnrolled()` ersetzt.

```js
// auth.js — neue Version (vereinfacht)

const TOKEN_KEY = 'pwa.auth.token';

export function getToken()   { return localStorage.getItem(TOKEN_KEY); }
export function clearToken() { localStorage.removeItem(TOKEN_KEY); }
function saveToken(t)        { localStorage.setItem(TOKEN_KEY, t); }

/**
 * Prüft ob ein gültiger Token gespeichert ist.
 * Falls nein: zeigt Enrollment-UI.
 * Falls ja: kehrt sofort zurück.
 */
export async function ensureEnrolled() {
  if (getToken()) return; // bereits enrollt
  await showEnrollmentScreen();
}
```

### 2.5 Enrollment-Screen

Der Enrollment-Screen läuft ausschliesslich über die LAN-Adresse (`CONFIG.LAN_BASE`).

UI-Elemente (in `index.html` — analog zum bisherigen Auth-Dialog):
- Erklärungstext: "Erste Einrichtung — nur im Heim-WLAN möglich"
- Input: Server-Passwort (type="password")
- Input: Geräte-Name (z.B. "Nadias iPhone")
- Button: "Registrieren"
- Fehleranzeige

Enrollment-Request:
```js
const r = await fetch(CONFIG.LAN_BASE + '/api/enroll', {
  method:  'POST',
  headers: { 'Content-Type': 'application/json' },
  body:    JSON.stringify({ password, device_label }),
  credentials: 'omit',
});
if (r.ok) {
  const { token } = await r.json();
  saveToken(token);
  // Enrollment-Screen ausblenden, App starten
}
```

Fehlerfälle:
- `401`: falsches Passwort
- Netzwerkfehler / Timeout: "Nicht im Heim-WLAN — Ersteinrichtung erfordert Heimnetz"
- Nach erfolgreichem Enrollment: Server-Restart nicht nötig, Token sofort gültig

### 2.6 `main.js` anpassen

```js
// Vorher:
import { ensureAuthenticated } from './auth.js';
await ensureAuthenticated();

// Nachher:
import { ensureEnrolled } from './auth.js';
await ensureEnrolled();
```

### 2.7 `tools/make-hash.html` entfernen

Diese Datei wird obsolet — einfach löschen.

### 2.8 `sw.js` + Versionsbump

- `VERSION` in `sw.js` erhöhen (z.B. auf `v22`)
- `APP_VERSION` in `config.js` entsprechend erhöhen
- Geänderte Dateien in `SHELL_ASSETS` prüfen (alle bereits gelisteten Module
  sind bereits enthalten; `tools/make-hash.html` aus der Liste entfernen falls vorhanden)

---

## 3. Reihenfolge der Umsetzung

1. `config.js`: `LOCAL_BASE` → `LAN_BASE` + `TS_BASE`, `AUTH`-Block entfernen
2. `localBridge.js`: `getBaseUrl()` + `detectBaseUrl()` implementieren
3. Alle 6 Module auf `getBaseUrl()` umstellen (Suchen/Ersetzen `CONFIG.LOCAL_BASE`)
4. `auth.js` ersetzen: `getToken`/`clearToken` behalten, `ensureEnrolled()` neu
5. Enrollment-UI in `index.html` einbauen
6. `main.js`: `ensureEnrolled()` statt `ensureAuthenticated()`
7. `tools/make-hash.html` löschen
8. `sw.js` + `config.js` Version bumpen

---

## 4. Wichtige Hinweise

- **`getBaseUrl()` immer frisch aufrufen** — nie beim Modulstart cachen
- **Enrollment nur über `LAN_BASE`** — nie über `TS_BASE` (der Server-Endpoint
  ist LAN-only und lehnt Tailscale-IPs mit 403 ab)
- **401-Handling** bleibt: bei HTTP 401 `clearToken()` + `location.reload()`,
  damit der Enrollment-Screen erscheint — das gilt für alle Module
- **Bestehende Geräte** verlieren beim Deploy ihren Token und müssen sich
  einmalig neu enrollen (einmalig im Heim-WLAN)
- Der Tailscale-Hostname (`TS_BASE`) muss nach Tailscale-Installation des
  Heim-PCs eingetragen werden — als Platzhalter zunächst leer lassen oder
  den Nutzer fragen
- `SHELL_ASSETS` in `sw.js`: `tools/make-hash.html` entfernen falls gelistet
