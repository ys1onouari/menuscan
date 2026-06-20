import { t } from './i18n.js';

let currentFrame = null;

export function initScrambleText() {
  const el = document.getElementById('scramble-text');
  if (!el) return;
  start(el);

  document.addEventListener('languagechange', () => {
    if (currentFrame) cancelAnimationFrame(currentFrame);
    start(el);
  });
}

function start(el) {
  const finalText = t('hero.titleHighlight');
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!@#$%';
  const delay = 1700;
  const duration = 900;

  function step(timestamp, startTime) {
    if (!startTime) startTime = timestamp;
    const p = Math.min((timestamp - startTime) / duration, 1);
    const n = Math.floor(p * finalText.length);
    let out = '';
    for (let i = 0; i < finalText.length; i++) {
      if (i < n || finalText[i] === ' ' || finalText[i] === '.') {
        out += finalText[i];
      } else {
        out += chars[Math.floor(Math.random() * chars.length)];
      }
    }
    el.textContent = out;
    if (p < 1) {
      currentFrame = requestAnimationFrame((ts) => step(ts, startTime));
    } else {
      el.textContent = finalText;
      currentFrame = null;
    }
  }

  setTimeout(() => {
    currentFrame = requestAnimationFrame((ts) => step(ts));
  }, delay);
}
