// Only answer to your voice.
//
// Every few seconds of speech gets turned into a "voiceprint": 256 numbers describing the voice
// itself, not the words. Yours is recorded once and kept on this machine; anything that doesn't
// match it is ignored. The audio never leaves the device and is never stored — only the numbers.
//
// This is a doorman, not a lock. It's very good at ignoring the telly, a flatmate or a guest, and
// it is NOT proof of who you are: a recording of you could get past it. Anything that actually
// matters — passwords, money — still asks for your face or fingerprint through Windows Hello.
const SR16 = 16000;
const BUFFER_SEC = 12;
const T = {
  MATCH: 0.58,        // how alike two voiceprints must be (you ≈ .73-.80, anyone else ≈ .10-.20)
  MIN_SEC: 0.75,      // shorter than this and there isn't enough voice to judge
  MAX_SEC: 4,         // longer than this and we just use the most recent part
  ENSEMBLE_SEC: 1.6,  // long enough to split in two and average, which steadies the reading
  GRACE_MS: 8000,     // after you're recognised, short follow-ups ("yes", "stop") are taken as yours
  SILENCE: 0.006,     // never trim quieter than this, whatever the room sounds like
  NOISE_MARGIN: 2.5,  // how far above this clip's own quiet stretches counts as "someone talking"
  LEARN_AT: 0.62,     // recognised this comfortably? quietly remember this one too
  LEARN_EVERY: 60000, // but at most once a minute, so one chatty hour can't swamp the profile
  LEARN_TOPK: 2,      // judge against your best couple of learned samples, not just the luckiest one
  OUTLIER: 0.42,      // a setup recording this unlike the others was a cough, a shout or someone else
};

let ring = null, wIdx = 0, filled = 0, rate = 48000;
let worker = null, nextId = 1, waiting = new Map();
let profile = null, enabled = true, lastPass = 0, lastLearn = 0, tapping = false;

/* ---------- the model, kept in a worker so the orb never stutters ---------- */
function ask(msg, transfer = []) {
  worker ||= new Worker('/voiceid-worker.js', { type: 'module' });
  worker.onmessage = (e) => {
    const { id, ...rest } = e.data;
    waiting.get(id)?.(rest);
    waiting.delete(id);
  };
  return new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    worker.postMessage({ id, ...msg }, transfer);
  });
}
const cosine = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);

/* ---------- microphone tap ---------- */
async function startTap() {
  if (tapping) return;
  tapping = true;
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  });
  const ctx = new AudioContext();
  rate = ctx.sampleRate;
  ring = new Float32Array(SR16 * BUFFER_SEC);
  await ctx.audioWorklet.addModule('/voiceid-worklet.js');
  const tap = new AudioWorkletNode(ctx, 'voice-tap');
  ctx.createMediaStreamSource(stream).connect(tap);
  tap.port.onmessage = (e) => write(e.data);
  ask({ type: 'warm' });                                  // load the model now, not mid-sentence
  // Taking the microphone can knock Chrome's speech recognition off the air, so put it back on.
  setTimeout(() => window.__earsRestart?.(), 400);
}

/** Drop the sample rate to the 16 kHz the model expects and add it to the rolling buffer. */
function write(chunk) {
  const step = rate / SR16;
  for (let i = 0; i < chunk.length; i += step) {
    ring[wIdx] = chunk[i | 0];
    wIdx = (wIdx + 1) % ring.length;
    if (filled < ring.length) filled++;
  }
}

/** The last `ms` milliseconds of sound, oldest first. */
function recent(ms) {
  const want = Math.min(Math.round((ms / 1000) * SR16), filled);
  const out = new Float32Array(want);
  for (let i = 0; i < want; i++) out[i] = ring[(wIdx - want + i + ring.length) % ring.length];
  return out;
}

