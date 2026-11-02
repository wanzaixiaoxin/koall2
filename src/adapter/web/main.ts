/**
 * Web 适配层（docs/05 §1.5 适配模式的第二个实现，第一个是 sim）：
 * Canvas 渲染 + 指针/键盘输入，消费 gamecore 的公共接口，
 * 证明核心逻辑零引擎依赖——Cocos 适配层将按同样方式接入。
 *
 * 渲染已全部下沉到 render/scene.ts（SceneRenderer），本文件只负责：
 * 输入 → 会话推进 → 卡牌/结算 DOM UI → 调用场景渲染器。
 */
import { GameSession, LevelConfig, MonsterConfig, WeaponConfig, CardConfig, TICK_DT, xpNeed, Vec2 } from '../../gamecore';
import { greedyDpsPolicy } from '../../../tools/sim/policies';
import { loadFxConfig, FxRuntime } from './render/fx';
import { SceneRenderer, ScenePalette } from './render/scene';

const W = 1080;
const H = 1920;

async function fetchJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`加载失败: ${url}`);
  return r.json() as Promise<T>;
}

async function boot(): Promise<void> {
  const [palette, weaponsFile, monstersFile, cardsFile, level, fxConfig] = await Promise.all([
    fetchJson<ScenePalette>('/configs/art-style/palette.json'),
    fetchJson<{ weapons: WeaponConfig[] }>('/configs/weapons.json'),
    fetchJson<{ monsters: MonsterConfig[] }>('/configs/monsters.json'),
    fetchJson<{ cards: CardConfig[] }>('/configs/cards.json'),
    fetchJson<LevelConfig>(`/configs/levels/${new URLSearchParams(location.search).get('level') ?? 'level_1_1.json'}`),
    loadFxConfig(),
  ]);
  // 动效运行时：唯一读取 fx-config.json 的消费者（美术改配置即生效，无需改代码）
  const fx = new FxRuntime(fxConfig);

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

  // ---------- 输入：点按移动（触屏/鼠标）+ WASD/方向键 ----------
  const input = { tx: W / 2, ty: 300, hasTarget: false, keys: new Set<string>() };

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
    input.tx = p.x;
    input.ty = p.y;
    input.hasTarget = true;
  });
  canvas.addEventListener('pointermove', (e) => {
    if (input.hasTarget) {
      // 按住拖动跟随
      const p = toGameCoords(e);
      input.tx = p.x;
      input.ty = p.y;
    }
  });
  const release = (): void => { input.hasTarget = false; }; // 松开即停
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  window.addEventListener('keydown', (e) => input.keys.add(e.key.toLowerCase()));
  window.addEventListener('keyup', (e) => input.keys.delete(e.key.toLowerCase()));
  window.addEventListener('blur', () => input.keys.clear()); // 失焦清空按键，防按键卡住

  const controller = {
    getMoveDir(s: GameSession): Vec2 {
      let dx = 0;
      let dy = 0;
      const k = input.keys;
      if (k.has('a') || k.has('arrowleft')) dx -= 1;
      if (k.has('d') || k.has('arrowright')) dx += 1;
      if (k.has('w') || k.has('arrowup')) dy += 1;
      if (k.has('s') || k.has('arrowdown')) dy -= 1;
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
      return { x: 0, y: 0 }; // 无输入时静止（不自动回中）
    },
  };

  // ---------- 会话 ----------
  const session = new GameSession({
    level,
    weaponConfigs: [
      weaponsFile.weapons.find((w) => w.id === new URLSearchParams(location.search).get('weapon'))
        ?? weaponsFile.weapons[0],
    ],
    monsterConfigs: new Map(monstersFile.monsters.map((m) => [m.id, m])),
    cardConfigs: cardsFile.cards,
    seed: (Date.now() % 100000) | 0,
    controller,
    cardPolicy: greedyDpsPolicy,
  });
  session.externalLevelUps = true;

  // 场景渲染器：背景/城墙/单位/弹幕/粒子/飘字全部由它负责（与实验室共用）
  const scene = new SceneRenderer(W, H, palette, fx);
  scene.attach(session);

  let bannerTimer = 0;
  session.bus.on<{ index: number; banner: string }>('onWaveStart', ({ banner: b }) => {
    banner.textContent = b;
    banner.classList.add('show');
    bannerTimer = 2.2;
  });

  session.bus.on<{ result: string }>('onGameOver', ({ result }) => {
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
  function render(timeMs: number): void {
    scene.render(ctx, session, timeMs);

    // HUD（DOM 层）
    const h = session.hero;
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
  }

  // ---------- 主循环：固定 30Hz 逻辑 + 每帧渲染 ----------
  let last = performance.now();
  let acc = 0;
  function frame(now: number): void {
    acc += Math.min((now - last) / 1000, 0.25);
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
  document.body.innerHTML = `<pre style="color:#FF6B57;padding:2em">启动失败：${(e as Error).message}\n请确认从项目根目录启动静态服务器（见 README）。</pre>`;
});
