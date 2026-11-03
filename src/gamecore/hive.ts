/**
 * 虫巢对抗系统（docs/13）：菌毯三层 + 活性 + 瘤 + 虫巢 + 地堡免疫 + 虫核经济 + 孵兵决策。
 *
 * 边界：纯逻辑，不依赖渲染；不直接创建怪物——通过回调 onHatch(monsterKey, x, y) 交给 session。
 * 只在关卡带 `level.hive` 时由 session 启用（第一章/实验室/测试不受影响）。
 *
 * 关键机制（对齐 docs/13）：
 *  - 菌毯地面：90px 网格 cellKey → 活性 a(0~100)。由"该网格虫群密度阈值"驱动涨落。
 *  - 菌毯瘤：不进入索敌表；被 AOE/穿透顺带波及掉 HP；打空→休眠→复活。是菌毯的"发动机"（附近活性回升快）。
 *  - 虫巢：唯一可摧毁目标；可左右移动；茧壳护甲由"全局平均活性"剥离；产虫核、孵兵。
 *  - 地堡：覆盖区永久免疫菌毯（菌毯无法长入）。
 *  - 只在菌毯上孵兵：出生点 = 最靠前（y 最小）的高活性瘤；无可用瘤时从虫巢旁孵。
 */
import { BunkerRuntime, HiveLevelConfig, HiveRuntime, MonsterRuntime, TumorRuntime } from './data/types';

const CELL = 90;

export interface HiveDeps {
  arenaW: number;
  arenaH: number;
  /** 现存活怪物（用于区域密度统计与地堡/瘤判定） */
  monsters: readOnlyMonsters;
  /** 当前时间（秒） */
  now: number;
  /** 孵兵回调 */
  onHatch: (monsterKey: string, x: number, y: number) => void;
  /** 事件/上报（可选） */
  onEvent?: (evt: string, payload?: Record<string, number | string>) => void;
}
type readOnlyMonsters = readonly MonsterRuntime[];

function cellKey(cx: number, cy: number): number {
  return cx * 4096 + cy;
}

export class HiveSystem {
  readonly cfg: HiveLevelConfig;
  readonly hive: HiveRuntime;
  tumors: TumorRuntime[] = [];
  bunkers: BunkerRuntime[] = [];
  /** 菌毯网格活性：cellKey → a(0~100) */
  activity = new Map<number, number>();

  /** 参数（含缺省） */
  private readonly A: Required<NonNullable<HiveLevelConfig['activity']>>;
  private readonly T: Required<NonNullable<HiveLevelConfig['tumor']>>;
  private readonly M: Required<NonNullable<HiveLevelConfig['migrate']>>;
  private readonly E: Required<NonNullable<HiveLevelConfig['economy']>>;
  private nextId = 1;

  constructor(cfg: HiveLevelConfig) {
    this.cfg = cfg;
    this.A = {
      risePerSec: 3,
      fallPerSec: 8,
      thresholdLow: 3,
      thresholdHigh: 8,
      baseCap: 100,
      ...(cfg.activity ?? {}),
    };
    this.T = {
      hp: 80,
      maxCount: 9,
      spreadIntervalSec: 8,
      dormantSec: 6,
      reviveCost: 20,
      ...(cfg.tumor ?? {}),
    };
    this.M = {
      intervalSec: 50,
      durationSec: 1.5,
      armorBonusWhileMoving: 15,
      ...(cfg.migrate ?? {}),
    };
    this.E = {
      hiveIncomePerSec: 2,
      tumorIncomeScale: 1.5,
      startBiomass: 30,
      unitCost: { zerg_ling: 5, zerg_roach: 12, zerg_lurker: 25, zerg_queen: 60, baneling: 20, zerg_ultra: 120 },
      ...(cfg.economy ?? {}),
    };
    this.hive = {
      x: cfg.hivePos.x,
      y: cfg.hivePos.y,
      hp: cfg.hiveHp,
      maxHp: cfg.hiveHp,
      armor: cfg.hiveArmorMax,
      armorMax: cfg.hiveArmorMax,
      migrateLeft: 0,
      migrateCd: this.M.intervalSec,
      targetX: cfg.hivePos.x,
      biomass: this.E.startBiomass,
      biomassEarned: 0,
      hatchLeft: 1.5,
      armorTickLeft: 10,
      dead: false,
    };
    // 初始菌毯：虫巢周围一圈
    this.paintAround(cfg.hivePos.x, cfg.hivePos.y, 2);
    // 初始 1~2 个瘤
    this.spawnTumor(cfg.hivePos.x, cfg.hivePos.y - 180);
    // 地堡
    this.bunkers = (cfg.bunkers ?? []).map((b) => ({ x: b.x, y: b.y, r: b.r, hp: b.hp, maxHp: b.hp }));
  }

