/**
 * 几何绘制库（docs/06 形状语言）：武器子弹与怪物的外观区分。
 * 主游戏（main.ts）与卡牌实验室（lab.ts）共用，保证两端视觉一致。
 * 坐标系：调用方已做 y 轴翻转，这里直接使用游戏坐标（y 向上）。
 */
import { MonsterRuntime, MonsterShot, ProjectileRuntime } from '../../gamecore';

/** 怪物配色：同族珊瑚色系渐变 + 岩甲灰蓝（docs/06 色板纪律内）。 */
const MONSTER_COLOR: Record<string, string> = {
  slime: '#FF6B57',
  wolf: '#FF8357',
  charger: '#FFA25E',
  thrower: '#FF5E7A',
  bulwark: '#8A93B8',
  bat: '#FF7EC7',
  shroom: '#FF6B9C',
  boss: '#B537F2',
  shaman: '#B388FF',
};

export function monsterColor(m: MonsterRuntime): string {
  return MONSTER_COLOR[m.cfg.shape ?? 'slime'] ?? '#FF6B57';
}

function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** 按种类绘制怪物（t = 秒，用于行走进缩与扑翼）。状态指示（冰环/火）由调用方叠加。 */
export function drawMonster(ctx: CanvasRenderingContext2D, m: MonsterRuntime, t: number): void {
  const r = m.cfg.radius;
  const moving = m.state === 'march';
  const color = monsterColor(m);
  ctx.fillStyle = color;
  const x = m.x;
  const y = m.y;

  switch (m.cfg.shape) {
    case 'wolf': {
      // 尖三角（朝下压墙）+ 冲刺拉伸
      const stretch = moving ? 1 + 0.15 * Math.sin(t * 8 + m.phase) : 1;
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(1, stretch);
      ctx.beginPath();
      ctx.moveTo(0, -r);
      ctx.lineTo(-r * 0.85, r * 0.8);
      ctx.lineTo(r * 0.85, r * 0.8);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      break;
    }
    case 'charger': {
      // 瘦长尖梭（极速感）
      ctx.save();
      ctx.translate(x, y);
      ctx.beginPath();
      ctx.moveTo(0, -r * 1.4);
      ctx.lineTo(-r * 0.55, r);
      ctx.lineTo(r * 0.55, r);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      break;
    }
    case 'thrower': {
      // 梯形 + 长矛
      ctx.beginPath();
      ctx.moveTo(x - r * 0.8, y - r * 0.7);
      ctx.lineTo(x + r * 0.8, y - r * 0.7);
      ctx.lineTo(x + r * 0.5, y + r * 0.8);
      ctx.lineTo(x - r * 0.5, y + r * 0.8);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(x, y + r * 0.3);
      ctx.lineTo(x, y + r * 1.6);
      ctx.stroke();
      break;
    }
    case 'bulwark': {
      // 六边形重甲 + 内甲片
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 3) * i + Math.PI / 6;
        const px = x + Math.cos(a) * r;
        const py = y + Math.sin(a) * r;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(11,12,29,.55)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 3) * i + Math.PI / 6;
        const px = x + Math.cos(a) * r * 0.55;
        const py = y + Math.sin(a) * r * 0.55;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.stroke();
      break;
    }
    case 'bat': {
      // 双翼（扑翼缩放）
      const flap = 0.75 + 0.3 * Math.sin(t * 12 + m.phase);
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(1, flap);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(-r * 1.3, -r * 0.7);
      ctx.lineTo(-r * 0.9, r * 0.5);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(r * 1.3, -r * 0.7);
      ctx.lineTo(r * 0.9, r * 0.5);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      break;
    }
    case 'shroom': {
      // 叠圆：伞盖 + 柄
      ctx.beginPath();
      ctx.arc(x, y + r * 0.35, r * 0.55, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, y - r * 0.35, r * 0.85, Math.PI, 0);
      ctx.fill();
      break;
    }
    case 'boss': {
      // 巨型 Boss：尖刺重环 + 核心（缓慢脉动）
      const pulse = 1 + 0.04 * Math.sin(t * 2.4 + m.phase);
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(pulse, pulse);
      ctx.beginPath();
      for (let i = 0; i < 12; i++) {
        const a = (Math.PI / 6) * i;
        const rad = i % 2 === 0 ? r * 1.15 : r * 0.92;
        const px = Math.cos(a) * rad;
        const py = Math.sin(a) * rad;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = 'rgba(11,12,29,.5)';
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      break;
    }
    case 'shaman': {
      // 巫师：菱形法袍 + 头顶悬浮法球（呼吸浮动）
      const bob = Math.sin(t * 3 + m.phase) * 3;
      ctx.beginPath();
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r * 0.75, y);
      ctx.lineTo(x, y + r);
      ctx.lineTo(x - r * 0.75, y);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#F5F5FA';
      ctx.beginPath();
      ctx.arc(x, y - r - 8 + bob, 5, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'slime':
    default: {
      // 圆角方块 squash 弹跳
      const sq = moving ? 1 + 0.12 * Math.sin(t * 6 + m.phase) : 1;
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(2 - sq, sq);
      rr(ctx, -r, -r, r * 2, r * 2, r * 0.45);
      ctx.fill();
      ctx.restore();
      break;
    }
  }
}

