/**
 * 怪物血条（billboard 点精灵，单 draw call）：只在 hp < maxHp 时显示。
 * 片元里画条形（黑底 + 亮填充 + 边框），aRatio 控制填充比，随距离缩放。
 */
import * as THREE from 'three';
import { toX, toZ, S } from '../scene/world';

const CAP = 220;

export class HpBarsRender {
  private points: THREE.Points;
  private posAttr: Float32Array;
  private ratioAttr: Float32Array;
  private sizeAttr: Float32Array;

  constructor(scene: THREE.Scene) {
    const geo = new THREE.BufferGeometry();
    this.posAttr = new Float32Array(CAP * 3);
    this.ratioAttr = new Float32Array(CAP);
    this.sizeAttr = new Float32Array(CAP);
    geo.setAttribute('position', new THREE.BufferAttribute(this.posAttr, 3));
    geo.setAttribute('aRatio', new THREE.BufferAttribute(this.ratioAttr, 1));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.sizeAttr, 1));
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      vertexShader: /* glsl */`
        attribute float aRatio; attribute float aSize;
        varying float vR;
        void main(){
          vR = aRatio;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * (60.0 / -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        varying float vR;
        void main(){
          // 条形区域（点精灵内 0.72×0.14）
          vec2 uv = gl_PointCoord - 0.5;
          if (abs(uv.x) > 0.36 || abs(uv.y) > 0.07) discard;
          vec2 b = abs(vec2(uv.x / 0.36, uv.y / 0.07));
          float border = max(b.x, b.y);
          if (border > 0.94) { gl_FragColor = vec4(0.05,0.05,0.09,0.9); return; } // 深底边框
          float fill = step(uv.x / 0.36 + 0.5, vR) * step(abs(uv.y), 0.055);
          vec3 col = vR > 0.5 ? vec3(0.42,0.95,0.55) : vR > 0.25 ? vec3(1.0,0.78,0.3) : vec3(1.0,0.35,0.3);
          gl_FragColor = vec4(col, fill > 0.5 ? 0.95 : 0.18);
        }`,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
  }

  /** 每帧同步：只收 hp<maxHp 的活怪 */
  sync(monsters: { x: number; y: number; hp: number; maxHp: number; burrowed: boolean; cfg: { radius: number } }[]): void {
    let n = 0;
    for (const m of monsters) {
      if (m.burrowed || m.hp >= m.maxHp) continue;
      if (n >= CAP) break;
      this.posAttr[n * 3] = toX(m.x);
      this.posAttr[n * 3 + 1] = Math.max(0.5, m.cfg.radius * S) * 2 + 0.35;
      this.posAttr[n * 3 + 2] = toZ(m.y);
      this.ratioAttr[n] = Math.max(0, m.hp / m.maxHp);
      this.sizeAttr[n] = 16;
      n++;
    }
    this.points.geometry.setDrawRange(0, n);
    (this.points.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.points.geometry.getAttribute('aRatio') as THREE.BufferAttribute).needsUpdate = true;
    (this.points.geometry.getAttribute('aSize') as THREE.BufferAttribute).needsUpdate = true;
  }
}
