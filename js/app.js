// Sawt PWA controller.
//
// The same promises as the native app, within what Safari allows:
// audio is stored before it is processed, every chunk can always be retried,
// models run on the phone, and transcribe-only deletes audio after its text
// is safely stored.

import * as db from "./db.js";
import { Recorder, importFile, floatToPCM16, pcm16ToFloat, SAMPLE_RATE } from "./audio.js";
import {
  normalizeForDisplay, normalizeForIndex, languageTagOf, isArabic,
  renderBidi, stripSpecialTokens, formatDuration,
} from "./text.js";
import { summarize } from "./summarize.js";
import { buildDocument, toDocx, toPDF, toMarkdown, toPlainText, deliver, shareText, safeFileName } from "./export.js";

const VERSION = "1.1.1";
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

// ---------- preferences ----------

const DEFAULT_PREFS = { policy: "transcribe", language: "auto", model: "standard", summaryLang: "match" };
const prefs = (() => {
  try { return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem("sawt-prefs") || "{}") }; }
  catch { return { ...DEFAULT_PREFS }; }
})();
function savePrefs() { try { localStorage.setItem("sawt-prefs", JSON.stringify(prefs)); } catch {} }
function modelReady(key) { try { return localStorage.getItem("sawt-model-" + key) === "ready"; } catch { return false; } }
function markModelReady(key) { try { localStorage.setItem("sawt-model-" + key, "ready"); } catch {} }

// ---------- worker ----------

// iPadOS reports itself as a Mac; touch support gives it away.
const IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);

let worker = null;
let rpcSeq = 0;
const rpcs = new Map();
let onModelProgress = null;
// A worker that fails to load would otherwise leave every call waiting
// forever, which is exactly how the first test run of this app hung silently.
let workerFailure = null;

function startWorker() {
  worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  workerFailure = null;
  worker.onmessage = (e) => {
    const msg = e.data;
    if (msg.type === "progress") { onModelProgress?.(msg); return; }
    const rpc = rpcs.get(msg.id);
    if (!rpc) return;
    rpcs.delete(msg.id);
    msg.ok ? rpc.resolve(msg.result) : rpc.reject(new Error(msg.error));
  };
  worker.onerror = (e) => {
    workerFailure = new Error("The transcription engine could not start (" + (e.message || "script error") + "). Reload the app; if it persists, delete and re-add it to the Home Screen.");
    for (const rpc of rpcs.values()) rpc.reject(workerFailure);
    rpcs.clear();
  };
}

/** Replaces a stuck worker. Its model files stay cached, so nothing is downloaded again. */
function restartWorker(reason) {
  worker?.terminate();
  for (const rpc of rpcs.values()) rpc.reject(reason);
  rpcs.clear();
  startWorker();
}
startWorker();

function call(type, data = {}, transfer = []) {
  if (workerFailure) return Promise.reject(workerFailure);
  const id = ++rpcSeq;
  return new Promise((resolve, reject) => {
    rpcs.set(id, { resolve, reject });
    worker.postMessage({ id, type, ...data }, transfer);
  });
}

// ---------- service worker and cross-origin isolation ----------
// The service worker adds COOP/COEP headers so ONNX Runtime can use several
// threads. Isolation only applies once the worker controls the page, so the
// first visit reloads exactly once.

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
  if (!self.crossOriginIsolated) {
    const reloadOnce = () => {
      try {
        if (sessionStorage.getItem("sawt-coi")) return;
        sessionStorage.setItem("sawt-coi", "1");
      } catch { return; }
      location.reload();
    };
    if (navigator.serviceWorker.controller) reloadOnce();
    else navigator.serviceWorker.addEventListener("controllerchange", reloadOnce);
  } else {
    // An update took over. This page is still running the old code, so switch
    // to the new version at the next moment nothing is being captured.
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      const tryReload = () => (recorder || queueRunning ? setTimeout(tryReload, 5000) : location.reload());
      tryReload();
    });
  }
}

// ---------- small helpers ----------

let toastTimer;
function toast(text) {
  const el = $("#toast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2600);
}

function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
}

function defaultTitle() {
  const d = new Date();
  return "Recording " + d.toLocaleDateString(undefined, { day: "numeric", month: "short" }) + ", " +
    d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children) if (c !== null && c !== undefined) node.append(c);
  return node;
}

const bidi = (tag, text, attrs = {}) => renderBidi(el(tag, attrs), text);
const SOURCE_LABEL = { mic: "🎙 Microphone", file: "📄 Imported", call: "📞 Call recording" };

// ---------- navigation ----------

