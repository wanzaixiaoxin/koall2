import { norm } from './core/math';
import { Targetable } from './targeting';

/**
 * 弹道行为库（docs/07）——结构化封装，供武器/卡牌/AI 生成内容便捷调用。
 *
 * 四层体系：
 *  1. 运动基元 Motion：位置随时间的变化（直线/抛物线/追踪/螺旋/蛇形/路径点/悬停/阶段机）
 *  2. 世界交互：命中后的连锁(chain)/弹射(bounce)/穿透(pierce)/分裂(split)（session 层，见 HeroAffixes）
 *  3. 生命周期：射程/时间/回到主人（飞盘 phased 的 nearOwner）
 *  4. 特殊形态：光束/两点连线（session 的 SegmentField，非抛射物）
 *
 * 全部确定性：同种子同输入，轨迹可复现。
 */

/** 运动上下文：由 session 每帧注入（时间/主人位置/世界查询），轨迹基元不持有世界状态。 */
export interface MotionContext {
  dt: number;
  now: number;
  ownerX: number;
  ownerY: number;
  /** 查找半径内最近的存活怪（排除 hitIds，供追踪重索敌/连锁） */
  nearestMonster(x: number, y: number, radius: number, exclude: Set<number>): Targetable | null;
}

export interface TrajectoryResult {
  x: number;
  y: number;
  alive: boolean;
  /** 俯视下的"离地高度"视觉量（抛物线用），渲染层可取用 */
  height?: number;
}

export interface Trajectory {
  update(x: number, y: number, ctx: MotionContext): TrajectoryResult;
}

// ---------- 声明式配置（可直接进 JSON，武器/卡牌/AI 内容生成共用） ----------

export type TrajectoryConfig =
  | { type: 'straight'; speed: number; life: number }   // life = 子弹寿命（秒），与索敌射程解耦
  | { type: 'homing'; speed: number; range: number; turnRate: number; duration: number; retarget: boolean; home?: boolean }
  | { type: 'parabola'; speed: number; range: number; peak?: number }
  | { type: 'spiral'; speed: number; range: number; angularSpeed: number; radius: number }
  | { type: 'zigzag'; speed: number; range: number; frequency: number; amplitude: number }
  | { type: 'waypoints'; speed: number; points: { x: number; y: number }[]; loop?: boolean }
  | { type: 'hover' }
  | { type: 'phased'; phases: PhaseConfig[] };

export type PhaseUntil =
  | { kind: 'distance'; value: number }   // 本阶段累计位移达标
  | { kind: 'duration'; value: number }   // 本阶段累计时间达标
  | { kind: 'nearOwner'; value: number }; // 距主人距离小于值（返回阶段）

export interface PhaseConfig {
  motion: TrajectoryConfig;
  until: PhaseUntil;
}

/** 发射参数：方向 + 可选锁定目标（homing 用）。 */
export interface TrajectoryLaunch {
  dirX: number;
  dirY: number;
  target?: Targetable | null;
}

/** 工厂：配置 + 发射参数 → 可执行的轨迹。 */
export function createTrajectory(cfg: TrajectoryConfig, launch: TrajectoryLaunch): Trajectory {
  const d = norm(launch.dirX, launch.dirY);
  switch (cfg.type) {
    case 'straight':
      return new StraightTrajectory(d.x, d.y, cfg.speed, cfg.life);
    case 'homing':
      return new HomingTrajectory(d.x, d.y, cfg.speed, cfg.range, launch.target ?? null, cfg);
    case 'parabola':
      return new ParabolaTrajectory(d.x, d.y, cfg.speed, cfg.range, cfg.peak ?? 120);
    case 'spiral':
      return new SpiralTrajectory(d.x, d.y, cfg.speed, cfg.range, cfg.angularSpeed, cfg.radius);
    case 'zigzag':
      return new ZigzagTrajectory(d.x, d.y, cfg.speed, cfg.range, cfg.frequency, cfg.amplitude);
    case 'waypoints':
      return new WaypointTrajectory(cfg.speed, cfg.points, cfg.loop ?? false);
    case 'hover':
      return new HoverTrajectory();
    case 'phased':
      return new PhaseTrajectory(cfg.phases, launch);
  }
}

// ---------- 运动基元 ----------

/** 直线：恒定方向，寿命耗尽消亡（寿命制：与索敌射程解耦）。 */
export class StraightTrajectory implements Trajectory {
  private dir: { x: number; y: number };
  private traveled = 0;

  constructor(dirX: number, dirY: number, private speed: number, private lifeSec: number) {
    this.dir = norm(dirX, dirY);
  }

