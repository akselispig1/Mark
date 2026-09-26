// Mark Autofill: keeps a connection to Mark, tells him which site you're on, opens the Windows Hello
// approval window, and types the login into the page after you approve. Passwords arrive only after
// approval, are used once, and are never stored here.
const DEFAULT_URL = 'http://localhost:7777';
let ws = null, approvalWindows = new Map();

async function settings() {
  const s = await chrome.storage.local.get(['url', 'token']);
  return { url: s.url || DEFAULT_URL, token: s.token || '' };
}

async function connect() {
  if (ws && ws.readyState <= 1) return;
  const { url, token } = await settings();
  if (!token) return setStatus('not linked');
  try { ws = new WebSocket(url.replace(/^http/, 'ws') + '/autofill'); } catch { return setStatus('offline'); }
  ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', token }));
  ws.onclose = () => { ws = null; setStatus('offline'); };
  ws.onerror = () => {};
  ws.onmessage = (e) => handle(JSON.parse(e.data)).catch((err) => reply({ type: 'error', id: undefined, error: String(err) }));
}
const reply = (o) => ws?.readyState === 1 && ws.send(JSON.stringify(o));
function setStatus(s) { chrome.storage.local.set({ status: s }); chrome.action.setBadgeText({ text: s === 'connected' ? '' : '!' }); chrome.action.setBadgeBackgroundColor({ color: '#b8860b' }); }

async function handle(m) {
  if (m.type === 'welcome') return setStatus('connected');
  if (m.type === 'denied') { setStatus('link code rejected'); return ws.close(); }
  if (m.type === 'ping') return reply({ type: 'pong' });

  if (m.type === 'tab?') {                      // which site are you on? (hostname only)
    // The browser window you last used (not the orb's app window or the approval popup).
    const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
    const [tab] = win ? await chrome.tabs.query({ active: true, windowId: win.id }) : [];
    let host = '';
    try { host = new URL(tab.url).hostname; } catch {}
    return reply({ type: 'tab', id: m.id, tabId: tab?.id, host, title: tab?.title || '' });
  }

  if (m.type === 'approve') {                   // open the Windows Hello approval window
    const { url } = await settings();
    const w = await chrome.windows.create({ url: `${url}/approve.html?id=${encodeURIComponent(m.id)}`, type: 'popup', width: 440, height: 520, focused: true });
    approvalWindows.set(m.id, w.id);
    return;
  }
  if (m.type === 'approval_done') {
    const wid = approvalWindows.get(m.id); approvalWindows.delete(m.id);
    if (wid) chrome.windows.remove(wid).catch(() => {});
    return;
  }

  if (m.type === 'fill') {                      // approved: type it in, only if the tab is still on that site
    const tab = await chrome.tabs.get(m.tabId).catch(() => null);
    let host = '';
    try { host = new URL(tab.url).hostname; } catch {}
    if (!tab || host !== m.host) return reply({ type: 'filled', id: m.id, ok: false, why: 'The tab changed site before filling.' });
    const [res] = await chrome.scripting.executeScript({ target: { tabId: m.tabId, allFrames: false }, func: fillPage, args: [m.username || '', m.password || '', m.otp || ''] });
    await chrome.tabs.update(m.tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    return reply({ type: 'filled', id: m.id, ok: !!res?.result?.ok, why: res?.result?.why || '' });
  }
}

// Runs inside the web page: finds the login fields and fills them like a person typing would.
function fillPage(username, password, otp) {
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && !el.disabled && !el.readOnly; };
  const set = (el, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    el.focus(); setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const inputs = [...document.querySelectorAll('input')].filter(visible);
  const pw = inputs.find((i) => i.type === 'password');
  const label = (i) => `${i.name} ${i.id} ${i.autocomplete} ${i.placeholder} ${i.getAttribute('aria-label') || ''}`;
  const texty = (i) => ['email', 'text', 'tel'].includes(i.type) && !/search|query|^q$/i.test(label(i).trim());
  // Username box: marked as one, else the text box just before the password (same form first), else anything that looks like it.
  const before = pw ? inputs.slice(0, inputs.indexOf(pw)).filter(texty) : [];
  let user = inputs.find((i) => i.autocomplete === 'username')
    || [...before].reverse().find((i) => i.form && i.form === pw.form) || before[before.length - 1]
    || inputs.find((i) => texty(i) && /user|mail|login|account|phone|e-?mail|id/i.test(label(i)));
  // 2FA code boxes: one box marked as a code, or a row of single-digit boxes.
  const codeBox = inputs.find((i) => i.autocomplete === 'one-time-code' || /otp|one.?time|2fa|totp|mfa|verification|security.?code|auth.*code|^code$|pin/i.test(label(i).trim()));
  const digitBoxes = inputs.filter((i) => i.maxLength === 1 && ['text', 'tel', 'number', ''].includes(i.type));
  if (!pw && otp && (codeBox || digitBoxes.length >= 4)) {
    if (digitBoxes.length >= 4 && (!codeBox || digitBoxes.includes(codeBox))) digitBoxes.slice(0, otp.length).forEach((b, i) => set(b, otp[i]));
    else set(codeBox, otp);
    return { ok: true, why: 'Entered the 2FA code.' };
  }
  if (!pw && !user) return { ok: false, why: otp ? "I couldn't find a login or code box on this page." : "I couldn't find a login form on this page." };
  if (user && username) set(user, username);
  if (pw) set(pw, password);
  else return { ok: true, why: 'Only the username box was on this page. Press Next, then ask again for the password.' };
  return { ok: true };
}

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(() => { chrome.alarms.create('reconnect', { periodInMinutes: 1 }); connect(); });
chrome.alarms.onAlarm.addListener(connect);
chrome.storage.onChanged.addListener((c) => { if (c.token || c.url) { ws?.close(); ws = null; connect(); } });
connect();
