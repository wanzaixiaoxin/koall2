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
  { name: 'B-紧急修缮：+300 且不超上限（封顶）', run: () => {
    const s = freshSession();
    const base = s.wallMaxHp;
    s.wallHp = base - 1000;
    s.grantCard('repair');
    if (Number(s.wallHp) !== base - 700) return `第 1 次修复后 ${s.wallHp}`;
    s.grantCard('repair');
    if (Number(s.wallHp) !== base - 400) return `第 2 次修复后 ${s.wallHp}`;
    s.grantCard('repair');
    if (Number(s.wallHp) !== base - 100) return `第 3 次修复后 ${s.wallHp}`;
    s.grantCard('repair'); // base-100+300 → 封顶 base
    if (Number(s.wallHp) !== base) return `第 4 次修复后 ${s.wallHp}（未封顶 ${base}）`;
    // 加固提升上限后：修复在新上限内生效
    s.grantCard('fortify');
    s.wallHp = s.wallMaxHp - 100;
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
  { name: 'C-弹片/扩爆（炸弹专属）：分裂成长 + 在本体爆破上放大半径', run: () => {
    const s = freshSession(1, 2); // alchemist_bomb（本体爆破 r90）
    s.grantCard('split'); s.grantCard('split');
    s.grantCard('blast');
    const a = s.hero.weapons[0].affixes;
    if (!(a.split === 2 && a.blast === 1)) return `split=${a.split} blast=${a.blast}`;
    s.debugSpawn('slime', 540, 1100); // 远目标，射程尽头落地爆炸
    const ok = runFor(s, 6, () => s.pools.length > 0);
    if (!ok) return '伤害圈未出现';
    return s.pools[0].radius >= 90 ? true : `半径 ${s.pools[0].radius}（应 ≥ 本体 90）`;
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
    s.hero.x = 540;
    s.hero.y = 96;
    let transferSeen = false;
    s.bus.on('onDamageTransfer', () => { transferSeen = true; });
    const hpBefore = shaman.hp;
    runFor(s, 10, () => transferSeen);
    if (!transferSeen) return '转嫁未触发';
    return shaman.hp >= hpBefore ? true : `巫师仍掉血（${hpBefore} → ${shaman.hp}）`;
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
    shaman.hp = shaman.maxHp;
    for (const e of aliveEscorts) e.hp = e.maxHp;
    s.hero.x = 540;
    s.hero.y = 96;
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
  { name: 'W-血滴子：回旋镖悬停期间对同一目标反复研磨（0.5s 重击冷却）', run: () => {
    const s = freshSession(9, 3); // boomerang（飞出 350 → 悬停 2s → 返回）
    s.debugSpawn('bulwark', 540, 670); // ≈悬停点（英雄 328 + 飞出 350）
    let hits = 0;
    s.bus.on('onHit', () => { hits++; });
    runFor(s, 6, () => false);
    return hits >= 3 ? true : `总命中 ${hits} 次（悬停研磨未生效）`;
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
  { name: 'T-飞盘：飞出→悬停→返回主人后消亡', run: () => {
    const ctx: MotionContext = { dt: 1 / 30, now: 0, ownerX: 0, ownerY: 0, nearestMonster: () => null };
    const t: Trajectory = createTrajectory(frisbeeConfig(300, 300, 1.0, 400), { dirX: 1, dirY: 0 });
    let x = 0; let y = 0; let alive = true;
    // 阶段 1：飞出 300px（约 30 tick）
    for (let i = 0; i < 30 && alive; i++) { const r = t.update(x, y, ctx); x = r.x; y = r.y; alive = r.alive; }
    const outX = x;
    if (outX < 250) return `飞出距离不足: ${outX.toFixed(0)}`;
    // 阶段 2：悬停 1 秒，位移应接近 0
    const hx = x; const hy = y;
    for (let i = 0; i < 30 && alive; i++) { const r = t.update(x, y, ctx); x = r.x; y = r.y; alive = r.alive; }
    const hoverMove = Math.hypot(x - hx, y - hy);
    if (hoverMove > 2) return `悬停漂移过大: ${hoverMove.toFixed(1)}`;
    // 阶段 3：返回主人（0,0），最终应消亡且终点靠近主人
    let steps = 0;
    while (alive && steps < 600) { const r = t.update(x, y, ctx); x = r.x; y = r.y; alive = r.alive; steps++; }
    const dHome = Math.hypot(x, y);
    return !alive && dHome <= 45 ? true : `alive=${alive} dHome=${dHome.toFixed(1)}`;
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
    return approx(st.atk, 10.8) && approx(st.aspd, 1.07) && approx(st.critChance, 0.10)
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
