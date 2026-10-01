/**
 * sim：无头整局模拟 CLI（docs/05 §1.6 AI 流水线的"机器试玩"环节）。
 *
 * 用法：
 *   node dist/tools/sim/index.js --level configs/levels/level_1_1.json [--seed 42]
 *      [--weapon gun_rifle] [--policy greedy|random] [--runs 5] [--json]
 *
 * 输出：每局结果 + 汇总报告（城破率/通关率/星级/各波 TTK/对墙压力）。
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
import { SimAIController } from './controller';
import { CasualAIController } from './casual';
import { getPolicy, PolicyName } from './policies';
import { runWatch } from './watch';

interface Args {
  level: string;
  seed: number;
  weapon: string;
  policy: PolicyName;
  runs: number;
  json: boolean;
  watch: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { level: '', seed: 42, weapon: 'gun_rifle', policy: 'greedy', runs: 1, json: false, watch: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--level') args.level = next();
    else if (a === '--seed') args.seed = Number(next());
    else if (a === '--weapon') args.weapon = next();
    else if (a === '--policy') args.policy = next() as PolicyName;
    else if (a === '--runs') args.runs = Number(next());
    else if (a === '--json') args.json = true;
    else if (a === '--watch') args.watch = true;
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

function runOnce(
  runIndex: number,
  seed: number,
  level: LevelConfig,
  weaponCfg: WeaponConfig,
  monsterCfgs: ReadonlyMap<string, MonsterConfig>,
  cardConfigs: CardConfig[],
  policy: PolicyName,
): Record<string, unknown> {
  const session = new GameSession({
    level,
    weaponConfigs: [weaponCfg],
    monsterConfigs: monsterCfgs,
    cardConfigs,
    seed,
    controller: policy === 'casual' ? new CasualAIController(seed) : new SimAIController(),
    cardPolicy: getPolicy(policy),
  });

  let ticks = 0;
  const maxTicks = 30 * 60 * 20; // 20 分钟兜底
  while (!session.result && ticks < maxTicks) {
    session.step();
    ticks++;
  }

  const wallRatio = session.wallHp / session.wallMaxHp;
  const stars = session.result === 'victory' ? (wallRatio > 0.7 ? 3 : wallRatio > 0.4 ? 2 : 1) : 0;

  return {
    run: runIndex,
    seed,
    result: session.result ?? 'timeout',
    stars,
    durationSec: +(session.timeSec.toFixed(1)),
    wallHpEnd: Math.round(session.wallHp),
    wallHpMax: session.wallMaxHp,
    heroLevel: session.hero.level,
    totalKills: session.totalKills,
    totalDamage: session.totalDamage,
    totalCrits: session.totalCrits,
    totalWallDamage: Math.round(session.totalWallDamage),
    maxMonsters: session.maxMonsters,
    maxProjectiles: session.maxProjectiles,
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
    reports.push(runOnce(i, args.seed + i, level, weaponCfg, monsterMap, cards, args.policy));
  }

  // 汇总
  const victories = reports.filter((r) => r.result === 'victory');
  const defeats = reports.filter((r) => r.result === 'defeat');
  const avg = (f: (r: Record<string, unknown>) => number) =>
    reports.reduce((s, r) => s + f(r), 0) / reports.length;

  const summary = {
    level: level.id,
    weapon: args.weapon,
    policy: args.policy,
    runs: args.runs,
    victoryRate: +(victories.length / reports.length).toFixed(2),
    defeatRate: +(defeats.length / reports.length).toFixed(2),
    avgStars: +avg((r) => r.stars as number).toFixed(2),
    avgDurationSec: +avg((r) => r.durationSec as number).toFixed(1),
    avgWallDamageTaken: +avg((r) => ((r.wallHpMax as number) - (r.wallHpEnd as number))).toFixed(1),
    avgKills: +avg((r) => r.totalKills as number).toFixed(1),
    avgHeroLevel: +avg((r) => r.heroLevel as number).toFixed(1),
  };

  if (args.json) {
    console.log(JSON.stringify({ summary, reports }, null, 2));
  } else {
    console.log('================ 无头模拟报告 ================');
    console.log(`关卡: ${level.name}  武器: ${weaponCfg.name}  策略: ${args.policy}  种子: ${args.seed}  局数: ${args.runs}`);
    console.log('----------------------------------------------');
    for (const r of reports) {
      console.log(
        `#${(r.run as number) + 1} [${(r.result as string).toUpperCase()}] ★${r.stars}` +
        ` 时长 ${r.durationSec}s 城防 ${r.wallHpEnd}/${r.wallHpMax}` +
        ` 击杀 ${r.totalKills} 等级 ${r.heroLevel} 暴击 ${r.totalCrits} 峰值怪 ${r.maxMonsters}`,
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
    console.log('==============================================');
  }
}

main();
