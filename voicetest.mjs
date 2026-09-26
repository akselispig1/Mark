process.loadEnvFile();
const { VoiceSession } = await import('./brain.js');
const s = new VoiceSession('test');

const ask = (text, ms = 45000) => new Promise((resolve) => {
  const parts = [];
  let done = false;
  const finish = () => { if (done) return; done = true; s.on({}); resolve(parts.join(' ').trim()); };
  s.on({ sentence: (x) => parts.push(x), done: finish });
  s.say(text);
  setTimeout(finish, ms);
});

for (const q of process.argv.slice(2)) {
  const t = Date.now();
  console.log(`\nYOU: ${q}`);
  const answer = await ask(q);
  console.log(`MARK (${((Date.now() - t) / 1000).toFixed(1)}s): ${answer}`);
}
process.exit(0);
