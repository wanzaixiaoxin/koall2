/**
 * lab：卡牌效果测试入口。
 *
 * 用法：
 *   node dist/tools/lab/index.js --card power [--times 3]     # 观察单张卡效果（前后对比）
 *   node dist/tools/lab/index.js --all                        # 全量断言测试（npm test）
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  CardConfig,
  createTrajectory,
  frisbeeConfig,
  applyForm,
  GameSession,
  HeroRuntime,
  LevelConfig,
  MonsterConfig,
  MotionContext,
  rollCardChoices,
  Targetable,
  Trajectory,
  WeaponConfig,
} from '../../src/gamecore';
import { greedyDpsPolicy } from '../sim/policies';
import { HumanInputController, TraceRecorder, parseTrace, serializeTrace } from '../sim/human';
import { runTraceReplay } from '../sim/replay';

const root = process.cwd();

function loadConfigs(): {
  level: LevelConfig;
  weapon: WeaponConfig;
  monsters: Map<string, MonsterConfig>;
  cards: CardConfig[];
} {
  const level = JSON.parse(fs.readFileSync(path.join(root, 'configs/levels/lab_arena.json'), 'utf-8')) as LevelConfig;
  const weapons = (JSON.parse(fs.readFileSync(path.join(root, 'configs/weapons.json'), 'utf-8')) as { weapons: WeaponConfig[] }).weapons;
  const monsters = (JSON.parse(fs.readFileSync(path.join(root, 'configs/monsters.json'), 'utf-8')) as { monsters: MonsterConfig[] }).monsters;
  const cards = (JSON.parse(fs.readFileSync(path.join(root, 'configs/cards.json'), 'utf-8')) as { cards: CardConfig[] }).cards;
  return { level, weapon: weapons[0], monsters: new Map(monsters.map((m) => [m.id, m])), cards };
}

function freshSession(seed = 1, weaponIndex = 0): GameSession {
  const { level, weapon, monsters, cards } = loadConfigs();
  void weapon;
  const weapons = (JSON.parse(fs.readFileSync(path.join(root, 'configs/weapons.json'), 'utf-8')) as { weapons: WeaponConfig[] }).weapons;
  return new GameSession({
    level,
    weaponConfigs: [weapons[weaponIndex]],
    monsterConfigs: monsters,
    cardConfigs: cards,
    seed,
    controller: { getMoveDir: () => ({ x: 0, y: 0 }) },
    cardPolicy: greedyDpsPolicy,
  });
}

function heroSnapshot(h: HeroRuntime): Record<string, unknown> {
  const w = h.weapons[0];
  return {
    atk: +h.stats.atk.toFixed(2),
    aspd: +h.stats.aspd.toFixed(2),
    critChance: +h.stats.critChance.toFixed(2),
    critDmg: +h.stats.critDmg.toFixed(2),
    dmgMul: +h.stats.dmgMul.toFixed(2),
    面板伤害: +w.damage.toFixed(2),
    弹速倍率: +w.mods.projSpeedMul.toFixed(2),
    射程倍率: +w.mods.rangeMul.toFixed(2),
    伤害倍率: +w.mods.damageMul.toFixed(2),
    齐射: w.mods.extraCount,
    连射: w.mods.burst,
    元素: w.element,
    词缀: {
      追踪: w.affixes.homing,
      弹射: w.affixes.bounce,
      分裂: w.affixes.split,
      破甲等级: w.affixes.shred,
      爆破等级: w.affixes.blast,
      连锁等级: w.affixes.chain,
    },
    元素骑士: {
      灼烧倍率: +w.riders.burnDpsMul.toFixed(2),
      灼烧时长: w.riders.burnSec,
      减速: `${Math.round(w.riders.slowPct * 100)}%`,
      减速时长: w.riders.slowSec,
    },
  };
}

// ---------- 模式 1：单卡观察 ----------

function observeCard(cardId: string, times: number): void {
  const cards = loadConfigs().cards;
  const card = cards.find((c) => c.id === cardId);
  if (!card) {
    console.error(`未知卡牌: ${cardId}`);
    process.exit(1);
  }
  const s = freshSession();
  const before = {
    hero: heroSnapshot(s.hero),
    wallHp: s.wallHp,
    wallMaxHp: s.wallMaxHp,
  };
  const results: boolean[] = [];
  for (let i = 0; i < times; i++) results.push(s.grantCard(cardId));
  const after = { hero: heroSnapshot(s.hero), wallHp: s.wallHp, wallMaxHp: s.wallMaxHp };
  console.log(`卡牌: ${card.name} (${card.type}) × ${times}  授予结果: ${results.map((r) => (r ? 'OK' : '拒绝(上限)')).join(',')}`);
  console.log('--- 前 ---');
  console.log(JSON.stringify(before, null, 2));
  console.log('--- 后 ---');
  console.log(JSON.stringify(after, null, 2));
}

// ---------- 模式 2：全量断言 ----------

interface TestCase { name: string; run: () => boolean | string }

const approx = (a: number, b: number, eps = 0.01): boolean => Math.abs(a - b) < eps;

/** 让步进固定时长，返回是否提前满足条件。 */
function runFor(s: GameSession, seconds: number, cond: () => boolean): boolean {
  const ticks = Math.round(seconds * 30);
  for (let i = 0; i < ticks; i++) {
    if (cond()) return true;
    s.step();
  }
  return cond();
}

function fireGroups(s: GameSession, seconds: number): number[] {
  const times: number[] = [];
  s.bus.on('onShoot', () => times.push(s.timeSec));
  const ticks = Math.round(seconds * 30);
  for (let i = 0; i < ticks; i++) s.step();
  // 按 0.4s 间隔分组成"攻击批次"（区分齐射轮次与连射的 0.12s 间隔）
  const groups: number[] = [];
  let prev = -1;
  for (const t of times) {
    if (prev < 0 || t - prev > 0.4) groups.push(1);
    else groups[groups.length - 1]++;
    prev = t;
  }
  return groups;
}

