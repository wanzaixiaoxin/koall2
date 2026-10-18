/**
 * 人工轨迹回放器：读录制 JSONL → 同 seed/逐 tick 输入/选卡序列在 gamecore 里逐帧复现，
 * 与录制存档点（check/end）比对，报告首个分歧。
 *
 * 作用：
 *   1) 验证轨迹样本完整可用（录制端与 gamecore 逐位一致 → 样本可信）；
 *   2) 作为"真人基线"评估入口（后续走位策略标定/模仿学习的对照列）。
 *
 * 用法：node dist/tools/sim/index.js --replay <trace.jsonl> [--json]
 * 退出码：0 = 完全一致；1 = 存在分歧或轨迹不可回放（便于脚本化校验）。
 *
 * 注意：回放要求"同代码版本"——平衡改动后再回放旧轨迹会在改动相关处出现分歧（属预期）。
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  CardConfig,
  GameSession,
  LevelConfig,
  MonsterConfig,
  WeaponConfig,
} from '../../src/gamecore';
import { HumanInputController, ParsedTrace, parseTrace } from './human';
import { greedyDpsPolicy } from './policies';

export interface ReplayMismatch {
  t: number;
  field: string;
  recorded: string;
  replayed: string;
}

export interface ReplayEndStats {
  result: string;
  kills: number;
  wallHp: number;
  wallMax: number;
  lv: number;
  sec: number;
}

export interface ReplayReport {
  trace: string;
  run: ParsedTrace['run'];
  inputs: number;
  picks: number;
  checksTotal: number;
  mismatches: ReplayMismatch[];
  recordedEnd: ReplayEndStats | null;
  replayEnd: ReplayEndStats;
  consistent: boolean;
}

const EPS_POS = 1e-4; // 位置/血量浮点容差（同引擎逐位一致；跨引擎仅容忍极小噪声，真分歧会迅速放大）

export function runTraceReplay(
  parsed: ParsedTrace,
  opts: {
    level: LevelConfig;
    weapon: WeaponConfig;
    monsters: ReadonlyMap<string, MonsterConfig>;
    cards: CardConfig[];
  },
  traceName = '<inline>',
): ReplayReport {
  const ctrl = new HumanInputController();
  const session = new GameSession({
    level: opts.level,
    weaponConfigs: [opts.weapon],
    monsterConfigs: opts.monsters,
    cardConfigs: opts.cards,
    seed: parsed.run.seed,
    controller: ctrl,
    cardPolicy: greedyDpsPolicy, // 占位：externalLevelUps=true，选卡完全按录制回放
  });
  session.externalLevelUps = true;

  const mismatches: ReplayMismatch[] = [];
  const push = (t: number, field: string, recorded: number | string, replayed: number | string): void => {
    if (mismatches.length >= 8) return; // 只留前几条防刷屏
    mismatches.push({
      t,
      field,
      recorded: typeof recorded === 'number' ? recorded.toFixed(3) : recorded,
      replayed: typeof replayed === 'number' ? replayed.toFixed(3) : replayed,
    });
  };
  const cmp = (t: number, field: string, recorded: number, replayed: number, eps: number): void => {
    if (Math.abs(recorded - replayed) > eps) push(t, field, recorded, replayed);
  };

  const MAX_TICKS = 30 * 60 * 40; // 40 分钟兜底（正常局 ≤10 分钟）
  // 按录制终止点停止：有 end 用 end.t；录制中断（无 end）用最后一条记录 tick
  const lastT = (arr: { t: number }[]): number => (arr.length ? arr[arr.length - 1].t : -1);
  const stopTick = parsed.end
    ? parsed.end.t
    : Math.max(0, lastT(parsed.inputs), lastT(parsed.picks), lastT(parsed.checks));
  let iIn = 0;
  let iPick = 0;
  let iCheck = 0;

  while (
    session.result === null &&
    session.tick < stopTick &&
    session.tick < MAX_TICKS &&
    mismatches.length === 0
  ) {
    // 1) 步进前：应用该 tick 之前的输入变化（取最近一条 ≤ 当前 tick）
    while (iIn < parsed.inputs.length && parsed.inputs[iIn].t <= session.tick) {
      ctrl.restore(parsed.inputs[iIn].st);
      iIn++;
    }
    session.step();
    // 2) 步进后（session.tick 已 +1）：按录制应用升选卡（web 端同样在暂停时结算）
    while (iPick < parsed.picks.length && parsed.picks[iPick].t <= session.tick) {
      const rec = parsed.picks[iPick++];
      const card = session.pendingLevelChoices.find((c) => c.id === rec.id);
      if (card) {
        session.resolveLevelUp(card);
      } else {
        push(session.tick, `pick:${rec.id}`, rec.id, session.pendingLevelChoices.map((c) => c.id).join(',') || '无候选');
      }
    }
    // 3) 存档点比对（首个分歧即止，便于定位）
    while (iCheck < parsed.checks.length && parsed.checks[iCheck].t <= session.tick) {
      const c = parsed.checks[iCheck++];
      cmp(c.t, 'hero.x', c.x, session.hero.x, EPS_POS);
      cmp(c.t, 'hero.y', c.y, session.hero.y, EPS_POS);
      cmp(c.t, 'wallHp', c.wallHp, session.wallHp, EPS_POS);
      cmp(c.t, 'kills', c.kills, session.totalKills, 0);
      cmp(c.t, 'lv', c.lv, session.hero.level, 0);
    }
  }

  const replayEnd: ReplayEndStats = {
    result: session.result ?? 'timeout',
    kills: session.totalKills,
    wallHp: Math.round(session.wallHp),
    wallMax: session.wallMaxHp,
    lv: session.hero.level,
    sec: +session.timeSec.toFixed(3),
  };
  const recordedEnd: ReplayEndStats | null = parsed.end
    ? {
        result: parsed.end.result,
        kills: parsed.end.kills,
        wallHp: Math.round(parsed.end.wallHp),
        wallMax: parsed.end.wallMax,
        lv: parsed.end.lv,
        sec: parsed.end.sec,
      }
    : null;
  if (recordedEnd) {
    if (recordedEnd.result !== replayEnd.result) push(session.tick, 'end.result', recordedEnd.result, replayEnd.result);
    cmp(session.tick, 'end.kills', recordedEnd.kills, replayEnd.kills, 0);
    cmp(session.tick, 'end.wallHp', recordedEnd.wallHp, replayEnd.wallHp, 1); // 录制端四舍五入，容忍 1 点
    cmp(session.tick, 'end.lv', recordedEnd.lv, replayEnd.lv, 0);
    cmp(session.tick, 'end.sec', recordedEnd.sec, replayEnd.sec, 1.5); // 时长对同一局应一致，容忍浮点显示差
  }

  return {
    trace: traceName,
    run: parsed.run,
    inputs: parsed.inputs.length,
    picks: parsed.picks.length,
    checksTotal: parsed.checks.length,
    mismatches,
    recordedEnd,
    replayEnd,
    consistent: mismatches.length === 0,
  };
}

/** 读轨迹文件 + 按元数据（level/weapon）加载配置并回放。 */
export function replayFromFile(file: string, root: string): ReplayReport {
  const text = fs.readFileSync(path.resolve(root, file), 'utf-8');
  const parsed = parseTrace(text);
  const levelPath = path.resolve(root, 'configs/levels', parsed.run.level);
  if (!fs.existsSync(levelPath)) throw new Error(`轨迹引用的关卡不存在: ${parsed.run.level}`);
  const level = JSON.parse(fs.readFileSync(levelPath, 'utf-8')) as LevelConfig;
  const weapons = (JSON.parse(fs.readFileSync(path.resolve(root, 'configs/weapons.json'), 'utf-8')) as { weapons: WeaponConfig[] }).weapons;
  const weapon = weapons.find((w) => w.id === parsed.run.weapon);
  if (!weapon) throw new Error(`轨迹引用的武器不存在: ${parsed.run.weapon}`);
  const monsters = (JSON.parse(fs.readFileSync(path.resolve(root, 'configs/monsters.json'), 'utf-8')) as { monsters: MonsterConfig[] }).monsters;
  const cards = (JSON.parse(fs.readFileSync(path.resolve(root, 'configs/cards.json'), 'utf-8')) as { cards: CardConfig[] }).cards;
  return runTraceReplay(
    parsed,
    { level, weapon, monsters: new Map(monsters.map((m) => [m.id, m])), cards },
    file,
  );
}

