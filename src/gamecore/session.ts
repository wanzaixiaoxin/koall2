import { EventBus } from './core/events';
import { Rng } from './core/rng';
import { SpatialHash } from './core/spatial-hash';
import { clamp, Vec2 } from './core/math';
import { calcDamage } from './damage';
import { createTrajectory, MotionContext, TrajectoryConfig } from './trajectory';
import {
  createHero,
  heroAttackerSnapshot,
  updateWeapons,
  applyStat,
  applyBulletMod,
  applyForm,
  FireCommand,
  xpNeed,
  BASE_ATK,
  rollCardChoices,
  CardPolicy,
} from './hero';
import { updateMonster } from './monster';
import {
  BlastSpec,
  CardConfig,
  DamagePool,
  HeroRuntime,
  LevelConfig,
  MonsterConfig,
  MonsterRuntime,
  MonsterShot,
  ProjectileRuntime,
  SegmentField,
  WeaponAffixes,
  WeaponConfig,
  WeaponInstance,
  WeaponRiders,
} from './data/types';

export const TICK_DT = 1 / 30; // 固定逻辑帧（docs/05 §1.2 帧模型）

/** 点到线段的最近距离（投射物扫掠碰撞用）。 */
function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const abx = bx - ax;
  const aby = by - ay;
  const len2 = abx * abx + aby * aby;
  if (len2 < 1e-9) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / len2));
  return Math.hypot(px - (ax + abx * t), py - (ay + aby * t));
}

export type GameResult = 'victory' | 'defeat';

export interface HeroController {
  /** 返回期望移动方向（单位向量或零向量），session 负责位移与钳制。 */
  getMoveDir(session: GameSession): Vec2;
}

export interface SessionOptions {
  level: LevelConfig;
  weaponConfigs: WeaponConfig[];
  monsterConfigs: ReadonlyMap<string, MonsterConfig>;
  cardConfigs: CardConfig[];
  seed: number;
  controller: HeroController;
  cardPolicy: CardPolicy;
}

type DirectorState = 'prepare' | 'spawning' | 'clearing' | 'intermission' | 'done';

interface SpawnItem {
  monsterKey: string;
  spawnX: number;
}

/** 带放行时刻的出怪条目（t = 波内相对秒数） */
interface ScheduledSpawn {
  at: number;
  item: SpawnItem;
}

/**
 * 波次导演（docs/04 §5）：prepare → spawning → clearing → intermission → … → done
 * 出怪模型：一波总怪物按 4~8 段潮连续放出——段内密集（windowSec 内集中进场），
 * 段间重叠衔接（下一段在上一段未清完时已开始进场），避免"出完→清空→停顿"的断裂感。
 */
class WaveDirector {
  state: DirectorState = 'prepare';
  waveIndex = -1;
  stateTimer: number;
  private schedule: ScheduledSpawn[] = [];
  private waveElapsed = 0;

  constructor(private level: LevelConfig, private rng: Rng) {
    this.stateTimer = level.prepareSec;
  }

  get currentWave(): number {
    return this.waveIndex;
  }

  get isLastWave(): boolean {
    return this.waveIndex >= this.level.waves.length - 1;
  }

  /** 每 tick 调用；返回本 tick 应刷出的怪物。 */
  update(session: GameSession, dt: number): SpawnItem[] {
    const out: SpawnItem[] = [];
    this.stateTimer -= dt;

    switch (this.state) {
      case 'prepare':
        if (this.stateTimer <= 0) {
          this.waveIndex++;
          this.waveElapsed = 0;
          this.schedule = this.buildSchedule(this.waveIndex);
          session.onWaveStart(this.waveIndex, this.level.waves[this.waveIndex].banner);
          this.state = 'spawning';
        }
        break;

      case 'spawning':
        this.waveElapsed += dt;
        while (
          this.schedule.length > 0 &&
          this.schedule[0].at <= this.waveElapsed &&
          out.length < 8 // 单帧放行上限，防滞后追放
        ) {
          out.push(this.schedule.shift()!.item);
        }
        if (this.schedule.length === 0) this.state = 'clearing';
        break;

      case 'clearing':
        if (session.monsters.length === 0) {
          session.onWaveClear(this.waveIndex);
          if (this.isLastWave) {
            this.state = 'done';
          } else {
            this.state = 'intermission';
            this.stateTimer = this.level.intermissionSec;
          }
        }
        break;

      case 'intermission':
        if (this.stateTimer <= 0) {
          this.state = 'prepare';
          this.stateTimer = this.level.prepareSec;
        }
        break;

      case 'done':
        break;
    }
    return out;
  }

  /** 把一波的怪物构成切成多段潮，每段在一小时间窗内密集进场。 */
  private buildSchedule(waveIndex: number): ScheduledSpawn[] {
    const wave = this.level.waves[waveIndex];
    const formation = wave.formation ?? 'stream';
    const duration = wave.durationSec ?? 60;
    const allPts = this.level.spawnPointsX;
    const total = wave.spawns.reduce((s, sp) => s + sp.count, 0);
    const segCount = Math.max(3, Math.min(7, Math.round(total / 12)));
    const segInterval = duration / segCount;
    const windowSec = Math.min(5, segInterval * 0.6); // 段内集中进场窗口

    const out: ScheduledSpawn[] = [];
    for (const spawn of wave.spawns) {
      const pts = spawn.spawnPoints === 'all'
        ? allPts
        : spawn.spawnPoints.map((i) => allPts[i]);
      for (let s = 0; s < segCount; s++) {
        const cnt = Math.floor(spawn.count / segCount) + (s < spawn.count % segCount ? 1 : 0);
        for (let i = 0; i < cnt; i++) {
          let x: number;
          switch (formation) {
            case 'line': // 全线等距铺开（横排压墙）
              x = pts[i % pts.length];
              break;
            case 'center': // 中央突破
              x = pts[Math.floor(pts.length / 2)] + this.rng.range(-50, 50);
              break;
            case 'pincer': // 两翼钳形
              x = i % 2 === 0
                ? pts[0] + this.rng.range(0, 60)
                : pts[pts.length - 1] - this.rng.range(0, 60);
              break;
            case 'stream':
            default: // 多点多路随机
              x = this.rng.pick(pts);
              break;
          }
          const at = s * segInterval + (i / Math.max(1, cnt)) * windowSec + this.rng.range(0, 0.4);
          out.push({ at, item: { monsterKey: spawn.monster, spawnX: x } });
        }
      }
    }
    out.sort((a, b) => a.at - b.at);
    return out;
  }
}

