import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import QRCode from 'qrcode';

try { process.loadEnvFile(); } catch {}
// Blank lines in .env (e.g. CLAUDE_CODE_OAUTH_TOKEN= before it's filled in) mean "not set".
for (const [k, v] of Object.entries(process.env)) if (v === '') delete process.env[k];
const { VoiceSession, runBackgroundTask } = await import('./brain.js');
const schedule = await import('./scheduler.js');
const { placeCall, phoneConfigured, telegramConfigured } = await import('./phone.js');
const push = await import('./push.js');
const { getStats } = await import('./stats.js');
const store = await import('./store.js');
const migrated = store.migrate();          // backs up data/ first if the format changed
if (migrated) console.log('  ' + migrated);
const vault = await import('./vault.js');
const hello = await import('./hello.js');
const mail = await import('./mailcodes.js');
const alexa = await import('./alexa.js');

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 7777);
const VOICE = process.env.JARVIS_VOICE || 'en-GB-RyanNeural';
const PUBLIC = path.join(ROOT, 'public');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.task': 'application/octet-stream', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/manifest+json' };
const isLocal = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) && !req.headers['x-forwarded-for'];

// Remote devices (your phone, via Tailscale) must be paired once with this key.
const KEY_FILE = path.join(ROOT, 'data', 'pair-key.txt');
fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
if (!fs.existsSync(KEY_FILE)) fs.writeFileSync(KEY_FILE, crypto.randomBytes(24).toString('hex'));
const PAIR_KEY = fs.readFileSync(KEY_FILE, 'utf8').trim();
const cookieKey = (req) => /(?:^|;\s*)jarvis_key=([^;]+)/.exec(req.headers.cookie || '')?.[1];
const sameKey = (k) => typeof k === 'string' && k.length === PAIR_KEY.length && crypto.timingSafeEqual(Buffer.from(k), Buffer.from(PAIR_KEY));
const authed = (req) => isLocal(req) || sameKey(cookieKey(req));

// Only answer requests addressed to Mark himself (blocks DNS-rebinding tricks from web pages)…
const hostName = (h) => { try { return new URL(`http://${h}`).hostname; } catch { return ''; } };
const urlHost = (u) => { try { return new URL(u).hostname; } catch { return ''; } };
function hostOk(req) {
  const h = hostName(req.headers.host || '');
  return ['localhost', '127.0.0.1', '[::1]'].includes(h)
    || [process.env.JARVIS_URL, process.env.PUBLIC_URL].some((u) => u && urlHost(u) === h)
    || h === process.env.JARVIS_DOMAIN;
}
// …and only let Mark's own page open his live connection (other websites you visit can't talk to him).
const rpOf = (req) => hostName(req.headers.host || '');
const originOf = (req) => req.headers.origin || `http://${req.headers.host}`;
const sameOrigin = (req) => { const o = req.headers.origin; try { return !!o && new URL(o).host === req.headers.host; } catch { return false; } };
const readRaw = (req) => new Promise((ok) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => ok(b)); });
const readJson = (req) => new Promise((ok) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => { try { ok(JSON.parse(b)); } catch { ok(null); } });
});

// The orb's conversation is started at boot so it's warm before you speak, and resumes across restarts.
const orb = new VoiceSession('orb', { persist: true });
let echo = null;                                   // Alexa's conversation, started on first use

/** Ask a voice session something and wait for the whole answer (or give up after a moment). */
function askVoice(session, text, timeoutMs) {
  return new Promise((resolve) => {
    const parts = [];
    let settled = false;
    const finish = () => { if (settled) return; settled = true; session.on({}); resolve(parts.join(' ').trim()); };
    session.on({ sentence: (s) => parts.push(s), done: finish });
    session.say(text);
    setTimeout(finish, timeoutMs);
  });
}

