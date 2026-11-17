// アプリ本体だけをキャッシュしてオフラインでも開けるようにする（GitHub API は常にネットワーク）
const CACHE = 'tap-diary-2026-11-17d';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'bucket.js', 'manifest.json', 'icon-180.png', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => e.waitUntil(
  caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting())
));
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())
));
self.addEventListener('fetch', e => {
  if (new URL(e.request.url).origin !== location.origin) return;
  // GitHub Pages は10分間ブラウザにキャッシュさせるので、毎回サーバーに新しい版がないか確かめる
  e.respondWith(fetch(e.request, { cache: 'no-cache' }).then(res => {
    const copy = res.clone();
    caches.open(CACHE).then(c => c.put(e.request, copy));
    return res;
  }).catch(() => caches.match(e.request)));
});