/** 战斗会话：整个游戏世界的唯一真相（docs/05 §1.5 单一数据源）。 */
export class GameSession {
  readonly bus = new EventBus();
  readonly rng: Rng;
  readonly level: LevelConfig;

  hero: HeroRuntime;
  monsters: MonsterRuntime[] = [];
  projectiles: ProjectileRuntime[] = [];
  monsterShots: MonsterShot[] = []; // 怪物远程弹（可见弹道，落点结算对墙伤害）
  pools: DamagePool[] = [];
  segments: SegmentField[] = []; // 光束/连线伤害场（docs/07 §4）

  wallHp: number;
  wallMaxHp: number; // 可被 B 类卡（加固城墙）提升

  tick = 0;
  result: GameResult | null = null;

  /** 人类输入模式：升级结算挂起，等 UI 调用 resolveLevelUp（Web/Cocos 适配层用）。 */
  externalLevelUps = false;
  pendingLevelChoices: CardConfig[] = [];

  /** 沙盒模式（实验室）：跳过胜负结算，会话永不结束。 */
  sandboxMode = false;

  private monsterCfgs: ReadonlyMap<string, MonsterConfig>;
  private cardConfigs: CardConfig[];
  private controller: HeroController;
  private cardPolicy: CardPolicy;
  private director: WaveDirector;
  private hash = new SpatialHash(64);

  private fireCommands: FireCommand[] = [];
  /** 连射（burst）的后续子弹调度 */
  private burstQueue: { timer: number; cmd: FireCommand }[] = [];
  private nextEntityId = 1;
  private cardStacks = new Map<string, number>();
  private pendingLevels = 0;

  // 报表累计
  totalDamage = 0;
  totalCrits = 0;
  totalKills = 0;
  totalWallDamage = 0;
  maxMonsters = 0;
  maxProjectiles = 0;
  cardPickLog: string[] = [];
  waveStats: { wave: number; banner: string; durationTicks: number; kills: number; wallDamage: number; wallHpEnd: number }[] = [];
  private waveKills = 0;
  private waveWallDamage = 0;

  constructor(opts: SessionOptions) {
    this.level = opts.level;
    this.rng = new Rng(opts.seed);
    this.monsterCfgs = opts.monsterConfigs;
    this.cardConfigs = opts.cardConfigs;
    this.controller = opts.controller;
    this.cardPolicy = opts.cardPolicy;

    const { width } = opts.level.arena;
    const midY = (opts.level.defenseRect.yMin + opts.level.defenseRect.yMax) / 2;
    this.hero = createHero(width / 2, midY, opts.weaponConfigs);

    this.wallMaxHp = opts.level.wall.hp;
    this.wallHp = opts.level.wall.hp;

    this.director = new WaveDirector(opts.level, this.rng);
  }

  get timeSec(): number {
    return this.tick * TICK_DT;
  }