async function tts(text, res) {
  const t = new MsEdgeTTS();
  await t.setMetadata(VOICE, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
  const { audioStream } = t.toStream(text, { rate: '+6%', pitch: '-4Hz' });
  res.writeHead(200, { 'content-type': 'audio/mpeg', 'cache-control': 'no-store' });
  audioStream.pipe(res);
  audioStream.on('close', () => t.close());
}

let tunnelStarting = null;
async function publicAddress() {
  if (process.env.JARVIS_URL) return process.env.JARVIS_URL;
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL;
  tunnelStarting ||= import('./tunnel.js').then(({ startTunnel }) => startTunnel(PORT))
    .then((u) => { process.env.PUBLIC_URL = u; console.log(`  public link: ${u}`); return u; })
    .catch((e) => { tunnelStarting = null; throw new Error(`Couldn't open a public link: ${e.message}. Install cloudflared, or set JARVIS_URL in .env.`); });
  return tunnelStarting;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (!hostOk(req)) { res.writeHead(421).end(); return; }
  // Cross-site form posts (another website poking Mark) are refused.
  if (req.method !== 'GET' && req.headers.origin && !sameOrigin(req)) { res.writeHead(403).end(); return; }

  if (req.method === 'POST' && url.pathname === '/alexa') {
    const raw = await readRaw(req);
    try {
      const body = await alexa.verifyRequest(req.headers, raw);
      console.log('[alexa]', body.request?.type, body.request?.intent?.name || '');
      const answer = await alexa.handle(body, async (said) => {
        console.log('[alexa] you:', said);
        if (!echo) echo = new VoiceSession('alexa', { persist: true });
        return askVoice(echo, `[speaking through an Alexa Echo, keep it to one or two short sentences] ${said}`, 6500);
      });
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(answer));
    } catch (e) {
      console.error('[alexa] rejected:', e.message);
      res.writeHead(400).end();
    }
    return;
  }

  // Pairing link (from the QR code): remember this device with a long-lived cookie.
  if (url.searchParams.has('key') && sameKey(url.searchParams.get('key'))) {
    res.writeHead(302, { 'set-cookie': `jarvis_key=${PAIR_KEY}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax`, location: '/' }).end();
    return;
  }
  // This PC or a paired device only; everyone else gets nothing.
  if (!authed(req)) { res.writeHead(404).end(); return; }

  if (url.pathname === '/tts') {
    try { await tts(url.searchParams.get('text') || '', res); }
    catch (e) { console.error('tts', e.message); if (!res.headersSent) res.writeHead(502); res.end(); }
    return;
  }
  if (url.pathname === '/pair') {
    if (!isLocal(req)) { res.writeHead(403).end(JSON.stringify({ error: 'Pair from the PC.' })); return; }
    try {
      const base = await publicAddress();
      const link = `${base.replace(/\/$/, '')}/?key=${PAIR_KEY}`;
      res.end(JSON.stringify({ qr: await QRCode.toDataURL(link, { margin: 1, width: 320, color: { dark: '#ffc440', light: '#000000' } }), link }));
    } catch (e) {
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (url.pathname === '/stats') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(getStats())); return; }
  if (url.pathname === '/vapid') { res.end(JSON.stringify({ key: push.vapidPublicKey() })); return; }
  if (req.method === 'POST' && url.pathname === '/subscribe') { push.subscribe(await readJson(req)); res.end('{}'); return; }

  // Your voiceprint: sets of 256 numbers describing your voice, never the audio itself. Used to
  // ignore other people. It is not a password — Windows Hello still guards anything that matters.
  //   core    — from the sit-down setup. Never changes on its own; the anchor everything is judged against.
  //   learned — added quietly whenever he's certain it was you, so he keeps up with colds, new mics and time.
  if (url.pathname === '/voiceprint' || url.pathname === '/voiceprint/learn') {
    const file = path.join(ROOT, 'data', 'voiceprint.json');
    const backup = path.join(ROOT, 'data', 'voiceprint.backup.json');
    const okPrint = (p) => Array.isArray(p) && p.length === 256 && p.every((n) => typeof n === 'number' && Number.isFinite(n));
    const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
    const write = (data) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (fs.existsSync(file)) fs.copyFileSync(file, backup);       // never lose the old one
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, file);                                     // atomic: no half-written profile
    };

    if (req.method === 'GET') {
      const cur = read();
      if (!cur) { res.writeHead(404).end('{}'); return; }
      res.end(JSON.stringify(cur));
      return;
    }

    // One more example of your voice, recognised with room to spare. Capped so it can't grow forever.
    if (req.method === 'POST' && url.pathname === '/voiceprint/learn') {
      const { print } = await readJson(req);
      const cur = read();
      if (!cur?.core?.length) { res.writeHead(409).end(JSON.stringify({ error: 'not set up' })); return; }
      if (!okPrint(print)) { res.writeHead(400).end(JSON.stringify({ error: 'bad print' })); return; }
      const learned = [...(cur.learned || []), print].slice(-24);
      write({ ...cur, learned, samples: (cur.samples || 0) + 1, updated: Date.now() });
      res.end(JSON.stringify({ learned: learned.length }));
      return;
    }

    if (req.method === 'POST') {
      const body = await readJson(req);
      const core = body?.core || body?.prints;                      // `prints` was the old name
      if (!Array.isArray(core) || core.length < 3 || !core.every(okPrint))
        { res.writeHead(400).end(JSON.stringify({ error: 'bad voiceprint' })); return; }
      write({ core, learned: [], created: Date.now(), updated: Date.now(), samples: core.length, confidence: body.confidence ?? null });
      console.log(`[voiceid] voice learned from ${core.length} recordings`);
      res.end('{}');
      return;
    }

    if (req.method === 'DELETE') {
      try { if (fs.existsSync(file)) fs.copyFileSync(file, backup); fs.unlinkSync(file); } catch {}
      console.log('[voiceid] voiceprint deleted (a copy stays in data/voiceprint.backup.json)');
      res.end('{}');
      return;
    }
  }
  if (req.method === 'POST' && url.pathname === '/call') {
    try { res.end(JSON.stringify({ sid: await placeCall('Good evening, sir. You asked me to ring.') })); }
    catch (e) { res.writeHead(400).end(JSON.stringify({ error: e.message })); }
    return;
  }

  // ---- Windows Hello approvals (this PC only) ----
  if (url.pathname.startsWith('/approval')) {          // this PC, or a paired phone approving with Face ID
    const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.method === 'GET') {
      const a = approvals.get(url.searchParams.get('id'));
      return json(a ? { action: a.action, name: a.name, username: a.username, host: a.host, what: a.what } : { error: 'This request has expired.' });
    }
    const body = (await readJson(req)) || {};
    const a = approvals.get(body.id);
    if (!a) return json({ error: 'This request has expired.' });
    try {
      if (url.pathname === '/approval/options') return json(await hello.authOptions(rpOf(req), a.id));
      if (url.pathname === '/approval/verify') { const ok = await hello.verify(rpOf(req), originOf(req), a.id, body.response); settle(a.id, ok); return json({ ok }); }
      if (url.pathname === '/approval/deny') { settle(a.id, false); return json({ ok: true }); }
    } catch (e) { return json({ error: e.message }); }
    res.writeHead(404).end(); return;
  }

  // Hand tracking library (MediaPipe), served locally so the camera feature works offline.
  const MP = path.join(ROOT, 'node_modules', '@mediapipe', 'tasks-vision');
  const SWA = path.join(ROOT, 'node_modules', '@simplewebauthn', 'browser', 'dist', 'bundle');   // Windows Hello (WebAuthn) helper
  const file = url.pathname.startsWith('/vendor/mediapipe/')
    ? path.join(MP, path.normalize(url.pathname.slice('/vendor/mediapipe/'.length)))
    : url.pathname.startsWith('/vendor/simplewebauthn/')
      ? path.join(SWA, path.normalize(url.pathname.slice('/vendor/simplewebauthn/'.length)))
      : path.join(PUBLIC, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
  if (!(file.startsWith(PUBLIC) || file.startsWith(MP) || file.startsWith(SWA)) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404).end(); return; }
  res.setHeader('content-type', TYPES[path.extname(file)] || 'application/octet-stream');
  // Mark's own pages/scripts change often: don't let the browser keep an old copy.
  res.setHeader('cache-control', file.startsWith(PUBLIC) ? 'no-store' : 'max-age=86400');
  fs.createReadStream(file).pipe(res);
});

