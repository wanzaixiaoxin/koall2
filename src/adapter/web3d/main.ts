/**
 * 3D 适配层主入口：加载配置 → 构建会话/世界 → 主循环（固定 30Hz 逻辑 + rAF 渲染）。
 * 契约与 2D 适配层相同：只读快照 + 事件订阅，禁止回写会话。
 */
import * as THREE from 'three';
import {
  GameSession, LevelConfig, MonsterConfig, WeaponConfig, CardConfig, TICK_DT, xpNeed,
} from '../../gamecore';
import type { MonsterRuntime } from '../../gamecore';
import { greedyDpsPolicy } from '../../../tools/sim/policies';
import { buildWorld, toX, toZ, WorldRefs } from './scene/world';
import { CameraRig, wallThreatDist } from './camera-rig';
import { Input3D } from './input3d';
import { HeroRender } from './render/hero-render';
import { MonstersRender } from './render/monsters-render';
import { ProjectilesRender } from './render/projectiles-render';
import { Fx3D } from './render/fx3d';
import { FloatsRender } from './render/floats';
import { GemsRender } from './render/gems-render';
import { ThreatHud } from './threat-hud';
import { Vector3 } from 'three';

interface Palette { damageType: Record<string, string> }

async function fetchJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`加载失败: ${url}`);
  return r.json() as Promise<T>;
}

