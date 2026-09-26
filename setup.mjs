// First-run setup: fetches the model files that are too big to keep in the repository.
//   npm run setup
// Safe to run again at any time — it skips anything already in place and never touches data/.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const V = path.join(ROOT, 'public', 'vendor');
const MB = (n) => (n / 1e6).toFixed(1) + ' MB';

// Downloaded once. The rest of the voice runtime is copied out of node_modules below.
const DOWNLOADS = [
  {
    to: 'voiceid/onnx/model.onnx',
    from: 'https://huggingface.co/onnx-community/wespeaker-voxceleb-resnet34-LM/resolve/main/onnx/model.onnx',
    what: 'speaker recognition model (so he only answers you)',
  },
  {
    to: 'voiceid/config.json',
    from: 'https://huggingface.co/onnx-community/wespeaker-voxceleb-resnet34-LM/resolve/main/config.json',
    what: 'speaker model config',
  },
  {
    to: 'voiceid/preprocessor_config.json',
    from: 'https://huggingface.co/onnx-community/wespeaker-voxceleb-resnet34-LM/resolve/main/preprocessor_config.json',
    what: 'speaker model audio settings',
  },
  {
    to: 'hand_landmarker.task',
    from: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
    what: 'hand tracking model (camera control)',
  },
];

// Shipped inside npm packages, so just copy them where the browser expects to find them.
const COPIES = [
  ['node_modules/@huggingface/transformers/dist/transformers.min.js', 'voiceid/transformers.min.js'],
  ['node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs', 'voiceid/ort-wasm-simd-threaded.jsep.mjs'],
  ['node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm', 'voiceid/ort-wasm-simd-threaded.jsep.wasm'],
  ['node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs', 'voiceid/ort-wasm-simd-threaded.asyncify.mjs'],
  ['node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm', 'voiceid/ort-wasm-simd-threaded.asyncify.wasm'],
];

async function download({ to, from, what }) {
  const dest = path.join(V, to);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1000) {
    console.log(`  already here  ${to}`);
    return;
  }
  process.stdout.write(`  downloading   ${to} — ${what} … `);
  const res = await fetch(from, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} from ${new URL(from).host}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  console.log(MB(buf.length));
}

console.log('\nSetting up Mark.\n');

if (!fs.existsSync(path.join(ROOT, 'node_modules'))) {
  console.error('  Run "npm install" first.\n');
  process.exit(1);
}

for (const [from, to] of COPIES) {
  const src = path.join(ROOT, from), dest = path.join(V, to);
  if (!fs.existsSync(src)) { console.log(`  MISSING       ${from} — run npm install`); continue; }
  if (fs.existsSync(dest) && fs.statSync(dest).size === fs.statSync(src).size) { console.log(`  already here  ${to}`); continue; }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  console.log(`  copied        ${to}  ${MB(fs.statSync(dest).size)}`);
}

try {
  for (const d of DOWNLOADS) await download(d);
} catch (e) {
  console.error(`\n  Download failed: ${e.message}`);
  console.error('  Check your connection and run "npm run setup" again.\n');
  process.exit(1);
}

if (!fs.existsSync(path.join(ROOT, '.env'))) {
  fs.copyFileSync(path.join(ROOT, '.env.example'), path.join(ROOT, '.env'));
  console.log('\n  Created .env from the example.');
}

console.log(`
Done. Next:

  1. Put your own Claude token in .env — get one with:  claude setup-token
     (it goes on the CLAUDE_CODE_OAUTH_TOKEN= line)
  2. npm start
  3. Open http://localhost:7777

Everything personal — your vault, your voiceprint, your conversations — is created on
first use and stays in data/, which is never committed and never shared.
`);
