import { DamageType } from '../damage';
import { TargetingRule } from '../targeting';
import { TrajectoryConfig } from '../trajectory';

// ---------- 配置表类型（与 configs/*.json 对应） ----------

export interface WeaponConfig {
  id: string;
  name: string;
  damageType: DamageType;
  baseDamage: number;
  interval: number;        // 攻击间隔（秒）
  count: number;           // 每次发射数量
  projectileSpeed: number; // px/s
  /** 索敌距离（px，锁定目标的最远距离；长枪管卡强化它）——不是子弹飞行距离 */
  projectileRange: number;
  /** 子弹寿命（秒）：按飞行时间存活，命中/出屏/寿尽才消失（默认 2.5s，全屏武器 3s） */
  bulletLife?: number;
  projectileRadius: number;
  pierce: number;          // 穿透目标数（0=命中即消失）
  /** 穿透伤害衰减率（每穿透一个目标，伤害 ×(1-衰减率)）；破甲每级削减 5%，最低 0（docs/02 §2） */
  pierceFalloff?: number;
  targeting: TargetingRule;
  /** 运动形态（docs/07 弹道行为库）；缺省 straight。homing 可被"追踪弹"词缀附加 */
  trajectory: 'straight' | 'homing';
  /** 声明式运动配置（优先于 trajectory 字段），供新武器/AI 生成内容使用 */
  motion?: TrajectoryConfig;
  homing?: { turnRate: number; duration: number; retarget: boolean };
  /** 枪管过热：每发射 shots 次（一轮齐射/连射计 1 次）强制冷却 cooldown 秒 */
  heat?: { shots: number; cooldown: number };
  /** ≥1 = 落雷武器：开火不产生子弹，直接以"1+连锁等级"次打击落雷（连锁闪电武器本体） */
  chainBase?: number;
    /** 子弹视觉形态（docs/06）：dot 光点 / arrow 箭矢 / bomb 抛物弹 / gear 齿轮圆盘 */
  shape?: string;
  /** 齐射扇形间距（rad/档，默认 0.1）；大型弹体（齿轮盘）建议加大以拉开间距 */
  spread?: number;
  /** 内置爆破（爆破系武器本体）：子弹消亡时产生范围伤害圈（可被"爆破落地"卡叠加强化） */
  blastBase?: { radius: number; dmgMul: number; poolDpsMul: number; poolSec: number };
  /** 武器谱系定位（docs/02 §6 分类）：速射 / 贯穿 / 爆破 / 回旋 / 雷霆 */
  role?: string;
}

export type MonsterBehavior =
  | 'march' | 'zigzag' | 'dash' | 'fast_rush'
  | 'ranged' | 'splitter' | 'shielded';

export interface MonsterConfig {
  id: string;
  name: string;
  hp: number;
  def: number;
  speed: number;           // px/s
  radius: number;
  atk: number;             // 单次对墙伤害
  attackInterval: number;  // 对墙攻击间隔（秒）
  behavior: MonsterBehavior;
  /** ranged 停驻射击距离（距城墙，默认 260）：投矛手 260 / 投石车 600 */
  rangedDist?: number;
  /** 免伤盾：抵消 N 次直接命中（每被命中一次消耗 1 层；DoT/伤害圈等持续伤害不消耗） */
  hitShield?: number;
  /** 灼烧免疫：不可被点燃 */
  burnImmune?: boolean;
  /** 治疗光环：每 interval 秒为半径内友军回血 amount（不可超过上限） */
  healAura?: { radius: number; amount: number; interval: number };
  /** 出场护卫：生成时在自身周围 radius 半径部署 count 只 escort 怪（环形站位） */
  escort?: { monster: string; count: number; radius: number };
  /** 伤害转嫁（始终生效）：受到的直接伤害转移给半径内随机友军（无友军则自己承受） */
  transferAura?: { radius: number };
  /** 近墙变阵：与城墙距离小于该值时，护卫排成一排啃墙、巫师居中（docs/04 §1.2） */
  formationDist?: number;
  xp: number;              // 经验（击杀自动吸收）
  /** 伤害类型弱点：受到该类型 ×1.25（docs/01 §2.1） */
  weak?: DamageType[];
  /** 伤害类型抗性：受到该类型 ×0.75 */
  resist?: DamageType[];
  /** 外观形态（docs/06 形状语言）：slime/wolf/charger/thrower/bulwark/bat/shroom/boss */
  shape?: string;
}

export type CardRarity = 'common' | 'rare' | 'epic' | 'legendary';

// 三类增强维度（docs/03 §2）扩展为统一目标体系：
// - passive：英雄公共属性（所有武器共享）
// - bullet：武器弹道参数（可声明武器专属）
// - wall：城墙
// - form：形态机制词缀（通用）
// - grantElement / boostElement：元素赋予与元素加持（见 CardTarget 门控）
export type CardType = 'passive' | 'bullet' | 'wall' | 'form' | 'element';

