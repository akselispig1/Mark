// Compare voice models on accuracy + speed with the exact Mark setup.
process.loadEnvFile();
const { VoiceSession } = await import('./brain.js');
const QUESTIONS = [
  'What time is it right now?',
  'What is 17 times 23?',
  'What day of the week is Christmas this year?',
  "What's the weather in Zurich right now?",
  'How much free space is on my C drive?',
  'Who won the most recent Formula 1 race?',
  'What is the capital of Australia?',
];
const configs = JSON.parse(process.argv[2]);
for (const cfg of configs) {
  const s = new VoiceSession(`bench-${cfg.model}-${cfg.effort || 'default'}`, cfg);
  console.log(`\n=== ${cfg.model} effort=${cfg.effort || 'default'} ===`);
  for (const q of QUESTIONS) {
    const t0 = Date.now(); let first = null; const out = [];
    await new Promise((done) => {
      s.on({ sentence: (x) => { first ??= Date.now() - t0; out.push(x); }, status: (x) => out.push(`(${x})`), done });
      s.say(q);
    });
    console.log(`[first ${(first / 1000).toFixed(1)}s, total ${((Date.now() - t0) / 1000).toFixed(1)}s] ${q}\n   -> ${out.join(' ')}`);
  }
  s.close();
}
process.exit(0);
