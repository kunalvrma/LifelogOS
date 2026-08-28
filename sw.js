/**
 * Lifelog service worker — offline shell only.
 *
 * This exists so tapping the hourly notification opens a usable screen instantly, and
 * still opens one with no signal. It does NOT do notifications: a PWA cannot fire
 * scheduled local ones (the Notification Triggers API never shipped past origin trial,
 * and Web Push requires a server to initiate). MacroDroid owns pings. See SPEC.md.
 *
 * Bump CACHE when the shell file list changes, or when a shell update must land
 * deterministically rather than via stale-while-revalidate — e.g. alongside a backend
 * or data-contract change, so the HUD and the server flip together on the next open.
 */

var CACHE = 'lifelog-v7';
var SHELL = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE)
      .then(function (c) { return c.addAll(SHELL); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;

  // Only the local shell is ever served from cache. Anything cross-origin — above all
  // the Apps Script endpoint — goes straight to the network. A cached write response
  // would be indistinguishable from a real one, which is the failure mode this whole
  // system is built to avoid.
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;

  e.respondWith(
    caches.match(req).then(function (hit) {
      if (!hit) return fetch(req);

      // Stale-while-revalidate: serve instantly, refresh underneath, so a deploy lands
      // on the next open instead of never.
      fetch(req).then(function (res) {
        if (res && res.ok) {
          caches.open(CACHE).then(function (c) { c.put(req, res.clone()); });
        }
      }).catch(function () { /* offline: the cached copy is the answer */ });

      return hit;
    })
  );
});
