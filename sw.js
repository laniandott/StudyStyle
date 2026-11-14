const CACHE_NAME = 'studystyle-app-v8';
const NETWORK_TIMEOUT_MS = 2500;
const APP_SHELL = [
  '/',
  '/index.html',
  '/styles.css',
  '/styles/tokens.css',
  '/styles/layout.css',
  '/styles/components.css',
  '/styles/views.css',
  '/styles/glass-responsive.css',
  '/domain.cjs',
  '/src/state.js',
  '/src/store.js',
  '/src/views.js',
  '/src/review.js',
  '/app.js',
  '/vendor/pouchdb.min.js',
  '/manifest.webmanifest',
  '/favicon.svg',
  '/icon.svg',
  '/apple-touch-icon.png',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/healthz') return;

  /* 弱网/假在线（Lie-Fi）超时兜底：若命中离线缓存，网络超过 2.5s 未返回即刻切缓存，后台继续更新 */
  const networkPromise = fetch(req).then(res => {
    if (res && res.ok && res.type === 'basic') {
      const copy = res.clone();
      event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.put(req, copy)).catch(() => {}));
    }
    return res;
  });
  event.waitUntil(networkPromise.catch(() => {}));

  event.respondWith((async () => {
    const cached = (await caches.match(req)) || (req.mode === 'navigate' ? ((await caches.match('/index.html')) || (await caches.match('/'))) : null);
    if (!cached) {
      return networkPromise.catch(() => new Response('Offline', { status: 503, statusText: 'Service Unavailable' }));
    }
    let timerId = null;
    try {
      const networkRes = await Promise.race([
        networkPromise,
        new Promise(resolve => { timerId = setTimeout(() => resolve(cached), NETWORK_TIMEOUT_MS); })
      ]);
      if (networkRes && networkRes.status >= 500) return cached;
      return networkRes;
    } catch {
      return cached;
    } finally {
      if (timerId) clearTimeout(timerId);
    }
  })());
});