  /** 推进一个固定逻辑帧。 */
  step(): void {
    if (this.result) return;
    const dt = TICK_DT;
    const now = this.timeSec;
    this.motionCtx.now = now;
    this.motionCtx.ownerX = this.hero.x;
    this.motionCtx.ownerY = this.hero.y;

    // 1) 导演刷怪
    const spawned = this.director.update(this, dt);
    for (const item of spawned) this.spawnMonster(item.monsterKey, item.spawnX);

    // 2) 英雄移动（控制器给方向，session 位移 + 钳制在防守区域）
    const move = this.controller.getMoveDir(this);
    const len = Math.hypot(move.x, move.y);
    if (len > 1e-6) {
      const { width } = this.level.arena;
      this.hero.x = clamp(this.hero.x + (move.x / len) * this.hero.stats.moveSpeed * dt, 20, width - 20);
      this.hero.y = clamp(
        this.hero.y + (move.y / len) * this.hero.stats.moveSpeed * dt,
        this.level.defenseRect.yMin,
        this.level.defenseRect.yMax,
      );
    }

    // 3) 武器开火 + 连射调度（连锁闪电：不生成子弹，直接落雷）
    this.hash.rebuild(this.monsters);
    updateWeapons(this.hero, this.monsters, this.hash, this.rng, this.fireCommands);
    for (const cmd of this.fireCommands) {
      if ((cmd.weapon.cfg.chainBase ?? 0) > 0 || cmd.weapon.affixes.chain > 0) {
        this.doLightning(cmd);
      } else {
        this.spawnProjectile(cmd);
        // 连射（A 类卡 burst）：后续子弹间隔 0.12s
        for (let i = 1; i <= cmd.weapon.mods.burst; i++) {
          this.burstQueue.push({ timer: i * 0.12, cmd });
        }
      }
    }
    for (let i = this.burstQueue.length - 1; i >= 0; i--) {
      const b = this.burstQueue[i];
      b.timer -= dt;
      if (b.timer <= 0) {
        if ((b.cmd.weapon.cfg.chainBase ?? 0) > 0 || b.cmd.weapon.affixes.chain > 0) this.doLightning(b.cmd);
        else this.spawnProjectile(b.cmd);
        this.burstQueue.splice(i, 1);
      }
    }

    // 4) 投射物推进与命中（扫掠检测：prev→curr 线段，防高速弹隧穿）
    for (const p of this.projectiles) {
      if (!p.alive) continue;
      p.px = p.x;
      p.py = p.y;
      const res = p.trajectory.update(p.x, p.y, this.motionCtx);
      p.x = res.x;
      p.y = res.y;
      p.height = res.height ?? 0;
      p.stepLen = Math.hypot(p.x - p.px, p.y - p.py);
      if (!res.alive) {
        this.killProjectile(p); // 寿命耗尽（落地/到达）——触发爆破落地
        continue;
      }
      // 出屏即消亡（飞出战场边界）
      const { width, height } = this.level.arena;
      if (p.x < -60 || p.x > width + 60 || p.y < -60 || p.y > height + 60) {
        this.killProjectile(p);
        continue;
      }
      this.collideProjectile(p);
    }

    // 5) 怪物推进：灼烧 DoT → 行为（含冰冻减速）→ 打墙 / 远程停驻射击（无碰撞遮挡，可互相穿过）
    this.hash.rebuild(this.monsters);
    for (const m of this.monsters) {
      if (m.hp <= 0) continue;
      this.tickBurns(m, dt);
      if (m.hp <= 0) continue;
      if (this.formationMove(m, dt)) continue; // 巫师编队（变阵排排啃墙）由编队逻辑驱动
      updateMonster(m, dt, now, this.level.wall.height, (dmg, src) => {
        this.wallHp = Math.max(0, this.wallHp - dmg);
        this.totalWallDamage += dmg;
        this.waveWallDamage += dmg;
        this.bus.emit('onWallHit', { dmg, wallHp: this.wallHp, x: src.x, y: this.level.wall.height + 26 });
      }, (src) => {
        this.spawnMonsterShot(src);
      });
    }

    // 5d) 巫师编队：领队近墙激活变阵（护卫排一排啃墙、巫师居中）；编队成员由 formationMove 驱动
    for (const m of this.monsters) {
      if (m.hp <= 0) continue;
      if (m.cfg.formationDist && !m.formationActive && m.y <= this.level.wall.height + m.cfg.formationDist) {
        m.formationActive = true;
        const members = this.monsters.filter((x) => x.groupId === m.id && x.hp > 0);
        members.forEach((mem, i) => {
          // 间距 58px < 岩甲兽直径 60：相邻盾面微叠，横排无缝隙（防子弹雨渗透）
          mem.slotX = clamp(m.x + (i - (members.length - 1) / 2) * 58, 40, this.level.arena.width - 40);
        });
        this.bus.emit('onFormation', { x: m.x, y: m.y });
      }
    }

    // 5e) 治疗光环：巫师为半径内友军回血（不可超过上限，满血不触发）
    for (const m of this.monsters) {
      const aura = m.cfg.healAura;
      if (!aura || m.hp <= 0) continue;
      m.healTimer -= dt;
      if (m.healTimer > 0) continue;
      m.healTimer += aura.interval;
      this.hash.queryCircle(m.x, m.y, aura.radius, this.scratch);
      let healed = 0;
      for (const id of this.scratch) {
        const ally = this.monsters[id];
        if (!ally || ally.hp <= 0 || ally.hp >= ally.maxHp) continue;
        const amount = Math.round(aura.amount);
        ally.hp = Math.min(ally.maxHp, ally.hp + amount);
        healed++;
        this.bus.emit('onHealed', { x: ally.x, y: ally.y + ally.cfg.radius + 8, amount }); // 绿色回血飘字
      }
      if (healed > 0) this.bus.emit('onHeal', { x: m.x, y: m.y, radius: aura.radius });
    }

    // 5b) 怪物远程弹推进：到达落点结算对墙伤害
    for (let i = this.monsterShots.length - 1; i >= 0; i--) {
      const s = this.monsterShots[i];
      s.t += dt / s.dur;
      if (s.t >= 1) {
        this.wallHp = Math.max(0, this.wallHp - s.dmg);
        this.totalWallDamage += s.dmg;
        this.waveWallDamage += s.dmg;
        this.bus.emit('onWallHit', { dmg: s.dmg, wallHp: this.wallHp, x: s.tx, y: this.level.wall.height + 26 });
        this.monsterShots.splice(i, 1);
        continue;
      }
      s.x = s.sx + (s.tx - s.sx) * s.t;
      s.y = s.sy + (s.ty - s.sy) * s.t;
      s.height = Math.sin(s.t * Math.PI) * (s.kind === 'rock' ? 140 : 40);
    }

    // 6) 落地范围伤害圈（持续 DoT）
    for (let i = this.pools.length - 1; i >= 0; i--) {
      const pool = this.pools[i];
      if (now >= pool.until) {
        this.pools.splice(i, 1);
        continue;
      }
      this.hash.queryCircle(pool.x, pool.y, pool.radius, this.scratch);
      for (const mid of this.scratch) {
        const m = this.monsters[mid];
        if (!m || m.hp <= 0) continue;
        const rr = pool.radius + m.cfg.radius;
        const dx = m.x - pool.x;
        const dy = m.y - pool.y;
        if (dx * dx + dy * dy > rr * rr) continue;
        const dmg = Math.max(1, Math.round(pool.dps * dt)); // 整数结算
        m.hp -= dmg;
        this.totalDamage += dmg;
        if (m.hp <= 0) this.killMonster(null, m);
      }
    }

    // 6b) 光束/连线伤害场（线段胶囊体持续 dps；followOwner 的光束锚定英雄朝向）
    for (let i = this.segments.length - 1; i >= 0; i--) {
      const seg = this.segments[i];
      if (now >= seg.until) {
        this.segments.splice(i, 1);
        continue;
      }
      if (seg.followOwner) {
        seg.ax = this.hero.x;
        seg.ay = this.hero.y;
        seg.bx = this.hero.x + Math.cos(seg.angle ?? Math.PI / 2) * (seg.length ?? 900);
        seg.by = this.hero.y + Math.sin(seg.angle ?? Math.PI / 2) * (seg.length ?? 900);
      }
      this.hash.rebuild(this.monsters);
      for (const m of this.monsters) {
        if (m.hp <= 0) continue;
        const rr = seg.width / 2 + m.cfg.radius;
        if (distToSegment(m.x, m.y, seg.ax, seg.ay, seg.bx, seg.by) > rr) continue;
        const dmg = Math.max(1, Math.round(seg.dps * dt)); // 整数结算
        m.hp -= dmg;
        this.totalDamage += dmg;
        if (m.hp <= 0) this.killMonster(null, m);
      }
    }

    // 7) 升级 → 三选一
    while (this.hero.xp >= xpNeed(this.hero.level)) {
      this.hero.xp -= xpNeed(this.hero.level);
      this.hero.level++;
      this.pendingLevels++;
    }
    if (this.sandboxMode) {
      // 沙盒（实验室）：升级不弹卡、不自动选——卡牌只能手动 grantCard 验证
      this.pendingLevels = 0;
      this.pendingLevelChoices = [];
    }
    while (this.pendingLevels > 0) {
      if (this.externalLevelUps) {
        // 人类输入适配器（Web/Cocos）：暂停内部结算，等外部点选 resolveLevelUp
        if (this.pendingLevelChoices.length === 0) {
          this.pendingLevelChoices = rollCardChoices(this.cardConfigs, this.cardStacks, this.hero.weapons, this.rng);
          if (this.pendingLevelChoices.length === 0) {
            this.pendingLevels = 0;
            break;
          }
          this.bus.emit('onLevelUpPending', { level: this.hero.level });
        }
        break;
      }
      this.pendingLevels--;
      const choices = rollCardChoices(this.cardConfigs, this.cardStacks, this.hero.weapons, this.rng);
      if (choices.length === 0) break;
      const picked = this.cardPolicy(choices, this.hero, this.rng, this);
      this.applyPickedCard(picked);
    }

    // 8) 清理死亡怪物（密度数组约定：id = 下标；压缩时同步重映射队籍 groupId，
    //    否则巫师护卫阵在减员后队籍错位，变阵/转嫁失效）
    if (this.monsters.some((m) => m.hp <= 0)) {
      const idMap = new Map<number, number>();
      const survivors: MonsterRuntime[] = [];
      for (const m of this.monsters) {
        if (m.hp > 0) {
          idMap.set(m.id, survivors.length);
          survivors.push(m);
        }
      }
      this.monsters = survivors;
      for (const m of this.monsters) {
        m.id = idMap.get(m.id)!;
        if (m.groupId >= 0) m.groupId = idMap.get(m.groupId) ?? -1; // 领队阵亡 → 编队解散
      }
    }
    this.projectiles = this.projectiles.filter((p) => p.alive);

    // 9) 帧统计与胜负判定
    this.maxMonsters = Math.max(this.maxMonsters, this.monsters.length);
    this.maxProjectiles = Math.max(this.maxProjectiles, this.projectiles.length);

    if (!this.sandboxMode) {
      if (this.wallHp <= 0) {
        this.result = 'defeat';
        this.bus.emit('onGameOver', { result: this.result });
      } else if (this.director.state === 'done' && this.monsters.length === 0) {
        this.result = 'victory';
        this.bus.emit('onGameOver', { result: this.result });
      }
    }

    this.tick++;
  }

