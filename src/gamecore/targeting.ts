import { SpatialHash } from './core/spatial-hash';
import { dist2 } from './core/math';
import { Rng } from './core/rng';

export interface Targetable {
  id: number;
  x: number;
  y: number;
  hp: number;
}

export type TargetingRule =
  | 'nearest'     // 最近（默认）
  | 'lowestHp'    // 血量最低
  | 'strongest'   // 血量最高（优先精英/Boss）
  | 'random'      // 范围内随机（炸弹防永远砸最近）
  | 'densest';    // 怪物最密的方向

const scratch: number[] = [];

/**
 * 索敌系统（docs/02 §4）：攻击瞬间才索敌，不逐帧索敌。
 * 通过空间网格取候选，再做精确判定。
 */
export function acquireTarget(
  rule: TargetingRule,
  fromX: number,
  fromY: number,
  range: number,
  monsters: readonly Targetable[],
  hash: SpatialHash,
  rng: Rng,
): Targetable | null {
  if (monsters.length === 0) return null;
  hash.rebuild(monsters);
  hash.queryCircle(fromX, fromY, range, scratch);

  let best: Targetable | null = null;
  let bestScore = Infinity;
  let randomCand: Targetable | null = null;
  let randomCount = 0;

  for (const id of scratch) {
    const m = monsters[id];
    if (!m || m.hp <= 0) continue;
    if (dist2(fromX, fromY, m.x, m.y) > range * range) continue;

    randomCount++;
    if (rng.next() < 1 / randomCount) randomCand = m; // 蓄水池抽样

    let score: number;
    switch (rule) {
      case 'lowestHp':
        score = m.hp;
        break;
      case 'strongest':
        score = -m.hp;
        break;
      case 'nearest':
      case 'densest': // M1 先用最近近似；密集度投票在 M2 实现
      default:
        score = dist2(fromX, fromY, m.x, m.y);
        break;
    }
    if (score < bestScore) {
      bestScore = score;
      best = m;
    }
  }

  if (rule === 'random') return randomCand;
  return best;
}
