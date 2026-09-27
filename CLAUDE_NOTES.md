# Notes from the automated build runs

This file is kept up to date by the Claude Code session that checks
[issue #1](https://github.com/akselispig1/Mark/issues/1) every hour and codes against it.

## Update, later the same run: superseded by a direct fix on `main`

While the PR below (`voiceid-embed-version-fix`, #2) was open, a commit landed directly on `main`
(`c910575`, "voiceid: drop the ensemble, work the threshold out from your own voice") from the
owner's own machine with real numbers: on his actual microphone, 19 of 28 pairs among his own eight
enrolment recordings failed the 0.58 threshold after the ensemble change — he was locked out of his
own assistant. That's a bigger problem than the version-mismatch this run's PR was built to fix: the
ensemble method itself reads worse on real audio, not just against profiles enrolled before it
existed. `c910575` drops the ensemble entirely and replaces the fixed threshold with one calculated
per-owner from his own enrolment consistency (`bar()`).

That supersedes everything below except the `trim()` fix, which is independent and still a real bug
regardless of which embedding method is in use. Merged `main` into the PR branch and dropped the
`embedVersion`/`embedForProfile`/`embedEnsemble` machinery — there's no second embedding method left
to disambiguate, so keeping it would just be unused complexity. The PR now contains only the
`trim()` fix described below.

## This run (2026-09-27, second run today)

**Instruction from issue #1:** detailed review of the previous run's voice-recognition change
(`1f3bb30`) — a real bug in it, a smaller thing worth a look, and a new working agreement:
branch + pull request instead of pushing straight to `main` from now on. This run follows that
new agreement: the work is on a branch, opened as a PR, not pushed to `main` directly.

### The bug: checks were measured with a different ruler than the profile they're judged against

`embedOf()` (from the last run) always averaged two overlapping halves for *any* clip long enough
— both at enrollment and at every live check. But the owner's profile on disk was enrolled the old
way, one embedding of the whole clip. Comparing an ensemble-embedded live check against a
single-embedded stored profile measurably shrinks the genuine-speaker margin (the issue measured
it: ~0.043 → ~0.016 against the 0.58 threshold, using this machine's own numbers) without shrinking
the impostor score to match — worst case, the owner gets told his own voice isn't his.

**Fix, all in `public/voiceid.js`, `server.js`, and `store.js`:**

- Split the single embedding function into `embedSingle()` (the original, one pass) and
  `embedEnsemble()` (the averaged-halves version added last run).
- Every profile now carries `embedVersion`. Enrollment always uses `embedEnsemble()` and stamps
  the new profile `embedVersion: 2`. A live check (and `testMe()`) picks whichever method matches
  the *current* profile's version via `embedForProfile()` — so a profile enrolled the old way keeps
  being checked the old way, and only a freshly re-enrolled profile gets the newer, steadier method.
- `store.js`: bumped `VERSION` to 2. The migration stamps any existing `data/voiceprint.json` that
  has no `embedVersion` with `embedVersion: 1`, so the format is explicit on disk rather than
  inferred. It runs once, is safe to run twice, and — like every migration — backs up `data/` first.
- `public/index.html`: when a profile is enrolled but not yet on `embedVersion: 2`, the voice panel
  now says so and that re-recording (optional) would move it onto the newer method. Nothing is
  forced — the old path still recognises the owner fine, per the bug above.
- `server.js`'s voiceprint save now stores whatever `embedVersion` the client sends (defaulting to
  `1` if omitted, e.g. from an older client), and the comment above that route was updated to say
  the field must never be inferred or defaulted away by a future change.

**Verified without a mic** (matching the issue's own "how to verify" section): ran the
version-routing logic (`embedForProfile`) standalone — a profile with no `embedVersion` or with
`embedVersion: 1` routes to `embedSingle`, only `embedVersion: 2` routes to `embedEnsemble` — and
ran the `store.js` migration against a simulated `data/` directory twice to confirm it's idempotent
and stamps correctly. `node --check` passes on every touched file, including the inline `<script>`
blocks in `public/index.html`.

### The smaller thing: `trim()` could clip real speech, not just silence

Flagged in the issue: if you talk right through a clip with no pause at either end, the 20th
percentile of loudness is just the quieter moments of your own speech, not silence — and the
`NOISE_MARGIN` multiplier on top of it can land *above* your actual voice, which strips real words
off the start and end instead of just the gaps.

Reproduced it with a synthetic 4s clip of continuous speech-like amplitude (no zero regions): the
old `trim()` dropped ~0.26s off the ends. Fixed by only trusting the noise-margin cutoff when it's
still clearly below what the clip typically sounds like (its 60th percentile); otherwise there's no
real quiet to cut, so it falls back to the absolute `SILENCE` floor only. Re-ran the same synthetic
test — continuous speech now keeps its full length, and a normal silence-speech-silence clip trims
exactly as before (verified byte-for-byte identical output on that case). Script used for both is
disposable and wasn't committed.

### Left alone

- The grace window (`GRACE_MS`) — the issue said to leave it for now.
- Dropping the ensemble outright (the "simpler" option in the issue) — went with the preferred,
  versioned option instead, since it keeps the accuracy improvement rather than reverting it.

**Not done / couldn't test:** still no microphone or browser in this build environment, so no live
enrol/recognise pass — worth doing on the owner's PC before trusting the new thresholds blindly,
same caveat as last run.

## Working agreement, starting this run

Per the issue: **changes now go on a branch and open as a pull request**, not pushed to `main`
directly. `main` stays whatever's already been reviewed and merged.

## How to run Mark locally on Windows

```
npm install
npm run setup                 :: downloads the voice + hand models (~93 MB), one-time
```

Then put a Claude token in `.env` (copy `.env.example` first), on the `CLAUDE_CODE_OAUTH_TOKEN=`
line. Get one by running `claude setup-token`.

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
