/**
 * 几何绘制库（configs/art-style/shapes.md 形状语言的唯一实现）：怪物 / 子弹 / 武器挂载 / 场景符号。
 * 主游戏（main.ts）与卡牌实验室（lab.ts）共用，保证两端视觉一致。
 * 坐标系：调用方已做 y 轴翻转，这里直接使用游戏坐标（y 向上，城墙在 y=0）。
 *
 * 身份分层（数据在 identity.ts）：
 *  - 轮廓 silhouette：一眼分清族类（三角/六边/叠圆/菱形/尖刺环…）；
 *  - accent / core：同族内的具体身份（爪、冠、孢子、眼）；
 *  - deco=false（受击闪白重描）时只画实心主体，跳过一切装饰——闪白必须贴合各自几何。
 */
import { DamagePool, MonsterRuntime, MonsterShot, ProjectileRuntime, WeaponInstance } from '../../../gamecore';
import { MonsterLook, monsterLook, weaponLook } from './identity';

const TAU = Math.PI * 2;

/**
 * 怪物本体色：按 id 优先（同族内的具体身份），shape 兜底。
 * 纪律：只允许同族深浅变体或 palette.json 既有色，不引入新色相（docs/06 §1.2）。
 */
const MONSTER_COLOR: Record<string, string> = {
  slime: '#FF6B57',
  wolf: '#FF8357',
  charger: '#FFA25E',
  thrower: '#FF5E7A',
  catapult: '#A9714B',
  bulwark: '#8A93B8',
  bulwark_king: '#6F7BA6',
  boss_treant: '#B537F2',
  split_shroom: '#FF6B9C',
  shroom_baby: '#FF8FB6',
  bat: '#FF7EC7',
  shaman: '#B388FF',
  zerg_ling: '#9CCC65',
  zerg_larva: '#B4D97A',
  zerg_roach: '#7CB342',
  zerg_lurker: '#558B2F',
  zerg_queen: '#C77DFF',
  baneling: '#AEEA00',
  zerg_ultra: '#69A83B',
};

/** 形状兜底色（config 新增怪但 identity 未登记时的中性选择） */
const SHAPE_COLOR: Record<string, string> = {
  slime: '#FF6B57', wolf: '#FF8357', charger: '#FFA25E', thrower: '#FF5E7A',
  bulwark: '#8A93B8', bat: '#FF7EC7', shroom: '#FF6B9C', boss: '#B537F2', shaman: '#B388FF',
  larva: '#9CCC65', roach: '#7CB342', lurker: '#558B2F', zqueen: '#C77DFF',
  baneling: '#AEEA00', ultra: '#69A83B',
};

export function monsterColor(m: MonsterRuntime): string {
  return MONSTER_COLOR[m.cfg.id] ?? SHAPE_COLOR[m.cfg.shape ?? 'slime'] ?? '#FF6B57';
}

// ---------------- 几何小工具 ----------------

