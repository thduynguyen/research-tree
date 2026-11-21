const field = document.getElementById('app');
chrome.storage.sync.get('app').then(({ app }) => (field.value = app || ''));
document.getElementById('save').addEventListener('click', async () => {
  const value = field.value.trim();
  const status = document.getElementById('status');
  if (value && !/^https?:\/\/\S+$/i.test(value)) return (status.textContent = 'Give a full address, starting with http:// or https://');
  await chrome.storage.sync.set({ app: value });
  status.textContent = 'Saved.';
});
