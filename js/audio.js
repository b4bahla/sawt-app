// Microphone capture, file import, resampling, and silence-aware chunking.
//
// Everything is converted to 16 kHz mono and cut into ~30 s chunks at the
// quietest point near the boundary, so a word is rarely split. Chunks are
// handed out as soon as they close; the caller stores them before anything
// else happens to them.

export const SAMPLE_RATE = 16000;
const TARGET = 30 * SAMPLE_RATE;
const SEARCH_FROM = 25 * SAMPLE_RATE;
const WINDOW = Math.round(0.25 * SAMPLE_RATE);

/** Accumulates 16 kHz samples and emits chunks cut at a pause. */
export class Chunker {
  constructor(onChunk) {
    this.onChunk = onChunk;
    this.parts = [];
    this.length = 0;
    this.emittedSamples = 0;
  }

  push(samples) {
    this.parts.push(samples);
    this.length += samples.length;
    while (this.length >= TARGET) this.#emit(false);
  }

  flush() {
    if (this.length > SAMPLE_RATE * 0.3) this.#emit(true);
    this.parts = [];
    this.length = 0;
  }

  #buffer() {
    const all = new Float32Array(this.length);
    let offset = 0;
    for (const p of this.parts) { all.set(p, offset); offset += p.length; }
    return all;
  }

  #emit(force) {
    const all = this.#buffer();
    const cut = force ? all.length : quietestPoint(all, SEARCH_FROM, Math.min(TARGET, all.length));
    const chunk = all.slice(0, cut);
    const rest = all.slice(cut);
    this.parts = rest.length ? [rest] : [];
    this.length = rest.length;
    const startOffset = this.emittedSamples / SAMPLE_RATE;
    this.emittedSamples += chunk.length;
    this.onChunk(chunk, startOffset);
  }
}

/** Offset of the lowest-energy 250 ms window between from and to. */
function quietestPoint(samples, from, to) {
  let best = to, bestEnergy = Infinity;
  for (let start = from; start + WINDOW <= to; start += WINDOW / 2) {
    let energy = 0;
    for (let i = start; i < start + WINDOW; i++) energy += samples[i] * samples[i];
    if (energy < bestEnergy) { bestEnergy = energy; best = start + WINDOW / 2; }
  }
  return Math.round(best);
}

/** Linear-interpolating resampler with a simple averaging pre-filter. */
export function resample(input, fromRate, toRate = SAMPLE_RATE) {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const out = new Float32Array(Math.floor(input.length / ratio));
  const span = Math.max(1, Math.floor(ratio));
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio;
    const base = Math.floor(pos);
    let sum = 0, n = 0;
    for (let k = 0; k < span && base + k < input.length; k++) { sum += input[base + k]; n++; }
    out[i] = n ? sum / n : 0;
  }
  return out;
}

export function floatToPCM16(samples) {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    out[i] = s < 0 ? s * 32768 : s * 32767;
  }
  return out.buffer;
}

export function pcm16ToFloat(buffer) {
  const pcm = new Int16Array(buffer);
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / 32768;
  return out;
}

export function peakDB(samples) {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) { const v = Math.abs(samples[i]); if (v > peak) peak = v; }
  return 20 * Math.log10(Math.max(peak, 1e-7));
}

/**
 * Live microphone capture.
 *
 * iOS stops microphone capture in a web app the moment it leaves the screen,
 * so this keeps the screen awake while recording and reports interruptions
 * instead of pretending to record through them.
 */
export class Recorder {
  constructor({ onChunk, onLevel, onElapsed, onInterrupted, onResumed }) {
    this.cb = { onChunk, onLevel, onElapsed, onInterrupted, onResumed };
    this.chunker = new Chunker((samples, start) => onChunk(samples, start));
    this.captured = 0;
    this.state = "idle";
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    try {
      this.ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    } catch {
      this.ctx = new AudioContext();
    }
    this.rate = this.ctx.sampleRate;
    await this.ctx.audioWorklet.addModule(new URL("./capture-worklet.js", import.meta.url));
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, "capture-processor");
    this.node.port.onmessage = (e) => this.#receive(e.data);
    this.source.connect(this.node);
    // A silent sink keeps the graph pulling on browsers that skip idle nodes.
    const sink = this.ctx.createGain();
    sink.gain.value = 0;
    this.node.connect(sink).connect(this.ctx.destination);