/** 终端可读的回放报告文本。 */
export function formatReplayReport(r: ReplayReport): string {
  const lines: string[] = [];
  const run = r.run;
  lines.push(`轨迹回放：${r.trace}`);
  lines.push(`元数据：seed=${run.seed} 关卡=${run.level} 武器=${run.weapon} 资源版本=${run.version} 开始=${new Date(run.t0).toLocaleString()}`);
  lines.push(`样本量：输入变化 ${r.inputs} 条 · 选卡 ${r.picks} 次 · 存档点 ${r.checksTotal} 个`);
  const fmt = (e: ReplayEndStats | null): string =>
    e
      ? `result=${e.result} kills=${e.kills} 城墙=${e.wallHp}/${e.wallMax} lv=${e.lv} 时长=${e.sec.toFixed(1)}s`
      : '（无结算记录——录制中断）';
  lines.push(`录制结果：${fmt(r.recordedEnd)}`);
  lines.push(`回放结果：${fmt(r.replayEnd)}`);
  if (r.consistent) {
    lines.push('结论：逐位一致 ✓（轨迹样本可完整回放）');
  } else {
    lines.push(`结论：存在 ${r.mismatches.length} 处分歧 ✗（首个分歧点即上表）`);
    for (const m of r.mismatches) {
      lines.push(`  t=${m.t} ${m.field}: 录制 ${m.recorded} ≠ 回放 ${m.replayed}`);
    }
  }
  return lines.join('\n');
}
