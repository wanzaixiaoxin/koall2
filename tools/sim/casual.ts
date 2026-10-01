import { Vec2 } from '../../src/gamecore';
import { GameSession } from '../../src/gamecore';

/**
 * 人类代理控制器：校准用（sim 的 SimAI 是完美走位，会高估玩家水平）。
 * 拟真要素：反应延迟（0.7s 才换一次走位决策）+ 目标点噪声 + 偶尔发呆。
 */
export class CasualAIController {
  private nextDecisionAt = 0;
  private currentDir: Vec2 = { x: 0, y: 0 };
  private readonly rng: () => number;

  constructor(seed = 1) {
    let s = (seed >>> 0) || 1;
    this.rng = () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  getMoveDir(session: GameSession): Vec2 {
    const now = session.timeSec;
    if (now < this.nextDecisionAt) return this.currentDir;
    this.nextDecisionAt = now + 0.7;

    // 10% 概率发呆一拍
    if (this.rng() < 0.1) {
      this.currentDir = { x: 0, y: 0 };
      return this.currentDir;
    }

    // 补漏站位（带噪声），人类会跟丢目标
    let threat: { x: number; y: number } | null = null;
    let threatY = Infinity;
    for (const m of session.monsters) {
      if (m.y < threatY) {
        threatY = m.y;
        threat = m;
      }
    }
    if (threat) {
      const nx = threat.x + (this.rng() - 0.5) * 160;
      const ny = Math.max(session.level.defenseRect.yMin, threat.y - 120) + (this.rng() - 0.5) * 80;
      this.currentDir = normTo(session.hero.x, session.hero.y, nx, ny);
      return this.currentDir;
    }
    const midY = (session.level.defenseRect.yMin + session.level.defenseRect.yMax) / 2;
    this.currentDir = normTo(session.hero.x, session.hero.y, session.level.arena.width / 2, midY);
    return this.currentDir;
  }
}

function normTo(fx: number, fy: number, tx: number, ty: number): Vec2 {
  const dx = tx - fx;
  const dy = ty - fy;
  const l = Math.hypot(dx, dy);
  return l > 1e-6 ? { x: dx / l, y: dy / l } : { x: 0, y: 0 };
}
