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
    const defTerm = target.def + 100 + 8 * target.level;
    const reduction = target.def / defTerm;
    const rawFinal = raw * (1 - reduction);
    const amount = Math.max(1, Math.round(rawFinal));
    return {
      amount,
      isCrit,
      damageType: ctx.damageType,
      mitigated: Math.max(0, Math.round(raw) - amount)
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
        return new StraightTrajectory(d.x, d.y, cfg.speed, cfg.life);
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
    constructor(dirX, dirY, speed, lifeSec) {
      this.speed = speed;
      this.lifeSec = lifeSec;
      this.traveled = 0;
      this.dir = norm(dirX, dirY);
    }
    update(x, y, ctx) {
      const step = this.speed * ctx.dt;
      this.traveled += step;
      if (this.traveled >= this.speed * this.lifeSec || this.dir.x === 0 && this.dir.y === 0) {
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
  var RANGED_HOLD_DISTANCE = 260;
  var DASH_PERIOD = 2.2;
  function updateMonster(m, dt, now, wallTopY, onWallHit, onRangedShot, isCreeped, maxHoldY) {
    const r = m.cfg.radius;
    if (m.burrowed) {
      m.burrowTimer -= dt;
      if (m.cfg.burrowRegen && m.burrowTimer <= 0) {
        m.burrowed = false;
        m.hp = Math.min(m.maxHp, m.hp + Math.round(m.maxHp * m.cfg.burrowRegen.heal));
      } else if (m.cfg.burrowCharge && m.burrowTimer <= 0) {
        m.burrowed = false;
        m.y = wallTopY + r;
        onWallHit(m.cfg.burrowCharge.dmg, m);
      }
      if (m.cfg.burrowSiege) {
        m.attackTimer -= dt;
        if (m.attackTimer <= 0) {
          m.attackTimer += m.cfg.attackInterval;
          onWallHit(m.cfg.atk, m);
        }
        if (m.burrowed) {
          m.burrowTimer -= dt;
          if (m.burrowTimer <= 0) {
            m.burrowed = false;
            m.burrowTimer = m.cfg.burrowSiege.surfaceSec ?? 2.2;
          }
        }
      }
      return;
    }
    let holdY = wallTopY + (m.cfg.behavior === "ranged" ? m.cfg.rangedDist ?? RANGED_HOLD_DISTANCE : 0) + r;
    if (m.cfg.behavior === "ranged" && maxHoldY !== void 0) holdY = Math.min(holdY, maxHoldY);
    if (m.state === "march") {
      let speed = m.cfg.speed;
      if (now < m.slowUntil) speed *= m.slowFactor;
      if (m.cfg.creepBenefit && isCreeped && isCreeped(m.x, m.y)) speed *= 1.25;
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
      if (m.cfg.burrowSiege && m.y <= wallTopY + m.cfg.burrowSiege.dist + r) {
        m.y = wallTopY + m.cfg.burrowSiege.dist + r;
        m.state = "assault";
        m.sieged = true;
        m.burrowed = true;
        m.burrowTimer = m.cfg.burrowSiege.buriedSec ?? 2.5;
        m.attackTimer = m.cfg.attackInterval;
        return;
      }
      if (m.cfg.burrowRegen && m.hp < m.maxHp * m.cfg.burrowRegen.threshold) {
        m.burrowed = true;
        m.burrowTimer = m.cfg.burrowRegen.duration;
        return;
      }
      if (m.cfg.burrowCharge) {
        m.attackTimer -= dt;
        if (m.attackTimer <= 0 && m.y > wallTopY + 400) {
          m.burrowed = true;
          m.burrowTimer = m.cfg.burrowCharge.duration;
          m.attackTimer = m.cfg.burrowCharge.interval;
          return;
        }
        if (m.attackTimer <= 0) m.attackTimer = m.cfg.burrowCharge.interval;
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
      if (m.cfg.burrowSiege && m.sieged && m.burrowTimer > 0) {
        m.burrowTimer -= dt;
        if (m.burrowTimer <= 0) {
          m.burrowed = true;
          m.burrowTimer = m.cfg.burrowSiege.buriedSec ?? 2.5;
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

  // src/gamecore/hive.ts
  var CELL = 90;
  function cellKey(cx, cy) {
    return cx * 4096 + cy;
  }
  var HiveSystem = class {
    constructor(cfg) {
      this.tumors = [];
      this.bunkers = [];
      /** 菌毯网格活性：cellKey → a(0~100) */
      this.activity = /* @__PURE__ */ new Map();
      /** 开局预孵批次（"虫多繁殖快"：第一窝直接上路） */
      this.pendingBurst = 0;
      /** 精英潮倒计时额度：>0 时孵化偏向高级单位 */
      this.pendingElite = 0;
      /** 已触发孵化潮次数（编排出精英潮/Boss 潮） */
      this.waveCount = 0;
      /** 对局累计时间（护甲剥离与经济递增用） */
      this.hiveArmorElapsed = 0;
      /** 孵化潮倒计时（波次感的替代物） */
      this.hiveWaveLeft = 45;
      this.nextId = 1;
      /** 强制孵一只指定单位（Boss 潮用：无视虫核成本，保证 Boss 一定登场） */
      this.lastDeps = null;
      this.cfg = cfg;
      this.A = {
        risePerSec: 3,
        fallPerSec: 8,
        thresholdLow: 3,
        thresholdHigh: 8,
        baseCap: 100,
        ...cfg.activity ?? {}
      };
      this.T = {
        hp: 80,
        maxCount: 14,
        spreadIntervalSec: 5.5,
        dormantSec: 6,
        reviveCost: 20,
        ...cfg.tumor ?? {}
      };
      this.M = {
        intervalSec: 50,
        durationSec: 1.5,
        armorBonusWhileMoving: 15,
        ...cfg.migrate ?? {}
      };
      this.E = {
        hiveIncomePerSec: 34,
        tumorIncomeScale: 3.5,
        startBiomass: 80,
        unitCost: { zerg_ling: 1, zerg_roach: 5, zerg_lurker: 12, zerg_queen: 30, baneling: 8, zerg_ultra: 60 },
        ...cfg.economy ?? {}
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
        dead: false
      };
      this.paintAround(cfg.hivePos.x, cfg.hivePos.y, 2);
      this.spawnTumor(cfg.hivePos.x, cfg.hivePos.y - 260);
      this.spawnTumor(cfg.hivePos.x - 170, cfg.hivePos.y - 520);
      this.bunkers = (cfg.bunkers ?? []).map((b) => ({ x: b.x, y: b.y, r: b.r, hp: b.hp, maxHp: b.hp }));
      this.pendingBurst = 3;
    }
    // ---------------- 菌毯网格 ----------------
    keyAt(x, y) {
      return cellKey(Math.floor(x / CELL), Math.floor(y / CELL));
    }
    cx(k) {
      return Math.floor(k / 4096);
    }
    cy(k) {
      return k % 4096;
    }
    cellCenterX(k) {
      return this.cx(k) * CELL + CELL / 2;
    }
    cellCenterY(k) {
      return this.cy(k) * CELL + CELL / 2;
    }
    hasCreep(x, y) {
      return this.activity.get(this.keyAt(x, y)) !== void 0;
    }
    /** 在 (x,y) 半径格数内刷菌毯（避开地堡覆盖）。 */
    paintAround(x, y, cells) {
      const cx0 = Math.floor(x / CELL);
      const cy0 = Math.floor(y / CELL);
      for (let dx = -cells; dx <= cells; dx++) {
        for (let dy = -cells; dy <= cells; dy++) {
          if (dx * dx + dy * dy > cells * cells) continue;
          const px = (cx0 + dx) * CELL + CELL / 2;
          const py = (cy0 + dy) * CELL + CELL / 2;
          if (px < 0 || px > this.cfg.hiveMoveRange[1] + 200 || py < 0) continue;
          if (this.inBunker(px, py)) continue;
          const k = cellKey(cx0 + dx, cy0 + dy);
          if (this.activity.get(k) === void 0) this.activity.set(k, 50);
        }
      }
    }
    inBunker(x, y) {
      for (const b of this.bunkers) {
        if (b.hp <= 0) continue;
        const dx = x - b.x;
        const dy = y - b.y;
        if (Math.abs(dx) <= b.r && Math.abs(dy) <= b.r) return true;
      }
      return false;
    }
    /** 某个瘤是否已休眠（休眠瘤不产收入、不孵兵）。 */
    activeTumors() {
      return this.tumors.filter((t) => !t.dormant);
    }
    // ---------------- 瘤 ----------------
    spawnTumor(x, y) {
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
        spreadLeft: this.T.spreadIntervalSec
      });
    }
    /** 供战斗层调用：对瘤造成（AOE/穿透的顺带）伤害；不秒，掉空→休眠。 */
    damageTumor(t, dmg) {
      if (t.dormant) return;
      t.hp -= dmg;
      if (t.hp <= 0) {
        t.hp = 0;
        t.dormant = true;
        t.dormantLeft = this.T.dormantSec;
      }
    }
    /** 玩家火力/AOE 波及某点：对附近的瘤施加顺带伤害（用于穿透/溅射/AOE 弹）。 */
    applySplashToTumors(x, y, radius, dmg) {
      for (const t of this.tumors) {
        if (t.dormant) continue;
        const dx = t.x - x;
        const dy = t.y - y;
        if (dx * dx + dy * dy <= (radius + 30) * (radius + 30)) this.damageTumor(t, dmg);
      }
    }
    // ---------------- 主更新 ----------------
    update(dt, deps) {
      if (this.hive.dead) return;
      const now = deps.now;
      this.lastDeps = deps;
      this.updateActivity(dt, deps.monsters);
      this.updateTumors(dt);
      this.updateEconomy(dt, deps);
      this.updateArmor(dt);
      this.updateMigration(dt);
      this.updateHatch(dt, deps);
      if (this.hive.hp <= 0 && this.hive.armor <= 0) {
        this.hive.dead = true;
        deps.onEvent?.("hiveDead");
      }
    }
    /** 区域虫群密度统计：每格虫数；据此涨落活性。 */
    updateActivity(dt, monsters) {
      const count = /* @__PURE__ */ new Map();
      for (const m of monsters) {
        if (m.hp <= 0) continue;
        const k = this.keyAt(m.x, m.y);
        count.set(k, (count.get(k) ?? 0) + 1);
      }
      const { risePerSec, fallPerSec, thresholdLow, thresholdHigh, baseCap } = this.A;
      for (const k of this.activity.keys()) {
        const n = count.get(k) ?? 0;
        let a = this.activity.get(k);
        if (n > thresholdHigh) a += risePerSec * dt;
        else if (n <= thresholdLow) a -= fallPerSec * dt;
        const px = this.cellCenterX(k);
        const py = this.cellCenterY(k);
        if (this.nearTumor(px, py)) a += 2 * dt;
        if (Math.hypot(px - this.hive.x, py - this.hive.y) < 260) a += 4 * dt;
        a = Math.max(0, Math.min(baseCap, a));
        this.activity.set(k, a);
      }
    }
    nearTumor(x, y) {
      for (const t of this.tumors) {
        if (t.dormant) continue;
        if (Math.abs(t.x - x) <= CELL * 1.2 && Math.abs(t.y - y) <= CELL * 1.2) return true;
      }
      return false;
    }
    updateTumors(dt) {
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
          this.paintAround(t.x, t.y - CELL, 1);
          if (alive < this.T.maxCount && this.rngLike() < 0.92) {
            this.spawnTumor(t.x, t.y - CELL * 1.5);
          }
        }
      }
    }
    rngLike() {
      this.nextId = this.nextId * 1103515245 + 12345 & 2147483647;
      return this.nextId % 1e3 / 1e3;
    }
    /** 全局平均活性（仅统计有菌毯的格） */
    avgActivity() {
      if (this.activity.size === 0) return 0;
      let sum = 0;
      for (const a of this.activity.values()) sum += a;
      return sum / this.activity.size;
    }
    updateEconomy(dt, deps0) {
      const tumorCount = this.activeTumors().length;
      let income = this.E.hiveIncomePerSec + tumorCount * (this.avgActivity() / 100) * this.E.tumorIncomeScale;
      if (this.hive.armor <= 0) income *= 1.4;
      const now = this.hiveArmorElapsed;
      income *= Math.min(1, 0.06 + now / 100);
      income *= Math.min(2.5, 1 + now / 240);
      this.hive.biomass += income * dt;
      this.hive.biomassEarned += income * dt;
      this.hiveWaveLeft -= dt;
      if (this.hiveWaveLeft <= 0) {
        this.hiveWaveLeft += 20;
        const elapsed = this.hiveArmorElapsed;
        if (elapsed < 60) {
          this.hiveWaveLeft = Math.max(1, 60 - elapsed);
          return;
        }
        this.waveCount++;
        const growth = Math.min(75, (elapsed - 60) * 0.5);
        const base = Math.round(55 + growth) + Math.floor(this.rngLike() * 16);
        const alive = deps0.monsters.length;
        const flood = Math.max(0, Math.min(base, 220 - alive));
        const pool = this.unlockedUnits();
        for (let i = 0; i < flood; i++) {
          const key = pool[Math.floor(this.rngLike() * pool.length) % pool.length];
          this.hatchOne(key, deps0);
        }
        if (this.waveCount % 4 === 0) {
          this.pendingElite += 8;
          this.forceHatchOne("zerg_ultra");
          deps0.onEvent?.("boss");
        } else if (this.waveCount % 2 === 0) {
          this.pendingElite += 6;
          deps0.onEvent?.("elite");
        } else {
          deps0.onEvent?.("wave");
        }
        this.waveCallback?.();
      }
    }
    updateArmor(dt) {
      this.hiveArmorElapsed += dt;
      if (this.hive.armor <= 0) return;
      this.hive.armorTickLeft -= dt;
      if (this.hive.armorTickLeft <= 0) {
        this.hive.armorTickLeft += 6;
        const avg = this.avgActivity();
        let drop = Math.max(0, (100 - avg) / 10);
        if (avg < 50) drop *= 1.8;
        this.hive.armor = Math.max(0, this.hive.armor - drop);
      }
    }
    updateMigration(dt) {
      if (this.hive.migrateLeft > 0) {
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
        const [minX, maxX] = this.cfg.hiveMoveRange;
        const span = maxX - minX;
        const drift = (this.rngLike() - 0.5) * span * 0.6;
        this.hive.targetX = Math.max(minX, Math.min(maxX, this.hive.x + drift));
        this.hive.migrateLeft = this.M.durationSec;
      }
    }
    updateHatch(dt, deps) {
      if (this.hive.migrateLeft > 0) return;
      this.hive.hatchLeft -= dt;
      if (this.hive.hatchLeft > 0) return;
      this.hive.hatchLeft += 0.6;
      const pool = this.unlockedUnits();
      if (pool.length === 0) return;
      const burst = this.pendingBurst > 0 ? Math.min(30, this.pendingBurst) : 4 + Math.floor(this.rngLike() * 5);
      let hatched = 0;
      for (let i = 0; i < burst; i++) {
        let key;
        if (this.pendingElite > 0) {
          const strong = pool.filter((k) => k !== "zerg_ling");
          key = strong.length > 0 ? strong[Math.floor(this.rngLike() * strong.length) % strong.length] : pool[Math.floor(this.rngLike() * pool.length) % pool.length];
          this.pendingElite--;
        } else {
          key = pool[Math.floor(this.rngLike() * pool.length) % pool.length];
        }
        const cost = this.E.unitCost[key] ?? 10;
        if (this.hive.biomass < cost) break;
        this.hive.biomass -= cost;
        this.hatchOne(key, deps);
        hatched++;
      }
      if (this.pendingBurst > 0 && hatched > 0) this.pendingBurst -= hatched;
    }
    forceHatchOne(key) {
      if (!this.lastDeps) return;
      this.hatchOne(key, this.lastDeps);
    }
    hatchOne(key, deps) {
      const act = this.activeTumors();
      const src = act.length > 0 ? act[Math.floor(this.rngLike() * act.length) % act.length] : null;
      let sx;
      let sy;
      if (src) {
        sx = src.x + (this.rngLike() - 0.5) * 140;
        sy = src.y + (this.rngLike() - 0.5) * 80 - 10;
      } else {
        sx = this.hive.x + (this.rngLike() - 0.5) * 160;
        sy = this.hive.y - 60;
      }
      sx = Math.max(30, Math.min(this.cfg.hiveMoveRange[1] + 180, sx));
      sy = Math.max(120, sy);
      if (!this.hasCreep(sx, sy)) this.paintAround(sx, sy, 1);
      deps.onHatch(key, sx, sy);
      deps.onEvent?.("hatch", { x: sx, y: sy });
    }
    frontTumor() {
      let best = null;
      for (const t of this.activeTumors()) {
        if (!best || t.y < best.y) best = t;
      }
      return best;
    }
    /** 已解锁单位（缺省：初始只有 zerg_ling，随累计虫核解锁） */
    unlockedUnits() {
      const list = ["zerg_ling"];
      const unlock = this.cfg.unlock ?? [
        { monster: "zerg_roach", needBiomass: 18 },
        { monster: "baneling", needBiomass: 40 },
        { monster: "zerg_lurker", needBiomass: 70 },
        { monster: "zerg_queen", needBiomass: 110 },
        { monster: "zerg_ultra", needBiomass: 180 }
      ];
      for (const u of unlock) {
        if (this.hive.biomassEarned >= u.needBiomass) list.push(u.monster);
      }
      return list;
    }
    // ---------------- 战斗接口 ----------------
    /** 玩家对虫巢造成伤害：护甲>0 时免伤（不能拆家）。返回实际伤害。 */
    damageHive(raw) {
      if (this.hive.dead) return 0;
      if (this.hive.armor > 0) return 0;
      const dealt = Math.min(this.hive.hp, raw);
      this.hive.hp -= dealt;
      return dealt;
    }
    /** 虫族摧毁玩家设施后：玩家核心护甲下降（对称）。由 session 记录。 */
    /** 地堡是否被摧毁（供 session 侦测）。 */
    bunkersAlive() {
      return this.bunkers.filter((b) => b.hp > 0).length;
    }
    /** 虫群攻击地堡（毒爆/雷兽靠近时调用）。 */
    damageBunker(x, y, dmg) {
      for (const b of this.bunkers) {
        if (b.hp <= 0) continue;
        if (Math.abs(b.x - x) <= b.r + 20 && Math.abs(b.y - y) <= b.r + 20) {
          b.hp = Math.max(0, b.hp - dmg);
          return;
        }
      }
    }
  };

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
  var GameSession = class _GameSession {
    constructor(opts) {
      this.bus = new EventBus();
      this.monsters = [];
      this.projectiles = [];
      this.monsterShots = [];
      // 怪物远程弹（可见弹道，落点结算对墙伤害）
      this.pools = [];
      this.segments = [];
      // 光束/连线伤害场（docs/07 §4）
      this.lasers = [];
      // 激光能量束（瞬时结算，仅渲染快照，见 doLaser）
      /** 虫苔地块（docs/08）：cellKey = cx*4096+cy（90px 网格）→ 消退时间 */
      this.creep = /* @__PURE__ */ new Map();
      /** 虫巢对抗模式（docs/13）：关卡带 level.hive 时启用；否则为 null（第一章/实验室走原逻辑）。 */
      this.hiveSystem = null;
      /** 玩家核心茧壳护甲（虫巢模式）；0 表示无护甲保护。 */
      this.playerCoreArmor = 0;
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
      this.targetableScratch = [];
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
      if (opts.level.hive) {
        this.hiveSystem = new HiveSystem(opts.level.hive);
        this.playerCoreArmor = opts.level.hive.playerCoreArmorMax;
      }
    }
    static {
      this.CREEP_CELL = 90;
    }
    static {
      this.CREEP_LIFE = 60;
    }
    /** 是否虫巢对抗模式 */
    get hiveMode() {
      return this.hiveSystem !== null;
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
      if (this.hiveSystem) {
        this.hiveSystem.update(dt, {
          arenaW: this.level.arena.width,
          arenaH: this.level.arena.height,
          monsters: this.monsters,
          now,
          onHatch: (key, x, y) => this.spawnMonster(key, x, y),
          onEvent: (evt, payload) => this.bus.emit("onHiveEvent", { evt, ...payload ?? {} })
        });
        for (const [key] of this.hiveSystem.activity) {
          this.creep.set(key, now + 60);
        }
      } else {
        const spawned = this.director.update(this, dt);
        for (const item of spawned) this.spawnMonster(item.monsterKey, item.spawnX);
      }
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
      this.targetableScratch.length = 0;
      for (const m of this.monsters) {
        if (!m.burrowed) this.targetableScratch.push(m);
      }
      updateWeapons(this.hero, this.targetableScratch, this.hash, this.rng, this.fireCommands);
      for (const cmd of this.fireCommands) {
        if (cmd.weapon.cfg.laser) {
          this.doLaser(cmd);
        } else if ((cmd.weapon.cfg.chainBase ?? 0) > 0 || cmd.weapon.affixes.chain > 0) {
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
          if (b.cmd.weapon.cfg.laser) this.doLaser(b.cmd);
          else if ((b.cmd.weapon.cfg.chainBase ?? 0) > 0 || b.cmd.weapon.affixes.chain > 0) this.doLightning(b.cmd);
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
        const { width, height } = this.level.arena;
        if (p.x < -60 || p.x > width + 60 || p.y < -60 || p.y > height + 60) {
          this.killProjectile(p);
          continue;
        }
        if (p.weapon.cfg.ghost) continue;
        this.collideProjectile(p);
      }
      this.hash.rebuild(this.monsters);
      for (const m of this.monsters) {
        if (m.hp <= 0) continue;
        if (m.burrowed) {
          updateMonster(m, dt, now, this.level.wall.height, (dmg, src) => {
            this.wallHp = Math.max(0, this.wallHp - dmg);
            this.totalWallDamage += dmg;
            this.waveWallDamage += dmg;
            this.bus.emit("onWallHit", { dmg, wallHp: this.wallHp, x: src.x, y: this.level.wall.height + 26 });
            this.bus.emit("onBurrowStrike", { x: src.x, y: this.level.wall.height });
          }, (src) => {
            this.spawnMonsterShot(src);
          }, (x, y) => this.isCreeped(x, y), this.maxSafeHoldY());
          continue;
        }
        this.tickBurns(m, dt);
        if (m.hp <= 0) continue;
        if (m.cfg.creepTrail && m.state === "march") {
          m.creepTimerLeft -= dt;
          if (m.creepTimerLeft <= 0) {
            m.creepTimerLeft += m.cfg.creepTrail.interval;
            this.dropCreep(m.x, m.y);
          }
        }
        if (m.cfg.creepBenefit && this.isCreeped(m.x, m.y)) {
          m.regenAcc += 2 * dt;
          while (m.regenAcc >= 1) {
            m.regenAcc -= 1;
            m.hp = Math.min(m.maxHp, m.hp + 1);
          }
        }
        if (this.formationMove(m, dt)) continue;
        updateMonster(m, dt, now, this.level.wall.height, (dmg, src) => {
          this.wallHp = Math.max(0, this.wallHp - dmg);
          this.totalWallDamage += dmg;
          this.waveWallDamage += dmg;
          this.bus.emit("onWallHit", { dmg, wallHp: this.wallHp, x: src.x, y: this.level.wall.height + 26 });
        }, (src) => {
          this.spawnMonsterShot(src);
        }, (x, y) => this.isCreeped(x, y), this.maxSafeHoldY());
      }
      for (const m of this.monsters) {
        if (m.cfg.detonate && m.state === "assault" && m.hp > 0) {
          const dmg = m.cfg.detonate.wallDamage;
          this.wallHp = Math.max(0, this.wallHp - dmg);
          this.totalWallDamage += dmg;
          this.waveWallDamage += dmg;
          this.bus.emit("onExplode", { x: m.x, y: m.y, radius: 70 });
          this.bus.emit("onWallHit", { dmg, wallHp: this.wallHp, x: m.x, y: this.level.wall.height + 26 });
          m.hp = 0;
          this.killMonster(null, m);
        }
      }
      for (const [key, until] of this.creep) {
        if (until <= now) this.creep.delete(key);
      }
      for (const m of this.monsters) {
        if (!m.cfg.splitTimer || m.hp <= 0) continue;
        m.splitTimerLeft -= dt;
        if (m.splitTimerLeft > 0) continue;
        m.splitTimerLeft += m.cfg.splitTimer.interval;
        this.spawnBaby(m, m.cfg.splitTimer.baby, 1);
      }
      for (const m of this.monsters) {
        if (m.hp <= 0) continue;
        if (m.cfg.formationDist && !m.formationActive && m.y <= this.level.wall.height + m.cfg.formationDist) {
          m.formationActive = true;
          const members = this.monsters.filter((x) => x.groupId === m.id && x.hp > 0);
          members.forEach((mem, i) => {
            mem.slotX = clamp(m.x + (i - (members.length - 1) / 2) * 58, 40, this.level.arena.width - 40);
          });
          this.bus.emit("onFormation", { x: m.x, y: m.y });
        }
      }
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
          if (!ally || ally === m || ally.hp <= 0 || ally.hp >= ally.maxHp) continue;
          const amount = Math.round(aura.amount);
          ally.hp = Math.min(ally.maxHp, ally.hp + amount);
          healed++;
          this.bus.emit("onHealed", { x: ally.x, y: ally.y + ally.cfg.radius + 8, amount });
        }
        if (healed > 0) this.bus.emit("onHeal", { x: m.x, y: m.y, radius: aura.radius });
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
        const arc = s.kind === "rock" ? Math.min(260, Math.max(120, Math.abs(s.sy - s.ty) * 0.32)) : 40;
        s.height = Math.sin(s.t * Math.PI) * arc;
      }
      for (let i = this.pools.length - 1; i >= 0; i--) {
        const pool = this.pools[i];
        if (now >= pool.until) {
          this.pools.splice(i, 1);
          continue;
        }
        if (pool.damageType === "fire") this.burnCreep(pool.x, pool.y, pool.radius);
        this.hash.queryCircle(pool.x, pool.y, pool.radius, this.scratch);
        for (const mid of this.scratch) {
          const m = this.monsters[mid];
          if (!m || m.hp <= 0) continue;
          if (m.burrowed) {
            if (pool.damageType !== "fire") continue;
            this.forceEmerge(m);
          }
          const rr = pool.radius + m.cfg.radius;
          const dx = m.x - pool.x;
          const dy = m.y - pool.y;
          if (dx * dx + dy * dy > rr * rr) continue;
          const dmg = Math.max(1, Math.round(pool.dps * dt));
          m.hp -= dmg;
          this.totalDamage += dmg;
          this.bus.emit("onPoolTick", { x: m.x, y: m.y + m.cfg.radius + 8, dmg });
          if (m.hp <= 0) this.killMonster(null, m);
        }
      }
      for (let i = this.lasers.length - 1; i >= 0; i--) {
        if (now >= this.lasers[i].until) this.lasers.splice(i, 1);
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
          const rr = seg.width / 2 + m.cfg.radius;
          if (distToSegment(m.x, m.y, seg.ax, seg.ay, seg.bx, seg.by) > rr) continue;
          if (m.burrowed) this.forceEmerge(m);
          const dmg = Math.max(1, Math.round(seg.dps * dt));
          m.hp -= dmg;
          this.totalDamage += dmg;
          if (m.hp <= 0) this.killMonster(null, m);
        }
      }
      while (this.hero.xp >= xpNeed(this.hero.level)) {
        this.hero.xp -= xpNeed(this.hero.level);
        this.hero.level++;
        this.hero.stats.atk *= 1.08;
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
        const idMap = /* @__PURE__ */ new Map();
        const survivors = [];
        for (const m of this.monsters) {
          if (m.hp > 0) {
            idMap.set(m.id, survivors.length);
            survivors.push(m);
          }
        }
        this.monsters = survivors;
        for (const m of this.monsters) {
          m.id = idMap.get(m.id);
          if (m.groupId >= 0) m.groupId = idMap.get(m.groupId) ?? -1;
        }
      }
      this.projectiles = this.projectiles.filter((p) => p.alive);
      this.maxMonsters = Math.max(this.maxMonsters, this.monsters.length);
      this.maxProjectiles = Math.max(this.maxProjectiles, this.projectiles.length);
      if (!this.sandboxMode) {
        if (this.hiveSystem) {
          if (this.hiveSystem.hive.dead) {
            this.result = "victory";
            this.bus.emit("onGameOver", { result: this.result });
          } else if (this.wallHp <= 0) {
            this.result = "defeat";
            this.bus.emit("onGameOver", { result: this.result });
          }
        } else if (this.wallHp <= 0) {
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
      const wallH = this.level.wall.height;
      const dist = Math.abs(src.y - wallH);
      const speed = isRock ? 460 : 620;
      const r = src.cfg.radius;
      const spread = isRock ? r * 2.6 : 24;
      this.monsterShots.push({
        // 起点：投石车固定从"臂端"出石（略朝城墙方向偏移），与抛臂甩下的方向一致
        sx: src.x + (isRock ? 0 : 0),
        sy: isRock ? src.y - r * 0.9 : src.y,
        tx: src.x + this.rng.range(-spread, spread),
        ty: wallH,
        x: src.x,
        y: isRock ? src.y - r * 0.9 : src.y,
        height: 0,
        t: 0,
        dur: Math.max(0.2, dist / speed),
        dmg: src.cfg.atk,
        kind: isRock ? "rock" : "spear"
      });
    }
    spawnMonster(key, spawnX, spawnY, skipEscort = false) {
      const cfg = this.monsterCfgs.get(key);
      if (!cfg) throw new Error(`\u672A\u77E5\u602A\u7269\u914D\u7F6E: ${key}`);
      const x = clamp(spawnX, 40, this.level.arena.width - 40);
      const y = spawnY ?? this.rng.range(this.level.spawnBandY[0], this.level.spawnBandY[1]);
      const scale = 1 + 0.07 * this.director.currentWave;
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
        shieldLeft: cfg.hitShield ?? 0,
        healTimer: cfg.healAura ? cfg.healAura.interval : 0,
        splitTimerLeft: cfg.splitTimer ? cfg.splitTimer.interval : 0,
        burrowed: false,
        burrowTimer: 0,
        sieged: false,
        creepTimerLeft: cfg.creepTrail ? cfg.creepTrail.interval : 0,
        regenAcc: 0,
        groupId: -1,
        formationActive: false,
        slotX: x,
        formIndex: 0,
        formAngle: 0,
        slowUntil: 0,
        slowFactor: 1,
        shredUntil: 0,
        shredAmount: 0
      });
      if (cfg.escort && !skipEscort) {
        const leaderId = this.monsters[this.monsters.length - 1].id;
        for (let i = 0; i < cfg.escort.count; i++) {
          const ang = Math.PI * 2 * i / cfg.escort.count + this.rng.range(-0.2, 0.2);
          const ex = clamp(x + Math.cos(ang) * cfg.escort.radius, 40, this.level.arena.width - 40);
          const ey = clamp(y + Math.sin(ang) * cfg.escort.radius, 200, this.level.arena.height - 60);
          this.spawnMonster(cfg.escort.monster, ex, ey);
          const member = this.monsters[this.monsters.length - 1];
          member.groupId = leaderId;
          member.formIndex = i;
          member.formAngle = Math.PI * 2 * i / cfg.escort.count;
        }
      }
    }
    spawnProjectile(cmd) {
      const { weapon, fromX, fromY, dirX, dirY, speed, range, dmg, index } = cmd;
      let fan = 0;
      if (index > 0) {
        const side = index % 2 === 1 ? -1 : 1;
        const step = Math.ceil(index / 2);
        fan = side * step * (weapon.cfg.spread ?? 0.1);
      }
      const rawLen = Math.hypot(dirX, dirY);
      const baseDirX = rawLen > 1e-6 ? dirX : 0;
      const baseDirY = rawLen > 1e-6 ? dirY : 1;
      const cos = Math.cos(fan);
      const sin = Math.sin(fan);
      const dx = baseDirX * cos - baseDirY * sin;
      const dy = baseDirX * sin + baseDirY * cos;
      const affixes = weapon.affixes;
      const riders = weapon.riders;
      const damageType = weapon.element;
      const homing = affixes.homing > 0 && !!cmd.target;
      let motionCfg = homing ? { type: "homing", speed, range, turnRate: 360, duration: 2.5, retarget: true } : weapon.cfg.motion ?? { type: "straight", speed, life: weapon.cfg.bulletLife ?? 2.5 };
      if (motionCfg.type === "parabola" && cmd.target) {
        const dist = Math.hypot(cmd.target.x - fromX, cmd.target.y - fromY);
        motionCfg = { ...motionCfg, range: Math.max(120, dist) };
      }
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
      if (this.hiveSystem && !this.hiveSystem.hive.dead && p.alive) {
        const h = this.hiveSystem.hive;
        const rr = p.radius + 46;
        if (distToSegment(h.x, h.y, p.px, p.py, p.x, p.y) <= rr) {
          const raw = p.dmg;
          const dealt = this.hiveSystem.damageHive(raw);
          if (dealt > 0) {
            this.totalDamage += dealt;
            this.bus.emit("onHiveHit", { dmg: dealt, armor: h.armor, armorMax: h.armorMax, x: h.x, y: h.y });
          } else {
            this.bus.emit("onHiveHit", { dmg: 0, armor: h.armor, armorMax: h.armorMax, x: h.x, y: h.y });
          }
          if (p.pierceLeft > 0) {
            p.pierceLeft--;
            p.pierceCount++;
          } else {
            this.killProjectile(p);
          }
          if (!p.alive) return;
        }
      }
      const reach = p.radius + 34 + p.stepLen;
      this.hash.queryCircle(p.x, p.y, reach, this.scratch);
      for (const mid of this.scratch) {
        if (!p.alive) break;
        const m = this.monsters[mid];
        if (!m || m.hp <= 0 || m.burrowed) continue;
        if (p.hitIds.has(m.id) && now - (p.hitIds.get(m.id) ?? 0) < 0.5) continue;
        const rr = p.radius + m.cfg.radius;
        if (distToSegment(m.x, m.y, p.px, p.py, p.x, p.y) > rr) continue;
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
        const dealt0 = this.applyDirectHit(m, res.amount);
        const dealt = this.resolveTransfer(m, dealt0);
        m.hp -= dealt;
        this.totalDamage += dealt;
        if (res.isCrit && dealt > 0) this.totalCrits++;
        this.bus.emit("onHit", {
          monsterId: m.id,
          dmg: dealt,
          isCrit: res.isCrit,
          blocked: dealt === 0,
          mitigated: dealt === 0 ? 0 : res.mitigated,
          x: m.x,
          y: m.y,
          damageType: p.damageType
        });
        if (p.damageType === "fire") this.burnCreep(m.x, m.y, 60);
        if (p.damageType === "fire" && p.riders.burnDpsMul > 0 && !m.cfg.burnImmune) {
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
     * 激光（docs/07 §4 特殊形态）：直线能量束，瞬时结算。
     *
     * 语义（策划口径）：
     *  - 直射：从英雄炮口沿瞄准方向射出；
     *  - 束内所有怪物都受伤害（一条线穿过去，不是单体）；
     *  - 能量守恒衰减：起始能量 = 本次单发伤害（cmd.dmg）。按离英雄由近到远依次结算，
     *    每只怪吸收「当前能量 × transfer」作为本次伤害；实际造成的伤害从能量池扣除，
     *    能量归零即停止 —— 所以"越近的怪吃到的能量（伤害）越大"，且后面的怪会被前面的挡弱。
     *  - 装甲/免伤盾会减少实际扣血，从而少消耗能量（肉盾"扛住"了光束，激光能继续往后穿）。
     */
    doLaser(cmd) {
      const lz = cmd.weapon.cfg.laser;
      const now = this.timeSec;
      const transfer = Math.max(0.05, Math.min(1, lz.transfer ?? 0.85));
      const width = lz.width ?? 16;
      const length = (lz.length ?? 1400) * cmd.weapon.mods.rangeMul;
      const maxHits = 16;
      let dx = cmd.dirX;
      let dy = cmd.dirY;
      const dl = Math.hypot(dx, dy);
      if (dl < 1e-6) {
        dx = 0;
        dy = 1;
      } else {
        dx /= dl;
        dy /= dl;
      }
      if (cmd.index > 0) {
        const side = cmd.index % 2 === 1 ? -1 : 1;
        const step = Math.ceil(cmd.index / 2);
        const fan = side * step * (cmd.weapon.cfg.spread ?? 0.12);
        const cos = Math.cos(fan);
        const sin = Math.sin(fan);
        const ndx = dx * cos - dy * sin;
        const ndy = dx * sin + dy * cos;
        dx = ndx;
        dy = ndy;
      }
      const ax = cmd.fromX;
      const ay = cmd.fromY;
      const half = width / 2;
      const cands = [];
      this.hash.rebuild(this.monsters);
      for (const m of this.monsters) {
        if (m.hp <= 0) continue;
        const rx = m.x - ax;
        const ry = m.y - ay;
        const t = rx * dx + ry * dy;
        if (t < -m.cfg.radius || t > length + m.cfg.radius) continue;
        const perp = Math.abs(rx * -dy + ry * dx);
        if (perp > half + m.cfg.radius) continue;
        cands.push({ m, t: Math.max(0, t) });
      }
      cands.sort((a, b) => a.t - b.t);
      const hits = [];
      let energy = Math.max(1, cmd.dmg);
      const energyStart = energy;
      for (const { m, t } of cands) {
        if (energy <= 0.5 || hits.length >= maxHits) break;
        if (m.burrowed) {
          this.forceEmerge(m);
          continue;
        }
        const current = energy;
        const want = Math.max(1, current * transfer);
        const def = Math.max(0, m.cfg.def - (now < m.shredUntil ? m.shredAmount : 0));
        const res = calcDamage(
          heroAttackerSnapshot(this.hero),
          { def, level: this.director.currentWave + 1 },
          {
            skillMul: want / BASE_ATK,
            damageType: cmd.weapon.element,
            typeMul: m.cfg.weak?.includes(cmd.weapon.element) ? 1.25 : m.cfg.resist?.includes(cmd.weapon.element) ? 0.75 : 1
          },
          this.rng
        );
        const dealt0 = this.applyDirectHit(m, res.amount);
        const dealt = this.resolveTransfer(m, dealt0);
        m.hp -= dealt;
        this.totalDamage += dealt;
        if (res.isCrit && dealt > 0) this.totalCrits++;
        this.bus.emit("onHit", {
          monsterId: m.id,
          dmg: dealt,
          isCrit: res.isCrit,
          blocked: dealt === 0,
          mitigated: dealt === 0 ? 0 : res.mitigated,
          x: m.x,
          y: m.y,
          damageType: cmd.weapon.element
        });
        if (cmd.weapon.element === "fire") this.burnCreep(m.x, m.y, 60);
        if (cmd.weapon.element === "fire" && cmd.weapon.riders.burnDpsMul > 0 && !m.cfg.burnImmune) {
          const dps = want * cmd.weapon.riders.burnDpsMul;
          if (m.burn && m.burn.dps >= dps) m.burn.until = now + cmd.weapon.riders.burnSec;
          else m.burn = { dps, until: now + cmd.weapon.riders.burnSec, nextTick: now + 0.5 };
        }
        if (cmd.weapon.element === "frost" && cmd.weapon.riders.slowPct > 0) {
          m.slowFactor = Math.max(0.35, 1 - cmd.weapon.riders.slowPct);
          m.slowUntil = now + cmd.weapon.riders.slowSec;
        }
        if (cmd.weapon.affixes.shred > 0) {
          m.shredAmount = 3 * cmd.weapon.affixes.shred;
          m.shredUntil = now + 4;
        }
        hits.push({ x: m.x, y: m.y, dmg: dealt, energy: current });
        energy -= Math.max(dealt0, 0);
        if (m.hp <= 0) this.killMonster(null, m);
      }
      const lastHit = hits.length > 0 ? hits[hits.length - 1] : null;
      const bx = lastHit ? lastHit.x : ax + dx * length;
      const by = lastHit ? lastHit.y : ay + dy * length;
      this.lasers.push({
        ax,
        ay,
        bx,
        by,
        width,
        energy: energyStart,
        hits,
        until: now + (lz.life ?? 0.18),
        damageType: cmd.weapon.element
      });
      this.bus.emit("onLaser", { hits: hits.length, energy: Math.max(0, energy) });
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
        const dealt0 = this.applyDirectHit(cur, res.amount);
        const dealt = this.resolveTransfer(cur, dealt0);
        cur.hp -= dealt;
        this.totalDamage += dealt;
        if (res.isCrit && dealt > 0) this.totalCrits++;
        this.bus.emit("onHit", { monsterId: cur.id, dmg: dealt, isCrit: res.isCrit, blocked: dealt === 0, mitigated: dealt === 0 ? 0 : res.mitigated, x: cur.x, y: cur.y, damageType: "lightning" });
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
    // ---------- 虫苔（docs/08） ----------
    /**
     * 远程怪停驻点的安全上限：保证任何怪物都不会停在我方所有武器都够不到的"死角"里。
     * 取所有武器「索敌距离」与「实际飞行/作用距离」的较小者的最小值；英雄最远可站到 defenseRect.yMax，
     * 故 maxHoldY = yMax + minReach - 余量。
     */
    maxSafeHoldY() {
      const margin = 40;
      const yMax = this.level.defenseRect.yMax;
      let minReach = Infinity;
      for (const w of this.hero.weapons) {
        const target = w.cfg.projectileRange * w.mods.rangeMul;
        const rMul = w.mods.rangeMul;
        let flight = target;
        if (w.cfg.laser) {
          flight = (w.cfg.laser.length ?? 1400) * rMul;
        } else if (w.cfg.motion?.type === "phased") {
          const first = w.cfg.motion.phases.find((ph) => ph.until.kind === "distance");
          flight = first && first.until.kind === "distance" ? first.until.value * rMul : target;
        } else if (w.cfg.motion?.type === "parabola") {
          flight = w.cfg.motion.range * rMul;
        } else {
          flight = w.cfg.projectileSpeed * w.mods.projSpeedMul * (w.cfg.bulletLife ?? 2.5);
        }
        minReach = Math.min(minReach, target, flight);
      }
      if (!Number.isFinite(minReach)) minReach = 600;
      return yMax + Math.max(120, minReach - margin);
    }
    creepKey(x, y) {
      const c = _GameSession.CREEP_CELL;
      return Math.floor(x / c) * 4096 + Math.floor(y / c);
    }
    isCreeped(x, y) {
      const until = this.creep.get(this.creepKey(x, y));
      return until !== void 0 && until > this.timeSec;
    }
    dropCreep(x, y) {
      this.creep.set(this.creepKey(x, y), this.timeSec + _GameSession.CREEP_LIFE);
    }
    /** 火焰清除虫苔：清除以 (x,y) 半径 r 内所有虫苔格。 */
    burnCreep(x, y, r) {
      const c = _GameSession.CREEP_CELL;
      const minCx = Math.floor((x - r) / c);
      const maxCx = Math.floor((x + r) / c);
      const minCy = Math.floor((y - r) / c);
      const maxCy = Math.floor((y + r) / c);
      for (let cx = minCx; cx <= maxCx; cx++) {
        for (let cy = minCy; cy <= maxCy; cy++) {
          this.creep.delete(cx * 4096 + cy);
        }
      }
    }
    /** 强制出土：钻地怪被爆炸/火焰波及立即出土。 */
    forceEmerge(m) {
      if (m.burrowed) {
        m.burrowed = false;
        m.burrowTimer = 0;
      }
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
        if (m.burrowed) this.forceEmerge(m);
        const rr = radius + m.cfg.radius;
        const dx = m.x - p.x;
        const dy = m.y - p.y;
        if (dx * dx + dy * dy > rr * rr) continue;
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
        const dealt0 = this.applyDirectHit(m, res.amount);
        const dealt = this.resolveTransfer(m, dealt0);
        m.hp -= dealt;
        this.totalDamage += dealt;
        if (res.isCrit && dealt > 0) this.totalCrits++;
        if (m.hp <= 0) this.killMonster(null, m);
      }
      if (p.damageType === "fire") this.burnCreep(p.x, p.y, radius);
      if (this.hiveSystem) this.hiveSystem.applySplashToTumors(p.x, p.y, radius, p.dmg * dmgMul * 0.6);
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
    /** 直接命中结算（吃免伤盾，DoT/伤害圈不消耗盾）；返回实际落地伤害。 */
    applyDirectHit(m, rawAmount) {
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
    formationMove(m, dt) {
      const wallTop = this.level.wall.height;
      if (m.formationActive) {
        this.steerToSlot(m, m.x, wallTop + m.cfg.radius + 10, dt, true);
        return true;
      }
      if (m.groupId < 0) return false;
      const leader = this.monsters[m.groupId];
      if (!leader || leader.hp <= 0) return false;
      if (!leader.formationActive) {
        const tx = clamp(leader.x + Math.cos(m.formAngle) * 95, 40, this.level.arena.width - 40);
        const ty = clamp(leader.y + Math.sin(m.formAngle) * 95, 120, this.level.arena.height - 60);
        this.steerToSlot(m, tx, ty, dt, false);
        return true;
      }
      const count = leader.cfg.escort?.count ?? 1;
      const slotX = clamp(leader.x + (m.formIndex - (count - 1) / 2) * 58, 40, this.level.arena.width - 40);
      m.slotX = slotX;
      this.steerToSlot(m, slotX, wallTop + m.cfg.radius, dt, true);
      return true;
    }
    /** 驶向槽位；到位后若为墙前位则转为啃墙（assault），否则原地待机（行军相位中场到位不隔空啃墙）。 */
    steerToSlot(m, tx, ty, dt, atWall) {
      let speed = m.cfg.speed * 3;
      if (this.timeSec < m.slowUntil) speed *= m.slowFactor;
      const dx = tx - m.x;
      const dy = ty - m.y;
      const dist = Math.hypot(dx, dy);
      if (dist > 6) {
        const step = Math.min(speed * dt, dist);
        m.x += dx / dist * step;
        m.y += dy / dist * step;
        m.state = "march";
        return;
      }
      if (!atWall) {
        m.state = "march";
        return;
      }
      m.y = ty;
      m.state = "assault";
      m.attackTimer -= dt;
      if (m.attackTimer <= 0) {
        m.attackTimer += m.cfg.attackInterval;
        const dmg = m.cfg.atk;
        this.wallHp = Math.max(0, this.wallHp - dmg);
        this.totalWallDamage += dmg;
        this.waveWallDamage += dmg;
        this.bus.emit("onWallHit", { dmg, wallHp: this.wallHp, x: m.x, y: this.level.wall.height + 26 });
      }
    }
    /** 伤害转嫁：巫师受到的直接伤害始终转移给半径内随机友军（无友军则自承）。返回巫师实际承受值。 */
    resolveTransfer(m, dealt) {
      if (dealt <= 0 || !m.cfg.transferAura) return dealt;
      this.hash.queryCircle(m.x, m.y, m.cfg.transferAura.radius, this.scratch);
      const candidates = [];
      for (const id of this.scratch) {
        const ally = this.monsters[id];
        if (ally && ally !== m && ally.hp > 0) candidates.push(ally);
      }
      if (candidates.length === 0) return dealt;
      const target = candidates[this.rng.int(0, candidates.length - 1)];
      target.hp -= dealt;
      this.totalDamage += dealt;
      this.bus.emit("onDamageTransfer", { fx: m.x, fy: m.y, tx: target.x, ty: target.y, dmg: dealt });
      if (target.hp <= 0) this.killMonster(null, target);
      return 0;
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
        const dmg = Math.max(1, Math.round(b.dps * 0.5));
        m.hp -= dmg;
        this.totalDamage += dmg;
        this.bus.emit("onBurnTick", { x: m.x, y: m.y + m.cfg.radius + 8, dmg });
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
    /** 在指定位置生成测试怪；id 不存在返回 false。noEscort=true 时不触发出场护卫（如单独生成巫师）。 */
    debugSpawn(monsterKey, x, y, opts) {
      if (!this.monsterCfgs.has(monsterKey)) return false;
      this.spawnMonster(monsterKey, x, y, opts?.noEscort ?? false);
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
            w.riders.burnDpsMul = Math.max(w.riders.burnDpsMul, 1);
            w.riders.burnSec = 3;
          } else if (e.grantElement === "frost") {
            w.riders.slowPct = Math.max(w.riders.slowPct, 0.12);
            w.riders.slowSec = 2.5;
          }
        }
      } else {
        for (const w of this.hero.weapons.filter((x) => x.element === e.boostElement)) {
          if (e.boostElement === "fire") {
            w.riders.burnDpsMul += 0.5 * e.value;
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
    /** 分裂幼体：血条与母体一致（maxHp 覆盖），速度取幼体配置（更快），不可再分裂。 */
    spawnBaby(parent, babyKey, count) {
      for (let i = 0; i < count; i++) {
        const ang = this.rng.range(0, Math.PI * 2);
        const bx = clamp(parent.x + Math.cos(ang) * (parent.cfg.radius + 20), 40, this.level.arena.width - 40);
        const by = clamp(parent.y + Math.sin(ang) * (parent.cfg.radius + 20), 120, this.level.arena.height - 60);
        const before = this.monsters.length;
        this.spawnMonster(babyKey, bx, by);
        const baby = this.monsters[this.monsters.length - 1];
        if (this.monsters.length > before) {
          baby.hp = baby.maxHp = parent.maxHp;
        }
      }
    }
    killMonster(p, m, dmgType) {
      this.totalKills++;
      this.waveKills++;
      this.hero.xp += m.cfg.xp;
      this.bus.emit("onKill", {
        monsterId: m.id,
        key: m.cfg.id,
        shape: m.cfg.shape,
        x: m.x,
        y: m.y,
        radius: m.cfg.radius,
        damageType: p ? p.damageType : null
      });
      if (p && p.weapon.cfg.killSplash) {
        const { radius, dmgMul } = p.weapon.cfg.killSplash;
        const splash = Math.max(1, Math.round(p.dmg * dmgMul));
        for (const o of this.monsters) {
          if (o === m || o.hp <= 0 || o.burrowed) continue;
          const dx = o.x - m.x;
          const dy = o.y - m.y;
          const rr = radius + o.cfg.radius;
          if (dx * dx + dy * dy > rr * rr) continue;
          o.hp -= splash;
          this.totalDamage += splash;
          this.bus.emit("onHit", {
            monsterId: o.id,
            dmg: splash,
            isCrit: false,
            blocked: false,
            mitigated: 0,
            x: o.x,
            y: o.y,
            damageType: p.damageType
          });
          if (o.hp <= 0) this.killMonster(null, o, p.damageType);
        }
      }
      if (m.cfg.deathSplit) {
        this.spawnBaby(m, m.cfg.deathSplit.baby, m.cfg.deathSplit.count);
      }
      if (m.cfg.detonate) {
        const dmg = m.cfg.detonate.wallDamage;
        this.wallHp = Math.max(0, this.wallHp - dmg);
        this.totalWallDamage += dmg;
        this.waveWallDamage += dmg;
        this.bus.emit("onExplode", { x: m.x, y: m.y, radius: 70 });
        this.bus.emit("onWallHit", { dmg, wallHp: this.wallHp, x: m.x, y: this.level.wall.height + 26 });
      }
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
          const childCfg = childHoming ? { type: "homing", speed: p.speed, range: 500, turnRate: 360, duration: 2.5, retarget: true } : { type: "straight", speed: p.speed, life: 2 };
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
          case "count":
            return isWeaponSpecific ? 108 : 90;
          case "burst":
            return isWeaponSpecific ? 106 : 88;
          case "damage":
            return 82;
          case "range":
            return 60;
          case "projSpeed":
            return 55;
          case "pierce":
            return 58;
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

  // src/adapter/web/render/fx.ts
  var clamp01 = (t) => t < 0 ? 0 : t > 1 ? 1 : t;
  var Easing = {
    linear: (t) => t,
    easeOut: (t) => 1 - Math.pow(1 - t, 3),
    easeIn: (t) => t * t * t,
    easeInOut: (t) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2,
    /** 超调回弹：末段越过 1 再收回，用于挤压/弹出，产生「弹性」而非「软绵绵」 */
    easeOutBack: (t) => {
      const c1 = 1.70158;
      const c3 = c1 + 1;
      return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
    },
    /** 多次振荡衰减：用于升级选卡这种「有仪式感」的弹出 */
    elastic: (t) => {
      if (t === 0 || t === 1) return t;
      const c4 = 2 * Math.PI / 3;
      return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
    },
    /** 单调衰减：用于震屏、闪白这类「瞬间冲高后衰减」的曲线 */
    decay: (t) => 1 - t
  };
  function easingOf(name) {
    if (name && Easing[name]) return Easing[name];
    return Easing.linear;
  }
  function sampleKeyframes(frames, t, easingName) {
    if (!frames || frames.length === 0) return 1;
    if (frames.length === 1) return frames[0];
    const k = clamp01(easingOf(easingName)(clamp01(t)));
    const seg = frames.length - 1;
    const pos = k * seg;
    const i = Math.min(seg - 1, Math.floor(pos));
    const local = pos - i;
    return frames[i] + (frames[i + 1] - frames[i]) * local;
  }
  var FxRuntime = class {
    constructor(cfg) {
      /** monsterId → 闪白到期时刻（秒，与 session.timeSec 同一时间基准） */
      this.flashUntil = /* @__PURE__ */ new Map();
      this.cfg = cfg;
    }
    get flashSec() {
      return (this.cfg.hitFlash?.duration ?? 80) / 1e3;
    }
    /** 登记一次受击闪白（由 onHit 事件调用）。now 用渲染时间秒。 */
    markHit(monsterId, now) {
      this.flashUntil.set(monsterId, now + this.flashSec);
    }
    /** 查询闪白强度 0~1（0=无闪白，1=刚被打中）。 */
    flashAlpha(monsterId, now) {
      const until = this.flashUntil.get(monsterId);
      if (until === void 0) return 0;
      const left = until - now;
      if (left <= 0) {
        this.flashUntil.delete(monsterId);
        return 0;
      }
      const dur = this.flashSec;
      const t = dur > 0 ? 1 - left / dur : 0;
      return clamp01(t < 0.3 ? 1 : easingOf(this.cfg.hitFlash?.easing ?? "decay")((t - 0.3) / 0.7));
    }
    /**
     * 挤压回弹倍率（纵向），1 = 不变形。
     * 语义约束：**只有受击期间才允许偏离 1**。
     * 未受击时无条件返回 1，否则配置里的关键帧序列（如 [1,0.75,1.15,1]）
     * 会在怪物静止时被采样，导致全体永久变形。
     */
    hitSquash(monsterId, now) {
      const a = this.flashAlpha(monsterId, now);
      if (a <= 0) return 1;
      const frames = this.cfg.squashStretch?.scaleY;
      const v = sampleKeyframes(frames, a, this.cfg.squashStretch?.easing);
      const base = frames && frames.length > 0 ? frames[0] : 1;
      return base === 0 ? v : v / base;
    }
  };
  async function loadFxConfig(baseUrl = "/configs/art-style/fx-config.json") {
    try {
      const r = await fetch(baseUrl);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch {
      console.warn("[fx] fx-config.json \u52A0\u8F7D\u5931\u8D25\uFF0C\u52A8\u6548\u56DE\u843D\u4E3A\u4E2D\u6027\u9ED8\u8BA4\u503C");
      return {};
    }
  }

  // src/adapter/web/render/style.ts
  var SPRITE_SIZE = 128;
  function hexToRgb(hex) {
    let h = hex.replace("#", "");
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    const n = parseInt(h, 16);
    if (Number.isNaN(n)) return [255, 255, 255];
    return [n >> 16 & 255, n >> 8 & 255, n & 255];
  }
  function rgba(hex, alpha) {
    const [r, g, b] = hexToRgb(hex);
    return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, alpha))})`;
  }
  function mix(a, b, t) {
    const [ar, ag, ab] = hexToRgb(a);
    const [br, bg, bb] = hexToRgb(b);
    const k = Math.max(0, Math.min(1, t));
    return `rgb(${Math.round(ar + (br - ar) * k)},${Math.round(ag + (bg - ag) * k)},${Math.round(ab + (bb - ab) * k)})`;
  }
  function lighten(hex, t) {
    return mix(hex, "#FFFFFF", t);
  }
  function darken(hex, t) {
    return mix(hex, "#0B0C1D", t);
  }
  var glowCache = /* @__PURE__ */ new Map();
  function glowSprite(color) {
    const hit = glowCache.get(color);
    if (hit) return hit;
    const c = document.createElement("canvas");
    c.width = SPRITE_SIZE;
    c.height = SPRITE_SIZE;
    const g = c.getContext("2d");
    const half = SPRITE_SIZE / 2;
    const [r, gg, b] = hexToRgb(color);
    const grad = g.createRadialGradient(half, half, 0, half, half, half);
    grad.addColorStop(0, `rgba(${r},${gg},${b},0.92)`);
    grad.addColorStop(0.22, `rgba(${r},${gg},${b},0.5)`);
    grad.addColorStop(0.5, `rgba(${r},${gg},${b},0.16)`);
    grad.addColorStop(1, `rgba(${r},${gg},${b},0)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, SPRITE_SIZE, SPRITE_SIZE);
    glowCache.set(color, c);
    return c;
  }
  function drawGlow(ctx, x, y, radius, color, alpha = 1) {
    if (alpha <= 4e-3 || radius <= 0.5) return;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
    ctx.drawImage(glowSprite(color), x - radius, y - radius, radius * 2, radius * 2);
    ctx.restore();
  }
  var SHADOW_SPRITE = /* @__PURE__ */ (() => {
    let c = null;
    return () => {
      if (c) return c;
      c = document.createElement("canvas");
      c.width = SPRITE_SIZE;
      c.height = SPRITE_SIZE;
      const g = c.getContext("2d");
      const half = SPRITE_SIZE / 2;
      const grad = g.createRadialGradient(half, half, 0, half, half, half);
      grad.addColorStop(0, "rgba(4,5,12,0.62)");
      grad.addColorStop(0.55, "rgba(4,5,12,0.3)");
      grad.addColorStop(1, "rgba(4,5,12,0)");
      g.fillStyle = grad;
      g.fillRect(0, 0, SPRITE_SIZE, SPRITE_SIZE);
      return c;
    };
  })();
  function drawGroundShadow(ctx, x, y, rx, ry, alpha = 1) {
    if (alpha <= 4e-3) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.drawImage(SHADOW_SPRITE(), x - rx, y - ry, rx * 2, ry * 2);
    ctx.restore();
  }
  function hash01(n) {
    const s = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
    return s - Math.floor(s);
  }

  // src/adapter/web/render/identity.ts
  var MONSTER_LOOKS = {
    slime: {
      silhouette: "slime",
      size: "normal",
      accent: "#FFB199",
      core: "#2A0F0C",
      note: "\u6A61\u76AE\u679C\u51BB\uFF1A\u538B\u6241\u5F39\u8DF3\u524D\u8FDB\uFF0C\u6B7B\u4EA1\u644A\u6210\u4E00\u6EE9\u80F6\u8D28",
      death: {
        chunks: "goo",
        count: 9,
        speed: [70, 190],
        size: [3, 6.5],
        gravity: 250,
        spin: false,
        color: "#FF6B57",
        color2: "#FFB199",
        ring: { r1: 34, color: "#FF6B57", width: 3, dur: 0.3 },
        decal: { color: "#FF6B57", radius: 30, dur: 3.6 }
      }
    },
    wolf: {
      silhouette: "wolf",
      size: "normal",
      accent: "#FFD9B0",
      core: "#FF3D71",
      note: "\u75BE\u884C\u730E\u624B\uFF1A\u51B2\u523A\u62C9\u4F38 + \u524D\u6447\u9884\u8B66\u7EBF\uFF0C\u6B7B\u4EA1\u70B8\u6210\u6BDB\u56E2\u4E0E\u4E24\u9053\u65A9\u75D5",
      death: {
        chunks: "shard",
        count: 10,
        speed: [130, 280],
        size: [3, 6],
        gravity: 240,
        spin: true,
        color: "#FF8357",
        color2: "#FFD9B0",
        ring: { r1: 40, color: "#FF8357", width: 2.5, dur: 0.26 },
        glyphs: [{ kind: "slash", count: 2, color: "#FFE7CE", size: [26, 34], speed: [0, 0], dur: 0.34 }]
      }
    },
    thrower: {
      silhouette: "goblin",
      size: "normal",
      accent: "#FFC2A0",
      core: "#2A0F0C",
      note: "\u6295\u77DB\u624B\uFF1A\u68AF\u5F62\u8EAB\u677F + \u957F\u77DB\uFF0C\u63B7\u77DB\u65F6\u540E\u4EF0\uFF1B\u6B7B\u4EA1\u957F\u77DB\u8131\u624B\u63D2\u5730",
      death: {
        chunks: "splinter",
        count: 8,
        speed: [90, 220],
        size: [2.5, 5],
        gravity: 220,
        spin: true,
        color: "#FF5E7A",
        color2: "#FFC2A0",
        glyphs: [{ kind: "drop", count: 1, color: "#FFC2A0", size: [30, 34], speed: [40, 70], dur: 1.1 }]
      }
    },
    catapult: {
      silhouette: "catapult",
      size: "large",
      accent: "#C9A26B",
      core: "#6B4A2F",
      note: "\u6295\u77F3\u8F66\uFF1A\u6728\u67B6 + \u53CC\u8F6E + \u6295\u81C2\uFF0C\u8F6E\u5B50\u5E38\u8F6C\uFF1B\u6B7B\u4EA1\u6728\u5C51\u56DB\u6E85\u3001\u8F6E\u5B50\u6EDA\u8D70",
      death: {
        chunks: "splinter",
        count: 14,
        speed: [110, 260],
        size: [3, 7],
        gravity: 260,
        spin: true,
        color: "#A9714B",
        color2: "#C9A26B",
        ring: { r1: 52, color: "#C9A26B", width: 3, dur: 0.34 },
        smoke: { color: "#8A6B4A", count: 5 },
        glyphs: [{ kind: "drop", count: 2, color: "#8B5E3C", size: [13, 16], speed: [50, 90], dur: 1.3 }]
      }
    },
    charger: {
      silhouette: "charger",
      size: "small",
      accent: "#FFEBC8",
      core: "#FF3D71",
      note: "\u51B2\u950B\u9F20\uFF1A\u5168\u6E38\u620F\u6700\u5FEB\u7684\u52A8\u80FD\u68AD\uFF0C\u6B7B\u4EA1\u53EA\u5269\u4E00\u9053\u901F\u5EA6\u7EBF\u4E0E\u5239\u8F66\u75D5",
      death: {
        chunks: "spark",
        count: 12,
        speed: [180, 380],
        size: [2, 4],
        gravity: 0,
        spin: false,
        color: "#FFA25E",
        color2: "#FFEBC8",
        ring: { r1: 44, color: "#FFA25E", width: 2, dur: 0.2 },
        glyphs: [
          { kind: "slash", count: 3, color: "#FFEBC8", size: [22, 30], speed: [0, 0], dur: 0.26 },
          { kind: "crack", count: 2, color: "#E0B080", size: [24, 34], speed: [20, 40], dur: 0.7 }
        ]
      }
    },
    bulwark: {
      silhouette: "armor",
      size: "large",
      accent: "#C7CEE6",
      core: "#0B0C1D",
      note: "\u5CA9\u7532\u517D\uFF1A\u516D\u8FB9\u5F62\u91CD\u7532 + \u514D\u4F24\u76FE\uFF0C\u6B7B\u4EA1\u6574\u7247\u7532\u58F3\u5D29\u89E3\u6210\u77F3\u7247",
      death: {
        chunks: "plate",
        count: 11,
        speed: [90, 220],
        size: [5, 10],
        gravity: 280,
        spin: true,
        color: "#8A93B8",
        color2: "#C7CEE6",
        ring: { r1: 48, color: "#C7CEE6", width: 4, dur: 0.4 },
        smoke: { color: "#6E7796", count: 4 },
        decal: { color: "#6E7796", radius: 26, dur: 2.2 }
      }
    },
    bulwark_king: {
      silhouette: "king",
      size: "boss",
      accent: "#FFD54F",
      core: "#0B0C1D",
      note: "\u5CA9\u7532\u9B54\u738B\uFF1A\u540C\u65CF\u91CD\u7532\u7684\u9EC4\u91D1\u51A0\u7248\u672C\uFF0C\u53CC\u5C42\u8F6E\u5ED3\u8109\u51B2\uFF1B\u6B7B\u4EA1\u51A0\u788E\u3001\u77F3\u7532\u6210\u5C71",
      death: {
        chunks: "plate",
        count: 18,
        speed: [110, 300],
        size: [6, 12],
        gravity: 300,
        spin: true,
        color: "#8A93B8",
        color2: "#FFD54F",
        weight: 1.35,
        ring: { r1: 78, color: "#FFD54F", width: 5, dur: 0.55 },
        smoke: { color: "#6E7796", count: 7 },
        decal: { color: "#6E7796", radius: 40, dur: 3 },
        glyphs: [{ kind: "drop", count: 3, color: "#FFD54F", size: [8, 12], speed: [90, 150], dur: 1.4 }]
      }
    },
    boss_treant: {
      silhouette: "treant",
      size: "boss",
      accent: "#D9A6FF",
      core: "#B537F2",
      note: "\u8150\u5316\u6811\u4EBA\uFF1A\u5D4C\u5957\u5C16\u523A\u73AF + \u65CB\u8F6C\u5916\u73AF\uFF1B\u6B7B\u4EA1\u662F\u584C\u9677\u2014\u2014\u5916\u73AF\u788E\u88C2\u3001\u6728\u5C51\u6210\u96E8",
      death: {
        chunks: "shard",
        count: 22,
        speed: [80, 240],
        size: [5, 12],
        gravity: 260,
        spin: true,
        color: "#6B4A2F",
        color2: "#B537F2",
        weight: 1.7,
        ring: { r1: 120, color: "#B537F2", width: 6, dur: 0.8 },
        smoke: { color: "#5E3B6E", count: 8 },
        decal: { color: "#B537F2", radius: 54, dur: 4 },
        glyphs: [
          { kind: "shatter", count: 10, color: "#D9A6FF", size: [10, 18], speed: [60, 120], dur: 1.5 },
          { kind: "wisp", count: 8, color: "#D9A6FF", size: [2, 4], speed: [30, 70], dur: 1.2 },
          { kind: "crack", count: 4, color: "#6B4A2F", size: [40, 70], speed: [30, 60], dur: 1.2 }
        ]
      }
    },
    split_shroom: {
      silhouette: "mushroom",
      size: "normal",
      accent: "#FFD1E3",
      core: "#3A1024",
      note: "\u5206\u88C2\u83C7\uFF1A\u4F1E\u76D6 + \u6591\u70B9\uFF1B\u6B7B\u4EA1\u5D29\u6210\u5B62\u5B50\u4E91\uFF0C\u5E76\u88C2\u51FA\u4E24\u53EA\u5E7C\u4F53\uFF08\u5BF9\u5E94 deathSplit\uFF09",
      death: {
        chunks: "goo",
        count: 10,
        speed: [80, 200],
        size: [3, 6],
        gravity: 200,
        spin: false,
        color: "#FF6B9C",
        color2: "#FFD1E3",
        ring: { r1: 42, color: "#FF6B9C", width: 3, dur: 0.3 },
        smoke: { color: "#FF9DC0", count: 5 },
        decal: { color: "#FF6B9C", radius: 28, dur: 2.6 },
        glyphs: [{ kind: "split", count: 2, color: "#FF9DC0", size: [9, 12], speed: [70, 110], dur: 0.85 }]
      }
    },
    shroom_baby: {
      silhouette: "mushroom",
      size: "small",
      accent: "#FFC9DE",
      core: "#3A1024",
      note: "\u5206\u88C2\u83C7\u5E7C\u4F53\uFF1A\u5C0F\u4E00\u53F7\u3001\u65E0\u6591\u70B9\uFF1B\u6B7B\u4EA1\u53EA\u6709\u4E00\u5C0F\u56E2\u5B62\u5B50\uFF0C\u4E0D\u518D\u5206\u88C2",
      death: {
        chunks: "goo",
        count: 6,
        speed: [60, 150],
        size: [2, 4],
        gravity: 190,
        spin: false,
        color: "#FF6B9C",
        color2: "#FFC9DE",
        smoke: { color: "#FFB3CC", count: 3 },
        decal: { color: "#FF6B9C", radius: 16, dur: 1.8 }
      }
    },
    bat: {
      silhouette: "bat",
      size: "small",
      accent: "#FFB3E1",
      core: "#2A0F20",
      note: "\u591C\u884C\u8759\u8760\uFF1A\u53CC\u7FFC\u6251\u52A8 + \u86C7\u5F62\u8F68\u8FF9\uFF1B\u6B7B\u4EA1\u7FFC\u819C\u788E\u7247\u4E0A\u98D8\u3001\u56DE\u58F0\u73AF\u6269\u6563",
      death: {
        chunks: "feather",
        count: 10,
        speed: [90, 240],
        size: [3, 6],
        gravity: -40,
        spin: true,
        color: "#FF7EC7",
        color2: "#FFB3E1",
        ring: { r1: 38, color: "#FF7EC7", width: 2, dur: 0.4 },
        glyphs: [
          { kind: "wisp", count: 3, color: "#FFB3E1", size: [2, 3], speed: [30, 60], dur: 0.9 },
          { kind: "arc", count: 2, color: "#FF7EC7", size: [14, 20], speed: [0, 0], dur: 0.3 }
        ]
      }
    },
    shaman: {
      silhouette: "shaman",
      size: "normal",
      accent: "#F5F5FA",
      core: "#B388FF",
      note: "\u5730\u7CBE\u5DEB\u5E08\uFF1A\u83F1\u5F62\u6CD5\u888D + \u60AC\u6D6E\u6CD5\u7403\uFF1B\u6B7B\u4EA1\u6CD5\u888D\u584C\u843D\u3001\u9B42\u706B\u4E0A\u5347\u3001\u5730\u9762\u7559\u4E0B\u7B26\u6587\u73AF",
      death: {
        chunks: "shard",
        count: 9,
        speed: [70, 200],
        size: [3, 6],
        gravity: 210,
        spin: true,
        color: "#B388FF",
        color2: "#F5F5FA",
        ring: { r1: 46, color: "#B388FF", width: 3, dur: 0.5 },
        glyphs: [
          { kind: "wisp", count: 5, color: "#D9C2FF", size: [2.5, 4.5], speed: [40, 90], dur: 1.3 },
          { kind: "shatter", count: 4, color: "#B388FF", size: [10, 16], speed: [30, 60], dur: 0.9 }
        ]
      }
    },
    zerg_ling: {
      silhouette: "zergling",
      size: "small",
      accent: "#C5E1A5",
      core: "#1A2410",
      note: "\u5E7C\u866B\u7FA4\uFF1A\u4F4E\u4F0F\u8EAB\u4F4D + \u524D\u80A2\u9570\u5200\uFF0C\u8D34\u5730\u75BE\u8DD1\uFF1B\u6B7B\u4EA1\u9178\u6D46\u56DB\u6E85",
      death: {
        chunks: "spark",
        count: 8,
        speed: [120, 260],
        size: [2, 4],
        gravity: 160,
        spin: false,
        color: "#9CCC65",
        color2: "#C5E1A5",
        decal: { color: "#7CB342", radius: 16, dur: 1.6 },
        glyphs: [{ kind: "slash", count: 2, color: "#C5E1A5", size: [16, 22], speed: [0, 0], dur: 0.24 }]
      }
    },
    zerg_roach: {
      silhouette: "roach",
      size: "normal",
      accent: "#AED581",
      core: "#1A2410",
      note: "\u722C\u866B\uFF1A\u692D\u5706\u7532\u58F3 + \u80CC\u810A\u5C16\u523A\uFF0C\u6B8B\u8840\u94BB\u5730\u56DE\u8840\uFF1B\u6B7B\u4EA1\u7532\u58F3\u5BF9\u534A\u88C2\u5F00",
      death: {
        chunks: "plate",
        count: 9,
        speed: [80, 200],
        size: [4, 8],
        gravity: 240,
        spin: true,
        color: "#7CB342",
        color2: "#AED581",
        ring: { r1: 44, color: "#7CB342", width: 3, dur: 0.34 },
        smoke: { color: "#4A5B2A", count: 3 },
        decal: { color: "#558B2F", radius: 24, dur: 2 }
      }
    },
    zerg_lurker: {
      silhouette: "lurker",
      size: "normal",
      accent: "#8BC34A",
      core: "#1A2410",
      note: "\u6F5C\u4F0F\u8005\uFF1A\u7AD6\u7ACB\u5C16\u523A + \u56DB\u4FA7\u5229\u722A\uFF0C\u94BB\u5730\u65F6\u53EA\u5269\u571F\u5305\u865A\u7EBF\uFF1B\u6B7B\u4EA1\u5730\u523A\u70B8\u51FA\u3001\u571F\u5757\u7FFB\u8D77",
      death: {
        chunks: "shard",
        count: 8,
        speed: [100, 240],
        size: [4, 8],
        gravity: 260,
        spin: true,
        color: "#558B2F",
        color2: "#8BC34A",
        glyphs: [
          { kind: "spike", count: 6, color: "#8BC34A", size: [8, 16], speed: [100, 180], dur: 0.5 },
          { kind: "crack", count: 3, color: "#6B4A2F", size: [26, 40], speed: [20, 50], dur: 0.8 }
        ]
      }
    },
    zerg_larva: {
      silhouette: "grub",
      size: "small",
      accent: "#E6EE9C",
      core: "#1A2410",
      note: "\u5E7C\u866B\uFF1A\u4E09\u8282\u80A5\u8EAF + \u53D8\u6001\u56CA\uFF08\u56CA\u4F53\u968F morph \u5012\u8BA1\u65F6\u52A0\u901F\u8109\u52A8\uFF09\uFF1B\u6B7B\u4EA1\u4F53\u6DB2\u7206\u5F00",
      death: {
        chunks: "goo",
        count: 7,
        speed: [60, 170],
        size: [2.5, 5],
        gravity: 200,
        spin: false,
        color: "#9CCC65",
        color2: "#E6EE9C",
        decal: { color: "#8BC34A", radius: 15, dur: 1.6 }
      }
    },
    zerg_queen: {
      silhouette: "queen",
      size: "large",
      accent: "#FF9DE2",
      core: "#1A2410",
      note: '\u866B\u540E\uFF1A\u83F1\u5F62\u6BCD\u4F53 + \u6CBB\u7597\u5149\u73AF\uFF1B\u6B7B\u4EA1\u662F\u4E00\u6B21"\u5DE2\u5D29"\u2014\u2014\u7EFF\u73AF + \u5375\u7C92\u98DE\u6563 + \u96FE\u5316',
      death: {
        chunks: "goo",
        count: 14,
        speed: [90, 240],
        size: [4, 9],
        gravity: 220,
        spin: false,
        color: "#C77DFF",
        color2: "#AEEA00",
        weight: 1.2,
        ring: { r1: 96, color: "#7CB342", width: 5, dur: 0.6 },
        smoke: { color: "#7CB342", count: 6 },
        decal: { color: "#558B2F", radius: 44, dur: 3.2 },
        glyphs: [
          { kind: "split", count: 6, color: "#AEEA00", size: [4, 7], speed: [60, 130], dur: 0.9 },
          { kind: "wisp", count: 6, color: "#C77DFF", size: [2, 4], speed: [40, 80], dur: 1.1 }
        ]
      }
    },
    baneling: {
      silhouette: "baneling",
      size: "normal",
      accent: "#D8FF50",
      core: "#7CB342",
      note: "\u6BD2\u7206\u866B\uFF1A\u8109\u52A8\u81EA\u7206\u4F53\uFF08\u5371\u9669\u5EA6\u8D8A\u9AD8\u98A4\u5F97\u8D8A\u6025\uFF09\uFF1B\u6B7B\u4EA1=\u9178\u7206\uFF0C\u7EFF\u6D46\u5916\u6E85",
      death: {
        chunks: "bubble",
        count: 14,
        speed: [120, 300],
        size: [3, 7],
        gravity: 150,
        spin: false,
        color: "#AEEA00",
        color2: "#D8FF50",
        ring: { r1: 60, color: "#AEEA00", width: 4, dur: 0.45 },
        smoke: { color: "#7CB342", count: 5 },
        decal: { color: "#7CB342", radius: 32, dur: 3.2 },
        glyphs: [{ kind: "arc", count: 4, color: "#D8FF50", size: [16, 26], speed: [80, 140], dur: 0.4 }]
      }
    },
    zerg_ultra: {
      silhouette: "ultra",
      size: "boss",
      accent: "#AED581",
      core: "#1A2410",
      note: "\u96F7\u517D\uFF1A\u5341\u89D2\u7532\u58F3 + \u9570\u5200\u53CC\u81C2\uFF0C\u94BB\u5730\u51B2\u950B\uFF1B\u6B7B\u4EA1\u662F\u5730\u9707\u2014\u2014\u88C2\u7EB9 + \u7532\u7247\u6210\u5806",
      death: {
        chunks: "plate",
        count: 16,
        speed: [100, 280],
        size: [6, 12],
        gravity: 300,
        spin: true,
        color: "#69A83B",
        color2: "#AED581",
        weight: 1.45,
        ring: { r1: 88, color: "#AED581", width: 5, dur: 0.55 },
        smoke: { color: "#4A5B2A", count: 6 },
        decal: { color: "#558B2F", radius: 46, dur: 3 },
        glyphs: [
          { kind: "crack", count: 5, color: "#6B4A2F", size: [40, 72], speed: [30, 70], dur: 1.3 },
          { kind: "arc", count: 3, color: "#AED581", size: [20, 30], speed: [60, 120], dur: 0.45 }
        ]
      }
    }
  };
  var SHAPE_TO_SILHOUETTE = {
    slime: "slime",
    wolf: "wolf",
    charger: "charger",
    thrower: "goblin",
    bulwark: "armor",
    bat: "bat",
    shroom: "mushroom",
    boss: "treant",
    shaman: "shaman",
    larva: "grub",
    roach: "roach",
    lurker: "lurker",
    zqueen: "queen",
    baneling: "baneling",
    ultra: "ultra"
  };
  var FALLBACK_LOOK = {
    silhouette: "slime",
    size: "normal",
    accent: "#FFB199",
    core: "#2A0F0C",
    note: "\u672A\u767B\u8BB0\u5F62\u6001\uFF08\u56DE\u843D\u53F2\u83B1\u59C6\uFF09",
    death: {
      chunks: "goo",
      count: 6,
      speed: [70, 160],
      size: [3, 5],
      gravity: 220,
      color: "#FF6B57",
      color2: "#FFB199",
      decal: { color: "#FF6B57", radius: 20, dur: 2 }
    }
  };
  function lookOf(key, shape) {
    const own = key ? MONSTER_LOOKS[key] : void 0;
    if (own) return own;
    const fam = FALLBACK_LOOK;
    const sil = SHAPE_TO_SILHOUETTE[shape ?? ""] ?? fam.silhouette;
    return { ...fam, silhouette: sil };
  }
  var SIZE_SCALE = {
    small: 0.78,
    normal: 1,
    large: 1.35,
    boss: 1.9
  };
  var CHUNK_TO_KIND = {
    goo: "star",
    shard: "shard",
    plate: "shard",
    splinter: "shard",
    feather: "star",
    spark: "spark",
    ember: "ember",
    bubble: "star"
  };

  // src/adapter/web/render/particles.ts
  var MAX_PARTICLES = 320;
  var MAX_FLOATS = 48;
  var MAX_BOLTS = 18;
  var EffectsLayer = class {
    constructor() {
      this.particles = [];
      this.rings = [];
      this.bolts = [];
      this.floats = [];
      this.heals = [];
      this.transfers = [];
      this.muzzles = [];
      /** 震屏状态（渲染层局部，不影响逻辑与输入） */
      this.shakeAmp = 0;
      this.shakeLeft = 0;
      this.shakeDur = 0;
      this.clock = 0;
      /** 帧间随机序列（仅观感）：避免 Math.random 造成同帧多粒子完全重叠 */
      this.seed = 1337;
    }
    rand() {
      this.seed = (this.seed * 1664525 + 1013904223) % 4294967296;
      return this.seed / 4294967296;
    }
    range(a, b) {
      return a + (b - a) * this.rand();
    }
    // ---------------- 对外触发接口 ----------------
    /** 震屏：amp=像素幅度，dur=秒。 */
    shake(amp, dur) {
      if (amp >= this.shakeAmp || this.shakeLeft <= 0) {
        this.shakeAmp = amp;
        this.shakeDur = Math.max(0.02, dur);
        this.shakeLeft = this.shakeDur;
      }
    }
    get shakeOffset() {
      if (this.shakeLeft <= 0) return { x: 0, y: 0 };
      const k = this.shakeLeft / this.shakeDur;
      const decay = k * k;
      const a = this.shakeAmp * decay;
      const t = this.clock * 60;
      return { x: Math.sin(t * 1.7) * a, y: Math.cos(t * 2.3) * a * 0.7 };
    }
    pushFloat(x, y, text, color, size, opts) {
      if (this.floats.length >= MAX_FLOATS) this.floats.shift();
      const life = opts?.life ?? (opts?.crit ? 0.95 : 0.8);
      this.floats.push({
        x,
        y,
        text,
        color,
        size,
        life,
        maxLife: life,
        pop: opts?.crit ? 0.85 : 0.5,
        vy: opts?.rise ?? 62
      });
    }
    /** 命中火花：沿受击方向溅射（dir 为空时向四周）。 */
    impact(x, y, color, dir, count = 3) {
      for (let i = 0; i < count; i++) {
        const a = dir === void 0 ? this.range(0, Math.PI * 2) : dir + this.range(-0.7, 0.7);
        const sp = this.range(160, 380);
        this.add({
          kind: "spark",
          x: x + this.range(-3, 3),
          y: y + this.range(-3, 3),
          vx: Math.cos(a) * sp,
          vy: Math.sin(a) * sp,
          grav: -220,
          drag: 3.2,
          life: this.range(0.14, 0.3),
          size: this.range(1.9, 3.4),
          color,
          rot: a,
          spin: 0,
          shrink: 1
        });
      }
      if (this.rand() < 0.5) {
        this.rings.push({
          x,
          y,
          r0: 1,
          r1: this.range(8, 13),
          life: 0.16,
          maxLife: 0.16,
          color,
          width: 2,
          filled: false
        });
      }
    }
    /** 击杀碎裂：碎片形状跟随本体色，尺寸随半径增大。 */
    deathBurst(x, y, color, radius) {
      const n = Math.min(20, 8 + Math.round(radius / 4));
      for (let i = 0; i < n; i++) {
        const a = Math.PI * 2 * i / n + this.range(-0.4, 0.4);
        const sp = this.range(140, 340) * (0.7 + radius / 55);
        this.add({
          kind: "shard",
          x,
          y,
          vx: Math.cos(a) * sp,
          vy: Math.sin(a) * sp + 40,
          grav: -720,
          drag: 0.7,
          life: this.range(0.35, 0.72),
          size: this.range(3.2, 6) * (0.75 + radius / 55),
          color,
          rot: a,
          spin: this.range(-8, 8),
          shrink: 1
        });
      }
      this.rings.push({
        x,
        y,
        r0: radius * 0.35,
        r1: radius * 1.5,
        life: 0.24,
        maxLife: 0.24,
        color: "#F5F5FA",
        width: 2,
        filled: false
      });
      this.add({
        kind: "star",
        x,
        y,
        vx: 0,
        vy: 0,
        grav: 0,
        drag: 0,
        life: 0.12,
        size: radius * 1.5,
        color: "#FFFFFF",
        rot: 0.6,
        spin: 3,
        shrink: 1
      });
    }
    /**
     * 身份化击杀（identity.ts 的 death 配方 → 本层粒子/环/电弧）。
     * 与通用 deathBurst 的区别：碎块材质、数量、速度、颜色、冲击环、尘烟、专属符号
     * 全部按「怪物 id」取配方，所以 19 只怪死法各不相同；未知 id 回落通用碎裂。
     * 只做观感，不读逻辑，不影响确定性。
     */
    deathFor(key, shape, x, y, radius, fallbackColor, damageType) {
      const look = lookOf(key, shape);
      if (!key && !shape) {
        this.deathBurst(x, y, fallbackColor, radius);
        this.elementalFlavor(x, y, radius, damageType);
        return;
      }
      const r = look.death;
      const scale = SIZE_SCALE[look.size] * Math.min(1.7, Math.max(0.75, radius / 20));
      const isSmall = look.size === "small";
      const chunkKind = CHUNK_TO_KIND[r.chunks];
      const count = Math.min(28, Math.round(r.count * (scale > 1.3 ? 1.3 : 1)));
      for (let i = 0; i < count; i++) {
        const a = this.range(0, Math.PI * 2);
        const sp = this.range(r.speed[0], r.speed[1]) * (0.7 + 0.35 * scale);
        this.add({
          kind: chunkKind,
          x: x + this.range(-radius * 0.3, radius * 0.3),
          y: y + this.range(-radius * 0.3, radius * 0.3),
          vx: Math.cos(a) * sp,
          vy: Math.sin(a) * sp,
          grav: -r.gravity,
          drag: r.chunks === "goo" || r.chunks === "bubble" ? 1.6 : 0.8,
          life: this.range(0.34, 0.34 + 0.5),
          size: this.range(r.size[0], r.size[1]) * Math.min(1.6, scale),
          color: r.color2 && this.rand() < 0.4 ? r.color2 : r.color,
          rot: a,
          spin: r.spin ? this.range(-9, 9) : this.range(-2, 2),
          shrink: 1
        });
      }
      if (r.ring) {
        this.rings.push({
          x,
          y,
          r0: radius * 0.4,
          r1: r.ring.r1 * scale,
          life: r.ring.dur,
          maxLife: r.ring.dur,
          color: r.ring.color,
          width: r.ring.width,
          filled: false
        });
      }
      if (r.decal) {
        for (let i = 0; i < 5; i++) {
          const a = this.range(0, Math.PI * 2);
          this.add({
            kind: "dust",
            x: x + Math.cos(a) * r.decal.radius * scale * 0.5,
            y: y + Math.sin(a) * r.decal.radius * scale * 0.25,
            vx: Math.cos(a) * 12,
            vy: Math.sin(a) * 10,
            grav: -4,
            drag: 2.4,
            life: 0.9,
            size: r.decal.radius * scale * 0.5,
            color: r.decal.color,
            rot: a,
            spin: 0,
            shrink: 1
          });
        }
      }
      if (r.smoke) {
        const n = Math.round(r.smoke.count * Math.min(1.6, scale));
        for (let i = 0; i < n; i++) {
          const a = this.range(0, Math.PI * 2);
          this.add({
            kind: "smoke",
            x: x + this.range(-radius * 0.4, radius * 0.4),
            y: y + this.range(-radius * 0.4, radius * 0.4),
            vx: Math.cos(a) * this.range(10, 34),
            vy: Math.sin(a) * this.range(10, 34) + 10,
            grav: 0,
            drag: 1.4,
            life: this.range(0.5, 0.95),
            size: (9 + this.rand() * 12) * Math.min(1.5, scale),
            color: r.smoke.color,
            rot: 0,
            spin: 0,
            shrink: 0
          });
        }
      }
      if (r.glyphs) {
        for (const g of r.glyphs) {
          for (let i = 0; i < g.count; i++) {
            const a = this.range(0, Math.PI * 2);
            const sz = this.range(g.size[0], g.size[1]) * Math.min(1.5, scale);
            if (g.kind === "arc") {
              const ex = x + Math.cos(a) * 40;
              const ey = y + Math.sin(a) * 40;
              const mx = (x + ex) / 2 + this.range(-10, 10);
              const my = (y + ey) / 2 + this.range(-10, 10);
              if (this.bolts.length < MAX_BOLTS) {
                this.bolts.push({ pts: [[x, y], [mx, my], [ex, ey]], life: g.dur, maxLife: g.dur, color: g.color, width: 2.5 });
              }
            } else if (g.kind === "wisp") {
              this.add({ kind: "star", x, y, vx: this.range(-20, 20), vy: this.range(40, 90), grav: -20, drag: 1, life: g.dur, size: sz * 0.5, color: g.color, rot: 0.6, spin: 2, shrink: 1 });
            } else if (g.kind === "shatter") {
              this.rings.push({ x, y, r0: sz * 1.5, r1: sz * 4, life: g.dur, maxLife: g.dur, color: g.color, width: 2, filled: false });
            } else if (g.kind === "crack") {
              this.add({ kind: "dust", x: x + Math.cos(a) * sz, y: y + Math.sin(a) * sz * 0.5, vx: Math.cos(a) * 30, vy: Math.sin(a) * 20, grav: -30, drag: 2, life: g.dur, size: sz * 0.6, color: g.color, rot: a, spin: 0, shrink: 1 });
            } else {
              this.add({ kind: g.kind === "split" ? "star" : "shard", x, y, vx: Math.cos(a) * this.range(90, 200), vy: Math.sin(a) * this.range(90, 200), grav: -260, drag: 1.2, life: g.dur, size: sz * 0.5, color: g.color, rot: a, spin: this.range(-8, 8), shrink: 1 });
            }
          }
        }
      }
      this.add({ kind: "star", x, y, vx: 0, vy: 0, grav: 0, drag: 0, life: isSmall ? 0.1 : 0.13, size: radius * 1.4, color: "#FFFFFF", rot: 0.6, spin: 3, shrink: 1 });
      if (look.size === "boss" || look.size === "large") this.shake(isSmall ? 0 : look.size === "boss" ? 7 : 3, 0.2);
      this.elementalFlavor(x, y, radius, damageType);
    }
    /**
     * 致命元素风味（2D）：让"怎么死的"在画面上多一层可读的元素语言。
     * 火=上飘余烬 + 焦痕红晕；冰=四散碎晶 + 霜环；雷=短电弧；毒=绿气泡；物理=白色星芒。
     */
    elementalFlavor(x, y, radius, damageType) {
      if (!damageType) return;
      const R = radius;
      if (damageType === "fire") {
        this.rings.push({ x, y, r0: R * 0.5, r1: R * 1.6, life: 0.35, maxLife: 0.35, color: "#FF5A3C", width: 3, filled: false });
        for (let i = 0; i < 5; i++) {
          const a = this.range(0, Math.PI * 2);
          this.add({ kind: "ember", x, y, vx: Math.cos(a) * this.range(30, 90), vy: this.range(60, 140), grav: -60, drag: 1.4, life: this.range(0.3, 0.6), size: this.range(2, 4), color: i % 2 ? "#FFD54F" : "#FF5A3C", rot: a, spin: 0, shrink: 1 });
        }
      } else if (damageType === "frost") {
        this.rings.push({ x, y, r0: R * 0.6, r1: R * 1.9, life: 0.45, maxLife: 0.45, color: "#4FC3F7", width: 2, filled: false });
        for (let i = 0; i < 7; i++) {
          const a = this.range(0, Math.PI * 2);
          const sp = this.range(120, 260);
          this.add({ kind: "shard", x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, grav: -120, drag: 1.4, life: this.range(0.3, 0.55), size: this.range(2.5, 5), color: i % 2 ? "#BFFFF2" : "#4FC3F7", rot: a, spin: this.range(-8, 8), shrink: 1 });
        }
      } else if (damageType === "lightning") {
        for (let i = 0; i < 2; i++) {
          const a = this.range(0, Math.PI * 2);
          const ex = x + Math.cos(a) * 44;
          const ey = y + Math.sin(a) * 44;
          if (this.bolts.length < MAX_BOLTS) {
            this.bolts.push({ pts: [[x, y], [(x + ex) / 2 + this.range(-10, 10), (y + ey) / 2 + this.range(-10, 10)], [ex, ey]], life: 0.28, maxLife: 0.28, color: "#B388FF", width: 2.6 });
          }
        }
      } else if (damageType === "poison") {
        for (let i = 0; i < 6; i++) {
          const a = this.range(0, Math.PI * 2);
          this.add({ kind: "star", x: x + Math.cos(a) * R * 0.5, y: y + Math.sin(a) * R * 0.4, vx: Math.cos(a) * this.range(20, 70), vy: this.range(40, 110), grav: -30, drag: 1.8, life: this.range(0.35, 0.7), size: this.range(2, 3.6), color: "#7CB342", rot: a, spin: 0, shrink: 1 });
        }
      } else if (damageType === "physical") {
        this.add({ kind: "star", x, y, vx: 0, vy: 0, grav: 0, drag: 0, life: 0.14, size: R * 1.5, color: "#F5F5FA", rot: this.range(0, 1), spin: 3, shrink: 1 });
      }
    }
    /** 爆炸：火球闪 + 冲击环 + 火星 + 烟。 */
    explosion(x, y, radius, coreColor = "#FFD54F", edgeColor = "#FF5A3C") {
      this.rings.push({
        x,
        y,
        r0: radius * 0.2,
        r1: radius * 1.15,
        life: 0.34,
        maxLife: 0.34,
        color: coreColor,
        width: 7,
        filled: true
      });
      this.rings.push({
        x,
        y,
        r0: radius * 0.5,
        r1: radius * 1.5,
        life: 0.45,
        maxLife: 0.45,
        color: edgeColor,
        width: 3,
        filled: false
      });
      const n = Math.min(26, 14 + Math.round(radius / 7));
      for (let i = 0; i < n; i++) {
        const a = this.range(0, Math.PI * 2);
        const sp = this.range(90, 340);
        this.add({
          kind: "ember",
          x: x + Math.cos(a) * radius * 0.25,
          y: y + Math.sin(a) * radius * 0.25,
          vx: Math.cos(a) * sp,
          vy: Math.sin(a) * sp,
          grav: -280,
          drag: 2.1,
          life: this.range(0.25, 0.6),
          size: this.range(2.6, 6),
          color: i % 3 === 0 ? coreColor : edgeColor,
          rot: a,
          spin: 0,
          shrink: 1
        });
      }
      for (let i = 0; i < 4; i++) {
        this.add({
          kind: "smoke",
          x: x + this.range(-radius * 0.3, radius * 0.3),
          y: y + this.range(-radius * 0.2, radius * 0.2),
          vx: this.range(-30, 30),
          vy: this.range(20, 70),
          grav: -20,
          drag: 1.4,
          life: this.range(0.5, 0.9),
          size: radius * this.range(0.18, 0.34),
          color: "#0B0C1D",
          rot: 0,
          spin: 0,
          shrink: 0
        });
      }
      this.shake(Math.min(9, radius * 0.055), 0.22);
    }
    /** 城墙受击：碎屑 + 尘土 + 震屏。 */
    wallImpact(x, y, strength, color) {
      const n = Math.min(12, 3 + Math.round(strength / 6));
      for (let i = 0; i < n; i++) {
        const a = this.range(Math.PI * 0.15, Math.PI * 0.85);
        const sp = this.range(80, 260);
        this.add({
          kind: "shard",
          x: x + this.range(-10, 10),
          y,
          vx: Math.cos(a) * sp,
          vy: Math.sin(a) * sp,
          grav: -820,
          drag: 0.5,
          life: this.range(0.3, 0.6),
          size: this.range(2, 4),
          color,
          rot: a,
          spin: this.range(-6, 6),
          shrink: 1
        });
      }
      this.add({
        kind: "smoke",
        x,
        y,
        vx: 0,
        vy: 30,
        grav: -10,
        drag: 2,
        life: 0.4,
        size: 16,
        color: "#0B0C1D",
        rot: 0,
        spin: 0,
        shrink: 0
      });
      this.shake(Math.min(6, 1.5 + strength * 0.22), 0.16);
    }
    /** 治疗：绿色扩散环 + 上升光点。 */
    healPulse(x, y, radius) {
      if (this.heals.length > 10) this.heals.shift();
      this.heals.push({ x, y, radius, life: 0.5, maxLife: 0.5 });
      for (let i = 0; i < 3; i++) {
        this.add({
          kind: "star",
          x: x + this.range(-radius * 0.4, radius * 0.4),
          y: y + this.range(-radius * 0.2, radius * 0.2),
          vx: this.range(-8, 8),
          vy: this.range(30, 70),
          grav: -10,
          drag: 0.8,
          life: this.range(0.3, 0.6),
          size: this.range(2, 3.6),
          color: "#7CB342",
          rot: 0.6,
          spin: 2,
          shrink: 1
        });
      }
    }
    transfer(fx, fy, tx, ty) {
      if (this.transfers.length > 14) this.transfers.shift();
      this.transfers.push({ fx, fy, tx, ty, life: 0.3, maxLife: 0.3 });
      this.add({
        kind: "star",
        x: tx,
        y: ty,
        vx: 0,
        vy: 0,
        grav: 0,
        drag: 0,
        life: 0.18,
        size: 9,
        color: "#B388FF",
        rot: 0.5,
        spin: 4,
        shrink: 1
      });
    }
    chain(points, color = "#B388FF") {
      if (this.bolts.length >= MAX_BOLTS) this.bolts.shift();
      this.bolts.push({ pts: points, life: 0.3, maxLife: 0.3, color, width: 6 });
      for (const p of points) {
        if (this.particles.length > MAX_PARTICLES - 4) break;
        this.add({
          kind: "spark",
          x: p[0],
          y: p[1],
          vx: this.range(-90, 90),
          vy: this.range(-90, 90),
          grav: 0,
          drag: 4,
          life: 0.16,
          size: 2,
          color: "#F5F5FA",
          rot: 0,
          spin: 0,
          shrink: 1
        });
      }
    }
    muzzle(x, y, angle, color, size = 20, life = 0.07) {
      if (this.muzzles.length > 12) this.muzzles.shift();
      this.muzzles.push({ x, y, angle, life, maxLife: life, color, size });
      for (let i = 0; i < 2; i++) {
        const a = angle + this.range(-0.35, 0.35);
        this.add({
          kind: "spark",
          x,
          y,
          vx: Math.cos(a) * this.range(180, 380),
          vy: Math.sin(a) * this.range(180, 380),
          grav: 0,
          drag: 5,
          life: 0.1,
          size: 1.6,
          color: "#FFFFFF",
          rot: a,
          spin: 0,
          shrink: 1
        });
      }
    }
    /** 升级：英雄脚下金色扩散环 + 上升星点。 */
    levelUp(x, y) {
      for (let i = 0; i < 3; i++) {
        this.rings.push({
          x,
          y,
          r0: 12,
          r1: 90 + i * 28,
          life: 0.55 + i * 0.12,
          maxLife: 0.55 + i * 0.12,
          color: "#FFD54F",
          width: 3 - i * 0.6,
          filled: false
        });
      }
      for (let i = 0; i < 10; i++) {
        const a = this.range(0, Math.PI * 2);
        this.add({
          kind: "star",
          x: x + Math.cos(a) * 26,
          y: y + Math.sin(a) * 12,
          vx: Math.cos(a) * this.range(20, 70),
          vy: this.range(60, 160),
          grav: -60,
          drag: 1.2,
          life: this.range(0.4, 0.8),
          size: this.range(2, 4),
          color: "#FFD54F",
          rot: 0.6,
          spin: 2,
          shrink: 1
        });
      }
    }
    clear() {
      this.particles.length = 0;
      this.rings.length = 0;
      this.bolts.length = 0;
      this.floats.length = 0;
      this.heals.length = 0;
      this.transfers.length = 0;
      this.muzzles.length = 0;
    }
    // ---------------- 内部 ----------------
    add(p) {
      if (this.particles.length >= MAX_PARTICLES) this.particles.shift();
      this.particles.push({ ...p, maxLife: p.life });
    }
    update(dt) {
      this.clock += dt;
      if (this.shakeLeft > 0) this.shakeLeft = Math.max(0, this.shakeLeft - dt);
      for (let i = this.particles.length - 1; i >= 0; i--) {
        const p = this.particles[i];
        p.life -= dt;
        if (p.life <= 0) {
          this.particles.splice(i, 1);
          continue;
        }
        p.vy += p.grav * dt;
        if (p.drag > 0) {
          const k = Math.max(0, 1 - p.drag * dt);
          p.vx *= k;
          p.vy *= k;
        }
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.rot += p.spin * dt;
      }
      for (let i = this.rings.length - 1; i >= 0; i--) {
        this.rings[i].life -= dt;
        if (this.rings[i].life <= 0) this.rings.splice(i, 1);
      }
      for (let i = this.bolts.length - 1; i >= 0; i--) {
        this.bolts[i].life -= dt;
        if (this.bolts[i].life <= 0) this.bolts.splice(i, 1);
      }
      for (let i = this.floats.length - 1; i >= 0; i--) {
        const f = this.floats[i];
        f.life -= dt;
        if (f.life <= 0) this.floats.splice(i, 1);
      }
      for (let i = this.heals.length - 1; i >= 0; i--) {
        this.heals[i].life -= dt;
        if (this.heals[i].life <= 0) this.heals.splice(i, 1);
      }
      for (let i = this.transfers.length - 1; i >= 0; i--) {
        this.transfers[i].life -= dt;
        if (this.transfers[i].life <= 0) this.transfers.splice(i, 1);
      }
      for (let i = this.muzzles.length - 1; i >= 0; i--) {
        this.muzzles[i].life -= dt;
        if (this.muzzles[i].life <= 0) this.muzzles.splice(i, 1);
      }
    }
    /** 在 y 已翻转的游戏坐标系内绘制。 */
    draw(ctx) {
      this.drawGround(ctx);
      this.drawParticles(ctx);
      this.drawRings(ctx);
      this.drawBolts(ctx);
      this.drawMuzzles(ctx);
    }
    drawGround(ctx) {
      for (const h of this.heals) {
        const k = 1 - h.life / h.maxLife;
        const a = 1 - k;
        ctx.strokeStyle = rgba("#7CB342", 0.55 * a);
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.ellipse(h.x, h.y, h.radius * (0.35 + 0.65 * k), h.radius * (0.35 + 0.65 * k) * 0.82, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = rgba("#7CB342", 0.06 * a);
        ctx.fill();
        ctx.strokeStyle = rgba("#AEEA00", 0.35 * a);
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.ellipse(h.x, h.y, h.radius * 0.72, h.radius * 0.6, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      for (const tr of this.transfers) {
        const a = Math.min(1, tr.life / tr.maxLife);
        const seg = 3;
        const pts = [[tr.fx, tr.fy]];
        for (let i = 1; i < seg; i++) {
          const k = i / seg;
          pts.push([
            tr.fx + (tr.tx - tr.fx) * k + (hash01(i * 7.7 + tr.fx) - 0.5) * 34,
            tr.fy + (tr.ty - tr.fy) * k + (hash01(i * 3.1 + tr.fy) - 0.5) * 34
          ]);
        }
        pts.push([tr.tx, tr.ty]);
        ctx.strokeStyle = rgba("#B388FF", 0.35 * a);
        ctx.lineWidth = 6;
        ctx.beginPath();
        pts.forEach((p, i) => i === 0 ? ctx.moveTo(p[0], p[1]) : ctx.lineTo(p[0], p[1]));
        ctx.stroke();
        ctx.strokeStyle = rgba("#F5F5FA", 0.9 * a);
        ctx.lineWidth = 1.6;
        ctx.stroke();
      }
    }
    drawParticles(ctx) {
      for (const p of this.particles) {
        if (p.kind !== "shard" && p.kind !== "smoke") continue;
        const k = p.life / p.maxLife;
        ctx.globalAlpha = p.kind === "smoke" ? k * 0.34 : Math.min(1, k * 1.6);
        ctx.fillStyle = p.color;
        if (p.kind === "shard") {
          const s = p.size * (p.shrink ? 0.4 + 0.6 * k : 1);
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(p.rot);
          ctx.beginPath();
          ctx.moveTo(-s, -s * 0.55);
          ctx.lineTo(s, 0);
          ctx.lineTo(-s * 0.7, s * 0.7);
          ctx.closePath();
          ctx.fill();
          ctx.restore();
        } else {
          const s = p.size * (1 + (1 - k) * 1.6);
          ctx.beginPath();
          ctx.arc(p.x, p.y, s, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      for (const p of this.particles) {
        if (p.kind === "shard" || p.kind === "smoke") continue;
        const k = p.life / p.maxLife;
        if (p.kind === "spark") {
          const len2 = 7 + p.size * 2.2;
          ctx.strokeStyle = rgba(p.color, Math.min(1, k * 1.8));
          ctx.lineWidth = p.size * 0.8;
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(p.x - Math.cos(p.rot) * len2, p.y - Math.sin(p.rot) * len2);
          ctx.stroke();
        } else if (p.kind === "ember") {
          ctx.globalAlpha = Math.min(1, k * 1.5);
          ctx.drawImage(
            glowSprite(p.color),
            p.x - p.size * 2.6,
            p.y - p.size * 2.6,
            p.size * 5.2,
            p.size * 5.2
          );
          ctx.globalAlpha = 1;
        } else if (p.kind === "star") {
          const s = p.size * (p.shrink ? 0.3 + 0.7 * k : 1);
          ctx.strokeStyle = rgba(p.color, Math.min(1, k * 1.6));
          ctx.lineWidth = 1.6;
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(p.rot);
          ctx.beginPath();
          ctx.moveTo(-s, 0);
          ctx.lineTo(s, 0);
          ctx.moveTo(0, -s * 0.55);
          ctx.lineTo(0, s * 0.55);
          ctx.stroke();
          ctx.restore();
        }
      }
      ctx.restore();
      ctx.globalAlpha = 1;
    }
    drawRings(ctx) {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      for (const r of this.rings) {
        const k = 1 - r.life / r.maxLife;
        const a = (1 - k) * (1 - k);
        const rad = r.r0 + (r.r1 - r.r0) * (1 - Math.pow(1 - k, 2.4));
        if (r.filled) {
          const grad = ctx.createRadialGradient(r.x, r.y, 0, r.x, r.y, Math.max(1, rad));
          grad.addColorStop(0, rgba(r.color, 0.55 * a));
          grad.addColorStop(0.55, rgba(r.color, 0.22 * a));
          grad.addColorStop(1, rgba(r.color, 0));
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.arc(r.x, r.y, rad, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.strokeStyle = rgba(r.color, 0.85 * a);
          ctx.lineWidth = Math.max(0.6, r.width * (1 - k * 0.7));
          ctx.beginPath();
          ctx.arc(r.x, r.y, rad, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      ctx.restore();
    }
    drawBolts(ctx) {
      for (const b of this.bolts) {
        const a = Math.min(1, b.life / b.maxLife);
        ctx.strokeStyle = rgba(b.color, 0.3 * a);
        ctx.lineWidth = b.width * 2.2;
        ctx.beginPath();
        this.boltPath(ctx, b.pts);
        ctx.stroke();
        ctx.strokeStyle = rgba(b.color, 0.95 * a);
        ctx.lineWidth = b.width;
        ctx.beginPath();
        this.boltPath(ctx, b.pts);
        ctx.stroke();
        ctx.strokeStyle = rgba("#F5F5FA", 0.95 * a);
        ctx.lineWidth = Math.max(1, b.width * 0.35);
        ctx.beginPath();
        this.boltPath(ctx, b.pts);
        ctx.stroke();
      }
    }
    boltPath(ctx, pts) {
      let first = true;
      for (let s = 0; s < pts.length - 1; s++) {
        const [x1, y1] = pts[s];
        const [x2, y2] = pts[s + 1];
        if (first) {
          ctx.moveTo(x1, y1);
          first = false;
        }
        for (let j = 1; j <= 2; j++) {
          const k = j / 3;
          const amp = j === 2 ? 1.6 : 1;
          const jx = (hash01(s * 13.7 + j * 3.1 + x1 * 0.11) - 0.5) * 30 * amp;
          const jy = (hash01(s * 7.3 + j * 5.7 + y1 * 0.13) - 0.5) * 30 * amp;
          ctx.lineTo(x1 + (x2 - x1) * k + jx, y1 + (y2 - y1) * k + jy);
        }
        ctx.lineTo(x2, y2);
      }
    }
    drawMuzzles(ctx) {
      if (this.muzzles.length === 0) return;
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      for (const m of this.muzzles) {
        const k = m.life / m.maxLife;
        const len2 = m.size * (0.6 + 0.7 * k);
        ctx.fillStyle = rgba(m.color, 0.75 * k);
        ctx.beginPath();
        ctx.moveTo(m.x, m.y);
        ctx.lineTo(
          m.x + Math.cos(m.angle - 0.35) * len2,
          m.y + Math.sin(m.angle - 0.35) * len2
        );
        ctx.lineTo(
          m.x + Math.cos(m.angle) * len2 * 1.7,
          m.y + Math.sin(m.angle) * len2 * 1.7
        );
        ctx.lineTo(
          m.x + Math.cos(m.angle + 0.35) * len2,
          m.y + Math.sin(m.angle + 0.35) * len2
        );
        ctx.closePath();
        ctx.fill();
        ctx.drawImage(glowSprite(m.color), m.x - m.size, m.y - m.size, m.size * 2, m.size * 2);
      }
      ctx.restore();
    }
    /** 飘字需要回到未翻转坐标系绘制（否则文字倒置）。 */
    drawTexts(ctx, screenH) {
      if (this.floats.length === 0) return;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (const f of this.floats) {
        const k = f.life / f.maxLife;
        const age = 1 - k;
        const pop = 1 + f.pop * Math.exp(-age * 11);
        const alpha = Math.min(1, k * 2.2);
        const y = screenH - (f.y + age * f.vy);
        ctx.globalAlpha = alpha;
        ctx.font = `800 ${Math.round(f.size * pop)}px "PingFang SC", "Microsoft YaHei", sans-serif`;
        ctx.lineWidth = Math.max(2, f.size * 0.16);
        ctx.strokeStyle = "rgba(7,8,15,.72)";
        ctx.strokeText(f.text, f.x, y);
        ctx.fillStyle = f.color;
        ctx.fillText(f.text, f.x, y);
      }
      ctx.globalAlpha = 1;
      ctx.restore();
    }
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
    boss: "#B537F2",
    shaman: "#B388FF",
    // 虫族（酸性绿族 + 紫点缀，docs/08）
    larva: "#9CCC65",
    roach: "#7CB342",
    lurker: "#558B2F",
    zqueen: "#C77DFF",
    baneling: "#AEEA00",
    ultra: "#69A83B"
  };
  var INK = "#0B0C1D";
  function monsterColor(m) {
    return MONSTER_COLOR[m.cfg.shape ?? "slime"] ?? "#FF6B57";
  }
  function monsterColorByKey(key) {
    return MONSTER_COLOR[key] ?? "#FF6B57";
  }
  function tierOf(m) {
    if (m.cfg.shape === "boss") return 2;
    if (m.cfg.radius >= 40 || m.cfg.hp >= 500) return 1;
    return 0;
  }
  function rrPath(ctx, x, y, w, h, r) {
    const rad = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rad, y);
    ctx.arcTo(x + w, y, x + w, y + h, rad);
    ctx.arcTo(x + w, y + h, x, y + h, rad);
    ctx.arcTo(x, y + h, x, y, rad);
    ctx.arcTo(x, y, x + w, y, rad);
    ctx.closePath();
  }
  function polyPath(ctx, n, r, rot = 0, innerRatio = 1) {
    ctx.beginPath();
    for (let i = 0; i < n * 2; i++) {
      const a = Math.PI / n * i + rot - Math.PI / 2;
      const rad = i % 2 === 0 ? r : r * innerRatio;
      const px = Math.cos(a) * rad;
      const py = Math.sin(a) * rad;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
  }
  function ptsPath(ctx, pts) {
    ctx.beginPath();
    pts.forEach((p, i) => i === 0 ? ctx.moveTo(p[0], p[1]) : ctx.lineTo(p[0], p[1]));
    ctx.closePath();
  }
  function inkStroke(ctx, width = 2.2) {
    ctx.strokeStyle = INK;
    ctx.lineWidth = width;
    ctx.stroke();
  }
  function lightShape(ctx, color, alpha = 0.3, dy = 0.12) {
    ctx.save();
    ctx.translate(0, dy);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.fill();
    ctx.restore();
  }
  function drawMonster(ctx, m, t, flash = 0, squash = 1, scale = 1) {
    const r = m.cfg.radius;
    const x = m.x;
    const y = m.y;
    const color = monsterColor(m);
    const tier = tierOf(m);
    const flying = m.cfg.shape === "bat";
    if (!m.burrowed) {
      const sh = flying ? 0.62 : 0.9;
      const flap = flying ? 0.85 + 0.15 * Math.sin(t * 12 + m.phase) : 1;
      drawGroundShadow(ctx, x, y - r * (flying ? 1.5 : 0.82), r * 1.08 * flap, r * 0.4 * flap, sh);
    }
    if (!m.burrowed && tier > 0) {
      const pulse = 0.5 + 0.5 * Math.sin(t * 2.4 + m.phase);
      ctx.strokeStyle = rgba(tier === 2 ? "#B537F2" : "#FF3D71", 0.18 + 0.14 * pulse);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(x, y - r * 0.8, r * 1.35, r * 0.52, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.save();
    ctx.translate(x, y);
    if (scale !== 1) ctx.scale(scale, scale);
    const deform = Math.abs(squash - 1) > 1e-3;
    if (deform) {
      ctx.translate(0, -r);
      ctx.scale(1 / squash, squash);
      ctx.translate(0, r);
    }
    drawMonsterBody(ctx, m, t, false, tier);
    if (flash > 0) {
      ctx.save();
      ctx.globalAlpha = flash;
      drawMonsterBody(ctx, m, t, true, tier);
      ctx.restore();
    }
    ctx.restore();
  }
  function drawMonsterStatus(ctx, m, t, now, statusFx) {
    const r = m.cfg.radius;
    const freeze = statusFx?.freeze;
    const burn = statusFx?.burn;
    const shred = statusFx?.shred;
    const shield = statusFx?.shield;
    if (now < m.slowUntil && freeze?.enabled !== false) {
      const shell = freeze?.iceShell ?? 0.34;
      const spikes = Math.max(0, Math.round(freeze?.spikes ?? 6));
      const shards = Math.max(0, Math.round(freeze?.shards ?? 4));
      const sheen = freeze?.sheen ?? 0.5;
      ctx.fillStyle = rgba("#4FC3F7", shell);
      ctx.beginPath();
      ctx.arc(m.x, m.y, r * 0.96, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = rgba("#DFF6FF", shell * 0.9);
      ctx.beginPath();
      ctx.ellipse(m.x - r * 0.3, m.y + r * 0.28, r * 0.38, r * 0.22, -0.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = rgba("#BFFFF2", 0.85);
      ctx.lineWidth = 1.6;
      ctx.lineCap = "round";
      for (let i = 0; i < spikes; i++) {
        const a = Math.PI * 2 * i / Math.max(1, spikes) + m.phase * 0.15;
        const x0 = m.x + Math.cos(a) * (r + 1);
        const y0 = m.y + Math.sin(a) * (r + 1);
        const len2 = r * 0.34 + Math.sin(t * 5 + i) * 1.6;
        const x1 = x0 + Math.cos(a) * len2;
        const y1 = y0 + Math.sin(a) * len2;
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
        drawGlow(ctx, x1, y1, 4, "#BFFFF2", 0.55);
      }
      const sweep = (t * 0.55 + m.phase) % 1;
      const sx = m.x - r + 2 * r * sweep;
      ctx.save();
      ctx.globalAlpha = sheen * (1 - Math.abs(sweep - 0.5) * 1.6);
      ctx.strokeStyle = rgba("#FFFFFF", 0.8);
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(sx, m.y - r * 0.8);
      ctx.lineTo(sx, m.y + r * 0.8);
      ctx.stroke();
      ctx.restore();
      for (let i = 0; i < shards; i++) {
        const seed = m.id * 7 + i * 13;
        const k = (t * 0.5 + hash01(seed)) % 1;
        const px = m.x + (hash01(seed + 1) - 0.5) * r * 1.6;
        const py = m.y + r * 0.5 - k * r * 1.9;
        ctx.fillStyle = rgba("#DFF6FF", 0.7 * (1 - k));
        ctx.beginPath();
        ctx.arc(px, py, 1.4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    if (m.burn && m.burn.until > now && burn?.enabled !== false) {
      const fs = burn?.flameScale ?? 1.15;
      const embers = Math.max(0, Math.round(burn?.embers ?? 4));
      const smokeA = burn?.smoke ?? 0.35;
      const scorchA = burn?.scorch ?? 0.28;
      const bx = m.x;
      const by = m.y + r + 2;
      drawGlow(ctx, m.x, m.y, r * 1.5, "#FF5A3C", scorchA * (0.7 + 0.3 * Math.sin(t * 12 + m.phase)));
      const flick = Math.sin(t * 16 + m.phase);
      const h1 = (9 + flick * 3) * fs;
      ctx.fillStyle = rgba("#FF5A3C", 0.9);
      ctx.beginPath();
      ctx.moveTo(bx, by + h1 * 2);
      ctx.quadraticCurveTo(bx - 9 * fs + flick * 2, by + h1 * 0.9, bx - 2.5 * fs, by);
      ctx.quadraticCurveTo(bx, by + h1 * 0.45, bx + 3 * fs, by);
      ctx.quadraticCurveTo(bx + 9 * fs + flick * 2, by + h1 * 0.9, bx, by + h1 * 2);
      ctx.fill();
      ctx.fillStyle = rgba("#FF9A3C", 0.95);
      ctx.beginPath();
      ctx.moveTo(bx, by + h1 * 1.45);
      ctx.quadraticCurveTo(bx - 5.5 * fs - flick, by + h1 * 0.6, bx, by);
      ctx.quadraticCurveTo(bx + 5.5 * fs - flick, by + h1 * 0.6, bx, by + h1 * 1.45);
      ctx.fill();
      ctx.fillStyle = rgba("#FFF3C4", 0.95);
      ctx.beginPath();
      ctx.moveTo(bx, by + h1 * 0.95);
      ctx.quadraticCurveTo(bx - 3 * fs, by + h1 * 0.42, bx, by);
      ctx.quadraticCurveTo(bx + 3 * fs, by + h1 * 0.42, bx, by + h1 * 0.95);
      ctx.fill();
      drawGlow(ctx, bx, by + h1 * 0.6, 16 * fs, "#FF5A3C", 0.4);
      for (let i = 0; i < embers; i++) {
        const seed = m.id * 11 + i * 17;
        const k = (t * (0.8 + hash01(seed) * 0.5) + hash01(seed + 1)) % 1;
        const ex = bx + Math.sin(seed + k * 7) * r * 0.55;
        const ey = by + h1 * 0.6 + k * r * 2.2;
        ctx.fillStyle = rgba(i % 2 === 0 ? "#FFD54F" : "#FF9A3C", 0.85 * (1 - k));
        ctx.beginPath();
        ctx.arc(ex, ey, 2.2 * (1 - k * 0.5), 0, Math.PI * 2);
        ctx.fill();
      }
      for (let i = 0; i < 2; i++) {
        const seed = m.id * 5 + i * 29;
        const k = (t * 0.45 + hash01(seed)) % 1;
        const sx = bx + Math.sin(seed + k * 4) * r * 0.4;
        const sy = by + h1 * 1.2 + k * r * 2.6;
        ctx.fillStyle = rgba("#6E7796", smokeA * (1 - k) * 0.6);
        ctx.beginPath();
        ctx.arc(sx, sy, 3 + k * 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    if (now < m.shredUntil && shred?.enabled !== false) {
      const cracks = Math.max(0, Math.round(shred?.cracks ?? 3));
      const glow = shred?.glow ?? 0.4;
      drawGlow(ctx, m.x, m.y, r * 1.2, "#FF7A3C", glow * (0.6 + 0.4 * Math.sin(t * 8 + m.phase)));
      ctx.strokeStyle = rgba("#FFB357", 0.8);
      ctx.lineWidth = 1.8;
      ctx.lineCap = "round";
      for (let i = 0; i < cracks; i++) {
        const a = Math.PI * 2 * i / Math.max(1, cracks) + m.phase + 0.4;
        let px = m.x + Math.cos(a) * r * 0.9;
        let py = m.y + Math.sin(a) * r * 0.9;
        ctx.beginPath();
        ctx.moveTo(px, py);
        for (let s = 0; s < 2; s++) {
          const aa = a + Math.PI + (s % 2 === 0 ? 0.5 : -0.4);
          px += Math.cos(aa) * r * 0.3;
          py += Math.sin(aa) * r * 0.3;
          ctx.lineTo(px, py);
        }
        ctx.stroke();
      }
    }
    if (m.shieldLeft > 0 && shield?.enabled !== false) {
      const segs = Math.max(3, Math.round(shield?.segments ?? 6));
      const shown = Math.min(segs, m.shieldLeft);
      const rr = r + 6;
      for (let i = 0; i < shown; i++) {
        const a = Math.PI * 2 * i / segs - Math.PI / 2;
        const cx = m.x + Math.cos(a) * rr;
        const cy = m.y + Math.sin(a) * rr;
        ctx.strokeStyle = rgba("#C7CEE6", 0.85);
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (let k = 0; k < 6; k++) {
          const aa = Math.PI / 3 * k + t * 0.25;
          const px = cx + Math.cos(aa) * 3;
          const py = cy + Math.sin(aa) * 3;
          if (k === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.stroke();
      }
      ctx.strokeStyle = rgba("#8A93B8", 0.28);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(m.x, m.y, rr, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  function drawMonsterBody(ctx, m, t, tint, tier) {
    const r = m.cfg.radius;
    const base = monsterColor(m);
    if (m.burrowed) {
      drawBurrowed(ctx, m, t, base, tint);
      return;
    }
    const s = {
      r,
      color: tint ? "#FFFFFF" : base,
      light: tint ? "#FFFFFF" : lighten(base, 0.34),
      dark: tint ? "#FFFFFF" : darken(base, 0.4),
      deco: !tint,
      flat: tint,
      tier
    };
    ctx.save();
    switch (m.cfg.shape) {
      case "larva":
        drawLarva(ctx, m, t, s);
        break;
      case "roach":
        drawRoach(ctx, m, t, s);
        break;
      case "lurker":
        drawLurker(ctx, m, t, s);
        break;
      case "zqueen":
        drawZergQueen(ctx, m, t, s);
        break;
      case "baneling":
        drawBaneling(ctx, m, t, s);
        break;
      case "ultra":
        drawUltra(ctx, m, t, s);
        break;
      case "wolf":
        drawWolf(ctx, m, t, s);
        break;
      case "charger":
        drawCharger(ctx, m, t, s);
        break;
      case "thrower":
        drawThrower(ctx, m, t, s);
        break;
      case "catapult":
        drawThrower(ctx, m, t, s);
        break;
      case "bulwark":
        drawBulwark(ctx, m, t, s);
        break;
      case "bat":
        drawBat(ctx, m, t, s);
        break;
      case "shroom":
        drawShroom(ctx, m, t, s);
        break;
      case "boss":
        drawBossTreant(ctx, m, t, s);
        break;
      case "shaman":
        drawShaman(ctx, m, t, s);
        break;
      case "slime":
      default:
        drawSlime(ctx, m, t, s);
        break;
    }
    ctx.restore();
  }
  function walkBob(m, t, freq = 6, amp = 0.1) {
    if (m.state !== "march") return 0;
    return Math.abs(Math.sin(t * freq + m.phase)) * m.cfg.radius * amp;
  }
  function drawSlime(ctx, m, t, s) {
    const { r, color, light, dark, deco } = s;
    const moving = m.state === "march";
    const hop = moving ? Math.abs(Math.sin(t * 3.6 + m.phase)) : 0;
    const sq = 1 + 0.13 * Math.sin(t * 7.2 + m.phase) * (moving ? 1 : 0.4);
    ctx.translate(0, hop * r * 0.34 + (moving ? 0 : Math.sin(t * 2 + m.phase) * 1.2));
    ctx.scale(1 / sq, sq);
    rrPath(ctx, -r, -r, r * 2, r * 2, r * 0.46);
    ctx.fillStyle = s.flat ? "#FFFFFF" : color;
    ctx.fill();
    if (deco) {
      inkStroke(ctx, 2.4);
      rrPath(ctx, -r * 0.94, -r * 0.94, r * 1.88, r * 1.88, r * 0.42);
      ctx.strokeStyle = rgba("#FFFFFF", 0.35);
      ctx.lineWidth = 2.2;
      ctx.stroke();
      rrPath(ctx, -r * 0.78, -r * 0.62, r * 1.56, r * 1.42, r * 0.4);
      lightShape(ctx, light, 0.4);
      ctx.fillStyle = rgba("#FFFFFF", 0.3);
      ctx.beginPath();
      ctx.ellipse(-r * 0.34, r * 0.4, r * 0.3, r * 0.19, -0.5, 0, Math.PI * 2);
      ctx.fill();
      for (let i = 0; i < 3; i++) {
        const ph = i * 2.1 + m.phase;
        const bx = Math.sin(t * 0.9 + ph) * r * 0.42;
        const by = (t * 0.22 + i * 0.31) % 1 * r * 1.2 - r * 0.6;
        ctx.fillStyle = rgba(light, 0.35);
        ctx.beginPath();
        ctx.arc(bx, by, 2.2 - i * 0.4, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = rgba(dark, 0.22);
      ctx.beginPath();
      ctx.ellipse(0, -r * 0.66, r * 0.62, r * 0.2, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  function drawWolf(ctx, m, t, s) {
    const { r, color, light, dark, deco } = s;
    const cyc = m.state === "march" ? m.phase % 2.2 : 0;
    const winding = cyc < 0.4;
    const rushing = cyc >= 0.4 && cyc < 0.9;
    const lean = rushing ? 1.16 : winding ? 0.94 : 1;
    ctx.translate(0, walkBob(m, t, 9, 0.06));
    ctx.scale(1 / Math.sqrt(lean), lean);
    if (rushing && deco) {
      for (let i = 2; i >= 1; i--) {
        ctx.fillStyle = rgba(color, 0.16 * (3 - i));
        ctx.save();
        ctx.translate(0, i * 9);
        ptsPath(ctx, [
          [0, -r * 1.05],
          [-r * 0.82, r * 0.62],
          [0, r * 0.3],
          [r * 0.82, r * 0.62]
        ]);
        ctx.fill();
        ctx.restore();
      }
    }
    const wag = Math.sin(t * 9 + m.phase) * r * 0.4;
    ctx.strokeStyle = s.flat ? "#FFFFFF" : light;
    ctx.lineCap = "round";
    ctx.lineWidth = 3.4;
    ctx.beginPath();
    ctx.moveTo(0, r * 0.45);
    ctx.quadraticCurveTo(r * 0.55 + wag * 0.3, r * 0.95, r * 0.95 + wag, r * 1.35);
    ctx.stroke();
    if (deco) {
      ctx.strokeStyle = rgba(dark, 0.5);
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(0, -r * 1.12);
    ctx.quadraticCurveTo(-r * 0.36, -r * 0.42, -r * 0.86, r * 0.6);
    ctx.lineTo(-r * 0.4, r * 0.5);
    ctx.lineTo(0, r * 0.66);
    ctx.lineTo(r * 0.4, r * 0.5);
    ctx.lineTo(r * 0.86, r * 0.6);
    ctx.quadraticCurveTo(r * 0.36, -r * 0.42, 0, -r * 1.12);
    ctx.closePath();
    ctx.fillStyle = s.flat ? "#FFFFFF" : color;
    ctx.fill();
    for (const sx of [-1, 1]) {
      ptsPath(ctx, [
        [sx * r * 0.58, r * 0.16],
        [sx * r * 0.98, r * 0.92],
        [sx * r * 0.18, r * 0.52]
      ]);
      ctx.fillStyle = s.flat ? "#FFFFFF" : color;
      ctx.fill();
      if (deco) {
        inkStroke(ctx, 1.2);
        ctx.fillStyle = rgba(lighten(color, 0.25), 0.55);
        ctx.beginPath();
        ctx.moveTo(sx * r * 0.58, r * 0.3);
        ctx.lineTo(sx * r * 0.82, r * 0.8);
        ctx.lineTo(sx * r * 0.34, r * 0.52);
        ctx.closePath();
        ctx.fill();
      }
    }
    if (deco) {
      inkStroke(ctx, 2.3);
      ctx.strokeStyle = rgba(light, 0.5);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, -r * 0.9);
      ctx.lineTo(0, r * 0.42);
      ctx.stroke();
      const eyeColor = rushing ? "#FF3D71" : "#F5F5FA";
      const eyeGlow = rushing ? 0.9 : 0.35;
      for (const sx of [-1, 1]) {
        ctx.save();
        ctx.translate(sx * r * 0.3, -r * 0.34);
        ctx.rotate(sx * 0.5);
        ctx.fillStyle = eyeColor;
        ctx.beginPath();
        ctx.ellipse(0, 0, r * 0.17, r * 0.075, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        if (rushing) drawGlow(ctx, sx * r * 0.3, -r * 0.34, r * 0.5, "#FF3D71", eyeGlow);
      }
    }
    if (winding && deco) {
      const k = cyc / 0.4;
      ctx.strokeStyle = rgba("#FF3D71", 0.35 + 0.3 * Math.sin(t * 30));
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(0, r * 0.75, r * (1.15 - k * 0.25), r * 0.3, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  function drawCharger(ctx, m, t, s) {
    const { r, color, light, deco } = s;
    const moving = m.state === "march";
    if (moving && deco) {
      for (let i = 0; i < 3; i++) {
        const len2 = r * (1.6 + i * 0.7);
        const xo = (i - 1) * r * 0.28;
        ctx.strokeStyle = rgba(light, 0.34 - i * 0.08);
        ctx.lineWidth = 2 - i * 0.4;
        ctx.beginPath();
        ctx.moveTo(xo, r + 4);
        ctx.lineTo(xo, r + 4 + len2);
        ctx.stroke();
      }
      for (let i = 3; i >= 1; i--) {
        const k = 1 - i / 4;
        ctx.fillStyle = rgba(color, 0.2 * k);
        ptsPath(ctx, [
          [0, -r * 1.35 * (1 - i * 0.08)],
          [-r * 0.42, r * (0.9 + i * 0.75)],
          [r * 0.42, r * (0.9 + i * 0.75)]
        ]);
        ctx.fill();
      }
    }
    ptsPath(ctx, [
      [0, -r * 1.5],
      [r * 0.46, r * 0.18],
      [r * 0.16, r * 0.5],
      [r * 0.72, r * 1],
      [0, r * 0.72],
      [-r * 0.72, r * 1],
      [-r * 0.16, r * 0.5],
      [-r * 0.46, r * 0.18]
    ]);
    ctx.fillStyle = s.flat ? "#FFFFFF" : color;
    ctx.fill();
    if (deco) {
      inkStroke(ctx, 2.2);
      ctx.fillStyle = rgba(light, 0.8);
      ptsPath(ctx, [
        [0, -r * 1.42],
        [-r * 0.14, -r * 0.62],
        [r * 0.14, -r * 0.62]
      ]);
      ctx.fill();
      ctx.fillStyle = INK;
      ctx.beginPath();
      ctx.ellipse(0, -r * 0.16, r * 0.13, r * 0.22, 0, 0, Math.PI * 2);
      ctx.fill();
      drawGlow(ctx, 0, -r * 1.2, r * 0.85, light, 0.28);
    }
  }
  function drawThrower(ctx, m, t, s) {
    const { r, color, light, dark, deco } = s;
    const heavy = r >= 24;
    const assault = m.state === "assault";
    const interval = Math.max(1e-3, m.cfg.attackInterval);
    const wind = assault ? Math.min(1, 1 - m.attackTimer / interval) : 0;
    const pull = assault ? Math.sin(Math.min(1, wind) * Math.PI) : 0;
    ctx.translate(0, walkBob(m, t, 5, 0.05));
    if (heavy) {
      rrPath(ctx, -r * 0.85, -r * 0.75, r * 1.7, r * 0.5, r * 0.18);
      ctx.fillStyle = s.flat ? "#FFFFFF" : darken(color, 0.35);
      ctx.fill();
      if (deco) inkStroke(ctx, 2);
      for (const sx of [-0.55, 0.55]) {
        ctx.beginPath();
        ctx.arc(sx * r, -r * 0.72, r * 0.3, 0, Math.PI * 2);
        ctx.fillStyle = s.flat ? "#FFFFFF" : lighten(color, 0.15);
        ctx.fill();
        if (deco) {
          inkStroke(ctx, 2);
          ctx.strokeStyle = rgba(INK, 0.55);
          ctx.lineWidth = 1.8;
          const spin = t * 2.4 + sx;
          for (let k = 0; k < 3; k++) {
            const a = spin + k * Math.PI / 3;
            ctx.beginPath();
            ctx.moveTo(sx * r - Math.cos(a) * r * 0.26, -r * 0.72 - Math.sin(a) * r * 0.26);
            ctx.lineTo(sx * r + Math.cos(a) * r * 0.26, -r * 0.72 + Math.sin(a) * r * 0.26);
            ctx.stroke();
          }
          ctx.beginPath();
          ctx.arc(sx * r, -r * 0.72, r * 0.07, 0, Math.PI * 2);
          ctx.fillStyle = rgba(INK, 0.7);
          ctx.fill();
        }
      }
      ctx.save();
      ctx.translate(0, -r * 0.05);
      ctx.rotate(-Math.PI / 2 + pull * 1.5);
      rrPath(ctx, 0, -r * 0.12, r * 1.45, r * 0.22, r * 0.1);
      ctx.fillStyle = s.flat ? "#FFFFFF" : color;
      ctx.fill();
      if (deco) inkStroke(ctx, 1.8);
      ctx.beginPath();
      ctx.arc(r * 1.5, 0, r * 0.2, 0, Math.PI * 2);
      ctx.fillStyle = s.flat ? "#FFFFFF" : light;
      ctx.fill();
      if (deco) {
        inkStroke(ctx, 1.5);
        ctx.strokeStyle = rgba(INK, 0.35);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(r * 1.5, 0, r * 0.12, 0.3, 2.4);
        ctx.stroke();
      }
      if (deco) {
        ctx.fillStyle = rgba(INK, 0.5);
        rrPath(ctx, -r * 0.28, -r * 0.1, r * 0.26, r * 0.2, r * 0.06);
        ctx.fill();
      }
      ctx.restore();
      rrPath(ctx, -r * 0.58, -r * 0.52, r * 1.16, r * 1.12, r * 0.16);
      ctx.fillStyle = s.flat ? "#FFFFFF" : color;
      ctx.fill();
      if (deco) {
        inkStroke(ctx, 2.4);
        ctx.strokeStyle = rgba(INK, 0.35);
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(-r * 0.52, r * 0.16);
        ctx.lineTo(r * 0.52, r * 0.16);
        ctx.moveTo(-r * 0.52, -r * 0.2);
        ctx.lineTo(r * 0.52, -r * 0.2);
        ctx.stroke();
        ctx.fillStyle = rgba(light, 0.9);
        for (const sx of [-0.42, 0.42]) {
          for (const sy of [-0.38, 0.42]) {
            ctx.beginPath();
            ctx.arc(sx * r, sy * r, r * 0.045, 0, Math.PI * 2);
            ctx.fill();
          }
        }
        ctx.fillStyle = rgba("#FFD54F", 0.85);
        ctx.beginPath();
        ctx.arc(0, r * 0.16, r * 0.14, 0, Math.PI * 2);
        ctx.fill();
        drawGlow(ctx, 0, r * 0.16, r * 0.55, "#FFD54F", 0.32);
      }
      return;
    }
    ctx.save();
    ctx.translate(r * 0.42, -r * 0.1);
    ctx.rotate(-0.22 + pull * 0.9);
    ctx.strokeStyle = s.flat ? "#FFFFFF" : light;
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(0, -r * 1.25);
    ctx.lineTo(0, r * 0.85);
    ctx.stroke();
    if (deco) {
      ctx.fillStyle = "#F5F5FA";
      ptsPath(ctx, [
        [0, -r * 1.55],
        [-r * 0.12, -r * 1.15],
        [r * 0.12, -r * 1.15]
      ]);
      ctx.fill();
      inkStroke(ctx, 1.2);
      ctx.strokeStyle = rgba(INK, 0.6);
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(-r * 0.1, r * 0.7);
      ctx.lineTo(0, r * 0.9);
      ctx.lineTo(r * 0.1, r * 0.7);
      ctx.stroke();
    }
    ctx.restore();
    ptsPath(ctx, [
      [-r * 0.72, r * 0.82],
      [-r * 0.5, -r * 0.25],
      [0, -r * 0.78],
      [r * 0.5, -r * 0.25],
      [r * 0.72, r * 0.82]
    ]);
    ctx.fillStyle = s.flat ? "#FFFFFF" : color;
    ctx.fill();
    if (deco) {
      inkStroke(ctx, 2.2);
      ctx.fillStyle = rgba(light, 0.5);
      ptsPath(ctx, [
        [-r * 0.5, r * 0.05],
        [0, -r * 0.8],
        [r * 0.5, r * 0.05]
      ]);
      ctx.fill();
      ctx.strokeStyle = rgba(INK, 0.45);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(-r * 0.62, r * 0.42);
      ctx.lineTo(r * 0.66, r * 0.42);
      ctx.stroke();
      const eye = assault && wind > 0.55 ? "#FF3D71" : "#FFD54F";
      ctx.fillStyle = eye;
      for (const sx of [-1, 1]) {
        ctx.beginPath();
        ctx.arc(sx * r * 0.22, -r * 0.34, r * 0.085, 0, Math.PI * 2);
        ctx.fill();
      }
      if (assault) drawGlow(ctx, 0, -r * 0.34, r * 0.6, eye, 0.25);
    }
  }
  function drawBulwark(ctx, m, t, s) {
    const { r, color, light, dark, deco } = s;
    const heavy = s.tier > 0;
    ctx.translate(0, walkBob(m, t, 4.5, 0.045));
    for (const sx of [-1, 1]) {
      const step = Math.sin(t * 4.2 + m.phase + (sx > 0 ? Math.PI : 0)) * r * 0.16;
      ptsPath(ctx, [
        [sx * r * 0.28, -r * 0.5],
        [sx * r * 0.62, -r * 0.5],
        [sx * r * 0.66, -r * 0.95 + step],
        [sx * r * 0.34, -r * 0.95 + step]
      ]);
      ctx.fillStyle = s.flat ? "#FFFFFF" : darken(color, 0.25);
      ctx.fill();
      if (deco) inkStroke(ctx, 1.8);
    }
    polyPath(ctx, 6, r, Math.PI / 6);
    ctx.fillStyle = s.flat ? "#FFFFFF" : color;
    ctx.fill();
    if (s.flat && heavy) {
      for (let i = -1; i <= 1; i++) {
        ptsPath(ctx, [
          [i * r * 0.34 - r * 0.1, r * 0.86],
          [i * r * 0.34, r * 1.2],
          [i * r * 0.34 + r * 0.1, r * 0.86]
        ]);
        ctx.fillStyle = "#FFFFFF";
        ctx.fill();
      }
    }
    if (deco) {
      inkStroke(ctx, 2.4);
      polyPath(ctx, 6, r * 0.7, Math.PI / 6);
      ctx.strokeStyle = rgba(INK, 0.45);
      ctx.lineWidth = 2;
      ctx.stroke();
      polyPath(ctx, 6, r * 0.42, Math.PI / 6);
      ctx.fillStyle = rgba(dark, 0.35);
      ctx.fill();
      for (let i = 0; i < 6; i++) {
        const a = Math.PI / 3 * i + Math.PI / 6;
        ctx.fillStyle = rgba(light, 0.65);
        ctx.beginPath();
        ctx.arc(Math.cos(a) * r * 0.82, Math.sin(a) * r * 0.82, r * 0.07, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = rgba(light, 0.16);
      polyPath(ctx, 6, r * 0.62, Math.PI / 6);
      ctx.save();
      ctx.translate(0, r * 0.16);
      ctx.fill();
      ctx.restore();
      const shieldK = m.shieldLeft > 0 ? 1 : 0.35;
      ctx.strokeStyle = rgba(light, 0.4 + 0.4 * shieldK);
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(0, 0, r * 1.02, Math.PI * 1.18, Math.PI * 1.82);
      ctx.stroke();
      if (m.shieldLeft > 0) {
        ctx.strokeStyle = rgba("#F5F5FA", 0.5 + 0.3 * Math.sin(t * 6));
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(0, 0, r * 1.12, Math.PI * 1.22, Math.PI * 1.78);
        ctx.stroke();
      }
      if (heavy) {
        polyPath(ctx, 6, r * (1.14 + 0.02 * Math.sin(t * 3 + m.phase)), Math.PI / 6);
        ctx.strokeStyle = rgba(light, 0.22 + 0.18 * Math.sin(t * 3 + m.phase));
        ctx.lineWidth = 2.4;
        ctx.stroke();
        for (let i = -1; i <= 1; i++) {
          ptsPath(ctx, [
            [i * r * 0.34 - r * 0.1, r * 0.86],
            [i * r * 0.34, r * 1.2],
            [i * r * 0.34 + r * 0.1, r * 0.86]
          ]);
          ctx.fillStyle = light;
          ctx.fill();
          inkStroke(ctx, 1.4);
        }
      }
    }
  }
  function drawBat(ctx, m, t, s) {
    const { r, color, light, deco } = s;
    const flap = Math.sin(t * 13 + m.phase);
    const bob = Math.sin(t * 4 + m.phase) * r * 0.18;
    ctx.translate(0, r * 0.9 + bob);
    for (const sx of [-1, 1]) {
      ctx.save();
      ctx.scale(sx, 1);
      ctx.rotate(flap * 0.5);
      ptsPath(ctx, [
        [0, 0],
        [r * 1.02, r * 0.28],
        [r * 1.5, r * 0.52],
        [r * 1.16, r * 0.1],
        [r * 0.88, r * 0.18],
        [r * 0.42, -r * 0.2]
      ]);
      ctx.fillStyle = s.flat ? "#FFFFFF" : color;
      ctx.fill();
      if (deco) {
        inkStroke(ctx, 1.9);
        ptsPath(ctx, [
          [r * 0.9, r * 0.02],
          [r * 1.72, r * 0.18],
          [r * 1.32, r * 0.72]
        ]);
        ctx.fillStyle = rgba(light, 0.9);
        ctx.fill();
        inkStroke(ctx, 1.4);
        ctx.strokeStyle = rgba(INK, 0.35);
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(r * 1.42, r * 0.4);
        ctx.moveTo(0, 0);
        ctx.lineTo(r * 1, -r * 0.36);
        ctx.stroke();
      }
      ctx.restore();
    }
    ptsPath(ctx, [
      [0, -r * 0.6],
      [r * 0.34, 0],
      [0, r * 0.55],
      [-r * 0.34, 0]
    ]);
    ctx.fillStyle = s.flat ? "#FFFFFF" : darken(color, 0.4);
    ctx.fill();
    if (deco) {
      inkStroke(ctx, 1.9);
      ctx.fillStyle = "#FF3D71";
      for (const sx of [-1, 1]) {
        ctx.beginPath();
        ctx.arc(sx * r * 0.12, -r * 0.16, r * 0.075, 0, Math.PI * 2);
        ctx.fill();
      }
      drawGlow(ctx, 0, -r * 0.16, r * 0.5, "#FF3D71", 0.35);
    }
  }
  function drawShroom(ctx, m, t, s) {
    const { r, color, light, dark, deco } = s;
    const wob = Math.sin(t * 2.6 + m.phase) * 0.07;
    ctx.translate(0, walkBob(m, t, 3.6, 0.05));
    ctx.rotate(wob);
    rrPath(ctx, -r * 0.34, -r * 0.92, r * 0.68, r * 1.02, r * 0.22);
    ctx.fillStyle = s.flat ? "#FFFFFF" : darken(lighten(color, 0.22), 0.06);
    ctx.fill();
    if (deco) inkStroke(ctx, 1.9);
    ctx.beginPath();
    ctx.moveTo(-r * 1.02, r * 0.12);
    ctx.quadraticCurveTo(-r * 0.96, r * 1.05, 0, r * 1.05);
    ctx.quadraticCurveTo(r * 0.96, r * 1.05, r * 1.02, r * 0.12);
    ctx.quadraticCurveTo(0, r * 0.34, -r * 1.02, r * 0.12);
    ctx.closePath();
    ctx.fillStyle = s.flat ? "#FFFFFF" : color;
    ctx.fill();
    if (deco) {
      inkStroke(ctx, 2.3);
      ctx.strokeStyle = rgba("#FFFFFF", 0.4);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, r * 0.12, r * 0.78, Math.PI * 1.12, Math.PI * 1.88);
      ctx.stroke();
      for (const [px, py, pr] of [
        [-r * 0.36, r * 0.62, r * 0.17],
        [r * 0.28, r * 0.74, r * 0.13],
        [r * 0.6, r * 0.42, r * 0.1]
      ]) {
        ctx.fillStyle = rgba("#F5F5FA", 0.5);
        ctx.beginPath();
        ctx.arc(px, py, pr, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.strokeStyle = rgba(INK, 0.3);
      ctx.lineWidth = 1.4;
      for (let i = 1; i <= 4; i++) {
        const x = -r * 0.9 + r * 1.8 * i / 5;
        ctx.beginPath();
        ctx.moveTo(x, r * 0.2);
        ctx.lineTo(x * 0.9, -r * 0.02);
        ctx.stroke();
      }
      for (let i = 0; i < 4; i++) {
        const k = (t * 0.22 + i * 0.27) % 1;
        const sx = Math.sin(t * 0.8 + i * 2.1) * r * 0.7;
        ctx.fillStyle = rgba(light, (1 - k) * 0.55);
        ctx.beginPath();
        ctx.arc(sx, r * 1.15 + k * r * 1.5, 1.8 + (1 - k) * 1.4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  function drawShaman(ctx, m, t, s) {
    const { r, color, light, dark, deco } = s;
    const bob = Math.sin(t * 2.4 + m.phase) * r * 0.05;
    ctx.translate(0, bob);
    ctx.beginPath();
    ctx.moveTo(0, -r * 1.15);
    ctx.quadraticCurveTo(r * 0.55, -r * 0.5, r * 0.82, r * 0.1);
    ctx.quadraticCurveTo(r * 0.7, r * 0.9, 0, r * 1.02);
    ctx.quadraticCurveTo(-r * 0.7, r * 0.9, -r * 0.82, r * 0.1);
    ctx.quadraticCurveTo(-r * 0.55, -r * 0.5, 0, -r * 1.15);
    ctx.closePath();
    ctx.fillStyle = s.flat ? "#FFFFFF" : color;
    ctx.fill();
    if (deco) {
      inkStroke(ctx, 2.3);
      ctx.fillStyle = rgba(INK, 0.55);
      ctx.beginPath();
      ctx.ellipse(0, -r * 0.42, r * 0.3, r * 0.38, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#F5F5FA";
      for (const sx of [-1, 1]) {
        ctx.beginPath();
        ctx.arc(sx * r * 0.12, -r * 0.42, r * 0.06, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.strokeStyle = rgba(light, 0.7);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(-r * 0.6, r * 0.24);
      ctx.lineTo(r * 0.6, r * 0.24);
      ctx.stroke();
      ptsPath(ctx, [
        [0, r * 0.5],
        [r * 0.14, r * 0.68],
        [0, r * 0.86],
        [-r * 0.14, r * 0.68]
      ]);
      ctx.fillStyle = rgba("#B388FF", 0.9);
      ctx.fill();
      drawGlow(ctx, 0, r * 0.68, r * 0.5, "#B388FF", 0.4);
      ctx.fillStyle = rgba(dark, 0.3);
      ctx.beginPath();
      ctx.ellipse(0, r * 0.92, r * 0.5, r * 0.12, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    const orbBob = Math.sin(t * 3 + m.phase) * 4;
    ctx.strokeStyle = s.flat ? "#FFFFFF" : darken(light, 0.1);
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(r * 0.86, r * 0.9);
    ctx.lineTo(r * 0.86, -r * 0.95 + orbBob);
    ctx.stroke();
    if (deco) {
      ctx.beginPath();
      ctx.arc(r * 0.86, -r * 1.08 + orbBob, r * 0.17, 0, Math.PI * 2);
      ctx.fillStyle = "#E9D5FF";
      ctx.fill();
      inkStroke(ctx, 1.4);
      drawGlow(ctx, r * 0.86, -r * 1.08 + orbBob, r * 0.75, "#B388FF", 0.55);
      for (let i = 0; i < 2; i++) {
        const a = t * 1.8 + i * Math.PI;
        ptsPath(ctx, [
          [
            r * 0.86 + Math.cos(a) * r * 0.34,
            -r * 1.08 + orbBob + Math.sin(a) * r * 0.24
          ],
          [
            r * 0.86 + Math.cos(a) * r * 0.34 + 2.4,
            -r * 1.08 + orbBob + Math.sin(a) * r * 0.24
          ],
          [
            r * 0.86 + Math.cos(a) * r * 0.34,
            -r * 1.08 + orbBob + Math.sin(a) * r * 0.24 + 4
          ]
        ]);
        ctx.fillStyle = rgba("#B388FF", 0.7);
        ctx.fill();
      }
    }
  }
  function drawLarva(ctx, m, t, s) {
    const { r, color, light, dark, deco } = s;
    const wig = Math.sin(t * 8 + m.phase) * 0.12;
    ctx.rotate(wig);
    for (let i = 0; i < 3; i++) {
      const seg = 1 - i * 0.22;
      ctx.beginPath();
      ctx.ellipse(0, (i - 1) * r * 0.5, r * 0.62 * seg, r * 0.52 * seg, 0, 0, Math.PI * 2);
      ctx.fillStyle = s.flat ? "#FFFFFF" : i === 0 ? lighten(color, 0.15) : color;
      ctx.fill();
      if (deco) {
        ctx.strokeStyle = rgba(dark, 0.65);
        ctx.lineWidth = 1.4;
        ctx.stroke();
      }
    }
    if (deco) {
      ctx.strokeStyle = rgba(light, 0.9);
      ctx.lineWidth = 1.2;
      for (const sx of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(sx * r * 0.3, -r * 0.75);
        ctx.quadraticCurveTo(sx * r * 0.7, -r * 1.1, sx * r * 0.55, -r * 1.45);
        ctx.stroke();
      }
      for (const sx of [-1, 1]) {
        ctx.fillStyle = INK;
        ctx.beginPath();
        ctx.arc(sx * r * 0.2, -r * 0.6, r * 0.1, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = rgba(light, 0.3);
      ctx.beginPath();
      ctx.ellipse(-r * 0.2, r * 0.1, r * 0.22, r * 0.12, -0.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  function drawRoach(ctx, m, t, s) {
    const { r, color, light, dark, deco } = s;
    ctx.translate(0, walkBob(m, t, 10, 0.03));
    if (deco) {
      ctx.strokeStyle = rgba(dark, 0.9);
      ctx.lineWidth = 2;
      ctx.lineCap = "round";
      for (let i = 0; i < 3; i++) {
        for (const sx of [-1, 1]) {
          const y = (i - 1) * r * 0.42;
          const step = Math.sin(t * 10 + i * 1.4 + (sx > 0 ? Math.PI : 0)) * r * 0.16;
          ctx.beginPath();
          ctx.moveTo(sx * r * 0.5, y);
          ctx.lineTo(sx * (r * 0.95 + step), y + r * 0.3);
          ctx.stroke();
        }
      }
    }
    ctx.beginPath();
    ctx.ellipse(0, 0, r, r * 0.74, 0, 0, Math.PI * 2);
    ctx.fillStyle = s.flat ? "#FFFFFF" : color;
    ctx.fill();
    if (deco) {
      inkStroke(ctx, 2.2);
      ctx.strokeStyle = rgba("#FFFFFF", 0.3);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(0, 0, r * 0.86, r * 0.62, 0, Math.PI * 1.15, Math.PI * 1.85);
      ctx.stroke();
      ctx.strokeStyle = rgba(dark, 0.7);
      ctx.lineWidth = 1.8;
      for (let i = -1; i <= 1; i++) {
        ctx.beginPath();
        ctx.ellipse(0, i * r * 0.3, r * (0.86 - Math.abs(i) * 0.14), r * 0.5, 0, Math.PI * 0.08, Math.PI * 0.92);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.ellipse(0, -r * 0.62, r * 0.32, r * 0.24, 0, 0, Math.PI * 2);
      ctx.fillStyle = darken(color, 0.2);
      ctx.fill();
      inkStroke(ctx, 1.6);
      for (const sx of [-1, 1]) {
        ctx.fillStyle = "#FFD54F";
        ctx.beginPath();
        ctx.arc(sx * r * 0.13, -r * 0.64, r * 0.06, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = rgba(light, 0.22);
      ctx.beginPath();
      ctx.ellipse(-r * 0.24, r * 0.18, r * 0.44, r * 0.24, -0.3, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  function drawLurker(ctx, m, t, s) {
    const { r, color, light, dark, deco } = s;
    ctx.fillStyle = s.flat ? "#FFFFFF" : darken(color, 0.45);
    ctx.beginPath();
    ctx.ellipse(0, r * 0.75, r * 0.95, r * 0.32, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(0, r * 1.35);
    ctx.lineTo(-r * 0.42, r * 0.5);
    ctx.lineTo(-r * 0.2, r * 0.58);
    ctx.lineTo(-r * 0.42, -r * 0.25);
    ctx.lineTo(0, -r * 1.05);
    ctx.lineTo(r * 0.42, -r * 0.25);
    ctx.lineTo(r * 0.2, r * 0.58);
    ctx.lineTo(r * 0.42, r * 0.5);
    ctx.closePath();
    ctx.fillStyle = s.flat ? "#FFFFFF" : color;
    ctx.fill();
    if (deco) {
      inkStroke(ctx, 2.1);
      ctx.strokeStyle = rgba(light, 0.45);
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(0, -r * 0.9);
      ctx.lineTo(0, r * 0.75);
      ctx.stroke();
      ctx.strokeStyle = rgba("#F5F5FA", 0.35);
      ctx.beginPath();
      ctx.moveTo(-r * 0.18, -r * 0.2);
      ctx.lineTo(-r * 0.28, r * 0.5);
      ctx.stroke();
    }
  }
  function drawZergQueen(ctx, m, t, s) {
    const { r, color, light, dark, deco } = s;
    const aura = m.cfg.healAura;
    if (aura && deco) {
      const total = Math.max(1e-3, aura.interval);
      const k = Math.min(1, Math.max(0, 1 - m.healTimer / total));
      const eased = 1 - Math.pow(1 - k, 3);
      const ringR = r * 1.2 + (aura.radius - r * 1.2) * eased;
      drawGroundShadow(ctx, 0, -r * 0.75, aura.radius * 0.9, aura.radius * 0.36, 0.35 * (0.6 + 0.4 * k));
      drawGlow(ctx, 0, -r * 0.7, aura.radius, "#7CB342", 0.05 + 0.07 * (1 - k));
      ctx.strokeStyle = rgba("#7CB342", 0.18 + 0.4 * k);
      ctx.lineWidth = 2.4 - 1.4 * k;
      ctx.beginPath();
      ctx.ellipse(0, -r * 0.75, ringR, ringR * 0.42, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = rgba("#AEEA00", 0.2 + 0.3 * k);
      ctx.lineWidth = 1.4;
      for (let i = 0; i < 8; i++) {
        const a = Math.PI * 2 * i / 8 + t * 0.2;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * ringR * 0.94, -r * 0.75 + Math.sin(a) * ringR * 0.4);
        ctx.lineTo(Math.cos(a) * ringR, -r * 0.75 + Math.sin(a) * ringR * 0.42);
        ctx.stroke();
      }
      const n = Math.min(6, Math.max(3, Math.round(aura.radius / 60)));
      for (let i = 0; i < n; i++) {
        const a = Math.PI * 2 * i / n + t * 0.45 + m.phase;
        const rise = (t * 0.18 + i * 0.37) % 1;
        const rr2 = ringR * (0.35 + 0.62 * rise);
        const px = Math.cos(a) * rr2;
        const py = -r * 0.75 + Math.sin(a) * rr2 * 0.42 + rise * r * 1.4;
        ctx.fillStyle = rgba("#AEEA00", (1 - rise) * 0.55 * (0.35 + 0.65 * k));
        ctx.beginPath();
        ctx.arc(px, py, 2.4 - 1 * rise, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    const bob = Math.sin(t * 2 + m.phase) * r * 0.08;
    ctx.translate(0, bob);
    for (const sx of [-1, 1]) {
      ctx.save();
      ctx.scale(sx, 1);
      ctx.rotate(Math.sin(t * 3 + m.phase) * 0.12);
      ptsPath(ctx, [
        [r * 0.2, r * 0.1],
        [r * 1.15, r * 0.55],
        [r * 0.95, -r * 0.35],
        [r * 0.3, -r * 0.2]
      ]);
      ctx.fillStyle = s.flat ? "#FFFFFF" : rgba(light, 0.18);
      ctx.fill();
      if (deco) {
        ctx.strokeStyle = rgba(light, 0.4);
        ctx.lineWidth = 1.2;
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(r * 0.25, r * 0.05);
        ctx.lineTo(r * 1.05, r * 0.45);
        ctx.moveTo(r * 0.25, r * 0.05);
        ctx.lineTo(r * 0.9, -r * 0.28);
        ctx.stroke();
      }
      ctx.restore();
    }
    polyPath(ctx, 6, r * 0.82, Math.PI / 6);
    ctx.fillStyle = s.flat ? "#FFFFFF" : color;
    ctx.fill();
    if (deco) {
      inkStroke(ctx, 2.3);
      ctx.beginPath();
      ctx.ellipse(0, r * 0.34, r * 0.52, r * 0.44, 0, 0, Math.PI * 2);
      ctx.fillStyle = rgba(dark, 0.3);
      ctx.fill();
      for (let i = 0; i < 3; i++) {
        ctx.fillStyle = rgba("#AEEA00", 0.55);
        ctx.beginPath();
        ctx.arc(Math.sin(i * 2.2) * r * 0.2, r * 0.34 + (i - 1) * r * 0.18, r * 0.1, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.beginPath();
      ctx.ellipse(0, -r * 0.7, r * 0.34, r * 0.28, 0, 0, Math.PI * 2);
      ctx.fillStyle = darken(color, 0.25);
      ctx.fill();
      inkStroke(ctx, 1.6);
      for (let i = -1; i <= 1; i++) {
        ptsPath(ctx, [
          [i * r * 0.22 - r * 0.08, -r * 0.86],
          [i * r * 0.22, -r * 1.22],
          [i * r * 0.22 + r * 0.08, -r * 0.86]
        ]);
        ctx.fillStyle = light;
        ctx.fill();
        inkStroke(ctx, 1.2);
      }
      ctx.fillStyle = "#F5F5FA";
      for (const sx of [-1, 1]) {
        ctx.beginPath();
        ctx.arc(sx * r * 0.13, -r * 0.72, r * 0.07, 0, Math.PI * 2);
        ctx.fill();
      }
      drawGlow(ctx, 0, -r * 0.72, r * 0.5, "#C77DFF", 0.3);
    }
  }
  function drawBaneling(ctx, m, t, s) {
    const { r, color, light, dark, deco } = s;
    const hpK = Math.min(1, Math.max(0, 1 - m.hp / m.maxHp));
    const danger = m.state === "assault" ? 1 : hpK;
    const rate = 4 + 10 * danger;
    const amp = 0.1 + 0.16 * danger;
    const pulseScale = 1 + amp * Math.sin(t * rate + m.phase);
    if (danger > 0.35 && deco) {
      const warnK = (danger - 0.35) / 0.65;
      ctx.strokeStyle = rgba("#FF5A3C", (0.22 + 0.45 * warnK) * (0.6 + 0.4 * Math.sin(t * rate + m.phase)));
      ctx.lineWidth = 2 + 2 * warnK;
      ctx.beginPath();
      ctx.arc(0, 0, r * pulseScale + 4, 0, Math.PI * 2);
      ctx.stroke();
      drawGlow(ctx, 0, 0, r * 2.1, "#FF5A3C", 0.12 + 0.2 * warnK);
    }
    ctx.scale(pulseScale, pulseScale);
    if (deco) {
      ctx.strokeStyle = rgba(dark, 0.9);
      ctx.lineWidth = 2;
      for (let i = 0; i < 4; i++) {
        const a = Math.PI * 0.2 + i * Math.PI * 0.6 / 3;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * r * 0.8, Math.sin(a) * r * 0.8);
        ctx.lineTo(Math.cos(a) * r * 1.18, Math.sin(a) * r * 1.18);
        ctx.stroke();
      }
    }
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fillStyle = s.flat ? "#FFFFFF" : color;
    ctx.fill();
    if (deco) {
      inkStroke(ctx, 2.3);
      const coreK = 0.4 + 0.6 * danger;
      ctx.fillStyle = rgba(mix("#FF5A3C", "#FFD54F", danger), 0.6 + 0.35 * danger);
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.45 * coreK, 0, Math.PI * 2);
      ctx.fill();
      drawGlow(ctx, 0, 0, r * 1.2, mix("#FF5A3C", "#FFD54F", danger), 0.25 + 0.35 * danger);
      const veinColor = mix("#4E7A24", "#D8FF50", danger);
      ctx.strokeStyle = rgba(veinColor, 0.55 + 0.4 * danger);
      ctx.lineWidth = 1.6;
      for (let i = 0; i < 6; i++) {
        const a = Math.PI * 2 * i / 6 + t * 0.8 + m.phase;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * r * 0.3, Math.sin(a) * r * 0.3);
        ctx.lineTo(Math.cos(a + 0.2) * r * 0.68, Math.sin(a + 0.2) * r * 0.68);
        ctx.lineTo(Math.cos(a) * r * 0.94, Math.sin(a) * r * 0.94);
        ctx.stroke();
      }
      ctx.strokeStyle = rgba(dark, 0.45);
      ctx.lineWidth = 1.2;
      for (let i = 0; i < 4; i++) {
        const a = Math.PI * 2 * i / 4 + 0.4;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * r * 0.5, Math.sin(a) * r * 0.5);
        ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
        ctx.stroke();
      }
      ctx.fillStyle = rgba("#FFFFFF", 0.34);
      ctx.beginPath();
      ctx.ellipse(-r * 0.34, r * 0.34, r * 0.24, r * 0.14, -0.6, 0, Math.PI * 2);
      ctx.fill();
      if (danger > 0.75) {
        const finalK = (danger - 0.75) / 0.25;
        const f = Math.max(0, Math.sin(t * 26 + m.phase));
        ctx.fillStyle = rgba("#FFFFFF", 0.6 * finalK * f * f);
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  function drawUltra(ctx, m, t, s) {
    const { r, color, light, dark, deco } = s;
    const breatheK = 1 + 0.03 * Math.sin(t * 1.8 + m.phase);
    ctx.scale(breatheK, breatheK);
    ctx.translate(0, walkBob(m, t, 3.4, 0.03));
    polyPath(ctx, 10, r * 1.12, Math.PI / 10, 0.78);
    ctx.fillStyle = s.flat ? "#FFFFFF" : color;
    ctx.fill();
    if (deco) {
      inkStroke(ctx, 2.8);
      polyPath(ctx, 10, r * 0.86, Math.PI / 10, 0.8);
      ctx.fillStyle = rgba(dark, 0.4);
      ctx.fill();
      ctx.strokeStyle = rgba(light, 0.28);
      ctx.lineWidth = 1.6;
      for (let i = 0; i < 5; i++) {
        const a = Math.PI * 2 * i / 5;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * r * 0.3, Math.sin(a) * r * 0.3);
        ctx.lineTo(Math.cos(a) * r * 1.02, Math.sin(a) * r * 1.02);
        ctx.stroke();
      }
      for (const sx of [-1, 1]) {
        ptsPath(ctx, [
          [sx * r * 0.38, -r * 0.72],
          [sx * r * 0.66, -r * 1.42],
          [sx * r * 0.14, -r * 0.86]
        ]);
        ctx.fillStyle = light;
        ctx.fill();
        inkStroke(ctx, 1.6);
      }
      for (const sx of [-1, 1]) {
        ptsPath(ctx, [
          [sx * r * 0.3, r * 0.7],
          [sx * r * 0.46, r * 1.16],
          [sx * r * 0.12, r * 0.82]
        ]);
        ctx.fillStyle = light;
        ctx.fill();
        inkStroke(ctx, 1.4);
      }
      const coreP = 0.5 + 0.5 * Math.sin(t * 2.6 + m.phase);
      ctx.fillStyle = rgba("#D8FF50", 0.55 + 0.3 * coreP);
      polyPath(ctx, 6, r * 0.3, Math.PI / 6);
      ctx.fill();
      drawGlow(ctx, 0, 0, r * 1.1, "#AEEA00", 0.18 + 0.16 * coreP);
      polyPath(ctx, 10, r * (1.16 + 0.02 * Math.sin(t * 2.2)), Math.PI / 10, 0.78);
      ctx.strokeStyle = rgba(light, 0.2 + 0.16 * Math.sin(t * 2.2));
      ctx.lineWidth = 2.2;
      ctx.stroke();
    }
  }
  function drawBossTreant(ctx, m, t, s) {
    const { r, color, light, dark, deco } = s;
    if (deco) {
      for (let layer = 0; layer < 2; layer++) {
        const dir = layer === 0 ? 1 : -1;
        const rot = t * 0.35 * dir + layer * 0.4;
        const rad = r * (1.2 + layer * 0.16);
        ctx.strokeStyle = rgba(layer === 0 ? "#B537F2" : light, 0.35 + 0.15 * Math.sin(t * 2 + layer));
        ctx.lineWidth = layer === 0 ? 3 : 1.6;
        for (let i = 0; i < 4; i++) {
          const a0 = rot + Math.PI / 2 * i;
          ctx.beginPath();
          ctx.arc(0, 0, rad, a0, a0 + 0.92);
          ctx.stroke();
        }
        for (let i = 0; i < 4; i++) {
          const a = rot + Math.PI / 2 * i + 0.46;
          const px = Math.cos(a) * rad;
          const py = Math.sin(a) * rad;
          ptsPath(ctx, [
            [px, py - 5],
            [px + 4, py],
            [px, py + 5],
            [px - 4, py]
          ]);
          ctx.fillStyle = rgba(layer === 0 ? "#B537F2" : light, 0.8);
          ctx.fill();
        }
      }
    }
    ctx.strokeStyle = s.flat ? "#FFFFFF" : dark;
    ctx.lineWidth = 5;
    ctx.lineCap = "round";
    for (let i = -1; i <= 1; i++) {
      ctx.beginPath();
      ctx.moveTo(0, r * 0.7);
      ctx.quadraticCurveTo(i * r * 0.5, r * 1, i * r * 0.9, r * 1.16);
      ctx.stroke();
    }
    ptsPath(ctx, [
      [-r * 0.32, r * 0.86],
      [-r * 0.24, -r * 0.1],
      [r * 0.24, -r * 0.1],
      [r * 0.32, r * 0.86]
    ]);
    ctx.fillStyle = s.flat ? "#FFFFFF" : darken(color, 0.55);
    ctx.fill();
    if (deco) inkStroke(ctx, 2.2);
    const sway = Math.sin(t * 1.1 + m.phase) * 0.05;
    ctx.save();
    ctx.translate(0, r * 0.1);
    ctx.rotate(sway);
    const layers = [
      [r * 0.95, -r * 0.05, 1.02],
      [r * 0.74, -r * 0.52, 0.9],
      [r * 0.52, -r * 0.95, 0.78]
    ];
    for (let i = 0; i < layers.length; i++) {
      const [w, cy, h] = layers[i];
      ptsPath(ctx, [
        [-w, cy + r * 0.12],
        [0, cy - r * 0.86 * h],
        [w, cy + r * 0.12],
        [0, cy + r * 0.3]
      ]);
      ctx.fillStyle = s.flat ? "#FFFFFF" : i === 0 ? darken(color, 0.28) : i === 1 ? color : lighten(color, 0.14);
      ctx.fill();
      if (deco) {
        inkStroke(ctx, 2.2);
        ctx.strokeStyle = rgba(INK, 0.35);
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(0, cy - r * 0.7 * h);
        ctx.lineTo(0, cy + r * 0.2);
        ctx.stroke();
      }
    }
    ctx.restore();
    if (deco) {
      drawGlow(ctx, 0, r * 0.34, r * 0.7, "#B537F2", 0.45 + 0.15 * Math.sin(t * 3));
      ctx.fillStyle = "#B537F2";
      ctx.beginPath();
      ctx.ellipse(0, r * 0.34, r * 0.2, r * 0.26, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#0B0C1D";
      ctx.beginPath();
      ctx.ellipse(0, r * 0.34, r * 0.06, r * 0.2, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = rgba("#B537F2", 0.2 + 0.1 * Math.sin(t * 2));
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.ellipse(0, r * 0.95, r * 1.15, r * 0.34, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  function drawBurrowed(ctx, m, t, base, tint) {
    const r = m.cfg.radius;
    const color = tint ? "#FFFFFF" : base;
    const dark = tint ? "#FFFFFF" : darken(base, 0.5);
    ctx.fillStyle = tint ? "#FFFFFF" : rgba("#2A2F52", 0.92);
    ctx.beginPath();
    ctx.ellipse(0, -r * 0.4, r * 1.3, r * 0.44, 0, 0, Math.PI * 2);
    ctx.fill();
    if (!tint) {
      ctx.beginPath();
      ctx.ellipse(0, -r * 0.5, r * 1.12, r * 0.46, 0, Math.PI, Math.PI * 2);
      ctx.fillStyle = rgba("#3A4270", 0.95);
      ctx.fill();
      ctx.strokeStyle = rgba(dark, 0.7);
      ctx.lineWidth = 1.6;
      for (let i = 0; i < 4; i++) {
        const a = Math.PI * 0.15 + i * 0.62;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * r * 0.9, -r * 0.4 + Math.sin(a) * r * 0.4);
        ctx.lineTo(Math.cos(a) * r * 1.35, -r * 0.4 + Math.sin(a) * r * 0.55);
        ctx.stroke();
      }
    }
    const shape = m.cfg.shape;
    if (shape === "lurker") {
      const interval = Math.max(1e-3, m.cfg.attackInterval);
      const wind = Math.min(1, Math.max(0, 1 - m.attackTimer / interval));
      const lift = Math.sin(Math.min(1, Math.max(0, wind)) * Math.PI);
      ctx.fillStyle = color;
      ptsPath(ctx, [
        [0, -r * 0.3],
        [-r * 0.26, -r * 0.4],
        [0, -r * 1.5 - lift * r * 0.5],
        [r * 0.26, -r * 0.4]
      ]);
      ctx.fill();
      if (!tint) {
        ctx.strokeStyle = INK;
        ctx.lineWidth = 1.8;
        ctx.stroke();
        ctx.strokeStyle = rgba("#FFD54F", 0.35 + 0.55 * lift);
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(-r * 0.14, -r * 0.42);
        ctx.lineTo(0, -r * 1.42);
        ctx.stroke();
      }
    } else if (shape === "ultra") {
      ctx.save();
      ctx.translate(0, -r * 0.4);
      polyPath(ctx, 6, r * 0.55, Math.PI / 6);
      ctx.fillStyle = color;
      ctx.fill();
      if (!tint) {
        ctx.strokeStyle = INK;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      ctx.restore();
    } else {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.ellipse(0, -r * 0.4, r * 0.6, r * 0.2, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    if (!tint) {
      ctx.strokeStyle = rgba(color, 0.55);
      ctx.setLineDash([5, 5]);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(0, -r * 0.3, r * 1.45, r * 0.62, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      const breatheA = 0.1 + 0.08 * Math.sin(t * 3 + m.phase);
      ctx.strokeStyle = rgba("#4FC3F7", breatheA);
      ctx.beginPath();
      ctx.ellipse(0, -r * 0.3, r * 1.6, r * 0.7, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  function drawHero(ctx, hero, t, opts = {}) {
    const color = "#35E0C3";
    const light = lighten(color, 0.4);
    const dark = darken(color, 0.45);
    const hover = Math.sin(t * 2.2) * 3;
    const lean = opts.lean ?? 0;
    const aim = opts.aim ?? Math.PI / 2;
    const recoil = Math.max(0, Math.min(6, opts.recoil ?? 0));
    drawGroundShadow(ctx, hero.x, hero.y - 24, 34, 12, 0.85);
    ctx.strokeStyle = rgba("#35E0C3", 0.16 + 0.06 * Math.sin(t * 2.2));
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.ellipse(hero.x, hero.y - 24, 30, 10.5, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.save();
    ctx.translate(hero.x, hero.y + hover);
    ctx.scale(1.18, 1.18);
    const flameK = 0.75 + 0.25 * Math.sin(t * 34) * Math.sin(t * 7.3);
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (const sx of [-1, 1]) {
      const flick = 0.7 + 0.3 * Math.sin(t * 27 + sx);
      ctx.fillStyle = rgba("#5EE1FF", 0.55 * flick);
      ctx.beginPath();
      ctx.moveTo(sx * 9, -20);
      ctx.lineTo(sx * 5, -20 - 16 * flameK * flick);
      ctx.lineTo(sx * 13, -20 - 9 * flameK * flick);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = rgba("#FFFFFF", 0.5 * flick);
      ctx.beginPath();
      ctx.moveTo(sx * 8, -20);
      ctx.lineTo(sx * 8, -20 - 7 * flameK);
      ctx.lineTo(sx * 10, -20);
      ctx.closePath();
      ctx.fill();
    }
    drawGlow(ctx, 0, -26, 34, "#35E0C3", 0.5);
    ctx.restore();
    ctx.rotate(lean);
    for (const sx of [-1, 1]) {
      rrPath(ctx, sx > 0 ? 8 : -34, -18, 26, 15, 6);
      ctx.fillStyle = dark;
      ctx.fill();
      ctx.strokeStyle = INK;
      ctx.lineWidth = 2;
      ctx.stroke();
      rrPath(ctx, sx > 0 ? 10 : -32, -16, 22, 6, 3);
      ctx.fillStyle = rgba(color, 0.5);
      ctx.fill();
      ctx.fillStyle = "#5EE1FF";
      ctx.beginPath();
      ctx.arc(sx * 31, -11, 2.2, 0, Math.PI * 2);
      ctx.fill();
      drawGlow(ctx, sx * 31, -11, 8, "#5EE1FF", 0.7);
    }
    ctx.save();
    ctx.rotate(aim - Math.PI / 2);
    ctx.translate(0, -recoil);
    rrPath(ctx, -5, 2, 10, 30, 4);
    ctx.fillStyle = darken(color, 0.2);
    ctx.fill();
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1.8;
    ctx.stroke();
    rrPath(ctx, -6.5, 27, 13, 6, 3);
    ctx.fillStyle = light;
    ctx.fill();
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.fillStyle = rgba("#FFFFFF", 0.35);
    ctx.fillRect(-3.2, 6, 2, 20);
    if (recoil > 0.2) drawGlow(ctx, 0, 32, 26 * (recoil / 6) + 10, "#FFFFFF", 0.5 * (recoil / 6));
    ctx.restore();
    ctx.beginPath();
    ctx.moveTo(0, 34);
    ctx.quadraticCurveTo(9, 22, 17, -8);
    ctx.quadraticCurveTo(12, -20, 0, -20);
    ctx.quadraticCurveTo(-12, -20, -17, -8);
    ctx.quadraticCurveTo(-9, 22, 0, 34);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2.4;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, 30);
    ctx.quadraticCurveTo(6, 20, 11, -6);
    ctx.quadraticCurveTo(6, -16, 0, -16);
    ctx.closePath();
    ctx.fillStyle = rgba(light, 0.45);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(0, 30);
    ctx.quadraticCurveTo(-6, 20, -11, -6);
    ctx.quadraticCurveTo(-6, -16, 0, -16);
    ctx.closePath();
    ctx.fillStyle = rgba(dark, 0.35);
    ctx.fill();
    ctx.strokeStyle = rgba(INK, 0.35);
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(0, 24);
    ctx.lineTo(0, -14);
    ctx.stroke();
    const corePulse = 0.5 + 0.5 * Math.sin(t * 3);
    ctx.fillStyle = INK;
    ctx.beginPath();
    ctx.arc(0, 2, 8.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = lighten(color, 0.72);
    ctx.beginPath();
    ctx.arc(0, 2, 4.2 + corePulse * 1.2, 0, Math.PI * 2);
    ctx.fill();
    drawGlow(ctx, 0, 2, 26 + corePulse * 6, "#35E0C3", 0.5);
    ctx.fillStyle = "#FFFFFF";
    ctx.beginPath();
    ctx.arc(0, 28, 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  function drawProjectile(ctx, p, t, color) {
    const shape = p.weapon.cfg.shape ?? "dot";
    const dx = p.x - p.px;
    const dy = p.y - p.py;
    const len2 = Math.hypot(dx, dy) || 1;
    const ux = dx / len2;
    const uy = dy / len2;
    const light = lighten(color, 0.55);
    switch (shape) {
      case "arrow": {
        ctx.strokeStyle = rgba(color, 0.22);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(p.x - ux * 62, p.y - uy * 62);
        ctx.lineTo(p.x - ux * 18, p.y - uy * 18);
        ctx.stroke();
        const shaft = 22;
        ctx.strokeStyle = color;
        ctx.lineWidth = 2.6;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(p.x - ux * shaft, p.y - uy * shaft);
        ctx.lineTo(p.x + ux * 6, p.y + uy * 6);
        ctx.stroke();
        ctx.strokeStyle = rgba(light, 0.85);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(p.x - ux * shaft, p.y - uy * shaft);
        ctx.lineTo(p.x + ux * 4, p.y + uy * 4);
        ctx.stroke();
        const px = -uy;
        const py = ux;
        ctx.fillStyle = rgba(light, 0.9);
        for (const s of [-1, 1]) {
          ctx.beginPath();
          ctx.moveTo(p.x - ux * shaft, p.y - uy * shaft);
          ctx.lineTo(
            p.x - ux * (shaft + 8) + px * 5 * s,
            p.y - uy * (shaft + 8) + py * 5 * s
          );
          ctx.lineTo(p.x - ux * (shaft + 2), p.y - uy * (shaft + 2));
          ctx.closePath();
          ctx.fill();
        }
        ctx.fillStyle = light;
        ctx.beginPath();
        ctx.moveTo(p.x + ux * 13, p.y + uy * 13);
        ctx.lineTo(p.x - ux * 2 + px * 4.5, p.y - uy * 2 + py * 4.5);
        ctx.lineTo(p.x - ux * 2 - px * 4.5, p.y - uy * 2 - py * 4.5);
        ctx.closePath();
        ctx.fill();
        drawGlow(ctx, p.x, p.y, 20, color, 0.35);
        break;
      }
      case "bomb": {
        const h = p.height;
        ctx.fillStyle = "rgba(4,5,12,0.34)";
        ctx.beginPath();
        ctx.ellipse(p.x, p.y, 10, 3.6, 0, 0, Math.PI * 2);
        ctx.fill();
        const by = p.y + h;
        for (let i = 1; i <= 3; i++) {
          ctx.fillStyle = rgba(color, 0.12 * (4 - i));
          ctx.beginPath();
          ctx.arc(p.x - ux * i * 14, by - uy * i * 14, (p.radius + 3) * (1 - i * 0.12), 0, Math.PI * 2);
          ctx.fill();
        }
        const R = p.radius + 3;
        const rot = t * 4 + p.id;
        ctx.save();
        ctx.translate(p.x, by);
        ctx.rotate(rot);
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(0, 0, R, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = INK;
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.fillStyle = rgba(light, 0.5);
        ctx.beginPath();
        ctx.arc(-R * 0.32, -R * 0.32, R * 0.34, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = rgba(INK, 0.55);
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.arc(0, 0, R * 0.62, 0.4, 2.6);
        ctx.stroke();
        ctx.restore();
        const fuseSwing = Math.sin(t * 5 + p.id) * 3;
        ctx.strokeStyle = "#8A93B8";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(p.x + R * 0.7, by + R * 0.7);
        ctx.quadraticCurveTo(p.x + R * 0.9 + fuseSwing, by + R * 1.25, p.x + R * 0.7 + fuseSwing, by + R * 1.5);
        ctx.stroke();
        const sparkA = 0.6 + 0.4 * Math.sin(t * 22 + p.id);
        drawGlow(ctx, p.x + R * 0.7 + fuseSwing, by + R * 1.5, 10, "#FFD54F", sparkA);
        ctx.fillStyle = "#FFF3C4";
        ctx.beginPath();
        ctx.arc(p.x + R * 0.7 + fuseSwing, by + R * 1.5, 2.2, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case "gear":
      case "crescent": {
        const R = 17;
        const rot = t * 11 + p.id;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.strokeStyle = rgba(color, 0.18);
        ctx.lineWidth = 3;
        for (let i = 0; i < 2; i++) {
          ctx.beginPath();
          ctx.arc(0, 0, R + i * 3, rot - 1.1 - i * 0.2, rot - 0.2);
          ctx.stroke();
        }
        ctx.rotate(rot);
        ctx.fillStyle = color;
        for (let i = 0; i < 8; i++) {
          ctx.save();
          ctx.rotate(Math.PI / 4 * i);
          ctx.fillRect(-2.6, -R - 5, 5.2, 7);
          ctx.restore();
        }
        ctx.beginPath();
        ctx.arc(0, 0, R, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = INK;
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.fillStyle = "#0B0C1D";
        ctx.beginPath();
        ctx.arc(0, 0, R * 0.45, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = color;
        for (let i = 0; i < 4; i++) {
          ctx.save();
          ctx.rotate(Math.PI / 2 * i);
          ctx.fillRect(-1.6, R * 0.4, 3.2, R * 0.32);
          ctx.restore();
        }
        ctx.strokeStyle = rgba(light, 0.7);
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(0, 0, R - 1.2, -0.6, 0.9);
        ctx.stroke();
        ctx.restore();
        drawGlow(ctx, p.x, p.y, R * 2.2, color, 0.3);
        break;
      }
      case "dot":
      default: {
        const isRune = p.weapon.cfg.id === "gun_rifle";
        ctx.strokeStyle = rgba(color, 0.18);
        ctx.lineWidth = 6;
        ctx.beginPath();
        ctx.moveTo(p.x - ux * 54, p.y - uy * 54);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
        ctx.strokeStyle = rgba(color, 0.55);
        ctx.lineWidth = 2.4;
        ctx.beginPath();
        ctx.moveTo(p.x - ux * 34, p.y - uy * 34);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
        for (let i = 1; i <= 3; i++) {
          const k = i / 4;
          ctx.fillStyle = rgba(color, 0.3 * (1 - k) + 0.08);
          ctx.beginPath();
          ctx.arc(p.x - ux * 30 * k, p.y - uy * 30 * k, p.radius * (1 - k * 0.55), 0, Math.PI * 2);
          ctx.fill();
        }
        drawGlow(ctx, p.x, p.y, p.radius * 4.6, color, 0.55);
        if (isRune) {
          const ang = Math.atan2(uy, ux);
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(ang);
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.moveTo(p.radius * 2.1, 0);
          ctx.lineTo(0, p.radius * 1.2);
          ctx.lineTo(-p.radius * 2.1, 0);
          ctx.lineTo(0, -p.radius * 1.2);
          ctx.closePath();
          ctx.fill();
          ctx.strokeStyle = rgba(light, 0.85);
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.arc(0, 0, p.radius * 2.3, t * 6, t * 6 + 2.1);
          ctx.stroke();
          ctx.fillStyle = "#FFFFFF";
          ctx.beginPath();
          ctx.arc(0, 0, p.radius * 0.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
          break;
        }
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = rgba("#FFFFFF", 0.9);
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.radius * 0.45, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
    }
  }
  function drawMonsterShot(ctx, s, t) {
    const color = "#FFB357";
    if (s.kind === "rock") {
      const by = s.y + s.height;
      ctx.fillStyle = "rgba(4,5,12,0.3)";
      ctx.beginPath();
      ctx.ellipse(s.x, s.ty, 11, 4.2, 0, 0, Math.PI * 2);
      ctx.fill();
      if (s.t > 0.02) {
        const arc = Math.max(120, Math.abs(s.sy - s.ty) * 0.32);
        ctx.strokeStyle = rgba(color, 0.22);
        ctx.lineWidth = 2;
        ctx.beginPath();
        const steps = 10;
        for (let k = 0; k <= steps; k++) {
          const tt = s.t * k / steps;
          const px = s.sx + (s.tx - s.sx) * tt;
          const py = s.sy + (s.ty - s.sy) * tt + Math.sin(tt * Math.PI) * arc;
          if (k === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.stroke();
      }
      const R = 9;
      const rot = t * 5 + s.tx * 0.01;
      ptsPath(ctx, Array.from({ length: 7 }, (_, i) => {
        const a = Math.PI * 2 * i / 7 + rot;
        const rr = R * (0.82 + 0.22 * hash01(i * 3.7 + s.sx * 0.13));
        return [s.x + Math.cos(a) * rr, by + Math.sin(a) * rr];
      }));
      ctx.fillStyle = darken(color, 0.25);
      ctx.fill();
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1.8;
      ctx.stroke();
      ctx.fillStyle = rgba(lighten(color, 0.45), 0.55);
      ctx.beginPath();
      ctx.arc(s.x - 3, by + 3, 3, 0, Math.PI * 2);
      ctx.fill();
      drawGlow(ctx, s.x, by, 22, color, 0.22);
    } else {
      const dx = s.tx - s.sx;
      const dy = s.ty - s.sy;
      const l = Math.hypot(dx, dy) || 1;
      const ux = dx / l;
      const uy = dy / l;
      const by = s.y + s.height;
      ctx.strokeStyle = rgba(color, 0.2);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(s.x - ux * 44, by - uy * 44);
      ctx.lineTo(s.x - ux * 18, by - uy * 18);
      ctx.stroke();
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(s.x - ux * 16, by - uy * 16);
      ctx.lineTo(s.x + ux * 6, by + uy * 6);
      ctx.stroke();
      ctx.fillStyle = "#F5F5FA";
      const px = -uy;
      const py = ux;
      ctx.beginPath();
      ctx.moveTo(s.x + ux * 16, by + uy * 16);
      ctx.lineTo(s.x + ux * 4 + px * 3.6, by + uy * 4 + py * 3.6);
      ctx.lineTo(s.x + ux * 4 - px * 3.6, by + uy * 4 - py * 3.6);
      ctx.closePath();
      ctx.fill();
      drawGlow(ctx, s.x, by, 18, color, 0.28);
    }
  }
  function drawLaser(ctx, beam, t, color) {
    const dx = beam.bx - beam.ax;
    const dy = beam.by - beam.ay;
    const len2 = Math.hypot(dx, dy) || 1;
    const ux = dx / len2;
    const uy = dy / len2;
    const px = -uy;
    const py = ux;
    const lifeK = 0.9 + 0.1 * Math.sin(t * 60);
    const baseW = beam.width;
    const light = lighten(color, 0.65);
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const segs = 10;
    for (let i = 0; i <= segs; i++) {
      const k = i / segs;
      const x = beam.ax + ux * len2 * k;
      const y = beam.ay + uy * len2 * k;
      drawGlow(ctx, x, y, baseW * (2.4 - k * 1.2), color, 0.34 * (1 - k * 0.8) * lifeK);
    }
    const steps = 22;
    let prevX = beam.ax;
    let prevY = beam.ay;
    for (let i = 1; i <= steps; i++) {
      const k = i / steps;
      const x = beam.ax + ux * len2 * k;
      const y = beam.ay + uy * len2 * k;
      const en = 1 - k;
      const jitter = Math.sin(t * 42 + i * 1.7) * baseW * 0.12 * en;
      const w = baseW * (0.35 + 0.9 * en);
      ctx.strokeStyle = rgba(color, 0.2 * (0.4 + en) * lifeK);
      ctx.lineWidth = w * 2.1;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(prevX + px * jitter, prevY + py * jitter);
      ctx.lineTo(x + px * jitter, y + py * jitter);
      ctx.stroke();
      ctx.strokeStyle = rgba(light, 0.55 * (0.5 + en) * lifeK);
      ctx.lineWidth = w * 0.85;
      ctx.beginPath();
      ctx.moveTo(prevX + px * jitter, prevY + py * jitter);
      ctx.lineTo(x + px * jitter, y + py * jitter);
      ctx.stroke();
      prevX = x;
      prevY = y;
    }
    ctx.strokeStyle = rgba("#FFFFFF", 0.68 * lifeK);
    ctx.lineWidth = Math.max(1.4, baseW * 0.22);
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(beam.ax, beam.ay);
    ctx.lineTo(beam.bx, beam.by);
    ctx.stroke();
    drawGlow(ctx, beam.ax, beam.ay, baseW * 3.2, light, 0.75 * lifeK);
    for (const h of beam.hits) {
      const ek = beam.energy > 0 ? Math.max(0.15, h.energy / beam.energy) : 0.2;
      const r = 10 + 22 * ek;
      drawGlow(ctx, h.x, h.y, r, color, 0.5 * ek * lifeK);
      drawGlow(ctx, h.x, h.y, r * 0.5, "#FFFFFF", 0.55 * ek * lifeK);
      ctx.strokeStyle = rgba("#FFFFFF", 0.6 * ek * lifeK);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(h.x - r * 0.7, h.y);
      ctx.lineTo(h.x + r * 0.7, h.y);
      ctx.moveTo(h.x, h.y - r * 0.7);
      ctx.lineTo(h.x, h.y + r * 0.7);
      ctx.stroke();
      ctx.strokeStyle = rgba(color, 0.5 * ek * lifeK);
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(h.x, h.y, r * 0.75, 0, Math.PI * 2);
      ctx.stroke();
    }
    drawGlow(ctx, beam.bx, beam.by, baseW * 1.8, "#FFFFFF", 0.5 * lifeK);
    ctx.restore();
  }
  function drawPool(ctx, pool, t) {
    const left = Math.max(0, pool.until - t);
    const lifeK = Math.min(1, left * 0.8);
    const r = pool.radius;
    const seed = pool.x * 0.13 + pool.y * 0.07;
    ctx.fillStyle = rgba("#0B0C1D", 0.55 * lifeK);
    ctx.beginPath();
    for (let i = 0; i <= 18; i++) {
      const a = Math.PI * 2 * i / 18;
      const rr = (r + 7) * (0.94 + 0.1 * hash01(i * 2.3 + seed));
      const px = pool.x + Math.cos(a) * rr;
      const py = pool.y + Math.sin(a) * rr * 0.92;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
    const pulse = 0.85 + 0.15 * Math.sin(t * 6 + seed);
    ctx.fillStyle = rgba("#FF5A3C", 0.42 * lifeK);
    ctx.beginPath();
    ctx.ellipse(pool.x, pool.y, r * pulse, r * pulse * 0.94, 0, 0, Math.PI * 2);
    ctx.fill();
    drawGlow(ctx, pool.x, pool.y, r * 1.5, "#FF5A3C", 0.18 * lifeK);
    ctx.fillStyle = rgba("#FFAA3C", 0.4 * lifeK);
    ctx.beginPath();
    ctx.ellipse(pool.x, pool.y, r * 0.55 * pulse, r * 0.52 * pulse, 0, 0, Math.PI * 2);
    ctx.fill();
    drawGlow(ctx, pool.x, pool.y, r * 0.7, "#FFD54F", 0.22 * lifeK);
    ctx.strokeStyle = rgba("#FF5A3C", 0.75 * lifeK);
    ctx.lineWidth = 2;
    for (let i = 0; i < 6; i++) {
      const a0 = Math.PI * 2 * i / 6 + seed;
      ctx.beginPath();
      ctx.ellipse(pool.x, pool.y, r, r * 0.94, 0, a0, a0 + 0.55);
      ctx.stroke();
    }
    for (let i = 0; i < 5; i++) {
      const s = seed + i * 2.4;
      const k = (t * 0.9 + s) % 1;
      const ex = pool.x + Math.sin(s * 7 + k * 3) * r * 0.6 * (1 - k);
      const ey = pool.y + (0.5 - k) * r * 1.25;
      ctx.fillStyle = rgba("#FFD54F", (1 - k) * 0.8 * lifeK);
      ctx.beginPath();
      ctx.arc(ex, ey, 2.2 - k, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  function drawSegments(ctx, segments, now, color = "#B388FF") {
    for (const seg of segments) {
      const left = Math.max(0, seg.until - now);
      const alpha = Math.min(1, 0.3 + left * 0.6);
      const dx = seg.bx - seg.ax;
      const dy = seg.by - seg.ay;
      const len2 = Math.hypot(dx, dy) || 1;
      const ux = dx / len2;
      const uy = dy / len2;
      ctx.strokeStyle = rgba(color, 0.16 * alpha);
      ctx.lineWidth = seg.width * 0.9;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(seg.ax, seg.ay);
      ctx.lineTo(seg.bx, seg.by);
      ctx.stroke();
      ctx.strokeStyle = rgba(color, 0.5 * alpha);
      ctx.lineWidth = Math.max(4, seg.width * 0.35);
      ctx.stroke();
      ctx.strokeStyle = rgba("#F5F5FA", 0.9 * alpha);
      ctx.lineWidth = 3;
      ctx.stroke();
      for (let i = 0; i < 3; i++) {
        const k = (now * 1.6 + i * 0.33) % 1;
        drawGlow(ctx, seg.ax + ux * len2 * k, seg.ay + uy * len2 * k, 10, color, 0.55 * alpha);
      }
      drawGlow(ctx, seg.ax, seg.ay, seg.width, color, 0.5 * alpha);
      drawGlow(ctx, seg.bx, seg.by, seg.width, color, 0.5 * alpha);
    }
  }

  // src/adapter/web/render/scene.ts
  var WALL_SEGS = 12;
  var SceneRenderer = class {
    constructor(W2, H2, palette, fx) {
      this.effects = new EffectsLayer();
      this.bg = null;
      this.bgKey = "";
      this.lastMs = 0;
      /** 出场缩放：首次看到的时刻（WeakMap 以怪物对象为键，避免 id 复用导致的错乱） */
      this.seenAt = /* @__PURE__ */ new WeakMap();
      /** 英雄视觉状态（纯渲染层，不参与逻辑） */
      this.aim = Math.PI / 2;
      this.recoil = 0;
      this.prevHeroX = 0;
      this.lean = 0;
      this.heroInit = false;
      /** 每段城墙的受击闪光计时（秒） */
      this.wallFlash = new Array(WALL_SEGS).fill(0);
      this.wallHeal = new Array(WALL_SEGS).fill(0);
      this.W = W2;
      this.H = H2;
      this.palette = palette;
      this.fx = fx;
    }
    get floatCount() {
      return this.effects.floats.length;
    }
    /** 把渲染层接到一个会话的事件总线上（每次新建会话后调用一次）。 */
    attach(session) {
      const bus = session.bus;
      const fx = this.fx;
      const eff = this.effects;
      this.wallFlash.fill(0);
      this.wallHeal.fill(0);
      this.heroInit = false;
      bus.on(
        "onHit",
        ({ monsterId, dmg, isCrit, blocked, mitigated, x, y, damageType }) => {
          if (monsterId !== void 0 && !blocked) fx.markHit(monsterId, session.timeSec);
          const elemColor = this.palette.damageType[damageType ?? "physical"] ?? "#F5F5FA";
          if (blocked) {
            eff.pushFloat(x, y - 12, "\u6321", "#8A93B8", 15);
            eff.impact(x, y, "#8A93B8", void 0, 2);
            return;
          }
          if (mitigated && mitigated > 0) eff.pushFloat(x + 22, y + 34, `\u62B5${mitigated}`, "#8A93B8", 12);
          eff.pushFloat(
            x + (hash01(x + y * 3.3 + dmg) - 0.5) * 26,
            y + 18,
            String(Math.round(dmg)),
            isCrit ? "#FFD54F" : elemColor,
            isCrit ? 30 : 18,
            { crit: isCrit }
          );
          const sparkBase = this.fx.cfg.hitSpark?.count ?? 3;
          eff.impact(x, y, isCrit ? "#FFD54F" : elemColor, void 0, isCrit ? sparkBase * 2 : sparkBase);
          if (isCrit) {
            eff.rings.push({ x, y, r0: 4, r1: 26, life: 0.2, maxLife: 0.2, color: "#FFD54F", width: 2.5, filled: false });
            eff.shake(1.6, 0.08);
          }
        }
      );
      bus.on("onKill", ({ monsterId, key, shape, damageType }) => {
        const m = session.monsters.find((x) => x.id === monsterId);
        if (!m) return;
        const color = monsterColorByKey(key);
        eff.deathFor(key, shape ?? m.cfg.shape, m.x, m.y, m.cfg.radius, color, damageType);
        if (m.cfg.shape === "boss") {
          eff.explosion(m.x, m.y, m.cfg.radius * 1.6, "#B537F2", "#FF3D71");
          eff.shake(9, 0.4);
        }
      });
      bus.on("onExplode", ({ x, y, radius }) => {
        eff.explosion(x, y, radius);
      });
      bus.on("onWallHit", ({ dmg, x, y }) => {
        eff.pushFloat(x, y, `-${Math.round(dmg)}`, "#FF6B57", 17);
        const seg = Math.max(0, Math.min(WALL_SEGS - 1, Math.floor(x / (this.W / WALL_SEGS))));
        this.wallFlash[seg] = 0.26;
        eff.wallImpact(x, y, dmg, this.palette.friendly.wall);
      });
      bus.on("onBurrowStrike", ({ x, y }) => {
        eff.pushFloat(x, y + 46, "\u26A0 \u5730\u523A", "#FFB357", 15);
        for (let i = 0; i < 3; i++) {
          const sx = x + (i - 1) * 9;
          eff.particles.push({
            kind: "shard",
            x: sx,
            y: y + 4,
            vx: 0,
            vy: 120,
            grav: -260,
            drag: 1.2,
            life: 0.28,
            maxLife: 0.28,
            size: 4,
            color: "#C9A26B",
            rot: 0,
            spin: 0,
            shrink: 1
          });
        }
      });
      bus.on("onWallHeal", () => {
        this.wallHeal.fill(0.5);
        eff.pushFloat(this.W / 2, this.H * 0.12, "\u57CE\u9632\u4FEE\u590D", "#5EE1FF", 20);
      });
      bus.on("onShoot", () => {
        const h = session.hero;
        const tip = 30;
        eff.muzzle(
          h.x + Math.cos(this.aim) * tip,
          h.y + Math.sin(this.aim) * tip,
          this.aim,
          this.palette.damageType.physical ?? "#F5F5FA",
          16,
          (this.fx.cfg.muzzleFlash?.duration ?? 70) / 1e3
        );
        this.recoil = this.fx.cfg.heroRecoil?.distance ?? 5.5;
      });
      bus.on("onChain", ({ points }) => eff.chain(points));
      bus.on("onLaser", ({ hits }) => {
        eff.shake(hits > 0 ? 2.4 : 1.2, 0.1);
        const h = session.hero;
        eff.muzzle(h.x + Math.cos(this.aim) * 30, h.y + Math.sin(this.aim) * 30, this.aim, "#FFFFFF", 22, 0.08);
      });
      bus.on("onHeal", ({ x, y, radius }) => eff.healPulse(x, y, radius));
      bus.on(
        "onHealed",
        ({ x, y, amount }) => eff.pushFloat(x, y, `+${amount}`, "#7CB342", 15)
      );
      bus.on(
        "onDamageTransfer",
        ({ fx: fx2, fy, tx, ty, dmg }) => {
          eff.transfer(fx2, fy, tx, ty);
          eff.pushFloat(tx, ty + 24, `\u8F6C${Math.round(dmg)}`, "#B388FF", 14);
        }
      );
      bus.on(
        "onBurnTick",
        ({ dmg, x, y }) => eff.pushFloat(x, y, String(Math.round(dmg * 10) / 10), "#FF9A3C", 13)
      );
      bus.on(
        "onPoolTick",
        ({ dmg, x, y }) => eff.pushFloat(x, y, String(dmg), "#FF6B57", 12)
      );
      bus.on("onLevelUp", () => {
        eff.levelUp(session.hero.x, session.hero.y);
        eff.pushFloat(session.hero.x, session.hero.y + 40, "LEVEL UP", "#FFD54F", 22, { crit: true, life: 1.1 });
      });
    }
    // ---------------- 主渲染 ----------------
    render(ctx, session, timeMs) {
      const dt = Math.min(0.05, Math.max(1e-3, (timeMs - this.lastMs) / 1e3 || 0.016));
      this.lastMs = timeMs;
      const t = timeMs / 1e3;
      const now = session.timeSec;
      const wallTop = session.level.wall.height;
      const wallRatio = session.wallHp / session.wallMaxHp;
      this.effects.update(dt);
      this.updateHeroVisuals(session, dt, t);
      for (let i = 0; i < WALL_SEGS; i++) {
        this.wallFlash[i] = Math.max(0, this.wallFlash[i] - dt);
        this.wallHeal[i] = Math.max(0, this.wallHeal[i] - dt);
      }
      const sh = this.effects.shakeOffset;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.drawBackground(ctx, session, t, wallRatio, sh);
      ctx.setTransform(1, 0, 0, -1, sh.x, this.H + sh.y);
      this.drawCreep(ctx, session, t);
      this.drawHiveEntities(ctx, session, t);
      for (const pool of session.pools) drawPool(ctx, pool, now);
      this.drawWall(ctx, session, wallRatio, t, dt);
      const monsters = session.monsters.slice().sort((a, b) => b.y - a.y);
      for (const m of monsters) {
        const scale = this.spawnScale(m, timeMs);
        drawMonster(ctx, m, t, this.fx.flashAlpha(m.id, now), this.fx.hitSquash(m.id, now), scale);
      }
      for (const m of monsters) {
        drawMonsterStatus(ctx, m, t, now, this.fx.cfg.statusFx);
        this.drawHpBar(ctx, m);
      }
      drawSegments(ctx, session.segments, now, "#B388FF");
      const laserColor = (type) => this.palette.damageType[type] ?? "#B388FF";
      for (const beam of session.lasers) {
        drawLaser(ctx, beam, t, laserColor(beam.damageType));
      }
      const h = session.hero;
      drawHero(ctx, h, t, { aim: this.aim, recoil: this.recoil, lean: this.lean });
      const projColor = (type) => this.palette.damageType[type] ?? "#BFFFF2";
      for (const p of session.projectiles) drawProjectile(ctx, p, t, projColor(p.damageType));
      for (const s of session.monsterShots) drawMonsterShot(ctx, s, t);
      this.effects.draw(ctx);
      this.effects.drawTexts(ctx, this.H);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.drawHiveHud(ctx, session, t);
    }
    /** 顶部大进度条：让玩家一眼看到"我正在赢/正在输"。 */
    drawHiveHud(ctx, session, t) {
      const hive = session.hiveSystem;
      if (!hive) return;
      const h = hive.hive;
      if (h.dead) {
        ctx.fillStyle = "rgba(245,245,250,0.92)";
        ctx.font = '700 30px "PingFang SC", "Microsoft YaHei", sans-serif';
        ctx.textAlign = "center";
        ctx.fillText("\u866B \u5DE2 \u5DF1 \u7834", this.W / 2, this.H * 0.4);
        return;
      }
      const barW = this.W * 0.8;
      const barX = (this.W - barW) / 2;
      const ak = h.armor / h.armorMax;
      const y1 = 118;
      ctx.fillStyle = "rgba(7,8,15,0.72)";
      ctx.beginPath();
      ctx.roundRect(barX - 2, y1 - 2, barW + 4, 16, 8);
      ctx.fill();
      const armorColor = ak > 0.5 ? "#C7CEE6" : ak > 0.15 ? "#FFD54F" : "#FF3D71";
      ctx.fillStyle = armorColor;
      ctx.beginPath();
      ctx.roundRect(barX, y1, barW * ak, 12, 6);
      ctx.fill();
      if (ak <= 0.15) {
        ctx.strokeStyle = `rgba(255,61,113,${0.5 + 0.5 * Math.sin(t * 10)})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.roundRect(barX - 2, y1 - 2, barW + 4, 16, 8);
        ctx.stroke();
      }
      ctx.fillStyle = "rgba(245,245,250,0.85)";
      ctx.font = '600 11px "PingFang SC", "Microsoft YaHei", sans-serif';
      ctx.textAlign = "center";
      ctx.fillText(ak > 0 ? `\u866B\u5DE2\u8327\u58F3 ${(ak * 100).toFixed(0)}%  \u2014  \u6301\u7EED\u6E05\u866B\u538B\u5236\u83CC\u6BEF\u4EE5\u5265\u58F3` : "\u8327\u58F3\u5DF2\u7834\uFF01\u5168\u706B\u529B\u62C6\u866B\u5DE2\uFF01", this.W / 2, y1 - 6);
      const avg = hive.avgActivity();
      const y2 = y1 + 24;
      ctx.fillStyle = "rgba(7,8,15,0.6)";
      ctx.beginPath();
      ctx.roundRect(barX - 2, y2 - 2, barW + 4, 10, 5);
      ctx.fill();
      ctx.fillStyle = avg > 60 ? "#FF6B57" : avg > 30 ? "#FFB357" : "#7CB342";
      ctx.beginPath();
      ctx.roundRect(barX, y2, barW * (avg / 100), 6, 3);
      ctx.fill();
      ctx.fillStyle = "rgba(245,245,250,0.55)";
      ctx.font = '500 10px "PingFang SC", "Microsoft YaHei", sans-serif';
      ctx.fillText(`\u83CC\u6BEF\u6D3B\u6027 ${avg.toFixed(0)}  \u2014  \u8D8A\u4F4E\u866B\u5DE2\u8D8A\u5F31`, this.W / 2, y2 + 20);
    }
    // ---------------- 英雄视觉 ----------------
    updateHeroVisuals(session, dt, t) {
      const h = session.hero;
      if (!this.heroInit) {
        this.prevHeroX = h.x;
        this.heroInit = true;
      }
      let target = null;
      let bestD = Infinity;
      for (const m of session.monsters) {
        if (m.burrowed) continue;
        const d = (m.x - h.x) ** 2 + (m.y - h.y) ** 2;
        if (d < bestD) {
          bestD = d;
          target = m;
        }
      }
      const want = target ? Math.atan2(target.y - h.y, target.x - h.x) : Math.PI / 2 + Math.sin(t * 0.8) * 0.08;
      let diff = want - this.aim;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      this.aim += diff * Math.min(1, dt * 12);
      this.recoil *= Math.exp(-dt * 16);
      const vx = dt > 0 ? (h.x - this.prevHeroX) / dt : 0;
      this.prevHeroX = h.x;
      const targetLean = Math.max(-1, Math.min(1, vx / 700)) * 0.16;
      this.lean += (targetLean - this.lean) * Math.min(1, dt * 10);
    }
    /** 出场缩放（fx-config.spawnPop.scale 关键帧；缺省 0.2→1.08→1）。 */
    spawnScale(m, timeMs) {
      let at = this.seenAt.get(m);
      if (at === void 0) {
        at = timeMs;
        this.seenAt.set(m, at);
      }
      const dur = this.fx.cfg.spawnPop?.duration ?? 220;
      const k = Math.min(1, (timeMs - at) / Math.max(1, dur));
      const frames = this.fx.cfg.spawnPop?.scale ?? [0.2, 1.08, 1];
      return sampleKeyframes(frames, k, this.fx.cfg.spawnPop?.easing ?? "easeOutBack");
    }
    // ---------------- 背景 ----------------
    buildBackground(session) {
      const c = document.createElement("canvas");
      c.width = this.W;
      c.height = this.H;
      const g = c.getContext("2d");
      const pal = this.palette;
      const sky = g.createLinearGradient(0, 0, 0, this.H);
      sky.addColorStop(0, pal.background.nightDeep);
      sky.addColorStop(0.55, pal.background.night);
      sky.addColorStop(1, mix(pal.background.night, pal.friendly.wall, 0.18));
      g.fillStyle = sky;
      g.fillRect(0, 0, this.W, this.H);
      g.strokeStyle = pal.background.gridLine;
      g.lineWidth = 1;
      for (let x = 0; x <= this.W; x += 90) {
        g.beginPath();
        g.moveTo(x, 0);
        g.lineTo(x, this.H);
        g.stroke();
      }
      for (let y = 0; y <= this.H; y += 90) {
        g.beginPath();
        g.moveTo(0, y);
        g.lineTo(this.W, y);
        g.stroke();
      }
      const fade = g.createLinearGradient(0, this.H * 0.2, 0, this.H);
      fade.addColorStop(0, "rgba(11,12,29,0)");
      fade.addColorStop(1, "rgba(11,12,29,0.85)");
      g.fillStyle = fade;
      g.fillRect(0, 0, this.W, this.H);
      for (let i = 0; i < 150; i++) {
        const x = hash01(i * 12.9 + 3.1) * this.W;
        const y = hash01(i * 7.7 + 11.3) * this.H * 0.85;
        const size = 0.6 + hash01(i * 3.3) * 1.9;
        const a = 0.06 + hash01(i * 5.1) * 0.26;
        g.fillStyle = i % 11 === 0 ? rgba(pal.chapterAccent.chapter_1 ?? "#35E0C3", a) : `rgba(245,245,250,${a})`;
        g.beginPath();
        g.arc(x, y, size, 0, Math.PI * 2);
        g.fill();
      }
      const accent = pal.chapterAccent.chapter_1 ?? pal.friendly.hero;
      const horiz = g.createLinearGradient(0, this.H * 0.75, 0, this.H);
      horiz.addColorStop(0, rgba(accent, 0));
      horiz.addColorStop(1, rgba(accent, 0.06));
      g.fillStyle = horiz;
      g.fillRect(0, this.H * 0.75, this.W, this.H * 0.25);
      const vig = g.createRadialGradient(this.W / 2, this.H * 0.55, this.H * 0.18, this.W / 2, this.H * 0.55, this.H * 0.72);
      vig.addColorStop(0, "rgba(7,8,15,0)");
      vig.addColorStop(1, "rgba(7,8,15,0.62)");
      g.fillStyle = vig;
      g.fillRect(0, 0, this.W, this.H);
      return c;
    }
    drawBackground(ctx, session, t, wallRatio, sh) {
      const key = `${this.W}x${this.H}`;
      if (!this.bg || this.bgKey !== key) {
        this.bg = this.buildBackground(session);
        this.bgKey = key;
      }
      ctx.fillStyle = this.palette.background.nightDeep;
      ctx.fillRect(0, 0, this.W, this.H);
      ctx.drawImage(this.bg, sh.x, sh.y);
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      for (let i = 0; i < 22; i++) {
        const speed = 6 + hash01(i * 2.3) * 18;
        const x = (hash01(i * 9.1) * this.W + t * speed) % this.W;
        const y = hash01(i * 4.7) * this.H * 0.9;
        const a = 0.05 + 0.09 * (0.5 + 0.5 * Math.sin(t * 0.7 + i));
        ctx.fillStyle = rgba(i % 5 === 0 ? this.palette.chapterAccent.chapter_1 ?? "#35E0C3" : "#F5F5FA", a);
        ctx.beginPath();
        ctx.arc(x, y, 1.1 + hash01(i * 6.1) * 1.2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
      if (wallRatio < 0.3) {
        const k = 1 - wallRatio / 0.3;
        const pulse = 0.5 + 0.5 * Math.sin(t * 4);
        const g = ctx.createRadialGradient(this.W / 2, this.H * 0.5, this.H * 0.3, this.W / 2, this.H * 0.5, this.H * 0.8);
        g.addColorStop(0, "rgba(255,61,113,0)");
        g.addColorStop(1, `rgba(255,61,113,${(0.1 + 0.12 * pulse) * k})`);
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, this.W, this.H);
      }
    }
    // ---------------- 城墙 ----------------
    drawWall(ctx, session, ratio, t, _dt) {
      const pal = this.palette;
      const segW = this.W / WALL_SEGS;
      const top = session.level.wall.height;
      const warn = ratio < 0.3;
      const damaged = ratio < 0.55;
      for (let i = 0; i < WALL_SEGS; i++) {
        const flash = this.wallFlash[i];
        const heal = this.wallHeal[i];
        const shakeX = flash > 0 ? Math.sin(t * 90 + i) * 3 * (flash / 0.26) : 0;
        const x = i * segW + 3 + shakeX;
        const w = segW - 6;
        const segSeed = hash01(i * 7.7 + 1.3);
        const ruin = ratio < 0.2 && segSeed > 0.55 ? 1 : ratio < 0.4 && segSeed > 0.8 ? 0.6 : 0;
        const baseColor = damaged ? pal.friendly.wallDamaged : pal.friendly.wall;
        const bodyTop = top - 12;
        if (ruin < 1) {
          ctx.beginPath();
          ctx.roundRect(x, 6, w, bodyTop, 8);
          ctx.fillStyle = baseColor;
          ctx.fill();
          ctx.beginPath();
          ctx.roundRect(x, bodyTop - 6, w, 6, 4);
          ctx.fillStyle = rgba(lighten(baseColor, 0.35), 0.9);
          ctx.fill();
          ctx.beginPath();
          ctx.roundRect(x, 6, w, 8, 4);
          ctx.fillStyle = rgba(darken(baseColor, 0.45), 0.8);
          ctx.fill();
          ctx.strokeStyle = rgba(darken(baseColor, 0.55), 0.55);
          ctx.lineWidth = 1.4;
          const rows = Math.max(2, Math.floor(bodyTop / 22));
          for (let rIdx = 1; rIdx < rows; rIdx++) {
            const yy = 6 + bodyTop * rIdx / rows;
            ctx.beginPath();
            ctx.moveTo(x + 2, yy);
            ctx.lineTo(x + w - 2, yy);
            ctx.stroke();
            const offset = rIdx % 2 === 0 ? segW * 0.25 : segW * 0.5;
            ctx.beginPath();
            ctx.moveTo(x + offset, yy);
            ctx.lineTo(x + offset, yy - bodyTop / rows);
            ctx.stroke();
          }
          const merlons = 3;
          for (let k = 0; k < merlons; k++) {
            const missing = ruin >= 0.6 && hash01(i * 3.1 + k) > 0.55 || damaged && hash01(i * 5.3 + k) > 0.82;
            if (missing) continue;
            const mw = w * 0.22;
            const mx = x + w * (0.08 + k * 0.34);
            ctx.beginPath();
            ctx.roundRect(mx, top - 2, mw, 12, 3);
            ctx.fillStyle = baseColor;
            ctx.fill();
            ctx.beginPath();
            ctx.roundRect(mx, top + 7, mw, 3, 1.5);
            ctx.fillStyle = rgba(lighten(baseColor, 0.4), 0.85);
            ctx.fill();
          }
          if (ratio < 0.7 || ruin > 0) {
            const cracks = ratio < 0.3 ? 3 : ratio < 0.55 ? 2 : 1;
            ctx.strokeStyle = rgba("#07080F", 0.55);
            ctx.lineWidth = 1.6;
            for (let k = 0; k < cracks; k++) {
              const cx = x + w * (0.2 + hash01(i * 9.1 + k) * 0.6);
              const cy = 6 + bodyTop * (0.2 + hash01(i * 4.2 + k) * 0.5);
              ctx.beginPath();
              ctx.moveTo(cx, top - 4);
              ctx.lineTo(cx + (hash01(i + k) - 0.5) * 14, cy);
              ctx.lineTo(cx + (hash01(i * 2 + k) - 0.5) * 20, cy - 12);
              ctx.stroke();
            }
          }
          if (flash > 0) {
            ctx.beginPath();
            ctx.roundRect(x, 6, w, bodyTop, 8);
            ctx.fillStyle = rgba("#FFFFFF", 0.55 * (flash / 0.26));
            ctx.fill();
          }
          if (heal > 0) {
            ctx.beginPath();
            ctx.roundRect(x, 6, w, bodyTop, 8);
            ctx.fillStyle = rgba("#5EE1FF", 0.28 * (heal / 0.5));
            ctx.fill();
          }
        }
        if (warn) {
          const pulse = 0.35 + 0.3 * Math.sin(t * 3 + i * 0.4);
          ctx.fillStyle = rgba("#FF3D71", 0.1 + 0.08 * pulse);
          ctx.beginPath();
          ctx.roundRect(x, 6, w, bodyTop, 8);
          ctx.fill();
          ctx.strokeStyle = rgba("#FF3D71", pulse);
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(x, top + 10);
          ctx.lineTo(x + w, top + 10);
          ctx.stroke();
        }
      }
      ctx.strokeStyle = rgba(lighten(pal.friendly.wall, 0.5), 0.35);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, 5);
      ctx.lineTo(this.W, 5);
      ctx.stroke();
    }
    // ---------------- 虫苔 ----------------
    drawCreep(ctx, session, t) {
      if (session.creep.size === 0) return;
      const CELL2 = 90;
      const creepColor = "#7CB342";
      for (const [key, until] of session.creep) {
        const cx = Math.floor(key / 4096);
        const cy = key % 4096;
        const x = cx * CELL2;
        const y = cy * CELL2;
        const left = until - session.timeSec;
        const fade = Math.min(1, Math.max(0, left / 3));
        const s = hash01(cx * 3.7 + cy * 9.1);
        ctx.fillStyle = rgba(creepColor, 0.14 * fade);
        ctx.beginPath();
        ctx.ellipse(x + CELL2 * 0.5 + (s - 0.5) * 10, y + CELL2 * 0.5, CELL2 * 0.56, CELL2 * 0.46, s * 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = rgba(creepColor, 0.1 * fade);
        ctx.beginPath();
        ctx.ellipse(x + CELL2 * 0.4, y + CELL2 * 0.58, CELL2 * 0.36, CELL2 * 0.3, -s, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = rgba("#AEEA00", (0.12 + 0.06 * Math.sin(t * 2 + s * 6)) * fade);
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.ellipse(x + CELL2 * 0.5, y + CELL2 * 0.5, CELL2 * 0.5, CELL2 * 0.4, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = rgba("#D8FF50", 0.22 * fade);
        ctx.beginPath();
        ctx.arc(x + CELL2 * (0.3 + s * 0.4), y + CELL2 * (0.3 + s * 0.5), 2 + Math.sin(t * 3 + s * 9), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // ---------------- 虫巢对抗模式实体（docs/13） ----------------
    /** 瘤/虫巢/地堡：画在菌毯之上、怪物之下。 */
    drawHiveEntities(ctx, session, t) {
      const hive = session.hiveSystem;
      if (!hive) return;
      for (const b of hive.bunkers) {
        if (b.hp <= 0) {
          ctx.fillStyle = "rgba(40,42,60,0.5)";
          ctx.beginPath();
          ctx.arc(b.x, b.y, b.r * 0.5, 0, Math.PI * 2);
          ctx.fill();
          continue;
        }
        ctx.strokeStyle = "rgba(53,224,195,0.22)";
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 6]);
        ctx.strokeRect(b.x - b.r, b.y - b.r, b.r * 2, b.r * 2);
        ctx.setLineDash([]);
        ctx.fillStyle = "#12303F";
        ctx.beginPath();
        for (let i = 0; i < 6; i++) {
          const a = Math.PI / 3 * i + Math.PI / 6;
          const px = b.x + Math.cos(a) * 24;
          const py = b.y + Math.sin(a) * 24;
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = "#35E0C3";
        ctx.lineWidth = 2;
        ctx.stroke();
        const hk = b.hp / b.maxHp;
        ctx.fillStyle = "rgba(7,8,15,0.6)";
        ctx.fillRect(b.x - 18, b.y - 34, 36, 5);
        ctx.fillStyle = "#35E0C3";
        ctx.fillRect(b.x - 18, b.y - 34, 36 * hk, 5);
      }
      for (const tu of hive.tumors) {
        const alive = !tu.dormant;
        const hpk = tu.hp / tu.maxHp;
        ctx.strokeStyle = alive ? "rgba(85,139,47,0.7)" : "rgba(90,95,90,0.4)";
        ctx.lineWidth = 2;
        for (let i = 0; i < 4; i++) {
          const a = Math.PI / 2 * i + 0.4 + tu.id;
          ctx.beginPath();
          ctx.moveTo(tu.x + Math.cos(a) * 10, tu.y + Math.sin(a) * 10);
          ctx.lineTo(tu.x + Math.cos(a) * 22, tu.y + Math.sin(a) * 22);
          ctx.stroke();
        }
        const breathe = 1 + (alive ? 0.06 * Math.sin(t * 4 + tu.id) : 0);
        ctx.fillStyle = alive ? "#558B2F" : "#4A4F45";
        ctx.beginPath();
        ctx.arc(tu.x, tu.y, 16 * breathe, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "rgba(11,12,29,0.8)";
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.fillStyle = alive ? `rgba(174,234,0,${0.65 + 0.25 * Math.sin(t * 5 + tu.id)})` : "rgba(140,150,130,0.35)";
        ctx.beginPath();
        ctx.arc(tu.x, tu.y - 6, 7 * breathe, 0, Math.PI * 2);
        ctx.fill();
        if (alive && hpk < 1) {
          ctx.fillStyle = "rgba(7,8,15,0.6)";
          ctx.fillRect(tu.x - 16, tu.y - 28, 32, 4);
          ctx.fillStyle = "#AEEA00";
          ctx.fillRect(tu.x - 16, tu.y - 28, 32 * hpk, 4);
        }
        if (tu.dormant) {
          const k = 1 - tu.dormantLeft / 6;
          ctx.strokeStyle = "rgba(140,150,130,0.5)";
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(tu.x, tu.y, 20, -Math.PI / 2, -Math.PI / 2 + k * Math.PI * 2);
          ctx.stroke();
        }
      }
      const h = hive.hive;
      if (!h.dead) {
        const R = 46;
        const pulse = 1 + 0.03 * Math.sin(t * 2.2);
        ctx.fillStyle = "rgba(85,139,47,0.25)";
        ctx.beginPath();
        ctx.ellipse(h.x, h.y, R * 1.7, R * 1.2, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#3E5B21";
        ctx.beginPath();
        ctx.arc(h.x, h.y, R * pulse, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#558B2F";
        ctx.beginPath();
        ctx.arc(h.x, h.y - 6, R * 0.72 * pulse, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#9CCC65";
        ctx.beginPath();
        ctx.arc(h.x, h.y - 12, R * 0.4 * pulse, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = `rgba(216,255,80,${0.5 + 0.3 * Math.sin(t * 3)})`;
        ctx.beginPath();
        ctx.arc(h.x, h.y - 12, R * 0.16, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "rgba(11,12,29,0.85)";
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(h.x, h.y, R * pulse, 0, Math.PI * 2);
        ctx.stroke();
        const ak = h.armor / h.armorMax;
        if (ak > 0) {
          ctx.strokeStyle = "rgba(199,206,230,0.75)";
          ctx.lineWidth = 4;
          ctx.beginPath();
          ctx.arc(h.x, h.y, R * 1.18, -Math.PI * 0.35, -Math.PI * 0.35 + ak * Math.PI * 1.7);
          ctx.stroke();
          const cracks = Math.round((1 - ak) * 5);
          ctx.strokeStyle = "rgba(11,12,29,0.7)";
          ctx.lineWidth = 1.6;
          for (let i = 0; i < cracks; i++) {
            const a = Math.PI * 2 * i / 5 + h.x * 0.01;
            ctx.beginPath();
            ctx.moveTo(h.x + Math.cos(a) * R * 0.55, h.y + Math.sin(a) * R * 0.55);
            ctx.lineTo(h.x + Math.cos(a) * R * 1.05, h.y + Math.sin(a) * R * 1.05);
            ctx.stroke();
          }
        }
        if (h.migrateLeft > 0) {
          ctx.strokeStyle = "rgba(85,139,47,0.5)";
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.moveTo(h.x, h.y);
          ctx.lineTo(h.x - Math.sign(h.targetX - h.x) * 70, h.y + 10);
          ctx.stroke();
        }
        if (h.armor <= 0) {
          const hk2 = h.hp / h.maxHp;
          ctx.fillStyle = "rgba(7,8,15,0.65)";
          ctx.fillRect(h.x - 40, h.y + R * 1.35, 80, 7);
          ctx.fillStyle = "#FF3D71";
          ctx.fillRect(h.x - 40, h.y + R * 1.35, 80 * hk2, 7);
        }
      }
    }
    // ---------------- 血条 ----------------
    drawHpBar(ctx, m) {
      if (m.hp >= m.maxHp || m.hp <= 0) return;
      const r = m.cfg.radius;
      const w = Math.max(24, r * 2);
      const k = Math.max(0, m.hp / m.maxHp);
      const y = m.y - r - 12;
      const x = m.x - w / 2;
      const boss = m.cfg.shape === "boss";
      const hgt = boss ? 7 : 4;
      ctx.fillStyle = "rgba(7,8,15,0.6)";
      ctx.beginPath();
      ctx.roundRect(x - 1, y - 1, w + 2, hgt + 2, (hgt + 2) / 2);
      ctx.fill();
      const color = k > 0.5 ? "#FF6B57" : k > 0.25 ? "#FF3D71" : "#FFD54F";
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.roundRect(x, y, Math.max(1.5, w * k), hgt, hgt / 2);
      ctx.fill();
      if (boss) {
        ctx.strokeStyle = rgba("#B537F2", 0.8);
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.roundRect(x - 1, y - 1, w + 2, hgt + 2, (hgt + 2) / 2);
        ctx.stroke();
      }
    }
  };

  // src/adapter/web/lab.ts
  var W = 1080;
  var H = 1920;
  var LAB_LEVEL = "/configs/levels/lab_arena.json";
  async function fetchJson(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`\u52A0\u8F7D\u5931\u8D25: ${url}`);
    return r.json();
  }
  async function boot() {
    const [palette, weaponsFile, monstersFile, cardsFile, level, fxConfig] = await Promise.all([
      fetchJson("/configs/art-style/palette.json"),
      fetchJson("/configs/weapons.json"),
      fetchJson("/configs/monsters.json"),
      fetchJson("/configs/cards.json"),
      fetchJson(LAB_LEVEL),
      loadFxConfig()
    ]);
    const fx = new FxRuntime(fxConfig);
    const scene = new SceneRenderer(W, H, palette, fx);
    const canvas = document.getElementById("game");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    const input = { tx: W / 2, ty: 300, hasTarget: false, keys: /* @__PURE__ */ new Set() };
    const toGameCoords = (e) => {
      const rect = canvas.getBoundingClientRect();
      return {
        x: (e.clientX - rect.left) / rect.width * W,
        y: (e.clientY - rect.top) / rect.height * H
      };
    };
    canvas.addEventListener("pointerdown", (e) => {
      canvas.setPointerCapture(e.pointerId);
      const p = toGameCoords(e);
      input.tx = p.x;
      input.ty = p.y;
      input.hasTarget = true;
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!input.hasTarget) return;
      const p = toGameCoords(e);
      input.tx = p.x;
      input.ty = p.y;
    });
    const release = () => {
      input.hasTarget = false;
    };
    canvas.addEventListener("pointerup", release);
    canvas.addEventListener("pointercancel", release);
    window.addEventListener("keydown", (e) => input.keys.add(e.key.toLowerCase()));
    window.addEventListener("keyup", (e) => input.keys.delete(e.key.toLowerCase()));
    window.addEventListener("blur", () => input.keys.clear());
    let session;
    function createSession(weaponId) {
      const weapon = weaponsFile.weapons.find((w) => w.id === weaponId) ?? weaponsFile.weapons[0];
      session = new GameSession({
        level,
        weaponConfigs: [weapon],
        monsterConfigs: new Map(monstersFile.monsters.map((m) => [m.id, m])),
        cardConfigs: cardsFile.cards,
        seed: Date.now() % 1e5 | 0,
        controller: {
          getMoveDir(s) {
            const k = input.keys;
            let dx = 0;
            let dy = 0;
            if (k.has("a") || k.has("arrowleft")) dx -= 1;
            if (k.has("d") || k.has("arrowright")) dx += 1;
            if (k.has("w") || k.has("arrowup")) dy += 1;
            if (k.has("s") || k.has("arrowdown")) dy -= 1;
            if (dx !== 0 || dy !== 0) return { x: dx, y: dy };
            if (!input.hasTarget) return { x: 0, y: 0 };
            const ddx = input.tx - s.hero.x;
            const ddy = input.ty - s.hero.y;
            const d = Math.hypot(ddx, ddy);
            if (d < 14) {
              input.hasTarget = false;
              return { x: 0, y: 0 };
            }
            return { x: ddx / d, y: ddy / d };
          }
        },
        cardPolicy: greedyDpsPolicy
      });
      session.sandboxMode = true;
      scene.attach(session);
    }
    const cardGrid = document.getElementById("cardgrid");
    const cardBtns = /* @__PURE__ */ new Map();
    const elementNames = {
      fire: "\u706B\u7130",
      frost: "\u5BD2\u51B0",
      lightning: "\u95EA\u7535",
      poison: "\u6BD2\u7D20",
      physical: "\u7269\u7406"
    };
    const renderCards = () => {
      cardGrid.innerHTML = "";
      cardBtns.clear();
      const typeTag = { bullet: "\u5B50\u5F39", wall: "\u57CE\u5899", form: "\u5F62\u6001", passive: "\u5C5E\u6027", element: "\u5143\u7D20" };
      const weaponNames = new Map(weaponsFile.weapons.map((w) => [w.id, w.name]));
      const current = weaponsFile.weapons.find((w) => w.id === currentWeapon) ?? weaponsFile.weapons[0];
      const exclusive = cardsFile.cards.filter((c) => c.target?.kind === "weapon" && c.target.weaponType === current.id);
      const shared = cardsFile.cards.filter((c) => c.target?.kind !== "weapon");
      const addGroup = (title, list) => {
        if (list.length === 0) return;
        const h = document.createElement("div");
        h.className = "secgroup";
        h.textContent = title;
        cardGrid.appendChild(h);
        for (const c of list) {
          const targetTag = !c.target || c.target.kind === "any" ? "\u516C\u5171" : `${elementNames[c.target.element] ?? "\u5143\u7D20"}\xB7\u5143\u7D20`;
          const btn = document.createElement("button");
          btn.className = `cbtn t-${c.type}`;
          const cnt = document.createElement("span");
          cnt.className = "cnt";
          const label = document.createElement("span");
          label.innerHTML = `${c.name}<br><small>[${typeTag[c.type]}\uFF5C${targetTag}] ${c.desc ?? ""}</small>`;
          btn.appendChild(cnt);
          btn.appendChild(label);
          btn.onclick = () => {
            if (session.grantCard(c.id)) {
              log(`\u2713 ${c.name} \u2192 ${c.desc ?? ""}`);
              renderCards();
            } else {
              log(`\u2717 ${c.name}\uFF1A\u4E0D\u53EF\u7528\uFF08\u672A\u6EE1\u8DB3\u76EE\u6807\u6761\u4EF6\u6216\u5DF2\u8FBE\u4E0A\u9650\uFF09`);
            }
          };
          cardGrid.appendChild(btn);
          cardBtns.set(c.id, { btn, cnt });
        }
      };
      addGroup(`\u4E13\u5C5E\u5361 \xB7 ${weaponNames.get(current.id) ?? current.name}\uFF08${exclusive.length}\uFF09`, exclusive);
      addGroup(`\u516C\u5171\u5361\uFF08${shared.length}\uFF09`, shared);
      refreshCardStates();
    };
    const refreshCardStates = () => {
      for (const c of cardsFile.cards) {
        const entry = cardBtns.get(c.id);
        if (!entry) continue;
        const stacks = session.cardPickLog.filter((l) => l.startsWith(c.name + "(")).length;
        const full = stacks >= c.maxStack;
        const applicable = session.isCardApplicable(c);
        entry.btn.disabled = full || !applicable;
        entry.btn.classList.toggle("gated", !full && !applicable);
        entry.cnt.textContent = full ? `${stacks}/${c.maxStack} \u6EE1` : !applicable ? gateReason(c) : `${stacks}/${c.maxStack}`;
      }
    };
    const gateReason = (c) => {
      const e = c.effect;
      if ("boostElement" in e) return `\u9700${e.boostElement === "fire" ? "\u706B" : "\u51B0"}\u5C5E\u6027`;
      if ("grantElement" in e) return "\u5DF2\u8D4B\u5143\u7D20";
      if (c.target?.kind === "weapon") return "\u9700\u5BF9\u5E94\u6B66\u5668";
      return "\u672A\u6EE1\u8DB3";
    };
    const monGrid = document.getElementById("mongrid");
    const monTip = document.getElementById("mon-tip");
    const mechanismLines = (m) => {
      const out = [];
      switch (m.behavior) {
        case "dash":
          out.push({ text: "\u51B2\u523A\uFF1A\u524D\u6447 0.4s \u540E 3.2 \u500D\u901F\u7A81\u8FDB" });
          break;
        case "zigzag":
          out.push({ text: "\u86C7\u5F62\u884C\u8FDB\uFF1A\u6446\u52A8\u8EB2\u907F\u76F4\u7EBF\u5F39\u9053" });
          break;
        case "ranged":
          out.push({ text: `\u8FDC\u7A0B\uFF1A\u8DDD\u5899 ${m.rangedDist ?? 260}px \u505C\u9A7B\u629B\u5C04\uFF08\u5F39\u9053\u53EF\u88AB\u8D70\u4F4D\u89C4\u907F\uFF09` });
          break;
        case "burrow_regen":
          out.push({ text: `\u94BB\u5730\u56DE\u8840\uFF1A\u8840\u91CF <${Math.round((m.burrowRegen?.threshold ?? 0) * 100)}% \u65F6\u5165\u5730 ${m.burrowRegen?.duration}s\uFF0C\u51FA\u571F\u56DE\u590D ${Math.round((m.burrowRegen?.heal ?? 0) * 100)}%`, warn: true });
          break;
        case "burrow_siege":
          out.push({ text: `\u94BB\u5730\u653B\u5899\uFF1A\u8DDD\u5899 ${m.burrowSiege?.dist}px \u6C38\u4E45\u5165\u5730\uFF08\u6253\u4E0D\u5230\uFF01\uFF09\uFF0C\u5730\u4E0B\u6301\u7EED\u523A\u51FB\u57CE\u5899`, warn: true });
          break;
        case "burrow_charge":
          out.push({ text: `\u94BB\u5730\u51B2\u950B\uFF1A\u6BCF ${m.burrowCharge?.interval}s \u5165\u5730 ${m.burrowCharge?.duration}s\uFF0C\u5899\u524D\u51FA\u571F\u91CD\u51FB -${m.burrowCharge?.dmg} \u57CE\u9632`, warn: true });
          break;
        case "splitter":
          out.push({ text: "\u589E\u6B96\uFF1A\u5B9A\u65F6\u5206\u88C2 + \u6B7B\u540E\u88C2\u53CC" });
          break;
        default:
          break;
      }
      if (m.hitShield) out.push({ text: `\u62A4\u7532\uFF1A${m.hitShield} \u6B21\u514D\u4F24\uFF08\u76F4\u63A5\u547D\u4E2D\u6D88\u8017\uFF0CDoT/\u4F24\u5BB3\u5708\u4E0D\u6D88\u8017\uFF09` });
      if (m.burnImmune) out.push({ text: "\u707C\u70E7\u514D\u75AB\uFF1A\u4E0D\u53EF\u88AB\u70B9\u71C3" });
      if (m.healAura) out.push({ text: `\u6CBB\u7597\u5149\u73AF\uFF1A\u534A\u5F84 ${m.healAura.radius} \u6BCF ${m.healAura.interval}s \u56DE ${m.healAura.amount}`, warn: true });
      if (m.splitTimer) out.push({ text: `\u5B9A\u65F6\u5206\u88C2\uFF1A\u6BCF ${m.splitTimer.interval}s \u5206\u51FA 1 \u53EA\u5E7C\u4F53\uFF08\u540C\u8840\u6761/\u66F4\u5FEB/\u4E0D\u53EF\u518D\u5206\u88C2\uFF09` });
      if (m.deathSplit) out.push({ text: `\u6B7B\u4EA1\u5206\u88C2\uFF1A\u88C2\u4E3A ${m.deathSplit.count} \u53EA\u5E7C\u4F53` });
      if (m.escort) out.push({ text: `\u51FA\u573A\u62A4\u536B\uFF1A${m.escort.count} \u53EA${m.escort.monster === "bulwark" ? "\u5CA9\u7532\u517D" : m.escort.monster}\u73AF\u5F62\u62A4\u536B` });
      if (m.transferAura) out.push({ text: `\u4F24\u5BB3\u8F6C\u5AC1\uFF1A\u53D7\u51FB\u8F6C\u79FB\u7ED9 ${m.transferAura.radius}px \u5185\u53CB\u519B\u4EE3\u4F24`, warn: true });
      if (m.formationDist) out.push({ text: `\u8FD1\u5899\u53D8\u9635\uFF08${m.formationDist}px\uFF09\uFF1A\u62A4\u536B\u5C55\u5F00\u6A2A\u6392\u3001\u672C\u4F53\u5C45\u4E2D` });
      if (m.detonate) out.push({ text: `\u81EA\u7206\uFF1A\u649E\u5899\u6216\u6B7B\u4EA1\uFF0C\u57CE\u9632 -${m.detonate.wallDamage}`, warn: true });
      if (m.creepTrail) out.push({ text: `\u94FA\u866B\u82D4\uFF1A\u6BCF ${m.creepTrail.interval}s \u4E00\u5757\uFF08\u866B\u65CF\u52A0\u901F 25% \u56DE\u8840 2/s\uFF09` });
      if (m.creepBenefit) out.push({ text: "\u866B\u65CF\uFF1A\u7AD9\u4E0A\u866B\u82D4\u52A0\u901F +25%\u3001\u56DE\u8840 2/s" });
      if (m.weak?.length) out.push({ text: `\u5F31\u70B9\uFF1A${m.weak.join("/")} \u4F24\u5BB3 \xD71.25` });
      if (m.resist?.length) out.push({ text: `\u6297\u6027\uFF1A${m.resist.join("/")} \u4F24\u5BB3 \xD70.75` });
      return out;
    };
    const showMonTip = (m, e) => {
      const mech = mechanismLines(m);
      monTip.innerHTML = `<div class="t-name">${m.name}</div><div class="t-stats">HP ${m.hp} \xB7 \u653B ${m.atk}/${m.attackInterval}s \xB7 \u901F ${m.speed} \xB7 \u9632 ${m.def} \xB7 \u7ECF\u9A8C ${m.xp}</div><ul class="t-mech" style="margin:0;padding-left:16px;">` + mech.map((l) => `<li${l.warn ? ' class="warn"' : ""}>${l.text}</li>`).join("") + (mech.length === 0 ? "<li>\u65E0\u7279\u6B8A\u673A\u5236\uFF08\u57FA\u7840\u538B\u5899\u602A\uFF09</li>" : "") + "</ul>";
      monTip.style.display = "block";
      moveMonTip(e);
    };
    const moveMonTip = (e) => {
      const pad = 14;
      const rect = monTip.getBoundingClientRect();
      let x = e.clientX + pad;
      let y = e.clientY + pad;
      if (x + rect.width > window.innerWidth - 8) x = e.clientX - rect.width - pad;
      if (y + rect.height > window.innerHeight - 8) y = e.clientY - rect.height - pad;
      monTip.style.left = `${x}px`;
      monTip.style.top = `${y}px`;
    };
    const hideMonTip = () => {
      monTip.style.display = "none";
    };
    const bindMonTip = (btn, m) => {
      btn.addEventListener("mouseenter", (e) => showMonTip(m, e));
      btn.addEventListener("mousemove", moveMonTip);
      btn.addEventListener("mouseleave", hideMonTip);
    };
    for (const m of monstersFile.monsters) {
      const btn = document.createElement("button");
      btn.className = "mbtn";
      btn.textContent = `+ ${m.name}${m.escort ? "\uFF08\u5E26\u62A4\u536B\u73AF\uFF09" : ""}`;
      btn.onclick = () => {
        const x = 150 + Math.random() * (W - 300);
        const y = 1250 + Math.random() * 450;
        session.debugSpawn(m.id, x, y);
        log(`+ \u751F\u6210 ${m.name}${m.escort ? " + \u62A4\u536B\u73AF" : ""} @ (${x.toFixed(0)}, ${y.toFixed(0)})`);
      };
      bindMonTip(btn, m);
      monGrid.appendChild(btn);
    }
    const soloShaman = document.createElement("button");
    soloShaman.className = "mbtn";
    soloShaman.textContent = "+ \u5DEB\u5E08\uFF08\u5355\u72EC\uFF09";
    const shamanCfg = monstersFile.monsters.find((x) => x.id === "shaman");
    if (shamanCfg) bindMonTip(soloShaman, shamanCfg);
    soloShaman.onclick = () => {
      const x = 200 + Math.random() * (W - 400);
      const y = 1e3 + Math.random() * 400;
      session.debugSpawn("shaman", x, y, { noEscort: true });
      log(`+ \u751F\u6210 \u5DEB\u5E08\uFF08\u65E0\u62A4\u536B\uFF09@ (${x.toFixed(0)}, ${y.toFixed(0)})`);
    };
    monGrid.appendChild(soloShaman);
    document.getElementById("clear").onclick = () => {
      session.monsters.forEach((m) => {
        m.hp = 0;
      });
      log("\u6E05\u573A");
    };
    document.getElementById("beam").onclick = () => {
      session.debugBeam(Math.PI / 2, 1400, 60, 3);
      log("\u26A1 \u5149\u675F\uFF1A\u82F1\u96C4\u6B63\u4E0A\u65B9 1400px\uFF0C60 dps \xD7 3s");
    };
    document.getElementById("link").onclick = () => {
      const y = 700 + Math.random() * 600;
      session.debugLink(100, y, W - 100, y, 60, 3);
      log(`\u26A1 \u7535\u7F51\u8FDE\u7EBF\uFF1Ay=${y.toFixed(0)}\uFF0C60 dps \xD7 3s`);
    };
    document.getElementById("reset").onclick = () => location.reload();
    const weaponSelect = document.getElementById("weaponselect");
    const wprofile = document.getElementById("wprofile");
    let currentWeapon = new URLSearchParams(location.search).get("weapon") ?? weaponsFile.weapons[0].id;
    const renderWeaponProfile = () => {
      const w = weaponsFile.weapons.find((x) => x.id === currentWeapon) ?? weaponsFile.weapons[0];
      const tags = [];
      if (w.chainBase) tags.push(`\u843D\u96F7\u8FDE\u9501 \xD7${w.chainBase}`);
      if (w.blastBase) tags.push(`\u843D\u5730\u7206\u7834\u5708 r${Math.round(w.blastBase.radius)}`);
      if (w.motion?.type === "parabola") tags.push("\u629B\u7269\u7EBF\u5F39\u9053");
      if (w.motion?.type === "phased") tags.push("\u98DE\u51FA\u2192\u8FD4\u56DE");
      if ((w.pierce ?? 0) > 0) tags.push(`\u7A7F\u900F ${w.pierce}`);
      if (w.pierceFalloff) tags.push(`\u7A7F\u900F\u8870\u51CF ${Math.round(w.pierceFalloff * 100)}%/\u6B21`);
      wprofile.innerHTML = `<span class="role">${w.role ?? ""}</span><span class="chip">${elementNames[w.damageType] ?? w.damageType}</span><span class="chip">\u4F24\u5BB3 ${w.baseDamage} \xB7 ${w.interval}s \xB7 ${w.count} \u53D1</span>` + tags.map((t) => `<span class="chip mech">${t}</span>`).join("");
    };
    const renderWeaponSelect = () => {
      weaponSelect.innerHTML = "";
      for (const w of weaponsFile.weapons) {
        const btn = document.createElement("button");
        btn.className = `wbtn${w.id === currentWeapon ? " active" : ""}`;
        btn.innerHTML = `${w.name}<br><small style="opacity:.6;font-size:11px">${w.role ?? ""}</small>`;
        btn.onclick = () => {
          if (w.id === currentWeapon) return;
          currentWeapon = w.id;
          createSession(w.id);
          renderWeaponSelect();
          renderWeaponProfile();
          renderCards();
          log(`\u5207\u6362\u6B66\u5668\u6784\u7B51\uFF1A${w.name}\uFF08\u4E13\u5C5E\u5361\u5DF2\u5207\u6362\uFF09`);
        };
        weaponSelect.appendChild(btn);
      }
    };
    let autoSpawn = false;
    let spawnAcc = 0;
    const autoBtn = document.getElementById("autospawn");
    autoBtn.onclick = () => {
      autoSpawn = !autoSpawn;
      autoBtn.textContent = `\u8FDE\u7EED\u51FA\u602A\uFF1A${autoSpawn ? "\u5F00" : "\u5173"}`;
      log(`\u8FDE\u7EED\u51FA\u602A ${autoSpawn ? "\u5F00\u542F\uFF08\u573A\u4E0A<25 \u53EA\u65F6\u6301\u7EED\u8FDB\u573A\uFF09" : "\u5173\u95ED"}`);
    };
    const logBox = document.getElementById("log");
    const log = (s) => {
      const el = document.createElement("div");
      el.textContent = s;
      logBox.prepend(el);
      while (logBox.children.length > 30) logBox.lastChild?.remove();
    };
    const statsEl = document.getElementById("stats");
    const fmt = (n) => (Math.round(n * 100) / 100).toString();
    const renderStats = () => {
      const h = session.hero;
      const w = h.weapons[0];
      const a = w.affixes;
      const r = w.riders;
      statsEl.innerHTML = `
      <h3>\u82F1\u96C4\u5C5E\u6027</h3>
      <table>
        <tr><td>\u653B\u51FB</td><td>${fmt(h.stats.atk)}</td><td>\u653B\u901F</td><td>${fmt(h.stats.aspd)}</td></tr>
        <tr><td>\u66B4\u51FB\u7387</td><td>${fmt(h.stats.critChance * 100)}%</td><td>\u66B4\u51FB\u4F24\u5BB3</td><td>${fmt(h.stats.critDmg * 100)}%</td></tr>
        <tr><td>\u5168\u4F24\u52A0\u6210</td><td>${fmt(h.stats.dmgMul * 100)}%</td><td>\u7B49\u7EA7</td><td>${h.level}</td></tr>
      </table>
      <h3>\u6B66\u5668\u9762\u677F\uFF08${w.cfg.name}\uFF09</h3>
      <table>
        <tr><td>\u5355\u53D1\u4F24\u5BB3</td><td>${w.cfg.ghost && w.cfg.blastBase ? `\u6C60 ${fmt(w.damage * w.mods.damageMul * w.cfg.blastBase.poolDpsMul)}/s \xD7 ${w.cfg.blastBase.poolSec}s` : w.cfg.ghost ? "0\uFF08\u7EAF\u8303\u56F4\uFF09" : fmt(w.damage * w.mods.damageMul)}</td><td>\u653B\u51FB\u95F4\u9694</td><td>${fmt(w.cfg.interval / h.stats.aspd)}s</td></tr>
        <tr><td>\u5F39\u901F</td><td>${fmt(w.cfg.projectileSpeed * w.mods.projSpeedMul)}</td><td>\u5C04\u7A0B</td><td>${fmt(w.cfg.projectileRange * w.mods.rangeMul)}</td></tr>
        <tr><td>\u9F50\u5C04</td><td>${w.cfg.count + w.mods.extraCount} \u53D1</td><td>\u8FDE\u5C04</td><td>+${w.mods.burst} \u53D1</td></tr>
        <tr><td>\u5143\u7D20</td><td>${w.element}</td><td>\u7A7F\u900F</td><td>${w.cfg.pierce}\uFF08\u8870\u51CF ${Math.round((w.cfg.pierceFalloff ?? 0.15) * 100)}%/\u6B21\uFF09</td></tr>
        <tr><td>\u7206\u7834\u672C\u4F53</td><td colspan="3">${w.cfg.blastBase ? `r${w.cfg.blastBase.radius} \xB7 \u7206\u53D1 ${Math.round(w.cfg.blastBase.dmgMul * 100)}% \xB7 \u5730\u9762 ${Math.round(w.cfg.blastBase.poolDpsMul * 100)}%/s \xD7 ${w.cfg.blastBase.poolSec}s\uFF08\u6C60\u603B\u4F24 \u2248 ${fmt(w.damage * w.mods.damageMul * w.cfg.blastBase.poolDpsMul * w.cfg.blastBase.poolSec)}\uFF09` : '\u2014\uFF08\u53EF\u62FF"\u6269\u7206"\u5361\u83B7\u5F97\uFF09'}</td></tr>
      </table>
      <h3>\u5F62\u6001\u8BCD\u7F00</h3>
      <table>
        <tr><td>\u8FFD\u8E2A</td><td>${a.homing ? "\u2713" : "\u2014"}</td><td>\u5F39\u5C04</td><td>Lv${a.bounce}</td></tr>
        <tr><td>\u5206\u88C2</td><td>Lv${a.split}</td><td>\u7206\u7834</td><td>Lv${a.blast}</td></tr>
        <tr><td>\u7834\u7532</td><td>Lv${a.shred}\uFF08-${a.shred * 3} \u9632\uFF09</td><td>\u8FDE\u9501</td><td>Lv${a.chain}</td></tr>
      </table>
      <h3>\u5143\u7D20\u9A91\u58EB</h3>
      <table>
        <tr><td>\u707C\u70E7</td><td>${r.burnDpsMul > 0 ? `${fmt(r.burnDpsMul * 100)}%/s \xD7 ${r.burnSec}s` : "\u2014\uFF08\u9700\u706B\u5C5E\u6027\uFF09"}</td></tr>
        <tr><td>\u51B0\u51BB</td><td>${r.slowPct > 0 ? `-${Math.round(r.slowPct * 100)}% \xD7 ${r.slowSec}s` : "\u2014\uFF08\u9700\u51B0\u5C5E\u6027\uFF09"}</td></tr>
      </table>
      <h3>\u57CE\u5899</h3>
      <table><tr><td>\u57CE\u9632</td><td>${Math.ceil(session.wallHp)} / ${session.wallMaxHp}</td></tr></table>
      <h3>\u6218\u573A</h3>
      <table>
        <tr><td>\u573A\u4E0A\u602A\u7269</td><td>${session.monsters.length}</td><td>\u6295\u5C04\u7269</td><td>${session.projectiles.length}</td></tr>
        <tr><td>\u4F24\u5BB3\u5708</td><td>${session.pools.length}</td><td>\u603B\u4F24\u5BB3</td><td>${Math.round(session.totalDamage)}</td></tr>
        <tr><td>\u98D8\u5B57\u7F13\u51B2</td><td>${scene.floatCount}</td><td>\u866B\u82D4\u683C</td><td>${session.creep.size}</td></tr>
      </table>`;
    };
    createSession(currentWeapon);
    renderWeaponSelect();
    renderWeaponProfile();
    renderCards();
    log("\u5B9E\u9A8C\u5BA4\u5C31\u7EEA\uFF1A\u4E0A\u65B9\u5207\u6362\u6B66\u5668\u6784\u7B51\uFF0C\u4E0B\u65B9\u5361\u724C\u968F\u4E4B\u5207\u6362\uFF1B\u5DE6\u4FA7\u6218\u573A\u62D6\u52A8/WASD \u79FB\u52A8");
    let renderMs = 0;
    function render() {
      const nowMs = performance.now();
      renderMs = nowMs;
      scene.render(ctx, session, nowMs);
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.textAlign = "center";
      const wallRatio = session.wallHp / session.wallMaxHp;
      const barW = 420;
      const barX = (W - barW) / 2;
      const barSY = H - session.level.wall.height - 38;
      ctx.fillStyle = "rgba(7,8,15,0.65)";
      ctx.beginPath();
      ctx.roundRect(barX - 2, barSY - 2, barW + 4, 12, 6);
      ctx.fill();
      ctx.fillStyle = wallRatio < 0.3 ? "#FF3D71" : "#3D4470";
      ctx.beginPath();
      ctx.roundRect(barX, barSY, barW * wallRatio, 8, 4);
      ctx.fill();
      ctx.fillStyle = "#F5F5FA";
      ctx.font = '700 13px "PingFang SC", "Microsoft YaHei", sans-serif';
      ctx.fillText(`\u57CE\u9632 ${Math.ceil(session.wallHp)} / ${session.wallMaxHp}`, W / 2, barSY - 8);
      ctx.restore();
    }
    let acc = 0;
    let last = performance.now();
    let lastStats = 0;
    function frame(nowMs) {
      const dtF = Math.min((nowMs - last) / 1e3, 0.25);
      acc += dtF;
      last = nowMs;
      while (acc >= 1 / 30) {
        session.step();
        acc -= 1 / 30;
      }
      if (autoSpawn) {
        spawnAcc += dtF;
        if (spawnAcc >= 0.9) {
          spawnAcc = 0;
          if (session.monsters.length < 25) {
            const m = monstersFile.monsters[Math.floor(Math.random() * monstersFile.monsters.length)];
            session.debugSpawn(m.id, 150 + Math.random() * (W - 300), 1250 + Math.random() * 450);
          }
        }
      }
      if (nowMs - lastStats > 250) {
        renderStats();
        refreshCardStates();
        lastStats = nowMs;
      }
      render();
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }
  boot().catch((e) => {
    document.body.innerHTML = `<pre style="color:#FF6B57;padding:2em">\u542F\u52A8\u5931\u8D25\uFF1A${e.message}</pre>`;
  });
})();