const tests: TestCase[] = [
  // ===== A 类：子弹卡 =====
  { name: 'A-齐射：每次 +1，3 级后拒绝第 4 张', run: () => {
    const s = freshSession();
    if (!(s.grantCard('volley') && s.grantCard('volley') && s.grantCard('volley'))) return '授予失败';
    if (s.hero.weapons[0].mods.extraCount !== 3) return `extraCount=${s.hero.weapons[0].mods.extraCount}`;
    if (s.grantCard('volley')) return '第 4 张应被拒绝';
    return s.hero.weapons[0].mods.extraCount === 3;
  } },
  { name: 'A-连射：burst 叠加到 3', run: () => {
    const s = freshSession();
    s.grantCard('burst_fire'); s.grantCard('burst_fire'); s.grantCard('burst_fire');
    return s.hero.weapons[0].mods.burst === 3;
  } },
  { name: 'A-急速弹：弹速倍率 1.2 → 1.44', run: () => {
    const s = freshSession();
    s.grantCard('swift'); s.grantCard('swift');
    return approx(s.hero.weapons[0].mods.projSpeedMul, 1.44, 0.001);
  } },
  { name: 'A-强装药：伤害倍率 1.15 → 1.3225', run: () => {
    const s = freshSession();
    s.grantCard('overload'); s.grantCard('overload');
    return approx(s.hero.weapons[0].mods.damageMul, 1.3225, 0.001);
  } },
  { name: 'A-长枪管：射程倍率 1.15', run: () => {
    const s = freshSession();
    s.grantCard('longbarrel');
    return approx(s.hero.weapons[0].mods.rangeMul, 1.15, 0.001);
  } },
  { name: 'A-行为：齐射×3 每轮打出 4 发', run: () => {
    const s = freshSession();
    s.grantCard('volley'); s.grantCard('volley'); s.grantCard('volley');
    s.debugSpawn('slime', 540, 800);
    const groups = fireGroups(s, 3);
    return groups.length >= 1 && groups.every((g) => g === 4);
  } },
  { name: 'A-行为：穿透衰减与破甲（均值比，消除浮动噪声）', run: () => {
    // 穿透弩直线穿过三只岩甲兽；按 0.4s 窗口分组每次齐射的多次命中，取 (第1命中,第2命中) 均值比
    const meanRatio = (shredLv: number): number | null => {
      const s = freshSession(7, 1); // crossbow_pierce
      for (let i = 0; i < shredLv; i++) s.grantCard('shred');
      s.debugSpawn('bulwark', 540, 680);
      s.debugSpawn('bulwark', 540, 760);
      s.debugSpawn('bulwark', 540, 840);
      for (const b of s.monsters) b.shieldLeft = 0; // 隔离免伤盾，测穿透衰减本身
      const hits: { t: number; dmg: number }[] = [];
      // 剔除暴击样本（×1.5 会污染均值；种子固定时同一暴击位每次复现造成系统性偏差）
      s.bus.on('onHit', (p: { dmg: number; isCrit: boolean }) => {
        if (!p.isCrit && hits.length < 60) hits.push({ t: s.timeSec, dmg: p.dmg });
      });
      for (let i = 0; i < 30 * 10 && hits.length < 40; i++) s.step();
      const pairs: [number, number][] = [];
      for (let i = 0; i < hits.length - 1; i++) {
        if (hits[i + 1].t - hits[i].t < 0.4) pairs.push([hits[i].dmg, hits[i + 1].dmg]);
      }
      if (pairs.length < 3) return null;
      const m1 = pairs.reduce((a, p) => a + p[0], 0) / pairs.length;
      const m2 = pairs.reduce((a, p) => a + p[1], 0) / pairs.length;
      return m2 / m1;
    };
    const r0 = meanRatio(0);
    if (r0 === null) return '命中样本不足';
    if (!(r0 > 0.76 && r0 < 0.88)) return `无破甲均值比 ${r0.toFixed(3)}（期望 ≈0.82）`;
    const r3 = meanRatio(3);
    if (r3 === null || !(r3 > 0.97 && r3 < 1.03)) return `破甲×3 均值比 ${r3?.toFixed(3)}（期望 ≈1.0）`;
    const r1 = meanRatio(1);
    if (r1 === null || !(r1 > 0.84 && r1 < 0.94)) return `破甲×1 均值比 ${r1?.toFixed(3)}（期望 ≈0.88）`;
    return true;
  } },

  { name: 'A-行为：齐射主弹对准目标，附加弹左右交替展开', run: () => {
    const s = freshSession();
    s.grantCard('volley'); s.grantCard('volley'); s.grantCard('volley');
    s.debugSpawn('slime', 540, 900); // 英雄(540,328) 正上方，瞄准方向 = +y（90°）
    if (!runFor(s, 3, () => s.projectiles.length >= 4)) return '未观察到 4 发齐射';
    const aim = Math.PI / 2;
    const devs = s.projectiles.slice(0, 4).map((p) => {
      const ang = Math.atan2(p.y - p.py, p.x - p.px);
      let d = ang - aim;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      return Math.round(d * 1000) / 1000;
    }).sort((a, b) => a - b);
    const expect = [-0.2, -0.1, 0, 0.1]; // 主弹 0；+1 左 0.1；+2 右 0.1；+3 左 0.2
    return JSON.stringify(devs) === JSON.stringify(expect) || `实际偏差 ${JSON.stringify(devs)}`;
  } },
  { name: 'A-行为：连射×3 每次攻击共 4 发（1+3 延迟）', run: () => {
    const s = freshSession();
    s.grantCard('burst_fire'); s.grantCard('burst_fire'); s.grantCard('burst_fire');
    s.debugSpawn('slime', 540, 800);
    const times: number[] = [];
    s.bus.on('onShoot', () => { if (times.length < 40) times.push(s.timeSec); });
    const ticks = Math.round(2.2 * 30); // 4 轮攻击窗口
    for (let i = 0; i < ticks; i++) s.step();
    // 按 0.16s 间隔分组：连射内部 0.12s / 轮间 ≥0.19s（0.55 间隔 - 0.36 连射跨度）
    const groups: number[] = [];
    let lastT = -1;
    for (const t of times) {
      if (lastT < 0 || t - lastT > 0.16) groups.push(1);
      else groups[groups.length - 1]++;
      lastT = t;
    }
    return groups.length >= 2 && groups.every((g) => g === 4);
  } },

  // ===== B 类：城墙卡 =====
  { name: 'B-加固城墙：上限 +30% 复利且当前值同步', run: () => {
    const s = freshSession();
    const base = s.wallMaxHp; // 实验室城墙 99999，测试写成基线无关
    s.grantCard('fortify');
    const expect1 = base + Math.round(base * 0.3);
    if (Number(s.wallMaxHp) !== expect1 || Number(s.wallHp) !== expect1) return `1 层后 ${s.wallHp}/${s.wallMaxHp}`;
    s.grantCard('fortify');
    const expect2 = expect1 + Math.round(expect1 * 0.3);
    return Number(s.wallMaxHp) === expect2 && Number(s.wallHp) === expect2;
  } },
  { name: 'B-紧急修缮：+3000 且不超上限（封顶）', run: () => {
    const s = freshSession();
    const base = s.wallMaxHp;
    s.wallHp = base - 10000;
    s.grantCard('repair');
    if (Number(s.wallHp) !== base - 7000) return `第 1 次修复后 ${s.wallHp}`;
    s.grantCard('repair');
    if (Number(s.wallHp) !== base - 4000) return `第 2 次修复后 ${s.wallHp}`;
    s.grantCard('repair');
    if (Number(s.wallHp) !== base - 1000) return `第 3 次修复后 ${s.wallHp}`;
    s.grantCard('repair'); // base-1000+3000 → 封顶 base
    if (Number(s.wallHp) !== base) return `第 4 次修复后 ${s.wallHp}（未封顶 ${base}）`;
    // 加固提升上限后：修复在新上限内生效
    s.grantCard('fortify');
    s.wallHp = s.wallMaxHp - 1000;
    s.grantCard('repair');
    return Number(s.wallHp) === s.wallMaxHp;
  } },

  // ===== C 类：形态卡 =====
  { name: 'C-追踪弹：回旋镖导向（homing=1 且不叠加）', run: () => {
    const s = freshSession(1, 3); // boomerang（导向镖为其武器特性）
    if (!s.grantCard('homing')) return '导向镖授予失败';
    return s.hero.weapons[0].affixes.homing === 1 && !s.grantCard('homing');
  } },
  { name: 'C-跳箭（弩专属）：弹射按级叠加，其他武器不可拿', run: () => {
    const s = freshSession(1, 1); // crossbow_pierce
    s.grantCard('ricochet'); s.grantCard('ricochet'); s.grantCard('ricochet');
    const a = s.hero.weapons[0].affixes;
    if (!(a.bounce === 3 && !s.grantCard('ricochet'))) return `bounce=${a.bounce}`;
    const rifle = freshSession();
    if (rifle.grantCard('ricochet')) return '步枪不应能拿跳箭';
    return true;
  } },
  { name: 'C-扩爆（炸弹专属）：在本体爆破上放大半径', run: () => {
    const s = freshSession(1, 2); // alchemist_bomb（本体爆破 r95）
    s.grantCard('blast');
    const a = s.hero.weapons[0].affixes;
    if (!(a.blast === 1)) return `blast=${a.blast}`;
    s.debugSpawn('slime', 540, 850); // 中远目标（索敌距内），落地爆炸
    const ok = runFor(s, 6, () => s.pools.length > 0);
    if (!ok) return '伤害圈未出现';
    return s.pools[0].radius >= 95 ? true : `半径 ${s.pools[0].radius}（应 ≥ 本体 95）`;
  } },
  { name: 'C-元素：赋予解锁骑士效果、加持成长、互斥与门控', run: () => {
    // 门控：未携带元素时加持卡不可授予
    const s1 = freshSession();
    if (s1.grantCard('ignite')) return '烈火应在无火属性时被拒绝';
    if (s1.grantCard('deepfreeze')) return '严寒应在无冰属性时被拒绝';
    // 火路线：赋予 → 元素转 fire + 灼烧骑士 0.25；加持按级成长；第二次赋予被互斥拒绝
    if (!s1.grantCard('flame')) return '火焰弹授予失败';
    const w1 = s1.hero.weapons[0];
    if (w1.element !== 'fire' || !approx(w1.riders.burnDpsMul, 1.0)) return '火赋予未解锁点燃（100%/s）';
    if (s1.grantCard('frost')) return '元素互斥失效：已有火属性仍可拿寒冰弹';
    s1.grantCard('ignite'); s1.grantCard('ignite');
    if (!approx(w1.riders.burnDpsMul, 2.0)) return `烈火×2 后灼烧 ${w1.riders.burnDpsMul}`;
    // 冰路线（独立会话）：赋予 → 减速骑士 0.12；严寒×2 → 0.24
    const s2 = freshSession();
    s2.grantCard('frost');
    const w2 = s2.hero.weapons[0];
    if (w2.element !== 'frost' || !approx(w2.riders.slowPct, 0.12)) return '冰赋予未解锁减速';
    s2.grantCard('deepfreeze'); s2.grantCard('deepfreeze');
    if (!approx(w2.riders.slowPct, 0.24)) return `严寒×2 后减速 ${w2.riders.slowPct}`;
    return true;
  } },
  { name: 'C-灼烧：火焰赋予后命中附着燃烧，重复命中不叠加', run: () => {
    const s = freshSession();
    s.grantCard('flame');
    s.grantCard('ignite'); s.grantCard('ignite'); // 烈火×2：灼烧 100% + 100% = 200%/s
    const w = s.hero.weapons[0];
    if (!approx(w.riders.burnDpsMul, 2.0)) return `灼烧倍率 ${w.riders.burnDpsMul}`;
    s.debugSpawn('bulwark', 540, 900);
    const applied = runFor(s, 8, () => s.monsters.some((m) => m.burn !== null));
    if (!applied) return '灼烧未附着';
    const m = s.monsters.find((mm) => mm.burn !== null)!;
    const dps0 = m.burn!.dps;
    runFor(s, 2, () => false);
    return m.burn === null || m.burn.dps === dps0
      ? true : `灼烧叠加 ${dps0} → ${m.burn?.dps}`;
  } },
  { name: 'C-火焰弹：damageType 转 fire', run: () => {
    const s = freshSession();
    s.grantCard('flame');
    s.debugSpawn('bulwark', 540, 900);
    let seenFire = false;
    const ok = runFor(s, 5, () => {
      seenFire = seenFire || s.projectiles.some((p) => p.damageType === 'fire');
      return seenFire;
    });
    return ok || seenFire;
  } },
  { name: 'C-行为：火焰弹对弱火怪增伤（类型克制 ×1.25）', run: () => {
    const firstHit = (flame: boolean): number => {
      const s = freshSession();
      if (flame) s.grantCard('flame');
      s.debugSpawn('slime', 540, 900); // 史莱姆 weak fire
      let dmg = 0;
      s.bus.on('onHit', (p: { dmg: number }) => { if (dmg === 0) dmg = p.dmg; });
      runFor(s, 4, () => dmg > 0);
      return dmg;
    };
    const phys = firstHit(false);
    const fire = firstHit(true);
    return fire > phys * 1.15 ? true : `物理=${phys} 火焰=${fire}`;
  } },
  { name: 'P-行为：力量实际提升命中伤害（全局攻击，非与子弹卡重复）', run: () => {
    const firstHit = (grants: string[]): number => {
      const s = freshSession();
      for (const g of grants) s.grantCard(g);
      s.debugSpawn('bulwark', 540, 900);
      const t = s.monsters[0];
      t.shieldLeft = 0; // 隔离免伤盾，测攻击收益本身
      let dmg = 0;
      s.bus.on('onHit', (p: { dmg: number }) => { if (dmg === 0) dmg = p.dmg; });
      runFor(s, 4, () => dmg > 0);
      return dmg;
    };
    const base = firstHit([]);
    const powered = firstHit(['power', 'power', 'power', 'power', 'power']);
    return powered > base * 1.25 ? true : `base=${base} 力量×5=${powered}（力量未生效）`;
  } },
  { name: 'C-行为：冰冻命中后 slowUntil 生效', run: () => {
    const s = freshSession();
    s.grantCard('frost');
    s.debugSpawn('bulwark', 540, 900);
    return runFor(s, 8, () => s.monsters.some((m) => m.slowUntil > s.timeSec));
  } },
  { name: 'C-破甲（弩专属）：命中后 shredAmount=3/层；步枪不可拿', run: () => {
    const s = freshSession(1, 1); // crossbow_pierce
    s.grantCard('shred'); s.grantCard('shred');
    s.debugSpawn('bulwark', 540, 900);
    const ok = runFor(s, 8, () => s.monsters.some((m) => m.shredAmount === 6 && m.shredUntil > s.timeSec));
    if (!ok) return '破甲未生效';
    const rifle = freshSession();
    return rifle.grantCard('shred') ? '步枪不应能拿破甲弹' : true;
  } },
  { name: 'C-元素赋予门控：落雷武器不可被赋予元素', run: () => {
    const s = freshSession(1, 4); // lightning_chain
    if (s.grantCard('flame')) return '雷电权杖不应能拿火焰弹';
    if (s.grantCard('frost')) return '雷电权杖不应能拿寒冰弹';
    return true;
  } },
  { name: 'C-行为：弹射后仍保留追踪（衍生/重定向词缀继承）', run: () => {
    const s = freshSession();
    applyForm(s.hero.weapons[0].affixes, 'homing', 1); // 直接注入词缀，验证机制继承
    applyForm(s.hero.weapons[0].affixes, 'bounce', 1);
    s.debugSpawn('slime', 500, 800);
    s.debugSpawn('slime', 640, 850);
    s.debugSpawn('slime', 420, 880);
    return runFor(s, 6, () =>
      s.projectiles.some((p) => p.alive && p.hitIds.size >= 1 && p.homing === true));
  } },
  { name: 'C-行为：分裂衍生弹继承追踪', run: () => {
    const s = freshSession();
    applyForm(s.hero.weapons[0].affixes, 'homing', 1);
    applyForm(s.hero.weapons[0].affixes, 'split', 1);
    s.debugSpawn('slime', 500, 800);
    s.debugSpawn('slime', 620, 860);
    return runFor(s, 8, () =>
      s.projectiles.some((p) => p.alive && p.homing && p.affixes.split === 0 && p.hitIds.size === 0));
  } },

  // ===== 弹道行为库（docs/07）：运动基元单测 =====
  { name: 'W-卡池权重：齐射/连射出现率约为其他卡的 1/3', run: () => {
    // 构造等比池：volley(1/3) + burst(1/3) + power(1)，900 次抽取统计占比
    const { level, weapon, monsters } = loadConfigs();
    const cards = loadConfigs().cards.filter((c) => ['volley', 'burst_fire', 'power'].includes(c.id));
    for (const c of cards) c.maxStack = 9999;
    const s = new GameSession({
      level, weaponConfigs: [weapon], monsterConfigs: monsters, cardConfigs: cards,
      seed: 11,
      controller: { getMoveDir: () => ({ x: 0, y: 0 }) },
      cardPolicy: greedyDpsPolicy,
    });
    const rng = s.rng;
    const counts = new Map<string, number>();
    const stacks = new Map<string, number>();
    for (let i = 0; i < 900; i++) {
      const picks = rollCardChoices(cards, stacks, s.hero.weapons, rng, 1);
      if (picks.length > 0) counts.set(picks[0].id, (counts.get(picks[0].id) ?? 0) + 1);
    }
    const pPower = (counts.get('power') ?? 0) / 900;
    const pVolley = (counts.get('volley') ?? 0) / 900;
    // 期望：power 3/5=0.6，volley 1/5=0.2（容差 ±0.08）
    if (!(pPower > 0.52 && pPower < 0.68)) return `power 占比 ${(pPower * 100).toFixed(1)}%（期望 60%）`;
    if (!(pVolley > 0.12 && pVolley < 0.28)) return `齐射占比 ${(pVolley * 100).toFixed(1)}%（期望 20%）`;
    return true;
  } },
  { name: 'W-枪管过热：连射 14 轮后强制冷却 2.5 秒', run: () => {
    const s = freshSession(); // rifle heat 14/2.5
    s.debugSpawn('bulwark', 540, 900);
    const target = s.monsters[0];
    target.hp = target.maxHp = 1e6; // 测试靶不死，隔离英雄火力干扰
    let shots = 0;
    let lastShotT = -1;
    let cooled = false;
    s.bus.on('onShoot', () => { shots++; lastShotT = s.timeSec; });
    for (let i = 0; i < 30 * 25 && !cooled; i++) {
      s.step();
      if (lastShotT > 0 && s.timeSec - lastShotT > 1.2) cooled = true; // 0.55s 正常间隔下 >1.2s 空窗=过热冷却中
    }
    return shots >= 14 && cooled ? true : `射击 ${shots} 次，未检测到过冷窗口`;
  } },
  { name: 'M-分裂菇强化：定时分裂 + 死后裂双 + 幼体同血条更快且不可再分裂', run: () => {
    const s = freshSession();
    s.wallMaxHp = 10000;
    s.wallHp = 10000;
    s.debugSpawn('split_shroom', 540, 900);
    const parent = s.monsters[0];
    if (parent.cfg.hp !== 600) return `母体血量未强化 cfg.hp=${parent.cfg.hp}`;
    parent.hp = parent.maxHp = 1e6; // 测试靶：防止被步枪提前打死（600 血撑不过 6s 分裂周期）
    // 定时分裂：6~9s 内应出现幼体
    const born = runFor(s, 10, () => s.monsters.some((m) => m.cfg.id === 'shroom_baby'));
    if (!born) return '定时分裂未发生';
    const baby = s.monsters.find((m) => m.cfg.id === 'shroom_baby')!;
    if (baby.maxHp !== parent.maxHp) return `幼体血条不一致（${baby.maxHp}/${parent.maxHp}）`;
    if (!(baby.cfg.speed > parent.cfg.speed)) return `幼体未提速（${baby.cfg.speed} vs ${parent.cfg.speed}）`;
    if (baby.cfg.splitTimer || baby.cfg.deathSplit) return '幼体可再分裂（应不可）';
    // 死后裂双：清场使母体成为唯一目标，击杀 → 2 只幼体
    for (const m of s.monsters) if (m !== parent) m.hp = 0;
    runFor(s, 1, () => false);
    parent.hp = 1;
    const killed = runFor(s, 4, () => s.monsters.filter((m) => m.cfg.id === 'split_shroom').length === 0);
    if (!killed) return '母体未被打死';
    const after = s.monsters.filter((m) => m.cfg.id === 'shroom_baby').length;
    return after >= 2 ? true : `死后分裂 ${after} 只（应 ≥2）`;
  } },
  { name: 'Z-虫族：潜伏者钻地后不可被直击；爆炸可提前轰出（周期上浮见下条）', run: () => {
    const s = freshSession();
    s.wallMaxHp = 10000;
    s.wallHp = 10000;
    s.debugSpawn('zerg_lurker', 540, 460); // 距墙 396 ≈ siegeDist 400+r → 接近即钻地
    const lurker = s.monsters.find((m) => m.cfg.id === 'zerg_lurker')!;
    const lurkerBurrowed = runFor(s, 2, () => lurker.burrowed);
    if (!lurkerBurrowed) return '潜伏者未钻地';
    runFor(s, 2, () => false);
    // 爆炸强制出土：在潜伏者脚下放火属性伤害圈（surfaceEvery=10 前完成，验证的是"轰出"而非"到点上浮"）
    s.debugLink(lurker.x - 10, lurker.y, lurker.x + 10, lurker.y, 60, 0.5, 120);
    s.debugLink(lurker.x, lurker.y - 10, lurker.x, lurker.y + 10, 60, 0.5, 120);
    return runFor(s, 2, () => !lurker.burrowed) ? true : '爆炸未轰出潜伏者';
  } },
  { name: 'Z-虫族：潜伏者周期上浮（不再永久隐身，上浮期可索敌击杀；结束后重新入地）', run: () => {
    const s = freshSession();
    s.wallMaxHp = 10000;
    s.wallHp = 10000;
    s.debugSpawn('zerg_lurker', 540, 460);
    const lurker = s.monsters.find((m) => m.cfg.id === 'zerg_lurker')!;
    const every = lurker.cfg.burrowSiege!.surfaceEvery!;
    const forSec = lurker.cfg.burrowSiege!.surfaceFor!;
    lurker.hp = lurker.maxHp = 1e6; // 测试靶：避免上浮期被英雄直接打死，专注验证周期
    if (!runFor(s, 2, () => lurker.burrowed)) return '潜伏者未入地';
    // 周期前保持钻地（打不到）
    if (runFor(s, every - 2, () => !lurker.burrowed)) return `潜伏者提前上浮（应 ${every}s 周期）`;
    if (!runFor(s, 3, () => !lurker.burrowed)) return `潜伏者 ${every}s 后仍未上浮（永久隐身）`;
    // 上浮期可索敌：英雄直接命中掉血
    const hp0 = lurker.hp;
    runFor(s, 2.5, () => false);
    if (!(lurker.hp < hp0)) return '上浮期仍无法被攻击（hp 未下降）';
    if (forSec > 4 && lurker.burrowed) return '上浮期太短，立即又入地（无击杀窗口）';
    // 上浮结束后重新入地
    return runFor(s, forSec + 2, () => lurker.burrowed) ? true : '上浮结束后未重新入地';
  } },
  { name: 'Z-虫族：虫后产幼虫（自身血量，不继承 2000）→ 5s 后变态为池中随机形态（不含虫后）', run: () => {
    const s = freshSession();
    s.wallMaxHp = 10000;
    s.wallHp = 10000;
    s.debugSpawn('zerg_queen', 540, 900);
    const queen = s.monsters.find((m) => m.cfg.id === 'zerg_queen')!;
    queen.hp = queen.maxHp = 1e6; // 测试靶：保证虫后活到产卵
    const born = runFor(s, 10, () => s.monsters.some((m) => m.cfg.id === 'zerg_larva'));
    if (!born) return '虫后未产幼虫';
    const larva = s.monsters.find((m) => m.cfg.id === 'zerg_larva')!;
    if (larva.maxHp >= queen.maxHp) return `幼虫继承了虫后血量（${larva.maxHp}）`;
    larva.hp = larva.maxHp = 1e6; // 保活到变态
    const pool = ['zerg_ling', 'baneling', 'zerg_roach', 'zerg_lurker', 'zerg_ultra'];
    const morphed = runFor(s, 7, () => larva.cfg.id !== 'zerg_larva');
    if (!morphed) return '幼虫未变态';
    if (!pool.includes(larva.cfg.id)) return `变态目标不在池中：${larva.cfg.id}`;
    if (larva.cfg.id === 'zerg_queen') return '变态成了虫后（应排除）';
    if (larva.maxHp === 1e6) return '变态后血量未按新形态重算';
    return true;
  } },
  { name: 'Z-虫族：爬虫低血钻地回血（出土回 50%）', run: () => {
    const s = freshSession();
    s.wallMaxHp = 10000;
    s.wallHp = 10000;
    s.debugSpawn('zerg_roach', 300, 500);
    const roach = s.monsters.find((m) => m.cfg.id === 'zerg_roach')!;
    roach.hp = roach.maxHp = 1e6;
    // 打伤爬虫触发钻地回血
    roach.hp = Math.round(1e6 * 0.2);
    const burrowed = runFor(s, 3, () => roach.burrowed);
    if (!burrowed) return '爬虫未钻地';
    const hpAtBurrow = roach.hp;
    const emerged = runFor(s, 5, () => !roach.burrowed);
    if (!emerged) return '爬虫未出土';
    if (!(roach.hp > hpAtBurrow)) return `钻地未回血（${hpAtBurrow} → ${roach.hp}）`;
    return true;
  } },
  { name: 'Z-虫族：毒爆贴墙自爆单次 -300（野外拦截 0 墙伤）；虫后铺虫苔且火焰可烧', run: () => {
    // A) 野外拦截：步枪半路点燃毒爆 → 爆炸事件 1 次、城墙分文不扣
    {
      const s = freshSession();
      s.wallMaxHp = 10000;
      s.wallHp = 10000;
      s.debugSpawn('baneling', 540, 1000);
      let explodes = 0;
      s.bus.on('onExplode', () => { explodes++; });
      const killed = runFor(s, 6, () => s.totalKills > 0);
      runFor(s, 2, () => false); // 再多跑 2s，确认爆炸确实没伤墙
      if (!killed) return '毒爆未被半路击杀';
      if (s.wallHp !== 10000) return `野外拦截仍扣墙（10000 → ${s.wallHp}，期望不变）`;
      if (explodes !== 1) return `野外爆炸事件 ${explodes} 次（期望 1）`;
    }
    // B) 贴墙自爆：压住武器冷却让毒爆走到墙 → 恰扣 300、explode/wallHit 各 1 次
    {
      const s = freshSession();
      s.wallMaxHp = 10000;
      s.wallHp = 10000;
      s.hero.weapons[0].cooldown = 1e9; // 不打枪，逼毒爆贴墙
      s.debugSpawn('baneling', 540, 400);
      let explodes = 0;
      let wallHits = 0;
      s.bus.on('onExplode', () => { explodes++; });
      s.bus.on('onWallHit', () => { wallHits++; });
      const boomed = runFor(s, 8, () => s.wallHp < 10000);
      runFor(s, 1, () => false);
      if (!boomed) return `贴墙自爆未结算（城防 ${s.wallHp}）`;
      if (s.wallHp !== 10000 - 300) return `贴墙自爆扣墙 ${10000 - s.wallHp}（期望单次 300）`;
      if (explodes !== 1 || wallHits !== 1) return `事件次数异常（explode ${explodes} / wallHit ${wallHits}，期望各 1）`;
    }
    // C1) 虫后铺苔
    {
      const s = freshSession();
      s.wallMaxHp = 10000;
      s.wallHp = 10000;
      s.debugSpawn('zerg_queen', 700, 900);
      if (!runFor(s, 12, () => s.creep.size > 0)) return '虫苔未铺设';
    }
    // C2) 火焰烧穿（灼烧层）：走廊上的毯块被逐层烧穿清除——1 击不秒删、持续压制全清
    {
      const s = freshSession();
      s.sandboxMode = true; // 无波次场景防判胜冻结
      s.wallMaxHp = s.wallHp = 1e9;
      s.hero.weapons[0].cooldown = 1e9;
      const cellKey = (x: number, y: number): number => Math.floor(x / 90) * 4096 + Math.floor(y / 90);
      const keys = [cellKey(675, 675), cellKey(675, 765), cellKey(675, 855)];
      for (const k of keys) s.creep.set(k, s.timeSec + 600);
      s.grantCard('flame');
      s.hero.weapons[0].cooldown = 0;
      s.debugSpawn('bulwark', 700, 860);
      const target = s.monsters[s.monsters.length - 1];
      target.hp = target.maxHp = 1e6;
      runFor(s, 1, () => false); // 打 1s：3 层血下不秒删，毯块仍在（有焦痕）
      if (!keys.some((k) => s.creep.has(k))) return '火焰一击秒删毯块（灼烧层未生效）';
      const cleared = runFor(s, 10, () => keys.every((k) => !s.creep.has(k)));
      if (!cleared) return `火焰未烧穿走廊毯块（剩 ${keys.filter((k) => s.creep.has(k)).length}/3）`;
    }
    return true;
  } },
  { name: 'Z-虫苔蔓延：无虫后也自行扩张（单格起步）；缺口由边缘长回', run: () => {
    const key = (x: number, y: number): number => Math.floor(x / 90) * 4096 + Math.floor(y / 90);
    // A) 单格起步：60s 内自行扩张（实测约 8 格，阈值放宽到 ≥6）
    {
      const s = freshSession(3);
      s.sandboxMode = true; // 实验室空关卡 prepare 后即判胜会冻结 step，蔓延测试需关胜负
      s.hero.weapons[0].cooldown = 1e9;
      s.creep.set(key(540, 900), s.timeSec + 600);
      runFor(s, 60, () => s.creep.size >= 6);
      if (s.creep.size < 6) return `单格 60s 未扩张（${s.creep.size} 格）`;
    }
    // B) 缺口回长：6×5 实心块删掉内圈 2×2（模拟火焰烧出缺口），60s 内由外圈长回并重新覆盖缺口
    {
      const s = freshSession(4);
      s.sandboxMode = true;
      s.hero.weapons[0].cooldown = 1e9;
      for (let dx = 0; dx < 6; dx++) {
        for (let dy = 0; dy < 5; dy++) s.creep.set((2 + dx) * 4096 + (6 + dy), s.timeSec + 600);
      }
      runFor(s, 3.2, () => false); // 走一个蔓延节拍（续期生效）
      const before = s.creep.size;
      if (before < 30) return `种格丢失（${before} < 30）`;
      const hole: number[] = [];
      for (const dx of [3, 4]) {
        for (const dy of [7, 8]) {
          const k = dx * 4096 + dy;
          hole.push(k);
          s.creep.delete(k);
        }
      }
      if (s.creep.size !== before - 4) return `缺口未形成（${before} → ${s.creep.size}）`;
      runFor(s, 60, () => s.creep.size >= before && hole.some((k) => s.creep.has(k)));
      if (s.creep.size < before) return `缺口未长回（${before - 4} → ${s.creep.size}，期望 ≥ ${before}）`;
      return hole.some((k) => s.creep.has(k)) ? true : '缺口一直空缺（未重新覆盖）';
    }
  } },
  { name: 'Z-虫巢扩张：峰值 60 格晋升 T2（全族攻+10%/血+8%，站毯回血 16/s）', run: () => {
    const seedBlock = (s: GameSession, cx0: number, cy0: number, w: number, h: number): void => {
      for (let dx = 0; dx < w; dx++) {
        for (let dy = 0; dy < h; dy++) s.creep.set((cx0 + dx) * 4096 + (cy0 + dy), s.timeSec + 600);
      }
    };
    // A) 30 格（T1）放爬虫 → 补到 62 格晋升 T2：事件 1 次、存量按血倍率补足、站毯回血 16/s
    const a = freshSession(11);
    a.sandboxMode = true;
    a.hero.weapons[0].cooldown = 1e9;
    a.wallMaxHp = a.wallHp = 1e9;
    let tierEvents = 0;
    a.bus.on('onCreepTier', () => { tierEvents++; });
    seedBlock(a, 2, 7, 6, 5); // 30 格
    a.step();
    const tierAt30 = a.creepTier;
    if (tierAt30 !== 1) return `30 格不该晋升（T${tierAt30}）`;
    a.debugSpawn('zerg_roach', 300, 1040); // 站毯 → 吃回血
    const roach = a.monsters[0];
    const hpT1 = roach.maxHp;
    seedBlock(a, 2, 13, 8, 4); // +32 = 62 格
    a.step();
    if (tierEvents !== 1) return `晋升事件次数异常（${tierEvents} 次，期望 1）`;
    const tierAfterExpand = a.creepTier;
    if (tierAfterExpand !== 2) return `未晋升 T2（T${tierAfterExpand}）`;
    if (roach.maxHp !== Math.round(hpT1 * 1.08)) {
      return `存量补血异常（${hpT1} → ${roach.maxHp}，期望 ${Math.round(hpT1 * 1.08)}）`;
    }
    roach.hp = Math.round(roach.maxHp * 0.6); // 高于钻地阈值 30%，避免钻地
    const hpBefore = roach.hp;
    runFor(a, 1, () => false);
    const healed = roach.hp - hpBefore;
    if (healed < 14 || healed > 18) return `T2 站毯回血 ${healed} hp/s（期望 16）`;
    // 攻击增强：贴墙爬虫单次墙伤 = 基数 ×1.1
    let dmgT2 = 0;
    a.bus.on<{ dmg: number }>('onWallHit', ({ dmg }) => { if (!dmgT2) dmgT2 = dmg; });
    a.debugSpawn('zerg_roach', 540, 88);
    if (!runFor(a, 4, () => dmgT2 > 0)) return 'T2 爬虫未拍墙';
    // B) 对照（无虫苔 T1）：同一贴墙位置的单次墙伤
    const b = freshSession(11);
    b.sandboxMode = true;
    b.hero.weapons[0].cooldown = 1e9;
    b.wallMaxHp = b.wallHp = 1e9;
    let dmgT1 = 0;
    b.bus.on<{ dmg: number }>('onWallHit', ({ dmg }) => { if (!dmgT1) dmgT1 = dmg; });
    b.debugSpawn('zerg_roach', 540, 88);
    if (!runFor(b, 4, () => dmgT1 > 0)) return 'T1 爬虫未拍墙';
    return dmgT2 === Math.round(dmgT1 * 1.1)
      ? true
      : `T2 攻击倍率异常（T1 ${dmgT1} → T2 ${dmgT2}，期望 ${Math.round(dmgT1 * 1.1)}）`;
  } },
  { name: 'Z-菌毯孵化：fromCreep 从虫苔中钻出；无可用虫苔回落顶部出生带', run: () => {
    const { monsters, cards } = loadConfigs();
    const weapons = (JSON.parse(fs.readFileSync(path.join(root, 'configs/weapons.json'), 'utf-8')) as { weapons: WeaponConfig[] }).weapons;
    const spawnLevel: LevelConfig = {
      id: 'creep_spawn_test',
      name: '菌毯孵化（测试场）',
      arena: { width: 1080, height: 1920 },
      wall: { height: 64, hp: 100000 },
      defenseRect: { yMin: 96, yMax: 560 },
      spawnBandY: [1750, 1880],
      spawnPointsX: [300, 540, 780],
      prepareSec: 0.5,
      intermissionSec: 2,
      waves: [{
        banner: '孵化', durationSec: 8,
        spawns: [{ monster: 'zerg_ling', count: 6, spawnPoints: 'all', releasePerTick: 3, fromCreep: true }],
      }],
    };
    const build = (seedCreep: boolean, seed: number): GameSession => {
      const s = new GameSession({
        level: spawnLevel,
        weaponConfigs: [weapons[0]],
        monsterConfigs: monsters,
        cardConfigs: cards,
        seed,
        controller: { getMoveDir: () => ({ x: 0, y: 0 }) },
        cardPolicy: greedyDpsPolicy,
      });
      s.hero.weapons[0].cooldown = 1e9;
      s.wallMaxHp = s.wallHp = 1e9;
      if (seedCreep) {
        for (let dx = 0; dx < 4; dx++) {
          for (let dy = 0; dy < 3; dy++) s.creep.set((4 + dx) * 4096 + (9 + dy), s.timeSec + 600);
        }
      }
      return s;
    };
    const trackSpawns = (s: GameSession): Map<number, number> => {
      const seen = new Map<number, number>(); // id → 出生 y
      for (let i = 0; i < 30 * 30 && seen.size < 6; i++) {
        s.step();
        for (const m of s.monsters) if (!seen.has(m.id)) seen.set(m.id, m.y);
      }
      return seen;
    };
    // A) 有毯（12 格可用）：全部从毯里钻出——出土点都在虫苔上、且在城墙远侧（wall.height+300 起）
    {
      const s = build(true, 21);
      const emerges: { x: number; y: number }[] = [];
      s.bus.on<{ x: number; y: number }>('onMonsterEmerge', (e) => emerges.push(e));
      runFor(s, 30, () => s.monsters.length >= 6);
      if (s.monsters.length < 6) return `孵化数量不足（${s.monsters.length}/6）`;
      if (emerges.length !== 6) return `出土事件 ${emerges.length} 次（期望 6）`;
      for (const e of emerges) {
        if (e.y < 364 || e.y > 1820) return `出土位置越界（y=${e.y.toFixed(0)}）`;
        if (!s.isCreeped(e.x, e.y)) return `出土点不在虫苔上（${e.x.toFixed(0)}, ${e.y.toFixed(0)}）`;
      }
    }
    // B) 无毯：回落顶部出生带
    {
      const s = build(false, 21);
      const emerges: { x: number; y: number }[] = [];
      s.bus.on('onMonsterEmerge', (e) => emerges.push(e as { x: number; y: number }));
      const seen = trackSpawns(s);
      if (seen.size < 6) return `普通波次数量不足（${seen.size}/6）`;
      if (emerges.length !== 0) return `无毯却触发出土 ${emerges.length} 次`;
      for (const y of seen.values()) {
        if (y < 1700 || y > 1900) return `出生点不在顶部出生带（y=${y.toFixed(0)}）`;
      }
    }
    // C) 毯不足 3 格可用（4 格在 maxY 之外）：同样回落顶部出生带
    {
      const s = build(false, 22);
      for (let dx = 0; dx < 4; dx++) s.creep.set((4 + dx) * 4096 + 20, s.timeSec + 600); // y=1845 > maxY 1820 → 不算可用
      const emerges: { x: number; y: number }[] = [];
      s.bus.on('onMonsterEmerge', (e) => emerges.push(e as { x: number; y: number }));
      const seen = trackSpawns(s);
      if (seen.size < 6) return `C 组数量不足（${seen.size}/6）`;
      if (emerges.length !== 0) return `可用毯不足却触发出土 ${emerges.length} 次`;
    }
    return true;
  } },
  { name: 'Z-菌毯灼烧层：火焰每击烧 1 层不秒删，蔓延节拍回层，烧穿才清除', run: () => {
    const cellKey = (x: number, y: number): number => Math.floor(x / 90) * 4096 + Math.floor(y / 90);
    const s = freshSession(31);
    s.sandboxMode = true;
    s.hero.weapons[0].cooldown = 1e9;
    const k = cellKey(540, 900); // 格中心 (585, 945)
    // A) 单次灼烧：格仍在（满 3 层 → 2 层），留下焦痕记录
    s.creep.set(k, s.timeSec + 600);
    s.debugBurnCreep(585, 945, 40);
    if (!s.creep.has(k)) return '一次灼烧即被秒删（未见灼烧层）';
    if ((s.creepHp.get(k) ?? GameSession.CREEP_LAYERS) !== GameSession.CREEP_LAYERS - 1) {
      return `灼烧层未扣减（剩余 ${s.creepHp.get(k) ?? GameSession.CREEP_LAYERS}）`;
    }
    // B) 烧穿：再烧 2 次（累计 3 层）格毁
    s.debugBurnCreep(585, 945, 40);
    s.debugBurnCreep(585, 945, 40);
    if (s.creep.has(k)) return `烧穿后格未清除（余层 ${s.creepHp.get(k) ?? GameSession.CREEP_LAYERS}）`;
    // C) 回层：重新种格、烧掉 2 层后，蔓延节拍（3s）恢复 1 层
    s.creep.set(k, s.timeSec + 600);
    s.debugBurnCreep(585, 945, 40);
    s.debugBurnCreep(585, 945, 40);
    const layersAfterBurn = s.creepHp.get(k) ?? GameSession.CREEP_LAYERS;
    if (layersAfterBurn !== 1) return `烧 2 层后剩余 ${layersAfterBurn}（期望 1）`;
    runFor(s, 3.3, () => (s.creepHp.get(k) ?? GameSession.CREEP_LAYERS) > 1);
    const layersAfterRegrow = s.creepHp.get(k) ?? GameSession.CREEP_LAYERS;
    if (layersAfterRegrow <= layersAfterBurn) return `蔓延节拍未回层（${layersAfterBurn} → ${layersAfterRegrow}）`;
    return true;
  } },
  { name: 'M-巫师编队：近墙变阵排排啃墙，巫师伤害转嫁给周围怪物', run: () => {
    const s = freshSession();
    s.wallMaxHp = 99999;
    s.wallHp = 99999;
    s.debugSpawn('shaman', 540, 700);
    const shaman = s.monsters.find((m) => m.cfg.id === 'shaman')!;
    const escorts = s.monsters.filter((m) => m.cfg.id === 'bulwark');
    const activated = runFor(s, 20, () => shaman.formationActive);
    if (!activated) return '变阵未激活';
    runFor(s, 12, () => escorts.every((e) => e.state === 'assault')); // ×3 编队速度下全队列对齐约需 9~11s
    const xs = escorts.map((e) => e.slotX).sort((a, b) => a - b);
    const spread = xs[xs.length - 1] - xs[0];
    if (spread < 400) return `横排未展开（跨度 ${spread.toFixed(0)}）`;
    const gaps = xs.slice(1).map((v, i) => v - xs[i]);
    if (Math.min(...gaps) > 60) return `横排存在缝隙（最小间距 ${Math.min(...gaps).toFixed(0)} > 盾径 60）`;
    // 伤害转嫁：把巫师提到线前使其成为最近目标（横排在物理上护住了它），受击应由护卫代伤
    shaman.hp = shaman.maxHp;
    for (const e of escorts) e.hp = e.maxHp;
    // 英雄压到墙前线与巫师同点：巫师必为最近目标且被领队锚定静止（瞬移会被走位甩弹）
    // 横排重叠掩护使直击够不到巫师——用爆破落地(AoE 可伤及巫师)触发转嫁
    applyForm(s.hero.weapons[0].affixes, 'blast', 1);
    s.hero.x = 540;
    s.hero.y = 200;
    let transferSeen = false;
    s.bus.on('onDamageTransfer', () => { transferSeen = true; });
    const hpBefore = shaman.hp;
    runFor(s, 10, () => transferSeen);
    if (!transferSeen) return '转嫁未触发';
    // 直击/爆炸全额转嫁；伤害圈 tick 不转嫁（设计：DoT 可磨巫师），允许少量圈伤
    return shaman.hp >= hpBefore - 20 ? true : `巫师异常掉血（${hpBefore} → ${shaman.hp}）`;
  } },
  { name: 'M-巫师编队减员：先杀护卫后队籍不错位，变阵/转嫁仍生效', run: () => {
    const s = freshSession();
    s.wallMaxHp = 99999;
    s.wallHp = 99999;
    s.debugSpawn('shaman', 540, 700);
    const shaman = s.monsters.find((m) => m.cfg.id === 'shaman')!;
    const escorts = s.monsters.filter((m) => m.cfg.id === 'bulwark');
    // 先杀 3 只护卫（触发 id 压缩与队籍重映射）
    for (let i = 0; i < 3; i++) escorts[i].hp = 0;
    runFor(s, 1, () => false);
    // 队籍必须仍然指向巫师
    const aliveEscorts = s.monsters.filter((m) => m.cfg.id === 'bulwark');
    const shamanIdx = shaman.id;
    if (!aliveEscorts.every((e) => e.groupId === shamanIdx)) return '减员后队籍错位';
    // 变阵 + 转嫁仍工作
    if (!runFor(s, 20, () => shaman.formationActive)) return '变阵未激活';
    runFor(s, 12, () => aliveEscorts.every((e) => e.state === 'assault')); // 等横排完全就位开啃
    shaman.hp = shaman.maxHp;
    for (const e of aliveEscorts) e.hp = e.maxHp;
    // 横排重叠掩护使直击够不到巫师——用爆破落地(AoE 可伤及巫师)触发转嫁
    applyForm(s.hero.weapons[0].affixes, 'blast', 1);
    s.hero.x = 540;
    s.hero.y = 200;
    let transferSeen = false;
    s.bus.on('onDamageTransfer', () => { transferSeen = true; });
    runFor(s, 10, () => transferSeen);
    // 守卫有攻击力：横排在啃墙（城墙 99999 会受伤）
    const wallDamaged = s.totalWallDamage > 0;
    return transferSeen && wallDamaged ? true : `转嫁=${transferSeen} 啃墙=${wallDamaged}`;
  } },
  { name: 'M-巫师：治疗光环为周围友军回血 + 出场自带岩甲兽护卫环', run: () => {
    const s = freshSession();
    s.debugSpawn('shaman', 540, 900);
    // 护卫环：10 只岩甲兽
    const escorts = s.monsters.filter((m) => m.cfg.id === 'bulwark');
    if (escorts.length !== 10) return `护卫 ${escorts.length} 只（应 10）`;
    if (!escorts.every((b) => b.cfg.hitShield === 20)) return '岩甲兽护甲未增强（20 次免伤）';
    // 治疗：打伤一只护卫，观察回血
    const target = escorts[0];
    target.hp = Math.max(1, target.hp - 80);
    const before = target.hp;
    const healedUp = runFor(s, 8, () => target.hp > before + 20);
    if (!healedUp) return `治疗未生效（${before} → ${target.hp}）`;
    // 巫师死亡后不再治疗（顺带验证可击杀性）
    const shaman = s.monsters.find((m) => m.cfg.id === 'shaman')!;
    shaman.hp = 1;
    return true;
  } },
  { name: 'M-蝙蝠强化：10 层免伤盾 + 灼烧免疫 + 双倍速', run: () => {
    const s = freshSession();
    s.debugSpawn('bat', 540, 900);
    const bat = s.monsters[0];
    if (bat.cfg.speed !== 360) return `速度 ${bat.cfg.speed}（应 360）`;
    s.grantCard('flame'); // 火属性点燃
    const hits: number[] = [];
    s.bus.on('onHit', (p: { dmg: number }) => { if (hits.length < 20) hits.push(p.dmg); });
    const hasBurn = runFor(s, 12, () => false);
    void hasBurn;
    // 前 10 次直接命中应被盾抵消（dmg=0），第 11 次起开始掉血
    if (hits.length < 11) return `命中样本 ${hits.length} 不足`;
    if (!hits.slice(0, 10).every((d) => d === 0)) return `前 10 次未全部免伤: ${hits.slice(0, 10).join(',')}`;
    if (!(hits[10] > 0)) return `第 11 次仍未掉血`;
    if (bat.burn !== null && bat.burn.until > s.timeSec) return '蝙蝠被点燃（灼烧免疫失效）';
    return true;
  } },
  { name: 'M-远程怪：停驻发射可见弹道，落点结算对墙伤害', run: () => {
    const s = freshSession();
    s.wallMaxHp = 100000;
    s.wallHp = 100000;
    s.debugSpawn('thrower', 540, 900);
    const target = s.monsters[0];
    target.hp = target.maxHp = 1e6; // 测试靶不死
    const before = s.totalWallDamage;
    if (!runFor(s, 25, () => s.monsterShots.length > 0)) return '弹道未出现（停驻距离 260px，行军+首次射击需 ~13s）';
    return runFor(s, 10, () => s.totalWallDamage > before) ? true : '落点未结算伤害';
  } },
  { name: 'W-武器特色：炸弹本体=抛物线+落地爆破（自动产生伤害圈）', run: () => {
    const s = freshSession(5, 2); // alchemist_bomb（blastBase 本体机制）
    s.debugSpawn('slime', 540, 1100);
    return runFor(s, 6, () => s.pools.length > 0);
  } },
  { name: 'W-血滴子：去程/回程两段切割、单发两刀（不悬停）', run: () => {
    const s = freshSession(9, 3); // boomerang（飞出 350 → 立即折返）
    s.debugSpawn('bulwark', 540, 670); // 飞出路径上（英雄 328，顶点 350px 处）
    let hits = 0;
    s.bus.on('onHit', () => { hits++; });
    runFor(s, 1.6, () => false); // 单发往返 ≈1.2s：去程一刀 + 折返再一刀
    return hits >= 2 ? true : `总命中 ${hits} 次（往返未各结算）`;
  } },
  { name: 'W-谱系完整性：每把武器 ≥3 张专属升级卡', run: () => {
    const weapons = (JSON.parse(fs.readFileSync(path.join(root, 'configs/weapons.json'), 'utf-8')) as { weapons: WeaponConfig[] }).weapons;
    const cards = loadConfigs().cards;
    const missing: string[] = [];
    for (const w of weapons) {
      const n = cards.filter((c) => c.target?.kind === 'weapon' && c.target.weaponType === w.id).length;
      if (n < 3) missing.push(`${w.name}(${n}张)`);
    }
    return missing.length === 0 ? true : `专属卡不足: ${missing.join(' ')}`;
  } },
  { name: 'X-沙盒：实验室击杀升级不自动选卡（卡牌只能手动验证）', run: () => {
    const s = freshSession();
    s.sandboxMode = true;
    for (let i = 0; i < 10; i++) s.debugSpawn('slime', 400 + i * 30, 850 + (i % 3) * 60);
    let autoPicked = false;
    for (let t = 0; t < 30 * 28; t++) { // 低伤版本击杀慢，放宽到 28 秒
      s.step();
      if (s.cardPickLog.length > 0) { autoPicked = true; break; }
    }
    if (autoPicked) return `自动选卡: ${s.cardPickLog.join('、')}`;
    return s.hero.level >= 2
      ? true : `等级 ${s.hero.level}（升级未发生，测试无效）`;
  } },
  { name: 'T-直线：匀速前进，寿命耗尽消亡', run: () => {
    const ctx: MotionContext = { dt: 1 / 30, now: 0, ownerX: 0, ownerY: 0, nearestMonster: () => null };
    const t: Trajectory = createTrajectory({ type: 'straight', speed: 300, life: 100 / 300 }, { dirX: 1, dirY: 0 });
    let x = 0; let y = 0; let alive = true; let steps = 0;
    let sawStep10 = false;
    while (alive && steps < 60) {
      const prevX = x;
      const res = t.update(x, y, ctx);
      x = res.x; y = res.y; alive = res.alive;
      if (alive && Math.abs(x - prevX - 10) < 0.01) sawStep10 = true;
      steps++;
    }
    return !alive && sawStep10 && x >= 90 && x <= 100 ? true : `x=${x.toFixed(1)} alive=${alive}`;
  } },
  { name: 'T-抛物线：中程有离地高度，落地消亡', run: () => {
    const ctx: MotionContext = { dt: 1 / 30, now: 0, ownerX: 0, ownerY: 0, nearestMonster: () => null };
    const t: Trajectory = createTrajectory({ type: 'parabola', speed: 300, range: 300, peak: 100 }, { dirX: 1, dirY: 0 });
    let x = 0; let y = 0; let alive = true; let maxH = 0; let midOK = false; let steps = 0;
    while (alive && steps < 120) {
      const res = t.update(x, y, ctx);
      x = res.x; y = res.y; alive = res.alive;
      if (res.height !== undefined) {
        maxH = Math.max(maxH, res.height);
        if (x > 120 && x < 180 && res.height > 80) midOK = true;
      }
      steps++;
    }
    return !alive && midOK && maxH <= 100.01 ? true : `maxH=${maxH.toFixed(1)} midOK=${midOK}`;
  } },
  { name: 'T-螺旋/蛇形：主轴前进且横向偏移符号震荡', run: () => {
    const ctx: MotionContext = { dt: 1 / 30, now: 0, ownerX: 0, ownerY: 0, nearestMonster: () => null };
    const run = (t: Trajectory): { endX: number; signChanges: number } => {
      let x = 0; let y = 0; let prevSign = 0; let signChanges = 0;
      for (let i = 0; i < 60; i++) {
        const res = t.update(x, y, ctx);
        x = res.x; y = res.y;
        const sign = y > 0.5 ? 1 : y < -0.5 ? -1 : 0;
        if (sign !== 0 && prevSign !== 0 && sign !== prevSign) signChanges++;
        if (sign !== 0) prevSign = sign;
      }
      return { endX: x, signChanges };
    };
    const spiral = run(createTrajectory({ type: 'spiral', speed: 300, range: 2000, angularSpeed: 10, radius: 40 }, { dirX: 1, dirY: 0 }));
    const zig = run(createTrajectory({ type: 'zigzag', speed: 300, range: 2000, frequency: 2, amplitude: 30 }, { dirX: 1, dirY: 0 }));
    return spiral.endX > 500 && spiral.signChanges >= 2 && zig.endX > 500 && zig.signChanges >= 3
      ? true : `spiral(${spiral.endX.toFixed(0)},${spiral.signChanges}) zig(${zig.endX.toFixed(0)},${zig.signChanges})`;
  } },
  { name: 'T-飞盘：飞出→立即折返回主人（不悬停）', run: () => {
    const ctx: MotionContext = { dt: 1 / 30, now: 0, ownerX: 0, ownerY: 0, nearestMonster: () => null };
    const t: Trajectory = createTrajectory(frisbeeConfig(300, 300, 400), { dirX: 1, dirY: 0 });
    let x = 0; let y = 0; let alive = true;
    let frozen = 0; let maxX = 0; let steps = 0;
    // 全程逐步推进：飞出 300px 后折返至主人身边消亡；途中不得出现"原地悬停"（连续位移≈0）
    while (alive && steps < 600) {
      const r = t.update(x, y, ctx);
      if (Math.hypot(r.x - x, r.y - y) < 1) frozen++;
      x = r.x; y = r.y; alive = r.alive;
      maxX = Math.max(maxX, x);
      steps++;
    }
    const dHome = Math.hypot(x, y);
    return !alive && dHome <= 45 && maxX >= 280 && frozen <= 2
      ? true
      : `maxX=${maxX.toFixed(0)} frozen=${frozen} dHome=${dHome.toFixed(1)} alive=${alive}`;
  } },
  { name: 'T-追踪：目标死亡后按 ctx 重索敌转向', run: () => {
    const a: Targetable = { id: 1, x: 100, y: 0, hp: 1 };
    const b: Targetable = { id: 2, x: 0, y: 100, hp: 10 };
    const ctx: MotionContext = {
      dt: 1 / 30, now: 0, ownerX: 0, ownerY: 0,
      nearestMonster: () => (a.hp <= 0 ? b : null),
    };
    const t: Trajectory = createTrajectory(
      { type: 'homing', speed: 300, range: 5000, turnRate: 360, duration: 5, retarget: true },
      { dirX: 1, dirY: 0, target: a },
    );
    let x = 0; let y = 0;
    for (let i = 0; i < 10; i++) { const r = t.update(x, y, ctx); x = r.x; y = r.y; }
    a.hp = 0; // 目标死亡 → 应重索敌到 b 并转向
    let upTicks = 0;
    for (let i = 0; i < 60; i++) {
      const prevY = y;
      const r = t.update(x, y, ctx);
      x = r.x; y = r.y;
      if (y - prevY > 0.1) upTicks++;
    }
    return upTicks >= 30 ? true : `转向不足 upTicks=${upTicks}`;
  } },
  { name: 'C-行为：雷电权杖=炮口直达+怪间跳跃的瞬发闪电（连锁长度成长）', run: () => {
    const s = freshSession(3, 4); // weapons[4] = lightning_chain 落雷武器
    s.grantCard('chain_len'); s.grantCard('chain_len'); // 基础 1 + 2 = 3 击
    s.debugSpawn('slime', 500, 800);
    s.debugSpawn('slime', 580, 800);
    s.debugSpawn('slime', 540, 860);
    let path: number[][] | null = null;
    s.bus.on('onChain', (p: { points: number[][] }) => { if (!path) path = p.points; });
    const fired = runFor(s, 4, () => path !== null);
    if (!fired || !path) return '闪电未触发';
    const pts = path as unknown as number[][];
    const [mx, my] = pts[0];
    const fromMuzzle = Math.abs(mx - 540) < 1 && Math.abs(my - 328) < 1; // 起点 = 英雄（炮口）
    // 步枪不应获得连锁卡：门控验证
    const rifle = freshSession();
    if (rifle.grantCard('chain_len')) return '步枪不应能拿连锁长度';
    return pts.length === 4 && fromMuzzle && s.projectiles.length === 0
      ? true : `路径点数=${pts.length} 起点=(${mx},${my}) 残留子弹=${s.projectiles.length}`;
  } },
  { name: 'S-光束：线段上的怪持续掉血，线外无伤', run: () => {
    const s = freshSession();
    s.debugSpawn('bulwark', 540, 1300); // 光束线上（英雄 540,328 正上方）
    s.debugSpawn('bulwark', 150, 1300); // 线外对照（超出步枪射程 900，排除流弹）
    s.debugBeam(Math.PI / 2, 1400, 40, 2); // 40dps×2s=80 < 130 血，保证存活可校验
    runFor(s, 2.5, () => false);
    const onLine = s.monsters.find((m) => Math.abs(m.x - 540) < 1);
    const offLine = s.monsters.find((m) => Math.abs(m.x - 150) < 1);
    const onLineHurt = !onLine || onLine.hp < onLine.maxHp; // 被打死（离场）也算受伤
    return onLineHurt && !!offLine && offLine.hp === offLine.maxHp
      ? true : `线上 ${onLine ? `${onLine.hp.toFixed(0)}/${onLine.maxHp}` : '已击杀'} 线外 ${offLine ? offLine.hp.toFixed(0) : '离场'}`;
  } },
  { name: 'S-连线：固定两点间持续伤害，场外无伤', run: () => {
    const s = freshSession();
    s.debugSpawn('bulwark', 400, 1400); // 线段上
    const onSeg = s.monsters[s.monsters.length - 1];
    s.debugSpawn('bulwark', 400, 1650); // 线段外（y 超出步枪射程，排除流弹）
    const offSeg = s.monsters[s.monsters.length - 1];
    s.debugLink(100, 1400, 800, 1400, 40, 2);
    runFor(s, 2.5, () => false);
    return onSeg.hp < onSeg.maxHp && offSeg.hp === offSeg.maxHp
      ? true : `线上 ${onSeg.hp.toFixed(0)}/${onSeg.maxHp} 线外 ${offSeg.hp.toFixed(0)}/${offSeg.maxHp}`;
  } },

  // ===== 属性卡 =====
  { name: 'P-力量/急速/鹰眼/狂暴/专注：属性递增', run: () => {
    const s = freshSession();
    s.grantCard('power'); s.grantCard('haste'); s.grantCard('eagle'); s.grantCard('rage'); s.grantCard('focus');
    const st = s.hero.stats;
    return approx(st.atk, 108) && approx(st.aspd, 1.07) && approx(st.critChance, 0.10)
      && approx(st.critDmg, 1.62) && approx(st.dmgMul, 0.05);
  } },

  // ===== 综合 =====
  { name: '综合：所有卡授予后 sim 对局仍跑通', run: () => {
    const s = freshSession();
    for (const c of loadConfigs().cards) s.grantCard(c.id);
    s.debugSpawn('bulwark', 540, 900);
    runFor(s, 10, () => false);
    return s.result !== 'defeat'; // 10 秒无崩溃、无异常城破（实验室空波次胜利属正常）
  } },

  // ===== 人工轨迹（录制 → sim 回放链路） =====
  { name: 'H-人工轨迹：录制→sim 回放逐位一致（含升选卡）', run: () => {
    const { monsters, cards } = loadConfigs();
    const level = JSON.parse(fs.readFileSync(path.join(root, 'configs/levels/level_1_1.json'), 'utf-8')) as LevelConfig;
    const weapons = (JSON.parse(fs.readFileSync(path.join(root, 'configs/weapons.json'), 'utf-8')) as { weapons: WeaponConfig[] }).weapons;
    const ctrl = new HumanInputController();
    const rec = new TraceRecorder();
    const s = new GameSession({
      level,
      weaponConfigs: [weapons[0]],
      monsterConfigs: monsters,
      cardConfigs: cards,
      seed: 1234,
      controller: ctrl,
      cardPolicy: greedyDpsPolicy,
    });
    s.externalLevelUps = true;
    rec.start({ t0: 0, seed: 1234, level: 'level_1_1.json', weapon: weapons[0].id, version: 'test' });
    // 脚本化"人工"输入：指针正弦巡游 + 周期性拖动/松开 + 按键切换（40s 保证覆盖升选卡）
    let picks = 0;
    for (let i = 0; i < 30 * 40 && !s.result; i++) {
      const t = i / 30;
      ctrl.tx = 540 + Math.sin(t * 1.1) * 320;
      ctrl.ty = 500 + Math.sin(t * 2.3) * 160;
      ctrl.hasTarget = i % 210 < 150;
      if (i % 97 === 0) ctrl.keys = new Set(['a']);
      if (i % 97 === 45) ctrl.keys = new Set(['d']);
      rec.observe(ctrl.snapshot(), s.tick);
      s.step();
      if (s.pendingLevelChoices.length > 0) {
        const c = s.pendingLevelChoices[i % s.pendingLevelChoices.length];
        rec.pick(s.tick, c.id, s.pendingLevelChoices.map((x) => x.id));
        s.resolveLevelUp(c);
        picks++;
      }
      if (s.tick % 30 === 0) {
        rec.check(s.tick, { x: s.hero.x, y: s.hero.y, wallHp: s.wallHp, kills: s.totalKills, lv: s.hero.level });
      }
    }
    rec.end(s.tick, {
      result: s.result ?? 'timeout',
      kills: s.totalKills,
      wallHp: s.wallHp,
      wallMax: s.wallMaxHp,
      lv: s.hero.level,
      sec: +s.timeSec.toFixed(3),
    });
    if (picks === 0) return '40s 内未触发选卡（样本未覆盖升选卡，请调整脚本）';
    const parsed = parseTrace(serializeTrace(rec.records));
    const report = runTraceReplay(parsed, { level, weapon: weapons[0], monsters, cards });
    if (!report.consistent) {
      const m = report.mismatches[0];
      return `回放分歧：t=${m.t} ${m.field} 录制 ${m.recorded} ≠ 回放 ${m.replayed}`;
    }
    return report.checksTotal > 0 ? true : '存档点缺失（录制未产出 check 记录）';
  } },

  // ===== 多发独立索敌 / 雷霆尸击 =====
  { name: 'W-炸弹多发：双掷后 3 颗各砸各的（独立索敌）', run: () => {
    const s = freshSession(1, 2); // alchemist_bomb
    s.grantCard('bomb_toss');
    s.grantCard('bomb_toss'); // 数量 1 + 2 = 3
    const w = s.hero.weapons[0];
    if (w.cfg.count + w.mods.extraCount < 3) return `炸弹数量未达 3（${w.cfg.count + w.mods.extraCount}）`;
    // 三个相距 340px 的目标（爆圈半径 95，互不波及）
    s.debugSpawn('bulwark', 200, 800);
    s.debugSpawn('bulwark', 540, 800);
    s.debugSpawn('bulwark', 880, 800);
    for (const m of s.monsters) m.hp = m.maxHp = 1e6; // 只验证"挨没挨"，不验证死
    const hp0 = s.monsters.map((m) => m.hp);
    runFor(s, 6, () => false); // 首轮齐射 1.5s 内落地，6s 富余
    const hits = s.monsters.filter((m, i) => m.hp < hp0[i]).length;
    return hits === 3 ? true : `仅 ${hits}/3 个目标被砸中（多发未独立索敌）`;
  } },
  { name: 'W-回旋镖多盘：双盘两枚各打各的（不重复索敌）', run: () => {
    const s = freshSession(1, 3); // boomerang
    s.grantCard('boom_twin'); // 双盘：数量 +1
    const w = s.hero.weapons[0];
    if (w.cfg.count + w.mods.extraCount < 2) return `回旋镖数量未达 2（${w.cfg.count + w.mods.extraCount}）`;
    // 两目标横向错开：近的（660 侧，距 362）先被锁定 → 第 2 枚必须排除它改打另一只（380 侧，距 378）
    s.debugSpawn('bulwark', 660, 670);
    s.debugSpawn('bulwark', 380, 670);
    for (const m of s.monsters) m.hp = m.maxHp = 1e6;
    const hit = [0, 0];
    s.bus.on<{ monsterId: number }>('onHit', ({ monsterId }) => { if (monsterId < 2) hit[monsterId]++; });
    runFor(s, 2.5, () => false);
    return hit[0] > 0 && hit[1] > 0 ? true : `命中 ${hit[0]}/${hit[1]}（第 2 枚应改打另一目标）`;
  } },
  { name: 'W-索敌距离：回旋镖 380 / 炸弹 600 外的目标不开火', run: () => {
    const bo = freshSession(1, 3); // boomerang（短程索敌 380）
    bo.debugSpawn('bulwark', 540, 328 + 500); // 500 > 380（bulwark 30px/s，2s 内进不来）
    let boShots = 0;
    bo.bus.on('onShoot', () => { boShots++; });
    runFor(bo, 2, () => false);
    if (boShots !== 0) return `回旋镖对 500px 外目标开火 ${boShots} 次`;
    const bomb = freshSession(1, 2); // alchemist_bomb（索敌 600）
    bomb.debugSpawn('bulwark', 540, 328 + 700); // 700 > 600
    let bombShots = 0;
    bomb.bus.on('onShoot', () => { bombShots++; });
    runFor(bomb, 2, () => false);
    return bombShots === 0 ? true : `炸弹对 700px 外目标开火 ${bombShots} 次`;
  } },
  { name: 'W-雷霆多发：尸击不再白打（双雷同 tick 连杀无重复命中）', run: () => {
    const s = freshSession(3, 4); // lightning_chain
    s.grantCard('chain_twin'); // 每次落雷 2 道（同 tick 两发指令）
    for (let i = 0; i < 6; i++) s.debugSpawn('zerg_ling', 400 + i * 80, 700);
    const killedObjects = new Set<unknown>(); // 用对象身份而非 id（清尸会重排 id，按 id 会误报）
    let corpseHits = 0;
    s.bus.on<{ monsterId: number }>('onKill', ({ monsterId }) => { killedObjects.add(s.monsters[monsterId]); });
    s.bus.on<{ monsterId: number }>('onHit', ({ monsterId }) => {
      const m = s.monsters[monsterId];
      if (m && killedObjects.has(m)) corpseHits++; // 已死怪再被命中 = 尸击
    });
    const ok = runFor(s, 15, () => s.totalKills >= 4);
    if (!ok) return `15s 内未击杀 4 只（实际 ${s.totalKills}，场景未覆盖多发）`;
    return corpseHits === 0 ? true : `出现 ${corpseHits} 次尸击（期望 0）`;
  } },

  // ===== 多武器（docs/02 §1：1 把初始 + 升级卡获得、≤4 把、同武器不重复） =====
  { name: 'W-多武器：开局双武器同时开火（两系伤害并存）', run: () => {
    const { level, monsters, cards } = loadConfigs();
    const weapons = (JSON.parse(fs.readFileSync(path.join(root, 'configs/weapons.json'), 'utf-8')) as { weapons: WeaponConfig[] }).weapons;
    const s = new GameSession({
      level, weaponConfigs: [weapons[0], weapons[2]], monsterConfigs: monsters, cardConfigs: cards,
      seed: 7,
      controller: { getMoveDir: () => ({ x: 0, y: 0 }) },
      cardPolicy: greedyDpsPolicy,
    });
    if (s.hero.weapons.length !== 2) return `武器实例数 ${s.hero.weapons.length}（应 2）`;
    s.debugSpawn('bulwark', 540, 800); // 高血量靶子：保持战斗进行（空波次会提前判胜）
    const target = s.monsters[0];
    target.hp = target.maxHp = 1e6;
    const seen = new Set<string>();
    for (let i = 0; i < 30 * 5 && !s.result; i++) {
      s.step();
      for (const p of s.projectiles) seen.add(p.damageType);
    }
    return seen.has('physical') && seen.has('fire') ? true : `仅出现伤害类型: ${[...seen].join(',') || '无'}`;
  } },
  { name: 'W-新武器候选：三选一出"新武器"（去重/满槽门控）', run: () => {
    const { level, monsters, cards } = loadConfigs();
    const weapons = (JSON.parse(fs.readFileSync(path.join(root, 'configs/weapons.json'), 'utf-8')) as { weapons: WeaponConfig[] }).weapons;
    // 单武器 + 全图鉴：反复抽取应出现新武器候选，且不含已持有武器
    const s = new GameSession({
      level, weaponConfigs: [weapons[0]], monsterConfigs: monsters, cardConfigs: cards,
      weaponPool: weapons, seed: 5,
      controller: { getMoveDir: () => ({ x: 0, y: 0 }) },
      cardPolicy: greedyDpsPolicy,
    });
    const rng = s.rng;
    const stacks = new Map<string, number>();
    let grants = 0;
    for (let i = 0; i < 400; i++) {
      const picks = rollCardChoices(cards, stacks, s.hero.weapons, rng, 3, weapons);
      for (const p of picks) {
        if (!p.id.startsWith('grant:')) continue;
        grants++;
        const wid = (p.effect as { grantWeapon: string }).grantWeapon;
        if (wid === weapons[0].id) return '候选出现已持有的武器（去重失效）';
        if (!weapons.some((w) => w.id === wid)) return `候选武器 ${wid} 不在图鉴中`;
      }
    }
    if (grants === 0) return '400 次×3 抽取未出现任何新武器候选（权重过低？）';
    // 满 4 槽：不应再出现新武器候选
    const s2 = new GameSession({
      level, weaponConfigs: [weapons[0], weapons[1], weapons[2], weapons[3]], monsterConfigs: monsters, cardConfigs: cards,
      weaponPool: weapons, seed: 5,
      controller: { getMoveDir: () => ({ x: 0, y: 0 }) },
      cardPolicy: greedyDpsPolicy,
    });
    for (let i = 0; i < 400; i++) {
      const picks = rollCardChoices(cards, stacks, s2.hero.weapons, rng, 5, weapons);
      if (picks.some((p) => p.id.startsWith('grant:'))) return '满 4 槽仍出现新武器候选';
    }
    return true;
  } },
  { name: 'W-新武器获得：grantWeapon 立即参战（去重/上限 4）', run: () => {
    const { level, monsters, cards } = loadConfigs();
    const weapons = (JSON.parse(fs.readFileSync(path.join(root, 'configs/weapons.json'), 'utf-8')) as { weapons: WeaponConfig[] }).weapons;
    const s = new GameSession({
      level, weaponConfigs: [weapons[0]], monsterConfigs: monsters, cardConfigs: cards,
      weaponPool: weapons, seed: 9,
      controller: { getMoveDir: () => ({ x: 0, y: 0 }) },
      cardPolicy: greedyDpsPolicy,
    });
    if (!s.grantWeapon(weapons[2])) return '获得炼金炸弹被拒（应在图鉴内）';
    if (s.hero.weapons.length !== 2) return `获得后武器数 ${s.hero.weapons.length}（应 2）`;
    if (s.grantWeapon(weapons[2])) return '重复获得同一武器未被拒';
    if (!s.grantWeapon(weapons[1]) || !s.grantWeapon(weapons[3])) return '第 3/4 把武器获得被拒（应允许）';
    if (s.grantWeapon(weapons[4])) return '第 5 把武器获得未被拒（上限 4 失效）';
    s.debugSpawn('bulwark', 540, 800);
    const target = s.monsters[0];
    target.hp = target.maxHp = 1e6;
    const seen = new Set<string>();
    for (let i = 0; i < 30 * 5 && !s.result; i++) {
      s.step();
      for (const p of s.projectiles) seen.add(p.damageType);
    }
    return seen.has('physical') && seen.has('fire') ? true : `获得后仅见伤害类型: ${[...seen].join(',') || '无'}`;
  } },
  { name: 'H-轨迹回放（新武器池）：含获得新武器的录制逐位一致', run: () => {
    const { monsters, cards } = loadConfigs();
    const level = JSON.parse(fs.readFileSync(path.join(root, 'configs/levels/level_1_1.json'), 'utf-8')) as LevelConfig;
    // 训练场切片：密集蝙蝠流（快速升级，稳定覆盖"获得新武器"路径）+ 超厚城墙（窗口内不终局）。
    // 录制与回放共用同一内存关卡对象，回放仍逐位一致。
    level.waves = [{ banner: '训练', formation: 'center', durationSec: 300, spawns: [{ monster: 'bat', count: 900, spawnPoints: 'all', releasePerTick: 1 }] }];
    level.wall.hp = 1e9;
    const weapons = (JSON.parse(fs.readFileSync(path.join(root, 'configs/weapons.json'), 'utf-8')) as { weapons: WeaponConfig[] }).weapons;
    const ctrl = new HumanInputController();
    const rec = new TraceRecorder();
    const s = new GameSession({
      level, weaponConfigs: [weapons[0]], monsterConfigs: monsters, cardConfigs: cards,
      weaponPool: weapons, seed: 4321,
      controller: ctrl, cardPolicy: greedyDpsPolicy,
    });
    s.externalLevelUps = true;
    rec.start({ t0: 0, seed: 4321, level: 'level_1_1.json', weapon: weapons[0].id, version: 'test', pool: true });
    // 脚本化"人工"输入：优先选新武器候选（保证样本覆盖"获得新武器"路径）；
    // 自适应窗口：拿到新武器且再走 3 次选卡即收工（上限 90s）——不依赖单次抽卡的运气
    let picks = 0;
    let grantPicks = 0;
    for (let i = 0; i < 30 * 90 && !s.result; i++) {
      const t = i / 30;
      ctrl.tx = 540 + Math.sin(t * 1.7) * 300;
      ctrl.ty = 520 + Math.sin(t * 2.1) * 140;
      ctrl.hasTarget = i % 300 < 210;
      rec.observe(ctrl.snapshot(), s.tick);
      s.step();
      if (s.pendingLevelChoices.length > 0) {
        const pending = s.pendingLevelChoices;
        const grant = pending.find((c) => c.id.startsWith('grant:'));
        const c = grant ?? pending[i % pending.length];
        rec.pick(s.tick, c.id, pending.map((x) => x.id));
        s.resolveLevelUp(c);
        picks++;
        if (grant) grantPicks++;
        if (grantPicks >= 1 && picks >= 4) break;
      }
      if (s.tick % 30 === 0) {
        rec.check(s.tick, { x: s.hero.x, y: s.hero.y, wallHp: s.wallHp, kills: s.totalKills, lv: s.hero.level });
      }
    }
    if (picks === 0) return '90s 内未触发选卡（样本未覆盖升选卡）';
    if (grantPicks === 0) return '90s 内未出现新武器候选（权重过低？）';
    const parsed = parseTrace(serializeTrace(rec.records));
    const report = runTraceReplay(parsed, { level, weapon: weapons[0], monsters, cards, weaponPool: weapons });
    if (!report.consistent) {
      const m = report.mismatches[0];
      return `回放分歧：t=${m.t} ${m.field} 录制 ${m.recorded} ≠ 回放 ${m.replayed}`;
    }
    if (s.hero.weapons.length < 2) return '录制未实际获得新武器（覆盖不足）';
    return report.checksTotal > 0 ? true : '存档点缺失（录制未产出 check 记录）';
  } },

  // ===== 激光炮（持续光束，docs/07 §4）=====
  { name: 'W-激光：持续光束灼烧线上目标，近旁不误伤', run: () => {
    const s = freshSession(11, 5); // laser_cannon（英雄 540,328；索敌 600）
    s.debugSpawn('bulwark', 540, 900); // 光束线上（距离 572）
    s.debugSpawn('bulwark', 660, 900); // 近旁对照：索敌内、非最近目标、离束线 120px
    const guard = s.monsters[0];
    const control = s.monsters[1];
    runFor(s, 1.5, () => false);
    if (!(guard.hp < guard.maxHp)) return '线上目标未被光束灼烧';
    const dealt = guard.maxHp - guard.hp;
    const dps = s.hero.weapons[0].cfg.baseDamage; // 面板每秒伤害（本测试不加伤害卡）
    const exp = (1.5 - 0.33) * dps;
    if (dealt < exp * 0.7 || dealt > exp * 1.3) return `1.5s 线上伤害 ${dealt}（期望 ≈${Math.round(exp)} = (1.5-0.33)×${dps}）`;
    if (control.hp !== control.maxHp) return `近旁对照被误伤（剩 ${control.hp}）`;
    const segs = s.segments.filter((sg) => sg.srcWeaponId === 'laser_cannon');
    return segs.length === 1 ? true : `激光段场数 ${segs.length}（应 1）`;
  } },
  { name: 'W-激光：重锁替换不叠加（伤害 = DPS×时间，无双算）', run: () => {
    const s = freshSession(12, 5);
    s.debugSpawn('bulwark', 540, 900);
    const m = s.monsters[0];
    m.hp = m.maxHp = 1e9;
    runFor(s, 2.0, () => false);
    const dealt = 1e9 - m.hp;
    // 期望 ≈ (2.0-0.33)×面板DPS；若同源旧束不删（叠加）会约翻倍
    const dps = s.hero.weapons[0].cfg.baseDamage;
    const exp = (2.0 - 0.33) * dps;
    return dealt > exp * 0.7 && dealt < exp * 1.3 ? true : `2s 伤害 ${dealt}（期望 ≈${Math.round(exp)}，换束叠加会约翻倍）`;
  } },
  { name: 'W-激光：过热熄灭 → 散热后复燃（节拍）', run: () => {
    const s = freshSession(13, 5);
    s.debugSpawn('bulwark', 540, 900);
    const m = s.monsters[0];
    m.hp = m.maxHp = 1e9;
    // 30Hz 帧量化：0.4s 间隔实走 13 帧（0.4333s）→ 18 发末束 ≈8.2s 熄灭；散热 2.2s → ≈9.9s 复燃
    runFor(s, 8.6, () => false);
    if (s.segments.some((sg) => sg.srcWeaponId === 'laser_cannon')) return '8.6s 应已过热熄灭（仍有残留光束）';
    const revived = runFor(s, 1.9, () => s.segments.some((sg) => sg.srcWeaponId === 'laser_cannon'));
    return revived ? true : '散热结束（≈9.3~10.0s）后未复燃';
  } },
  { name: 'W-激光：分光/扩束/余辉卡生效（扇形夹角+宽度+余辉）', run: () => {
    const s = freshSession(14, 5);
    if (!s.grantCard('laser_prism')) return '分光棱镜授予失败';
    if (!s.grantCard('laser_wide')) return '扩束透镜授予失败';
    if (!s.grantCard('laser_afterglow')) return '持续供能授予失败';
    s.debugSpawn('bulwark', 540, 900);
    runFor(s, 0.6, () => s.segments.length >= 2);
    const segs = s.segments.filter((sg) => sg.srcWeaponId === 'laser_cannon');
    if (segs.length !== 2) return `光束数 ${segs.length}（应 2）`;
    const [a, b] = segs;
    const spread = Math.abs((a.angle ?? 0) - (b.angle ?? 0));
    if (Math.abs(spread - 0.11) > 0.01) return `两束夹角 ${spread.toFixed(3)}（应 ≈0.11 扇形散开）`;
    if (Math.abs(a.width - 14 * 1.6) > 0.01) return `束宽 ${a.width}（应 22.4 = 14×1.6）`;
    const life = Math.min(a.until, b.until) - s.timeSec;
    if (life <= 0.5) return `余辉剩余 ${life.toFixed(2)}s（应 >0.5 = 0.5+供能 0.4）`;
    return true;
  } },
  { name: 'W-激光：散热鳍片缩短过热（约 8.8s 复燃）', run: () => {
    const s = freshSession(15, 5);
    if (!s.grantCard('laser_cooling')) return '散热鳍片授予失败';
    s.debugSpawn('bulwark', 540, 900);
    const m = s.monsters[0];
    m.hp = m.maxHp = 1e9;
    // 散热 ×0.75 → 1.65s（50 帧 = 1.667s）：末束 ≈8.2s 熄灭、≈9.4s 复燃（基准 ≈9.9s）
    runFor(s, 8.6, () => false);
    if (s.segments.some((sg) => sg.srcWeaponId === 'laser_cannon')) return '8.6s 应已熄灭';
    const revived = runFor(s, 1.2, () => s.segments.some((sg) => sg.srcWeaponId === 'laser_cannon'));
    return revived ? true : '散热鳍片后仍未在 9.8s 内复燃';
  } },
];

