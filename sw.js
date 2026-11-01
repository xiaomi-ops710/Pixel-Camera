/* 無音カメラ Service Worker
   ・アプリ本体(HTML/CSS/JS)は「ネットワーク優先」: オンラインなら毎回サーバーから最新を取得し、
     オフラインの時だけキャッシュを使う。古い版が表示され続ける問題を防ぐ。
   ・Google Fonts(アイコン)と画像類は「キャッシュ優先」(変わらないため)。 */
const VERSION = 'v15';
const CACHE = 'silentcam-shell-' + VERSION;
const FONTS = 'silentcam-fonts';
const SHELL = [
  './', 'index.html', 'styles.css', 'icons.css', 'icons/ms-outlined.woff', 'icons/ms-outlined.ttf',
  'icons/ms-filled.woff', 'icons/ms-filled.ttf', 'app.js', 'scan.js', 'capture.js', 'gallery.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png'
];

self.addEventListener('install', e => {
  // 新しい版をすぐ有効にする(待たされないように)
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== FONTS).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(() => self.clients.matchAll({ type: 'window' }))
      .then(list => list.forEach(c => c.postMessage({ type: 'SW_ACTIVATED', version: VERSION })))
  );
});

self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

function networkFirst(req) {
  // cache:'no-cache' で HTTPキャッシュを使わず、必ずサーバーに確認する
  return fetch(req, { cache: 'no-cache' }).then(res => {
    if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req, { ignoreSearch: true }).then(hit => hit || (req.mode === 'navigate' ? caches.match('index.html') : undefined)));
}
function cacheFirst(req, cacheName) {
  return caches.match(req).then(hit => hit || fetch(req).then(res => {
    if (res && (res.ok || res.type === 'opaque')) { const copy = res.clone(); caches.open(cacheName).then(c => c.put(req, copy)); }
    return res;
  }));
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (/^fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)) { e.respondWith(cacheFirst(req, FONTS)); return; }
  if (url.origin !== location.origin) return;
  e.respondWith(networkFirst(req));
});
