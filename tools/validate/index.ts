/**
 * validate：配置表机器校验（docs/05 §1.6 AI 流水线的第 ③ 步）。
 * - 结构校验：必填字段、类型、取值范围
 * - 引用校验：波次表引用的怪物/出生点存在
 * - 数值校验：docs/01 §6.4 的压力规则——任一波次"潜在对墙总 DPS"换算的破墙时间不得过短
 *
 * 用法：node dist/tools/validate/index.js [configs 目录]
 * 退出码：0 = 全部通过；1 = 存在 ERROR。
 */
import * as fs from 'fs';
import * as path from 'path';
import { CardConfig, LevelConfig, MonsterConfig, WeaponConfig } from '../../src/gamecore';

type Severity = 'ERROR' | 'WARN';
interface Issue { severity: Severity; where: string; msg: string }

const issues: Issue[] = [];
const err = (where: string, msg: string) => issues.push({ severity: 'ERROR', where, msg });
const warn = (where: string, msg: string) => issues.push({ severity: 'WARN', where, msg });

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function need(cond: unknown, where: string, msg: string): void {
  if (!cond) err(where, msg);
}

// ---------- 校验器 ----------

function validateWeapons(weapons: WeaponConfig[]): void {
  const ids = new Set<string>();
  for (const w of weapons) {
    const where = `weapons/${w?.id ?? '?'}`;
    need(w && typeof w.id === 'string', where, '缺少 id');
    if (!w) continue;
    need(!ids.has(w.id), where, `id 重复: ${w.id}`);
    ids.add(w.id);
    need(isNum(w.baseDamage) && w.baseDamage > 0, where, 'baseDamage 必须为正数');
    need(isNum(w.interval) && w.interval > 0, where, 'interval 必须为正数');
    // 落雷武器（chainBase≥1）无弹体，弹速可为 0
    need(
      isNum(w.projectileSpeed) && (w.projectileSpeed > 0 || (w.chainBase ?? 0) > 0),
      where, 'projectileSpeed 必须为正数（落雷武器除外）',
    );
    if ((w.chainBase ?? 0) > 0) {
      need(isNum(w.chainBase) && (w.chainBase as number) >= 1, where, 'chainBase 必须 ≥ 1');
    }
    if (w.blastBase) {
      need(isNum(w.blastBase.radius) && w.blastBase.radius > 0, where, 'blastBase.radius 必须为正数');
      need(isNum(w.blastBase.dmgMul) && w.blastBase.dmgMul > 0, where, 'blastBase.dmgMul 必须为正数');
      need(isNum(w.blastBase.poolSec) && w.blastBase.poolSec >= 0, where, 'blastBase.poolSec 必须 ≥ 0');
    }
    if (w.shape !== undefined) {
      need(['dot', 'arrow', 'bomb', 'crescent'].includes(w.shape), where, `未知子弹形态: ${w.shape}`);
    }
    need(isNum(w.projectileRange) && w.projectileRange > 0, where, 'projectileRange 必须为正数');
    need(isNum(w.count) && w.count >= 1, where, 'count 必须 ≥ 1');
    need(['nearest', 'lowestHp', 'strongest', 'random', 'densest'].includes(w.targeting), where, `未知索敌规则: ${w.targeting}`);
    need(['straight', 'homing'].includes(w.trajectory), where, `未知轨迹类型: ${w.trajectory}`);
    if (w.trajectory === 'homing') {
      need(!!w.homing && isNum(w.homing.turnRate), where, 'homing 轨迹缺少 homing 配置');
    }
  }
}

function validateMonsters(monsters: MonsterConfig[]): Map<string, MonsterConfig> {
  const map = new Map<string, MonsterConfig>();
  for (const m of monsters) {
    const where = `monsters/${m?.id ?? '?'}`;
    need(m && typeof m.id === 'string', where, '缺少 id');
    if (!m) continue;
    need(!map.has(m.id), where, `id 重复: ${m.id}`);
    need(isNum(m.hp) && m.hp > 0, where, 'hp 必须为正数');
    need(isNum(m.speed) && m.speed > 0, where, 'speed 必须为正数');
    need(isNum(m.radius) && m.radius > 0, where, 'radius 必须为正数');
    need(isNum(m.atk) && m.atk >= 0, where, 'atk 必须 ≥ 0');
    need(isNum(m.attackInterval) && m.attackInterval > 0, where, 'attackInterval 必须为正数');
    need(isNum(m.xp) && m.xp >= 0, where, 'xp 必须 ≥ 0');
    if (m.shape !== undefined) {
      need(['slime', 'wolf', 'charger', 'thrower', 'bulwark', 'bat', 'shroom'].includes(m.shape), where, `未知怪物形态: ${m.shape}`);
    }
    map.set(m.id, m);
  }
  return map;
}

