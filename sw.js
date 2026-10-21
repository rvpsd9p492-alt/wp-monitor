// Offline-Cache: alles wird beim ersten Besuch geladen; danach kommt die App aus dem Cache
// und aktualisiert sich im Hintergrund, sobald Netz da ist (beim nächsten Start aktiv).
// Bei jeder Änderung an den Dateien CACHE hochzählen, damit Geräte die neue Version vollständig laden.
const CACHE = "wp-monitor-v4";
const ASSETS = [
  "./",
  "css/style.css",
  "js/config.js",
  "js/calc.js",
  "js/defaults.js",
  "js/report.js",
  "js/store.js",
  "js/cloud.js",
  "js/app.js",
  "vendor/chart.umd.js",
  "manifest.webmanifest",
  "icons/apple-touch-icon.png",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: "reload" }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      // nur eigene alte Caches löschen: die Leichtathletik-App liegt auf derselben Domain
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("wp-monitor-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function cacheKey(req) {
  const url = new URL(req.url);
  url.hash = "";
  url.search = "";
  if (url.pathname.endsWith("/index.html")) url.pathname = url.pathname.slice(0, -"index.html".length);
  return url.href;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  const key = cacheKey(req);

  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(key);
      const update = fetch(req)
        .then((res) => {
          if (res.ok && !res.redirected) cache.put(key, res.clone());
          return res;
        })
        .catch(() => undefined);
      if (cached) {
        event.waitUntil(update);
        return cached;
      }
      const res = await update;
      if (res) return res;
      if (req.mode === "navigate") {
        const home = await cache.match(new URL("./", self.registration.scope).href);
        if (home) return home;
      }
      return new Response("Offline", { status: 503, statusText: "Offline" });
    })
  );
});