export type PassiveStat = 'atk' | 'aspd' | 'moveSpeed' | 'critChance' | 'critDmg' | 'dmgMul';
export type BulletStat = 'count' | 'burst' | 'projSpeed' | 'damage' | 'range' | 'pierce';
export type WallStat = 'wallMax' | 'wallRepair';
export type FormId =
  | 'homing' | 'bounce' | 'split' | 'shred' | 'blast' | 'chain';

export type CardEffect =
  | { stat: PassiveStat; op: 'add' | 'mul'; value: number }        // passive 公共属性
  | { bullet: BulletStat; op: 'add' | 'mul'; value: number }       // bullet 弹道参数
  | { wall: WallStat; op: 'add' | 'mul'; value: number }           // wall
  | { form: FormId; value: number }                                // form 形态词缀
  | { grantElement: DamageType }                                   // 元素赋予（改武器元素 + 基础骑士效果）
  | { boostElement: DamageType; value: number };                   // 元素加持（需武器已携带该元素）

/**
 * 卡牌适用目标（统一门控，docs/03 §2.2）：
 * - any：公共卡，对所有武器生效
 * - weapon：武器专属卡（仅当持有该武器时进入卡池，如 步枪的齐射/连射）
 * - element：元素专属卡（仅当某武器已携带该元素时进入卡池，如 烈火需火属性）
 */
export type CardTarget =
  | { kind: 'any' }
  | { kind: 'weapon'; weaponType: string }
  | { kind: 'element'; element: DamageType };

export interface CardConfig {
  id: string;
  name: string;
  rarity: CardRarity;
  type: CardType;
  /** 适用目标（缺省 = 公共） */
  target?: CardTarget;
  effect: CardEffect;
  maxStack: number;
  /** UI 展示用的效果描述 */
  desc?: string;
  /** 出现权重（默认 1；<1 降低三选一刷新率，如齐射/连射设为 1/3 防叠满无敌） */
  weight?: number;
}

export interface WaveSpawnConfig {
  monster: string;         // 引用 monsters 表 id
  count: number;
  spawnPoints: number[] | 'all';
  releasePerTick: number;  // 每逻辑帧放出数量（控制进场节奏）
}

export type WaveFormation = 'stream' | 'line' | 'pincer' | 'center';

export interface WaveConfig {
  banner: string;
  /** 出生阵型：stream 随机多点 / line 全线铺开 / pincer 两翼钳形 / center 中央突破（默认 stream） */
  formation?: WaveFormation;
  /** 出怪总时长（秒）：怪物按多段潮在此时间窗内连续放出（默认 60，约一分钟一波） */
  durationSec?: number;
  spawns: WaveSpawnConfig[];
}

export interface LevelConfig {
  id: string;
  name: string;
  arena: { width: number; height: number };
  wall: { height: number; hp: number };
  defenseRect: { yMin: number; yMax: number };  // 英雄可活动 y 范围（绝对坐标，底部为墙顶）
  spawnBandY: [number, number];                 // 怪物出生 y 带
  spawnPointsX: number[];                       // 出生点 x 坐标表
  prepareSec: number;
  intermissionSec: number;
  /** 每波清空的通关经验奖励（自动入账） */
  waveClearBonusXp?: number;
  waves: WaveConfig[];
}

// ---------- 运行时实体 ----------

export interface HeroStats {
  atk: number;
  aspd: number;
  moveSpeed: number;
  critChance: number;
  critDmg: number;
  dmgMul: number;
}

/** 子弹属性强化（A 类卡，作用于每把武器） */
export interface WeaponMods {
  extraCount: number;    // 齐射 +N
  burst: number;         // 连射额外次数
  projSpeedMul: number;  // 弹速倍率
  damageMul: number;     // 伤害倍率
  rangeMul: number;      // 射程倍率
  pierceAdd: number;     // 穿透 +N（贯穿卡）
}

/** 形态机制词缀（C 类卡，挂在武器实例上，发射时快照到投射物） */
export interface WeaponAffixes {
  homing: number;     // ≥1：追踪弹
  bounce: number;     // 击中弹射次数
  split: number;      // 击杀分裂弹数
  shred: number;      // 破甲：每级 -3 防御（0 = 无），并削减穿透衰减 5%/级
  blast: number;      // 爆破落地：≥1 时投射物消亡产生范围伤害圈
  chain: number;      // 连锁闪电：≥1 时该武器转为落雷（1+等级 击）
}

/** 元素骑士效果强度（随元素赋予卡解锁、元素加持卡成长，挂在武器实例上） */
export interface WeaponRiders {
  burnDpsMul: number; // 火焰：灼烧每秒伤害 = 弹伤 × 倍率（0 = 无）
  burnSec: number;
  slowPct: number;    // 寒冰：减速百分比（0 = 无）
  slowSec: number;
}

export interface HeroRuntime {
  x: number;
  y: number;
  stats: HeroStats;
  level: number;
  xp: number;
  weapons: WeaponInstance[];
}