  // ---------- 内部 ----------

  /** 远程怪发射可见弹道（投矛/投石），落点结算对墙伤害。 */
  private spawnMonsterShot(src: MonsterRuntime): void {
    const isRock = (src.cfg.rangedDist ?? 0) > 400; // 投石车类远距抛石
    const dist = Math.hypot(src.x - src.x, src.y - this.level.wall.height);
    const speed = isRock ? 420 : 620;
    this.monsterShots.push({
      sx: src.x,
      sy: src.y,
      tx: src.x + this.rng.range(-24, 24),
      ty: this.level.wall.height,
      x: src.x,
      y: src.y,
      height: 0,
      t: 0,
      dur: Math.max(0.2, dist / speed),
      dmg: src.cfg.atk,
      kind: isRock ? 'rock' : 'spear',
    });
  }

  private spawnMonster(key: string, spawnX: number, spawnY?: number, skipEscort = false): void {
    const cfg = this.monsterCfgs.get(key);
    if (!cfg) throw new Error(`未知怪物配置: ${key}`);
    const x = clamp(spawnX, 40, this.level.arena.width - 40);
    const y = spawnY ?? this.rng.range(this.level.spawnBandY[0], this.level.spawnBandY[1]);
    // 波次成长（docs/04 §2）：第 n 波 HP × (1 + 10%×n)，血量随波次显著增强
    const scale = 1 + 0.1 * this.director.currentWave;
    const hp = Math.round(cfg.hp * scale);
    this.monsters.push({
      id: this.monsters.length, // tick 内密度数组约定
      cfg,
      x,
      y,
      hp,
      maxHp: hp,
      state: 'march',
      attackTimer: cfg.attackInterval,
      phase: this.rng.range(0, Math.PI * 2),
      burn: null,
      shieldLeft: cfg.hitShield ?? 0,
      healTimer: cfg.healAura ? cfg.healAura.interval : 0,
      groupId: -1,
      formationActive: false,
      slotX: x,
      formIndex: 0,
      formAngle: 0,
      slowUntil: 0,
      slowFactor: 1,
      shredUntil: 0,
      shredAmount: 0,
    });

    // 出场护卫：巫师等带 escort 的怪，周围环形部署一圈护卫（记录队籍/编队序号）
    if (cfg.escort && !skipEscort) {
      const leaderId = this.monsters[this.monsters.length - 1].id;
      for (let i = 0; i < cfg.escort.count; i++) {
        const ang = (Math.PI * 2 * i) / cfg.escort.count + this.rng.range(-0.2, 0.2);
        const ex = clamp(x + Math.cos(ang) * cfg.escort.radius, 40, this.level.arena.width - 40);
        const ey = clamp(y + Math.sin(ang) * cfg.escort.radius, 200, this.level.arena.height - 60);
        this.spawnMonster(cfg.escort.monster, ex, ey);
        const member = this.monsters[this.monsters.length - 1];
        member.groupId = leaderId;
        member.formIndex = i;
        member.formAngle = (Math.PI * 2 * i) / cfg.escort.count;
      }
    }
  }

  private spawnProjectile(cmd: FireCommand): void {
    const { weapon, fromX, fromY, dirX, dirY, speed, range, dmg, index } = cmd;
    // 齐射扇形：index 0 为主弹头——严格对准目标；从第 2 发开始一左一右交替，
    // 每侧按武器间距（spread，默认 0.1rad）均匀展开（+1 左、+2 右、+3 左 2 档、+4 右 2 档……）
    let fan = 0;
    if (index > 0) {
      const side = index % 2 === 1 ? -1 : 1;
      const step = Math.ceil(index / 2);
      fan = side * step * (weapon.cfg.spread ?? 0.1);
    }
    const cos = Math.cos(fan);
    const sin = Math.sin(fan);
    const dx = dirX * cos - dirY * sin;
    const dy = dirX * sin + dirY * cos;

    const affixes = weapon.affixes;
    const riders = weapon.riders;
    const damageType = weapon.element;
    const homing = affixes.homing > 0 && !!cmd.target;
    // 运动配置快照：武器声明式配置优先；追踪词缀覆盖为 homing（弹射/分裂重定向按此配置重建）
    let motionCfg: TrajectoryConfig = homing
      ? { type: 'homing', speed, range, turnRate: 360, duration: 2.5, retarget: true }
      : (weapon.cfg.motion ?? { type: 'straight', speed, life: weapon.cfg.bulletLife ?? 2.5 });
    // 阶段机（回旋镖等）：距离相位随射程倍率缩放——"长旋"等射程卡对飞出距离生效
    if (motionCfg.type === 'phased' && weapon.mods.rangeMul !== 1) {
      motionCfg = {
        ...motionCfg,
        phases: motionCfg.phases.map((ph) =>
          ph.until.kind === 'distance'
            ? { ...ph, until: { ...ph.until, value: ph.until.value * weapon.mods.rangeMul } }
            : ph,
        ),
      };
    }
    // 爆破：武器本体（blastBase）为基座，"扩爆"卡逐级放大（无本体则用默认基座）
    const blastBase = weapon.cfg.blastBase;
    const blast: BlastSpec | null = affixes.blast > 0 || blastBase
      ? {
          radius: (blastBase?.radius ?? 70) + 30 * Math.max(0, affixes.blast - 1),
          dmgMul: (blastBase?.dmgMul ?? 0.5) + 0.25 * Math.max(0, affixes.blast - 1),
          poolDpsMul: blastBase?.poolDpsMul ?? 0.4,
          poolSec: blastBase?.poolSec ?? 2.5,
        }
      : null;

    this.projectiles.push({
      id: this.nextEntityId++,
      weapon,
      x: fromX,
      y: fromY,
      px: fromX,
      py: fromY,
      stepLen: 0,
      radius: weapon.cfg.projectileRadius,
      speed,
      dmg,
      height: 0,
      damageType,
      trajectory: createTrajectory(motionCfg, { dirX: dx, dirY: dy, target: cmd.target }),
      pierceLeft: weapon.cfg.pierce + Math.round(weapon.mods.pierceAdd),
      pierceCount: 0,
      bounceLeft: affixes.bounce,
      hitIds: new Map(),
      alive: true,
      affixes,
      riders,
      homing,
      motionCfg,
      blast,
    });
    this.bus.emit('onShoot', {});
  }

