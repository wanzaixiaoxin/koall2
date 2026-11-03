# 3D 化项目总结（docs3d/README.md）

> 分支 `feature/3d-gameplay` · 2026-10-29 · 基于 main @ 93456fc
> 一句话：**复用 2D 确定性逻辑内核，Three.js 全新 3D 适配层，5 个阶段 + 3 轮玩家评审迭代，全部备份 tag。**

## 备份索引

| tag | 内容 |
|-----|------|
| `backup/p1p2-3d-core-playable` | P1 技术验证 + P2 战斗表现（全链路跑通） |
| `backup/p3-threat-gems` | P3 威胁三件套 + 宝石磁吸 |
| `backup/p4-sim-regression` | P4 sim 同种子回归一致 + 60fps 压测 |
| `backup/p5-round1` | R1：音效/开始画面/发光/朝向 |
| `backup/p5-round2` | R2：墙体遮挡治本/镜头俯角 |
| `backup/p5-round3` | R3：血条/拖尾/红光收敛 |

## 运行

```bash
npm run play3d        # 打包 3D 版 + 8001 端口起服
# → http://localhost:8001/web/game3d.html?level=level_1_1.json&weapon=gun_rifle
```

## 质量证据

- **逻辑零污染**：同种子(42) sim 对比 main 与 3D 分支——结果/击杀/峰值怪/选卡序列完全一致
- **性能**：level_2_1（虫族 30 只波）1280×720 全程 60fps（39 采样 min=60）
- **零素材美术**：全部程序几何 + Canvas 纹理 + ShaderMaterial + WebAudio 合成音效

## 架构

```
src/adapter/web3d/          唯一 import 'three' 的层
  main.ts                   会话驱动/事件接线/HUD/主循环
  camera-rig.ts             张力镜头（威胁感知俯角）
  input3d.ts                WASD/拖拽（HeroController 契约）
  threat-hud.ts             威胁三件套（边缘红光/受击罗盘/近墙雷达）
  sfx.ts                    WebAudio 合成音效
  start-screen.ts           开始画面
  scene/world.ts            场景 + 坐标映射唯一源（X=(x-540)/100, Z=(64-y)/100）
  render/                   hero / monsters(InstancedMesh池) / projectiles(光弹+拖尾)
                            / fx3d(粒子池) / floats(投影飘字) / gems / hp-bars(点精灵)
```

硬约定（已兑现）：gamecore 零修改；渲染层只读快照+事件；坐标映射单一来源。

## 未完成（下个 session 接续）

见 `log-p5.md` 第 4 轮清单：Boss 出场横移镜头、fx-config 3D 接线、尸体淡出、真人手感校验。
