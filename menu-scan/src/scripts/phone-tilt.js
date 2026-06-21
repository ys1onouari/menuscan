export function initPhoneTilt() {
  const phoneTilt = document.getElementById('phoneTilt');
  const phoneWrap = document.querySelector('.phone-wrap');

  if (!phoneWrap || !phoneTilt) return;
  if (window.matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0) return;

  phoneWrap.addEventListener('mousemove', (e) => {
    const rect = phoneWrap.getBoundingClientRect();
    const dx = (e.clientX - rect.left - rect.width / 2) / (rect.width / 2);
    const dy = (e.clientY - rect.top - rect.height / 2) / (rect.height / 2);
    phoneTilt.style.transform = `rotateY(${dx * 14}deg) rotateX(${-dy * 10}deg)`;
  });

  phoneWrap.addEventListener('mouseleave', () => {
    phoneTilt.style.transform = '';
  });

  document.querySelectorAll('.cat').forEach((cat) => {
    cat.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        cat.click();
      }
    });
  });
}