  update(x: number, y: number, ctx: MotionContext): TrajectoryResult {
    const step = this.speed * ctx.dt;
    this.traveled += step;
    if (this.traveled >= this.speed * this.lifeSec || (this.dir.x === 0 && this.dir.y === 0)) {
      return { x, y, alive: false };
    }
    return { x: x + this.dir.x * step, y: y + this.dir.y * step, alive: true };
  }
}

/** 追踪：转向角速度/追踪时长/丢目标行为三限制（docs/02 §3）；home=true 时追踪主人（飞盘返回段）。 */
export class HomingTrajectory implements Trajectory {
  private dir: { x: number; y: number };
  private traveled = 0;
  private life: number;

  constructor(
    dirX: number,
    dirY: number,
    private speed: number,
    private maxRange: number,
    private target: Targetable | null,
    private cfg: { turnRate: number; duration: number; retarget: boolean; home?: boolean },
  ) {
    this.dir = norm(dirX, dirY);
    this.life = cfg.duration;
  }

  update(x: number, y: number, ctx: MotionContext): TrajectoryResult {
    const step = this.speed * ctx.dt;
    this.traveled += step;
    this.life -= ctx.dt;

    let tx: number | null = null;
    let ty: number | null = null;
    if (this.cfg.home) {
      tx = ctx.ownerX;
      ty = ctx.ownerY;
    } else if (this.target && this.target.hp > 0) {
      tx = this.target.x;
      ty = this.target.y;
    } else if (this.cfg.retarget && this.life > 0) {
      const next = ctx.nearestMonster(x, y, 600, new Set());
      if (next) {
        this.target = next;
        tx = next.x;
        ty = next.y;
      }
    }

    if (tx !== null && ty !== null) {
      const want = norm(tx - x, ty - y);
      const maxTurn = (this.cfg.turnRate * Math.PI / 180) * ctx.dt;
      const dot = this.dir.x * want.x + this.dir.y * want.y;
      if (dot > Math.cos(maxTurn)) {
        this.dir = want;
      } else {
        const cross = this.dir.x * want.y - this.dir.y * want.x;
        const ang = Math.atan2(this.dir.y, this.dir.x) + Math.sign(cross || 1) * maxTurn;
        this.dir = { x: Math.cos(ang), y: Math.sin(ang) };
      }
    }

    if (this.traveled >= this.maxRange) return { x, y, alive: false };
    return { x: x + this.dir.x * step, y: y + this.dir.y * step, alive: true };
  }
}

/** 抛物线：飞向发射时锁定的落点（射程即落距），到达即"落地"消亡（触发落地效果）；height 供渲染画弧。 */
export class ParabolaTrajectory implements Trajectory {
  private dir: { x: number; y: number };
  private traveled = 0;

  constructor(dirX: number, dirY: number, private speed: number, private range: number, private peak: number) {
    this.dir = norm(dirX, dirY);
  }

  update(x: number, y: number, ctx: MotionContext): TrajectoryResult {
    const step = this.speed * ctx.dt;
    this.traveled += step;
    if (this.traveled >= this.range) {
      return { x: x + this.dir.x * step, y: y + this.dir.y * step, alive: false, height: 0 };
    }
    const k = this.traveled / this.range;
    return {
      x: x + this.dir.x * step,
      y: y + this.dir.y * step,
      alive: true,
      height: Math.sin(k * Math.PI) * this.peak,
    };
  }
}

/** 螺旋：沿主轴前进 + 垂直方向正弦摆动（钻头/旋转刃）。 */
export class SpiralTrajectory implements Trajectory {
  private baseX = 0;
  private baseY = 0;
  private phase: number;
  private traveled = 0;
  private started = false;

  constructor(
    dirX: number,
    dirY: number,
    private speed: number,
    private range: number,
    private angularSpeed: number,
    private radius: number,
  ) {
    this.dir = norm(dirX, dirY);
    this.phase = 0;
  }
  private dir: { x: number; y: number };

  update(x: number, y: number, ctx: MotionContext): TrajectoryResult {
    if (!this.started) {
      this.baseX = x;
      this.baseY = y;
      this.started = true;
    }
    const step = this.speed * ctx.dt;
    this.traveled += step;
    if (this.traveled >= this.range) return { x, y, alive: false };
    this.phase += this.angularSpeed * ctx.dt;
    this.baseX += this.dir.x * step;
    this.baseY += this.dir.y * step;
    // 垂直于主轴的偏移
    const px = -this.dir.y;
    const py = this.dir.x;
    const off = Math.sin(this.phase) * this.radius;
    return { x: this.baseX + px * off, y: this.baseY + py * off, alive: true };
  }
}

/** 蛇形（折线波）：沿主轴前进 + 垂直方向高频摆动（闪避弹道/波动弹）。 */
export class ZigzagTrajectory implements Trajectory {
  private dir: { x: number; y: number };
  private baseX = 0;
  private baseY = 0;
  private phase = 0;
  private traveled = 0;
  private started = false;

