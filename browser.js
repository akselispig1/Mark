// Mark's own browser: a real Chrome window with its own profile, kept apart from yours.
// He can open pages, read them, click and type — so he can look things up, fill in forms and
// use websites that have no API. Passwords are the one thing he can't type himself: those go
// through the vault (browser_login), which needs your face or fingerprint every time.
//
// On the PC the window is visible, so you can watch and take over. On a server it runs headless.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const PROFILE = process.env.JARVIS_BROWSER_PROFILE || path.join(process.cwd(), 'data', 'browser');
const HEADLESS = process.env.JARVIS_BROWSER_HEADLESS
  ? process.env.JARVIS_BROWSER_HEADLESS === '1'
  : process.platform !== 'win32';                    // visible on your PC, headless on the server

// Sites he must never drive on his own: anywhere money moves, and account-recovery pages.
const BLOCKED_HOSTS = /^(.*\.)?(paypal|wise|revolut|coinbase|binance|kraken|stripe|klarna|ubs|credit-suisse|postfinance|raiffeisen|zkb|neon|yuh)\.[a-z.]+$/i;
const BLOCKED_PATHS = /\/(signin\/recovery|password\/reset|account-recovery|checkout|payment)\b/i;

let ctx = null, page = null, lastList = [];

const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const blocked = (url) => {
  let u; try { u = new URL(url); } catch { return false; }
  return BLOCKED_HOSTS.test(u.hostname) || BLOCKED_PATHS.test(u.pathname);
};

async function browser() {
  if (ctx) return ctx;
  fs.mkdirSync(PROFILE, { recursive: true });
  ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: 'chrome',
    headless: HEADLESS,
    viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
  ctx.setDefaultTimeout(15_000);
  ctx.on('close', () => { ctx = null; page = null; });
  page = ctx.pages()[0] || (await ctx.newPage());
  return ctx;
}

async function current() {
  await browser();
  if (!page || page.isClosed()) page = ctx.pages().at(-1) || (await ctx.newPage());
  return page;
}

/** Close the window and forget everything — used when you tell him to stop browsing. */
export async function shutdown() {
  try { await ctx?.close(); } catch {}
  ctx = null; page = null; lastList = [];
}

export const state = () => ({ open: !!ctx, url: page && !page.isClosed() ? page.url() : null, headless: HEADLESS });

/** The readable text of the page, trimmed to something a voice model can digest. */
async function readPage(p, limit = 4000) {
  const txt = await p.evaluate(() => {
    const pick = document.querySelector('main, article, [role="main"]') || document.body;
    return (pick?.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
  });
  return txt.length > limit ? txt.slice(0, limit) + `\n… (${txt.length - limit} more characters)` : txt;
}

/** Everything on the page he could click or fill, numbered so he can say "click 3". */
async function listParts(p) {
  const parts = await p.evaluate(() => {
    const seen = [], out = [];
    const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 2 && r.height > 2; };
    for (const el of document.querySelectorAll('a[href], button, input, textarea, select, [role="button"], [role="link"], [role="textbox"]')) {
      if (!visible(el) || seen.includes(el)) continue;
      seen.push(el);
      const tag = el.tagName.toLowerCase();
      const kind = tag === 'a' ? 'link' : tag === 'input' ? (el.type || 'text') : tag;
      const label = (el.getAttribute('aria-label') || el.placeholder || el.innerText || el.value || el.name || el.title || '').trim().replace(/\s+/g, ' ').slice(0, 70);
      if (!label && kind === 'link') continue;
      out.push({ kind, label, href: tag === 'a' ? el.href : undefined });
      if (out.length > 60) break;
    }
    return out;
  });
  lastList = parts;
  return parts.map((x, i) => `${i + 1}. [${x.kind}] ${x.label}${x.href ? ' → ' + x.href.slice(0, 60) : ''}`).join('\n');
}