  private collideProjectile(p: ProjectileRuntime): void {
    const now = this.timeSec;
    const reach = p.radius + 34 + p.stepLen; // 34=怪物半径上限近似；stepLen 覆盖本帧扫掠范围
    this.hash.queryCircle(p.x, p.y, reach, this.scratch);
    for (const mid of this.scratch) {
      if (!p.alive) break;
      const m = this.monsters[mid];
      if (!m || m.hp <= 0) continue;
      if (p.hitIds.has(m.id) && now - (p.hitIds.get(m.id) ?? 0) < 0.5) continue; // 0.5s 重击冷却
      const rr = p.radius + m.cfg.radius;
      if (distToSegment(m.x, m.y, p.px, p.py, p.x, p.y) > rr) continue;

      p.hitIds.set(m.id, now);
      // 穿透衰减：每穿透一个目标伤害 ×(1-衰减率)，破甲每级削减 5% 衰减率，系数上限 1（永不超过原弹伤）
      const falloffRate = Math.max(0, (p.weapon.cfg.pierceFalloff ?? 0.15) - p.affixes.shred * 0.06);
      const effDmg = p.dmg * Math.min(1, Math.max(0, 1 - falloffRate * p.pierceCount));
      const def = Math.max(0, m.cfg.def - (now < m.shredUntil ? m.shredAmount : 0));
      const res = calcDamage(
        heroAttackerSnapshot(this.hero),
        { def, level: this.director.currentWave + 1 },
        {
          skillMul: effDmg / BASE_ATK,
          damageType: p.damageType,
          typeMul: m.cfg.weak?.includes(p.damageType) ? 1.25 : m.cfg.resist?.includes(p.damageType) ? 0.75 : 1,
        },
        this.rng,
      );
      const dealt0 = this.applyDirectHit(m, res.amount); // 免伤盾结算
      const dealt = this.resolveTransfer(m, dealt0); // 巫师变阵：伤害转嫁
      m.hp -= dealt;
      this.totalDamage += dealt;
      if (res.isCrit && dealt > 0) this.totalCrits++;
      this.bus.emit('onHit', {
        monsterId: m.id, dmg: dealt, isCrit: res.isCrit, blocked: dealt === 0,
        mitigated: dealt === 0 ? 0 : res.mitigated, x: m.x, y: m.y,
      });

      // C 类词缀：灼烧（火焰骑士，附着定时跳伤不叠加；灼烧免疫怪不可被点燃）/ 冰冻 / 破甲
      if (p.damageType === 'fire' && p.riders.burnDpsMul > 0 && !m.cfg.burnImmune) {
        const dps = p.dmg * p.riders.burnDpsMul;
        if (m.burn && m.burn.dps >= dps) {
          m.burn.until = now + p.riders.burnSec; // 重复命中只刷新时长，不叠加伤害
        } else {
          m.burn = { dps, until: now + p.riders.burnSec, nextTick: now + 0.5 };
        }
      }
      if (p.damageType === 'frost' && p.riders.slowPct > 0) {
        m.slowFactor = Math.max(0.35, 1 - p.riders.slowPct);
        m.slowUntil = now + p.riders.slowSec;
      }
      if (p.affixes.shred > 0) {
        m.shredAmount = 3 * p.affixes.shred;
        m.shredUntil = now + 4;
      }

      if (m.hp <= 0) this.killMonster(p, m);

      // 穿透 / 弹射 / 消亡
      if (p.pierceLeft > 0) {
        p.pierceLeft--;
        p.pierceCount++;
        continue;
      }
      if (p.bounceLeft > 0 && this.tryBounce(p)) {
        p.bounceLeft--;
        continue;
      }
      this.killProjectile(p);
    }
  }

  /**
   * 连锁闪电（docs/07 §3）：不是子弹——索敌后从炮口直接劈向目标，
   * 再瞬时跳跃至附近未命中目标（1+chain 击，×0.8/跳），发 onChain{points} 供渲染折线。
   */
  private doLightning(cmd: FireCommand): void {
    const now = this.timeSec;
    const path: number[][] = [[cmd.fromX, cmd.fromY]];
    const hit = new Set<number>();
    let cur: MonsterRuntime | null = (cmd.target as MonsterRuntime | null) ?? null;
    let mul = 1;
    // 打击数 = 武器基础（chainBase）+ 连锁长度卡（affixes.chain）
    let strikesLeft = (cmd.weapon.cfg.chainBase ?? 0) + cmd.weapon.affixes.chain;
    while (cur && strikesLeft > 0) {
      hit.add(cur.id);
      const def = Math.max(0, cur.cfg.def - (now < cur.shredUntil ? cur.shredAmount : 0));
      const res = calcDamage(
        heroAttackerSnapshot(this.hero),
        { def, level: this.director.currentWave + 1 },
        {
          skillMul: (cmd.dmg * mul) / BASE_ATK,
          damageType: 'lightning',
          typeMul: cur.cfg.weak?.includes('lightning') ? 1.25 : cur.cfg.resist?.includes('lightning') ? 0.75 : 1,
        },
        this.rng,
      );
      const dealt0 = this.applyDirectHit(cur, res.amount); // 免伤盾结算
      const dealt = this.resolveTransfer(cur, dealt0); // 巫师变阵：伤害转嫁
      cur.hp -= dealt;
      this.totalDamage += dealt;
      if (res.isCrit && dealt > 0) this.totalCrits++;
      this.bus.emit('onHit', { monsterId: cur.id, dmg: dealt, isCrit: res.isCrit, blocked: dealt === 0, mitigated: dealt === 0 ? 0 : res.mitigated, x: cur.x, y: cur.y });
      if (cur.hp <= 0) this.killMonster(null, cur); // 闪电不触发分裂（无弹体）
      path.push([cur.x, cur.y]);
      strikesLeft--;
      mul *= 0.8;
      cur = strikesLeft > 0
        ? this.nearestMonsterRuntime(cur.x, cur.y, 420 * cmd.weapon.mods.rangeMul, hit)
        : null;
    }
    this.bus.emit('onChain', { points: path });
  }

