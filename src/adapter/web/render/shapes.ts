/**
 * 几何绘制库（docs/06 形状语言）：所有战斗单位的"美术贴图"。
 *
 * 三条纪律在代码里的落点：
 *  ① 形状语言：友方=圆/圆角（英雄、宝石、治疗），敌方=三角/尖角（怪物），场景=矩形/网格；
 *  ② 配色克制：层次全部由 palette 既有色「提亮/压深」派生，不引入新色相；
 *  ③ 生命力来自动效：每一个单位都有专属待机/移动/攻击姿态，且至少有一处"信息型"表现
 *     （冲刺前摇、护甲层数、治疗进度、临爆闪白……），保证好看但不误导。
 *
 * 几何 ≠ 简陋：每个形体由「底色块 + 受光面 + 暗部 + 高光 + 墨线」五层构成，
 * 再叠上阴影与微动效；同屏大量单位时也不用渐变（改用分层色块），保证 60fps。
 *
 * 坐标系：调用方已做 y 轴翻转，这里直接使用游戏坐标（y 向上，敌人从上方压下来）。
 */
import { HeroRuntime, MonsterRuntime, MonsterShot, ProjectileRuntime } from '../../../gamecore';
import { drawGlow, drawGroundShadow, rgba, lighten, darken, mix, hash01 } from './style';

/** 怪物配色：同族珊瑚色系渐变 + 岩甲灰蓝（docs/06 色板纪律内）。 */
const MONSTER_COLOR: Record<string, string> = {
  slime: '#FF6B57',
  wolf: '#FF8357',
  charger: '#FFA25E',
  thrower: '#FF5E7A',
  bulwark: '#8A93B8',
  bat: '#FF7EC7',
  shroom: '#FF6B9C',
  boss: '#B537F2',
  shaman: '#B388FF',
  // 虫族（酸性绿族 + 紫点缀，docs/08）
  larva: '#9CCC65',
  roach: '#7CB342',
  lurker: '#558B2F',
  zqueen: '#C77DFF',
  baneling: '#AEEA00',
  ultra: '#69A83B',
};

const INK = '#0B0C1D';

export function monsterColor(m: MonsterRuntime): string {
  return MONSTER_COLOR[m.cfg.shape ?? 'slime'] ?? '#FF6B57';
}

export function monsterColorByKey(key: string): string {
  return MONSTER_COLOR[key] ?? '#FF6B57';
}

/** 体型分档：影响描边层数、光环与细节密度（精英 = 同族放大 + 双层描边脉冲）。 */
function tierOf(m: MonsterRuntime): 0 | 1 | 2 {
  if (m.cfg.shape === 'boss') return 2;
  if (m.cfg.radius >= 40 || m.cfg.hp >= 500) return 1;
  return 0;
}

// ---------------- 基础路径工具 ----------------

function rrPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

function polyPath(
  ctx: CanvasRenderingContext2D,
  n: number,
  r: number,
  rot = 0,
  innerRatio = 1,
): void {
  ctx.beginPath();
  for (let i = 0; i < n * 2; i++) {
    const a = (Math.PI / n) * i + rot - Math.PI / 2;
    const rad = i % 2 === 0 ? r : r * innerRatio;
    const px = Math.cos(a) * rad;
    const py = Math.sin(a) * rad;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

function ptsPath(ctx: CanvasRenderingContext2D, pts: number[][]): void {
  ctx.beginPath();
  pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p[0], p[1]) : ctx.lineTo(p[0], p[1])));
  ctx.closePath();
}

/** 墨线描边：把单位从夜色背景里"抠"出来（可读性铁律：轮廓优先）。 */
function inkStroke(ctx: CanvasRenderingContext2D, width = 2.2): void {
  ctx.strokeStyle = INK;
  ctx.lineWidth = width;
  ctx.stroke();
}

/** 在局部坐标里按 0.78 比例生成受光面（同形状缩小心向上偏），不依赖渐变。 */
function lightShape(ctx: CanvasRenderingContext2D, color: string, alpha = 0.3, dy = 0.12): void {
  ctx.save();
  ctx.translate(0, dy);
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
}

// ---------------- 怪物 ----------------

/**
 * 按种类绘制怪物（t = 秒，用于行走进缩与扑翼）。
 * flash: 0~1 受击闪白强度（FxRuntime.flashAlpha，来源 fx-config.json hitFlash）。
 * squash: 纵向缩放倍率（FxRuntime.hitSquash，来源 fx-config.json squashStretch），1=不变形。
 * scale: 出场/出生缩放（renderer 的 spawnPop，默认 1）。
 * 状态指示（冰环/火）由 drawMonsterStatus 叠加。
 */
