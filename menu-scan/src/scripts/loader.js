export function initLoader() {
  const el = document.getElementById('loader');
  if (!el) return;

  console.log('[MenuScan] Loader start');

  function hide() {
    el.classList.add('hidden');
    el.addEventListener('transitionend', () => {
      el.remove();
      const firstFocusable = document.querySelector('a, button, [tabindex="0"]');
      if (firstFocusable) firstFocusable.focus();
    }, { once: true });
    console.log('[MenuScan] Loader hidden');
  }

  setTimeout(hide, 2500);
}