function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function poly(ctx: CanvasRenderingContext2D, cx: number, cy: number, n: number, rad: number, rot = -Math.PI / 2, inner = 1): void {
  ctx.beginPath();
  for (let i = 0; i < n * 2; i++) {
    const a = rot + (Math.PI / n) * i;
    const r = i % 2 === 0 ? rad : rad * inner;
    const px = cx + Math.cos(a) * r;
    const py = cy + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

/** 接触阴影：把怪物"按在地上"，也是同屏大量单位时的可读性锚点。 */
function contactShadow(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, alpha = 0.22): void {
  ctx.fillStyle = `rgba(0,0,0,${alpha})`;
  ctx.beginPath();
  ctx.ellipse(x, y - r * 0.3, r * 1.02, r * 0.4, 0, 0, TAU);
  ctx.fill();
}

// ---------------- 怪物入口 ----------------

/**
 * 按种类绘制怪物（t = 秒，用于行走进缩/扑翼/脉动/机关运转）。
 * flash: 0~1 受击闪白强度（FxRuntime.flashAlpha，来源 fx-config.json hitFlash）。
 * squash: 纵向缩放倍率（FxRuntime.hitSquash），1=不变形。
 * 状态指示（冰环/火/血条）由调用方叠加。
 */
export function drawMonster(
  ctx: CanvasRenderingContext2D,
  m: MonsterRuntime,
  t: number,
  flash = 0,
  squash = 1,
): void {
  const r = m.cfg.radius;
  const look = monsterLook(m);
  const bodyColor = monsterColor(m);
  const x = m.x;
  const y = m.y;

  // 钻地：地面土包 + 虚线轮廓（看得见打不到，docs/08）
  if (m.burrowed) {
    ctx.fillStyle = 'rgba(70,82,52,0.45)';
    ctx.beginPath();
    ctx.ellipse(x, y, r * 1.1, r * 0.55, 0, 0, TAU);
    ctx.fill();
    // 土包裂纹：钻地中的单位不是"消失"，而是"在底下"（可读性）
    ctx.strokeStyle = 'rgba(26,36,16,0.55)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < 3; i++) {
      const a = (Math.PI / 3) * i + m.phase;
      ctx.moveTo(x + Math.cos(a) * r * 0.2, y + Math.sin(a) * r * 0.1);
      ctx.lineTo(x + Math.cos(a) * r * 0.85, y + Math.sin(a) * r * 0.45);
    }
    ctx.stroke();
    ctx.strokeStyle = bodyColor;
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(x, y, r + 3, (r + 3) * 0.5, 0, 0, TAU);
    ctx.stroke();
    ctx.setLineDash([]);
    return;
  }

  // 挤压回弹（squashStretch）：以脚底为锚点纵向缩放，横向反比补偿保持体积感。
  const deform = Math.abs(squash - 1) > 0.001;
  if (deform) {
    ctx.save();
    ctx.translate(x, y - r);
    ctx.scale(1 / squash, squash);
    ctx.translate(-x, -(y - r));
  }

  // 接触阴影在最底层（闪白重描时不画，避免白色本体被"脏化"）
  if (flash <= 0.001) contactShadow(ctx, x, y, r, look.size === 'boss' ? 0.3 : 0.22);

  drawMonsterBody(ctx, m, t, look, bodyColor, false);

  // 受击闪白（shapes.md 可读性铁律 2）：用半透明白把「同一套形状」再画一遍（tint），
  // 严格贴合各自几何，不会出现「本体在发光球里」的伪影。
  if (flash > 0) {
    ctx.fillStyle = `rgba(255,255,255,${0.9 * flash})`;
    drawMonsterBody(ctx, m, t, look, '#FFFFFF', true);
  }

  if (deform) ctx.restore();
}

type BodyFn = (
  ctx: CanvasRenderingContext2D,
  m: MonsterRuntime,
  t: number,
  color: string,
  deco: boolean,
  look: MonsterLook,
) => void;

function drawMonsterBody(
  ctx: CanvasRenderingContext2D,
  m: MonsterRuntime,
  t: number,
  look: MonsterLook,
  color: string,
  tint: boolean,
): void {
  const fn = BODIES[look.silhouette] ?? drawSlimeBody;
  fn(ctx, m, t, color, !tint, look);
}

const BODIES: Record<string, BodyFn> = {
  slime: drawSlimeBody,
  wolf: drawWolfBody,
  goblin: drawGoblinBody,
  catapult: drawCatapultBody,
  charger: drawChargerBody,
  armor: drawArmorBody,
  king: drawKingBody,
  treant: drawTreantBody,
  mushroom: drawMushroomBody,
  bat: drawBatBody,
  shaman: drawShamanBody,
  zergling: drawZerglingBody,
  grub: drawGrubBody,
  roach: drawRoachBody,
  lurker: drawLurkerBody,
  queen: drawQueenBody,
  baneling: drawBanelingBody,
  ultra: drawUltraBody,
};

// ---------------- 各轮廓 ----------------

function drawSlimeBody(ctx: CanvasRenderingContext2D, m: MonsterRuntime, t: number, color: string, deco: boolean, look: MonsterLook): void {
  const x = m.x, y = m.y, r = m.cfg.radius;
  const sq = m.state === 'march' ? 1 + 0.12 * Math.sin(t * 6 + m.phase) : 1;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(2 - sq, sq);
  ctx.fillStyle = color;
  rr(ctx, -r, -r, r * 2, r * 2, r * 0.45);
  ctx.fill();
  if (deco) {
    // 胶质高光：让圆角方块读作"半透明橡皮"而不是纸片
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    ctx.beginPath();
    ctx.ellipse(-r * 0.3, r * 0.34, r * 0.4, r * 0.24, -0.5, 0, TAU);
    ctx.fill();
    // 双眼朝城墙（-y）：小怪也有"看着你要打的地方"的方向感
    ctx.fillStyle = look.core;
    for (const sx of [-0.34, 0.34]) {
      ctx.beginPath();
      ctx.arc(sx * r, -r * 0.2, r * 0.12, 0, TAU);
      ctx.fill();
    }
  }
  ctx.restore();
}

function drawWolfBody(ctx: CanvasRenderingContext2D, m: MonsterRuntime, t: number, color: string, deco: boolean, look: MonsterLook): void {
  const x = m.x, y = m.y, r = m.cfg.radius;
  const moving = m.state === 'march';
  const stretch = moving ? 1 + 0.15 * Math.sin(t * 8 + m.phase) : 1;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(1, stretch);
  if (deco) {
    // 尾线（身后 = +y，朝城墙推进的反方向）
    ctx.strokeStyle = look.accent;
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(0, r * 0.72);
    ctx.quadraticCurveTo(Math.sin(t * 7 + m.phase) * r * 0.55, r * 1.25, Math.sin(t * 7 + m.phase + 1) * r * 0.7, r * 1.66);
    ctx.stroke();
  }
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(0, -r * 1.05);
  ctx.lineTo(-r * 0.85, r * 0.8);
  ctx.lineTo(r * 0.85, r * 0.8);
  ctx.closePath();
  ctx.fill();
  if (deco) {
    // 颈背鬃毛（同族亮一档的三角）
    ctx.fillStyle = look.accent;
    ctx.globalAlpha = 0.32;
    ctx.beginPath();
    ctx.moveTo(0, -r * 0.5);
    ctx.lineTo(-r * 0.36, r * 0.4);
    ctx.lineTo(r * 0.36, r * 0.4);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;
    // 噬血红眼：冲刺类怪唯一的“表情”，远看也能认出是野狼
    ctx.fillStyle = look.core;
    for (const sx of [-0.26, 0.26]) {
      ctx.beginPath();
      ctx.arc(sx * r, -r * 0.32, r * 0.1, 0, TAU);
      ctx.fill();
    }
  }
  ctx.restore();
}

function drawGoblinBody(ctx: CanvasRenderingContext2D, m: MonsterRuntime, t: number, color: string, deco: boolean, look: MonsterLook): void {
  const x = m.x, y = m.y, r = m.cfg.radius;
  const interval = Math.max(0.001, m.cfg.attackInterval);
  // 0 = 刚投出（前倾），1 = 蓄力到位（后仰）——投矛手的手感由此一眼可读
  const wind = m.cfg.behavior === 'ranged' ? Math.sin(Math.min(1, Math.max(0, 1 - m.attackTimer / interval)) * Math.PI) : 0;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(-0.18 * wind);
  // 身体梯形（上窄下宽，和野狼的尖三角区分开）
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(-r * 0.78, r * 0.68);
  ctx.lineTo(r * 0.78, r * 0.68);
  ctx.lineTo(r * 0.46, -r * 0.72);
  ctx.lineTo(-r * 0.46, -r * 0.72);
  ctx.closePath();
  ctx.fill();
  if (deco) {
    // 尖耳（哥布林身份的剪影符号）
    ctx.fillStyle = color;
    for (const sx of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(sx * r * 0.5, -r * 0.5);
      ctx.lineTo(sx * r * 0.95, -r * 0.86);
      ctx.lineTo(sx * r * 0.62, -r * 0.24);
      ctx.closePath();
      ctx.fill();
    }
    // 长矛：投出瞬间随手臂前挥
    ctx.save();
    ctx.rotate(-0.35 + 0.7 * wind);
    ctx.strokeStyle = look.accent;
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(r * 0.12, r * 0.9);
    ctx.lineTo(r * 0.12, -r * 1.85);
    ctx.stroke();
    ctx.fillStyle = '#F5F5FA';
    ctx.beginPath();
    ctx.moveTo(r * 0.12, -r * 2.15);
    ctx.lineTo(r * 0.12 - r * 0.16, -r * 1.78);
    ctx.lineTo(r * 0.12 + r * 0.16, -r * 1.78);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    // 眼点
    ctx.fillStyle = look.core;
    for (const sx of [-0.22, 0.22]) {
      ctx.beginPath();
      ctx.arc(sx * r, -r * 0.34, r * 0.1, 0, TAU);
      ctx.fill();
    }
  }
  ctx.restore();
}

function drawCatapultBody(ctx: CanvasRenderingContext2D, m: MonsterRuntime, t: number, color: string, deco: boolean, look: MonsterLook): void {
  const x = m.x, y = m.y, r = m.cfg.radius;
  const interval = Math.max(0.001, m.cfg.attackInterval);
  const wind = Math.min(1, Math.max(0, 1 - m.attackTimer / interval)); // 0=装填 1=刚抛出
  const wheelRot = t * (m.state === 'march' ? 2.4 : 0.4);
  // 闪白重描：只画简化剪影（底梁 + 双轮 + A 架），保持闪白贴合这台机器的外形
  if (!deco) {
    ctx.fillStyle = color;
    rr(ctx, x - r * 0.95, y - r * 0.36, r * 1.9, r * 0.34, r * 0.1);
    ctx.fill();
    for (const sx of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(x + sx * r * 0.78, y - r * 0.5, r * 0.32, 0, TAU);
      ctx.fill();
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = r * 0.17;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x - r * 0.52, y - r * 0.08);
    ctx.lineTo(x, y + r * 0.66);
    ctx.moveTo(x + r * 0.52, y - r * 0.08);
    ctx.lineTo(x, y + r * 0.66);
    ctx.stroke();
    return;
  }
  // 双轮：转动 = 真的在"推车前进"
  for (const sx of [-1, 1]) {
    const wx = x + sx * r * 0.78;
    const wy = y - r * 0.5;
    ctx.fillStyle = '#4E3A24';
    ctx.beginPath();
    ctx.arc(wx, wy, r * 0.32, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = look.accent;
    ctx.lineWidth = 2.6;
    ctx.beginPath();
    for (let i = 0; i < 3; i++) {
      const a = wheelRot + (i * Math.PI) / 3;
      ctx.moveTo(wx - Math.cos(a) * r * 0.27, wy - Math.sin(a) * r * 0.27);
      ctx.lineTo(wx + Math.cos(a) * r * 0.27, wy + Math.sin(a) * r * 0.27);
    }
    ctx.stroke();
    ctx.strokeStyle = 'rgba(11,12,29,0.55)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(wx, wy, r * 0.32, 0, TAU);
    ctx.stroke();
  }
  // 底梁
  ctx.fillStyle = color;
  rr(ctx, x - r * 0.95, y - r * 0.34, r * 1.9, r * 0.32, r * 0.1);
  ctx.fill();
  // A 字架
  ctx.strokeStyle = color;
  ctx.lineWidth = r * 0.17;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x - r * 0.52, y - r * 0.08);
  ctx.lineTo(x, y + r * 0.66);
  ctx.moveTo(x + r * 0.52, y - r * 0.08);
  ctx.lineTo(x, y + r * 0.66);
  ctx.stroke();
  // 投臂：装填时后仰、发射时前挥（机关运转感）
  const armAng = -0.95 + wind * 1.8;
  ctx.save();
  ctx.translate(x, y + r * 0.5);
  ctx.rotate(armAng);
  ctx.strokeStyle = look.accent;
  ctx.lineWidth = r * 0.13;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, r * 1.3);
  ctx.stroke();
  // 配重块
  ctx.fillStyle = '#4E3A24';
  rr(ctx, -r * 0.17, -r * 0.28, r * 0.34, r * 0.32, r * 0.07);
  ctx.fill();
  // 弹仓里的石头
  if (deco && wind < 0.6) {
    ctx.fillStyle = '#8A93B8';
    ctx.beginPath();
    ctx.arc(0, r * 1.3, r * 0.21, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = 'rgba(11,12,29,0.6)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  ctx.restore();
  if (deco) {
    // 捆绳：把木架读成"造出来的机械"
    ctx.strokeStyle = '#4E3A24';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x - r * 0.82, y + r * 0.3);
    ctx.lineTo(x + r * 0.82, y + r * 0.12);
    ctx.stroke();
  }
}

function drawChargerBody(ctx: CanvasRenderingContext2D, m: MonsterRuntime, t: number, color: string, deco: boolean, look: MonsterLook): void {
  const x = m.x, y = m.y, r = m.cfg.radius;
  // 动能残影：仅行军时画（抵达城墙后速度归零，残影会撒谎）
  if (m.state === 'march' && deco) {
    const trail = 3;
    for (let i = trail; i >= 1; i--) {
      const back = i * 9;
      const k = 1 - i / (trail + 0.6);
      const shrink = 1 - i * 0.1;
      ctx.fillStyle = `rgba(255,190,130,${0.5 * k})`;
      ctx.beginPath();
      ctx.moveTo(x, y - r * 1.4 * shrink + back);
      ctx.lineTo(x - r * 0.55 * shrink, y + r * shrink + back);
      ctx.lineTo(x + r * 0.55 * shrink, y + r * shrink + back);
      ctx.closePath();
      ctx.fill();
    }
  }
  ctx.save();
  ctx.translate(x, y);
  // 瘦长尖梭
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(0, -r * 1.45);
  ctx.lineTo(-r * 0.55, r);
  ctx.lineTo(r * 0.55, r);
  ctx.closePath();
  ctx.fill();
  if (deco) {
    // 尖端高光：方向感
    ctx.fillStyle = look.accent;
    ctx.beginPath();
    ctx.moveTo(0, -r * 1.45);
    ctx.lineTo(-r * 0.16, -r * 0.55);
    ctx.lineTo(r * 0.16, -r * 0.55);
    ctx.closePath();
    ctx.fill();
    // 眼线：只剩一道极窄的红光（速度感单位不画大眼）
    ctx.fillStyle = look.core;
    ctx.fillRect(-r * 0.22, -r * 0.72, r * 0.44, r * 0.12);
  }
  ctx.restore();
}

function drawArmorBody(ctx: CanvasRenderingContext2D, m: MonsterRuntime, t: number, color: string, deco: boolean, look: MonsterLook): void {
  const x = m.x, y = m.y, r = m.cfg.radius;
  ctx.fillStyle = color;
  poly(ctx, x, y, 6, r, Math.PI / 6);
  ctx.fill();
  if (deco) {
    // 内甲片
    ctx.strokeStyle = 'rgba(11,12,29,0.55)';
    ctx.lineWidth = 3;
    poly(ctx, x, y, 6, r * 0.55, Math.PI / 6);
    ctx.stroke();
    // 铆钉：六角甲片的机械感
    ctx.fillStyle = look.accent;
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 3) * i + Math.PI / 6;
      ctx.beginPath();
      ctx.arc(x + Math.cos(a) * r * 0.74, y + Math.sin(a) * r * 0.74, 2.4, 0, TAU);
      ctx.fill();
    }
    // 正面盾弧（朝城墙 -y）：这只怪的身份就是"挡在你和墙之间"
    ctx.strokeStyle = look.accent;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(x, y, r * 1.02, -Math.PI * 0.86, -Math.PI * 0.14);
    ctx.stroke();
    if (m.shieldLeft > 0) {
      // 免伤盾层数：盾弧外的脉冲环（越亮=还有层数）
      ctx.strokeStyle = `rgba(245,245,250,${0.25 + 0.25 * Math.sin(t * 6 + m.phase)})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, r * 1.16, -Math.PI * 0.95, -Math.PI * 0.05);
      ctx.stroke();
    }
  }
}

function drawKingBody(ctx: CanvasRenderingContext2D, m: MonsterRuntime, t: number, color: string, deco: boolean, look: MonsterLook): void {
  const x = m.x, y = m.y, r = m.cfg.radius;
  ctx.fillStyle = color;
  poly(ctx, x, y, 6, r, Math.PI / 6);
  ctx.fill();
  if (deco) {
    const pulse = 0.5 + 0.5 * Math.sin(t * 3.2 + m.phase);
    // 精英双层描边脉冲（shapes.md 精英行）
    ctx.strokeStyle = `rgba(255,213,79,${0.18 + 0.28 * pulse})`;
    ctx.lineWidth = 3;
    poly(ctx, x, y, 6, r * 1.12, Math.PI / 6);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(11,12,29,0.5)';
    poly(ctx, x, y, 6, r * 0.55, Math.PI / 6);
    ctx.stroke();
    // 黄金冠：三根尖峰（岩甲魔王的唯一"头饰"）
    ctx.fillStyle = '#FFD54F';
    for (const sx of [-0.46, 0, 0.46]) {
      ctx.beginPath();
      ctx.moveTo(x + sx * r, y + r * 0.62);
      ctx.lineTo(x + sx * r - r * 0.12, y + r * 0.95);
      ctx.lineTo(x + sx * r + r * 0.12, y + r * 0.95);
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillStyle = look.accent;
    ctx.fillRect(x - r * 0.62, y + r * 0.56, r * 1.24, r * 0.1);
    // 铆钉
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 3) * i + Math.PI / 6;
      ctx.beginPath();
      ctx.arc(x + Math.cos(a) * r * 0.72, y + Math.sin(a) * r * 0.72, 2.6, 0, TAU);
      ctx.fill();
    }
  }
}

function drawTreantBody(ctx: CanvasRenderingContext2D, m: MonsterRuntime, t: number, color: string, deco: boolean, look: MonsterLook): void {
  const x = m.x, y = m.y, r = m.cfg.radius;
  const pulse = 1 + 0.04 * Math.sin(t * 2.4 + m.phase);
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(pulse, pulse);
  if (deco) {
    // 旋转几何外环：Boss 的"身份环"，碎裂时由击杀特效接管（shatter 符号）
    ctx.save();
    ctx.rotate(t * 0.45);
    ctx.strokeStyle = look.accent;
    ctx.globalAlpha = 0.35;
    ctx.lineWidth = 3;
    for (let i = 0; i < 6; i++) {
      ctx.beginPath();
      ctx.arc(0, 0, r * 1.34, (Math.PI / 3) * i, (Math.PI / 3) * i + 0.52);
      ctx.stroke();
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }
  // 12 尖刺重环
  ctx.fillStyle = color;
  poly(ctx, 0, 0, 12, r * 1.12, 0, 0.93);
  ctx.fill();
  if (deco) {
    ctx.strokeStyle = 'rgba(11,12,29,0.45)';
    ctx.lineWidth = 2;
    poly(ctx, 0, 0, 12, r * 0.94, 0, 0.93);
    ctx.stroke();
    // 嵌套三角躯干（树人 = 木），三层递减
    ctx.fillStyle = 'rgba(107,74,47,0.9)';
    for (let i = 0; i < 3; i++) {
      const k = 1 - i * 0.26;
      ctx.beginPath();
      ctx.moveTo(0, -r * 0.72 * k);
      ctx.lineTo(r * 0.5 * k, r * 0.5 * k);
      ctx.lineTo(-r * 0.5 * k, r * 0.5 * k);
      ctx.closePath();
      ctx.fill();
    }
    // 核心：Boss 的紫色心脏（呼吸）
    const g = ctx.createRadialGradient(0, 0, 1, 0, 0, r * 0.55);
    g.addColorStop(0, 'rgba(217,166,255,0.95)');
    g.addColorStop(0.55, 'rgba(181,55,242,0.8)');
    g.addColorStop(1, 'rgba(181,55,242,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.55, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

function drawMushroomBody(ctx: CanvasRenderingContext2D, m: MonsterRuntime, t: number, color: string, deco: boolean, look: MonsterLook): void {
  const baby = m.cfg.id === 'shroom_baby';
  const x = m.x, y = m.y, r = m.cfg.radius;
  const bob = Math.sin(t * 3 + m.phase) * (m.state === 'march' ? 1.6 : 0.6);
  ctx.save();
  ctx.translate(x, y + bob);
  // 柄（浅色：与伞盖拉开层次）；闪白重描时统一用白色主体色，保持闪白贴合几何
  ctx.fillStyle = deco ? look.accent : color;
  rr(ctx, -r * 0.24, -r * 0.2, r * 0.48, r * 0.98, r * 0.14);
  ctx.fill();
  // 伞盖：大圆 + 底缘压暗
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(0, -r * 0.22, baby ? r * 0.82 : r, 0, TAU);
  ctx.fill();
  if (deco) {
    ctx.strokeStyle = 'rgba(58,16,36,0.45)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, -r * 0.22, baby ? r * 0.82 : r, Math.PI * 0.15, Math.PI * 0.85);
    ctx.stroke();
    // 斑点：成年菇 3 点、幼体无斑（大小两代一眼可分）
    if (!baby) {
      ctx.fillStyle = look.accent;
      for (const [sx, sy, sr] of [[-0.42, 0.1, 0.16], [0.36, 0.28, 0.13], [0.05, -0.42, 0.11]] as const) {
        ctx.beginPath();
        ctx.arc(sx * r, sy * r - r * 0.22, sr * r, 0, TAU);
        ctx.fill();
      }
    } else {
      // 幼体：一个极小的"呆点眼"，弱但可爱（区别于成年菇的斑点语言）
      ctx.fillStyle = look.core;
      ctx.beginPath();
      ctx.arc(0, -r * 0.16, r * 0.1, 0, TAU);
      ctx.fill();
    }
  }
  ctx.restore();
}

function drawBatBody(ctx: CanvasRenderingContext2D, m: MonsterRuntime, t: number, color: string, deco: boolean, look: MonsterLook): void {
  const x = m.x, y = m.y, r = m.cfg.radius;
  const flap = 0.75 + 0.3 * Math.sin(t * 12 + m.phase);
  if (deco) {
    // 回声环：蝙蝠的"专属待机动效"——声呐感，同时暗示范围
    const echo = (t * 0.8 + m.phase) % 1;
    ctx.strokeStyle = `rgba(255,179,225,${0.22 * (1 - echo)})`;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y, r * (0.9 + echo * 1.4), 0, TAU);
    ctx.stroke();
  }
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(1, flap);
  // 双翼（对三角）
  ctx.fillStyle = color;
  for (const sx of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(sx * r * 0.24, 0);
    ctx.lineTo(sx * r * 1.34, r * 0.58);
    ctx.lineTo(sx * r * 0.92, -r * 0.5);
    ctx.closePath();
    ctx.fill();
  }
  // 身体（竖直小椭圆，与双翼共同构成"蝙蝠"剪影）
  ctx.beginPath();
  ctx.ellipse(0, -r * 0.1, r * 0.34, r * 0.62, 0, 0, TAU);
  ctx.fill();
  if (deco) {
    // 尖耳 + 双眼
    ctx.fillStyle = color;
    for (const sx of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(sx * r * 0.14, -r * 0.55);
      ctx.lineTo(sx * r * 0.34, -r * 0.92);
      ctx.lineTo(sx * r * 0.06, -r * 0.7);
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillStyle = look.core;
    for (const sx of [-0.13, 0.13]) {
      ctx.beginPath();
      ctx.arc(sx * r, -r * 0.36, r * 0.08, 0, TAU);
      ctx.fill();
    }
  }
  ctx.restore();
}

function drawShamanBody(ctx: CanvasRenderingContext2D, m: MonsterRuntime, t: number, color: string, deco: boolean, look: MonsterLook): void {
  const x = m.x, y = m.y, r = m.cfg.radius;
  const bob = Math.sin(t * 3 + m.phase) * 3;
  if (deco) {
    // 地面符文环：巫师是"施法者"，脚下要有法阵
    ctx.save();
    ctx.translate(x, y - r * 0.55);
    ctx.rotate(t * 0.5);
    ctx.strokeStyle = 'rgba(179,136,255,0.32)';
    ctx.lineWidth = 2;
    for (let i = 0; i < 6; i++) {
      ctx.beginPath();
      ctx.arc(0, 0, r * 1.15, (Math.PI / 3) * i, (Math.PI / 3) * i + 0.38);
      ctx.stroke();
    }
    ctx.restore();
  }
  // 菱形法袍
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x, y - r * 1.05);
  ctx.lineTo(x + r * 0.8, y + r * 0.1);
  ctx.lineTo(x, y + r);
  ctx.lineTo(x - r * 0.8, y + r * 0.1);
  ctx.closePath();
  ctx.fill();
  if (deco) {
    // 兜帽阴影
    ctx.fillStyle = 'rgba(11,12,29,0.45)';
    ctx.beginPath();
    ctx.moveTo(x, y - r * 0.86);
    ctx.lineTo(x + r * 0.34, y - r * 0.12);
    ctx.lineTo(x - r * 0.34, y - r * 0.12);
    ctx.closePath();
    ctx.fill();
    // 悬浮法球（呼吸浮动 + 光晕）
    const oy = y - r - 9 + bob;
    const g = ctx.createRadialGradient(x, oy, 1, x, oy, 12);
    g.addColorStop(0, 'rgba(245,245,250,0.95)');
    g.addColorStop(0.4, 'rgba(179,136,255,0.7)');
    g.addColorStop(1, 'rgba(179,136,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, oy, 12, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#F5F5FA';
    ctx.beginPath();
    ctx.arc(x, oy, 3.4, 0, TAU);
    ctx.fill();
  }
}

function drawZerglingBody(ctx: CanvasRenderingContext2D, m: MonsterRuntime, t: number, color: string, deco: boolean, look: MonsterLook): void {
  const x = m.x, y = m.y, r = m.cfg.radius;
  const sweep = Math.sin(t * 10 + m.phase) * r * 0.14;
  ctx.save();
  ctx.translate(x, y);
  if (deco) {
    // 四条节肢：左右各两段，交替抬落（贴地小跑的碎步感）
    ctx.strokeStyle = 'rgba(26,36,16,0.85)';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    for (const sx of [-1, 1]) {
      for (let i = 0; i < 2; i++) {
        const ph = Math.sin(t * 18 + m.phase + i * Math.PI + (sx > 0 ? Math.PI / 2 : 0)) * r * 0.16;
        const bx = sx * r * 0.5;
        const by = r * (i * 0.34 - 0.12);
        ctx.beginPath();
        ctx.moveTo(bx, by);
        ctx.lineTo(sx * r * 1.0, by + r * 0.22 + ph);
        ctx.lineTo(sx * r * 1.12, by + r * 0.5 + ph);
        ctx.stroke();
      }
    }
  }
  // 低伏菱形躯干（宽而扁，明显区别于幼虫的圆节）
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(0, -r * 1.05);
  ctx.lineTo(r * 1.1, 0);
  ctx.lineTo(0, r * 0.62);
  ctx.lineTo(-r * 1.1, 0);
  ctx.closePath();
  ctx.fill();
  if (deco) {
    // 前肢镰刀：虫族近战的语言，向前挥砍
    ctx.strokeStyle = look.accent;
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    for (const sx of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(sx * r * 0.72, -r * 0.05);
      ctx.quadraticCurveTo(sx * r * 1.5, -r * 0.62 + sweep, sx * r * 0.82, -r * 1.26 + sweep);
      ctx.stroke();
    }
    // 头 + 双击眼
    ctx.fillStyle = '#3E5B21';
    ctx.beginPath();
    ctx.arc(0, -r * 0.68, r * 0.3, 0, TAU);
    ctx.fill();
    ctx.fillStyle = look.core;
    for (const sx of [-0.36, 0.36]) {
      ctx.beginPath();
      ctx.arc(sx * r * 0.26, -r * 0.72, r * 0.08, 0, TAU);
      ctx.fill();
    }
  }
  ctx.restore();
}

function drawGrubBody(ctx: CanvasRenderingContext2D, m: MonsterRuntime, t: number, color: string, deco: boolean, look: MonsterLook): void {
  const x = m.x, y = m.y, r = m.cfg.radius;
  // 变态倒计时 = 脉动频率：越接近变态，囊体颤得越快（信息型表现，玩家能预判它要变什么）
  const morph = m.cfg.morph;
  let rate = 3.2;
  let amp = 0.05;
  if (morph && m.morphLeft > 0) {
    const k = 1 - Math.min(1, m.morphLeft / Math.max(0.001, morph.delay));
    rate = 3.2 + 9 * k;
    amp = 0.05 + 0.13 * k;
  }
  const pulse = 1 + amp * Math.sin(t * rate + m.phase);
  ctx.save();
  ctx.translate(x, y);
  // 三节肥躯（向后逐节收小）：幼虫的"软"由叠圆承担
  ctx.fillStyle = color;
  for (let i = 0; i < 3; i++) {
    const kk = 1 - i * 0.17;
    ctx.beginPath();
    ctx.ellipse(0, i * r * 0.42 - r * 0.35, r * 0.72 * kk, r * 0.5 * kk, 0, 0, TAU);
    ctx.fill();
  }
  // 头 + 口器
  ctx.beginPath();
  ctx.arc(0, -r * 0.72, r * 0.5 * pulse, 0, TAU);
  ctx.fill();
  if (deco) {
    ctx.strokeStyle = 'rgba(26,36,16,0.7)';
    ctx.lineWidth = 1.5;
    for (const sx of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(sx * r * 0.3, -r * 0.92);
      ctx.lineTo(sx * r * 0.5, -r * 1.16);
      ctx.stroke();
    }
    // 变态囊：亮黄绿光斑，随倒计时变亮
    const g = ctx.createRadialGradient(0, -r * 0.05, 1, 0, -r * 0.05, r * 0.66);
    g.addColorStop(0, `rgba(230,238,156,${0.32 + 0.3 * pulse})`);
    g.addColorStop(1, 'rgba(230,238,156,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, -r * 0.05, r * 0.66, 0, TAU);
    ctx.fill();
    ctx.fillStyle = look.core;
    for (const sx of [-0.2, 0.2]) {
      ctx.beginPath();
      ctx.arc(sx * r, -r * 0.8, r * 0.075, 0, TAU);
      ctx.fill();
    }
  }
  ctx.restore();
}

function drawRoachBody(ctx: CanvasRenderingContext2D, m: MonsterRuntime, t: number, color: string, deco: boolean, look: MonsterLook): void {
  const x = m.x, y = m.y, r = m.cfg.radius;
  ctx.save();
  ctx.translate(x, y);
  if (deco) {
    // 六足（爬行步态）
    ctx.strokeStyle = 'rgba(26,36,16,0.8)';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    for (const sx of [-1, 1]) {
      for (let i = 0; i < 3; i++) {
        const ph = Math.sin(t * 12 + m.phase + i * 2.1 + (sx > 0 ? Math.PI : 0)) * r * 0.12;
        ctx.beginPath();
        ctx.moveTo(sx * r * 0.55, r * (0.1 + i * 0.22) - r * 0.28);
        ctx.lineTo(sx * r * 1.0, r * (0.22 + i * 0.24) - r * 0.28 + ph);
        ctx.stroke();
      }
    }
  }
  // 甲壳椭圆
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.ellipse(0, 0, r, r * 0.7, 0, 0, TAU);
  ctx.fill();
  if (deco) {
    ctx.strokeStyle = 'rgba(26,36,16,0.8)';
    ctx.lineWidth = 2;
    ctx.stroke();
    // 背脊甲缝 + 尖刺
    ctx.beginPath();
    ctx.moveTo(-r * 0.62, -r * 0.16);
    ctx.quadraticCurveTo(0, -r * 0.4, r * 0.62, -r * 0.16);
    ctx.stroke();
    ctx.fillStyle = look.accent;
    for (const dx of [-0.45, 0, 0.45]) {
      ctx.beginPath();
      ctx.moveTo(r * dx, -r * 0.4);
      ctx.lineTo(r * dx - r * 0.1, -r * 0.78);
      ctx.lineTo(r * dx + r * 0.1, -r * 0.78);
      ctx.closePath();
      ctx.fill();
    }
    // 头 + 眼
    ctx.fillStyle = '#3E5B21';
    ctx.beginPath();
    ctx.ellipse(0, -r * 0.74, r * 0.34, r * 0.26, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = look.core;
    for (const sx of [-0.16, 0.16]) {
      ctx.beginPath();
      ctx.arc(sx * r, -r * 0.78, r * 0.07, 0, TAU);
      ctx.fill();
    }
  }
  ctx.restore();
}

function drawLurkerBody(ctx: CanvasRenderingContext2D, m: MonsterRuntime, t: number, color: string, deco: boolean, look: MonsterLook): void {
  const x = m.x, y = m.y, r = m.cfg.radius;
  // 上浮窗口（surfaceLeft>0）= 可击杀期：给一圈绿光，告诉玩家"现在能打"
  const surfaced = m.surfaceLeft > 0;
  ctx.save();
  ctx.translate(x, y);
  if (surfaced && deco) {
    ctx.strokeStyle = `rgba(174,234,0,${0.3 + 0.2 * Math.sin(t * 8 + m.phase)})`;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.ellipse(0, r * 0.35, r * 1.05, r * 0.5, 0, 0, TAU);
    ctx.stroke();
  }
  // 基部土包（地刺伏击感）
  if (deco) {
    ctx.fillStyle = 'rgba(101,67,33,0.4)';
    ctx.beginPath();
    ctx.ellipse(0, r * 0.45, r * 0.85, r * 0.3, 0, 0, TAU);
    ctx.fill();
  }
  // 竖立尖刺主体
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(0, -r * 1.1);
  ctx.lineTo(-r * 0.38, r * 0.5);
  ctx.lineTo(r * 0.38, r * 0.5);
  ctx.closePath();
  ctx.fill();
  if (deco) {
    ctx.strokeStyle = 'rgba(26,36,16,0.8)';
    ctx.lineWidth = 2;
    ctx.stroke();
    // 四侧利爪
    ctx.strokeStyle = look.accent;
    ctx.lineWidth = 2.4;
    ctx.lineCap = 'round';
    const claw = r * 0.98;
    ctx.beginPath();
    ctx.moveTo(-r * 0.28, -r * 0.3);
    ctx.lineTo(-claw, -r * 0.62);
    ctx.moveTo(r * 0.28, -r * 0.3);
    ctx.lineTo(claw, -r * 0.62);
    ctx.moveTo(-r * 0.28, r * 0.1);
    ctx.lineTo(-r * 0.9, -r * 0.02);
    ctx.moveTo(r * 0.28, r * 0.1);
    ctx.lineTo(r * 0.9, -r * 0.02);
    ctx.stroke();
    // 眼缝：细长绿光（伏击者的注视）
    ctx.fillStyle = '#D8FF50';
    ctx.fillRect(-r * 0.16, -r * 0.66, r * 0.32, r * 0.1);
  }
  ctx.restore();
}

function drawQueenBody(ctx: CanvasRenderingContext2D, m: MonsterRuntime, t: number, color: string, deco: boolean, look: MonsterLook): void {
  const x = m.x, y = m.y, r = m.cfg.radius;
  const aura = m.cfg.healAura;
  if (aura && deco) {
    // 治疗光环进度与真实计时同步：环扩张到位的一刻正是治疗落下的时刻（信息型表现）
    const total = Math.max(0.001, aura.interval);
    const k = Math.min(1, Math.max(0, 1 - m.healTimer / total));
    const eased = 1 - Math.pow(1 - k, 3);
    const ringR = r * 1.15 + (aura.radius - r * 1.15) * eased;
    const glow = ctx.createRadialGradient(x, y, r * 0.6, x, y, aura.radius);
    const ga = 0.05 + 0.1 * (1 - k);
    glow.addColorStop(0, `rgba(124,179,66,${ga * 1.6})`);
    glow.addColorStop(0.72, `rgba(124,179,66,${ga * 0.6})`);
    glow.addColorStop(1, 'rgba(124,179,66,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(x, y, aura.radius, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = `rgba(124,179,66,${0.15 + 0.45 * k})`;
    ctx.lineWidth = 2.5 - 1.5 * k;
    ctx.beginPath();
    ctx.arc(x, y, ringR, 0, TAU);
    ctx.stroke();
    // 环绕卵粒
    const n = Math.min(6, Math.max(3, Math.round(aura.radius / 60)));
    for (let i = 0; i < n; i++) {
      const a = (TAU * i) / n + t * 0.45 + m.phase;
      const rise = (t * 0.18 + i * 0.37) % 1;
      const rr2 = ringR * (0.35 + 0.62 * rise);
      ctx.fillStyle = `rgba(174,234,0,${((1 - rise) * 0.55 * (0.35 + 0.65 * k)).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(x + Math.cos(a) * rr2, y + Math.sin(a) * rr2 * 0.82, 2.4 - rise, 0, TAU);
      ctx.fill();
    }
  }
  //  brood sac：虫后的"生产者"身份（朝身后 +y 的卵囊，缓慢鼓动）
  const belly = 1 + 0.06 * Math.sin(t * 2.6 + m.phase);
  ctx.fillStyle = deco ? 'rgba(124,179,66,0.55)' : color;
  ctx.beginPath();
  ctx.ellipse(x, y + r * 0.62, r * 0.62 * belly, r * 0.46 * belly, 0, 0, TAU);
  ctx.fill();
  // 菱形主体：三层同心，内芯保留本体紫色（身份由光环承担）
  const layers: Array<[number, string]> = deco
    ? [[1.0, color], [0.64, '#A46BE0'], [0.3, '#D9A6FF']]
    : [[1.0, color]];
  for (const [k2, c2] of layers) {
    ctx.fillStyle = c2;
    ctx.beginPath();
    ctx.moveTo(x, y - r * k2);
    ctx.lineTo(x + r * 0.8 * k2, y);
    ctx.lineTo(x, y + r * k2);
    ctx.lineTo(x - r * 0.8 * k2, y);
    ctx.closePath();
    ctx.fill();
  }
  if (deco) {
    // 头冠：三根向外的小刺，虫后与普通怪的唯一剪影差异
    ctx.fillStyle = '#FF9DE2';
    for (const sx of [-0.34, 0, 0.34]) {
      ctx.beginPath();
      ctx.moveTo(x + sx * r, y - r * 0.92);
      ctx.lineTo(x + sx * r - r * 0.1, y - r * 1.24);
      ctx.lineTo(x + sx * r + r * 0.1, y - r * 1.24);
      ctx.closePath();
      ctx.fill();
    }
  }
}

function drawBanelingBody(ctx: CanvasRenderingContext2D, m: MonsterRuntime, t: number, color: string, deco: boolean, look: MonsterLook): void {
  const x = m.x, y = m.y, r = m.cfg.radius;
  // 核心：脉动频率随「真实危险度」加快——低血或贴近城墙时闪得更急，玩家可据此预判爆炸时机
  const hpK = Math.min(1, Math.max(0, 1 - m.hp / m.maxHp));
  const danger = m.state === 'assault' ? 1 : Math.max(hpK, 0);
  const rate = 4 + 10 * danger;
  const amp = 0.1 + 0.16 * danger;
  const pulse = 1 + amp * Math.sin(t * rate + m.phase);
  if (danger > 0.35 && deco) {
    const warnK = (danger - 0.35) / 0.65;
    ctx.strokeStyle = `rgba(255,90,60,${(0.25 + 0.5 * warnK) * (0.6 + 0.4 * Math.sin(t * rate + m.phase))})`;
    ctx.lineWidth = 2 + 2 * warnK;
    ctx.beginPath();
    ctx.arc(x, y, r * pulse + 3, 0, TAU);
    ctx.stroke();
  }
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, r * pulse, 0, TAU);
  ctx.fill();
  if (deco) {
    // 内核：像即将失控的反应堆
    const coreK = 0.4 + 0.6 * danger;
    ctx.fillStyle = `rgba(255,${Math.round(220 - 90 * danger)},${Math.round(120 - 100 * danger)},${0.55 + 0.4 * danger})`;
    ctx.beginPath();
    ctx.arc(x, y, r * 0.45 * pulse * coreK, 0, TAU);
    ctx.fill();
    // 内裂纹：濒死时向外辐射的酸性亮线
    if (danger > 0.5) {
      const cr = (danger - 0.5) / 0.5;
      ctx.strokeStyle = `rgba(216,255,80,${0.5 * cr})`;
      ctx.lineWidth = 1.5;
      for (let i = 0; i < 4; i++) {
        const a = (Math.PI / 2) * i + t * 1.2 + m.phase;
        ctx.beginPath();
        ctx.moveTo(x + Math.cos(a) * r * 0.3, y + Math.sin(a) * r * 0.3);
        ctx.lineTo(x + Math.cos(a) * r * pulse * 0.92, y + Math.sin(a) * r * pulse * 0.92);
        ctx.stroke();
      }
    }
    // 临爆闪白
    if (danger > 0.75) {
      const finalK = (danger - 0.75) / 0.25;
      const fl = Math.max(0, Math.sin(t * 26 + m.phase));
      ctx.fillStyle = `rgba(255,255,255,${0.55 * finalK * fl * fl})`;
      ctx.beginPath();
      ctx.arc(x, y, r * pulse, 0, TAU);
      ctx.fill();
    }
  }
}

