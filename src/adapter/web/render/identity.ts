/**
 * 身份矩阵（docs/06 §2「元素几何设计规范」的落地数据表，只被渲染层消费）。
 *
 * 为什么需要它：可读性铁律 5 要求「每个元素至少有一个专属动效」。此前 17 只怪只有
 * 12 套 shape（投石车借投矛手的梯形、岩甲魔王借岩甲兽的六边形、幼虫与幼虫群共用三角），
 * 6 把武器只有 5 种子弹形态，且**完全没有击杀表现**——死亡是玩家记住一个怪的最强线索，
 * 缺失它等于所有怪「死得都一样」。
 *
 * 分层原则（重要性与实现顺序一致）：
 *  1. silhouette 轮廓：一眼分清族类（三角/六边/叠圆/菱形/尖刺环…）——drawMonster 按它分派；
 *  2. accent 点缀色：同族内的具体身份（投矛手珊瑚红 / 投石车木褐 / 虫后紫 / 岩甲魔王金冠）；
 *  3. gait 动效：它怎么动（squash / 拖影 / 扑翼 / 蠕动 / 呼吸 / 重踏）；
 *  4. death 死法：它怎么碎（材质 + 碎块形态 + 冲击环 + 地面残留 + 专属附加符号）。
 *
 * 色板纪律：accent 只允许取 palette.json 的既有色或同族深浅变体，不引入新色相；
 * 需要新色相时先改 palette.json 再回来（docs/06 三条美学纪律第 2 条）。
 */
import { DamageType, MonsterConfig } from '../../../gamecore';

// ---------------- 怪物 ----------------

export type Silhouette =
  | 'slime' | 'wolf' | 'goblin' | 'catapult' | 'charger' | 'armor' | 'king' | 'treant'
  | 'mushroom' | 'bat' | 'shaman' | 'zergling' | 'grub' | 'roach' | 'lurker' | 'queen' | 'baneling' | 'ultra';

/** 碎块材质：决定死亡时飞出来的是什么（读作"这只怪是什么做的"）。 */
export type ChunkKind = 'goo' | 'shard' | 'plate' | 'splinter' | 'feather' | 'spark' | 'ember' | 'bubble';

/** 死亡附加符号：一句话说完"它的死法还额外发生了什么"。 */
export type GlyphKind =
  | 'slash'      // 交叉斩痕（野狼：被斩断的气流）
  | 'drop'       // 掉落兵器（投矛手的矛 / 投石车的轮 / 魔王的冠）
  | 'spike'      // 地面尖刺爆出（潜伏者）
  | 'wisp'       // 上升的光点（巫师的魂火 / 蝙蝠的回声）
  | 'arc'        // 电火花（雷兽 / 雷击致死）
  | 'split'      // 裂成两枚小圆（分裂菇：与 deathSplit 机制对得上）
  | 'shatter'    // 外环碎裂（Boss：几何外环解体）
  | 'crack';     // 地面裂纹（雷兽/岩甲：重物砸地）

export interface GlyphSpec {
  kind: GlyphKind;
  count: number;
  color: string;
  size: [number, number];
  speed: [number, number];
  dur: number;
}

export interface DeathRecipe {
  chunks: ChunkKind;
  count: number;
  speed: [number, number];   // 初速 px/s
  size: [number, number];    // 碎块半径 px
  /** 俯视角下的"重力"：>0 向城墙方向（-y）落，0 = 原地四散 */
  gravity: number;
  color: string;
  color2?: string;
  spin?: boolean;
  ring?: { r1: number; color: string; width: number; dur: number };
  decal?: { color: string; radius: number; dur: number };
  smoke?: { color: string; count: number };
  glyphs?: GlyphSpec[];
  /** 整体时长倍率：越重越慢（Boss 死亡是"塌"，不是"炸"） */
  weight?: number;
}

export type SizeClass = 'small' | 'normal' | 'large' | 'boss';

export interface MonsterLook {
  silhouette: Silhouette;
  size: SizeClass;
  /** 装饰色（爪/盔/孢子/冠） */
  accent: string;
  /** 眼睛/核心色 */
  core: string;
  /** 一句话身份（实验室 tooltip / 文档对齐用） */
  note: string;
  death: DeathRecipe;
}

