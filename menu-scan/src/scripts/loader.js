export function initLoader() {
  const el = document.getElementById('loader');
  if (!el) return;

  console.log('[MenuScan] Loader start');

  function hide() {
    el.classList.add('hidden');
    el.addEventListener('transitionend', () => el.remove(), { once: true });
    console.log('[MenuScan] Loader hidden');
  }

  setTimeout(hide, 2500);
}