let currentView = "notes";
function showView(name) {
  currentView = name;
  for (const v of ["notes", "record", "settings"]) $("#view-" + v).hidden = v !== name;
  $("#view-note").hidden = true;
  document.body.classList.remove("detail-open");
  $$("#tabbar button").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  if (name === "notes") renderNotes();
  if (name === "settings") renderSettings();
  window.scrollTo(0, 0);
}
$$("#tabbar button").forEach((b) => b.addEventListener("click", () => showView(b.dataset.view)));

// ---------- first run ----------

function needsSetup() { return !modelReady(prefs.model); }

async function runSetup() {
  $("#setup").hidden = false;
  $("#tabbar").hidden = true;
  for (const v of ["notes", "record", "settings"]) $("#view-" + v).hidden = true;
  const radios = $$('input[name="setup-model"]');
  radios.forEach((r) => (r.checked = r.value === prefs.model));
  $("#setup-go").onclick = async () => {
    const choice = radios.find((r) => r.checked)?.value || "standard";
    prefs.model = choice; savePrefs();
    $("#setup-go").disabled = true;
    $("#setup-error").hidden = true;
    $("#setup-progress").hidden = false;
    // Building the model after the download can take a while on a phone, and
    // if Safari stalls it nothing ever reports back. So the stage is shown,
    // and a watchdog turns silence into an error the user can act on.
    const PREPARE_LIMIT_MS = 4 * 60 * 1000;
    let watchdog = null, preparingSince = 0, ticker = null;
    const stall = new Promise((_, reject) => {
      const arm = () => {
        clearTimeout(watchdog);
        watchdog = setTimeout(() => reject(new Error("Preparing the model stopped responding.")), PREPARE_LIMIT_MS);
      };
      arm();
      onModelProgress = (p) => {
        if (p.stage === "preparing") {
          if (!preparingSince) {
            preparingSince = Date.now();
            $("#setup-fill").style.width = "100%";
            const show = () => {
              const s = Math.round((Date.now() - preparingSince) / 1000);
              $("#setup-status").textContent = `Download complete. Preparing the model on this iPhone… ${s}s (usually under a minute)`;
            };
            show();
            ticker = setInterval(show, 1000);
          }
          arm();
          return;
        }
        arm();
        $("#setup-fill").style.width = Math.round((p.loaded / p.total) * 100) + "%";
        $("#setup-status").textContent = `Downloading · ${(p.loaded / 1e6).toFixed(0)} of ${(p.total / 1e6).toFixed(0)} MB`;
      };
    });
    stall.catch(() => {});
    try {
      await call("set-model", { model: choice, ios: IOS });
      await Promise.race([call("load-asr", { model: choice }), stall]);
      markModelReady(choice);
      navigator.storage?.persist?.();
      $("#setup").hidden = true;
      $("#tabbar").hidden = false;
      showView("notes");
      kickQueue();
    } catch (err) {
      const stalled = /stopped responding/.test(err.message);
      if (stalled) restartWorker(err);
      $("#setup-error").textContent = stalled
        ? "The model downloaded, but this iPhone did not finish preparing it. Tap Try again (nothing is downloaded twice). If it happens again, choose Light, which needs far less memory."
        : preparingSince
          ? "The model downloaded but could not be loaded: " + err.message + " Try again, or choose Light."
          : "The download did not finish: " + err.message + " Check the connection and try again.";
      $("#setup-error").hidden = false;
      $("#setup-go").disabled = false;
      $("#setup-go").textContent = "Try again";
    } finally {
      clearTimeout(watchdog);
      clearInterval(ticker);
      onModelProgress = null;
    }
  };
}

// ---------- notes list ----------

async function renderNotes() {
  const notes = await db.allNotes();
  const query = normalizeForIndex($("#search").value);
  const shown = query
    ? notes.filter((n) => normalizeForIndex(n.title).includes(query) || (n.indexText || "").includes(query) || normalizeForIndex(n.summary || "").includes(query))
    : notes;
  const list = $("#note-list");
  list.textContent = "";
  for (const note of shown) list.append(noteItem(note));
  $("#empty-notes").hidden = notes.length > 0;
  $("#install-hint").hidden = isStandalone() || !/iPhone|iPad/.test(navigator.userAgent);
}

