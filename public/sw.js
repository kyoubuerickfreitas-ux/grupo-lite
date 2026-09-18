// Service worker do Concord — só o essencial pra deixar o app instalável
// e abrir rápido offline (tela de login). O chat/voz em si precisa de
// conexão mesmo, então não tentamos cachear nada relacionado ao Socket.IO.

const CACHE_NAME = 'concord-v1';

const APP_SHELL = [
  '/',
  '/index.html',
  '/style.css',
  '/client.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .catch((err) => console.error('[SW] falha ao cachear app shell', err))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Nunca interceptar Socket.IO (polling/websocket) — precisa ir direto pra rede.
  if (url.pathname.startsWith('/socket.io/')) return;

  // Só lidamos com GET; o resto (se houver) segue normal.
  if (req.method !== 'GET') return;

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).catch(() => cached);
    })
  );
});
