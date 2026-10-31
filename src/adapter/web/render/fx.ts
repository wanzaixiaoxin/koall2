/**
 * 动效参数与缓动库（docs/06 §3）——configs/art-style/fx-config.json 的唯一消费者。
 *
 * 职责边界：
 *  - 只做「参数加载 + 缓动数学 + 轻量状态（闪白计时）」，不持有 canvas、不绘制。
 *  - 绘制仍在 render/ 层；本模块只回答「现在应该是什么值」。
 *  - 纯适配层组件，不得被 gamecore 引用（保持引擎解耦）。
 *
 * 「好 > 无 > 有」：所有效果默认值为中性（scale=1、闪白=0），
 * 配置缺失或字段缺省时行为与改造前完全一致，不会凭空产生错误效果。
 */

/** fx-config.json 的结构（宽松映射：允许美术侧只写关心的几项）。 */
export interface FxConfig {
  hitFlash?: { duration?: number; easing?: string; note?: string };
  squashStretch?: { duration?: number; easing?: string; scaleY?: number[]; note?: string };
  spawnPop?: { duration?: number; easing?: string; scale?: number[]; note?: string };
  cardPop?: { duration?: number; easing?: string; scale?: number[]; note?: string };
  wallBreakSlowmo?: { duration?: number; timeScale?: number; easing?: string; note?: string };
  screenShake?: {
    hit?: { duration?: number; amplitude?: number };
    bossSkill?: { duration?: number; amplitude?: number };
    easing?: string;
  };
  wallHitShake?: { duration?: number; amplitude?: number; note?: string };
  wallBreatheWarn?: { interval?: number; glow?: number; note?: string };
  projectileTrail?: { fade?: number; note?: string };
  dashTelegraph?: { flashInterval?: number; note?: string };
  skillTelegraph?: { easing?: string; note?: string };
  gemMagnet?: { speed?: number; acceleration?: number; note?: string };
  levelUpFlash?: { duration?: number; easing?: string; note?: string };
}

/** 缓动函数库：统一签名，输入 t∈[0,1]（线性进度），输出缓动后的进度。 */
export type EasingFn = (t: number) => number;

const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t);

/** 缓动曲线表（内部使用；对外只经 easingOf 取用，避免外部直接依赖具体曲线实现）。 */
const Easing: Record<string, EasingFn> = {
  linear: (t) => t,
  easeOut: (t) => 1 - Math.pow(1 - t, 3),
  easeIn: (t) => t * t * t,
  easeInOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  /** 超调回弹：末段越过 1 再收回，用于挤压/弹出，产生「弹性」而非「软绵绵」 */
  easeOutBack: (t) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  },
  /** 多次振荡衰减：用于升级选卡这种「有仪式感」的弹出 */
  elastic: (t) => {
    if (t === 0 || t === 1) return t;
    const c4 = (2 * Math.PI) / 3;
    return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
  },
  /** 单调衰减：用于震屏、闪白这类「瞬间冲高后衰减」的曲线 */
  decay: (t) => 1 - t,
};

export function easingOf(name: string | undefined): EasingFn {
  if (name && Easing[name]) return Easing[name];
  return Easing.linear;
}

/**
 * 关键帧采样：把 [1, 0.75, 1.15, 1] 这类关键帧序列按缓动进度取样。
 * 这一条让 fx-config.json 里 squashStretch / spawnPop 的 scale 数组真正生效。
 */
export function sampleKeyframes(frames: number[] | undefined, t: number, easingName?: string): number {
  if (!frames || frames.length === 0) return 1;
  if (frames.length === 1) return frames[0];
  const k = clamp01(easingOf(easingName)(clamp01(t)));
  const seg = frames.length - 1;
  const pos = k * seg;
  const i = Math.min(seg - 1, Math.floor(pos));
  const local = pos - i;
  return frames[i] + (frames[i + 1] - frames[i]) * local;
}

// ---------------- 运行时状态：受击闪白 ----------------
/**
 * 闪白是「最高优先级动效」（shapes.md 可读性铁律 2），但此前只在配置里存在。
 * 这里用按怪物 id 记录的到期时间实现：着色时机由 render 层查询，逻辑不进 gamecore。
 */
export class FxRuntime {
  readonly cfg: FxConfig;

  /** monsterId → 闪白到期时刻（秒，与 session.timeSec 同一时间基准） */
  private flashUntil = new Map<number, number>();

  constructor(cfg: FxConfig) {
    this.cfg = cfg;
  }

  private get flashSec(): number {
    return (this.cfg.hitFlash?.duration ?? 80) / 1000;
  }

  /** 登记一次受击闪白（由 onHit 事件调用）。now 用渲染时间秒。 */
  markHit(monsterId: number, now: number): void {
    this.flashUntil.set(monsterId, now + this.flashSec);
  }

  /** 查询闪白强度 0~1（0=无闪白，1=刚被打中）。 */
  flashAlpha(monsterId: number, now: number): number {
    const until = this.flashUntil.get(monsterId);
    if (until === undefined) return 0;
    const left = until - now;
    if (left <= 0) {
      this.flashUntil.delete(monsterId); // 顺手清理，避免 Map 无限增长
      return 0;
    }
    const dur = this.flashSec;
    const t = dur > 0 ? 1 - left / dur : 0;
    // 前 30% 保持满亮（让玩家确实看见），后段用 decay 曲线收掉
    return clamp01(t < 0.3 ? 1 : easingOf(this.cfg.hitFlash?.easing ?? 'decay')((t - 0.3) / 0.7));
  }

  /**
   * 挤压回弹倍率（纵向），1 = 不变形。
   * 语义约束：**只有受击期间才允许偏离 1**。
   * 未受击时无条件返回 1，否则配置里的关键帧序列（如 [1,0.75,1.15,1]）
   * 会在怪物静止时被采样，导致全体永久变形。
   */
  hitSquash(monsterId: number, now: number): number {
    const a = this.flashAlpha(monsterId, now);
    if (a <= 0) return 1; // 未受击：中性，不施加任何形变
    const frames = this.cfg.squashStretch?.scaleY;
    const v = sampleKeyframes(frames, a, this.cfg.squashStretch?.easing);
    // 关键帧首值是「静止姿态」，把受击进度映射到 0..1 之间即可；
    // 若配置首值本身不是 1（美术想自定义静止姿态），则以首值为基准做相对变形。
    const base = frames && frames.length > 0 ? frames[0] : 1;
    return base === 0 ? v : v / base;
  }
}

/** 从 /configs/art-style/fx-config.json 加载；失败时回落为空配置（中性行为）。 */
export async function loadFxConfig(baseUrl = '/configs/art-style/fx-config.json'): Promise<FxConfig> {
  try {
    const r = await fetch(baseUrl);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()) as FxConfig;
  } catch {
    // 「无 > 有」：配置缺失时宁可没有效果，也不要给出错误效果
    console.warn('[fx] fx-config.json 加载失败，动效回落为中性默认值');
    return {};
  }
}
