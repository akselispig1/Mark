// Starts Mark in the background (if he isn't already running) and opens the orb in its own app window.
// Used by the Windows startup entry; you can also double-click start-mark.vbs.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const URL_ = 'http://localhost:7777';
const up = () => fetch(URL_, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok).catch(() => false);

if (!(await up())) {
  fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
  const log = fs.openSync(path.join(ROOT, 'data', 'mark.log'), 'a');
  spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, detached: true, stdio: ['ignore', log, log], windowsHide: true }).unref();
  for (let i = 0; i < 60 && !(await up()); i++) await new Promise((r) => setTimeout(r, 500));
}

const browsers = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];
const browser = browsers.find((b) => fs.existsSync(b));
if (browser) spawn(browser, [`--app=${URL_}`, '--start-maximized'], { detached: true, stdio: 'ignore' }).unref();
process.exit(0);
