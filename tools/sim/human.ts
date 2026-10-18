/**
 * 人工输入模型 + 走位轨迹格式（web 录制 ↔ sim 回放 共用同一套逻辑，保证两端逐帧同源）。
 *
 * 轨迹文件为 JSONL（一行一条记录）：
 *   {type:'run',  t0, seed, level, weapon, version}   一局元数据
 *   {type:'in',   t, st}      步进前输入状态（只记变化点；回放取最近一条 ≤ t 应用）
 *   {type:'pick', t, id, offers}  升选卡（t 为完成该步后的 session.tick；offers 记录当时三选一）
 *   {type:'check',t, x, y, wallHp, kills, lv}  每 30 tick 存档（回放时定位首个分歧）
 *   {type:'end',  t, result, kills, wallHp, wallMax, lv, sec}  结算快照
 *
 * 回放原理：gamecore 完全确定性——同 seed + 同逐 tick 输入 + 同选卡序列即可逐位复现，
 * 因此只需录"输入流"，完整状态（怪物位置/血量/伤害）都可在 sim 里重演（模仿学习样本重建用）。
 */
import { GameSession, Vec2 } from '../../src/gamecore';

export interface HumanInputState {
  tx: number;
  ty: number;
  hasTarget: boolean;
  keys: string[]; // 排序后的按键（稳定比较/序列化）
}

/** 点按移动（触屏/鼠标拖动）+ WASD/方向键。与 web 适配层共享，改动此处即两端同步。 */
export class HumanInputController {
  tx: number;
  ty: number;
  hasTarget = false;
  keys = new Set<string>();

  constructor(tx = 540, ty = 300) {
    this.tx = tx;
    this.ty = ty;
  }

  getMoveDir(s: GameSession): Vec2 {
    let dx = 0;
    let dy = 0;
    const k = this.keys;
    if (k.has('a') || k.has('arrowleft')) dx -= 1;
    if (k.has('d') || k.has('arrowright')) dx += 1;
    if (k.has('w') || k.has('arrowup')) dy += 1;
    if (k.has('s') || k.has('arrowdown')) dy -= 1;
    if (dx !== 0 || dy !== 0) return { x: dx, y: dy };
    if (this.hasTarget) {
      const ddx = this.tx - s.hero.x;
      const ddy = this.ty - s.hero.y;
      const d = Math.hypot(ddx, ddy);
      if (d < 14) {
        this.hasTarget = false; // 抵达即停（与 web 端一致）
        return { x: 0, y: 0 };
      }
      return { x: ddx / d, y: ddy / d };
    }
    return { x: 0, y: 0 }; // 无输入时静止（不自动回中）
  }

  snapshot(): HumanInputState {
    return { tx: this.tx, ty: this.ty, hasTarget: this.hasTarget, keys: [...this.keys].sort() };
  }

  restore(st: HumanInputState): void {
    this.tx = st.tx;
    this.ty = st.ty;
    this.hasTarget = st.hasTarget;
    this.keys = new Set(st.keys);
  }
}

export function sameInputState(a: HumanInputState, b: HumanInputState): boolean {
  return (
    a.tx === b.tx &&
    a.ty === b.ty &&
    a.hasTarget === b.hasTarget &&
    a.keys.length === b.keys.length &&
    a.keys.every((k, i) => k === b.keys[i])
  );
}

export interface TraceRun {
  type: 'run';
  t0: number;      // 开始时间戳（Date.now）
  seed: number;
  level: string;   // 关卡文件名，如 level_1_1.json
  weapon: string;  // 初始武器 id
  version: string; // web 资源版本（bundle.js?v=N），仅作溯源
}
export interface TraceInput {
  type: 'in';
  t: number;
  st: HumanInputState;
}
export interface TracePick {
  type: 'pick';
  t: number;
  id: string;
  offers: string[];
}
export interface TraceCheck {
  type: 'check';
  t: number;
  x: number;
  y: number;
  wallHp: number;
  kills: number;
  lv: number;
}
export interface TraceEnd {
  type: 'end';
  t: number;
  result: string;
  kills: number;
  wallHp: number;
  wallMax: number;
  lv: number;
  sec: number;
}
export type TraceRecord = TraceRun | TraceInput | TracePick | TraceCheck | TraceEnd;

/** 录制器：只负责"何时记什么"，落盘方式由 sink 决定（web 走 POST /api/trace；测试收数组）。 */
export class TraceRecorder {
  readonly records: TraceRecord[] = [];
  private last: HumanInputState | null = null;

  constructor(private readonly sink: (r: TraceRecord) => void = () => {}) {}

  start(meta: Omit<TraceRun, 'type'>): void {
    this.push({ type: 'run', ...meta });
  }

  /** 每步进前调用：输入状态变化才记录（静止/匀速拖动期间零开销）。 */
  observe(st: HumanInputState, tick: number): void {
    if (!this.last || !sameInputState(this.last, st)) {
      this.push({ type: 'in', t: tick, st });
      this.last = st;
    }
  }

  pick(tick: number, id: string, offers: string[]): void {
    this.push({ type: 'pick', t: tick, id, offers });
  }

  check(tick: number, s: { x: number; y: number; wallHp: number; kills: number; lv: number }): void {
    this.push({ type: 'check', t: tick, x: s.x, y: s.y, wallHp: s.wallHp, kills: s.kills, lv: s.lv });
  }

  end(tick: number, s: Omit<TraceEnd, 'type' | 't'>): void {
    this.push({ type: 'end', t: tick, ...s });
  }

  private push(r: TraceRecord): void {
    this.records.push(r);
    this.sink(r);
  }
}

export interface ParsedTrace {
  run: TraceRun;
  inputs: TraceInput[];
  picks: TracePick[];
  checks: TraceCheck[];
  end: TraceEnd | null;
}

export function serializeTrace(records: readonly TraceRecord[]): string {
  return records.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

/** 解析 JSONL 轨迹；坏行跳过（崩溃/半行写入容忍）。 */
export function parseTrace(text: string): ParsedTrace {
  let run: TraceRun | null = null;
  const inputs: TraceInput[] = [];
  const picks: TracePick[] = [];
  const checks: TraceCheck[] = [];
  let end: TraceEnd | null = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let r: TraceRecord;
    try {
      r = JSON.parse(line) as TraceRecord;
    } catch {
      continue;
    }
    if (r.type === 'run') run = r;
    else if (r.type === 'in') inputs.push(r);
    else if (r.type === 'pick') picks.push(r);
    else if (r.type === 'check') checks.push(r);
    else if (r.type === 'end') end = r;
  }
  if (!run) throw new Error('轨迹缺少 run 头记录（不是有效的人工轨迹文件）');
  return { run, inputs, picks, checks, end };
}
