/**
 * 表现层特效系统（docs/06 §3 动效规范）：粒子 / 冲击环 / 电弧 / 飘字 / 震屏。
 *
 * 边界：只消费 gamecore 的事件与快照，绝不回写逻辑；所有随机只影响观感，
 * 因此不会破坏「同种子整局可复现」的确定性承诺。
 *
 * 性能纪律：粒子有硬上限（超出时覆盖最老的），光晕走预渲染精灵，
 * 同屏 150 怪 + 满屏弹幕时也不会掉帧。
 */
import { glowSprite, rgba, hash01 } from './style';
import { CHUNK_TO_KIND, lookOf, SIZE_SCALE } from './identity';

export type ParticleKind = 'spark' | 'shard' | 'ember' | 'smoke' | 'dust' | 'star';

export interface Particle {
  kind: ParticleKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  grav: number;
  drag: number;
  life: number;
  maxLife: number;
  size: number;
  color: string;
  rot: number;
  spin: number;
  /** 0=不缩放，1=随剩余寿命收缩（火星/烟） */
  shrink: number;
}

export interface Ring {
  x: number;
  y: number;
  r0: number;
  r1: number;
  life: number;
  maxLife: number;
  color: string;
  width: number;
  /** 是否用实心衰减填充（爆炸火球） */
  filled: boolean;
}

export interface BoltFx {
  pts: number[][];
  life: number;
  maxLife: number;
  color: string;
  width: number;
}

export interface FloatText {
  x: number;
  y: number;
  text: string;
  color: string;
  size: number;
  life: number;
  maxLife: number;
  /** 弹出缩放：出生瞬间略大，快速回落 */
  pop: number;
  vy: number;
}

export interface HealPulseFx {
  x: number;
  y: number;
  radius: number;
  life: number;
  maxLife: number;
}

export interface TransferFx {
  fx: number;
  fy: number;
  tx: number;
  ty: number;
  life: number;
  maxLife: number;
}

export interface MuzzleFx {
  x: number;
  y: number;
  angle: number;
  life: number;
  maxLife: number;
  color: string;
  size: number;
}

const MAX_PARTICLES = 320;
const MAX_RINGS = 40;
const MAX_FLOATS = 48;
const MAX_BOLTS = 18;

export class EffectsLayer {
  particles: Particle[] = [];
  rings: Ring[] = [];
  bolts: BoltFx[] = [];
  floats: FloatText[] = [];
  heals: HealPulseFx[] = [];
  transfers: TransferFx[] = [];
  muzzles: MuzzleFx[] = [];

  /** 震屏状态（渲染层局部，不影响逻辑与输入） */
  private shakeAmp = 0;
  private shakeLeft = 0;
  private shakeDur = 0;
  private clock = 0;

  /** 帧间随机序列（仅观感）：避免 Math.random 造成同帧多粒子完全重叠 */
  private seed = 1337;

  private rand(): number {
    this.seed = (this.seed * 1664525 + 1013904223) % 4294967296;
    return this.seed / 4294967296;
  }

  private range(a: number, b: number): number {
    return a + (b - a) * this.rand();
  }

  // ---------------- 对外触发接口 ----------------

  /** 震屏：amp=像素幅度，dur=秒。 */
  shake(amp: number, dur: number): void {
    // 取最强的一次，避免连续小震把大震顶掉
    if (amp >= this.shakeAmp || this.shakeLeft <= 0) {
      this.shakeAmp = amp;
      this.shakeDur = Math.max(0.02, dur);
      this.shakeLeft = this.shakeDur;
    }
  }

  get shakeOffset(): { x: number; y: number } {
    if (this.shakeLeft <= 0) return { x: 0, y: 0 };
    const k = this.shakeLeft / this.shakeDur; // 1 → 0
    const decay = k * k;
    const a = this.shakeAmp * decay;
    const t = this.clock * 60;
    return { x: Math.sin(t * 1.7) * a, y: Math.cos(t * 2.3) * a * 0.7 };
  }

  pushFloat(
    x: number,
    y: number,
    text: string,
    color: string,
    size: number,
    opts?: { crit?: boolean; rise?: number; life?: number },
  ): void {
    if (this.floats.length >= MAX_FLOATS) this.floats.shift();
    const life = opts?.life ?? (opts?.crit ? 0.95 : 0.8);
    this.floats.push({
      x,
      y,
      text,
      color,
      size,
      life,
      maxLife: life,
      pop: opts?.crit ? 0.85 : 0.5,
      vy: opts?.rise ?? 62,
    });
  }