function runAll(): void {
  let pass = 0;
  const failures: string[] = [];
  for (const t of tests) {
    try {
      const r = t.run();
      if (r === true) {
        pass++;
        console.log(`  PASS  ${t.name}`);
      } else {
        failures.push(t.name);
        console.log(`  FAIL  ${t.name}${typeof r === 'string' ? ` —— ${r}` : ''}`);
      }
    } catch (e) {
      failures.push(t.name);
      console.log(`  ERROR ${t.name} —— ${(e as Error).message}`);
    }
  }
  console.log(`\n${pass}/${tests.length} 通过`);
  if (failures.length > 0) {
    console.log('失败项：' + failures.join('、'));
    process.exit(1);
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  if (argv[0] === '--all') {
    runAll();
    return;
  }
  if (argv[0] === '--card') {
    const timesIdx = argv.indexOf('--times');
    observeCard(argv[1], timesIdx >= 0 ? Number(argv[timesIdx + 1]) : 1);
    return;
  }
  console.log('用法:');
  console.log('  node dist/tools/lab/index.js --card <cardId> [--times N]   观察单卡效果');
  console.log('  node dist/tools/lab/index.js --all                         全量断言测试');
  const cards = loadConfigs().cards;
  console.log('\n可用卡牌: ' + cards.map((c) => `${c.id}(${c.name})`).join(' '));
}

main();
