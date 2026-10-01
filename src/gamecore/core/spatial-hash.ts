export interface HasPosition {
  id: number;
  x: number;
  y: number;
}

/** 空间网格：怪物索敌/分离/AOE 查询的均摊 O(1) 基础设施。 */
export class SpatialHash {
  private cellSize: number;
  private map = new Map<number, number[]>();

  constructor(cellSize = 64) {
    this.cellSize = cellSize;
  }

  clear(): void {
    this.map.clear();
  }

  private key(cx: number, cy: number): number {
    // 支持负坐标的大数压缩键
    return ((cx + 4096) << 16) | (cy + 4096);
  }

  insert(id: number, x: number, y: number): void {
    const cx = Math.floor(x / this.cellSize);
    const cy = Math.floor(y / this.cellSize);
    const k = this.key(cx, cy);
    let bucket = this.map.get(k);
    if (!bucket) {
      bucket = [];
      this.map.set(k, bucket);
    }
    bucket.push(id);
  }

  rebuild(items: readonly HasPosition[]): void {
    this.clear();
    for (const it of items) this.insert(it.id, it.x, it.y);
  }

  /** 收集圆形范围内的候选 id（含格子的粗糙超集，调用方做精确距离判断）。 */
  queryCircle(x: number, y: number, r: number, out: number[]): void {
    out.length = 0;
    const minCx = Math.floor((x - r) / this.cellSize);
    const maxCx = Math.floor((x + r) / this.cellSize);
    const minCy = Math.floor((y - r) / this.cellSize);
    const maxCy = Math.floor((y + r) / this.cellSize);
    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        const bucket = this.map.get(this.key(cx, cy));
        if (bucket) for (const id of bucket) out.push(id);
      }
    }
  }
}
