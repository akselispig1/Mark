// Live machine stats for the orb's HUD readouts (this PC, or the server when on AWS).
import os from 'node:os';
import fs from 'node:fs';
import net from 'node:net';
import { execFile } from 'node:child_process';

const stats = { cpu: 0, mem: 0, disk: null, ping: null, battery: null, charging: null, uptime: 0 };

// CPU: busy share across all cores since the last sample.
let prev = os.cpus();
function sampleCpu() {
  const cur = os.cpus();
  let idle = 0, total = 0;
  cur.forEach((c, i) => {
    const p = prev[i].times, n = c.times;
    const t = Object.keys(n).reduce((s, k) => s + n[k] - p[k], 0);
    total += t; idle += n.idle - p.idle;
  });
  prev = cur;
  if (total > 0) stats.cpu = Math.round((1 - idle / total) * 100);
  stats.mem = Math.round((1 - os.freemem() / os.totalmem()) * 100);
  stats.uptime = Math.round(os.uptime());
}

function sampleDisk() {
  try {
    const s = fs.statfsSync(process.platform === 'win32' ? 'C:/' : '/');
    stats.disk = Math.round((1 - s.bavail / s.blocks) * 100);   // % used
  } catch {}
}

// Network: time to open a TCP connection to Cloudflare's DNS (a real round trip, no data sent).
function samplePing() {
  const t0 = performance.now();
  const sock = net.connect({ host: '1.1.1.1', port: 443, timeout: 3000 });
  sock.once('connect', () => { stats.ping = Math.round(performance.now() - t0); sock.destroy(); });
  sock.once('timeout', () => { stats.ping = null; sock.destroy(); });
  sock.once('error', () => { stats.ping = null; });
}

// Battery (Windows laptops): charge % and whether it's plugged in.
function sampleBattery() {
  if (process.platform !== 'win32') return;
  execFile('powershell', ['-NoProfile', '-Command',
    'Get-CimInstance Win32_Battery | Select-Object EstimatedChargeRemaining,BatteryStatus | ConvertTo-Json -Compress'],
    { windowsHide: true, timeout: 10000 }, (err, out) => {
      if (err || !out.trim()) return;
      try {
        const b = [].concat(JSON.parse(out))[0];
        stats.battery = b.EstimatedChargeRemaining;
        stats.charging = b.BatteryStatus !== 1;      // 1 = discharging; 2+ = on AC / charging
      } catch {}
    });
}

sampleCpu(); sampleDisk(); samplePing(); sampleBattery();
setInterval(sampleCpu, 1000).unref();
setInterval(samplePing, 5000).unref();
setInterval(sampleDisk, 60000).unref();
setInterval(sampleBattery, 30000).unref();

export const getStats = () => stats;
