import i18next from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import fr from '../locales/fr.js';

const SUPPORTED = ['fr', 'en', 'es', 'ar'];
const loaded = new Set(['fr']);
let initialized = false;

const localeLoaders = {
  en: () => import('../locales/en.js'),
  es: () => import('../locales/es.js'),
  ar: () => import('../locales/ar.js'),
};

function detectInitialLanguage() {
  try {
    const stored = localStorage.getItem('i18nextLng');
    if (stored && SUPPORTED.includes(stored)) return stored;
  } catch {}
  const nav = (navigator.language || '').split('-')[0];
  if (nav && SUPPORTED.includes(nav)) return nav;
  return 'fr';
}

export async function initI18n() {
  if (initialized) return;
  initialized = true;

  const initial = detectInitialLanguage();
  const resources = { fr: { translation: fr } };

  if (initial !== 'fr' && localeLoaders[initial]) {
    const mod = await localeLoaders[initial]();
    resources[initial] = { translation: mod.default };
    loaded.add(initial);
  }

  await i18next.use(LanguageDetector).init({
    resources,
    fallbackLng: 'fr',
    detection: {
      order: ['localStorage', 'navigator'],
      caches: ['localStorage'],
    },
    interpolation: {
      escapeValue: false,
    },
  });

  applyLanguage();
}

export function t(key) {
  return i18next.t(key);
}

export async function changeLanguage(lng) {
  if (!loaded.has(lng) && localeLoaders[lng]) {
    const mod = await localeLoaders[lng]();
    i18next.addResourceBundle(lng, 'translation', mod.default);
    loaded.add(lng);
  }
  i18next.changeLanguage(lng);
  applyLanguage();
  document.dispatchEvent(new CustomEvent('languagechange', { detail: { language: lng } }));
}

function applyLanguage() {
  const lang = i18next.language;
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  translatePage();
}

export function translatePage() {
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    el.textContent = t(key);
  });

  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder')));
  });

  document.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.setAttribute('title', t(el.getAttribute('data-i18n-title')));
  });

  document.querySelectorAll('[data-i18n-alt]').forEach((el) => {
    el.setAttribute('alt', t(el.getAttribute('data-i18n-alt')));
  });

  document.querySelectorAll('[data-i18n-aria-label]').forEach((el) => {
    el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria-label')));
  });

  const titleEl = document.querySelector('title');
  if (titleEl) titleEl.textContent = t('meta.title');

  const metaDesc = document.querySelector('meta[name="description"]');
  if (metaDesc) metaDesc.setAttribute('content', t('meta.description'));

  const ogTitle = document.querySelector('meta[property="og:title"]');
  if (ogTitle) ogTitle.setAttribute('content', t('meta.ogTitle'));

  const ogDesc = document.querySelector('meta[property="og:description"]');
  if (ogDesc) ogDesc.setAttribute('content', t('meta.ogDescription'));

  const ogImgAlt = document.querySelector('meta[property="og:image:alt"]');
  if (ogImgAlt) ogImgAlt.setAttribute('content', t('meta.ogImgAlt'));

  const twitterTitle = document.querySelector('meta[name="twitter:title"]');
  if (twitterTitle) twitterTitle.setAttribute('content', t('meta.twitterTitle'));

  const twitterDesc = document.querySelector('meta[name="twitter:description"]');
  if (twitterDesc) twitterDesc.setAttribute('content', t('meta.twitterDescription'));
}
