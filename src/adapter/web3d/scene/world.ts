/**
 * 3D 世界搭建（docs3d/00 §2）：地面/天空/雾/光照/城墙/防守区。
 * 坐标映射（全工程唯一）：逻辑 (x, y) px → 3D 米
 *   X = (x - ARENA_W/2) * S     （x=0..1080 → -5.4..5.4）
 *   Z = (WALL_Y - y) * S        （墙顶 y=64 → z=0；出生带 y≈1880 → z≈-18.2）
 *   Y = 0 为地面。
 * 渲染层禁止把该映射写进其他文件。
 */
export const S = 1 / 100;           // px → m
export const ARENA_W = 1080;
export const WALL_Y = 64;           // 逻辑城墙顶 y
export const ARENA_DEPTH = 1920;

export const toX = (x: number): number => (x - ARENA_W / 2) * S;
export const toZ = (y: number): number => (WALL_Y - y) * S;

/** 逻辑 y 带转 3D z 带（z1 < z2，z1 为更深处） */
export const bandZ = (yMin: number, yMax: number): [number, number] =>
  [toZ(yMax), toZ(yMin)];

import * as THREE from 'three';

export interface WorldRefs {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  wallSegments: THREE.Mesh[];
  wallFlash: number[];      // 每段受击红闪剩余时间
  lantern: THREE.PointLight;
  muzzle: THREE.PointLight;
  muzzleLife: number;
  defenseLines: THREE.LineLoop;
}

/** 程序网格纹理：暗夜底 + 青灰网格线（对应 2D 版背景网格） */
function makeGridTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#0B0C1D';
  g.fillRect(0, 0, 256, 256);
  g.strokeStyle = '#1E2140';
  g.lineWidth = 2;
  g.strokeRect(0, 0, 256, 256);
  g.strokeStyle = 'rgba(30,33,64,0.6)';
  g.beginPath(); g.moveTo(128, 0); g.lineTo(128, 256); g.stroke();
  g.beginPath(); g.moveTo(0, 128); g.lineTo(256, 128); g.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(320, 400);
  tex.anisotropy = 4;
  return tex;
}

/** 天空穹顶：夜空渐变 + 地平线裂隙发光带（怪物来向 -Z） */
function makeSky(): THREE.Mesh {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {},
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 p = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * p;
      }`,
    fragmentShader: /* glsl */`
      varying vec3 vDir;
      void main() {
        float h = vDir.y;                       // -1..1
        vec3 top = vec3(0.028, 0.031, 0.078);   // #07080F
        vec3 mid = vec3(0.070, 0.078, 0.169);   // #12142B
        vec3 hor = vec3(0.10, 0.07, 0.13);
        vec3 col = mix(mid, top, smoothstep(0.05, 0.6, h));
        col = mix(hor, col, smoothstep(-0.02, 0.16, h));
        // 裂隙：-Z 方向地平线红青双色辉光
        float rift = pow(max(0.0, -vDir.z), 3.0) * smoothstep(0.22, 0.0, abs(h - 0.03));
        col += vec3(0.35, 0.10, 0.16) * rift;             // 暗红底
        col += vec3(0.05, 0.30, 0.26) * pow(rift, 2.0);   // 青色芯
        // 星光颗粒
        float star = step(0.9985, fract(sin(dot(vDir.xy * 417.0, vec2(12.9898, 78.233))) * 43758.5453));
        col += vec3(0.7) * star * smoothstep(0.15, 0.5, h);
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(300, 32, 20), mat);
  sky.frustumCulled = false;
  return sky;
}

/** 城墙：12 段石砖体块，横跨全宽，位于 z=0（受击红闪由 main 驱动） */
function makeWall(wallHalfW: number): { group: THREE.Group; segments: THREE.Mesh[] } {
  const group = new THREE.Group();
  const segs = 12;
  const segW = (wallHalfW * 2) / segs;
  const segments: THREE.Mesh[] = [];
  const geo = new THREE.BoxGeometry(segW - 0.12, 3.2, 1.1);
  for (let i = 0; i < segs; i++) {
    const mat = new THREE.MeshStandardMaterial({
      color: '#3D4470', roughness: 0.85, metalness: 0.1,
      emissive: '#000000',
    });
    const m = new THREE.Mesh(geo, mat);
    m.position.set(-wallHalfW + segW * (i + 0.5), 1.6, 0.1);
    group.add(m);
    segments.push(m);
    // 城垛
    const cap = new THREE.Mesh(
      new THREE.BoxGeometry(segW - 0.3, 0.32, 1.3),
      new THREE.MeshStandardMaterial({ color: '#2E3454', roughness: 0.9 }),
    );
    cap.position.set(m.position.x, 3.36, 0.1);
    group.add(cap);
  }
  return { group, segments };
}