function validateCards(cards: CardConfig[]): void {
  const ids = new Set<string>();
  const passiveStats = ['atk', 'aspd', 'moveSpeed', 'critChance', 'critDmg', 'dmgMul'];
  const bulletStats = ['count', 'burst', 'projSpeed', 'damage', 'range', 'pierce'];
  const wallStats = ['wallMax', 'wallRepair'];
  const formIds = ['homing', 'bounce', 'split', 'shred', 'blast', 'chain'];
  const damageTypes = ['physical', 'fire', 'frost', 'lightning', 'poison'];
  for (const c of cards) {
    const where = `cards/${c?.id ?? '?'}`;
    need(c && typeof c.id === 'string', where, '缺少 id');
    if (!c) continue;
    need(!ids.has(c.id), where, `id 重复: ${c.id}`);
    ids.add(c.id);
    need(['common', 'rare', 'epic', 'legendary'].includes(c.rarity), where, `未知稀有度: ${c.rarity}`);
    need(['passive', 'bullet', 'wall', 'form', 'element'].includes(c.type), where, `未知卡类型: ${c.type}`);
    need(isNum(c.maxStack) && c.maxStack >= 1, where, 'maxStack 必须 ≥ 1');
    if (c.target) {
      need(['any', 'weapon', 'element'].includes(c.target.kind), where, `未知目标类型: ${c.target.kind}`);
      if (c.target.kind === 'weapon') need(typeof c.target.weaponType === 'string', where, 'weapon 目标缺少 weaponType');
      if (c.target.kind === 'element') need(damageTypes.includes(c.target.element), where, `element 目标非法: ${c.target.element}`);
    }
    const e = c.effect as Record<string, unknown> | undefined;
    need(!!e, where, '缺少 effect');
    if (!e) continue;
    if ('stat' in e) {
      need(passiveStats.includes(e.stat as string), where, `未知属性: ${e.stat}`);
      need(['add', 'mul'].includes(e.op as string), where, `未知运算: ${e.op}`);
      need(isNum(e.value), where, 'effect.value 必须是数字');
    } else if ('bullet' in e) {
      need(bulletStats.includes(e.bullet as string), where, `未知子弹属性: ${e.bullet}`);
      need(['add', 'mul'].includes(e.op as string), where, `未知运算: ${e.op}`);
      need(isNum(e.value), where, 'effect.value 必须是数字');
    } else if ('wall' in e) {
      need(wallStats.includes(e.wall as string), where, `未知城墙属性: ${e.wall}`);
      need(['add', 'mul'].includes(e.op as string), where, `未知运算: ${e.op}`);
      need(isNum(e.value), where, 'effect.value 必须是数字');
    } else if ('form' in e) {
      need(formIds.includes(e.form as string), where, `未知形态: ${e.form}`);
      need(isNum(e.value), where, 'effect.value 必须是数字');
    } else if ('grantElement' in e) {
      need(damageTypes.includes(e.grantElement as string), where, `未知元素: ${e.grantElement}`);
    } else if ('boostElement' in e) {
      need(damageTypes.includes(e.boostElement as string), where, `未知元素: ${e.boostElement}`);
      need(isNum(e.value), where, 'effect.value 必须是数字');
      // 元素加持卡必须声明 element 目标（门控一致性）
      need(c.target?.kind === 'element' && c.target.element === e.boostElement, where, 'boostElement 卡必须声明同元素的 target');
    } else {
      err(where, 'effect 必须包含 stat/bullet/wall/form/grantElement/boostElement 之一');
    }
  }
}

/** docs/01 §6.4：波次潜在对墙 DPS 压力校验（实用解释：全漏时破墙时间过短 → 该波过难）。 */
const MIN_WALL_BREAK_SEC = 30;

