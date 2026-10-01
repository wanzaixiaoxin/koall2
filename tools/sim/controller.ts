import { Vec2 } from '../../src/gamecore';
import { GameSession } from '../../src/gamecore';

/**
 * sim 用英雄 AI 控制器（M1 占位，后续由"人类输入适配器"或更强 AI 策略替换）。
 *
 * 注意：英雄被钳制在防守区域内，战场区的宝石由"波间磁石事件"回收（docs/04 §5），
 * 所以控制器**不追宝石**（追也追不到），只做站位：
 * 1. 有怪物：横向移动到"离墙最近的怪物"正下方，模拟玩家补漏站位；
 * 2. 否则：回到防守区域中心。
 */
export class SimAIController {
  getMoveDir(s: GameSession): Vec2 {
    let threat: { x: number; y: number } | null = null;
    let threatY = Infinity;
    for (const m of s.monsters) {
      if (m.y < threatY) {
        threatY = m.y;
        threat = m;
      }
    }
    if (threat) {
      const targetY = Math.max(s.level.defenseRect.yMin, threat.y - 120);
      return normTo(s.hero.x, s.hero.y, threat.x, targetY);
    }

    const midY = (s.level.defenseRect.yMin + s.level.defenseRect.yMax) / 2;
    return normTo(s.hero.x, s.hero.y, s.level.arena.width / 2, midY);
  }
}

function normTo(fx: number, fy: number, tx: number, ty: number): Vec2 {
  const dx = tx - fx;
  const dy = ty - fy;
  const l = Math.hypot(dx, dy);
  return l > 1e-6 ? { x: dx / l, y: dy / l } : { x: 0, y: 0 };
}
