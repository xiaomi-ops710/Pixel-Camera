```javascript
const CACHE_NAME = 'silent-camera-v1';
const ASSETS = [
  'index.html',
  'manifest.json',
  'sw.js',
  'icon-152.png',
  'icon-167.png',
  'icon-180.png',
  'icon-192.png'
];

// インストール時に必要なリソースをキャッシュする
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS);
    }).then(() => self.skipWaiting())
  );
});

// アクティベート時に古いキャッシュを消去する
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// キャッシュがあればキャッシュから、なければネットワークからリソースを取得
self.addEventListener('fetch', (e) => {
  // カメラストリームの権限取得などAPI通信はキャッシュさせない
  if (e.request.url.startsWith('http')) {
    e.respondWith(
      caches.match(e.request).then((cachedResponse) => {
        if (cachedResponse) {
          return cachedResponse;
        }
        return fetch(e.request);
      })
    );
  }
});

```