const orbWss = new WebSocketServer({ noServer: true });
const extWss = new WebSocketServer({ noServer: true });   // the Mark Autofill browser extension
const relayWss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://x');
  if (!hostOk(req)) { socket.destroy(); return; }
  if (pathname === '/orb' && authed(req) && sameOrigin(req)) orbWss.handleUpgrade(req, socket, head, (ws) => orbWss.emit('connection', ws, req));
  else if (pathname === '/autofill' && isLocal(req) && String(req.headers.origin || '').startsWith('chrome-extension://'))
    extWss.handleUpgrade(req, socket, head, (ws) => extWss.emit('connection', ws));
  else if (process.env.RELAY_SECRET && pathname === `/relay/${process.env.RELAY_SECRET}`)
    relayWss.handleUpgrade(req, socket, head, (ws) => relayWss.emit('connection', ws));
  else socket.destroy();
});

// Orb clients (PC + paired phones) share one conversation; whichever device spoke last hears the reply.
let active = null;
const toActive = (o) => active?.readyState === 1 && active.send(JSON.stringify(o));
orb.on({
  sentence: (text) => toActive({ type: 'sentence', text }),
  status: (text) => toActive({ type: 'status', text }),
  done: () => toActive({ type: 'done' }),
});
// Autonomy: alarms and scheduled jobs fire even when nobody's at the orb (24/7 on a server).
const brief = (s, n = 350) => (s.length > n ? s.slice(0, n).replace(/\s\S*$/, '') + '…' : s);
schedule.start({
  alarm: async (item) => {
    const line = `Sir. ${item.label}`;
    const here = active?.readyState === 1;
    if (here) { toActive({ type: 'sentence', text: line }); toActive({ type: 'done' }); }
    if (item.notify === 'call' || !here) await placeCall(line).catch((e) => console.error('alarm call failed:', e.message));
  },
  runTask: (item) => runBackgroundTask(item.prompt, { scheduled: true }),
  deliver: async (item, result) => {
    const alert = /^\s*ALERT:/i.test(result);
    const summary = String(result).replace(/^\s*ALERT:\s*/i, '').trim();
    if (item.notify === 'silent') return;
    if (item.notify === 'call' || (item.notify === 'auto' && alert))
      await placeCall(`Sir, about ${item.label}. ${brief(summary)}`).catch((e) => console.error('job call failed:', e.message));
    if (active?.readyState === 1 && (item.notify !== 'auto' || alert))
      orb.say(`[scheduled job "${item.label}" finished]
${summary}

Tell the user briefly.`);
  },
});

