# Mark

A voice assistant that runs on your own machine. A glowing orb you talk to: he has shell and file
access, his own browser, your passwords (which he can use but never see), permanent memory, alarms,
and he can ring your phone. His brain is the Claude Agent SDK, so he also gets web search.

He only answers *your* voice, and anything involving a password asks for your face or fingerprint.

## Get it running

```
npm install
npm run setup          # downloads the voice + hand models, ~93 MB, not kept in the repo
```

Then put your own Claude token in `.env`, on the `CLAUDE_CODE_OAUTH_TOKEN=` line. Get one with:

```
claude setup-token
```

```
npm start              # then open http://localhost:7777 in Chrome or Edge
npm run doctor         # says what is working and what still needs setting up
```

Say "Mark, ..." or click the orb (or press Space) and talk. You can also type in the line at the
bottom. Needs Node 20 or newer.

## Your data stays yours

Everything personal — your vault, your voiceprint, his memory of you, every conversation, his browser
profile — is created on first use and lives in `data/`. That folder is never committed and never
leaves your machine, so two people running this share the code and nothing else.

Updates can't touch it either: before any change to a file format, the whole folder is copied to
`data/backups/` first.

He talks using `claude-haiku-4-5` and does background work with `claude-opus-5`, on **your** Claude
login, billed to your own account.

## On a server instead

Everything works on a Linux box too — see [deploy/aws.md](deploy/aws.md). His browser goes headless
automatically, and the PC-only bits (clipboard, volume, opening apps) politely say so instead of
breaking. Set `HOST=0.0.0.0` and `PUBLIC_URL` and the rest is the same.

## Free real calls: Telegram (recommended)
Mark rings you as a normal Telegram call (full-screen, on the lock screen) and talks to you. It's free. Your speech is transcribed locally with Whisper; his voice is the same neural voice.
1. Give Mark his own Telegram account. That needs a second phone number (a spare SIM, for example).
2. Signed in as Mark, go to https://my.telegram.org, open API development tools and create an app. Copy the api_id and api_hash.
3. Add to `.env`:
   ```
   TELEGRAM_API_ID=...
   TELEGRAM_API_HASH=...
   TELEGRAM_CALL_USER=@your_telegram_username
   ```
4. Log Mark in once. You type his number and the code Telegram sends:
   ```
   telegram\.venv\Scripts\python telegram\caller.py login
   ```
5. Run `npm start`. Pressing the phone button, or saying "Mark, call me", now rings your Telegram.
Tip: message Mark's account once from your own Telegram so your privacy settings don't block his calls.

## Hand control
Click the hand (top right) to turn on the camera. Hold up middle, ring and pinky, pinch thumb and index, then spread them to zoom in or close them to zoom out. Tracking runs locally in the browser.

## Free phone calls (default)
Mark rings your phone with a notification. Tap it and the orb opens as a live voice call. No phone bill,
no accounts, nothing to install.

1. On the PC orb, click the **QR button** (bottom left). Mark opens a free public link to himself
   (a Cloudflare quick tunnel) and shows a code.
2. **Scan it with your phone.** That link carries the pairing key, so your phone gets in and nobody else does.
3. On the phone: Share → **Add to Home Screen** (iPhone needs this for notifications), open it from there,
   and tap the **bell** (bottom left).

Now "Mark, call me when that's done", the phone button, or any alarm will ring your phone.

Without the pairing key that public address returns nothing at all — not a login page, nothing.

