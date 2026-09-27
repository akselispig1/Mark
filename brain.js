// Mark's brain, built like Claude's own voice mode:
//  - a fast voice model (Haiku 4.5) in a persistent, always-warm session per channel
//  - heavy work handed to Opus 5 running in the background, which reports back when done
//  - long-term memory (data/memory.md) and a scheduler for alarms and autonomous recurring jobs.
// All of it runs on the Claude Agent SDK (Claude Code harness: shell, files, web, your MCP servers).
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { placeCall } from './phone.js';
import * as memory from './memory.js';
import * as schedule from './scheduler.js';
import { localTools } from './tools.js';
import { fileTools } from './files.js';
import * as transcript from './transcript.js';
import * as vault from './vault.js';
import * as google from './google.js';

const VOICE_MODEL = process.env.JARVIS_VOICE_MODEL || 'claude-haiku-4-5';
const WORKER_MODEL = process.env.JARVIS_WORKER_MODEL || 'claude-opus-5';
const VOICE_EFFORT = process.env.JARVIS_VOICE_EFFORT || undefined;   // low | medium | high
const WHERE = process.env.JARVIS_HOST_DESC || (process.platform === 'win32' ? "the user's Windows PC" : 'a Linux cloud server that runs 24/7');

const persona = () => `You are MARK, the user's personal AI, talking to them by voice. Everything you write is spoken aloud.

How you talk:
- This is a conversation, not a document. Never cite sources or read out links, even if a tool asks you to. Usually one or two short sentences. Never lists, markdown, code, URLs or emoji.
- Dry British wit, calm and quick. "Sir" occasionally, not every line.
- If you need a moment for a tool, say a few words first ("One moment.") so there's no dead air.
- Numbers and times the way a person says them ("ten past four", "about two hundred").

What you can do:
- You run on ${WHERE} (home folder ${os.homedir()}) with shell, files, web search and every connected app/MCP server. Do quick things yourself.
- Anything that takes more than a few steps (research, coding, building, long file work) goes to start_background_task. Tell the user you're on it and keep chatting; you'll get a message when it finishes, then summarise the result in a sentence or two.
- call_user phones the user. Use it when they ask, or when a background task finishes and they asked to be called.
- Memory: when the user tells you something about themselves worth keeping (name, people, preferences, plans, routines, projects), call remember with one short fact. Don't announce it every time; a quick "noted" is enough. Use forget_memory when they ask you to forget something. If you don't know their name yet, ask for it once, naturally.
- Autonomy: set_alarm for alarms and reminders; schedule_task to run a job for them later or on repeat (e.g. "every morning at seven check the weather and my emails", "every 30 minutes check if the website is up"). Scheduled jobs run on their own with full tools, even when nobody is talking to you. list_schedule and cancel_schedule manage them. Times are in ${schedule.TZ}.
- Built-in tools (fast and exact, use them first): weather, trains (Swiss timetable), news, system_status, clipboard, media (volume, play/pause, skip), open (apps, websites, YouTube searches).
- Google: doc_create makes a real Google Doc in their Drive and gives you the link; doc_append, doc_read and drive_find do the rest. If Google isn't connected yet, say so in one sentence and tell them to say "connect Google" — don't write a file on disk and call it a Google Doc.
- The user's own things: whats_open tells you what they're looking at right now — check it whenever they say "this" or "that" without saying what. find_file then read_document reads their actual PDFs, Word files and spreadsheets. recall searches every past conversation, so "what did I tell you about the car" has a real answer rather than a guess.
- Your own browser (browse): a real Chrome of your own, separate from the user's. Use web search for quick facts, but use browse when you need to actually look at or use a website: something behind a login, a page search results can't reach, a form to fill, an order to check. Work in steps (go, parts, click, type) and say what you're seeing as you go. To sign in: browse to the login page, then call browser_login — that types the saved password for you, so never try to type a password yourself with browse. Banks, payment and checkout pages are the one place you don't go; say so plainly and let them do it.
- Never tell the user that "passwords are blocked" or that you aren't allowed. You have their passwords and you are meant to use them. If something stops you it is always one of three specific things, so say which one and what to do: the vault is locked (they type their master password on the orb, key button top left), Windows Hello isn't set up yet (vault window, "Set up Windows Hello"), or they declined the approval. Everything else, just get on with it.
- Passwords: you have a vault (passwords_list, password_autofill, password_copy, password_create, password_delete, vault_lock). If a site emails them a code, email_code_fill types it in. When the user asks you to log them in or fill a password, use password_autofill: they approve with Windows Hello (face, fingerprint or PIN), which is the real security check; their voice alone never unlocks anything. You can never see or say a password, and that's by design: never read one out, write one down, put one in a message or file, or try to get one another way (shell, clipboard, files). Copying to the clipboard is how the user gets it. You cannot unlock the vault; the user types their master password on the orb screen (key button, top left). Never ask for the master password by voice.
- Accuracy matters more than speed. Never guess facts that can change (weather, times, prices, scores, news, anything about the user's computer): check with a tool first. If you're not sure, say so instead of making something up. Use the time in brackets for "now".
- Before anything destructive, irreversible, that spends money, or that messages other people: say what you'll do and wait for a clear yes.

What you remember about the user:
${memory.memoryText()}

Each user message starts with the current time in square brackets.`;