  /** 命中火花：沿受击方向溅射（dir 为空时向四周）。 */
  impact(x: number, y: number, color: string, dir?: number, count = 3): void {
    for (let i = 0; i < count; i++) {
      const a = dir === undefined ? this.range(0, Math.PI * 2) : dir + this.range(-0.7, 0.7);
      const sp = this.range(160, 380);
      this.add({
        kind: 'spark',
        x: x + this.range(-3, 3),
        y: y + this.range(-3, 3),
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        grav: -220,
        drag: 3.2,
        life: this.range(0.14, 0.3),
        size: this.range(1.9, 3.4),
        color,
        rot: a,
        spin: 0,
        shrink: 1,
      });
    }
    if (this.rand() < 0.5) {
      this.rings.push({
        x, y, r0: 1, r1: this.range(8, 13),
        life: 0.16, maxLife: 0.16, color, width: 2, filled: false,
      });
    }
  }

  /** 击杀碎裂：碎片形状跟随本体色，尺寸随半径增大。 */
  deathBurst(x: number, y: number, color: string, radius: number): void {
    const n = Math.min(20, 8 + Math.round(radius / 4));
    for (let i = 0; i < n; i++) {
      const a = (Math.PI * 2 * i) / n + this.range(-0.4, 0.4);
      const sp = this.range(140, 340) * (0.7 + radius / 55);
      this.add({
        kind: 'shard',
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp + 40,
        grav: -720,
        drag: 0.7,
        life: this.range(0.35, 0.72),
        size: this.range(3.2, 6.0) * (0.75 + radius / 55),
        color,
        rot: a,
        spin: this.range(-8, 8),
        shrink: 1,
      });
    }
    // 小怪也有一次短促的白色闪光（打击确认感）
    this.rings.push({
      x, y, r0: radius * 0.35, r1: radius * 1.5,
      life: 0.24, maxLife: 0.24, color: '#F5F5FA', width: 2, filled: false,
    });
    this.add({
      kind: 'star',
      x, y,
      vx: 0,
      vy: 0,
      grav: 0,
      drag: 0,
      life: 0.12,
      size: radius * 1.5,
      color: '#FFFFFF',
      rot: 0.6,
      spin: 3,
      shrink: 1,
    });
  }