function validateLevel(level: LevelConfig, monsters: Map<string, MonsterConfig>): void {
  const where = `levels/${level?.id ?? '?'}`;
  need(level && typeof level.id === 'string', where, '缺少 id');
  if (!level) return;

  const { width, height } = level.arena ?? {};
  need(isNum(width) && isNum(height) && width > 0 && height > 0, where, 'arena 尺寸非法');
  need(level.wall && isNum(level.wall.hp) && level.wall.hp > 0, where, 'wall.hp 必须为正数');
  need(level.defenseRect && level.defenseRect.yMin < level.defenseRect.yMax, where, 'defenseRect 非法');
  need(
    level.defenseRect && level.wall &&
    level.defenseRect.yMin >= level.wall.height,
    where, 'defenseRect.yMin 必须在城墙顶之上',
  );
  need(
    level.defenseRect && level.defenseRect.yMax < (level.spawnBandY?.[0] ?? 0),
    where, 'defenseRect.yMax 必须在出生带之下',
  );
  need(Array.isArray(level.spawnPointsX) && level.spawnPointsX.length > 0, where, 'spawnPointsX 不能为空');
  if (level.spawnPointsX) {
    for (const x of level.spawnPointsX) {
      need(isNum(x) && x > 0 && x < width, where, `出生点 x=${x} 超出战场宽度`);
    }
  }
  need(Array.isArray(level.waves) && level.waves.length > 0, where, 'waves 不能为空');

  level.waves?.forEach((wave, i) => {
    const wWhere = `${where}/wave[${i + 1}]`;
    need(Array.isArray(wave.spawns), wWhere, 'spawns 必须是数组');
    if ((wave.spawns ?? []).length === 0) {
      warn(wWhere, 'spawns 为空（仅实验室/特殊关允许）');
    }
    let waveWallDps = 0;
    let waveCount = 0;
    for (const sp of wave.spawns ?? []) {
      const m = monsters.get(sp.monster);
      need(!!m, wWhere, `引用了不存在的怪物: ${sp.monster}`);
      need(isNum(sp.count) && sp.count >= 1, wWhere, 'spawn.count 必须 ≥ 1');
      need(isNum(sp.releasePerTick) && sp.releasePerTick >= 1, wWhere, 'releasePerTick 必须 ≥ 1');
      need(
        wave.formation === undefined ||
        ['stream', 'line', 'pincer', 'center'].includes(wave.formation),
        wWhere, `未知阵型: ${wave.formation}`,
      );
      need(wave.durationSec === undefined || (isNum(wave.durationSec) && wave.durationSec >= 10), wWhere, 'durationSec 必须 ≥ 10');
      if (sp.spawnPoints !== 'all') {
        need(Array.isArray(sp.spawnPoints), wWhere, 'spawnPoints 必须是数组或 "all"');
        for (const idx of sp.spawnPoints ?? []) {
          need(
            Number.isInteger(idx) && idx >= 0 && idx < (level.spawnPointsX?.length ?? 0),
            wWhere, `出生点下标越界: ${idx}`,
          );
        }
      }
      if (m) {
        waveWallDps += (m.atk / m.attackInterval) * sp.count;
        waveCount += sp.count;
      }
    }
    if (level.wall && waveWallDps > 0) {
      const breakSec = level.wall.hp / waveWallDps;
      if (breakSec < MIN_WALL_BREAK_SEC) {
        warn(
          wWhere,
          `潜在破墙时间 ${breakSec.toFixed(1)}s < ${MIN_WALL_BREAK_SEC}s（全漏即破，波次压力过高）`,
        );
      }
    }
    if (waveCount > 200) {
      warn(wWhere, `单波怪物数 ${waveCount} 超过 200，注意性能基线`);
    }
  });
}

// ---------- 入口 ----------

function main(): void {
  const dir = path.resolve(process.argv[2] ?? path.join(process.cwd(), 'configs'));

  const weaponsFile = JSON.parse(fs.readFileSync(path.join(dir, 'weapons.json'), 'utf-8')) as { weapons: WeaponConfig[] };
  const monstersFile = JSON.parse(fs.readFileSync(path.join(dir, 'monsters.json'), 'utf-8')) as { monsters: MonsterConfig[] };
  const cardsFile = JSON.parse(fs.readFileSync(path.join(dir, 'cards.json'), 'utf-8')) as { cards: CardConfig[] };

  validateWeapons(weaponsFile.weapons ?? []);
  const monsterMap = validateMonsters(monstersFile.monsters ?? []);
  validateCards(cardsFile.cards ?? []);

  const levelsDir = path.join(dir, 'levels');
  const files = fs.readdirSync(levelsDir).filter((f) => f.endsWith('.json') && f !== 'index.json');
  for (const f of files) {
    const level = JSON.parse(fs.readFileSync(path.join(levelsDir, f), 'utf-8')) as LevelConfig;
    validateLevel(level, monsterMap);
  }

  // 关卡清单 manifest 与目录一致性（开始界面依赖）
  const manifestPath = path.join(levelsDir, 'index.json');
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as { levels?: { file: string }[] };
    const listed = new Set((manifest.levels ?? []).map((l) => l.file));
    for (const f of files) {
      if (f.startsWith('lab_')) continue; // 实验室沙盒场景不进开始界面清单
      if (!listed.has(f)) err('levels/index.json', `目录中的 ${f} 未在清单中登记（开始界面不显示）`);
    }
    for (const l of manifest.levels ?? []) {
      if (!files.includes(l.file)) err('levels/index.json', `清单引用了不存在的关卡文件: ${l.file}`);
    }
  } else {
    err('levels/index.json', '缺少关卡清单（开始界面依赖）');
  }

  const errors = issues.filter((i) => i.severity === 'ERROR');
  const warns = issues.filter((i) => i.severity === 'WARN');
  for (const i of issues) {
    console.log(`[${i.severity}] ${i.where}: ${i.msg}`);
  }
  console.log(`\n校验完成：${errors.length} 个错误，${warns.length} 个警告`);
  process.exit(errors.length > 0 ? 1 : 0);
}

main();
