/**
 * Web 适配层（docs/05 §1.5 适配模式的第二个实现，第一个是 sim）：
 * Canvas 渲染 + 指针/键盘输入，消费 gamecore 的公共接口，
 * 证明核心逻辑零引擎依赖——Cocos 适配层将按同样方式接入。
 */
import {
  GameSession,
  LevelConfig,
  MonsterConfig,
  WeaponConfig,
  CardConfig,
  TICK_DT,
  xpNeed,
} from '../../gamecore';
import { greedyDpsPolicy } from '../../../tools/sim/policies';
import { HumanInputController, TraceRecorder, TraceRecord } from '../../../tools/sim/human';
import { drawMonster, drawProjectile, drawMonsterShot, drawHealPulse, drawTransfer, drawPool } from './render/shapes';

const W = 1080;
const H = 1920;

interface Palette {
  background: { nightDeep: string; gridLine: string };
  enemy: { primary: string };
  friendly: { hero: string; wall: string; wallDamaged: string };
  damageType: { physical: string; fire: string; frost: string; lightning: string; poison: string };
  ui: { warn: string };
}

async function fetchJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`加载失败: ${url}`);
  return r.json() as Promise<T>;
}

/** 电弧折线路径：每段中点加随机抖动（渲染层表现，不影响逻辑确定性）。 */
function strokeBoltPath(ctx: CanvasRenderingContext2D, pts: number[][]): void {
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

async function boot(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const levelFile = params.get('level') ?? 'level_1_1.json';
  const [palette, weaponsFile, monstersFile, cardsFile, level] = await Promise.all([
    fetchJson<Palette>('/configs/art-style/palette.json'),
    fetchJson<{ weapons: WeaponConfig[] }>('/configs/weapons.json'),
    fetchJson<{ monsters: MonsterConfig[] }>('/configs/monsters.json'),
    fetchJson<{ cards: CardConfig[] }>('/configs/cards.json'),
    fetchJson<LevelConfig>(`/configs/levels/${levelFile}`),  ]);

  const canvas = document.getElementById('game') as HTMLCanvasElement;
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;

  const hudWall = document.getElementById('wallbar')!;
  const hudWallText = document.getElementById('walltext')!;
  const hudXp = document.getElementById('xpbar')!;
  const hudText = document.getElementById('hudtext')!;
  const banner = document.getElementById('banner')!;
  const cardOverlay = document.getElementById('cards')!;
  const gameOver = document.getElementById('gameover')!;

  // ---------- 人工轨迹录制：POST /api/trace（npm run play 的静态服务器自带录制端点）----------
  // 只录"输入流"（变化点）+ 存档点/选卡/结算：gamecore 完全确定性 ⇒ sim 可逐位回放重建全程状态。
  const BUNDLE_VERSION = (() => {
    const src = (document.currentScript as HTMLScriptElement | null)?.src ?? '';
    const m = /[?&]v=(\d+)/.exec(src);
    if (m) return m[1];
    for (const e of performance.getEntriesByType('resource')) {
      const m2 = /bundle\.js\?v=(\d+)/.exec((e as PerformanceResourceTiming).name);
      if (m2) return m2[1];
    }
    return 'dev';
  })();
  const traceQueue: TraceRecord[] = [];
  let traceWarned = false;
  function flushTrace(): void {
    if (traceQueue.length === 0) return;
    const body = traceQueue.map((r) => JSON.stringify(r)).join('\n') + '\n';
    traceQueue.length = 0;
    void fetch('/api/trace', { method: 'POST', headers: { 'Content-Type': 'application/x-ndjson' }, body }).catch(() => {
      if (!traceWarned) {
        traceWarned = true;
        console.warn('[轨迹] POST /api/trace 不可用（静态服务器缺少录制端点）——本局轨迹仅留在内存，不会落盘');
      }
    });
  }
  const recorder = new TraceRecorder((r) => {
    traceQueue.push(r);
    if (traceQueue.length > 6000) traceQueue.splice(0, traceQueue.length - 6000); // 端点缺失时防内存膨胀
  });
  setInterval(flushTrace, 1500);
  window.addEventListener('pagehide', () => {
    if (traceQueue.length === 0) return;
    const blob = new Blob([traceQueue.map((r) => JSON.stringify(r)).join('\n') + '\n'], { type: 'application/x-ndjson' });
    navigator.sendBeacon('/api/trace', blob);
    traceQueue.length = 0;
  });

  // ---------- 输入：点按移动（触屏/鼠标）+ WASD/方向键 ----------
  // 控制器本体在 tools/sim/human.ts（与 sim 回放共用同一逻辑，保证录制/回放逐帧同源）
  const controller = new HumanInputController(W / 2, 300);

  function toGameCoords(e: PointerEvent): { x: number; y: number } {
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * W,
      y: ((e.clientY - rect.top) / rect.height) * H,
    };
  }
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    const p = toGameCoords(e);
    controller.tx = p.x;
    controller.ty = p.y;
    controller.hasTarget = true;
  });
  canvas.addEventListener('pointermove', (e) => {
    if (controller.hasTarget) { // 按住拖动跟随
      const p = toGameCoords(e);
      controller.tx = p.x;
      controller.ty = p.y;
    }
  });
  const release = (): void => { controller.hasTarget = false; }; // 松开即停
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  window.addEventListener('keydown', (e) => controller.keys.add(e.key.toLowerCase()));
  window.addEventListener('keyup', (e) => controller.keys.delete(e.key.toLowerCase()));
  window.addEventListener('blur', () => controller.keys.clear()); // 失焦清空按键，防按键卡住

  // ---------- 会话 ----------
  const weaponCfg = weaponsFile.weapons.find((w) => w.id === params.get('weapon')) ?? weaponsFile.weapons[0];
  // ?seed=123 可复现指定种子（默认随机）；配合轨迹回放做 A/B 对照
  const seedParam = Number(params.get('seed'));
  const seed = Number.isInteger(seedParam) && seedParam > 0 ? seedParam : (Date.now() % 100000) | 0;
  const session = new GameSession({
    level,
    weaponConfigs: [weaponCfg],
    monsterConfigs: new Map(monstersFile.monsters.map((m) => [m.id, m])),
    cardConfigs: cardsFile.cards,
    seed,
    controller,
    cardPolicy: greedyDpsPolicy,
  });
  session.externalLevelUps = true;
  recorder.start({ t0: Date.now(), seed, level: levelFile, weapon: weaponCfg.id, version: BUNDLE_VERSION });

  let bannerTimer = 0;
  let prevRenderMs = 0;
  session.bus.on<{ index: number; banner: string }>('onWaveStart', ({ banner: b }) => {
    banner.textContent = b;
    banner.classList.add('show');
    bannerTimer = 2.2;
  });
  session.bus.on('onWallHit', () => canvas.classList.add('shake'));

  // 伤害飘字（渲染层对象池语义：上限 40，见 docs/01 §4）
  interface FloatText { x: number; y: number; text: string; color: string; size: number; life: number; maxLife: number }
  const floats: FloatText[] = [];
  const pushFloat = (x: number, y: number, text: string, color: string, size: number): void => {
    if (floats.length >= 40) floats.shift();
    floats.push({ x, y, text, color, size, life: 0.8, maxLife: 0.8 });
  };
  session.bus.on<{ dmg: number; isCrit: boolean; blocked?: boolean; mitigated?: number; x: number; y: number }>(
    'onHit',
    ({ dmg, isCrit, blocked, mitigated, x, y }) => {
      if (blocked) {
        pushFloat(x, y - 12, '挡', '#8A93B8', 16); // 免伤盾抵消
        return;
      }
      if (mitigated && mitigated > 0) {
        pushFloat(x + 20, y + 34, `抵${mitigated}`, '#8A93B8', 13); // 护甲减伤量
      }
      pushFloat(
        x + (Math.random() - 0.5) * 24,
        y + 20,
        String(Math.round(dmg)),
        isCrit ? '#FFD54F' : '#F5F5FA',
        isCrit ? 30 : 19,
      );
    },
  );
  session.bus.on<{ dmg: number; x: number; y: number }>('onWallHit', ({ dmg, x, y }) => {
    pushFloat(x, y, `-${Math.round(dmg)}`, '#FF6B57', 17);
  });
  // 灼烧跳伤：小橙色飘字（让点燃的定时伤害"看得见"）
  session.bus.on<{ dmg: number; x: number; y: number }>('onBurnTick', ({ dmg, x, y }) => {
    pushFloat(x, y, String(Math.round(dmg * 10) / 10), '#FF9A3C', 14);
  });
  // 弹坑池跳字（纯范围武器的主要伤害来源）
  session.bus.on<{ dmg: number; x: number; y: number }>('onPoolTick', ({ dmg, x, y }) => {
    pushFloat(x, y, String(dmg), '#FF6B57', 16);
  });
  // 治疗光环：绿色扩散环 + 每个回血单位的 "+N" 绿字
  const heals: { x: number; y: number; radius: number; life: number }[] = [];
  session.bus.on<{ x: number; y: number; radius: number }>('onHeal', (p) => {
    if (heals.length > 10) heals.shift();
    heals.push({ x: p.x, y: p.y, radius: p.radius, life: 0.5 });
  });
  session.bus.on<{ x: number; y: number; amount: number }>('onHealed', (p) => {
    pushFloat(p.x, p.y, `+${p.amount}`, '#7CB342', 15);
  });
  // 伤害转嫁：紫色连线 + "转X"飘字
  const transfers: { fx: number; fy: number; tx: number; ty: number; life: number }[] = [];
  session.bus.on<{ fx: number; fy: number; tx: number; ty: number; dmg: number }>(
    'onDamageTransfer',
    (p) => {
      if (transfers.length > 14) transfers.shift();
      transfers.push({ fx: p.fx, fy: p.fy, tx: p.tx, ty: p.ty, life: 0.3 });
      pushFloat(p.tx, p.ty + 24, `转${Math.round(p.dmg)}`, '#B388FF', 15);
    },
  );
  // 连锁闪电折线（渲染层表现，0.22s 闪现）
  const bolts: { pts: number[][]; life: number }[] = [];
  session.bus.on<{ points: number[][] }>('onChain', ({ points }) => {
    if (bolts.length > 12) bolts.shift();
    bolts.push({ pts: points, life: 0.22 });
  });
  session.bus.on<{ result: string }>('onGameOver', ({ result }) => {
    recorder.end(session.tick, {
      result,
      kills: session.totalKills,
      wallHp: session.wallHp,
      wallMax: session.wallMaxHp,
      lv: session.hero.level,
      sec: +session.timeSec.toFixed(3),
    });
    flushTrace();
    const stars = result === 'victory'
      ? '★'.repeat(session.wallHp / session.wallMaxHp > 0.7 ? 3 : session.wallHp / session.wallMaxHp > 0.4 ? 2 : 1)
      : '☆';
    gameOver.innerHTML =
      `<div class="big">${result === 'victory' ? '守 城 成 功' : '城 墙 陷 落'}</div>` +
      `<div class="stars">${stars}</div>` +
      `<div class="sub">击杀 ${session.totalKills} · 等级 ${session.hero.level} · 用时 ${session.timeSec.toFixed(0)}s</div>` +
      `<div><button onclick="location.reload()">再来一局</button>` +
      `<button class="ghost" onclick="location.href='./index.html'">返回主菜单</button></div>`;
    gameOver.classList.add('show');
  });

  // ---------- 卡牌 UI ----------
  let cardsShown = false;
  function refreshCards(): void {
    const pending = session.pendingLevelChoices;
    if (pending.length > 0 && !cardsShown) {
      cardsShown = true;
      cardOverlay.innerHTML = '<div class="title">升 级 · 三 选 一</div><div class="row"></div>';
      const row = cardOverlay.querySelector('.row')!;
      pending.forEach((c, i) => {
        const el = document.createElement('div');
        el.className = `card ${c.rarity} t-${c.type}`;
  const typeTag = { bullet: '子弹', wall: '城墙', form: '形态', passive: '属性', element: '元素' }[c.type];
        const weaponNames = new Map(weaponsFile.weapons.map((w) => [w.id, w.name]));
        const elementNames: Record<string, string> = {
          fire: '火焰', frost: '寒冰', lightning: '闪电', poison: '毒素', physical: '物理',
        };
        const targetTag = !c.target || c.target.kind === 'any'
          ? '公共'
          : c.target.kind === 'weapon'
            ? (weaponNames.get(c.target.weaponType) ?? c.target.weaponType)
            : `${elementNames[c.target.element] ?? c.target.element}·元素`;
        el.innerHTML =
          `<div class="key">${i + 1}</div><div class="tag">${typeTag}｜${targetTag}</div>` +
          `<div class="cname">${c.name}</div><div class="ceff">${c.desc ?? ''}</div>`;
        el.onclick = () => pick(c);
        row.appendChild(el);
      });
      cardOverlay.classList.add('show');
      (cardOverlay as unknown as { _choices: CardConfig[] })._choices = pending;
    } else if (pending.length === 0 && cardsShown) {
      cardsShown = false;
      cardOverlay.classList.remove('show');
    }
  }
  function pick(c: CardConfig): void {
    recorder.pick(session.tick, c.id, session.pendingLevelChoices.map((x) => x.id));
    session.resolveLevelUp(c);
    refreshCards();
  }
  window.addEventListener('keydown', (e) => {
    const n = Number(e.key);
    if (n >= 1 && n <= 3) {
      const choices = (cardOverlay as unknown as { _choices?: CardConfig[] })._choices;
      if (choices?.[n - 1]) pick(choices[n - 1]);
    }
  });

  // ---------- 渲染 ----------
  function drawRoundRect(x: number, y: number, w: number, h: number, r: number): void {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function render(timeMs: number): void {
    // 游戏坐标 y 向上（城墙在 y=0 底部），画布 y 向下 → 翻转 y 轴渲染，
    // 保证视觉上城墙在底部、怪物自上而下进攻、点击方向与移动一致。
    ctx.setTransform(1, 0, 0, -1, 0, H);

    // 帧间隔（飘字/闪电/治疗环的寿命衰减共用）
    const dtR = Math.min(0.05, (timeMs - prevRenderMs) / 1000 || 0.016);
    prevRenderMs = timeMs;

    // 背景
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

    // 城墙（分段城垛）
    const segs = 12;
    const segW = W / segs;
    const wallRatio = session.wallHp / session.wallMaxHp;
    for (let i = 0; i < segs; i++) {
      ctx.fillStyle = wallRatio < 0.3 ? palette.friendly.wallDamaged : palette.friendly.wall;
      drawRoundRect(i * segW + 3, 6, segW - 6, wallTop - 12, 8);
      ctx.fill();
    }
    if (wallRatio < 0.3) {
      ctx.fillStyle = 'rgba(255,61,113,0.12)';
      ctx.fillRect(0, 0, W, wallTop);
    }

    // 怪物（形状语言区分种类，docs/06；血条/状态指示由下方叠加）
    const t = timeMs / 1000;
    const now = session.timeSec;
    for (const m of session.monsters) {
      const r = m.cfg.radius;
      drawMonster(ctx, m, t);
      // 血条
      if (m.hp < m.maxHp) {
        ctx.fillStyle = 'rgba(255,255,255,0.25)';
        ctx.fillRect(m.x - r, m.y - r - 10, r * 2, 4);
        ctx.fillStyle = '#FF3D71';
        ctx.fillRect(m.x - r, m.y - r - 10, (r * 2 * m.hp) / m.maxHp, 4);
      }
      // 状态指示：冰冻（蓝环）/ 灼烧（附着火焰，定时跳伤害直至熄灭）
      if (now < m.slowUntil) {
        ctx.strokeStyle = 'rgba(79,195,247,0.9)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(m.x, m.y, r + 4, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (m.burn && m.burn.until > now) {
        const fl = 9 + Math.sin(t * 14 + m.phase) * 3;
        ctx.fillStyle = '#FF5A3C';
        ctx.beginPath();
        ctx.moveTo(m.x, m.y + r + 4 + fl);
        ctx.quadraticCurveTo(m.x - 8, m.y + r + 5, m.x, m.y + r);
        ctx.quadraticCurveTo(m.x + 8, m.y + r + 5, m.x, m.y + r + 4 + fl);
        ctx.fill();
        ctx.fillStyle = '#FFD54F';
        ctx.beginPath();
        ctx.arc(m.x, m.y + r + 5, 2.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // 落地范围伤害圈（弹坑强化绘制）
    for (const pool of session.pools) {
      drawPool(ctx, pool, session.timeSec);
    }

    // 虫苔地块（docs/08：酸性绿半透明网格）
    ctx.fillStyle = 'rgba(124,179,66,0.13)';
    const CELL = 90;
    for (const key of session.creep.keys()) {
      const cx = Math.floor(key / 4096);
      const cy = key % 4096;
      ctx.fillRect(cx * CELL + 1, cy * CELL + 1, CELL - 2, CELL - 2);
    }

    // 英雄（正三角机身 + 圆形核心，呼吸浮动）
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
    ctx.fillStyle = '#0B0C1D';
    ctx.fill();
    ctx.restore();

    // 投射物（按武器塑形 + 伤害类型着色）
    const projColor = (t: string): string =>
      (palette.damageType as Record<string, string>)[t] ?? '#BFFFF2';
    for (const p of session.projectiles) {
      drawProjectile(ctx, p, t, projColor(p.damageType));
    }

    // 怪物远程弹（投矛/投石，警示橙）
    for (const s of session.monsterShots) {
      drawMonsterShot(ctx, s);
    }

    // 治疗光环脉冲
    for (let i = heals.length - 1; i >= 0; i--) {
      const h = heals[i];
      h.life -= dtR;
      if (h.life <= 0) {
        heals.splice(i, 1);
        continue;
      }
      drawHealPulse(ctx, h.x, h.y, h.radius, 1 - h.life / 0.5);
    }

    // 伤害转嫁连线
    for (let i = transfers.length - 1; i >= 0; i--) {
      const tr = transfers[i];
      tr.life -= dtR;
      if (tr.life <= 0) {
        transfers.splice(i, 1);
        continue;
      }
      drawTransfer(ctx, tr.fx, tr.fy, tr.tx, tr.ty, Math.min(1, tr.life / 0.18));
    }

    // 伤害飘字（上升 + 淡出；文字在 y 翻转坐标系下需回到标准变换绘制）
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.textAlign = 'center';
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

    // 连锁闪电折线（两层：紫色光带 + 白色芯线，中点抖动形成电弧感）
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

    // HUD
    hudWall.style.width = `${(session.wallHp / session.wallMaxHp) * 100}%`;
    hudWallText.textContent = `城防 ${Math.ceil(session.wallHp)} / ${session.wallMaxHp}`;
    const need = xpNeed(h.level);
    hudXp.style.width = `${Math.min(100, (h.xp / need) * 100)}%`;
    hudText.textContent =
      `第 ${Math.min(session.waveStats.length + 1, level.waves.length)}/${level.waves.length} 波` +
      ` · Lv.${h.level} · 击杀 ${session.totalKills} · ${session.timeSec.toFixed(0)}s`;

    if (bannerTimer > 0) {
      bannerTimer -= 1 / 60;
      if (bannerTimer <= 0) banner.classList.remove('show');
    }
    if (canvas.classList.contains('shake')) {
      setTimeout(() => canvas.classList.remove('shake'), 120);
    }
  }

  // ---------- 主循环：固定 30Hz 逻辑 + 每帧渲染 ----------
  // 倍速：accumulator 按倍率累积（1x/1.5x/2x 循环切换），渲染/飘字动效仍按真实时间
  let gameSpeed = 1;
  const speedBtn = document.getElementById('speedbtn')!;
  const SPEED_STEPS = [1, 1.5, 2];
  speedBtn.onclick = () => {
    const next = (SPEED_STEPS.indexOf(gameSpeed) + 1) % SPEED_STEPS.length;
    gameSpeed = SPEED_STEPS[next];
    speedBtn.textContent = `${gameSpeed}x`;
    speedBtn.classList.toggle('fast', gameSpeed !== 1);
  };

  let last = performance.now();
  let acc = 0;
  function frame(now: number): void {
    acc += Math.min((now - last) / 1000, 0.25) * gameSpeed;
    last = now;
    const paused = session.pendingLevelChoices.length > 0 || session.result !== null;
    while (acc >= TICK_DT && !paused) {
      recorder.observe(controller.snapshot(), session.tick); // 步进前采样（仅记变化点）
      session.step();
      if (session.tick % 30 === 0) {
        recorder.check(session.tick, {
          x: session.hero.x, y: session.hero.y, wallHp: session.wallHp, kills: session.totalKills, lv: session.hero.level,
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
  document.body.innerHTML = `<pre style="color:#FF6B57;padding:2em">启动失败：${(e as Error).message}\n请确认从项目根目录启动静态服务器（见 README）。</pre>`;
});