  /**
   * 身份化击杀（identity.ts 的 death 配方 → 本层粒子/环/电弧）。
   * 与通用 deathBurst 的区别：碎块材质、数量、速度、颜色、冲击环、尘烟、专属符号
   * 全部按「怪物 id」取配方，所以 19 只怪死法各不相同；未知 id 回落通用碎裂。
   * 只做观感，不读逻辑，不影响确定性。
   */
  deathFor(key: string | undefined, shape: string | undefined, x: number, y: number, radius: number, fallbackColor: string, damageType?: string | null): void {
    const look = lookOf(key, shape);
    // 未登记 id/shape → 沿用通用碎裂（"好 > 无 > 有"）
    if (!key && !shape) {
      this.deathBurst(x, y, fallbackColor, radius);
      this.elementalFlavor(x, y, radius, damageType);
      return;
    }
    const r = look.death;
    const scale = SIZE_SCALE[look.size] * Math.min(1.7, Math.max(0.75, radius / 20));
    const isSmall = look.size === 'small';

    // 1) 碎块：材质 → 本层的粒子 kind
    const chunkKind = CHUNK_TO_KIND[r.chunks];
    const count = Math.min(28, Math.round(r.count * (scale > 1.3 ? 1.3 : 1)));
    for (let i = 0; i < count; i++) {
      const a = this.range(0, Math.PI * 2);
      const sp = this.range(r.speed[0], r.speed[1]) * (0.7 + 0.35 * scale);
      this.add({
        kind: chunkKind,
        x: x + this.range(-radius * 0.3, radius * 0.3),
        y: y + this.range(-radius * 0.3, radius * 0.3),
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        grav: -r.gravity,
        drag: r.chunks === 'goo' || r.chunks === 'bubble' ? 1.6 : 0.8,
        life: this.range(0.34, 0.34 + 0.5),
        size: this.range(r.size[0], r.size[1]) * Math.min(1.6, scale),
        color: r.color2 && this.rand() < 0.4 ? r.color2 : r.color,
        rot: a,
        spin: r.spin ? this.range(-9, 9) : this.range(-2, 2),
        shrink: 1,
      });
    }

    // 2) 冲击环（击杀重音）
    if (r.ring) {
      this.rings.push({
        x, y, r0: radius * 0.4, r1: r.ring.r1 * scale,
        life: r.ring.dur, maxLife: r.ring.dur, color: r.ring.color, width: r.ring.width, filled: false,
      });
    }
    // 3) 地面残留：本层无 decal 通道，用一圈低矮尘烟/斑痕近似
    if (r.decal) {
      for (let i = 0; i < 5; i++) {
        const a = this.range(0, Math.PI * 2);
        this.add({
          kind: 'dust',
          x: x + Math.cos(a) * r.decal.radius * scale * 0.5,
          y: y + Math.sin(a) * r.decal.radius * scale * 0.25,
          vx: Math.cos(a) * 12,
          vy: Math.sin(a) * 10,
          grav: -4,
          drag: 2.4,
          life: 0.9,
          size: r.decal.radius * scale * 0.5,
          color: r.decal.color,
          rot: a,
          spin: 0,
          shrink: 1,
        });
      }
    }
    // 4) 尘烟
    if (r.smoke) {
      const n = Math.round(r.smoke.count * Math.min(1.6, scale));
      for (let i = 0; i < n; i++) {
        const a = this.range(0, Math.PI * 2);
        this.add({
          kind: 'smoke',
          x: x + this.range(-radius * 0.4, radius * 0.4),
          y: y + this.range(-radius * 0.4, radius * 0.4),
          vx: Math.cos(a) * this.range(10, 34),
          vy: Math.sin(a) * this.range(10, 34) + 10,
          grav: 0,
          drag: 1.4,
          life: this.range(0.5, 0.95),
          size: (9 + this.rand() * 12) * Math.min(1.5, scale),
          color: r.smoke.color,
          rot: 0,
          spin: 0,
          shrink: 0,
        });
      }
    }
    // 5) 专属符号（近似映射到本层能力：斩痕/地刺/掉落→火花或碎片；魂火→上升星点；电弧→bolt；碎裂→环；裂纹→尘）
    if (r.glyphs) {
      for (const g of r.glyphs) {
        for (let i = 0; i < g.count; i++) {
          const a = this.range(0, Math.PI * 2);
          const sz = this.range(g.size[0], g.size[1]) * Math.min(1.5, scale);
          if (g.kind === 'arc') {
            // 电弧：一小段折线
            const ex = x + Math.cos(a) * 40;
            const ey = y + Math.sin(a) * 40;
            const mx = (x + ex) / 2 + this.range(-10, 10);
            const my = (y + ey) / 2 + this.range(-10, 10);
            if (this.bolts.length < MAX_BOLTS) {
              this.bolts.push({ pts: [[x, y], [mx, my], [ex, ey]], life: g.dur, maxLife: g.dur, color: g.color, width: 2.5 });
            }
          } else if (g.kind === 'wisp') {
            this.add({ kind: 'star', x, y, vx: this.range(-20, 20), vy: this.range(40, 90), grav: -20, drag: 1.0, life: g.dur, size: sz * 0.5, color: g.color, rot: 0.6, spin: 2, shrink: 1 });
          } else if (g.kind === 'shatter') {
            this.rings.push({ x, y, r0: sz * 1.5, r1: sz * 4, life: g.dur, maxLife: g.dur, color: g.color, width: 2, filled: false });
          } else if (g.kind === 'crack') {
            this.add({ kind: 'dust', x: x + Math.cos(a) * sz, y: y + Math.sin(a) * sz * 0.5, vx: Math.cos(a) * 30, vy: Math.sin(a) * 20, grav: -30, drag: 2, life: g.dur, size: sz * 0.6, color: g.color, rot: a, spin: 0, shrink: 1 });
          } else {
            // slash / drop / spike / split：碎片或火星向外飞
            this.add({ kind: g.kind === 'split' ? 'star' : 'shard', x, y, vx: Math.cos(a) * this.range(90, 200), vy: Math.sin(a) * this.range(90, 200), grav: -260, drag: 1.2, life: g.dur, size: sz * 0.5, color: g.color, rot: a, spin: this.range(-8, 8), shrink: 1 });
          }
        }
      }
    }

    // 6) 白闪收尾（打击确认；小怪更快）
    this.add({ kind: 'star', x, y, vx: 0, vy: 0, grav: 0, drag: 0, life: isSmall ? 0.1 : 0.13, size: radius * 1.4, color: '#FFFFFF', rot: 0.6, spin: 3, shrink: 1 });
    if (look.size === 'boss' || look.size === 'large') this.shake(isSmall ? 0 : look.size === 'boss' ? 7 : 3, 0.2);
    // 7) 致命元素风味（火余烬/冰碎晶/雷电弧/毒气泡/物理白闪）——只叠一层，不覆盖怪物身份
    this.elementalFlavor(x, y, radius, damageType);
  }