function noteItem(note) {
  const statusChip = {
    recording: el("span", { class: "chip warn" }, "Recording"),
    importing: el("span", { class: "chip" }, "Importing"),
    transcribing: el("span", { class: "chip" }, "Transcribing"),
    attention: el("span", { class: "chip warn" }, "Needs attention"),
    summarizing: el("span", { class: "chip" }, "Summarizing"),
  }[note.status] || null;
  const snippet = note.summary || note.preview || "";
  const openTasks = (note.tasks || []).filter((t) => !t.done).length;
  return el("li", { class: "note-item", onclick: () => openNote(note.id) },
    el("div", { class: "top" },
      note.pinned ? el("span", { class: "pin" }, "●") : null,
      bidi("span", note.title, { class: "title" }),
      statusChip),
    snippet ? bidi("div", snippet, { class: "snippet" }) : null,
    el("div", { class: "meta" },
      el("span", {}, SOURCE_LABEL[note.source] || "Recording"),
      el("span", {}, formatDuration(note.duration)),
      el("span", {}, new Date(note.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })),
      openTasks ? el("span", {}, `☐ ${openTasks}`) : null,
      note.policy === "keep" ? el("span", {}, "Audio kept") : null));
}

$("#search").addEventListener("input", () => renderNotes());

// ---------- recording ----------

let recorder = null, recNote = null, recWrites = Promise.resolve(), recIndex = 0, levels = [];

function setPolicyUI(value) {
  $$("#policy-seg button").forEach((b) => b.classList.toggle("active", b.dataset.value === value));
  $("#policy-hint").textContent = value === "keep"
    ? "The recording is kept alongside the transcript."
    : "Audio is deleted the moment it is transcribed. Only text is kept.";
}
$$("#policy-seg button").forEach((b) => b.addEventListener("click", () => setPolicyUI(b.dataset.value)));
const chosenPolicy = () => $("#policy-seg button.active")?.dataset.value || prefs.policy;

function storeChunk(noteId, samples, startOffset) {
  const chunk = {
    id: db.uid(), noteId, index: recIndex++, startOffset,
    duration: samples.length / SAMPLE_RATE, state: "pending", attempts: 0,
    audio: floatToPCM16(samples), createdAt: Date.now(),
  };
  // Serialized so chunks land in order, and each one is stored before the
  // queue is told about it.
  recWrites = recWrites
    .then(() => db.addChunk(chunk))
    .then(() => kickQueue())
    .catch((err) => showRecError("Could not save audio to storage: " + err.message + ". Free up space on the iPhone."));
  return recWrites;
}

function showRecError(text) { $("#rec-error").textContent = text; $("#rec-error").hidden = false; }

async function startRecording() {
  $("#rec-error").hidden = true;
  if (needsSetup()) { runSetup(); return; }
  recNote = {
    id: db.uid(), title: defaultTitle(), createdAt: Date.now(), source: "mic",
    policy: chosenPolicy(), language: $("#rec-language").value, status: "recording",
    duration: 0, pinned: false, preview: "", indexText: "", tasks: [],
  };
  recIndex = 0; levels = [];
  await db.putNote(recNote);
  recorder = new Recorder({
    onChunk: (samples, start) => storeChunk(recNote.id, samples, start),
    onLevel: (dbfs) => { levels.push(dbfs); if (levels.length > 60) levels.shift(); drawWave(); },
    onElapsed: (s) => { $("#rec-time").textContent = formatDuration(s); recNote.duration = s; },
    onInterrupted: (text) => { $("#rec-interrupted-text").textContent = text + " Everything up to now is saved."; $("#rec-interrupted").hidden = false; },
    onResumed: () => { $("#rec-interrupted").hidden = true; },
  });
  try {
    await recorder.start();
  } catch (err) {
    await db.deleteNote(recNote.id);
    recorder = null; recNote = null;
    showRecError(err.name === "NotAllowedError"
      ? "Sawt needs the microphone. Allow it in Settings › Safari › Microphone, or when iOS asks."
      : "Could not start recording: " + err.message);
    return;
  }
  navigator.storage?.persist?.();
  $("#rec-idle").hidden = true;
  $("#rec-active").hidden = false;
  $("#rec-time").textContent = "0:00";
  $("#rec-preview").textContent = "";
  $("#rec-policy-badge").textContent = recNote.policy === "keep" ? "Keeping audio" : "Audio deleted after transcription";
  $("#tabbar").hidden = true;
}

async function stopRecording(discard = false) {
  if (!recorder) return;
  $("#rec-stop").disabled = true;
  await recorder.stop();
  await recWrites;
  const note = recNote;
  recorder = null; recNote = null;
  $("#rec-stop").disabled = false;
  $("#rec-active").hidden = true;
  $("#rec-interrupted").hidden = true;
  $("#rec-idle").hidden = false;
  $("#tabbar").hidden = false;
  if (discard) {
    await db.deleteNote(note.id);
    toast("Recording discarded");
    return;
  }
  // Re-read: transcription has been writing the preview and search index to
  // the stored note while recording, and the in-memory copy predates that.
  const stored = (await db.getNote(note.id)) || note;
  stored.duration = note.duration;
  stored.status = "transcribing";
  await finishIfComplete(stored);
  kickQueue();
  openNote(note.id);
}

