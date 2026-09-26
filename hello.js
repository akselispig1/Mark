// Windows Hello (face / fingerprint / PIN) via WebAuthn: the same tech Windows and passkeys use.
// Your face never leaves Windows; we only ever get a cryptographic "yes, it was really them" signature.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} from '@simplewebauthn/server';

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'hello.json');
let db = { userId: crypto.randomBytes(16).toString('base64url'), creds: [] };
try { db = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
const save = () => fs.writeFileSync(FILE, JSON.stringify(db, null, 1));
const challenges = new Map();        // key -> { challenge, expires }
const remember = (k, challenge) => challenges.set(k, { challenge, expires: Date.now() + 120_000 });
function takeChallenge(k) {
  const c = challenges.get(k); challenges.delete(k);
  if (!c || c.expires < Date.now()) throw new Error('That request expired. Try again.');
  return c.challenge;
}

export const enrolled = (rpID) => db.creds.some((c) => c.rpID === rpID);
export const anyEnrolled = () => db.creds.length > 0;
export const phoneEnrolled = () => db.creds.some((c) => !['localhost', '127.0.0.1'].includes(c.rpID));

export async function registrationOptions(rpID) {
  const opts = await generateRegistrationOptions({
    rpName: 'MARK', rpID, userName: 'owner', userDisplayName: 'Mark owner',
    userID: Buffer.from(db.userId, 'base64url'),
    attestationType: 'none',
    excludeCredentials: db.creds.filter((c) => c.rpID === rpID).map((c) => ({ id: c.id, transports: c.transports })),
    authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
  });
  remember(`reg:${rpID}`, opts.challenge);
  return opts;
}

export async function register(rpID, origin, response) {
  const v = await verifyRegistrationResponse({
    response, expectedChallenge: takeChallenge(`reg:${rpID}`), expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true,
  });
  if (!v.verified) throw new Error('Windows Hello setup could not be verified.');
  const { credential } = v.registrationInfo;
  db.creds.push({ id: credential.id, publicKey: Buffer.from(credential.publicKey).toString('base64'), counter: credential.counter, transports: credential.transports, rpID, added: new Date().toISOString() });
  save();
}

export async function authOptions(rpID, key) {
  const opts = await generateAuthenticationOptions({
    rpID, userVerification: 'required',
    allowCredentials: db.creds.filter((c) => c.rpID === rpID).map((c) => ({ id: c.id, transports: c.transports })),
  });
  remember(`auth:${key}`, opts.challenge);
  return opts;
}

/** True only if Windows Hello confirmed the user (face/fingerprint/PIN) for this exact request. */
export async function verify(rpID, origin, key, response) {
  const cred = db.creds.find((c) => c.id === response?.id && c.rpID === rpID);
  if (!cred) throw new Error('Unknown Windows Hello key.');
  const v = await verifyAuthenticationResponse({
    response, expectedChallenge: takeChallenge(`auth:${key}`), expectedOrigin: origin, expectedRPID: rpID,
    requireUserVerification: true,
    credential: { id: cred.id, publicKey: Buffer.from(cred.publicKey, 'base64'), counter: cred.counter, transports: cred.transports },
  });
  if (!v.verified) return false;
  cred.counter = v.authenticationInfo.newCounter; save();
  return true;
}
