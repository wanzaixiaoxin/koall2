import { AttackerSnapshot } from './damage';
import {
  BulletStat,
  CardConfig,
  FormId,
  HeroRuntime,
  PassiveStat,
  WeaponAffixes,
  WeaponConfig,
  WeaponInstance,
  WeaponMods,
} from './data/types';
import { Rng } from './core/rng';
import { SpatialHash } from './core/spatial-hash';
import { acquireTarget } from './targeting';
import { norm } from './core/math';

/** 经验曲线（docs/01 §3）：ExpNeed(Lv) = 80 + 40Lv + 6Lv²（每波 1~2 次三选一的节奏基准） */
export const BASE_ATK = 100;

export function xpNeed(level: number): number {
  return Math.round(80 + 40 * level + 6 * level * level);
}

export function createHero(x: number, y: number, weaponCfgs: WeaponConfig[]): HeroRuntime {
  return {
    x,
    y,
    level: 1,
    xp: 0,
    stats: {
      atk: BASE_ATK,
      aspd: 1,
      moveSpeed: 260,
      critChance: 0.05,
      critDmg: 1.5,
      dmgMul: 0,
    },
    weapons: weaponCfgs.map((cfg) => ({
      cfg,
      level: 1,
      damage: cfg.baseDamage,
      cooldown: 0.3, // 开局小延迟，避免第一帧齐射
      shotsSinceCool: 0,
      mods: { extraCount: 0, burst: 0, projSpeedMul: 1, damageMul: 1, rangeMul: 1, pierceAdd: 0, intervalMul: 1 },
      element: cfg.damageType,
      riders: { burnDpsMul: 0, burnSec: 3, slowPct: 0, slowSec: 2.5 },
      affixes: { homing: 0, bounce: 0, split: 0, shred: 0, blast: 0, chain: 0 },
    })),
  };
}

export function heroAttackerSnapshot(hero: HeroRuntime): AttackerSnapshot {
  return {
    atk: hero.stats.atk,
    dmgMul: hero.stats.dmgMul,
    critChance: hero.stats.critChance,
    critDmg: hero.stats.critDmg,
    level: hero.level,
  };
}

export interface FireCommand {
  weapon: WeaponInstance;
  fromX: number;
  fromY: number;
  dirX: number;
  dirY: number;
  speed: number;   // 最终弹速（含 mods）
  range: number;   // 最终射程（含 mods）
  dmg: number;     // 最终单发伤害（含 mods）
  index: number;   // 齐射扇形中的序号
  total: number;   // 齐射总数
  target: ReturnType<typeof acquireTarget>;
}

/** 武器系统：按间隔索敌，产出开火命令（session 负责创建投射物与连射调度）。 */
export function updateWeapons(
  hero: HeroRuntime,
  monsters: Parameters<typeof acquireTarget>[4],
  hash: SpatialHash,
  rng: Rng,
  out: FireCommand[],
): void {
  out.length = 0;
  for (const w of hero.weapons) {
    w.cooldown = Math.max(0, w.cooldown - 1 / 30);
    if (w.cooldown > 0) continue;
    const mods: WeaponMods = w.mods;
    const range = w.cfg.projectileRange * mods.rangeMul;
    const target = acquireTarget(w.cfg.targeting, hero.x, hero.y, range, monsters, hash, rng);
    if (!target) continue; // 无目标时冷却停在 0，不积累负值（否则目标出现时会"憋一大串"齐射）
    w.cooldown = (w.cfg.interval * mods.intervalMul) / hero.stats.aspd; // 赋值而非累加
    // 枪管过热：一轮发射计 1 次，达阈值强制冷却
    if (w.cfg.heat) {
      w.shotsSinceCool++;
      if (w.shotsSinceCool >= w.cfg.heat.shots) {
        w.shotsSinceCool = 0;
        w.cooldown = Math.max(w.cooldown, w.cfg.heat.cooldown);
      }
    }
    const n = norm(target.x - hero.x, target.y - hero.y);
    const total = w.cfg.count + mods.extraCount;
    for (let i = 0; i < total; i++) {
      out.push({
        weapon: w,
        fromX: hero.x,
        fromY: hero.y,
        dirX: n.x,
        dirY: n.y,
        speed: w.cfg.projectileSpeed * mods.projSpeedMul,
        range,
        dmg: w.damage * mods.damageMul,
        index: i,
        total,
        target,
      });
    }
  }
}

