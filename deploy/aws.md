# Moving Mark to AWS (when it's working perfectly on the PC)

Everything is ready to go; nothing has been created on AWS yet, so there's no cost until you do this.

## What changes on AWS
- Mark runs 24/7 even when your PC is off, at a fixed public HTTPS address.
- Twilio calls work directly, with no tunnel. Push "calls" work too, and Tailscale isn't needed any more.
- **Alarms and scheduled jobs run around the clock** and phone you (Telegram, then Twilio, then push). Memory, schedules and his conversation live in the `mark-data` / `mark-claude` volumes, so they survive restarts and updates. All times are Europe/Zurich.
- **His "hands" move to the server.** Shell and file commands run on the AWS machine, not your PC. Web search and cloud connectors still work.

## Steps
1. **Create the server** (Lightsail console): Ubuntu 24.04, **$24/month, 4 GB plan**, in a region near you (e.g. Frankfurt).
   - Networking tab: attach a **static IP**, then open ports **80** and **443**.
2. **Get a Claude login token** on your PC, for the server to use instead of your browser login:
   ```
   claude setup-token
   ```
3. **Copy Mark to the server** (from your PC; replace the IP):
   ```
   scp -r <the mark folder> ubuntu@1.2.3.4:~/jarvis
   ```
   (node_modules, data and .env are excluded from the Docker build anyway; you can delete node_modules on the server.)
4. **On the server**:
   ```
   cd ~/jarvis && bash deploy/server-setup.sh     # installs Docker, then log out and back in
   ```
5. **Create `~/jarvis/.env` on the server.** A free HTTPS domain comes from sslip.io: IP `1.2.3.4` becomes `1-2-3-4.sslip.io`.
   ```
   JARVIS_DOMAIN=1-2-3-4.sslip.io
   JARVIS_URL=https://1-2-3-4.sslip.io
   PUBLIC_URL=https://1-2-3-4.sslip.io
   CLAUDE_CODE_OAUTH_TOKEN=<from step 2>
   MY_PHONE=+<your number, international format>
   RELAY_SECRET=<long random string>
   TWILIO_ACCOUNT_SID=...
   TWILIO_AUTH_TOKEN=...
   TWILIO_FROM=...
   ```
6. **Start it:**
   ```
   docker compose up -d --build
   docker compose logs -f mark
   ```
7. **Bring his memory with him** (what he knows about you; optional):
   ```
   docker compose cp data/memory.md mark:/app/data/memory.md && docker compose restart mark
   ```
   Alarms and scheduled jobs you want on the server: just ask him again once he's running there.
8. **Telegram calls** (if set up): log his account in once on the server:
   ```
   docker compose exec -it mark telegram/.venv/bin/python telegram/caller.py login && docker compose restart mark
   ```
9. **Pair your phone and PC browser** (prints a QR code and link):
   ```
   docker compose exec mark node pair.js
   ```

## Updating later
```
scp -r <changed files> ubuntu@1.2.3.4:~/jarvis/  &&  ssh ubuntu@1.2.3.4 "cd mark && docker compose up -d --build"
```
