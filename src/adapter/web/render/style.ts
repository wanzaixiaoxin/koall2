/**
 * 视觉基础层（docs/06 美术规划）：色板派生 + 预渲染精灵 + 确定性噪声。
 *
 * 设计约束：
 *  - 不新增色板颜色：亮/暗层次一律由 palette.json 的既有色「加白/压深」派生，
 *    保证「全游戏 ≤ 12 色」的纪律不被"为了好看"悄悄破坏。
 *  - 光晕/落地阴影这类高频、形状固定的元素预渲染成离屏精灵，绘制退化为 drawImage，
 *    避免每帧 createRadialGradient（同屏上百单位时这是最贵的一步）。
 *  - 本模块只依赖 DOM Canvas，不引用 gamecore（保持引擎解耦的适配层边界）。
 */

const SPRITE_SIZE = 128;

// ---------------- 颜色 ----------------

export function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h, 16);
  if (Number.isNaN(n)) return [255, 255, 255];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** 透明度叠加的 rgba 字符串（替代 hex + '66' 这类不可控写法）。 */
export function rgba(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, alpha))})`;
}

/** 线性混色：t=0 → a，t=1 → b。 */
export function mix(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  const k = Math.max(0, Math.min(1, t));
  return `rgb(${Math.round(ar + (br - ar) * k)},${Math.round(ag + (bg - ag) * k)},${Math.round(ab + (bb - ab) * k)})`;
}

/** 向白提亮 / 向夜色压深：唯一允许的"派生色"来源。 */
export function lighten(hex: string, t: number): string {
  return mix(hex, '#FFFFFF', t);
}

export function darken(hex: string, t: number): string {
  return mix(hex, '#0B0C1D', t);
}

// ---------------- 预渲染精灵 ----------------

const glowCache = new Map<string, HTMLCanvasElement>();

/** 径向光晕精灵（加色混合用）。同一颜色只生成一次。 */
export function glowSprite(color: string): HTMLCanvasElement {
  const hit = glowCache.get(color);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = SPRITE_SIZE;
  c.height = SPRITE_SIZE;
  const g = c.getContext('2d')!;
  const half = SPRITE_SIZE / 2;
  const [r, gg, b] = hexToRgb(color);
  const grad = g.createRadialGradient(half, half, 0, half, half, half);
  grad.addColorStop(0, `rgba(${r},${gg},${b},0.92)`);
  grad.addColorStop(0.22, `rgba(${r},${gg},${b},0.5)`);
  grad.addColorStop(0.5, `rgba(${r},${gg},${b},0.16)`);
  grad.addColorStop(1, `rgba(${r},${gg},${b},0)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, SPRITE_SIZE, SPRITE_SIZE);
  glowCache.set(color, c);
  return c;
}

/** 加色光晕：比 shadowBlur 便宜一个数量级，是"发光感"的主力。 */
export function drawGlow(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  color: string,
  alpha = 1,
): void {
  if (alpha <= 0.004 || radius <= 0.5) return;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
  ctx.drawImage(glowSprite(color), x - radius, y - radius, radius * 2, radius * 2);
  ctx.restore();
}

const SHADOW_SPRITE = (() => {
  let c: HTMLCanvasElement | null = null;
  return (): HTMLCanvasElement => {
    if (c) return c;
    c = document.createElement('canvas');
    c.width = SPRITE_SIZE;
    c.height = SPRITE_SIZE;
    const g = c.getContext('2d')!;
    const half = SPRITE_SIZE / 2;
    const grad = g.createRadialGradient(half, half, 0, half, half, half);
    grad.addColorStop(0, 'rgba(4,5,12,0.62)');
    grad.addColorStop(0.55, 'rgba(4,5,12,0.3)');
    grad.addColorStop(1, 'rgba(4,5,12,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, SPRITE_SIZE, SPRITE_SIZE);
    return c;
  };
})();

/**
 * 接地阴影：所有单位脚下的软圆盘（y 方向压扁）。
 * 没有它，几何体看起来是"贴在屏幕上"而不是"站在地面上"。
 */
export function drawGroundShadow(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  rx: number,
  ry: number,
  alpha = 1,
): void {
  if (alpha <= 0.004) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.drawImage(SHADOW_SPRITE(), x - rx, y - ry, rx * 2, ry * 2);
  ctx.restore();
}

// ---------------- 确定性噪声（纯表现，不参与逻辑） ----------------

/** 0~1 的确定性哈希：同一输入永远同一结果，避免闪烁抖动破坏确定性观感。 */
export function hash01(n: number): number {
  const s = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return s - Math.floor(s);
}

export function hash2(x: number, y: number): number {
  return hash01(x * 7.13 + y * 3.71);
}

/** 平滑呼吸波：把时间映射到 0~1（可指定相位/频率），各元素的待机节奏基础。 */
export function breathe(t: number, freq = 1, phase = 0): number {
  return 0.5 + 0.5 * Math.sin(t * freq * Math.PI * 2 + phase);
}

/** 分段信号：快速上冲、缓慢回落（用于受击/脉冲类表现，比纯 sin 更有重量感）。 */
export function pulse(t: number, freq = 1, phase = 0): number {
  const k = (t * freq + phase) % 1;
  return k < 0.15 ? k / 0.15 : 1 - (k - 0.15) / 0.85;
}
