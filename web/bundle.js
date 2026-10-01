"use strict";
(() => {
  // src/gamecore/core/rng.ts
  var Rng = class {
    constructor(seed) {
      this.s = seed >>> 0 || 1;
    }
    /** [0, 1) */
    next() {
      this.s = this.s + 1831565813 | 0;
      let t = Math.imul(this.s ^ this.s >>> 15, 1 | this.s);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    }
    range(min, max) {
      return min + this.next() * (max - min);
    }
    int(min, max) {
      return Math.floor(this.range(min, max + 1));
    }
    pick(arr) {
      return arr[Math.floor(this.next() * arr.length)];
    }
  };

  // src/gamecore/core/math.ts
  function len(x, y) {
    return Math.sqrt(x * x + y * y);
  }
  function dist2(ax, ay, bx, by) {
    const dx = ax - bx;
    const dy = ay - by;
    return dx * dx + dy * dy;
  }
  function norm(x, y) {
    const l = len(x, y);
    return l > 1e-6 ? { x: x / l, y: y / l } : { x: 0, y: 0 };
  }
  function clamp(v, min, max) {
    return v < min ? min : v > max ? max : v;
  }

  // src/gamecore/core/events.ts
  var EventBus = class {
    constructor() {
      this.map = /* @__PURE__ */ new Map();
    }
    on(event, handler) {
      let set = this.map.get(event);
      if (!set) {
        set = /* @__PURE__ */ new Set();
        this.map.set(event, set);
      }
      set.add(handler);
    }
    emit(event, payload) {
      const set = this.map.get(event);
      if (!set) return;
      for (const h of set) h(payload);
    }
    clear() {
      this.map.clear();
    }
  };

  // src/gamecore/core/spatial-hash.ts
  var SpatialHash = class {
    constructor(cellSize = 64) {
      this.map = /* @__PURE__ */ new Map();
      this.cellSize = cellSize;
    }
    clear() {
      this.map.clear();
    }
    key(cx, cy) {
      return cx + 4096 << 16 | cy + 4096;
    }
    insert(id, x, y) {
      const cx = Math.floor(x / this.cellSize);
      const cy = Math.floor(y / this.cellSize);
      const k = this.key(cx, cy);
      let bucket = this.map.get(k);
      if (!bucket) {
        bucket = [];
        this.map.set(k, bucket);
      }
      bucket.push(id);
    }
    rebuild(items) {
      this.clear();
      for (const it of items) this.insert(it.id, it.x, it.y);
    }
    /** 收集圆形范围内的候选 id（含格子的粗糙超集，调用方做精确距离判断）。 */
    queryCircle(x, y, r, out) {
      out.length = 0;
      const minCx = Math.floor((x - r) / this.cellSize);
      const maxCx = Math.floor((x + r) / this.cellSize);
      const minCy = Math.floor((y - r) / this.cellSize);
      const maxCy = Math.floor((y + r) / this.cellSize);
      for (let cx = minCx; cx <= maxCx; cx++) {
        for (let cy = minCy; cy <= maxCy; cy++) {
          const bucket = this.map.get(this.key(cx, cy));
          if (bucket) for (const id of bucket) out.push(id);
        }
      }
    }
  };

  // src/gamecore/damage.ts
  function calcDamage(attacker, target, ctx, rng) {
    const isCrit = rng.next() < attacker.critChance;
    const critMul = isCrit ? attacker.critDmg : 1;
    const floatMul = rng.range(0.95, 1.05);
    const typeMul = ctx.typeMul ?? 1;
    const raw = attacker.atk * ctx.skillMul * (1 + attacker.dmgMul) * critMul * floatMul * typeMul;
    const defTerm = target.def + 100 + 10 * target.level;
    const reduction = target.def / defTerm;
    return {
      amount: Math.max(1, Math.round(raw * (1 - reduction))),
      isCrit,
      damageType: ctx.damageType
    };
  }

  // src/gamecore/targeting.ts
  var scratch = [];
  function acquireTarget(rule, fromX, fromY, range, monsters, hash, rng) {
    if (monsters.length === 0) return null;
    hash.rebuild(monsters);
    hash.queryCircle(fromX, fromY, range, scratch);
    let best = null;
    let bestScore = Infinity;
    let randomCand = null;
    let randomCount = 0;
    for (const id of scratch) {
      const m = monsters[id];
      if (!m || m.hp <= 0) continue;
      if (dist2(fromX, fromY, m.x, m.y) > range * range) continue;
      randomCount++;
      if (rng.next() < 1 / randomCount) randomCand = m;
      let score;
      switch (rule) {
        case "lowestHp":
          score = m.hp;
          break;
        case "strongest":
          score = -m.hp;
          break;
        case "nearest":
        case "densest":
        // M1 先用最近近似；密集度投票在 M2 实现
        default:
          score = dist2(fromX, fromY, m.x, m.y);
          break;
      }
      if (score < bestScore) {
        bestScore = score;
        best = m;
      }
    }
    if (rule === "random") return randomCand;
    return best;
  }

  // src/gamecore/trajectory.ts
  function createTrajectory(cfg, launch) {
    const d = norm(launch.dirX, launch.dirY);
    switch (cfg.type) {
      case "straight":
        return new StraightTrajectory(d.x, d.y, cfg.speed, cfg.range);
      case "homing":
        return new HomingTrajectory(d.x, d.y, cfg.speed, cfg.range, launch.target ?? null, cfg);
      case "parabola":
        return new ParabolaTrajectory(d.x, d.y, cfg.speed, cfg.range, cfg.peak ?? 120);
      case "spiral":
        return new SpiralTrajectory(d.x, d.y, cfg.speed, cfg.range, cfg.angularSpeed, cfg.radius);
      case "zigzag":
        return new ZigzagTrajectory(d.x, d.y, cfg.speed, cfg.range, cfg.frequency, cfg.amplitude);
      case "waypoints":
        return new WaypointTrajectory(cfg.speed, cfg.points, cfg.loop ?? false);
      case "hover":
        return new HoverTrajectory();
      case "phased":
        return new PhaseTrajectory(cfg.phases, launch);
    }
  }
  var StraightTrajectory = class {
    constructor(dirX, dirY, speed, maxRange) {
      this.speed = speed;
      this.maxRange = maxRange;
      this.traveled = 0;
      this.dir = norm(dirX, dirY);
    }
    update(x, y, ctx) {
      const step = this.speed * ctx.dt;
      this.traveled += step;
      if (this.traveled >= this.maxRange || this.dir.x === 0 && this.dir.y === 0) {
        return { x, y, alive: false };
      }
      return { x: x + this.dir.x * step, y: y + this.dir.y * step, alive: true };
    }
  };
  var HomingTrajectory = class {
    constructor(dirX, dirY, speed, maxRange, target, cfg) {
      this.speed = speed;
      this.maxRange = maxRange;
      this.target = target;
      this.cfg = cfg;
      this.traveled = 0;
      this.dir = norm(dirX, dirY);
      this.life = cfg.duration;
    }
    update(x, y, ctx) {
      const step = this.speed * ctx.dt;
      this.traveled += step;
      this.life -= ctx.dt;
      let tx = null;
      let ty = null;
      if (this.cfg.home) {
        tx = ctx.ownerX;
        ty = ctx.ownerY;
      } else if (this.target && this.target.hp > 0) {
        tx = this.target.x;
        ty = this.target.y;
      } else if (this.cfg.retarget && this.life > 0) {
        const next = ctx.nearestMonster(x, y, 600, /* @__PURE__ */ new Set());
        if (next) {
          this.target = next;
          tx = next.x;
          ty = next.y;
        }
      }
      if (tx !== null && ty !== null) {
        const want = norm(tx - x, ty - y);
        const maxTurn = this.cfg.turnRate * Math.PI / 180 * ctx.dt;
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
  };
  var ParabolaTrajectory = class {
    constructor(dirX, dirY, speed, range, peak) {
      this.speed = speed;
      this.range = range;
      this.peak = peak;
      this.traveled = 0;
      this.dir = norm(dirX, dirY);
    }
    update(x, y, ctx) {
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
        height: Math.sin(k * Math.PI) * this.peak
      };
    }
  };
  var SpiralTrajectory = class {
    constructor(dirX, dirY, speed, range, angularSpeed, radius) {
      this.speed = speed;
      this.range = range;
      this.angularSpeed = angularSpeed;
      this.radius = radius;
      this.baseX = 0;
      this.baseY = 0;
      this.traveled = 0;
      this.started = false;
      this.dir = norm(dirX, dirY);
      this.phase = 0;
    }
    update(x, y, ctx) {
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
      const px = -this.dir.y;
      const py = this.dir.x;
      const off = Math.sin(this.phase) * this.radius;
      return { x: this.baseX + px * off, y: this.baseY + py * off, alive: true };
    }
  };
  var ZigzagTrajectory = class {
    constructor(dirX, dirY, speed, range, frequency, amplitude) {
      this.speed = speed;
      this.range = range;
      this.frequency = frequency;
      this.amplitude = amplitude;
      this.baseX = 0;
      this.baseY = 0;
      this.phase = 0;
      this.traveled = 0;
      this.started = false;
      this.dir = norm(dirX, dirY);
    }
    update(x, y, ctx) {
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
  };
  var WaypointTrajectory = class {
    constructor(speed, points, loop) {
      this.speed = speed;
      this.points = points;
      this.loop = loop;
      this.idx = 0;
    }
    update(x, y, ctx) {
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
          cx += dx / d * remain;
          cy += dy / d * remain;
          break;
        }
      }
      return { x: cx, y: cy, alive: true };
    }
  };
  var HoverTrajectory = class {
    update(x, y) {
      return { x, y, alive: true };
    }
  };
  var PhaseTrajectory = class {
    constructor(phases, launch) {
      this.phases = phases;
      this.phaseIdx = 0;
      this.phaseDist = 0;
      this.phaseTime = 0;
      if (phases.length === 0) throw new Error("PhaseTrajectory \u81F3\u5C11\u9700\u8981\u4E00\u6BB5");
      this.child = createTrajectory(phases[0].motion, launch);
    }
    update(x, y, ctx) {
      const res = this.child.update(x, y, ctx);
      this.phaseDist += Math.hypot(res.x - x, res.y - y);
      this.phaseTime += ctx.dt;
      const until = this.phases[this.phaseIdx].until;
      let done = false;
      switch (until.kind) {
        case "distance":
          done = this.phaseDist >= until.value;
          break;
        case "duration":
          done = this.phaseTime >= until.value;
          break;
        case "nearOwner":
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
          target: null
        });
      }
      return { x: res.x, y: res.y, alive: res.alive };
    }
  };

  // src/gamecore/monster.ts
  var scratch2 = [];
  var RANGED_HOLD_DISTANCE = 260;
  var DASH_PERIOD = 2.2;
  function updateMonster(m, dt, now, wallTopY, monsters, hash, onWallHit, onRangedShot) {
    const r = m.cfg.radius;
    const holdY = wallTopY + (m.cfg.behavior === "ranged" ? m.cfg.rangedDist ?? RANGED_HOLD_DISTANCE : 0) + r;
    if (m.state === "march") {
      let speed = m.cfg.speed;
      if (now < m.slowUntil) speed *= m.slowFactor;
      switch (m.cfg.behavior) {
        case "zigzag":
          m.phase += dt * 4;
          m.x += Math.sin(m.phase) * speed * 0.6 * dt;
          break;
        case "dash": {
          m.phase += dt;
          const cyc = m.phase % DASH_PERIOD;
          if (cyc < 0.4) speed *= 0.2;
          else if (cyc < 0.9) speed *= 3.2;
          break;
        }
        default:
          break;
      }
      m.y -= speed * dt;
      hash.queryCircle(m.x, m.y, r * 2, scratch2);
      for (const nid of scratch2) {
        if (nid === m.id) continue;
        const o = monsters[nid];
        if (!o || o.hp <= 0) continue;
        const dx = m.x - o.x;
        const dy = m.y - o.y;
        const d2 = dx * dx + dy * dy;
        const minD = r + o.cfg.radius;
        if (d2 > 1e-6 && d2 < minD * minD) {
          const d = Math.sqrt(d2);
          const push = (minD - d) / d * 0.5;
          m.x += dx * push;
          m.y += dy * push;
        }
      }
      if (m.y <= holdY) {
        m.y = holdY;
        m.state = "assault";
        m.attackTimer = m.cfg.attackInterval;
      }
    } else {
      m.attackTimer -= dt;
      if (m.attackTimer <= 0) {
        m.attackTimer += m.cfg.attackInterval;
        if (m.cfg.behavior === "ranged") {
          onRangedShot(m);
        } else {
          onWallHit(m.cfg.atk, m);
        }
      }
    }
  }

  // src/gamecore/hero.ts
  var BASE_ATK = 10;
  function xpNeed(level) {
    return Math.round(8 + 4 * level + 0.6 * level * level);
  }
  function createHero(x, y, weaponCfgs) {
    return {
      x,
      y,
      level: 1,
      xp: 0,
      stats: {
        atk: BASE_ATK,
        aspd: 1,
        moveSpeed: 260,
        critChance: 0.05,
        critDmg: 1.5,
        dmgMul: 0
      },
      weapons: weaponCfgs.map((cfg) => ({
        cfg,
        level: 1,
        damage: cfg.baseDamage,
        cooldown: 0.3,
        // 开局小延迟，避免第一帧齐射
        shotsSinceCool: 0,
        mods: { extraCount: 0, burst: 0, projSpeedMul: 1, damageMul: 1, rangeMul: 1, pierceAdd: 0 },
        element: cfg.damageType,
        riders: { burnDpsMul: 0, burnSec: 3, slowPct: 0, slowSec: 2.5 },
        affixes: { homing: 0, bounce: 0, split: 0, shred: 0, blast: 0, chain: 0 }
      }))
    };
  }
  function heroAttackerSnapshot(hero) {
    return {
      atk: hero.stats.atk,
      dmgMul: hero.stats.dmgMul,
      critChance: hero.stats.critChance,
      critDmg: hero.stats.critDmg,
      level: hero.level
    };
  }
  function updateWeapons(hero, monsters, hash, rng, out) {
    out.length = 0;
    for (const w of hero.weapons) {
      w.cooldown = Math.max(0, w.cooldown - 1 / 30);
      if (w.cooldown > 0) continue;
      const mods = w.mods;
      const range = w.cfg.projectileRange * mods.rangeMul;
      const target = acquireTarget(w.cfg.targeting, hero.x, hero.y, range, monsters, hash, rng);
      if (!target) continue;
      w.cooldown = w.cfg.interval / hero.stats.aspd;
      if (w.cfg.heat) {
        w.shotsSinceCool++;
        if (w.shotsSinceCool >= w.cfg.heat.shots) {
          w.shotsSinceCool = 0;
          w.cooldown = Math.max(w.cooldown, w.cfg.heat.cooldown);
        }
      }
      const n = norm(target.x - hero.x, target.y - hero.y);
      const total = w.cfg.count + mods.extraCount;
      for (let i = 0; i < total; i++) {
        out.push({
          weapon: w,
          fromX: hero.x,
          fromY: hero.y,
          dirX: n.x,
          dirY: n.y,
          speed: w.cfg.projectileSpeed * mods.projSpeedMul,
          range,
          dmg: w.damage * mods.damageMul,
          index: i,
          total,
          target
        });
      }
    }
  }
  function rollCardChoices(cards, stacks, weapons, rng, count = 3) {
    const pool = cards.filter((c) => {
      if ((stacks.get(c.id) ?? 0) >= c.maxStack) return false;
      const e = c.effect;
      if ("grantElement" in e) {
        return weapons.some((w) => w.element === w.cfg.damageType && !w.cfg.chainBase);
      }
      const t = c.target;
      if (!t || t.kind === "any") return true;
      if (t.kind === "weapon") return weapons.some((w) => w.cfg.id === t.weaponType);
      return weapons.some((w) => w.element === t.element);
    });
    const result = [];
    const bag = [...pool];
    while (result.length < count && bag.length > 0) {
      let total = 0;
      for (const c of bag) total += c.weight ?? 1;
      let roll = rng.next() * total;
      let idx = 0;
      for (; idx < bag.length; idx++) {
        roll -= bag[idx].weight ?? 1;
        if (roll <= 0) break;
      }
      idx = Math.min(idx, bag.length - 1);
      result.push(bag[idx]);
      bag.splice(idx, 1);
    }
    return result;
  }
  function applyStat(s, stat, op, value) {
    const cur = s[stat];
    s[stat] = op === "add" ? cur + value : cur * (1 + value);
  }
  function applyBulletMod(w, stat, op, value) {
    const m = w.mods;
    switch (stat) {
      case "count":
        m.extraCount = op === "add" ? m.extraCount + value : m.extraCount * (1 + value);
        break;
      case "burst":
        m.burst = op === "add" ? m.burst + value : m.burst * (1 + value);
        break;
      case "projSpeed":
        m.projSpeedMul = op === "add" ? m.projSpeedMul + value : m.projSpeedMul * (1 + value);
        break;
      case "damage":
        m.damageMul = op === "add" ? m.damageMul + value : m.damageMul * (1 + value);
        break;
      case "range":
        m.rangeMul = op === "add" ? m.rangeMul + value : m.rangeMul * (1 + value);
        break;
      case "pierce":
        m.pierceAdd = op === "add" ? m.pierceAdd + value : m.pierceAdd * (1 + value);
        break;
    }
  }
  function applyForm(a, form, value = 1) {
    switch (form) {
      case "homing":
        a.homing = Math.min(1, a.homing + value);
        break;
      case "bounce":
        a.bounce += value;
        break;
      case "split":
        a.split += value;
        break;
      case "shred":
        a.shred += value;
        break;
      case "blast":
        a.blast += value;
        break;
      case "chain":
        a.chain += value;
        break;
    }
  }

  // src/gamecore/session.ts
  var TICK_DT = 1 / 30;
  function distToSegment(px, py, ax, ay, bx, by) {
    const abx = bx - ax;
    const aby = by - ay;
    const len2 = abx * abx + aby * aby;
    if (len2 < 1e-9) return Math.hypot(px - ax, py - ay);
    const t = Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / len2));
    return Math.hypot(px - (ax + abx * t), py - (ay + aby * t));
  }
  var WaveDirector = class {
    constructor(level, rng) {
      this.level = level;
      this.rng = rng;
      this.state = "prepare";
      this.waveIndex = -1;
      this.schedule = [];
      this.waveElapsed = 0;
      this.stateTimer = level.prepareSec;
    }
    get currentWave() {
      return this.waveIndex;
    }
    get isLastWave() {
      return this.waveIndex >= this.level.waves.length - 1;
    }
    /** 每 tick 调用；返回本 tick 应刷出的怪物。 */
    update(session, dt) {
      const out = [];
      this.stateTimer -= dt;
      switch (this.state) {
        case "prepare":
          if (this.stateTimer <= 0) {
            this.waveIndex++;
            this.waveElapsed = 0;
            this.schedule = this.buildSchedule(this.waveIndex);
            session.onWaveStart(this.waveIndex, this.level.waves[this.waveIndex].banner);
            this.state = "spawning";
          }
          break;
        case "spawning":
          this.waveElapsed += dt;
          while (this.schedule.length > 0 && this.schedule[0].at <= this.waveElapsed && out.length < 8) {
            out.push(this.schedule.shift().item);
          }
          if (this.schedule.length === 0) this.state = "clearing";
          break;
        case "clearing":
          if (session.monsters.length === 0) {
            session.onWaveClear(this.waveIndex);
            if (this.isLastWave) {
              this.state = "done";
            } else {
              this.state = "intermission";
              this.stateTimer = this.level.intermissionSec;
            }
          }
          break;
        case "intermission":
          if (this.stateTimer <= 0) {
            this.state = "prepare";
            this.stateTimer = this.level.prepareSec;
          }
          break;
        case "done":
          break;
      }
      return out;
    }
    /** 把一波的怪物构成切成多段潮，每段在一小时间窗内密集进场。 */
    buildSchedule(waveIndex) {
      const wave = this.level.waves[waveIndex];
      const formation = wave.formation ?? "stream";
      const duration = wave.durationSec ?? 60;
      const allPts = this.level.spawnPointsX;
      const total = wave.spawns.reduce((s, sp) => s + sp.count, 0);
      const segCount = Math.max(3, Math.min(7, Math.round(total / 12)));
      const segInterval = duration / segCount;
      const windowSec = Math.min(5, segInterval * 0.6);
      const out = [];
      for (const spawn of wave.spawns) {
        const pts = spawn.spawnPoints === "all" ? allPts : spawn.spawnPoints.map((i) => allPts[i]);
        for (let s = 0; s < segCount; s++) {
          const cnt = Math.floor(spawn.count / segCount) + (s < spawn.count % segCount ? 1 : 0);
          for (let i = 0; i < cnt; i++) {
            let x;
            switch (formation) {
              case "line":
                x = pts[i % pts.length];
                break;
              case "center":
                x = pts[Math.floor(pts.length / 2)] + this.rng.range(-50, 50);
                break;
              case "pincer":
                x = i % 2 === 0 ? pts[0] + this.rng.range(0, 60) : pts[pts.length - 1] - this.rng.range(0, 60);
                break;
              case "stream":
              default:
                x = this.rng.pick(pts);
                break;
            }
            const at = s * segInterval + i / Math.max(1, cnt) * windowSec + this.rng.range(0, 0.4);
            out.push({ at, item: { monsterKey: spawn.monster, spawnX: x } });
          }
        }
      }
      out.sort((a, b) => a.at - b.at);
      return out;
    }
  };
  var GameSession = class {
    constructor(opts) {
      this.bus = new EventBus();
      this.monsters = [];
      this.projectiles = [];
      this.monsterShots = [];
      // 怪物远程弹（可见弹道，落点结算对墙伤害）
      this.pools = [];
      this.segments = [];
      // 可被 B 类卡（加固城墙）提升
      this.tick = 0;
      this.result = null;
      /** 人类输入模式：升级结算挂起，等 UI 调用 resolveLevelUp（Web/Cocos 适配层用）。 */
      this.externalLevelUps = false;
      this.pendingLevelChoices = [];
      /** 沙盒模式（实验室）：跳过胜负结算，会话永不结束。 */
      this.sandboxMode = false;
      this.hash = new SpatialHash(64);
      this.fireCommands = [];
      /** 连射（burst）的后续子弹调度 */
      this.burstQueue = [];
      this.nextEntityId = 1;
      this.cardStacks = /* @__PURE__ */ new Map();
      this.pendingLevels = 0;
      // 报表累计
      this.totalDamage = 0;
      this.totalCrits = 0;
      this.totalKills = 0;
      this.totalWallDamage = 0;
      this.maxMonsters = 0;
      this.maxProjectiles = 0;
      this.cardPickLog = [];
      this.waveStats = [];
      this.waveKills = 0;
      this.waveWallDamage = 0;
      /** 每 tick 注入的运动上下文（轨迹基元通过它查询世界，保持零持有状态）。 */
      this.motionCtx = {
        dt: TICK_DT,
        now: 0,
        ownerX: 0,
        ownerY: 0,
        nearestMonster: (x, y, r, exclude) => this.nearestMonsterExcluding(x, y, r, exclude)
      };
      this.scratch = [];
      this._lastClearTick = 0;
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
    get timeSec() {
      return this.tick * TICK_DT;
    }
    /** 推进一个固定逻辑帧。 */
    step() {
      if (this.result) return;
      const dt = TICK_DT;
      const now = this.timeSec;
      this.motionCtx.now = now;
      this.motionCtx.ownerX = this.hero.x;
      this.motionCtx.ownerY = this.hero.y;
      const spawned = this.director.update(this, dt);
      for (const item of spawned) this.spawnMonster(item.monsterKey, item.spawnX);
      const move = this.controller.getMoveDir(this);
      const len2 = Math.hypot(move.x, move.y);
      if (len2 > 1e-6) {
        const { width } = this.level.arena;
        this.hero.x = clamp(this.hero.x + move.x / len2 * this.hero.stats.moveSpeed * dt, 20, width - 20);
        this.hero.y = clamp(
          this.hero.y + move.y / len2 * this.hero.stats.moveSpeed * dt,
          this.level.defenseRect.yMin,
          this.level.defenseRect.yMax
        );
      }
      this.hash.rebuild(this.monsters);
      updateWeapons(this.hero, this.monsters, this.hash, this.rng, this.fireCommands);
      for (const cmd of this.fireCommands) {
        if ((cmd.weapon.cfg.chainBase ?? 0) > 0 || cmd.weapon.affixes.chain > 0) {
          this.doLightning(cmd);
        } else {
          this.spawnProjectile(cmd);
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
          this.killProjectile(p);
          continue;
        }
        this.collideProjectile(p);
      }
      this.hash.rebuild(this.monsters);
      for (const m of this.monsters) {
        if (m.hp <= 0) continue;
        this.tickBurns(m, dt);
        if (m.hp <= 0) continue;
        updateMonster(m, dt, now, this.level.wall.height, this.monsters, this.hash, (dmg, src) => {
          this.wallHp = Math.max(0, this.wallHp - dmg);
          this.totalWallDamage += dmg;
          this.waveWallDamage += dmg;
          this.bus.emit("onWallHit", { dmg, wallHp: this.wallHp, x: src.x, y: this.level.wall.height + 26 });
        }, (src) => {
          this.spawnMonsterShot(src);
        });
      }
      for (let i = this.monsterShots.length - 1; i >= 0; i--) {
        const s = this.monsterShots[i];
        s.t += dt / s.dur;
        if (s.t >= 1) {
          this.wallHp = Math.max(0, this.wallHp - s.dmg);
          this.totalWallDamage += s.dmg;
          this.waveWallDamage += s.dmg;
          this.bus.emit("onWallHit", { dmg: s.dmg, wallHp: this.wallHp, x: s.tx, y: this.level.wall.height + 26 });
          this.monsterShots.splice(i, 1);
          continue;
        }
        s.x = s.sx + (s.tx - s.sx) * s.t;
        s.y = s.sy + (s.ty - s.sy) * s.t;
        s.height = Math.sin(s.t * Math.PI) * (s.kind === "rock" ? 140 : 40);
      }
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
          const rr2 = pool.radius + m.cfg.radius;
          const dx = m.x - pool.x;
          const dy = m.y - pool.y;
          if (dx * dx + dy * dy > rr2 * rr2) continue;
          const dmg = pool.dps * dt;
          m.hp -= dmg;
          this.totalDamage += dmg;
          if (m.hp <= 0) this.killMonster(null, m);
        }
      }
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
          const rr2 = seg.width / 2 + m.cfg.radius;
          if (distToSegment(m.x, m.y, seg.ax, seg.ay, seg.bx, seg.by) > rr2) continue;
          const dmg = seg.dps * dt;
          m.hp -= dmg;
          this.totalDamage += dmg;
          if (m.hp <= 0) this.killMonster(null, m);
        }
      }
      while (this.hero.xp >= xpNeed(this.hero.level)) {
        this.hero.xp -= xpNeed(this.hero.level);
        this.hero.level++;
        this.pendingLevels++;
      }
      if (this.sandboxMode) {
        this.pendingLevels = 0;
        this.pendingLevelChoices = [];
      }
      while (this.pendingLevels > 0) {
        if (this.externalLevelUps) {
          if (this.pendingLevelChoices.length === 0) {
            this.pendingLevelChoices = rollCardChoices(this.cardConfigs, this.cardStacks, this.hero.weapons, this.rng);
            if (this.pendingLevelChoices.length === 0) {
              this.pendingLevels = 0;
              break;
            }
            this.bus.emit("onLevelUpPending", { level: this.hero.level });
          }
          break;
        }
        this.pendingLevels--;
        const choices = rollCardChoices(this.cardConfigs, this.cardStacks, this.hero.weapons, this.rng);
        if (choices.length === 0) break;
        const picked = this.cardPolicy(choices, this.hero, this.rng, this);
        this.applyPickedCard(picked);
      }
      if (this.monsters.some((m) => m.hp <= 0)) {
        this.monsters = this.monsters.filter((m) => m.hp > 0);
        this.monsters.forEach((m, i) => {
          m.id = i;
        });
      }
      this.projectiles = this.projectiles.filter((p) => p.alive);
      this.maxMonsters = Math.max(this.maxMonsters, this.monsters.length);
      this.maxProjectiles = Math.max(this.maxProjectiles, this.projectiles.length);
      if (!this.sandboxMode) {
        if (this.wallHp <= 0) {
          this.result = "defeat";
          this.bus.emit("onGameOver", { result: this.result });
        } else if (this.director.state === "done" && this.monsters.length === 0) {
          this.result = "victory";
          this.bus.emit("onGameOver", { result: this.result });
        }
      }
      this.tick++;
    }
    // ---------- 内部 ----------
    /** 远程怪发射可见弹道（投矛/投石），落点结算对墙伤害。 */
    spawnMonsterShot(src) {
      const isRock = (src.cfg.rangedDist ?? 0) > 400;
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
        kind: isRock ? "rock" : "spear"
      });
    }
    spawnMonster(key, spawnX, spawnY) {
      const cfg = this.monsterCfgs.get(key);
      if (!cfg) throw new Error(`\u672A\u77E5\u602A\u7269\u914D\u7F6E: ${key}`);
      const x = clamp(spawnX, 40, this.level.arena.width - 40);
      const y = spawnY ?? this.rng.range(this.level.spawnBandY[0], this.level.spawnBandY[1]);
      const scale = 1 + 0.1 * this.director.currentWave;
      const hp = Math.round(cfg.hp * scale);
      this.monsters.push({
        id: this.monsters.length,
        // tick 内密度数组约定
        cfg,
        x,
        y,
        hp,
        maxHp: hp,
        state: "march",
        attackTimer: cfg.attackInterval,
        phase: this.rng.range(0, Math.PI * 2),
        burn: null,
        slowUntil: 0,
        slowFactor: 1,
        shredUntil: 0,
        shredAmount: 0
      });
    }
    spawnProjectile(cmd) {
      const { weapon, fromX, fromY, dirX, dirY, speed, range, dmg, index } = cmd;
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
      let motionCfg = homing ? { type: "homing", speed, range, turnRate: 360, duration: 2.5, retarget: true } : weapon.cfg.motion ?? { type: "straight", speed, range };
      if (motionCfg.type === "phased" && weapon.mods.rangeMul !== 1) {
        motionCfg = {
          ...motionCfg,
          phases: motionCfg.phases.map(
            (ph) => ph.until.kind === "distance" ? { ...ph, until: { ...ph.until, value: ph.until.value * weapon.mods.rangeMul } } : ph
          )
        };
      }
      const blastBase = weapon.cfg.blastBase;
      const blast = affixes.blast > 0 || blastBase ? {
        radius: (blastBase?.radius ?? 70) + 30 * Math.max(0, affixes.blast - 1),
        dmgMul: (blastBase?.dmgMul ?? 0.5) + 0.25 * Math.max(0, affixes.blast - 1),
        poolDpsMul: blastBase?.poolDpsMul ?? 0.4,
        poolSec: blastBase?.poolSec ?? 2.5
      } : null;
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
        hitIds: /* @__PURE__ */ new Map(),
        alive: true,
        affixes,
        riders,
        homing,
        motionCfg,
        blast
      });
      this.bus.emit("onShoot", {});
    }
    collideProjectile(p) {
      const now = this.timeSec;
      const reach = p.radius + 34 + p.stepLen;
      this.hash.queryCircle(p.x, p.y, reach, this.scratch);
      for (const mid of this.scratch) {
        if (!p.alive) break;
        const m = this.monsters[mid];
        if (!m || m.hp <= 0) continue;
        if (p.hitIds.has(m.id) && now - (p.hitIds.get(m.id) ?? 0) < 0.5) continue;
        const rr2 = p.radius + m.cfg.radius;
        if (distToSegment(m.x, m.y, p.px, p.py, p.x, p.y) > rr2) continue;
        p.hitIds.set(m.id, now);
        const falloffRate = Math.max(0, (p.weapon.cfg.pierceFalloff ?? 0.15) - p.affixes.shred * 0.06);
        const effDmg = p.dmg * Math.min(1, Math.max(0, 1 - falloffRate * p.pierceCount));
        const def = Math.max(0, m.cfg.def - (now < m.shredUntil ? m.shredAmount : 0));
        const res = calcDamage(
          heroAttackerSnapshot(this.hero),
          { def, level: this.director.currentWave + 1 },
          {
            skillMul: effDmg / BASE_ATK,
            damageType: p.damageType,
            typeMul: m.cfg.weak?.includes(p.damageType) ? 1.25 : m.cfg.resist?.includes(p.damageType) ? 0.75 : 1
          },
          this.rng
        );
        m.hp -= res.amount;
        this.totalDamage += res.amount;
        if (res.isCrit) this.totalCrits++;
        this.bus.emit("onHit", { monsterId: m.id, dmg: res.amount, isCrit: res.isCrit, x: m.x, y: m.y });
        if (p.damageType === "fire" && p.riders.burnDpsMul > 0) {
          const dps = p.dmg * p.riders.burnDpsMul;
          if (m.burn && m.burn.dps >= dps) {
            m.burn.until = now + p.riders.burnSec;
          } else {
            m.burn = { dps, until: now + p.riders.burnSec, nextTick: now + 0.5 };
          }
        }
        if (p.damageType === "frost" && p.riders.slowPct > 0) {
          m.slowFactor = Math.max(0.35, 1 - p.riders.slowPct);
          m.slowUntil = now + p.riders.slowSec;
        }
        if (p.affixes.shred > 0) {
          m.shredAmount = 3 * p.affixes.shred;
          m.shredUntil = now + 4;
        }
        if (m.hp <= 0) this.killMonster(p, m);
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
    doLightning(cmd) {
      const now = this.timeSec;
      const path = [[cmd.fromX, cmd.fromY]];
      const hit = /* @__PURE__ */ new Set();
      let cur = cmd.target ?? null;
      let mul = 1;
      let strikesLeft = (cmd.weapon.cfg.chainBase ?? 0) + cmd.weapon.affixes.chain;
      while (cur && strikesLeft > 0) {
        hit.add(cur.id);
        const def = Math.max(0, cur.cfg.def - (now < cur.shredUntil ? cur.shredAmount : 0));
        const res = calcDamage(
          heroAttackerSnapshot(this.hero),
          { def, level: this.director.currentWave + 1 },
          {
            skillMul: cmd.dmg * mul / BASE_ATK,
            damageType: "lightning",
            typeMul: cur.cfg.weak?.includes("lightning") ? 1.25 : cur.cfg.resist?.includes("lightning") ? 0.75 : 1
          },
          this.rng
        );
        cur.hp -= res.amount;
        this.totalDamage += res.amount;
        if (res.isCrit) this.totalCrits++;
        this.bus.emit("onHit", { monsterId: cur.id, dmg: res.amount, isCrit: res.isCrit, x: cur.x, y: cur.y });
        if (cur.hp <= 0) this.killMonster(null, cur);
        path.push([cur.x, cur.y]);
        strikesLeft--;
        mul *= 0.8;
        cur = strikesLeft > 0 ? this.nearestMonsterRuntime(cur.x, cur.y, 420 * cmd.weapon.mods.rangeMul, hit) : null;
      }
      this.bus.emit("onChain", { points: path });
    }
    /** 半径内最近的存活怪。exclude 为 Map 时按 0.5s 重击冷却排除（悬停研磨可重复命中），Set 时永久排除。 */
    nearestMonsterRuntime(x, y, radius, exclude) {
      const now = this.timeSec;
      this.hash.queryCircle(x, y, radius, this.scratch);
      let best = null;
      let bestD = Infinity;
      for (const id of this.scratch) {
        if (exclude.has(id)) {
          if (exclude instanceof Map) {
            const t = exclude.get(id);
            if (t !== void 0 && now - t < 0.5) continue;
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
    nearestMonsterExcluding(x, y, radius, exclude) {
      return this.nearestMonsterRuntime(x, y, radius, exclude);
    }
    /** 弹射：找最近的未命中过的怪物重定向弹道（按运动配置重建，保留追踪）。 */
    tryBounce(p) {
      const best = this.nearestMonsterRuntime(p.x, p.y, 520, p.hitIds);
      if (!best) return false;
      const dist = Math.hypot(best.x - p.x, best.y - p.y);
      p.trajectory = createTrajectory(p.motionCfg, { dirX: best.x - p.x, dirY: best.y - p.y, target: best });
      return true;
    }
    /** 投射物消亡：触发"爆破落地"范围伤害圈。 */
    killProjectile(p) {
      if (!p.alive) return;
      p.alive = false;
      if (!p.blast) return;
      const now = this.timeSec;
      const { radius, dmgMul, poolDpsMul, poolSec } = p.blast;
      this.hash.queryCircle(p.x, p.y, radius, this.scratch);
      for (const mid of this.scratch) {
        const m = this.monsters[mid];
        if (!m || m.hp <= 0) continue;
        const rr2 = radius + m.cfg.radius;
        const dx = m.x - p.x;
        const dy = m.y - p.y;
        if (dx * dx + dy * dy > rr2 * rr2) continue;
        const def = Math.max(0, m.cfg.def - (now < m.shredUntil ? m.shredAmount : 0));
        const res = calcDamage(
          heroAttackerSnapshot(this.hero),
          { def, level: this.director.currentWave + 1 },
          {
            skillMul: p.dmg * dmgMul / BASE_ATK,
            damageType: p.damageType,
            typeMul: m.cfg.weak?.includes(p.damageType) ? 1.25 : m.cfg.resist?.includes(p.damageType) ? 0.75 : 1
          },
          this.rng
        );
        m.hp -= res.amount;
        this.totalDamage += res.amount;
        if (res.isCrit) this.totalCrits++;
        if (m.hp <= 0) this.killMonster(null, m);
      }
      this.pools.push({
        x: p.x,
        y: p.y,
        radius,
        dps: p.dmg * poolDpsMul,
        until: now + poolSec,
        damageType: p.damageType
      });
      this.bus.emit("onExplode", { x: p.x, y: p.y, radius });
    }
    /** 灼烧：附着的火焰每 0.5s 跳一次伤害直至熄灭（重复命中只刷新时长，不叠加）。 */
    tickBurns(m, _dt) {
      const b = m.burn;
      if (!b) return;
      const now = this.timeSec;
      if (now >= b.until) {
        m.burn = null;
        return;
      }
      if (now >= b.nextTick) {
        b.nextTick += 0.5;
        const dmg = b.dps * 0.5;
        m.hp -= dmg;
        this.totalDamage += dmg;
        this.bus.emit("onBurnTick", { x: m.x, y: m.y });
        if (m.hp <= 0) this.killMonster(null, m);
      }
    }
    /** 外部（人类玩家）完成三选一决策；未挂起时调用为无操作。 */
    resolveLevelUp(card) {
      if (this.pendingLevelChoices.length === 0) return;
      this.pendingLevelChoices = [];
      this.pendingLevels = Math.max(0, this.pendingLevels - 1);
      this.applyPickedCard(card);
    }
    // ---------- 测试入口（tools/lab 与 web/lab.html 用，不影响正常对局） ----------
    /** 直接授予一张卡（跳过升级流程），不适用/达上限/id 不存在时返回 false。 */
    grantCard(cardId) {
      const card = this.cardConfigs.find((c) => c.id === cardId);
      if (!card) return false;
      if ((this.cardStacks.get(card.id) ?? 0) >= card.maxStack) return false;
      if (!this.isCardApplicable(card)) return false;
      this.applyPickedCard(card);
      return true;
    }
    /** 卡牌适用性（与 rollCardChoices 同一套门控规则；实验室/UI 可查询）。 */
    isCardApplicable(card) {
      const e = card.effect;
      if ("grantElement" in e) {
        return this.hero.weapons.some((w) => w.element === w.cfg.damageType && !w.cfg.chainBase);
      }
      const t = card.target;
      if (!t || t.kind === "any") return true;
      if (t.kind === "weapon") return this.hero.weapons.some((w) => w.cfg.id === t.weaponType);
      return this.hero.weapons.some((w) => w.element === t.element);
    }
    /** 在指定位置生成测试怪；id 不存在返回 false。 */
    debugSpawn(monsterKey, x, y) {
      if (!this.monsterCfgs.has(monsterKey)) return false;
      this.spawnMonster(monsterKey, x, y);
      return true;
    }
    /** 测试入口：光束——锚定英雄、朝 angle（弧度）持续 dps 伤害 duration 秒。 */
    debugBeam(angleRad, length, dps, duration, width = 40) {
      this.segments.push({
        ax: this.hero.x,
        ay: this.hero.y,
        bx: this.hero.x,
        by: this.hero.y + length,
        width,
        dps,
        until: this.timeSec + duration,
        damageType: "lightning",
        followOwner: true,
        angle: angleRad,
        length
      });
      this.bus.emit("onBeam", {});
    }
    /** 测试入口：固定两点连线（电网），持续 dps 伤害 duration 秒。 */
    debugLink(ax, ay, bx, by, dps, duration, width = 40) {
      this.segments.push({
        ax,
        ay,
        bx,
        by,
        width,
        dps,
        until: this.timeSec + duration,
        damageType: "lightning"
      });
      this.bus.emit("onBeam", {});
    }
    /**
     * 统一卡牌结算（docs/03 §2.2）：按目标声明分发——
     * 公共卡作用于全部武器/英雄；武器专属卡只作用于匹配武器；元素卡需武器已携带对应元素。
     */
    applyPickedCard(picked) {
      const e = picked.effect;
      const t = picked.target;
      const targets = t && t.kind === "weapon" ? this.hero.weapons.filter((w) => w.cfg.id === t.weaponType) : this.hero.weapons;
      if ("stat" in e) {
        applyStat(this.hero.stats, e.stat, e.op, e.value);
      } else if ("bullet" in e) {
        for (const w of targets) applyBulletMod(w, e.bullet, e.op, e.value);
      } else if ("wall" in e) {
        if (e.wall === "wallMax") {
          const add = Math.round(this.wallMaxHp * e.value);
          this.wallMaxHp += add;
          this.wallHp = Math.min(this.wallMaxHp, this.wallHp + add);
        } else {
          this.wallHp = Math.min(this.wallMaxHp, this.wallHp + e.value);
        }
        this.bus.emit("onWallHeal", { wallHp: this.wallHp, wallMaxHp: this.wallMaxHp });
      } else if ("form" in e) {
        for (const w of targets) applyForm(w.affixes, e.form, e.value);
      } else if ("grantElement" in e) {
        for (const w of this.hero.weapons) {
          w.element = e.grantElement;
          if (e.grantElement === "fire") {
            w.riders.burnDpsMul = Math.max(w.riders.burnDpsMul, 0.25);
            w.riders.burnSec = 3;
          } else if (e.grantElement === "frost") {
            w.riders.slowPct = Math.max(w.riders.slowPct, 0.12);
            w.riders.slowSec = 2.5;
          }
        }
      } else {
        for (const w of this.hero.weapons.filter((x) => x.element === e.boostElement)) {
          if (e.boostElement === "fire") {
            w.riders.burnDpsMul += 0.15 * e.value;
            w.riders.burnSec = 3;
          } else if (e.boostElement === "frost") {
            w.riders.slowPct = Math.min(0.65, w.riders.slowPct + 0.06 * e.value);
            w.riders.slowSec += 0.5 * e.value;
          }
        }
      }
      this.cardStacks.set(picked.id, (this.cardStacks.get(picked.id) ?? 0) + 1);
      this.cardPickLog.push(`${picked.name}(Lv${this.cardStacks.get(picked.id)})`);
      this.bus.emit("onLevelUp", { level: this.hero.level, picked: picked.id });
    }
    killMonster(p, m) {
      this.totalKills++;
      this.waveKills++;
      this.hero.xp += m.cfg.xp;
      this.bus.emit("onKill", { monsterId: m.id, key: m.cfg.id });
      if (p && p.affixes.split > 0) {
        const base = Math.atan2(p.y - p.py, p.x - p.px);
        let childTarget = null;
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
          const childCfg = childHoming ? { type: "homing", speed: p.speed, range: 500, turnRate: 360, duration: 2.5, retarget: true } : { type: "straight", speed: p.speed, range: 500 };
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
            hitIds: /* @__PURE__ */ new Map(),
            alive: true,
            affixes: { ...p.affixes, split: 0, bounce: 0, blast: 0 },
            riders: p.riders,
            homing: childHoming,
            motionCfg: childCfg,
            blast: null
          });
        }
      }
    }
    // ---------- 导演回调（报表） ----------
    onWaveStart(index, banner) {
      this.waveKills = 0;
      this.waveWallDamage = 0;
      this.bus.emit("onWaveStart", { index, banner });
    }
    onWaveClear(index) {
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
        wallHpEnd: Math.round(this.wallHp)
      });
      this._lastClearTick = this.tick;
      this.bus.emit("onWaveClear", { index });
    }
  };

  // tools/sim/policies.ts
  var greedyDpsPolicy = (choices, _hero, _rng, session) => {
    const wallDanger = session ? 1 - session.wallHp / session.wallMaxHp : 0;
    const prio = (c) => {
      const e = c.effect;
      if (c.type === "wall") {
        if (c.id === "fortify") return wallDanger > 0.35 ? 99 : 55;
        return wallDanger > 0.3 ? 92 : 25;
      }
      if (c.type === "bullet") {
        const isWeaponSpecific = c.target?.kind === "weapon";
        switch (e.bullet) {
          case "damage":
            return 100;
          case "count":
            return isWeaponSpecific ? 96 : 90;
          case "burst":
            return isWeaponSpecific ? 94 : 88;
          case "range":
            return 60;
          case "projSpeed":
            return 55;
          default:
            return 50;
        }
      }
      if (c.type === "form") {
        switch (e.form) {
          case "chain":
            return 92;
          case "blast":
            return 86;
          case "bounce":
            return 82;
          case "split":
            return 80;
          case "homing":
            return 78;
          case "shred":
            return 58;
          default:
            return 50;
        }
      }
      if (c.type === "element") {
        if ("grantElement" in e) return e.grantElement === "fire" ? 76 : 74;
        return 62;
      }
      switch (e.stat) {
        case "atk":
          return 98;
        case "aspd":
          return 90;
        case "critChance":
          return 75;
        case "critDmg":
          return 72;
        case "dmgMul":
          return 68;
        case "moveSpeed":
          return 40;
        default:
          return 10;
      }
    };
    return [...choices].sort((a, b) => prio(b) - prio(a))[0];
  };

  // src/adapter/web/render/shapes.ts
  var MONSTER_COLOR = {
    slime: "#FF6B57",
    wolf: "#FF8357",
    charger: "#FFA25E",
    thrower: "#FF5E7A",
    bulwark: "#8A93B8",
    bat: "#FF7EC7",
    shroom: "#FF6B9C",
    boss: "#B537F2"
  };
  function monsterColor(m) {
    return MONSTER_COLOR[m.cfg.shape ?? "slime"] ?? "#FF6B57";
  }
  function rr(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function drawMonster(ctx, m, t) {
    const r = m.cfg.radius;
    const moving = m.state === "march";
    const color = monsterColor(m);
    ctx.fillStyle = color;
    const x = m.x;
    const y = m.y;
    switch (m.cfg.shape) {
      case "wolf": {
        const stretch = moving ? 1 + 0.15 * Math.sin(t * 8 + m.phase) : 1;
        ctx.save();
        ctx.translate(x, y);
        ctx.scale(1, stretch);
        ctx.beginPath();
        ctx.moveTo(0, -r);
        ctx.lineTo(-r * 0.85, r * 0.8);
        ctx.lineTo(r * 0.85, r * 0.8);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
        break;
      }
      case "charger": {
        ctx.save();
        ctx.translate(x, y);
        ctx.beginPath();
        ctx.moveTo(0, -r * 1.4);
        ctx.lineTo(-r * 0.55, r);
        ctx.lineTo(r * 0.55, r);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
        break;
      }
      case "thrower": {
        ctx.beginPath();
        ctx.moveTo(x - r * 0.8, y - r * 0.7);
        ctx.lineTo(x + r * 0.8, y - r * 0.7);
        ctx.lineTo(x + r * 0.5, y + r * 0.8);
        ctx.lineTo(x - r * 0.5, y + r * 0.8);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(x, y + r * 0.3);
        ctx.lineTo(x, y + r * 1.6);
        ctx.stroke();
        break;
      }
      case "bulwark": {
        ctx.beginPath();
        for (let i = 0; i < 6; i++) {
          const a = Math.PI / 3 * i + Math.PI / 6;
          const px = x + Math.cos(a) * r;
          const py = y + Math.sin(a) * r;
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = "rgba(11,12,29,.55)";
        ctx.lineWidth = 3;
        ctx.beginPath();
        for (let i = 0; i < 6; i++) {
          const a = Math.PI / 3 * i + Math.PI / 6;
          const px = x + Math.cos(a) * r * 0.55;
          const py = y + Math.sin(a) * r * 0.55;
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.stroke();
        break;
      }
      case "bat": {
        const flap = 0.75 + 0.3 * Math.sin(t * 12 + m.phase);
        ctx.save();
        ctx.translate(x, y);
        ctx.scale(1, flap);
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(-r * 1.3, -r * 0.7);
        ctx.lineTo(-r * 0.9, r * 0.5);
        ctx.closePath();
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(r * 1.3, -r * 0.7);
        ctx.lineTo(r * 0.9, r * 0.5);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
        break;
      }
      case "shroom": {
        ctx.beginPath();
        ctx.arc(x, y + r * 0.35, r * 0.55, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(x, y - r * 0.35, r * 0.85, Math.PI, 0);
        ctx.fill();
        break;
      }
      case "boss": {
        const pulse = 1 + 0.04 * Math.sin(t * 2.4 + m.phase);
        ctx.save();
        ctx.translate(x, y);
        ctx.scale(pulse, pulse);
        ctx.beginPath();
        for (let i = 0; i < 12; i++) {
          const a = Math.PI / 6 * i;
          const rad = i % 2 === 0 ? r * 1.15 : r * 0.92;
          const px = Math.cos(a) * rad;
          const py = Math.sin(a) * rad;
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = "rgba(11,12,29,.5)";
        ctx.beginPath();
        ctx.arc(0, 0, r * 0.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        break;
      }
      case "slime":
      default: {
        const sq = moving ? 1 + 0.12 * Math.sin(t * 6 + m.phase) : 1;
        ctx.save();
        ctx.translate(x, y);
        ctx.scale(2 - sq, sq);
        rr(ctx, -r, -r, r * 2, r * 2, r * 0.45);
        ctx.fill();
        ctx.restore();
        break;
      }
    }
  }
  function drawProjectile(ctx, p, t, color) {
    const shape = p.weapon.cfg.shape ?? "dot";
    const dx = p.x - p.px;
    const dy = p.y - p.py;
    const len2 = Math.hypot(dx, dy) || 1;
    const ux = dx / len2;
    const uy = dy / len2;
    switch (shape) {
      case "arrow": {
        const shaft = 22;
        ctx.strokeStyle = color;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(p.x - ux * shaft, p.y - uy * shaft);
        ctx.lineTo(p.x + ux * 6, p.y + uy * 6);
        ctx.stroke();
        ctx.fillStyle = color;
        ctx.beginPath();
        const px = -uy;
        const py = ux;
        ctx.moveTo(p.x + ux * 12, p.y + uy * 12);
        ctx.lineTo(p.x - ux * 2 + px * 4.5, p.y - uy * 2 + py * 4.5);
        ctx.lineTo(p.x - ux * 2 - px * 4.5, p.y - uy * 2 - py * 4.5);
        ctx.closePath();
        ctx.fill();
        break;
      }
      case "bomb": {
        const h = p.height;
        ctx.fillStyle = "rgba(0,0,0,0.3)";
        ctx.beginPath();
        ctx.ellipse(p.x, p.y, 9, 3.5, 0, 0, Math.PI * 2);
        ctx.fill();
        const by = p.y + h;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(p.x, by, p.radius + 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "rgba(11,12,29,.6)";
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(p.x, by + p.radius + 3);
        ctx.lineTo(p.x + 3, by + p.radius + 8);
        ctx.stroke();
        ctx.fillStyle = `rgba(255,213,79,${0.6 + 0.4 * Math.sin(t * 20)})`;
        ctx.beginPath();
        ctx.arc(p.x + 3, by + p.radius + 9, 2.2, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case "gear":
      case "crescent": {
        const R = 17;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(t * 10 + p.id);
        ctx.fillStyle = color;
        for (let i = 0; i < 8; i++) {
          ctx.save();
          ctx.rotate(Math.PI / 4 * i);
          ctx.fillRect(-2.5, -R - 4.5, 5, 6.5);
          ctx.restore();
        }
        ctx.beginPath();
        ctx.arc(0, 0, R, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#0B0C1D";
        ctx.beginPath();
        ctx.arc(0, 0, R * 0.45, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        break;
      }
      case "dot":
      default: {
        ctx.strokeStyle = color + "66";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(p.x - ux * 30, p.y - uy * 30);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
    }
  }
  function drawMonsterShot(ctx, s) {
    const color = "#FFB357";
    if (s.kind === "rock") {
      ctx.fillStyle = "rgba(0,0,0,0.28)";
      ctx.beginPath();
      ctx.ellipse(s.x, s.ty, 10, 4, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(s.x, s.y + s.height, 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(11,12,29,.5)";
      ctx.lineWidth = 2;
      ctx.stroke();
    } else {
      const dx = s.tx - s.sx;
      const dy = s.ty - s.sy;
      const l = Math.hypot(dx, dy) || 1;
      const ux = dx / l;
      const uy = dy / l;
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(s.x - ux * 16, s.y - uy * 16 + s.height);
      ctx.lineTo(s.x + ux * 4, s.y + uy * 4 + s.height);
      ctx.stroke();
    }
  }

  // src/adapter/web/main.ts
  var W = 1080;
  var H = 1920;
  async function fetchJson(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`\u52A0\u8F7D\u5931\u8D25: ${url}`);
    return r.json();
  }
  function strokeBoltPath(ctx, pts) {
    let first = true;
    for (let s = 0; s < pts.length - 1; s++) {
      const [x1, y1] = pts[s];
      const [x2, y2] = pts[s + 1];
      const mx = (x1 + x2) / 2 + (Math.random() - 0.5) * 20;
      const my = (y1 + y2) / 2 + (Math.random() - 0.5) * 20;
      if (first) {
        ctx.moveTo(x1, y1);
        first = false;
      }
      ctx.lineTo(mx, my);
      ctx.lineTo(x2, y2);
    }
  }
  async function boot() {
    const [palette, weaponsFile, monstersFile, cardsFile, level] = await Promise.all([
      fetchJson("/configs/art-style/palette.json"),
      fetchJson("/configs/weapons.json"),
      fetchJson("/configs/monsters.json"),
      fetchJson("/configs/cards.json"),
      fetchJson(`/configs/levels/${new URLSearchParams(location.search).get("level") ?? "level_1_1.json"}`)
    ]);
    const canvas = document.getElementById("game");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    const hudWall = document.getElementById("wallbar");
    const hudWallText = document.getElementById("walltext");
    const hudXp = document.getElementById("xpbar");
    const hudText = document.getElementById("hudtext");
    const banner = document.getElementById("banner");
    const cardOverlay = document.getElementById("cards");
    const gameOver = document.getElementById("gameover");
    const input = { tx: W / 2, ty: 300, hasTarget: false, keys: /* @__PURE__ */ new Set() };
    function toGameCoords(e) {
      const rect = canvas.getBoundingClientRect();
      return {
        x: (e.clientX - rect.left) / rect.width * W,
        y: (e.clientY - rect.top) / rect.height * H
      };
    }
    canvas.addEventListener("pointerdown", (e) => {
      canvas.setPointerCapture(e.pointerId);
      const p = toGameCoords(e);
      input.tx = p.x;
      input.ty = p.y;
      input.hasTarget = true;
    });
    canvas.addEventListener("pointermove", (e) => {
      if (input.hasTarget) {
        const p = toGameCoords(e);
        input.tx = p.x;
        input.ty = p.y;
      }
    });
    const release = () => {
      input.hasTarget = false;
    };
    canvas.addEventListener("pointerup", release);
    canvas.addEventListener("pointercancel", release);
    window.addEventListener("keydown", (e) => input.keys.add(e.key.toLowerCase()));
    window.addEventListener("keyup", (e) => input.keys.delete(e.key.toLowerCase()));
    window.addEventListener("blur", () => input.keys.clear());
    const controller = {
      getMoveDir(s) {
        let dx = 0;
        let dy = 0;
        const k = input.keys;
        if (k.has("a") || k.has("arrowleft")) dx -= 1;
        if (k.has("d") || k.has("arrowright")) dx += 1;
        if (k.has("w") || k.has("arrowup")) dy += 1;
        if (k.has("s") || k.has("arrowdown")) dy -= 1;
        if (dx !== 0 || dy !== 0) return { x: dx, y: dy };
        if (input.hasTarget) {
          const ddx = input.tx - s.hero.x;
          const ddy = input.ty - s.hero.y;
          const d = Math.hypot(ddx, ddy);
          if (d < 14) {
            input.hasTarget = false;
            return { x: 0, y: 0 };
          }
          return { x: ddx / d, y: ddy / d };
        }
        return { x: 0, y: 0 };
      }
    };
    const session = new GameSession({
      level,
      weaponConfigs: [weaponsFile.weapons[0]],
      monsterConfigs: new Map(monstersFile.monsters.map((m) => [m.id, m])),
      cardConfigs: cardsFile.cards,
      seed: Date.now() % 1e5 | 0,
      controller,
      cardPolicy: greedyDpsPolicy
    });
    session.externalLevelUps = true;
    let bannerTimer = 0;
    let prevRenderMs = 0;
    session.bus.on("onWaveStart", ({ banner: b }) => {
      banner.textContent = b;
      banner.classList.add("show");
      bannerTimer = 2.2;
    });
    session.bus.on("onWallHit", () => canvas.classList.add("shake"));
    const floats = [];
    const pushFloat = (x, y, text, color, size) => {
      if (floats.length >= 40) floats.shift();
      floats.push({ x, y, text, color, size, life: 0.8, maxLife: 0.8 });
    };
    session.bus.on("onHit", ({ dmg, isCrit, x, y }) => {
      pushFloat(
        x + (Math.random() - 0.5) * 24,
        y + 20,
        String(Math.round(dmg)),
        isCrit ? "#FFD54F" : "#F5F5FA",
        isCrit ? 30 : 19
      );
    });
    session.bus.on("onWallHit", ({ dmg, x, y }) => {
      pushFloat(x, y, `-${Math.round(dmg)}`, "#FF6B57", 17);
    });
    const bolts = [];
    session.bus.on("onChain", ({ points }) => {
      if (bolts.length > 12) bolts.shift();
      bolts.push({ pts: points, life: 0.22 });
    });
    session.bus.on("onGameOver", ({ result }) => {
      const stars = result === "victory" ? "\u2605".repeat(session.wallHp / session.wallMaxHp > 0.7 ? 3 : session.wallHp / session.wallMaxHp > 0.4 ? 2 : 1) : "\u2606";
      gameOver.innerHTML = `<div class="big">${result === "victory" ? "\u5B88 \u57CE \u6210 \u529F" : "\u57CE \u5899 \u9677 \u843D"}</div><div class="stars">${stars}</div><div class="sub">\u51FB\u6740 ${session.totalKills} \xB7 \u7B49\u7EA7 ${session.hero.level} \xB7 \u7528\u65F6 ${session.timeSec.toFixed(0)}s</div><div><button onclick="location.reload()">\u518D\u6765\u4E00\u5C40</button><button class="ghost" onclick="location.href='./index.html'">\u8FD4\u56DE\u4E3B\u83DC\u5355</button></div>`;
      gameOver.classList.add("show");
    });
    let cardsShown = false;
    function refreshCards() {
      const pending = session.pendingLevelChoices;
      if (pending.length > 0 && !cardsShown) {
        cardsShown = true;
        cardOverlay.innerHTML = '<div class="title">\u5347 \u7EA7 \xB7 \u4E09 \u9009 \u4E00</div><div class="row"></div>';
        const row = cardOverlay.querySelector(".row");
        pending.forEach((c, i) => {
          const el = document.createElement("div");
          el.className = `card ${c.rarity} t-${c.type}`;
          const typeTag = { bullet: "\u5B50\u5F39", wall: "\u57CE\u5899", form: "\u5F62\u6001", passive: "\u5C5E\u6027", element: "\u5143\u7D20" }[c.type];
          const weaponNames = new Map(weaponsFile.weapons.map((w) => [w.id, w.name]));
          const elementNames = {
            fire: "\u706B\u7130",
            frost: "\u5BD2\u51B0",
            lightning: "\u95EA\u7535",
            poison: "\u6BD2\u7D20",
            physical: "\u7269\u7406"
          };
          const targetTag = !c.target || c.target.kind === "any" ? "\u516C\u5171" : c.target.kind === "weapon" ? weaponNames.get(c.target.weaponType) ?? c.target.weaponType : `${elementNames[c.target.element] ?? c.target.element}\xB7\u5143\u7D20`;
          el.innerHTML = `<div class="key">${i + 1}</div><div class="tag">${typeTag}\uFF5C${targetTag}</div><div class="cname">${c.name}</div><div class="ceff">${c.desc ?? ""}</div>`;
          el.onclick = () => pick(c);
          row.appendChild(el);
        });
        cardOverlay.classList.add("show");
        cardOverlay._choices = pending;
      } else if (pending.length === 0 && cardsShown) {
        cardsShown = false;
        cardOverlay.classList.remove("show");
      }
    }
    function pick(c) {
      session.resolveLevelUp(c);
      refreshCards();
    }
    window.addEventListener("keydown", (e) => {
      const n = Number(e.key);
      if (n >= 1 && n <= 3) {
        const choices = cardOverlay._choices;
        if (choices?.[n - 1]) pick(choices[n - 1]);
      }
    });
    function drawRoundRect(x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }
    function render(timeMs) {
      ctx.setTransform(1, 0, 0, -1, 0, H);
      ctx.fillStyle = palette.background.nightDeep;
      ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = palette.background.gridLine;
      ctx.lineWidth = 1;
      for (let x = 0; x <= W; x += 90) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, H);
        ctx.stroke();
      }
      for (let y = 0; y <= H; y += 90) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(W, y);
        ctx.stroke();
      }
      const wallTop = level.wall.height;
      const segs = 12;
      const segW = W / segs;
      const wallRatio = session.wallHp / session.wallMaxHp;
      for (let i = 0; i < segs; i++) {
        ctx.fillStyle = wallRatio < 0.3 ? palette.friendly.wallDamaged : palette.friendly.wall;
        drawRoundRect(i * segW + 3, 6, segW - 6, wallTop - 12, 8);
        ctx.fill();
      }
      if (wallRatio < 0.3) {
        ctx.fillStyle = "rgba(255,61,113,0.12)";
        ctx.fillRect(0, 0, W, wallTop);
      }
      const t = timeMs / 1e3;
      const now = session.timeSec;
      for (const m of session.monsters) {
        const r = m.cfg.radius;
        drawMonster(ctx, m, t);
        if (m.hp < m.maxHp) {
          ctx.fillStyle = "rgba(255,255,255,0.25)";
          ctx.fillRect(m.x - r, m.y - r - 10, r * 2, 4);
          ctx.fillStyle = "#FF3D71";
          ctx.fillRect(m.x - r, m.y - r - 10, r * 2 * m.hp / m.maxHp, 4);
        }
        if (now < m.slowUntil) {
          ctx.strokeStyle = "rgba(79,195,247,0.9)";
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(m.x, m.y, r + 4, 0, Math.PI * 2);
          ctx.stroke();
        }
        if (m.burn && m.burn.until > now) {
          const fl = 9 + Math.sin(t * 14 + m.phase) * 3;
          ctx.fillStyle = "#FF5A3C";
          ctx.beginPath();
          ctx.moveTo(m.x, m.y + r + 4 + fl);
          ctx.quadraticCurveTo(m.x - 8, m.y + r + 5, m.x, m.y + r);
          ctx.quadraticCurveTo(m.x + 8, m.y + r + 5, m.x, m.y + r + 4 + fl);
          ctx.fill();
          ctx.fillStyle = "#FFD54F";
          ctx.beginPath();
          ctx.arc(m.x, m.y + r + 5, 2.6, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      for (const pool of session.pools) {
        const left = Math.max(0, pool.until - session.timeSec);
        const alpha = Math.min(0.35, left * 0.5);
        ctx.fillStyle = `rgba(255,90,60,${alpha})`;
        ctx.beginPath();
        ctx.arc(pool.x, pool.y, pool.radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = `rgba(255,90,60,${Math.min(1, alpha * 2)})`;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      const h = session.hero;
      const breathe = Math.sin(t * 2.2) * 3;
      ctx.save();
      ctx.translate(h.x, h.y + breathe);
      ctx.fillStyle = palette.friendly.hero;
      ctx.beginPath();
      ctx.moveTo(0, 26);
      ctx.lineTo(-20, -16);
      ctx.lineTo(20, -16);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.arc(0, -2, 7, 0, Math.PI * 2);
      ctx.fillStyle = "#0B0C1D";
      ctx.fill();
      ctx.restore();
      const projColor = (t2) => palette.damageType[t2] ?? "#BFFFF2";
      for (const p of session.projectiles) {
        drawProjectile(ctx, p, t, projColor(p.damageType));
      }
      for (const s of session.monsterShots) {
        drawMonsterShot(ctx, s);
      }
      const dtR = Math.min(0.05, (timeMs - prevRenderMs) / 1e3 || 0.016);
      prevRenderMs = timeMs;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.textAlign = "center";
      for (let i = floats.length - 1; i >= 0; i--) {
        const f = floats[i];
        f.life -= dtR;
        if (f.life <= 0) {
          floats.splice(i, 1);
          continue;
        }
        const k = f.life / f.maxLife;
        ctx.globalAlpha = Math.min(1, k * 2);
        ctx.font = `700 ${f.size}px "PingFang SC", "Microsoft YaHei", sans-serif`;
        ctx.fillStyle = f.color;
        ctx.fillText(f.text, f.x, H - (f.y + (1 - k) * 56));
      }
      ctx.globalAlpha = 1;
      ctx.restore();
      for (let i = bolts.length - 1; i >= 0; i--) {
        const b = bolts[i];
        b.life -= dtR;
        if (b.life <= 0) {
          bolts.splice(i, 1);
          continue;
        }
        const alpha = Math.min(1, b.life / 0.14);
        ctx.strokeStyle = `rgba(179,136,255,${alpha})`;
        ctx.lineWidth = 5;
        ctx.beginPath();
        strokeBoltPath(ctx, b.pts);
        ctx.stroke();
        ctx.strokeStyle = `rgba(245,245,250,${alpha})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        strokeBoltPath(ctx, b.pts);
        ctx.stroke();
      }
      hudWall.style.width = `${session.wallHp / session.wallMaxHp * 100}%`;
      hudWallText.textContent = `\u57CE\u9632 ${Math.ceil(session.wallHp)} / ${session.wallMaxHp}`;
      const need = xpNeed(h.level);
      hudXp.style.width = `${Math.min(100, h.xp / need * 100)}%`;
      hudText.textContent = `\u7B2C ${Math.min(session.waveStats.length + 1, level.waves.length)}/${level.waves.length} \u6CE2 \xB7 Lv.${h.level} \xB7 \u51FB\u6740 ${session.totalKills} \xB7 ${session.timeSec.toFixed(0)}s`;
      if (bannerTimer > 0) {
        bannerTimer -= 1 / 60;
        if (bannerTimer <= 0) banner.classList.remove("show");
      }
      if (canvas.classList.contains("shake")) {
        setTimeout(() => canvas.classList.remove("shake"), 120);
      }
    }
    let last = performance.now();
    let acc = 0;
    function frame(now) {
      acc += Math.min((now - last) / 1e3, 0.25);
      last = now;
      const paused = session.pendingLevelChoices.length > 0 || session.result !== null;
      while (acc >= TICK_DT && !paused) {
        session.step();
        acc -= TICK_DT;
      }
      if (paused) acc = 0;
      refreshCards();
      render(now);
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }
  boot().catch((e) => {
    document.body.innerHTML = `<pre style="color:#FF6B57;padding:2em">\u542F\u52A8\u5931\u8D25\uFF1A${e.message}
\u8BF7\u786E\u8BA4\u4ECE\u9879\u76EE\u6839\u76EE\u5F55\u542F\u52A8\u9759\u6001\u670D\u52A1\u5668\uFF08\u89C1 README\uFF09\u3002</pre>`;
  });
})();