/**
 * 按武器绘制子弹（t = 秒）。
 * dot 光点+拖尾 / arrow 箭矢 / bomb 抛物弹（带投影与引线）/ crescent 旋转 V 刃。
 */
export function drawProjectile(
  ctx: CanvasRenderingContext2D,
  p: ProjectileRuntime,
  t: number,
  color: string,
): void {
  const shape = p.weapon.cfg.shape ?? 'dot';
  const dx = p.x - p.px;
  const dy = p.y - p.py;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;

  switch (shape) {
    case 'arrow': {
      // 箭矢：杆 + 三角箭头，沿速度方向
      const shaft = 22;
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(p.x - ux * shaft, p.y - uy * shaft);
      ctx.lineTo(p.x + ux * 6, p.y + uy * 6);
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.beginPath();
      const px = -uy;
      const py = ux;
      ctx.moveTo(p.x + ux * 12, p.y + uy * 12);
      ctx.lineTo(p.x - ux * 2 + px * 4.5, p.y - uy * 2 + py * 4.5);
      ctx.lineTo(p.x - ux * 2 - px * 4.5, p.y - uy * 2 - py * 4.5);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'bomb': {
      // 投影 + 抛物线高度处的弹体 + 引线火花
      const h = p.height;
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, 9, 3.5, 0, 0, Math.PI * 2);
      ctx.fill();
      const by = p.y + h;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(p.x, by, p.radius + 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(11,12,29,.6)';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(p.x, by + p.radius + 3);
      ctx.lineTo(p.x + 3, by + p.radius + 8);
      ctx.stroke();
      ctx.fillStyle = `rgba(255,213,79,${0.6 + 0.4 * Math.sin(t * 20)})`;
      ctx.beginPath();
      ctx.arc(p.x + 3, by + p.radius + 9, 2.2, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'gear':
    case 'crescent': {
      // 齿轮圆盘（血滴子）：大圆盘 + 外齿 + 内环镂空，持续自转
      const R = 17;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(t * 10 + p.id);
      ctx.fillStyle = color;
      for (let i = 0; i < 8; i++) {
        ctx.save();
        ctx.rotate((Math.PI / 4) * i);
        ctx.fillRect(-2.5, -R - 4.5, 5, 6.5);
        ctx.restore();
      }
      ctx.beginPath();
      ctx.arc(0, 0, R, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#0B0C1D';
      ctx.beginPath();
      ctx.arc(0, 0, R * 0.45, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      break;
    }
    case 'dot':
    default: {
      ctx.strokeStyle = color + '66';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(p.x - ux * 30, p.y - uy * 30);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
  }
}

/** 怪物远程弹：投矛=细长梭标，投石=带投影的抛物石块（警示橙）。 */
export function drawMonsterShot(ctx: CanvasRenderingContext2D, s: MonsterShot): void {
  const color = '#FFB357';
  if (s.kind === 'rock') {
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.beginPath();
    ctx.ellipse(s.x, s.ty, 10, 4, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(s.x, s.y + s.height, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(11,12,29,.5)';
    ctx.lineWidth = 2;
    ctx.stroke();
  } else {
    const dx = s.tx - s.sx;
    const dy = s.ty - s.sy;
    const l = Math.hypot(dx, dy) || 1;
    const ux = dx / l;
    const uy = dy / l;
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(s.x - ux * 16, s.y - uy * 16 + s.height);
    ctx.lineTo(s.x + ux * 4, s.y + uy * 4 + s.height);
    ctx.stroke();
  }
}

/** 治疗光环脉冲：绿色扩散环（k = 0~1 进度）。 */
export function drawHealPulse(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, k: number): void {
  const alpha = 0.5 * (1 - k);
  ctx.strokeStyle = `rgba(124,179,66,${alpha})`;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(x, y, radius * (0.3 + 0.7 * k), 0, Math.PI * 2);
  ctx.stroke();
}
