/**
 * 卡牌实验室（web/lab.html）：测试入口——点任意卡立即生效，实时观察属性面板与弹道表现。
 * 使用 gamecore 的测试 API（grantCard / debugSpawn），不影响正常对局逻辑。
 */
import {
  CardConfig,
  GameSession,
  LevelConfig,
  MonsterConfig,
  WeaponConfig,
} from '../../gamecore';
import { greedyDpsPolicy } from '../../../tools/sim/policies';
import { drawMonster, drawProjectile } from './render/shapes';

const W = 1080;
const H = 1920;
const LAB_LEVEL = '/configs/levels/lab_arena.json';

interface Palette {
  background: { nightDeep: string; gridLine: string };
  enemy: { primary: string };
  friendly: { hero: string; wall: string; wallDamaged: string };
  damageType: Record<string, string>;
}

async function fetchJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`加载失败: ${url}`);
  return r.json() as Promise<T>;
}

/** 电弧折线路径：每段中点随机抖动（纯渲染表现）。 */
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

let prevMs = 0;

async function boot(): Promise<void> {
  const [palette, weaponsFile, monstersFile, cardsFile, level] = await Promise.all([
    fetchJson<Palette>('/configs/art-style/palette.json'),
    fetchJson<{ weapons: WeaponConfig[] }>('/configs/weapons.json'),
    fetchJson<{ monsters: MonsterConfig[] }>('/configs/monsters.json'),
    fetchJson<{ cards: CardConfig[] }>('/configs/cards.json'),
    fetchJson<LevelConfig>(LAB_LEVEL),
  ]);

  const canvas = document.getElementById('game') as HTMLCanvasElement;
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;

  // ---------- 输入：点按/拖动 + WASD/方向键移动英雄（与主游戏一致） ----------
  const input = { tx: W / 2, ty: 300, hasTarget: false, keys: new Set<string>() };
  const toGameCoords = (e: PointerEvent): { x: number; y: number } => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * W,
      y: ((e.clientY - rect.top) / rect.height) * H,
    };
  };
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    const p = toGameCoords(e);
    input.tx = p.x;
    input.ty = p.y;
    input.hasTarget = true;
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!input.hasTarget) return;
    const p = toGameCoords(e);
    input.tx = p.x;
    input.ty = p.y;
  });
  const release = (): void => { input.hasTarget = false; };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  window.addEventListener('keydown', (e) => input.keys.add(e.key.toLowerCase()));
  window.addEventListener('keyup', (e) => input.keys.delete(e.key.toLowerCase()));
  window.addEventListener('blur', () => input.keys.clear());

  // 连锁闪电折线（跨会话共享渲染缓冲；监听随会话重建）
  const bolts: { pts: number[][]; life: number }[] = [];

  let session: GameSession;
  /** 按武器构筑创建沙盒会话（切换英雄/武器时重建，卡池门控随之刷新）。 */
  function createSession(weaponId: string): void {
    const weapon = weaponsFile.weapons.find((w) => w.id === weaponId) ?? weaponsFile.weapons[0];
    session = new GameSession({
      level,
      weaponConfigs: [weapon],
      monsterConfigs: new Map(monstersFile.monsters.map((m) => [m.id, m])),
      cardConfigs: cardsFile.cards,
      seed: (Date.now() % 100000) | 0,
      controller: {
        getMoveDir(s) {
          const k = input.keys;
          let dx = 0;
          let dy = 0;
          if (k.has('a') || k.has('arrowleft')) dx -= 1;
          if (k.has('d') || k.has('arrowright')) dx += 1;
          if (k.has('w') || k.has('arrowup')) dy += 1;
          if (k.has('s') || k.has('arrowdown')) dy -= 1;
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
        },
      },
      cardPolicy: greedyDpsPolicy,
    });
    session.sandboxMode = true; // 实验室：空波次会触发"胜利"，跳过胜负结算
    session.bus.on<{ points: number[][] }>('onChain', ({ points }) => {
      if (bolts.length > 12) bolts.shift();
      bolts.push({ pts: points, life: 0.22 });
    });
  }

  // ---------- 卡牌按钮 ----------
  const cardGrid = document.getElementById('cardgrid')!;
  const cardBtns = new Map<string, { btn: HTMLButtonElement; cnt: HTMLSpanElement }>();
  const elementNames: Record<string, string> = {
    fire: '火焰', frost: '寒冰', lightning: '闪电', poison: '毒素', physical: '物理',
  };
  const renderCards = (): void => {
    cardGrid.innerHTML = '';
    cardBtns.clear();
    const typeTag: Record<string, string> = { bullet: '子弹', wall: '城墙', form: '形态', passive: '属性', element: '元素' };
    const weaponNames = new Map(weaponsFile.weapons.map((w) => [w.id, w.name]));
    const current = weaponsFile.weapons.find((w) => w.id === currentWeapon) ?? weaponsFile.weapons[0];
    // 谱系分组：本武器专属卡 / 公共卡（其他武器的卡隐藏，切换武器即切换整套视图）
    const exclusive = cardsFile.cards.filter((c) => c.target?.kind === 'weapon' && c.target.weaponType === current.id);
    const shared = cardsFile.cards.filter((c) => c.target?.kind !== 'weapon');

    const addGroup = (title: string, list: CardConfig[]): void => {
      if (list.length === 0) return;
      const h = document.createElement('div');
      h.className = 'secgroup';
      h.textContent = title;
      cardGrid.appendChild(h);
      for (const c of list) {
        const targetTag = !c.target || c.target.kind === 'any'
          ? '公共'
          : `${elementNames[(c.target as { element: string }).element] ?? '元素'}·元素`;
        const btn = document.createElement('button');
        btn.className = `cbtn t-${c.type}`;
        const cnt = document.createElement('span');
        cnt.className = 'cnt';
        const label = document.createElement('span');
        label.innerHTML = `${c.name}<br><small>[${typeTag[c.type]}｜${targetTag}] ${c.desc ?? ''}</small>`;
        btn.appendChild(cnt);
        btn.appendChild(label);
        btn.onclick = () => {
          if (session.grantCard(c.id)) {
            log(`✓ ${c.name} → ${c.desc ?? ''}`);
            renderCards();
          } else {
            log(`✗ ${c.name}：不可用（未满足目标条件或已达上限）`);
          }
        };
        cardGrid.appendChild(btn);
        cardBtns.set(c.id, { btn, cnt });
      }
    };
    addGroup(`专属卡 · ${weaponNames.get(current.id) ?? current.name}（${exclusive.length}）`, exclusive);
    addGroup(`公共卡（${shared.length}）`, shared);
    refreshCardStates();
  };

  /** 按当前武器状态刷新每个按钮的可用性与原因（门控实时反映，如 烈火需先有火属性）。 */
  const refreshCardStates = (): void => {
    for (const c of cardsFile.cards) {
      const entry = cardBtns.get(c.id);
      if (!entry) continue;
      const stacks = session.cardPickLog.filter((l) => l.startsWith(c.name + '(')).length;
      const full = stacks >= c.maxStack;
      const applicable = session.isCardApplicable(c);
      entry.btn.disabled = full || !applicable;
      entry.btn.classList.toggle('gated', !full && !applicable);
      entry.cnt.textContent = full
        ? `${stacks}/${c.maxStack} 满`
        : !applicable
          ? gateReason(c)
          : `${stacks}/${c.maxStack}`;
    }
  };
  const gateReason = (c: CardConfig): string => {
    const e = c.effect;
    if ('boostElement' in e) return `需${e.boostElement === 'fire' ? '火' : '冰'}属性`;
    if ('grantElement' in e) return '已赋元素';
    if (c.target?.kind === 'weapon') return '需对应武器';
    return '未满足';
  };

  // ---------- 测试怪按钮 ----------
  const monGrid = document.getElementById('mongrid')!;
  for (const m of monstersFile.monsters) {
    const btn = document.createElement('button');
    btn.className = 'mbtn';
    btn.textContent = `+ ${m.name}`;
    btn.onclick = () => {
      const x = 150 + Math.random() * (W - 300);
      const y = 1250 + Math.random() * 450; // 步枪射程（≈1228）之外生成， marched 过程可观察
      session.debugSpawn(m.id, x, y);
      log(`+ 生成 ${m.name} @ (${x.toFixed(0)}, ${y.toFixed(0)})`);
    };
    monGrid.appendChild(btn);
  }
  document.getElementById('clear')!.onclick = () => {
    session.monsters.forEach((m) => { m.hp = 0; });
    log('清场');
  };
  document.getElementById('beam')!.onclick = () => {
    session.debugBeam(Math.PI / 2, 1400, 60, 3);
    log('⚡ 光束：英雄正上方 1400px，60 dps × 3s');
  };
  document.getElementById('link')!.onclick = () => {
    const y = 700 + Math.random() * 600;
    session.debugLink(100, y, W - 100, y, 60, 3);
    log(`⚡ 电网连线：y=${y.toFixed(0)}，60 dps × 3s`);
  };
  document.getElementById('reset')!.onclick = () => location.reload();

  // 武器构筑选择：切换后重建沙盒会话，卡池按新武器门控刷新
  const weaponSelect = document.getElementById('weaponselect')!;
  const wprofile = document.getElementById('wprofile')!;
  let currentWeapon = new URLSearchParams(location.search).get('weapon') ?? weaponsFile.weapons[0].id;

  /** 谱系档案：定位 + 本体机制标签（由武器配置派生，docs/02 §6）。 */
  const renderWeaponProfile = (): void => {
    const w = weaponsFile.weapons.find((x) => x.id === currentWeapon) ?? weaponsFile.weapons[0];
    const tags: string[] = [];
    if (w.chainBase) tags.push(`落雷连锁 ×${w.chainBase}`);
    if (w.blastBase) tags.push(`落地爆破圈 r${Math.round(w.blastBase.radius)}`);
    if (w.motion?.type === 'parabola') tags.push('抛物线弹道');
    if (w.motion?.type === 'phased') tags.push('飞出→返回');
    if ((w.pierce ?? 0) > 0) tags.push(`穿透 ${w.pierce}`);
    if (w.pierceFalloff) tags.push(`穿透衰减 ${Math.round(w.pierceFalloff * 100)}%/次`);
    wprofile.innerHTML =
      `<span class="role">${w.role ?? ''}</span>` +
      `<span class="chip">${elementNames[w.damageType] ?? w.damageType}</span>` +
      `<span class="chip">伤害 ${w.baseDamage} · ${w.interval}s · ${w.count} 发</span>` +
      tags.map((t) => `<span class="chip mech">${t}</span>`).join('');
  };

  const renderWeaponSelect = (): void => {
    weaponSelect.innerHTML = '';
    for (const w of weaponsFile.weapons) {
      const btn = document.createElement('button');
      btn.className = `wbtn${w.id === currentWeapon ? ' active' : ''}`;
      btn.innerHTML = `${w.name}<br><small style="opacity:.6;font-size:11px">${w.role ?? ''}</small>`;
      btn.onclick = () => {
        if (w.id === currentWeapon) return;
        currentWeapon = w.id;
        createSession(w.id);
        renderWeaponSelect();
        renderWeaponProfile();
        renderCards();
        log(`切换武器构筑：${w.name}（专属卡已切换）`);
      };
      weaponSelect.appendChild(btn);
    }
  };

  // 连续出怪开关
  let autoSpawn = false;
  let spawnAcc = 0;
  const autoBtn = document.getElementById('autospawn') as HTMLButtonElement;
  autoBtn.onclick = () => {
    autoSpawn = !autoSpawn;
    autoBtn.textContent = `连续出怪：${autoSpawn ? '开' : '关'}`;
    log(`连续出怪 ${autoSpawn ? '开启（场上<25 只时持续进场）' : '关闭'}`);
  };

  const logBox = document.getElementById('log')!;
  const log = (s: string): void => {
    const el = document.createElement('div');
    el.textContent = s;
    logBox.prepend(el);
    while (logBox.children.length > 30) logBox.lastChild?.remove();
  };

  // ---------- 属性面板 ----------
  const statsEl = document.getElementById('stats')!;
  const fmt = (n: number): string => (Math.round(n * 100) / 100).toString();
  const renderStats = (): void => {
    const h = session.hero;
    const w = h.weapons[0];
    const a = w.affixes;
    const r = w.riders;
    statsEl.innerHTML = `
      <h3>英雄属性</h3>
      <table>
        <tr><td>攻击</td><td>${fmt(h.stats.atk)}</td><td>攻速</td><td>${fmt(h.stats.aspd)}</td></tr>
        <tr><td>暴击率</td><td>${fmt(h.stats.critChance * 100)}%</td><td>暴击伤害</td><td>${fmt(h.stats.critDmg * 100)}%</td></tr>
        <tr><td>全伤加成</td><td>${fmt(h.stats.dmgMul * 100)}%</td><td>等级</td><td>${h.level}</td></tr>
      </table>
      <h3>武器面板（${w.cfg.name}）</h3>
      <table>
        <tr><td>单发伤害</td><td>${fmt(w.damage * w.mods.damageMul)}</td><td>攻击间隔</td><td>${fmt(w.cfg.interval / h.stats.aspd)}s</td></tr>
        <tr><td>弹速</td><td>${fmt(w.cfg.projectileSpeed * w.mods.projSpeedMul)}</td><td>射程</td><td>${fmt(w.cfg.projectileRange * w.mods.rangeMul)}</td></tr>
        <tr><td>齐射</td><td>${w.cfg.count + w.mods.extraCount} 发</td><td>连射</td><td>+${w.mods.burst} 发</td></tr>
        <tr><td>元素</td><td>${w.element}</td><td>穿透</td><td>${w.cfg.pierce}（衰减 ${Math.round((w.cfg.pierceFalloff ?? 0.15) * 100)}%/次）</td></tr>
      </table>
      <h3>形态词缀</h3>
      <table>
        <tr><td>追踪</td><td>${a.homing ? '✓' : '—'}</td><td>弹射</td><td>Lv${a.bounce}</td></tr>
        <tr><td>分裂</td><td>Lv${a.split}</td><td>爆破</td><td>Lv${a.blast}</td></tr>
        <tr><td>破甲</td><td>Lv${a.shred}（-${a.shred * 3} 防）</td><td>连锁</td><td>Lv${a.chain}</td></tr>
      </table>
      <h3>元素骑士</h3>
      <table>
        <tr><td>灼烧</td><td>${r.burnDpsMul > 0 ? `${fmt(r.burnDpsMul * 100)}%/s × ${r.burnSec}s` : '—（需火属性）'}</td></tr>
        <tr><td>冰冻</td><td>${r.slowPct > 0 ? `-${Math.round(r.slowPct * 100)}% × ${r.slowSec}s` : '—（需冰属性）'}</td></tr>
      </table>
      <h3>城墙</h3>
      <table><tr><td>城防</td><td>${Math.ceil(session.wallHp)} / ${session.wallMaxHp}</td></tr></table>
      <h3>战场</h3>
      <table>
        <tr><td>场上怪物</td><td>${session.monsters.length}</td><td>投射物</td><td>${session.projectiles.length}</td></tr>
        <tr><td>伤害圈</td><td>${session.pools.length}</td><td>总伤害</td><td>${Math.round(session.totalDamage)}</td></tr>
      </table>`;
  };
  createSession(currentWeapon);
  renderWeaponSelect();
  renderWeaponProfile();
  renderCards();
  log('实验室就绪：上方切换武器构筑，下方卡牌随之切换；左侧战场拖动/WASD 移动');

  // ---------- 渲染（精简版，与主游戏同规范） ----------
  function render(): void {
    ctx.setTransform(1, 0, 0, -1, 0, H);
    ctx.fillStyle = palette.background.nightDeep;
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = palette.background.gridLine;
    ctx.lineWidth = 1;
    for (let x = 0; x <= W; x += 90) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
    for (let y = 0; y <= H; y += 90) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }

    // 防守区域指示
    ctx.fillStyle = 'rgba(53,224,195,0.05)';
    ctx.fillRect(0, session.level.defenseRect.yMin, W, session.level.defenseRect.yMax - session.level.defenseRect.yMin);

    const wallTop = session.level.wall.height;
    const segs = 12;
    const segW = W / segs;
    const wr = session.wallHp / session.wallMaxHp;
    for (let i = 0; i < segs; i++) {
      ctx.fillStyle = wr < 0.3 ? palette.friendly.wallDamaged : palette.friendly.wall;
      ctx.beginPath();
      ctx.roundRect(i * segW + 3, 6, segW - 6, wallTop - 12, 8);
      ctx.fill();
    }

    for (const pool of session.pools) {
      ctx.fillStyle = 'rgba(255,90,60,0.3)';
      ctx.beginPath();
      ctx.arc(pool.x, pool.y, pool.radius, 0, Math.PI * 2);
      ctx.fill();
    }

    // 光束/连线（段场）：外发光 + 高亮芯线
    for (const seg of session.segments) {
      const left = Math.max(0, seg.until - session.timeSec);
      const alpha = Math.min(1, 0.25 + left * 0.6);
      ctx.strokeStyle = `rgba(179,136,255,${alpha})`;
      ctx.lineWidth = seg.width / 2;
      ctx.beginPath(); ctx.moveTo(seg.ax, seg.ay); ctx.lineTo(seg.bx, seg.by); ctx.stroke();
      ctx.strokeStyle = `rgba(245,245,250,${Math.min(1, alpha + 0.3)})`;
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(seg.ax, seg.ay); ctx.lineTo(seg.bx, seg.by); ctx.stroke();
    }

    // 连锁闪电折线（紫色光带 + 白色芯线，中点抖动电弧）
    const nowMs = performance.now();
    const dtR = Math.min(0.05, (nowMs - prevMs) / 1000 || 0.016);
    prevMs = nowMs;
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

    const now = session.timeSec;
    const tNow = now; // 渲染动效时钟与逻辑时钟一致（实验室确定性优先）
    for (const m of session.monsters) {
      drawMonster(ctx, m, tNow);
      if (now < m.slowUntil) {
        ctx.strokeStyle = 'rgba(79,195,247,0.9)';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(m.x, m.y, m.cfg.radius + 4, 0, Math.PI * 2); ctx.stroke();
      }
      if (m.burn && m.burn.until > now) {
        const flick = 8 + Math.sin(now * 14 + m.phase) * 3;
        ctx.fillStyle = '#FF5A3C';
        ctx.beginPath();
        ctx.moveTo(m.x, m.y + m.cfg.radius + 4 + flick);
        ctx.quadraticCurveTo(m.x - 7, m.y + m.cfg.radius + 5, m.x, m.y + m.cfg.radius);
        ctx.quadraticCurveTo(m.x + 7, m.y + m.cfg.radius + 5, m.x, m.y + m.cfg.radius + 4 + flick);
        ctx.fill();
        ctx.fillStyle = '#FFD54F';
        ctx.beginPath(); ctx.arc(m.x, m.y + m.cfg.radius + 5, 2.4, 0, Math.PI * 2); ctx.fill();
      }
      if (m.hp < m.maxHp) {
        ctx.fillStyle = 'rgba(255,255,255,0.25)';
        ctx.fillRect(m.x - m.cfg.radius, m.y + m.cfg.radius + 6, m.cfg.radius * 2, 4);
        ctx.fillStyle = '#FF3D71';
        ctx.fillRect(m.x - m.cfg.radius, m.y + m.cfg.radius + 6, (m.cfg.radius * 2 * m.hp) / m.maxHp, 4);
      }
    }

    const projColor = (t: string): string => palette.damageType[t] ?? '#BFFFF2';
    for (const p of session.projectiles) {
      drawProjectile(ctx, p, now, projColor(p.damageType));
    }

    ctx.fillStyle = palette.friendly.hero;
    ctx.beginPath();
    ctx.moveTo(session.hero.x, session.hero.y + 26);
    ctx.lineTo(session.hero.x - 20, session.hero.y - 16);
    ctx.lineTo(session.hero.x + 20, session.hero.y - 16);
    ctx.closePath();
    ctx.fill();
  }

  let acc = 0;
  let last = performance.now();
  let lastStats = 0;
  function frame(nowMs: number): void {
    const dtF = Math.min((nowMs - last) / 1000, 0.25);
    acc += dtF;
    last = nowMs;
    while (acc >= 1 / 30) {
      session.step();
      acc -= 1 / 30;
    }
    // 连续出怪：每 0.9s 一只，场上少于 25 只时生效
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
      refreshCardStates(); // 门控随构筑实时刷新（如拿到火属性后烈火解锁）
      lastStats = nowMs;
    }
    render();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

boot().catch((e) => {
  document.body.innerHTML = `<pre style="color:#FF6B57;padding:2em">启动失败：${(e as Error).message}</pre>`;
});
