// UniSocial — service worker (notificações no dispositivo)
// Tem de ficar na mesma pasta do index.html e ser servido por HTTPS.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins.length) {
      const w = wins[0];
      await w.focus();
      if (data.uid) w.postMessage({ type: 'chat', uid: data.uid });
    } else {
      await self.clients.openWindow('./');
    }
  })());
});
