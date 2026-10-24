// UniSocial - service worker (notificações no dispositivo)
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

// Ao tocar na notificação: abre/foca o site e leva à conversa
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const uid = e.notification.data && e.notification.data.uid;
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
      for (const c of cs) {
        if ('focus' in c) {
          if (uid) c.postMessage({ type: 'chat', uid });
          return c.focus();
        }
      }
      return self.clients.openWindow('./');
    })
  );
});