// ---------- 卡牌系统 ----------

/**
 * 生成升级三选一候选：按叠加上限 + 适用目标（统一门控，docs/03 §2.2）过滤后随机取 3。
 * - weapon 专属卡：仅当持有对应武器时可选
 * - element 专属卡 / 元素加持卡：仅当某武器已携带该元素时可选
 * - 元素赋予卡：武器已是该元素则无意义，不可选
 */
export function rollCardChoices(
  cards: readonly CardConfig[],
  stacks: ReadonlyMap<string, number>,
  weapons: readonly WeaponInstance[],
  rng: Rng,
  count = 3,
): CardConfig[] {
  const pool = cards.filter((c) => {
    if ((stacks.get(c.id) ?? 0) >= c.maxStack) return false;
    const e = c.effect;
    if ('grantElement' in e) {
      // 元素互斥：武器已被赋予过元素（≠ 默认元素）则不可再赋予；
      // 落雷武器（chainBase）伤害类型硬编码 lightning 且不结算骑士效果，不可赋予
      return weapons.some((w) => w.element === w.cfg.damageType && !w.cfg.chainBase);
    }
    const t = c.target;
    if (!t || t.kind === 'any') return true;
    if (t.kind === 'weapon') return weapons.some((w) => w.cfg.id === t.weaponType);
    return weapons.some((w) => w.element === t.element);
  });
  const result: CardConfig[] = [];
  // 加权无放回抽取（weight 默认 1）
  const bag = [...pool];
  while (result.length < count && bag.length > 0) {
    let total = 0;
    for (const c of bag) total += c.weight ?? 1;
    let roll = rng.next() * total;
    let idx = 0;
    for (; idx < bag.length; idx++) {
      roll -= bag[idx].weight ?? 1;
      if (roll <= 0) break;
    }
    idx = Math.min(idx, bag.length - 1);
    result.push(bag[idx]);
    bag.splice(idx, 1);
  }
  return result;
}

export function applyStat(s: HeroStatsLike, stat: PassiveStat, op: 'add' | 'mul', value: number): void {
  const cur = s[stat];
  (s as Record<PassiveStat, number>)[stat] = op === 'add' ? cur + value : cur * (1 + value);
}
type HeroStatsLike = HeroRuntime['stats'];

/** A 类卡：子弹属性强化（作用于所有武器）。 */
export function applyBulletMod(w: WeaponInstance, stat: BulletStat, op: 'add' | 'mul', value: number): void {
  const m = w.mods;
  switch (stat) {
    case 'count':
      m.extraCount = op === 'add' ? m.extraCount + value : m.extraCount * (1 + value);
      break;
    case 'burst':
      m.burst = op === 'add' ? m.burst + value : m.burst * (1 + value);
      break;
    case 'projSpeed':
      m.projSpeedMul = op === 'add' ? m.projSpeedMul + value : m.projSpeedMul * (1 + value);
      break;
    case 'damage':
      m.damageMul = op === 'add' ? m.damageMul + value : m.damageMul * (1 + value);
      break;
    case 'range':
      m.rangeMul = op === 'add' ? m.rangeMul + value : m.rangeMul * (1 + value);
      break;
    case 'pierce':
      m.pierceAdd = op === 'add' ? m.pierceAdd + value : m.pierceAdd * (1 + value);
      break;
    case 'interval':
      m.intervalMul = op === 'add' ? m.intervalMul + value : m.intervalMul * (1 + value);
      break;
  }
}

/** C 类卡：形态机制词缀（数值按等级叠加，具体参数在结算时解释）。 */
export function applyForm(a: WeaponAffixes, form: FormId, value = 1): void {
  switch (form) {
    case 'homing':
      a.homing = Math.min(1, a.homing + value);
      break;
    case 'bounce':
      a.bounce += value;
      break;
    case 'split':
      a.split += value;
      break;
    case 'shred':
      a.shred += value;
      break;
    case 'blast':
      a.blast += value;
      break;
    case 'chain':
      a.chain += value;
      break;
  }
}

/** AI/人类选卡策略接口：输入候选与当前状态，输出选择。session 为可选上下文（自适应策略用）。 */
export type CardPolicy = (
  choices: readonly CardConfig[],
  hero: HeroRuntime,
  rng: Rng,
  session?: { wallHp: number; wallMaxHp: number },
) => CardConfig;