// Watchdog: speaks up about problems on this machine without being asked (once per problem).
const warned = {};
let offlineChecks = 0;
setInterval(() => {
  const s = getStats();
  const warn = (key, bad, recovered, line) => {
    if (bad && !warned[key]) {
      warned[key] = true;
      console.log('[watchdog]', line);
      if (active?.readyState === 1) { toActive({ type: 'sentence', text: line }); toActive({ type: 'done' }); }
    } else if (recovered) warned[key] = false;
  };
  warn('battery', s.battery != null && !s.charging && s.battery <= 20, s.charging, `Sir, the battery's down to ${s.battery} percent. Might be time for the charger.`);
  warn('disk', s.disk >= 95, s.disk < 90, `Your main drive is ${s.disk} percent full, sir. Want me to find what's taking the space?`);
  warn('mem', s.mem >= 95, s.mem < 85, `Memory's at ${s.mem} percent. Something's being greedy.`);
  offlineChecks = s.ping == null ? offlineChecks + 1 : 0;
  warn('net', offlineChecks >= 2, offlineChecks === 0, "We've lost the internet connection, sir. I'll be rather limited until it's back.");
}, 60_000).unref();

// ---- Password vault ----
// A screen is "vault-authed" only after someone typed the master password on it. Secrets are only ever
// sent to such a screen (or the PC clipboard), never into Mark's conversation.
/** If Mark was stopped by a locked vault, let him know it is open and get on with it. */
function carryOn() {
  if (!waitingOnVault) return;
  waitingOnVault = false;
  orb.say('[the vault has just been unlocked — carry on with what you were doing, without asking again]');
}
const fullStatus = (ws) => ({ ...vault.status(), authed: !!ws.vaultAuthed, hello: hello.enrolled(ws.rpID), ext: extWs?.readyState === 1, gmail: vault.isUnlocked() && vault.hasSystem('gmail') });
const vaultStatus = (ws) => ({ type: 'vault', status: fullStatus(ws) });

// ---- Browser extension link (Mark Autofill) ----
// It proves itself with a link code shown once on the vault screen; only a hash of that code is stored.
let extWs = null;
const extWaiters = new Map();
const EXT_FILE = path.join(ROOT, 'data', 'extension.json');
const sha = (x) => crypto.createHash('sha256').update(x).digest('hex');
const extHash = () => { try { return JSON.parse(fs.readFileSync(EXT_FILE, 'utf8')).hash; } catch { return null; } };
const extSend = (o) => extWs?.readyState === 1 && extWs.send(JSON.stringify(o));
let waitingOnVault = false;
vault.setNeedUnlock(() => {
  waitingOnVault = true; for (const c of orbWss.clients) if (c.readyState === 1) c.send(JSON.stringify({ type: 'vault', needUnlock: true })); });
