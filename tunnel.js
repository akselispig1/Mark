// Free public HTTPS link to this PC (Cloudflare quick tunnel, no account) so Twilio can reach Mark.
// Not needed on AWS, where the server already has a public address (set PUBLIC_URL instead).
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const INSTALLED = ['C:\\Program Files (x86)\\cloudflared\\cloudflared.exe', 'C:\\Program Files\\cloudflared\\cloudflared.exe'];

export function startTunnel(port) {
  const bin = INSTALLED.find((c) => fs.existsSync(c)) || 'cloudflared';
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => reject(new Error('tunnel did not start within 30s')), 30_000);
    const onData = (buf) => {
      const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(buf.toString());
      if (m) { clearTimeout(timer); resolve(m[0]); }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
    process.on('exit', () => proc.kill());
  });
}
