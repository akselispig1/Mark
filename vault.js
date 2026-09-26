// Mark's password vault.
// - Encrypted at rest: scrypt(master password) -> AES-256-GCM. The file alone is useless without the master password.
// - The key only lives in this process's memory while unlocked, and it auto-locks after inactivity.
// - Nothing in here ever hands a password to the AI: secrets only go to a screen where a person typed the
//   master password (see server.js), or straight onto the PC clipboard.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = process.env.VAULT_FILE || path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'vault.json');
const AUTOLOCK_MS = Number(process.env.VAULT_AUTOLOCK_MIN || 10) * 60_000;
const KDF = { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
const CHECK = 'mark-vault-v1';

let key = null, items = null, lockTimer = null, fails = 0, blockedUntil = 0;
const listeners = new Set();
export const onChange = (fn) => listeners.add(fn);
const changed = () => listeners.forEach((fn) => fn(status()));

const derive = (master, salt) => new Promise((ok, no) => crypto.scrypt(master.normalize('NFKC'), salt, 32, KDF, (e, k) => (e ? no(e) : ok(k))));
function seal(k, plaintext) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', k, iv);
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64') };
}
function open(k, box) {
  const d = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(box.iv, 'base64'));
  d.setAuthTag(Buffer.from(box.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(box.ct, 'base64')), d.final()]).toString('utf8');
}
const read = () => JSON.parse(fs.readFileSync(FILE, 'utf8'));
function persist() {
  const file = read();
  file.items = seal(key, JSON.stringify(items));
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(file));
  fs.renameSync(FILE + '.tmp', FILE);                       // atomic: never leaves a half-written vault
}
function touch() {
  clearTimeout(lockTimer);
  lockTimer = setTimeout(lock, AUTOLOCK_MS);
  lockTimer.unref?.();
}

export const exists = () => fs.existsSync(FILE);
export const isUnlocked = () => !!key;
export const status = () => ({ exists: exists(), unlocked: isUnlocked(), count: items?.length ?? null, autolockMin: AUTOLOCK_MS / 60_000, helloUnlock: helloUnlockReady() });

export async function create(master) {
  if (exists()) throw new Error('A vault already exists.');
  if (!master || master.length < 10) throw new Error('Use a master password of at least 10 characters.');
  const salt = crypto.randomBytes(16);
  const k = await derive(master, salt);
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify({ v: 1, kdf: { ...KDF, maxmem: undefined, salt: salt.toString('base64') }, check: seal(k, CHECK), items: seal(k, '[]') }));
  key = k; items = []; touch(); changed();
}

export async function unlock(master) {
  if (Date.now() < blockedUntil) throw new Error(`Too many wrong attempts. Try again in ${Math.ceil((blockedUntil - Date.now()) / 1000)} seconds.`);
  const file = read();
  const k = await derive(master || '', Buffer.from(file.kdf.salt, 'base64'));
  try {
    if (open(k, file.check) !== CHECK) throw new Error();
  } catch {
    fails++;
    if (fails >= 5) { blockedUntil = Date.now() + 60_000 * 2 ** Math.min(4, fails - 5); }
    throw new Error('Wrong master password.');
  }
  fails = 0;
  let loaded;
  try { loaded = JSON.parse(open(k, file.items)); } catch { throw new Error('The vault file is damaged or was tampered with.'); }
  key = k; items = loaded; touch(); changed();
}

export function lock() {
  if (!key) return;
  key = null; items = null; clearTimeout(lockTimer); changed();
}

function need() { if (!key) throw new Error('The vault is locked. Unlock it on the orb screen (key button, top left).'); touch(); }

/** Names, usernames and sites only; never passwords. */
export function list() {
  need();
  return items.filter((i) => !i.sys).map(({ id, name, username, url, updated, totp: t }) => ({ id, name, username, url, updated, has2fa: !!t }));
}

export function find(query) {
  need();
  const q = String(query).toLowerCase().trim();
  const logins = items.filter((i) => !i.sys);
  return logins.find((i) => i.id === q) || logins.find((i) => i.name.toLowerCase() === q)
    || logins.find((i) => i.name.toLowerCase().includes(q) || (i.url || '').toLowerCase().includes(q));
}