/** Find something by what it's called — or by the number from the last list. */
async function locate(p, target, forInput = false) {
  const n = Number(target);
  if (Number.isInteger(n) && lastList[n - 1]?.label) target = lastList[n - 1].label;
  const t = String(target);
  const safe = t.replace(/["\\]/g, '');
  const ways = forInput ? [
    () => p.getByPlaceholder(t, { exact: false }),
    () => p.getByRole('textbox', { name: t, exact: false }),
    () => p.getByRole('searchbox', { name: t, exact: false }),
    () => p.getByLabel(t, { exact: false }),
    () => p.locator(`input[name*="${safe}" i], input[id*="${safe}" i], input[aria-label*="${safe}" i], textarea[name*="${safe}" i]`),
    () => p.locator('input:not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea, [contenteditable=true]'),
    () => p.locator(t),
  ] : [
    () => p.getByRole('button', { name: t, exact: false }),
    () => p.getByRole('link', { name: t, exact: false }),
    () => p.getByLabel(t, { exact: false }),
    () => p.getByPlaceholder(t, { exact: false }),
    () => p.getByText(t, { exact: false }),
    () => p.locator(t),
  ];
  for (const make of ways) {
    try {
      const all = make();
      const n = Math.min(await all.count(), 5);
      for (let i = 0; i < n; i++) {
        const loc = all.nth(i);
        if (!await loc.isVisible().catch(() => false)) continue;
        if (forInput && !await loc.isEditable().catch(() => false)) continue;   // skip labels and wrappers
        return loc;
      }
    } catch {}
  }
  throw new Error(`Couldn't find "${target}" on the page. Ask for the list of parts first.`);
}

/**
 * One step of browsing. Returns a short sentence or the page text — never anything secret.
 *   go <url> · read · parts · click <what> · type <what>=<text> · press <key> · scroll · back · close
 */
export async function act({ action, target, text, enter }) {
  const p = await current();
  switch (action) {
    case 'go': {
      let url = String(target || '').trim();
      if (!/^https?:\/\//i.test(url)) url = 'https://' + url.replace(/^\/+/, '');
      if (blocked(url)) throw new Error("That's a banking or account-recovery site — Mark doesn't drive those. Do that one yourself.");
      await p.goto(url, { waitUntil: 'domcontentloaded' });
      await p.waitForTimeout(600);
      return `${await p.title()} — ${p.url()}\n\n${await readPage(p, 2500)}`;
    }
    case 'read': return await readPage(p);
    case 'parts': return (await listParts(p)) || 'Nothing clickable found.';
    case 'click': {
      const loc = await locate(p, target);
      await loc.scrollIntoViewIfNeeded().catch(() => {});
      await loc.click({ timeout: 8000 });
      await p.waitForLoadState('domcontentloaded').catch(() => {});
      await p.waitForTimeout(700);
      if (blocked(p.url())) { await p.goBack().catch(() => {}); throw new Error('That went to a banking site, so I backed out.'); }
      return `Clicked "${target}". Now on ${p.url()}\n\n${await readPage(p, 2000)}`;
    }
    case 'type': {
      const loc = await locate(p, target, true);
      const secret = await loc.evaluate((el) => {                   // a password box, however it was found
        const i = el.tagName === 'INPUT' ? el : el.querySelector?.('input') || el.closest?.('label')?.querySelector('input');
        return i?.type === 'password' || /pass/i.test(i?.name || i?.id || '');
      }).catch(() => /pass/i.test(String(target)));
      if (secret) throw new Error("That's the password box. Don't type it yourself — call browser_login with the name of the saved login and it will be filled in for you. This is not a refusal; it's how you sign the user in.");
      await loc.fill(String(text ?? ''));
      if (enter) { await loc.press('Enter'); await p.waitForLoadState('domcontentloaded').catch(() => {}); await p.waitForTimeout(800); }
      return enter ? `Typed it and pressed enter. Now on ${p.url()}\n\n${await readPage(p, 2000)}` : `Typed into "${target}".`;
    }
    case 'press': await p.keyboard.press(String(target || 'Enter')); await p.waitForTimeout(500); return `Pressed ${target}.`;
    case 'scroll': await p.mouse.wheel(0, 900); await p.waitForTimeout(300); return await readPage(p, 2500);
    case 'back': await p.goBack().catch(() => {}); await p.waitForTimeout(500); return `Back on ${p.url()}\n\n${await readPage(p, 2000)}`;
    case 'close': await shutdown(); return 'Closed the browser.';
    default: throw new Error(`Unknown browsing step "${action}".`);
  }
}

/**
 * Type a saved login into the page he's on. The secret comes straight from the vault into the
 * keyboard — it never passes through the model. server.js only calls this after you've approved.
 */
export async function fillLogin({ username, password, otp }) {
  const p = await current();
  const pageHost = host(p.url());
  if (!pageHost) throw new Error("He isn't on a website yet.");

  const first = async (sels) => {
    for (const s of sels) {
      const loc = p.locator(s).first();
      if (await loc.count() && await loc.isVisible().catch(() => false)) return loc;
    }
    return null;
  };
  const done = [];
  if (otp) {
    const code = await first(['input[autocomplete="one-time-code"]', 'input[name*="otp" i]', 'input[name*="code" i]', 'input[id*="otp" i]', 'input[inputmode="numeric"]']);
    if (code) { await code.fill(otp); done.push('the code'); }
  }
  if (!done.length) {
    const user = await first(['input[autocomplete="username"]', 'input[type="email"]', 'input[name*="user" i]', 'input[name*="email" i]', 'input[id*="user" i]']);
    if (user && username) { await user.fill(username); done.push('your username'); }
    const pass = await first(['input[type="password"]', 'input[autocomplete="current-password"]']);
    if (pass && password) { await pass.fill(password); done.push('the password'); }
  }
  if (!done.length) throw new Error(`No login boxes found on ${pageHost}.`);
  return `Filled ${done.join(' and ')} on ${pageHost}. Say "click sign in" when you want me to submit it.`;
}

/** The site he's currently on — server.js checks this matches the saved login before filling. */
export const currentHost = async () => host((await current()).url());
