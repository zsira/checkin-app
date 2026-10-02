// Service Worker - 让应用可安装到主屏幕并支持离线基本功能与后台推送
const CACHE = 'checkin-v14';
const ASSETS = [
  './',
  './index.html',
  './admin.html',
  './app.js',
  './admin.js',
  './style.css',
  './manifest.json',
  './manifest-admin.json',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// 网络优先，失败回退缓存；API 请求不缓存
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/api/')) return; // 不缓存 API

  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const clone = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, clone));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});

// ---------- 后台推送（页面关闭/锁屏时也能收到） ----------
self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { data = { title: '打卡通知', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      // 已有可见页面：转发给页面显示轻提示，不重复弹系统通知
      const visible = list.find((c) => c.visibilityState === 'visible');
      if (visible) {
        visible.postMessage({ type: 'server-push', payload: data });
        return;
      }
      const title = data.title || '打卡通知';
      return self.registration.showNotification(title, {
        body: data.body || '',
        icon: 'icon-192.png',
        badge: 'icon-192.png',
        tag: data.tag || 'checkin',
        renotify: true,
        requireInteraction: false,
        data: { url: data.url || './' },
      });
    })
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ('focus' in client) {
          client.navigate(target);
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    })
  );
});

self.addEventListener('pushsubscriptionchange', (e) => {
  // 订阅自动轮换时重新登记
  e.waitUntil(
    fetch('./api/push/vapid-key')
      .then((r) => r.json())
      .then(({ key }) =>
        self.registration.pushManager.subscribe(
          key
            ? { userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) }
            : { userVisibleOnly: true }
        )
      )
      .then((sub) =>
        fetch('./api/push/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ subscription: sub, scope: 'user' }),
        })
      )
      .catch(() => {})
  );
});

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const raw = atob((base64String + padding).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; ++i) out[i] = raw.charCodeAt(i);
  return out;
}