  // ---------------- 菌毯网格 ----------------

  private keyAt(x: number, y: number): number {
    return cellKey(Math.floor(x / CELL), Math.floor(y / CELL));
  }
  private cx(k: number): number {
    return Math.floor(k / 4096);
  }
  private cy(k: number): number {
    return k % 4096;
  }
  private cellCenterX(k: number): number {
    return this.cx(k) * CELL + CELL / 2;
  }
  private cellCenterY(k: number): number {
    return this.cy(k) * CELL + CELL / 2;
  }

  hasCreep(x: number, y: number): boolean {
    return this.activity.get(this.keyAt(x, y)) !== undefined;
  }

  /** 在 (x,y) 半径格数内刷菌毯（避开地堡覆盖）。 */
  private paintAround(x: number, y: number, cells: number): void {
    const cx0 = Math.floor(x / CELL);
    const cy0 = Math.floor(y / CELL);
    for (let dx = -cells; dx <= cells; dx++) {
      for (let dy = -cells; dy <= cells; dy++) {
        if (dx * dx + dy * dy > cells * cells) continue;
        const px = (cx0 + dx) * CELL + CELL / 2;
        const py = (cy0 + dy) * CELL + CELL / 2;
        if (px < 0 || px > this.cfg.hiveMoveRange[1] + 200 || py < 0) continue;
        if (this.inBunker(px, py)) continue; // 地堡免疫
        const k = cellKey(cx0 + dx, cy0 + dy);
        if (this.activity.get(k) === undefined) this.activity.set(k, 40);
      }
    }
  }

  private inBunker(x: number, y: number): boolean {
    for (const b of this.bunkers) {
      if (b.hp <= 0) continue;
      const dx = x - b.x;
      const dy = y - b.y;
      // 方形覆盖近似
      if (Math.abs(dx) <= b.r && Math.abs(dy) <= b.r) return true;
    }
    return false;
  }

  /** 某个瘤是否已休眠（休眠瘤不产收入、不孵兵）。 */
  private activeTumors(): TumorRuntime[] {
    return this.tumors.filter((t) => !t.dormant);
  }

  // ---------------- 瘤 ----------------

  private spawnTumor(x: number, y: number): void {
    if (this.tumors.length >= this.T.maxCount) return;
    if (this.inBunker(x, y)) return;
    const cx = Math.max(1, Math.min(this.cfg.hiveMoveRange[1], x));
    this.tumors.push({
      id: this.nextId++,
      x: cx,
      y,
      hp: this.T.hp,
      maxHp: this.T.hp,
      dormant: false,
      dormantLeft: 0,
      spreadLeft: this.T.spreadIntervalSec,
    });
  }

  /** 供战斗层调用：对瘤造成（AOE/穿透的顺带）伤害；不秒，掉空→休眠。 */
  damageTumor(t: TumorRuntime, dmg: number): void {
    if (t.dormant) return;
    t.hp -= dmg;
    if (t.hp <= 0) {
      t.hp = 0;
      t.dormant = true;
      t.dormantLeft = this.T.dormantSec;
    }
  }

  /** 玩家火力/AOE 波及某点：对附近的瘤施加顺带伤害（用于穿透/溅射/AOE 弹）。 */
  applySplashToTumors(x: number, y: number, radius: number, dmg: number): void {
    for (const t of this.tumors) {
      if (t.dormant) continue;
      const dx = t.x - x;
      const dy = t.y - y;
      if (dx * dx + dy * dy <= (radius + 30) * (radius + 30)) this.damageTumor(t, dmg);
    }
  }

  // ---------------- 主更新 ----------------

