/**
 * sim：无头整局模拟 CLI（docs/05 §1.6 AI 流水线的"机器试玩"环节）。
 *
 * 用法：
 *   node dist/tools/sim/index.js --level configs/levels/level_1_1.json [--seed 42]
 *      [--weapon gun_rifle] [--runs 5] [--json] [--watch]
 *      [--move sim|sim-legacy|casual] [--cards greedy|random]
 *
 * 走位与选卡相互独立（--move × --cards 可做对照矩阵）：
 *   sim        武器感知版 SimAI（默认）
 *   sim-legacy 改动前旧版（贴墙追前哨，仅供 A/B 对比复现）
 *   casual     拟真噪声版（0.7s 决策节拍 + 噪声 + 发呆）
 *
 * --policy greedy|random|casual 为旧别名，仍兼容：
 *   greedy=sim+greedy / random=sim+random / casual=casual+random
 *
 * 输出：每局结果 + 汇总报告（城破率/通关率/星级/各波 TTK/对墙压力）。
 * 汇总含多维进度统计（0 通关也可读）：时长·击杀·每分钟击杀·到达波次·清怪率%·
 * 内容进度%（击杀/配置总怪池）·终波内击杀·英雄等级·城防损耗% 的平均/中位/最小/最大/标准差
 * + 到达波次分布 + 各波到达率。
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  GameSession,
  LevelConfig,
  MonsterConfig,
  WeaponConfig,
  CardConfig,
  TICK_DT,
} from '../../src/gamecore';
import { createController, MoveName } from './agents';
import { getPolicy, CardPolicyName } from './policies';
import { runWatch } from './watch';

interface Args {
  level: string;
  seed: number;
  weapon: string;
  move: MoveName;
  cards: CardPolicyName;
  runs: number;
  json: boolean;
  watch: boolean;
}

const MOVES: MoveName[] = ['sim', 'sim-legacy', 'casual'];
const CARD_POLICIES: CardPolicyName[] = ['greedy', 'random'];

/** 旧 --policy 别名 → (move, cards) 映射（迁移期兼容，行为与改动前一致）。 */
const LEGACY_POLICY_MAP: Record<string, { move: MoveName; cards: CardPolicyName }> = {
  greedy: { move: 'sim', cards: 'greedy' },
  random: { move: 'sim', cards: 'random' },
  casual: { move: 'casual', cards: 'random' },
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    level: '', seed: 42, weapon: 'gun_rifle', move: 'sim', cards: 'greedy', runs: 1, json: false, watch: false,
  };
  let moveSet = false;
  let cardsSet = false;
  let legacyPolicy = '';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--level') args.level = next();
    else if (a === '--seed') args.seed = Number(next());
    else if (a === '--weapon') args.weapon = next();
    else if (a === '--move') { args.move = next() as MoveName; moveSet = true; }
    else if (a === '--cards') { args.cards = next() as CardPolicyName; cardsSet = true; }
    else if (a === '--policy') legacyPolicy = next();
    else if (a === '--runs') args.runs = Number(next());
    else if (a === '--json') args.json = true;
    else if (a === '--watch') args.watch = true;
  }
  if (legacyPolicy) {
    const mapped = LEGACY_POLICY_MAP[legacyPolicy];
    if (!mapped) {
      console.error(`未知 --policy: ${legacyPolicy}（旧别名: greedy|random|casual；新参数: --move ${MOVES.join('|')} --cards ${CARD_POLICIES.join('|')}）`);
      process.exit(1);
    }
    if (!moveSet) args.move = mapped.move; // 显式 --move/--cards 优先于旧别名
    if (!cardsSet) args.cards = mapped.cards;
  }
  if (!MOVES.includes(args.move)) {
    console.error(`未知 --move: ${args.move}（可选: ${MOVES.join(' | ')}）`);
    process.exit(1);
  }
  if (!CARD_POLICIES.includes(args.cards)) {
    console.error(`未知 --cards: ${args.cards}（可选: ${CARD_POLICIES.join(' | ')}）`);
    process.exit(1);
  }
  if (!args.level) {
    console.error('缺少 --level 参数');
    process.exit(1);
  }
  return args;
}

function loadJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
}