  /**
   * 致命元素风味（2D）：让"怎么死的"在画面上多一层可读的元素语言。
   * 火=上飘余烬 + 焦痕红晕；冰=四散碎晶 + 霜环；雷=短电弧；毒=绿气泡；物理=白色星芒。
   */
  private elementalFlavor(x: number, y: number, radius: number, damageType?: string | null): void {
    if (!damageType) return;
    const R = radius;
    if (damageType === 'fire') {
      this.rings.push({ x, y, r0: R * 0.5, r1: R * 1.6, life: 0.35, maxLife: 0.35, color: '#FF5A3C', width: 3, filled: false });
      for (let i = 0; i < 5; i++) {
        const a = this.range(0, Math.PI * 2);
        this.add({ kind: 'ember', x, y, vx: Math.cos(a) * this.range(30, 90), vy: this.range(60, 140), grav: -60, drag: 1.4, life: this.range(0.3, 0.6), size: this.range(2, 4), color: i % 2 ? '#FFD54F' : '#FF5A3C', rot: a, spin: 0, shrink: 1 });
      }
    } else if (damageType === 'frost') {
      this.rings.push({ x, y, r0: R * 0.6, r1: R * 1.9, life: 0.45, maxLife: 0.45, color: '#4FC3F7', width: 2, filled: false });
      for (let i = 0; i < 7; i++) {
        const a = this.range(0, Math.PI * 2);
        const sp = this.range(120, 260);
        this.add({ kind: 'shard', x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, grav: -120, drag: 1.4, life: this.range(0.3, 0.55), size: this.range(2.5, 5), color: i % 2 ? '#BFFFF2' : '#4FC3F7', rot: a, spin: this.range(-8, 8), shrink: 1 });
      }
    } else if (damageType === 'lightning') {
      for (let i = 0; i < 2; i++) {
        const a = this.range(0, Math.PI * 2);
        const ex = x + Math.cos(a) * 44;
        const ey = y + Math.sin(a) * 44;
        if (this.bolts.length < MAX_BOLTS) {
          this.bolts.push({ pts: [[x, y], [(x + ex) / 2 + this.range(-10, 10), (y + ey) / 2 + this.range(-10, 10)], [ex, ey]], life: 0.28, maxLife: 0.28, color: '#B388FF', width: 2.6 });
        }
      }
    } else if (damageType === 'poison') {
      for (let i = 0; i < 6; i++) {
        const a = this.range(0, Math.PI * 2);
        this.add({ kind: 'star', x: x + Math.cos(a) * R * 0.5, y: y + Math.sin(a) * R * 0.4, vx: Math.cos(a) * this.range(20, 70), vy: this.range(40, 110), grav: -30, drag: 1.8, life: this.range(0.35, 0.7), size: this.range(2, 3.6), color: '#7CB342', rot: a, spin: 0, shrink: 1 });
      }
    } else if (damageType === 'physical') {
      this.add({ kind: 'star', x, y, vx: 0, vy: 0, grav: 0, drag: 0, life: 0.14, size: R * 1.5, color: '#F5F5FA', rot: this.range(0, 1), spin: 3, shrink: 1 });
    }
  }