  update(dt: number, deps: HiveDeps): void {
    if (this.hive.dead) return;
    const now = deps.now;

    // 1) 活性更新（区域虫群密度阈值驱动）
    this.updateActivity(dt, deps.monsters);

    // 2) 瘤增殖 + 休眠复活
    this.updateTumors(dt);

    // 3) 虫核经济
    this.updateEconomy(dt);

    // 4) 虫巢护甲剥离（全局平均活性）
    this.updateArmor(dt);

    // 5) 虫巢迁徙
    this.updateMigration(dt);

    // 6) 孵兵
    this.updateHatch(dt, deps);

    // 7) 虫巢被摧毁？
    if (this.hive.hp <= 0 && this.hive.armor <= 0) {
      this.hive.dead = true;
      deps.onEvent?.('hiveDead');
    }
  }

  /** 区域虫群密度统计：每格虫数；据此涨落活性。 */
  private updateActivity(dt: number, monsters: readOnlyMonsters): void {
    // 统计每格虫数
    const count = new Map<number, number>();
    for (const m of monsters) {
      if (m.hp <= 0) continue;
      const k = this.keyAt(m.x, m.y);
      count.set(k, (count.get(k) ?? 0) + 1);
    }
    const { risePerSec, fallPerSec, thresholdLow, thresholdHigh, baseCap } = this.A;
    for (const k of this.activity.keys()) {
      const n = count.get(k) ?? 0;
      let a = this.activity.get(k)!;
      if (n > thresholdHigh) a += risePerSec * dt;
      else if (n <= thresholdLow) a -= fallPerSec * dt;
      // 瘤周边 / 虫巢周边：回升基线
      const px = this.cellCenterX(k);
      const py = this.cellCenterY(k);
      if (this.nearTumor(px, py)) a += 2 * dt;
      if (Math.hypot(px - this.hive.x, py - this.hive.y) < 260) a += 4 * dt;
      a = Math.max(0, Math.min(baseCap, a));
      this.activity.set(k, a);
    }
  }

  private nearTumor(x: number, y: number): boolean {
    for (const t of this.tumors) {
      if (t.dormant) continue;
      if (Math.abs(t.x - x) <= CELL * 1.2 && Math.abs(t.y - y) <= CELL * 1.2) return true;
    }
    return false;
  }

  private updateTumors(dt: number): void {
    const alive = this.tumors.length;
    for (const t of this.tumors) {
      if (t.dormant) {
        t.dormantLeft -= dt;
        if (t.dormantLeft <= 0 && this.hive.biomass >= this.T.reviveCost) {
          this.hive.biomass -= this.T.reviveCost;
          t.dormant = false;
          t.hp = t.maxHp * 0.5;
        }
        continue;
      }
      t.spreadLeft -= dt;
      if (t.spreadLeft <= 0) {
        t.spreadLeft += this.T.spreadIntervalSec;
        // 朝"最靠前（y 更小）/朝向城墙"方向长菌毯 + 概率生新瘤
        this.paintAround(t.x, t.y - CELL, 1);
        if (alive < this.T.maxCount && this.rngLike() < 0.5) {
          this.spawnTumor(t.x, t.y - CELL * 1.5);
        }
      }
    }
  }

  private rngLike(): number {
    // 简单确定性伪随机（以 tick 计数扰动）；不依赖外部 rng 以保证模块独立
    this.nextId = (this.nextId * 1103515245 + 12345) & 0x7fffffff;
    return (this.nextId % 1000) / 1000;
  }

  /** 全局平均活性（仅统计有菌毯的格） */
  avgActivity(): number {
    if (this.activity.size === 0) return 0;
    let sum = 0;
    for (const a of this.activity.values()) sum += a;
    return sum / this.activity.size;
  }

  private updateEconomy(dt: number): void {
    const tumorCount = this.activeTumors().length;
    const income = this.E.hiveIncomePerSec + tumorCount * (this.avgActivity() / 100) * this.E.tumorIncomeScale;
    this.hive.biomass += income * dt;
    this.hive.biomassEarned += income * dt;
  }

  private updateArmor(dt: number): void {
    if (this.hive.armor <= 0) return;
    this.hive.armorTickLeft -= dt;
    if (this.hive.armorTickLeft <= 0) {
      this.hive.armorTickLeft += 10;
      // 每 10s：下降量 ∝ (100 - 平均活性)/10
      const drop = Math.max(0, (100 - this.avgActivity()) / 10);
      this.hive.armor = Math.max(0, this.hive.armor - drop);
    }
  }

