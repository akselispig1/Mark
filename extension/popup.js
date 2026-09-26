const $ = (id) => document.getElementById(id);
chrome.storage.local.get(['url', 'status']).then(({ url, status }) => {
  $('url').value = url || 'http://localhost:7777';
  $('status').textContent = `Status: ${status || 'not linked'}`;
});
$('save').onclick = async () => {
  const token = $('token').value.trim();
  await chrome.storage.local.set({ url: $('url').value.trim() || 'http://localhost:7777', ...(token ? { token } : {}) });
  $('status').textContent = 'Status: connecting…';
  setTimeout(async () => { $('status').textContent = `Status: ${(await chrome.storage.local.get('status')).status}`; }, 1500);
};
