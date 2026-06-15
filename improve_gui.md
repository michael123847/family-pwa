# Family PWA — UX review & improvement suggestions (frontend + backend)

*Author: UX pass, 2026-06-14. Same lens applied to StockScanner-pwa. Mockup/code is ground truth.*

This reviews **`C:\Projects\family-pwa`** (public PWA) and its backend
**`C:\Server\family-pwa-server`** (Node/Express `api/server.js`) through a UX lens and proposes
improvements for both. Findings are graded **P0** (misleads or blocks the user) → **P1** (real
friction) → **P2** (polish). Each has a concrete fix and the file it lives in.

**Method note:** fully read `index.html`, `app.js`, `weather.js`, `transit.js`, `todo.js`,
`info.js`, the design tokens in `style.css`, and the backend route map. Findings about
`photos/ai/hauschat/share/adminboard/swatch/audiotest` are grounded in their DOM in `index.html`
and should be spot-verified against their module code before implementing.

---

## How the app is structured today

- **Tab bar (4):** Home · TODO · Fotos · Diverses. TODO/Fotos are gated `data-min-role="Family"`.
- **Home:** family photo + 3-day weather + next departures (weather/transit need server-seeded
  `/api/config`; double-tap opens MeteoSwiss / SBB).
- **Diverses (menu → 6 subpages):** Farbe (color picker), Hauschat (Family), KI-Assistent (Power),
  Share (Power), Admin-Notizen (Admin), Info.
- **Roles:** Visitor < Family < Power < Admin. `applyRoleVisibility()` hides `[data-min-role]`
  elements below the device's role (`app.js:38`); the server enforces the same via `requireRole()`.
- **Offline-first** TODO with optimistic UI + pending-queue + ultrasound P2P (`todo.js`).

---

## P0 — Misleads or blocks the user

**F-1. A below-Family device is a silent dead-end (frontend + backend).**
A freshly installed device is a **Visitor**: TODO, Fotos, and most of Diverses are simply *hidden*
(`applyRoleVisibility`, `app.js:38`). The user sees a near-empty app with **no explanation** and
**no path forward** — they don't know they're a Visitor, that approval exists, or how to get it.
The backend already supports this gracefully (`/api/enroll-self`, auto-promote window
`/api/enroll-mode`, and 403s that include `haveRole`, `server.js:544-552`) — but the frontend uses
none of it for guidance.
*Fix:* add a first-run/role banner: "Dieses Gerät ist als **Besucher** angemeldet. Bitte einen
Admin um Freigabe bitten." Consume the 403 `haveRole` payload to show "Freigabe nötig" on locked
items instead of hiding them entirely. (See B-1/B-2.)

**F-2. "Cache leeren & neu laden" is destructive with no confirmation.**
`hardReload()` (`info.js:117`) unregisters the SW and deletes **every** cache, then reloads — a
factory reset that forces the device back through the home-Wi-Fi bootstrap. One mis-tap on a phone
away from home leaves the app non-functional. The amber border is the only warning.
*Fix:* a confirm step — and you already have the perfect component: the **Share conflict dialog**
(`#share-conflict-*`, `index.html:261`) is a clean modal. Generalize it into a reusable confirm and
use it here ("Alle lokal gespeicherten Daten löschen?").

