/**
 * 怪物 InstancedMesh 池（docs3d/00 §2.1）：按形态分池，共享几何/材质。
 * 每池独立实例矩阵+血条隐色（instanceColor 承载受击闪白与血量染色）。
 * 形态语言（docs/06 3D 转译）：全部低模几何 + 程序动画（update 内 squash/前倾/旋转）。
 */
import * as THREE from 'three';
import { toX, toZ, S } from '../scene/world';
import type { MonsterRuntime } from '../../../gamecore';

interface Pool {
  key: string;
  mesh: THREE.InstancedMesh;
  radius: number;         // 该形态基准半径（米）
  items: Map<number, number>;  // monsterId → instance index
  next: number[];
  offset: Float32Array;   // 每实例相位（程序动画用）
  flash: Float32Array;    // 每实例受击闪白剩余时间
}

const DUMMY = new THREE.Object3D();
const COLOR_HIT = new THREE.Color('#FFFFFF');
const SHADOW_CAP = 400;

/** 径向渐变软阴影贴图（接触阴影：让怪物"踩"在地面上，体积感的主要来源） */
function makeShadowTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 2, 32, 32, 32);
  grad.addColorStop(0, 'rgba(0,0,0,0.5)');
  grad.addColorStop(0.6, 'rgba(0,0,0,0.28)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

/** 形态 → 几何构建器（半径 r 米）；细分档提升，保证近景曲面圆滑 */
const GEO_BUILDERS: Record<string, (r: number) => THREE.BufferGeometry> = {
  slime: (r) => { const g = new THREE.IcosahedronGeometry(r, 2); g.scale(1.25, 0.7, 1.25); return g; },
  larva: (r) => { const g = new THREE.IcosahedronGeometry(r * 0.7, 2); g.scale(1.2, 0.7, 1.2); return g; },
  wolf: (r) => { const g = new THREE.ConeGeometry(r * 0.8, r * 2.6, 8); g.rotateX(Math.PI / 2); return g; },
  charger: (r) => { const g = new THREE.ConeGeometry(r * 0.9, r * 2.4, 8); g.rotateX(Math.PI / 2); return g; },
  thrower: (r) => new THREE.BoxGeometry(r * 1.4, r * 1.8, r * 1.2),
  shaman: (r) => { const g = new THREE.OctahedronGeometry(r * 1.2, 1); g.scale(0.8, 1.3, 0.8); return g; },
  bulwark: (r) => new THREE.BoxGeometry(r * 2.0, r * 1.8, r * 1.4),
  ultra: (r) => new THREE.DodecahedronGeometry(r * 1.4, 1),
  bat: (r) => { const g = new THREE.OctahedronGeometry(r, 1); g.scale(1.5, 0.55, 1.1); return g; },
  shroom: (r) => { const g = new THREE.SphereGeometry(r, 16, 12, 0, Math.PI * 2, 0, Math.PI / 2); return g; },
  roach: (r) => { const g = new THREE.CapsuleGeometry(r * 0.6, r * 1.2, 4, 12); g.rotateX(Math.PI / 2); return g; },
  lurker: (r) => { const g = new THREE.ConeGeometry(r * 0.8, r * 1.8, 8); g.rotateX(-Math.PI / 2); return g; },
  baneling: (r) => { const g = new THREE.IcosahedronGeometry(r, 2); g.scale(1.1, 0.9, 1.1); return g; },
  zqueen: (r) => { const g = new THREE.OctahedronGeometry(r * 1.5, 1); g.scale(0.85, 1.4, 0.85); return g; },
  boss: (r) => new THREE.OctahedronGeometry(r * 1.6, 2),
};

const SHAPE_COLOR: Record<string, string> = {
  slime: '#7CB342', larva: '#9CCC65', wolf: '#FF6B57', charger: '#FF8A50',
  thrower: '#C0CA33', shaman: '#B388FF', bulwark: '#8A93B8', ultra: '#FF3D71',
  bat: '#9575CD', shroom: '#66BB6A', roach: '#A1887F', lurker: '#78909C',
  baneling: '#FFEA00', zqueen: '#B537F2', boss: '#B537F2',
};

const POOL_CAPS: Record<string, number> = {
  slime: 80, larva: 100, wolf: 60, charger: 50, thrower: 40, shaman: 20,
  bulwark: 30, ultra: 20, bat: 50, shroom: 30, roach: 40, lurker: 30,
  baneling: 50, zqueen: 8, boss: 3,
};

export class MonstersRender {
  private pools = new Map<string, Pool>();
  private group = new THREE.Group();
  private shadowMesh: THREE.InstancedMesh;

  constructor(scene: THREE.Scene) {
    scene.add(this.group);
    // 接触阴影池：每怪一个软圆盘，贴在地面（y≈0.012）
    const shadowGeo = new THREE.PlaneGeometry(1, 1);
    shadowGeo.rotateX(-Math.PI / 2);
    const shadowMat = new THREE.MeshBasicMaterial({
      map: makeShadowTexture(), transparent: true, depthWrite: false,
    });
    this.shadowMesh = new THREE.InstancedMesh(shadowGeo, shadowMat, SHADOW_CAP);
    this.shadowMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.shadowMesh.frustumCulled = false;
    this.shadowMesh.count = 0;
    scene.add(this.shadowMesh);
  }

  private ensurePool(key: string, radiusPx: number): Pool {
    let p = this.pools.get(key);
    if (p) return p;
    const r = Math.max(0.16, radiusPx * S);
    const geo = (GEO_BUILDERS[key] ?? GEO_BUILDERS.slime)(r);
    const cap = POOL_CAPS[key] ?? 40;
    const mat = new THREE.MeshStandardMaterial({
      color: SHAPE_COLOR[key] ?? '#FF6B57',
      roughness: 0.35, metalness: 0.1,
      emissive: new THREE.Color(SHAPE_COLOR[key] ?? '#FF6B57').multiplyScalar(1.3),
    });
    const mesh = new THREE.InstancedMesh(geo, mat, cap);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;   // 池内实例动态分布，整池不裁剪（实例级由距离裁剪兜底）
    mesh.count = cap;
    // 未用实例缩到 0 藏住
    for (let i = 0; i < cap; i++) {
      DUMMY.position.set(0, -50, 0);
      DUMMY.scale.setScalar(0.001);
      DUMMY.updateMatrix();
      mesh.setMatrixAt(i, DUMMY.matrix);
    }
    this.group.add(mesh);
    p = {
      key, mesh, radius: r,
      items: new Map(),
      next: Array.from({ length: cap }, (_, i) => cap - 1 - i),
      offset: new Float32Array(cap).map(() => Math.random() * Math.PI * 2),
      flash: new Float32Array(cap),
    };
    this.pools.set(key, p);
    return p;
  }

  markHit(id: number, shape: string): void {
    const p = this.pools.get(shape);
    if (!p) return;
    const idx = p.items.get(id);
    if (idx !== undefined) p.flash[idx] = 0.09;
  }

  /** 每渲染帧同步；nowSec 为会话时间（程序动画基准，保持确定性观感） */
  sync(monsters: MonsterRuntime[], nowSec: number, dt: number): void {
    const aliveIds = new Set<number>();
    for (const m of monsters) aliveIds.add(m.id);
    let sn = 0; // 接触阴影实例计数
    for (const m of monsters) {
      const shape = m.cfg.shape ?? 'slime';
      const p = this.ensurePool(shape, m.cfg.radius);
      let idx = p.items.get(m.id);
      if (idx === undefined) {
        idx = p.next.pop();
        if (idx === undefined) continue;  // 池满（超预算），跳过渲染
        p.items.set(m.id, idx);
      }
      const bob = Math.sin(nowSec * 6 + p.offset[idx]) * 0.06;
      const buried = m.burrowed ? 0.001 : 1;
      // 呼吸发光：每实例相位错开，深色地面也能一眼分辨
      const glowPulse = 0.7 + Math.sin(nowSec * 5 + p.offset[idx]) * 0.3;
      const sq = 1 + Math.sin(nowSec * 9 + p.offset[idx]) * 0.07; // squash&stretch 脉动
      DUMMY.position.set(toX(m.x), p.radius * buried + bob, toZ(m.y));
      DUMMY.rotation.set(0, Math.sin(nowSec * 1.3 + p.offset[idx]) * 0.25, 0);
      DUMMY.scale.set(1 * sq * buried, (2 - sq) * buried, 1 * sq * buried);
      DUMMY.updateMatrix();
      p.mesh.setMatrixAt(idx, DUMMY.matrix);

      // 接触阴影：贴地软圆盘（钻地时隐藏）
      if (sn < SHADOW_CAP) {
        DUMMY.position.set(toX(m.x), 0.012, toZ(m.y));
        DUMMY.rotation.set(0, 0, 0);
        DUMMY.scale.setScalar(m.burrowed ? 0.001 : p.radius * 2.6);
        DUMMY.updateMatrix();
        this.shadowMesh.setMatrixAt(sn++, DUMMY.matrix);
      }

      // 颜色：受击闪白 > 血量染色（低血偏暗红）
      const base = new THREE.Color(SHAPE_COLOR[shape] ?? '#FF6B57');
      const flash = p.flash[idx];
      if (flash > 0) {
        p.flash[idx] = Math.max(0, flash - dt);
        base.lerp(COLOR_HIT, Math.min(1, flash / 0.09));
      } else {
        const hpr = m.hp / m.maxHp;
        if (hpr < 0.5) base.multiplyScalar(0.55 + hpr * 0.9);
      }
      base.multiplyScalar(glowPulse);
      p.mesh.setColorAt(idx, base);
    }

    // 回收消失实例 + 提交
    this.shadowMesh.count = sn;
    this.shadowMesh.instanceMatrix.needsUpdate = true;
    for (const p of this.pools.values()) {
      for (const [id, idx] of p.items) {
        if (!aliveIds.has(id)) {
          DUMMY.position.set(0, -50, 0);
          DUMMY.scale.setScalar(0.001);
          DUMMY.updateMatrix();
          p.mesh.setMatrixAt(idx, DUMMY.matrix);
          p.next.push(idx);
          p.items.delete(id);
        }
      }
      p.mesh.instanceMatrix.needsUpdate = true;
      if (p.mesh.instanceColor) p.mesh.instanceColor.needsUpdate = true;
    }
  }
}
