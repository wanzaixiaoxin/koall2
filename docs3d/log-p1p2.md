# P1+P2 阶段日志（docs3d/log-p1p2.md）

> 完成时间：2026-10-29 · tag：`backup/p1p2-3d-core-playable`

## 交付内容

**P1 技术验证** ✅
- Three.js r170 接入，`src/adapter/web3d/` 全新适配层（gamecore 零修改）
- 逻辑坐标映射：`X=(x-540)/100, Z=(64-y)/100`（墙 z=0，出生带 z≈-18）
- 张力镜头（camera-rig）：跟随英雄，威胁近墙时自动抬俯角；屏幕震动
- WASD/拖拽输入（input3d），HeroController 契约复用
- 场景：程序网格地面（地平线级）/ 渐变天空+裂隙辉光 / 雾 / 月光+提灯+枪口闪光 / 12 段城墙+城垛 / 防守区发光边界 / 出生带警戒线

**P2 战斗表现** ✅
- 怪物 InstancedMesh 池（15 形态 × 独立几何/池上限/闪白/血量染色/程序动画）
- 投射物光弹 InstancedMesh + 拖尾线带 + 怪物远程弹 + 地面伤害圈(弹坑) + 光束段
- 粒子特效（单 Points 池 900 + Mesh 池）：命中火花/爆炸火球+冲击环/落雷光柱/治疗上升粒子/墙砖屑/死亡碎裂
- 伤害飘字 3D→屏幕投影（HTML 池 40）
- HUD（城防/经验/波次）/ 波次横幅 / 卡牌三选一 / 结算画面 / 墙段受击红闪

## 浏览器实测结论

- 会话驱动渲染全链路 ✅：出怪→开火→命中跳字→击杀→升级选卡→城防掉血→波次推进
- 击杀 11 / 城防 2136/2200 / 第 2 波推进，确认逻辑与 2D 版一致
- 选卡暂停逻辑恢复正常（externalLevelUps 语义不变）

## 已知问题（进 P3/P4 修）

1. `[FIXED]` 地面边缘穿帮 → 地面放大至 400×500
2. 子弹过小 → 光弹 ×1.6（炸弹 ×2.2）
3. 键盘数字键选卡在 IAB 自动化下不稳定（疑似焦点问题，待人工验证；DOM 点击正常）
4. 怪物点击 `.click()` 后镜头未跟随验证 —— WASD 移动待人工确认（自动化无法长按）
5. onHit 特效颜色暂用物理白（未按武器元素着色）→ P4
6. `monsters-render` 池满时跳过渲染（预期内降级，>cap 时怪物隐形但仍参与逻辑）

## 性能初测

- 1280×720、第一波 ~20 怪：帧率目测满帧（rAF 无压力）
- 待 P4 做 100+ 怪压测（第 2 章 W4 30 只波）

## 文件清单

```
src/adapter/web3d/
  main.ts                 主入口（会话/事件/HUD/主循环）
  camera-rig.ts           张力镜头
  input3d.ts              WASD/拖拽
  scene/world.ts          场景搭建+坐标映射（唯一映射源）
  render/hero-render.ts   英雄胶囊+提灯
  render/monsters-render.ts  怪物 InstancedMesh 池
  render/projectiles-render.ts  光弹/拖尾/弹坑/光束
  render/fx3d.ts          粒子特效运行时
  render/floats.ts        投影飘字
web/game3d.html           3D 版页面（bundle3d.js?v=1）
```

命令：`npm run build:3d`（类型检查+打包）/ `npm run play3d`（打包+8001 端口起服）→
http://localhost:8001/web/game3d.html?level=level_1_1.json