/** Only for delivering to the user's screen/clipboard. Never return this to the AI. */
export function secretFor(query) {
  const it = find(query);
  if (!it) throw new Error(`No login matching "${query}".`);
  return { name: it.name, username: it.username, password: it.password, url: it.url || '', totp: it.totp };
}

export function generate(length = 20) {
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!@#$%^&*-_=+?'];
  const all = sets.join('');
  const n = Math.min(64, Math.max(12, length | 0));
  let pw;
  do {
    pw = Array.from({ length: n }, () => all[crypto.randomInt(all.length)]).join('');
  } while (!sets.every((s) => [...pw].some((c) => s.includes(c))));      // at least one of each kind
  return pw;
}

export function add({ name, username = '', password, url = '', notes = '', totp: totpInput = '' }) {
  need();
  if (!name?.trim()) throw new Error('Give the login a name.');
  const existing = items.find((i) => i.name.toLowerCase() === name.trim().toLowerCase());
  const pw = password || existing?.password || generate();
  const totpSpec = totpInput ? parseTotp(totpInput) : existing?.totp;
  const entry = { id: existing?.id || crypto.randomBytes(4).toString('hex'), name: name.trim(), username, password: pw, url, notes, totp: totpSpec, updated: new Date().toISOString() };
  items = existing ? items.map((i) => (i === existing ? entry : i)) : [...items, entry];
  persist(); changed();
  return { id: entry.id, name: entry.name, username, url, replaced: !!existing };
}

// Settings kept inside the encrypted vault (e.g. the Gmail app password used to read login codes).
export function setSystem(key, data) {
  need();
  items = [...items.filter((i) => i.sys !== key), ...(data ? [{ id: `sys:${key}`, sys: key, data, updated: new Date().toISOString() }] : [])];
  persist(); changed();
}
export function getSystem(key) { need(); return items.find((i) => i.sys === key)?.data || null; }
export const hasSystem = (key) => !!items?.some((i) => i.sys === key);

export function remove(query) {
  const it = find(query);
  if (!it) throw new Error(`No login matching "${query}".`);
  items = items.filter((i) => i !== it);
  persist(); changed();
  return it.name;
}

// ---- Unlocking with Windows Hello instead of the master password ----
// WebAuthn's PRF extension lets the TPM produce a secret that only appears after your face,
// fingerprint or PIN — and only for this site. We wrap the vault key with it and keep that wrapped
// copy in the vault file. Stolen on its own the file is still useless: the unwrapping secret never
// leaves the security chip, and your master password still works as the way back in.
const helloKeyFrom = (prfSecret) =>
  Buffer.from(crypto.hkdfSync('sha256', Buffer.from(prfSecret, 'base64url'), Buffer.alloc(0), Buffer.from('mark-vault-hello'), 32));

/** A per-vault salt for the PRF. Not secret; it just makes the derived key specific to this vault. */
export function helloSalt() {
  const file = read();
  if (!file.helloSalt) {
    file.helloSalt = crypto.randomBytes(32).toString('base64url');
    fs.writeFileSync(FILE, JSON.stringify(file));
  }
  return file.helloSalt;
}

export const helloUnlockReady = () => { try { return !!read().helloKey; } catch { return false; } };

export function enableHelloUnlock(prfSecret) {
  need();                                                  // only while it's open and you're already in
  if (!prfSecret) throw new Error('Windows Hello did not return a key on this device.');
  const file = read();
  file.helloKey = seal(helloKeyFrom(prfSecret), key.toString('base64'));
  fs.writeFileSync(FILE, JSON.stringify(file));
  changed();
}

export function unlockWithHello(prfSecret) {
  const file = read();
  if (!file.helloKey) throw new Error('Windows Hello unlocking is not set up for this vault.');
  let k;
  try { k = Buffer.from(open(helloKeyFrom(prfSecret), file.helloKey), 'base64'); }
  catch { throw new Error("That didn't unwrap the vault. Use your master password, then set Windows Hello unlocking up again."); }
  let loaded;
  try { loaded = JSON.parse(open(k, file.items)); } catch { throw new Error('The vault file is damaged or was tampered with.'); }
  key = k; items = loaded; touch(); changed();
}

