/* 無音カメラ Service Worker — アプリシェルをキャッシュして完全オフライン動作 */
const CACHE = 'silentcam-v4';
const FONTS = 'silentcam-fonts';
const SHELL = [
  './', 'index.html', 'styles.css', 'icons.css', 'icons/ms-outlined.woff', 'icons/ms-outlined.ttf', 'icons/ms-filled.woff', 'icons/ms-filled.ttf', 'app.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== FONTS).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// stale-while-revalidate(まずキャッシュ、裏で更新)
self.addEventListener('fetch', e => {
  const req = e.request;
  // Google Fonts(アイコン)は初回取得後にキャッシュしてオフラインでも表示
  if (req.method === 'GET' && /^fonts\.(googleapis|gstatic)\.com$/.test(new URL(req.url).hostname)) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res && (res.ok || res.type === 'opaque')) { const copy = res.clone(); caches.open(FONTS).then(c => c.put(req, copy)); }
      return res;
    })));
    return;
  }
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then(hit => {
      const net = fetch(req).then(res => {
        if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
        return res;
      }).catch(() => hit || (req.mode === 'navigate' ? caches.match('index.html') : undefined));
      return hit || net;
    })
  );
});
