// "Is Mark actually working?" — checks every part and says plainly what's wrong.
//   npm run doctor
process.loadEnvFile();
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const PORT = Number(process.env.PORT || 7777);
const rows = [];
const add = (name, ok, note) => rows.push({ name, ok, note });
const has = (f) => fs.existsSync(path.join(ROOT, f));

/* ---------- is he running? ---------- */
let running = false;
try {
  const r = await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(3000) });
  running = r.ok;
  add('Mark running', true, `answering on http://localhost:${PORT}`);
} catch {
  add('Mark running', false, `nothing on port ${PORT} — start him with: npm start`);
}

/* ---------- the brain ---------- */
if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
  add('Claude login', false, 'no CLAUDE_CODE_OAUTH_TOKEN in .env — run: claude setup-token');
} else {
  try {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    const t = Date.now();
    let reply = '';
    for await (const m of query({ prompt: 'Reply with the single word: ok', options: { model: 'claude-haiku-4-5', maxTurns: 1, allowedTools: [] } }))
      if (m.type === 'assistant') reply += m.message.content.map((c) => c.text || '').join('');
    add('Claude login', !!reply.trim(), reply.trim() ? `answering in ${((Date.now() - t) / 1000).toFixed(1)}s` : 'connected but said nothing');
  } catch (e) {
    const expired = /401|unauthor|expired|invalid/i.test(e.message);
    add('Claude login', false, expired ? 'token rejected — make a new one with: claude setup-token' : e.message.slice(0, 90));
  }
}

/* ---------- voice ---------- */
add('Voice out', true, `Edge neural voice (${process.env.JARVIS_VOICE || 'en-GB-RyanNeural'})`);
const vp = path.join(ROOT, 'data', 'voiceprint.json');
add('Only your voice', has('data/voiceprint.json'),
  has('data/voiceprint.json')
    ? `set up ${new Date(JSON.parse(fs.readFileSync(vp, 'utf8')).created).toLocaleDateString()} — he ignores other people`
    : 'not set up — click the microphone button on the orb (he currently answers anyone)');
add('Voice model files', has('public/vendor/voiceid/onnx/model.onnx'), has('public/vendor/voiceid/onnx/model.onnx') ? 'present' : 'missing — see README');

/* ---------- his browser ---------- */
add('Reads your documents', has('node_modules/pdf-parse'), has('node_modules/pdf-parse') ? 'PDF, Word, Excel, CSV' : 'run: npm install pdf-parse mammoth xlsx');
const tdir = path.join(ROOT, 'data', 'transcript');
const tdays = fs.existsSync(tdir) ? fs.readdirSync(tdir).filter((f) => f.endsWith('.jsonl')).length : 0;
add('Remembers conversations', true, tdays ? tdays + ' day(s) of conversation he can search' : 'nothing said yet');
add('His own browser', has('node_modules/playwright-core'), has('node_modules/playwright-core') ? 'ready' : 'run: npm install playwright-core');

/* ---------- passwords ---------- */
add('Password vault', has('data/vault.json'), has('data/vault.json') ? 'created' : 'not created yet — click the key on the orb');
add('Windows Hello', has('data/hello.json'), has('data/hello.json') ? 'set up' : 'not set up — vault screen, "Set up Windows Hello"');
add('Autofill extension', has('data/extension.json'), has('data/extension.json') ? 'linked' : 'not linked — see README');

/* ---------- optional connections ---------- */
const phone = !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN);
add('Phone calls', phone || !!process.env.TELEGRAM_API_ID, phone ? 'Twilio' : process.env.TELEGRAM_API_ID ? 'Telegram' : 'off — needs Twilio or Telegram details in .env');
add('Alexa', !!process.env.ALEXA_SKILL_ID, process.env.ALEXA_SKILL_ID ? 'skill id set' : 'off — needs ALEXA_SKILL_ID in .env');
add('Emailed codes', has('data/vault.json') && !!process.env.GMAIL_USER, 'connect Gmail from the vault screen');

/* ---------- report ---------- */
const pad = Math.max(...rows.map((r) => r.name.length));
console.log('');
for (const r of rows) console.log(`  ${r.ok ? '[ ok ]' : '[ -- ]'}  ${r.name.padEnd(pad)}  ${r.note}`);
const broken = rows.filter((r) => !r.ok && ['Mark running', 'Claude login'].includes(r.name));
console.log(broken.length
  ? `\n  He won't answer until this is fixed: ${broken.map((b) => b.name).join(' and ')}.\n`
  : '\n  He is connected and answering. Anything marked -- above is optional and just not set up yet.\n');
process.exit(0);