  constructor(
    dirX: number,
    dirY: number,
    private speed: number,
    private range: number,
    private frequency: number,
    private amplitude: number,
  ) {
    this.dir = norm(dirX, dirY);
  }

  update(x: number, y: number, ctx: MotionContext): TrajectoryResult {
    if (!this.started) {
      this.baseX = x;
      this.baseY = y;
      this.started = true;
    }
    const step = this.speed * ctx.dt;
    this.traveled += step;
    if (this.traveled >= this.range) return { x, y, alive: false };
    this.phase += this.frequency * Math.PI * 2 * ctx.dt;
    this.baseX += this.dir.x * step;
    this.baseY += this.dir.y * step;
    const px = -this.dir.y;
    const py = this.dir.x;
    const off = Math.sin(this.phase) * this.amplitude;
    return { x: this.baseX + px * off, y: this.baseY + py * off, alive: true };
  }
}

/** 路径点：依次途经给定点（折线/巡逻弹），走完消亡（loop 则循环）。 */
export class WaypointTrajectory implements Trajectory {
  private idx = 0;

  constructor(private speed: number, private points: { x: number; y: number }[], private loop: boolean) {}

  update(x: number, y: number, ctx: MotionContext): TrajectoryResult {
    if (this.points.length === 0) return { x, y, alive: false };
    const step = this.speed * ctx.dt;
    let cx = x;
    let cy = y;
    let remain = step;
    for (let guard = 0; guard < 8; guard++) {
      const p = this.points[this.idx];
      const dx = p.x - cx;
      const dy = p.y - cy;
      const d = Math.hypot(dx, dy);
      if (d <= remain) {
        cx = p.x;
        cy = p.y;
        remain -= d;
        this.idx++;
        if (this.idx >= this.points.length) {
          if (this.loop) this.idx = 0;
          else return { x: cx, y: cy, alive: false };
        }
      } else {
        cx += (dx / d) * remain;
        cy += (dy / d) * remain;
        break;
      }
    }
    return { x: cx, y: cy, alive: true };
  }
}

/** 悬停：原地不动（飞盘悬停段）。 */
export class HoverTrajectory implements Trajectory {
  update(x: number, y: number): TrajectoryResult {
    return { x, y, alive: true };
  }
}

/**
 * 阶段机：按顺序执行阶段（每阶段一个运动基元 + 结束条件）。
 * 飞盘 = 飞出(distance) → 悬停(duration) → 返回(nearOwner)，用 frisbeeConfig 生成。
 */
export class PhaseTrajectory implements Trajectory {
  private phaseIdx = 0;
  private child: Trajectory;
  private phaseDist = 0;
  private phaseTime = 0;

  constructor(private phases: PhaseConfig[], launch: TrajectoryLaunch) {
    if (phases.length === 0) throw new Error('PhaseTrajectory 至少需要一段');
    this.child = createTrajectory(phases[0].motion, launch);
  }

  update(x: number, y: number, ctx: MotionContext): TrajectoryResult {
    const res = this.child.update(x, y, ctx);
    this.phaseDist += Math.hypot(res.x - x, res.y - y);
    this.phaseTime += ctx.dt;

    const until = this.phases[this.phaseIdx].until;
    let done = false;
    switch (until.kind) {
      case 'distance':
        done = this.phaseDist >= until.value;
        break;
      case 'duration':
        done = this.phaseTime >= until.value;
        break;
      case 'nearOwner':
        done = Math.hypot(res.x - ctx.ownerX, res.y - ctx.ownerY) <= until.value;
        break;
    }

    if (done) {
      if (this.phaseIdx >= this.phases.length - 1) {
        return { x: res.x, y: res.y, alive: false };
      }
      this.phaseIdx++;
      this.phaseDist = 0;
      this.phaseTime = 0;
      this.child = createTrajectory(this.phases[this.phaseIdx].motion, {
        dirX: res.x - x || 1,
        dirY: res.y - y || 0,
        target: null,
      });
    }
    return { x: res.x, y: res.y, alive: res.alive };
  }
}

/** 飞盘预设：飞出 → 悬停 → 返回主人。 */
export function frisbeeConfig(speed: number, outRange: number, hoverSec: number, returnSpeed: number): TrajectoryConfig {
  return {
    type: 'phased',
    phases: [
      { motion: { type: 'straight', speed, life: (outRange + 200) / speed }, until: { kind: 'distance', value: outRange } },
      { motion: { type: 'hover' }, until: { kind: 'duration', value: hoverSec } },
      {
        motion: { type: 'homing', speed: returnSpeed, range: 99999, turnRate: 720, duration: 99, retarget: false, home: true },
        until: { kind: 'nearOwner', value: 40 },
      },
    ],
  };
}
