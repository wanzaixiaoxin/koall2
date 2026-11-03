/**
 * 击杀 / 命中 / 爆炸特效引擎（纯渲染层，不参与 30Hz 结算，不影响确定性）。
 *
 * 为什么独立成文件：shapes.ts 是「静态几何语言」，这里是「有生命周期的粒子」。
 * 混在一起的形状库会变成杂货铺，而 3D 适配层可以按同一套 identity 配方换实现。
 *
 * 设计约束（docs/06 + docs/05 性能策略）：
 *  - 对象池语义：数组上限硬封顶，事件驱动创建、到期原地压缩，绝不每帧 new；
 *  - 事件驱动：只有 onKill / onHit / onExplode 才产生粒子，静止战场零开销；
 *  - 「好 > 无 > 有」：未知怪物/武器一律回落到中性配方，不凭空造错误效果；
 *  - 可读性铁律 1：击杀表现亮度高于弹幕，但寿命短（0.3~0.9s），不遮挡后续战斗。
 */
import { DamageType } from '../../../gamecore';
import {
  ChunkKind, DAMAGE_FX, GlyphKind, GlyphSpec, lookOf, SIZE_SCALE,
} from './identity';

// ---------- 容量上限（超过则丢最旧的，保证低端机不因特效堆积掉帧） ----------
const MAX_PARTICLES = 560;
const MAX_RINGS = 48;
const MAX_DECALS = 42;
const MAX_GLYPHS = 96;
const MAX_SMOKE = 64;

interface Particle {
  x: number; y: number; vx: number; vy: number;
  life: number; maxLife: number;
  size: number; color: string;
  chunk: ChunkKind;
  rot: number; vr: number;
  gravity: number; drag: number;
}

interface Ring {
  x: number; y: number; r0: number; r1: number;
  color: string; width: number; life: number; maxLife: number;
}

interface Decal {
  x: number; y: number; radius: number; color: string;
  life: number; maxLife: number;
}

interface Smoke {
  x: number; y: number; vx: number; vy: number;
  size: number; life: number; maxLife: number; color: string;
}

interface Glyph {
  kind: GlyphKind;
  x: number; y: number; vx: number; vy: number;
  rot: number; vr: number;
  size: number; color: string;
  life: number; maxLife: number;
  seed: number;
}

