// Mark's long-term memory: a plain Markdown file of facts about you, loaded into every conversation.
// You can read or edit it yourself: data/memory.md
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
const FILE = path.join(DATA, 'memory.md');
const HEADER = '# What Mark knows about you\n\n';
fs.mkdirSync(DATA, { recursive: true });

const read = () => { try { return fs.readFileSync(FILE, 'utf8'); } catch { return HEADER; } };
const facts = () => read().split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2));
const write = (list) => fs.writeFileSync(FILE, HEADER + list.map((f) => `- ${f}`).join('\n') + '\n');

export function memoryText() {
  const list = facts();
  return list.length ? list.map((f) => `- ${f}`).join('\n') : '(nothing yet)';
}

export function remember(fact) {
  const clean = fact.replace(/\s+/g, ' ').trim();
  const list = facts();
  if (!list.some((f) => f.toLowerCase() === clean.toLowerCase())) write([...list, `${clean} (${new Date().toISOString().slice(0, 10)})`]);
  return clean;
}

/** Remove every fact containing the given text (case-insensitive). Returns how many were removed. */
export function forget(text) {
  const list = facts();
  const keep = list.filter((f) => !f.toLowerCase().includes(text.toLowerCase()));
  write(keep);
  return list.length - keep.length;
}

// Conversation continuity: the orb's Claude session id survives restarts.
const SESS = path.join(DATA, 'sessions.json');
export const savedSession = (channel) => { try { return JSON.parse(fs.readFileSync(SESS, 'utf8'))[channel]; } catch { return undefined; } };
export function saveSession(channel, id) {
  let all = {};
  try { all = JSON.parse(fs.readFileSync(SESS, 'utf8')); } catch {}
  if (all[channel] === id) return;
  all[channel] = id;
  fs.writeFileSync(SESS, JSON.stringify(all, null, 2));
}
