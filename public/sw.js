// Every ad-network service worker was removed from this site.
//
// The file stays at /sw.js on purpose: browsers that already installed the old
// 5gvci ad worker keep it alive until a same-scope update replaces it, and an
// updated worker whose script no longer imports the ad bundle is exactly how
// that worker gets retired. This one registers nothing and, on activation,
// clears the caches the old worker created and unregisters itself so the site
// runs without any background ad process.
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    } catch (e) {}
    try {
      await self.registration.unregister();
    } catch (e) {}
  })());
});
