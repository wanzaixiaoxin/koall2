/**
 * 张力镜头（docs3d/00 §1.3）：镜头在英雄身后上方跟随。
 * 威胁远时低角度看雾中地平线；怪物近墙时自动抬升俯角越过墙顶看穿漏点。
 * 位置/朝向用弹簧插值，与逻辑帧解耦（渲染帧平滑）。
 */
import * as THREE from 'three';
import { WALL_Y, S } from './scene/world';

/** 每帧评估威胁：怪物距墙顶的最小距离（逻辑 px），0 = 已在墙上 */
export function wallThreatDist(monsters: { y: number }[]): number {
  let min = 9999;
  for (const m of monsters) {
    const d = m.y - WALL_Y;
    if (d < min) min = d;
  }
  return min;
}

export class CameraRig {
  cam: THREE.PerspectiveCamera;
  private pos = new THREE.Vector3(0, 9, 8);
  private look = new THREE.Vector3(0, 1.2, -6);
  private shakeAmp = 0;
  private shakeT = 0;

  constructor(cam: THREE.PerspectiveCamera) {
    this.cam = cam;
    cam.position.copy(this.pos);
  }

  /** 屏幕震动（受击/Boss 技能）。amp≈米 */
  shake(amp: number): void {
    this.shakeAmp = Math.max(this.shakeAmp, amp);
  }

  /** hero3 = 英雄 3D 坐标；threatDistPx = 最近怪距墙（逻辑 px） */
  update(hero3: THREE.Vector3, threatDistPx: number, dt: number): void {
    // 俯角随威胁收紧：威胁 <300px 时更深俯视，保证英雄与墙前沿同框（防城垛遮挡）
    const k = THREE.MathUtils.clamp(1 - (threatDistPx - 150) / 450, 0, 1);
    const back = THREE.MathUtils.lerp(6.8, 5.6, k);        // 相机后撤距离
    const height = THREE.MathUtils.lerp(8.0, 9.8, k);      // 相机高度（加深俯角防遮挡）
    const lookAhead = THREE.MathUtils.lerp(-4.6, -3.0, k); // 视线落点纵深

    const targetPos = new THREE.Vector3(
      THREE.MathUtils.lerp(this.pos.x, hero3.x * 0.72, 1 - Math.exp(-6 * dt)),
      0, 0,
    );
    targetPos.y = THREE.MathUtils.lerp(this.pos.y, hero3.y + height, 1 - Math.exp(-5 * dt));
    targetPos.z = THREE.MathUtils.lerp(this.pos.z, hero3.z + back, 1 - Math.exp(-6 * dt));

    this.pos.copy(targetPos);
    this.look.x = THREE.MathUtils.lerp(this.look.x, hero3.x * 0.85, 1 - Math.exp(-5 * dt));
    this.look.y = THREE.MathUtils.lerp(this.look.y, 0.6, 1 - Math.exp(-4 * dt));
    this.look.z = THREE.MathUtils.lerp(this.look.z, hero3.z + lookAhead, 1 - Math.exp(-5 * dt));

    this.cam.position.copy(this.pos);
    if (this.shakeAmp > 0.001) {
      this.shakeT += dt * 40;
      this.cam.position.x += Math.sin(this.shakeT * 1.1) * this.shakeAmp;
      this.cam.position.y += Math.sin(this.shakeT * 1.7) * this.shakeAmp * 0.6;
      this.shakeAmp *= Math.exp(-9 * dt);
    }
    this.cam.lookAt(this.look);
  }
}
