/**
 * Web 适配层（docs/05 §1.5 适配模式的第二个实现，第一个是 sim）：
 * Canvas 渲染 + 指针/键盘输入，消费 gamecore 的公共接口，
 * 证明核心逻辑零引擎依赖——Cocos 适配层将按同样方式接入。
 */
import {
  GameSession,
  LevelConfig,
  MonsterConfig,
  MonsterRuntime,
  WeaponConfig,
  CardConfig,
  TICK_DT,
  xpNeed,
} from '../../gamecore';
import { greedyDpsPolicy } from '../../../tools/sim/policies';
import { HumanInputController, TraceRecorder, TraceRecord } from '../../../tools/sim/human';
import { drawMonster, drawProjectile, drawMonsterShot, drawHealPulse, drawTransfer, drawPool } from './render/shapes';
import { FxRuntime, loadFxConfig } from './render/fx';

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

/** 电弧折线路径：每段中点加随机抖动（渲染层表现，不影响逻辑确定性）；frac 只画前段（0→1 传导展开）。 */
function strokeBoltPath(ctx: CanvasRenderingContext2D, pts: number[][], frac = 1): void {
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
      const k = Math.max(0, budget) / Math.max(segLen, 0.001);
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

// ---------- 虫苔渲染（docs/08 视觉强化）：离屏缓存有机团块/脉纹/边缘亮弧 + 每帧脉动与蔓延光环 ----------
const CREEP_CELL_PX = 90;
const creepCache = document.createElement('canvas');
let creepCacheVersion = -1;
let creepPulseNodes: { x: number; y: number; s: number }[] = [];
/** 每格确定性噪声（同一格每次重建外观一致，避免闪烁） */
const creepHash = (n: number): number => {
  let x = (n ^ 0x9e3779b9) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
};

/** 重建虫苔离屏缓存：暗绿基座 + 内芯 + 脉纹 + 瘤节点 + 缺失邻格的边缘亮弧（蔓延感）。 */
function rebuildCreepCache(session: GameSession, w: number, h: number): void {
  creepCache.width = w;
  creepCache.height = h;
  const cctx = creepCache.getContext('2d')!;
  const c = CREEP_CELL_PX;
  const keys = [...session.creep.keys()];
  const has = (cx: number, cy: number): boolean => session.creep.has(cx * 4096 + cy);
  creepPulseNodes = [];
  // 层 1：软光晕——抹平格与格之间的硬边，整体读作"一张毯"而不是一堆圆
  cctx.fillStyle = 'rgba(53,83,26,0.26)';
  for (const key of keys) {
    cctx.beginPath();
    cctx.arc(Math.floor(key / 4096) * c + 45, (key % 4096) * c + 45, 56 + creepHash(key) * 5, 0, Math.PI * 2);
    cctx.fill();
  }
  // 层 2：暗绿基座
  cctx.fillStyle = 'rgba(31,49,13,0.4)';
  for (const key of keys) {
    cctx.beginPath();
    cctx.arc(Math.floor(key / 4096) * c + 45, (key % 4096) * c + 45, 48 + creepHash(key + 3) * 5, 0, Math.PI * 2);
    cctx.fill();
  }
  // 层 3：双错位内芯团块（打破圆形对称，出有机块面感）
  for (const key of keys) {
    const x = Math.floor(key / 4096) * c + 45;
    const y = (key % 4096) * c + 45;
    const a1 = creepHash(key + 7) * Math.PI * 2;
    cctx.fillStyle = 'rgba(74,107,31,0.48)';
    cctx.beginPath();
    cctx.arc(x + Math.cos(a1) * 10, y + Math.sin(a1) * 10, 34 + creepHash(key + 11) * 6, 0, Math.PI * 2);
    cctx.fill();
    const a2 = a1 + 2.4;
    cctx.fillStyle = 'rgba(94,134,40,0.3)';
    cctx.beginPath();
    cctx.arc(x + Math.cos(a2) * 14, y + Math.sin(a2) * 14, 25 + creepHash(key + 19) * 6, 0, Math.PI * 2);
    cctx.fill();
  }
  const dirs: [number, number, number][] = [[1, 0, 0], [0, 1, Math.PI / 2], [-1, 0, Math.PI], [0, -1, -Math.PI / 2]];
  // 层 4：焦痕（docs/08 §2.2 灼烧层）——受损格压暗 + 健康点缀随层数减少而消失
  const fullLayers = GameSession.CREEP_LAYERS;
  for (const key of keys) {
    const layersLeft = session.creepHp.get(key) ?? fullLayers;
    if (layersLeft >= fullLayers) continue;
    const x = Math.floor(key / 4096) * c + 45;
    const y = (key % 4096) * c + 45;
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
    // 脉纹（深色短弧；焦壳上不画健康细节）
    if (layersLeft >= 2) {
      const a0 = creepHash(key + 13) * Math.PI * 2;
      cctx.strokeStyle = 'rgba(20,32,8,0.4)';
      cctx.lineWidth = 3;
      cctx.beginPath();
      cctx.arc(x - Math.cos(a0) * 14, y - Math.sin(a0) * 14, 26 + creepHash(key + 17) * 14, a0 - 1.2, a0 + 1.2);
      cctx.stroke();
    }
    // 瘤节点 + 脉动候选（稀疏：点缀感，不喧宾夺主；满层才有）
    if (layersLeft >= fullLayers && creepHash(key + 23) < 0.22) {
      cctx.fillStyle = 'rgba(156,204,101,0.4)';
      cctx.beginPath();
      cctx.arc(x, y, 3 + creepHash(key + 29) * 3, 0, Math.PI * 2);
      cctx.fill();
    }
    if (layersLeft >= 2 && creepHash(key + 31) < 0.3) creepPulseNodes.push({ x, y, s: creepHash(key + 37) });
    // 外缘亮弧（面向空缺方向 = 正在蔓延的边缘；烧焦格不亮）
    if (layersLeft < 2) continue;
    cctx.strokeStyle = 'rgba(156,204,101,0.35)';
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

/** 虫苔渲染：缓存底图 + 呼吸脉动 + 新生地块扩散圈（纯渲染层，不影响 30Hz 结算）。 */
function drawCreepField(ctx: CanvasRenderingContext2D, session: GameSession, t: number, w: number, h: number): void {
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

async function boot(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const levelFile = params.get('level') ?? 'level_1_1.json';
  const [palette, weaponsFile, monstersFile, cardsFile, level, fxConfig] = await Promise.all([
    fetchJson<Palette>('/configs/art-style/palette.json'),
    fetchJson<{ weapons: WeaponConfig[] }>('/configs/weapons.json'),
    fetchJson<{ monsters: MonsterConfig[] }>('/configs/monsters.json'),
    fetchJson<{ cards: CardConfig[] }>('/configs/cards.json'),
    fetchJson<LevelConfig>(`/configs/levels/${levelFile}`),
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
  const hudWeapons = document.getElementById('weaponrow')!;
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
    weaponPool: weaponsFile.weapons, // 升级三选一可出"新武器"候选（docs/02 §1：1 把初始 + 卡牌获得）
    seed,
    controller,
    cardPolicy: greedyDpsPolicy,
  });
  // ?ff=<秒>：开发快进——直达后期波次观察战场（快进期间按贪心策略自动选卡、城墙锁定，
  // 避免无操作 AI 走位失败把观察打断；仅调试/截图用，正常对局不传此参数）
  const ffSec = Math.min(1800, Math.max(0, Number(params.get('ff')) || 0));
  if (ffSec > 0 && !session.result) {
    session.externalLevelUps = false; // 快进期间自动选卡（与 sim 贪心策略一致）
    const ffTicks = Math.round(ffSec * 30);
    for (let i = 0; i < ffTicks && !session.result; i++) {
      session.wallHp = session.wallMaxHp; // 城墙锁定：快进只用于观察，不结算走位失败的破墙
      session.step();
    }
  }
  session.externalLevelUps = true;
  recorder.start({ t0: Date.now(), seed, level: levelFile, weapon: weaponCfg.id, version: BUNDLE_VERSION, pool: true });

  let bannerTimer = 0;
  let prevRenderMs = 0;
  let weaponsShown = -1; // HUD 武器槽缓存（仅数量变化时重建 DOM）
  session.bus.on<{ index: number; banner: string }>('onWaveStart', ({ banner: b }) => {
    banner.textContent = b;
    banner.classList.add('show');
    bannerTimer = 2.2;
  });
  session.bus.on('onWallHit', () => canvas.classList.add('shake'));

  // 虫巢扩张（docs/08 §2.4）：晋升横幅 + 全屏绿闪；菌毯孵化出土烟尘（§2.5）
  let creepFlash = 0;
  const emerges: { x: number; y: number; life: number }[] = [];
  session.bus.on<{ tier: number; cells: number }>('onCreepTier', ({ tier }) => {
    banner.textContent = `虫巢扩张 · 全族强化（T${tier}）`;
    banner.classList.add('show');
    bannerTimer = 2.4;
    creepFlash = 1;
  });
  session.bus.on<{ x: number; y: number }>('onMonsterEmerge', ({ x, y }) => {
    if (emerges.length >= 24) emerges.shift();
    emerges.push({ x, y, life: 0.55 });
  });

  // 站毯回血可视（docs/08）：受损虫族在毯上回血时节拍冒绿色愈合粒子（纯渲染层，观察 hp 上升）
  const healMarks: { x: number; y: number; life: number }[] = [];
  const healSeen = new WeakMap<MonsterRuntime, { hp: number; next: number }>();

  // 伤害飘字（渲染层对象池语义：上限 40，见 docs/01 §4）
  interface FloatText { x: number; y: number; text: string; color: string; size: number; life: number; maxLife: number }
  const floats: FloatText[] = [];
  const pushFloat = (x: number, y: number, text: string, color: string, size: number): void => {
    if (floats.length >= 40) floats.shift();
    floats.push({ x, y, text, color, size, life: 0.8, maxLife: 0.8 });
  };
  session.bus.on<{
    monsterId?: number; dmg: number; isCrit: boolean; blocked?: boolean; mitigated?: number; x: number; y: number;
  }>(
    'onHit',
    ({ monsterId, dmg, isCrit, blocked, mitigated, x, y }) => {
      // 受击闪白登记（最高优先级动效，时长/曲线来自 fx-config.json hitFlash）
      // 时间基准与 render 内的 now 一致（session.timeSec，秒）
      if (monsterId !== undefined && !blocked) fx.markHit(monsterId, session.timeSec);
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
  // ---------- 机身武器挂载（多武器可视化，docs/02 §1） ----------
  // 每把武器在机身上一个发射装置：开火时对应炮口闪光/后坐（武器 id 唯一 ⇒ 下标稳定对齐）
  // 按持有数取布局：1=正面单炮 / 2=左右两侧 / 3=加前沿炮塔 / 4=加尾部炮塔
  const MOUNT_SPOTS: [number, number][][] = [
    [],
    [[0, 20]],
    [[-16, 2], [16, 2]],
    [[-16, 2], [16, 2], [0, 28]],
    [[-16, 2], [16, 2], [0, 28], [0, -26]],
  ];
  const MUZZLE_LEN = 14; // 炮口离底座中心距离（连锁闪电起点用它对齐炮口）
  const weaponFlash: number[] = []; // 与 hero.weapons 同序：闪光剩余时长
  const WEAPON_FLASH = 0.13;
  session.bus.on<{ weaponId?: string }>('onShoot', ({ weaponId }) => {
    const idx = session.hero.weapons.findIndex((w) => w.cfg.id === weaponId);
    if (idx >= 0) weaponFlash[idx] = WEAPON_FLASH;
  });
  let aimCur = Math.PI / 2; // 炮口朝向（渲染层平滑值，默认朝上=敌人来向）
  // 连锁闪电折线（渲染层表现，0.26s：前 0.07s 从炮口"传导"展开 + 余晖）
  const bolts: { pts: number[][]; life: number; age: number }[] = [];
  session.bus.on<{ points: number[][] }>('onChain', ({ points }) => {
    // 起点改绑雷电挂载的炮口：移动中也能看清"这道雷从权杖放出来"，不再凭空劈在怪身上
    const pts = points.map((p) => [p[0], p[1]] as number[]);
    const li = session.hero.weapons.findIndex((w) => w.cfg.id === 'lightning_chain');
    const mounts = MOUNT_SPOTS[Math.min(session.hero.weapons.length, 4)];
    if (li >= 0 && li < mounts.length) {
      const [mx, my] = mounts[li];
      pts[0] = [session.hero.x + mx + MUZZLE_LEN * Math.cos(aimCur), session.hero.y + my + MUZZLE_LEN * Math.sin(aimCur)];
    }
    if (bolts.length > 12) bolts.shift();
    bolts.push({ pts, life: 0.26, age: 0 });
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
  const typeTag = { bullet: '子弹', wall: '城墙', form: '形态', passive: '属性', element: '元素', weapon: '新武器' }[c.type];
        const weaponNames = new Map(weaponsFile.weapons.map((w) => [w.id, w.name]));
        const elementNames: Record<string, string> = {
          fire: '火焰', frost: '寒冰', lightning: '闪电', poison: '毒素', physical: '物理',
        };
        const targetTag = c.type === 'weapon'
          ? '加入战斗'
          : !c.target || c.target.kind === 'any'
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
    // 虫苔（docs/08）：画在怪物/英雄之下——离屏缓存有机团块 + 呼吸脉动 + 蔓延光环
    drawCreepField(ctx, session, t, W, H);
    for (const m of session.monsters) {
      const r = m.cfg.radius;
      // 虫族站毯提示（docs/08）：脚下酸绿微光（加速/回血生效中）；受伤时微光随呼吸脉动 = 回血中
      if (m.cfg.creepBenefit && !m.burrowed && session.isCreeped(m.x, m.y)) {
        const pulse = m.hp < m.maxHp ? 0.18 + 0.1 * Math.sin(t * 4 + m.phase) : 0.16;
        ctx.fillStyle = `rgba(156,204,101,${pulse.toFixed(3)})`;
        ctx.beginPath();
        ctx.ellipse(m.x, m.y + r * 0.55, r * 1.35, r * 0.6, 0, 0, Math.PI * 2);
        ctx.fill();
        // 愈合粒子：hp 上升（站毯回血/虫后治疗）时节拍冒一颗绿十字，≤0.8s/只、全场 20 上限
        const seen = healSeen.get(m) ?? { hp: m.hp, next: t + 0.8 };
        if (m.hp > seen.hp && t >= seen.next && healMarks.length < 20) {
          seen.next = t + 0.8;
          healMarks.push({ x: m.x + (m.phase % 1) * 8 - 4, y: m.y + r * 0.3, life: 0.7 });
        }
        seen.hp = m.hp;
        healSeen.set(m, seen);
      }
      // 受击反馈：闪白强度走 hitFlash，挤压倍率走 squashStretch（均来自 fx-config.json）
      drawMonster(ctx, m, t, fx.flashAlpha(m.id, now), fx.hitSquash(m.id, now));
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

    // 英雄（正三角机身 + 圆形核心，呼吸浮动；多武器挂载：每把武器一个发射装置）
    const h = session.hero;
    const breathe = Math.sin(t * 2.2) * 3;
    // 炮口朝向最近怪物（无怪则朝上）；按最短弧平滑，避免 ±π 跳变
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
    // 机身
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
    // 武器挂载（布局表见 MOUNT_SPOTS：1=正面单炮 / 2=左右 / 3=+前沿 / 4=+尾部）
    const beamOn = new Set(session.segments.map((sg) => sg.srcWeaponId)); // 光束武器：持束常亮
    const mounts = MOUNT_SPOTS[Math.min(h.weapons.length, 4)];
    for (let i = 0; i < h.weapons.length && i < mounts.length; i++) {
      const w = h.weapons[i];
      const [mx, my] = mounts[i];
      const k = Math.max(0, weaponFlash[i] ?? 0) / WEAPON_FLASH;
      if (weaponFlash[i]) weaponFlash[i] = Math.max(0, (weaponFlash[i] ?? 0) - dtR);
      const color = (palette.damageType as Record<string, string>)[w.element] ?? '#BFFFF2'; // 元素卡换色与弹道一致
      const isBeam = !!w.cfg.beamBase;
      const beamLive = isBeam && beamOn.has(w.cfg.id);
      const overheated = isBeam && w.cooldown > w.cfg.interval * 1.5; // 强制散热中（正常射击间隔远小于此）
      const recoil = isBeam ? 0 : k * 3; // 持续光束不播后坐（每 0.4s 一次会抖）
      ctx.save();
      ctx.translate(mx, my);
      ctx.rotate(aimCur - Math.PI / 2);
      // 炮塔底座
      ctx.fillStyle = '#12142B';
      ctx.strokeStyle = '#3D4470';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(0, 0, 7.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      // 炮管（开火后坐）
      ctx.strokeStyle = color;
      ctx.lineWidth = 3.5;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(0, -3 + recoil * 0.4);
      ctx.lineTo(0, 13 - recoil);
      ctx.stroke();
      // 炮口端点
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(0, 13 - recoil, 2.4, 0, Math.PI * 2);
      ctx.fill();
      // 光束武器：持束时炮口常亮光圈 / 散热时红光脉动
      if (beamLive) {
        ctx.globalAlpha = 0.45 + 0.25 * Math.sin(t * 24);
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(0, 13, 6.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#F5F5FA';
        ctx.beginPath();
        ctx.arc(0, 13, 2.6, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      if (overheated) {
        ctx.globalAlpha = 0.45 + 0.3 * Math.sin(t * 12);
        ctx.strokeStyle = '#FF7A6B';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(0, 0, 9.5, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      // 开火闪光
      if (k > 0.02) {
        ctx.globalAlpha = 0.85 * Math.min(1, k);
        ctx.fillStyle = '#FFF6D6';
        ctx.beginPath();
        ctx.arc(0, 15 - recoil, 1.8 + 2.4 * k, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      ctx.restore();
    }
    ctx.restore();

    // 投射物（按武器塑形 + 伤害类型着色）
    const projColor = (t: string): string =>
      (palette.damageType as Record<string, string>)[t] ?? '#BFFFF2';
    // 激光束（SegmentField 持续光束，docs/07 §4）：起点对齐挂载炮口，三层光带 + 炮口光斑；
    // 微闪为纯渲染层（不影响 30Hz 结算），穿透到界外由画布裁剪自然呈现
    for (const seg of session.segments) {
      if (!seg.srcWeaponId) continue; // 调试光束（lab 页）不进主游戏画面
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
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineCap = 'round';
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.1 * flick;
      ctx.lineWidth = seg.width * 3.4;
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(seg.bx, seg.by); ctx.stroke();
      ctx.globalAlpha = 0.3 * flick;
      ctx.lineWidth = seg.width * 1.7;
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(seg.bx, seg.by); ctx.stroke();
      ctx.globalAlpha = 0.9;
      ctx.strokeStyle = '#F5F5FA';
      ctx.lineWidth = Math.max(1.5, seg.width * 0.5);
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(seg.bx, seg.by); ctx.stroke();
      ctx.globalAlpha = 0.8;
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(sx, sy, seg.width * 0.75 * flick, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 0.95;
      ctx.fillStyle = '#FFFFFF';
      ctx.beginPath(); ctx.arc(sx, sy, 2.2, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
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

    // 连锁闪电折线（两层：紫色光带 + 白色芯线；前 0.07s 沿折线传导展开 + 炮口先导光）
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
      // 炮口先导光：放电瞬间从炮口亮一下（移动中也能看清"从权杖放出来"）
      if (b.age < 0.12) {
        const kk = 1 - b.age / 0.12;
        ctx.globalAlpha = 0.75 * kk;
        ctx.fillStyle = '#B388FF';
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

    // 站毯回血粒子：绿色小十字缓升消散（docs/08 回血支援的可视反馈）
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

    // 虫巢扩张全屏绿闪（纯渲染层）
    if (creepFlash > 0) {
      creepFlash = Math.max(0, creepFlash - dtR * 1.1);
      ctx.fillStyle = `rgba(124,179,66,${(0.16 * creepFlash).toFixed(3)})`;
      ctx.fillRect(0, 0, W, H);
    }

    // 菌毯孵化出土：扩散圈 + 土屑（docs/08 §2.5）
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

    // HUD
    hudWall.style.width = `${(session.wallHp / session.wallMaxHp) * 100}%`;
    hudWallText.textContent = `城防 ${Math.ceil(session.wallHp)} / ${session.wallMaxHp}`;
    const need = xpNeed(h.level);
    hudXp.style.width = `${Math.min(100, (h.xp / need) * 100)}%`;
    hudText.textContent =
      `第 ${Math.min(session.waveStats.length + 1, level.waves.length)}/${level.waves.length} 波` +
      ` · Lv.${h.level} · 击杀 ${session.totalKills} · ${session.timeSec.toFixed(0)}s` +
      (session.creepTier > 1 ? ` · 虫巢T${session.creepTier}` : '');

    // 武器槽（获得新武器时重建：1 把初始 + 升级三选一获得，最多 4 把）
    if (session.hero.weapons.length !== weaponsShown) {
      weaponsShown = session.hero.weapons.length;
      hudWeapons.innerHTML = session.hero.weapons
        .map((w) => `<span class="wchip">${w.cfg.name}</span>`)
        .join('');
    }

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
