// Google: Docs, Drive, Calendar and Gmail through the real APIs rather than by driving a browser.
//
// Signing in happens once, in your own browser, and Google hands back a refresh token that keeps
// working. It's kept in data/google.json — same standing as the Claude token in .env, and like
// everything else in data/ it never leaves this machine.
//
// You have to create the OAuth client yourself (see README); there's no way around that, because
// Google ties API access to a project that belongs to you.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'google.json');
const SCOPES = [
  'https://www.googleapis.com/auth/drive.file',      // only files Mark creates or you open with him
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/calendar.events',
].join(' ');

const load = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return null; } };
const save = (t) => { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(t, null, 1)); };

export const configured = () => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
export const connected = () => !!load()?.refresh_token;
export function disconnect() { try { fs.unlinkSync(FILE); } catch {} }

/* ---------- signing in ---------- */
const pending = new Map();

/** The link you click once to let Mark in. Redirects back to him when you approve. */
export function authLink(redirectUri) {
  if (!configured()) throw new Error('Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env first — see the README.');
  const state = crypto.randomBytes(16).toString('hex');
  pending.set(state, { redirectUri, at: Date.now() });
  for (const [k, v] of pending) if (Date.now() - v.at > 600_000) pending.delete(k);
  const q = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent',                 // so Google actually hands back a refresh token
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

export async function finishAuth(code, state) {
  const p = pending.get(state);
  if (!p) throw new Error('That sign-in link has expired. Ask Mark to connect Google again.');
  pending.delete(state);
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: p.redirectUri, grant_type: 'authorization_code',
    }),
  });
  const t = await res.json();
  if (!res.ok || !t.refresh_token) throw new Error(t.error_description || t.error || 'Google would not hand back a token.');
  save({ refresh_token: t.refresh_token, access_token: t.access_token, expires: Date.now() + (t.expires_in - 60) * 1000 });
  return true;
}

/** A live access token, refreshed when it's about to run out. */
async function token() {
  const t = load();
  if (!t?.refresh_token) throw new Error("Google isn't connected yet. Tell the user to say \"Mark, connect Google\".");
  if (t.access_token && Date.now() < t.expires) return t.access_token;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: t.refresh_token, client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET, grant_type: 'refresh_token',
    }),
  });
  const n = await res.json();
  if (!res.ok) throw new Error(n.error_description || 'Google sign-in has expired — connect it again.');
  save({ ...t, access_token: n.access_token, expires: Date.now() + (n.expires_in - 60) * 1000 });
  return n.access_token;
}

async function api(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { authorization: `Bearer ${await token()}`, 'content-type': 'application/json', ...options.headers },
  });
  const body = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error?.message || `Google said ${res.status}`);
  return body;
}

/* ---------- the things he can actually do ---------- */

/** A new Google Doc with a title and, optionally, something already written in it. */
export async function createDoc(title, text = '') {
  const doc = await api('https://docs.googleapis.com/v1/documents', {
    method: 'POST', body: JSON.stringify({ title }),
  });
  if (text) await appendDoc(doc.documentId, text);
  return { id: doc.documentId, title, url: `https://docs.google.com/document/d/${doc.documentId}/edit` };
}

export async function appendDoc(documentId, text) {
  await api(`https://docs.googleapis.com/v1/documents/${documentId}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({ requests: [{ insertText: { endOfSegmentLocation: {}, text } }] }),
  });
  return { url: `https://docs.google.com/document/d/${documentId}/edit` };
}

export async function readDoc(documentId) {
  const d = await api(`https://docs.googleapis.com/v1/documents/${documentId}`);
  const out = (d.body?.content || []).flatMap((c) =>
    (c.paragraph?.elements || []).map((e) => e.textRun?.content || '')).join('');
  return { title: d.title, text: out.trim() };
}

/** Find something among the files Mark has made or been shown. */
export async function findFiles(query) {
  const q = new URLSearchParams({
    q: `name contains '${String(query).replace(/'/g, "\\'")}' and trashed = false`,
    fields: 'files(id,name,mimeType,modifiedTime,webViewLink)', pageSize: '10',
  });
  const r = await api(`https://www.googleapis.com/drive/v3/files?${q}`);
  return (r.files || []).map((f) => ({
    name: f.name, url: f.webViewLink, id: f.id,
    kind: f.mimeType.replace('application/vnd.google-apps.', ''),
    modified: f.modifiedTime?.slice(0, 10),
  }));
}
