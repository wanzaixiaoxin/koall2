import { Rng } from './core/rng';

export type DamageType = 'physical' | 'fire' | 'frost' | 'lightning' | 'poison';

/** 攻击方属性快照（武器结算时从英雄/辅助 + 卡牌加成聚合）。 */
export interface AttackerSnapshot {
  atk: number;
  dmgMul: number;      // DMG% 独立乘区，如 0.25 = +25%
  critChance: number;  // 0~1
  critDmg: number;     // 1.5 = 150%
  level: number;       // 参与目标减伤公式的等级项
}

export interface TargetSnapshot {
  def: number;
  level: number;
}

export interface DamageContext {
  skillMul: number;     // 技能倍率（武器基础 1.0，升级后 >1）
  damageType: DamageType;
  /** 类型克制系数（weak 1.25 / resist 0.75 / 无关系 1.0，docs/01 §2.1） */
  typeMul?: number;
}

export interface DamageResult {
  amount: number;
  isCrit: boolean;
  damageType: DamageType;
}

/**
 * 伤害公式（docs/01 §2）：
 *   伤害 = ATK × 技能倍率 × (1+DMG%) × 暴击 × 浮动(0.95~1.05)
 *   减伤 = DEF / (DEF + 100 + 10×目标等级)
 */
export function calcDamage(
  attacker: AttackerSnapshot,
  target: TargetSnapshot,
  ctx: DamageContext,
  rng: Rng,
): DamageResult {
  const isCrit = rng.next() < attacker.critChance;
  const critMul = isCrit ? attacker.critDmg : 1;
  const floatMul = rng.range(0.95, 1.05);
  const typeMul = ctx.typeMul ?? 1;

  const raw = attacker.atk * ctx.skillMul * (1 + attacker.dmgMul) * critMul * floatMul * typeMul;

  const defTerm = target.def + 100 + 10 * target.level;
  const reduction = target.def / defTerm;

  return {
    amount: Math.max(1, Math.round(raw * (1 - reduction))),
    isCrit,
    damageType: ctx.damageType,
  };
}

/** 对墙伤害不走路径，直接读怪物 wallDps（docs/04 §1）。 */
export function calcWallDamage(wallDps: number, tickDt: number): number {
  return wallDps * tickDt;
}