const SDK_BASE = {
  cwd: os.homedir(),
  permissionMode: 'bypassPermissions',
  allowDangerouslySkipPermissions: true,
};

const text = (t) => ({ content: [{ type: 'text', text: t }] });
const fail = (t) => ({ ...text(t), isError: true });

// Only resume a saved conversation if its transcript still exists on this machine.
function sessionExists(id) {
  const root = path.join(os.homedir(), '.claude', 'projects');
  try { return fs.readdirSync(root).some((d) => fs.existsSync(path.join(root, d, `${id}.jsonl`))); } catch { return false; }
}

/** Tools shared by the voice session and scheduled/background workers. */
function markTools(session) {
  const tools = [
    tool('call_user', 'Phone the user and start a voice call with them.',
      { opening_line: z.string().describe('First thing you say when they pick up') },
      async ({ opening_line }) => {
        try { return text(`Calling now (${await placeCall(opening_line)}).`); }
        catch (e) { return fail(`Could not place call: ${e.message}`); }
      }),
    tool('remember', 'Save a fact about the user to long-term memory (survives restarts).',
      { fact: z.string().describe('One short standalone fact, e.g. "Name is Sam" or "Has football training Tuesdays 18:00"') },
      async ({ fact }) => text(`Remembered: ${memory.remember(fact)}`)),
    tool('forget_memory', 'Delete remembered facts containing this text.',
      { text: z.string() },
      async ({ text: t }) => text(`Forgot ${memory.forget(t)} fact(s).`)),
    tool('recall',
      'Search everything you and the user have ever said to each other. Use it for "what did I tell you about…", "what did we decide", "what did I ask you yesterday" — anything from a past conversation that isn\'t in your memory notes.',
      { about: z.string().describe('Words to look for, e.g. "dentist" or "the car"'),
        day: z.string().optional().describe('A date (YYYY-MM-DD) to read that whole day instead of searching') },
      async ({ about, day }) => {
        if (day) {
          const lines = transcript.onDay(day);
          if (!lines.length) return text(`Nothing was said on ${day}.`);
          return text(lines.map((l) => `${l.at.slice(11, 16)} ${l.who}: ${l.what}`).join('\n').slice(0, 5000));
        }
        const hits = transcript.find(about);
        if (!hits.length) return text(`Nothing in our conversations mentions "${about}". ${JSON.stringify(transcript.stats())}`);
        return text(hits.map((h) => `${h.when}\n  ${h.context.join('\n  ')}`).join('\n\n').slice(0, 5000));
      }),
    tool('set_alarm', `Set an alarm or reminder. Mark says it out loud if the orb is open and phones the user if call is true or nobody is around. Local time zone ${schedule.TZ}.`,
      {
        label: z.string().describe('What it is for, spoken when it goes off, e.g. "Wake up, school today"'),
        at: z.string().optional().describe('One-off local time as YYYY-MM-DDTHH:MM:SS'),
        cron: z.string().optional().describe('Recurring, 5-field cron, e.g. "30 6 * * 1-5" for weekdays 06:30'),
        call: z.boolean().optional().describe('Phone the user as well (default true for wake-up alarms)'),
      },
      async ({ label, at, cron, call }) => {
        try {
          const it = schedule.add({ kind: 'alarm', label, at, cron, notify: call === false ? 'speak' : 'call' });
          return text(`Alarm set (id ${it.id}), next: ${it.next}.`);
        } catch (e) { return fail(`Could not set alarm: ${e.message}`); }
      }),
    tool('schedule_task', `Schedule an autonomous job: a full Claude Code agent (${WORKER_MODEL}) runs the prompt with all tools at the given time(s), even when nobody is talking to Mark. Local time zone ${schedule.TZ}.`,
      {
        label: z.string().describe('Short name, e.g. "Morning briefing"'),
        prompt: z.string().describe('Complete, self-contained instructions for the job, including what counts as worth telling the user'),
        at: z.string().optional().describe('One-off local time YYYY-MM-DDTHH:MM:SS'),
        cron: z.string().optional().describe('Recurring 5-field cron, e.g. "0 7 * * *"'),
        every_minutes: z.number().optional().describe('Simple loop interval in minutes'),
        notify: z.enum(['auto', 'call', 'speak', 'silent']).optional()
          .describe('auto = only phone the user if the job finds something important; call = always phone with the result; speak = say it if the orb is open; silent = just log it'),
      },
      async ({ label, prompt, at, cron, every_minutes, notify }) => {
        try {
          const it = schedule.add({ kind: 'task', label, prompt, at, cron, everyMinutes: every_minutes, notify: notify || 'auto' });
          return text(`Scheduled (id ${it.id}), next run: ${it.next}.`);
        } catch (e) { return fail(`Could not schedule: ${e.message}`); }
      }),
    tool('list_schedule', 'List all alarms and scheduled jobs with their next run and last result.', {},
      async () => text(JSON.stringify(schedule.list(), null, 1))),
    tool('cancel_schedule', 'Cancel alarms/jobs by id or by words in their label.', { id_or_label: z.string() },
      async ({ id_or_label }) => {
        const gone = schedule.cancel(id_or_label);
        return text(gone.length ? `Cancelled: ${gone.join(', ')}` : 'Nothing matched.');
      }),
  ];
  tools.push(...localTools(), ...fileTools());

  // Google: real documents in the user's own Drive, not a file on disk pretending to be one.
  tools.push(
    tool('google_connect', "Start connecting the user's Google account, so you can make real Google Docs for them. Returns a link they click once. Use it whenever they ask for a Google Doc and Google isn't connected yet.",
      {}, async () => {
        if (google.connected()) return text('Google is already connected.');
        if (!google.configured()) return fail('Google needs setting up first: the user has to add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env. The README has the ten-click version. Tell them that, briefly.');
        return text('Ask the user to click the link that just opened on their screen and approve it. Then try again.');
      }),
    tool('doc_create', 'Create a real Google Doc in the user\'s Drive and write something in it. Returns the link. Use this when they ask for a Google Doc, a document, or something to share.',
      { title: z.string(), text: z.string().optional().describe('What to write in it. Plain text, newlines for paragraphs.') },
      async ({ title, text: body = '' }) => {
        try { const d = await google.createDoc(title, body); return text(`Made "${d.title}". Link: ${d.url}`); }
        catch (e) { return fail(e.message); }
      }),
    tool('doc_append', 'Add more text to the end of a Google Doc you already made.',
      { document_id: z.string(), text: z.string() },
      async ({ document_id, text: body }) => {
        try { await google.appendDoc(document_id, body); return text('Added it.'); }
        catch (e) { return fail(e.message); }
      }),
    tool('doc_read', 'Read what a Google Doc says.', { document_id: z.string() },
      async ({ document_id }) => {
        try { const d = await google.readDoc(document_id); return text(`${d.title}\n\n${d.text.slice(0, 5000)}`); }
        catch (e) { return fail(e.message); }
      }),
    tool('drive_find', "Find a file in the user's Google Drive by name.", { name: z.string() },
      async ({ name }) => {
        try { const f = await google.findFiles(name); return text(f.length ? JSON.stringify(f) : `Nothing in Drive matching "${name}".`); }
        catch (e) { return fail(e.message); }
      }),
  );
  if (session) {
    // Password vault: Mark can use logins but never sees a password. Every tool here returns names only.
    const locked = () => { vault.askToUnlock(); return text('The vault is locked, and the vault window has just been opened on their screen. Tell them to type their master password there. Never ask them to say it out loud.'); };
    tools.push(
      tool('passwords_list', 'List saved logins (names, usernames, sites only; passwords are never shown to you).',
        { search: z.string().optional() },
        async ({ search }) => {
          if (!vault.isUnlocked()) return locked();
          const all = vault.list().filter((i) => !search || `${i.name} ${i.url} ${i.username}`.toLowerCase().includes(search.toLowerCase()));
          return text(JSON.stringify(all.map(({ name, username, url }) => ({ name, username, url }))));
        }),
      tool('password_copy', "Copy a saved login's password, username or current 2FA code to the user's clipboard. It clears itself after 30 seconds. You never see it.",
        { login: z.string().describe('Name or site of the login, e.g. "Netflix"'), what: z.enum(['password', 'username', 'code']).optional() },
        async ({ login, what = 'password' }) => {
          if (!vault.isUnlocked()) return locked();
          try { const r = await vault.deliver(login, what); return text(`Copied the ${what} for ${r.name} to ${r.where}. It clears in 30 seconds.`); }
          catch (e) { return fail(e.message); }
        }),
      tool('password_create', 'Generate a strong new password for a site, save it in the vault and copy it to the clipboard. You never see it.',
        { name: z.string(), username: z.string().optional(), url: z.string().optional(), length: z.number().optional().describe('Default 20') },
        async ({ name, username = '', url = '', length = 20 }) => {
          if (!vault.isUnlocked()) return locked();
          try {
            const saved = vault.add({ name, username, url, password: vault.generate(length) });
            const r = await vault.deliver(saved.id);
            return text(`${saved.replaced ? 'Replaced' : 'Saved'} a new ${length}-character password for ${saved.name} and copied it to ${r.where}.`);
          } catch (e) { return fail(e.message); }
        }),
      tool('password_delete', 'Delete a saved login. Only after the user has clearly confirmed, by name, that they want it deleted.',
        { login: z.string() },
        async ({ login }) => {
          if (!vault.isUnlocked()) return locked();
          try { return text(`Deleted ${vault.remove(login)}.`); } catch (e) { return fail(e.message); }
        }),
      tool('password_autofill', 'Log the user in: type a saved login into the website open in their browser (Mark Autofill extension). If the page is asking for a 2FA / verification code and the login has a 2FA key saved, it fills the code instead. A Windows Hello prompt (face, fingerprint or PIN) pops up for the user to approve; you only get told whether it worked. Say something like "Look at the camera to approve" first.',
        { login: z.string().describe('Name or site of the login, e.g. "Netflix"') },
        async ({ login }) => {
          if (!vault.isUnlocked()) return locked();
          try { return text(await vault.autofill(login)); } catch (e) { return fail(e.message); }
        }),
      tool('email_code_fill', "The website is asking for a code it emailed the user: find that code in their Gmail and type it into the page. Waits up to a minute for the email to arrive. Only looks at mail from that site in the last ten minutes, and you never see the code. Tell the user you're watching for the email.",
        {}, async () => {
          if (!vault.isUnlocked()) return locked();
          try { return text(await vault.emailCodeFill()); } catch (e) { return fail(e.message); }
        }),
      tool('vault_lock', 'Lock the password vault now.', {}, async () => { vault.lock(); return text('Vault locked.'); }),
      tool('browser_login', 'Sign the user in to the website Mark has open in his OWN browser (see the browse tool), using a saved login. A Windows Hello prompt (face, fingerprint or PIN) pops up for them to approve; you only get told whether it worked, never the password. Say something like "Look at the camera to approve" first. Afterwards use browse with click to submit the form.',
        { login: z.string().describe('Name or site of the login, e.g. "Netflix"') },
        async ({ login }) => {
          if (!vault.isUnlocked()) return locked();
          try { return text(await vault.browserLogin(login)); } catch (e) { return fail(e.message); }
        }),
    );
    tools.push(tool('start_background_task',
      `Hand a multi-step job to a stronger agent (${WORKER_MODEL}) with full access to the machine and connected apps. Returns immediately; you will receive a message with the result when it finishes.`,
      { task: z.string().describe('Complete, self-contained instructions including everything the user said that matters') },
      async ({ task }) => {
        runBackgroundTask(task).then(
          (result) => session.say(`[background task finished]\nTask: ${task}\nResult: ${result}\n\nTell the user briefly.`),
          (e) => session.say(`[background task failed]\nTask: ${task}\nError: ${e.message}\n\nTell the user briefly.`),
        );
        return text('Started. Keep talking with the user; the result will arrive as a message.');
      }));
  }
  return createSdkMcpServer({ name: 'mark', version: '3.0.0', tools });
}

