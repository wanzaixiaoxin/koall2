/**
 * 战场场景渲染器：把「一个 GameSession 的世界」画成一张有层次、有生命的画面。
 *
 * 分层（从后到前，对应可读性铁律：玩家 > 弹幕 > 精英/Boss > 小怪 > 场景）：
 *   夜空/星尘/网格 → 虫苔 → 弹坑 → 城墙 → 小怪 → 光束 → 英雄 → 弹幕 → 粒子/飘字
 *
 * 主游戏（main.ts）与卡牌实验室（lab.ts）共用本渲染器，保证两端视觉完全一致。
 * 只读取 session 快照 + 订阅事件，绝不回写逻辑。
 */
import { DamagePool, GameSession, MonsterRuntime } from '../../../gamecore';
import { EffectsLayer } from './particles';
import { FxRuntime, sampleKeyframes } from './fx';
import {
  drawHero,
  drawMonster,
  drawLaser,
  drawMonsterShot,
  drawMonsterStatus,
  drawPool,
  drawProjectile,
  drawSegments,
  monsterColorByKey,
} from './shapes';
import { darken, drawGlow, hash01, lighten, mix, rgba } from './style';

export interface ScenePalette {
  background: { night: string; nightDeep: string; gridLine: string };
  chapterAccent: Record<string, string>;
  enemy: { primary: string; elite: string; boss: string };
  friendly: { hero: string; assist: string; wall: string; wallDamaged: string };
  damageType: Record<string, string>;
  ui: Record<string, string>;
}

const WALL_SEGS = 12;

export class SceneRenderer {
  readonly W: number;
  readonly H: number;
  readonly effects = new EffectsLayer();
  private palette: ScenePalette;
  private fx: FxRuntime;

  private bg: HTMLCanvasElement | null = null;
  private bgKey = '';
  private lastMs = 0;

  /** 出场缩放：首次看到的时刻（WeakMap 以怪物对象为键，避免 id 复用导致的错乱） */
  private seenAt = new WeakMap<MonsterRuntime, number>();

  /** 英雄视觉状态（纯渲染层，不参与逻辑） */
  private aim = Math.PI / 2;
  private recoil = 0;
  private prevHeroX = 0;
  private lean = 0;
  private heroInit = false;

  /** 每段城墙的受击闪光计时（秒） */
  private wallFlash = new Array<number>(WALL_SEGS).fill(0);
  private wallHeal = new Array<number>(WALL_SEGS).fill(0);

  constructor(W: number, H: number, palette: ScenePalette, fx: FxRuntime) {
    this.W = W;
    this.H = H;
    this.palette = palette;
    this.fx = fx;
  }

  get floatCount(): number {
    return this.effects.floats.length;
  }