/** 确定性伪随机（mulberry32）：同一事件每次生成的碎块分布一致，录像回看不会"每次死法都不一样"。 */
function makeRng(seed: number): () => number {
  let a = (seed * 0x9e3779b9) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TAU = Math.PI * 2;

export interface KillInfo {
  x: number;
  y: number;
  radius: number;
  key?: string;
  shape?: string;
  /** 致命一击的伤害类型（null/undefined = 中性死法：不带元素色） */
  damageType?: DamageType | null;
}

export class KillFx {
  private particles: Particle[] = [];
  private rings: Ring[] = [];
  private decals: Decal[] = [];
  private smoke: Smoke[] = [];
  private glyphs: Glyph[] = [];
  private seedCount = 1;

  /** 清场（重开局/切关时调用，避免上一局的残留粒子飘进新局） */
  clear(): void {
    this.particles.length = 0;
    this.rings.length = 0;
    this.decals.length = 0;
    this.smoke.length = 0;
    this.glyphs.length = 0;
  }

  private rng(): () => number {
    return makeRng(this.seedCount++);
  }

  private pushParticle(p: Particle): void {
    if (this.particles.length >= MAX_PARTICLES) this.particles.shift();
    this.particles.push(p);
  }

  private pushRing(x: number, y: number, r0: number, r1: number, color: string, width: number, dur: number): void {
    if (this.rings.length >= MAX_RINGS) this.rings.shift();
    this.rings.push({ x, y, r0, r1, color, width, life: dur, maxLife: dur });
  }

  private pushDecal(x: number, y: number, radius: number, color: string, dur: number): void {
    if (this.decals.length >= MAX_DECALS) this.decals.shift();
    this.decals.push({ x, y, radius, color, life: dur, maxLife: dur });
  }

  private pushGlyph(g: Glyph): void {
    if (this.glyphs.length >= MAX_GLYPHS) this.glyphs.shift();
    this.glyphs.push(g);
  }

  // ---------------- 事件入口 ----------------

  /**
   * 怪物死亡：按身份表的 death 配方生成碎块 + 冲击环 + 地面残留 + 尘烟 + 专属符号，
   * 再叠一层「致命伤害类型」风味（火焰=余烬上飘、寒冰=碎晶、雷电=电弧、毒素=气泡）。
   */
  spawnKill(info: KillInfo): void {
    const look = lookOf(info.key, info.shape);
    const r = look.death;
    const scale = SIZE_SCALE[look.size] * Math.min(1.7, Math.max(0.75, info.radius / 20));
    const rnd = this.rng();
    const t = info.damageType ? DAMAGE_FX[info.damageType] : null;

    // 1) 碎块（材质由 chunk 决定：胶质/石片/甲片/木屑/翼膜/火星/余烬/气泡）
    const count = Math.min(30, Math.round(r.count * (scale > 1.3 ? 1.35 : 1)));
    for (let i = 0; i < count; i++) {
      const a = rnd() * TAU;
      const sp = r.speed[0] + rnd() * (r.speed[1] - r.speed[0]);
      const color = r.color2 && rnd() < 0.4 ? r.color2 : r.color;
      this.pushParticle({
        x: info.x + Math.cos(a) * info.radius * 0.35,
        y: info.y + Math.sin(a) * info.radius * 0.35,
        vx: Math.cos(a) * sp * (0.6 + 0.4 * scale),
        vy: Math.sin(a) * sp * (0.6 + 0.4 * scale),
        life: 0.34 + rnd() * 0.5,
        maxLife: 0.34 + rnd() * 0.5,
        size: (r.size[0] + rnd() * (r.size[1] - r.size[0])) * Math.min(1.5, scale),
        color,
        chunk: r.chunks,
        rot: rnd() * TAU,
        vr: (rnd() - 0.5) * (r.spin ? 14 : 3),
        gravity: r.gravity,
        drag: 2.2,
      });
    }

    // 2) 冲击环：击杀的"重音"，体型越大越慢越厚
    if (r.ring) {
      this.pushRing(info.x, info.y, info.radius * 0.5, r.ring.r1 * scale, r.ring.color, r.ring.width, r.ring.dur * (r.weight ?? 1));
    }
    // 3) 地面残留（血/孢子/焦土/酸液）：这是"这怪死在这里"的可读证据
    if (r.decal) {
      this.pushDecal(info.x, info.y, r.decal.radius * scale, r.decal.color, r.decal.dur);
    }
    // 4) 尘烟
    if (r.smoke) {
      const n = Math.round(r.smoke.count * Math.min(1.6, scale));
      for (let i = 0; i < n; i++) {
        const a = rnd() * TAU;
        if (this.smoke.length >= MAX_SMOKE) this.smoke.shift();
        this.smoke.push({
          x: info.x + Math.cos(a) * info.radius * 0.4,
          y: info.y + Math.sin(a) * info.radius * 0.4,
          vx: Math.cos(a) * (12 + rnd() * 26),
          vy: Math.sin(a) * (12 + rnd() * 26) + 8,
          size: (8 + rnd() * 12) * scale,
          life: 0.5 + rnd() * 0.45,
          maxLife: 0.5 + rnd() * 0.45,
          color: r.smoke.color,
        });
      }
    }
    // 5) 专属符号（斩痕 / 掉落兵器 / 地刺 / 魂火 / 碎裂外环 / 地面裂纹 / 分裂小圆）
    if (r.glyphs) {
      for (const g of r.glyphs) this.spawnGlyphSpec(g, info.x, info.y, scale, rnd);
    }

    // 6) 伤害类型风味：只加一层，不覆盖上面的怪物身份（先看清"是什么"，再读懂"怎么死的"）
    if (t) {
      const n = Math.round(5 * scale);
      for (let i = 0; i < n; i++) {
        const a = rnd() * TAU;
        const sp = 60 + rnd() * 180;
        this.pushParticle({
          x: info.x + (rnd() - 0.5) * info.radius * 0.8,
          y: info.y + (rnd() - 0.5) * info.radius * 0.8,
          vx: Math.cos(a) * sp,
          vy: Math.sin(a) * sp * 0.6 + (t.chunk === 'ember' ? 90 : 0), // 余烬上飘
          life: 0.26 + rnd() * 0.4,
          maxLife: 0.26 + rnd() * 0.4,
          size: 2 + rnd() * 3,
          color: t.color,
          chunk: t.chunk,
          rot: rnd() * TAU,
          vr: (rnd() - 0.5) * 8,
          gravity: t.chunk === 'ember' ? -60 : 40,
          drag: 1.6,
        });
      }
      // 雷电致死：额外两道电弧（元素身份最强的信号）
      if (info.damageType === 'lightning') {
        this.spawnGlyph('arc', info.x, info.y, 0, 0, 26 * scale, t.color, 0.32, rnd() * TAU);
      }
      // 寒冰致死：一圈薄霜环（冷冽感）
      if (info.damageType === 'frost') {
        this.pushRing(info.x, info.y, info.radius * 0.6, info.radius * 1.9 * scale, t.color, 2, 0.45);
      }
      // 火焰致死：地面焦痕（与弹坑焦土同一套语言）
      if (info.damageType === 'fire' && !r.decal) {
        this.pushDecal(info.x, info.y, info.radius * 1.1 * scale, t.stain, 2.2);
      }
    }

    // 7) 白闪：最后一击的"脆响"，只给一次（Boss 给得更响）
    this.pushRing(info.x, info.y, 0, info.radius * 0.9, '#F5F5FA', 2, 0.14);
  }

  private spawnGlyphSpec(g: GlyphSpec, x: number, y: number, scale: number, rnd: () => number): void {
    for (let i = 0; i < g.count; i++) {
      const a = rnd() * TAU;
      const sp = g.speed[0] + rnd() * (g.speed[1] - g.speed[0]);
      this.spawnGlyph(
        g.kind,
        x + Math.cos(a) * 6,
        y + Math.sin(a) * 6,
        Math.cos(a) * sp,
        Math.sin(a) * sp,
        (g.size[0] + rnd() * (g.size[1] - g.size[0])) * Math.min(1.5, scale),
        g.color,
        g.dur,
        rnd() * TAU,
      );
    }
  }

  private spawnGlyph(
    kind: GlyphKind, x: number, y: number, vx: number, vy: number,
    size: number, color: string, dur: number, rot: number,
  ): void {
    this.pushGlyph({
      kind, x, y, vx, vy,
      rot,
      vr: kind === 'drop' || kind === 'split' ? (kind === 'drop' ? 9 : 3) : 0,
      size, color,
      life: dur, maxLife: dur,
      seed: this.seedCount * 977 + Math.floor(x * 13 + y * 7),
    });
  }

  /**
   * 命中火花：与受击闪白（fx-config）叠加使用——闪白回答"打中了"，火花回答"什么打的"。
   * strength 由调用方按暴击/伤害量给，控制在 1~3，避免大伤害时糊屏。
   */
  spawnHit(x: number, y: number, damageType?: DamageType | null, strength = 1): void {
    const t = damageType ? DAMAGE_FX[damageType] : DAMAGE_FX.physical;
    const rnd = this.rng();
    const n = Math.min(9, Math.round(2 + 2.4 * strength));
    for (let i = 0; i < n; i++) {
      const a = rnd() * TAU;
      const sp = 90 + rnd() * 240;
      this.pushParticle({
        x, y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        life: 0.12 + rnd() * 0.16,
        maxLife: 0.12 + rnd() * 0.16,
        size: 1.6 + rnd() * 2.2 + strength * 0.5,
        color: rnd() < 0.55 ? t.color : '#F5F5FA',
        chunk: t.chunk === 'spark' ? 'spark' : t.chunk,
        rot: a,
        vr: 6,
        gravity: 0,
        drag: 5,
      });
    }
    if (strength >= 1.8) this.pushRing(x, y, 2, 12 + strength * 4, t.color, 1.8, 0.16);
  }

  /** 爆炸（炸弹落地 / 毒爆 / 场景爆炸）：双向冲击环 + 碎块 + 烟。 */
  spawnExplode(x: number, y: number, radius: number, damageType?: DamageType | null): void {
    const t = damageType ? DAMAGE_FX[damageType] : DAMAGE_FX.fire;
    const rnd = this.rng();
    this.pushRing(x, y, radius * 0.1, radius * 1.15, t.color, 4, 0.34);
    this.pushRing(x, y, radius * 0.05, radius * 0.72, '#F5F5FA', 2.5, 0.22);
    for (let i = 0; i < 12; i++) {
      const a = rnd() * TAU;
      const sp = 80 + rnd() * 260;
      this.pushParticle({
        x, y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        life: 0.24 + rnd() * 0.4,
        maxLife: 0.24 + rnd() * 0.4,
        size: 3 + rnd() * 5,
        color: rnd() < 0.4 ? '#F5F5FA' : t.color,
        chunk: t.chunk,
        rot: rnd() * TAU,
        vr: (rnd() - 0.5) * 10,
        gravity: 120,
        drag: 2.4,
      });
    }
    for (let i = 0; i < 4; i++) {
      const a = rnd() * TAU;
      if (this.smoke.length >= MAX_SMOKE) this.smoke.shift();
      this.smoke.push({
        x, y,
        vx: Math.cos(a) * 30,
        vy: Math.sin(a) * 30 + 14,
        size: 14 + rnd() * 16,
        life: 0.5 + rnd() * 0.4,
        maxLife: 0.5 + rnd() * 0.4,
        color: t.stain,
      });
    }
  }

  // ---------------- 帧推进 ----------------

  update(dt: number): void {
    const d = Math.min(0.05, dt);
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= d;
      if (p.life <= 0) {
        this.particles.splice(i, 1);
        continue;
      }
      const k = Math.max(0, 1 - p.drag * d);
      p.vx *= k;
      p.vy *= k;
      p.vy -= p.gravity * d; // 俯视角：gravity>0 = 朝城墙方向落
      p.x += p.vx * d;
      p.y += p.vy * d;
      p.rot += p.vr * d;
    }
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.life -= d;
      if (r.life <= 0) this.rings.splice(i, 1);
    }
    for (let i = this.decals.length - 1; i >= 0; i--) {
      const r = this.decals[i];
      r.life -= d;
      if (r.life <= 0) this.decals.splice(i, 1);
    }
    for (let i = this.smoke.length - 1; i >= 0; i--) {
      const s = this.smoke[i];
      s.life -= d;
      if (s.life <= 0) {
        this.smoke.splice(i, 1);
        continue;
      }
      s.x += s.vx * d;
      s.y += s.vy * d;
      s.vx *= Math.max(0, 1 - 1.4 * d);
      s.vy *= Math.max(0, 1 - 1.4 * d);
      s.size += 26 * d;
    }
    for (let i = this.glyphs.length - 1; i >= 0; i--) {
      const g = this.glyphs[i];
      g.life -= d;
      if (g.life <= 0) {
        this.glyphs.splice(i, 1);
        continue;
      }
      g.x += g.vx * d;
      g.y += g.vy * d;
      g.rot += g.vr * d;
      // 掉落物轻微下坠（俯视角里"掉在地上"= 向城墙方向落一点）
      if (g.kind === 'drop' || g.kind === 'split') g.vy -= 140 * d;
    }
  }

  // ---------------- 绘制 ----------------

  /** 在已做 y 翻转的游戏坐标系里绘制（调用方负责 setTransform）。 */
  draw(ctx: CanvasRenderingContext2D, t: number): void {
    // 1) 地面残留（最底层，读作"这地方发生过事"）
    for (const d of this.decals) {
      const k = Math.min(1, d.life / d.maxLife);
      const fade = Math.min(1, k * 1.6);
      ctx.fillStyle = hexA(d.color, 0.34 * fade);
      ctx.beginPath();
      ctx.ellipse(d.x, d.y, d.radius * (0.9 + 0.18 * (1 - k)), d.radius * 0.5, 0, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = hexA(d.color, 0.18 * fade);
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    // 2) 冲击环
    for (const r of this.rings) {
      const k = 1 - r.life / r.maxLife;
      const rad = r.r0 + (r.r1 - r.r0) * easeOut(k);
      ctx.strokeStyle = hexA(r.color, 0.75 * (1 - k));
      ctx.lineWidth = Math.max(0.8, r.width * (1 - k * 0.7));
      ctx.beginPath();
      ctx.ellipse(r.x, r.y, rad, rad * 0.62, 0, 0, TAU);
      ctx.stroke();
    }
    // 3) 地面系符号（裂纹/地刺/碎裂外环/掉落物）——压在碎块之下
    for (const g of this.glyphs) {
      if (g.kind === 'crack' || g.kind === 'spike' || g.kind === 'shatter' || g.kind === 'drop' || g.kind === 'split') {
        drawGlyph(ctx, g, t);
      }
    }
    // 4) 碎块
    for (const p of this.particles) {
      const k = Math.max(0, p.life / p.maxLife);
      ctx.globalAlpha = Math.min(1, k * 1.5);
      drawChunk(ctx, p);
    }
    ctx.globalAlpha = 1;
    // 5) 尘烟（半透明团块）
    for (const s of this.smoke) {
      const k = Math.max(0, s.life / s.maxLife);
      ctx.fillStyle = hexA(s.color, 0.2 * k);
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.size, 0, TAU);
      ctx.fill();
    }
    // 6) 上层符号（斩痕/电弧/魂火）：加色混合，闪一下就走
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const g of this.glyphs) {
      if (g.kind === 'slash' || g.kind === 'arc' || g.kind === 'wisp') drawGlyph(ctx, g, t);
    }
    ctx.restore();
    // 7) 发光碎屑（火星/余烬）走加色，避免被暗底吃掉
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const p of this.particles) {
      if (p.chunk === 'spark' || p.chunk === 'ember') {
        const k = Math.max(0, p.life / p.maxLife);
        ctx.globalAlpha = Math.min(1, k * 1.6);
        drawChunk(ctx, p);
      }
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  /** 供 HUD 调试/性能观测：当前存活粒子数 */
  get particleCount(): number {
    return this.particles.length;
  }
}

