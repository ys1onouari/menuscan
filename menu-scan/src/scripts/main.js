import { initI18n, translatePage } from './i18n.js';
import { initLanguageSwitcher } from './language-switcher.js';
import { initLoader } from './loader.js';
import { initNavbar } from './navbar.js';
import { initParticles } from './particles.js';
import { initPhoneTilt } from './phone-tilt.js';
import { initScrambleText } from './scramble-text.js';
import { initFaq } from './faq.js';
import { initScrollReveal } from './scroll-reveal.js';
import { initSmoothScroll } from './smooth-scroll.js';
import { initMagneticButtons } from './magnetic-buttons.js';

function log(step) {
  console.log(`[MenuScan] Init ${step}`);
}

document.addEventListener('DOMContentLoaded', async () => {
  log('DOMContentLoaded');

  initLoader();
  log('loader');

  try {
    await initI18n();
    log('i18n');
  } catch (e) {
    console.error('[MenuScan] i18n init error:', e);
  }

  translatePage();
  log('translate');
  initLanguageSwitcher();
  log('language-switcher');
  initNavbar();
  log('navbar');
  initParticles();
  log('particles');
  initPhoneTilt();
  log('phone-tilt');
  initScrambleText();
  log('scramble-text');
  initFaq();
  log('faq');
  initScrollReveal();
  log('scroll-reveal');
  initSmoothScroll();
  log('smooth-scroll');
  initMagneticButtons();
  log('magnetic-buttons');

  log('all modules initialized');
});