/** A long-lived voice conversation (one per orb / per phone call). The orb's survives restarts. */
export class VoiceSession {
  constructor(channel, { persist = false, model = VOICE_MODEL, effort = VOICE_EFFORT } = {}) {
    this.channel = channel;
    this.persist = persist;
    this.handlers = {};
    this.inbox = [];
    this.wake = null;
    this.closed = false;
    this.buffer = '';
    const resume = persist ? memory.savedSession(channel) : undefined;
    this.q = query({
      prompt: this.#input(),
      options: {
        ...SDK_BASE,
        model,
        ...(effort ? { effort } : {}),
        systemPrompt: persona(),
        resume: resume && sessionExists(resume) ? resume : undefined,
        mcpServers: { mark: markTools(this) },
        includePartialMessages: true,
        // Load tools up front instead of searching for them mid-turn: saves a round trip per tool use.
        env: { ...process.env, ENABLE_TOOL_SEARCH: 'false' },
      },
    });
    this.#run().catch((e) => console.error(`[${channel}]`, e));
  }

  on(handlers) { this.handlers = handlers; }

  /** Send the user's words (stamped with the current time so alarms/schedules are relative to now). */
  say(text) { transcript.log("you", text, this.channel); this.#push(`[${schedule.nowString()}] ${text}`); }

  async interrupt() { this.buffer = ''; this.interrupted = true; try { await this.q.interrupt(); } catch {} }

  close() { this.closed = true; this.wake?.(); }

  #push(text) { this.inbox.push(text); this.wake?.(); }

  async *#input() {
    while (!this.closed) {
      if (!this.inbox.length) await new Promise((r) => (this.wake = r));
      this.wake = null;
      while (this.inbox.length) {
        yield { type: 'user', message: { role: 'user', content: this.inbox.shift() }, parent_tool_use_id: null };
      }
    }
  }