  private updateMigration(dt: number): void {
    if (this.hive.migrateLeft > 0) {
      // 迁徙中：向 targetX 移动
      this.hive.migrateLeft -= dt;
      const dx = this.hive.targetX - this.hive.x;
      const step = Math.min(Math.abs(dx), 120 * dt);
      this.hive.x += Math.sign(dx) * step;
      if (this.hive.migrateLeft <= 0) {
        this.hive.x = this.hive.targetX;
        this.hive.migrateCd = this.M.intervalSec;
      }
      return;
    }
    this.hive.migrateCd -= dt;
    if (this.hive.migrateCd <= 0) {
      // 触发迁徙：选一个远离当前的方向（左右）
      const [minX, maxX] = this.cfg.hiveMoveRange;
      const span = maxX - minX;
      const drift = (this.rngLike() - 0.5) * span * 0.6;
      this.hive.targetX = Math.max(minX, Math.min(maxX, this.hive.x + drift));
      this.hive.migrateLeft = this.M.durationSec;
    }
  }

  private updateHatch(dt: number, deps: HiveDeps): void {
    if (this.hive.migrateLeft > 0) return; // 迁徙不孵兵
    this.hive.hatchLeft -= dt;
    if (this.hive.hatchLeft > 0) return;
    this.hive.hatchLeft += 1.6;

    // 可孵单位：按虫核累计收入解锁
    const pool = this.unlockedUnits();
    if (pool.length === 0) return;
    const key = pool[Math.floor(this.rngLike() * pool.length) % pool.length];
    const cost = this.E.unitCost[key] ?? 10;
    if (this.hive.biomass < cost) return;
    this.hive.biomass -= cost;

    // 出生点：最靠前（y 最小）的活跃瘤；否则虫巢旁
    const src = this.frontTumor();
    let sx: number;
    let sy: number;
    if (src) {
      sx = src.x + (this.rngLike() - 0.5) * 40;
      sy = src.y - 20;
    } else {
      sx = this.hive.x + (this.rngLike() - 0.5) * 80;
      sy = this.hive.y - 60;
    }
    // 出生必须在菌毯上：若该点无菌毯，画一小片
    if (!this.hasCreep(sx, sy)) this.paintAround(sx, sy, 1);
    deps.onHatch(key, sx, sy);
    deps.onEvent?.('hatch', { x: sx, y: sy });
  }

  private frontTumor(): TumorRuntime | null {
    let best: TumorRuntime | null = null;
    for (const t of this.activeTumors()) {
      if (!best || t.y < best.y) best = t;
    }
    return best;
  }

  /** 已解锁单位（缺省：初始只有 zerg_ling，随累计虫核解锁） */
  unlockedUnits(): string[] {
    const list: string[] = ['zerg_ling'];
    const unlock = this.cfg.unlock ?? [
      { monster: 'zerg_roach', needBiomass: 60 },
      { monster: 'baneling', needBiomass: 140 },
      { monster: 'zerg_lurker', needBiomass: 240 },
      { monster: 'zerg_queen', needBiomass: 400 },
      { monster: 'zerg_ultra', needBiomass: 700 },
    ];
    for (const u of unlock) {
      if (this.hive.biomassEarned >= u.needBiomass) list.push(u.monster);
    }
    return list;
  }

  // ---------------- 战斗接口 ----------------

  /** 玩家对虫巢造成伤害：护甲>0 时免伤（不能拆家）。返回实际伤害。 */
  damageHive(raw: number): number {
    if (this.hive.dead) return 0;
    if (this.hive.armor > 0) return 0; // 茧壳未破：本体免伤
    const dealt = Math.min(this.hive.hp, raw);
    this.hive.hp -= dealt;
    return dealt;
  }

  /** 虫族摧毁玩家设施后：玩家核心护甲下降（对称）。由 session 记录。 */
  /** 地堡是否被摧毁（供 session 侦测）。 */
  bunkersAlive(): number {
    return this.bunkers.filter((b) => b.hp > 0).length;
  }

  /** 虫群攻击地堡（毒爆/雷兽靠近时调用）。 */
  damageBunker(x: number, y: number, dmg: number): void {
    for (const b of this.bunkers) {
      if (b.hp <= 0) continue;
      if (Math.abs(b.x - x) <= b.r + 20 && Math.abs(b.y - y) <= b.r + 20) {
        b.hp = Math.max(0, b.hp - dmg);
        return;
      }
    }
  }
}
