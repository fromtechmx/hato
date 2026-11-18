// HATO · service worker: guarda la app en el teléfono para abrirla sin conexión.
// Nunca guarda respuestas de Supabase (datos ni sesión): solo los archivos de la propia app.
const VERSION = 'hato-v3';
const ARCHIVOS = [
  './', 'index.html', 'app.js', 'lib.js', 'store.js', 'api.js', 'sync.js', 'config.js',
  'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(ARCHIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return; // lo de otros orígenes (Supabase) pasa directo
  // Primero la red (para recibir versiones nuevas); si no hay conexión, lo guardado.
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) { const copia = res.clone(); caches.open(VERSION).then((c) => c.put(req, copia)); }
        return res;
      })
      .catch(() => caches.match(req).then((r) => r || (req.mode === 'navigate' ? caches.match('index.html') : Response.error()))),
  );
});