  /** 半径内最近的存活怪。exclude 为 Map 时按 0.5s 重击冷却排除（悬停研磨可重复命中），Set 时永久排除。 */
  private nearestMonsterRuntime(
    x: number,
    y: number,
    radius: number,
    exclude: ReadonlySet<number> | ReadonlyMap<number, number>,
  ): MonsterRuntime | null {
    const now = this.timeSec;
    this.hash.queryCircle(x, y, radius, this.scratch);
    let best: MonsterRuntime | null = null;
    let bestD = Infinity;
    for (const id of this.scratch) {
      if (exclude.has(id)) {
        if (exclude instanceof Map) {
          const t = exclude.get(id);
          if (t !== undefined && now - t < 0.5) continue; // 冷却中排除；冷却过期可再命中
        } else {
          continue;
        }
      }
      const m = this.monsters[id];
      if (!m || m.hp <= 0) continue;
      const d = (m.x - x) ** 2 + (m.y - y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = m;
      }
    }
    return best;
  }

  private nearestMonsterExcluding(x: number, y: number, radius: number, exclude: Set<number>): import('./targeting').Targetable | null {
    return this.nearestMonsterRuntime(x, y, radius, exclude);
  }

  /** 弹射：找最近的未命中过的怪物重定向弹道（按运动配置重建，保留追踪）。 */
  private tryBounce(p: ProjectileRuntime): boolean {
    const best = this.nearestMonsterRuntime(p.x, p.y, 520, p.hitIds);
    if (!best) return false;
    const dist = Math.hypot(best.x - p.x, best.y - p.y);
    p.trajectory = createTrajectory(p.motionCfg, { dirX: best.x - p.x, dirY: best.y - p.y, target: best });
    return true;
  }

  /** 投射物消亡：触发"爆破落地"范围伤害圈。 */
  private killProjectile(p: ProjectileRuntime): void {
    if (!p.alive) return;
    p.alive = false;
    if (!p.blast) return;
    const now = this.timeSec;
    const { radius, dmgMul, poolDpsMul, poolSec } = p.blast;
    // 瞬时 AOE
    this.hash.queryCircle(p.x, p.y, radius, this.scratch);
    for (const mid of this.scratch) {
      const m = this.monsters[mid];
      if (!m || m.hp <= 0) continue;
      const rr = radius + m.cfg.radius;
      const dx = m.x - p.x;
      const dy = m.y - p.y;
      if (dx * dx + dy * dy > rr * rr) continue;
      const def = Math.max(0, m.cfg.def - (now < m.shredUntil ? m.shredAmount : 0));
      const res = calcDamage(
        heroAttackerSnapshot(this.hero),
        { def, level: this.director.currentWave + 1 },
        {
          skillMul: (p.dmg * dmgMul) / BASE_ATK,
          damageType: p.damageType,
          typeMul: m.cfg.weak?.includes(p.damageType) ? 1.25 : m.cfg.resist?.includes(p.damageType) ? 0.75 : 1,
        },
        this.rng,
      );
      const dealt0 = this.applyDirectHit(m, res.amount); // 免伤盾结算
      const dealt = this.resolveTransfer(m, dealt0); // 巫师变阵：伤害转嫁
      m.hp -= dealt;
      this.totalDamage += dealt;
      if (res.isCrit && dealt > 0) this.totalCrits++;
      if (m.hp <= 0) this.killMonster(null, m);
    }
    // 持续伤害圈
    this.pools.push({
      x: p.x,
      y: p.y,
      radius,
      dps: p.dmg * poolDpsMul,
      until: now + poolSec,
      damageType: p.damageType,
    });
    this.bus.emit('onExplode', { x: p.x, y: p.y, radius });
  }

  /** 直接命中结算（吃免伤盾，DoT/伤害圈不消耗盾）；返回实际落地伤害。 */
  private applyDirectHit(m: MonsterRuntime, rawAmount: number): number {
    if (m.shieldLeft > 0) {
      m.shieldLeft--;
      return 0;
    }
    return rawAmount;
  }

  /**
   * 编队移动（两相位）：
   * - 行军相位：护卫紧凑环绕领队（盾环随行，防弹雨穿透）
   * - 近墙变阵：护卫展开横排啃墙、巫师居中
   * 返回 true 表示本 tick 已由编队逻辑处理。
   */
  private formationMove(m: MonsterRuntime, dt: number): boolean {
    const wallTop = this.level.wall.height;
    if (m.formationActive) {
      // 领队：移到横排中央（墙前一线）
      this.steerToSlot(m, m.x, wallTop + m.cfg.radius + 10, dt, true);
      return true;
    }
    if (m.groupId < 0) return false;
    const leader = this.monsters[m.groupId];
    if (!leader || leader.hp <= 0) return false;
    if (!leader.formationActive) {
      // 行军相位：紧凑盾环（周长 2π×95/10 ≈ 60 ≈ 盾径，近似无缝）
      const tx = clamp(leader.x + Math.cos(m.formAngle) * 95, 40, this.level.arena.width - 40);
      const ty = clamp(leader.y + Math.sin(m.formAngle) * 95, 120, this.level.arena.height - 60);
      this.steerToSlot(m, tx, ty, dt, false);
      return true;
    }
    // 变阵相位：横排（以领队当前 x 为轴心保持更新，间距 58 盾面微叠）
    const count = leader.cfg.escort?.count ?? 1;
    const slotX = clamp(leader.x + (m.formIndex - (count - 1) / 2) * 58, 40, this.level.arena.width - 40);
    m.slotX = slotX;
    this.steerToSlot(m, slotX, wallTop + m.cfg.radius, dt, true);
    return true;
  }

