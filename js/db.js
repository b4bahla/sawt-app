// IndexedDB storage. Same model as the native app's SwiftData store:
// notes, transcript segments, and a write-ahead log of audio chunks.
//
// A chunk row is written in the same transaction as its audio, so a row always
// means the audio is there - the web version of "fsync before registering".

const DB_NAME = "sawt";
const DB_VERSION = 1;
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore("notes", { keyPath: "id" });
      const seg = db.createObjectStore("segments", { keyPath: "id" });
      seg.createIndex("noteId", "noteId");
      const chunks = db.createObjectStore("chunks", { keyPath: "id" });
      chunks.createIndex("noteId", "noteId");
      chunks.createIndex("state", "state");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("Storage transaction aborted"));
  });
}

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));

export async function putNote(note) {
  const db = await open();
  const tx = db.transaction("notes", "readwrite");
  tx.objectStore("notes").put({ ...note, updatedAt: Date.now() });
  await done(tx);
}

export async function getNote(id) {
  const db = await open();
  return request(db.transaction("notes").objectStore("notes").get(id));
}

export async function allNotes() {
  const db = await open();
  const notes = await request(db.transaction("notes").objectStore("notes").getAll());
  return notes.sort((a, b) => (b.pinned - a.pinned) || (b.createdAt - a.createdAt));
}

export async function deleteNote(id) {
  const db = await open();
  const tx = db.transaction(["notes", "segments", "chunks"], "readwrite");
  tx.objectStore("notes").delete(id);
  for (const store of ["segments", "chunks"]) {
    const index = tx.objectStore(store).index("noteId");
    const keys = await request(index.getAllKeys(id));
    for (const key of keys) tx.objectStore(store).delete(key);
  }
  await done(tx);
}

export async function segmentsFor(noteId) {
  const db = await open();
  const rows = await request(db.transaction("segments").objectStore("segments").index("noteId").getAll(noteId));
  return rows.sort((a, b) => a.start - b.start);
}

/** Commits a chunk's transcript and, under transcribe-only, drops its audio - in one transaction. */
export async function commitChunk(chunk, segments, discardAudio) {
  const db = await open();
  const tx = db.transaction(["segments", "chunks"], "readwrite");
  for (const seg of segments) tx.objectStore("segments").put(seg);
  const updated = { ...chunk, state: "done", error: null };
  if (discardAudio) { updated.audio = null; updated.audioDiscarded = true; }
  tx.objectStore("chunks").put(updated);
  await done(tx);
}

export async function addChunk(chunk) {
  const db = await open();
  const tx = db.transaction("chunks", "readwrite");
  tx.objectStore("chunks").put(chunk);
  await done(tx);
}

export async function updateChunk(chunk) {
  const db = await open();
  const tx = db.transaction("chunks", "readwrite");
  tx.objectStore("chunks").put(chunk);
  await done(tx);
}

export async function chunksFor(noteId) {
  const db = await open();
  const rows = await request(db.transaction("chunks").objectStore("chunks").index("noteId").getAll(noteId));
  return rows.sort((a, b) => a.index - b.index);
}

/** Oldest outstanding chunk across all notes, or null. */
export async function nextPendingChunk() {
  const db = await open();
  const store = db.transaction("chunks").objectStore("chunks");
  const pending = await request(store.index("state").getAll("pending"));
  const retry = await request(store.index("state").getAll("retryable"));
  const all = [...pending, ...retry].filter((c) => c.audio);
  all.sort((a, b) => (a.createdAt - b.createdAt) || (a.index - b.index));
  return all[0] || null;
}

/**
 * Launch-time recovery: a chunk left "running" by a closed tab goes back to
 * pending. Its audio is still in the row, so nothing is lost.
 */
export async function recoverInterrupted() {
  const db = await open();
  const tx = db.transaction("chunks", "readwrite");
  const store = tx.objectStore("chunks");
  const running = await request(store.index("state").getAll("running"));
  for (const chunk of running) store.put({ ...chunk, state: "pending" });
  await done(tx);
  return running.length;
}

export async function storageEstimate() {
  if (!navigator.storage?.estimate) return null;
  return navigator.storage.estimate();
}