  /** 把渲染层接到一个会话的事件总线上（每次新建会话后调用一次）。 */
  attach(session: GameSession): void {
    const bus = session.bus;
    const fx = this.fx;
    const eff = this.effects;
    this.wallFlash.fill(0);
    this.wallHeal.fill(0);
    this.heroInit = false;

    bus.on<{ monsterId?: number; dmg: number; isCrit: boolean; blocked?: boolean; mitigated?: number; x: number; y: number }>(
      'onHit',
      ({ monsterId, dmg, isCrit, blocked, mitigated, x, y }) => {
        if (monsterId !== undefined && !blocked) fx.markHit(monsterId, session.timeSec);
        if (blocked) {
          eff.pushFloat(x, y - 12, '挡', '#8A93B8', 15);
          eff.impact(x, y, '#8A93B8', undefined, 2);
          return;
        }
        if (mitigated && mitigated > 0) eff.pushFloat(x + 22, y + 34, `抵${mitigated}`, '#8A93B8', 12);
        eff.pushFloat(
          x + (hash01(x + y * 3.3 + dmg) - 0.5) * 26,
          y + 18,
          String(Math.round(dmg)),
          isCrit ? '#FFD54F' : '#F5F5FA',
          isCrit ? 30 : 18,
          { crit: isCrit },
        );
        const sparkBase = this.fx.cfg.hitSpark?.count ?? 3;
        eff.impact(x, y, isCrit ? '#FFD54F' : '#F5F5FA', undefined, isCrit ? sparkBase * 2 : sparkBase);
        if (isCrit) {
          eff.rings.push({ x, y, r0: 4, r1: 26, life: 0.2, maxLife: 0.2, color: '#FFD54F', width: 2.5, filled: false });
          eff.shake(1.6, 0.08);
        }
      },
    );

    bus.on<{ monsterId: number; key: string }>('onKill', ({ monsterId, key }) => {
      const m = session.monsters.find((x) => x.id === monsterId);
      if (!m) return;
      const color = monsterColorByKey(key);
      eff.deathBurst(m.x, m.y, color, m.cfg.radius);
      if (m.cfg.shape === 'boss') {
        eff.explosion(m.x, m.y, m.cfg.radius * 1.6, '#B537F2', '#FF3D71');
        eff.shake(9, 0.4);
      }
    });

    bus.on<{ x: number; y: number; radius: number }>('onExplode', ({ x, y, radius }) => {
      eff.explosion(x, y, radius);
    });

    bus.on<{ dmg: number; x: number; y: number }>('onWallHit', ({ dmg, x, y }) => {
      eff.pushFloat(x, y, `-${Math.round(dmg)}`, '#FF6B57', 17);
      const seg = Math.max(0, Math.min(WALL_SEGS - 1, Math.floor(x / (this.W / WALL_SEGS))));
      this.wallFlash[seg] = 0.26;
      eff.wallImpact(x, y, dmg, this.palette.friendly.wall);
    });

    bus.on<{ wallHp: number; wallMaxHp: number }>('onWallHeal', () => {
      this.wallHeal.fill(0.5);
      eff.pushFloat(this.W / 2, this.H * 0.12, '城防修复', '#5EE1FF', 20);
    });

    bus.on('onShoot', () => {
      const h = session.hero;
      const tip = 30;
      eff.muzzle(
        h.x + Math.cos(this.aim) * tip,
        h.y + Math.sin(this.aim) * tip,
        this.aim,
        this.palette.damageType.physical ?? '#F5F5FA',
        16,
        (this.fx.cfg.muzzleFlash?.duration ?? 70) / 1000,
      );
      this.recoil = this.fx.cfg.heroRecoil?.distance ?? 5.5;
    });

    bus.on<{ points: number[][] }>('onChain', ({ points }) => eff.chain(points));

    // 激光开火：轻微震屏 + 枪口冲击尘（光束的"重量感"）
    bus.on<{ hits: number; energy: number }>('onLaser', ({ hits }) => {
      eff.shake(hits > 0 ? 2.4 : 1.2, 0.1);
      const h = session.hero;
      eff.muzzle(h.x + Math.cos(this.aim) * 30, h.y + Math.sin(this.aim) * 30, this.aim, '#FFFFFF', 22, 0.08);
    });

    bus.on<{ x: number; y: number; radius: number }>('onHeal', ({ x, y, radius }) => eff.healPulse(x, y, radius));
    bus.on<{ x: number; y: number; amount: number }>('onHealed', ({ x, y, amount }) =>
      eff.pushFloat(x, y, `+${amount}`, '#7CB342', 15),
    );
    bus.on<{ fx: number; fy: number; tx: number; ty: number; dmg: number }>(
      'onDamageTransfer',
      ({ fx, fy, tx, ty, dmg }) => {
        eff.transfer(fx, fy, tx, ty);
        eff.pushFloat(tx, ty + 24, `转${Math.round(dmg)}`, '#B388FF', 14);
      },
    );
    bus.on<{ dmg: number; x: number; y: number }>('onBurnTick', ({ dmg, x, y }) =>
      eff.pushFloat(x, y, String(Math.round(dmg * 10) / 10), '#FF9A3C', 13),
    );
    bus.on<{ dmg: number; x: number; y: number }>('onPoolTick', ({ dmg, x, y }) =>
      eff.pushFloat(x, y, String(dmg), '#FF6B57', 12),
    );
    bus.on<{ level: number }>('onLevelUp', () => {
      eff.levelUp(session.hero.x, session.hero.y);
      eff.pushFloat(session.hero.x, session.hero.y + 40, 'LEVEL UP', '#FFD54F', 22, { crit: true, life: 1.1 });
    });
  }

