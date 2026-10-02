import { MonsterRuntime } from './data/types';

/** ranged 怪停驻射击城墙的距离（距城墙顶） */
const RANGED_HOLD_DISTANCE = 260;
/** dash 行为周期（秒）：前摇 0.4s 减速 → 0.5s 冲刺 ×3.2 */
const DASH_PERIOD = 2.2;

/**
 * 怪物系统：行军（向下压向城墙）+ 抵达后驻留攻击。
 * 坐标系：y 向上，城墙在底部（y ∈ [0, wallHeight]），怪物从顶部出生带向下推进。
 * 设计：怪物间无碰撞遮挡——小怪可以互相穿过（docs/04 §1.1，密集潮不堵路）。
 *
 * 行为（docs/04 §1.1）：
 * - march/fast_rush：直线压墙（速度差在配置里）
 * - zigzag：蛇形横向摆动
 * - dash：周期性前摇 + 冲刺（压墙尖峰）
 * - ranged：距墙 rangedDist（默认 260）处停驻，发射可见弹道
 * - 所有近战抵达后转 assault 驻留打墙
 */
export function updateMonster(
  m: MonsterRuntime,
  dt: number,
  now: number,
  wallTopY: number,
  onWallHit: (dmg: number, m: MonsterRuntime) => void,
  onRangedShot: (m: MonsterRuntime) => void,
  isCreeped?: (x: number, y: number) => boolean,
): void {
  const r = m.cfg.radius;

  // ---------- 钻地状态（docs/08）：不可移动/受击，按行为结算地下效果 ----------
  if (m.burrowed) {
    m.burrowTimer -= dt;
    if (m.cfg.burrowRegen && m.burrowTimer <= 0) {
      m.burrowed = false;
      m.hp = Math.min(m.maxHp, m.hp + Math.round(m.maxHp * m.cfg.burrowRegen.heal));
    } else if (m.cfg.burrowCharge && m.burrowTimer <= 0) {
      // 冲锋出土：出现在墙前并重击城墙
      m.burrowed = false;
      m.y = wallTopY + r;
      onWallHit(m.cfg.burrowCharge!.dmg, m);
    }
    // burrow_siege：地下持续刺击城墙（无计时，只能被爆炸/火焰轰出）
    if (m.burrowed && m.cfg.burrowSiege) {
      m.attackTimer -= dt;
      if (m.attackTimer <= 0) {
        m.attackTimer += m.cfg.attackInterval;
        onWallHit(m.cfg.atk, m);
      }
    }
    return;
  }

  const holdY = wallTopY + (m.cfg.behavior === 'ranged' ? (m.cfg.rangedDist ?? RANGED_HOLD_DISTANCE) : 0) + r;

  if (m.state === 'march') {
    let speed = m.cfg.speed;
    if (now < m.slowUntil) speed *= m.slowFactor; // 冰冻减速（C 类卡）

    // 虫族虫苔加速（docs/08）：在位移前生效
    if (m.cfg.creepBenefit && isCreeped && isCreeped(m.x, m.y)) speed *= 1.25;

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

    // 钻地触发：潜伏者到阵位永久入地；爬虫低血入地回血；雷兽周期冲锋入地
    if (m.cfg.burrowSiege && m.y <= wallTopY + m.cfg.burrowSiege.dist + r) {
      m.burrowed = true;
      m.y = wallTopY + m.cfg.burrowSiege.dist + r;
      return;
    }
    if (m.cfg.burrowRegen && m.hp < m.maxHp * m.cfg.burrowRegen.threshold) {
      m.burrowed = true;
      m.burrowTimer = m.cfg.burrowRegen.duration;
      return;
    }
    if (m.cfg.burrowCharge) {
      m.attackTimer -= dt; // 行军期复用 attackTimer 作冲锋冷却
      if (m.attackTimer <= 0 && m.y > wallTopY + 400) {
        m.burrowed = true;
        m.burrowTimer = m.cfg.burrowCharge.duration;
        m.attackTimer = m.cfg.burrowCharge.interval;
        return;
      }
      if (m.attackTimer <= 0) m.attackTimer = m.cfg.burrowCharge.interval;
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
