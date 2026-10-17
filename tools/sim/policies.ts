import { CardConfig, CardPolicy, Rng } from '../../src/gamecore';

/**
 * 贪心输出策略（模拟"正常玩家"的构筑倾向，用于 sim 回归与 AI 内容评估的对照组）。
 * 统一卡牌体系下的优先级：
 * 武器专属弹道（齐射/连射）> 通用子弹伤害 > 连锁/爆破形态 > 元素赋予 > 英雄属性 > 城墙。
 */
export const greedyDpsPolicy: CardPolicy = (choices, _hero, _rng, session) => {
  // 高压环境下城墙是战略资源：城防吃紧时防御卡优先级反超输出
  const wallDanger = session ? 1 - session.wallHp / session.wallMaxHp : 0;
  const prio = (c: CardConfig): number => {
    const e = c.effect as Record<string, unknown>;
    if (c.type === 'wall') {
      if (c.id === 'fortify') return wallDanger > 0.35 ? 99 : 55;
      return wallDanger > 0.3 ? 92 : 25;
    }
    if (c.type === 'bullet') {
      const isWeaponSpecific = c.target?.kind === 'weapon';
      // 低基础伤害版本：齐射/连射是乘法级输出（+100%/+轮），远超百分比加伤
      switch (e.bullet) {
        case 'count': return isWeaponSpecific ? 108 : 90;
        case 'burst': return isWeaponSpecific ? 106 : 88;
        case 'damage': return 82;
        case 'range': return 60;
        case 'projSpeed': return 55;
        case 'pierce': return 58;
        default: return 50;
      }
    }
    if (c.type === 'form') {
      switch (e.form) {
        case 'chain': return 92;
        case 'blast': return 86;
        case 'bounce': return 82;
        case 'split': return 80;
        case 'homing': return 78;
        case 'shred': return 58;
        default: return 50;
      }
    }
    if (c.type === 'element') {
      if ('grantElement' in e) return e.grantElement === 'fire' ? 76 : 74; // 赋予：解锁骑士效果
      return 62; // 加持（能被选到即已满足门控）
    }
    // passive
    switch (e.stat) {
      case 'atk': return 98;
      case 'aspd': return 90;
      case 'critChance': return 75;
      case 'critDmg': return 72;
      case 'dmgMul': return 68;
      case 'moveSpeed': return 40;
      default: return 10;
    }
  };
  return [...choices].sort((a, b) => prio(b) - prio(a))[0];
};

/** 随机策略：用于评估卡池下限（脸黑局）。 */
export const randomPolicy: CardPolicy = (choices, _hero, rng: Rng) =>
  choices[rng.int(0, choices.length - 1)];

/** 选卡策略名（--cards）：与走位策略（--move）相互独立，方便做 走位×构筑 对照矩阵。 */
export type CardPolicyName = 'greedy' | 'random';

export function getPolicy(name: CardPolicyName): CardPolicy {
  return name === 'greedy' ? greedyDpsPolicy : randomPolicy;
}
