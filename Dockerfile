FROM node:24-slim

# git/curl give Mark's shell tool something useful on the server; python + ffmpeg run the Telegram caller.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git curl python3 python3-venv ffmpeg tzdata \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Free Telegram calls (Python side-process started by server.js when configured).
COPY telegram/requirements.txt telegram/
RUN python3 -m venv telegram/.venv && telegram/.venv/bin/pip install --no-cache-dir -r telegram/requirements.txt

COPY . .
RUN useradd -m mark && mkdir -p /app/data && chown -R mark /app
USER mark

# Whisper model is downloaded on first call and kept in the data volume.
ENV HOST=0.0.0.0 PORT=7777 NODE_ENV=production TZ=Europe/Zurich \
    TELEGRAM_SESSION=/app/data/telegram-mark HF_HOME=/app/data/hf
EXPOSE 7777
CMD ["node", "server.js"]