$("#rec-start").addEventListener("click", startRecording);
$("#rec-stop").addEventListener("click", () => stopRecording(false));
$("#rec-discard").addEventListener("click", () => { if (confirm("Discard this recording? The audio and any transcript will be deleted.")) stopRecording(true); });
$("#rec-resume").addEventListener("click", async () => {
  try { await recorder?.resume(); } catch (err) { toast("Could not resume: " + err.message); }
});

function drawWave() {
  const canvas = $("#wave");
  const ctx = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--petrol").trim() || "#0E5C55";
  const barW = w / 60;
  levels.forEach((dbfs, i) => {
    const norm = Math.max(0, Math.min(1, (dbfs + 60) / 60));
    const bh = Math.max(4, h * Math.pow(norm, 1.4));
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(i * barW + 2, (h - bh) / 2, barW - 4, bh, 3) : ctx.rect(i * barW + 2, (h - bh) / 2, barW - 4, bh);
    ctx.fill();
  });
}

// ---------- import ----------

$("#import-input").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) return;
  if (needsSetup()) { runSetup(); return; }
  if (file.size > 400 * 1024 * 1024) {
    showRecError("That file is over 400 MB, which is more than Safari can decode at once. Trim it or export just the audio first.");
    return;
  }
  const isCall = /call|recording/i.test(file.name) && /\.m4a$/i.test(file.name);
  const note = {
    id: db.uid(), title: file.name.replace(/\.[^.]+$/, "") || "Imported recording", createdAt: Date.now(),
    source: isCall ? "call" : "file", policy: chosenPolicy(), language: $("#rec-language").value,
    status: "importing", duration: 0, pinned: false, preview: "", indexText: "", tasks: [],
  };
  await db.putNote(note);
  recIndex = 0; recWrites = Promise.resolve();
  $("#rec-idle").hidden = true;
  $("#rec-importing").hidden = false;
  try {
    note.duration = await importFile(file, (samples, start) => storeChunk(note.id, samples, start), (fraction, stage) => {
      $("#import-fill").style.width = Math.round(fraction * 100) + "%";
      $("#import-status").textContent = stage;
    });
    await recWrites;
    const stored = (await db.getNote(note.id)) || note;
    stored.duration = note.duration;
    stored.status = "transcribing";
    await finishIfComplete(stored);
    kickQueue();
    openNote(note.id);
  } catch (err) {
    await db.deleteNote(note.id);
    showRecError(err.message);
  } finally {
    $("#rec-importing").hidden = true;
    $("#rec-idle").hidden = false;
  }
});

// ---------- transcription queue ----------
// One chunk at a time, oldest first. No terminal failure: a chunk that keeps
// failing is marked "needs attention" with its audio kept, and can be retried.

let queueRunning = false, summarizing = false;
const MAX_ATTEMPTS = 3;

function rmsDB(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return 10 * Math.log10(Math.max(sum / Math.max(1, samples.length), 1e-12));
}

async function kickQueue() {
  if (queueRunning || summarizing || needsSetup()) return;
  queueRunning = true;
  try {
    for (;;) {
      if (summarizing) break;
      const chunk = await db.nextPendingChunk();
      if (!chunk) break;
      await processChunk(chunk);
    }
  } finally {
    queueRunning = false;
    $("#queue-banner").hidden = true;
  }
}

