// Built-in tools that need no accounts or keys: weather, Swiss trains, news, and (on the Windows PC)
// clipboard, volume/media keys and opening apps. Fast and exact, so Mark doesn't
// have to guess from web searches.
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { execFile } from 'node:child_process';
import { getStats } from './stats.js';
import { isRecentSecret } from './vault.js';

const text = (t) => ({ content: [{ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t) }] });
const fail = (t) => ({ ...text(t), isError: true });
const isWin = process.platform === 'win32';
const pcOnly = () => fail('That only works when Mark runs on the Windows PC, not on the server.');
const getJson = async (url) => { const r = await fetch(url, { signal: AbortSignal.timeout(10000) }); if (!r.ok) throw new Error(`${r.status} from ${new URL(url).host}`); return r.json(); };

function ps(script, env = {}) {
  return new Promise((resolve, reject) => execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, timeout: 20000, maxBuffer: 20 * 1024 * 1024, env: { ...process.env, ...env } },
    (err, out, errOut) => (err ? reject(new Error(errOut || err.message)) : resolve(out))));
}

// WMO weather codes -> words
const WMO = { 0: 'clear', 1: 'mostly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 48: 'freezing fog', 51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle',
  61: 'light rain', 63: 'rain', 65: 'heavy rain', 66: 'freezing rain', 67: 'heavy freezing rain', 71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains',
  80: 'light showers', 81: 'showers', 82: 'violent showers', 85: 'snow showers', 86: 'heavy snow showers', 95: 'thunderstorm', 96: 'thunderstorm with hail', 99: 'severe thunderstorm with hail' };

const NEWS = {
  world: 'https://feeds.bbci.co.uk/news/world/rss.xml',
  tech: 'https://feeds.bbci.co.uk/news/technology/rss.xml',
  swiss: 'https://www.srf.ch/news/bnf/rss/1646',
  sport: 'https://feeds.bbci.co.uk/sport/rss.xml',
  science: 'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml',
};

