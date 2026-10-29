/**
 * 投射物/怪物弹/伤害圈/光线段 渲染。
 * 光弹 = InstancedMesh 球（加法发光材质）+ 每实例短拖尾（退化线带用 Line2 太重，用位置历史折线）。
 * 拖尾用共享 BufferGeometry 的 LineSegments 池，控制上限。
 */
import * as THREE from 'three';
import { toX, toZ, S } from '../scene/world';
import type { DamagePool, MonsterShot, ProjectileRuntime, SegmentField } from '../../../gamecore';

const DUMMY = new THREE.Object3D();
const CAP = 220;

export class ProjectilesRender {
  private mesh: THREE.InstancedMesh;
  private colors: Float32Array;
  private trails: THREE.LineSegments;
  private trailPos: Float32Array;   // 每实例 2 点（起-今），LINES 用
  private trailAlpha: Float32Array; // 逐顶点 alpha
  private shotsMesh: THREE.InstancedMesh;
  private poolsMesh: THREE.InstancedMesh;
  private poolCap = 24;
  private beams: THREE.Mesh[] = [];

  constructor(scene: THREE.Scene) {
    // 玩家光弹
    const geo = new THREE.SphereGeometry(0.09, 8, 6);
    const mat = new THREE.MeshBasicMaterial({ toneMapped: false });
    this.mesh = new THREE.InstancedMesh(geo, mat, CAP);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 3), 3);
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    for (let i = 0; i < CAP; i++) {
      DUMMY.position.set(0, -50, 0);
      DUMMY.scale.setScalar(0.001);
      DUMMY.updateMatrix();
      this.mesh.setMatrixAt(i, DUMMY.matrix);
    }
    scene.add(this.mesh);
    this.colors = new Float32Array(CAP * 3);

    // 拖尾（每弹一条 2 段线：pos→prev1→prev2，LINES 需 3 点 4 顶点；简化为 2 点）
    const trailGeo = new THREE.BufferGeometry();
    const MAXV = CAP * 2 * 3;
    this.trailPos = new Float32Array(MAXV);
    this.trailAlpha = new Float32Array(CAP * 2);
    trailGeo.setAttribute('position', new THREE.BufferAttribute(this.trailPos, 3));
    trailGeo.setAttribute('aAlpha', new THREE.BufferAttribute(this.trailAlpha, 1));
    const trailMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */`
        attribute float aAlpha; varying float vA;
        void main(){ vA = aAlpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: /* glsl */`
        varying float vA;
        void main(){ gl_FragColor = vec4(1.0, 1.0, 1.0, vA * 0.5); }`,
    });
    this.trails = new THREE.LineSegments(trailGeo, trailMat);
    this.trails.frustumCulled = false;
    scene.add(this.trails);

    // 怪物远程弹（矛/石）
    const shotGeo = new THREE.SphereGeometry(0.14, 6, 5);
    const shotMat = new THREE.MeshBasicMaterial({ color: '#FFD54F', toneMapped: false });
    this.shotsMesh = new THREE.InstancedMesh(shotGeo, shotMat, 60);
    this.shotsMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.shotsMesh.frustumCulled = false;
    for (let i = 0; i < 60; i++) {
      DUMMY.position.set(0, -50, 0);
      DUMMY.scale.setScalar(0.001);
      DUMMY.updateMatrix();
      this.shotsMesh.setMatrixAt(i, DUMMY.matrix);
    }
    scene.add(this.shotsMesh);

    // 地面伤害圈（弹坑）：薄圆柱 + 半透明
    const poolGeo = new THREE.CylinderGeometry(1, 1, 0.02, 20, 1, false);
    const poolMat = new THREE.MeshBasicMaterial({
      color: '#FF5A3C', transparent: true, opacity: 0.32, depthWrite: false, toneMapped: false,
    });
    this.poolsMesh = new THREE.InstancedMesh(poolGeo, poolMat, this.poolCap);
    this.poolsMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.poolsMesh.frustumCulled = false;
    for (let i = 0; i < this.poolCap; i++) {
      DUMMY.position.set(0, -50, 0);
      DUMMY.scale.setScalar(0.001);
      DUMMY.updateMatrix();
      this.poolsMesh.setMatrixAt(i, DUMMY.matrix);
    }
    scene.add(this.poolsMesh);
  }

  private trailCursor = 0;

  sync(
    projectiles: ProjectileRuntime[],
    shots: MonsterShot[],
    pools: DamagePool[],
    segments: SegmentField[],
    ownerX: number,
    ownerY: number,
  ): void {
    // ---- 玩家光弹 + 拖尾 ----
    let n = 0;
    for (const p of projectiles) {
      if (n >= CAP) break;
      const x = toX(p.x);
      const z = toZ(p.y);
      const h = 0.35 + (p.height ?? 0) * S;
      DUMMY.position.set(x, h, z);
      const isBomb = p.weapon.cfg.shape === 'bomb' || p.weapon.cfg.ghost === true;
      DUMMY.scale.setScalar(isBomb ? 2.2 : 1.6);
      DUMMY.updateMatrix();
      this.mesh.setMatrixAt(n, DUMMY.matrix);
      const c = new THREE.Color(p.damageType === 'physical' ? '#F5F5FA'
        : p.damageType === 'fire' ? '#FF5A3C'
        : p.damageType === 'frost' ? '#4FC3F7'
        : p.damageType === 'lightning' ? '#B388FF' : '#7CB342');
      this.mesh.setColorAt(n, c);
      // 拖尾：当前 → 上一帧位置（×4 拉长速度线）
      const px = toX(p.px);
      const pz = toZ(p.py);
      const vx = (x - px) * 4;
      const vz = (z - pz) * 4;
      const vi = (n * 2) * 3;
      this.trailPos[vi] = x - vx; this.trailPos[vi + 1] = h; this.trailPos[vi + 2] = z - vz;
      this.trailPos[vi + 3] = x; this.trailPos[vi + 4] = h; this.trailPos[vi + 5] = z;
      this.trailAlpha[n * 2] = 0.0;
      this.trailAlpha[n * 2 + 1] = 0.85;
      n++;
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    // 未用拖尾顶点藏到远处
    for (let i = n; i < CAP; i++) {
      const vi = (i * 2) * 3;
      for (let k = 0; k < 6; k++) this.trailPos[vi + k] = 0;
      this.trailAlpha[i * 2] = 0;
      this.trailAlpha[i * 2 + 1] = 0;
    }
    (this.trails.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.trails.geometry.getAttribute('aAlpha') as THREE.BufferAttribute).needsUpdate = true;

    // ---- 怪物远程弹（抛物线由逻辑层 height 字段给出） ----
    let sn = 0;
    for (const s of shots) {
      if (sn >= 60) break;
      DUMMY.position.set(toX(s.x), 0.4 + s.height * S, toZ(s.y));
      DUMMY.scale.setScalar(s.kind === 'rock' ? 1.6 : 1);
      DUMMY.rotation.set(0, 0, 0);
      DUMMY.updateMatrix();
      this.shotsMesh.setMatrixAt(sn++, DUMMY.matrix);
    }
    this.shotsMesh.count = sn;
    this.shotsMesh.instanceMatrix.needsUpdate = true;

    // ---- 地面伤害圈 ----
    let pn = 0;
    for (const pool of pools) {
      if (pn >= this.poolCap) break;
      DUMMY.position.set(toX(pool.x), 0.02, toZ(pool.y));
      DUMMY.scale.set(pool.radius * S, 1, pool.radius * S);
      DUMMY.updateMatrix();
      this.poolsMesh.setMatrixAt(pn++, DUMMY.matrix);
    }
    this.poolsMesh.count = pn;
    this.poolsMesh.instanceMatrix.needsUpdate = true;

    // ---- 光束/连线段（followOwner 时锚定英雄） ----
    for (const b of this.beams) b.visible = false;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      let ax = seg.ax, ay = seg.ay;
      if (seg.followOwner) {
        ax = ownerX; ay = ownerY;
      }
      const bx = seg.followOwner ? ax + Math.cos(seg.angle ?? 0) * (seg.length ?? 0) : seg.bx;
      const by = seg.followOwner ? ay + Math.sin(seg.angle ?? 0) * (seg.length ?? 0) : seg.by;
      let beam = this.beams[i];
      if (!beam) {
        beam = new THREE.Mesh(
          new THREE.CylinderGeometry(0.045, 0.045, 1, 6, 1, true),
          new THREE.MeshBasicMaterial({
            color: '#B388FF', transparent: true, opacity: 0.75,
            blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
          }),
        );
        this.beams.push(beam);
        beam.frustumCulled = false;
        this.beams[i].parent?.remove(beam);
        // 需要场景引用 —— 由构造时传入的 scene 添加
        (beam as unknown as { __inScene?: boolean }).__inScene = true;
        if (!beam.parent) {
          // 延迟加入：用 mesh.onBeforeRender 前 add 的兜底（保存 scene 引用）
          this.pendingScene?.add(beam);
        }
      }
      beam.visible = true;
      const a = new THREE.Vector3(toX(ax), 0.5, toZ(ay));
      const b3 = new THREE.Vector3(toX(bx), 0.5, toZ(by));
      const mid = a.clone().add(b3).multiplyScalar(0.5);
      beam.position.copy(mid);
      beam.scale.y = a.distanceTo(b3);
      beam.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        b3.clone().sub(a).normalize(),
      );
    }
    void this.trailCursor;
  }

  private pendingScene: THREE.Scene | null = null;

  /** 构造后调用一次，供延迟创建的光束加入场景 */
  setScene(scene: THREE.Scene): void {
    this.pendingScene = scene;
  }
}