async function processChunk(chunk) {
  const note = await db.getNote(chunk.noteId);
  if (!note) { await db.updateChunk({ ...chunk, state: "done", audio: null }); return; }
  await db.updateChunk({ ...chunk, state: "running" });
  const banner = $("#queue-banner");
  banner.hidden = false;
  banner.replaceChildren(el("span", { class: "spinner" }), el("span", {}, `Transcribing “${note.title}”`));

  onModelProgress = ({ loaded, total }) => {
    banner.replaceChildren(el("span", { class: "spinner" }),
      el("span", {}, `Downloading the speech model · ${Math.round((loaded / total) * 100)}%`));
  };

  try {
    const audio = pcm16ToFloat(chunk.audio);
    let raw = [];
    // Whisper invents text for silence ("Thank you for watching", or the
    // Arabic "subscribe to the channel"), so a silent chunk is skipped.
    if (rmsDB(audio) > -52) {
      raw = await call("transcribe", { audio, language: note.language }, [audio.buffer]);
    }
    markModelReady(prefs.model);
    const segments = raw
      .map((s) => {
        const text0 = stripSpecialTokens(s.text).trim();
        const lang = languageTagOf(text0) || (note.language === "ar" ? "ar" : "en");
        const start = chunk.startOffset + (s.start || 0);
        const end = chunk.startOffset + (s.end ?? chunk.duration);
        return { id: db.uid(), noteId: note.id, start, end, text: normalizeForDisplay(text0, lang), lang };
      })
      .filter((s) => s.text.length > 0);

    await db.commitChunk(chunk, segments, note.policy !== "keep");

    const fresh = await db.getNote(note.id);
    // Discarded while this part was being transcribed: remove what was just written.
    if (!fresh) { await db.deleteNote(note.id); return; }
    {
      const added = segments.map((s) => s.text).join(" ");
      if ((fresh.preview || "").length < 220) fresh.preview = ((fresh.preview || "") + " " + added).trim().slice(0, 260);
      fresh.indexText = ((fresh.indexText || "") + " " + normalizeForIndex(added)).trim();
      await finishIfComplete(fresh);
    }
    noteChanged(note.id);
    if (recNote && recNote.id === note.id && segments.length) {
      $("#rec-preview").textContent = segments.slice(-3).map((s) => s.text).join(" ");
      $("#rec-preview").dir = isArabic($("#rec-preview").textContent) ? "rtl" : "ltr";
    }
  } catch (err) {
    const attempts = (chunk.attempts || 0) + 1;
    const state = attempts >= MAX_ATTEMPTS ? "attention" : "retryable";
    await db.updateChunk({ ...chunk, state, attempts, error: err.message });
    if (state === "attention") {
      const fresh = await db.getNote(note.id);
      if (fresh) { fresh.status = "attention"; await db.putNote(fresh); }
      noteChanged(note.id);
    } else {
      await new Promise((r) => setTimeout(r, 2000 * attempts));
    }
  } finally {
    onModelProgress = null;
  }
}

async function finishIfComplete(note) {
  const chunks = await db.chunksFor(note.id);
  // Audio still arriving: completion is decided when it stops.
  if (note.status === "recording" || note.status === "importing") { await db.putNote(note); return; }
  if (chunks.some((c) => c.state === "attention")) note.status = "attention";
  else if (chunks.every((c) => c.state === "done")) {
    note.status = "transcribed";
    const segments = await db.segmentsFor(note.id);
    let ar = 0, en = 0;
    for (const s of segments) { const d = Math.max(0.5, s.end - s.start); s.lang === "ar" ? (ar += d) : (en += d); }
    note.detectedLanguage = ar >= en ? "ar" : "en";
  }
  await db.putNote(note);
  // Summaries are instant and local, so every finished note gets one.
  if (note.status === "transcribed" && !note.minutes) setTimeout(() => runSummary(note.id, { quiet: true }), 0);
}

// ---------- note detail ----------

let openNoteId = null, detailTab = "summary";

async function openNote(id) {
  openNoteId = id;
  for (const v of ["notes", "record", "settings"]) $("#view-" + v).hidden = true;
  $("#view-note").hidden = false;
  document.body.classList.add("detail-open");
  window.scrollTo(0, 0);
  await renderNote();
}

function noteChanged(id) {
  if (id === openNoteId && !$("#view-note").hidden) renderNote();
  else if (currentView === "notes" && !$("#view-notes").hidden) renderNotes();
}

$("#note-back").addEventListener("click", () => { openNoteId = null; showView("notes"); });

$$("#detail-seg button").forEach((b) => b.addEventListener("click", () => {
  detailTab = b.dataset.tab;
  $$("#detail-seg button").forEach((x) => x.classList.toggle("active", x === b));
  for (const t of ["summary", "minutes", "tasks", "transcript"]) $("#tab-" + t).hidden = t !== detailTab;
}));

$("#note-title").addEventListener("blur", async (e) => {
  const note = await db.getNote(openNoteId);
  const title = e.target.textContent.trim();
  if (note && title && title !== note.title) { note.title = title; await db.putNote(note); }
});
$("#note-title").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); e.target.blur(); } });

$("#note-delete").addEventListener("click", async () => {
  if (!confirm("Delete this note? Its transcript, summary, and any kept audio will be removed.")) return;
  await db.deleteNote(openNoteId);
  openNoteId = null;
  showView("notes");
  toast("Note deleted");
});