  /** 爆炸：火球闪 + 冲击环 + 火星 + 烟。 */
  explosion(x: number, y: number, radius: number, coreColor = '#FFD54F', edgeColor = '#FF5A3C'): void {
    this.rings.push({
      x, y, r0: radius * 0.2, r1: radius * 1.15,
      life: 0.34, maxLife: 0.34, color: coreColor, width: 7, filled: true,
    });
    this.rings.push({
      x, y, r0: radius * 0.5, r1: radius * 1.5,
      life: 0.45, maxLife: 0.45, color: edgeColor, width: 3, filled: false,
    });
    const n = Math.min(26, 14 + Math.round(radius / 7));
    for (let i = 0; i < n; i++) {
      const a = this.range(0, Math.PI * 2);
      const sp = this.range(90, 340);
      this.add({
        kind: 'ember',
        x: x + Math.cos(a) * radius * 0.25,
        y: y + Math.sin(a) * radius * 0.25,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        grav: -280,
        drag: 2.1,
        life: this.range(0.25, 0.6),
        size: this.range(2.6, 6),
        color: i % 3 === 0 ? coreColor : edgeColor,
        rot: a,
        spin: 0,
        shrink: 1,
      });
    }
    for (let i = 0; i < 4; i++) {
      this.add({
        kind: 'smoke',
        x: x + this.range(-radius * 0.3, radius * 0.3),
        y: y + this.range(-radius * 0.2, radius * 0.2),
        vx: this.range(-30, 30),
        vy: this.range(20, 70),
        grav: -20,
        drag: 1.4,
        life: this.range(0.5, 0.9),
        size: radius * this.range(0.18, 0.34),
        color: '#0B0C1D',
        rot: 0,
        spin: 0,
        shrink: 0,
      });
    }
    this.shake(Math.min(9, radius * 0.055), 0.22);
  }

  /** 城墙受击：碎屑 + 尘土 + 震屏。 */
  wallImpact(x: number, y: number, strength: number, color: string): void {
    const n = Math.min(12, 3 + Math.round(strength / 6));
    for (let i = 0; i < n; i++) {
      const a = this.range(Math.PI * 0.15, Math.PI * 0.85); // 向上飞溅
      const sp = this.range(80, 260);
      this.add({
        kind: 'shard',
        x: x + this.range(-10, 10),
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        grav: -820,
        drag: 0.5,
        life: this.range(0.3, 0.6),
        size: this.range(2, 4),
        color,
        rot: a,
        spin: this.range(-6, 6),
        shrink: 1,
      });
    }
    this.add({
      kind: 'smoke',
      x,
      y,
      vx: 0,
      vy: 30,
      grav: -10,
      drag: 2,
      life: 0.4,
      size: 16,
      color: '#0B0C1D',
      rot: 0,
      spin: 0,
      shrink: 0,
    });
    this.shake(Math.min(6, 1.5 + strength * 0.22), 0.16);
  }

  /** 治疗：绿色扩散环 + 上升光点。 */
  healPulse(x: number, y: number, radius: number): void {
    if (this.heals.length > 10) this.heals.shift();
    this.heals.push({ x, y, radius, life: 0.5, maxLife: 0.5 });
    for (let i = 0; i < 3; i++) {
      this.add({
        kind: 'star',
        x: x + this.range(-radius * 0.4, radius * 0.4),
        y: y + this.range(-radius * 0.2, radius * 0.2),
        vx: this.range(-8, 8),
        vy: this.range(30, 70),
        grav: -10,
        drag: 0.8,
        life: this.range(0.3, 0.6),
        size: this.range(2, 3.6),
        color: '#7CB342',
        rot: 0.6,
        spin: 2,
        shrink: 1,
      });
    }
  }

  transfer(fx: number, fy: number, tx: number, ty: number): void {
    if (this.transfers.length > 14) this.transfers.shift();
    this.transfers.push({ fx, fy, tx, ty, life: 0.3, maxLife: 0.3 });
    this.add({
      kind: 'star',
      x: tx,
      y: ty,
      vx: 0,
      vy: 0,
      grav: 0,
      drag: 0,
      life: 0.18,
      size: 9,
      color: '#B388FF',
      rot: 0.5,
      spin: 4,
      shrink: 1,
    });
  }

  chain(points: number[][], color = '#B388FF'): void {
    if (this.bolts.length >= MAX_BOLTS) this.bolts.shift();
    this.bolts.push({ pts: points, life: 0.3, maxLife: 0.3, color, width: 6 });
    for (const p of points) {
      if (this.particles.length > MAX_PARTICLES - 4) break;
      this.add({
        kind: 'spark',
        x: p[0],
        y: p[1],
        vx: this.range(-90, 90),
        vy: this.range(-90, 90),
        grav: 0,
        drag: 4,
        life: 0.16,
        size: 2,
        color: '#F5F5FA',
        rot: 0,
        spin: 0,
        shrink: 1,
      });
    }
  }

