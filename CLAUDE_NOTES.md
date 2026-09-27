# Notes from the automated build runs

This file is kept up to date by the Claude Code session that checks
[issue #1](https://github.com/akselispig1/Mark/issues/1) every hour and codes against it.

## This run (2026-09-27, later)

No new instruction on issue #1 since the last reply there — nothing coded this run.

**State of `main`, for context** (all landed from the owner's own machine since the last automated
run, not from this bot):

- `c910575` — dropped the ensemble embedding entirely and replaced the fixed 0.58 match threshold
  with one calculated per-owner from his own enrolment consistency (`bar()`). This superseded the
  `embedVersion` fix this bot had put up as PR #2.
- `7d69095` — voice recognition (`public/voiceid*.js`) is switched off in the running app: it fought
  the browser's own speech recognition for the microphone and cost more (Mark going silently deaf)
  than it earned. The code and the enrolled voiceprint in `data/` are untouched; `npm run setup
  -- --voice` fetches the speaker model again if it's switched back on. Windows Hello is unchanged
  and remains the only real gate on secrets.
- `ae827de` — real Google Docs support (`google.js`, OAuth via loopback redirect, `drive.file`
  scope only, refresh token in `data/google.json`). Needs a Google OAuth client the owner creates
  himself (README has the steps) via `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` in `.env`.
- `3aa03ff` — Mark now knows he can write documents (the Artifact tool was already in his session;
  the persona just didn't say so), and links in his speech/tool output now surface as a clickable
  card on the orb instead of being silently stripped by `speakable()`.

**PR #2** (`voiceid-embed-version-fix`, this bot's branch) is still open: just the `trim()` fix for
clipping continuous speech, mergeable cleanly against current `main`, no CI configured on this repo,
no review comments waiting on a reply. Left as-is pending the owner's own review/merge.

## Earlier run (2026-09-27)

**Instruction from issue #1:** "Can you improve the voice sensing and create a better recognition
and only listen to the voice that has been learnt."

**What changed**, all in `public/voiceid.js` (no other files touched):

- **Adaptive noise floor.** `trim()` used to cut anything quieter than one fixed number. It now
  measures each clip's own quietest stretches and trims relative to that, so a noisy room (fan,
  traffic, a TV) doesn't leave background hiss inside the voiceprint, and a very quiet room doesn't
  get over-trimmed.
- **Ensemble embeddings.** Any clip long enough to spare (~1.6s or more — which is every enrollment
  take, and most live utterances) is now split into two overlapping halves, embedded separately, and
  averaged into one steadier reading. A cough or a door slamming in one half no longer skews the
  whole voiceprint the way a single embedding of it would. This improves both the quality of the
  eight enrollment recordings and every live recognition check.
- **Stricter matching against the learned pool.** Recognition used to accept if you matched *any
  single* sample he'd picked up since enrollment — one drifted or mislearned sample was all it took.
  It now averages your best couple of matches from that pool (`LEARN_TOPK = 2`) instead of just the
  luckiest one, so only-you-recognised stays true even as the learned pool grows. The original
  sit-down recordings (`core`) are unchanged: they're deliberate, so they're still judged by their
  single best match.

Nothing about the doorman/lock model changed: voice recognition still fails open (a broken model
never locks the owner out — CLAUDE.md rule), Windows Hello still gates every actual secret, and no
password ever reaches the model. This was purely about making the "was that you?" check more
accurate.

**Not done / left alone:** the grace window after a recognised utterance (`GRACE_MS`, currently 8s)
still accepts *any* short follow-up ("yes", "stop") without a fresh voice check — that's existing,
deliberate behaviour, not something the issue asked to change, and tightening it risks locking the
owner out mid-conversation. Flagged here in case a future instruction wants it revisited.

**Testing:** `node --check` passes on every touched/adjacent file. This is browser-only code (mic,
AudioWorklet, WebGPU/WASM) with no model files or browser available in this build environment, so it
could not be exercised live this run — worth a real enrol/recognise pass on a PC with a mic before
trusting the new thresholds blindly.

## How to run Mark locally on Windows

```
npm install
npm run setup                 :: downloads the hand-tracking model, one-time (~7 MB)
```

Voice recognition (answering only to your voice) is switched off in the running app by default —
skip this unless you're turning it back on:

```
npm run setup -- --voice       :: also fetches the ~86 MB speaker model
```

Then put a Claude token in `.env` (copy `.env.example` first), on the `CLAUDE_CODE_OAUTH_TOKEN=`
line. Get one by running `claude setup-token`. Everything else in `.env` (Twilio, Telegram, Alexa,
Google Docs via `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`) is optional — see the README for setup.

```
npm start                     :: starts the server
```

Open **http://localhost:7777** in Chrome or Edge (needs WebGPU + the browser's own speech
recognition — Chrome/Edge only). Say "Mark, ..." or click the orb, or press Space, to talk; you can
also type into the box at the bottom.

```
npm run doctor                :: reports what's set up and what isn't
```

Node 20+ is required. `data/` (vault, voiceprint, memory, conversations) is created on first use,
never committed, and never touched by an update without a backup first.