/** 17 只怪的完整身份表：每个 id 一项，绝不共用（这是本表的唯一纪律）。 */
export const MONSTER_LOOKS: Record<string, MonsterLook> = {
  slime: {
    silhouette: 'slime', size: 'normal', accent: '#FFB199', core: '#2A0F0C',
    note: '橡皮果冻：压扁弹跳前进，死亡摊成一滩胶质',
    death: {
      chunks: 'goo', count: 9, speed: [70, 190], size: [3, 6.5], gravity: 250, spin: false,
      color: '#FF6B57', color2: '#FFB199',
      ring: { r1: 34, color: '#FF6B57', width: 3, dur: 0.3 },
      decal: { color: '#FF6B57', radius: 30, dur: 3.6 },
    },
  },
  wolf: {
    silhouette: 'wolf', size: 'normal', accent: '#FFD9B0', core: '#FF3D71',
    note: '疾行猎手：冲刺拉伸 + 前摇预警线，死亡炸成毛团与两道斩痕',
    death: {
      chunks: 'shard', count: 10, speed: [130, 280], size: [3, 6], gravity: 240, spin: true,
      color: '#FF8357', color2: '#FFD9B0',
      ring: { r1: 40, color: '#FF8357', width: 2.5, dur: 0.26 },
      glyphs: [{ kind: 'slash', count: 2, color: '#FFE7CE', size: [26, 34], speed: [0, 0], dur: 0.34 }],
    },
  },
  thrower: {
    silhouette: 'goblin', size: 'normal', accent: '#FFC2A0', core: '#2A0F0C',
    note: '投矛手：梯形身板 + 长矛，掷矛时后仰；死亡长矛脱手插地',
    death: {
      chunks: 'splinter', count: 8, speed: [90, 220], size: [2.5, 5], gravity: 220, spin: true,
      color: '#FF5E7A', color2: '#FFC2A0',
      glyphs: [{ kind: 'drop', count: 1, color: '#FFC2A0', size: [30, 34], speed: [40, 70], dur: 1.1 }],
    },
  },
  catapult: {
    silhouette: 'catapult', size: 'large', accent: '#C9A26B', core: '#6B4A2F',
    note: '投石车：木架 + 双轮 + 投臂，轮子常转；死亡木屑四溅、轮子滚走',
    death: {
      chunks: 'splinter', count: 14, speed: [110, 260], size: [3, 7], gravity: 260, spin: true,
      color: '#A9714B', color2: '#C9A26B',
      ring: { r1: 52, color: '#C9A26B', width: 3, dur: 0.34 },
      smoke: { color: '#8A6B4A', count: 5 },
      glyphs: [{ kind: 'drop', count: 2, color: '#8B5E3C', size: [13, 16], speed: [50, 90], dur: 1.3 }],
    },
  },
  charger: {
    silhouette: 'charger', size: 'small', accent: '#FFEBC8', core: '#FF3D71',
    note: '冲锋鼠：全游戏最快的动能梭，死亡只剩一道速度线与刹车痕',
    death: {
      chunks: 'spark', count: 12, speed: [180, 380], size: [2, 4], gravity: 0, spin: false,
      color: '#FFA25E', color2: '#FFEBC8',
      ring: { r1: 44, color: '#FFA25E', width: 2, dur: 0.2 },
      glyphs: [
        { kind: 'slash', count: 3, color: '#FFEBC8', size: [22, 30], speed: [0, 0], dur: 0.26 },
        { kind: 'crack', count: 2, color: '#E0B080', size: [24, 34], speed: [20, 40], dur: 0.7 },
      ],
    },
  },
  bulwark: {
    silhouette: 'armor', size: 'large', accent: '#C7CEE6', core: '#0B0C1D',
    note: '岩甲兽：六边形重甲 + 免伤盾，死亡整片甲壳崩解成石片',
    death: {
      chunks: 'plate', count: 11, speed: [90, 220], size: [5, 10], gravity: 280, spin: true,
      color: '#8A93B8', color2: '#C7CEE6',
      ring: { r1: 48, color: '#C7CEE6', width: 4, dur: 0.4 },
      smoke: { color: '#6E7796', count: 4 },
      decal: { color: '#6E7796', radius: 26, dur: 2.2 },
    },
  },
  bulwark_king: {
    silhouette: 'king', size: 'boss', accent: '#FFD54F', core: '#0B0C1D',
    note: '岩甲魔王：同族重甲的黄金冠版本，双层轮廓脉冲；死亡冠碎、石甲成山',
    death: {
      chunks: 'plate', count: 18, speed: [110, 300], size: [6, 12], gravity: 300, spin: true,
      color: '#8A93B8', color2: '#FFD54F', weight: 1.35,
      ring: { r1: 78, color: '#FFD54F', width: 5, dur: 0.55 },
      smoke: { color: '#6E7796', count: 7 },
      decal: { color: '#6E7796', radius: 40, dur: 3 },
      glyphs: [{ kind: 'drop', count: 3, color: '#FFD54F', size: [8, 12], speed: [90, 150], dur: 1.4 }],
    },
  },
  boss_treant: {
    silhouette: 'treant', size: 'boss', accent: '#D9A6FF', core: '#B537F2',
    note: '腐化树人：嵌套尖刺环 + 旋转外环；死亡是塌陷——外环碎裂、木屑成雨',
    death: {
      chunks: 'shard', count: 22, speed: [80, 240], size: [5, 12], gravity: 260, spin: true,
      color: '#6B4A2F', color2: '#B537F2', weight: 1.7,
      ring: { r1: 120, color: '#B537F2', width: 6, dur: 0.8 },
      smoke: { color: '#5E3B6E', count: 8 },
      decal: { color: '#B537F2', radius: 54, dur: 4 },
      glyphs: [
        { kind: 'shatter', count: 10, color: '#D9A6FF', size: [10, 18], speed: [60, 120], dur: 1.5 },
        { kind: 'wisp', count: 8, color: '#D9A6FF', size: [2, 4], speed: [30, 70], dur: 1.2 },
        { kind: 'crack', count: 4, color: '#6B4A2F', size: [40, 70], speed: [30, 60], dur: 1.2 },
      ],
    },
  },
  split_shroom: {
    silhouette: 'mushroom', size: 'normal', accent: '#FFD1E3', core: '#3A1024',
    note: '分裂菇：伞盖 + 斑点；死亡崩成孢子云，并裂出两只幼体（对应 deathSplit）',
    death: {
      chunks: 'goo', count: 10, speed: [80, 200], size: [3, 6], gravity: 200, spin: false,
      color: '#FF6B9C', color2: '#FFD1E3',
      ring: { r1: 42, color: '#FF6B9C', width: 3, dur: 0.3 },
      smoke: { color: '#FF9DC0', count: 5 },
      decal: { color: '#FF6B9C', radius: 28, dur: 2.6 },
      glyphs: [{ kind: 'split', count: 2, color: '#FF9DC0', size: [9, 12], speed: [70, 110], dur: 0.85 }],
    },
  },
  shroom_baby: {
    silhouette: 'mushroom', size: 'small', accent: '#FFC9DE', core: '#3A1024',
    note: '分裂菇幼体：小一号、无斑点；死亡只有一小团孢子，不再分裂',
    death: {
      chunks: 'goo', count: 6, speed: [60, 150], size: [2, 4], gravity: 190, spin: false,
      color: '#FF6B9C', color2: '#FFC9DE',
      smoke: { color: '#FFB3CC', count: 3 },
      decal: { color: '#FF6B9C', radius: 16, dur: 1.8 },
    },
  },
  bat: {
    silhouette: 'bat', size: 'small', accent: '#FFB3E1', core: '#2A0F20',
    note: '夜行蝙蝠：双翼扑动 + 蛇形轨迹；死亡翼膜碎片上飘、回声环扩散',
    death: {
      chunks: 'feather', count: 10, speed: [90, 240], size: [3, 6], gravity: -40, spin: true,
      color: '#FF7EC7', color2: '#FFB3E1',
      ring: { r1: 38, color: '#FF7EC7', width: 2, dur: 0.4 },
      glyphs: [
        { kind: 'wisp', count: 3, color: '#FFB3E1', size: [2, 3], speed: [30, 60], dur: 0.9 },
        { kind: 'arc', count: 2, color: '#FF7EC7', size: [14, 20], speed: [0, 0], dur: 0.3 },
      ],
    },
  },
  shaman: {
    silhouette: 'shaman', size: 'normal', accent: '#F5F5FA', core: '#B388FF',
    note: '地精巫师：菱形法袍 + 悬浮法球；死亡法袍塌落、魂火上升、地面留下符文环',
    death: {
      chunks: 'shard', count: 9, speed: [70, 200], size: [3, 6], gravity: 210, spin: true,
      color: '#B388FF', color2: '#F5F5FA',
      ring: { r1: 46, color: '#B388FF', width: 3, dur: 0.5 },
      glyphs: [
        { kind: 'wisp', count: 5, color: '#D9C2FF', size: [2.5, 4.5], speed: [40, 90], dur: 1.3 },
        { kind: 'shatter', count: 4, color: '#B388FF', size: [10, 16], speed: [30, 60], dur: 0.9 },
      ],
    },
  },
  zerg_ling: {
    silhouette: 'zergling', size: 'small', accent: '#C5E1A5', core: '#1A2410',
    note: '幼虫群：低伏身位 + 前肢镰刀，贴地疾跑；死亡酸浆四溅',
    death: {
      chunks: 'spark', count: 8, speed: [120, 260], size: [2, 4], gravity: 160, spin: false,
      color: '#9CCC65', color2: '#C5E1A5',
      decal: { color: '#7CB342', radius: 16, dur: 1.6 },
      glyphs: [{ kind: 'slash', count: 2, color: '#C5E1A5', size: [16, 22], speed: [0, 0], dur: 0.24 }],
    },
  },
  zerg_roach: {
    silhouette: 'roach', size: 'normal', accent: '#AED581', core: '#1A2410',
    note: '爬虫：椭圆甲壳 + 背脊尖刺，残血钻地回血；死亡甲壳对半裂开',
    death: {
      chunks: 'plate', count: 9, speed: [80, 200], size: [4, 8], gravity: 240, spin: true,
      color: '#7CB342', color2: '#AED581',
      ring: { r1: 44, color: '#7CB342', width: 3, dur: 0.34 },
      smoke: { color: '#4A5B2A', count: 3 },
      decal: { color: '#558B2F', radius: 24, dur: 2 },
    },
  },
  zerg_lurker: {
    silhouette: 'lurker', size: 'normal', accent: '#8BC34A', core: '#1A2410',
    note: '潜伏者：竖立尖刺 + 四侧利爪，钻地时只剩土包虚线；死亡地刺炸出、土块翻起',
    death: {
      chunks: 'shard', count: 8, speed: [100, 240], size: [4, 8], gravity: 260, spin: true,
      color: '#558B2F', color2: '#8BC34A',
      glyphs: [
        { kind: 'spike', count: 6, color: '#8BC34A', size: [8, 16], speed: [100, 180], dur: 0.5 },
        { kind: 'crack', count: 3, color: '#6B4A2F', size: [26, 40], speed: [20, 50], dur: 0.8 },
      ],
    },
  },
  zerg_larva: {
    silhouette: 'grub', size: 'small', accent: '#E6EE9C', core: '#1A2410',
    note: '幼虫：三节肥躯 + 变态囊（囊体随 morph 倒计时加速脉动）；死亡体液爆开',
    death: {
      chunks: 'goo', count: 7, speed: [60, 170], size: [2.5, 5], gravity: 200, spin: false,
      color: '#9CCC65', color2: '#E6EE9C',
      decal: { color: '#8BC34A', radius: 15, dur: 1.6 },
    },
  },
  zerg_queen: {
    silhouette: 'queen', size: 'large', accent: '#FF9DE2', core: '#1A2410',
    note: '虫后：菱形母体 + 治疗光环；死亡是一次"巢崩"——绿环 + 卵粒飞散 + 雾化',
    death: {
      chunks: 'goo', count: 14, speed: [90, 240], size: [4, 9], gravity: 220, spin: false,
      color: '#C77DFF', color2: '#AEEA00', weight: 1.2,
      ring: { r1: 96, color: '#7CB342', width: 5, dur: 0.6 },
      smoke: { color: '#7CB342', count: 6 },
      decal: { color: '#558B2F', radius: 44, dur: 3.2 },
      glyphs: [
        { kind: 'split', count: 6, color: '#AEEA00', size: [4, 7], speed: [60, 130], dur: 0.9 },
        { kind: 'wisp', count: 6, color: '#C77DFF', size: [2, 4], speed: [40, 80], dur: 1.1 },
      ],
    },
  },
  baneling: {
    silhouette: 'baneling', size: 'normal', accent: '#D8FF50', core: '#7CB342',
    note: '毒爆虫：脉动自爆体（危险度越高颤得越急）；死亡=酸爆，绿浆外溅',
    death: {
      chunks: 'bubble', count: 14, speed: [120, 300], size: [3, 7], gravity: 150, spin: false,
      color: '#AEEA00', color2: '#D8FF50',
      ring: { r1: 60, color: '#AEEA00', width: 4, dur: 0.45 },
      smoke: { color: '#7CB342', count: 5 },
      decal: { color: '#7CB342', radius: 32, dur: 3.2 },
      glyphs: [{ kind: 'arc', count: 4, color: '#D8FF50', size: [16, 26], speed: [80, 140], dur: 0.4 }],
    },
  },
  zerg_ultra: {
    silhouette: 'ultra', size: 'boss', accent: '#AED581', core: '#1A2410',
    note: '雷兽：十角甲壳 + 镰刀双臂，钻地冲锋；死亡是地震——裂纹 + 甲片成堆',
    death: {
      chunks: 'plate', count: 16, speed: [100, 280], size: [6, 12], gravity: 300, spin: true,
      color: '#69A83B', color2: '#AED581', weight: 1.45,
      ring: { r1: 88, color: '#AED581', width: 5, dur: 0.55 },
      smoke: { color: '#4A5B2A', count: 6 },
      decal: { color: '#558B2F', radius: 46, dur: 3 },
      glyphs: [
        { kind: 'crack', count: 5, color: '#6B4A2F', size: [40, 72], speed: [30, 70], dur: 1.3 },
        { kind: 'arc', count: 3, color: '#AED581', size: [20, 30], speed: [60, 120], dur: 0.45 },
      ],
    },
  },
};