  muzzle(x: number, y: number, angle: number, color: string, size = 20, life = 0.07): void {
    if (this.muzzles.length > 12) this.muzzles.shift();
    this.muzzles.push({ x, y, angle, life, maxLife: life, color, size });
    for (let i = 0; i < 2; i++) {
      const a = angle + this.range(-0.35, 0.35);
      this.add({
        kind: 'spark',
        x,
        y,
        vx: Math.cos(a) * this.range(180, 380),
        vy: Math.sin(a) * this.range(180, 380),
        grav: 0,
        drag: 5,
        life: 0.1,
        size: 1.6,
        color: '#FFFFFF',
        rot: a,
        spin: 0,
        shrink: 1,
      });
    }
  }

  /** 升级：英雄脚下金色扩散环 + 上升星点。 */
  levelUp(x: number, y: number): void {
    for (let i = 0; i < 3; i++) {
      this.rings.push({
        x, y, r0: 12, r1: 90 + i * 28,
        life: 0.55 + i * 0.12, maxLife: 0.55 + i * 0.12, color: '#FFD54F', width: 3 - i * 0.6, filled: false,
      });
    }
    for (let i = 0; i < 10; i++) {
      const a = this.range(0, Math.PI * 2);
      this.add({
        kind: 'star',
        x: x + Math.cos(a) * 26,
        y: y + Math.sin(a) * 12,
        vx: Math.cos(a) * this.range(20, 70),
        vy: this.range(60, 160),
        grav: -60,
        drag: 1.2,
        life: this.range(0.4, 0.8),
        size: this.range(2, 4),
        color: '#FFD54F',
        rot: 0.6,
        spin: 2,
        shrink: 1,
      });
    }
  }

  clear(): void {
    this.particles.length = 0;
    this.rings.length = 0;
    this.bolts.length = 0;
    this.floats.length = 0;
    this.heals.length = 0;
    this.transfers.length = 0;
    this.muzzles.length = 0;
  }

  // ---------------- 内部 ----------------

  private add(p: Omit<Particle, 'maxLife'>): void {
    if (this.particles.length >= MAX_PARTICLES) this.particles.shift();
    this.particles.push({ ...p, maxLife: p.life });
  }

