// Turns a few seconds of speech into a "voiceprint" — 256 numbers describing the voice, not the words.
// Runs in a worker so the model never holds up the orb. Nothing leaves this machine.
import { AutoModel, AutoProcessor, env } from '/vendor/voiceid/transformers.min.js';

env.allowRemoteModels = false;                       // never phone home for the model
env.allowLocalModels = true;
env.localModelPath = '/vendor/';
env.backends.onnx.wasm.wasmPaths = '/vendor/voiceid/';
env.backends.onnx.wasm.numThreads = 1;               // threads need special headers; one is fast enough

let processor, model, loading, backend = 'none';
async function ready() {
  if (model) return;
  loading ||= (async () => {
    processor = await AutoProcessor.from_pretrained('voiceid');
    // The graphics chip does this about five times faster (roughly a third of a second, not two).
    if (navigator.gpu) {
      try {
        model = await AutoModel.from_pretrained('voiceid', { dtype: 'fp32', device: 'webgpu' });
        backend = 'webgpu';
      } catch { model = null; }
    }
    if (!model) { model = await AutoModel.from_pretrained('voiceid', { dtype: 'fp32' }); backend = 'wasm'; }
  })();
  await loading;
}

/** A unit-length voiceprint, so two of them can be compared by a simple dot product. */
async function embed(samples) {
  await ready();
  const inputs = await processor(samples);
  const v = (await model(inputs)).last_hidden_state.data;
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return Array.from(v, (x) => x / n);
}

onmessage = async (e) => {
  const { id, type, samples } = e.data;
  try {
    if (type === 'warm') { await ready(); postMessage({ id, ok: true, backend }); }
    else if (type === 'embed') postMessage({ id, ok: true, embedding: await embed(samples) });
  } catch (err) {
    postMessage({ id, ok: false, error: err.message });
  }
};
