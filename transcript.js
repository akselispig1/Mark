// A plain record of everything said, so "what did I ask you about the car last week?" has an answer.
// One file per day in data/transcript, human-readable, and easy to delete.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'transcript');
const dayFile = (d = new Date()) => path.join(DIR, `${d.toISOString().slice(0, 10)}.jsonl`);

export function log(who, what, channel = 'orb') {
  const line = String(what || '').trim();
  if (!line) return;
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.appendFileSync(dayFile(), JSON.stringify({ at: new Date().toISOString(), channel, who, what: line }) + '\n');
  } catch {}
}

const days = () => { try { return fs.readdirSync(DIR).filter((f) => f.endsWith('.jsonl')).sort(); } catch { return []; } };
const readDay = (f) => {
  try {
    return fs.readFileSync(path.join(DIR, f), 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
};

/** Everything said on a given day (default today), oldest first. */
export function onDay(dateish) {
  const d = dateish ? new Date(dateish) : new Date();
  if (Number.isNaN(+d)) return [];
  return readDay(`${d.toISOString().slice(0, 10)}.jsonl`);
}

/** Lines mentioning all of these words, newest first, with the couple of lines around each. */
export function find(query, { limit = 12, sinceDays = 400 } = {}) {
  const want = query.toLowerCase().split(/\s+/).filter(Boolean);
  const cutoff = Date.now() - sinceDays * 864e5;
  const out = [];
  for (const f of days().reverse()) {
    if (new Date(f.slice(0, 10)) < cutoff) break;
    const lines = readDay(f);
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      if (!want.every((w) => lines[i].what.toLowerCase().includes(w))) continue;
      out.push({
        when: lines[i].at.slice(0, 16).replace('T', ' '),
        context: lines.slice(Math.max(0, i - 1), i + 2).map((l) => `${l.who}: ${l.what}`),
      });
    }
    if (out.length >= limit) break;
  }
  return out;
}

export const stats = () => {
  const all = days();
  return { days: all.length, first: all[0]?.slice(0, 10) || null, lines: all.reduce((n, f) => n + readDay(f).length, 0) };
};