  /** 驶向槽位；到位后若为墙前位则转为啃墙（assault），否则原地待机（行军相位中场到位不隔空啃墙）。 */
  private steerToSlot(m: MonsterRuntime, tx: number, ty: number, dt: number, atWall: boolean): void {
    let speed = m.cfg.speed * 3;
    if (this.timeSec < m.slowUntil) speed *= m.slowFactor;
    const dx = tx - m.x;
    const dy = ty - m.y;
    const dist = Math.hypot(dx, dy);
    if (dist > 6) {
      const step = Math.min(speed * dt, dist);
      m.x += (dx / dist) * step;
      m.y += (dy / dist) * step;
      m.state = 'march';
      return;
    }
    if (!atWall) {
      m.state = 'march'; // 行军相位到位：原地待机，不攻击城墙
      return;
    }
    m.y = ty;
    m.state = 'assault';
    m.attackTimer -= dt;
    if (m.attackTimer <= 0) {
      m.attackTimer += m.cfg.attackInterval;
      const dmg = m.cfg.atk;
      this.wallHp = Math.max(0, this.wallHp - dmg);
      this.totalWallDamage += dmg;
      this.waveWallDamage += dmg;
      this.bus.emit('onWallHit', { dmg, wallHp: this.wallHp, x: m.x, y: this.level.wall.height + 26 });
    }
  }

  /** 伤害转嫁：变阵巫师的直接伤害转移给半径内随机友军（无友军则自承）。返回巫师实际承受值。 */
  private resolveTransfer(m: MonsterRuntime, dealt: number): number {
    if (dealt <= 0 || !m.formationActive || !m.cfg.transferAura) return dealt;
    this.hash.queryCircle(m.x, m.y, m.cfg.transferAura.radius, this.scratch);
    const candidates: MonsterRuntime[] = [];
    for (const id of this.scratch) {
      const ally = this.monsters[id];
      if (ally && ally !== m && ally.hp > 0) candidates.push(ally);
    }
    if (candidates.length === 0) return dealt;
    const target = candidates[this.rng.int(0, candidates.length - 1)];
    target.hp -= dealt;
    this.totalDamage += dealt;
    this.bus.emit('onDamageTransfer', { fx: m.x, fy: m.y, tx: target.x, ty: target.y, dmg: dealt });
    if (target.hp <= 0) this.killMonster(null, target);
    return 0;
  }

  /** 灼烧：附着的火焰每 0.5s 跳一次伤害直至熄灭（重复命中只刷新时长，不叠加）。 */
  private tickBurns(m: MonsterRuntime, _dt: number): void {
    const b = m.burn;
    if (!b) return;
    const now = this.timeSec;
    if (now >= b.until) {
      m.burn = null; // 火焰熄灭
      return;
    }
    if (now >= b.nextTick) {
      b.nextTick += 0.5;
      const dmg = Math.max(1, Math.round(b.dps * 0.5)); // 整数结算（伤害无小数）
      m.hp -= dmg;
      this.totalDamage += dmg;
      this.bus.emit('onBurnTick', { x: m.x, y: m.y + m.cfg.radius + 8, dmg });
      if (m.hp <= 0) this.killMonster(null, m);
    }
  }

  /** 每 tick 注入的运动上下文（轨迹基元通过它查询世界，保持零持有状态）。 */
  private motionCtx: MotionContext = {
    dt: TICK_DT,
    now: 0,
    ownerX: 0,
    ownerY: 0,
    nearestMonster: (x, y, r, exclude) => this.nearestMonsterExcluding(x, y, r, exclude),
  };

  private scratch: number[] = [];

  /** 外部（人类玩家）完成三选一决策；未挂起时调用为无操作。 */
  resolveLevelUp(card: CardConfig): void {
    if (this.pendingLevelChoices.length === 0) return;
    this.pendingLevelChoices = [];
    this.pendingLevels = Math.max(0, this.pendingLevels - 1);
    this.applyPickedCard(card);
  }

  // ---------- 测试入口（tools/lab 与 web/lab.html 用，不影响正常对局） ----------

  /** 直接授予一张卡（跳过升级流程），不适用/达上限/id 不存在时返回 false。 */
  grantCard(cardId: string): boolean {
    const card = this.cardConfigs.find((c) => c.id === cardId);
    if (!card) return false;
    if ((this.cardStacks.get(card.id) ?? 0) >= card.maxStack) return false;
    if (!this.isCardApplicable(card)) return false;
    this.applyPickedCard(card);
    return true;
  }

  /** 卡牌适用性（与 rollCardChoices 同一套门控规则；实验室/UI 可查询）。 */
  isCardApplicable(card: CardConfig): boolean {
    const e = card.effect;
    if ('grantElement' in e) {
      // 元素互斥：武器已被赋予过元素（≠ 默认元素）则不可再赋予；
      // 落雷武器（chainBase）伤害类型硬编码 lightning 且不结算骑士效果，不可赋予
      return this.hero.weapons.some((w) => w.element === w.cfg.damageType && !w.cfg.chainBase);
    }
    const t = card.target;
    if (!t || t.kind === 'any') return true;
    if (t.kind === 'weapon') return this.hero.weapons.some((w) => w.cfg.id === t.weaponType);
    return this.hero.weapons.some((w) => w.element === t.element);
  }

  /** 在指定位置生成测试怪；id 不存在返回 false。noEscort=true 时不触发出场护卫（如单独生成巫师）。 */
  debugSpawn(monsterKey: string, x: number, y: number, opts?: { noEscort?: boolean }): boolean {
    if (!this.monsterCfgs.has(monsterKey)) return false;
    this.spawnMonster(monsterKey, x, y, opts?.noEscort ?? false);
    return true;
  }

  /** 测试入口：光束——锚定英雄、朝 angle（弧度）持续 dps 伤害 duration 秒。 */
  debugBeam(angleRad: number, length: number, dps: number, duration: number, width = 40): void {
    this.segments.push({
      ax: this.hero.x, ay: this.hero.y,
      bx: this.hero.x, by: this.hero.y + length,
      width, dps, until: this.timeSec + duration, damageType: 'lightning',
      followOwner: true, angle: angleRad, length,
    });
    this.bus.emit('onBeam', {});
  }

