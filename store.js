// Keeping your data safe across updates.
//
// Everything personal lives in data/ — vault, voiceprint, memory, transcripts, schedule. That folder
// is never in the repository, so pulling code can't touch it. The one way an update could still hurt
// you is by changing the *shape* of a file so the old one no longer loads. This stops that:
//
//   - before any update that changes a format, the whole of data/ is copied to data/backups/<date>
//   - migrations only ever add; nothing here deletes or overwrites your content
//   - if a migration throws, we stop rather than carry on with half-converted files
//
// Adding a migration: bump VERSION, add an entry to MIGRATIONS with the same number.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(ROOT, 'data');
const STAMP = path.join(DATA, 'version.json');
const BACKUPS = path.join(DATA, 'backups');

export const VERSION = 1;

/** Keyed by the version they upgrade *to*. Each one must be safe to run twice. */
const MIGRATIONS = {
  // 2: (data) => { ... },
};

const read = (f, fallback = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } };

/** Copy everything personal to data/backups/<date>, minus the browser profile (big and replaceable). */
export function backup(why = 'manual') {
  if (!fs.existsSync(DATA)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dest = path.join(BACKUPS, `${stamp}-${why}`);
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(DATA)) {
    if (name === 'backups' || name === 'browser') continue;      // skip itself and the 70 MB profile
    const from = path.join(DATA, name);
    fs.cpSync(from, path.join(dest, name), { recursive: true });
  }
  // Keep the ten most recent; older ones go.
  const all = fs.readdirSync(BACKUPS).sort();
  for (const old of all.slice(0, Math.max(0, all.length - 10))) fs.rmSync(path.join(BACKUPS, old), { recursive: true, force: true });
  return dest;
}

/**
 * Run at start-up, before anything reads your files. Returns a line to print, or null if there was
 * nothing to do (the usual case).
 */
export function migrate() {
  if (!fs.existsSync(DATA)) { fs.mkdirSync(DATA, { recursive: true }); }
  const at = read(STAMP, { version: fs.readdirSync(DATA).length > 1 ? 1 : VERSION }).version;
  if (at === VERSION) {
    if (!fs.existsSync(STAMP)) fs.writeFileSync(STAMP, JSON.stringify({ version: VERSION }, null, 1));
    return null;
  }
  if (at > VERSION) {
    throw new Error(`Your data is from a newer version of Mark (${at} > ${VERSION}). Update the code before starting, or your files could be damaged.`);
  }

  const saved = backup(`before-v${VERSION}`);
  for (let v = at + 1; v <= VERSION; v++) {
    const step = MIGRATIONS[v];
    if (!step) continue;
    try { step({ DATA, read }); } catch (e) {
      throw new Error(`Update to version ${v} failed: ${e.message}. Nothing was lost — your files are in ${saved}.`);
    }
  }
  fs.writeFileSync(STAMP, JSON.stringify({ version: VERSION, updated: new Date().toISOString() }, null, 1));
  return `data updated ${at} -> ${VERSION} (a copy of the old files is in ${path.relative(ROOT, saved)})`;
}