export function drawMonster(
  ctx: CanvasRenderingContext2D,
  m: MonsterRuntime,
  t: number,
  flash = 0,
  squash = 1,
  scale = 1,
): void {
  const r = m.cfg.radius;
  const x = m.x;
  const y = m.y;
  const color = monsterColor(m);
  const tier = tierOf(m);
  const flying = m.cfg.shape === 'bat';

  // 接地阴影（飞行单位更小更淡，并随扑翼轻微收缩）
  if (!m.burrowed) {
    const sh = flying ? 0.62 : 0.9;
    const flap = flying ? 0.85 + 0.15 * Math.sin(t * 12 + m.phase) : 1;
    drawGroundShadow(ctx, x, y - r * (flying ? 1.5 : 0.82), r * 1.08 * flap, r * 0.4 * flap, sh);
  }

  // 精英/Boss 地面光环（词缀色光环；纯表现，不改变语义）
  if (!m.burrowed && tier > 0) {
    const pulse = 0.5 + 0.5 * Math.sin(t * 2.4 + m.phase);
    ctx.strokeStyle = rgba(tier === 2 ? '#B537F2' : '#FF3D71', 0.18 + 0.14 * pulse);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(x, y - r * 0.8, r * 1.35, r * 0.52, 0, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.save();
  ctx.translate(x, y);
  if (scale !== 1) ctx.scale(scale, scale);

  // 挤压回弹（squashStretch）：以脚底为锚点纵向缩放，横向反比补偿保持体积感。
  const deform = Math.abs(squash - 1) > 0.001;
  if (deform) {
    ctx.translate(0, -r);
    ctx.scale(1 / squash, squash);
    ctx.translate(0, r);
  }

  drawMonsterBody(ctx, m, t, false, tier);
  if (flash > 0) {
    // 受击闪白：同一套形状重填纯白（而不是盖一个白圆），闪白严格贴合几何轮廓。
    ctx.save();
    ctx.globalAlpha = flash;
    drawMonsterBody(ctx, m, t, true, tier);
    ctx.restore();
  }
  ctx.restore();
}

/** 单位状态叠加：冰冻、灼烧、护盾层数、被破甲（由 scene 每帧调用）。 */
export function drawMonsterStatus(
  ctx: CanvasRenderingContext2D,
  m: MonsterRuntime,
  t: number,
  now: number,
): void {
  const r = m.cfg.radius;
  if (now < m.slowUntil) {
    // 冰冻：青蓝双层环 + 冰晶碎片（信息型：减速中）
    ctx.strokeStyle = rgba('#4FC3F7', 0.75);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(m.x, m.y, r + 4, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = rgba('#BFFFF2', 0.35);
    ctx.beginPath();
    ctx.arc(m.x, m.y, r + 7, t * 1.4, t * 1.4 + 2.2);
    ctx.stroke();
    for (let i = 0; i < 3; i++) {
      const a = t * 0.6 + (i * Math.PI * 2) / 3;
      drawGlow(ctx, m.x + Math.cos(a) * (r + 2), m.y + Math.sin(a) * (r + 2), 5, '#4FC3F7', 0.5);
    }
  }
  if (m.burn && m.burn.until > now) {
    // 灼烧：摇曳的火舌 + 上升火星（DoT 的"看得见"）
    const fl = 9 + Math.sin(t * 16 + m.phase) * 3;
    const bx = m.x;
    const by = m.y + r + 2;
    ctx.fillStyle = '#FF5A3C';
    ctx.beginPath();
    ctx.moveTo(bx, by + fl * 1.8);
    ctx.quadraticCurveTo(bx - 8, by + fl * 0.8, bx - 2.5, by);
    ctx.quadraticCurveTo(bx, by + fl * 0.4, bx + 3, by);
    ctx.quadraticCurveTo(bx + 8, by + fl * 0.8, bx, by + fl * 1.8);
    ctx.fill();
    ctx.fillStyle = '#FFD54F';
    ctx.beginPath();
    ctx.moveTo(bx, by + fl * 1.1);
    ctx.quadraticCurveTo(bx - 3.5, by + fl * 0.5, bx, by);
    ctx.quadraticCurveTo(bx + 3.5, by + fl * 0.5, bx, by + fl * 1.1);
    ctx.fill();
    drawGlow(ctx, bx, by + fl * 0.7, 16, '#FF5A3C', 0.35);
  }
  if (m.shieldLeft > 0) {
    // 免伤层数：护甲环上的刻度（打一次掉一格，可读）
    const rr = r + 6;
    ctx.strokeStyle = rgba('#8A93B8', 0.5);
    ctx.lineWidth = 2.5;
    for (let i = 0; i < Math.min(4, m.shieldLeft); i++) {
      const a = Math.PI * 0.5 + (i - (Math.min(4, m.shieldLeft) - 1) / 2) * 0.42;
      ctx.beginPath();
      ctx.arc(m.x, m.y, rr, a - 0.12, a + 0.12);
      ctx.stroke();
    }
  }
}

function drawMonsterBody(
  ctx: CanvasRenderingContext2D,
  m: MonsterRuntime,
  t: number,
  tint: boolean,
  tier: 0 | 1 | 2,
): void {
  const r = m.cfg.radius;
  const base = monsterColor(m);

  // 钻地：土包 + 虚线轮廓 + 地下活动痕迹（看得见打不到，docs/08）
  if (m.burrowed) {
    drawBurrowed(ctx, m, t, base, tint);
    return;
  }

  const s: Skin = {
    r,
    color: tint ? '#FFFFFF' : base,
    light: tint ? '#FFFFFF' : lighten(base, 0.34),
    dark: tint ? '#FFFFFF' : darken(base, 0.4),
    deco: !tint,
    flat: tint,
    tier,
  };

  // 每个形体的内部变换（旋转/缩放/平移）自成作用域，保证闪白重描与正常绘制互不影响。
  ctx.save();
  switch (m.cfg.shape) {
    case 'larva':
      drawLarva(ctx, m, t, s);
      break;
    case 'roach':
      drawRoach(ctx, m, t, s);
      break;
    case 'lurker':
      drawLurker(ctx, m, t, s);
      break;
    case 'zqueen':
      drawZergQueen(ctx, m, t, s);
      break;
    case 'baneling':
      drawBaneling(ctx, m, t, s);
      break;
    case 'ultra':
      drawUltra(ctx, m, t, s);
      break;
    case 'wolf':
      drawWolf(ctx, m, t, s);
      break;
    case 'charger':
      drawCharger(ctx, m, t, s);
      break;
    case 'thrower':
      drawThrower(ctx, m, t, s);
      break;
    case 'bulwark':
      drawBulwark(ctx, m, t, s);
      break;
    case 'bat':
      drawBat(ctx, m, t, s);
      break;
    case 'shroom':
      drawShroom(ctx, m, t, s);
      break;
    case 'boss':
      drawBossTreant(ctx, m, t, s);
      break;
    case 'shaman':
      drawShaman(ctx, m, t, s);
      break;
    case 'slime':
    default:
      drawSlime(ctx, m, t, s);
      break;
  }
  ctx.restore();
}

interface Skin {
  r: number;
  color: string;
  light: string;
  dark: string;
  deco: boolean;
  flat: boolean;
  tier: 0 | 1 | 2;
}

/** 行走姿态的纵向起伏（脚底为原点，向上为正）。 */
function walkBob(m: MonsterRuntime, t: number, freq = 6, amp = 0.1): number {
  if (m.state !== 'march') return 0;
  return Math.abs(Math.sin(t * freq + m.phase)) * m.cfg.radius * amp;
}

// ---------- 史莱姆：圆角方块 + squash 弹跳 ----------
function drawSlime(ctx: CanvasRenderingContext2D, m: MonsterRuntime, t: number, s: Skin): void {
  const { r, color, light, dark, deco } = s;
  const moving = m.state === 'march';
  const hop = moving ? Math.abs(Math.sin(t * 3.6 + m.phase)) : 0;
  const sq = 1 + 0.13 * Math.sin(t * 7.2 + m.phase) * (moving ? 1 : 0.4);
  ctx.translate(0, hop * r * 0.34 + (moving ? 0 : Math.sin(t * 2 + m.phase) * 1.2));
  ctx.scale(1 / sq, sq);

  // 本体（圆角方块 = 友方/中性语言里的"软体"，用于史莱姆的弹性质感）
  rrPath(ctx, -r, -r, r * 2, r * 2, r * 0.46);
  ctx.fillStyle = s.flat ? '#FFFFFF' : color;
  ctx.fill();
  if (deco) {
    inkStroke(ctx, 2.4);
    // 顶部受光边：软胶质感的"高光带"（让圆角方块不再像色块）
    rrPath(ctx, -r * 0.94, -r * 0.94, r * 1.88, r * 1.88, r * 0.42);
    ctx.strokeStyle = rgba('#FFFFFF', 0.35);
    ctx.lineWidth = 2.2;
    ctx.stroke();
    // 受光面：内缩圆角块 + 左上高光
    rrPath(ctx, -r * 0.78, -r * 0.62, r * 1.56, r * 1.42, r * 0.4);
    lightShape(ctx, light, 0.4);
    ctx.fillStyle = rgba('#FFFFFF', 0.3);
    ctx.beginPath();
    ctx.ellipse(-r * 0.34, r * 0.4, r * 0.3, r * 0.19, -0.5, 0, Math.PI * 2);
    ctx.fill();
    // 内部气泡：3 个，缓慢上浮（生命感）
    for (let i = 0; i < 3; i++) {
      const ph = i * 2.1 + m.phase;
      const bx = Math.sin(t * 0.9 + ph) * r * 0.42;
      const by = ((t * 0.22 + i * 0.31) % 1) * r * 1.2 - r * 0.6;
      ctx.fillStyle = rgba(light, 0.35);
      ctx.beginPath();
      ctx.arc(bx, by, 2.2 - i * 0.4, 0, Math.PI * 2);
      ctx.fill();
    }
    // 暗部：底部压深，落地更稳
    ctx.fillStyle = rgba(dark, 0.22);
    ctx.beginPath();
    ctx.ellipse(0, -r * 0.66, r * 0.62, r * 0.2, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ---------- 野狼：尖三角 + 尾线 + 冲刺姿态 ----------
function drawWolf(ctx: CanvasRenderingContext2D, m: MonsterRuntime, t: number, s: Skin): void {
  const { r, color, light, dark, deco } = s;
  // 冲刺前摇/冲锋姿态由 dash 周期（2.2s：0.4 前摇 → 0.5 冲锋）驱动
  const cyc = m.state === 'march' ? m.phase % 2.2 : 0;
  const winding = cyc < 0.4;
  const rushing = cyc >= 0.4 && cyc < 0.9;
  const lean = rushing ? 1.16 : winding ? 0.94 : 1;
  ctx.translate(0, walkBob(m, t, 9, 0.06));
  ctx.scale(1 / Math.sqrt(lean), lean);

  if (rushing && deco) {
    // 冲刺残影：身后两道半透明轮廓（速度感，且只出现在真正冲锋时）
    for (let i = 2; i >= 1; i--) {
      ctx.fillStyle = rgba(color, 0.16 * (3 - i));
      ctx.save();
      ctx.translate(0, i * 9);
      ptsPath(ctx, [
        [0, -r * 1.05],
        [-r * 0.82, r * 0.62],
        [0, r * 0.3],
        [r * 0.82, r * 0.62],
      ]);
      ctx.fill();
      ctx.restore();
    }
  }

  // 尾巴（甩动 = 情绪/速度）
  const wag = Math.sin(t * 9 + m.phase) * r * 0.4;
  ctx.strokeStyle = s.flat ? '#FFFFFF' : light;
  ctx.lineCap = 'round';
  ctx.lineWidth = 3.4;
  ctx.beginPath();
  ctx.moveTo(0, r * 0.45);
  ctx.quadraticCurveTo(r * 0.55 + wag * 0.3, r * 0.95, r * 0.95 + wag, r * 1.35);
  ctx.stroke();
  if (deco) {
    ctx.strokeStyle = rgba(dark, 0.5);
    ctx.lineWidth = 1.4;
    ctx.stroke();
  }

  // 身体：尖三角（朝前进方向 = -y），两侧腰线让它不像一块纸片
  ctx.beginPath();
  ctx.moveTo(0, -r * 1.12);
  ctx.quadraticCurveTo(-r * 0.36, -r * 0.42, -r * 0.86, r * 0.6);
  ctx.lineTo(-r * 0.4, r * 0.5);
  ctx.lineTo(0, r * 0.66);
  ctx.lineTo(r * 0.4, r * 0.5);
  ctx.lineTo(r * 0.86, r * 0.6);
  ctx.quadraticCurveTo(r * 0.36, -r * 0.42, 0, -r * 1.12);
  ctx.closePath();
  ctx.fillStyle = s.flat ? '#FFFFFF' : color;
  ctx.fill();
  // 双耳：尖角（敌方语言）——受击闪白也要覆盖，故不受 deco 门控
  for (const sx of [-1, 1]) {
    ptsPath(ctx, [
      [sx * r * 0.58, r * 0.16],
      [sx * r * 0.98, r * 0.92],
      [sx * r * 0.18, r * 0.52],
    ]);
    ctx.fillStyle = s.flat ? '#FFFFFF' : color;
    ctx.fill();
    if (deco) {
      inkStroke(ctx, 1.2);
      // 耳内受光（避免小三角形被墨线吃掉变成"棕色块"）
      ctx.fillStyle = rgba(lighten(color, 0.25), 0.55);
      ctx.beginPath();
      ctx.moveTo(sx * r * 0.58, r * 0.3);
      ctx.lineTo(sx * r * 0.82, r * 0.8);
      ctx.lineTo(sx * r * 0.34, r * 0.52);
      ctx.closePath();
      ctx.fill();
    }
  }
  if (deco) {
    inkStroke(ctx, 2.3);
    // 背脊受光线
    ctx.strokeStyle = rgba(light, 0.5);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, -r * 0.9);
    ctx.lineTo(0, r * 0.42);
    ctx.stroke();
    // 眼睛：倾斜的白色眼缝 + 冲锋时转红（前摇预警）
    const eyeColor = rushing ? '#FF3D71' : '#F5F5FA';
    const eyeGlow = rushing ? 0.9 : 0.35;
    for (const sx of [-1, 1]) {
      ctx.save();
      ctx.translate(sx * r * 0.3, -r * 0.34);
      ctx.rotate(sx * 0.5);
      ctx.fillStyle = eyeColor;
      ctx.beginPath();
      ctx.ellipse(0, 0, r * 0.17, r * 0.075, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      if (rushing) drawGlow(ctx, sx * r * 0.3, -r * 0.34, r * 0.5, '#FF3D71', eyeGlow);
    }
  }

  // 前摇：脚下蓄力圈（信息型表现：马上要冲了）
  if (winding && deco) {
    const k = cyc / 0.4;
    ctx.strokeStyle = rgba('#FF3D71', 0.35 + 0.3 * Math.sin(t * 30));
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(0, r * 0.75, r * (1.15 - k * 0.25), r * 0.3, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
}

// ---------- 冲锋鼠：极致速度感 ----------
function drawCharger(ctx: CanvasRenderingContext2D, m: MonsterRuntime, t: number, s: Skin): void {
  const { r, color, light, deco } = s;
  const moving = m.state === 'march';

  if (moving && deco) {
    // 速度线：身后三层渐隐细线（比残影更"物理"）
    for (let i = 0; i < 3; i++) {
      const len = r * (1.6 + i * 0.7);
      const xo = (i - 1) * r * 0.28;
      ctx.strokeStyle = rgba(light, 0.34 - i * 0.08);
      ctx.lineWidth = 2 - i * 0.4;
      ctx.beginPath();
      ctx.moveTo(xo, r + 4);
      ctx.lineTo(xo, r + 4 + len);
      ctx.stroke();
    }
    for (let i = 3; i >= 1; i--) {
      const k = 1 - i / 4;
      ctx.fillStyle = rgba(color, 0.2 * k);
      ptsPath(ctx, [
        [0, -r * 1.35 * (1 - i * 0.08)],
        [-r * 0.42, r * (0.9 + i * 0.75)],
        [r * 0.42, r * (0.9 + i * 0.75)],
      ]);
      ctx.fill();
    }
  }

  // 本体：细长梭形 + 后掠鳍（空气动力学语言）
  ptsPath(ctx, [
    [0, -r * 1.5],
    [r * 0.46, r * 0.18],
    [r * 0.16, r * 0.5],
    [r * 0.72, r * 1.0],
    [0, r * 0.72],
    [-r * 0.72, r * 1.0],
    [-r * 0.16, r * 0.5],
    [-r * 0.46, r * 0.18],
  ]);
  ctx.fillStyle = s.flat ? '#FFFFFF' : color;
  ctx.fill();
  if (deco) {
    inkStroke(ctx, 2.2);
    // 尖端高光 + 驾驶舱式眼点
    ctx.fillStyle = rgba(light, 0.8);
    ptsPath(ctx, [
      [0, -r * 1.42],
      [-r * 0.14, -r * 0.62],
      [r * 0.14, -r * 0.62],
    ]);
    ctx.fill();
    ctx.fillStyle = INK;
    ctx.beginPath();
    ctx.ellipse(0, -r * 0.16, r * 0.13, r * 0.22, 0, 0, Math.PI * 2);
    ctx.fill();
    drawGlow(ctx, 0, -r * 1.2, r * 0.85, light, 0.28);
  }
}

// ---------- 投矛手 / 投石车 ----------
function drawThrower(ctx: CanvasRenderingContext2D, m: MonsterRuntime, t: number, s: Skin): void {
  const { r, color, light, dark, deco } = s;
  const heavy = r >= 24; // 同族重装变体（投石车）：平台 + 抛臂
  const assault = m.state === 'assault';
  const interval = Math.max(0.001, m.cfg.attackInterval);
  const wind = assault ? Math.min(1, 1 - m.attackTimer / interval) : 0;
  // 攻击前摇：后仰蓄力（sin 曲线，出手瞬间回到 0）
  const pull = assault ? Math.sin(Math.min(1, wind) * Math.PI) : 0;
  ctx.translate(0, walkBob(m, t, 5, 0.05));

  if (heavy) {
    // 底座轮式平台
    rrPath(ctx, -r * 0.85, -r * 0.75, r * 1.7, r * 0.5, r * 0.18);
    ctx.fillStyle = s.flat ? '#FFFFFF' : darken(color, 0.35);
    ctx.fill();
    if (deco) inkStroke(ctx, 2);
    for (const sx of [-0.55, 0.55]) {
      ctx.beginPath();
      ctx.arc(sx * r, -r * 0.72, r * 0.26, 0, Math.PI * 2);
      ctx.fillStyle = s.flat ? '#FFFFFF' : lighten(color, 0.15);
      ctx.fill();
      if (deco) {
        inkStroke(ctx, 1.8);
        ctx.strokeStyle = rgba(INK, 0.5);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(sx * r - r * 0.14, -r * 0.72);
        ctx.lineTo(sx * r + r * 0.14, -r * 0.72);
        ctx.stroke();
      }
    }
    // 抛臂 + 石弹
    ctx.save();
    ctx.translate(-r * 0.55, -r * 0.2);
    ctx.rotate(-0.5 - pull * 0.8);
    rrPath(ctx, 0, -r * 0.12, r * 1.5, r * 0.24, r * 0.1);
    ctx.fillStyle = s.flat ? '#FFFFFF' : color;
    ctx.fill();
    if (deco) inkStroke(ctx, 1.8);
    ctx.beginPath();
    ctx.arc(r * 1.55, -r * 0.02, r * 0.2, 0, Math.PI * 2);
    ctx.fillStyle = s.flat ? '#FFFFFF' : light;
    ctx.fill();
    if (deco) inkStroke(ctx, 1.5);
    ctx.restore();
    // 车体
    rrPath(ctx, -r * 0.55, -r * 0.5, r * 1.1, r * 1.15, r * 0.2);
    ctx.fillStyle = s.flat ? '#FFFFFF' : color;
    ctx.fill();
    if (deco) {
      inkStroke(ctx, 2.2);
      ctx.fillStyle = rgba('#FFD54F', 0.85);
      ctx.beginPath();
      ctx.arc(0, r * 0.16, r * 0.13, 0, Math.PI * 2);
      ctx.fill();
      drawGlow(ctx, 0, r * 0.16, r * 0.5, '#FFD54F', 0.3);
    }
    return;
  }

  // 长矛：随攻击前摇后仰，出手后回正（投矛动画）
  ctx.save();
  ctx.translate(r * 0.42, -r * 0.1);
  ctx.rotate(-0.22 + pull * 0.9);
  ctx.strokeStyle = s.flat ? '#FFFFFF' : light;
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(0, -r * 1.25);
  ctx.lineTo(0, r * 0.85);
  ctx.stroke();
  if (deco) {
    ctx.fillStyle = '#F5F5FA';
    ptsPath(ctx, [
      [0, -r * 1.55],
      [-r * 0.12, -r * 1.15],
      [r * 0.12, -r * 1.15],
    ]);
    ctx.fill();
    inkStroke(ctx, 1.2);
    ctx.strokeStyle = rgba(INK, 0.6);
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(-r * 0.1, r * 0.7);
    ctx.lineTo(0, r * 0.9);
    ctx.lineTo(r * 0.1, r * 0.7);
    ctx.stroke();
  }
  ctx.restore();

  // 身体：梯形 + 兜帽尖（哥布林语言：窄肩、尖顶）
  ptsPath(ctx, [
    [-r * 0.72, r * 0.82],
    [-r * 0.5, -r * 0.25],
    [0, -r * 0.78],
    [r * 0.5, -r * 0.25],
    [r * 0.72, r * 0.82],
  ]);
  ctx.fillStyle = s.flat ? '#FFFFFF' : color;
  ctx.fill();
  if (deco) {
    inkStroke(ctx, 2.2);
    // 兜帽：更亮的一层尖顶
    ctx.fillStyle = rgba(light, 0.5);
    ptsPath(ctx, [
      [-r * 0.5, r * 0.05],
      [0, -r * 0.8],
      [r * 0.5, r * 0.05],
    ]);
    ctx.fill();
    // 腰带
    ctx.strokeStyle = rgba(INK, 0.45);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-r * 0.62, r * 0.42);
    ctx.lineTo(r * 0.66, r * 0.42);
    ctx.stroke();
    // 双眼（瞄准状态变红）
    const eye = assault && wind > 0.55 ? '#FF3D71' : '#FFD54F';
    ctx.fillStyle = eye;
    for (const sx of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(sx * r * 0.22, -r * 0.34, r * 0.085, 0, Math.PI * 2);
      ctx.fill();
    }
    if (assault) drawGlow(ctx, 0, -r * 0.34, r * 0.6, eye, 0.25);
  }
}

// ---------- 岩甲兽 / 岩甲魔王：六边形重甲 ----------
function drawBulwark(ctx: CanvasRenderingContext2D, m: MonsterRuntime, t: number, s: Skin): void {
  const { r, color, light, dark, deco } = s;
  const heavy = s.tier > 0;
  ctx.translate(0, walkBob(m, t, 4.5, 0.045));

  // 腿：两根短粗梯形，交替迈步（重量感）
  for (const sx of [-1, 1]) {
    const step = Math.sin(t * 4.2 + m.phase + (sx > 0 ? Math.PI : 0)) * r * 0.16;
    ptsPath(ctx, [
      [sx * r * 0.28, -r * 0.5],
      [sx * r * 0.62, -r * 0.5],
      [sx * r * 0.66, -r * 0.95 + step],
      [sx * r * 0.34, -r * 0.95 + step],
    ]);
    ctx.fillStyle = s.flat ? '#FFFFFF' : darken(color, 0.25);
    ctx.fill();
    if (deco) inkStroke(ctx, 1.8);
  }

  // 主体六边形（尖角 = 敌方）
  polyPath(ctx, 6, r, Math.PI / 6);
  ctx.fillStyle = s.flat ? '#FFFFFF' : color;
  ctx.fill();
  // 重装尖冠：闪白重描时也要有，保证"全覆盖"
  if (s.flat && heavy) {
    for (let i = -1; i <= 1; i++) {
      ptsPath(ctx, [
        [i * r * 0.34 - r * 0.1, r * 0.86],
        [i * r * 0.34, r * 1.2],
        [i * r * 0.34 + r * 0.1, r * 0.86],
      ]);
      ctx.fillStyle = '#FFFFFF';
      ctx.fill();
    }
  }
  if (deco) {
    inkStroke(ctx, 2.4);
    // 内甲片：两层同心六边形 + 板缝
    polyPath(ctx, 6, r * 0.7, Math.PI / 6);
    ctx.strokeStyle = rgba(INK, 0.45);
    ctx.lineWidth = 2;
    ctx.stroke();
    polyPath(ctx, 6, r * 0.42, Math.PI / 6);
    ctx.fillStyle = rgba(dark, 0.35);
    ctx.fill();
    // 铆钉
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 3) * i + Math.PI / 6;
      ctx.fillStyle = rgba(light, 0.65);
      ctx.beginPath();
      ctx.arc(Math.cos(a) * r * 0.82, Math.sin(a) * r * 0.82, r * 0.07, 0, Math.PI * 2);
      ctx.fill();
    }
    // 受光面
    ctx.fillStyle = rgba(light, 0.16);
    polyPath(ctx, 6, r * 0.62, Math.PI / 6);
    ctx.save();
    ctx.translate(0, r * 0.16);
    ctx.fill();
    ctx.restore();
    // 正面护盾弧（朝向城墙）：护甲层数越高越亮
    const shieldK = m.shieldLeft > 0 ? 1 : 0.35;
    ctx.strokeStyle = rgba(light, 0.4 + 0.4 * shieldK);
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(0, 0, r * 1.02, Math.PI * 1.18, Math.PI * 1.82);
    ctx.stroke();
    if (m.shieldLeft > 0) {
      ctx.strokeStyle = rgba('#F5F5FA', 0.5 + 0.3 * Math.sin(t * 6));
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(0, 0, r * 1.12, Math.PI * 1.22, Math.PI * 1.78);
      ctx.stroke();
    }
    // 精英：双层描边脉冲 + 顶部尖冠
    if (heavy) {
      polyPath(ctx, 6, r * (1.14 + 0.02 * Math.sin(t * 3 + m.phase)), Math.PI / 6);
      ctx.strokeStyle = rgba(light, 0.22 + 0.18 * Math.sin(t * 3 + m.phase));
      ctx.lineWidth = 2.4;
      ctx.stroke();
      for (let i = -1; i <= 1; i++) {
        ptsPath(ctx, [
          [i * r * 0.34 - r * 0.1, r * 0.86],
          [i * r * 0.34, r * 1.2],
          [i * r * 0.34 + r * 0.1, r * 0.86],
        ]);
        ctx.fillStyle = light;
        ctx.fill();
        inkStroke(ctx, 1.4);
      }
    }
  }
}

// ---------- 夜行蝙蝠：双对三角 + 扑翼 ----------
function drawBat(ctx: CanvasRenderingContext2D, m: MonsterRuntime, t: number, s: Skin): void {
  const { r, color, light, deco } = s;
  const flap = Math.sin(t * 13 + m.phase);
  const bob = Math.sin(t * 4 + m.phase) * r * 0.18;
  ctx.translate(0, r * 0.9 + bob);

  for (const sx of [-1, 1]) {
    ctx.save();
    ctx.scale(sx, 1);
    ctx.rotate(flap * 0.5);
    // 双对三角翼：带缺口的翼缘（蝙蝠翼的关键剪影，比三角形更像生物）
    ptsPath(ctx, [
      [0, 0],
      [r * 1.02, r * 0.28],
      [r * 1.5, r * 0.52],
      [r * 1.16, r * 0.1],
      [r * 0.88, r * 0.18],
      [r * 0.42, -r * 0.2],
    ]);
    ctx.fillStyle = s.flat ? '#FFFFFF' : color;
    ctx.fill();
    if (deco) {
      inkStroke(ctx, 1.9);
      ptsPath(ctx, [
        [r * 0.9, r * 0.02],
        [r * 1.72, r * 0.18],
        [r * 1.32, r * 0.72],
      ]);
      ctx.fillStyle = rgba(light, 0.9);
      ctx.fill();
      inkStroke(ctx, 1.4);
      // 翼骨
      ctx.strokeStyle = rgba(INK, 0.35);
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(r * 1.42, r * 0.4);
      ctx.moveTo(0, 0);
      ctx.lineTo(r * 1.0, -r * 0.36);
      ctx.stroke();
    }
    ctx.restore();
  }

  // 身体：小菱形 + 眼睛
  ptsPath(ctx, [
    [0, -r * 0.6],
    [r * 0.34, 0],
    [0, r * 0.55],
    [-r * 0.34, 0],
  ]);
  ctx.fillStyle = s.flat ? '#FFFFFF' : darken(color, 0.4);
  ctx.fill();
  if (deco) {
    inkStroke(ctx, 1.9);
    ctx.fillStyle = '#FF3D71';
    for (const sx of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(sx * r * 0.12, -r * 0.16, r * 0.075, 0, Math.PI * 2);
      ctx.fill();
    }
    drawGlow(ctx, 0, -r * 0.16, r * 0.5, '#FF3D71', 0.35);
  }
}

// ---------- 分裂菇：三叠圆 + 孢子 ----------
function drawShroom(ctx: CanvasRenderingContext2D, m: MonsterRuntime, t: number, s: Skin): void {
  const { r, color, light, dark, deco } = s;
  const wob = Math.sin(t * 2.6 + m.phase) * 0.07;
  ctx.translate(0, walkBob(m, t, 3.6, 0.05));
  ctx.rotate(wob);

  // 柄（圆角方块：稳定、可亲）
  rrPath(ctx, -r * 0.34, -r * 0.92, r * 0.68, r * 1.02, r * 0.22);
  ctx.fillStyle = s.flat ? '#FFFFFF' : darken(lighten(color, 0.22), 0.06);
  ctx.fill();
  if (deco) inkStroke(ctx, 1.9);

  // 伞盖：半圆 + 微垂边沿
  ctx.beginPath();
  ctx.moveTo(-r * 1.02, r * 0.12);
  ctx.quadraticCurveTo(-r * 0.96, r * 1.05, 0, r * 1.05);
  ctx.quadraticCurveTo(r * 0.96, r * 1.05, r * 1.02, r * 0.12);
  ctx.quadraticCurveTo(0, r * 0.34, -r * 1.02, r * 0.12);
  ctx.closePath();
  ctx.fillStyle = s.flat ? '#FFFFFF' : color;
  ctx.fill();
  if (deco) {
    inkStroke(ctx, 2.3);
    // 菌盖顶部反光（球面弧线）
    ctx.strokeStyle = rgba('#FFFFFF', 0.4);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, r * 0.12, r * 0.78, Math.PI * 1.12, Math.PI * 1.88);
    ctx.stroke();
    // 菌盖斑点（3 个，大小错落）
    for (const [px, py, pr] of [
      [-r * 0.36, r * 0.62, r * 0.17],
      [r * 0.28, r * 0.74, r * 0.13],
      [r * 0.6, r * 0.42, r * 0.1],
    ]) {
      ctx.fillStyle = rgba('#F5F5FA', 0.5);
      ctx.beginPath();
      ctx.arc(px, py, pr, 0, Math.PI * 2);
      ctx.fill();
    }
    // 菌褶
    ctx.strokeStyle = rgba(INK, 0.3);
    ctx.lineWidth = 1.4;
    for (let i = 1; i <= 4; i++) {
      const x = -r * 0.9 + (r * 1.8 * i) / 5;
      ctx.beginPath();
      ctx.moveTo(x, r * 0.2);
      ctx.lineTo(x * 0.9, -r * 0.02);
      ctx.stroke();
    }
    // 孢子：缓慢上浮循环
    for (let i = 0; i < 4; i++) {
      const k = (t * 0.22 + i * 0.27) % 1;
      const sx = Math.sin(t * 0.8 + i * 2.1) * r * 0.7;
      ctx.fillStyle = rgba(light, (1 - k) * 0.55);
      ctx.beginPath();
      ctx.arc(sx, r * 1.15 + k * r * 1.5, 1.8 + (1 - k) * 1.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

// ---------- 地精巫师：菱形法袍 + 悬浮法球 ----------
function drawShaman(ctx: CanvasRenderingContext2D, m: MonsterRuntime, t: number, s: Skin): void {
  const { r, color, light, dark, deco } = s;
  const bob = Math.sin(t * 2.4 + m.phase) * r * 0.05;
  ctx.translate(0, bob);

  // 法袍：菱形（辅助/施法者的"图腾"语言，与英雄的圆角形成对比但仍属友方语义）
  ctx.beginPath();
  ctx.moveTo(0, -r * 1.15);
  ctx.quadraticCurveTo(r * 0.55, -r * 0.5, r * 0.82, r * 0.1);
  ctx.quadraticCurveTo(r * 0.7, r * 0.9, 0, r * 1.02);
  ctx.quadraticCurveTo(-r * 0.7, r * 0.9, -r * 0.82, r * 0.1);
  ctx.quadraticCurveTo(-r * 0.55, -r * 0.5, 0, -r * 1.15);
  ctx.closePath();
  ctx.fillStyle = s.flat ? '#FFFFFF' : color;
  ctx.fill();
  if (deco) {
    inkStroke(ctx, 2.3);
    // 兜帽内里（深色，形成"脸"的负空间）
    ctx.fillStyle = rgba(INK, 0.55);
    ctx.beginPath();
    ctx.ellipse(0, -r * 0.42, r * 0.3, r * 0.38, 0, 0, Math.PI * 2);
    ctx.fill();
    // 双眼
    ctx.fillStyle = '#F5F5FA';
    for (const sx of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(sx * r * 0.12, -r * 0.42, r * 0.06, 0, Math.PI * 2);
      ctx.fill();
    }
    // 腰带 + 胸口符文
    ctx.strokeStyle = rgba(light, 0.7);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-r * 0.6, r * 0.24);
    ctx.lineTo(r * 0.6, r * 0.24);
    ctx.stroke();
    ptsPath(ctx, [
      [0, r * 0.5],
      [r * 0.14, r * 0.68],
      [0, r * 0.86],
      [-r * 0.14, r * 0.68],
    ]);
    ctx.fillStyle = rgba('#B388FF', 0.9);
    ctx.fill();
    drawGlow(ctx, 0, r * 0.68, r * 0.5, '#B388FF', 0.4);
    // 暗部
    ctx.fillStyle = rgba(dark, 0.3);
    ctx.beginPath();
    ctx.ellipse(0, r * 0.92, r * 0.5, r * 0.12, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // 法杖 + 法球（法球呼吸浮动，是"施法者"的身份符号）
  const orbBob = Math.sin(t * 3 + m.phase) * 4;
  ctx.strokeStyle = s.flat ? '#FFFFFF' : darken(light, 0.1);
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(r * 0.86, r * 0.9);
  ctx.lineTo(r * 0.86, -r * 0.95 + orbBob);
  ctx.stroke();
  if (deco) {
    ctx.beginPath();
    ctx.arc(r * 0.86, -r * 1.08 + orbBob, r * 0.17, 0, Math.PI * 2);
    ctx.fillStyle = '#E9D5FF';
    ctx.fill();
    inkStroke(ctx, 1.4);
    drawGlow(ctx, r * 0.86, -r * 1.08 + orbBob, r * 0.75, '#B388FF', 0.55);
    // 环绕符文（2 枚小菱形绕法球旋转）
    for (let i = 0; i < 2; i++) {
      const a = t * 1.8 + i * Math.PI;
      ptsPath(ctx, [
        [
          r * 0.86 + Math.cos(a) * r * 0.34,
          -r * 1.08 + orbBob + Math.sin(a) * r * 0.24,
        ],
        [
          r * 0.86 + Math.cos(a) * r * 0.34 + 2.4,
          -r * 1.08 + orbBob + Math.sin(a) * r * 0.24,
        ],
        [
          r * 0.86 + Math.cos(a) * r * 0.34,
          -r * 1.08 + orbBob + Math.sin(a) * r * 0.24 + 4,
        ],
      ]);
      ctx.fillStyle = rgba('#B388FF', 0.7);
      ctx.fill();
    }
  }
}

// ---------- 虫族：幼虫 / 爬虫 / 潜伏者 / 虫后 / 毒爆虫 / 雷兽 ----------
function drawLarva(ctx: CanvasRenderingContext2D, m: MonsterRuntime, t: number, s: Skin): void {
  const { r, color, light, dark, deco } = s;
  const wig = Math.sin(t * 8 + m.phase) * 0.12;
  ctx.rotate(wig);
  // 三段体节（小体型也能看出"虫"）
  for (let i = 0; i < 3; i++) {
    const seg = 1 - i * 0.22;
    ctx.beginPath();
    ctx.ellipse(0, (i - 1) * r * 0.5, r * 0.62 * seg, r * 0.52 * seg, 0, 0, Math.PI * 2);
    ctx.fillStyle = s.flat ? '#FFFFFF' : i === 0 ? lighten(color, 0.15) : color;
    ctx.fill();
    if (deco) {
      ctx.strokeStyle = rgba(dark, 0.65);
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }
  }
  if (deco) {
    // 触角 + 眼点
    ctx.strokeStyle = rgba(light, 0.9);
    ctx.lineWidth = 1.2;
    for (const sx of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(sx * r * 0.3, -r * 0.75);
      ctx.quadraticCurveTo(sx * r * 0.7, -r * 1.1, sx * r * 0.55, -r * 1.45);
      ctx.stroke();
    }
    for (const sx of [-1, 1]) {
      ctx.fillStyle = INK;
      ctx.beginPath();
      ctx.arc(sx * r * 0.2, -r * 0.6, r * 0.1, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = rgba(light, 0.3);
    ctx.beginPath();
    ctx.ellipse(-r * 0.2, r * 0.1, r * 0.22, r * 0.12, -0.4, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawRoach(ctx: CanvasRenderingContext2D, m: MonsterRuntime, t: number, s: Skin): void {
  const { r, color, light, dark, deco } = s;
  ctx.translate(0, walkBob(m, t, 10, 0.03));
  // 六足：交替摆动
  if (deco) {
    ctx.strokeStyle = rgba(dark, 0.9);
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    for (let i = 0; i < 3; i++) {
      for (const sx of [-1, 1]) {
        const y = (i - 1) * r * 0.42;
        const step = Math.sin(t * 10 + i * 1.4 + (sx > 0 ? Math.PI : 0)) * r * 0.16;
        ctx.beginPath();
        ctx.moveTo(sx * r * 0.5, y);
        ctx.lineTo(sx * (r * 0.95 + step), y + r * 0.3);
        ctx.stroke();
      }
    }
  }
  // 甲壳：扁椭圆 + 3 道体节弧
  ctx.beginPath();
  ctx.ellipse(0, 0, r, r * 0.74, 0, 0, Math.PI * 2);
  ctx.fillStyle = s.flat ? '#FFFFFF' : color;
  ctx.fill();
  if (deco) {
    inkStroke(ctx, 2.2);
    // 甲壳顶部反光弧
    ctx.strokeStyle = rgba('#FFFFFF', 0.3);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(0, 0, r * 0.86, r * 0.62, 0, Math.PI * 1.15, Math.PI * 1.85);
    ctx.stroke();
    ctx.strokeStyle = rgba(dark, 0.7);
    ctx.lineWidth = 1.8;
    for (let i = -1; i <= 1; i++) {
      ctx.beginPath();
      ctx.ellipse(0, i * r * 0.3, r * (0.86 - Math.abs(i) * 0.14), r * 0.5, 0, Math.PI * 0.08, Math.PI * 0.92);
      ctx.stroke();
    }
    // 头部 + 复眼
    ctx.beginPath();
    ctx.ellipse(0, -r * 0.62, r * 0.32, r * 0.24, 0, 0, Math.PI * 2);
    ctx.fillStyle = darken(color, 0.2);
    ctx.fill();
    inkStroke(ctx, 1.6);
    for (const sx of [-1, 1]) {
      ctx.fillStyle = '#FFD54F';
      ctx.beginPath();
      ctx.arc(sx * r * 0.13, -r * 0.64, r * 0.06, 0, Math.PI * 2);
      ctx.fill();
    }
    // 受光
    ctx.fillStyle = rgba(light, 0.22);
    ctx.beginPath();
    ctx.ellipse(-r * 0.24, r * 0.18, r * 0.44, r * 0.24, -0.3, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawLurker(ctx: CanvasRenderingContext2D, m: MonsterRuntime, t: number, s: Skin): void {
  const { r, color, light, dark, deco } = s;
  // 刀锋尖刺（竖立），底部有土包
  ctx.fillStyle = s.flat ? '#FFFFFF' : darken(color, 0.45);
  ctx.beginPath();
  ctx.ellipse(0, r * 0.75, r * 0.95, r * 0.32, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(0, r * 1.35);
  ctx.lineTo(-r * 0.42, r * 0.5);
  ctx.lineTo(-r * 0.2, r * 0.58);
  ctx.lineTo(-r * 0.42, -r * 0.25);
  ctx.lineTo(0, -r * 1.05);
  ctx.lineTo(r * 0.42, -r * 0.25);
  ctx.lineTo(r * 0.2, r * 0.58);
  ctx.lineTo(r * 0.42, r * 0.5);
  ctx.closePath();
  ctx.fillStyle = s.flat ? '#FFFFFF' : color;
  ctx.fill();
  if (deco) {
    inkStroke(ctx, 2.1);
    ctx.strokeStyle = rgba(light, 0.45);
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(0, -r * 0.9);
    ctx.lineTo(0, r * 0.75);
    ctx.stroke();
    // 刃口反光
    ctx.strokeStyle = rgba('#F5F5FA', 0.35);
    ctx.beginPath();
    ctx.moveTo(-r * 0.18, -r * 0.2);
    ctx.lineTo(-r * 0.28, r * 0.5);
    ctx.stroke();
  }
}

function drawZergQueen(ctx: CanvasRenderingContext2D, m: MonsterRuntime, t: number, s: Skin): void {
  const { r, color, light, dark, deco } = s;
  const aura = m.cfg.healAura;
  // 光环进度与真实治疗计时同步：环扩张到位的一刻正是治疗落下（信息型表现）
  if (aura && deco) {
    const total = Math.max(0.001, aura.interval);
    const k = Math.min(1, Math.max(0, 1 - m.healTimer / total));
    const eased = 1 - Math.pow(1 - k, 3);
    const ringR = r * 1.2 + (aura.radius - r * 1.2) * eased;

    // 领域底光（预渲染光晕精灵，比逐帧径向渐变便宜且更柔和）
    drawGroundShadow(ctx, 0, -r * 0.75, aura.radius * 0.9, aura.radius * 0.36, 0.35 * (0.6 + 0.4 * k));
    drawGlow(ctx, 0, -r * 0.7, aura.radius, '#7CB342', 0.05 + 0.07 * (1 - k));

    // 扩散环：越接近治疗越亮越细（蓄势感）
    ctx.strokeStyle = rgba('#7CB342', 0.18 + 0.4 * k);
    ctx.lineWidth = 2.4 - 1.4 * k;
    ctx.beginPath();
    ctx.ellipse(0, -r * 0.75, ringR, ringR * 0.42, 0, 0, Math.PI * 2);
    ctx.stroke();
    // 环上刻度：治疗范围可视化（不用乱猜半径）
    ctx.strokeStyle = rgba('#AEEA00', 0.2 + 0.3 * k);
    ctx.lineWidth = 1.4;
    for (let i = 0; i < 8; i++) {
      const a = (Math.PI * 2 * i) / 8 + t * 0.2;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * ringR * 0.94, -r * 0.75 + Math.sin(a) * ringR * 0.4);
      ctx.lineTo(Math.cos(a) * ringR, -r * 0.75 + Math.sin(a) * ringR * 0.42);
      ctx.stroke();
    }
    // 上升卵粒（带相位差循环）
    const n = Math.min(6, Math.max(3, Math.round(aura.radius / 60)));
    for (let i = 0; i < n; i++) {
      const a = (Math.PI * 2 * i) / n + t * 0.45 + m.phase;
      const rise = (t * 0.18 + i * 0.37) % 1;
      const rr2 = ringR * (0.35 + 0.62 * rise);
      const px = Math.cos(a) * rr2;
      const py = -r * 0.75 + Math.sin(a) * rr2 * 0.42 + rise * r * 1.4;
      ctx.fillStyle = rgba('#AEEA00', (1 - rise) * 0.55 * (0.35 + 0.65 * k));
      ctx.beginPath();
      ctx.arc(px, py, 2.4 - 1.0 * rise, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  const bob = Math.sin(t * 2 + m.phase) * r * 0.08;
  ctx.translate(0, bob);
  // 翅膀（半透明膜翼，缓慢扇动）
  for (const sx of [-1, 1]) {
    ctx.save();
    ctx.scale(sx, 1);
    ctx.rotate(Math.sin(t * 3 + m.phase) * 0.12);
    ptsPath(ctx, [
      [r * 0.2, r * 0.1],
      [r * 1.15, r * 0.55],
      [r * 0.95, -r * 0.35],
      [r * 0.3, -r * 0.2],
    ]);
    ctx.fillStyle = s.flat ? '#FFFFFF' : rgba(light, 0.18);
    ctx.fill();
    if (deco) {
      ctx.strokeStyle = rgba(light, 0.4);
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(r * 0.25, r * 0.05);
      ctx.lineTo(r * 1.05, r * 0.45);
      ctx.moveTo(r * 0.25, r * 0.05);
      ctx.lineTo(r * 0.9, -r * 0.28);
      ctx.stroke();
    }
    ctx.restore();
  }

  // 本体：六角腹 + 卵囊
  polyPath(ctx, 6, r * 0.82, Math.PI / 6);
  ctx.fillStyle = s.flat ? '#FFFFFF' : color;
  ctx.fill();
  if (deco) {
    inkStroke(ctx, 2.3);
    ctx.beginPath();
    ctx.ellipse(0, r * 0.34, r * 0.52, r * 0.44, 0, 0, Math.PI * 2);
    ctx.fillStyle = rgba(dark, 0.3);
    ctx.fill();
    for (let i = 0; i < 3; i++) {
      ctx.fillStyle = rgba('#AEEA00', 0.55);
      ctx.beginPath();
      ctx.arc(Math.sin(i * 2.2) * r * 0.2, r * 0.34 + (i - 1) * r * 0.18, r * 0.1, 0, Math.PI * 2);
      ctx.fill();
    }
    // 头部 + 冠刺 + 眼
    ctx.beginPath();
    ctx.ellipse(0, -r * 0.7, r * 0.34, r * 0.28, 0, 0, Math.PI * 2);
    ctx.fillStyle = darken(color, 0.25);
    ctx.fill();
    inkStroke(ctx, 1.6);
    for (let i = -1; i <= 1; i++) {
      ptsPath(ctx, [
        [i * r * 0.22 - r * 0.08, -r * 0.86],
        [i * r * 0.22, -r * 1.22],
        [i * r * 0.22 + r * 0.08, -r * 0.86],
      ]);
      ctx.fillStyle = light;
      ctx.fill();
      inkStroke(ctx, 1.2);
    }
    ctx.fillStyle = '#F5F5FA';
    for (const sx of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(sx * r * 0.13, -r * 0.72, r * 0.07, 0, Math.PI * 2);
      ctx.fill();
    }
    drawGlow(ctx, 0, -r * 0.72, r * 0.5, '#C77DFF', 0.3);
  }
}

function drawBaneling(ctx: CanvasRenderingContext2D, m: MonsterRuntime, t: number, s: Skin): void {
  const { r, color, light, dark, deco } = s;
  const hpK = Math.min(1, Math.max(0, 1 - m.hp / m.maxHp));
  const danger = m.state === 'assault' ? 1 : hpK;
  const rate = 4 + 10 * danger;
  const amp = 0.1 + 0.16 * danger;
  const pulseScale = 1 + amp * Math.sin(t * rate + m.phase);

  if (danger > 0.35 && deco) {
    // 危险度可视化：外圈警示光越亮越急促
    const warnK = (danger - 0.35) / 0.65;
    ctx.strokeStyle = rgba('#FF5A3C', (0.22 + 0.45 * warnK) * (0.6 + 0.4 * Math.sin(t * rate + m.phase)));
    ctx.lineWidth = 2 + 2 * warnK;
    ctx.beginPath();
    ctx.arc(0, 0, r * pulseScale + 4, 0, Math.PI * 2);
    ctx.stroke();
    drawGlow(ctx, 0, 0, r * 2.1, '#FF5A3C', 0.12 + 0.2 * warnK);
  }

  ctx.scale(pulseScale, pulseScale);
  // 腿
  if (deco) {
    ctx.strokeStyle = rgba(dark, 0.9);
    ctx.lineWidth = 2;
    for (let i = 0; i < 4; i++) {
      const a = Math.PI * 0.2 + (i * Math.PI * 0.6) / 3;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * r * 0.8, Math.sin(a) * r * 0.8);
      ctx.lineTo(Math.cos(a) * r * 1.18, Math.sin(a) * r * 1.18);
      ctx.stroke();
    }
  }
  // 囊体
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fillStyle = s.flat ? '#FFFFFF' : color;
  ctx.fill();
  if (deco) {
    inkStroke(ctx, 2.3);
    // 内核（随危险度变亮变大）
    const coreK = 0.4 + 0.6 * danger;
    ctx.fillStyle = rgba(mix('#FF5A3C', '#FFD54F', danger), 0.6 + 0.35 * danger);
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.45 * coreK, 0, Math.PI * 2);
    ctx.fill();
    drawGlow(ctx, 0, 0, r * 1.2, mix('#FF5A3C', '#FFD54F', danger), 0.25 + 0.35 * danger);
    // 膜上的裂纹：平时是暗绿脉络（让满血的它也不是一颗"纯色球"），
    // 越接近引爆越亮、越偏酸黄（临爆信号）。
    const veinColor = mix('#4E7A24', '#D8FF50', danger);
    ctx.strokeStyle = rgba(veinColor, 0.55 + 0.4 * danger);
    ctx.lineWidth = 1.6;
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI * 2 * i) / 6 + t * 0.8 + m.phase;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * r * 0.3, Math.sin(a) * r * 0.3);
      ctx.lineTo(Math.cos(a + 0.2) * r * 0.68, Math.sin(a + 0.2) * r * 0.68);
      ctx.lineTo(Math.cos(a) * r * 0.94, Math.sin(a) * r * 0.94);
      ctx.stroke();
    }
    // 膜瓣分隔线（常驻结构感）
    ctx.strokeStyle = rgba(dark, 0.45);
    ctx.lineWidth = 1.2;
    for (let i = 0; i < 4; i++) {
      const a = (Math.PI * 2 * i) / 4 + 0.4;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * r * 0.5, Math.sin(a) * r * 0.5);
      ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      ctx.stroke();
    }
    // 高光
    ctx.fillStyle = rgba('#FFFFFF', 0.34);
    ctx.beginPath();
    ctx.ellipse(-r * 0.34, r * 0.34, r * 0.24, r * 0.14, -0.6, 0, Math.PI * 2);
    ctx.fill();
    // 临爆高频闪白：最后阶段只属于真正要炸的瞬间
    if (danger > 0.75) {
      const finalK = (danger - 0.75) / 0.25;
      const f = Math.max(0, Math.sin(t * 26 + m.phase));
      ctx.fillStyle = rgba('#FFFFFF', 0.6 * finalK * f * f);
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawUltra(ctx: CanvasRenderingContext2D, m: MonsterRuntime, t: number, s: Skin): void {
  const { r, color, light, dark, deco } = s;
  const breatheK = 1 + 0.03 * Math.sin(t * 1.8 + m.phase);
  ctx.scale(breatheK, breatheK);
  ctx.translate(0, walkBob(m, t, 3.4, 0.03));

  // 外骨骼十角星（巨型单位：层数更多，边缘更硬）
  polyPath(ctx, 10, r * 1.12, Math.PI / 10, 0.78);
  ctx.fillStyle = s.flat ? '#FFFFFF' : color;
  ctx.fill();
  if (deco) {
    inkStroke(ctx, 2.8);
    polyPath(ctx, 10, r * 0.86, Math.PI / 10, 0.8);
    ctx.fillStyle = rgba(dark, 0.4);
    ctx.fill();
    // 甲片接缝
    ctx.strokeStyle = rgba(light, 0.28);
    ctx.lineWidth = 1.6;
    for (let i = 0; i < 5; i++) {
      const a = (Math.PI * 2 * i) / 5;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * r * 0.3, Math.sin(a) * r * 0.3);
      ctx.lineTo(Math.cos(a) * r * 1.02, Math.sin(a) * r * 1.02);
      ctx.stroke();
    }
    // 双角（朝上）+ 下颚
    for (const sx of [-1, 1]) {
      ptsPath(ctx, [
        [sx * r * 0.38, -r * 0.72],
        [sx * r * 0.66, -r * 1.42],
        [sx * r * 0.14, -r * 0.86],
      ]);
      ctx.fillStyle = light;
      ctx.fill();
      inkStroke(ctx, 1.6);
    }
    for (const sx of [-1, 1]) {
      ptsPath(ctx, [
        [sx * r * 0.3, r * 0.7],
        [sx * r * 0.46, r * 1.16],
        [sx * r * 0.12, r * 0.82],
      ]);
      ctx.fillStyle = light;
      ctx.fill();
      inkStroke(ctx, 1.4);
    }
    // 核心（酸性绿发光，随呼吸脉动）
    const coreP = 0.5 + 0.5 * Math.sin(t * 2.6 + m.phase);
    ctx.fillStyle = rgba('#D8FF50', 0.55 + 0.3 * coreP);
    polyPath(ctx, 6, r * 0.3, Math.PI / 6);
    ctx.fill();
    drawGlow(ctx, 0, 0, r * 1.1, '#AEEA00', 0.18 + 0.16 * coreP);
    // 精英双层描边脉冲
    polyPath(ctx, 10, r * (1.16 + 0.02 * Math.sin(t * 2.2)), Math.PI / 10, 0.78);
    ctx.strokeStyle = rgba(light, 0.2 + 0.16 * Math.sin(t * 2.2));
    ctx.lineWidth = 2.2;
    ctx.stroke();
  }
}

// ---------- Boss：腐化树人（多层三角嵌套 + 旋转外环） ----------
function drawBossTreant(ctx: CanvasRenderingContext2D, m: MonsterRuntime, t: number, s: Skin): void {
  const { r, color, light, dark, deco } = s;

  if (deco) {
    // 旋转外环：两段反向旋转的断环 + 4 枚菱形节点（Boss 身份，也是阶段感）
    for (let layer = 0; layer < 2; layer++) {
      const dir = layer === 0 ? 1 : -1;
      const rot = t * 0.35 * dir + layer * 0.4;
      const rad = r * (1.2 + layer * 0.16);
      ctx.strokeStyle = rgba(layer === 0 ? '#B537F2' : light, 0.35 + 0.15 * Math.sin(t * 2 + layer));
      ctx.lineWidth = layer === 0 ? 3 : 1.6;
      for (let i = 0; i < 4; i++) {
        const a0 = rot + (Math.PI / 2) * i;
        ctx.beginPath();
        ctx.arc(0, 0, rad, a0, a0 + 0.92);
        ctx.stroke();
      }
      for (let i = 0; i < 4; i++) {
        const a = rot + (Math.PI / 2) * i + 0.46;
        const px = Math.cos(a) * rad;
        const py = Math.sin(a) * rad;
        ptsPath(ctx, [
          [px, py - 5],
          [px + 4, py],
          [px, py + 5],
          [px - 4, py],
        ]);
        ctx.fillStyle = rgba(layer === 0 ? '#B537F2' : light, 0.8);
        ctx.fill();
      }
    }
  }

  // 根系（扎根感）
  ctx.strokeStyle = s.flat ? '#FFFFFF' : dark;
  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  for (let i = -1; i <= 1; i++) {
    ctx.beginPath();
    ctx.moveTo(0, r * 0.7);
    ctx.quadraticCurveTo(i * r * 0.5, r * 1.0, i * r * 0.9, r * 1.16);
    ctx.stroke();
  }

  // 树干
  ptsPath(ctx, [
    [-r * 0.32, r * 0.86],
    [-r * 0.24, -r * 0.1],
    [r * 0.24, -r * 0.1],
    [r * 0.32, r * 0.86],
  ]);
  ctx.fillStyle = s.flat ? '#FFFFFF' : darken(color, 0.55);
  ctx.fill();
  if (deco) inkStroke(ctx, 2.2);

  // 树冠：三层三角（下宽上窄）+ 摇摆
  const sway = Math.sin(t * 1.1 + m.phase) * 0.05;
  ctx.save();
  ctx.translate(0, r * 0.1);
  ctx.rotate(sway);
  const layers: Array<[number, number, number]> = [
    [r * 0.95, -r * 0.05, 1.02],
    [r * 0.74, -r * 0.52, 0.9],
    [r * 0.52, -r * 0.95, 0.78],
  ];
  for (let i = 0; i < layers.length; i++) {
    const [w, cy, h] = layers[i];
    ptsPath(ctx, [
      [-w, cy + r * 0.12],
      [0, cy - r * 0.86 * h],
      [w, cy + r * 0.12],
      [0, cy + r * 0.3],
    ]);
    ctx.fillStyle = s.flat ? '#FFFFFF' : i === 0 ? darken(color, 0.28) : i === 1 ? color : lighten(color, 0.14);
    ctx.fill();
    if (deco) {
      inkStroke(ctx, 2.2);
      // 叶脉/腐化纹：三角内的折线
      ctx.strokeStyle = rgba(INK, 0.35);
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(0, cy - r * 0.7 * h);
      ctx.lineTo(0, cy + r * 0.2);
      ctx.stroke();
    }
  }
  ctx.restore();

  if (deco) {
    // 核心眼：竖瞳（Boss 的"注视感"，一眼可辨的威胁中心）
    drawGlow(ctx, 0, r * 0.34, r * 0.7, '#B537F2', 0.45 + 0.15 * Math.sin(t * 3));
    ctx.fillStyle = '#B537F2';
    ctx.beginPath();
    ctx.ellipse(0, r * 0.34, r * 0.2, r * 0.26, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#0B0C1D';
    ctx.beginPath();
    ctx.ellipse(0, r * 0.34, r * 0.06, r * 0.2, 0, 0, Math.PI * 2);
    ctx.fill();
    // 全屏威压：脚下一圈常驻光环
    ctx.strokeStyle = rgba('#B537F2', 0.2 + 0.1 * Math.sin(t * 2));
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.ellipse(0, r * 0.95, r * 1.15, r * 0.34, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
}

// ---------- 钻地形态：土包 + 露出地表的部分 ----------
// 注意：本函数在「已平移到怪物坐标」的局部坐标系内绘制（原点 = 怪物中心）。
function drawBurrowed(
  ctx: CanvasRenderingContext2D,
  m: MonsterRuntime,
  t: number,
  base: string,
  tint: boolean,
): void {
  const r = m.cfg.radius;
  const color = tint ? '#FFFFFF' : base;
  const dark = tint ? '#FFFFFF' : darken(base, 0.5);

  // 土包：深色半圆 + 碎土（压扁贴地）
  ctx.fillStyle = tint ? '#FFFFFF' : rgba('#2A2F52', 0.92);
  ctx.beginPath();
  ctx.ellipse(0, -r * 0.4, r * 1.3, r * 0.44, 0, 0, Math.PI * 2);
  ctx.fill();
  if (!tint) {
    ctx.beginPath();
    ctx.ellipse(0, -r * 0.5, r * 1.12, r * 0.46, 0, Math.PI, Math.PI * 2);
    ctx.fillStyle = rgba('#3A4270', 0.95);
    ctx.fill();
    // 地面裂纹
    ctx.strokeStyle = rgba(dark, 0.7);
    ctx.lineWidth = 1.6;
    for (let i = 0; i < 4; i++) {
      const a = Math.PI * 0.15 + i * 0.62;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * r * 0.9, -r * 0.4 + Math.sin(a) * r * 0.4);
      ctx.lineTo(Math.cos(a) * r * 1.35, -r * 0.4 + Math.sin(a) * r * 0.55);
      ctx.stroke();
    }
  }

  // 露出地表的部分：潜伏者=刃尖，雷兽=背甲，其他=壳顶
  const shape = m.cfg.shape;
  if (shape === 'lurker') {
    const interval = Math.max(0.001, m.cfg.attackInterval);
    const wind = Math.min(1, Math.max(0, 1 - m.attackTimer / interval));
    const lift = Math.sin(Math.min(1, Math.max(0, wind)) * Math.PI);
    ctx.fillStyle = color;
    ptsPath(ctx, [
      [0, -r * 0.3],
      [-r * 0.26, -r * 0.4],
      [0, -r * 1.5 - lift * r * 0.5],
      [r * 0.26, -r * 0.4],
    ]);
    ctx.fill();
    if (!tint) {
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1.8;
      ctx.stroke();
      // 攻击预警：刃口发亮
      ctx.strokeStyle = rgba('#FFD54F', 0.35 + 0.55 * lift);
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(-r * 0.14, -r * 0.42);
      ctx.lineTo(0, -r * 1.42);
      ctx.stroke();
    }
  } else if (shape === 'ultra') {
    ctx.save();
    ctx.translate(0, -r * 0.4);
    polyPath(ctx, 6, r * 0.55, Math.PI / 6);
    ctx.fillStyle = color;
    ctx.fill();
    if (!tint) {
      ctx.strokeStyle = INK;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.restore();
  } else {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.ellipse(0, -r * 0.4, r * 0.6, r * 0.2, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  if (!tint) {
    // 地下"看得见打不到"的虚线身份提示（docs/08）
    ctx.strokeStyle = rgba(color, 0.55);
    ctx.setLineDash([5, 5]);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(0, -r * 0.3, r * 1.45, r * 0.62, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    // 呼吸的"打击无效"提示（淡蓝，避免与"危险红"混淆）
    const breatheA = 0.1 + 0.08 * Math.sin(t * 3 + m.phase);
    ctx.strokeStyle = rgba('#4FC3F7', breatheA);
    ctx.beginPath();
    ctx.ellipse(0, -r * 0.3, r * 1.6, r * 0.7, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
}

// ---------------- 英雄 ----------------

export interface HeroVisualOpts {
  /** 枪口朝向（弧度，游戏坐标）；默认正上方 */
  aim?: number;
  /** 开火后坐（像素） */
  recoil?: number;
  /** 移动前倾（弧度） */
  lean?: number;
}

/**
 * 主英雄：正三角机身 + 圆形核心 + 双圆角翼（docs/06），
 * 叠加呼吸浮动、移动前倾、射击后坐、渐变喷焰与瞄准炮塔。
 */
export function drawHero(
  ctx: CanvasRenderingContext2D,
  hero: HeroRuntime,
  t: number,
  opts: HeroVisualOpts = {},
): void {
  const color = '#35E0C3';
  const light = lighten(color, 0.4);
  const dark = darken(color, 0.45);
  const hover = Math.sin(t * 2.2) * 3;
  const lean = opts.lean ?? 0;
  const aim = opts.aim ?? Math.PI / 2;
  const recoil = Math.max(0, Math.min(6, opts.recoil ?? 0));

  // 玩家落影 + 脚下光环（可读性铁律 1：玩家永远是最亮、最有存在感的一层）
  drawGroundShadow(ctx, hero.x, hero.y - 24, 34, 12, 0.85);
  ctx.strokeStyle = rgba('#35E0C3', 0.16 + 0.06 * Math.sin(t * 2.2));
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.ellipse(hero.x, hero.y - 24, 30, 10.5, 0, 0, Math.PI * 2);
  ctx.stroke();

  ctx.save();
  ctx.translate(hero.x, hero.y + hover);
  ctx.scale(1.18, 1.18);

  // 引擎喷焰（在船体下方，y 向上坐标系里就是 -y；加色发光）
  const flameK = 0.75 + 0.25 * Math.sin(t * 34) * Math.sin(t * 7.3);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const sx of [-1, 1]) {
    const flick = 0.7 + 0.3 * Math.sin(t * 27 + sx);
    ctx.fillStyle = rgba('#5EE1FF', 0.55 * flick);
    ctx.beginPath();
    ctx.moveTo(sx * 9, -20);
    ctx.lineTo(sx * 5, -20 - 16 * flameK * flick);
    ctx.lineTo(sx * 13, -20 - 9 * flameK * flick);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = rgba('#FFFFFF', 0.5 * flick);
    ctx.beginPath();
    ctx.moveTo(sx * 8, -20);
    ctx.lineTo(sx * 8, -20 - 7 * flameK);
    ctx.lineTo(sx * 10, -20);
    ctx.closePath();
    ctx.fill();
  }
  drawGlow(ctx, 0, -26, 34, '#35E0C3', 0.5);
  ctx.restore();

  ctx.rotate(lean);

  // 双圆角翼（友方=圆角语言）：带受光边的高光条
  for (const sx of [-1, 1]) {
    rrPath(ctx, sx > 0 ? 8 : -34, -18, 26, 15, 6);
    ctx.fillStyle = dark;
    ctx.fill();
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2;
    ctx.stroke();
    // 翼面受光
    rrPath(ctx, sx > 0 ? 10 : -32, -16, 22, 6, 3);
    ctx.fillStyle = rgba(color, 0.5);
    ctx.fill();
    // 翼尖小灯
    ctx.fillStyle = '#5EE1FF';
    ctx.beginPath();
    ctx.arc(sx * 31, -11, 2.2, 0, Math.PI * 2);
    ctx.fill();
    drawGlow(ctx, sx * 31, -11, 8, '#5EE1FF', 0.7);
  }

  // 炮塔：跟随最近的怪物转动（纯表现），开火时后坐
  ctx.save();
  ctx.rotate(aim - Math.PI / 2);
  ctx.translate(0, -recoil);
  rrPath(ctx, -5, 2, 10, 30, 4);
  ctx.fillStyle = darken(color, 0.2);
  ctx.fill();
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.8;
  ctx.stroke();
  // 枪口环
  rrPath(ctx, -6.5, 27, 13, 6, 3);
  ctx.fillStyle = light;
  ctx.fill();
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.4;
  ctx.stroke();
  // 炮管高光
  ctx.fillStyle = rgba('#FFFFFF', 0.35);
  ctx.fillRect(-3.2, 6, 2, 20);
  if (recoil > 0.2) drawGlow(ctx, 0, 32, 26 * (recoil / 6) + 10, '#FFFFFF', 0.5 * (recoil / 6));
  ctx.restore();

  // 机身：正三角（圆角化，友方语言）+ 分层受光
  ctx.beginPath();
  ctx.moveTo(0, 34);
  ctx.quadraticCurveTo(9, 22, 17, -8);
  ctx.quadraticCurveTo(12, -20, 0, -20);
  ctx.quadraticCurveTo(-12, -20, -17, -8);
  ctx.quadraticCurveTo(-9, 22, 0, 34);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2.4;
  ctx.stroke();
  // 受光面（左半亮、右半暗：明确光源）
  ctx.beginPath();
  ctx.moveTo(0, 30);
  ctx.quadraticCurveTo(6, 20, 11, -6);
  ctx.quadraticCurveTo(6, -16, 0, -16);
  ctx.closePath();
  ctx.fillStyle = rgba(light, 0.45);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(0, 30);
  ctx.quadraticCurveTo(-6, 20, -11, -6);
  ctx.quadraticCurveTo(-6, -16, 0, -16);
  ctx.closePath();
  ctx.fillStyle = rgba(dark, 0.35);
  ctx.fill();
  // 面板线
  ctx.strokeStyle = rgba(INK, 0.35);
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(0, 24);
  ctx.lineTo(0, -14);
  ctx.stroke();

  // 圆形核心（呼吸脉动 + 加色辉光，是英雄最亮的点 → 可读性铁律：玩家最高亮度）
  const corePulse = 0.5 + 0.5 * Math.sin(t * 3);
  ctx.fillStyle = INK;
  ctx.beginPath();
  ctx.arc(0, 2, 8.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = lighten(color, 0.72);
  ctx.beginPath();
  ctx.arc(0, 2, 4.2 + corePulse * 1.2, 0, Math.PI * 2);
  ctx.fill();
  drawGlow(ctx, 0, 2, 26 + corePulse * 6, '#35E0C3', 0.5);
  // 机头识别灯
  ctx.fillStyle = '#FFFFFF';
  ctx.beginPath();
  ctx.arc(0, 28, 2, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

// ---------------- 投射物 ----------------

/**
 * 按武器绘制子弹（t = 秒）。
 * dot 光点+拖尾 / arrow 箭矢 / bomb 抛物弹 / gear 旋转 V 刃。
 * 统一规范：出生缩放在 renderer，80ms 拖尾渐隐在这里用物理尾迹近似。
 */
export function drawProjectile(
  ctx: CanvasRenderingContext2D,
  p: ProjectileRuntime,
  t: number,
  color: string,
): void {
  const shape = p.weapon.cfg.shape ?? 'dot';
  const dx = p.x - p.px;
  const dy = p.y - p.py;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const light = lighten(color, 0.55);

  switch (shape) {
    case 'arrow': {
      // 箭矢：渐变杆 + 三角箭头 + 尾羽 + 速度拖影
      ctx.strokeStyle = rgba(color, 0.22);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(p.x - ux * 62, p.y - uy * 62);
      ctx.lineTo(p.x - ux * 18, p.y - uy * 18);
      ctx.stroke();
      const shaft = 22;
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.6;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(p.x - ux * shaft, p.y - uy * shaft);
      ctx.lineTo(p.x + ux * 6, p.y + uy * 6);
      ctx.stroke();
      ctx.strokeStyle = rgba(light, 0.85);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(p.x - ux * shaft, p.y - uy * shaft);
      ctx.lineTo(p.x + ux * 4, p.y + uy * 4);
      ctx.stroke();
      // 尾羽（两片斜羽）
      const px = -uy;
      const py = ux;
      ctx.fillStyle = rgba(light, 0.9);
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(p.x - ux * shaft, p.y - uy * shaft);
        ctx.lineTo(
          p.x - ux * (shaft + 8) + px * 5 * s,
          p.y - uy * (shaft + 8) + py * 5 * s,
        );
        ctx.lineTo(p.x - ux * (shaft + 2), p.y - uy * (shaft + 2));
        ctx.closePath();
        ctx.fill();
      }
      // 箭头
      ctx.fillStyle = light;
      ctx.beginPath();
      ctx.moveTo(p.x + ux * 13, p.y + uy * 13);
      ctx.lineTo(p.x - ux * 2 + px * 4.5, p.y - uy * 2 + py * 4.5);
      ctx.lineTo(p.x - ux * 2 - px * 4.5, p.y - uy * 2 - py * 4.5);
      ctx.closePath();
      ctx.fill();
      drawGlow(ctx, p.x, p.y, 20, color, 0.35);
      break;
    }
    case 'bomb': {
      // 抛物线弹：地面投影 + 弹体 + 自旋 + 引线火花 + 空中拖尾
      const h = p.height;
      ctx.fillStyle = 'rgba(4,5,12,0.34)';
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, 10, 3.6, 0, 0, Math.PI * 2);
      ctx.fill();
      const by = p.y + h;
      // 空中残影（高度越高越淡）
      for (let i = 1; i <= 3; i++) {
        ctx.fillStyle = rgba(color, 0.12 * (4 - i));
        ctx.beginPath();
        ctx.arc(p.x - ux * i * 14, by - uy * i * 14, (p.radius + 3) * (1 - i * 0.12), 0, Math.PI * 2);
        ctx.fill();
      }
      const R = p.radius + 3;
      const rot = t * 4 + p.id;
      // 弹体（带自旋的高光）
      ctx.save();
      ctx.translate(p.x, by);
      ctx.rotate(rot);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(0, 0, R, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = INK;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = rgba(light, 0.5);
      ctx.beginPath();
      ctx.arc(-R * 0.32, -R * 0.32, R * 0.34, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = rgba(INK, 0.55);
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(0, 0, R * 0.62, 0.4, 2.6);
      ctx.stroke();
      ctx.restore();
      // 引线 + 火花（火花闪烁是"即将爆炸"的呼吸）
      const fuseSwing = Math.sin(t * 5 + p.id) * 3;
      ctx.strokeStyle = '#8A93B8';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(p.x + R * 0.7, by + R * 0.7);
      ctx.quadraticCurveTo(p.x + R * 0.9 + fuseSwing, by + R * 1.25, p.x + R * 0.7 + fuseSwing, by + R * 1.5);
      ctx.stroke();
      const sparkA = 0.6 + 0.4 * Math.sin(t * 22 + p.id);
      drawGlow(ctx, p.x + R * 0.7 + fuseSwing, by + R * 1.5, 10, '#FFD54F', sparkA);
      ctx.fillStyle = '#FFF3C4';
      ctx.beginPath();
      ctx.arc(p.x + R * 0.7 + fuseSwing, by + R * 1.5, 2.2, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'gear':
    case 'crescent': {
      // 齿轮圆盘（血滴子）：内环镂空 + 外齿 + 运动模糊弧 + 边缘高光
      const R = 17;
      const rot = t * 11 + p.id;
      ctx.save();
      ctx.translate(p.x, p.y);
      // 运动模糊：两道残弧（比整圈拖尾便宜且速度感更强）
      ctx.strokeStyle = rgba(color, 0.18);
      ctx.lineWidth = 3;
      for (let i = 0; i < 2; i++) {
        ctx.beginPath();
        ctx.arc(0, 0, R + i * 3, rot - 1.1 - i * 0.2, rot - 0.2);
        ctx.stroke();
      }
      ctx.rotate(rot);
      ctx.fillStyle = color;
      for (let i = 0; i < 8; i++) {
        ctx.save();
        ctx.rotate((Math.PI / 4) * i);
        ctx.fillRect(-2.6, -R - 5, 5.2, 7);
        ctx.restore();
      }
      ctx.beginPath();
      ctx.arc(0, 0, R, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = INK;
      ctx.lineWidth = 2;
      ctx.stroke();
      // 内环镂空 + 十字轮辐
      ctx.fillStyle = '#0B0C1D';
      ctx.beginPath();
      ctx.arc(0, 0, R * 0.45, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = color;
      for (let i = 0; i < 4; i++) {
        ctx.save();
        ctx.rotate((Math.PI / 2) * i);
        ctx.fillRect(-1.6, R * 0.4, 3.2, R * 0.32);
        ctx.restore();
      }
      // 刃口高光
      ctx.strokeStyle = rgba(light, 0.7);
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(0, 0, R - 1.2, -0.6, 0.9);
      ctx.stroke();
      ctx.restore();
      drawGlow(ctx, p.x, p.y, R * 2.2, color, 0.3);
      break;
    }
    case 'dot':
    default: {
      // 光弹：外辉光 + 芯线拖尾 + 白色弹芯（战场上最亮的一类，符合层级铁律）
      ctx.strokeStyle = rgba(color, 0.18);
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.moveTo(p.x - ux * 54, p.y - uy * 54);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      ctx.strokeStyle = rgba(color, 0.55);
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.moveTo(p.x - ux * 34, p.y - uy * 34);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      // 拖尾上的等距光点（弹道可读）
      for (let i = 1; i <= 3; i++) {
        const k = i / 4;
        ctx.fillStyle = rgba(color, 0.3 * (1 - k) + 0.08);
        ctx.beginPath();
        ctx.arc(p.x - ux * 30 * k, p.y - uy * 30 * k, p.radius * (1 - k * 0.55), 0, Math.PI * 2);
        ctx.fill();
      }
      drawGlow(ctx, p.x, p.y, p.radius * 4.6, color, 0.55);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = rgba('#FFFFFF', 0.9);
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.radius * 0.45, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
  }
}

/** 怪物远程弹：投矛=细长梭标，投石=带投影的抛石（警示橙）。 */
export function drawMonsterShot(ctx: CanvasRenderingContext2D, s: MonsterShot, t: number): void {
  const color = '#FFB357';
  if (s.kind === 'rock') {
    const by = s.y + s.height;
    ctx.fillStyle = 'rgba(4,5,12,0.3)';
    ctx.beginPath();
    ctx.ellipse(s.x, s.ty, 11, 4.2, 0, 0, Math.PI * 2);
    ctx.fill();
    // 抛石：不规则多边形（旋转） + 受光面
    const R = 9;
    const rot = t * 5 + s.tx * 0.01;
    ptsPath(ctx, Array.from({ length: 7 }, (_, i) => {
      const a = (Math.PI * 2 * i) / 7 + rot;
      const rr = R * (0.82 + 0.22 * hash01(i * 3.7 + s.sx * 0.13));
      return [s.x + Math.cos(a) * rr, by + Math.sin(a) * rr];
    }));
    ctx.fillStyle = darken(color, 0.25);
    ctx.fill();
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1.8;
    ctx.stroke();
    ctx.fillStyle = rgba(lighten(color, 0.45), 0.55);
    ctx.beginPath();
    ctx.arc(s.x - 3, by + 3, 3, 0, Math.PI * 2);
    ctx.fill();
    drawGlow(ctx, s.x, by, 22, color, 0.22);
  } else {
    const dx = s.tx - s.sx;
    const dy = s.ty - s.sy;
    const l = Math.hypot(dx, dy) || 1;
    const ux = dx / l;
    const uy = dy / l;
    const by = s.y + s.height;
    // 矛：尾焰拖影 + 杆 + 箭头
    ctx.strokeStyle = rgba(color, 0.2);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(s.x - ux * 44, by - uy * 44);
    ctx.lineTo(s.x - ux * 18, by - uy * 18);
    ctx.stroke();
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(s.x - ux * 16, by - uy * 16);
    ctx.lineTo(s.x + ux * 6, by + uy * 6);
    ctx.stroke();
    ctx.fillStyle = '#F5F5FA';
    const px = -uy;
    const py = ux;
    ctx.beginPath();
    ctx.moveTo(s.x + ux * 16, by + uy * 16);
    ctx.lineTo(s.x + ux * 4 + px * 3.6, by + uy * 4 + py * 3.6);
    ctx.lineTo(s.x + ux * 4 - px * 3.6, by + uy * 4 - py * 3.6);
    ctx.closePath();
    ctx.fill();
    drawGlow(ctx, s.x, by, 18, color, 0.28);
  }
}

// ---------------- 地面特效 ----------------

/** 治疗光环脉冲：绿色扩散环（k = 0~1 进度）——保留旧接口给实验室/兼容。 */
export function drawHealPulse(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, k: number): void {
  const alpha = 0.5 * (1 - k);
  ctx.strokeStyle = rgba('#7CB342', alpha);
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(x, y, radius * (0.3 + 0.7 * k), 0, Math.PI * 2);
  ctx.stroke();
}

/** 伤害转嫁连线：巫师 → 替伤怪物（紫色电弧，0.3s 闪现）——保留旧接口。 */
export function drawTransfer(
  ctx: CanvasRenderingContext2D,
  fx: number,
  fy: number,
  tx: number,
  ty: number,
  alpha: number,
): void {
  const mx = (fx + tx) / 2 + (hash01(fx + tx) - 0.5) * 26;
  const my = (fy + ty) / 2 + (hash01(fy + ty) - 0.5) * 26;
  ctx.strokeStyle = rgba('#B388FF', alpha * 0.4);
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(fx, fy);
  ctx.lineTo(mx, my);
  ctx.lineTo(tx, ty);
  ctx.stroke();
  ctx.strokeStyle = rgba('#F5F5FA', alpha);
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  ctx.moveTo(fx, fy);
  ctx.lineTo(mx, my);
  ctx.lineTo(tx, ty);
  ctx.stroke();
}

/**
 * 弹坑（持续伤害圈）：焦黑坑缘 + 起伏熔岩盘 + 裂纹 + 上升火星。
 * 位置/半径来自逻辑层，绘制完全程序化（贴地火焰也是"几何+动效"）。
 */
export function drawPool(
  ctx: CanvasRenderingContext2D,
  pool: import('../../../gamecore').DamagePool,
  t: number,
): void {
  const left = Math.max(0, pool.until - t);
  const lifeK = Math.min(1, left * 0.8);
  const r = pool.radius;
  const seed = pool.x * 0.13 + pool.y * 0.07;

  // 焦土坑缘（不规则圆，避免"完美圆"的塑料感）
  ctx.fillStyle = rgba('#0B0C1D', 0.55 * lifeK);
  ctx.beginPath();
  for (let i = 0; i <= 18; i++) {
    const a = (Math.PI * 2 * i) / 18;
    const rr = (r + 7) * (0.94 + 0.1 * hash01(i * 2.3 + seed));
    const px = pool.x + Math.cos(a) * rr;
    const py = pool.y + Math.sin(a) * rr * 0.92;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fill();

  // 熔岩盘：外圈橙红 + 内圈亮黄，随时间脉动
  const pulse = 0.85 + 0.15 * Math.sin(t * 6 + seed);
  ctx.fillStyle = rgba('#FF5A3C', 0.42 * lifeK);
  ctx.beginPath();
  ctx.ellipse(pool.x, pool.y, r * pulse, r * pulse * 0.94, 0, 0, Math.PI * 2);
  ctx.fill();
  drawGlow(ctx, pool.x, pool.y, r * 1.5, '#FF5A3C', 0.18 * lifeK);
  ctx.fillStyle = rgba('#FFAA3C', 0.4 * lifeK);
  ctx.beginPath();
  ctx.ellipse(pool.x, pool.y, r * 0.55 * pulse, r * 0.52 * pulse, 0, 0, Math.PI * 2);
  ctx.fill();
  drawGlow(ctx, pool.x, pool.y, r * 0.7, '#FFD54F', 0.22 * lifeK);

  // 裂纹描边（沿坑缘的断续亮线）
  ctx.strokeStyle = rgba('#FF5A3C', 0.75 * lifeK);
  ctx.lineWidth = 2;
  for (let i = 0; i < 6; i++) {
    const a0 = (Math.PI * 2 * i) / 6 + seed;
    ctx.beginPath();
    ctx.ellipse(pool.x, pool.y, r, r * 0.94, 0, a0, a0 + 0.55);
    ctx.stroke();
  }

  // 上升火星（确定性相位）
  for (let i = 0; i < 5; i++) {
    const s = seed + i * 2.4;
    const k = (t * 0.9 + s) % 1;
    const ex = pool.x + Math.sin(s * 7 + k * 3) * r * 0.6 * (1 - k);
    const ey = pool.y + (0.5 - k) * r * 1.25;
    ctx.fillStyle = rgba('#FFD54F', (1 - k) * 0.8 * lifeK);
    ctx.beginPath();
    ctx.arc(ex, ey, 2.2 - k, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** 光束/连线伤害场（段场）：外辉光 + 流动亮芯 + 两端节点光。 */
export function drawSegments(
  ctx: CanvasRenderingContext2D,
  segments: import('../../../gamecore').SegmentField[],
  now: number,
  color = '#B388FF',
): void {
  for (const seg of segments) {
    const left = Math.max(0, seg.until - now);
    const alpha = Math.min(1, 0.3 + left * 0.6);
    const dx = seg.bx - seg.ax;
    const dy = seg.by - seg.ay;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    ctx.strokeStyle = rgba(color, 0.16 * alpha);
    ctx.lineWidth = seg.width * 0.9;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(seg.ax, seg.ay);
    ctx.lineTo(seg.bx, seg.by);
    ctx.stroke();
    ctx.strokeStyle = rgba(color, 0.5 * alpha);
    ctx.lineWidth = Math.max(4, seg.width * 0.35);
    ctx.stroke();
    ctx.strokeStyle = rgba('#F5F5FA', 0.9 * alpha);
    ctx.lineWidth = 3;
    ctx.stroke();
    // 流动光点（向远端推进，表现"持续输出"）
    for (let i = 0; i < 3; i++) {
      const k = ((now * 1.6 + i * 0.33) % 1);
      drawGlow(ctx, seg.ax + ux * len * k, seg.ay + uy * len * k, 10, color, 0.55 * alpha);
    }
    drawGlow(ctx, seg.ax, seg.ay, seg.width, color, 0.5 * alpha);
    drawGlow(ctx, seg.bx, seg.by, seg.width, color, 0.5 * alpha);
  }
}