const refreshVaultScreens = () => { for (const c of orbWss.clients) if (c.readyState === 1) c.send(JSON.stringify(vaultStatus(c))); };
function extAsk(msg, replyType, ms = 5000) {
  return new Promise((resolve, reject) => {
    if (extWs?.readyState !== 1) return reject(new Error("The Mark Autofill browser extension isn't connected."));
    const id = crypto.randomBytes(6).toString('hex');
    extWaiters.set(id, { resolve, replyType });
    extSend({ ...msg, id });
    setTimeout(() => { if (extWaiters.delete(id)) reject(new Error("The browser extension didn't answer.")); }, ms);
  });
}
extWss.on('connection', (ws) => {
  let linked = false;
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!linked) {
      const h = extHash();
      if (m.type === 'hello' && h && typeof m.token === 'string' && crypto.timingSafeEqual(Buffer.from(sha(m.token)), Buffer.from(h))) {
        linked = true; if (extWs && extWs !== ws) extWs.close(); extWs = ws;
        ws.send(JSON.stringify({ type: 'welcome' })); refreshVaultScreens();
      } else { ws.send(JSON.stringify({ type: 'denied' })); ws.close(); }
      return;
    }
    const w = extWaiters.get(m.id);
    if (w && m.type === w.replyType) { extWaiters.delete(m.id); w.resolve(m); }
  });
  const ping = setInterval(() => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'ping' })), 20_000);   // keeps the extension awake
  ws.on('close', () => { clearInterval(ping); if (extWs === ws) { extWs = null; refreshVaultScreens(); } });
});

// ---- Windows Hello approvals ----
// Every password Mark types or copies needs a fresh face/fingerprint/PIN check. The request pops up in the
// extension's window (or on the orb screen); Mark only learns yes or no.
const approvals = new Map();
const recentApprovals = new Map();
function settle(id, ok) {
  const a = approvals.get(id); if (!a) return;
  approvals.delete(id); clearTimeout(a.timer); a.resolve(ok);
  // Approving a login also covers its emailed code for the next 10 minutes (no second prompt mid-login).
  if (ok && a.host && a.action === 'fill') recentApprovals.set(a.host, Date.now() + 10 * 60_000);
  extSend({ type: 'approval_done', id });
  for (const c of orbWss.clients) if (c.readyState === 1) c.send(JSON.stringify({ type: 'approval_done', id }));
}
function requestApproval(info) {
  return new Promise((resolve) => {
    const id = crypto.randomBytes(8).toString('hex');
    approvals.set(id, { id, ...info, resolve, timer: setTimeout(() => settle(id, false), 90_000) });
    const popup = extWs?.readyState === 1;
    if (popup) extSend({ type: 'approve', id });
    const text = info.action === 'emailcode' ? `Use the code emailed to you to sign in on ${info.host}?`
      : info.action === 'fill' ? `Type your ${info.name} login${info.otp ? ' and 2FA code' : ''} into ${info.host}?`
      : `Copy your ${info.name} ${info.what === 'code' ? '2FA code' : info.what || 'password'} to the clipboard?`;
    // Screens that can approve: this PC (Windows Hello) and any paired phone with Face ID set up.
    for (const c of orbWss.clients) if (c.readyState === 1 && (c.isLocalPC || hello.enrolled(c.rpID))) c.send(JSON.stringify({ type: 'approve', id, text, popup }));
    // Phone in your pocket: a notification you tap to approve with Face ID.
    if (hello.phoneEnrolled()) push.notify({ title: 'MARK needs your OK', body: text, url: `/approve.html?id=${id}`, tag: `approve-${id}` }).catch(() => {});
  });
}
const helloReady = () => hello.anyEnrolled();