/** Cut the quiet bits off both ends, so pauses don't dilute the voiceprint. */
function trim(samples) {
  const win = 320;                                        // 20 ms
  const rms = [];
  for (let i = 0; i + win <= samples.length; i += win) {
    let sum = 0;
    for (let j = i; j < i + win; j++) sum += samples[j] * samples[j];
    rms.push(Math.sqrt(sum / win));
  }
  if (!rms.length) return new Float32Array(0);
  // A fan, traffic or the fridge sets a different floor in every room, so judge "quiet" against
  // this clip's own quietest fifth rather than one number that's wrong everywhere but a lab.
  const sorted = [...rms].sort((a, b) => a - b);
  const floor = sorted[Math.floor(rms.length * 0.2)] || 0;
  // But if you talk right through with no pause at either end, that "quietest fifth" is just the
  // softer moments of your own speech, not silence — and a margin on top of it can land above your
  // actual voice, clipping words off the start and end. Only trust the margin when it still falls
  // well short of what the clip typically sounds like; otherwise there's no real quiet to cut.
  const typical = sorted[Math.floor(rms.length * 0.6)] || floor;
  const cutoff = floor * T.NOISE_MARGIN < typical ? Math.max(T.SILENCE, floor * T.NOISE_MARGIN) : T.SILENCE;
  const loud = rms.map((v) => v > cutoff);
  let a = loud.indexOf(true), b = loud.lastIndexOf(true);
  if (a < 0) return new Float32Array(0);
  return samples.subarray(Math.max(0, (a - 2) * win), Math.min(samples.length, (b + 3) * win));
}

// Embeddings changed shape once: the original method embeds a clip in one pass, the newer one
// averages two overlapping halves (steadier, but a different ruler). A profile is only safe to
// compare against with the method it was *enrolled* with, so every profile carries the version it
// was made with, and a live check picks its embedding method to match rather than always using the
// newest one. EMBED_VERSION is what enroll() stamps new profiles with; go via embedForProfile().
const EMBED_VERSION = 2;

/** A unit-length embedding of the whole clip in one pass — the original method, and still what a
 *  live check uses against a profile enrolled before the ensemble method existed. */
async function embedSingle(samples) {
  const r = await ask({ type: 'embed', samples: Float32Array.from(samples) });
  if (!r.ok) throw new Error(r.error);
  return r.embedding;
}

/** A unit-length embedding, averaged from two overlapping halves when there's enough audio to
 *  spare. A cough or a door slamming in one half then gets outvoted instead of poisoning the
 *  whole reading, so a genuine sentence reads more steadily than a single embedding of it would. */
async function embedEnsemble(samples) {
  if (samples.length < SR16 * T.ENSEMBLE_SEC) return embedSingle(samples);
  const half = Math.floor(samples.length / 2);
  const overlap = Math.floor(samples.length * 0.15);
  const [ra, rb] = await Promise.all([
    ask({ type: 'embed', samples: Float32Array.from(samples.subarray(0, half + overlap)) }),
    ask({ type: 'embed', samples: Float32Array.from(samples.subarray(half - overlap)) }),
  ]);
  if (!ra.ok) throw new Error(ra.error);
  if (!rb.ok) throw new Error(rb.error);
  const sum = ra.embedding.map((x, i) => x + rb.embedding[i]);
  let n = 0; for (const x of sum) n += x * x;
  n = Math.sqrt(n) || 1;
  return sum.map((x) => x / n);
}

/** Which embedding method matches how the current profile was enrolled. */
const embedForProfile = () => (profile?.embedVersion === EMBED_VERSION ? embedEnsemble : embedSingle);

async function voiceprintOf(ms, embed) {
  const clip = trim(recent(ms));
  if (clip.length < SR16 * T.MIN_SEC) return { short: true, seconds: clip.length / SR16 };
  const use = clip.length > SR16 * T.MAX_SEC ? clip.subarray(clip.length - SR16 * T.MAX_SEC) : clip;
  const embedding = await embed(use);
  return { embedding, seconds: use.length / SR16 };
}

/* ---------- the decision ---------- */
let speechStart = 0;
export const markSpeechStart = () => (speechStart = Date.now());

// The words take about a second longer to arrive than the sound does, so start recognising the
// voice the moment you stop talking. By the time we know what you said, we usually know it was you.
let pending = null, pendingAt = 0;
export function prepare() {
  pending = check();
  pendingAt = Date.now();
  pending.catch(() => {});
}

