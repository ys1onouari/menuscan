import { initI18n } from './i18n.js';
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

const I18N_TIMEOUT = 3000;

function run(step, init) {
  try {
    init();
    log(step);
  } catch (e) {
    console.error(`[MenuScan] ${step} failed, continuing:`, e);
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  log('DOMContentLoaded');

  run('loader', initLoader);

  try {
    await Promise.race([
      initI18n(),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`i18n init timeout after ${I18N_TIMEOUT}ms`)), I18N_TIMEOUT)),
    ]);
  } catch (e) {
    console.error('[MenuScan] i18n init error, page kept in static French:', e);
  }

  log('i18n + translate');
  run('language-switcher', initLanguageSwitcher);
  run('navbar', initNavbar);
  run('particles', initParticles);
  run('phone-tilt', initPhoneTilt);
  run('scramble-text', initScrambleText);
  run('faq', initFaq);
  run('scroll-reveal', initScrollReveal);
  run('smooth-scroll', initSmoothScroll);
  run('magnetic-buttons', initMagneticButtons);

  log('all modules initialized');
});
