/**
 * 掉落渲染：经验宝石（击杀掉落，自动吸收——逻辑层结算，渲染层只做视觉）。
 * 逻辑层没有掉落实体（xp 自动入账），这里订阅 onKill 生成视觉宝石：
 * 从怪物尸体弹出 → 弹跳落地 → 0.3s 后飞向英雄（纯表现）。
 * 血瓶掉落逻辑层同样没有（2D 版也没实现），先不做。
 */
import * as THREE from 'three';
import { toX, toZ, S } from '../scene/world';

const CAP = 60;
const DUMMY = new THREE.Object3D();

interface Gem {
  x: number; z: number;      // 世界坐标
  vx: number; vz: number;    // 弹开速度
  y: number; vy: number;
  t: number;                 // 存活时间
  phase: 'burst' | 'fly';
}

export class GemsRender {
  private mesh: THREE.InstancedMesh;
  private gems: Gem[] = [];
  private heroPos = { x: 0, z: 0 };

  constructor(scene: THREE.Scene) {
    const geo = new THREE.OctahedronGeometry(0.13, 0);
    const mat = new THREE.MeshBasicMaterial({ color: '#4FC3F7', toneMapped: false });
    this.mesh = new THREE.InstancedMesh(geo, mat, CAP);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    for (let i = 0; i < CAP; i++) {
      DUMMY.position.set(0, -50, 0);
      DUMMY.scale.setScalar(0.001);
      DUMMY.updateMatrix();
      this.mesh.setMatrixAt(i, DUMMY.matrix);
    }
    scene.add(this.mesh);
  }

  /** onKill：尸体位置弹出宝石（世界坐标入口） */
  spawn(wx: number, wz: number): void {
    if (this.gems.length >= CAP) this.gems.shift();
    const a = Math.random() * Math.PI * 2;
    this.gems.push({
      x: wx, z: wz,
      vx: Math.cos(a) * (0.6 + Math.random() * 1.2),
      vz: Math.sin(a) * (0.6 + Math.random() * 1.2),
      y: 0.35, vy: 2 + Math.random() * 1.5,
      t: 0, phase: 'burst',
    });
  }

  setHero(wx: number, wz: number): void {
    this.heroPos.x = wx;
    this.heroPos.z = wz;
  }

  update(dt: number): void {
    for (let i = this.gems.length - 1; i >= 0; i--) {
      const g = this.gems[i];
      g.t += dt;
      if (g.phase === 'burst') {
        g.vy -= 9 * dt;
        g.x += g.vx * dt;
        g.z += g.vz * dt;
        g.y += g.vy * dt;
        if (g.y < 0.12) {
          g.y = 0.12;
          g.vy *= -0.45;
          g.vx *= 0.7;
          g.vz *= 0.7;
        }
        if (g.t > 0.4) g.phase = 'fly';
      } else {
        // 磁吸飞向英雄（视觉速度 12m/s，加速）
        const dx = this.heroPos.x - g.x;
        const dz = this.heroPos.z - g.z;
        const d = Math.hypot(dx, dz);
        if (d < 0.5) {
          this.gems.splice(i, 1);
          continue;
        }
        const sp = Math.min(22, 6 + g.t * 14);
        g.x += (dx / d) * sp * dt;
        g.z += (dz / d) * sp * dt;
        g.y += (1.0 - g.y) * 6 * dt;
      }
    }
    let n = 0;
    for (const g of this.gems) {
      if (n >= CAP) break;
      DUMMY.position.set(g.x, g.y + Math.sin(g.t * 8) * 0.04, g.z);
      DUMMY.rotation.set(0, g.t * 4, 0);
      DUMMY.scale.setScalar(1);
      DUMMY.updateMatrix();
      this.mesh.setMatrixAt(n++, DUMMY.matrix);
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
