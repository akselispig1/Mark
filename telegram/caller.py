"""
Jarvis's free phone line: rings you on Telegram (a real, full-screen Telegram call) and
bridges the audio to Jarvis's brain over the same /relay websocket Twilio would use.

  python caller.py login   one-time: sign Jarvis's Telegram account in (you type the code)
  python caller.py         run the call service (server.js starts this automatically)

Speech-to-text runs locally (faster-whisper); Jarvis's voice is the same Edge neural voice.
"""
import asyncio
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import edge_tts
import numpy as np
import websockets
from aiohttp import web
from faster_whisper import WhisperModel
from pytgcalls import PyTgCalls, filters
from pytgcalls.types import (CallConfig, ChatUpdate, Device, Direction, ExternalMedia,
                             MediaStream, RecordStream, StreamFrames)
from pytgcalls.types.raw import AudioParameters
from telethon import TelegramClient

HERE = Path(__file__).parent
for line in ((HERE.parent / '.env').read_text(encoding='utf-8').splitlines() if (HERE.parent / '.env').exists() else []):
    if '=' in line and not line.lstrip().startswith('#'):
        k, v = line.split('=', 1)
        os.environ.setdefault(k.strip(), v.split('#')[0].strip())

API_ID = int(os.environ.get('TELEGRAM_API_ID') or 0)
API_HASH = os.environ.get('TELEGRAM_API_HASH', '')
TARGET = os.environ.get('TELEGRAM_CALL_USER') or os.environ.get('MY_PHONE')   # @username or +phone of YOU
RELAY = f"ws://127.0.0.1:{os.environ.get('PORT', '7777')}/relay/{os.environ.get('RELAY_SECRET', '')}"
VOICE = os.environ.get('JARVIS_VOICE', 'en-GB-RyanNeural')
CONTROL_PORT = int(os.environ.get('TELEGRAM_CONTROL_PORT', '7778'))
SESSION = os.environ.get('TELEGRAM_SESSION') or str(HERE / 'jarvis')   # Telethon adds .session

RATE = 48000                     # Telegram call audio: 48 kHz mono s16le
FRAME = RATE // 100 * 2          # 10 ms of audio in bytes
AUDIO = AudioParameters(RATE, 1)

client: TelegramClient | None = None
calls: PyTgCalls | None = None
whisper = None


def log(*a):
    print('[telegram]', *a, flush=True)


