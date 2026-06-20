// ============================================================
// PARTICLE — uses RGB for proper alpha rendering
// ============================================================
// Lightweight gameplay particle (trail/sparkle/bounce dust). Pure rendering,
// no DSP coupling; extracted from app.js so the game class stays focused.
export class Particle {
  constructor(x, y, r, g, b, vx, vy, life, size) {
    this.x = x; this.y = y;
    this.r = r; this.g = g; this.b = b;
    this.vx = vx; this.vy = vy;
    this.life = life; this.maxLife = life;
    this.size = size;
  }
  update(dt) {
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.vy += 120 * dt;
    this.life -= dt;
  }
  draw(ctx) {
    const alpha = Math.max(0, this.life / this.maxLife) * 0.8;
    ctx.fillStyle = `rgba(${this.r},${this.g},${this.b},${alpha})`;
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.size * (this.life / this.maxLife), 0, Math.PI * 2);
    ctx.fill();
  }
}