  // ---------------- 主渲染 ----------------

  render(ctx: CanvasRenderingContext2D, session: GameSession, timeMs: number): void {
    const dt = Math.min(0.05, Math.max(0.001, (timeMs - this.lastMs) / 1000 || 0.016));
    this.lastMs = timeMs;
    const t = timeMs / 1000;
    const now = session.timeSec;
    const wallTop = session.level.wall.height;
    const wallRatio = session.wallHp / session.wallMaxHp;

    this.effects.update(dt);
    this.updateHeroVisuals(session, dt, t);
    for (let i = 0; i < WALL_SEGS; i++) {
      this.wallFlash[i] = Math.max(0, this.wallFlash[i] - dt);
      this.wallHeal[i] = Math.max(0, this.wallHeal[i] - dt);
    }

    const sh = this.effects.shakeOffset;

    // 背景（屏幕坐标，不翻转）
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.drawBackground(ctx, session, t, wallRatio, sh);

    // 战场实体（y 轴翻转）
    ctx.setTransform(1, 0, 0, -1, sh.x, this.H + sh.y);

    this.drawCreep(ctx, session, t);
    for (const pool of session.pools) drawPool(ctx, pool, now);
    this.drawWall(ctx, session, wallRatio, t, dt);

    // 怪物：按 y 从远到近绘制（painter's algorithm），同层重叠时近处在上
    const monsters = session.monsters.slice().sort((a, b) => b.y - a.y);
    for (const m of monsters) {
      const scale = this.spawnScale(m, timeMs);
      drawMonster(ctx, m, t, this.fx.flashAlpha(m.id, now), this.fx.hitSquash(m.id, now), scale);
    }
    // 状态与血条画在全体怪之上，避免被后画的怪遮住
    for (const m of monsters) {
      drawMonsterStatus(ctx, m, t, now);
      this.drawHpBar(ctx, m);
    }

    drawSegments(ctx, session.segments, now, '#B388FF');

    // 激光能量束（瞬时结算的视觉快照）
    const laserColor = (type: string): string => this.palette.damageType[type] ?? '#B388FF';
    for (const beam of session.lasers) {
      drawLaser(ctx, beam, t, laserColor(beam.damageType));
    }

    // 英雄
    const h = session.hero;
    drawHero(ctx, h, t, { aim: this.aim, recoil: this.recoil, lean: this.lean });

    // 投射物
    const projColor = (type: string): string => this.palette.damageType[type] ?? '#BFFFF2';
    for (const p of session.projectiles) drawProjectile(ctx, p, t, projColor(p.damageType));
    for (const s of session.monsterShots) drawMonsterShot(ctx, s, t);

    // 粒子 / 冲击环 / 电弧 / 炮口闪光
    this.effects.draw(ctx);

    // 飘字（回到屏幕坐标）
    this.effects.drawTexts(ctx, this.H);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  // ---------------- 英雄视觉 ----------------

  private updateHeroVisuals(session: GameSession, dt: number, t: number): void {
    const h = session.hero;
    if (!this.heroInit) {
      this.prevHeroX = h.x;
      this.heroInit = true;
    }
    // 瞄准最近的可见怪物（纯表现：让炮塔朝向威胁，英雄"活"起来）
    let target: MonsterRuntime | null = null;
    let bestD = Infinity;
    for (const m of session.monsters) {
      if (m.burrowed) continue;
      const d = (m.x - h.x) ** 2 + (m.y - h.y) ** 2;
      if (d < bestD) {
        bestD = d;
        target = m;
      }
    }
    const want = target ? Math.atan2(target.y - h.y, target.x - h.x) : Math.PI / 2 + Math.sin(t * 0.8) * 0.08;
    // 角度插值（走最短弧）
    let diff = want - this.aim;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    this.aim += diff * Math.min(1, dt * 12);
    this.recoil *= Math.exp(-dt * 16);
    // 移动前倾：由位移速度推导
    const vx = dt > 0 ? (h.x - this.prevHeroX) / dt : 0;
    this.prevHeroX = h.x;
    const targetLean = Math.max(-1, Math.min(1, vx / 700)) * 0.16;
    this.lean += (targetLean - this.lean) * Math.min(1, dt * 10);
  }

  /** 出场缩放（fx-config.spawnPop.scale 关键帧；缺省 0.2→1.08→1）。 */
  private spawnScale(m: MonsterRuntime, timeMs: number): number {
    let at = this.seenAt.get(m);
    if (at === undefined) {
      at = timeMs;
      this.seenAt.set(m, at);
    }
    const dur = this.fx.cfg.spawnPop?.duration ?? 220;
    const k = Math.min(1, (timeMs - at) / Math.max(1, dur));
    const frames = this.fx.cfg.spawnPop?.scale ?? [0.2, 1.08, 1];
    return sampleKeyframes(frames, k, this.fx.cfg.spawnPop?.easing ?? 'easeOutBack');
  }

  // ---------------- 背景 ----------------

  private buildBackground(session: GameSession): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = this.W;
    c.height = this.H;
    const g = c.getContext('2d')!;
    const pal = this.palette;

    // 夜空：上深下渐亮（靠近城墙有地平线微光，形成纵深）
    const sky = g.createLinearGradient(0, 0, 0, this.H);
    sky.addColorStop(0, pal.background.nightDeep);
    sky.addColorStop(0.55, pal.background.night);
    sky.addColorStop(1, mix(pal.background.night, pal.friendly.wall, 0.18));
    g.fillStyle = sky;
    g.fillRect(0, 0, this.W, this.H);

    // 网格（场景=矩形/网格语言），向下渐隐
    g.strokeStyle = pal.background.gridLine;
    g.lineWidth = 1;
    for (let x = 0; x <= this.W; x += 90) {
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, this.H);
      g.stroke();
    }
    for (let y = 0; y <= this.H; y += 90) {
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(this.W, y);
      g.stroke();
    }
    const fade = g.createLinearGradient(0, this.H * 0.2, 0, this.H);
    fade.addColorStop(0, 'rgba(11,12,29,0)');
    fade.addColorStop(1, 'rgba(11,12,29,0.85)');
    g.fillStyle = fade;
    g.fillRect(0, 0, this.W, this.H);

