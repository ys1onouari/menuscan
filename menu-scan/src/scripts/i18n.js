import i18next from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import fr from '../locales/fr.js';

const SUPPORTED = ['fr', 'en', 'es', 'ar'];
const RTL = ['ar'];
const loaded = new Set(['fr']);
let initialized = false;

const localeLoaders = {
  en: () => import('../locales/en.js'),
  es: () => import('../locales/es.js'),
  ar: () => import('../locales/ar.js'),
};

function normalizeLang(lng) {
  return typeof lng === 'string' ? lng.split('-')[0].toLowerCase() : '';
}

function detectInitialLanguage() {
  try {
    const stored = normalizeLang(localStorage.getItem('i18nextLng'));
    if (stored && SUPPORTED.includes(stored)) return stored;
  } catch {}
  const nav = normalizeLang(navigator.language);
  if (nav && SUPPORTED.includes(nav)) return nav;
  return 'fr';
}

export async function initI18n() {
  if (initialized) return;
  initialized = true;

  const initial = detectInitialLanguage();
  const resources = { fr: { translation: fr } };

  if (initial !== 'fr' && localeLoaders[initial]) {
    try {
      const mod = await localeLoaders[initial]();
      if (mod && mod.default) {
        resources[initial] = { translation: mod.default };
        loaded.add(initial);
      } else {
        console.error(`[MenuScan] locale "${initial}" sans export par defaut, repli sur fr`);
      }
    } catch (e) {
      console.error(`[MenuScan] locale "${initial}" indisponible, repli sur fr:`, e);
    }
  }

  await i18next.use(LanguageDetector).init({
    resources,
    fallbackLng: 'fr',
    detection: {
      order: ['localStorage', 'navigator'],
      caches: ['localStorage'],
      convertDetectedLanguage: (lng) => {
        const base = normalizeLang(lng);
        return SUPPORTED.includes(base) ? base : lng;
      },
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
  const base = normalizeLang(lng);
  if (!loaded.has(base) && localeLoaders[base]) {
    const mod = await localeLoaders[base]();
    i18next.addResourceBundle(base, 'translation', mod.default);
    loaded.add(base);
  }
  await i18next.changeLanguage(base);
  applyLanguage();
  document.dispatchEvent(new CustomEvent('languagechange', { detail: { language: base } }));
  const announcer = document.getElementById('lang-announce');
  if (announcer) announcer.textContent = t('langAnnounce').replace('{lang}', t('switcher.' + base));
}

function applyLanguage() {
  const lang = normalizeLang(i18next.resolvedLanguage) || normalizeLang(i18next.language) || 'fr';
  document.documentElement.lang = lang;
  document.documentElement.dir = RTL.includes(lang) ? 'rtl' : 'ltr';
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

  document.querySelectorAll('[data-i18n-content]').forEach((el) => {
    el.setAttribute('content', t(el.getAttribute('data-i18n-content')));
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

  const ogLocale = document.querySelector('meta[property="og:locale"]');
  if (ogLocale) ogLocale.setAttribute('content', t('meta.ogLocale'));

  const twitterTitle = document.querySelector('meta[name="twitter:title"]');
  if (twitterTitle) twitterTitle.setAttribute('content', t('meta.twitterTitle'));

  const twitterDesc = document.querySelector('meta[name="twitter:description"]');
  if (twitterDesc) twitterDesc.setAttribute('content', t('meta.twitterDescription'));

  updateWhatsAppLinks();
}

function updateWhatsAppLinks() {
  const msg = encodeURIComponent(t('waMessage'));
  document.querySelectorAll('a[href^="https://wa.me/"]').forEach((a) => {
    const href = a.getAttribute('href');
    if (!href) return;
    const numMatch = href.match(/wa\.me\/(\d+)/);
    const num = numMatch ? numMatch[1] : '212630230803';
    a.setAttribute('href', `https://wa.me/${num}${msg ? `?text=${msg}` : ''}`);
  });
}