/** 多维统计：平均 / 中位 / 最小 / 最大 / 标准差（四舍五入到 digits 位）。 */
function statBlock(values: number[], digits = 1): { avg: number; median: number; min: number; max: number; std: number } {
  const n = values.length;
  const sorted = [...values].sort((a, b) => a - b);
  const avg = values.reduce((s, v) => s + v, 0) / n;
  const median = n % 2 === 1 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  const std = Math.sqrt(values.reduce((s, v) => s + (v - avg) ** 2, 0) / n);
  const r = (v: number) => +v.toFixed(digits);
  return { avg: r(avg), median: r(median), min: r(sorted[0]), max: r(sorted[n - 1]), std: r(std) };
}

function runOnce(
  runIndex: number,
  seed: number,
  level: LevelConfig,
  weaponCfg: WeaponConfig,
  monsterCfgs: ReadonlyMap<string, MonsterConfig>,
  cardConfigs: CardConfig[],
  move: MoveName,
  cards: CardPolicyName,
): Record<string, unknown> {
  const session = new GameSession({
    level,
    weaponConfigs: [weaponCfg],
    monsterConfigs: monsterCfgs,
    cardConfigs,
    seed,
    controller: createController(move, seed),
    cardPolicy: getPolicy(cards),
  });

  let ticks = 0;
  const maxTicks = 30 * 60 * 20; // 20 分钟兜底
  while (!session.result && ticks < maxTicks) {
    session.step();
    ticks++;
  }

  const wallRatio = session.wallHp / session.wallMaxHp;
  const stars = session.result === 'victory' ? (wallRatio > 0.7 ? 3 : wallRatio > 0.4 ? 2 : 1) : 0;

  // —— 进度维度 ——
  const durationSec = +(session.timeSec.toFixed(1));
  const wallHpEnd = Math.round(session.wallHp);
  const wallHpPct = +((session.wallHp / session.wallMaxHp) * 100).toFixed(1);
  const clearedKills = session.waveStats.reduce((s, w) => s + w.kills, 0);
  const waveTotal = level.waves.length;
  const totalSpawned = session.totalSpawned; // 实际出场（含分裂/产卵/护卫）
  const totalMonsters = level.waves.reduce(
    (s, w) => s + w.spawns.reduce((a, sp) => a + sp.count, 0), 0); // 配置怪池（参考值）
  // 胜利=打完全部；否则=阵亡时正在打的那一波（1 起，0=还没见到第 1 波）
  const waveReached = session.result === 'victory'
    ? waveTotal
    : Math.max(0, session.currentWaveIndex + 1);

  return {
    run: runIndex,
    seed,
    result: session.result ?? 'timeout',
    stars,
    durationSec,
    wallHpEnd,
    wallHpMax: session.wallMaxHp,
    wallHpPct,
    heroLevel: session.hero.level,
    totalKills: session.totalKills,
    killsPerMin: durationSec > 0 ? +(session.totalKills / (durationSec / 60)).toFixed(1) : 0,
    totalDamage: session.totalDamage,
    totalCrits: session.totalCrits,
    totalWallDamage: Math.round(session.totalWallDamage),
    maxMonsters: session.maxMonsters,
    maxProjectiles: session.maxProjectiles,
    // —— 进度维度（波次/斩杀池） ——
    waveReached,
    waveTotal,
    wavesCleared: session.waveStats.length,
    finalWaveKills: session.totalKills - clearedKills, // 阵亡那一波内的击杀
    totalMonsters,
    totalSpawned,
    killedPct: totalSpawned > 0 ? +((session.totalKills / totalSpawned) * 100).toFixed(1) : 0, // 清怪率（÷实际出场）
    poolPct: +((session.totalKills / totalMonsters) * 100).toFixed(1), // 内容进度（÷配置总怪池）
    aliveEnd: session.monsters.length,
    cards: session.cardPickLog,
    waves: session.waveStats.map((w) => ({
      ...w,
      durationSec: +(w.durationTicks * TICK_DT).toFixed(1),
      durationTicks: undefined,
    })),
  };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const root = process.cwd();

  const level = loadJson<LevelConfig>(path.resolve(root, args.level));
  const weapons = loadJson<{ weapons: WeaponConfig[] }>(path.resolve(root, 'configs/weapons.json')).weapons;
  const monsters = loadJson<{ monsters: MonsterConfig[] }>(path.resolve(root, 'configs/monsters.json')).monsters;
  const cards = loadJson<{ cards: CardConfig[] }>(path.resolve(root, 'configs/cards.json')).cards;

  const weaponCfg = weapons.find((w) => w.id === args.weapon);
  if (!weaponCfg) {
    console.error(`未知武器: ${args.weapon}（可选: ${weapons.map((w) => w.id).join(', ')}）`);
    process.exit(1);
  }
  const monsterMap = new Map(monsters.map((m) => [m.id, m]));

  if (args.watch) {
    // 终端实时播放（异步，Ctrl+C 退出）
    runWatch(args, level, weaponCfg, monsterMap, cards).catch((e) => {
      console.error(e);
      process.exit(1);
    });
    return;
  }

  const reports: Record<string, unknown>[] = [];
  for (let i = 0; i < args.runs; i++) {
    reports.push(runOnce(i, args.seed + i, level, weaponCfg, monsterMap, cards, args.move, args.cards));
  }

  // 汇总
  const victories = reports.filter((r) => r.result === 'victory');
  const defeats = reports.filter((r) => r.result === 'defeat');
  const num = (r: Record<string, unknown>, k: string): number => r[k] as number;
  const avg = (f: (r: Record<string, unknown>) => number) =>
    reports.reduce((s, r) => s + f(r), 0) / reports.length;

  // 多维度统计：即使 0 通关，也能看清"打到哪儿、杀多少、撑多久"
  const dims = {
    durationSec: statBlock(reports.map((r) => num(r, 'durationSec'))),
    kills: statBlock(reports.map((r) => num(r, 'totalKills'))),
    killsPerMin: statBlock(reports.map((r) => num(r, 'killsPerMin'))),
    waveReached: statBlock(reports.map((r) => num(r, 'waveReached'))),
    killedPct: statBlock(reports.map((r) => num(r, 'killedPct'))),
    poolPct: statBlock(reports.map((r) => num(r, 'poolPct'))),
    finalWaveKills: statBlock(reports.map((r) => num(r, 'finalWaveKills'))),
    heroLevel: statBlock(reports.map((r) => num(r, 'heroLevel'))),
    wallLossPct: statBlock(reports.map((r) => 100 - num(r, 'wallHpPct'))),
  };

  // 到达波次分布（第 k 波有多少局活着到达）
  const waveTotal = level.waves.length;
  const reachHistogram: { wave: number; runs: number }[] = [];
  for (let w = 1; w <= waveTotal; w++) {
    const n = reports.filter((r) => num(r, 'waveReached') >= w).length;
    if (n > 0) reachHistogram.push({ wave: w, runs: n });
  }

  // 各波区间统计（只统计实际清掉该波的局）
  const waveBreakdown = level.waves.map((waveCfg, i) => {
    const reached = reports.filter((r) => num(r, 'waveReached') >= i + 1);
    const cleared = reports
      .map((r) => (r.waves as Record<string, unknown>[])[i])
      .filter((w): w is Record<string, unknown> => w !== undefined);
    const agg = (f: (w: Record<string, unknown>) => number): number | null =>
      cleared.length ? +(cleared.reduce((s, w) => s + f(w), 0) / cleared.length).toFixed(1) : null;
    return {
      wave: i + 1,
      banner: waveCfg.banner,
      reachedRuns: reached.length,
      reachedRate: +(reached.length / reports.length).toFixed(2),
      clearedRuns: cleared.length,
      clearedRate: +(cleared.length / reports.length).toFixed(2),
      avgDurationSec: agg((w) => w.durationSec as number),
      avgKills: agg((w) => w.kills as number),
      avgWallDamage: agg((w) => w.wallDamage as number),
      avgWallHpEnd: agg((w) => w.wallHpEnd as number),
    };
  });

  const summary = {
    level: level.id,
    weapon: args.weapon,
    move: args.move,
    cards: args.cards,
    runs: args.runs,
    victoryRate: +(victories.length / reports.length).toFixed(2),
    defeatRate: +(defeats.length / reports.length).toFixed(2),
    timeoutRate: +(reports.filter((r) => r.result === 'timeout').length / reports.length).toFixed(2),
    avgStars: +avg((r) => r.stars as number).toFixed(2),
    avgDurationSec: +avg((r) => r.durationSec as number).toFixed(1),
    avgWallDamageTaken: +avg((r) => ((r.wallHpMax as number) - (r.wallHpEnd as number))).toFixed(1),
    avgKills: +avg((r) => r.totalKills as number).toFixed(1),
    avgHeroLevel: +avg((r) => r.heroLevel as number).toFixed(1),
    // —— 多维度进度统计 ——
    dims,
    reachHistogram,
    waveBreakdown,
  };

  if (args.json) {
    console.log(JSON.stringify({ summary, reports }, null, 2));
  } else {
    console.log('================ 无头模拟报告 ================');
    console.log(`关卡: ${level.name}  武器: ${weaponCfg.name}  走位: ${args.move}  选卡: ${args.cards}  种子: ${args.seed}  局数: ${args.runs}`);
    console.log('----------------------------------------------');
    for (const r of reports) {
      console.log(
        `#${(r.run as number) + 1} [${(r.result as string).toUpperCase()}] ★${r.stars}` +
        ` 时长 ${r.durationSec}s 城防 ${r.wallHpEnd}/${r.wallHpMax} (${r.wallHpPct}%)`,
      );
      console.log(
        `   击杀 ${r.totalKills}（出场 ${r.totalSpawned} · 清怪 ${r.killedPct}% · 内容 ${r.poolPct}% · ${r.killsPerMin}/分）` +
        ` 到达 第${r.waveReached}/${r.waveTotal}波（已清 ${r.wavesCleared} 波 · 终波内击杀 ${r.finalWaveKills}）` +
        ` 等级 ${r.heroLevel} 暴击 ${r.totalCrits} 峰值怪 ${r.maxMonsters}`,
      );
      for (const w of r.waves as Record<string, unknown>[]) {
        console.log(
          `   第${w.wave}波 "${w.banner}" 用时 ${w.durationSec}s 击杀 ${w.kills}` +
          ` 磨墙 ${w.wallDamage} 波末城防 ${w.wallHpEnd}`,
        );
      }
      console.log(`   选卡: ${(r.cards as string[]).join(' → ') || '无'}`);
    }
    console.log('-------------------- 汇总 --------------------');
    console.log(`通关率 ${(summary.victoryRate * 100).toFixed(0)}%  平均星级 ${summary.avgStars}` +
      `  平均时长 ${summary.avgDurationSec}s  平均城防损耗 ${summary.avgWallDamageTaken}` +
      `  平均击杀 ${summary.avgKills}  平均等级 ${summary.avgHeroLevel}`);
    console.log('-------- 维度统计（即使 0 通关也能看进度）--------');
    console.log('指标            平均     中位     最小     最大     标准差');
    const dimRows: [string, keyof typeof dims][] = [
      ['时长(s)', 'durationSec'],
      ['击杀', 'kills'],
      ['每分钟击杀', 'killsPerMin'],
      ['到达波次', 'waveReached'],
      ['清怪率(%)', 'killedPct'],
      ['内容进度(%)', 'poolPct'],
      ['终波内击杀', 'finalWaveKills'],
      ['英雄等级', 'heroLevel'],
      ['城防损耗(%)', 'wallLossPct'],
    ];
    for (const [label, key] of dimRows) {
      const s = dims[key];
      console.log(
        `${label.padEnd(12)}${String(s.avg).padStart(8)}${String(s.median).padStart(8)}` +
        `${String(s.min).padStart(8)}${String(s.max).padStart(8)}${String(s.std).padStart(8)}`,
      );
    }
    console.log(`到达波次分布: ${summary.reachHistogram.map((h) => `第${h.wave}波×${h.runs}`).join('  ') || '无'}`);
    console.log('-------- 各波区间统计（只看实际到达的局）--------');
    console.log('波  到达率  清波率  平均用时  平均击杀  平均磨墙');
    for (const w of summary.waveBreakdown) {
      if (w.reachedRuns === 0) continue;
      console.log(
        `${String(w.wave).padStart(2)}  ${`${(w.reachedRate * 100).toFixed(0)}%`.padStart(5)}  ` +
        `${`${(w.clearedRate * 100).toFixed(0)}%`.padStart(5)}  ` +
        `${String(w.avgDurationSec ?? '-').padStart(8)}  ${String(w.avgKills ?? '-').padStart(8)}  ` +
        `${String(w.avgWallDamage ?? '-').padStart(8)}`,
      );
    }
    console.log('==============================================');
  }
}

main();