vault.setAutofiller(async (query) => {
  const entry = vault.secretFor(query);
  const tab = await extAsk({ type: 'tab?' }, 'tab');
  if (!tab.host) throw new Error("There's no website open in the browser.");
  const want = entry.url ? urlHost(/:\/\//.test(entry.url) ? entry.url : `https://${entry.url}`) : '';
  if (want && !(tab.host === want || tab.host.endsWith(`.${want}`) || want.endsWith(`.${tab.host}`)))
    throw new Error(`The browser is on ${tab.host}, but the saved ${entry.name} login is for ${want}. Not filling it there, in case it's a fake site.`);
  if (!helloReady()) throw new Error('Windows Hello is not set up yet. Open the vault screen and press "Set up Windows Hello".');
  if (!(await requestApproval({ action: 'fill', name: entry.name, username: entry.username, host: tab.host, otp: !!entry.totp }))) return 'Not approved, so nothing was filled.';
  const otp = entry.totp ? vault.totpCode(entry.totp) : null;       // made right after approval, so it's fresh
  const r = await extAsk({ type: 'fill', tabId: tab.tabId, host: tab.host, username: entry.username, password: entry.password, otp: otp?.code || '' }, 'filled', 10_000);
  return r.ok ? `Filled the ${entry.name} login on ${tab.host}.${r.why ? ' ' + r.why : ''}` : (r.why || 'Could not fill the page.');
});
// Same again, for the browser Mark drives himself. Approval still comes from your face or PIN,
// and the site still has to match the saved login, so he can't be talked into a fake page.
vault.setBrowserFiller(async (query) => {
  const entry = vault.secretFor(query);
  const jb = await import('./browser.js');
  const pageHost = await jb.currentHost();
  if (!pageHost) throw new Error("Mark isn't on a website yet — open one with the browse tool first.");
  const want = entry.url ? urlHost(/:\/\//.test(entry.url) ? entry.url : `https://${entry.url}`) : '';
  if (want && !(pageHost === want || pageHost.endsWith(`.${want}`) || want.endsWith(`.${pageHost}`)))
    throw new Error(`His browser is on ${pageHost}, but the saved ${entry.name} login is for ${want}. Not filling it there, in case it's a fake site.`);
  if (!helloReady()) throw new Error('Windows Hello is not set up yet. Open the vault screen and press "Set up Windows Hello".');
  if (!(await requestApproval({ action: 'fill', name: entry.name, username: entry.username, host: pageHost, otp: !!entry.totp })))
    return 'Not approved, so nothing was filled.';
  const otp = entry.totp ? vault.totpCode(entry.totp) : null;       // made right after approval, so it's fresh
  return jb.fillLogin({ username: entry.username, password: entry.password, otp: otp?.code || '' });
});
vault.onChange((st) => {
  for (const c of orbWss.clients) {
    if (!st.unlocked) c.vaultAuthed = false;
    if (c.readyState === 1) c.send(JSON.stringify(vaultStatus(c)));
  }
});
const pcClipboard = (value) => new Promise((ok, no) => {
  if (process.platform !== 'win32') return no(new Error('No screen is unlocked to receive it.'));
  import('node:child_process').then(({ execFile }) => {
    const run = (script) => new Promise((r) => execFile('powershell', ['-NoProfile', '-Command', script], { windowsHide: true, env: { ...process.env, JARVIS_SECRET: value } }, r));
    run('Set-Clipboard -Value $env:JARVIS_SECRET').then((err) => {
      if (err) return no(err);
      // Clear it again after 30 s, unless you've copied something else since.
      setTimeout(() => run('if ((Get-Clipboard -Raw) -eq $env:JARVIS_SECRET) { Set-Clipboard -Value $null }'), 30_000);
      ok('the PC clipboard');
    });
  });
});
// Codes a site emails you: found in Gmail, typed straight into the page.
vault.setEmailFiller(async () => {
  const creds = vault.getSystem('gmail');
  if (!creds) throw new Error('Gmail is not connected yet. Open the vault screen and connect it under "Email codes".');
  const tab = await extAsk({ type: 'tab?' }, 'tab');
  if (!tab.host) throw new Error("There's no website open in the browser.");
  if (!(recentApprovals.get(tab.host) > Date.now())) {
    if (!helloReady()) throw new Error('Windows Hello or Face ID is not set up yet.');
    if (!(await requestApproval({ action: 'emailcode', name: 'emailed code', host: tab.host }))) return 'Not approved, so nothing was typed.';
  }
  const hit = await mail.findCode({ ...creds, host: tab.host, waitMs: 60_000 });
  if (!hit) return `No code from ${tab.host} has arrived in your inbox in the last ten minutes.`;
  const r = await extAsk({ type: 'fill', tabId: tab.tabId, host: tab.host, username: '', password: '', otp: hit.code }, 'filled', 10_000);
  return r.ok ? `Typed the code from the ${hit.from || 'email'} message into ${tab.host}.` : (r.why || "Couldn't type the code.");
});

vault.setDeliverer(async (secret, what) => {
  let value = secret.value;
  if (helloReady() && !(await requestApproval({ action: 'copy', name: secret.name, what }))) throw new Error('Not approved.');
  if (what === 'code') value = vault.totpCode(secret.totp).code;   // fresh code after the approval wait
  const screens = [active, ...orbWss.clients].filter((c) => c?.vaultAuthed && c.readyState === 1);
  for (const c of screens) {
    const ok = await new Promise((resolve) => {
      const id = crypto.randomBytes(4).toString('hex');
      const onAck = (raw) => { try { const m = JSON.parse(raw); if (m.type === 'secret_ack' && m.id === id) { c.off('message', onAck); resolve(m.ok); } } catch {} };
      c.on('message', onAck);
      c.send(JSON.stringify({ type: 'secret', id, name: secret.name, what, value }));
      setTimeout(() => { c.off('message', onAck); resolve(false); }, 2500);
    });
    if (ok) return "your screen's clipboard";
  }
  return pcClipboard(value);
});

async function vaultOp(ws, msg) {
  const reply = (o) => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'vault', ...o, status: fullStatus(ws) }));
  try {
    switch (msg.op) {
      case 'status': return reply({});
      case 'create': await vault.create(msg.master); ws.vaultAuthed = true; return reply({ items: vault.list() });
      case 'unlock': await vault.unlock(msg.master); ws.vaultAuthed = true; carryOn(); return reply({ items: vault.list() });
      case 'lock': vault.lock(); return reply({});
      // Unlocking with your face instead of the master password.
      case 'hello_unlock_options': {
        if (!vault.helloUnlockReady()) throw new Error('Windows Hello unlocking is not set up yet.');
        if (!hello.enrolled(ws.rpID)) throw new Error('Windows Hello is not set up on this screen.');
        return reply({ helloUnlock: { ...(await hello.authOptions(ws.rpID, 'unlock:' + ws.cid)), salt: vault.helloSalt() } });
      }
      case 'hello_unlock': {
        if (!(await hello.verify(ws.rpID, ws.origin, 'unlock:' + ws.cid, msg.response))) throw new Error('Windows Hello could not confirm it was you.');
        vault.unlockWithHello(msg.prf);                    // the assertion proves it; the PRF opens it
        ws.vaultAuthed = true;
        carryOn();
        return reply({ items: vault.list(), note: 'Unlocked with Windows Hello.' });
      }
    }
    if (!ws.vaultAuthed || !vault.isUnlocked()) throw new Error('Unlock the vault on this screen first.');
    switch (msg.op) {
      case 'list': return reply({ items: vault.list() });
      case 'generate': return reply({ generated: vault.generate(msg.length || 20) });
      case 'add': vault.add(msg.item || {}); return reply({ items: vault.list(), note: 'Saved.' });
      case 'delete': vault.remove(msg.id); return reply({ items: vault.list(), note: 'Deleted.' });
      case 'gmail_connect': {
        await mail.testLogin({ user: msg.user, pass: msg.pass });
        vault.setSystem('gmail', { user: msg.user, pass: msg.pass });
        return reply({ note: 'Gmail connected. Mark can now fetch login codes sent to you by email.' });
      }
      case 'gmail_disconnect': vault.setSystem('gmail', null); return reply({ note: 'Gmail disconnected.' });
      case 'hello_unlock_setup_options':
        if (!hello.enrolled(ws.rpID)) throw new Error('Set up Windows Hello first.');
        return reply({ helloUnlockSetup: { ...(await hello.authOptions(ws.rpID, 'unlocksetup:' + ws.cid)), salt: vault.helloSalt() } });
      case 'hello_unlock_enable': {
        if (!(await hello.verify(ws.rpID, ws.origin, 'unlocksetup:' + ws.cid, msg.response))) throw new Error('Windows Hello could not confirm it was you.');
        vault.enableHelloUnlock(msg.prf);
        return reply({ note: 'Done. Your face opens the vault from now on; your master password still works.' });
      }
      case 'hello_unlock_disable': vault.disableHelloUnlock(); return reply({ note: 'Windows Hello unlocking turned off.' });
      case 'import': {
        const list = Array.isArray(msg.logins) ? msg.logins.slice(0, 2000) : [];
        let added = 0, failed = 0;
        for (const item of list) { try { vault.add(item); added++; } catch { failed++; } }
        return reply({ items: vault.list(), note: `Imported ${added} login${added === 1 ? '' : 's'}${failed ? `, ${failed} skipped` : ''}. Delete the export file now.` });
      }
      case 'hello_options': return reply({ helloOptions: await hello.registrationOptions(ws.rpID) });
      case 'hello_register': await hello.register(ws.rpID, ws.origin, msg.response); return reply({ note: 'Windows Hello is set up. Mark will ask for it before using any password.' });
      case 'ext_code': {
        const code = crypto.randomBytes(15).toString('base64url');
        fs.writeFileSync(EXT_FILE, JSON.stringify({ hash: sha(code), created: new Date().toISOString() }));
        extWs?.close();
        return reply({ extCode: code });
      }
      case 'totp': { const s2 = vault.secretFor(msg.id); if (!s2.totp) throw new Error('No 2FA key saved for this login.'); return reply({ totp: { id: msg.id, ...vault.totpCode(s2.totp) } }); }
      case 'reveal': return reply({ revealed: { id: msg.id, password: vault.secretFor(msg.id).password, copy: !!msg.copy } });
      default: throw new Error('Unknown vault request.');
    }
  } catch (e) { reply({ error: e.message }); }
}

