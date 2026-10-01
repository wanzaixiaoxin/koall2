import { MonsterRuntime } from './data/types';
import { SpatialHash } from './core/spatial-hash';

const scratch: number[] = [];

/** ranged 怪停驻射击城墙的距离（距城墙顶） */
const RANGED_HOLD_DISTANCE = 260;
/** dash 行为周期（秒）：前摇 0.4s 减速 → 0.5s 冲刺 ×3.2 */
const DASH_PERIOD = 2.2;

/**
 * 怪物系统：行军（向下压向城墙）+ 抵达后驻留攻击 + 近邻分离。
 * 坐标系：y 向上，城墙在底部（y ∈ [0, wallHeight]），怪物从顶部出生带向下推进。
 *
 * 行为（docs/04 §1.1）：
 * - march/fast_rush：直线压墙（速度差在配置里）
 * - zigzag：蛇形横向摆动
 * - dash：周期性前摇 + 冲刺（压墙尖峰）
 * - ranged：距墙 RANGED_HOLD_DISTANCE 处停驻，远程磨墙
 * - 所有近战抵达后转 assault 驻留打墙
 */
export function updateMonster(
  m: MonsterRuntime,
  dt: number,
  now: number,
  wallTopY: number,
  monsters: readonly MonsterRuntime[],
  hash: SpatialHash,
  onWallHit: (dmg: number, m: MonsterRuntime) => void,
  onRangedShot: (m: MonsterRuntime) => void,
): void {
  const r = m.cfg.radius;
  const holdY = wallTopY + (m.cfg.behavior === 'ranged' ? (m.cfg.rangedDist ?? RANGED_HOLD_DISTANCE) : 0) + r;

  if (m.state === 'march') {
    let speed = m.cfg.speed;
    if (now < m.slowUntil) speed *= m.slowFactor; // 冰冻减速（C 类卡）

    switch (m.cfg.behavior) {
      case 'zigzag':
        m.phase += dt * 4;
        m.x += Math.sin(m.phase) * speed * 0.6 * dt;
        break;
      case 'dash': {
        m.phase += dt; // 复用 phase 作冲刺周期计时
        const cyc = m.phase % DASH_PERIOD;
        if (cyc < 0.4) speed *= 0.2; // 前摇（程序预警线由渲染层表现）
        else if (cyc < 0.9) speed *= 3.2; // 冲刺
        break;
      }
      default:
        break;
    }

    m.y -= speed * dt;

    // 分离：只算近邻，防止叠成一团
    hash.queryCircle(m.x, m.y, r * 2, scratch);
    for (const nid of scratch) {
      if (nid === m.id) continue;
      const o = monsters[nid];
      if (!o || o.hp <= 0) continue;
      const dx = m.x - o.x;
      const dy = m.y - o.y;
      const d2 = dx * dx + dy * dy;
      const minD = r + o.cfg.radius;
      if (d2 > 1e-6 && d2 < minD * minD) {
        const d = Math.sqrt(d2);
        const push = ((minD - d) / d) * 0.5;
        m.x += dx * push;
        m.y += dy * push;
      }
    }

    if (m.y <= holdY) {
      m.y = holdY;
      m.state = 'assault';
      m.attackTimer = m.cfg.attackInterval;
    }
  } else {
    m.attackTimer -= dt;
    if (m.attackTimer <= 0) {
      m.attackTimer += m.cfg.attackInterval;
      if (m.cfg.behavior === 'ranged') {
        onRangedShot(m); // 远程怪：发射可见弹道（落点结算对墙伤害）
      } else {
        onWallHit(m.cfg.atk, m);
      }
    }
  }
}
