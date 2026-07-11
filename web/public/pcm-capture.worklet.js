// AudioWorklet for dictation (useDictation.ts): batches mic samples
// (~2048 frames) to the main thread. Served as a static asset because the
// app's CSP (default-src 'self') forbids blob:-URL worklet modules.
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = [];
    this.len = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      this.buf.push(new Float32Array(ch));
      this.len += ch.length;
      if (this.len >= 2048) {
        const out = new Float32Array(this.len);
        let o = 0;
        for (const b of this.buf) {
          out.set(b, o);
          o += b.length;
        }
        this.port.postMessage(out, [out.buffer]);
        this.buf = [];
        this.len = 0;
      }
    }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCapture);