  #emit(name, arg) {
    if (name === 'sentence') { arg = speakable(arg); if (!arg) return; this.spoke = true; transcript.log('mark', arg, this.channel); }
    this.handlers[name]?.(arg);
  }

  #flush(force) {
    // Speak sentence by sentence as soon as each one is complete.
    let m;
    while ((m = this.buffer.match(/[.!?…]+["')\]]?\s+/))) {
      const end = m.index + m[0].length;
      const s = this.buffer.slice(0, end).trim();
      this.buffer = this.buffer.slice(end);
      if (s) this.#emit('sentence', s);
    }
    if (force && this.buffer.trim()) { this.#emit('sentence', this.buffer.trim()); this.buffer = ''; }
  }

  async #run() {
    for await (const msg of this.q) {
      if (msg.session_id && this.persist) memory.saveSession(this.channel, msg.session_id);
      if (msg.type === 'stream_event') {
        const ev = msg.event;
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
          this.buffer += ev.delta.text;
          this.#flush(false);
        } else if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
          this.#flush(true);
          this.#emit('status', ev.content_block.name.replace(/^mcp__\w+?__/, '').replace(/_/g, ' ').toLowerCase());
        } else if (ev.type === 'message_stop') {
          this.#flush(true);
        }
      } else if (msg.type === 'result') {
        this.#flush(true);
        const failed = msg.is_error || msg.subtype !== 'success';
        if (failed && !this.interrupted) {
          // Never fail silently: say what's wrong (e.g. an expired Claude login) and log it.
          const why = String(msg.result || msg.errors?.join(' ') || msg.subtype);
          console.error(`[${this.channel}] turn failed:`, why);
          if (/authenticat|oauth|login|401|credential/i.test(why)) {
            this.#emit('status', 'login expired');
            this.#emit('sentence', "I've lost my connection to Claude, sir. My login needs renewing: run claude setup-token on the PC.");
          } else {
            this.#emit('sentence', 'Something went sideways on my end.');
          }
        } else if (!this.spoke && !this.interrupted && msg.result) {
          this.#emit('sentence', msg.result);            // answer arrived without streaming: still say it
        }
        this.interrupted = false;
        this.spoke = false;
        this.#emit('done');
      }
    }
  }
}

