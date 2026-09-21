// Model worker: runs Whisper for transcription, off the main thread.
// Summaries are extractive and run in the page (js/summarize.js); the small
// generative models that fit in Safari were tested and either produced
// garbage (4-bit/f16 on WebGPU) or text unrelated to the meeting (8-bit CPU).

import { pipeline, env } from "../vendor/transformers.min.js";

env.allowLocalModels = false;
env.useBrowserCache = true;
env.useWasmCache = true;
// Multithreaded WASM needs cross-origin isolation, which the service worker
// provides. Without it, ONNX Runtime quietly falls back to one thread.
// On iPhone and iPad, threaded ONNX Runtime can stall while it builds the
// session (threads are spawned as workers nested inside this worker), so iOS
// runs single-threaded: slower, but it always finishes.
const IOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
function configureThreads(ios) {
  env.backends.onnx.wasm.numThreads = ios || !self.crossOriginIsolated
    ? 1
    : Math.min(4, Math.max(1, (navigator.hardwareConcurrency || 2) - 1));
}
configureThreads(IOS);

const MODELS = {
  light: { id: "onnx-community/whisper-base", label: "Light", mb: 77 },
  standard: { id: "onnx-community/whisper-small", label: "Standard", mb: 250 },
};

let asr = null, asrId = null;

function progress(kind) {
  const files = new Map();
  return (p) => {
    if (p.status === "progress" && p.total) {
      files.set(p.file, { loaded: p.loaded, total: p.total });
      let loaded = 0, total = 0;
      for (const f of files.values()) { loaded += f.loaded; total += f.total; }
      self.postMessage({ type: "progress", kind, loaded, total });
    } else if (p.status === "done" && files.size && [...files.values()].every((f) => f.loaded >= f.total)) {
      // Every file is here; what follows is building the model in memory.
      self.postMessage({ type: "progress", kind, stage: "preparing" });
    }
  };
}

async function disposeASR() {
  if (asr) { try { await asr.dispose(); } catch {} asr = null; asrId = null; }
}

async function loadASR(key) {
  const model = MODELS[key];
  if (asr && asrId === model.id) return asr;
  await disposeASR();
  // 8-bit weights on WASM: the combination that loads reliably in Safari.
  asr = await pipeline("automatic-speech-recognition", model.id, {
    dtype: { encoder_model: "q8", decoder_model_merged: "q8" },
    device: "wasm",
    progress_callback: progress("asr"),
  });
  asrId = model.id;
  return asr;
}

async function transcribe({ audio, language }) {
  const pipe = await loadASR(currentModel);
  const options = { return_timestamps: true, task: "transcribe" };
  // Leaving language unset lets Whisper predict the language token itself,
  // which is the right behaviour for bilingual speakers.
  if (language === "ar" || language === "en") options.language = language === "ar" ? "arabic" : "english";
  const out = await pipe(audio, options);
  const chunks = Array.isArray(out.chunks) && out.chunks.length
    ? out.chunks
    : [{ timestamp: [0, audio.length / 16000], text: out.text || "" }];
  return chunks.map((c) => ({
    start: c.timestamp?.[0] ?? 0,
    end: c.timestamp?.[1] ?? c.timestamp?.[0] ?? 0,
    text: c.text || "",
  }));
}

let currentModel = "standard";

// Requests run strictly one after another. Handlers are async, so without this
// a model switch could dispose Whisper while a transcription was mid-run.
let chain = Promise.resolve();
self.onmessage = (e) => { chain = chain.then(() => handle(e)); };

async function handle(e) {
  const { id, type } = e.data;
  try {
    let result;
    switch (type) {
      case "set-model": currentModel = e.data.model; if (e.data.ios) configureThreads(true); result = true; break;
      case "load-asr": await loadASR(e.data.model || currentModel); result = true; break;
      case "transcribe": result = await transcribe(e.data); break;
      case "unload": await disposeASR(); result = true; break;
      default: throw new Error("Unknown request " + type);
    }
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.message || err) });
  }
}