// ---------------- 绘制原语 ----------------

function easeOut(k: number): number {
  return 1 - Math.pow(1 - clamp01(k), 3);
}
function clamp01(k: number): number {
  return k < 0 ? 0 : k > 1 ? 1 : k;
}

/** '#RRGGBB' + alpha → rgba()（避免每帧拼字符串开销过大的同时保持可读） */
function hexA(hex: string, a: number): string {
  const h = hex.replace('#', '');
  const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(v, 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r},${g},${b},${a.toFixed(3)})`;
}

/** 碎块材质：胶质圆 / 石片三角 / 甲片方 / 木屑条 / 翼膜羽 / 火星线 / 余烬点 / 气泡 */
function drawChunk(ctx: CanvasRenderingContext2D, p: Particle): void {
  const s = p.size;
  switch (p.chunk) {
    case 'goo': {
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, s, 0, TAU);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.beginPath();
      ctx.arc(p.x - s * 0.3, p.y + s * 0.3, s * 0.34, 0, TAU);
      ctx.fill();
      break;
    }
    case 'plate': {
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.moveTo(-s, -s * 0.75);
      ctx.lineTo(s * 0.85, -s);
      ctx.lineTo(s, s * 0.8);
      ctx.lineTo(-s * 0.8, s);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(11,12,29,0.45)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();
      break;
    }
    case 'shard': {
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.moveTo(0, -s);
      ctx.lineTo(s * 0.85, s * 0.75);
      ctx.lineTo(-s * 0.85, s * 0.75);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      break;
    }
    case 'splinter': {
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-s * 1.6, -s * 0.32, s * 3.2, s * 0.64);
      ctx.restore();
      break;
    }
    case 'feather': {
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.moveTo(-s * 1.7, 0);
      ctx.lineTo(0, -s * 0.55);
      ctx.lineTo(s * 1.3, 0);
      ctx.lineTo(0, s * 0.55);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      break;
    }
    case 'spark': {
      // 速度方向的短线（动能感）
      const len = 4 + s * 2.2;
      const n = Math.hypot(p.vx, p.vy) || 1;
      ctx.strokeStyle = p.color;
      ctx.lineWidth = Math.max(1, s * 0.5);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x - (p.vx / n) * len, p.y - (p.vy / n) * len);
      ctx.stroke();
      break;
    }
    case 'ember': {
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, s * 0.7, 0, TAU);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,230,160,0.55)';
      ctx.beginPath();
      ctx.arc(p.x, p.y, s * 0.32, 0, TAU);
      ctx.fill();
      break;
    }
    case 'bubble': {
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, s, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.lineWidth = 1;
      ctx.stroke();
      break;
    }
  }
}

/** 专属死亡符号：每种都是 4~12 行几何，不牺牲辨识度。 */
function drawGlyph(ctx: CanvasRenderingContext2D, g: Glyph, t: number): void {
  const k = Math.max(0, g.life / g.maxLife);
  const a = Math.min(1, k * 1.4);
  switch (g.kind) {
    case 'slash': {
      // 两道交叉斩痕：先画后收
      const grow = 1 - k;
      const L = g.size * (0.55 + 0.45 * Math.min(1, grow * 3));
      ctx.save();
      ctx.translate(g.x, g.y);
      ctx.rotate(g.rot);
      ctx.strokeStyle = hexA(g.color, 0.85 * a);
      ctx.lineWidth = 2.4;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(-L, -L * 0.55);
      ctx.lineTo(L * 0.75, L * 0.5);
      ctx.moveTo(L * 0.6, -L * 0.6);
      ctx.lineTo(-L * 0.8, L * 0.45);
      ctx.stroke();
      ctx.restore();
      break;
    }
    case 'arc': {
      // 电弧：确定性折线（种子固定）+ 高频闪烁
      ctx.strokeStyle = hexA(g.color, 0.9 * a * (0.55 + 0.45 * Math.sin(t * 40 + g.seed)));
      ctx.lineWidth = 2;
      ctx.beginPath();
      const segs = 4;
      let px = g.x;
      let py = g.y;
      ctx.moveTo(px, py);
      for (let i = 1; i <= segs; i++) {
        const kk = i / segs;
        const jitter = Math.sin(g.seed * 12.9898 + i * 4.1414) * g.size * 0.5;
        px = g.x + Math.cos(g.rot) * g.size * kk + Math.cos(g.rot + Math.PI / 2) * jitter;
        py = g.y + Math.sin(g.rot) * g.size * kk + Math.sin(g.rot + Math.PI / 2) * jitter;
        ctx.lineTo(px, py);
      }
      ctx.stroke();
      break;
    }
    case 'wisp': {
      // 上升魂火：小圆 + 拖尾
      const rise = (1 - k) * g.size * 2.4;
      ctx.fillStyle = hexA(g.color, 0.9 * a);
      ctx.beginPath();
      ctx.arc(g.x, g.y + rise, g.size * 0.8, 0, TAU);
      ctx.fill();
      ctx.fillStyle = hexA(g.color, 0.3 * a);
      ctx.beginPath();
      ctx.arc(g.x, g.y + rise - g.size * 0.9, g.size * 0.5, 0, TAU);
      ctx.fill();
      break;
    }
    case 'drop': {
      // 掉落兵器/轮子：旋转的长条 + 端头（插地后停下）
      const settled = 1 - k > 0.55;
      ctx.save();
      ctx.translate(g.x, g.y);
      ctx.rotate(settled ? g.rot : g.rot + (1 - k) * 6);
      ctx.strokeStyle = hexA(g.color, a);
      ctx.lineWidth = 4;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(-g.size * 0.5, 0);
      ctx.lineTo(g.size * 1.1, 0);
      ctx.stroke();
      ctx.fillStyle = hexA(g.color, a);
      ctx.beginPath();
      ctx.arc(g.size * 1.1, 0, 3, 0, TAU);
      ctx.fill();
      ctx.restore();
      break;
    }
    case 'spike': {
      // 地刺：从地面顶出的三角（先长后收）
      const up = Math.min(1, (1 - k) * 4);
      const h = g.size * 1.6 * up;
      ctx.save();
      ctx.translate(g.x, g.y);
      ctx.rotate(g.rot);
      ctx.fillStyle = hexA(g.color, 0.85 * a);
      ctx.beginPath();
      ctx.moveTo(0, h);
      ctx.lineTo(-g.size * 0.42, 0);
      ctx.lineTo(g.size * 0.42, 0);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      break;
    }
    case 'shatter': {
      // 外环碎裂：沿弧线漂出的短弧段
      const rad = g.size * (2.2 + (1 - k) * 3.2);
      ctx.strokeStyle = hexA(g.color, 0.8 * a);
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(g.x, g.y, rad, g.rot, g.rot + 0.5, false);
      ctx.stroke();
      break;
    }
    case 'crack': {
      // 地面裂纹：从中心向外的折线（长期残留，缓慢淡出）
      const L = g.size * Math.min(1, (1 - k) * 3);
      ctx.strokeStyle = hexA(g.color, 0.5 * a);
      ctx.lineWidth = 2;
      ctx.beginPath();
      let px = g.x;
      let py = g.y;
      ctx.moveTo(px, py);
      for (let i = 1; i <= 3; i++) {
        const ang = g.rot + Math.sin(g.seed + i * 2.1) * 0.5;
        px += Math.cos(ang) * (L / 3);
        py += Math.sin(ang) * (L / 3) * 0.6;
        ctx.lineTo(px, py);
      }
      ctx.stroke();
      break;
    }
    case 'split': {
      // 分裂：两枚小圆（带伞盖弧）弹开，正对 deathSplit 机制
      ctx.save();
      ctx.translate(g.x, g.y);
      ctx.fillStyle = hexA(g.color, 0.9 * a);
      ctx.beginPath();
      ctx.arc(0, 0, g.size, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = hexA('#3A1024', 0.6 * a);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(0, -g.size * 0.15, g.size * 0.85, Math.PI, 0);
      ctx.stroke();
      ctx.restore();
      break;
    }
  }
}
