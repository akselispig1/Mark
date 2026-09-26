// Free "phone calls": Mark rings your phone with a web push notification;
// tapping it opens the orb on your phone as a live voice call.
import webpush from 'web-push';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
fs.mkdirSync(DATA, { recursive: true });
const file = (n) => path.join(DATA, n);
const load = (n, fallback) => { try { return JSON.parse(fs.readFileSync(file(n), 'utf8')); } catch { return fallback; } };
const save = (n, v) => fs.writeFileSync(file(n), JSON.stringify(v, null, 2));

let vapid = load('vapid.json', null);
if (!vapid) { vapid = webpush.generateVAPIDKeys(); save('vapid.json', vapid); }
webpush.setVapidDetails('mailto:mark@localhost', vapid.publicKey, vapid.privateKey);

let subs = load('subscriptions.json', []);
export const pendingCalls = new Map(); // call id -> opening line

export const vapidPublicKey = () => vapid.publicKey;
export const hasSubscribers = () => subs.length > 0;

export function subscribe(sub) {
  if (!sub?.endpoint) return;
  subs = [...subs.filter((s) => s.endpoint !== sub.endpoint), sub];
  save('subscriptions.json', subs);
}

/** Ring every paired phone. Returns the call id. */
export async function ring(openingLine) {
  if (!subs.length) throw new Error('No phone paired yet. Open Mark on your phone and tap "enable calls".');
  const id = crypto.randomBytes(6).toString('hex');
  pendingCalls.set(id, openingLine);
  setTimeout(() => pendingCalls.delete(id), 10 * 60_000);
  const payload = JSON.stringify({ id, title: 'MARK is calling', body: openingLine });
  const results = await Promise.allSettled(subs.map((s) => webpush.sendNotification(s, payload, { TTL: 120, urgency: 'high' })));
  // Drop subscriptions the push service says are gone.
  const dead = new Set(results.flatMap((r, i) => (r.status === 'rejected' && [404, 410].includes(r.reason?.statusCode) ? [subs[i].endpoint] : [])));
  if (dead.size) { subs = subs.filter((s) => !dead.has(s.endpoint)); save('subscriptions.json', subs); }
  if (results.every((r) => r.status === 'rejected')) throw new Error('Push failed: ' + results[0].reason?.message);
  return id;
}

/** A tappable notification that opens a page (e.g. an approval request). */
export async function notify({ title, body, url, tag = 'mark' }) {
  if (!subs.length) return false;
  const payload = JSON.stringify({ title, body, url, tag });
  const res = await Promise.allSettled(subs.map((s) => webpush.sendNotification(s, payload, { TTL: 90, urgency: 'high' })));
  return res.some((r) => r.status === 'fulfilled');
}