**The link changes every restart**, so you'd have to re-pair. Fine for trying it out. For an address that
stays put, either install [Tailscale](https://tailscale.com/download) on both devices, run
`tailscale serve --bg 7777`, and set `JARVIS_URL=https://your-pc.tailXXXX.ts.net` in `.env` — or put him
on AWS, where he has a permanent address (see [deploy/aws.md](deploy/aws.md)). A stable address also matters
for approving passwords from your phone with Face ID, since a passkey is tied to the address it was made on.

## Real phone calls (optional, Twilio)
Twilio's free trial gives about $15 of credit, which is roughly 50 minutes of calls to a Swiss mobile. Trial calls start with a short "trial account" message and only reach verified numbers (your own).
1. Sign up at twilio.com with your own mobile as the verified number, and get a Twilio phone number (paid from the trial credit).
2. In the Twilio console, open Voice, then Settings, then Geo permissions, and enable **Switzerland**.
3. Put `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TWILIO_FROM` in `.env`. `MY_PHONE` and `RELAY_SECRET` are already there.
4. Run `npm start`. Mark opens a free Cloudflare tunnel by himself, so Twilio can reach him, and the phone button now makes real calls.

The tunnel only exposes the secret `/relay/<RELAY_SECRET>` phone line. The orb is still PC-only or for paired devices.

## AWS
See [deploy/aws.md](deploy/aws.md). It's ready to go and nothing has been created yet.

## Passwords + autofill with Windows Hello
1. Click the key (top left of the orb) and create your vault with a master password.
2. In the vault, press **Set up Windows Hello** and confirm with your face, fingerprint or PIN.
3. Install the browser extension: open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick the `jarvis\extension` folder (the folder on disk is still named jarvis).
4. In the vault, press **Get link code**, then click the Mark Autofill icon in Chrome, paste the code and press **Link**.
5. Open a login page and say "Mark, log me in". A Windows Hello prompt appears; approve it and the login gets typed in.
Mark never sees the password. It only gets filled on the site the login is saved for (add the website to each login).

### Opening it with your face instead of the master password
Once Windows Hello is set up, turn on **Open the vault with it** in the same Security section. After that your
face, fingerprint or PIN opens the vault — no master password, even after a restart.

The vault key is wrapped with a secret that this PC's security chip only produces after Hello says it is you,
and only for this site (WebAuthn PRF). The wrapped copy is all that is on disk, so a stolen vault file is still
worthless. **Keep your master password somewhere safe** — it remains the way back in if you change PC, reinstall
Windows or remove your Hello sign-in, and some machines have no PRF support at all.

Two things catch people out:
- **The vault locks every time Mark restarts**, on purpose — the key only ever lives in memory, so there's
  nothing on disk to steal. Ask him for a password while it's locked and the vault window now opens by
  itself; type your master password and ask again.
- **Autofill refuses to work until Windows Hello is set up.** Your voice alone never unlocks a password,
  by design, so without Hello there's no way to prove it's you and he declines. It's one button in the vault.
- A login with no website saved will be filled on *any* page, which throws away the fake-site protection.
  Check the imported ones have their site set.

## Only answer to your voice (off)

Mark can be taught to recognise one voice and ignore everyone else. It is **switched off**: it needs a
second microphone stream, which competes with the browser for the microphone and made him go deaf more
often than it kept anyone out.

The code is still here (`public/voiceid*.js`). To switch it back on: `npm run setup -- --voice` to fetch
the model, then restore the module block in `public/index.html` from the git history before commit
`REMOVED`. Your old voiceprint is untouched in `data/`.

None of this was ever the security. Passwords have always been gated by Windows Hello, which is unchanged.

## Mark's own browser
He has a Chrome of his own, with its own profile in `data\browser` — separate from yours, with its own
cookies and logins. Nothing to set up; it opens the first time he needs it. On the PC you see the window
and can take over in it; on the server it runs invisibly.

Say things like "look up X and read me the top result", "check my order status on that site", "fill in
that form". Behind the scenes he uses one `browse` tool: go, read, parts, click, type, scroll, back, close.

Two things he can't do there:
- **Type a password.** Password boxes are refused. Logins go through `browser_login`, which takes the
  password from the vault straight into the keyboard, only on the site that login is saved for, and only
  after you approve with your face, fingerprint or PIN. He never sees it.
- **Banking and checkout.** Banks, payment sites, and any `/checkout`, `/payment` or account-recovery
  page are blocked outright, including if a link tries to take him there.

Set `JARVIS_BROWSER_HEADLESS=1` in `.env` to hide the window on the PC too.

## Knowing your things
No setup for any of these.

**What you are looking at.** `whats_open` sees your open windows and which one is in front, so "what is
this?" and "summarise that page" work without you explaining. He reads window titles only, never the
screen itself.

**Your documents.** `find_file` searches Desktop, Documents, Downloads, Pictures and OneDrive by name;
`read_document` reads what is actually inside a PDF, Word file, spreadsheet, CSV or text file. Ask him
"what did the insurance letter say about excess?" and he will find it, read it and answer.

**Every conversation, searchable.** Everything said is written to `data/transcript/YYYY-MM-DD.jsonl`, and
`recall` searches it. "What did I tell you about the car?" now has a real answer instead of a guess,
months later and across restarts. Plain text you can read or delete yourself; delete the folder to wipe it.

## Real Google Docs

Ask for a document — "Mark, make me a doc of tonight's revision plan" — and he creates an actual
Google Doc in your Drive and gives you the link. Also `doc_append`, `doc_read` and `drive_find`.

Google ties API access to a project that belongs to you, so this bit can't be done for you. It's about
ten clicks, once:

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and make a project (any name).
2. **APIs & Services → Library**: enable **Google Docs API** and **Google Drive API**.
3. **APIs & Services → OAuth consent screen**: External, fill in the app name and your email, and add
   yourself under **Test users**. You don't need to publish it.
4. **Credentials → Create credentials → OAuth client ID → Web application**.
   Under *Authorised redirect URIs* add exactly:
   ```
   http://localhost:7777/google/callback
   ```
5. Copy the client ID and secret into `.env`:
   ```
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   ```
6. Restart Mark, open <http://localhost:7777/google/connect>, and approve. That's it — he tells you
   when it's done.

He only ever gets the `drive.file` scope, which means **the files he creates and nothing else**. He
cannot see the rest of your Drive. The sign-in token is kept in `data/google.json`, same standing as
your Claude token in `.env`, and never leaves the machine. Say "disconnect Google" to revoke it, or
remove the app at [myaccount.google.com/permissions](https://myaccount.google.com/permissions).

On a server, set `PUBLIC_URL` and add that address's `/google/callback` to the same list in step 4.

## Codes emailed to you (Gmail)
1. Turn on 2-Step Verification for your Google account, then make an app password at myaccount.google.com/apppasswords (name it "Mark").
2. Vault screen -> **Connect Gmail** -> your Gmail address + that 16-character app password.
3. When a site emails a login code, say "Mark, enter the code". He waits for the email, takes the code and types it in.
He only reads mail from the site you're signing in to, from the last 10 minutes, and only extracts the code. Revoke access anytime by deleting the app password in your Google account.

## Talk to Mark through your Alexa
You say "Alexa, open Mark", then talk to him normally: "what's the weather", "how full is my drive",
"set an alarm for seven". Say "stop" to end. Amazon does not allow replacing the "Alexa" wake word or the
assistant itself, so the first word is always Alexa; everything after it is Mark.

1. Mark needs a public HTTPS address. On AWS you already have one. On the PC he opens a free Cloudflare
   tunnel automatically once `ALEXA_SKILL_ID` is set — but that address changes each restart, so AWS is better here.
2. Sign in at developer.amazon.com/alexa/console/ask (free, same Amazon account as your Echo) and
   **Create Skill**: name "Mark", model **Custom**, hosting **Provision your own**, template **Start from scratch**.
3. Open **JSON Editor**, paste the contents of `alexa/interaction-model.json`, **Save** and **Build**.
4. **Endpoint** → HTTPS → Default region: `https://<your address>/alexa`.
   For the certificate question pick "My development endpoint is a sub-domain of a domain that has a wildcard
   certificate from a certificate authority".
5. Copy the **Skill ID** (amzn1.ask.skill.…) into `.env` as `ALEXA_SKILL_ID`, then restart Mark.
6. In the console's **Test** tab switch testing to **Development**. Your Echo, on the same account, can now use it.

Every request is checked against Amazon's signature, your skill id and the request time, so nothing else can
talk to that endpoint. Alexa cuts a skill off after about 8 seconds, so Mark says "one moment" and keeps
answers short; long jobs still run in the background and he can call you when they're done.
