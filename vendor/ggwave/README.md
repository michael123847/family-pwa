# ggwave — Bibliotheksdateien hier ablegen

Die Ultraschall-Funktion von Hauschat braucht die **ggwave**-Bibliothek
(Data-over-Sound). Nötig ist **eine einzige Datei** hier in diesem Ordner:

```
vendor/ggwave/
└── ggwave.js      ← Loader inkl. eingebettetem WASM (definiert window.ggwave_factory)
```

Der npm-Build von ggwave bettet das WASM-Modul base64-kodiert direkt in
`ggwave.js` ein — eine separate `.wasm`-Datei gibt es nicht und wird nicht
gebraucht.

Solange `ggwave.js` fehlt, bleibt die Ultraschall-Funktion automatisch
deaktiviert — der Rest der App funktioniert normal weiter.

## Dateien beschaffen

Variante A — über npm (einfachste):

```bash
# in einem beliebigen temporären Ordner:
npm pack ggwave
tar -xf ggwave-*.tgz
# dann ggwave.js und ggwave.wasm aus dem entpackten "package/"-Ordner
# hierher nach vendor/ggwave/ kopieren
```

Variante B — von GitHub: Releases/Quelle unter
<https://github.com/ggerganov/ggwave> (Ordner `bindings/javascript`).

Wichtig:
- `ggwave.js` muss als klassisches Script ladbar sein und `ggwave_factory`
  global bereitstellen — das ist der Standard-Build der ggwave-JS-Bindung.
- Nach dem Hinzufügen committen und deployen; der Service Worker nimmt die
  Datei dann in den Offline-Cache auf (wichtig für den Flugzeug-Fall).

## Lizenz

ggwave steht unter der MIT-Lizenz (© Georgi Gerganov). Beim Mitliefern der
Dateien die Lizenz von ggwave beibehalten.
