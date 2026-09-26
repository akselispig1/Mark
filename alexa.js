// Mark as an Alexa skill: "Alexa, open Mark" and then talk to him through the Echo.
// Amazon signs every request; we check that signature, the skill id and the timestamp before answering.
import verifierPkg from 'alexa-verifier';

const verifier = verifierPkg.default || verifierPkg;
const SKILL_ID = () => process.env.ALEXA_SKILL_ID || '';
const VOICE = () => process.env.ALEXA_VOICE || '';          // e.g. "Brian" for a British male voice

export const configured = () => !!SKILL_ID();

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const speech = (text) => {
  const body = VOICE() ? `<voice name="${xml(VOICE())}">${xml(text)}</voice>` : xml(text);
  return { type: 'SSML', ssml: `<speak>${body}</speak>` };
};
const reply = (text, { end = false, reprompt = 'Still here, sir.' } = {}) => ({
  version: '1.0',
  response: {
    outputSpeech: speech(text),
    ...(end ? {} : { reprompt: { outputSpeech: speech(reprompt) } }),
    shouldEndSession: end,
  },
});

/** Throws unless this really came from Amazon, for our skill, just now. */
export async function verifyRequest(headers, rawBody) {
  const certUrl = headers['signaturecertchainurl'], signature = headers['signature-256'] || headers['signature'];
  if (!certUrl || !signature) throw new Error('Unsigned request.');
  await new Promise((ok, no) => verifier(certUrl, signature, rawBody, (err) => (err ? no(new Error(err)) : ok())));
  const body = JSON.parse(rawBody);
  const appId = body?.context?.System?.application?.applicationId || body?.session?.application?.applicationId;
  if (SKILL_ID() && appId !== SKILL_ID()) throw new Error('Request for a different skill.');
  const age = Math.abs(Date.now() - new Date(body?.request?.timestamp).getTime());
  if (!(age < 150_000)) throw new Error('Stale request.');
  return body;
}

/** Tell the Echo "one moment" while Mark is still thinking (Alexa cuts us off after ~8 s otherwise). */
async function holdOn(body, text = 'One moment, sir.') {
  const api = body?.context?.System?.apiEndpoint, token = body?.context?.System?.apiAccessToken;
  const requestId = body?.request?.requestId;
  if (!api || !token || !requestId) return;
  await fetch(`${api}/v1/directives`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ header: { requestId }, directive: { type: 'VoicePlayer.Speak', speech: speech(text).ssml } }),
    signal: AbortSignal.timeout(2000),
  }).catch(() => {});
}

/**
 * Turn an Alexa request into an Alexa response.
 * `ask(text)` runs it past Mark's brain and resolves with what he said.
 */
export async function handle(body, ask) {
  const type = body?.request?.type;
  if (type === 'LaunchRequest') return reply('Mark online, sir. What can I do?', { reprompt: 'Still here, sir.' });
  if (type === 'SessionEndedRequest') return { version: '1.0', response: {} };

  if (type === 'IntentRequest') {
    const intent = body.request.intent?.name;
    if (intent === 'AMAZON.StopIntent' || intent === 'AMAZON.CancelIntent') return reply('Very good, sir.', { end: true });
    if (intent === 'AMAZON.HelpIntent') return reply('Just talk to me normally. Ask about your computer, the weather, your schedule, or anything else.');

    const slots = body.request.intent?.slots || {};
    const said = Object.values(slots).map((s) => s?.value).filter(Boolean).join(' ').trim();
    if (!said) return reply("I didn't catch that, sir. Say it again?");

    // Alexa hangs up at about 8 seconds, so tell the Echo to stutter politely if he's slow.
    const slow = setTimeout(() => holdOn(body), 1800);
    let answer = '';
    try { answer = await ask(said); } finally { clearTimeout(slow); }
    if (!answer) return reply("That one's taking a while, sir. Ask me again in a moment and I'll have it.");
    return reply(answer);
  }
  return reply('I only do conversation here, sir.', { end: true });
}
