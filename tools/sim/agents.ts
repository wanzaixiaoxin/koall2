import { HeroController } from '../../src/gamecore';
import { CasualAIController } from './casual';
import { SimAIController } from './controller';

/** 走位策略名（--move）：与选卡策略（--cards）相互独立，方便做 走位×构筑 对照矩阵。 */
export type MoveName = 'sim' | 'sim-legacy' | 'casual';

/**
 * 走位策略工厂：
 * - sim        武器感知版 SimAI（推荐，默认）
 * - sim-legacy 改动前旧版 SimAI（贴墙追前哨；仅供 A/B 对比复现）
 * - casual     拟真噪声版（0.7s 决策节拍 + 噪声 + 发呆）
 */
export function createController(move: MoveName, seed: number): HeroController {
  switch (move) {
    case 'casual':
      return new CasualAIController(seed);
    case 'sim-legacy':
      return new SimAIController(false);
    case 'sim':
    default:
      return new SimAIController();
  }
}
