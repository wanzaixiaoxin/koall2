export interface Vec2 {
  x: number;
  y: number;
}

export const v2 = (x = 0, y = 0): Vec2 => ({ x, y });

export function len(x: number, y: number): number {
  return Math.sqrt(x * x + y * y);
}

export function dist(ax: number, ay: number, bx: number, by: number): number {
  return len(ax - bx, ay - by);
}

export function dist2(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

/** 归一化；零向量返回 (0,0) 防 NaN */
export function norm(x: number, y: number): Vec2 {
  const l = len(x, y);
  return l > 1e-6 ? { x: x / l, y: y / l } : { x: 0, y: 0 };
}

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function moveToward(cur: number, target: number, maxDelta: number): number {
  const d = target - cur;
  if (Math.abs(d) <= maxDelta) return target;
  return cur + Math.sign(d) * maxDelta;
}
