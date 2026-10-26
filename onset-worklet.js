// Turns the (low-passed) mic signal into an onset envelope: one value per hop,
// the rise in log energy since the previous hop. Posted to the main thread in batches.
class OnsetProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.hop = 256;
    this.batch = 16;
    this.n = 0;
    this.acc = 0;
    this.prev = 0;
    this.k = 0;
    this.t0 = 0;
    this.levelAcc = 0;
    this.flux = new Float32Array(this.batch);
  }

  process(inputs) {
    const inp = inputs[0];
    if (inp && inp.length) {
      const l = inp[0];
      const r = inp[1] || inp[0];
      for (let i = 0; i < l.length; i++) {
        const s = 0.5 * (l[i] + r[i]);
        this.acc += s * s;
        if (++this.n < this.hop) continue;
        const ms = this.acc / this.hop;
        this.acc = 0;
        this.n = 0;
        const x = Math.log1p(1e4 * ms);
        if (this.k === 0) this.t0 = currentTime + (i + 1) / sampleRate;
        this.flux[this.k] = Math.max(0, x - this.prev);
        this.prev = x;
        this.levelAcc += ms;
        if (++this.k === this.batch) {
          this.port.postMessage({
            t: this.t0,
            hop: this.hop / sampleRate,
            flux: this.flux.slice(),
            level: this.levelAcc / this.batch,
          });
          this.k = 0;
          this.levelAcc = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('onset', OnsetProcessor);