/**
 * Was that you? Returns { ok, why } — and says yes whenever it can't tell, because a doorman
 * who locks you out when he's confused is worse than no doorman.
 */
export function isYou() {
  if (pending && Date.now() - pendingAt < 2500) { const p = pending; pending = null; return p; }
  return check();
}

async function check() {
  if (!enabled || !profile?.core?.length || !ring) return { ok: true, why: 'not set up' };
  const span = Math.min(T.MAX_SEC * 1000 + 500, Math.max(1200, Date.now() - (speechStart || Date.now() - 3000) + 400));
  try {
    const got = await voiceprintOf(span, embedForProfile());
    if (got.short) {
      const recently = Date.now() - lastPass < T.GRACE_MS;   // "yes", "stop" — too short to judge alone
      return { ok: recently, why: recently ? 'short, but you just spoke' : 'too short to recognise' };
    }
    const best = (list) => (list?.length ? Math.max(...list.map((p) => cosine(got.embedding, p))) : -1);
    // The learned pool is judged by its best few, not its single best — one drifted or mislearned
    // sample in there shouldn't be all an impostor needs to find. The core recordings stay judged
    // by their single best match: they were made deliberately, so there's nothing to be wary of.
    const topFew = (list, k) => {
      if (!list?.length) return -1;
      const scores = list.map((p) => cosine(got.embedding, p)).sort((a, b) => b - a);
      const n = Math.min(k, scores.length);
      return scores.slice(0, n).reduce((s, x) => s + x, 0) / n;
    };
    const vsCore = best(profile.core);                              // the sit-down recordings: the anchor
    const score = Math.max(vsCore, topFew(profile.learned, T.LEARN_TOPK));
    const ok = score >= T.MATCH;
    if (ok) {
      lastPass = Date.now();
      // Comfortably you, and judged against the original recordings rather than anything he taught
      // himself — so the profile can drift with your voice but never away from it.
      if (vsCore >= T.LEARN_AT && Date.now() - lastLearn > T.LEARN_EVERY) {
        lastLearn = Date.now();
        fetch('/voiceprint/learn', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ print: got.embedding }) })
          .then((r) => r.ok && r.json()).then((r) => { if (r) { profile.learned = [...(profile.learned || []), got.embedding].slice(-24); } })
          .catch(() => {});
      }
    }
    return { ok, score, why: ok ? 'recognised' : 'not your voice' };
  } catch (e) {
    return { ok: true, why: 'check failed: ' + e.message };  // never lock you out on a glitch
  }
}

/* ---------- setup: eight takes, deliberately varied ---------- */
// Sentence sounds vary; so does how you talk when you're tired, in a hurry, or across the room.
// Capturing that range is what stops him missing you later, so each take asks for something different.
const TAKES = [
  { how: 'Just normally, as if you were asking him something.', say: 'Mark, good morning. What does the day look like?' },
  { how: 'Normally again.', say: 'Remind me to call home at six, and check the trains to Bern.' },
  { how: 'Normally — last easy one.', say: 'Open the browser and read me the top story, would you?' },
  { how: 'Quietly, like it is late and someone is asleep.', say: 'Mark, turn the music down a bit, would you?' },
  { how: 'A bit louder, as if you were across the room.', say: 'Mark! What is the weather doing this afternoon?' },
  { how: 'Quickly, like you are halfway out of the door.', say: 'Mark, when is the next train, and did anything come in for me?' },
  { how: 'Slowly and clearly.', say: 'Remember that the spare key is in the kitchen drawer.' },
  { how: 'However you would really say it.', say: 'Right, Mark, what have I got on tomorrow?' },
];
const SECONDS = 7;
const MIN_GOOD = 6;