  /** 测试入口：固定两点连线（电网），持续 dps 伤害 duration 秒。 */
  debugLink(ax: number, ay: number, bx: number, by: number, dps: number, duration: number, width = 40): void {
    this.segments.push({
      ax, ay, bx, by, width, dps, until: this.timeSec + duration, damageType: 'lightning',
    });
    this.bus.emit('onBeam', {});
  }

  /**
   * 统一卡牌结算（docs/03 §2.2）：按目标声明分发——
   * 公共卡作用于全部武器/英雄；武器专属卡只作用于匹配武器；元素卡需武器已携带对应元素。
   */
  private applyPickedCard(picked: CardConfig): void {
    const e = picked.effect;
    const t = picked.target;
    const targets: WeaponInstance[] =
      t && t.kind === 'weapon'
        ? this.hero.weapons.filter((w) => w.cfg.id === t.weaponType)
        : this.hero.weapons;

    if ('stat' in e) {
      applyStat(this.hero.stats, e.stat, e.op, e.value);
    } else if ('bullet' in e) {
      for (const w of targets) applyBulletMod(w, e.bullet, e.op, e.value);
    } else if ('wall' in e) {
      if (e.wall === 'wallMax') {
        const add = Math.round(this.wallMaxHp * e.value);
        this.wallMaxHp += add;
        this.wallHp = Math.min(this.wallMaxHp, this.wallHp + add);
      } else {
        this.wallHp = Math.min(this.wallMaxHp, this.wallHp + e.value);
      }
      this.bus.emit('onWallHeal', { wallHp: this.wallHp, wallMaxHp: this.wallMaxHp });
    } else if ('form' in e) {
      for (const w of targets) applyForm(w.affixes, e.form, e.value);
    } else if ('grantElement' in e) {
      // 元素赋予：武器改属该元素，并解锁基础骑士效果（火→灼烧，冰→减速）
      for (const w of this.hero.weapons) {
        w.element = e.grantElement;
        if (e.grantElement === 'fire') {
          w.riders.burnDpsMul = Math.max(w.riders.burnDpsMul, 1.0); // 点燃：每秒 100% 弹伤，直至熄灭
          w.riders.burnSec = 3;
        } else if (e.grantElement === 'frost') {
          w.riders.slowPct = Math.max(w.riders.slowPct, 0.12);
          w.riders.slowSec = 2.5;
        }
      }
    } else {
      // 元素加持：仅对已携带该元素的武器生效
      for (const w of this.hero.weapons.filter((x) => x.element === e.boostElement)) {
        if (e.boostElement === 'fire') {
          w.riders.burnDpsMul += 0.5 * e.value;
          w.riders.burnSec = 3;
        } else if (e.boostElement === 'frost') {
          w.riders.slowPct = Math.min(0.65, w.riders.slowPct + 0.06 * e.value);
          w.riders.slowSec += 0.5 * e.value;
        }
      }
    }
    this.cardStacks.set(picked.id, (this.cardStacks.get(picked.id) ?? 0) + 1);
    this.cardPickLog.push(`${picked.name}(Lv${this.cardStacks.get(picked.id)})`);
    this.bus.emit('onLevelUp', { level: this.hero.level, picked: picked.id });
  }

  private killMonster(p: ProjectileRuntime | null, m: MonsterRuntime): void {
    this.totalKills++;
    this.waveKills++;
    this.hero.xp += m.cfg.xp; // 经验自动吸收（击杀即入账，无拾取环节）
    this.bus.emit('onKill', { monsterId: m.id, key: m.cfg.id });

    // C 类词缀：击杀分裂（子弹继承追踪/火/冰/破甲，但不继承分裂/弹射/爆破，防指数爆炸）
    if (p && p.affixes.split > 0) {
      const base = Math.atan2(p.y - p.py, p.x - p.px);
      // 衍生弹的追踪目标：就近另找一只（不复用父弹命中目标）
      let childTarget: MonsterRuntime | null = null;
      let bestD = Infinity;
      for (const o of this.monsters) {
        if (o.hp <= 0 || o === m) continue;
        const d = (o.x - m.x) ** 2 + (o.y - m.y) ** 2;
        if (d < bestD) {
          bestD = d;
          childTarget = o;
        }
      }
      for (const off of [-0.5, 0.5]) {
        const ang = base + off;
        const dx = Math.cos(ang);
        const dy = Math.sin(ang);
        const childHoming = p.homing && !!childTarget;
        const childCfg: TrajectoryConfig = childHoming
          ? { type: 'homing', speed: p.speed, range: 500, turnRate: 360, duration: 2.5, retarget: true }
          : { type: 'straight', speed: p.speed, life: 2.0 };
        this.projectiles.push({
          id: this.nextEntityId++,
          weapon: p.weapon,
          x: m.x,
          y: m.y,
          px: m.x,
          py: m.y,
          stepLen: 0,
          radius: p.radius,
          speed: p.speed,
          dmg: p.dmg * 0.5,
          height: 0,
          damageType: p.damageType,
          trajectory: createTrajectory(childCfg, { dirX: dx, dirY: dy, target: childTarget }),
          pierceLeft: 0,
          pierceCount: 0,
          bounceLeft: 0,
          hitIds: new Map(),
          alive: true,
          affixes: { ...p.affixes, split: 0, bounce: 0, blast: 0 },
          riders: p.riders,
          homing: childHoming,
          motionCfg: childCfg,
          blast: null,
        });
      }
    }
  }

  // ---------- 导演回调（报表） ----------

  onWaveStart(index: number, banner: string): void {
    this.waveKills = 0;
    this.waveWallDamage = 0;
    this.bus.emit('onWaveStart', { index, banner });
  }

  onWaveClear(index: number): void {
    // 通关经验奖励直接入账（自动吸收，无拾取环节）
    const bonus = this.level.waveClearBonusXp ?? 0;
    if (bonus > 0) {
      this.hero.xp += bonus;
    }
    this.waveStats.push({
      wave: index + 1,
      banner: this.level.waves[index].banner,
      durationTicks: this.tick - (this.waveStats.length ? this._lastClearTick : 0),
      kills: this.waveKills,
      wallDamage: Math.round(this.waveWallDamage * 10) / 10,
      wallHpEnd: Math.round(this.wallHp),
    });
    this._lastClearTick = this.tick;
    this.bus.emit('onWaveClear', { index });
  }

  private _lastClearTick = 0;
}