// Strip anything that shouldn't be read aloud (links, markdown, source lists).
function speakable(s) {
  if (/^\s*(sources?|references?)\s*:/i.test(s)) return '';
  return s
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[*_`#>|]/g, '')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Run a full Claude Code agent on a task (background jobs and scheduled jobs). Returns its final summary. */
export async function runBackgroundTask(task, { scheduled = false } = {}) {
  console.log(`[worker] start: ${task.slice(0, 120)}`);
  let result = '';
  for await (const msg of query({
    prompt: `[${schedule.nowString()}] ${task}`,
    options: {
      ...SDK_BASE,
      model: WORKER_MODEL,
      mcpServers: { mark: markTools(null) },
      systemPrompt: {
        type: 'preset', preset: 'claude_code',
        append: `You are working for MARK, the user's personal assistant.${scheduled
          ? ' This is a scheduled autonomous job: nobody is watching. If the result is something the user must know right now, start your final message with "ALERT:". Otherwise just report.'
          : ''} Finish with a short plain-English summary of what you did and found; it may be read aloud.\n\nWhat you know about the user:\n${memory.memoryText()}`,
      },
    },
  })) {
    if (msg.type === 'result') {
      if (msg.is_error || msg.subtype !== 'success') throw new Error(String(msg.result || msg.errors?.join(' ') || msg.subtype));
      result = msg.result;
    }
  }
  console.log('[worker] done');
  return result;
}