async function renderNote() {
  const note = await db.getNote(openNoteId);
  if (!note) { showView("notes"); return; }
  const [segments, chunks] = await Promise.all([db.segmentsFor(note.id), db.chunksFor(note.id)]);

  const title = $("#note-title");
  if (document.activeElement !== title) renderBidi(title, note.title);
  $("#note-meta").textContent = [
    new Date(note.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }),
    formatDuration(note.duration),
    (SOURCE_LABEL[note.source] || "").replace(/^\S+\s/, ""),
    note.detectedLanguage ? (note.detectedLanguage === "ar" ? "Arabic" : "English") : null,
  ].filter(Boolean).join(" · ");

  // Stuck chunks: the audio is still here, and one tap retries them.
  const stuck = chunks.filter((c) => c.state === "attention");
  const attention = $("#note-attention");
  attention.hidden = stuck.length === 0;
  if (stuck.length) {
    attention.replaceChildren(
      el("b", {}, `${stuck.length} part${stuck.length > 1 ? "s" : ""} could not be transcribed`),
      el("span", {}, (stuck[0].error || "") + " The audio is still saved; nothing has been lost."),
      el("button", { class: "primary", onclick: async () => {
        for (const c of stuck) await db.updateChunk({ ...c, state: "pending", attempts: 0, error: null });
        note.status = "transcribing"; await db.putNote(note);
        kickQueue(); renderNote();
      } }, "Try again"));
  }

  const done = chunks.filter((c) => c.state === "done").length;
  const progress = $("#note-progress");
  if (!summarizing && (note.status === "transcribing" || note.status === "recording") && chunks.length) {
    progress.hidden = false;
    $("#note-fill").style.width = Math.round((done / chunks.length) * 100) + "%";
    $("#note-status").textContent = `Transcribing · ${done} of ${chunks.length} parts. This continues while Sawt is open.`;
  } else if (!summarizing) {
    progress.hidden = true;
  }

  renderSummaryTab(note, segments);
  renderMinutesTab(note, segments);
  renderTasksTab(note, segments);
  renderTranscriptTab(note, segments);
}

function transcriptReady(note, segments) {
  return segments.length > 0 && note.status !== "transcribing" && note.status !== "recording";
}

function summaryPrompt(note, segments, target) {
  if (!transcriptReady(note, segments)) {
    return el("div", { class: "panel-empty" }, segments.length ? "The summary can be made once transcription finishes." : "Nothing has been transcribed yet.");
  }
  return el("div", { class: "panel-empty" },
    el("p", {}, `No ${target} yet.`),
    el("button", { class: "primary", onclick: () => runSummary(note.id) }, "Generate summary"));
}

function renderSummaryTab(note, segments) {
  const panel = $("#tab-summary");
  panel.textContent = "";
  if (!note.keyPoints?.length && !note.summary) { panel.append(summaryPrompt(note, segments, "summary or key points")); return; }
  if (note.summary) panel.append(bidi("div", note.summary, { class: "summary-box" }));
  if (note.keyPoints?.length) {
    panel.append(el("h3", { class: "panel-h" }, "Key points"));
    const ul = el("ul", { class: "points" });
    note.keyPoints.forEach((p) => ul.append(bidi("li", p)));
    panel.append(ul);
  }
  panel.append(el("p", { class: "foot" }, "Picked from what was actually said, on this iPhone. Nothing is reworded or invented."),
    el("button", { class: "ghost", onclick: () => runSummary(note.id) }, "Regenerate"));
}

