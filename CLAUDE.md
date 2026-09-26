# Working on Mark

Mark is a voice assistant that runs on its owner's own machine. Two people run their own copy from
this repository; nothing personal is ever shared between them.

## Run it

```
npm install
npm run setup     # downloads the voice + hand models (not in the repo, ~93 MB)
npm start         # http://localhost:7777
npm run doctor    # says what's working and what isn't
```

Node 20+. Chrome or Edge for the orb (it uses the browser's speech recognition and WebGPU).

## Shape of it

| File | What it does |
|---|---|
| `server.js` | HTTP + websockets, routes, the orb's live connection, vault operations |
| `brain.js` | the Claude Agent SDK session, the persona, and every tool he can call |
| `tools.js` `files.js` `browser.js` | weather/trains/PC control · finding and reading documents · his own Chrome |
| `vault.js` `hello.js` | encrypted passwords · Windows Hello / Face ID (WebAuthn) |
| `public/index.html` | the orb: canvas, speech in and out, turn-taking, the HUD |
| `public/voiceid*.js` | speaker recognition, so he only answers his owner |
| `store.js` | backups and migrations for `data/` |

## Rules that are deliberate — please don't quietly undo them

These were built on purpose and cost real effort. Change them only if the issue explicitly asks.

1. **Mark never sees a password.** Secrets go from the vault straight to the keyboard or clipboard.
   Nothing in `brain.js` may return a password to the model, and `browse` refuses to type into a
   password field — logins go through `browser_login`.
2. **Windows Hello approves every use of a secret.** The owner's voice is not a security check; it
   only decides who he listens to. Never make voice the gate for the vault.
3. **Banks, payments and checkout pages are off limits** to his browser (`browser.js`), including
   after a redirect.
4. **Voice recognition fails open, the vault fails closed.** If the speaker model can't load he
   listens to everyone rather than locking his owner out. The vault does the opposite.
5. **`data/` is sacred.** Never delete or rewrite files in it. If you change a file's format, bump
   `VERSION` in `store.js` and add a migration — it backs the folder up first.

## Works on a PC and on a server

Both are supported and both must keep working:

- **Localhost (a PC).** Binds `127.0.0.1`. Windows-only features (clipboard, volume, opening apps,
  window titles) are guarded by `pcOnly()` in `tools.js` — keep that pattern for anything new.
- **A server (AWS).** Binds `0.0.0.0`, runs headless, uses `PUBLIC_URL`/`MARK_DOMAIN`. His browser
  goes headless automatically off Windows. See `deploy/aws.md` and the `Dockerfile`.

Anything you add should degrade politely rather than crash when it isn't on a PC.

## House style

- Comments explain *why*, not what. Plain English, no jargon where an ordinary word works.
- User-facing text is a sentence a person would say, and names the next action when something fails.
  "The vault is locked — type your master password on the orb screen" beats "Error: locked".
- No build step, no framework. Plain ES modules and one HTML file per screen; keep it that way.
- Test what you change. The browser bits can be driven from the console — `window.__ears()`,
  `window.__voiceid`, `window.__turns()`, `window.__audio()` exist for exactly that.

## Things that will bite you

- **The microphone.** Speech recognition and the voice-ID tap both want it. Taking it can knock
  recognition off the air; that's why `__earsRestart()` exists and why the tap waits 2.5 s at start-up.
- **His voice goes through the AudioContext**, so a suspended context means silence with captions
  still showing. Any click or key press resumes it.
- **The vault locks on every restart** by design — the key only ever lives in memory.
- **Passkeys are tied to the exact address** they were made on, so a changing tunnel URL breaks them.