export const localTools = () => [
  tool('weather', 'Exact current weather and forecast for a place (Open-Meteo). Prefer this over web search for weather.',
    { place: z.string().optional().describe('City/town, default Zurich'), days: z.number().optional().describe('Forecast days 1-7, default 2') },
    async ({ place = 'Zurich', days = 2 }) => {
      try {
        const geo = (await getJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(place)}&count=1`)).results?.[0];
        if (!geo) return fail(`Couldn't find ${place}.`);
        const w = await getJson(`https://api.open-meteo.com/v1/forecast?latitude=${geo.latitude}&longitude=${geo.longitude}&timezone=auto&forecast_days=${Math.min(7, Math.max(1, days))}`
          + '&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,precipitation'
          + '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset');
        return text({
          place: `${geo.name}, ${geo.country}`,
          now: { temp_c: w.current.temperature_2m, feels_like_c: w.current.apparent_temperature, sky: WMO[w.current.weather_code], wind_kmh: w.current.wind_speed_10m, precip_mm: w.current.precipitation, at: w.current.time },
          days: w.daily.time.map((d, i) => ({ date: d, sky: WMO[w.daily.weather_code[i]], min_c: w.daily.temperature_2m_min[i], max_c: w.daily.temperature_2m_max[i], rain_chance: w.daily.precipitation_probability_max[i], sunrise: w.daily.sunrise[i].slice(11), sunset: w.daily.sunset[i].slice(11) })),
        });
      } catch (e) { return fail(`Weather unavailable: ${e.message}`); }
    }),

  tool('trains', 'Live Swiss public transport connections (SBB/transport.opendata.ch): next departures between two places, with platform and delays.',
    { from: z.string(), to: z.string(), time: z.string().optional().describe('HH:MM to depart after, default now'), date: z.string().optional().describe('YYYY-MM-DD') },
    async ({ from, to, time, date }) => {
      try {
        const q = new URLSearchParams({ from, to, limit: '4' });
        if (time) q.set('time', time);
        if (date) q.set('date', date);
        const d = await getJson(`https://transport.opendata.ch/v1/connections?${q}`);
        if (!d.connections?.length) return fail('No connections found.');
        return text(d.connections.map((c) => ({
          departs: c.from.departure?.slice(11, 16), platform: c.from.platform, delay_min: c.from.delay,
          arrives: c.to.arrival?.slice(11, 16), duration: c.duration?.replace(/^00d/, ''), changes: c.transfers,
          via: c.products?.join(' → '),
        })));
      } catch (e) { return fail(`Timetable unavailable: ${e.message}`); }
    }),

  tool('news', 'Latest headlines. Topics: world, swiss (German, SRF), tech, sport, science.',
    { topic: z.enum(['world', 'swiss', 'tech', 'sport', 'science']).optional() },
    async ({ topic = 'world' }) => {
      try {
        const xml = await (await fetch(NEWS[topic], { signal: AbortSignal.timeout(10000) })).text();
        const items = [...xml.matchAll(/<item>[\s\S]*?<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>[\s\S]*?(?:<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>)?/g)]
          .slice(0, 8).map((m) => ({ headline: m[1].trim(), summary: (m[2] || '').replace(/<[^>]+>/g, '').trim().slice(0, 200) }));
        return text(items);
      } catch (e) { return fail(`News unavailable: ${e.message}`); }
    }),

  tool('system_status', 'Live stats of the machine Mark runs on: CPU, memory, disk, battery, network latency, uptime, and the busiest programs.', {},
    async () => {
      const s = { ...getStats() };
      if (isWin) {
        try {
          s.top_programs = (await ps('Get-Process | Sort-Object CPU -Descending | Select-Object -First 5 Name,@{n="MB";e={[int]($_.WorkingSet64/1MB)}} | ConvertTo-Json -Compress')).trim();
        } catch {}
      }
      return text(s);
    }),

  tool('clipboard', 'Read the clipboard, or copy text to it.',
    { set: z.string().optional().describe('Text to copy. Omit to read the clipboard.') },
    async ({ set }) => {
      if (!isWin) return pcOnly();
      try {
        if (set != null) { await ps('Set-Clipboard -Value $env:JARVIS_CLIP', { JARVIS_CLIP: set }); return text('Copied.'); }
        const clip = await ps('Get-Clipboard -Raw');
        if (isRecentSecret(clip)) return text('(The clipboard holds a password from the vault, hidden.)');
        return text(clip.slice(0, 8000) || '(clipboard is empty)');
      } catch (e) { return fail(`Clipboard failed: ${e.message}`); }
    }),

  tool('media', 'Control PC audio and playback: volume up/down, mute, play/pause, next or previous track (works with Spotify, YouTube, etc.).',
    { action: z.enum(['volume_up', 'volume_down', 'mute', 'play_pause', 'next', 'previous']), steps: z.number().optional().describe('Volume steps of 2%, default 5') },
    async ({ action, steps = 5 }) => {
      if (!isWin) return pcOnly();
      const key = { volume_up: 175, volume_down: 174, mute: 173, play_pause: 179, next: 176, previous: 177 }[action];
      const n = action.startsWith('volume') ? Math.min(50, Math.max(1, Math.round(steps))) : 1;
      try { await ps(`$w = New-Object -ComObject WScript.Shell; 1..${n} | ForEach-Object { $w.SendKeys([char]${key}) }`); return text('Done.'); }
      catch (e) { return fail(`Media control failed: ${e.message}`); }
    }),

  tool('open', 'Open something on the PC: a website, a YouTube search, an app by name (e.g. notepad, spotify, calc), a file/folder path, or an app link like steam://rungameid/...',
    { target: z.string(), youtube_search: z.boolean().optional().describe('Treat target as a YouTube search') },
    async ({ target, youtube_search }) => {
      if (!isWin) return pcOnly();
      const t = youtube_search ? `https://www.youtube.com/results?search_query=${encodeURIComponent(target)}` : target;
      const known = { spotify: 'spotify:', steam: 'steam:', settings: 'ms-settings:', calculator: 'calc', explorer: 'explorer' };
      try { await ps('Start-Process $env:JARVIS_OPEN', { JARVIS_OPEN: known[t.toLowerCase()] || t }); return text(`Opened ${t}.`); }
      catch (e) { return fail(`Couldn't open ${t}: ${e.message}`); }
    }),

  tool('whats_open', "What the user is doing right now: the window they're looking at, everything else that's open, and anything playing. Use it when they say \"this\", \"that page\", \"what I'm working on\", or when you need to know what they're up to before answering.",
    {}, async () => {
      if (!isWin) return pcOnly();
      try {
        const out = await ps(`
          Add-Type -AssemblyName UIAutomationClient -ErrorAction SilentlyContinue
          $sig = '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();'
          $u = Add-Type -MemberDefinition $sig -Name W -PassThru -ErrorAction SilentlyContinue
          $fg = if ($u) { $u::GetForegroundWindow() } else { 0 }
          Get-Process | Where-Object { $_.MainWindowTitle } | ForEach-Object {
            [pscustomobject]@{ app = $_.ProcessName; title = $_.MainWindowTitle; front = ($_.MainWindowHandle -eq $fg) }
          } | ConvertTo-Json -Compress`);
        const list = JSON.parse(out.trim() || '[]');
        const all = Array.isArray(list) ? list : [list];
        const front = all.find((w) => w.front);
        return text({
          in_front: front ? { app: front.app, title: front.title } : null,
          also_open: all.filter((w) => !w.front).map((w) => ({ app: w.app, title: w.title })).slice(0, 20),
        });
      } catch (e) { return fail(`Couldn't see the windows: ${e.message}`); }
    }),

  tool('browse', `Mark's own browser — a real Chrome with its own profile, separate from the user's. Use it to look at websites, check things behind a login, read pages that web search can't reach, and fill in forms. Steps:
  go <url>     open a page (returns its text)
  read         the page text again, in full
  parts        numbered list of everything clickable or fillable
  click <what> click a button or link by its words, or by a number from "parts"
  type <what>  type into a box (target = its label; set enter to submit)
  scroll / back / close
Passwords are refused here on purpose — use browser_login for those. Tell the user what you're doing as you go, since each step takes a second or two.`,
    {
      action: z.enum(['go', 'read', 'parts', 'click', 'type', 'press', 'scroll', 'back', 'close']),
      target: z.string().optional().describe('URL for go; the words on a button/box, or its number from "parts"'),
      text: z.string().optional().describe('What to type, for type'),
      enter: z.boolean().optional().describe('Press enter after typing (submits a search or form)'),
    },
    async (args) => {
      try { const { act } = await import('./browser.js'); return text(await act(args)); }
      catch (e) { return fail(e.message); }
    }),
];