export interface WeaponInstance {
  cfg: WeaponConfig;
  level: number;
  damage: number;          // 面板伤害（不含子弹卡倍率；结算时 × mods.damageMul）
  cooldown: number;
  /** 枪管过热：当前连射计数（达 cfg.heat.shots 后强制冷却） */
  shotsSinceCool: number;
  mods: WeaponMods;
  /** 当前元素（默认 = cfg.damageType；可被元素赋予卡改变，享受类型克制与骑士效果） */
  element: DamageType;
  /** 元素骑士效果（灼烧/冰冻强度，随元素加持卡成长） */
  riders: WeaponRiders;
  /** 形态词缀（追踪/弹射/分裂/破甲/爆破/连锁） */
  affixes: WeaponAffixes;
}

/** 怪物远程弹（可见弹道：投矛/投石，落点结算对墙伤害） */
export interface MonsterShot {
  sx: number; sy: number;   // 起点
  tx: number; ty: number;   // 落点（城墙）
  x: number; y: number;
  height: number;
  t: number;                // 0~1 飞行进度
  dur: number;
  dmg: number;
  kind: 'spear' | 'rock';
}

export interface MonsterRuntime {
  id: number;              // tick 内 = monsters 数组下标（session 维护的密度数组约定）
  cfg: MonsterConfig;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  state: 'march' | 'assault';
  attackTimer: number;
  phase: number;           // zigzag/dash 相位
  /** 附着的火焰（灼烧）：定时跳伤害直至熄灭；重复命中只刷新时长，不叠加（叠加需专门卡牌） */
  burn: { dps: number; until: number; nextTick: number } | null;
  shieldLeft: number;      // 剩余免伤层数（hitShield）
  healTimer: number;       // 治疗光环计时（healAura）
  /** 队籍：护卫=领队巫师运行时 id；无编队为 -1（变阵系统用） */
  groupId: number;
  /** 领队：近墙变阵是否激活（护卫排一排啃墙、巫师居中） */
  formationActive: boolean;
  /** 变阵后分配的横排位（护卫用） */
  slotX: number;
  /** 编队序号/角度：行军相位环绕领队站位、变阵相位按序号排横排 */
  formIndex: number;
  formAngle: number;
  slowUntil: number;       // 冰冻减速
  slowFactor: number;
  shredUntil: number;      // 破甲
  shredAmount: number;
}

/** 爆破落地：投射物消亡时的范围伤害圈参数（按 blast 等级在发射时快照） */
export interface BlastSpec {
  radius: number;
  dmgMul: number;    // 瞬时 AOE = 弹伤 × 倍率
  poolDpsMul: number;
  poolSec: number;
}

export interface ProjectileRuntime {
  id: number;
  weapon: WeaponInstance;
  x: number;
  y: number;
  px: number;              // 上一帧位置（扫掠碰撞用，防高速弹穿透）
  py: number;
  stepLen: number;         // 本帧位移长度（扫掠查询半径用）
  radius: number;
  speed: number;           // 最终弹速（含子弹卡倍率）
  dmg: number;             // 最终单发伤害（含倍率）
  height: number;          // 俯视离地高度（抛物线渲染用，每帧由轨迹回写）
  damageType: DamageType;
  trajectory: import('../trajectory').Trajectory;
  /**
   * 已命中记录：monsterId → 最近命中时间。
   * 0.5s 重击冷却：悬停/回旋类武器可对同一目标反复切割（血滴子研磨），
   * 冷却期内不再结算（也用于弹射/连锁的"未命中"判定）。
   */
  hitIds: Map<number, number>;
  pierceLeft: number;
  pierceCount: number;    // 已穿透次数（穿透伤害衰减结算用）
  bounceLeft: number;      // 剩余弹射次数
  alive: boolean;
  affixes: WeaponAffixes;  // 发射武器的词缀快照（局内构筑只增不减，引用即可）
  riders: WeaponRiders;    // 发射武器的元素骑士快照
  homing: boolean;        // 发射时是否追踪（重定向/衍生弹必须继承，否则弹射/分裂会让追踪失效）
  motionCfg: TrajectoryConfig; // 运动配置快照（弹射/分裂重定向时按配置重建，保证词缀继承）
  blast: BlastSpec | null;
}

/** 落地范围伤害圈（持续 DoT 区域） */
export interface DamagePool {
  x: number;
  y: number;
  radius: number;
  dps: number;
  until: number;
  damageType: DamageType;
}

/**
 * 线段伤害场（光束/两点连线，docs/07 §4）：
 * 对"线段胶囊体"内的怪物持续结算 dps，直到 until。
 * followOwner=true 时光束锚定英雄，按 angle/length 延伸（光束武器）；
 * 否则两端固定（电网连线/多点固定连接）。
 */
export interface SegmentField {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  width: number;
  dps: number;
  until: number;
  damageType: DamageType;
  followOwner?: boolean;
  angle?: number;
  length?: number;
}
