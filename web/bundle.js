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
  function acquireTarget(rule, fromX, fromY, range, monsters, hash, rng, exclude) {
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
      if (exclude && exclude.has(m.id)) continue;
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
  function updateMonster(m, dt, now, wallTopY, onWallHit, onRangedShot, isCreeped) {
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
      } else if (m.cfg.burrowSiege && m.burrowTimer <= 0) {
        m.burrowed = false;
        m.surfaceLeft = m.cfg.burrowSiege.surfaceFor ?? 6;
        m.state = "march";
        m.attackTimer = 0;
      }
      if (m.burrowed && m.cfg.burrowSiege) {
        m.attackTimer -= dt;
        if (m.attackTimer <= 0) {
          m.attackTimer += m.cfg.attackInterval;
          onWallHit(m.cfg.atk, m);
        }
      }
      return;
    }
    if (m.surfaceLeft > 0) m.surfaceLeft = Math.max(0, m.surfaceLeft - dt);
    const holdY = wallTopY + (m.cfg.behavior === "ranged" ? m.cfg.rangedDist ?? RANGED_HOLD_DISTANCE : 0) + r;
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
    }
    if (m.cfg.burrowSiege && m.surfaceLeft <= 0 && m.y <= wallTopY + m.cfg.burrowSiege.dist + r) {
      m.burrowed = true;
      m.burrowTimer = m.cfg.burrowSiege.surfaceEvery ?? Infinity;
      m.y = Math.min(m.y, wallTopY + m.cfg.burrowSiege.dist + r);
    }
  }

  // src/gamecore/hero.ts
  var BASE_ATK = 100;
  var MAX_WEAPONS = 4;
  function xpNeed(level) {
    return Math.round(80 + 40 * level + 6 * level * level);
  }
  function createWeaponInstance(cfg) {
    return {
      cfg,
      level: 1,
      damage: cfg.baseDamage,
      cooldown: 0.3,
      // 开局小延迟，避免第一帧齐射
      shotsSinceCool: 0,
      mods: { extraCount: 0, burst: 0, projSpeedMul: 1, damageMul: 1, rangeMul: 1, pierceAdd: 0, intervalMul: 1, widthMul: 1, beamLifeAdd: 0, heatCoolMul: 1 },
      element: cfg.damageType,
      riders: { burnDpsMul: 0, burnSec: 3, slowPct: 0, slowSec: 2.5 },
      affixes: { homing: 0, bounce: 0, split: 0, shred: 0, blast: 0, chain: 0 }
    };
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
      weapons: weaponCfgs.map(createWeaponInstance)
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
      w.cooldown = w.cfg.interval * mods.intervalMul / hero.stats.aspd;
      if (w.cfg.heat) {
        w.shotsSinceCool++;
        if (w.shotsSinceCool >= w.cfg.heat.shots) {
          w.shotsSinceCool = 0;
          w.cooldown = Math.max(w.cooldown, w.cfg.heat.cooldown * mods.heatCoolMul);
        }
      }
      const n = norm(target.x - hero.x, target.y - hero.y);
      const total = w.cfg.count + mods.extraCount;
      const perShotAim = total > 1 && (w.cfg.motion?.type === "parabola" || w.cfg.splitAim === true);
      const claimed = perShotAim ? /* @__PURE__ */ new Set() : null;
      let shotTarget = target;
      for (let i = 0; i < total; i++) {
        if (claimed) {
          if (i > 0) {
            shotTarget = acquireTarget(w.cfg.targeting, hero.x, hero.y, range, monsters, hash, rng, claimed) ?? acquireTarget(w.cfg.targeting, hero.x, hero.y, range, monsters, hash, rng) ?? target;
          }
          claimed.add(shotTarget.id);
        }
        const aim = i === 0 ? n : norm(shotTarget.x - hero.x, shotTarget.y - hero.y);
        out.push({
          weapon: w,
          fromX: hero.x,
          fromY: hero.y,
          dirX: aim.x,
          dirY: aim.y,
          speed: w.cfg.projectileSpeed * mods.projSpeedMul,
          range,
          dmg: w.damage * mods.damageMul,
          index: i,
          total,
          exactAim: perShotAim,
          target: shotTarget
        });
      }
    }
  }
  function rollCardChoices(cards, stacks, weapons, rng, count = 3, grantPool = []) {
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
    if (weapons.length < MAX_WEAPONS) {
      for (const cfg of grantPool) {
        if (weapons.some((w) => w.cfg.id === cfg.id)) continue;
        pool.push({
          id: `grant:${cfg.id}`,
          name: `\u65B0\u6B66\u5668 \xB7 ${cfg.name}`,
          rarity: "epic",
          type: "weapon",
          effect: { grantWeapon: cfg.id },
          maxStack: 1,
          weight: weapons.length <= 1 ? 1.2 : weapons.length === 2 ? 0.8 : 0.5,
          desc: `${cfg.role ? `\u3010${cfg.role}\u3011` : ""}\u52A0\u5165\u6218\u6597\uFF08Lv1\uFF09\uFF0C\u4E0E\u73B0\u6709\u6B66\u5668\u540C\u65F6\u7D22\u654C\u5F00\u706B`
        });
      }
    }
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
      case "interval":
        m.intervalMul = op === "add" ? m.intervalMul + value : m.intervalMul * (1 + value);
        break;
      case "width":
        m.widthMul = op === "add" ? m.widthMul + value : m.widthMul * (1 + value);
        break;
      case "beamLife":
        m.beamLifeAdd = op === "add" ? m.beamLifeAdd + value : m.beamLifeAdd * (1 + value);
        break;
      case "heatCool":
        m.heatCoolMul = op === "add" ? m.heatCoolMul + value : m.heatCoolMul * (1 + value);
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
            out.push({ at, item: { monsterKey: spawn.monster, spawnX: x, fromCreep: spawn.fromCreep } });
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
      /** 虫苔地块（docs/08）：cellKey = cx*4096+cy（90px 网格）→ 消退时间 */
      this.creep = /* @__PURE__ */ new Map();
      /** 菌毯灼烧层（docs/08 §2.2）：仅记录受损格 → 剩余层数（缺失 = 满层）；
       *  火焰每命中烧 1 层，烧到 0 格毁并被火焰清除；蔓延节拍给受损格回层。 */
      this.creepHp = /* @__PURE__ */ new Map();
      /** 虫苔版本号（任一次增删/烧伤 +1；web 渲染层据此重建离屏缓存） */
      this.creepVersion = 0;
      /** 最近新生虫苔（渲染层蔓延光环用）：坐标 + 发生时刻，短名单自动裁剪 */
      this.creepGlow = [];
      /** 历史峰值覆盖格数（扩张等级按峰值只升不降） */
      this.creepPeak = 0;
      this.creepSpreadAcc = 0;
      this.creepTierCurrent = 1;
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
      this.totalSpawned = 0;
      // 实际出场怪数（含分裂/产卵/护卫，> 配置怪池）
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
      this.weaponPool = opts.weaponPool ?? [];
      this.controller = opts.controller;
      this.cardPolicy = opts.cardPolicy;
      const { width } = opts.level.arena;
      const midY = (opts.level.defenseRect.yMin + opts.level.defenseRect.yMax) / 2;
      this.hero = createHero(width / 2, midY, opts.weaponConfigs);
      this.wallMaxHp = opts.level.wall.hp;
      this.wallHp = opts.level.wall.hp;
      this.director = new WaveDirector(opts.level, this.rng);
    }
    static {
      this.CREEP_CELL = 90;
    }
    static {
      this.CREEP_LIFE = 60;
    }
    static {
      /** 虫苔蔓延：每 interval 秒每个地块尝试向外扩一格（概率 chance；成功则向随机邻格生长并续期自身） */
      this.CREEP_SPREAD_INTERVAL = 3;
    }
    static {
      this.CREEP_SPREAD_CHANCE = 0.12;
    }
    static {
      /** 菌毯灼烧层（docs/08 §2.2）：每格 3 层"血量"，火焰每命中一次烧 1 层，烧穿才格毁；
       *  蔓延节拍会给受损格回 1 层（持续火压制仍能清毯，零星火焰烧不穿）。 */
      this.CREEP_LAYERS = 3;
    }
    static {
      /** 虫巢扩张等级：按历史峰值覆盖格数分档（T1 起始，T2/T3/T4 阈值，docs/08 §2.4） */
      this.CREEP_TIER_CELLS = [60, 120, 190];
    }
    static {
      /** 各等级全族增益：攻击倍率 / 血量倍率 / 站毯每秒回血（docs/08 §2.4） */
      this.CREEP_ATK_MUL = [1, 1.1, 1.2, 1.3];
    }
    static {
      this.CREEP_HP_MUL = [1, 1.08, 1.16, 1.25];
    }
    static {
      this.CREEP_REGEN = [10, 16, 24, 36];
    }
    get timeSec() {
      return this.tick * TICK_DT;
    }
    /** 当前波次序号（0 起；-1 = 准备阶段尚未开波）——供报表/AI 工具读取"玩到第几波"。 */
    get currentWaveIndex() {
      return this.director.waveIndex;
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
      for (const item of spawned) {
        if (item.fromCreep && this.trySpawnFromCreep(item)) continue;
        this.spawnMonster(item.monsterKey, item.spawnX);
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
        if ((cmd.weapon.cfg.chainBase ?? 0) > 0 || cmd.weapon.affixes.chain > 0) {
          this.doLightning(cmd);
        } else if (cmd.weapon.cfg.beamBase) {
          this.doBeam(cmd);
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
          else if (b.cmd.weapon.cfg.beamBase) this.doBeam(b.cmd);
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
        if (p.ghost) continue;
        this.collideProjectile(p);
      }
      this.hash.rebuild(this.monsters);
      for (const m of this.monsters) {
        if (m.hp <= 0) continue;
        if (m.burrowed) {
          updateMonster(m, dt, now, this.level.wall.height, (dmg, src) => {
            const d = Math.round(dmg * this.creepAtkMulFor(src));
            this.wallHp = Math.max(0, this.wallHp - d);
            this.totalWallDamage += d;
            this.waveWallDamage += d;
            this.bus.emit("onWallHit", { dmg: d, wallHp: this.wallHp, x: src.x, y: this.level.wall.height + 26 });
          }, (src) => {
            this.spawnMonsterShot(src);
          }, (x, y) => this.isCreeped(x, y));
          continue;
        }
        this.tickBurns(m, dt);
        if (m.hp <= 0) continue;
        if (m.cfg.morph) {
          m.morphLeft -= dt;
          if (m.morphLeft <= 0) this.morphMonster(m);
        }
        if (m.cfg.creepTrail && m.state === "march") {
          m.creepTimerLeft -= dt;
          if (m.creepTimerLeft <= 0) {
            m.creepTimerLeft += m.cfg.creepTrail.interval;
            this.dropCreep(m.x, m.y);
          }
        }
        if (m.cfg.creepBenefit && this.isCreeped(m.x, m.y)) {
          m.regenAcc += _GameSession.CREEP_REGEN[this.creepTier - 1] * dt;
          while (m.regenAcc >= 1) {
            m.regenAcc -= 1;
            m.hp = Math.min(m.maxHp, m.hp + 1);
          }
        }
        if (this.formationMove(m, dt)) continue;
        updateMonster(m, dt, now, this.level.wall.height, (dmg, src) => {
          const d = Math.round(dmg * this.creepAtkMulFor(src));
          this.wallHp = Math.max(0, this.wallHp - d);
          this.totalWallDamage += d;
          this.waveWallDamage += d;
          this.bus.emit("onWallHit", { dmg: d, wallHp: this.wallHp, x: src.x, y: this.level.wall.height + 26 });
        }, (src) => {
          this.spawnMonsterShot(src);
        }, (x, y) => this.isCreeped(x, y));
      }
      for (const m of this.monsters) {
        if (m.cfg.detonate && m.state === "assault" && m.hp > 0) {
          m.hp = 0;
          this.killMonster(null, m, "poison");
        }
      }
      this.tickCreep(dt);
      for (const m of this.monsters) {
        if (!m.cfg.splitTimer || m.hp <= 0) continue;
        m.splitTimerLeft -= dt;
        if (m.splitTimerLeft > 0) continue;
        m.splitTimerLeft += m.cfg.splitTimer.interval;
        this.spawnBaby(m, m.cfg.splitTimer.baby, 1, m.cfg.splitTimer.inheritHp ?? false);
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
        s.height = Math.sin(s.t * Math.PI) * (s.kind === "rock" ? 140 : 40);
      }
      for (let i = this.pools.length - 1; i >= 0; i--) {
        const pool = this.pools[i];
        const tick = now >= pool.nextTick;
        let dmg = 0;
        if (tick) {
          pool.nextTick = now + 0.5;
          if (pool.damageType === "fire") this.burnCreep(pool.x, pool.y, pool.radius);
          pool.acc += pool.dps * 0.5;
          dmg = Math.floor(pool.acc);
          pool.acc -= dmg;
        }
        this.hash.queryCircle(pool.x, pool.y, pool.radius, this.scratch);
        for (const mid of this.scratch) {
          const m = this.monsters[mid];
          if (!m || m.hp <= 0) continue;
          if (m.burrowed) {
            if (pool.damageType !== "fire") continue;
            this.forceEmerge(m);
          }
          const rr2 = pool.radius + m.cfg.radius;
          const dx = m.x - pool.x;
          const dy = m.y - pool.y;
          if (dx * dx + dy * dy > rr2 * rr2) continue;
          if (!tick || dmg <= 0) continue;
          m.hp -= dmg;
          this.totalDamage += dmg;
          this.bus.emit("onPoolTick", { x: m.x, y: m.y + m.cfg.radius + 8, dmg });
          if (m.hp <= 0) this.killMonster(pool.src, m, pool.damageType);
        }
        if (now >= pool.until) {
          this.pools.splice(i, 1);
          continue;
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
          if (m.burrowed) this.forceEmerge(m);
          const dmg = Math.max(1, Math.round(seg.dps * dt));
          m.hp -= dmg;
          this.totalDamage += dmg;
          if (m.hp <= 0) this.killMonster(null, m, seg.damageType);
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
            this.pendingLevelChoices = rollCardChoices(this.cardConfigs, this.cardStacks, this.hero.weapons, this.rng, 3, this.weaponPool);
            if (this.pendingLevelChoices.length === 0) {
              this.pendingLevels = 0;
              break;
            }
            this.bus.emit("onLevelUpPending", { level: this.hero.level });
          }
          break;
        }
        this.pendingLevels--;
        const choices = rollCardChoices(this.cardConfigs, this.cardStacks, this.hero.weapons, this.rng, 3, this.weaponPool);
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
    spawnMonster(key, spawnX, spawnY, skipEscort = false) {
      const cfg = this.monsterCfgs.get(key);
      if (!cfg) throw new Error(`\u672A\u77E5\u602A\u7269\u914D\u7F6E: ${key}`);
      this.totalSpawned++;
      const x = clamp(spawnX, 40, this.level.arena.width - 40);
      const y = spawnY ?? this.rng.range(this.level.spawnBandY[0], this.level.spawnBandY[1]);
      const scale = 1 + 0.1 * this.director.currentWave;
      const tier = this.creepTier;
      const hp = Math.round(cfg.hp * scale * (cfg.creepBenefit ? _GameSession.CREEP_HP_MUL[tier - 1] : 1));
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
        surfaceLeft: 0,
        morphLeft: cfg.morph ? cfg.morph.delay : 0,
        dead: false,
        creepTimerLeft: cfg.creepTrail ? cfg.creepTrail.interval : 0,
        regenAcc: 0,
        creepTierApplied: tier,
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
    /**
     * 激光炮：生成"持续光束"（SegmentField，docs/07 §4）——非子弹、即时命中、逐帧结算。
     * - 同源旧束在每次齐射首发（index 0）时整体替换：0.4s 重锁不叠加双倍伤害；
     * - 长度缺省 = 场景对角线：任何朝向都贯穿到界外；
     * - 余辉：until = now + duration + 持续供能卡加成（熄火后仍灼烧，覆盖散热前段）；
     * - 扇形分光（count>1）：主束对准目标，附加束左右交替展开（与齐射同一套公式）。
     */
    doBeam(cmd) {
      const { weapon, dirX, dirY, index } = cmd;
      const beam = weapon.cfg.beamBase;
      if (!beam) return;
      if (index === 0) {
        this.segments = this.segments.filter((s) => s.srcWeaponId !== weapon.cfg.id);
      }
      let fan = 0;
      if (index > 0) {
        const side = index % 2 === 1 ? -1 : 1;
        const step = Math.ceil(index / 2);
        fan = side * step * (weapon.cfg.spread ?? 0.1);
      }
      const rawLen = Math.hypot(dirX, dirY);
      const angle = (rawLen > 1e-6 ? Math.atan2(dirY, dirX) : Math.PI / 2) + fan;
      const length = beam.length ?? Math.hypot(this.level.arena.width, this.level.arena.height);
      this.segments.push({
        ax: this.hero.x,
        ay: this.hero.y,
        bx: this.hero.x + Math.cos(angle) * length,
        by: this.hero.y + Math.sin(angle) * length,
        width: beam.width * weapon.mods.widthMul,
        dps: cmd.dmg,
        // 面板伤害即每秒伤害（baseDamage 语义为 DPS）
        until: this.timeSec + beam.duration + weapon.mods.beamLifeAdd,
        damageType: weapon.element,
        followOwner: true,
        angle,
        length,
        srcWeaponId: weapon.cfg.id
      });
    }
    spawnProjectile(cmd) {
      const { weapon, fromX, fromY, dirX, dirY, speed, range, dmg, index } = cmd;
      let fan = 0;
      if (index > 0 && !cmd.exactAim) {
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
        blast,
        ghost: weapon.cfg.ghost ?? false
      });
      this.bus.emit("onShoot", { weaponId: weapon.cfg.id });
    }
    collideProjectile(p) {
      const now = this.timeSec;
      const reach = p.radius + 34 + p.stepLen;
      this.hash.queryCircle(p.x, p.y, reach, this.scratch);
      for (const mid of this.scratch) {
        if (!p.alive) break;
        const m = this.monsters[mid];
        if (!m || m.hp <= 0 || m.burrowed) continue;
        if (p.hitIds.has(m.id) && now - (p.hitIds.get(m.id) ?? 0) < (p.weapon.cfg.rehitSec ?? 0.5)) continue;
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
            const nextTick = m.burn && m.burn.until > now ? m.burn.nextTick : now + 0.5;
            m.burn = { dps, until: now + p.riders.burnSec, nextTick };
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
        if (m.hp <= 0) this.killMonster(p, m, p.damageType);
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
      if (cur && cur.hp <= 0) {
        cur = this.nearestMonsterRuntime(cmd.fromX, cmd.fromY, Math.max(1, cmd.range), /* @__PURE__ */ new Set());
      }
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
        if (cur.hp <= 0) this.killMonster(null, cur, "lightning");
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
    // ---------- 虫苔 / 虫巢扩张（docs/08 §2.2 §2.4 §2.5） ----------
    creepKey(x, y) {
      const c = _GameSession.CREEP_CELL;
      return Math.floor(x / c) * 4096 + Math.floor(y / c);
    }
    isCreeped(x, y) {
      const until = this.creep.get(this.creepKey(x, y));
      return until !== void 0 && until > this.timeSec;
    }
    /**
     * 当前虫巢扩张等级（1-4）：按历史峰值覆盖格数分档，只升不降。
     * 火焰清苔只会拖慢下一档到来的速度，不会让已扩张的等级回退。
     */
    get creepTier() {
      let tier = 1;
      for (const threshold of _GameSession.CREEP_TIER_CELLS) {
        if (this.creepPeak >= threshold) tier++;
      }
      return tier;
    }
    /** 虫族攻击随扩张等级的倍率（非虫族恒为 1）。 */
    creepAtkMulFor(m) {
      return m.cfg.creepBenefit ? _GameSession.CREEP_ATK_MUL[this.creepTier - 1] : 1;
    }
    /** 每帧虫苔结算：蔓延（每 3s 一次）→ 过期清理 → 峰值统计 → 等级晋升（全族一次性补血）。 */
    tickCreep(dt) {
      const now = this.timeSec;
      this.creepSpreadAcc += dt;
      while (this.creepSpreadAcc >= _GameSession.CREEP_SPREAD_INTERVAL) {
        this.creepSpreadAcc -= _GameSession.CREEP_SPREAD_INTERVAL;
        this.spreadCreepOnce();
      }
      for (const [key, until] of this.creep) {
        if (until <= now) {
          this.creep.delete(key);
          this.creepHp.delete(key);
          this.creepVersion++;
        }
      }
      if (this.creep.size > this.creepPeak) this.creepPeak = this.creep.size;
      const tier = this.creepTier;
      if (tier <= this.creepTierCurrent) return;
      for (const m of this.monsters) {
        if (m.hp <= 0 || !m.cfg.creepBenefit || m.creepTierApplied >= tier) continue;
        const ratio = _GameSession.CREEP_HP_MUL[tier - 1] / _GameSession.CREEP_HP_MUL[m.creepTierApplied - 1];
        m.maxHp = Math.round(m.maxHp * ratio);
        m.hp = Math.min(m.maxHp, Math.round(m.hp * ratio));
        m.creepTierApplied = tier;
      }
      this.creepTierCurrent = tier;
      this.bus.emit("onCreepTier", { tier, cells: this.creep.size });
    }
    /** 蔓延结算：每个地块尝试向随机邻格生长（成功则铺新块并续期自身——领土只积不退）。 */
    spreadCreepOnce() {
      if (this.creep.size === 0) return;
      const c = _GameSession.CREEP_CELL;
      const maxCx = Math.floor((this.level.arena.width - 1) / c);
      const maxCy = Math.floor((this.level.arena.height - 1) / c);
      const minCy = Math.ceil(this.level.wall.height / c);
      const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      for (const key of [...this.creep.keys()]) {
        const cx = Math.floor(key / 4096);
        const cy = key % 4096;
        const [dx, dy] = dirs[this.rng.int(0, 3)];
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx >= 0 && nx <= maxCx && ny >= minCy && ny <= maxCy && this.rng.next() < _GameSession.CREEP_SPREAD_CHANCE) {
          this.dropCreep(nx * c + c / 2, ny * c + c / 2);
        }
        this.creep.set(key, this.timeSec + _GameSession.CREEP_LIFE);
        this.regrowCreepLayer(key);
      }
    }
    /** 恢复 1 层灼烧层（上限满层；满层时清掉记录）。 */
    regrowCreepLayer(key) {
      const layers = this.creepHp.get(key);
      if (layers === void 0) return;
      const next = layers + 1;
      if (next >= _GameSession.CREEP_LAYERS) this.creepHp.delete(key);
      else this.creepHp.set(key, next);
      this.creepVersion++;
    }
    dropCreep(x, y) {
      const c = _GameSession.CREEP_CELL;
      const key = this.creepKey(x, y);
      if (this.creep.has(key)) {
        this.creep.set(key, this.timeSec + _GameSession.CREEP_LIFE);
        this.regrowCreepLayer(key);
        return;
      }
      this.creepGlow.push({ x: Math.floor(x / c) * c + c / 2, y: Math.floor(y / c) * c + c / 2, t: this.timeSec });
      if (this.creepGlow.length > 64) this.creepGlow.shift();
      this.creep.set(key, this.timeSec + _GameSession.CREEP_LIFE);
      this.creepVersion++;
    }
    /**
     * 从菌毯中孵化（docs/08 §2.5）：放行时刻从当前虫苔里随机挑一格钻出（避开城墙贴脸，留一点反应窗口）；
     * 可用虫苔不足 3 格时返回 false，落回顶部出生带（前期没地盘时与普通波次表现一致）。
     */
    trySpawnFromCreep(item) {
      const c = _GameSession.CREEP_CELL;
      const minY = this.level.wall.height + 300;
      const maxY = this.level.arena.height - 100;
      const candidates = [];
      for (const key2 of this.creep.keys()) {
        const y2 = key2 % 4096 * c + c / 2;
        if (y2 >= minY && y2 <= maxY) candidates.push(key2);
      }
      if (candidates.length < 3) return false;
      const key = candidates[this.rng.int(0, candidates.length - 1)];
      const x = clamp(Math.floor(key / 4096) * c + c / 2 + this.rng.range(-25, 25), 40, this.level.arena.width - 40);
      const y = key % 4096 * c + c / 2 + this.rng.range(-20, 20);
      this.spawnMonster(item.monsterKey, x, y);
      this.bus.emit("onMonsterEmerge", { x, y });
      return true;
    }
    /** 火焰灼烧虫苔（docs/08 §2.2）：半径内每格烧掉 1 层灼烧层；烧穿（0 层）才清除该格，
     *  焦痕随蔓延节拍/虫后铺毯回层——零星火焰烧不穿整片毯，持续火压制才能清出走廊。 */
    burnCreep(x, y, r) {
      const c = _GameSession.CREEP_CELL;
      const minCx = Math.floor((x - r) / c);
      const maxCx = Math.floor((x + r) / c);
      const minCy = Math.floor((y - r) / c);
      const maxCy = Math.floor((y + r) / c);
      for (let cx = minCx; cx <= maxCx; cx++) {
        for (let cy = minCy; cy <= maxCy; cy++) {
          const key = cx * 4096 + cy;
          if (!this.creep.has(key)) continue;
          const layers = (this.creepHp.get(key) ?? _GameSession.CREEP_LAYERS) - 1;
          if (layers <= 0) {
            this.creep.delete(key);
            this.creepHp.delete(key);
          } else {
            this.creepHp.set(key, layers);
          }
          this.creepVersion++;
        }
      }
    }
    /** 测试入口：火焰灼烧虫苔（与火焰命中同一条 burnCreep 路径）。 */
    debugBurnCreep(x, y, r) {
      this.burnCreep(x, y, r);
    }
    /** 强制出土：钻地怪被爆炸/火焰波及立即出土（同样给足上浮窗口，否则一帧后又会缩回地下）。 */
    forceEmerge(m) {
      if (m.burrowed) {
        m.burrowed = false;
        m.burrowTimer = 0;
        m.surfaceLeft = Math.max(m.surfaceLeft, m.cfg.burrowSiege?.surfaceFor ?? 0);
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
        if (m.hp <= 0) this.killMonster(p, m, p.damageType);
      }
      if (p.damageType === "fire") this.burnCreep(p.x, p.y, radius);
      this.pools.push({
        x: p.x,
        y: p.y,
        radius,
        dps: p.dmg * poolDpsMul,
        until: now + poolSec,
        damageType: p.damageType,
        nextTick: now + 0.5,
        acc: 0,
        src: p
        // 弹坑击杀同样可触发"弹片"分裂
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
        const dmg = Math.round(m.cfg.atk * this.creepAtkMulFor(m));
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
        if (m.hp <= 0) this.killMonster(null, m, "fire");
      }
    }
    /** 外部（人类玩家）完成三选一决策；未挂起时调用为无操作。 */
    resolveLevelUp(card) {
      if (this.pendingLevelChoices.length === 0) return;
      this.pendingLevelChoices = [];
      this.pendingLevels = Math.max(0, this.pendingLevels - 1);
      this.applyPickedCard(card);
    }
    /**
     * 获得新武器（升级卡"新武器"候选的落地入口，docs/02 §1：1 把初始 + 升级卡获得）。
     * 规则：同武器不可重复、武器位上限 MAX_WEAPONS；获得后以 Lv1 立即与现有武器同时开火。
     */
    grantWeapon(cfg) {
      if (this.hero.weapons.length >= MAX_WEAPONS) return false;
      if (this.hero.weapons.some((w) => w.cfg.id === cfg.id)) return false;
      this.hero.weapons.push(createWeaponInstance(cfg));
      return true;
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
      if ("grantWeapon" in e) {
        return this.hero.weapons.length < MAX_WEAPONS && !this.hero.weapons.some((w) => w.cfg.id === e.grantWeapon) && this.weaponPool.some((c) => c.id === e.grantWeapon);
      }
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
      } else if ("grantWeapon" in e) {
        const cfg = this.weaponPool.find((c) => c.id === e.grantWeapon);
        if (cfg) this.grantWeapon(cfg);
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
    /** 分裂幼体：inheritHp = 血条与母体一致（分裂菇）；速度取幼体配置（更快），不可再分裂。 */
    spawnBaby(parent, babyKey, count, inheritHp = true) {
      for (let i = 0; i < count; i++) {
        const ang = this.rng.range(0, Math.PI * 2);
        const bx = clamp(parent.x + Math.cos(ang) * (parent.cfg.radius + 20), 40, this.level.arena.width - 40);
        const by = clamp(parent.y + Math.sin(ang) * (parent.cfg.radius + 20), 120, this.level.arena.height - 60);
        const before = this.monsters.length;
        this.spawnMonster(babyKey, bx, by);
        const baby = this.monsters[this.monsters.length - 1];
        if (this.monsters.length > before && inheritHp) {
          baby.hp = baby.maxHp = parent.maxHp;
        }
      }
    }
    /**
     * 变态（docs/08 §2.6 虫后幼虫）：按权重随机变为池中虫形态（虫后除外），
     * 新形态血量按波次成长 + 虫巢扩张倍率重算（与 spawnMonster 同式），并播出土烟尘。
     */
    morphMonster(m) {
      const morph = m.cfg.morph;
      m.morphLeft = 0;
      if (!morph || morph.pool.length === 0) return;
      let total = 0;
      for (const e of morph.pool) total += e.weight;
      let roll = this.rng.range(0, total);
      let pick = morph.pool[morph.pool.length - 1].id;
      for (const e of morph.pool) {
        roll -= e.weight;
        if (roll <= 0) {
          pick = e.id;
          break;
        }
      }
      const cfg = this.monsterCfgs.get(pick);
      if (!cfg) return;
      const scale = 1 + 0.1 * this.director.currentWave;
      const tier = this.creepTier;
      const hp = Math.round(cfg.hp * scale * (cfg.creepBenefit ? _GameSession.CREEP_HP_MUL[tier - 1] : 1));
      m.cfg = cfg;
      m.hp = hp;
      m.maxHp = hp;
      m.state = "march";
      m.attackTimer = cfg.attackInterval;
      m.burrowed = false;
      m.burrowTimer = 0;
      m.surfaceLeft = 0;
      m.splitTimerLeft = cfg.splitTimer ? cfg.splitTimer.interval : 0;
      m.healTimer = cfg.healAura ? cfg.healAura.interval : 0;
      m.creepTimerLeft = cfg.creepTrail ? cfg.creepTrail.interval : 0;
      m.regenAcc = 0;
      this.bus.emit("onMonsterEmerge", { x: m.x, y: m.y });
    }
    /**
     * 击杀结算（单点收口：同 tick 多伤害源只计一次）。
     * dmgType = 致命一击的伤害类型，仅供渲染层做「死法配色」，不参与任何数值。
     * onKill 携带位置/半径/形态：渲染层据此播放该怪物专属的死亡表现（docs/06 铁律 5）。
     */
    killMonster(p, m, dmgType) {
      if (m.dead) return;
      m.dead = true;
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
        damageType: dmgType ?? null
      });
      if (m.cfg.deathSplit) {
        this.spawnBaby(m, m.cfg.deathSplit.baby, m.cfg.deathSplit.count, true);
      }
      if (m.cfg.detonate) {
        this.bus.emit("onExplode", { x: m.x, y: m.y, radius: 70 });
        if (m.state === "assault") {
          const dmg = Math.round(m.cfg.detonate.wallDamage * this.creepAtkMulFor(m));
          this.wallHp = Math.max(0, this.wallHp - dmg);
          this.totalWallDamage += dmg;
          this.waveWallDamage += dmg;
          this.bus.emit("onWallHit", { dmg, wallHp: this.wallHp, x: m.x, y: this.level.wall.height + 26 });
        }
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
            blast: null,
            ghost: false
            // 弹片是可碰撞实体弹（即使母体是幽灵弹）
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
  var greedyDpsPolicy = (choices, hero, _rng, session) => {
    const wallDanger = session ? 1 - session.wallHp / session.wallMaxHp : 0;
    const prio = (c) => {
      const e = c.effect;
      if (c.type === "weapon") {
        const held = hero.weapons.length;
        return held <= 1 ? 100 : held === 2 ? 72 : 46;
      }
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

  // tools/sim/human.ts
  var HumanInputController = class {
    constructor(tx = 540, ty = 300) {
      this.hasTarget = false;
      this.keys = /* @__PURE__ */ new Set();
      this.tx = tx;
      this.ty = ty;
    }
    getMoveDir(s) {
      let dx = 0;
      let dy = 0;
      const k = this.keys;
      if (k.has("a") || k.has("arrowleft")) dx -= 1;
      if (k.has("d") || k.has("arrowright")) dx += 1;
      if (k.has("w") || k.has("arrowup")) dy += 1;
      if (k.has("s") || k.has("arrowdown")) dy -= 1;
      if (dx !== 0 || dy !== 0) return { x: dx, y: dy };
      if (this.hasTarget) {
        const ddx = this.tx - s.hero.x;
        const ddy = this.ty - s.hero.y;
        const d = Math.hypot(ddx, ddy);
        if (d < 14) {
          this.hasTarget = false;
          return { x: 0, y: 0 };
        }
        return { x: ddx / d, y: ddy / d };
      }
      return { x: 0, y: 0 };
    }
    snapshot() {
      return { tx: this.tx, ty: this.ty, hasTarget: this.hasTarget, keys: [...this.keys].sort() };
    }
    restore(st) {
      this.tx = st.tx;
      this.ty = st.ty;
      this.hasTarget = st.hasTarget;
      this.keys = new Set(st.keys);
    }
  };
  function sameInputState(a, b) {
    return a.tx === b.tx && a.ty === b.ty && a.hasTarget === b.hasTarget && a.keys.length === b.keys.length && a.keys.every((k, i) => k === b.keys[i]);
  }
  var TraceRecorder = class {
    constructor(sink = () => {
    }) {
      this.sink = sink;
      this.records = [];
      this.last = null;
    }
    start(meta) {
      this.push({ type: "run", ...meta });
    }
    /** 每步进前调用：输入状态变化才记录（静止/匀速拖动期间零开销）。 */
    observe(st, tick) {
      if (!this.last || !sameInputState(this.last, st)) {
        this.push({ type: "in", t: tick, st });
        this.last = st;
      }
    }
    pick(tick, id, offers) {
      this.push({ type: "pick", t: tick, id, offers });
    }
    check(tick, s) {
      this.push({ type: "check", t: tick, x: s.x, y: s.y, wallHp: s.wallHp, kills: s.kills, lv: s.lv });
    }
    end(tick, s) {
      this.push({ type: "end", t: tick, ...s });
    }
    push(r) {
      this.records.push(r);
      this.sink(r);
    }
  };

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
  function monsterLook(m) {
    return lookOf(m.cfg.id, m.cfg.shape);
  }
  var SIZE_SCALE = {
    small: 0.78,
    normal: 1,
    large: 1.35,
    boss: 1.9
  };
  var WEAPON_LOOKS = {
    gun_rifle: {
      bullet: "rune",
      muzzle: "star",
      impact: "spark",
      accent: "#F5F5FA",
      note: "\u7B26\u6587\u6B65\u67AA\uFF1A\u83F1\u5F62\u7B26\u6587\u5F39 + \u77ED\u66F3\u5149\uFF0C\u8FDE\u5C04\u5982\u5F39\u5E55\u96E8"
    },
    crossbow_pierce: {
      bullet: "bolt",
      muzzle: "cone",
      impact: "crack",
      accent: "#C7CEE6",
      note: "\u7A7F\u900F\u5F29\uFF1A\u957F\u6746\u91CD\u5F29\u7BAD + \u5C3E\u7FBD\uFF0C\u4E00\u6761\u8D2F\u7A7F\u6B8B\u5F71"
    },
    alchemist_bomb: {
      bullet: "flask",
      muzzle: "puff",
      impact: "burst",
      accent: "#FFB357",
      note: "\u70BC\u91D1\u70B8\u5F39\uFF1A\u7403\u5F62\u836F\u74F6 + \u5F15\u7EBF\u706B\u82B1\uFF0C\u629B\u7269\u5F27\u7EBF\u843D\u5730\u7559\u5751"
    },
    boomerang: {
      bullet: "disc",
      muzzle: "ring",
      impact: "slash",
      accent: "#FFD54F",
      note: "\u56DE\u65CB\u9556\uFF1A\u952F\u9F7F\u5706\u76D8\u9AD8\u901F\u81EA\u8F6C\uFF0C\u53BB/\u56DE\u5404\u4E00\u9053\u65A9\u75D5"
    },
    lightning_chain: {
      bullet: "chain",
      muzzle: "crackle",
      impact: "arc",
      accent: "#B388FF",
      note: "\u96F7\u7535\u6743\u6756\uFF1A\u65E0\u5F39\u4F53\uFF0C\u70AE\u53E3\u76F4\u8FBE + \u602A\u95F4\u8DF3\u8DC3\u7684\u6298\u7EBF\u95EA\u7535"
    },
    laser_cannon: {
      bullet: "beam",
      muzzle: "lens",
      impact: "scorch",
      accent: "#BFFFF2",
      note: "\u805A\u80FD\u6FC0\u5149\u70AE\uFF1A\u4E09\u5C42\u5149\u5E26\u6301\u7EED\u5149\u675F\uFF0C\u7AEF\u70B9\u707C\u70E7\u3001\u8FC7\u70ED\u5192\u70DF"
    }
  };
  var SHAPE_TO_BULLET = {
    dot: "rune",
    arrow: "bolt",
    bomb: "flask",
    gear: "disc",
    crescent: "disc",
    beam: "beam"
  };
  var FALLBACK_WEAPON = {
    bullet: "rune",
    muzzle: "star",
    impact: "spark",
    accent: "#F5F5FA",
    note: "\u672A\u767B\u8BB0\u6B66\u5668"
  };
  function weaponLook(w) {
    const own = WEAPON_LOOKS[w.cfg.id];
    if (own) return own;
    return { ...FALLBACK_WEAPON, bullet: SHAPE_TO_BULLET[w.cfg.shape ?? "dot"] ?? "rune" };
  }
  var DAMAGE_FX = {
    physical: { color: "#F5F5FA", chunk: "spark", stain: "#C7CEE6" },
    fire: { color: "#FF5A3C", chunk: "ember", stain: "#7A2A18" },
    frost: { color: "#4FC3F7", chunk: "shard", stain: "#2B6A88" },
    lightning: { color: "#B388FF", chunk: "spark", stain: "#4A3A7A" },
    poison: { color: "#7CB342", chunk: "bubble", stain: "#3E5B21" }
  };

  // src/adapter/web/render/shapes.ts
  var TAU = Math.PI * 2;
  var MONSTER_COLOR = {
    slime: "#FF6B57",
    wolf: "#FF8357",
    charger: "#FFA25E",
    thrower: "#FF5E7A",
    catapult: "#A9714B",
    bulwark: "#8A93B8",
    bulwark_king: "#6F7BA6",
    boss_treant: "#B537F2",
    split_shroom: "#FF6B9C",
    shroom_baby: "#FF8FB6",
    bat: "#FF7EC7",
    shaman: "#B388FF",
    zerg_ling: "#9CCC65",
    zerg_larva: "#B4D97A",
    zerg_roach: "#7CB342",
    zerg_lurker: "#558B2F",
    zerg_queen: "#C77DFF",
    baneling: "#AEEA00",
    zerg_ultra: "#69A83B"
  };
  var SHAPE_COLOR = {
    slime: "#FF6B57",
    wolf: "#FF8357",
    charger: "#FFA25E",
    thrower: "#FF5E7A",
    bulwark: "#8A93B8",
    bat: "#FF7EC7",
    shroom: "#FF6B9C",
    boss: "#B537F2",
    shaman: "#B388FF",
    larva: "#9CCC65",
    roach: "#7CB342",
    lurker: "#558B2F",
    zqueen: "#C77DFF",
    baneling: "#AEEA00",
    ultra: "#69A83B"
  };
  function monsterColor(m) {
    return MONSTER_COLOR[m.cfg.id] ?? SHAPE_COLOR[m.cfg.shape ?? "slime"] ?? "#FF6B57";
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
  function poly(ctx, cx, cy, n, rad, rot = -Math.PI / 2, inner = 1) {
    ctx.beginPath();
    for (let i = 0; i < n * 2; i++) {
      const a = rot + Math.PI / n * i;
      const r = i % 2 === 0 ? rad : rad * inner;
      const px = cx + Math.cos(a) * r;
      const py = cy + Math.sin(a) * r;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
  }
  function contactShadow(ctx, x, y, r, alpha = 0.22) {
    ctx.fillStyle = `rgba(0,0,0,${alpha})`;
    ctx.beginPath();
    ctx.ellipse(x, y - r * 0.3, r * 1.02, r * 0.4, 0, 0, TAU);
    ctx.fill();
  }
  function drawMonster(ctx, m, t, flash = 0, squash = 1) {
    const r = m.cfg.radius;
    const look = monsterLook(m);
    const bodyColor = monsterColor(m);
    const x = m.x;
    const y = m.y;
    if (m.burrowed) {
      ctx.fillStyle = "rgba(70,82,52,0.45)";
      ctx.beginPath();
      ctx.ellipse(x, y, r * 1.1, r * 0.55, 0, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = "rgba(26,36,16,0.55)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let i = 0; i < 3; i++) {
        const a = Math.PI / 3 * i + m.phase;
        ctx.moveTo(x + Math.cos(a) * r * 0.2, y + Math.sin(a) * r * 0.1);
        ctx.lineTo(x + Math.cos(a) * r * 0.85, y + Math.sin(a) * r * 0.45);
      }
      ctx.stroke();
      ctx.strokeStyle = bodyColor;
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(x, y, r + 3, (r + 3) * 0.5, 0, 0, TAU);
      ctx.stroke();
      ctx.setLineDash([]);
      return;
    }
    const deform = Math.abs(squash - 1) > 1e-3;
    if (deform) {
      ctx.save();
      ctx.translate(x, y - r);
      ctx.scale(1 / squash, squash);
      ctx.translate(-x, -(y - r));
    }
    if (flash <= 1e-3) contactShadow(ctx, x, y, r, look.size === "boss" ? 0.3 : 0.22);
    drawMonsterBody(ctx, m, t, look, bodyColor, false);
    if (flash > 0) {
      ctx.fillStyle = `rgba(255,255,255,${0.9 * flash})`;
      drawMonsterBody(ctx, m, t, look, "#FFFFFF", true);
    }
    if (deform) ctx.restore();
  }
  function drawMonsterBody(ctx, m, t, look, color, tint) {
    const fn = BODIES[look.silhouette] ?? drawSlimeBody;
    fn(ctx, m, t, color, !tint, look);
  }
  var BODIES = {
    slime: drawSlimeBody,
    wolf: drawWolfBody,
    goblin: drawGoblinBody,
    catapult: drawCatapultBody,
    charger: drawChargerBody,
    armor: drawArmorBody,
    king: drawKingBody,
    treant: drawTreantBody,
    mushroom: drawMushroomBody,
    bat: drawBatBody,
    shaman: drawShamanBody,
    zergling: drawZerglingBody,
    grub: drawGrubBody,
    roach: drawRoachBody,
    lurker: drawLurkerBody,
    queen: drawQueenBody,
    baneling: drawBanelingBody,
    ultra: drawUltraBody
  };
  function drawSlimeBody(ctx, m, t, color, deco, look) {
    const x = m.x, y = m.y, r = m.cfg.radius;
    const sq = m.state === "march" ? 1 + 0.12 * Math.sin(t * 6 + m.phase) : 1;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(2 - sq, sq);
    ctx.fillStyle = color;
    rr(ctx, -r, -r, r * 2, r * 2, r * 0.45);
    ctx.fill();
    if (deco) {
      ctx.fillStyle = "rgba(255,255,255,0.22)";
      ctx.beginPath();
      ctx.ellipse(-r * 0.3, r * 0.34, r * 0.4, r * 0.24, -0.5, 0, TAU);
      ctx.fill();
      ctx.fillStyle = look.core;
      for (const sx of [-0.34, 0.34]) {
        ctx.beginPath();
        ctx.arc(sx * r, -r * 0.2, r * 0.12, 0, TAU);
        ctx.fill();
      }
    }
    ctx.restore();
  }
  function drawWolfBody(ctx, m, t, color, deco, look) {
    const x = m.x, y = m.y, r = m.cfg.radius;
    const moving = m.state === "march";
    const stretch = moving ? 1 + 0.15 * Math.sin(t * 8 + m.phase) : 1;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(1, stretch);
    if (deco) {
      ctx.strokeStyle = look.accent;
      ctx.lineWidth = 3;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(0, r * 0.72);
      ctx.quadraticCurveTo(Math.sin(t * 7 + m.phase) * r * 0.55, r * 1.25, Math.sin(t * 7 + m.phase + 1) * r * 0.7, r * 1.66);
      ctx.stroke();
    }
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, -r * 1.05);
    ctx.lineTo(-r * 0.85, r * 0.8);
    ctx.lineTo(r * 0.85, r * 0.8);
    ctx.closePath();
    ctx.fill();
    if (deco) {
      ctx.fillStyle = look.accent;
      ctx.globalAlpha = 0.32;
      ctx.beginPath();
      ctx.moveTo(0, -r * 0.5);
      ctx.lineTo(-r * 0.36, r * 0.4);
      ctx.lineTo(r * 0.36, r * 0.4);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = look.core;
      for (const sx of [-0.26, 0.26]) {
        ctx.beginPath();
        ctx.arc(sx * r, -r * 0.32, r * 0.1, 0, TAU);
        ctx.fill();
      }
    }
    ctx.restore();
  }
  function drawGoblinBody(ctx, m, t, color, deco, look) {
    const x = m.x, y = m.y, r = m.cfg.radius;
    const interval = Math.max(1e-3, m.cfg.attackInterval);
    const wind = m.cfg.behavior === "ranged" ? Math.sin(Math.min(1, Math.max(0, 1 - m.attackTimer / interval)) * Math.PI) : 0;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(-0.18 * wind);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(-r * 0.78, r * 0.68);
    ctx.lineTo(r * 0.78, r * 0.68);
    ctx.lineTo(r * 0.46, -r * 0.72);
    ctx.lineTo(-r * 0.46, -r * 0.72);
    ctx.closePath();
    ctx.fill();
    if (deco) {
      ctx.fillStyle = color;
      for (const sx of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(sx * r * 0.5, -r * 0.5);
        ctx.lineTo(sx * r * 0.95, -r * 0.86);
        ctx.lineTo(sx * r * 0.62, -r * 0.24);
        ctx.closePath();
        ctx.fill();
      }
      ctx.save();
      ctx.rotate(-0.35 + 0.7 * wind);
      ctx.strokeStyle = look.accent;
      ctx.lineWidth = 3;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(r * 0.12, r * 0.9);
      ctx.lineTo(r * 0.12, -r * 1.85);
      ctx.stroke();
      ctx.fillStyle = "#F5F5FA";
      ctx.beginPath();
      ctx.moveTo(r * 0.12, -r * 2.15);
      ctx.lineTo(r * 0.12 - r * 0.16, -r * 1.78);
      ctx.lineTo(r * 0.12 + r * 0.16, -r * 1.78);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      ctx.fillStyle = look.core;
      for (const sx of [-0.22, 0.22]) {
        ctx.beginPath();
        ctx.arc(sx * r, -r * 0.34, r * 0.1, 0, TAU);
        ctx.fill();
      }
    }
    ctx.restore();
  }
  function drawCatapultBody(ctx, m, t, color, deco, look) {
    const x = m.x, y = m.y, r = m.cfg.radius;
    const interval = Math.max(1e-3, m.cfg.attackInterval);
    const wind = Math.min(1, Math.max(0, 1 - m.attackTimer / interval));
    const wheelRot = t * (m.state === "march" ? 2.4 : 0.4);
    if (!deco) {
      ctx.fillStyle = color;
      rr(ctx, x - r * 0.95, y - r * 0.36, r * 1.9, r * 0.34, r * 0.1);
      ctx.fill();
      for (const sx of [-1, 1]) {
        ctx.beginPath();
        ctx.arc(x + sx * r * 0.78, y - r * 0.5, r * 0.32, 0, TAU);
        ctx.fill();
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = r * 0.17;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(x - r * 0.52, y - r * 0.08);
      ctx.lineTo(x, y + r * 0.66);
      ctx.moveTo(x + r * 0.52, y - r * 0.08);
      ctx.lineTo(x, y + r * 0.66);
      ctx.stroke();
      return;
    }
    for (const sx of [-1, 1]) {
      const wx = x + sx * r * 0.78;
      const wy = y - r * 0.5;
      ctx.fillStyle = "#4E3A24";
      ctx.beginPath();
      ctx.arc(wx, wy, r * 0.32, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = look.accent;
      ctx.lineWidth = 2.6;
      ctx.beginPath();
      for (let i = 0; i < 3; i++) {
        const a = wheelRot + i * Math.PI / 3;
        ctx.moveTo(wx - Math.cos(a) * r * 0.27, wy - Math.sin(a) * r * 0.27);
        ctx.lineTo(wx + Math.cos(a) * r * 0.27, wy + Math.sin(a) * r * 0.27);
      }
      ctx.stroke();
      ctx.strokeStyle = "rgba(11,12,29,0.55)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(wx, wy, r * 0.32, 0, TAU);
      ctx.stroke();
    }
    ctx.fillStyle = color;
    rr(ctx, x - r * 0.95, y - r * 0.34, r * 1.9, r * 0.32, r * 0.1);
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = r * 0.17;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(x - r * 0.52, y - r * 0.08);
    ctx.lineTo(x, y + r * 0.66);
    ctx.moveTo(x + r * 0.52, y - r * 0.08);
    ctx.lineTo(x, y + r * 0.66);
    ctx.stroke();
    const armAng = -0.95 + wind * 1.8;
    ctx.save();
    ctx.translate(x, y + r * 0.5);
    ctx.rotate(armAng);
    ctx.strokeStyle = look.accent;
    ctx.lineWidth = r * 0.13;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, r * 1.3);
    ctx.stroke();
    ctx.fillStyle = "#4E3A24";
    rr(ctx, -r * 0.17, -r * 0.28, r * 0.34, r * 0.32, r * 0.07);
    ctx.fill();
    if (deco && wind < 0.6) {
      ctx.fillStyle = "#8A93B8";
      ctx.beginPath();
      ctx.arc(0, r * 1.3, r * 0.21, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = "rgba(11,12,29,0.6)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.restore();
    if (deco) {
      ctx.strokeStyle = "#4E3A24";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x - r * 0.82, y + r * 0.3);
      ctx.lineTo(x + r * 0.82, y + r * 0.12);
      ctx.stroke();
    }
  }
  function drawChargerBody(ctx, m, t, color, deco, look) {
    const x = m.x, y = m.y, r = m.cfg.radius;
    if (m.state === "march" && deco) {
      const trail = 3;
      for (let i = trail; i >= 1; i--) {
        const back = i * 9;
        const k = 1 - i / (trail + 0.6);
        const shrink = 1 - i * 0.1;
        ctx.fillStyle = `rgba(255,190,130,${0.5 * k})`;
        ctx.beginPath();
        ctx.moveTo(x, y - r * 1.4 * shrink + back);
        ctx.lineTo(x - r * 0.55 * shrink, y + r * shrink + back);
        ctx.lineTo(x + r * 0.55 * shrink, y + r * shrink + back);
        ctx.closePath();
        ctx.fill();
      }
    }
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, -r * 1.45);
    ctx.lineTo(-r * 0.55, r);
    ctx.lineTo(r * 0.55, r);
    ctx.closePath();
    ctx.fill();
    if (deco) {
      ctx.fillStyle = look.accent;
      ctx.beginPath();
      ctx.moveTo(0, -r * 1.45);
      ctx.lineTo(-r * 0.16, -r * 0.55);
      ctx.lineTo(r * 0.16, -r * 0.55);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = look.core;
      ctx.fillRect(-r * 0.22, -r * 0.72, r * 0.44, r * 0.12);
    }
    ctx.restore();
  }
  function drawArmorBody(ctx, m, t, color, deco, look) {
    const x = m.x, y = m.y, r = m.cfg.radius;
    ctx.fillStyle = color;
    poly(ctx, x, y, 6, r, Math.PI / 6);
    ctx.fill();
    if (deco) {
      ctx.strokeStyle = "rgba(11,12,29,0.55)";
      ctx.lineWidth = 3;
      poly(ctx, x, y, 6, r * 0.55, Math.PI / 6);
      ctx.stroke();
      ctx.fillStyle = look.accent;
      for (let i = 0; i < 6; i++) {
        const a = Math.PI / 3 * i + Math.PI / 6;
        ctx.beginPath();
        ctx.arc(x + Math.cos(a) * r * 0.74, y + Math.sin(a) * r * 0.74, 2.4, 0, TAU);
        ctx.fill();
      }
      ctx.strokeStyle = look.accent;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(x, y, r * 1.02, -Math.PI * 0.86, -Math.PI * 0.14);
      ctx.stroke();
      if (m.shieldLeft > 0) {
        ctx.strokeStyle = `rgba(245,245,250,${0.25 + 0.25 * Math.sin(t * 6 + m.phase)})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, r * 1.16, -Math.PI * 0.95, -Math.PI * 0.05);
        ctx.stroke();
      }
    }
  }
  function drawKingBody(ctx, m, t, color, deco, look) {
    const x = m.x, y = m.y, r = m.cfg.radius;
    ctx.fillStyle = color;
    poly(ctx, x, y, 6, r, Math.PI / 6);
    ctx.fill();
    if (deco) {
      const pulse = 0.5 + 0.5 * Math.sin(t * 3.2 + m.phase);
      ctx.strokeStyle = `rgba(255,213,79,${0.18 + 0.28 * pulse})`;
      ctx.lineWidth = 3;
      poly(ctx, x, y, 6, r * 1.12, Math.PI / 6);
      ctx.stroke();
      ctx.strokeStyle = "rgba(11,12,29,0.5)";
      poly(ctx, x, y, 6, r * 0.55, Math.PI / 6);
      ctx.stroke();
      ctx.fillStyle = "#FFD54F";
      for (const sx of [-0.46, 0, 0.46]) {
        ctx.beginPath();
        ctx.moveTo(x + sx * r, y + r * 0.62);
        ctx.lineTo(x + sx * r - r * 0.12, y + r * 0.95);
        ctx.lineTo(x + sx * r + r * 0.12, y + r * 0.95);
        ctx.closePath();
        ctx.fill();
      }
      ctx.fillStyle = look.accent;
      ctx.fillRect(x - r * 0.62, y + r * 0.56, r * 1.24, r * 0.1);
      for (let i = 0; i < 6; i++) {
        const a = Math.PI / 3 * i + Math.PI / 6;
        ctx.beginPath();
        ctx.arc(x + Math.cos(a) * r * 0.72, y + Math.sin(a) * r * 0.72, 2.6, 0, TAU);
        ctx.fill();
      }
    }
  }
  function drawTreantBody(ctx, m, t, color, deco, look) {
    const x = m.x, y = m.y, r = m.cfg.radius;
    const pulse = 1 + 0.04 * Math.sin(t * 2.4 + m.phase);
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(pulse, pulse);
    if (deco) {
      ctx.save();
      ctx.rotate(t * 0.45);
      ctx.strokeStyle = look.accent;
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = 3;
      for (let i = 0; i < 6; i++) {
        ctx.beginPath();
        ctx.arc(0, 0, r * 1.34, Math.PI / 3 * i, Math.PI / 3 * i + 0.52);
        ctx.stroke();
      }
      ctx.restore();
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = color;
    poly(ctx, 0, 0, 12, r * 1.12, 0, 0.93);
    ctx.fill();
    if (deco) {
      ctx.strokeStyle = "rgba(11,12,29,0.45)";
      ctx.lineWidth = 2;
      poly(ctx, 0, 0, 12, r * 0.94, 0, 0.93);
      ctx.stroke();
      ctx.fillStyle = "rgba(107,74,47,0.9)";
      for (let i = 0; i < 3; i++) {
        const k = 1 - i * 0.26;
        ctx.beginPath();
        ctx.moveTo(0, -r * 0.72 * k);
        ctx.lineTo(r * 0.5 * k, r * 0.5 * k);
        ctx.lineTo(-r * 0.5 * k, r * 0.5 * k);
        ctx.closePath();
        ctx.fill();
      }
      const g = ctx.createRadialGradient(0, 0, 1, 0, 0, r * 0.55);
      g.addColorStop(0, "rgba(217,166,255,0.95)");
      g.addColorStop(0.55, "rgba(181,55,242,0.8)");
      g.addColorStop(1, "rgba(181,55,242,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.55, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }
  function drawMushroomBody(ctx, m, t, color, deco, look) {
    const baby = m.cfg.id === "shroom_baby";
    const x = m.x, y = m.y, r = m.cfg.radius;
    const bob = Math.sin(t * 3 + m.phase) * (m.state === "march" ? 1.6 : 0.6);
    ctx.save();
    ctx.translate(x, y + bob);
    ctx.fillStyle = deco ? look.accent : color;
    rr(ctx, -r * 0.24, -r * 0.2, r * 0.48, r * 0.98, r * 0.14);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(0, -r * 0.22, baby ? r * 0.82 : r, 0, TAU);
    ctx.fill();
    if (deco) {
      ctx.strokeStyle = "rgba(58,16,36,0.45)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, -r * 0.22, baby ? r * 0.82 : r, Math.PI * 0.15, Math.PI * 0.85);
      ctx.stroke();
      if (!baby) {
        ctx.fillStyle = look.accent;
        for (const [sx, sy, sr] of [[-0.42, 0.1, 0.16], [0.36, 0.28, 0.13], [0.05, -0.42, 0.11]]) {
          ctx.beginPath();
          ctx.arc(sx * r, sy * r - r * 0.22, sr * r, 0, TAU);
          ctx.fill();
        }
      } else {
        ctx.fillStyle = look.core;
        ctx.beginPath();
        ctx.arc(0, -r * 0.16, r * 0.1, 0, TAU);
        ctx.fill();
      }
    }
    ctx.restore();
  }
  function drawBatBody(ctx, m, t, color, deco, look) {
    const x = m.x, y = m.y, r = m.cfg.radius;
    const flap = 0.75 + 0.3 * Math.sin(t * 12 + m.phase);
    if (deco) {
      const echo = (t * 0.8 + m.phase) % 1;
      ctx.strokeStyle = `rgba(255,179,225,${0.22 * (1 - echo)})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, r * (0.9 + echo * 1.4), 0, TAU);
      ctx.stroke();
    }
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(1, flap);
    ctx.fillStyle = color;
    for (const sx of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(sx * r * 0.24, 0);
      ctx.lineTo(sx * r * 1.34, r * 0.58);
      ctx.lineTo(sx * r * 0.92, -r * 0.5);
      ctx.closePath();
      ctx.fill();
    }
    ctx.beginPath();
    ctx.ellipse(0, -r * 0.1, r * 0.34, r * 0.62, 0, 0, TAU);
    ctx.fill();
    if (deco) {
      ctx.fillStyle = color;
      for (const sx of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(sx * r * 0.14, -r * 0.55);
        ctx.lineTo(sx * r * 0.34, -r * 0.92);
        ctx.lineTo(sx * r * 0.06, -r * 0.7);
        ctx.closePath();
        ctx.fill();
      }
      ctx.fillStyle = look.core;
      for (const sx of [-0.13, 0.13]) {
        ctx.beginPath();
        ctx.arc(sx * r, -r * 0.36, r * 0.08, 0, TAU);
        ctx.fill();
      }
    }
    ctx.restore();
  }
  function drawShamanBody(ctx, m, t, color, deco, look) {
    const x = m.x, y = m.y, r = m.cfg.radius;
    const bob = Math.sin(t * 3 + m.phase) * 3;
    if (deco) {
      ctx.save();
      ctx.translate(x, y - r * 0.55);
      ctx.rotate(t * 0.5);
      ctx.strokeStyle = "rgba(179,136,255,0.32)";
      ctx.lineWidth = 2;
      for (let i = 0; i < 6; i++) {
        ctx.beginPath();
        ctx.arc(0, 0, r * 1.15, Math.PI / 3 * i, Math.PI / 3 * i + 0.38);
        ctx.stroke();
      }
      ctx.restore();
    }
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x, y - r * 1.05);
    ctx.lineTo(x + r * 0.8, y + r * 0.1);
    ctx.lineTo(x, y + r);
    ctx.lineTo(x - r * 0.8, y + r * 0.1);
    ctx.closePath();
    ctx.fill();
    if (deco) {
      ctx.fillStyle = "rgba(11,12,29,0.45)";
      ctx.beginPath();
      ctx.moveTo(x, y - r * 0.86);
      ctx.lineTo(x + r * 0.34, y - r * 0.12);
      ctx.lineTo(x - r * 0.34, y - r * 0.12);
      ctx.closePath();
      ctx.fill();
      const oy = y - r - 9 + bob;
      const g = ctx.createRadialGradient(x, oy, 1, x, oy, 12);
      g.addColorStop(0, "rgba(245,245,250,0.95)");
      g.addColorStop(0.4, "rgba(179,136,255,0.7)");
      g.addColorStop(1, "rgba(179,136,255,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, oy, 12, 0, TAU);
      ctx.fill();
      ctx.fillStyle = "#F5F5FA";
      ctx.beginPath();
      ctx.arc(x, oy, 3.4, 0, TAU);
      ctx.fill();
    }
  }
  function drawZerglingBody(ctx, m, t, color, deco, look) {
    const x = m.x, y = m.y, r = m.cfg.radius;
    const sweep = Math.sin(t * 10 + m.phase) * r * 0.14;
    ctx.save();
    ctx.translate(x, y);
    if (deco) {
      ctx.strokeStyle = "rgba(26,36,16,0.85)";
      ctx.lineWidth = 2;
      ctx.lineCap = "round";
      for (const sx of [-1, 1]) {
        for (let i = 0; i < 2; i++) {
          const ph = Math.sin(t * 18 + m.phase + i * Math.PI + (sx > 0 ? Math.PI / 2 : 0)) * r * 0.16;
          const bx = sx * r * 0.5;
          const by = r * (i * 0.34 - 0.12);
          ctx.beginPath();
          ctx.moveTo(bx, by);
          ctx.lineTo(sx * r * 1, by + r * 0.22 + ph);
          ctx.lineTo(sx * r * 1.12, by + r * 0.5 + ph);
          ctx.stroke();
        }
      }
    }
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, -r * 1.05);
    ctx.lineTo(r * 1.1, 0);
    ctx.lineTo(0, r * 0.62);
    ctx.lineTo(-r * 1.1, 0);
    ctx.closePath();
    ctx.fill();
    if (deco) {
      ctx.strokeStyle = look.accent;
      ctx.lineWidth = 3;
      ctx.lineCap = "round";
      for (const sx of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(sx * r * 0.72, -r * 0.05);
        ctx.quadraticCurveTo(sx * r * 1.5, -r * 0.62 + sweep, sx * r * 0.82, -r * 1.26 + sweep);
        ctx.stroke();
      }
      ctx.fillStyle = "#3E5B21";
      ctx.beginPath();
      ctx.arc(0, -r * 0.68, r * 0.3, 0, TAU);
      ctx.fill();
      ctx.fillStyle = look.core;
      for (const sx of [-0.36, 0.36]) {
        ctx.beginPath();
        ctx.arc(sx * r * 0.26, -r * 0.72, r * 0.08, 0, TAU);
        ctx.fill();
      }
    }
    ctx.restore();
  }
  function drawGrubBody(ctx, m, t, color, deco, look) {
    const x = m.x, y = m.y, r = m.cfg.radius;
    const morph = m.cfg.morph;
    let rate = 3.2;
    let amp = 0.05;
    if (morph && m.morphLeft > 0) {
      const k = 1 - Math.min(1, m.morphLeft / Math.max(1e-3, morph.delay));
      rate = 3.2 + 9 * k;
      amp = 0.05 + 0.13 * k;
    }
    const pulse = 1 + amp * Math.sin(t * rate + m.phase);
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = color;
    for (let i = 0; i < 3; i++) {
      const kk = 1 - i * 0.17;
      ctx.beginPath();
      ctx.ellipse(0, i * r * 0.42 - r * 0.35, r * 0.72 * kk, r * 0.5 * kk, 0, 0, TAU);
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(0, -r * 0.72, r * 0.5 * pulse, 0, TAU);
    ctx.fill();
    if (deco) {
      ctx.strokeStyle = "rgba(26,36,16,0.7)";
      ctx.lineWidth = 1.5;
      for (const sx of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(sx * r * 0.3, -r * 0.92);
        ctx.lineTo(sx * r * 0.5, -r * 1.16);
        ctx.stroke();
      }
      const g = ctx.createRadialGradient(0, -r * 0.05, 1, 0, -r * 0.05, r * 0.66);
      g.addColorStop(0, `rgba(230,238,156,${0.32 + 0.3 * pulse})`);
      g.addColorStop(1, "rgba(230,238,156,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, -r * 0.05, r * 0.66, 0, TAU);
      ctx.fill();
      ctx.fillStyle = look.core;
      for (const sx of [-0.2, 0.2]) {
        ctx.beginPath();
        ctx.arc(sx * r, -r * 0.8, r * 0.075, 0, TAU);
        ctx.fill();
      }
    }
    ctx.restore();
  }
  function drawRoachBody(ctx, m, t, color, deco, look) {
    const x = m.x, y = m.y, r = m.cfg.radius;
    ctx.save();
    ctx.translate(x, y);
    if (deco) {
      ctx.strokeStyle = "rgba(26,36,16,0.8)";
      ctx.lineWidth = 2;
      ctx.lineCap = "round";
      for (const sx of [-1, 1]) {
        for (let i = 0; i < 3; i++) {
          const ph = Math.sin(t * 12 + m.phase + i * 2.1 + (sx > 0 ? Math.PI : 0)) * r * 0.12;
          ctx.beginPath();
          ctx.moveTo(sx * r * 0.55, r * (0.1 + i * 0.22) - r * 0.28);
          ctx.lineTo(sx * r * 1, r * (0.22 + i * 0.24) - r * 0.28 + ph);
          ctx.stroke();
        }
      }
    }
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.ellipse(0, 0, r, r * 0.7, 0, 0, TAU);
    ctx.fill();
    if (deco) {
      ctx.strokeStyle = "rgba(26,36,16,0.8)";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-r * 0.62, -r * 0.16);
      ctx.quadraticCurveTo(0, -r * 0.4, r * 0.62, -r * 0.16);
      ctx.stroke();
      ctx.fillStyle = look.accent;
      for (const dx of [-0.45, 0, 0.45]) {
        ctx.beginPath();
        ctx.moveTo(r * dx, -r * 0.4);
        ctx.lineTo(r * dx - r * 0.1, -r * 0.78);
        ctx.lineTo(r * dx + r * 0.1, -r * 0.78);
        ctx.closePath();
        ctx.fill();
      }
      ctx.fillStyle = "#3E5B21";
      ctx.beginPath();
      ctx.ellipse(0, -r * 0.74, r * 0.34, r * 0.26, 0, 0, TAU);
      ctx.fill();
      ctx.fillStyle = look.core;
      for (const sx of [-0.16, 0.16]) {
        ctx.beginPath();
        ctx.arc(sx * r, -r * 0.78, r * 0.07, 0, TAU);
        ctx.fill();
      }
    }
    ctx.restore();
  }
  function drawLurkerBody(ctx, m, t, color, deco, look) {
    const x = m.x, y = m.y, r = m.cfg.radius;
    const surfaced = m.surfaceLeft > 0;
    ctx.save();
    ctx.translate(x, y);
    if (surfaced && deco) {
      ctx.strokeStyle = `rgba(174,234,0,${0.3 + 0.2 * Math.sin(t * 8 + m.phase)})`;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.ellipse(0, r * 0.35, r * 1.05, r * 0.5, 0, 0, TAU);
      ctx.stroke();
    }
    if (deco) {
      ctx.fillStyle = "rgba(101,67,33,0.4)";
      ctx.beginPath();
      ctx.ellipse(0, r * 0.45, r * 0.85, r * 0.3, 0, 0, TAU);
      ctx.fill();
    }
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, -r * 1.1);
    ctx.lineTo(-r * 0.38, r * 0.5);
    ctx.lineTo(r * 0.38, r * 0.5);
    ctx.closePath();
    ctx.fill();
    if (deco) {
      ctx.strokeStyle = "rgba(26,36,16,0.8)";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.strokeStyle = look.accent;
      ctx.lineWidth = 2.4;
      ctx.lineCap = "round";
      const claw = r * 0.98;
      ctx.beginPath();
      ctx.moveTo(-r * 0.28, -r * 0.3);
      ctx.lineTo(-claw, -r * 0.62);
      ctx.moveTo(r * 0.28, -r * 0.3);
      ctx.lineTo(claw, -r * 0.62);
      ctx.moveTo(-r * 0.28, r * 0.1);
      ctx.lineTo(-r * 0.9, -r * 0.02);
      ctx.moveTo(r * 0.28, r * 0.1);
      ctx.lineTo(r * 0.9, -r * 0.02);
      ctx.stroke();
      ctx.fillStyle = "#D8FF50";
      ctx.fillRect(-r * 0.16, -r * 0.66, r * 0.32, r * 0.1);
    }
    ctx.restore();
  }
  function drawQueenBody(ctx, m, t, color, deco, look) {
    const x = m.x, y = m.y, r = m.cfg.radius;
    const aura = m.cfg.healAura;
    if (aura && deco) {
      const total = Math.max(1e-3, aura.interval);
      const k = Math.min(1, Math.max(0, 1 - m.healTimer / total));
      const eased = 1 - Math.pow(1 - k, 3);
      const ringR = r * 1.15 + (aura.radius - r * 1.15) * eased;
      const glow = ctx.createRadialGradient(x, y, r * 0.6, x, y, aura.radius);
      const ga = 0.05 + 0.1 * (1 - k);
      glow.addColorStop(0, `rgba(124,179,66,${ga * 1.6})`);
      glow.addColorStop(0.72, `rgba(124,179,66,${ga * 0.6})`);
      glow.addColorStop(1, "rgba(124,179,66,0)");
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(x, y, aura.radius, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = `rgba(124,179,66,${0.15 + 0.45 * k})`;
      ctx.lineWidth = 2.5 - 1.5 * k;
      ctx.beginPath();
      ctx.arc(x, y, ringR, 0, TAU);
      ctx.stroke();
      const n = Math.min(6, Math.max(3, Math.round(aura.radius / 60)));
      for (let i = 0; i < n; i++) {
        const a = TAU * i / n + t * 0.45 + m.phase;
        const rise = (t * 0.18 + i * 0.37) % 1;
        const rr2 = ringR * (0.35 + 0.62 * rise);
        ctx.fillStyle = `rgba(174,234,0,${((1 - rise) * 0.55 * (0.35 + 0.65 * k)).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(x + Math.cos(a) * rr2, y + Math.sin(a) * rr2 * 0.82, 2.4 - rise, 0, TAU);
        ctx.fill();
      }
    }
    const belly = 1 + 0.06 * Math.sin(t * 2.6 + m.phase);
    ctx.fillStyle = deco ? "rgba(124,179,66,0.55)" : color;
    ctx.beginPath();
    ctx.ellipse(x, y + r * 0.62, r * 0.62 * belly, r * 0.46 * belly, 0, 0, TAU);
    ctx.fill();
    const layers = deco ? [[1, color], [0.64, "#A46BE0"], [0.3, "#D9A6FF"]] : [[1, color]];
    for (const [k2, c2] of layers) {
      ctx.fillStyle = c2;
      ctx.beginPath();
      ctx.moveTo(x, y - r * k2);
      ctx.lineTo(x + r * 0.8 * k2, y);
      ctx.lineTo(x, y + r * k2);
      ctx.lineTo(x - r * 0.8 * k2, y);
      ctx.closePath();
      ctx.fill();
    }
    if (deco) {
      ctx.fillStyle = "#FF9DE2";
      for (const sx of [-0.34, 0, 0.34]) {
        ctx.beginPath();
        ctx.moveTo(x + sx * r, y - r * 0.92);
        ctx.lineTo(x + sx * r - r * 0.1, y - r * 1.24);
        ctx.lineTo(x + sx * r + r * 0.1, y - r * 1.24);
        ctx.closePath();
        ctx.fill();
      }
    }
  }
  function drawBanelingBody(ctx, m, t, color, deco, look) {
    const x = m.x, y = m.y, r = m.cfg.radius;
    const hpK = Math.min(1, Math.max(0, 1 - m.hp / m.maxHp));
    const danger = m.state === "assault" ? 1 : Math.max(hpK, 0);
    const rate = 4 + 10 * danger;
    const amp = 0.1 + 0.16 * danger;
    const pulse = 1 + amp * Math.sin(t * rate + m.phase);
    if (danger > 0.35 && deco) {
      const warnK = (danger - 0.35) / 0.65;
      ctx.strokeStyle = `rgba(255,90,60,${(0.25 + 0.5 * warnK) * (0.6 + 0.4 * Math.sin(t * rate + m.phase))})`;
      ctx.lineWidth = 2 + 2 * warnK;
      ctx.beginPath();
      ctx.arc(x, y, r * pulse + 3, 0, TAU);
      ctx.stroke();
    }
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, r * pulse, 0, TAU);
    ctx.fill();
    if (deco) {
      const coreK = 0.4 + 0.6 * danger;
      ctx.fillStyle = `rgba(255,${Math.round(220 - 90 * danger)},${Math.round(120 - 100 * danger)},${0.55 + 0.4 * danger})`;
      ctx.beginPath();
      ctx.arc(x, y, r * 0.45 * pulse * coreK, 0, TAU);
      ctx.fill();
      if (danger > 0.5) {
        const cr = (danger - 0.5) / 0.5;
        ctx.strokeStyle = `rgba(216,255,80,${0.5 * cr})`;
        ctx.lineWidth = 1.5;
        for (let i = 0; i < 4; i++) {
          const a = Math.PI / 2 * i + t * 1.2 + m.phase;
          ctx.beginPath();
          ctx.moveTo(x + Math.cos(a) * r * 0.3, y + Math.sin(a) * r * 0.3);
          ctx.lineTo(x + Math.cos(a) * r * pulse * 0.92, y + Math.sin(a) * r * pulse * 0.92);
          ctx.stroke();
        }
      }
      if (danger > 0.75) {
        const finalK = (danger - 0.75) / 0.25;
        const fl = Math.max(0, Math.sin(t * 26 + m.phase));
        ctx.fillStyle = `rgba(255,255,255,${0.55 * finalK * fl * fl})`;
        ctx.beginPath();
        ctx.arc(x, y, r * pulse, 0, TAU);
        ctx.fill();
      }
    }
  }
  function drawUltraBody(ctx, m, t, color, deco, look) {
    const x = m.x, y = m.y, r = m.cfg.radius;
    if (deco) {
      const stomp = (t * 0.62 + m.phase) % 1;
      if (stomp < 0.5) {
        const k = stomp / 0.5;
        ctx.strokeStyle = `rgba(105,168,59,${0.28 * (1 - k)})`;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.ellipse(x, y - r * 0.2, r * (1 + k * 0.5), r * 0.42 * (1 + k * 0.5), 0, 0, TAU);
        ctx.stroke();
      }
    }
    ctx.fillStyle = color;
    poly(ctx, x, y, 10, r, -Math.PI / 2, 0.72);
    ctx.fill();
    if (deco) {
      ctx.strokeStyle = "rgba(26,36,16,0.9)";
      ctx.lineWidth = 3;
      poly(ctx, x, y, 10, r, -Math.PI / 2, 0.72);
      ctx.stroke();
      ctx.strokeStyle = look.accent;
      ctx.lineWidth = 6;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(x - r * 0.75, y - r * 0.15);
      ctx.quadraticCurveTo(x - r * 1.5, y - r * 0.5, x - r * 1.45, y - r * 1.05);
      ctx.moveTo(x + r * 0.75, y - r * 0.15);
      ctx.quadraticCurveTo(x + r * 1.5, y - r * 0.5, x + r * 1.45, y - r * 1.05);
      ctx.stroke();
      ctx.lineCap = "butt";
      ctx.strokeStyle = "rgba(26,36,16,0.9)";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(x - r * 0.3, y + r * 0.75);
      ctx.lineTo(x - r * 0.55, y + r * 1.05);
      ctx.moveTo(x + r * 0.3, y + r * 0.75);
      ctx.lineTo(x + r * 0.55, y + r * 1.05);
      ctx.stroke();
      ctx.fillStyle = "#D8FF50";
      ctx.beginPath();
      ctx.arc(x, y - r * 0.05, r * 0.14, 0, TAU);
      ctx.fill();
    }
  }
  function drawWeaponMount(ctx, w, x, y, angle, t, color, k, beamLive, overheated) {
    const look = weaponLook(w);
    const id = w.cfg.id;
    const isBeam = !!w.cfg.beamBase;
    const recoil = isBeam ? 0 : k * 3;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle - Math.PI / 2);
    ctx.fillStyle = "#12142B";
    ctx.strokeStyle = "#3D4470";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(0, 0, 7.5, 0, TAU);
    ctx.fill();
    ctx.stroke();
    switch (id) {
      case "crossbow_pierce": {
        ctx.strokeStyle = color;
        ctx.lineWidth = 2.4;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(-10, 5);
        ctx.quadraticCurveTo(0, 11, 10, 5);
        ctx.stroke();
        ctx.strokeStyle = "rgba(245,245,250,0.75)";
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(-10, 5);
        ctx.lineTo(0, 1 + recoil * 0.6);
        ctx.lineTo(10, 5);
        ctx.stroke();
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(0, 14 - recoil);
        ctx.stroke();
        break;
      }
      case "alchemist_bomb": {
        ctx.fillStyle = "#1B1E3A";
        rr(ctx, -4.5, -3, 9, 15, 2.5);
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        rr(ctx, -4.5, -3, 9, 15, 2.5);
        ctx.stroke();
        ctx.fillStyle = "#0B0C1D";
        ctx.beginPath();
        ctx.ellipse(0, 12, 4.6, 2.2, 0, 0, TAU);
        ctx.fill();
        const puff = (t * 0.6 + w.cfg.id.length % 3 * 0.3) % 1;
        ctx.fillStyle = `rgba(255,179,87,${0.22 * (1 - puff)})`;
        ctx.beginPath();
        ctx.arc(0, 14 + puff * 10, 2 + puff * 5, 0, TAU);
        ctx.fill();
        break;
      }
      case "boomerang": {
        ctx.strokeStyle = "#3D4470";
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(-4, 2);
        ctx.lineTo(-5, 12);
        ctx.moveTo(4, 2);
        ctx.lineTo(5, 12);
        ctx.stroke();
        ctx.save();
        ctx.translate(0, 8);
        ctx.rotate(t * 9);
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        for (let i = 0; i < 3; i++) {
          const a = Math.PI / 3 * i;
          ctx.beginPath();
          ctx.moveTo(-Math.cos(a) * 4.5, -Math.sin(a) * 4.5);
          ctx.lineTo(Math.cos(a) * 4.5, Math.sin(a) * 4.5);
          ctx.stroke();
        }
        ctx.restore();
        break;
      }
      case "lightning_chain": {
        ctx.strokeStyle = "#3D4470";
        ctx.lineWidth = 3;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(0, 1);
        ctx.lineTo(0, 11);
        ctx.stroke();
        const flick = 0.55 + 0.45 * Math.sin(t * 11);
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.35 + 0.4 * flick;
        ctx.beginPath();
        ctx.moveTo(0, 11);
        ctx.lineTo(4.5, 15.5);
        ctx.lineTo(0, 20);
        ctx.lineTo(-4.5, 15.5);
        ctx.closePath();
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.fillStyle = "#F5F5FA";
        ctx.beginPath();
        ctx.arc(0, 15.5, 1.8, 0, TAU);
        ctx.fill();
        break;
      }
      case "laser_cannon": {
        ctx.fillStyle = "#1B1E3A";
        ctx.beginPath();
        ctx.moveTo(-5, 1);
        ctx.lineTo(5, 1);
        ctx.lineTo(3.5, 14);
        ctx.lineTo(-3.5, 14);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.8;
        ctx.stroke();
        ctx.fillStyle = color;
        ctx.globalAlpha = beamLive ? 0.85 : 0.28;
        ctx.beginPath();
        ctx.ellipse(0, 13, 3.2, 1.8, 0, 0, TAU);
        ctx.fill();
        ctx.globalAlpha = 1;
        break;
      }
      case "gun_rifle":
      default: {
        ctx.strokeStyle = color;
        ctx.lineWidth = 2.4;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(-2.6, -3 + recoil * 0.4);
        ctx.lineTo(-2.6, 13 - recoil);
        ctx.moveTo(2.6, -3 + recoil * 0.4);
        ctx.lineTo(2.6, 13 - recoil);
        ctx.stroke();
        ctx.strokeStyle = "rgba(245,245,250,0.5)";
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(0, 8, 4.4, 0, TAU);
        ctx.stroke();
        break;
      }
    }
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(0, 13 - recoil, 2.4, 0, TAU);
    ctx.fill();
    if (beamLive) {
      ctx.globalAlpha = 0.45 + 0.25 * Math.sin(t * 24);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(0, 13, 6.5, 0, TAU);
      ctx.fill();
      ctx.fillStyle = "#F5F5FA";
      ctx.beginPath();
      ctx.arc(0, 13, 2.6, 0, TAU);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    if (overheated) {
      ctx.globalAlpha = 0.45 + 0.3 * Math.sin(t * 12);
      ctx.strokeStyle = "#FF7A6B";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, 9.5, 0, TAU);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    if (k > 0.02) {
      drawMuzzleFlash(ctx, look.muzzle, t, k, recoil, color);
    }
    ctx.restore();
  }
  function drawMuzzleFlash(ctx, style, t, k, recoil, color) {
    const yy = 15 - recoil;
    ctx.save();
    ctx.globalAlpha = Math.min(1, k) * 0.9;
    switch (style) {
      case "cone": {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(-2, yy);
        ctx.lineTo(0, yy + 10 + 6 * k);
        ctx.lineTo(2, yy);
        ctx.closePath();
        ctx.fill();
        break;
      }
      case "puff": {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(-2.4, yy + 3, 3.2 + 3 * k, 0, TAU);
        ctx.arc(2.8, yy + 5, 2.4 + 2.4 * k, 0, TAU);
        ctx.fill();
        break;
      }
      case "ring": {
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(0, yy, 3 + 9 * k, 0, TAU);
        ctx.stroke();
        break;
      }
      case "crackle": {
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        for (let i = 0; i < 3; i++) {
          const a = Math.PI * 2 * i / 3 + t * 3;
          ctx.moveTo(Math.cos(a) * 3, yy + Math.sin(a) * 3);
          ctx.lineTo(Math.cos(a) * 9, yy + Math.sin(a) * 9);
        }
        ctx.stroke();
        break;
      }
      case "lens": {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.ellipse(0, yy + 1, 10 + 6 * k, 1.6, 0, 0, TAU);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(0, yy, 2 + 2.5 * k, 0, TAU);
        ctx.fill();
        break;
      }
      case "star":
      default: {
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        const L1 = 4 + 7 * k;
        const L2 = 3 + 4 * k;
        ctx.moveTo(-L1, yy);
        ctx.lineTo(L1, yy);
        ctx.moveTo(0, yy - L2);
        ctx.lineTo(0, yy + L2);
        ctx.moveTo(-L2 * 0.7, yy - L2 * 0.7);
        ctx.lineTo(L2 * 0.7, yy + L2 * 0.7);
        ctx.moveTo(-L2 * 0.7, yy + L2 * 0.7);
        ctx.lineTo(L2 * 0.7, yy - L2 * 0.7);
        ctx.stroke();
        ctx.fillStyle = "#FFF6D6";
        ctx.beginPath();
        ctx.arc(0, yy, 1.8 + 2.4 * k, 0, TAU);
        ctx.fill();
        break;
      }
    }
    ctx.restore();
  }
  function drawProjectile(ctx, p, t, color) {
    const look = weaponLook(p.weapon);
    const dx = p.x - p.px;
    const dy = p.y - p.py;
    const len2 = Math.hypot(dx, dy) || 1;
    const ux = dx / len2;
    const uy = dy / len2;
    const ang = Math.atan2(uy, ux);
    switch (look.bullet) {
      case "bolt": {
        const shaft = 26;
        ctx.strokeStyle = `${color}30`;
        ctx.lineWidth = 5;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(p.x - ux * 84, p.y - uy * 84);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
        ctx.strokeStyle = color;
        ctx.lineWidth = 2.6;
        ctx.beginPath();
        ctx.moveTo(p.x - ux * shaft, p.y - uy * shaft);
        ctx.lineTo(p.x + ux * 6, p.y + uy * 6);
        ctx.stroke();
        ctx.fillStyle = "#F5F5FA";
        ctx.beginPath();
        ctx.moveTo(p.x + ux * 13, p.y + uy * 13);
        ctx.lineTo(p.x - ux * 1 + -uy * 4.4, p.y - uy * 1 + ux * 4.4);
        ctx.lineTo(p.x - ux * 1 - -uy * 4.4, p.y - uy * 1 - ux * 4.4);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = look.accent;
        ctx.lineWidth = 2;
        for (const s of [-1, 1]) {
          ctx.beginPath();
          ctx.moveTo(p.x - ux * shaft, p.y - uy * shaft);
          ctx.lineTo(p.x - ux * (shaft + 9) + -uy * 5 * s, p.y - uy * (shaft + 9) + ux * 5 * s);
          ctx.stroke();
        }
        break;
      }
      case "flask": {
        const h = p.height;
        ctx.fillStyle = "rgba(0,0,0,0.28)";
        ctx.beginPath();
        ctx.ellipse(p.x, p.y, 10, 3.6, 0, 0, TAU);
        ctx.fill();
        const by = p.y + h;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(p.x, by, p.radius + 3.5, 0, TAU);
        ctx.fill();
        ctx.strokeStyle = "rgba(11,12,29,0.65)";
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.fillStyle = "#C9A26B";
        rr(ctx, p.x - 2.4, by + p.radius + 1.5, 4.8, 6, 1.4);
        ctx.fill();
        const sway = Math.sin(t * 18) * 2.4;
        ctx.strokeStyle = "#C9A26B";
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(p.x, by + p.radius + 7);
        ctx.quadraticCurveTo(p.x + sway, by + p.radius + 11, p.x + sway * 0.6, by + p.radius + 14);
        ctx.stroke();
        ctx.fillStyle = `rgba(255,213,79,${0.6 + 0.4 * Math.sin(t * 22)})`;
        ctx.beginPath();
        ctx.arc(p.x + sway * 0.6, by + p.radius + 15, 2.4, 0, TAU);
        ctx.fill();
        ctx.fillStyle = "rgba(255,255,255,0.35)";
        ctx.beginPath();
        ctx.arc(p.x - p.radius * 0.35, by + p.radius * 0.4, 2, 0, TAU);
        ctx.fill();
        break;
      }
      case "disc": {
        const R = 17;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(t * 11 + p.id);
        ctx.strokeStyle = `${color}55`;
        ctx.lineWidth = 2;
        for (let i = 0; i < 2; i++) {
          ctx.beginPath();
          ctx.arc(0, 0, R + 4 + i * 3, 0.3 + i, 2.1 + i);
          ctx.stroke();
        }
        ctx.fillStyle = color;
        for (let i = 0; i < 8; i++) {
          ctx.save();
          ctx.rotate(Math.PI / 4 * i);
          ctx.fillRect(-2.5, -R - 4.5, 5, 6.5);
          ctx.restore();
        }
        ctx.beginPath();
        ctx.arc(0, 0, R, 0, TAU);
        ctx.fill();
        ctx.fillStyle = "#0B0C1D";
        ctx.beginPath();
        ctx.arc(0, 0, R * 0.45, 0, TAU);
        ctx.fill();
        if (p.homing) {
          ctx.strokeStyle = "rgba(255,213,79,0.8)";
          ctx.lineWidth = 1.6;
          ctx.beginPath();
          ctx.arc(0, 0, R + 8, -0.6, 1.6);
          ctx.stroke();
        }
        ctx.restore();
        break;
      }
      case "chain":
      case "beam": {
        drawRuneBullet(ctx, p, ang, color, look.accent, t);
        break;
      }
      case "rune":
      default: {
        drawRuneBullet(ctx, p, ang, color, look.accent, t);
        break;
      }
    }
  }
  function drawRuneBullet(ctx, p, ang, color, accent, t) {
    const r = Math.max(3, p.radius);
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(ang);
    const grad = ctx.createLinearGradient(-34, 0, 0, 0);
    grad.addColorStop(0, `${color}00`);
    grad.addColorStop(1, `${color}88`);
    ctx.strokeStyle = grad;
    ctx.lineWidth = 2.6;
    ctx.beginPath();
    ctx.moveTo(-34, 0);
    ctx.lineTo(0, 0);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(r * 1.7, 0);
    ctx.lineTo(0, r * 1.05);
    ctx.lineTo(-r * 1.7, 0);
    ctx.lineTo(0, -r * 1.05);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = accent;
    ctx.globalAlpha = 0.7;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(0, 0, r * 1.9, t * 6, t * 6 + 2.1);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#FFFFFF";
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.42, 0, TAU);
    ctx.fill();
    ctx.restore();
  }
  function drawMonsterShot(ctx, s) {
    const color = "#FFB357";
    if (s.kind === "rock") {
      ctx.fillStyle = "rgba(0,0,0,0.28)";
      ctx.beginPath();
      ctx.ellipse(s.x, s.ty, 10, 4, 0, 0, TAU);
      ctx.fill();
      const rot = s.t * 9;
      ctx.save();
      ctx.translate(s.x, s.y + s.height);
      ctx.rotate(rot);
      ctx.fillStyle = color;
      ctx.beginPath();
      for (let i = 0; i < 7; i++) {
        const a = TAU / 7 * i;
        const rad = i % 2 === 0 ? 9.5 : 7.5;
        const px = Math.cos(a) * rad;
        const py = Math.sin(a) * rad;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = "rgba(11,12,29,0.5)";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = "rgba(11,12,29,0.25)";
      ctx.beginPath();
      ctx.arc(-2, 1.5, 2.6, 0, TAU);
      ctx.arc(3, -2, 1.8, 0, TAU);
      ctx.fill();
      ctx.restore();
      for (let i = 0; i < 3; i++) {
        const k = (s.t * 3 + i * 0.33) % 1;
        ctx.fillStyle = `rgba(169,113,75,${0.18 * (1 - k)})`;
        ctx.beginPath();
        ctx.arc(s.x - (s.x - s.sx) * k * 0.25, s.y + s.height * (1 - k * 0.2), 3 + k * 4, 0, TAU);
        ctx.fill();
      }
    } else {
      const dx = s.tx - s.sx;
      const dy = s.ty - s.sy;
      const l = Math.hypot(dx, dy) || 1;
      const ux = dx / l;
      const uy = dy / l;
      const spin = Math.sin(s.t * 12) * 0.25;
      ctx.save();
      ctx.translate(s.x, s.y + s.height);
      ctx.rotate(Math.atan2(uy, ux) + spin);
      ctx.strokeStyle = `${color}55`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(-26, 0);
      ctx.lineTo(-8, 0);
      ctx.stroke();
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(-16, 0);
      ctx.lineTo(6, 0);
      ctx.stroke();
      ctx.fillStyle = "#F5F5FA";
      ctx.beginPath();
      ctx.moveTo(12, 0);
      ctx.lineTo(3, 3);
      ctx.lineTo(3, -3);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }
  function drawHealPulse(ctx, x, y, radius, k) {
    const alpha = 0.5 * (1 - k);
    ctx.strokeStyle = `rgba(124,179,66,${alpha})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(x, y, radius * (0.3 + 0.7 * k), 0, TAU);
    ctx.stroke();
  }
  function drawTransfer(ctx, fx, fy, tx, ty, alpha) {
    const mx = (fx + tx) / 2 + (Math.random() - 0.5) * 24;
    const my = (fy + ty) / 2 + (Math.random() - 0.5) * 24;
    ctx.strokeStyle = `rgba(179,136,255,${alpha})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(fx, fy);
    ctx.lineTo(mx, my);
    ctx.lineTo(tx, ty);
    ctx.stroke();
  }
  function drawPool(ctx, pool, t) {
    const left = Math.max(0, pool.until - t);
    const lifeK = Math.min(1, left * 0.8);
    const r = pool.radius;
    const fire = pool.damageType === "fire";
    const outer = fire ? "255,90,60" : pool.damageType === "poison" ? "124,179,66" : pool.damageType === "frost" ? "79,195,247" : "179,136,255";
    const inner = fire ? "255,170,60" : pool.damageType === "poison" ? "174,234,0" : pool.damageType === "frost" ? "179,229,252" : "217,166,255";
    ctx.fillStyle = `rgba(11,12,29,${0.55 * lifeK})`;
    ctx.beginPath();
    ctx.arc(pool.x, pool.y, r + 6, 0, TAU);
    ctx.fill();
    const pulse = 0.85 + 0.15 * Math.sin(t * 6 + pool.x * 0.05);
    ctx.fillStyle = `rgba(${outer},${0.4 * lifeK})`;
    ctx.beginPath();
    ctx.arc(pool.x, pool.y, r * pulse, 0, TAU);
    ctx.fill();
    ctx.fillStyle = `rgba(${inner},${0.35 * lifeK})`;
    ctx.beginPath();
    ctx.arc(pool.x, pool.y, r * 0.55 * pulse, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = `rgba(${outer},${0.8 * lifeK})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(pool.x, pool.y, r, 0, TAU);
    ctx.stroke();
    for (let i = 0; i < 4; i++) {
      const seed = pool.x * 0.13 + pool.y * 0.07 + i * 2.4;
      const k = (t * 0.9 + seed) % 1;
      const ex = pool.x + Math.sin(seed * 7 + k * 3) * r * 0.6 * (1 - k);
      const ey = pool.y + (0.5 - k) * r * 1.2;
      ctx.fillStyle = `rgba(255,213,79,${(1 - k) * 0.8 * lifeK})`;
      ctx.beginPath();
      ctx.arc(ex, ey, 2.2, 0, TAU);
      ctx.fill();
    }
  }

  // src/adapter/web/render/kills.ts
  var MAX_PARTICLES = 560;
  var MAX_RINGS = 48;
  var MAX_DECALS = 42;
  var MAX_GLYPHS = 96;
  var MAX_SMOKE = 64;
  function makeRng(seed) {
    let a = seed * 2654435769 >>> 0;
    return () => {
      a = a + 1831565813 >>> 0;
      let t = a;
      t = Math.imul(t ^ t >>> 15, t | 1);
      t ^= t + Math.imul(t ^ t >>> 7, t | 61);
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  var TAU2 = Math.PI * 2;
  var KillFx = class {
    constructor() {
      this.particles = [];
      this.rings = [];
      this.decals = [];
      this.smoke = [];
      this.glyphs = [];
      this.seedCount = 1;
    }
    /** 清场（重开局/切关时调用，避免上一局的残留粒子飘进新局） */
    clear() {
      this.particles.length = 0;
      this.rings.length = 0;
      this.decals.length = 0;
      this.smoke.length = 0;
      this.glyphs.length = 0;
    }
    rng() {
      return makeRng(this.seedCount++);
    }
    pushParticle(p) {
      if (this.particles.length >= MAX_PARTICLES) this.particles.shift();
      this.particles.push(p);
    }
    pushRing(x, y, r0, r1, color, width, dur) {
      if (this.rings.length >= MAX_RINGS) this.rings.shift();
      this.rings.push({ x, y, r0, r1, color, width, life: dur, maxLife: dur });
    }
    pushDecal(x, y, radius, color, dur) {
      if (this.decals.length >= MAX_DECALS) this.decals.shift();
      this.decals.push({ x, y, radius, color, life: dur, maxLife: dur });
    }
    pushGlyph(g) {
      if (this.glyphs.length >= MAX_GLYPHS) this.glyphs.shift();
      this.glyphs.push(g);
    }
    // ---------------- 事件入口 ----------------
    /**
     * 怪物死亡：按身份表的 death 配方生成碎块 + 冲击环 + 地面残留 + 尘烟 + 专属符号，
     * 再叠一层「致命伤害类型」风味（火焰=余烬上飘、寒冰=碎晶、雷电=电弧、毒素=气泡）。
     */
    spawnKill(info) {
      const look = lookOf(info.key, info.shape);
      const r = look.death;
      const scale = SIZE_SCALE[look.size] * Math.min(1.7, Math.max(0.75, info.radius / 20));
      const rnd = this.rng();
      const t = info.damageType ? DAMAGE_FX[info.damageType] : null;
      const count = Math.min(30, Math.round(r.count * (scale > 1.3 ? 1.35 : 1)));
      for (let i = 0; i < count; i++) {
        const a = rnd() * TAU2;
        const sp = r.speed[0] + rnd() * (r.speed[1] - r.speed[0]);
        const color = r.color2 && rnd() < 0.4 ? r.color2 : r.color;
        this.pushParticle({
          x: info.x + Math.cos(a) * info.radius * 0.35,
          y: info.y + Math.sin(a) * info.radius * 0.35,
          vx: Math.cos(a) * sp * (0.6 + 0.4 * scale),
          vy: Math.sin(a) * sp * (0.6 + 0.4 * scale),
          life: 0.34 + rnd() * 0.5,
          maxLife: 0.34 + rnd() * 0.5,
          size: (r.size[0] + rnd() * (r.size[1] - r.size[0])) * Math.min(1.5, scale),
          color,
          chunk: r.chunks,
          rot: rnd() * TAU2,
          vr: (rnd() - 0.5) * (r.spin ? 14 : 3),
          gravity: r.gravity,
          drag: 2.2
        });
      }
      if (r.ring) {
        this.pushRing(info.x, info.y, info.radius * 0.5, r.ring.r1 * scale, r.ring.color, r.ring.width, r.ring.dur * (r.weight ?? 1));
      }
      if (r.decal) {
        this.pushDecal(info.x, info.y, r.decal.radius * scale, r.decal.color, r.decal.dur);
      }
      if (r.smoke) {
        const n = Math.round(r.smoke.count * Math.min(1.6, scale));
        for (let i = 0; i < n; i++) {
          const a = rnd() * TAU2;
          if (this.smoke.length >= MAX_SMOKE) this.smoke.shift();
          this.smoke.push({
            x: info.x + Math.cos(a) * info.radius * 0.4,
            y: info.y + Math.sin(a) * info.radius * 0.4,
            vx: Math.cos(a) * (12 + rnd() * 26),
            vy: Math.sin(a) * (12 + rnd() * 26) + 8,
            size: (8 + rnd() * 12) * scale,
            life: 0.5 + rnd() * 0.45,
            maxLife: 0.5 + rnd() * 0.45,
            color: r.smoke.color
          });
        }
      }
      if (r.glyphs) {
        for (const g of r.glyphs) this.spawnGlyphSpec(g, info.x, info.y, scale, rnd);
      }
      if (t) {
        const n = Math.round(5 * scale);
        for (let i = 0; i < n; i++) {
          const a = rnd() * TAU2;
          const sp = 60 + rnd() * 180;
          this.pushParticle({
            x: info.x + (rnd() - 0.5) * info.radius * 0.8,
            y: info.y + (rnd() - 0.5) * info.radius * 0.8,
            vx: Math.cos(a) * sp,
            vy: Math.sin(a) * sp * 0.6 + (t.chunk === "ember" ? 90 : 0),
            // 余烬上飘
            life: 0.26 + rnd() * 0.4,
            maxLife: 0.26 + rnd() * 0.4,
            size: 2 + rnd() * 3,
            color: t.color,
            chunk: t.chunk,
            rot: rnd() * TAU2,
            vr: (rnd() - 0.5) * 8,
            gravity: t.chunk === "ember" ? -60 : 40,
            drag: 1.6
          });
        }
        if (info.damageType === "lightning") {
          this.spawnGlyph("arc", info.x, info.y, 0, 0, 26 * scale, t.color, 0.32, rnd() * TAU2);
        }
        if (info.damageType === "frost") {
          this.pushRing(info.x, info.y, info.radius * 0.6, info.radius * 1.9 * scale, t.color, 2, 0.45);
        }
        if (info.damageType === "fire" && !r.decal) {
          this.pushDecal(info.x, info.y, info.radius * 1.1 * scale, t.stain, 2.2);
        }
      }
      this.pushRing(info.x, info.y, 0, info.radius * 0.9, "#F5F5FA", 2, 0.14);
    }
    spawnGlyphSpec(g, x, y, scale, rnd) {
      for (let i = 0; i < g.count; i++) {
        const a = rnd() * TAU2;
        const sp = g.speed[0] + rnd() * (g.speed[1] - g.speed[0]);
        this.spawnGlyph(
          g.kind,
          x + Math.cos(a) * 6,
          y + Math.sin(a) * 6,
          Math.cos(a) * sp,
          Math.sin(a) * sp,
          (g.size[0] + rnd() * (g.size[1] - g.size[0])) * Math.min(1.5, scale),
          g.color,
          g.dur,
          rnd() * TAU2
        );
      }
    }
    spawnGlyph(kind, x, y, vx, vy, size, color, dur, rot) {
      this.pushGlyph({
        kind,
        x,
        y,
        vx,
        vy,
        rot,
        vr: kind === "drop" || kind === "split" ? kind === "drop" ? 9 : 3 : 0,
        size,
        color,
        life: dur,
        maxLife: dur,
        seed: this.seedCount * 977 + Math.floor(x * 13 + y * 7)
      });
    }
    /**
     * 命中火花：与受击闪白（fx-config）叠加使用——闪白回答"打中了"，火花回答"什么打的"。
     * strength 由调用方按暴击/伤害量给，控制在 1~3，避免大伤害时糊屏。
     */
    spawnHit(x, y, damageType, strength = 1) {
      const t = damageType ? DAMAGE_FX[damageType] : DAMAGE_FX.physical;
      const rnd = this.rng();
      const n = Math.min(9, Math.round(2 + 2.4 * strength));
      for (let i = 0; i < n; i++) {
        const a = rnd() * TAU2;
        const sp = 90 + rnd() * 240;
        this.pushParticle({
          x,
          y,
          vx: Math.cos(a) * sp,
          vy: Math.sin(a) * sp,
          life: 0.12 + rnd() * 0.16,
          maxLife: 0.12 + rnd() * 0.16,
          size: 1.6 + rnd() * 2.2 + strength * 0.5,
          color: rnd() < 0.55 ? t.color : "#F5F5FA",
          chunk: t.chunk === "spark" ? "spark" : t.chunk,
          rot: a,
          vr: 6,
          gravity: 0,
          drag: 5
        });
      }
      if (strength >= 1.8) this.pushRing(x, y, 2, 12 + strength * 4, t.color, 1.8, 0.16);
    }
    /** 爆炸（炸弹落地 / 毒爆 / 场景爆炸）：双向冲击环 + 碎块 + 烟。 */
    spawnExplode(x, y, radius, damageType) {
      const t = damageType ? DAMAGE_FX[damageType] : DAMAGE_FX.fire;
      const rnd = this.rng();
      this.pushRing(x, y, radius * 0.1, radius * 1.15, t.color, 4, 0.34);
      this.pushRing(x, y, radius * 0.05, radius * 0.72, "#F5F5FA", 2.5, 0.22);
      for (let i = 0; i < 12; i++) {
        const a = rnd() * TAU2;
        const sp = 80 + rnd() * 260;
        this.pushParticle({
          x,
          y,
          vx: Math.cos(a) * sp,
          vy: Math.sin(a) * sp,
          life: 0.24 + rnd() * 0.4,
          maxLife: 0.24 + rnd() * 0.4,
          size: 3 + rnd() * 5,
          color: rnd() < 0.4 ? "#F5F5FA" : t.color,
          chunk: t.chunk,
          rot: rnd() * TAU2,
          vr: (rnd() - 0.5) * 10,
          gravity: 120,
          drag: 2.4
        });
      }
      for (let i = 0; i < 4; i++) {
        const a = rnd() * TAU2;
        if (this.smoke.length >= MAX_SMOKE) this.smoke.shift();
        this.smoke.push({
          x,
          y,
          vx: Math.cos(a) * 30,
          vy: Math.sin(a) * 30 + 14,
          size: 14 + rnd() * 16,
          life: 0.5 + rnd() * 0.4,
          maxLife: 0.5 + rnd() * 0.4,
          color: t.stain
        });
      }
    }
    // ---------------- 帧推进 ----------------
    update(dt) {
      const d = Math.min(0.05, dt);
      for (let i = this.particles.length - 1; i >= 0; i--) {
        const p = this.particles[i];
        p.life -= d;
        if (p.life <= 0) {
          this.particles.splice(i, 1);
          continue;
        }
        const k = Math.max(0, 1 - p.drag * d);
        p.vx *= k;
        p.vy *= k;
        p.vy -= p.gravity * d;
        p.x += p.vx * d;
        p.y += p.vy * d;
        p.rot += p.vr * d;
      }
      for (let i = this.rings.length - 1; i >= 0; i--) {
        const r = this.rings[i];
        r.life -= d;
        if (r.life <= 0) this.rings.splice(i, 1);
      }
      for (let i = this.decals.length - 1; i >= 0; i--) {
        const r = this.decals[i];
        r.life -= d;
        if (r.life <= 0) this.decals.splice(i, 1);
      }
      for (let i = this.smoke.length - 1; i >= 0; i--) {
        const s = this.smoke[i];
        s.life -= d;
        if (s.life <= 0) {
          this.smoke.splice(i, 1);
          continue;
        }
        s.x += s.vx * d;
        s.y += s.vy * d;
        s.vx *= Math.max(0, 1 - 1.4 * d);
        s.vy *= Math.max(0, 1 - 1.4 * d);
        s.size += 26 * d;
      }
      for (let i = this.glyphs.length - 1; i >= 0; i--) {
        const g = this.glyphs[i];
        g.life -= d;
        if (g.life <= 0) {
          this.glyphs.splice(i, 1);
          continue;
        }
        g.x += g.vx * d;
        g.y += g.vy * d;
        g.rot += g.vr * d;
        if (g.kind === "drop" || g.kind === "split") g.vy -= 140 * d;
      }
    }
    // ---------------- 绘制 ----------------
    /** 在已做 y 翻转的游戏坐标系里绘制（调用方负责 setTransform）。 */
    draw(ctx, t) {
      for (const d of this.decals) {
        const k = Math.min(1, d.life / d.maxLife);
        const fade = Math.min(1, k * 1.6);
        ctx.fillStyle = hexA(d.color, 0.34 * fade);
        ctx.beginPath();
        ctx.ellipse(d.x, d.y, d.radius * (0.9 + 0.18 * (1 - k)), d.radius * 0.5, 0, 0, TAU2);
        ctx.fill();
        ctx.strokeStyle = hexA(d.color, 0.18 * fade);
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      for (const r of this.rings) {
        const k = 1 - r.life / r.maxLife;
        const rad = r.r0 + (r.r1 - r.r0) * easeOut(k);
        ctx.strokeStyle = hexA(r.color, 0.75 * (1 - k));
        ctx.lineWidth = Math.max(0.8, r.width * (1 - k * 0.7));
        ctx.beginPath();
        ctx.ellipse(r.x, r.y, rad, rad * 0.62, 0, 0, TAU2);
        ctx.stroke();
      }
      for (const g of this.glyphs) {
        if (g.kind === "crack" || g.kind === "spike" || g.kind === "shatter" || g.kind === "drop" || g.kind === "split") {
          drawGlyph(ctx, g, t);
        }
      }
      for (const p of this.particles) {
        const k = Math.max(0, p.life / p.maxLife);
        ctx.globalAlpha = Math.min(1, k * 1.5);
        drawChunk(ctx, p);
      }
      ctx.globalAlpha = 1;
      for (const s of this.smoke) {
        const k = Math.max(0, s.life / s.maxLife);
        ctx.fillStyle = hexA(s.color, 0.2 * k);
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.size, 0, TAU2);
        ctx.fill();
      }
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      for (const g of this.glyphs) {
        if (g.kind === "slash" || g.kind === "arc" || g.kind === "wisp") drawGlyph(ctx, g, t);
      }
      ctx.restore();
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      for (const p of this.particles) {
        if (p.chunk === "spark" || p.chunk === "ember") {
          const k = Math.max(0, p.life / p.maxLife);
          ctx.globalAlpha = Math.min(1, k * 1.6);
          drawChunk(ctx, p);
        }
      }
      ctx.restore();
      ctx.globalAlpha = 1;
    }
    /** 供 HUD 调试/性能观测：当前存活粒子数 */
    get particleCount() {
      return this.particles.length;
    }
  };
  function easeOut(k) {
    return 1 - Math.pow(1 - clamp01(k), 3);
  }
  function clamp01(k) {
    return k < 0 ? 0 : k > 1 ? 1 : k;
  }
  function hexA(hex, a) {
    const h = hex.replace("#", "");
    const v = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
    const n = parseInt(v, 16);
    const r = n >> 16 & 255;
    const g = n >> 8 & 255;
    const b = n & 255;
    return `rgba(${r},${g},${b},${a.toFixed(3)})`;
  }
  function drawChunk(ctx, p) {
    const s = p.size;
    switch (p.chunk) {
      case "goo": {
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, s, 0, TAU2);
        ctx.fill();
        ctx.fillStyle = "rgba(255,255,255,0.35)";
        ctx.beginPath();
        ctx.arc(p.x - s * 0.3, p.y + s * 0.3, s * 0.34, 0, TAU2);
        ctx.fill();
        break;
      }
      case "plate": {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.moveTo(-s, -s * 0.75);
        ctx.lineTo(s * 0.85, -s);
        ctx.lineTo(s, s * 0.8);
        ctx.lineTo(-s * 0.8, s);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = "rgba(11,12,29,0.45)";
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.restore();
        break;
      }
      case "shard": {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.moveTo(0, -s);
        ctx.lineTo(s * 0.85, s * 0.75);
        ctx.lineTo(-s * 0.85, s * 0.75);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
        break;
      }
      case "splinter": {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.fillRect(-s * 1.6, -s * 0.32, s * 3.2, s * 0.64);
        ctx.restore();
        break;
      }
      case "feather": {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.moveTo(-s * 1.7, 0);
        ctx.lineTo(0, -s * 0.55);
        ctx.lineTo(s * 1.3, 0);
        ctx.lineTo(0, s * 0.55);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
        break;
      }
      case "spark": {
        const len2 = 4 + s * 2.2;
        const n = Math.hypot(p.vx, p.vy) || 1;
        ctx.strokeStyle = p.color;
        ctx.lineWidth = Math.max(1, s * 0.5);
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - p.vx / n * len2, p.y - p.vy / n * len2);
        ctx.stroke();
        break;
      }
      case "ember": {
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, s * 0.7, 0, TAU2);
        ctx.fill();
        ctx.fillStyle = "rgba(255,230,160,0.55)";
        ctx.beginPath();
        ctx.arc(p.x, p.y, s * 0.32, 0, TAU2);
        ctx.fill();
        break;
      }
      case "bubble": {
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, s, 0, TAU2);
        ctx.fill();
        ctx.strokeStyle = "rgba(255,255,255,0.5)";
        ctx.lineWidth = 1;
        ctx.stroke();
        break;
      }
    }
  }
  function drawGlyph(ctx, g, t) {
    const k = Math.max(0, g.life / g.maxLife);
    const a = Math.min(1, k * 1.4);
    switch (g.kind) {
      case "slash": {
        const grow = 1 - k;
        const L = g.size * (0.55 + 0.45 * Math.min(1, grow * 3));
        ctx.save();
        ctx.translate(g.x, g.y);
        ctx.rotate(g.rot);
        ctx.strokeStyle = hexA(g.color, 0.85 * a);
        ctx.lineWidth = 2.4;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(-L, -L * 0.55);
        ctx.lineTo(L * 0.75, L * 0.5);
        ctx.moveTo(L * 0.6, -L * 0.6);
        ctx.lineTo(-L * 0.8, L * 0.45);
        ctx.stroke();
        ctx.restore();
        break;
      }
      case "arc": {
        ctx.strokeStyle = hexA(g.color, 0.9 * a * (0.55 + 0.45 * Math.sin(t * 40 + g.seed)));
        ctx.lineWidth = 2;
        ctx.beginPath();
        const segs = 4;
        let px = g.x;
        let py = g.y;
        ctx.moveTo(px, py);
        for (let i = 1; i <= segs; i++) {
          const kk = i / segs;
          const jitter = Math.sin(g.seed * 12.9898 + i * 4.1414) * g.size * 0.5;
          px = g.x + Math.cos(g.rot) * g.size * kk + Math.cos(g.rot + Math.PI / 2) * jitter;
          py = g.y + Math.sin(g.rot) * g.size * kk + Math.sin(g.rot + Math.PI / 2) * jitter;
          ctx.lineTo(px, py);
        }
        ctx.stroke();
        break;
      }
      case "wisp": {
        const rise = (1 - k) * g.size * 2.4;
        ctx.fillStyle = hexA(g.color, 0.9 * a);
        ctx.beginPath();
        ctx.arc(g.x, g.y + rise, g.size * 0.8, 0, TAU2);
        ctx.fill();
        ctx.fillStyle = hexA(g.color, 0.3 * a);
        ctx.beginPath();
        ctx.arc(g.x, g.y + rise - g.size * 0.9, g.size * 0.5, 0, TAU2);
        ctx.fill();
        break;
      }
      case "drop": {
        const settled = 1 - k > 0.55;
        ctx.save();
        ctx.translate(g.x, g.y);
        ctx.rotate(settled ? g.rot : g.rot + (1 - k) * 6);
        ctx.strokeStyle = hexA(g.color, a);
        ctx.lineWidth = 4;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(-g.size * 0.5, 0);
        ctx.lineTo(g.size * 1.1, 0);
        ctx.stroke();
        ctx.fillStyle = hexA(g.color, a);
        ctx.beginPath();
        ctx.arc(g.size * 1.1, 0, 3, 0, TAU2);
        ctx.fill();
        ctx.restore();
        break;
      }
      case "spike": {
        const up = Math.min(1, (1 - k) * 4);
        const h = g.size * 1.6 * up;
        ctx.save();
        ctx.translate(g.x, g.y);
        ctx.rotate(g.rot);
        ctx.fillStyle = hexA(g.color, 0.85 * a);
        ctx.beginPath();
        ctx.moveTo(0, h);
        ctx.lineTo(-g.size * 0.42, 0);
        ctx.lineTo(g.size * 0.42, 0);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
        break;
      }
      case "shatter": {
        const rad = g.size * (2.2 + (1 - k) * 3.2);
        ctx.strokeStyle = hexA(g.color, 0.8 * a);
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(g.x, g.y, rad, g.rot, g.rot + 0.5, false);
        ctx.stroke();
        break;
      }
      case "crack": {
        const L = g.size * Math.min(1, (1 - k) * 3);
        ctx.strokeStyle = hexA(g.color, 0.5 * a);
        ctx.lineWidth = 2;
        ctx.beginPath();
        let px = g.x;
        let py = g.y;
        ctx.moveTo(px, py);
        for (let i = 1; i <= 3; i++) {
          const ang = g.rot + Math.sin(g.seed + i * 2.1) * 0.5;
          px += Math.cos(ang) * (L / 3);
          py += Math.sin(ang) * (L / 3) * 0.6;
          ctx.lineTo(px, py);
        }
        ctx.stroke();
        break;
      }
      case "split": {
        ctx.save();
        ctx.translate(g.x, g.y);
        ctx.fillStyle = hexA(g.color, 0.9 * a);
        ctx.beginPath();
        ctx.arc(0, 0, g.size, 0, TAU2);
        ctx.fill();
        ctx.strokeStyle = hexA("#3A1024", 0.6 * a);
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(0, -g.size * 0.15, g.size * 0.85, Math.PI, 0);
        ctx.stroke();
        ctx.restore();
        break;
      }
    }
  }

  // src/adapter/web/render/fx.ts
  var clamp012 = (t) => t < 0 ? 0 : t > 1 ? 1 : t;
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
    const k = clamp012(easingOf(easingName)(clamp012(t)));
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
      return clamp012(t < 0.3 ? 1 : easingOf(this.cfg.hitFlash?.easing ?? "decay")((t - 0.3) / 0.7));
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

  // src/adapter/web/main.ts
  var W = 1080;
  var H = 1920;
  async function fetchJson(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`\u52A0\u8F7D\u5931\u8D25: ${url}`);
    return r.json();
  }
  function strokeBoltPath(ctx, pts, frac = 1) {
    let total = 0;
    for (let s = 0; s < pts.length - 1; s++) {
      total += Math.hypot(pts[s + 1][0] - pts[s][0], pts[s + 1][1] - pts[s][1]);
    }
    let budget = total * frac;
    let first = true;
    for (let s = 0; s < pts.length - 1; s++) {
      const [x1, y1] = pts[s];
      const [x2, y2] = pts[s + 1];
      const segLen = Math.hypot(x2 - x1, y2 - y1);
      let ex = x2;
      let ey = y2;
      let partial = false;
      if (budget < segLen) {
        const k = Math.max(0, budget) / Math.max(segLen, 1e-3);
        ex = x1 + (x2 - x1) * k;
        ey = y1 + (y2 - y1) * k;
        partial = true;
      }
      budget -= segLen;
      const mx = (x1 + ex) / 2 + (Math.random() - 0.5) * 20;
      const my = (y1 + ey) / 2 + (Math.random() - 0.5) * 20;
      if (first) {
        ctx.moveTo(x1, y1);
        first = false;
      }
      ctx.lineTo(mx, my);
      ctx.lineTo(ex, ey);
      if (partial) break;
    }
  }
  var CREEP_CELL_PX = 90;
  var creepCache = document.createElement("canvas");
  var creepCacheVersion = -1;
  var creepPulseNodes = [];
  var creepHash = (n) => {
    let x = (n ^ 2654435769) >>> 0;
    x = Math.imul(x ^ x >>> 16, 73244475) >>> 0;
    x = Math.imul(x ^ x >>> 16, 73244475) >>> 0;
    return ((x ^ x >>> 16) >>> 0) / 4294967296;
  };
  function rebuildCreepCache(session, w, h) {
    creepCache.width = w;
    creepCache.height = h;
    const cctx = creepCache.getContext("2d");
    const c = CREEP_CELL_PX;
    const keys = [...session.creep.keys()];
    const has = (cx, cy) => session.creep.has(cx * 4096 + cy);
    creepPulseNodes = [];
    cctx.fillStyle = "rgba(53,83,26,0.26)";
    for (const key of keys) {
      cctx.beginPath();
      cctx.arc(Math.floor(key / 4096) * c + 45, key % 4096 * c + 45, 56 + creepHash(key) * 5, 0, Math.PI * 2);
      cctx.fill();
    }
    cctx.fillStyle = "rgba(31,49,13,0.4)";
    for (const key of keys) {
      cctx.beginPath();
      cctx.arc(Math.floor(key / 4096) * c + 45, key % 4096 * c + 45, 48 + creepHash(key + 3) * 5, 0, Math.PI * 2);
      cctx.fill();
    }
    for (const key of keys) {
      const x = Math.floor(key / 4096) * c + 45;
      const y = key % 4096 * c + 45;
      const a1 = creepHash(key + 7) * Math.PI * 2;
      cctx.fillStyle = "rgba(74,107,31,0.48)";
      cctx.beginPath();
      cctx.arc(x + Math.cos(a1) * 10, y + Math.sin(a1) * 10, 34 + creepHash(key + 11) * 6, 0, Math.PI * 2);
      cctx.fill();
      const a2 = a1 + 2.4;
      cctx.fillStyle = "rgba(94,134,40,0.3)";
      cctx.beginPath();
      cctx.arc(x + Math.cos(a2) * 14, y + Math.sin(a2) * 14, 25 + creepHash(key + 19) * 6, 0, Math.PI * 2);
      cctx.fill();
    }
    const dirs = [[1, 0, 0], [0, 1, Math.PI / 2], [-1, 0, Math.PI], [0, -1, -Math.PI / 2]];
    const fullLayers = GameSession.CREEP_LAYERS;
    for (const key of keys) {
      const layersLeft = session.creepHp.get(key) ?? fullLayers;
      if (layersLeft >= fullLayers) continue;
      const x = Math.floor(key / 4096) * c + 45;
      const y = key % 4096 * c + 45;
      const missing = fullLayers - layersLeft;
      cctx.fillStyle = `rgba(22,24,14,${(0.22 + 0.3 * missing).toFixed(2)})`;
      cctx.beginPath();
      cctx.arc(x, y, 36 + creepHash(key + 29) * 6, 0, Math.PI * 2);
      cctx.fill();
    }
    for (const key of keys) {
      const cx = Math.floor(key / 4096);
      const cy = key % 4096;
      const x = cx * c + 45;
      const y = cy * c + 45;
      const layersLeft = session.creepHp.get(key) ?? fullLayers;
      if (layersLeft >= 2) {
        const a0 = creepHash(key + 13) * Math.PI * 2;
        cctx.strokeStyle = "rgba(20,32,8,0.4)";
        cctx.lineWidth = 3;
        cctx.beginPath();
        cctx.arc(x - Math.cos(a0) * 14, y - Math.sin(a0) * 14, 26 + creepHash(key + 17) * 14, a0 - 1.2, a0 + 1.2);
        cctx.stroke();
      }
      if (layersLeft >= fullLayers && creepHash(key + 23) < 0.22) {
        cctx.fillStyle = "rgba(156,204,101,0.4)";
        cctx.beginPath();
        cctx.arc(x, y, 3 + creepHash(key + 29) * 3, 0, Math.PI * 2);
        cctx.fill();
      }
      if (layersLeft >= 2 && creepHash(key + 31) < 0.3) creepPulseNodes.push({ x, y, s: creepHash(key + 37) });
      if (layersLeft < 2) continue;
      cctx.strokeStyle = "rgba(156,204,101,0.35)";
      cctx.lineWidth = 4;
      for (const [dx, dy, ang] of dirs) {
        if (!has(cx + dx, cy + dy)) {
          cctx.beginPath();
          cctx.arc(x, y, 52, ang - Math.PI * 0.3, ang + Math.PI * 0.3);
          cctx.stroke();
        }
      }
    }
  }
  function drawCreepField(ctx, session, t, w, h) {
    if (session.creep.size > 0) {
      if (creepCacheVersion !== session.creepVersion) {
        creepCacheVersion = session.creepVersion;
        rebuildCreepCache(session, w, h);
      }
      ctx.drawImage(creepCache, 0, 0);
      for (const n of creepPulseNodes) {
        const a = 0.05 + 0.05 * Math.sin(t * 2.2 + n.s * 6.283);
        ctx.fillStyle = `rgba(156,204,101,${a.toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(n.x, n.y, 24 + 8 * n.s, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    for (const g of session.creepGlow) {
      const age = session.timeSec - g.t;
      if (age < 0 || age > 0.9) continue;
      const k = age / 0.9;
      ctx.strokeStyle = `rgba(174,234,0,${(0.5 * (1 - k)).toFixed(3)})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(g.x, g.y, 12 + 74 * k, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  async function boot() {
    const params = new URLSearchParams(location.search);
    const levelFile = params.get("level") ?? "level_1_1.json";
    const [palette, weaponsFile, monstersFile, cardsFile, level, fxConfig] = await Promise.all([
      fetchJson("/configs/art-style/palette.json"),
      fetchJson("/configs/weapons.json"),
      fetchJson("/configs/monsters.json"),
      fetchJson("/configs/cards.json"),
      fetchJson(`/configs/levels/${levelFile}`),
      loadFxConfig()
    ]);
    const fx = new FxRuntime(fxConfig);
    const killFx = new KillFx();
    const canvas = document.getElementById("game");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    const hudWall = document.getElementById("wallbar");
    const hudWallText = document.getElementById("walltext");
    const hudXp = document.getElementById("xpbar");
    const hudText = document.getElementById("hudtext");
    const hudWeapons = document.getElementById("weaponrow");
    const banner = document.getElementById("banner");
    const cardOverlay = document.getElementById("cards");
    const gameOver = document.getElementById("gameover");
    const BUNDLE_VERSION = (() => {
      const src = document.currentScript?.src ?? "";
      const m = /[?&]v=(\d+)/.exec(src);
      if (m) return m[1];
      for (const e of performance.getEntriesByType("resource")) {
        const m2 = /bundle\.js\?v=(\d+)/.exec(e.name);
        if (m2) return m2[1];
      }
      return "dev";
    })();
    const traceQueue = [];
    let traceWarned = false;
    function flushTrace() {
      if (traceQueue.length === 0) return;
      const body = traceQueue.map((r) => JSON.stringify(r)).join("\n") + "\n";
      traceQueue.length = 0;
      void fetch("/api/trace", { method: "POST", headers: { "Content-Type": "application/x-ndjson" }, body }).catch(() => {
        if (!traceWarned) {
          traceWarned = true;
          console.warn("[\u8F68\u8FF9] POST /api/trace \u4E0D\u53EF\u7528\uFF08\u9759\u6001\u670D\u52A1\u5668\u7F3A\u5C11\u5F55\u5236\u7AEF\u70B9\uFF09\u2014\u2014\u672C\u5C40\u8F68\u8FF9\u4EC5\u7559\u5728\u5185\u5B58\uFF0C\u4E0D\u4F1A\u843D\u76D8");
        }
      });
    }
    const recorder = new TraceRecorder((r) => {
      traceQueue.push(r);
      if (traceQueue.length > 6e3) traceQueue.splice(0, traceQueue.length - 6e3);
    });
    setInterval(flushTrace, 1500);
    window.addEventListener("pagehide", () => {
      if (traceQueue.length === 0) return;
      const blob = new Blob([traceQueue.map((r) => JSON.stringify(r)).join("\n") + "\n"], { type: "application/x-ndjson" });
      navigator.sendBeacon("/api/trace", blob);
      traceQueue.length = 0;
    });
    const controller = new HumanInputController(W / 2, 300);
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
      controller.tx = p.x;
      controller.ty = p.y;
      controller.hasTarget = true;
    });
    canvas.addEventListener("pointermove", (e) => {
      if (controller.hasTarget) {
        const p = toGameCoords(e);
        controller.tx = p.x;
        controller.ty = p.y;
      }
    });
    const release = () => {
      controller.hasTarget = false;
    };
    canvas.addEventListener("pointerup", release);
    canvas.addEventListener("pointercancel", release);
    window.addEventListener("keydown", (e) => controller.keys.add(e.key.toLowerCase()));
    window.addEventListener("keyup", (e) => controller.keys.delete(e.key.toLowerCase()));
    window.addEventListener("blur", () => controller.keys.clear());
    const weaponCfg = weaponsFile.weapons.find((w) => w.id === params.get("weapon")) ?? weaponsFile.weapons[0];
    const seedParam = Number(params.get("seed"));
    const seed = Number.isInteger(seedParam) && seedParam > 0 ? seedParam : Date.now() % 1e5 | 0;
    const session = new GameSession({
      level,
      weaponConfigs: [weaponCfg],
      monsterConfigs: new Map(monstersFile.monsters.map((m) => [m.id, m])),
      cardConfigs: cardsFile.cards,
      weaponPool: weaponsFile.weapons,
      // 升级三选一可出"新武器"候选（docs/02 §1：1 把初始 + 卡牌获得）
      seed,
      controller,
      cardPolicy: greedyDpsPolicy
    });
    const ffSec = Math.min(1800, Math.max(0, Number(params.get("ff")) || 0));
    if (ffSec > 0 && !session.result) {
      session.externalLevelUps = false;
      const ffTicks = Math.round(ffSec * 30);
      for (let i = 0; i < ffTicks && !session.result; i++) {
        session.wallHp = session.wallMaxHp;
        session.step();
      }
    }
    session.externalLevelUps = true;
    recorder.start({ t0: Date.now(), seed, level: levelFile, weapon: weaponCfg.id, version: BUNDLE_VERSION, pool: true });
    let bannerTimer = 0;
    let prevRenderMs = 0;
    let weaponsShown = -1;
    session.bus.on("onWaveStart", ({ banner: b }) => {
      banner.textContent = b;
      banner.classList.add("show");
      bannerTimer = 2.2;
    });
    session.bus.on("onWallHit", () => canvas.classList.add("shake"));
    let creepFlash = 0;
    const emerges = [];
    session.bus.on("onCreepTier", ({ tier }) => {
      banner.textContent = `\u866B\u5DE2\u6269\u5F20 \xB7 \u5168\u65CF\u5F3A\u5316\uFF08T${tier}\uFF09`;
      banner.classList.add("show");
      bannerTimer = 2.4;
      creepFlash = 1;
    });
    session.bus.on("onMonsterEmerge", ({ x, y }) => {
      if (emerges.length >= 24) emerges.shift();
      emerges.push({ x, y, life: 0.55 });
    });
    const healMarks = [];
    const healSeen = /* @__PURE__ */ new WeakMap();
    const floats = [];
    const pushFloat = (x, y, text, color, size) => {
      if (floats.length >= 40) floats.shift();
      floats.push({ x, y, text, color, size, life: 0.8, maxLife: 0.8 });
    };
    session.bus.on(
      "onHit",
      ({ monsterId, dmg, isCrit, blocked, mitigated, x, y, damageType }) => {
        if (monsterId !== void 0 && !blocked) fx.markHit(monsterId, session.timeSec);
        const dtype = damageType ?? "physical";
        killFx.spawnHit(x, y, blocked ? "physical" : dtype, blocked ? 0.5 : isCrit ? 2.2 : 1);
        if (blocked) {
          pushFloat(x, y - 12, "\u6321", "#8A93B8", 16);
          return;
        }
        if (mitigated && mitigated > 0) {
          pushFloat(x + 20, y + 34, `\u62B5${mitigated}`, "#8A93B8", 13);
        }
        pushFloat(
          x + (Math.random() - 0.5) * 24,
          y + 20,
          String(Math.round(dmg)),
          isCrit ? "#FFD54F" : "#F5F5FA",
          isCrit ? 30 : 19
        );
      }
    );
    session.bus.on("onKill", ({ key, shape, x, y, radius, damageType }) => {
      killFx.spawnKill({
        x,
        y,
        radius,
        key,
        shape,
        damageType: damageType ?? null
      });
    });
    session.bus.on("onExplode", ({ x, y, radius }) => {
      killFx.spawnExplode(x, y, radius, "fire");
    });
    session.bus.on("onWallHit", ({ dmg, x, y }) => {
      pushFloat(x, y, `-${Math.round(dmg)}`, "#FF6B57", 17);
    });
    session.bus.on("onBurnTick", ({ dmg, x, y }) => {
      pushFloat(x, y, String(Math.round(dmg * 10) / 10), "#FF9A3C", 14);
    });
    session.bus.on("onPoolTick", ({ dmg, x, y }) => {
      pushFloat(x, y, String(dmg), "#FF6B57", 16);
    });
    const heals = [];
    session.bus.on("onHeal", (p) => {
      if (heals.length > 10) heals.shift();
      heals.push({ x: p.x, y: p.y, radius: p.radius, life: 0.5 });
    });
    session.bus.on("onHealed", (p) => {
      pushFloat(p.x, p.y, `+${p.amount}`, "#7CB342", 15);
    });
    const transfers = [];
    session.bus.on(
      "onDamageTransfer",
      (p) => {
        if (transfers.length > 14) transfers.shift();
        transfers.push({ fx: p.fx, fy: p.fy, tx: p.tx, ty: p.ty, life: 0.3 });
        pushFloat(p.tx, p.ty + 24, `\u8F6C${Math.round(p.dmg)}`, "#B388FF", 15);
      }
    );
    const MOUNT_SPOTS = [
      [],
      [[0, 20]],
      [[-16, 2], [16, 2]],
      [[-16, 2], [16, 2], [0, 28]],
      [[-16, 2], [16, 2], [0, 28], [0, -26]]
    ];
    const MUZZLE_LEN = 14;
    const weaponFlash = [];
    const WEAPON_FLASH = 0.13;
    session.bus.on("onShoot", ({ weaponId }) => {
      const idx = session.hero.weapons.findIndex((w) => w.cfg.id === weaponId);
      if (idx >= 0) weaponFlash[idx] = WEAPON_FLASH;
    });
    let aimCur = Math.PI / 2;
    const bolts = [];
    session.bus.on("onChain", ({ points }) => {
      const pts = points.map((p) => [p[0], p[1]]);
      const li = session.hero.weapons.findIndex((w) => w.cfg.id === "lightning_chain");
      const mounts = MOUNT_SPOTS[Math.min(session.hero.weapons.length, 4)];
      if (li >= 0 && li < mounts.length) {
        const [mx, my] = mounts[li];
        pts[0] = [session.hero.x + mx + MUZZLE_LEN * Math.cos(aimCur), session.hero.y + my + MUZZLE_LEN * Math.sin(aimCur)];
      }
      if (bolts.length > 12) bolts.shift();
      bolts.push({ pts, life: 0.26, age: 0 });
    });
    session.bus.on("onGameOver", ({ result }) => {
      recorder.end(session.tick, {
        result,
        kills: session.totalKills,
        wallHp: session.wallHp,
        wallMax: session.wallMaxHp,
        lv: session.hero.level,
        sec: +session.timeSec.toFixed(3)
      });
      flushTrace();
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
          const typeTag = { bullet: "\u5B50\u5F39", wall: "\u57CE\u5899", form: "\u5F62\u6001", passive: "\u5C5E\u6027", element: "\u5143\u7D20", weapon: "\u65B0\u6B66\u5668" }[c.type];
          const weaponNames = new Map(weaponsFile.weapons.map((w) => [w.id, w.name]));
          const elementNames = {
            fire: "\u706B\u7130",
            frost: "\u5BD2\u51B0",
            lightning: "\u95EA\u7535",
            poison: "\u6BD2\u7D20",
            physical: "\u7269\u7406"
          };
          const targetTag = c.type === "weapon" ? "\u52A0\u5165\u6218\u6597" : !c.target || c.target.kind === "any" ? "\u516C\u5171" : c.target.kind === "weapon" ? weaponNames.get(c.target.weaponType) ?? c.target.weaponType : `${elementNames[c.target.element] ?? c.target.element}\xB7\u5143\u7D20`;
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
      recorder.pick(session.tick, c.id, session.pendingLevelChoices.map((x) => x.id));
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
      const dtR = Math.min(0.05, (timeMs - prevRenderMs) / 1e3 || 0.016);
      prevRenderMs = timeMs;
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
      drawCreepField(ctx, session, t, W, H);
      for (const m of session.monsters) {
        const r = m.cfg.radius;
        if (m.cfg.creepBenefit && !m.burrowed && session.isCreeped(m.x, m.y)) {
          const pulse = m.hp < m.maxHp ? 0.18 + 0.1 * Math.sin(t * 4 + m.phase) : 0.16;
          ctx.fillStyle = `rgba(156,204,101,${pulse.toFixed(3)})`;
          ctx.beginPath();
          ctx.ellipse(m.x, m.y + r * 0.55, r * 1.35, r * 0.6, 0, 0, Math.PI * 2);
          ctx.fill();
          const seen = healSeen.get(m) ?? { hp: m.hp, next: t + 0.8 };
          if (m.hp > seen.hp && t >= seen.next && healMarks.length < 20) {
            seen.next = t + 0.8;
            healMarks.push({ x: m.x + m.phase % 1 * 8 - 4, y: m.y + r * 0.3, life: 0.7 });
          }
          seen.hp = m.hp;
          healSeen.set(m, seen);
        }
        drawMonster(ctx, m, t, fx.flashAlpha(m.id, now), fx.hitSquash(m.id, now));
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
      killFx.update(dtR);
      killFx.draw(ctx, t);
      for (const pool of session.pools) {
        drawPool(ctx, pool, session.timeSec);
      }
      const h = session.hero;
      const breathe = Math.sin(t * 2.2) * 3;
      let aimTarget = Math.PI / 2;
      let bestD = Infinity;
      for (const m of session.monsters) {
        if (m.hp <= 0) continue;
        const ddx = m.x - h.x;
        const ddy = m.y - h.y;
        const d2 = ddx * ddx + ddy * ddy;
        if (d2 < bestD) {
          bestD = d2;
          aimTarget = Math.atan2(ddy, ddx);
        }
      }
      const da = Math.atan2(Math.sin(aimTarget - aimCur), Math.cos(aimTarget - aimCur));
      aimCur += da * Math.min(1, dtR * 10);
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
      const beamOn = new Set(session.segments.map((sg) => sg.srcWeaponId));
      const mounts = MOUNT_SPOTS[Math.min(h.weapons.length, 4)];
      for (let i = 0; i < h.weapons.length && i < mounts.length; i++) {
        const w = h.weapons[i];
        const [mx, my] = mounts[i];
        const k = Math.max(0, weaponFlash[i] ?? 0) / WEAPON_FLASH;
        if (weaponFlash[i]) weaponFlash[i] = Math.max(0, (weaponFlash[i] ?? 0) - dtR);
        const color = palette.damageType[w.element] ?? "#BFFFF2";
        const isBeam = !!w.cfg.beamBase;
        const beamLive = isBeam && beamOn.has(w.cfg.id);
        const overheated = isBeam && w.cooldown > w.cfg.interval * 1.5;
        drawWeaponMount(ctx, w, mx, my, aimCur, t, color, k, beamLive, overheated);
      }
      ctx.restore();
      const projColor = (t2) => palette.damageType[t2] ?? "#BFFFF2";
      for (const seg of session.segments) {
        if (!seg.srcWeaponId) continue;
        const color = projColor(seg.damageType);
        let sx = seg.ax;
        let sy = seg.ay;
        const li = h.weapons.findIndex((w) => w.cfg.id === seg.srcWeaponId);
        const bMounts = MOUNT_SPOTS[Math.min(h.weapons.length, 4)];
        if (seg.followOwner && li >= 0 && li < bMounts.length) {
          const [bmx, bmy] = bMounts[li];
          const ang = seg.angle ?? Math.PI / 2;
          sx = h.x + bmx + MUZZLE_LEN * Math.cos(ang);
          sy = h.y + breathe + bmy + MUZZLE_LEN * Math.sin(ang);
        }
        const flick = 1 + 0.12 * Math.sin(t * 47 + (seg.angle ?? 0) * 13);
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        ctx.lineCap = "round";
        ctx.strokeStyle = color;
        ctx.globalAlpha = 0.1 * flick;
        ctx.lineWidth = seg.width * 3.4;
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(seg.bx, seg.by);
        ctx.stroke();
        ctx.globalAlpha = 0.3 * flick;
        ctx.lineWidth = seg.width * 1.7;
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(seg.bx, seg.by);
        ctx.stroke();
        ctx.globalAlpha = 0.9;
        ctx.strokeStyle = "#F5F5FA";
        ctx.lineWidth = Math.max(1.5, seg.width * 0.5);
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(seg.bx, seg.by);
        ctx.stroke();
        ctx.globalAlpha = 0.8;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(sx, sy, seg.width * 0.75 * flick, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 0.95;
        ctx.fillStyle = "#FFFFFF";
        ctx.beginPath();
        ctx.arc(sx, sy, 2.2, 0, Math.PI * 2);
        ctx.fill();
        const ex = seg.bx;
        const ey = seg.by;
        ctx.globalAlpha = 0.5 * flick;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(ex, ey, seg.width * 1.1 * flick, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = "#FFFFFF";
        ctx.beginPath();
        ctx.arc(ex, ey, Math.max(2, seg.width * 0.34), 0, Math.PI * 2);
        ctx.fill();
        for (let i = 0; i < 3; i++) {
          const a = t * 9 + i * 2.1;
          const rr2 = seg.width * (1.2 + 0.6 * ((t * 1.6 + i * 0.37) % 1));
          ctx.globalAlpha = 0.5 * (1 - (t * 1.6 + i * 0.37) % 1);
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(ex + Math.cos(a) * rr2, ey + Math.sin(a) * rr2, 1.8, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }
      for (const p of session.projectiles) {
        drawProjectile(ctx, p, t, projColor(p.damageType));
      }
      for (const s of session.monsterShots) {
        drawMonsterShot(ctx, s);
      }
      for (let i = heals.length - 1; i >= 0; i--) {
        const h2 = heals[i];
        h2.life -= dtR;
        if (h2.life <= 0) {
          heals.splice(i, 1);
          continue;
        }
        drawHealPulse(ctx, h2.x, h2.y, h2.radius, 1 - h2.life / 0.5);
      }
      for (let i = transfers.length - 1; i >= 0; i--) {
        const tr = transfers[i];
        tr.life -= dtR;
        if (tr.life <= 0) {
          transfers.splice(i, 1);
          continue;
        }
        drawTransfer(ctx, tr.fx, tr.fy, tr.tx, tr.ty, Math.min(1, tr.life / 0.18));
      }
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
        b.age += dtR;
        if (b.life <= 0) {
          bolts.splice(i, 1);
          continue;
        }
        const alpha = Math.min(1, b.life / 0.14);
        const frac = Math.min(1, b.age / 0.07);
        if (b.age < 0.12) {
          const kk = 1 - b.age / 0.12;
          ctx.globalAlpha = 0.75 * kk;
          ctx.fillStyle = "#B388FF";
          ctx.beginPath();
          ctx.arc(b.pts[0][0], b.pts[0][1], 5 + 9 * (1 - kk), 0, Math.PI * 2);
          ctx.fill();
          ctx.globalAlpha = 1;
        }
        ctx.strokeStyle = `rgba(179,136,255,${alpha})`;
        ctx.lineWidth = 5;
        ctx.beginPath();
        strokeBoltPath(ctx, b.pts, frac);
        ctx.stroke();
        ctx.strokeStyle = `rgba(245,245,250,${alpha})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        strokeBoltPath(ctx, b.pts, frac);
        ctx.stroke();
      }
      for (let i = healMarks.length - 1; i >= 0; i--) {
        const hm = healMarks[i];
        hm.life -= dtR;
        if (hm.life <= 0) {
          healMarks.splice(i, 1);
          continue;
        }
        const k = 1 - hm.life / 0.7;
        const yy = hm.y + 14 + 18 * k;
        ctx.strokeStyle = `rgba(140,230,120,${(0.85 * (1 - k)).toFixed(3)})`;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(hm.x - 4, yy);
        ctx.lineTo(hm.x + 4, yy);
        ctx.moveTo(hm.x, yy - 4);
        ctx.lineTo(hm.x, yy + 4);
        ctx.stroke();
      }
      if (creepFlash > 0) {
        creepFlash = Math.max(0, creepFlash - dtR * 1.1);
        ctx.fillStyle = `rgba(124,179,66,${(0.16 * creepFlash).toFixed(3)})`;
        ctx.fillRect(0, 0, W, H);
      }
      for (let i = emerges.length - 1; i >= 0; i--) {
        const e = emerges[i];
        e.life -= dtR;
        if (e.life <= 0) {
          emerges.splice(i, 1);
          continue;
        }
        const k = 1 - e.life / 0.55;
        ctx.strokeStyle = `rgba(174,234,0,${(0.55 * (1 - k)).toFixed(3)})`;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.ellipse(e.x, e.y, 12 + 52 * k, (12 + 52 * k) * 0.5, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = `rgba(101,67,33,${(0.6 * (1 - k)).toFixed(3)})`;
        for (let s = 0; s < 5; s++) {
          const a = s * 1.256 + k * 1.8;
          ctx.beginPath();
          ctx.arc(e.x + Math.cos(a) * (16 + 44 * k), e.y + Math.sin(a) * (8 + 24 * k), 2 + 3 * (1 - k), 0, Math.PI * 2);
          ctx.fill();
        }
      }
      hudWall.style.width = `${session.wallHp / session.wallMaxHp * 100}%`;
      hudWallText.textContent = `\u57CE\u9632 ${Math.ceil(session.wallHp)} / ${session.wallMaxHp}`;
      const need = xpNeed(h.level);
      hudXp.style.width = `${Math.min(100, h.xp / need * 100)}%`;
      hudText.textContent = `\u7B2C ${Math.min(session.waveStats.length + 1, level.waves.length)}/${level.waves.length} \u6CE2 \xB7 Lv.${h.level} \xB7 \u51FB\u6740 ${session.totalKills} \xB7 ${session.timeSec.toFixed(0)}s` + (session.creepTier > 1 ? ` \xB7 \u866B\u5DE2T${session.creepTier}` : "");
      if (session.hero.weapons.length !== weaponsShown) {
        weaponsShown = session.hero.weapons.length;
        hudWeapons.innerHTML = session.hero.weapons.map((w) => `<span class="wchip">${w.cfg.name}</span>`).join("");
      }
      if (bannerTimer > 0) {
        bannerTimer -= 1 / 60;
        if (bannerTimer <= 0) banner.classList.remove("show");
      }
      if (canvas.classList.contains("shake")) {
        setTimeout(() => canvas.classList.remove("shake"), 120);
      }
    }
    let gameSpeed = 1;
    const speedBtn = document.getElementById("speedbtn");
    const SPEED_STEPS = [1, 1.5, 2];
    speedBtn.onclick = () => {
      const next = (SPEED_STEPS.indexOf(gameSpeed) + 1) % SPEED_STEPS.length;
      gameSpeed = SPEED_STEPS[next];
      speedBtn.textContent = `${gameSpeed}x`;
      speedBtn.classList.toggle("fast", gameSpeed !== 1);
    };
    let last = performance.now();
    let acc = 0;
    function frame(now) {
      acc += Math.min((now - last) / 1e3, 0.25) * gameSpeed;
      last = now;
      const paused = session.pendingLevelChoices.length > 0 || session.result !== null;
      while (acc >= TICK_DT && !paused) {
        recorder.observe(controller.snapshot(), session.tick);
        session.step();
        if (session.tick % 30 === 0) {
          recorder.check(session.tick, {
            x: session.hero.x,
            y: session.hero.y,
            wallHp: session.wallHp,
            kills: session.totalKills,
            lv: session.hero.level
          });
        }
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
