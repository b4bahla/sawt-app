// Service worker: offline app shell, plus the COOP/COEP headers that give the
// page cross-origin isolation, which ONNX Runtime needs for multithreaded WASM.
// Static hosts such as GitHub Pages cannot set those headers themselves.
//
// Model weights are not cached here; transformers.js keeps them in its own
// Cache Storage entry ("transformers-cache"), which this worker never touches.

const VERSION = "sawt-shell-v1.1.1";
const SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./css/app.css",
  "./js/app.js",
  "./js/audio.js",
  "./js/capture-worklet.js",
  "./js/db.js",
  "./js/export.js",
  "./js/summarize.js",
  "./js/text.js",
  "./js/worker.js",
  "./vendor/transformers.min.js",
  "./icons/icon-180.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  // cache: "reload" skips the browser HTTP cache. Without it, a host's
  // max-age lets the new worker install yesterday's files as today's shell.
  event.waitUntil(
    caches.open(VERSION)
      .then((cache) => cache.addAll(SHELL.map((url) => new Request(url, { cache: "reload" }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith("sawt-shell-") && key !== VERSION) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

function isolate(response) {
  if (!response || response.status === 0 || response.type === "opaque") return response;
  const headers = new Headers(response.headers);
  headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  // Cross-origin (Hugging Face, the ONNX Runtime CDN): straight to the network.
  // Those requests are CORS, which satisfies require-corp.
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const cached = await cache.match(request, { ignoreSearch: true });
    // Stale-while-revalidate: open instantly offline, refresh when online.
    // Revalidate with the server rather than trusting the HTTP cache, so an
    // update reaches the phone on the next online launch.
    const network = fetch(request, { cache: "no-cache" })
      .then((response) => {
        if (response.ok) cache.put(request, response.clone());
        return response;
      })
      .catch(() => null);
    const response = cached || (await network) || (request.mode === "navigate" ? await cache.match("./index.html") : null);
    return response ? isolate(response) : new Response("Offline", { status: 503 });
  })());
});
