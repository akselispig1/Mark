// Pulls raw microphone samples off the audio thread and hands them to the page in small batches.
// Runs in its own thread so it can never make the orb stutter.
class Tap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = []; this.n = 0; }
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (ch) {
      this.buf.push(new Float32Array(ch));
      this.n += ch.length;
      if (this.n >= 4096) {                       // ~85 ms at 48 kHz
        const out = new Float32Array(this.n);
        let at = 0;
        for (const b of this.buf) { out.set(b, at); at += b.length; }
        this.port.postMessage(out, [out.buffer]);
        this.buf = []; this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor('voice-tap', Tap);
