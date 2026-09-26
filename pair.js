// Prints the one-time pairing link + QR for a new device (use on a server, where the orb's QR button isn't available).
//   node pair.js            (locally)
//   docker compose exec mark node pair.js   (on AWS)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';

try { process.loadEnvFile(); } catch {}
const root = path.dirname(fileURLToPath(import.meta.url));
const base = process.env.JARVIS_URL;
if (!base) { console.error('Set JARVIS_URL first (e.g. https://1-2-3-4.sslip.io).'); process.exit(1); }
const key = fs.readFileSync(path.join(root, 'data', 'pair-key.txt'), 'utf8').trim();
const link = `${base.replace(/\/$/, '')}/?key=${key}`;
console.log(await QRCode.toString(link, { type: 'terminal', small: true }));
console.log(link);