async function boot(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const [palette, weaponsFile, monstersFile, cardsFile, level] = await Promise.all([
    fetchJson<Palette>('/configs/art-style/palette.json'),
    fetchJson<{ weapons: WeaponConfig[] }>('/configs/weapons.json'),
    fetchJson<{ monsters: MonsterConfig[] }>('/configs/monsters.json'),
    fetchJson<{ cards: CardConfig[] }>('/configs/cards.json'),
    fetchJson<LevelConfig>(`/configs/levels/${params.get('level') ?? 'level_1_1.json'}`),
  ]);

  const world: WorldRefs = buildWorld(level);
  const canvas = world.renderer.domElement;
  canvas.style.cssText = 'display:block;width:100vw;height:100vh;touch-action:none;';
  document.body.appendChild(canvas);
  document.body.style.cssText = 'margin:0;overflow:hidden;background:#07080F;';

  // ---------- HUD ----------
  const hud = document.createElement('div');
  hud.style.cssText = `
    position:fixed;top:12px;left:50%;transform:translateX(-50%);width:min(680px,92vw);
    pointer-events:none;z-index:10;font-family:"PingFang SC","Microsoft YaHei",sans-serif;color:#F5F5FA;`;
  hud.innerHTML = `
    <div class="bar" style="position:relative;height:12px;border-radius:6px;background:rgba(255,255,255,.12);overflow:hidden;margin-bottom:6px;">
      <div id="w3wall" style="height:100%;width:100%;background:#3D4470;border-radius:6px;transition:width .15s;"></div>
      <span id="w3walltext" style="position:absolute;right:6px;top:-1px;font-size:10px;line-height:12px;text-shadow:0 1px 2px #000;"></span>
    </div>
    <div class="bar" style="position:relative;height:8px;border-radius:4px;background:rgba(255,255,255,.12);overflow:hidden;">
      <div id="w3xp" style="height:100%;width:0%;background:#35E0C3;border-radius:4px;transition:width .15s;"></div>
    </div>
    <div id="w3text" style="font-size:12px;margin-top:5px;text-shadow:0 1px 4px #000;letter-spacing:.05em;"></div>`;
  document.body.appendChild(hud);

  const banner = document.createElement('div');
  banner.style.cssText = `
    position:fixed;top:20%;width:100%;text-align:center;color:#FFD54F;font-size:30px;font-weight:700;
    letter-spacing:.2em;text-shadow:0 2px 12px rgba(0,0,0,.8);opacity:0;transition:opacity .3s;
    pointer-events:none;z-index:10;font-family:"PingFang SC","Microsoft YaHei",sans-serif;`;
  document.body.appendChild(banner);

  const cardsOverlay = document.createElement('div');
  cardsOverlay.style.cssText = `
    position:fixed;inset:0;display:none;flex-direction:column;align-items:center;justify-content:center;
    gap:24px;background:rgba(7,8,15,.72);backdrop-filter:blur(3px);z-index:20;
    font-family:"PingFang SC","Microsoft YaHei",sans-serif;`;
  document.body.appendChild(cardsOverlay);

  const overOverlay = document.createElement('div');
  overOverlay.style.cssText = cardsOverlay.style.cssText + 'background:rgba(7,8,15,.85);';
  document.body.appendChild(overOverlay);

  const hint = document.createElement('div');
  hint.style.cssText = `
    position:fixed;bottom:12px;width:100%;text-align:center;color:rgba(245,245,250,.4);font-size:12px;
    pointer-events:none;z-index:10;font-family:"PingFang SC","Microsoft YaHei",sans-serif;`;
  hint.textContent = 'WASD / 方向键移动（或按住拖拽）· 数字键 1~3 选卡 · 3D 版';
  document.body.appendChild(hint);

  const el = <T extends HTMLElement>(id: string): T => hud.querySelector(`#${id}`) as T;
  const wallBar = el<HTMLDivElement>('w3wall');
  const wallText = el<HTMLSpanElement>('w3walltext');
  const xpBar = el<HTMLDivElement>('w3xp');
  const hudText = el<HTMLDivElement>('w3text');

  // ---------- 输入 + 会话 ----------
  const input = new Input3D(canvas);
  const session = new GameSession({
    level,
    weaponConfigs: [
      weaponsFile.weapons.find((w) => w.id === params.get('weapon')) ?? weaponsFile.weapons[0],
    ],
    monsterConfigs: new Map(monstersFile.monsters.map((m) => [m.id, m])),
    cardConfigs: cardsFile.cards,
    seed: (Date.now() % 100000) | 0,
    controller: input,
    cardPolicy: greedyDpsPolicy,
  });
  session.externalLevelUps = true;

  // ---------- 渲染器 ----------
  const rig = new CameraRig(world.camera);
  const hero = new HeroRender(world.scene, world.lantern);
  const monstersR = new MonstersRender(world.scene);
  const projR = new ProjectilesRender(world.scene);
  projR.setScene(world.scene);
  const fx = new Fx3D(world.scene);
  const floats = new FloatsRender(new Vector3());
  const gems = new GemsRender(world.scene);
  const threat = new ThreatHud();
  const wallHitMarks: number[] = [];   // 本帧城墙受击 x（罗盘用）

  const SHAPE_COLOR: Record<string, string> = {
    slime: '#7CB342', larva: '#9CCC65', wolf: '#FF6B57', charger: '#FF8A50',
    thrower: '#C0CA33', shaman: '#B388FF', bulwark: '#8A93B8', ultra: '#FF3D71',
    bat: '#9575CD', shroom: '#66BB6A', roach: '#A1887F', lurker: '#78909C',
    baneling: '#FFEA00', zqueen: '#B537F2', boss: '#B537F2',
  };
  const dmgColor = (t: string): string => palette.damageType[t] ?? '#F5F5FA';

  // ---------- 事件接线 ----------
  let bannerTimer = 0;
  let currentWaveNo = 0;
  session.bus.on<{ index: number; banner: string }>('onWaveStart', ({ index, banner: b }) => {
    currentWaveNo = index;
    banner.textContent = b;
    banner.style.opacity = '1';
    bannerTimer = 2.2;
  });

  session.bus.on<{ dmg: number; x: number; y: number }>('onWallHit', ({ dmg, x }) => {
    // 墙段红闪 + 砖屑 + 微震
    const halfW = (level.arena.width / 2) / 100;
    const segIdx = Math.max(0, Math.min(11, Math.floor(((toX(x)) + halfW) / (halfW * 2) * 12)));
    world.wallFlash[segIdx] = 0.18;
    fx.wallDebris(x);
    rig.shake(0.06);
    floats.push(toX(x), 2.2, 1.2, `-${Math.round(dmg)}`, '#FF6B57', 17);
    wallHitMarks.push(x);
  });

  session.bus.on<Record<string, never>>('onShoot', () => {
    world.muzzleLife = 0.05;
  });

  session.bus.on<{ x: number; y: number; radius: number }>('onExplode', ({ x, y, radius }) => {
    fx.explode(x, y, radius);
    rig.shake(0.1);
  });

  session.bus.on<{ points: number[][] }>('onChain', ({ points }) => {
    for (const p of points) fx.bolt(p[0], p[1]);
  });

  session.bus.on<{ x: number; y: number; radius: number }>('onHeal', ({ x, y, radius }) => {
    fx.heal(x, y, radius);
  });

  session.bus.on<{ monsterId: number; dmg: number; isCrit: boolean; blocked: boolean; mitigated: number; x: number; y: number }>('onHit',
    ({ monsterId, dmg, isCrit, blocked, mitigated, x, y }) => {
      const m: MonsterRuntime | undefined = session.monsters[monsterId];
      const shape = m?.cfg.shape ?? 'slime';
      if (monsterId !== undefined && !blocked) monstersR.markHit(monsterId, shape);
      if (!blocked) fx.hit(x, y, dmgColor(m?.cfg ? 'physical' : 'physical'), 4);
      if (blocked) {
        floats.push(toX(x), 0.8, toZ(y), '挡', '#8A93B8', 15);
        return;
      }
      if (mitigated > 0) {
        floats.push(toX(x) + 0.2, 0.7, toZ(y), `抵${mitigated}`, '#8A93B8', 12);
      }
      floats.push(
        toX(x) + (Math.random() - 0.5) * 0.24, 0.75, toZ(y),
        String(Math.round(dmg)), isCrit ? '#FFD54F' : '#F5F5FA', isCrit ? 30 : 19,
      );
    });

  session.bus.on<{ monsterId: number; key: string }>('onKill', ({ monsterId, key }) => {
    const m = session.monsters[monsterId];
    const kx = m?.x ?? 0;
    const ky = m?.y ?? 0;
    fx.death(toX(kx), toZ(ky), SHAPE_COLOR[m?.cfg.shape ?? 'slime'] ?? '#FF6B57');
    gems.spawn(toX(kx), toZ(ky));
    void key;
  });

  session.bus.on<{ dmg: number; x: number; y: number }>('onBurnTick', ({ dmg, x, y }) => {
    floats.push(toX(x), 0.6, toZ(y), String(Math.round(dmg * 10) / 10), '#FF9A3C', 13);
  });

  session.bus.on<{ dmg: number; x: number; y: number }>('onPoolTick', ({ dmg, x, y }) => {
    floats.push(toX(x), 0.5, toZ(y), String(dmg), '#FF6B57', 12);
  });

  session.bus.on<{ x: number; y: number; amount: number }>('onHealed', ({ x, y, amount }) => {
    floats.push(toX(x), 1.0, toZ(y), `+${amount}`, '#7CB342', 14);
  });

  session.bus.on<{ level: number }>('onLevelUpPending', () => {
    fx.heal(session.hero.x, session.hero.y, 60);
  });

  session.bus.on<{ result: string }>('onGameOver', ({ result }) => {
    const ratio = session.wallHp / session.wallMaxHp;
    const stars = result === 'victory'
      ? '★'.repeat(ratio > 0.7 ? 3 : ratio > 0.4 ? 2 : 1)
      : '☆';
    overOverlay.innerHTML =
      `<div style="color:#F5F5FA;font-size:42px;font-weight:800;letter-spacing:.3em;">${result === 'victory' ? '守 城 成 功' : '城 墙 陷 落'}</div>` +
      `<div style="color:#FFD54F;font-size:38px;letter-spacing:.2em;">${stars}</div>` +
      `<div style="color:rgba(245,245,250,.6);font-size:15px;">击杀 ${session.totalKills} · 等级 ${session.hero.level} · 用时 ${session.timeSec.toFixed(0)}s</div>` +
      `<div style="margin-top:10px;"><button onclick="location.reload()" style="padding:12px 44px;font-size:18px;border:none;border-radius:999px;background:#35E0C3;color:#0B0C1D;font-weight:700;cursor:pointer;">再来一局</button></div>`;
    overOverlay.style.display = 'flex';
  });

  // ---------- 卡牌 UI ----------
  let cardsShown = false;
  function refreshCards(): void {
    const pending = session.pendingLevelChoices;
    if (pending.length > 0 && !cardsShown) {
      cardsShown = true;
      cardsOverlay.innerHTML = '<div style="color:#FFD54F;font-size:24px;letter-spacing:.35em;font-weight:700;">升 级 · 三 选 一</div><div style="display:flex;gap:20px;"></div>';
      const row = cardsOverlay.lastChild as HTMLDivElement;
      pending.forEach((c, i) => {
        const div = document.createElement('div');
        div.style.cssText = `
          width:200px;padding:24px 16px 20px;border-radius:14px;cursor:pointer;text-align:center;
          background:#12142B;border:2px solid #F5F5FA;transition:transform .12s, box-shadow .12s;`;
        div.onmouseenter = () => { div.style.transform = 'translateY(-6px) scale(1.03)'; };
        div.onmouseleave = () => { div.style.transform = 'none'; };
        const typeTag = { bullet: '子弹', wall: '城墙', form: '形态', passive: '属性', element: '元素' }[c.type];
        div.innerHTML =
          `<div style="font-size:11px;letter-spacing:.2em;padding:2px 10px;border-radius:999px;margin-bottom:10px;display:inline-block;color:#0B0C1D;font-weight:700;background:#4FC3F7;">${typeTag}</div>` +
          `<div style="color:#F5F5FA;font-size:20px;font-weight:700;margin-bottom:8px;">${c.name}</div>` +
          `<div style="color:rgba(245,245,250,.65);font-size:13px;">${c.desc ?? ''}</div>` +
          `<div style="position:relative;margin-top:8px;color:rgba(255,255,255,.35);font-size:12px;">按 ${i + 1}</div>`;
        div.onclick = () => {
          session.resolveLevelUp(c);
        };
        row.appendChild(div);
      });
      cardsOverlay.style.display = 'flex';
      (cardsOverlay as unknown as { _c?: CardConfig[] })._c = pending;
    } else if (pending.length === 0 && cardsShown) {
      cardsShown = false;
      cardsOverlay.style.display = 'none';
    }
  }
  window.addEventListener('keydown', (e) => {
    const n = Number(e.key);
    if (n >= 1 && n <= 3) {
      const choices = (cardsOverlay as unknown as { _c?: CardConfig[] })._c;
      if (choices?.[n - 1]) session.resolveLevelUp(choices[n - 1]);
    }
  });

  // ---------- 主循环 ----------
  let last = performance.now();
  let acc = 0;
  let prevRenderMs = 0;

  function frame(nowMs: number): void {
    requestAnimationFrame(frame);
    const dtReal = Math.min((nowMs - last) / 1000, 0.1);
    last = nowMs;
    const dtR = Math.min(0.05, (nowMs - prevRenderMs) / 1000 || 0.016);
    prevRenderMs = nowMs;

    const paused = session.pendingLevelChoices.length > 0 || session.result !== null;
    acc += dtReal;
    while (acc >= TICK_DT && !paused) {
      session.step();
      acc -= TICK_DT;
    }
    if (paused) acc = 0;

    refreshCards();

    // ---- 同步英雄 ----
    hero.setTarget(toX(session.hero.x), toZ(session.hero.y));
    const heroPos = hero.update(dtR, session.timeSec);
    gems.setHero(heroPos.x, heroPos.z);

    // ---- 同步怪物/投射物 ----
    monstersR.sync(session.monsters, session.timeSec, dtR);
    projR.sync(session.projectiles, session.monsterShots, session.pools, session.segments,
      session.hero.x, session.hero.y);

    // ---- 枪口闪光 ----
    if (world.muzzleLife > 0) {
      world.muzzleLife -= dtR;
      world.muzzle.intensity = 10;
      world.muzzle.position.set(heroPos.x, 1.0, heroPos.z - 0.5);
    } else {
      world.muzzle.intensity = 0;
    }

    // ---- 城墙受击红闪 ----
    for (let i = 0; i < world.wallSegments.length; i++) {
      const mesh = world.wallSegments[i];
      const mat = mesh.material as THREE.MeshStandardMaterial;
      if (world.wallFlash[i] > 0) {
        world.wallFlash[i] -= dtR;
        mat.emissive.set('#FF3D71');
        mat.emissiveIntensity = 0.8;
      } else {
        const ratio = session.wallHp / session.wallMaxHp;
        if (ratio < 0.3) {
          mat.emissive.set('#FF3D71');
          mat.emissiveIntensity = 0.25 + Math.sin(session.timeSec * 4) * 0.15;
        } else {
          mat.emissiveIntensity = 0;
        }
      }
    }

    // ---- 粒子/飘字/宝石 ----
    fx.update(dtR);
    gems.update(dtR);
    floats.update(world.camera, window.innerWidth, window.innerHeight, dtR);

    // ---- 威胁三件套 ----
    threat.update(session.monsters, wallHitMarks, session.wallHp / session.wallMaxHp);
    wallHitMarks.length = 0;

    // ---- 横幅计时 ----
    if (bannerTimer > 0) {
      bannerTimer -= dtR;
      if (bannerTimer <= 0) banner.style.opacity = '0';
    }

    // ---- HUD ----
    wallBar.style.width = `${(session.wallHp / session.wallMaxHp) * 100}%`;
    wallText.textContent = `城防 ${Math.ceil(session.wallHp)}/${session.wallMaxHp}`;
    xpBar.style.width = `${(session.hero.xp / xpNeed(session.hero.level)) * 100}%`;
    hudText.textContent = `第 ${Math.max(1, currentWaveNo)}/${level.waves.length} 波 · 等级 ${session.hero.level} · 击杀 ${session.totalKills}`;

    // ---- 镜头 ----
    rig.update(heroPos, wallThreatDist(session.monsters), dtR);
    world.renderer.render(world.scene, world.camera);
  }
  requestAnimationFrame(frame);
}

boot().catch((e) => {
  document.body.innerHTML =
    `<pre style="color:#FF6B57;padding:2em;font-family:monospace;">3D 版启动失败：${(e as Error).message}\n${(e as Error).stack ?? ''}</pre>`;
});
