/**
 * 3D→屏幕投影伤害飘字（HTML overlay 池，上限 40，沿用 2D 版事件语义）。
 * 世界坐标每帧投影，跟随实体上浮。
 */
import type { PerspectiveCamera, Vector3 } from 'three';

const MAX = 40;

interface FloatText {
  wx: number; wy: number; wz: number;
  text: string; color: string; size: number;
  life: number; maxLife: number;
  el: HTMLDivElement;
}

export class FloatsRender {
  private items: FloatText[] = [];
  private layer: HTMLDivElement;
  private tmp: Vector3;

  constructor(tmpVec: Vector3) {
    this.tmp = tmpVec;
    this.layer = document.createElement('div');
    this.layer.id = 'floats3d';
    this.layer.style.cssText =
      'position:absolute;inset:0;overflow:hidden;pointer-events:none;font-family:"PingFang SC","Microsoft YaHei",sans-serif;';
    document.body.appendChild(this.layer);
    const style = document.createElement('style');
    style.textContent = `#floats3d div{position:absolute;transform:translate(-50%,-50%);font-weight:700;
      text-shadow:0 2px 6px rgba(0,0,0,.9);will-change:transform,opacity;white-space:nowrap;}`;
    document.head.appendChild(style);
  }

  push(wx: number, wy: number, wz: number, text: string, color: string, size: number): void {
    if (this.items.length >= MAX) this.remove(this.items[0]);
    const el = document.createElement('div');
    el.textContent = text;
    el.style.color = color;
    el.style.fontSize = `${size}px`;
    this.layer.appendChild(el);
    this.items.push({ wx, wy, wz, text, color, size, life: 0.8, maxLife: 0.8, el });
  }

  private remove(f: FloatText): void {
    f.el.remove();
    const i = this.items.indexOf(f);
    if (i >= 0) this.items.splice(i, 1);
  }

  /** 每帧：投影到屏幕坐标 */
  update(camera: PerspectiveCamera, w: number, h: number, dt: number): void {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const f = this.items[i];
      f.life -= dt;
      if (f.life <= 0) {
        this.remove(f);
        continue;
      }
      f.wy += dt * 0.9;   // 上浮
      this.tmp.set(f.wx, f.wy, f.wz).project(camera);
      if (this.tmp.z > 1) {
        f.el.style.opacity = '0';
        continue;
      }
      const sx = (this.tmp.x * 0.5 + 0.5) * w;
      const sy = (-this.tmp.y * 0.5 + 0.5) * h;
      const k = f.life / f.maxLife;
      f.el.style.transform = `translate(-50%,-50%) translate(${sx}px,${sy}px)`;
      f.el.style.opacity = String(Math.min(1, k * 2));
    }
  }
}
