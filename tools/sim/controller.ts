import { GameSession, Vec2, WeaponInstance } from '../../src/gamecore';

/**
 * sim 用英雄 AI 控制器（武器感知版）。
 *
 * 定位规则：默认追"最靠墙的怪"正下方（防漏站位），仅对抛物/爆破系加一条修正——
 * 怪物驻留墙前时退到防守区中场：贴墙时抛物线因 120px 最小射程被甩出城墙，
 * 落点够不着墙堆（A/B 实测：level_2_1 炸弹局 42s 城破/4 杀 → 181s/167 杀）。
 *
 * 已实测否决的规则（留档，避免后人重复踩坑）：
 * - 贯穿系"最密纵向列对齐"：弩箭丢前线防漏，4 格全负（时长 -8%~-36%）
 * - 雷霆系"最密列站桩"：12 局/格扩大样本全负（击杀 -8%~-49%，6 局小样本曾假阳性）
 *
 * 注意：本控制器是"合成基线"，不是真人代理；weaponAware=false 可复现改动前旧行为，供 A/B 对比。
 * 英雄被钳制在防守区域内，经验宝石由"击杀自动吸收"结算（无拾取环节），因此控制器不追宝石、只做站位。
 */
export class SimAIController {
  constructor(private weaponAware = true) {}

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
      const w = s.hero.weapons[0];
      const lobbed = this.weaponAware && !!w && isLobbedWeapon(w);
      const camped = threat.y <= s.level.defenseRect.yMin + 140; // 怪物已压到墙线附近（驻留啃墙）
      const targetY = lobbed && camped
        ? (s.level.defenseRect.yMin + s.level.defenseRect.yMax) / 2 // 退中场轰炸，避开抛物线近距死区
        : Math.max(s.level.defenseRect.yMin, threat.y - 120);
      return normTo(s.hero.x, s.hero.y, threat.x, targetY);
    }

    const midY = (s.level.defenseRect.yMin + s.level.defenseRect.yMax) / 2;
    return normTo(s.hero.x, s.hero.y, s.level.arena.width / 2, midY);
  }
}

/** 抛物/爆破系：落点 = 目标快照 + 最小射程 120px，贴墙站位存在近距死区，需要站位感知。 */
export function isLobbedWeapon(w: WeaponInstance): boolean {
  return w.cfg.motion?.type === 'parabola' || !!w.cfg.blastBase;
}

function normTo(fx: number, fy: number, tx: number, ty: number): Vec2 {
  const dx = tx - fx;
  const dy = ty - fy;
  const l = Math.hypot(dx, dy);
  return l > 1e-6 ? { x: dx / l, y: dy / l } : { x: 0, y: 0 };
}