orbWss.on('connection', (ws, req) => {
  ws.rpID = rpOf(req); ws.origin = req.headers.origin; ws.isLocalPC = isLocal(req); ws.cid = crypto.randomBytes(6).toString('hex');
  const send = (o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.type === 'vault') return vaultOp(ws, msg);
    if (msg.type === 'say' && msg.text?.trim()) { active = ws; orb.say(msg.text); }
    if (msg.type === 'interrupt' && ws === active) orb.interrupt();
    if (msg.type === 'answer') {            // phone picked up a push "call"
      active = ws;
      send({ type: 'sentence', text: push.pendingCalls.get(msg.id) || 'Sir. You rang?' });
      send({ type: 'done' });
      push.pendingCalls.delete(msg.id);
    }
  });
  ws.on('close', () => { if (active === ws) active = null; });
});

// Twilio ConversationRelay (optional, paid): Twilio transcribes the caller and speaks our text back.
relayWss.on('connection', (ws) => {
  let session, first = true;
  const say = (text, last) => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'text', token: text + ' ', last }));
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.type === 'setup') {
      console.log('call connected', msg.callSid);
      session = new VoiceSession(`phone:${msg.callSid}`);
      session.on({ sentence: (s) => say(s, false), done: () => say('', true) });
    }
    if (msg.type === 'interrupt') session?.interrupt();
    if (msg.type === 'prompt' && msg.last !== false) {
      console.log('caller:', msg.voicePrompt);
      session?.say((first ? '[Phone call with the user; you already greeted them. Keep replies extra short.] ' : '') + msg.voicePrompt);
      first = false;
    }
  });
  ws.on('close', () => session?.close());
});

