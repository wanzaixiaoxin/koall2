# 英雄守卫战（Hero Defense）

竖屏底部防守射击 Roguelike —— 引擎解耦架构 + AI 自动创作流水线。
设计文档见 [docs/](docs/00-总体规划.md)，本 README 只讲工程与命令。

## 工程结构

```
src/gamecore/    ★零引擎依赖的纯 TS 核心（禁止 import 'cc'，ESLint 门禁拦截）
  core/            rng(确定性随机) / math / events(事件总线) / spatial-hash(空间网格)
  damage.ts        伤害公式（docs/01 §2，纯函数）
  targeting.ts     索敌规则（nearest/lowestHp/strongest/random/densest）
  trajectory.ts    轨迹组件库（Straight / Homing，M2 扩展抛物线/回旋/连锁/环绕）
  monster.ts       怪物 AI：行军 + 分离 + 抵达驻留打墙（assault_wall）
  hero.ts          英雄属性/武器开火/经验曲线/卡牌三选一
  session.ts       战斗会话编排（唯一真相，固定 30Hz 逻辑帧，确定性可复现）
tools/
  sim/             无头整局模拟 CLI（AI 流水线的"机器试玩"环节）
  validate/        配置表校验（结构 + 引用 + 压力规则）
configs/           全部数据驱动内容（JSON）
  art-style/       优雅几何三件套：palette.json / fx-config.json / shapes.md
  levels/          关卡波次表
src/adapter/       （M1 第 2 步）Cocos Creator 适配层，唯一允许 import 'cc' 的层
```

## 常用命令

```bash
npm install
npm run sim -- --level configs/levels/level_1_1.json --seed 42 --runs 5   # 无头模拟
npm run sim -- --level ... --weapon crossbow_pierce --policy random       # 换武器/策略
npm run validate                                                          # 配置表校验
npm test                                                                  # 卡牌效果全量断言（21 项）
npm run lab -- --card blast --times 2                                     # 单卡前后对比观察
npm run play                                                              # 起服务器玩（/web/）+ 卡牌实验室（/web/lab.html）
npm run build                                                             # 仅编译
```

sim 报告含：每波 TTK / 磨墙伤害 / 城防余量 / 选卡记录 / 峰值同屏数 / 星级 / 通关率——
这是 AI 生成内容（波次表、怪物、卡牌）的自动评估依据（docs/05 §1.6）。

## 关键约定

- **确定性**：固定 30Hz 逻辑帧 + mulberry32 种子随机，同种子整局可复现（回归测试基础）。
- **单一数据源**：逻辑只在 session；渲染层将只读快照 + 订阅事件（onHit/onKill/onWaveClear/onWallHit…），禁止回写。
- **AI 创作边界**：AI 只允许修改 `configs/`，机器校验（validate）+ sim 试玩报告双重把关。