// 兼容：configs 里的 shape 只是「族类声明」，身份由 id 兜底；
// 未来新增怪只需在 MONSTER_LOOKS 补一项，没补时按 shape 回落、再回落史莱姆（中性）。
const SHAPE_TO_SILHOUETTE: Record<string, Silhouette> = {
  slime: 'slime', wolf: 'wolf', charger: 'charger', thrower: 'goblin', bulwark: 'armor',
  bat: 'bat', shroom: 'mushroom', boss: 'treant', shaman: 'shaman',
  larva: 'grub', roach: 'roach', lurker: 'lurker', zqueen: 'queen', baneling: 'baneling', ultra: 'ultra',
};

const FALLBACK_LOOK: MonsterLook = {
  silhouette: 'slime', size: 'normal', accent: '#FFB199', core: '#2A0F0C',
  note: '未登记形态（回落史莱姆）',
  death: {
    chunks: 'goo', count: 6, speed: [70, 160], size: [3, 5], gravity: 220,
    color: '#FF6B57', color2: '#FFB199', decal: { color: '#FF6B57', radius: 20, dur: 2 },
  },
};

export function lookOf(key: string | undefined, shape?: string): MonsterLook {
  const own = key ? MONSTER_LOOKS[key] : undefined;
  if (own) return own;
  const fam = FALLBACK_LOOK;
  const sil = SHAPE_TO_SILHOUETTE[shape ?? ''] ?? fam.silhouette;
  return { ...fam, silhouette: sil };
}