    this.ctx.onstatechange = () => {
      if (this.state !== "recording" && this.state !== "interrupted") return;
      if (this.ctx.state === "running" && this.state === "interrupted") {
        this.state = "recording";
        this.cb.onResumed?.();
      } else if (this.ctx.state !== "running" && this.state === "recording") {
        this.state = "interrupted";
        this.cb.onInterrupted?.("Recording paused because Sawt left the screen or another app took the microphone.");
      }
    };
    for (const track of this.stream.getAudioTracks()) {
      track.onended = () => {
        if (this.state === "recording") {
          this.state = "interrupted";
          this.cb.onInterrupted?.("The microphone was taken by another app or a call.");
        }
      };
    }
    await this.ctx.resume();
    await this.#holdWakeLock();
    this.visibilityHandler = () => {
      if (document.visibilityState === "visible" && this.state !== "idle" && this.state !== "stopped") {
        this.#holdWakeLock();
      }
    };
    document.addEventListener("visibilitychange", this.visibilityHandler);
    this.state = "recording";
  }

  #receive(block) {
    if (this.state !== "recording") return;
    const samples = resample(block, this.rate);
    this.captured += samples.length;
    this.chunker.push(samples);
    this.cb.onLevel?.(peakDB(block));
    this.cb.onElapsed?.(this.captured / SAMPLE_RATE);
  }

  /** Needs a tap: iOS only resumes audio from a user gesture. */
  async resume() {
    if (this.state !== "interrupted") return;
    const tracks = this.stream?.getAudioTracks() || [];
    if (tracks.some((t) => t.readyState === "ended")) {
      // The track is gone; reconnect a fresh one to the same graph.
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.source.disconnect();
      this.source = this.ctx.createMediaStreamSource(this.stream);
      this.source.connect(this.node);
    }
    await this.ctx.resume();
    await this.#holdWakeLock();
    this.state = "recording";
    this.cb.onResumed?.();
  }

  /** Flushes everything captured, including the tail, then releases the microphone. */
  async stop() {
    if (this.state === "idle" || this.state === "stopped") return;
    const wasCapturing = this.state;
    this.state = "draining";
    await new Promise((resolve) => {
      if (!this.node) return resolve();
      const previous = this.node.port.onmessage;
      this.node.port.onmessage = (e) => {
        // Accept the worklet's final partial block even though we are draining.
        const samples = resample(e.data, this.rate);
        this.captured += samples.length;
        this.chunker.push(samples);
        resolve();
      };
      this.node.port.postMessage("flush");
      setTimeout(resolve, 300);
      void previous;
    });
    this.chunker.flush();
    this.state = "stopped";
    document.removeEventListener("visibilitychange", this.visibilityHandler);
    this.stream?.getTracks().forEach((t) => t.stop());
    try { await this.ctx?.close(); } catch {}
    try { await this.wakeLock?.release(); } catch {}
    return wasCapturing;
  }

  async #holdWakeLock() {
    try {
      if ("wakeLock" in navigator) this.wakeLock = await navigator.wakeLock.request("screen");
    } catch {
      // Not fatal; the recording screen also tells the user to keep it open.
    }
  }
}

/**
 * Decodes an audio or video file to 16 kHz mono and chunks it.
 * Safari decodes m4a, mp3, wav, aac, and the audio track of mp4/mov.
 */
export async function importFile(file, onChunk, onProgress) {
  const data = await file.arrayBuffer();
  onProgress?.(0.1, "Decoding the file");
  const probe = new AudioContext();
  let decoded;
  try {
    decoded = await probe.decodeAudioData(data);
  } catch {
    throw new Error("This file's audio could not be read. Try an m4a, mp3, wav, or mp4 file.");
  } finally {
    probe.close();
  }

  onProgress?.(0.3, "Converting to 16 kHz");
  const frames = Math.ceil(decoded.duration * SAMPLE_RATE);
  const offline = new OfflineAudioContext(1, frames, SAMPLE_RATE);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  const mono = rendered.getChannelData(0);

  const chunker = new Chunker(onChunk);
  const step = SAMPLE_RATE * 10;
  for (let i = 0; i < mono.length; i += step) {
    chunker.push(mono.slice(i, i + step));
    onProgress?.(0.3 + 0.7 * Math.min(1, (i + step) / mono.length), "Saving audio");
    await new Promise((r) => setTimeout(r, 0));
  }
  chunker.flush();
  return decoded.duration;
}