export function disableHelloUnlock() {
  const file = read();
  delete file.helloKey;
  fs.writeFileSync(FILE, JSON.stringify(file));
  changed();
}

// ---- Delivery (wired up by server.js) ----
let deliverer = null, recent = [];
export const setDeliverer = (fn) => (deliverer = fn);
/** Put a login's password (or username) on the user's clipboard. Returns where it went, never the secret. */
export async function deliver(query, what = 'password') {
  const secret = secretFor(query);
  if (!deliverer) throw new Error('Nothing to deliver it to.');
  if (what === 'code' && !secret.totp) throw new Error(`No 2FA key is saved for ${secret.name}.`);
  const value = what === 'username' ? secret.username : what === 'code' ? totpCode(secret.totp).code : secret.password;
  recent = [...recent.filter((r) => r.until > Date.now()), { hash: crypto.createHash('sha256').update(value).digest('hex'), until: Date.now() + 60_000 }];
  return { name: secret.name, where: await deliverer({ ...secret, value }, what) };
}
/** True if this text is a password Mark just copied (so the clipboard tool can refuse to read it back). */
export const isRecentSecret = (text) => {
  const h = crypto.createHash('sha256').update(String(text).trim()).digest('hex');
  return recent.some((r) => r.until > Date.now() && r.hash === h);
};

// Typing a login into the browser (via the extension). Wired up by server.js; returns a sentence, never the secret.
let autofiller = null;
export const setAutofiller = (fn) => (autofiller = fn);
export async function autofill(query) {
  if (!autofiller) throw new Error('Autofill is not available.');
  return autofiller(query);
}

// The same thing, but into Mark's own browser window rather than the user's Chrome.
let onNeedUnlock = null;
export const setNeedUnlock = (fn) => (onNeedUnlock = fn);
/** Called when Mark reaches for a password and the vault is shut, so the screen can offer it. */
export const askToUnlock = () => onNeedUnlock?.();

let browserFiller = null;
export const setBrowserFiller = (fn) => (browserFiller = fn);
export async function browserLogin(query) {
  if (!browserFiller) throw new Error("Mark's own browser isn't available.");
  return browserFiller(query);
}

// ---- 2FA codes (TOTP, RFC 6238): the 6-digit codes authenticator apps show ----
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32(str) {
  let bits = '';
  for (const c of str.toUpperCase().replace(/[\s=-]/g, '')) {
    const v = B32.indexOf(c);
    if (v < 0) throw new Error("That 2FA key isn't valid. Paste the setup key (letters and numbers) or the otpauth:// link.");
    bits += v.toString(2).padStart(5, '0');
  }
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}
/** Accepts a setup key ("JBSW Y3DP ...") or an otpauth://totp/... link from a QR code. */
export function parseTotp(input) {
  const txt = String(input).trim();
  let spec = { secret: txt, digits: 6, period: 30, algo: 'sha1' };
  if (/^otpauth:\/\//i.test(txt)) {
    const u = new URL(txt);
    spec = { secret: u.searchParams.get('secret') || '', digits: Number(u.searchParams.get('digits')) || 6,
      period: Number(u.searchParams.get('period')) || 30, algo: (u.searchParams.get('algorithm') || 'sha1').toLowerCase() };
  }
  spec.secret = spec.secret.toUpperCase().replace(/[\s=-]/g, '');
  if (base32(spec.secret).length < 10) throw new Error('That 2FA key looks too short.');
  return spec;
}
export function totpCode(spec, now = Date.now()) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 1000 / spec.period)));
  const h = crypto.createHmac(spec.algo || 'sha1', base32(spec.secret)).update(counter).digest();
  const o = h[h.length - 1] & 15;
  const code = ((h.readUInt32BE(o) & 0x7fffffff) % 10 ** spec.digits).toString().padStart(spec.digits, '0');
  return { code, expiresIn: spec.period - (Math.floor(now / 1000) % spec.period) };
}

// Typing a code that a website emailed you (Gmail). Wired up by server.js.
let emailFiller = null;
export const setEmailFiller = (fn) => (emailFiller = fn);
export async function emailCodeFill() {
  if (!emailFiller) throw new Error('Email codes are not available.');
  return emailFiller();
}