export function monsterLook(m: { cfg: MonsterConfig }): MonsterLook {
  return lookOf(m.cfg.id, m.cfg.shape);
}

/** 尺寸档位 → 特效放大量（死亡表现按体型放大，Boss 才有"塌"的体量感）。 */
export const SIZE_SCALE: Record<SizeClass, number> = {
  small: 0.78,
  normal: 1,
  large: 1.35,
  boss: 1.9,
};

// ---------------- 武器 / 弹种 ----------------

/** 子弹形态：每个武器一种，互不借用（"所有子弹各具特色"的数据基础）。 */
export type BulletStyle = 'rune' | 'bolt' | 'flask' | 'disc' | 'chain' | 'beam';

/** 炮口表现：开火瞬间在挂载点演什么。 */
export type MuzzleStyle = 'star' | 'cone' | 'puff' | 'ring' | 'crackle' | 'lens';

/** 命中表现：打到怪的一瞬间给什么反馈（与受击闪白叠加，不替代它）。 */
export type ImpactStyle = 'spark' | 'crack' | 'burst' | 'slash' | 'arc' | 'scorch';

export interface WeaponLook {
  bullet: BulletStyle;
  muzzle: MuzzleStyle;
  impact: ImpactStyle;
  /** 武器本体点缀色（元素色优先，这里只做非元素部件的固定配色） */
  accent: string;
  note: string;
}

