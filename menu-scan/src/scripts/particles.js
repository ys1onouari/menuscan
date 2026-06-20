export function initParticles() {
  if (window.matchMedia('(hover: none), (pointer: coarse)').matches) return;
  const canvas = document.getElementById('particles');
  const ctx = canvas.getContext('2d');

  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  resize();
  window.addEventListener('resize', resize);

  class Particle {
    constructor() { this.reset(true) }
    reset(init) {
      this.x = Math.random() * canvas.width;
      this.y = init ? Math.random() * canvas.height : (Math.random() > 0.5 ? -5 : canvas.height + 5);
      this.s = Math.random() * 1.4 + 0.2;
      this.vx = (Math.random() - 0.5) * 0.25;
      this.vy = (Math.random() - 0.5) * 0.25;
      this.o = Math.random() * 0.35 + 0.05;
      this.life = 0;
      this.max = Math.random() * 400 + 150;
    }
    update() {
      this.x += this.vx;
      this.y += this.vy;
      this.life++;
      if (this.life > this.max || this.x < -10 || this.x > canvas.width + 10 || this.y < -10 || this.y > canvas.height + 10) {
        this.reset(false);
      }
    }
    draw() {
      const f = Math.min(this.life / 40, 1) * Math.min((this.max - this.life) / 40, 1);
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.s, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(220,70,70,${this.o * f})`;
      ctx.fill();
    }
  }

  const particles = Array.from({ length: 90 }, () => new Particle());

  function anim() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    particles.forEach(p => { p.update(); p.draw(); });
    requestAnimationFrame(anim);
  }
  anim();
}
