/**
 * 3D 粒子特效运行时：命中火花 / 爆炸火球+冲击环 / 落雷光柱 / 治疗上升粒子。
 * 单一 Points 池（加法混合），每粒子 {pos, vel, life, maxLife, size, color}。
 * 冲击环/光柱用短寿命 Mesh 池。
 */
import * as THREE from 'three';
import { toX, toZ, S } from '../scene/world';

const MAX_P = 900;

interface P {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  life: number; maxLife: number;
  size: number;
  r: number; g: number; b: number;
  grav: number;
}

const MAX_MESH_FX = 24;

interface MeshFx {
  mesh: THREE.Mesh;
  life: number;
  maxLife: number;
  kind: 'ring' | 'bolt' | 'flame';
  scale0: number;
  scale1: number;
}

export class Fx3D {
  private points: THREE.Points;
  private posAttr: Float32Array;
  private colAttr: Float32Array;
  private sizeAttr: Float32Array;
  private alphaAttr: Float32Array;
  private pool: P[] = [];
  private cursor = 0;
  private meshFx: MeshFx[] = [];
  private ringGeo = new THREE.RingGeometry(0.86, 1, 28);
  private flameGeo = new THREE.SphereGeometry(1, 12, 8);

  constructor(private scene: THREE.Scene) {
    const geo = new THREE.BufferGeometry();
    this.posAttr = new Float32Array(MAX_P * 3);
    this.colAttr = new Float32Array(MAX_P * 3);
    this.sizeAttr = new Float32Array(MAX_P);
    this.alphaAttr = new Float32Array(MAX_P);
    geo.setAttribute('position', new THREE.BufferAttribute(this.posAttr, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(this.colAttr, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.sizeAttr, 1));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alphaAttr, 1));
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */`
        attribute vec3 aColor; attribute float aSize; attribute float aAlpha;
        varying vec3 vC; varying float vA;
        void main(){
          vC = aColor; vA = aAlpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * (140.0 / -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        varying vec3 vC; varying float vA;
        void main(){
          vec2 d = gl_PointCoord - vec2(0.5);
          float a = smoothstep(0.5, 0.08, length(d));
          gl_FragColor = vec4(vC, a * vA);
        }`,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
  }

  private spawn(
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    life: number, size: number, color: string, grav = -6,
  ): void {
    if (this.pool.length >= MAX_P) {
      // 池满覆盖最旧（cursor 环形）
      const c = this.color(color);
      const i = this.cursor;
      this.pool[i] = { x, y, z, vx, vy, vz, life, maxLife: life, size, r: c.r, g: c.g, b: c.b, grav };
      this.cursor = (this.cursor + 1) % MAX_P;
      return;
    }
    const c = this.color(color);
    this.pool.push({ x, y, z, vx, vy, vz, life, maxLife: life, size, r: c.r, g: c.g, b: c.b, grav });
  }

  private tmpColor = new THREE.Color();
  private color(hex: string): THREE.Color {
    this.tmpColor.set(hex);
    return this.tmpColor;
  }

  // ---------- 公共特效入口（逻辑坐标） ----------

  /** 命中火花 */
  hit(lx: number, ly: number, color: string, count = 6): void {
    const x = toX(lx), z = toZ(ly);
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 1.2 + Math.random() * 2.2;
      this.spawn(x, 0.5, z, Math.cos(a) * sp, 1.5 + Math.random() * 2.4, Math.sin(a) * sp,
        0.22 + Math.random() * 0.15, 0.9 + Math.random() * 0.7, color);
    }
  }

  /** 爆炸：火球粒子 + 冲击环 */
  explode(lx: number, ly: number, radiusPx: number): void {
    const x = toX(lx), z = toZ(ly);
    const R = Math.max(0.5, radiusPx * S);
    for (let i = 0; i < 26; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 1 + Math.random() * 3.4;
      this.spawn(x, 0.35, z, Math.cos(a) * sp, 1.8 + Math.random() * 3.6, Math.sin(a) * sp,
        0.4 + Math.random() * 0.3, 2.4 + Math.random() * 2, Math.random() < 0.6 ? '#FF5A3C' : '#FFD54F');
    }
    this.addMeshFx('ring', x, z, R * 0.4, R * 1.15, 0.32, '#FF9A3C');
  }

  /** 落雷：天空光柱 + 落点火花 */
  bolt(lx: number, ly: number): void {
    const x = toX(lx), z = toZ(ly);
    this.addMeshFx('bolt', x, z, 0.5, 0.18, 0.22, '#B388FF');
    for (let i = 0; i < 10; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 0.8 + Math.random() * 1.6;
      this.spawn(x, 0.4, z, Math.cos(a) * sp, 2 + Math.random() * 3, Math.sin(a) * sp,
        0.3, 1.4, '#B388FF');
    }
  }

  /** 治疗：绿色上升粒子 */
  heal(lx: number, ly: number, radiusPx: number): void {
    const x = toX(lx), z = toZ(ly);
    const R = Math.max(0.4, radiusPx * S);
    for (let i = 0; i < 8; i++) {
      const a = Math.random() * Math.PI * 2;
      const rr = Math.random() * R;
      this.spawn(x + Math.cos(a) * rr, 0.3, z + Math.sin(a) * rr,
        0, 1.4 + Math.random() * 1.2, 0, 0.55, 1.1, '#7CB342', 0.5);
    }
  }

  /** 城墙砖屑 */
  wallDebris(lx: number): void {
    const x = toX(lx);
    for (let i = 0; i < 8; i++) {
      this.spawn(x + (Math.random() - 0.5) * 0.5, 1.2 + Math.random() * 1.4, 0.4,
        (Math.random() - 0.5) * 2.4, 1 + Math.random() * 2, 0.8 + Math.random() * 1.6,
        0.5, 1.0, '#8A93B8');
    }
  }

  /** 怪物死亡碎裂 */
  death(lx: number, ly: number, color: string): void {
    const x = toX(lx), z = toZ(ly);
    for (let i = 0; i < 10; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 1.4 + Math.random() * 2.6;
      this.spawn(x, 0.4, z, Math.cos(a) * sp, 1.2 + Math.random() * 2.6, Math.sin(a) * sp,
        0.35 + Math.random() * 0.2, 1.2, color);
    }
  }

  private addMeshFx(
    kind: 'ring' | 'bolt' | 'flame',
    x: number, z: number,
    scale0: number, scale1: number, life: number, color: string,
  ): void {
    if (this.meshFx.length >= MAX_MESH_FX) this.meshFx.shift()?.mesh.removeFromParent();
    let mesh: THREE.Mesh;
    if (kind === 'ring') {
      mesh = new THREE.Mesh(this.ringGeo, new THREE.MeshBasicMaterial({
        color, transparent: true, side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
      }));
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(x, 0.06, z);
    } else if (kind === 'bolt') {
      mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.4, 22, 8, 1, true), new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.85,
        blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
      }));
      mesh.position.set(x, 11, z);
      scale0 = 1; scale1 = 0.1;
    } else {
      mesh = new THREE.Mesh(this.flameGeo, new THREE.MeshBasicMaterial({
        color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
      }));
      mesh.position.set(x, 0.6, z);
    }
    this.scene.add(mesh);
    this.meshFx.push({ mesh, life, maxLife: life, kind, scale0, scale1 });
  }

  /** 每渲染帧推进 */
  update(dt: number): void {
    for (let i = this.pool.length - 1; i >= 0; i--) {
      const p = this.pool[i];
      p.life -= dt;
      if (p.life <= 0) {
        const last = this.pool.pop()!;
        if (i < this.pool.length) this.pool[i] = last;
        continue;
      }
      p.vy += p.grav * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      if (p.y < 0.05) { p.y = 0.05; p.vy *= -0.35; p.vx *= 0.7; p.vz *= 0.7; }
    }
    const n = Math.min(this.pool.length, MAX_P);
    for (let i = 0; i < n; i++) {
      const p = this.pool[i];
      const k = p.life / p.maxLife;
      this.posAttr[i * 3] = p.x;
      this.posAttr[i * 3 + 1] = p.y;
      this.posAttr[i * 3 + 2] = p.z;
      this.colAttr[i * 3] = p.r;
      this.colAttr[i * 3 + 1] = p.g;
      this.colAttr[i * 3 + 2] = p.b;
      this.sizeAttr[i] = p.size;
      this.alphaAttr[i] = k;
    }
    this.points.geometry.setDrawRange(0, n);
    (this.points.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.points.geometry.getAttribute('aColor') as THREE.BufferAttribute).needsUpdate = true;
    (this.points.geometry.getAttribute('aSize') as THREE.BufferAttribute).needsUpdate = true;
    (this.points.geometry.getAttribute('aAlpha') as THREE.BufferAttribute).needsUpdate = true;

    for (let i = this.meshFx.length - 1; i >= 0; i--) {
      const f = this.meshFx[i];
      f.life -= dt;
      if (f.life <= 0) {
        f.mesh.removeFromParent();
        if (f.kind === 'bolt') f.mesh.geometry.dispose();
        if (f.mesh.material instanceof THREE.Material) f.mesh.material.dispose();
        this.meshFx.splice(i, 1);
        continue;
      }
      const k = 1 - f.life / f.maxLife;
      const s = f.scale0 + (f.scale1 - f.scale0) * k;
      f.mesh.scale.setScalar(Math.max(0.001, s));
      const mat = f.mesh.material as THREE.MeshBasicMaterial;
      mat.opacity = (f.kind === 'bolt' ? 0.85 : 0.9) * (1 - k);
    }
  }
}
