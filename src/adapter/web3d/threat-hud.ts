/**
 * 威胁感知三件套（docs3d/00 §1.3）：
 * 1. 屏幕边缘漏怪方向红光（HTML overlay，按怪物 x 分布加权）
 * 2. 城墙受击方向指示（顶部罗盘条上的红点）
 * 3. 危险怪近墙雷达（左下小地图：墙线 + 怪物点，越近越亮）
 */
import { toX, WALL_Y } from './scene/world';

const ARENA_HALF_W = 5.4; // 米

export class ThreatHud {
  private root: HTMLDivElement;
  private edgeL: HTMLDivElement;
  private edgeR: HTMLDivElement;
  private compass: HTMLCanvasElement;
  private radar: HTMLCanvasElement;
  private compassCtx: CanvasRenderingContext2D;
  private radarCtx: CanvasRenderingContext2D;

  constructor() {
    this.root = document.createElement('div');
    this.root.style.cssText =
      'position:fixed;inset:0;pointer-events:none;z-index:9;font-family:"PingFang SC","Microsoft YaHei",sans-serif;';
    document.body.appendChild(this.root);

    // 1) 屏幕左右边缘红光
    const mk = (side: 'left' | 'right'): HTMLDivElement => {
      const d = document.createElement('div');
      d.style.cssText = `position:absolute;top:0;bottom:0;${side}:0;width:12vw;pointer-events:none;
        opacity:0;transition:opacity .18s;
        background:linear-gradient(to ${side === 'left' ? 'right' : 'left'}, rgba(255,61,113,.55), transparent);`;
      this.root.appendChild(d);
      return d;
    };
    this.edgeL = mk('left');
    this.edgeR = mk('right');

    // 2) 城墙受击罗盘（顶部横条：映射城墙 x -5.4..5.4）
    this.compass = document.createElement('canvas');
    this.compass.width = 680; this.compass.height = 18;
    this.compass.style.cssText =
      'position:absolute;top:44px;left:50%;transform:translateX(-50%);width:min(680px,86vw);height:14px;opacity:.9;';
    this.root.appendChild(this.compass);
    this.compassCtx = this.compass.getContext('2d')!;

    // 3) 近墙雷达（左下 120×76）
    this.radar = document.createElement('canvas');
    this.radar.width = 240; this.radar.height = 152;
    this.radar.style.cssText =
      'position:absolute;left:14px;bottom:14px;width:120px;height:76px;border-radius:8px;opacity:.85;';
    this.root.appendChild(this.radar);
    this.radarCtx = this.radar.getContext('2d')!;
  }

  /** 每渲染帧：monsters 为逻辑怪物数组，wallHits 本帧受击 x 列表 */
  update(
    monsters: { x: number; y: number; hp: number; maxHp: number; burrowed: boolean }[],
    wallHits: number[],
    wallRatio: number,
  ): void {
    // ---- 1) 边缘红光：统计近墙(<400px)且在两侧 1/3 区的威胁 ----
    let wL = 0;
    let wR = 0;
    for (const m of monsters) {
      const d = m.y - WALL_Y;
      if (d > 420) continue;
      const nx = (m.x - 540) / 540; // -1..1
      if (nx < -0.3) wL += Math.min(1, (420 - d) / 420);
      else if (nx > 0.3) wR += Math.min(1, (420 - d) / 420);
    }
    this.edgeL.style.opacity = String(Math.min(0.9, wL * 0.35));
    this.edgeR.style.opacity = String(Math.min(0.9, wR * 0.35));

    // ---- 2) 罗盘：城墙血条底 + 受击点闪 ----
    const g = this.compassCtx;
    g.clearRect(0, 0, 680, 18);
    g.fillStyle = 'rgba(255,255,255,0.08)';
    g.fillRect(0, 4, 680, 8);
    g.fillStyle = wallRatio < 0.3 ? '#FF3D71' : '#3D4470';
    g.fillRect(0, 4, 680 * wallRatio, 8);
    for (const hx of wallHits) {
      const nx = (hx - 540) / 1080; // 0..1
      g.fillStyle = '#FF6B57';
      g.beginPath();
      g.arc(nx * 680, 8, 7, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = 'rgba(255,107,87,.5)';
      g.beginPath();
      g.arc(nx * 680, 8, 12, 0, Math.PI * 2);
      g.stroke();
    }

    // ---- 3) 雷达：上=远(出生带) 下=墙，怪点亮度按威胁 ----
    const r = this.radarCtx;
    r.clearRect(0, 0, 240, 152);
    r.fillStyle = 'rgba(11,12,29,0.72)';
    r.fillRect(0, 0, 240, 152);
    r.strokeStyle = 'rgba(53,224,195,0.5)';
    r.strokeRect(0.5, 0.5, 239, 151);
    // 墙线
    r.fillStyle = 'rgba(61,68,112,0.9)';
    r.fillRect(0, 128, 240, 6);
    for (const m of monsters) {
      if (m.burrowed) continue;
      const px = ((m.x - 0) / 1080) * 240;
      const py = 128 - ((m.y - WALL_Y) / 1900) * 128;
      const threat = Math.max(0, 1 - (m.y - WALL_Y) / 900);
      r.fillStyle = threat > 0.66 ? '#FF3D71' : threat > 0.33 ? '#FF9A3C' : 'rgba(255,107,87,0.45)';
      const s = 3 + threat * 3;
      r.fillRect(px - s / 2, py - s / 2, s, s);
    }
  }
}