  update(dt: number): void {
    this.clock += dt;
    if (this.shakeLeft > 0) this.shakeLeft = Math.max(0, this.shakeLeft - dt);

    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      if (p.life <= 0) {
        this.particles.splice(i, 1);
        continue;
      }
      p.vy += p.grav * dt;
      if (p.drag > 0) {
        const k = Math.max(0, 1 - p.drag * dt);
        p.vx *= k;
        p.vy *= k;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.spin * dt;
    }

    for (let i = this.rings.length - 1; i >= 0; i--) {
      this.rings[i].life -= dt;
      if (this.rings[i].life <= 0) this.rings.splice(i, 1);
    }
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      this.bolts[i].life -= dt;
      if (this.bolts[i].life <= 0) this.bolts.splice(i, 1);
    }
    for (let i = this.floats.length - 1; i >= 0; i--) {
      const f = this.floats[i];
      f.life -= dt;
      if (f.life <= 0) this.floats.splice(i, 1);
    }
    for (let i = this.heals.length - 1; i >= 0; i--) {
      this.heals[i].life -= dt;
      if (this.heals[i].life <= 0) this.heals.splice(i, 1);
    }
    for (let i = this.transfers.length - 1; i >= 0; i--) {
      this.transfers[i].life -= dt;
      if (this.transfers[i].life <= 0) this.transfers.splice(i, 1);
    }
    for (let i = this.muzzles.length - 1; i >= 0; i--) {
      this.muzzles[i].life -= dt;
      if (this.muzzles[i].life <= 0) this.muzzles.splice(i, 1);
    }
  }

  /** 在 y 已翻转的游戏坐标系内绘制。 */
  draw(ctx: CanvasRenderingContext2D): void {
    this.drawGround(ctx);
    this.drawParticles(ctx);
    this.drawRings(ctx);
    this.drawBolts(ctx);
    this.drawMuzzles(ctx);
  }

  private drawGround(ctx: CanvasRenderingContext2D): void {
    // 治疗环：两层（扩散 + 滞留），信息型表现（治疗落点）
    for (const h of this.heals) {
      const k = 1 - h.life / h.maxLife;
      const a = 1 - k;
      ctx.strokeStyle = rgba('#7CB342', 0.55 * a);
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.ellipse(h.x, h.y, h.radius * (0.35 + 0.65 * k), h.radius * (0.35 + 0.65 * k) * 0.82, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = rgba('#7CB342', 0.06 * a);
      ctx.fill();
      ctx.strokeStyle = rgba('#AEEA00', 0.35 * a);
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.ellipse(h.x, h.y, h.radius * 0.72, h.radius * 0.6, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    // 转嫁电弧：紫光带 + 白芯 + 中途闪烁
    for (const tr of this.transfers) {
      const a = Math.min(1, tr.life / tr.maxLife);
      const seg = 3;
      const pts: number[][] = [[tr.fx, tr.fy]];
      for (let i = 1; i < seg; i++) {
        const k = i / seg;
        pts.push([
          tr.fx + (tr.tx - tr.fx) * k + (hash01(i * 7.7 + tr.fx) - 0.5) * 34,
          tr.fy + (tr.ty - tr.fy) * k + (hash01(i * 3.1 + tr.fy) - 0.5) * 34,
        ]);
      }
      pts.push([tr.tx, tr.ty]);
      ctx.strokeStyle = rgba('#B388FF', 0.35 * a);
      ctx.lineWidth = 6;
      ctx.beginPath();
      pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p[0], p[1]) : ctx.lineTo(p[0], p[1])));
      ctx.stroke();
      ctx.strokeStyle = rgba('#F5F5FA', 0.9 * a);
      ctx.lineWidth = 1.6;
      ctx.stroke();
    }
  }

  private drawParticles(ctx: CanvasRenderingContext2D): void {
    // 先画非加色（碎片/烟）再画加色（火花/余烬），一次切换混合模式
    for (const p of this.particles) {
      if (p.kind !== 'shard' && p.kind !== 'smoke') continue;
      const k = p.life / p.maxLife;
      ctx.globalAlpha = p.kind === 'smoke' ? k * 0.34 : Math.min(1, k * 1.6);
      ctx.fillStyle = p.color;
      if (p.kind === 'shard') {
        const s = p.size * (p.shrink ? 0.4 + 0.6 * k : 1);
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.beginPath();
        ctx.moveTo(-s, -s * 0.55);
        ctx.lineTo(s, 0);
        ctx.lineTo(-s * 0.7, s * 0.7);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      } else {
        const s = p.size * (1 + (1 - k) * 1.6);
        ctx.beginPath();
        ctx.arc(p.x, p.y, s, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const p of this.particles) {
      if (p.kind === 'shard' || p.kind === 'smoke') continue;
      const k = p.life / p.maxLife;
      if (p.kind === 'spark') {
        const len = 7 + p.size * 2.2;
        ctx.strokeStyle = rgba(p.color, Math.min(1, k * 1.8));
        ctx.lineWidth = p.size * 0.8;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - Math.cos(p.rot) * len, p.y - Math.sin(p.rot) * len);
        ctx.stroke();
      } else if (p.kind === 'ember') {
        ctx.globalAlpha = Math.min(1, k * 1.5);
        // 复用光晕精灵，余烬带一点柔和发光但不额外创建渐变
        ctx.drawImage(
          glowSprite(p.color),
          p.x - p.size * 2.6,
          p.y - p.size * 2.6,
          p.size * 5.2,
          p.size * 5.2,
        );
        ctx.globalAlpha = 1;
      } else if (p.kind === 'star') {
        const s = p.size * (p.shrink ? 0.3 + 0.7 * k : 1);
        ctx.strokeStyle = rgba(p.color, Math.min(1, k * 1.6));
        ctx.lineWidth = 1.6;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.beginPath();
        ctx.moveTo(-s, 0);
        ctx.lineTo(s, 0);
        ctx.moveTo(0, -s * 0.55);
        ctx.lineTo(0, s * 0.55);
        ctx.stroke();
        ctx.restore();
      }
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  private drawRings(ctx: CanvasRenderingContext2D): void {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const r of this.rings) {
      const k = 1 - r.life / r.maxLife;
      const a = (1 - k) * (1 - k);
      const rad = r.r0 + (r.r1 - r.r0) * (1 - Math.pow(1 - k, 2.4));
      if (r.filled) {
        const grad = ctx.createRadialGradient(r.x, r.y, 0, r.x, r.y, Math.max(1, rad));
        grad.addColorStop(0, rgba(r.color, 0.55 * a));
        grad.addColorStop(0.55, rgba(r.color, 0.22 * a));
        grad.addColorStop(1, rgba(r.color, 0));
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(r.x, r.y, rad, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.strokeStyle = rgba(r.color, 0.85 * a);
        ctx.lineWidth = Math.max(0.6, r.width * (1 - k * 0.7));
        ctx.beginPath();
        ctx.arc(r.x, r.y, rad, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  private drawBolts(ctx: CanvasRenderingContext2D): void {
    for (const b of this.bolts) {
      const a = Math.min(1, b.life / b.maxLife);
      ctx.strokeStyle = rgba(b.color, 0.3 * a);
      ctx.lineWidth = b.width * 2.2;
      ctx.beginPath();
      this.boltPath(ctx, b.pts);
      ctx.stroke();
      ctx.strokeStyle = rgba(b.color, 0.95 * a);
      ctx.lineWidth = b.width;
      ctx.beginPath();
      this.boltPath(ctx, b.pts);
      ctx.stroke();
      ctx.strokeStyle = rgba('#F5F5FA', 0.95 * a);
      ctx.lineWidth = Math.max(1, b.width * 0.35);
      ctx.beginPath();
      this.boltPath(ctx, b.pts);
      ctx.stroke();
    }
  }

  private boltPath(ctx: CanvasRenderingContext2D, pts: number[][]): void {
    let first = true;
    // 每段再细分成 2 小段并各自抖动 → 锯齿状电弧（比单折线更像闪电）
    for (let s = 0; s < pts.length - 1; s++) {
      const [x1, y1] = pts[s];
      const [x2, y2] = pts[s + 1];
      if (first) {
        ctx.moveTo(x1, y1);
        first = false;
      }
      for (let j = 1; j <= 2; j++) {
        const k = j / 3;
        const amp = j === 2 ? 1.6 : 1;
        const jx = (hash01(s * 13.7 + j * 3.1 + x1 * 0.11) - 0.5) * 30 * amp;
        const jy = (hash01(s * 7.3 + j * 5.7 + y1 * 0.13) - 0.5) * 30 * amp;
        ctx.lineTo(x1 + (x2 - x1) * k + jx, y1 + (y2 - y1) * k + jy);
      }
      ctx.lineTo(x2, y2);
    }
  }

  private drawMuzzles(ctx: CanvasRenderingContext2D): void {
    if (this.muzzles.length === 0) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const m of this.muzzles) {
      const k = m.life / m.maxLife;
      const len = m.size * (0.6 + 0.7 * k);
      ctx.fillStyle = rgba(m.color, 0.75 * k);
      ctx.beginPath();
      ctx.moveTo(m.x, m.y);
      ctx.lineTo(
        m.x + Math.cos(m.angle - 0.35) * len,
        m.y + Math.sin(m.angle - 0.35) * len,
      );
      ctx.lineTo(
        m.x + Math.cos(m.angle) * len * 1.7,
        m.y + Math.sin(m.angle) * len * 1.7,
      );
      ctx.lineTo(
        m.x + Math.cos(m.angle + 0.35) * len,
        m.y + Math.sin(m.angle + 0.35) * len,
      );
      ctx.closePath();
      ctx.fill();
      ctx.drawImage(glowSprite(m.color), m.x - m.size, m.y - m.size, m.size * 2, m.size * 2);
    }
    ctx.restore();
  }

  /** 飘字需要回到未翻转坐标系绘制（否则文字倒置）。 */
  drawTexts(ctx: CanvasRenderingContext2D, screenH: number): void {
    if (this.floats.length === 0) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const f of this.floats) {
      const k = f.life / f.maxLife;
      const age = 1 - k;
      const pop = 1 + f.pop * Math.exp(-age * 11);
      const alpha = Math.min(1, k * 2.2);
      const y = screenH - (f.y + age * f.vy);
      ctx.globalAlpha = alpha;
      ctx.font = `800 ${Math.round(f.size * pop)}px "PingFang SC", "Microsoft YaHei", sans-serif`;
      ctx.lineWidth = Math.max(2, f.size * 0.16);
      ctx.strokeStyle = 'rgba(7,8,15,.72)';
      ctx.strokeText(f.text, f.x, y);
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, f.x, y);
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }
}