// HOST=0.0.0.0 in Docker (behind Caddy); localhost-only on the PC.
server.listen(PORT, process.env.HOST || (process.platform === 'win32' ? '127.0.0.1' : '0.0.0.0'), async () => {
  // Twilio needs a public address. On AWS set PUBLIC_URL; on this PC a free Cloudflare tunnel is opened.
  if ((phoneConfigured() || alexa.configured() || process.env.JARVIS_TUNNEL === '1') && !process.env.PUBLIC_URL) {
    const { startTunnel } = await import('./tunnel.js');
    try { process.env.PUBLIC_URL = await startTunnel(PORT); console.log(`  tunnel: ${process.env.PUBLIC_URL}`); }
    catch (e) { console.error('  tunnel failed:', e.message); }
  }
  // Free Telegram calls: run the Python caller alongside Mark once it's logged in.
  if (telegramConfigured()) {
    const py = path.join(ROOT, 'telegram', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    const session = process.env.TELEGRAM_SESSION || path.join(ROOT, 'telegram', 'mark');
    if (fs.existsSync(`${session}.session`)) {
      const { spawn } = await import('node:child_process');
      const child = spawn(py, [path.join(ROOT, 'telegram', 'caller.py')], { stdio: 'inherit', env: { ...process.env, PORT: String(PORT) } });
      process.on('exit', () => child.kill());
    } else console.log('  telegram: log Mark in once with  telegram\\.venv\\Scripts\\python telegram\\caller.py login');
  }
  console.log(`\n  MARK online  ->  http://localhost:${PORT}`);
  console.log(`  calls:  ${telegramConfigured() ? 'Telegram (free)' : phoneConfigured() ? 'Twilio' : `free push calls (${push.hasSubscribers() ? 'phone paired' : 'no phone paired yet'})`}`);
  if (alexa.configured()) console.log('  alexa:  skill endpoint at ' + (process.env.PUBLIC_URL || 'no public address yet') + '/alexa');
  console.log(`  remote: ${process.env.JARVIS_URL || 'set JARVIS_URL (your Tailscale address) to use Mark from your phone'}\n`);
});
