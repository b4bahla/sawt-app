// Runs on the audio rendering thread. Batches 128-frame render quanta into
// larger blocks so the main thread gets a message every ~0.25 s, not 375 per
// second, and never does any work here beyond copying.
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Float32Array(4096);
    this.filled = 0;
    this.port.onmessage = (e) => {
      if (e.data === "flush" && this.filled > 0) {
        this.port.postMessage(this.block.slice(0, this.filled));
        this.filled = 0;
      }
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channels = input.length;
    const frames = input[0].length;
    for (let i = 0; i < frames; i++) {
      let sum = 0;
      for (let c = 0; c < channels; c++) sum += input[c][i];
      this.block[this.filled++] = sum / channels;
      if (this.filled === this.block.length) {
        this.port.postMessage(this.block.slice(0));
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor("capture-processor", CaptureProcessor);