export const WEAPON_LOOKS: Record<string, WeaponLook> = {
  gun_rifle: {
    bullet: 'rune', muzzle: 'star', impact: 'spark', accent: '#F5F5FA',
    note: '符文步枪：菱形符文弹 + 短曳光，连射如弹幕雨',
  },
  crossbow_pierce: {
    bullet: 'bolt', muzzle: 'cone', impact: 'crack', accent: '#C7CEE6',
    note: '穿透弩：长杆重弩箭 + 尾羽，一条贯穿残影',
  },
  alchemist_bomb: {
    bullet: 'flask', muzzle: 'puff', impact: 'burst', accent: '#FFB357',
    note: '炼金炸弹：球形药瓶 + 引线火花，抛物弧线落地留坑',
  },
  boomerang: {
    bullet: 'disc', muzzle: 'ring', impact: 'slash', accent: '#FFD54F',
    note: '回旋镖：锯齿圆盘高速自转，去/回各一道斩痕',
  },
  lightning_chain: {
    bullet: 'chain', muzzle: 'crackle', impact: 'arc', accent: '#B388FF',
    note: '雷电权杖：无弹体，炮口直达 + 怪间跳跃的折线闪电',
  },
  laser_cannon: {
    bullet: 'beam', muzzle: 'lens', impact: 'scorch', accent: '#BFFFF2',
    note: '聚能激光炮：三层光带持续光束，端点灼烧、过热冒烟',
  },
};