function drawUltraBody(ctx: CanvasRenderingContext2D, m: MonsterRuntime, t: number, color: string, deco: boolean, look: MonsterLook): void {
  const x = m.x, y = m.y, r = m.cfg.radius;
  // 重踏：巨兽的"重量"由落地尘环承担（每 1.6s 一踏）
  if (deco) {
    const stomp = (t * 0.62 + m.phase) % 1;
    if (stomp < 0.5) {
      const k = stomp / 0.5;
      ctx.strokeStyle = `rgba(105,168,59,${0.28 * (1 - k)})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.ellipse(x, y - r * 0.2, r * (1 + k * 0.5), r * 0.42 * (1 + k * 0.5), 0, 0, TAU);
      ctx.stroke();
    }
  }
  // 十角甲壳
  ctx.fillStyle = color;
  poly(ctx, x, y, 10, r, -Math.PI / 2, 0.72);
  ctx.fill();
  if (deco) {
    ctx.strokeStyle = 'rgba(26,36,16,0.9)';
    ctx.lineWidth = 3;
    poly(ctx, x, y, 10, r, -Math.PI / 2, 0.72);
    ctx.stroke();
    // 镰刀双臂
    ctx.strokeStyle = look.accent;
    ctx.lineWidth = 6;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x - r * 0.75, y - r * 0.15);
    ctx.quadraticCurveTo(x - r * 1.5, y - r * 0.5, x - r * 1.45, y - r * 1.05);
    ctx.moveTo(x + r * 0.75, y - r * 0.15);
    ctx.quadraticCurveTo(x + r * 1.5, y - r * 0.5, x + r * 1.45, y - r * 1.05);
    ctx.stroke();
    ctx.lineCap = 'butt';
    // 足部犄角
    ctx.strokeStyle = 'rgba(26,36,16,0.9)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x - r * 0.3, y + r * 0.75);
    ctx.lineTo(x - r * 0.55, y + r * 1.05);
    ctx.moveTo(x + r * 0.3, y + r * 0.75);
    ctx.lineTo(x + r * 0.55, y + r * 1.05);
    ctx.stroke();
    // 核心：酸绿光点（重甲里的生物感）
    ctx.fillStyle = '#D8FF50';
    ctx.beginPath();
    ctx.arc(x, y - r * 0.05, r * 0.14, 0, TAU);
    ctx.fill();
  }
}

// ---------------- 武器挂载（每个炮口都是那件武器的"剪影"） ----------------

/**
 * 机身挂载绘制：调用方给世界坐标与朝向，本函数负责该武器的专属外形与炮口动画。
 * 局部坐标：+y = 炮口指向（前方）。
 * k = 开火闪光剩余比例（0~1）；beamLive = 光束正持有；overheated = 强制散热中。
 */
export function drawWeaponMount(
  ctx: CanvasRenderingContext2D,
  w: WeaponInstance,
  x: number,
  y: number,
  angle: number,
  t: number,
  color: string,
  k: number,
  beamLive: boolean,
  overheated: boolean,
): void {
  const look = weaponLook(w);
  const id = w.cfg.id;
  const isBeam = !!w.cfg.beamBase;
  const recoil = isBeam ? 0 : k * 3; // 持续光束不播后坐（每 0.4s 一次会抖）

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle - Math.PI / 2);

  // 底座（所有武器共有，保证是"同一台机器上换炮"）
  ctx.fillStyle = '#12142B';
  ctx.strokeStyle = '#3D4470';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(0, 0, 7.5, 0, TAU);
  ctx.fill();
  ctx.stroke();

  // 武器专属外形
  switch (id) {
    case 'crossbow_pierce': {
      // 弩臂 + 弦：横向弓形是弩的剪影
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.4;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(-10, 5);
      ctx.quadraticCurveTo(0, 11, 10, 5);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(245,245,250,0.75)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(-10, 5);
      ctx.lineTo(0, 1 + recoil * 0.6);
      ctx.lineTo(10, 5);
      ctx.stroke();
      // 弩箭
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(0, 14 - recoil);
      ctx.stroke();
      break;
    }
    case 'alchemist_bomb': {
      // 短粗臼炮 + 口部敞口
      ctx.fillStyle = '#1B1E3A';
      rr(ctx, -4.5, -3, 9, 15, 2.5);
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      rr(ctx, -4.5, -3, 9, 15, 2.5);
      ctx.stroke();
      ctx.fillStyle = '#0B0C1D';
      ctx.beginPath();
      ctx.ellipse(0, 12, 4.6, 2.2, 0, 0, TAU);
      ctx.fill();
      // 待机余烟
      const puff = (t * 0.6 + (w.cfg.id.length % 3) * 0.3) % 1;
      ctx.fillStyle = `rgba(255,179,87,${0.22 * (1 - puff)})`;
      ctx.beginPath();
      ctx.arc(0, 14 + puff * 10, 2 + puff * 5, 0, TAU);
      ctx.fill();
      break;
    }
    case 'boomerang': {
      // 叉形发射器 + 待发圆盘
      ctx.strokeStyle = '#3D4470';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(-4, 2);
      ctx.lineTo(-5, 12);
      ctx.moveTo(4, 2);
      ctx.lineTo(5, 12);
      ctx.stroke();
      ctx.save();
      ctx.translate(0, 8);
      ctx.rotate(t * 9);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      for (let i = 0; i < 3; i++) {
        const a = (Math.PI / 3) * i;
        ctx.beginPath();
        ctx.moveTo(-Math.cos(a) * 4.5, -Math.sin(a) * 4.5);
        ctx.lineTo(Math.cos(a) * 4.5, Math.sin(a) * 4.5);
        ctx.stroke();
      }
      ctx.restore();
      break;
    }
    case 'lightning_chain': {
      // 权杖 + 顶端晶体
      ctx.strokeStyle = '#3D4470';
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(0, 1);
      ctx.lineTo(0, 11);
      ctx.stroke();
      const flick = 0.55 + 0.45 * Math.sin(t * 11);
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.35 + 0.4 * flick;
      ctx.beginPath();
      ctx.moveTo(0, 11);
      ctx.lineTo(4.5, 15.5);
      ctx.lineTo(0, 20);
      ctx.lineTo(-4.5, 15.5);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#F5F5FA';
      ctx.beginPath();
      ctx.arc(0, 15.5, 1.8, 0, TAU);
      ctx.fill();
      break;
    }
    case 'laser_cannon': {
      // 聚能镜筒：前窄后宽的透镜锥 + 玻璃高光
      ctx.fillStyle = '#1B1E3A';
      ctx.beginPath();
      ctx.moveTo(-5, 1);
      ctx.lineTo(5, 1);
      ctx.lineTo(3.5, 14);
      ctx.lineTo(-3.5, 14);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.8;
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.globalAlpha = beamLive ? 0.85 : 0.28;
      ctx.beginPath();
      ctx.ellipse(0, 13, 3.2, 1.8, 0, 0, TAU);
      ctx.fill();
      ctx.globalAlpha = 1;
      break;
    }
    case 'gun_rifle':
    default: {
      // 双管速射：两根细管是"弹幕雨"的剪影
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.4;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(-2.6, -3 + recoil * 0.4);
      ctx.lineTo(-2.6, 13 - recoil);
      ctx.moveTo(2.6, -3 + recoil * 0.4);
      ctx.lineTo(2.6, 13 - recoil);
      ctx.stroke();
      // 符文环（元素属性也会染它）
      ctx.strokeStyle = 'rgba(245,245,250,0.5)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(0, 8, 4.4, 0, TAU);
      ctx.stroke();
      break;
    }
  }

  // 炮口端点光
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(0, 13 - recoil, 2.4, 0, TAU);
  ctx.fill();

  // 光束持束 / 过热
  if (beamLive) {
    ctx.globalAlpha = 0.45 + 0.25 * Math.sin(t * 24);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(0, 13, 6.5, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#F5F5FA';
    ctx.beginPath();
    ctx.arc(0, 13, 2.6, 0, TAU);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  if (overheated) {
    ctx.globalAlpha = 0.45 + 0.3 * Math.sin(t * 12);
    ctx.strokeStyle = '#FF7A6B';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, 9.5, 0, TAU);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // 开火闪光（形态 = 这把武器的"枪声"）
  if (k > 0.02) {
    drawMuzzleFlash(ctx, look.muzzle, t, k, recoil, color);
  }
  ctx.restore();
}

function drawMuzzleFlash(
  ctx: CanvasRenderingContext2D,
  style: string,
  t: number,
  k: number,
  recoil: number,
  color: string,
): void {
  const yy = 15 - recoil;
  ctx.save();
  ctx.globalAlpha = Math.min(1, k) * 0.9;
  switch (style) {
    case 'cone': {
      // 弩：前冲锥形气浪
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(-2, yy);
      ctx.lineTo(0, yy + 10 + 6 * k);
      ctx.lineTo(2, yy);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'puff': {
      // 臼炮：两团圆烟
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(-2.4, yy + 3, 3.2 + 3 * k, 0, TAU);
      ctx.arc(2.8, yy + 5, 2.4 + 2.4 * k, 0, TAU);
      ctx.fill();
      break;
    }
    case 'ring': {
      // 圆盘发射：环形气浪
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, yy, 3 + 9 * k, 0, TAU);
      ctx.stroke();
      break;
    }
    case 'crackle': {
      // 权杖：小电弧
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      for (let i = 0; i < 3; i++) {
        const a = (Math.PI * 2 * i) / 3 + t * 3;
        ctx.moveTo(Math.cos(a) * 3, yy + Math.sin(a) * 3);
        ctx.lineTo(Math.cos(a) * 9, yy + Math.sin(a) * 9);
      }
      ctx.stroke();
      break;
    }
    case 'lens': {
      // 激光：镜头耀斑（横向拉长）
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.ellipse(0, yy + 1, 10 + 6 * k, 1.6, 0, 0, TAU);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(0, yy, 2 + 2.5 * k, 0, TAU);
      ctx.fill();
      break;
    }
    case 'star':
    default: {
      // 步枪：四点星芒 + 芯
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      const L1 = 4 + 7 * k;
      const L2 = 3 + 4 * k;
      ctx.moveTo(-L1, yy);
      ctx.lineTo(L1, yy);
      ctx.moveTo(0, yy - L2);
      ctx.lineTo(0, yy + L2);
      ctx.moveTo(-L2 * 0.7, yy - L2 * 0.7);
      ctx.lineTo(L2 * 0.7, yy + L2 * 0.7);
      ctx.moveTo(-L2 * 0.7, yy + L2 * 0.7);
      ctx.lineTo(L2 * 0.7, yy - L2 * 0.7);
      ctx.stroke();
      ctx.fillStyle = '#FFF6D6';
      ctx.beginPath();
      ctx.arc(0, yy, 1.8 + 2.4 * k, 0, TAU);
      ctx.fill();
      break;
    }
  }
  ctx.restore();
}

// ---------------- 子弹 ----------------

/**
 * 按武器绘制子弹（t = 秒）。形态由 weaponLook 决定，颜色由当前元素决定：
 * rune 符文弹 / bolt 重弩箭 / flask 药瓶 / disc 锯齿盘 / chain 落雷（无弹体）。
 */
export function drawProjectile(
  ctx: CanvasRenderingContext2D,
  p: ProjectileRuntime,
  t: number,
  color: string,
): void {
  const look = weaponLook(p.weapon);
  const dx = p.x - p.px;
  const dy = p.y - p.py;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const ang = Math.atan2(uy, ux);

  switch (look.bullet) {
    case 'bolt': {
      // 重弩箭：长杆 + 钢箭头 + 尾羽 + 贯穿残影（穿透武器的身份）
      const shaft = 26;
      ctx.strokeStyle = `${color}30`;
      ctx.lineWidth = 5;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(p.x - ux * 84, p.y - uy * 84);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.6;
      ctx.beginPath();
      ctx.moveTo(p.x - ux * shaft, p.y - uy * shaft);
      ctx.lineTo(p.x + ux * 6, p.y + uy * 6);
      ctx.stroke();
      // 钢箭头
      ctx.fillStyle = '#F5F5FA';
      ctx.beginPath();
      ctx.moveTo(p.x + ux * 13, p.y + uy * 13);
      ctx.lineTo(p.x - ux * 1 + -uy * 4.4, p.y - uy * 1 + ux * 4.4);
      ctx.lineTo(p.x - ux * 1 - -uy * 4.4, p.y - uy * 1 - ux * 4.4);
      ctx.closePath();
      ctx.fill();
      // 尾羽（把"箭"和"梭"区分开）
      ctx.strokeStyle = look.accent;
      ctx.lineWidth = 2;
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(p.x - ux * shaft, p.y - uy * shaft);
        ctx.lineTo(p.x - ux * (shaft + 9) + -uy * 5 * s, p.y - uy * (shaft + 9) + ux * 5 * s);
        ctx.stroke();
      }
      break;
    }
    case 'flask': {
      // 药瓶：地面投影 + 瓶体 + 瓶颈 + 引线火花；高度由 p.height 决定
      const h = p.height;
      ctx.fillStyle = 'rgba(0,0,0,0.28)';
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, 10, 3.6, 0, 0, TAU);
      ctx.fill();
      const by = p.y + h;
      // 药瓶
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(p.x, by, p.radius + 3.5, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = 'rgba(11,12,29,0.65)';
      ctx.lineWidth = 2;
      ctx.stroke();
      // 瓶颈 + 软木塞
      ctx.fillStyle = '#C9A26B';
      rr(ctx, p.x - 2.4, by + p.radius + 1.5, 4.8, 6, 1.4);
      ctx.fill();
      // 引线火花（摆动 = 还在烧）
      const sway = Math.sin(t * 18) * 2.4;
      ctx.strokeStyle = '#C9A26B';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(p.x, by + p.radius + 7);
      ctx.quadraticCurveTo(p.x + sway, by + p.radius + 11, p.x + sway * 0.6, by + p.radius + 14);
      ctx.stroke();
      ctx.fillStyle = `rgba(255,213,79,${0.6 + 0.4 * Math.sin(t * 22)})`;
      ctx.beginPath();
      ctx.arc(p.x + sway * 0.6, by + p.radius + 15, 2.4, 0, TAU);
      ctx.fill();
      // 液面高光
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.beginPath();
      ctx.arc(p.x - p.radius * 0.35, by + p.radius * 0.4, 2, 0, TAU);
      ctx.fill();
      break;
    }
    case 'disc': {
      // 锯齿圆盘（血滴子）：外齿 + 内环镂空 + 双弧运动模糊
      const R = 17;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(t * 11 + p.id);
      ctx.strokeStyle = `${color}55`;
      ctx.lineWidth = 2;
      for (let i = 0; i < 2; i++) {
        ctx.beginPath();
        ctx.arc(0, 0, R + 4 + i * 3, 0.3 + i, 2.1 + i);
        ctx.stroke();
      }
      ctx.fillStyle = color;
      for (let i = 0; i < 8; i++) {
        ctx.save();
        ctx.rotate((Math.PI / 4) * i);
        ctx.fillRect(-2.5, -R - 4.5, 5, 6.5);
        ctx.restore();
      }
      ctx.beginPath();
      ctx.arc(0, 0, R, 0, TAU);
      ctx.fill();
      ctx.fillStyle = '#0B0C1D';
      ctx.beginPath();
      ctx.arc(0, 0, R * 0.45, 0, TAU);
      ctx.fill();
      // 回转箭头：回程时提示"它还会再切一刀"
      if (p.homing) {
        ctx.strokeStyle = 'rgba(255,213,79,0.8)';
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.arc(0, 0, R + 8, -0.6, 1.6);
        ctx.stroke();
      }
      ctx.restore();
      break;
    }
    case 'chain':
    case 'beam': {
      // 落雷/光束没有弹体：若因词缀产生实体弹（分裂/弹射），按符文弹绘制，保持"弹药家族"识别
      drawRuneBullet(ctx, p, ang, color, look.accent, t);
      break;
    }
    case 'rune':
    default: {
      drawRuneBullet(ctx, p, ang, color, look.accent, t);
      break;
    }
  }
}

/** 符文弹：菱形弹体 + 旋转符文环 + 短曳光（速射武器的标准"弹幕单元"）。 */
function drawRuneBullet(
  ctx: CanvasRenderingContext2D,
  p: ProjectileRuntime,
  ang: number,
  color: string,
  accent: string,
  t: number,
): void {
  const r = Math.max(3, p.radius);
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(ang);
  // 曳光（朝速度反方向渐隐）
  const grad = ctx.createLinearGradient(-34, 0, 0, 0);
  grad.addColorStop(0, `${color}00`);
  grad.addColorStop(1, `${color}88`);
  ctx.strokeStyle = grad;
  ctx.lineWidth = 2.6;
  ctx.beginPath();
  ctx.moveTo(-34, 0);
  ctx.lineTo(0, 0);
  ctx.stroke();
  // 菱形弹体
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(r * 1.7, 0);
  ctx.lineTo(0, r * 1.05);
  ctx.lineTo(-r * 1.7, 0);
  ctx.lineTo(0, -r * 1.05);
  ctx.closePath();
  ctx.fill();
  // 符文环：小角度旋转，读作"正在充能"
  ctx.strokeStyle = accent;
  ctx.globalAlpha = 0.7;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.arc(0, 0, r * 1.9, t * 6, t * 6 + 2.1);
  ctx.stroke();
  ctx.globalAlpha = 1;
  // 芯
  ctx.fillStyle = '#FFFFFF';
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.42, 0, TAU);
  ctx.fill();
  ctx.restore();
}

// ---------------- 怪物远程弹 ----------------

/** 怪物远程弹：投矛=旋转梭标 + 甩尾，投石=翻滚石块 + 尘土（警示橙）。 */
export function drawMonsterShot(ctx: CanvasRenderingContext2D, s: MonsterShot): void {
  const color = '#FFB357';
  if (s.kind === 'rock') {
    // 落点投影（预判砸墙位置）
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.beginPath();
    ctx.ellipse(s.x, s.ty, 10, 4, 0, 0, TAU);
    ctx.fill();
    // 翻滚石块
    const rot = s.t * 9;
    ctx.save();
    ctx.translate(s.x, s.y + s.height);
    ctx.rotate(rot);
    ctx.fillStyle = color;
    ctx.beginPath();
    for (let i = 0; i < 7; i++) {
      const a = (TAU / 7) * i;
      const rad = i % 2 === 0 ? 9.5 : 7.5;
      const px = Math.cos(a) * rad;
      const py = Math.sin(a) * rad;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(11,12,29,0.5)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = 'rgba(11,12,29,0.25)';
    ctx.beginPath();
    ctx.arc(-2, 1.5, 2.6, 0, TAU);
    ctx.arc(3, -2, 1.8, 0, TAU);
    ctx.fill();
    ctx.restore();
    // 尘土尾迹
    for (let i = 0; i < 3; i++) {
      const k = ((s.t * 3 + i * 0.33) % 1);
      ctx.fillStyle = `rgba(169,113,75,${0.18 * (1 - k)})`;
      ctx.beginPath();
      ctx.arc(s.x - (s.x - s.sx) * k * 0.25, s.y + s.height * (1 - k * 0.2), 3 + k * 4, 0, TAU);
      ctx.fill();
    }
  } else {
    // 投矛：沿弹道旋转 + 橙色甩尾
    const dx = s.tx - s.sx;
    const dy = s.ty - s.sy;
    const l = Math.hypot(dx, dy) || 1;
    const ux = dx / l;
    const uy = dy / l;
    const spin = Math.sin(s.t * 12) * 0.25; // 飞行中的轻微翻转
    ctx.save();
    ctx.translate(s.x, s.y + s.height);
    ctx.rotate(Math.atan2(uy, ux) + spin);
    ctx.strokeStyle = `${color}55`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(-26, 0);
    ctx.lineTo(-8, 0);
    ctx.stroke();
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-16, 0);
    ctx.lineTo(6, 0);
    ctx.stroke();
    ctx.fillStyle = '#F5F5FA';
    ctx.beginPath();
    ctx.moveTo(12, 0);
    ctx.lineTo(3, 3);
    ctx.lineTo(3, -3);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}

// ---------------- 场景符号（治疗/转嫁/弹坑） ----------------

/** 治疗光环脉冲：绿色扩散环（k = 0~1 进度）。 */
export function drawHealPulse(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, k: number): void {
  const alpha = 0.5 * (1 - k);
  ctx.strokeStyle = `rgba(124,179,66,${alpha})`;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(x, y, radius * (0.3 + 0.7 * k), 0, TAU);
  ctx.stroke();
}

/** 伤害转嫁连线：巫师 → 替伤怪物（紫色电弧，0.3s 闪现）。 */
export function drawTransfer(
  ctx: CanvasRenderingContext2D,
  fx: number,
  fy: number,
  tx: number,
  ty: number,
  alpha: number,
): void {
  const mx = (fx + tx) / 2 + (Math.random() - 0.5) * 24;
  const my = (fy + ty) / 2 + (Math.random() - 0.5) * 24;
  ctx.strokeStyle = `rgba(179,136,255,${alpha})`;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(fx, fy);
  ctx.lineTo(mx, my);
  ctx.lineTo(tx, ty);
  ctx.stroke();
}

/** 弹坑（持续伤害圈）强化绘制：焦黑坑缘 + 熔核脉动 + 上升火星（t = 秒）。 */
export function drawPool(ctx: CanvasRenderingContext2D, pool: DamagePool, t: number): void {
  const left = Math.max(0, pool.until - t);
  const lifeK = Math.min(1, left * 0.8); // 收尾渐隐
  const r = pool.radius;
  // 元素色：火焰坑/酸池/冰面用各自的伤害色，而不是一律熔岩（一眼分辨谁留下的坑）
  const fire = pool.damageType === 'fire';
  const outer = fire ? '255,90,60' : pool.damageType === 'poison' ? '124,179,66' : pool.damageType === 'frost' ? '79,195,247' : '179,136,255';
  const inner = fire ? '255,170,60' : pool.damageType === 'poison' ? '174,234,0' : pool.damageType === 'frost' ? '179,229,252' : '217,166,255';

  ctx.fillStyle = `rgba(11,12,29,${0.55 * lifeK})`;
  ctx.beginPath();
  ctx.arc(pool.x, pool.y, r + 6, 0, TAU);
  ctx.fill();

  const pulse = 0.85 + 0.15 * Math.sin(t * 6 + pool.x * 0.05);
  ctx.fillStyle = `rgba(${outer},${0.4 * lifeK})`;
  ctx.beginPath();
  ctx.arc(pool.x, pool.y, r * pulse, 0, TAU);
  ctx.fill();
  ctx.fillStyle = `rgba(${inner},${0.35 * lifeK})`;
  ctx.beginPath();
  ctx.arc(pool.x, pool.y, r * 0.55 * pulse, 0, TAU);
  ctx.fill();

  ctx.strokeStyle = `rgba(${outer},${0.8 * lifeK})`;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(pool.x, pool.y, r, 0, TAU);
  ctx.stroke();

  // 上升火星（确定性相位）
  for (let i = 0; i < 4; i++) {
    const seed = pool.x * 0.13 + pool.y * 0.07 + i * 2.4;
    const k = (t * 0.9 + seed) % 1;
    const ex = pool.x + Math.sin(seed * 7 + k * 3) * r * 0.6 * (1 - k);
    const ey = pool.y + (0.5 - k) * r * 1.2;
    ctx.fillStyle = `rgba(255,213,79,${(1 - k) * 0.8 * lifeK})`;
    ctx.beginPath();
    ctx.arc(ex, ey, 2.2, 0, TAU);
    ctx.fill();
  }
}