async def tts_pcm(text: str) -> bytes:
    """Edge neural voice -> raw 48 kHz mono PCM."""
    mp3 = b''
    async for chunk in edge_tts.Communicate(text, VOICE, rate='+6%', pitch='-4Hz').stream():
        if chunk['type'] == 'audio':
            mp3 += chunk['data']
    proc = await asyncio.create_subprocess_exec(
        'ffmpeg', '-loglevel', 'quiet', '-i', 'pipe:0', '-f', 's16le', '-ac', '1', '-ar', str(RATE), 'pipe:1',
        stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    pcm, _ = await proc.communicate(mp3)
    return pcm


class Call:
    """One live call: mouth (outgoing frames), ears (incoming frames + VAD + Whisper), brain (/relay)."""

    def __init__(self, chat_id: int, greeting: str):
        self.chat_id, self.greeting = chat_id, greeting
        self.out = bytearray()          # PCM waiting to be spoken
        self.speech = bytearray()       # PCM of the user's current utterance
        self.voiced = self.silent = 0   # ms counters for simple voice-activity detection
        self.ws = None
        self.first = True
        self.alive = True
        self.say_lock = asyncio.Lock()

    async def speak(self, text: str):
        text = text.strip()
        if not text:
            return
        async with self.say_lock:
            pcm = await tts_pcm(text)
            self.out.extend(pcm)

    async def mouth(self):
        # Stream 10 ms frames in real time; silence when there's nothing to say.
        silence, t0, n = bytes(FRAME), time.perf_counter(), 0
        while self.alive:
            chunk = bytes(self.out[:FRAME]) if self.out else silence
            del self.out[:FRAME]
            try:
                await calls.send_frame(self.chat_id, Device.MICROPHONE, chunk.ljust(FRAME, b'\0'))
            except Exception:
                pass
            n += 1
            await asyncio.sleep(max(0, t0 + n * 0.01 - time.perf_counter()))

    def hear(self, pcm: bytes):
        # Energy-based endpointing: an utterance ends after 700 ms of quiet.
        rms = float(np.sqrt(np.mean(np.frombuffer(pcm, np.int16).astype(np.float32) ** 2))) if pcm else 0.0
        ms = len(pcm) / 2 / RATE * 1000
        if rms > 700:
            self.voiced += ms
            self.silent = 0
            if self.voiced > 150 and self.out:          # you started talking over Jarvis: stop him
                self.out.clear()
                asyncio.create_task(self.send({'type': 'interrupt'}))
        else:
            self.silent += ms
        if self.voiced:
            self.speech.extend(pcm)
        if self.voiced > 250 and self.silent > 700:
            audio = bytes(self.speech)
            self.speech.clear()
            self.voiced = self.silent = 0
            asyncio.create_task(self.transcribe(audio))
        elif self.voiced and self.silent > 700:        # just a noise blip
            self.speech.clear()
            self.voiced = self.silent = 0

    async def transcribe(self, pcm: bytes):
        samples = np.frombuffer(pcm, np.int16).astype(np.float32) / 32768
        samples = samples[: len(samples) // 3 * 3].reshape(-1, 3).mean(axis=1)   # 48k -> 16k
        segments, _ = await asyncio.to_thread(lambda: whisper.transcribe(samples, beam_size=1, vad_filter=True))
        text = ' '.join(s.text.strip() for s in segments).strip()
        if not text:
            return
        log('you:', text)
        await self.send({'type': 'prompt', 'voicePrompt': text, 'last': True})

    async def send(self, obj):
        if self.ws:
            await self.ws.send(json.dumps(obj))

    async def brain(self):
        async with websockets.connect(RELAY) as ws:
            self.ws = ws
            await self.send({'type': 'setup', 'callSid': f'telegram-{self.chat_id}-{int(time.time())}'})
            async for raw in ws:
                msg = json.loads(raw)
                if msg.get('type') == 'text' and msg.get('token', '').strip():
                    log('jarvis:', msg['token'].strip())
                    asyncio.create_task(self.speak(msg['token']))
                if not self.alive:
                    break

    def end(self):
        self.alive = False
        if self.ws:
            asyncio.create_task(self.ws.close())


current: Call | None = None


async def on_frames(_, update: StreamFrames):
    if current and update.chat_id == current.chat_id:
        for f in update.frames:
            current.hear(f.frame)


async def on_hangup(_, update: ChatUpdate):
    global current
    if current and update.chat_id == current.chat_id:
        log('call ended')
        current.end()
        current = None


async def place_call(greeting: str):
    global current
    if current:
        raise RuntimeError('Already on a call')
    user = await client.get_entity(TARGET)
    call = current = Call(user.id, greeting)
    log('ringing', TARGET)
    try:
        # Rings your Telegram; returns once you answer (or times out after 45 s).
        await calls.play(user.id, MediaStream(ExternalMedia.AUDIO, AUDIO), CallConfig(timeout=45))
        await calls.record(user.id, RecordStream(True, AUDIO))
    except Exception:
        current = None
        raise
    log('answered')
    asyncio.create_task(call.mouth())
    asyncio.create_task(call.brain())
    await call.speak(greeting)


async def handle_call(request):
    body = await request.json() if request.can_read_body else {}
    greeting = body.get('greeting') or 'Sir. You rang?'
    asyncio.create_task(safe_call(greeting))
    return web.json_response({'ok': True})


async def safe_call(greeting):
    try:
        await place_call(greeting)
    except Exception as e:
        log('call failed:', repr(e))


async def serve():
    global whisper
    if not (API_ID and API_HASH and TARGET):
        sys.exit('Set TELEGRAM_API_ID, TELEGRAM_API_HASH and TELEGRAM_CALL_USER in .env')
    log('loading speech recognition...')
    whisper = await asyncio.to_thread(WhisperModel, os.environ.get('JARVIS_WHISPER', 'base'), device='cpu', compute_type='int8')
    global client, calls
    client = TelegramClient(SESSION, API_ID, API_HASH)
    calls = PyTgCalls(client)
    calls.on_update(filters.stream_frame(Direction.INCOMING, Device.MICROPHONE))(on_frames)
    calls.on_update(filters.chat_update(ChatUpdate.Status.LEFT_CALL))(on_hangup)
    await client.connect()
    if not await client.is_user_authorized():
        sys.exit('Telegram not logged in yet: run  python telegram/caller.py login')
    await calls.start()
    app = web.Application()
    app.router.add_post('/call', handle_call)
    runner = web.AppRunner(app)
    await runner.setup()
    await web.TCPSite(runner, '127.0.0.1', CONTROL_PORT).start()
    log(f'ready: will call {TARGET}')
    await asyncio.Event().wait()


def login():
    # You type Jarvis's phone number and the login code yourself; nothing is stored except the session file.
    with TelegramClient(SESSION, API_ID, API_HASH) as c:
        me = c.get_me()
        print(f'Logged in as {me.first_name} (@{me.username}). Session saved to {SESSION}.session')


if __name__ == '__main__':
    if sys.argv[1:] == ['login']:
        login()
    else:
        asyncio.run(serve())
