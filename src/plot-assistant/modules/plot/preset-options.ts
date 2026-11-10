/**
 * 「`$7 默认上下文`」的全局设置 → 预设导入兜底项。
 *
 * 单独放一层是为了让预览和真跑用同一份 options：两边只要有一边漏传，
 * 用户在面板上调的条数/提取规则就会出现「预览生效、真跑不生效」（或反过来）。
 */
import type { RerushSettings } from '../types';
import type { ImportPresetOptions } from './eng/preset-import';

export function presetImportOptions(plot: RerushSettings['plot']): ImportPresetOptions {
  const defaults = plot.contextDefaults;
  return {
    defaultContextTurnCount: defaults.turnCount,
    defaultExtractRules: defaults.extractRules,
    defaultExcludeRules: defaults.excludeRules,
  };
}
