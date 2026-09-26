// Mark's autonomy: alarms and scheduled Claude Code jobs (one-off or recurring "loops"),
// persisted in data/schedule.json so they survive restarts and run 24/7 on a server.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Cron } from 'croner';

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
const FILE = path.join(DATA, 'schedule.json');
const LOG = path.join(DATA, 'task-log.md');
export const TZ = process.env.TZ_MARK || process.env.TZ || 'Europe/Zurich';

let items = [];
try { items = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
const jobs = new Map();          // id -> Cron
let handlers = { alarm: async () => {}, runTask: async () => '', deliver: async () => {} };

const save = () => fs.writeFileSync(FILE, JSON.stringify(items, null, 2));

/**
 * Item shape:
 *  { id, kind: 'alarm' | 'task', label, prompt?, at?: ISO time, cron?: '0 7 * * *', everyMinutes?: n,
 *    notify: 'speak' | 'call' | 'auto' | 'silent', createdAt, lastRun?, lastResult? }
 */
function pattern(item) {
  if (item.cron) return item.cron;
  if (item.everyMinutes) return `*/${Math.max(1, Math.round(item.everyMinutes))} * * * *`;
  return item.at;                // local ISO time, interpreted in TZ by croner
}

function arm(item) {
  jobs.get(item.id)?.stop();
  let job;
  try { job = new Cron(pattern(item), { timezone: TZ, protect: true }, () => fire(item.id)); } catch { return; }
  if (!job.nextRun()) {
    job.stop();
    // A one-off that came due while Mark was offline: fire it now (once) rather than silently drop it.
    if (!item.cron && !item.everyMinutes && !item.lastRun) setTimeout(() => fire(item.id), 2000);
    return;
  }
  jobs.set(item.id, job);
}

async function fire(id) {
  const item = items.find((i) => i.id === id);
  if (!item) return;
  item.lastRun = new Date().toISOString();
  const oneOff = !item.cron && !item.everyMinutes;
  console.log(`[schedule] ${item.kind}: ${item.label}`);
  try {
    if (item.kind === 'alarm') {
      await handlers.alarm(item);
    } else {
      const result = await handlers.runTask(item);
      item.lastResult = String(result).slice(0, 2000);
      fs.appendFileSync(LOG, `\n## ${new Date().toLocaleString('en-GB', { timeZone: TZ })} — ${item.label}\n${result}\n`);
      await handlers.deliver(item, result);
    }
  } catch (e) {
    console.error('[schedule] failed:', e);
  }
  if (oneOff) { items = items.filter((i) => i.id !== id); jobs.get(id)?.stop(); jobs.delete(id); }
  save();
}

export function start(h) {
  handlers = { ...handlers, ...h };
  items.forEach(arm);
  console.log(`  schedule: ${items.length} item(s), timezone ${TZ}`);
}

export function add(spec) {
  const item = { id: crypto.randomBytes(3).toString('hex'), createdAt: new Date().toISOString(), notify: 'auto', ...spec };
  if (!item.at && !item.cron && !item.everyMinutes) throw new Error('Give a time (at), a cron pattern or every_minutes');
  // Validate the time / cron syntax and compute the next run before saving.
  const probe = new Cron(pattern(item), { timezone: TZ, paused: true });
  const next = probe.nextRun();
  probe.stop();
  if (!next) throw new Error('That time is in the past');
  items.push(item); save(); arm(item);
  return { ...item, next: next.toLocaleString('en-GB', { timeZone: TZ }) };
}

export function list() {
  return items.map((i) => ({
    id: i.id, kind: i.kind, label: i.label, notify: i.notify,
    when: i.cron ? `cron ${i.cron}` : i.everyMinutes ? `every ${i.everyMinutes} min` : i.at,
    next: jobs.get(i.id)?.nextRun()?.toLocaleString('en-GB', { timeZone: TZ }) ?? 'now/overdue',
    lastRun: i.lastRun, lastResult: i.lastResult?.slice(0, 200),
  }));
}

export function cancel(idOrText) {
  const q = idOrText.toLowerCase();
  const gone = items.filter((i) => i.id === q || i.label.toLowerCase().includes(q));
  gone.forEach((i) => { jobs.get(i.id)?.stop(); jobs.delete(i.id); });
  items = items.filter((i) => !gone.includes(i));
  save();
  return gone.map((i) => i.label);
}

export const nowString = () => new Date().toLocaleString('en-GB', { timeZone: TZ, weekday: 'long', hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'long', year: 'numeric' });
