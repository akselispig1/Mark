// Finds login/verification codes in recent Gmail messages (IMAP + Google app password).
// Only looks at the last few minutes of mail from the site you're logging into, and only returns the code.
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

/** "accounts.netflix.com" -> "netflix.com", "login.post.ch" -> "post.ch", "www.bbc.co.uk" -> "bbc.co.uk" */
export function baseDomain(host) {
  const parts = String(host).toLowerCase().replace(/^\.+|\.+$/g, '').split('.');
  if (parts.length <= 2) return parts.join('.');
  const second = parts[parts.length - 2];
  const threeLabel = parts[parts.length - 1].length === 2 && ['co', 'com', 'org', 'net', 'ac', 'gov', 'edu'].includes(second);
  return parts.slice(threeLabel ? -3 : -2).join('.');
}

const KEYWORD = /(code|verif|one[- ]?time|passcode|otp|\bpin\b|security|sign[- ]?in|log[- ]?in|confirm|authenticat|bestätig|bestaetig|sicherheits|anmelde|einmal|código|codice|vérification)/i;

/** Picks the most likely login code out of an email. Returns null if nothing convincing. */
export function extractCode(subject = '', text = '') {
  const body = `${subject}\n${text}`.replace(/https?:\/\/\S+/g, ' ').replace(/[ \t]+/g, ' ');
  const found = [];
  // "123 456" / "123-456" are shown split for readability: join them.
  for (const m of body.matchAll(/(?<![\w-])(\d{3})[ -](\d{3})(?![\w-])/g)) found.push({ code: m[1] + m[2], at: m.index, split: true });
  // A code may follow a letter-dash prefix, e.g. Google's "G-558421".
  for (const m of body.matchAll(/(?<!\w)-?([0-9]{4,8}|(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{5,8})(?![\w-])/g)) found.push({ code: m[1], at: m.index });
  let best = null;
  for (const f of found) {
    const near = body.slice(Math.max(0, f.at - 90), f.at + f.code.length + 40);
    const justBefore = body.slice(Math.max(0, f.at - 35), f.at);
    let score = 0;
    if (KEYWORD.test(near)) score += 4;
    if (KEYWORD.test(justBefore)) score += 2;                         // "your code is 123456"
    if (/^\d+$/.test(f.code)) score += 2;
    if (f.code.length === 6) score += 2;
    if (/^(19|20)\d\d$/.test(f.code)) score -= 6;                     // looks like a year
    // A phone number nearby (a support line) is not a code, unless a code word sits right before it.
    if (!KEYWORD.test(justBefore) && /(\+\d|\b0[1-9]\d{2}\b|call us|phone|tel[.:]|hotline)/i.test(near)) score -= 4;
    // Reference/order/ticket numbers look like codes but are not.
    if (/(reference|ref\.|ticket|order|invoice|account number|case|receipt)\s*#?:?\s*$/i.test(justBefore)) score -= 6;
    if (f.at < subject.length + 1) score += 1;                          // codes in the subject are usually the real one
    if (!best || score > best.score) best = { ...f, score };
  }
  return best && best.score >= 4 ? best.code : null;
}

/**
 * Wait for a code email from the site's domain. Resolves { code, from, subject, received } or null on timeout.
 * Nothing but the code (and who sent it) leaves this function.
 */
export async function findCode({ user, pass, host, sinceMs = 10 * 60_000, waitMs = 60_000, imapHost = 'imap.gmail.com' }) {
  const domain = baseDomain(host);
  const brand = domain.split('.')[0];
  const deadline = Date.now() + waitMs;
  const since = Date.now() - sinceMs;
  const client = new ImapFlow({ host: imapHost, port: 993, secure: true, auth: { user, pass }, logger: false, connectionTimeout: 15_000 });
  await client.connect();
  try {
    while (true) {
      const lock = await client.getMailboxLock('INBOX');
      let hit = null;
      try {
        const uids = (await client.search({ since: new Date(since - 24 * 3600_000) }, { uid: true })) || [];
        const recent = uids.slice(-25);                                  // newest few only
        const candidates = [];
        if (recent.length) {
          for await (const msg of client.fetch(recent, { envelope: true, internalDate: true, source: true }, { uid: true })) {
            if (new Date(msg.internalDate).getTime() < since) continue;
            const from = msg.envelope?.from?.[0] || {};
            const fromDomain = String(from.address || '').split('@')[1] || '';
            const subject = msg.envelope?.subject || '';
            const fromSite = baseDomain(fromDomain) === domain || fromDomain.endsWith(`.${domain}`);
            const mentionsSite = new RegExp(`\\b${brand}\\b`, 'i').test(`${from.name || ''} ${subject}`);
            if (!fromSite && !mentionsSite) continue;
            candidates.push({ msg, from: from.name || from.address, subject });
          }
        }
        for (const c of candidates.sort((a, b) => new Date(b.msg.internalDate) - new Date(a.msg.internalDate))) {
          const parsed = await simpleParser(c.msg.source);
          const code = extractCode(c.subject, parsed.text || String(parsed.html || '').replace(/<[^>]+>/g, ' '));
          if (code) { hit = { code, from: c.from, subject: c.subject, received: c.msg.internalDate }; break; }
        }
      } finally { lock.release(); }
      if (hit) return hit;
      if (Date.now() > deadline) return null;
      await new Promise((r) => setTimeout(r, 4000));                   // email not here yet: check again shortly
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

/** Checks the Gmail login works (used when connecting). */
export async function testLogin({ user, pass, imapHost = 'imap.gmail.com' }) {
  const client = new ImapFlow({ host: imapHost, port: 993, secure: true, auth: { user, pass }, logger: false, connectionTimeout: 15_000 });
  try { await client.connect(); await client.logout(); }
  catch (e) {
    if (e.authenticationFailed || /auth/i.test(e.responseText || e.message)) throw new Error('Gmail rejected that address or app password.');
    throw new Error(`Couldn't reach Gmail: ${e.message}`);
  }
}
