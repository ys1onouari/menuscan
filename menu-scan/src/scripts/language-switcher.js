import { changeLanguage } from './i18n.js';

export function initLanguageSwitcher() {
  document.querySelectorAll('.lang-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const lang = btn.getAttribute('data-lang');
      changeLanguage(lang);
    });
  });

  document.addEventListener('languagechange', updateActiveButton);
  updateActiveButton();
}

function updateActiveButton() {
  const currentLang = document.documentElement.lang;
  document.querySelectorAll('.lang-btn').forEach((btn) => {
    const isActive = btn.getAttribute('data-lang') === currentLang;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-checked', isActive.toString());
  });
}
