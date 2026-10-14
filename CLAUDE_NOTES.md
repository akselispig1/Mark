# Notes from the automated build runs

This file is kept up to date by the Claude Code session that checks
[issue #1](https://github.com/akselispig1/Mark/issues/1) every hour and codes against it.

## This run (2026-10-14)

**No new instructions from akselispig1** since his last feedback on the issue (reviewing the
voice-recognition ensemble change and asking for a revert after testing on real hardware). Nothing
coded this run — these notes were just out of date, so this run only brings them in line with what's
actually on `main`.

**What changed on `main` since these notes were last accurate, none of it new this run:**

- `c910575` reverted the ensemble-embedding change the previous run of these notes still described as
  active. Each clip is embedded once, not split into two halves and averaged — measured against the
  same audio, averaging two shorter, noisier readings was worse than one, and it had locked the owner
  out of his own profile.
- `7d69095` **took voice recognition out of the running app.** It needed its own microphone stream
  alongside the browser's speech recognition, and the two fought — the commonest failure was Mark
  going silently deaf, worse than the problem the feature solved. The code is untouched
  (`public/voiceid*.js`) and the enrolled voiceprint is still in `data/`; it's just not wired into
  `public/index.html` any more. See the README's "Only answer to your voice (off)" section for how to
  switch it back on. Windows Hello is unaffected — it was always the real security, not voice.
- `ae827de` gave Mark a real Google Docs connection (OAuth, `google.js`): `doc_create`, `doc_append`,
  `doc_read`, `drive_find`, scoped to `drive.file` only (the files he makes, nothing else in Drive).
- `3aa03ff` let him write documents with Claude's own Artifact tool (no Google account needed) and
  made links in his replies show up as clickable cards on the orb instead of being silently stripped
  as unspeakable text.

**Open and unreviewed, still sitting since late September — not touched this run:**
- PR #2 — `voiceid: fix trim() over-clipping continuous speech`
- PR #3 — `CLAUDE_NOTES: catch the notes up to current main (no code change)`
- PR #4 — `CLAUDE_NOTES: bring current state and voiceid history up to date`

None of these have had a review, a comment, or CI activity in weeks. They're left alone pending
akselispig1's call — nothing in the standing instructions asks for them to be merged or closed.

## How to run Mark locally on Windows

```
npm install
npm run setup                 :: downloads the hand model (~93 MB), one-time
                               :: add --voice if you want the (currently unwired) voice model too
```

Then put a Claude token in `.env` (copy `.env.example` first), on the `CLAUDE_CODE_OAUTH_TOKEN=`
line. Get one by running `claude setup-token`.

```
npm start                     :: starts the server
```

Open **http://localhost:7777** in Chrome or Edge (needs WebGPU for hand tracking + the browser's own
speech recognition — Chrome/Edge only). Say "Mark, ..." or click the orb, or press Space, to talk; you
can also type into the box at the bottom.

```
npm run doctor                :: reports what's set up and what isn't
```

Node 20+ is required. `data/` (vault, voiceprint, memory, conversations, browser profile) is created
on first use, never committed, and never touched by an update without a backup first.