export async function enroll(ui) {
  await startTap();
  await ask({ type: 'warm' });
  const takes = [];

  let retries = 0;
  for (let i = 0; i < TAKES.length; i++) {
    const t = TAKES[i];
    await ui.say(t.say, t.how, takes.length + 1, TAKES.length);
    for (let left = SECONDS; left > 0; left--) { ui.countdown(left); await new Promise((r) => setTimeout(r, 1000)); }
    const got = await voiceprintOf(SECONDS * 1000 + 400, embedEnsemble);
    if (got.short) {
      if (++retries > 6) throw new Error("I'm not hearing anything. Check the microphone is on and allowed, then try again.");
      ui.note(got.seconds < 0.2 ? "I didn't hear anything that time — is the microphone on?" : 'Not quite enough — say the whole line.');
      await new Promise((r) => setTimeout(r, 1800));
      i--;                                              // same line again
      continue;
    }
    takes.push(got.embedding);
    ui.captured(takes.length, TAKES.length);
    await new Promise((r) => setTimeout(r, 700));
  }

  // Throw away any take that doesn't look like the rest — a cough, a shout, someone talking over you.
  const scored = takes.map((print, i) => {
    const others = takes.filter((_, j) => j !== i).map((b) => cosine(print, b));
    return { print, agrees: others.reduce((s, x) => s + x, 0) / others.length };
  });
  const good = scored.filter((s) => s.agrees >= T.OUTLIER);
  const kept = good.map((s) => s.print);
  const dropped = takes.length - kept.length;

  if (kept.length < MIN_GOOD) {
    ui.note(`Only ${kept.length} of those sounded like the same person. That usually means background noise — try again somewhere quieter.`);
    return null;
  }

  const confidence = good.reduce((s, x) => s + x.agrees, 0) / good.length;
  const saved = await fetch('/voiceprint', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ core: kept, confidence, embedVersion: EMBED_VERSION }),
  });
  if (!saved.ok) throw new Error('could not save your voiceprint — is Mark running?');
  profile = { core: kept, learned: [], created: Date.now(), confidence, embedVersion: EMBED_VERSION };
  return { takes: kept.length, dropped, confidence };
}

/** Say something and find out how well he knows you — no saving, just a reading. */
export async function testMe(seconds = 4) {
  if (!profile?.core?.length) return { error: 'Nothing learned yet.' };
  await startTap();
  await new Promise((r) => setTimeout(r, seconds * 1000));
  const got = await voiceprintOf(seconds * 1000 + 300, embedForProfile());
  if (got.short) return { error: "I didn't hear enough." };
  const all = [...profile.core, ...(profile.learned || [])];
  return { score: Math.max(...all.map((p) => cosine(got.embedding, p))), threshold: T.MATCH };
}

export async function forget() {
  profile = null;
  await fetch('/voiceprint', { method: 'DELETE' });
}

export const status = () => ({
  enrolled: !!profile?.core?.length,
  enabled,
  since: profile?.created,
  takes: profile?.core?.length || 0,
  learned: profile?.learned?.length || 0,
  samples: profile?.samples || profile?.core?.length || 0,
  confidence: profile?.confidence ?? null,
  // Enrolled before the steadier ensemble embedding existed — still recognised fine, just on the
  // older matching method. Teaching him again moves it onto the current one.
  outdated: !!profile?.core?.length && profile.embedVersion !== EMBED_VERSION,
});
export const setEnabled = (v) => (enabled = !!v);

export async function init() {
  try {
    const saved = await fetch('/voiceprint').then((r) => (r.ok ? r.json() : null));
    if (saved?.prints && !saved.core) saved.core = saved.prints;   // profiles saved before the rewrite
    profile = saved;
  } catch {}
  // Let Chrome's speech recognition get hold of the microphone first. Grabbing it at the same moment
  // is what used to knock his hearing out at startup.
  if (profile?.core?.length) setTimeout(() => startTap().catch(() => {}), 2500);
  return status();
}

window.__voiceid = {
  status, isYou, prepare, forget, testMe, setEnabled, tuning: T,
  // For testing without a microphone: push samples in, look at what comes back out.
  _feed: (chunk, hz = 16000) => { ring ||= new Float32Array(SR16 * BUFFER_SEC); rate = hz; write(chunk); },
  _recent: recent, _trim: trim, _state: () => ({ wIdx, filled, rate, len: ring?.length }),
  // For measuring the two embedding methods against each other, e.g. old vs. new against a saved
  // profile — the same comparison worth re-running before trusting a threshold.
  _embedSingle: embedSingle, _embedEnsemble: embedEnsemble, _embedForProfile: embedForProfile,
};
