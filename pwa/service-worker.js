const VERSION = 'dsh-pwa-v1'

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key.startsWith('dsh-pwa-') && key !== VERSION)
          .map((key) => caches.delete(key)),
      ))
      .then(() => self.clients.claim()),
  )
})

// Chromium-based mobile browsers require a fetch-capable worker before they
// offer the native PWA install path. Keep every request network-only: DSH pages
// and authenticated API responses must never be written to an offline cache.
self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request))
})
