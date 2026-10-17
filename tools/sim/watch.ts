/** sim --watch：终端 ASCII 实时播放 AI 对局（体验/演示用，无需浏览器）。 */
import {
  CardConfig,
  GameSession,
  LevelConfig,
  MonsterConfig,
  WeaponConfig,
} from '../../src/gamecore';
import { createController, MoveName } from './agents';
import { getPolicy, CardPolicyName } from './policies';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const COLS = 54;
const ROWS = 30;

export async function runWatch(
  args: { seed: number; weapon: string; move: MoveName; cards: CardPolicyName },
  level: LevelConfig,
  weaponCfg: WeaponConfig,
  monsterMap: ReadonlyMap<string, MonsterConfig>,
  cards: CardConfig[],
): Promise<void> {
  const session = new GameSession({
    level,
    weaponConfigs: [weaponCfg],
    monsterConfigs: monsterMap,
    cardConfigs: cards,
    seed: args.seed,
    controller: createController(args.move, args.seed),
    cardPolicy: getPolicy(args.cards),
  });

  const cw = level.arena.width / COLS;
  const ch = level.arena.height / ROWS;
  const toCol = (x: number) => Math.max(0, Math.min(COLS - 1, Math.floor(x / cw)));
  const toRow = (y: number) => Math.max(0, Math.min(ROWS - 1, Math.floor((level.arena.height - y) / ch)));

  process.stdout.write('\x1b[2J\x1b[?25l'); // 清屏 + 隐藏光标
  process.stdout.on('error', () => process.exit(0)); // 管道被 head/Ctrl+C 切断时安静退出
  try {
    while (!session.result) {
      session.step();
      const grid: string[][] = Array.from({ length: ROWS }, () => Array(COLS).fill(' '));

      // 城墙（最下行）
      for (let c = 0; c < COLS; c++) grid[ROWS - 1][c] = '#';

      for (const p of session.projectiles) {
        if (p.alive) grid[toRow(p.y)][toCol(p.x)] = '·';
      }
      for (const m of session.monsters) {
        grid[toRow(m.y)][toCol(m.x)] = m.state === 'assault' ? '0' : 'o';
      }
      grid[toRow(session.hero.y)][toCol(session.hero.x)] = 'A';

      const wave = Math.min(session.waveStats.length + 1, level.waves.length);
      const hud =
        ` 城防 ${Math.ceil(session.wallHp)}/${session.wallMaxHp}` +
        ` | 波次 ${wave}/${level.waves.length}` +
        ` | Lv.${session.hero.level}` +
        ` | 击杀 ${session.totalKills}` +
        ` | ${session.timeSec.toFixed(0)}s` +
        (session.result === 'defeat' ? ' | 城破!' : '');

      process.stdout.write('\x1b[H' + grid.map((r) => r.join('')).join('\n') + '\n' + hud + '\n');
      await sleep(33);
    }

    const s = session;
    console.log(
      `\n  结果: ${s.result === 'victory' ? '胜利' : '城破失败'}` +
      ` · 击杀 ${s.totalKills} · 等级 ${s.hero.level} · 用时 ${s.timeSec.toFixed(1)}s` +
      ` · 城防 ${Math.ceil(s.wallHp)}/${s.wallMaxHp} · 峰值怪 ${s.maxMonsters}` +
      ` · 走位 ${args.move} / 选卡 ${args.cards}`,
    );
  } finally {
    process.stdout.write('\x1b[?25h'); // 恢复光标
  }
}