    // 星尘（静态，均匀分布；大小/明度分层形成深度）
    for (let i = 0; i < 150; i++) {
      const x = hash01(i * 12.9 + 3.1) * this.W;
      const y = hash01(i * 7.7 + 11.3) * this.H * 0.85;
      const size = 0.6 + hash01(i * 3.3) * 1.9;
      const a = 0.06 + hash01(i * 5.1) * 0.26;
      g.fillStyle = i % 11 === 0 ? rgba(pal.chapterAccent.chapter_1 ?? '#35E0C3', a) : `rgba(245,245,250,${a})`;
      g.beginPath();
      g.arc(x, y, size, 0, Math.PI * 2);
      g.fill();
    }

    // 地平线微光（章节点缀色，极低透明度 → 不抢主体）
    const accent = pal.chapterAccent.chapter_1 ?? pal.friendly.hero;
    const horiz = g.createLinearGradient(0, this.H * 0.75, 0, this.H);
    horiz.addColorStop(0, rgba(accent, 0));
    horiz.addColorStop(1, rgba(accent, 0.06));
    g.fillStyle = horiz;
    g.fillRect(0, this.H * 0.75, this.W, this.H * 0.25);

    // 暗角（把视线收束到画面中央的战场）
    const vig = g.createRadialGradient(this.W / 2, this.H * 0.55, this.H * 0.18, this.W / 2, this.H * 0.55, this.H * 0.72);
    vig.addColorStop(0, 'rgba(7,8,15,0)');
    vig.addColorStop(1, 'rgba(7,8,15,0.62)');
    g.fillStyle = vig;
    g.fillRect(0, 0, this.W, this.H);
    return c;
  }

  private drawBackground(
    ctx: CanvasRenderingContext2D,
    session: GameSession,
    t: number,
    wallRatio: number,
    sh: { x: number; y: number },
  ): void {
    const key = `${this.W}x${this.H}`;
    if (!this.bg || this.bgKey !== key) {
      this.bg = this.buildBackground(session);
      this.bgKey = key;
    }
    ctx.fillStyle = this.palette.background.nightDeep;
    ctx.fillRect(0, 0, this.W, this.H);
    ctx.drawImage(this.bg, sh.x, sh.y);

    // 漂浮微尘（缓慢漂移的光点，给静态背景注入"空气感"）
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 22; i++) {
      const speed = 6 + hash01(i * 2.3) * 18;
      const x = (hash01(i * 9.1) * this.W + t * speed) % this.W;
      const y = hash01(i * 4.7) * this.H * 0.9;
      const a = 0.05 + 0.09 * (0.5 + 0.5 * Math.sin(t * 0.7 + i));
      ctx.fillStyle = rgba(i % 5 === 0 ? (this.palette.chapterAccent.chapter_1 ?? '#35E0C3') : '#F5F5FA', a);
      ctx.beginPath();
      ctx.arc(x, y, 1.1 + hash01(i * 6.1) * 1.2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // 城防告急：全屏红色呼吸暗角（信息型，比单纯 HUD 数字更直观）
    if (wallRatio < 0.3) {
      const k = 1 - wallRatio / 0.3;
      const pulse = 0.5 + 0.5 * Math.sin(t * 4);
      const g = ctx.createRadialGradient(this.W / 2, this.H * 0.5, this.H * 0.3, this.W / 2, this.H * 0.5, this.H * 0.8);
      g.addColorStop(0, 'rgba(255,61,113,0)');
      g.addColorStop(1, `rgba(255,61,113,${(0.1 + 0.12 * pulse) * k})`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, this.W, this.H);
    }
  }

  // ---------------- 城墙 ----------------

  private drawWall(
    ctx: CanvasRenderingContext2D,
    session: GameSession,
    ratio: number,
    t: number,
    _dt: number,
  ): void {
    const pal = this.palette;
    const segW = this.W / WALL_SEGS;
    const top = session.level.wall.height;
    const warn = ratio < 0.3;
    const damaged = ratio < 0.55; // 破损配色阈值：前期只出裂纹，不整面变红

    for (let i = 0; i < WALL_SEGS; i++) {
      const flash = this.wallFlash[i];
      const heal = this.wallHeal[i];
      // 受击段抖动（3px 级，快频率衰减）
      const shakeX = flash > 0 ? Math.sin(t * 90 + i) * 3 * (flash / 0.26) : 0;
      const x = i * segW + 3 + shakeX;
      const w = segW - 6;

      // 破损程度：整体血线 + 每段确定性差异（不是整齐划一的"同一个墙"）
      const segSeed = hash01(i * 7.7 + 1.3);
      const ruin = ratio < 0.2 && segSeed > 0.55 ? 1 : ratio < 0.4 && segSeed > 0.8 ? 0.6 : 0;

      const baseColor = damaged ? pal.friendly.wallDamaged : pal.friendly.wall;
      const bodyTop = top - 12;

      // 主体（圆角矩形）
      if (ruin < 1) {
        ctx.beginPath();
        ctx.roundRect(x, 6, w, bodyTop, 8);
        ctx.fillStyle = baseColor;
        ctx.fill();
        // 顶面受光 + 底部暗部（体积感）
        ctx.beginPath();
        ctx.roundRect(x, bodyTop - 6, w, 6, 4);
        ctx.fillStyle = rgba(lighten(baseColor, 0.35), 0.9);
        ctx.fill();
        ctx.beginPath();
        ctx.roundRect(x, 6, w, 8, 4);
        ctx.fillStyle = rgba(darken(baseColor, 0.45), 0.8);
        ctx.fill();
        // 砖缝
        ctx.strokeStyle = rgba(darken(baseColor, 0.55), 0.55);
        ctx.lineWidth = 1.4;
        const rows = Math.max(2, Math.floor(bodyTop / 22));
        for (let rIdx = 1; rIdx < rows; rIdx++) {
          const yy = 6 + (bodyTop * rIdx) / rows;
          ctx.beginPath();
          ctx.moveTo(x + 2, yy);
          ctx.lineTo(x + w - 2, yy);
          ctx.stroke();
          const offset = rIdx % 2 === 0 ? segW * 0.25 : segW * 0.5;
          ctx.beginPath();
          ctx.moveTo(x + offset, yy);
          ctx.lineTo(x + offset, yy - bodyTop / rows);
          ctx.stroke();
        }
        // 城垛（merlon）：2~3 个凸起，破损时缺角
        const merlons = 3;
        for (let k = 0; k < merlons; k++) {
          const missing = (ruin >= 0.6 && hash01(i * 3.1 + k) > 0.55) || (damaged && hash01(i * 5.3 + k) > 0.82);
          if (missing) continue;
          const mw = w * 0.22;
          const mx = x + w * (0.08 + k * 0.34);
          ctx.beginPath();
          ctx.roundRect(mx, top - 2, mw, 12, 3);
          ctx.fillStyle = baseColor;
          ctx.fill();
          ctx.beginPath();
          ctx.roundRect(mx, top + 7, mw, 3, 1.5);
          ctx.fillStyle = rgba(lighten(baseColor, 0.4), 0.85);
          ctx.fill();
        }
        // 裂纹（破损档）
        if (ratio < 0.7 || ruin > 0) {
          const cracks = ratio < 0.3 ? 3 : ratio < 0.55 ? 2 : 1;
          ctx.strokeStyle = rgba('#07080F', 0.55);
          ctx.lineWidth = 1.6;
          for (let k = 0; k < cracks; k++) {
            const cx = x + w * (0.2 + hash01(i * 9.1 + k) * 0.6);
            const cy = 6 + bodyTop * (0.2 + hash01(i * 4.2 + k) * 0.5);
            ctx.beginPath();
            ctx.moveTo(cx, top - 4);
            ctx.lineTo(cx + (hash01(i + k) - 0.5) * 14, cy);
            ctx.lineTo(cx + (hash01(i * 2 + k) - 0.5) * 20, cy - 12);
            ctx.stroke();
          }
        }
        // 受击白闪
        if (flash > 0) {
          ctx.beginPath();
          ctx.roundRect(x, 6, w, bodyTop, 8);
          ctx.fillStyle = rgba('#FFFFFF', 0.55 * (flash / 0.26));
          ctx.fill();
        }
        // 治疗修复：青色辉光扫过
        if (heal > 0) {
          ctx.beginPath();
          ctx.roundRect(x, 6, w, bodyTop, 8);
          ctx.fillStyle = rgba('#5EE1FF', 0.28 * (heal / 0.5));
          ctx.fill();
        }
      }

      // 告急红光呼吸（整体 + 每段顶部）
      if (warn) {
        const pulse = 0.35 + 0.3 * Math.sin(t * 3 + i * 0.4);
        ctx.fillStyle = rgba('#FF3D71', 0.1 + 0.08 * pulse);
        ctx.beginPath();
        ctx.roundRect(x, 6, w, bodyTop, 8);
        ctx.fill();
        ctx.strokeStyle = rgba('#FF3D71', pulse);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x, top + 10);
        ctx.lineTo(x + w, top + 10);
        ctx.stroke();
      }
    }

    // 城墙整体的"能量基座"亮线（把墙体与地面衔接起来）
    ctx.strokeStyle = rgba(lighten(pal.friendly.wall, 0.5), 0.35);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, 5);
    ctx.lineTo(this.W, 5);
    ctx.stroke();
  }

  // ---------------- 虫苔 ----------------

  private drawCreep(ctx: CanvasRenderingContext2D, session: GameSession, t: number): void {
    if (session.creep.size === 0) return;
    const CELL = 90;
    const creepColor = '#7CB342';
    for (const [key, until] of session.creep) {
      const cx = Math.floor(key / 4096);
      const cy = key % 4096;
      const x = cx * CELL;
      const y = cy * CELL;
      const left = until - session.timeSec;
      const fade = Math.min(1, Math.max(0, left / 3)); // 收尾渐隐
      const s = hash01(cx * 3.7 + cy * 9.1);
      // 有机地块：两枚错位椭圆叠成不规则斑块
      ctx.fillStyle = rgba(creepColor, 0.14 * fade);
      ctx.beginPath();
      ctx.ellipse(x + CELL * 0.5 + (s - 0.5) * 10, y + CELL * 0.5, CELL * 0.56, CELL * 0.46, s * 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = rgba(creepColor, 0.1 * fade);
      ctx.beginPath();
      ctx.ellipse(x + CELL * 0.4, y + CELL * 0.58, CELL * 0.36, CELL * 0.3, -s, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = rgba('#AEEA00', (0.12 + 0.06 * Math.sin(t * 2 + s * 6)) * fade);
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.ellipse(x + CELL * 0.5, y + CELL * 0.5, CELL * 0.5, CELL * 0.4, 0, 0, Math.PI * 2);
      ctx.stroke();
      // 虫苔上的呼吸孢子点
      ctx.fillStyle = rgba('#D8FF50', 0.22 * fade);
      ctx.beginPath();
      ctx.arc(x + CELL * (0.3 + s * 0.4), y + CELL * (0.3 + s * 0.5), 2 + Math.sin(t * 3 + s * 9), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ---------------- 血条 ----------------

  private drawHpBar(ctx: CanvasRenderingContext2D, m: MonsterRuntime): void {
    if (m.hp >= m.maxHp || m.hp <= 0) return;
    const r = m.cfg.radius;
    const w = Math.max(24, r * 2);
    const k = Math.max(0, m.hp / m.maxHp);
    const y = m.y - r - 12;
    const x = m.x - w / 2;
    const boss = m.cfg.shape === 'boss';
    const hgt = boss ? 7 : 4;
    // 底槽
    ctx.fillStyle = 'rgba(7,8,15,0.6)';
    ctx.beginPath();
    ctx.roundRect(x - 1, y - 1, w + 2, hgt + 2, (hgt + 2) / 2);
    ctx.fill();
    // 血量（按比例变色：健康=警示红，濒死=更亮）
    const color = k > 0.5 ? '#FF6B57' : k > 0.25 ? '#FF3D71' : '#FFD54F';
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(x, y, Math.max(1.5, w * k), hgt, hgt / 2);
    ctx.fill();
    if (boss) {
      ctx.strokeStyle = rgba('#B537F2', 0.8);
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.roundRect(x - 1, y - 1, w + 2, hgt + 2, (hgt + 2) / 2);
      ctx.stroke();
    }
  }
}

/** 供实验室/主游戏共用的弹坑类型导出（避免上层重复 import） */
export type { DamagePool };