**F-3. "Server unreachable" is worded four different ways and the status color is ambiguous.**
Each module ships its own offline banner with different copy for the *same* state:
`📵 Nicht im Heim-WLAN — TODO-Liste nicht verfügbar`, `Server nicht erreichbar — KI nicht
verfügbar`, `Nicht im Heim-WLAN — Galerie nicht verfügbar`, `Nicht im Heim-WLAN — Ablage nicht
verfügbar` (`index.html:56,194,253,327`). The status dot uses **amber** for offline
(`style.css:82`) — amber reads as *warning/error*, but "not on the home network" is a normal,
expected state.
*Fix:* one shared offline-banner component + one canonical sentence ("Heim-Server nicht erreichbar
— Daten sind offline nicht verfügbar"). Make the dot **grey** for "away/unknown", **green** for
online, and reserve red/amber for genuine faults.

---

## P1 — Real friction or confusion

**F-4. "Diverses" is a junk drawer; IA is incidental, not conceptual.**
It mixes a **toy** (color picker) with **daily comms** (Hauschat), an **AI assistant**, **file
share**, **admin notes**, and **diagnostics** — six unrelated things behind one generic label, ranked
by nothing in particular (`index.html:65-99`). A family member opening "Diverses" to chat scrolls
past a color picker to find it.
*Fix:* reorder by everyday use (Hauschat first), and consider **promoting Hauschat** to the tab bar
(it's the one daily-interaction feature buried two levels deep) while demoting the color picker to
the bottom. Group the rest under a clear "Werkzeuge" vs "Verwaltung" split.

**F-5. The TODO "Done" button is label-as-state and mixes languages.**
A not-done item's button says **"Done"** (English, action-ish); a done item's button says
**"Erledigt"** (German, a *state*, not the action it performs) (`todo.js:248-250`). So the control
flips language and stops describing its action.
*Fix:* use action verbs in one language — "Erledigen" / "Rückgängig" — or replace with a checkbox
(clearer affordance for a shopping list the whole family uses).

**F-6. Weather and departures hide a double-tap shortcut with no affordance.**
Double-tapping the weather card opens MeteoSwiss; double-tapping departures opens SBB
(`weather.js:121`, `transit.js:148`). Nothing on screen hints this exists, so it's effectively
undiscoverable.
*Fix:* a small visible "↗ MeteoSwiss" / "↗ SBB" link or icon in each section header (keep the
double-tap as a bonus).

**F-7. German app with English leakage throughout.**
`lang="de"`, yet: page `<title>Info App</title>`, the TODO "Done" button, "TODO-Liste", color
picker `<h1>Color Picker</h1>` (`index.html:139`), menu item "Share". Mixed language makes the app
feel unfinished.
*Fix:* pick German consistently (To-do / Erledigen / Farbwähler / Ablage) — or decide the English
terms are intentional brand and apply them consistently.

**F-8. Inline-editable TODO text has no edit affordance.**
Items are `contenteditable` with an `onblur` save (`todo.js:243-247`); nothing signals the text is
editable, so users discover it by accident — or trigger it by accident while trying to tap "Done".
*Fix:* a small edit (✎) affordance or a clearer tap target separation between the text and the
action buttons; show a focus ring/background when editing.

**F-9. Color-picker harmony labels are truncated.**
"Komplem.", "Triadisch", "Quadrat." (`index.html:174-177`) clip the real words.
*Fix:* shorter full words or a 2-row wrap; on a phone these fit if the row scrolls.

**F-10. Subpage navigation doesn't reset scroll or move focus.**
`show()` only toggles `.active` (`app.js:144`); it doesn't scroll the new page to top or move focus,
so returning from a long subpage can land mid-scroll, and keyboard/AT focus is left on the now-hidden
page.
*Fix:* on navigate, scroll the activated page to top and move focus to its first heading
(`tabindex="-1"` on the `.section-label`).

---

## P2 — Polish & state-of-the-art

**F-11. Ultrasound is family-facing jargon.** "📡 Ultraschall", "Modus: hörbar/Ultraschall"
(`index.html:51-54`, `todo.js:135-137`) will confuse non-technical members. The Audiotest page does
this well (it has a plain-language hint, `index.html:121`). Mirror that one-liner wherever the
ultrasound bar appears.

**F-12. No button hierarchy.** Primary, secondary, and destructive buttons look alike
(`.info-btn`, `.photo-upload-btn`, `.add-btn`); only the share dialog distinguishes
primary/cancel (`index.html:266-268`). Generalize that into `.btn-primary` / `.btn-danger` tokens and
apply (send/upload = primary; cache-clear/delete = danger).

**F-13. Status-dot semantics** — see F-3; grey/green/red is the conventional triad.

**F-14. Photos "Drucken" on mobile** (`index.html:344`) is an unusual action on phones; verify it
behaves (or hide it on touch devices).

**F-15. Darstellung (scale) is buried in Info** — acceptable (it's a settings control), consistent
with StockScanner; no change needed.

---

## Backend (family-pwa-server) — UX-affecting changes

The server is well-structured for auth and roles; these are the changes that show up in the **user
experience**, not internal refactors.

**B-1. Make the helpful 403 visible.** `requireRole()` already returns `{ error: 'Insufficient
role', haveRole }` (`server.js:544-552`) — but the client throws this away (e.g. `todo.js` only
special-cases 401). Wire a shared 403 handler in the frontend that reads `haveRole` and shows
"Du bist als **{haveRole}** angemeldet — Freigabe für **{needed}** nötig." Pairs with F-1.

**B-2. Close the enrollment/onboarding loop.** New devices enroll as **Visitor**
(`/api/enroll-self`, `server.js:845`); promotion needs an admin to open the auto-promote window
(`/api/enroll-mode`). Today the new user has no signal they're "pending". Add: (a) a frontend
"angemeldet, wartet auf Freigabe" state after enrollment, and (b) an **admin notification** when a
device enrolls (you already have Admin-Notizen + push infrastructure — surface new enrollments
there). Optionally a lightweight `POST /api/request-access` so a Visitor can ping the admin.

**B-3. Consistent, user-mapped error copy.** Audit that every route returns a `{error}` envelope and
that the client maps the meaningful statuses to friendly German: **401**→re-auth (handled in todo),
**403**→role (B-1), **409**→conflict (share already has a nice dialog), **413**→"Datei zu groß
(max. 10 MB)" for Share/Photos uploads (`index.html:249` promises the limit — verify the user
actually sees that message on rejection, not a generic failure).

**B-4. Reduce the home-Wi-Fi bootstrap cliff.** Weather/transit only work after `/api/config` has
been fetched once on the home network (`weather.js:135`, `transit.js:151`, served by
`server.js:1152`). A device set up off-home shows "Standort noch nicht geladen" with no next step.
*Fix:* either allow the config fetch over Tailscale on first run, or add an explicit onboarding line
("Einmal mit dem Heim-WLAN verbinden, um Wetter & Abfahrten zu aktivieren") with a retry button.

**B-5. (Note, not UX) `api/server.js` is one 2794-line file.** Out of scope for a GUI pass, but
splitting routes by domain would make the B-1…B-4 changes safer to land. Flagged only.

---

## Consolidated action list (suggested order)

| # | Change | Where | Tier |
|---|--------|-------|------|
| 1 | Role/enrollment guidance + consume 403 `haveRole` | app.js, new banner, server B-1/B-2 | P0 |
| 2 | Confirm dialog for cache-clear (reuse share-conflict modal) | info.js, index.html | P0 |
| 3 | One offline-banner component + canonical copy; grey/green/red dot | index.html, style.css, modules | P0 |
| 4 | Reorder/promote Diverses (Hauschat up, color picker down) | index.html, app.js | P1 |
| 5 | TODO action-verb button / checkbox; fix EN/DE leakage | todo.js, index.html | P1 |
| 6 | Visible MeteoSwiss/SBB links | index.html, weather.js, transit.js | P1 |
| 7 | Edit affordance for TODO items; scroll/focus on subpage nav | todo.js, app.js | P1 |
| 8 | Button hierarchy tokens; ultrasound plain-language hints | style.css, index.html | P2 |
| 9 | Error-copy mapping (413/409/403) end to end | server.js + module fetch handlers | P1 |

---

## Cross-cutting (state-of-the-art)

- **One connectivity + role context**, not per-module banners — a single source the modules
  subscribe to (the `pwa:server` event already exists; add `pwa:role`).
- **A small component system**: buttons (primary/secondary/danger), banners, empty states, and a
  reusable confirm/modal (generalize the share-conflict dialog). Most P2 inconsistencies dissolve
  once these exist.
- **Progressive disclosure** for advanced/rare features (ultrasound, admin tools) so the everyday
  surface (Home, TODO, Fotos, Hauschat) stays calm.
- **A real first-run flow**: install → enroll → (pending) → role granted, with copy at each step.
  This is the single biggest UX gap and the one most worth doing first.

---

## To verify before implementing

- Whether `ai.js / hauschat.js / share.js / photos.js` already surface 413/409/403 copy (B-3).
- Whether "Drucken" works on mobile (F-14).
- Exact frontend SW/version constants and `style.css` button/banner classes to touch (this doc names
  the DOM anchors; confirm the JS handlers before editing).
- The repo's tag scheme is `v1.0.<n>` in both family repos (per project memory) — bump accordingly if
  these land.
