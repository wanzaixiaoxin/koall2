/**
 * 英雄渲染：胶囊体 + 提灯 + 朝向锥 + 底部光圈。位置/朝向渲染帧平滑插值。
 */
import * as THREE from 'three';

export class HeroRender {
  readonly group = new THREE.Group();
  private body: THREE.Mesh;
  private nose: THREE.Mesh;
  private ring: THREE.Mesh;
  private targetX = 0;
  private targetZ = 0;

  constructor(scene: THREE.Scene, lantern: THREE.PointLight) {
    const bodyGeo = new THREE.CapsuleGeometry(0.26, 0.5, 4, 10);
    const bodyMat = new THREE.MeshStandardMaterial({
      color: '#35E0C3', roughness: 0.35, metalness: 0.3,
      emissive: '#35E0C3', emissiveIntensity: 0.22,
    });
    this.body = new THREE.Mesh(bodyGeo, bodyMat);
    this.body.position.y = 0.55;
    this.group.add(this.body);

    // 朝向指示（前伸小锥）
    this.nose = new THREE.Mesh(
      new THREE.ConeGeometry(0.09, 0.34, 6),
      new THREE.MeshBasicMaterial({ color: '#F5F5FA', toneMapped: false }),
    );
    this.nose.rotation.x = Math.PI / 2;
    this.nose.position.set(0, 0.62, -0.42);
    this.group.add(this.nose);

    // 底部光圈
    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(0.3, 0.42, 24),
      new THREE.MeshBasicMaterial({
        color: '#35E0C3', transparent: true, opacity: 0.5, side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
      }),
    );
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.03;
    this.group.add(this.ring);

    lantern.position.y = 2.0;
    this.group.add(lantern);

    scene.add(this.group);
  }

  /** 逻辑坐标快照（世界坐标，由 main 换算） */
  setTarget(wx: number, wz: number): void {
    this.targetX = wx;
    this.targetZ = wz;
  }

  /** 平滑插值 + 呼吸；返回当前世界坐标供镜头使用 */
  update(dt: number, timeSec: number): THREE.Vector3 {
    const k = 1 - Math.exp(-14 * dt);
    this.group.position.x += (this.targetX - this.group.position.x) * k;
    this.group.position.z += (this.targetZ - this.group.position.z) * k;
    const breathe = Math.sin(timeSec * 2.4) * 0.03;
    this.body.position.y = 0.55 + breathe;
    this.ring.rotation.z = timeSec * 0.8;
    return this.group.position;
  }
}