export function buildWorld(level: {
  arena: { width: number; height: number };
  defenseRect: { yMin: number; yMax: number };
  spawnBandY: [number, number];
}): WorldRefs {
  const scene = new THREE.Scene();
  const fog = new THREE.Fog('#0B0C1D', 18, 58);
  scene.fog = fog;

  const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 400);
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  // ---------- 光照 ----------
  scene.add(new THREE.AmbientLight('#3A3F6B', 0.9));
  const moon = new THREE.DirectionalLight('#BFE8FF', 0.85);
  moon.position.set(-8, 18, -6);
  scene.add(moon);
  const riftGlow = new THREE.DirectionalLight('#FF3D71', 0.3);
  riftGlow.position.set(0, 4, -20);
  scene.add(riftGlow);
  const lantern = new THREE.PointLight('#FFD54F', 14, 9, 1.6);
  lantern.position.set(0, 2.2, 0);
  scene.add(lantern);
  const muzzle = new THREE.PointLight('#FFF3C4', 0, 6, 2.0);   // 枪口闪光（onShoot 驱动）
  scene.add(muzzle);

  // ---------- 地面（放大到地平线级，边界自然消失于雾中） ----------
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(400, 500),
    new THREE.MeshStandardMaterial({ map: makeGridTexture(), roughness: 0.95, metalness: 0 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(0, 0, -160);
  scene.add(ground);

  // ---------- 天空 ----------
  scene.add(makeSky());

  // ---------- 防守区发光边界（青色，z 从 toZ(yMax) 到 toZ(yMin)） ----------
  const zNear = toZ(level.defenseRect.yMin);   // 靠墙侧
  const zFar = toZ(level.defenseRect.yMax);    // 靠敌侧
  const halfW = (level.arena.width / 2) * S;
  const rectPts = [
    new THREE.Vector3(-halfW, 0.03, zFar),
    new THREE.Vector3(halfW, 0.03, zFar),
    new THREE.Vector3(halfW, 0.03, zNear),
    new THREE.Vector3(-halfW, 0.03, zNear),
  ];
  const defenseLines = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(rectPts),
    new THREE.LineBasicMaterial({ color: '#35E0C3', transparent: true, opacity: 0.55 }),
  );
  scene.add(defenseLines);
  // 防守区外圈微光面
  const zoneGlow = new THREE.Mesh(
    new THREE.PlaneGeometry(halfW * 2, zFar - zNear),
    new THREE.MeshBasicMaterial({ color: '#35E0C3', transparent: true, opacity: 0.045, depthWrite: false }),
  );
  zoneGlow.rotation.x = -Math.PI / 2;
  zoneGlow.position.set(0, 0.015, (zFar + zNear) / 2);
  scene.add(zoneGlow);

  // ---------- 出生带警戒线（红，雾中隐约可见） ----------
  const [spawnZ1, spawnZ2] = bandZ(level.spawnBandY[0], level.spawnBandY[1]);
  const warnLine = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-halfW, 0.04, spawnZ1),
      new THREE.Vector3(halfW, 0.04, spawnZ1),
    ]),
    new THREE.LineBasicMaterial({ color: '#FF3D71', transparent: true, opacity: 0.3 }),
  );
  scene.add(warnLine);

  // ---------- 城墙 ----------
  const { group: wallGroup, segments } = makeWall(halfW);
  scene.add(wallGroup);

  return {
    scene, camera, renderer,
    wallSegments: segments,
    wallFlash: segments.map(() => 0),
    lantern, muzzle, muzzleLife: 0,
    defenseLines,
  };
}