const SHAPE_TO_BULLET: Record<string, BulletStyle> = {
  dot: 'rune', arrow: 'bolt', bomb: 'flask', gear: 'disc', crescent: 'disc', beam: 'beam',
};

const FALLBACK_WEAPON: WeaponLook = {
  bullet: 'rune', muzzle: 'star', impact: 'spark', accent: '#F5F5FA', note: '未登记武器',
};

export function weaponLook(w: { cfg: { id: string; shape?: string } }): WeaponLook {
  const own = WEAPON_LOOKS[w.cfg.id];
  if (own) return own;
  return { ...FALLBACK_WEAPON, bullet: SHAPE_TO_BULLET[w.cfg.shape ?? 'dot'] ?? 'rune' };
}

// ---------------- 伤害类型配色（死法/火花） ----------------

export interface DamageFx {
  /** 命中火花 / 致死碎屑主色 */
  color: string;
  /** 致死时追加的碎块材质 */
  chunk: ChunkKind;
  /** 地面残留色（灼烧焦痕 / 冰面 / 酸液） */
  stain: string;
}

/**
 * 与 palette.json damageType 保持一致（这是唯一允许的重复：
 * 渲染层要能不依赖网络请求就着色，色值变更时两边一起改）。
 */
export const DAMAGE_FX: Record<DamageType, DamageFx> = {
  physical: { color: '#F5F5FA', chunk: 'spark', stain: '#C7CEE6' },
  fire: { color: '#FF5A3C', chunk: 'ember', stain: '#7A2A18' },
  frost: { color: '#4FC3F7', chunk: 'shard', stain: '#2B6A88' },
  lightning: { color: '#B388FF', chunk: 'spark', stain: '#4A3A7A' },
  poison: { color: '#7CB342', chunk: 'bubble', stain: '#3E5B21' },
};
