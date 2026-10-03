import { t } from './i18n.js';

let currentFrame = null;
let pendingStart = null;
let runId = 0;

export function initScrambleText() {
  const el = document.getElementById('scramble-text');
  if (!el) return;
  start(el);

  document.addEventListener('languagechange', () => {
    start(el);
  });
}

function stop() {
  runId += 1;
  if (currentFrame) {
    cancelAnimationFrame(currentFrame);
    currentFrame = null;
  }
  if (pendingStart) {
    clearTimeout(pendingStart);
    pendingStart = null;
  }
}

function start(el) {
  stop();
  const run = runId;
  const finalText = t('hero.titleHighlight');
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!@#$%';
  const delay = 1700;
  const duration = 900;

  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    el.textContent = finalText;
    return;
  }

  function step(timestamp, startTime) {
    if (run !== runId) return;
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

  pendingStart = setTimeout(() => {
    pendingStart = null;
    currentFrame = requestAnimationFrame((ts) => step(ts));
  }, delay);
}