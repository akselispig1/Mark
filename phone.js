// Outbound phone calls via Twilio. Twilio's ConversationRelay does speech-to-text and
// text-to-speech on the call and streams text to our /relay websocket.
import { ring } from './push.js';

const env = (k) => process.env[k];

// PUBLIC_URL may be filled in at startup by the tunnel, so it isn't required here.
export function phoneConfigured() {
  return ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM', 'MY_PHONE', 'RELAY_SECRET'].every(env);
}

export function twiml(greeting) {
  const wss = env('PUBLIC_URL').replace(/^http/, 'ws') + '/relay/' + env('RELAY_SECRET');
  const esc = (s) => s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <ConversationRelay url="${esc(wss)}" welcomeGreeting="${esc(greeting)}"
      language="en-GB"${env('JARVIS_TTS_PROVIDER') ? ` ttsProvider="${esc(env('JARVIS_TTS_PROVIDER'))}"` : ''}${env('JARVIS_PHONE_VOICE') ? ` voice="${esc(env('JARVIS_PHONE_VOICE'))}"` : ''}
      interruptible="true" />
  </Connect>
</Response>`;
}

export const telegramConfigured = () => !!(env('TELEGRAM_API_ID') && env('TELEGRAM_API_HASH'));

/** Call the user: free Telegram call if set up, else Twilio (paid), else the free push "call". */
export async function placeCall(reason = 'You rang? Actually, I rang.') {
  if (telegramConfigured()) {
    const res = await fetch(`http://127.0.0.1:${env('TELEGRAM_CONTROL_PORT') || 7778}/call`, {
      method: 'POST', body: JSON.stringify({ greeting: reason }),
    }).catch(() => null);
    if (res?.ok) return 'telegram';
    console.error('Telegram caller not reachable, falling back');
  }
  if (!phoneConfigured()) return ring(reason);
  if (!env('PUBLIC_URL')) throw new Error('No public address yet (tunnel still starting?)');
  const sid = env('TWILIO_ACCOUNT_SID');
  const body = new URLSearchParams({ To: env('MY_PHONE'), From: env('TWILIO_FROM'), Twiml: twiml(reason) });
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls.json`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${env('TWILIO_AUTH_TOKEN')}`).toString('base64') },
    body,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || `Twilio error ${res.status}`);
  return data.sid;
}
