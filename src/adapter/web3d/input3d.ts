/**
 * 输入：WASD/方向键 + 指针拖拽（屏幕空间 → 逻辑移动方向）。
 * 3D 操控映射：屏幕上方 = 前进（逻辑 y+），右 = x+。
 */
import { Vec2 } from '../../gamecore';
import type { GameSession } from '../../gamecore';

export class Input3D {
  keys = new Set<string>();
  private pointerDown = false;
  private pointerNx = 0;   // 指针相对屏幕中心的归一化偏移
  private pointerNy = 0;

  constructor(private canvas: HTMLCanvasElement) {
    window.addEventListener('keydown', (e) => {
      this.keys.add(e.key.toLowerCase());
      if (e.key.startsWith('Arrow')) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => this.keys.clear());

    const setFromEvent = (e: PointerEvent): void => {
      const r = this.canvas.getBoundingClientRect();
      this.pointerNx = ((e.clientX - r.left) / r.width) * 2 - 1;
      this.pointerNy = ((e.clientY - r.top) / r.height) * 2 - 1;
    };
    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      this.pointerDown = true;
      setFromEvent(e);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (this.pointerDown) setFromEvent(e);
    });
    const up = (): void => { this.pointerDown = false; };
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
  }

  /** session 只读方向请求（HeroController 契约：返回单位向量或零向量） */
  getMoveDir(_s: GameSession): Vec2 {
    let dx = 0;
    let dy = 0;
    const k = this.keys;
    if (k.has('a') || k.has('arrowleft')) dx -= 1;
    if (k.has('d') || k.has('arrowright')) dx += 1;
    if (k.has('w') || k.has('arrowup')) dy += 1;
    if (k.has('s') || k.has('arrowdown')) dy -= 1;
    if (dx !== 0 || dy !== 0) {
      const l = Math.hypot(dx, dy);
      return { x: dx / l, y: dy / l };
    }
    if (this.pointerDown) {
      // 拖拽方向即移动方向（相对屏幕中心），死区 0.12
      const dxp = this.pointerNx;
      const dyp = -this.pointerNy; // 屏幕向上 = 逻辑 y+
      const l = Math.hypot(dxp, dyp);
      if (l > 0.12) return { x: dxp / l, y: dyp / l };
    }
    return { x: 0, y: 0 };
  }
}