function renderMinutesTab(note, segments) {
  const panel = $("#tab-minutes");
  panel.textContent = "";
  if (!note.minutes) { panel.append(summaryPrompt(note, segments, "minutes")); return; }
  const body = el("div", { class: "minutes-body" });
  let list = null;
  for (const line of note.minutes.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith("#")) { list = null; body.append(bidi("h3", t.replace(/^#+\s*/, ""))); }
    else if (/^[-*•]\s/.test(t)) { if (!list) { list = el("ul"); body.append(list); } list.append(bidi("li", t.replace(/^[-*•]\s+/, ""))); }
    else { list = null; body.append(bidi("p", t)); }
  }
  panel.append(body);
}

function renderTasksTab(note, segments) {
  const panel = $("#tab-tasks");
  panel.textContent = "";
  if (!note.tasks?.length) {
    panel.append(note.keyPoints ? el("div", { class: "panel-empty" }, "Nobody committed to anything specific in this meeting.") : summaryPrompt(note, segments, "action items"));
    return;
  }
  note.tasks.forEach((task, i) => {
    const box = el("input", { type: "checkbox", "aria-label": "Done" });
    box.checked = !!task.done;
    box.addEventListener("change", async () => {
      const fresh = await db.getNote(note.id);
      fresh.tasks[i].done = box.checked;
      await db.putNote(fresh);
      row.classList.toggle("done", box.checked);
    });
    const meta = [task.owner ? "👤 " + task.owner : null, task.due ? "📅 " + task.due : null].filter(Boolean).join("   ");
    const row = el("div", { class: "task" + (task.done ? " done" : "") }, box,
      el("div", {}, bidi("div", task.title, { class: "t-title" }), meta ? el("div", { class: "t-meta" }, meta) : null));
    panel.append(row);
  });
  panel.append(el("button", { class: "ghost", onclick: async () => {
    const text = note.tasks.map((t) => `${t.done ? "☑" : "☐"} ${t.title}${t.owner ? " — " + t.owner : ""}${t.due ? " (" + t.due + ")" : ""}`).join("\n");
    try { const how = await shareText(note.title + " — tasks", text); if (how === "copied") toast("Tasks copied"); }
    catch (err) { if (err.name !== "AbortError") toast("Could not share: " + err.message); }
  } }, "Share tasks (to Reminders, Notes, or a message)"));
}

function renderTranscriptTab(note, segments) {
  const panel = $("#tab-transcript");
  panel.textContent = "";
  if (!segments.length) {
    panel.append(el("div", { class: "panel-empty" }, note.status === "transcribing" ? "Transcribing… text appears here part by part." : "Nothing was transcribed."));
    return;
  }
  for (const seg of segments) {
    panel.append(el("div", { class: "seg" }, el("div", { class: "stamp" }, formatDuration(seg.start)), bidi("p", seg.text)));
  }
}

// ---------- summaries (on-device, extractive) ----------

function outputLanguage(note) {
  if (prefs.summaryLang === "en" || prefs.summaryLang === "ar") return prefs.summaryLang;
  return note.detectedLanguage === "ar" ? "ar" : "en";
}

async function runSummary(noteId, { quiet = false } = {}) {
  if (summarizing) return;
  summarizing = true;
  try {
    const segments = await db.segmentsFor(noteId);
    if (!segments.length) return;
    const fresh = await db.getNote(noteId);
    const result = summarize(segments, outputLanguage(fresh));
    // Keep ticks the user already made on tasks that survive a regenerate.
    const done = new Set((fresh.tasks || []).filter((t) => t.done).map((t) => t.title));
    result.tasks.forEach((t) => (t.done = done.has(t.title)));
    Object.assign(fresh, result);
    await db.putNote(fresh);
    if (!quiet) toast("Summary updated");
  } catch (err) {
    toast("Summarizing failed: " + err.message);
  } finally {
    summarizing = false;
    kickQueue();
    if (openNoteId === noteId) renderNote();
    noteChanged(noteId);
  }
}

// ---------- export ----------

const FORMAT_LABEL = { docx: "Create Word (.docx)", pdf: "Create PDF", md: "Create Markdown", txt: "Create plain text", notes: "Send to Notes" };

$("#note-export").addEventListener("click", async () => {
  const note = await db.getNote(openNoteId);
  $("#inc-kp").disabled = !note.keyPoints?.length; $("#inc-kp").checked = !!note.keyPoints?.length;
  $("#inc-min").disabled = !note.minutes; $("#inc-min").checked = !!note.minutes;
  $("#inc-tasks").disabled = !note.tasks?.length; $("#inc-tasks").checked = !!note.tasks?.length;
  $("#export-note").textContent = note.keyPoints?.length ? "" : "This note has no summary yet, so only the transcript can be exported.";
  resetExportButton();
  $("#export-sheet").hidden = false;
});
$("#export-cancel").addEventListener("click", () => ($("#export-sheet").hidden = true));
$("#export-sheet").addEventListener("click", (e) => { if (e.target.id === "export-sheet") $("#export-sheet").hidden = true; });
$$('input[name="fmt"]').forEach((r) => r.addEventListener("change", () => {
  $("#export-note").textContent = r.value === "pdf" ? "The PDF keeps Arabic laid out correctly; its text is an image and cannot be selected." : "";
}));

// Two steps: build the file, then share it from a fresh tap. iOS only opens the
// share sheet during a user gesture, and building a long PDF outlasts the one
// that started it.
let prepared = null;

function resetExportButton() {
  prepared = null;
  const format = $$('input[name="fmt"]').find((r) => r.checked).value;
  $("#export-go").textContent = FORMAT_LABEL[format];
}
$$('input[name="fmt"]').forEach((r) => r.addEventListener("change", resetExportButton));
["#inc-kp", "#inc-min", "#inc-tasks", "#inc-tr"].forEach((id) => $(id).addEventListener("change", resetExportButton));

$("#export-go").addEventListener("click", async () => {
  const button = $("#export-go");
  if (prepared) {
    const job = prepared;
    try {
      // Called straight from the tap, before any await.
      const how = job.text !== undefined ? await shareText(job.title, job.text) : await deliver(job.blob, job.name);
      $("#export-sheet").hidden = true;
      resetExportButton();
      if (how === "downloaded") toast("Saved to Downloads");
      if (how === "copied") toast("Copied. Paste it into Notes.");
    } catch (err) {
      if (err.name !== "AbortError") toast("Could not share: " + err.message);
    }
    return;
  }

  const note = await db.getNote(openNoteId);
  const segments = await db.segmentsFor(openNoteId);
  const sel = { keyPoints: $("#inc-kp").checked, minutes: $("#inc-min").checked, tasks: $("#inc-tasks").checked, transcript: $("#inc-tr").checked };
  if (!Object.values(sel).some(Boolean)) { toast("Choose at least one section"); return; }
  const doc = buildDocument(note, segments, sel);
  const format = $$('input[name="fmt"]').find((r) => r.checked).value;
  const name = safeFileName(note.title);
  button.disabled = true;
  button.textContent = "Preparing…";
  try {
    if (format === "docx") prepared = { blob: toDocx(doc), name: name + ".docx" };
    else if (format === "pdf") prepared = { blob: await toPDF(doc), name: name + ".pdf" };
    else if (format === "md") prepared = { blob: new Blob([toMarkdown(doc)], { type: "text/markdown" }), name: name + ".md" };
    else if (format === "txt") prepared = { blob: new Blob([toPlainText(doc)], { type: "text/plain" }), name: name + ".txt" };
    else prepared = { title: note.title, text: toPlainText(doc) };
    button.textContent = prepared.name ? `Share ${prepared.name}` : "Share to Notes";
  } catch (err) {
    toast("Export failed: " + err.message);
    resetExportButton();
  } finally {
    button.disabled = false;
  }
});

// ---------- settings ----------

async function renderSettings() {
  $("#set-policy").value = prefs.policy;
  $("#set-language").value = prefs.language;
  $("#set-model").value = prefs.model;
  $("#set-summary-lang").value = prefs.summaryLang;
  $("#set-version").textContent = "Version " + VERSION;
  const est = await db.storageEstimate();
  $("#set-storage").textContent = est ? `${(est.usage / 1e6).toFixed(0)} MB` : "Unknown";
  const persisted = await navigator.storage?.persisted?.();
  $("#set-persist").textContent = persisted ? "Yes" : isStandalone() ? "Not yet" : "Add to Home Screen first";
  $("#set-summary-status").textContent = "On this iPhone · instant";
}

$("#set-policy").addEventListener("change", (e) => { prefs.policy = e.target.value; savePrefs(); setPolicyUI(prefs.policy); });
$("#set-language").addEventListener("change", (e) => { prefs.language = e.target.value; savePrefs(); $("#rec-language").value = prefs.language; });
$("#set-summary-lang").addEventListener("change", (e) => { prefs.summaryLang = e.target.value; savePrefs(); });
$("#set-model").addEventListener("change", async (e) => {
  prefs.model = e.target.value; savePrefs();
  await call("set-model", { model: prefs.model, ios: IOS });
  if (needsSetup()) runSetup();
});
$("#set-clear-models").addEventListener("click", async () => {
  if (!confirm("Delete the downloaded models? Your notes are kept. You will download a model again before your next transcription.")) return;
  await call("unload");
  try { await caches.delete("transformers-cache"); } catch {}
  for (const key of ["light", "standard"]) { try { localStorage.removeItem("sawt-model-" + key); } catch {} }
  toast("Models deleted");
  renderSettings();
});

// ---------- start ----------

async function start() {
  setPolicyUI(prefs.policy);
  $("#rec-language").value = prefs.language;
  await call("set-model", { model: prefs.model, ios: IOS });
  const recovered = await db.recoverInterrupted();
  // A note still marked "recording" belongs to a closed tab: its chunks are
  // saved, so it simply continues as a transcription.
  for (const note of await db.allNotes()) {
    if (note.status === "recording" || note.status === "importing") { note.status = "transcribing"; await finishIfComplete(note); }
    else if (note.status === "transcribed" && !note.minutes) await runSummary(note.id, { quiet: true });
  }
  if (needsSetup()) { runSetup(); return; }
  showView("notes");
  if (recovered) toast(`Picked up ${recovered} unfinished part${recovered > 1 ? "s" : ""} from last time`);
  kickQueue();
}

// Warn before a reload or close would cut a recording short.
window.addEventListener("beforeunload", (e) => { if (recorder) { e.preventDefault(); e.returnValue = ""; } });

start().catch((err) => {
  document.body.innerHTML = `<p style="padding:40px 24px;font:16px -apple-system,sans-serif">Sawt could not start: ${String(err.message).replace(/</g, "&lt;")}. Your notes are still stored on this iPhone; try reopening the app.</p>`;
});
