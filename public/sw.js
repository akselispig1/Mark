// Service worker: turns Mark's push into an incoming-call notification.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  const d = e.data ? e.data.json() : { title: 'MARK', body: '' };
  if (d.url) {                                   // approval request: tap to approve with Face ID
    e.waitUntil(self.registration.showNotification(d.title, {
      body: d.body, tag: d.tag || 'mark', renotify: true, requireInteraction: true, vibrate: [200, 100, 200],
      icon: '/icon.svg', badge: '/icon.svg', data: { url: d.url }, actions: [{ action: 'open', title: 'Approve' }, { action: 'decline', title: 'Ignore' }],
    }));
    return;
  }
  e.waitUntil(self.registration.showNotification(d.title, {
    body: d.body,
    tag: 'mark-call',
    renotify: true,
    requireInteraction: true,
    vibrate: [600, 300, 600, 300, 600, 300, 600, 300, 600],
    icon: '/icon.svg',
    badge: '/icon.svg',
    data: { id: d.id },
    actions: [{ action: 'answer', title: 'Answer' }, { action: 'decline', title: 'Decline' }],
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  if (e.action === 'decline') return;
  const url = e.notification.data?.url || '/?call=' + encodeURIComponent(e.notification.data?.id || '');
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) { if ('focus' in w) { await w.navigate(url).catch(() => {}); return w.focus(); } }
    return self.clients.openWindow(url);
  })());
});
