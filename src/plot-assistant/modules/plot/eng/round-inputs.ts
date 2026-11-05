/**
 * 一轮任务要用的占位符表：把「这次发送的上下文」翻译成 `performReplacements` 能吃的对象。
 *
 * 这里只有一条真判断，其余都是搬运：
 *
 * **表里必须始终有全部键，缺的值填空串，不能干脆不给这个键。**
 * 因为 `performReplacements` 只替换「表里存在的键」，表里没有 `$U`，提示词里就会留下
 * 一个字面量 `$U` 原样发给 AI —— 不报错、不影响运行，只是模型看到一段垃圾指令。
 *
 * 另外 `$1` / `$9` 在这里**不套信封**（不要自己拼 `<worldbook_context>`）：
 * 信封由 `wrapWorldbookContext` 在替换时统一加，而且「内容为空则整个信封消失」也归它管。
 * 这里提前包一层的话，空内容会变成一对空标签，AI 会以为「这轮没有世界书」而不是「没开这个功能」。
 */

import type { PlotTaskResult } from './assemble';

/** 表里固定会有的键。顺序按「人设 → 世界书 → 前情 → 本轮」排，方便对照 ACU 的提示词。 */
export const ROUND_KEYS = [
  '$U',
  '$C',
  '$1',
  '$9',
  '$5',
  '$7',
  '$6',
  '$8',
  'sulv1',
  'sulv2',
  'sulv3',
  'sulv4',
  'zhaohui',
] as const;

export type RoundKey = (typeof ROUND_KEYS)[number];

export interface RoundReplacementsInput {
  /** `$U` 用户人设。取值属取数层（酒馆里怎么存人设是另一件事），这里只收字符串。 */
  userPersona?: string | null;
  /** `$C` 角色卡。同上。 */
  characterCard?: string | null;
  /** `$1` 本轮命中的世界书（不含信封）。 */
  worldbookContent?: string | null;
  /** `$9` 世界书里剔掉数据库生成条目的那一份（不含信封）。 */
  worldbookDatabaseExcluded?: string | null;
  /** `$5` 纪要索引 / 总体大纲。 */
  summaryIndex?: string | null;
  /** `$7` 前文摘要（`buildHistoryDigest` 的产物，已自带前缀）。 */
  historyDigest?: string | null;
  /** `$6` 上一轮 `<plot>`。按任务取不同值时，用 `taskOverrides` 覆盖这一项。 */
  previousPlot?: string | null;
  /** `$8` 本轮用户输入。 */
  userInput?: string | null;
  /** 强度四档。 */
  strengths?: Partial<Record<'sulv1' | 'sulv2' | 'sulv3' | 'sulv4', string | null>>;
  /** 召回条数。 */
  zhaohui?: string | number | null;
}

/** 统一把「没有 / null / undefined / 数字」收成字符串。数字是留给 `zhaohui` 的。 */
function text(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

/**
 * 组装占位符表。**永远返回全部 13 个键**，一个不缺。
 *
 * 不要把这里做成「只返回有值的键」——那正是上面注释里说的那类静默错误。
 */
export function buildRoundReplacements(input: RoundReplacementsInput = {}): Record<string, string> {
  const strengths = input.strengths || {};
  return {
    $U: text(input.userPersona),
    $C: text(input.characterCard),
    $1: text(input.worldbookContent),
    $9: text(input.worldbookDatabaseExcluded),
    $5: text(input.summaryIndex),
    $7: text(input.historyDigest),
    $6: text(input.previousPlot),
    $8: text(input.userInput),
    sulv1: text(strengths.sulv1),
    sulv2: text(strengths.sulv2),
    sulv3: text(strengths.sulv3),
    sulv4: text(strengths.sulv4),
    zhaohui: text(input.zhaohui),
  };
}

/**
 * 有的任务要读「自己上一次的输出」而不是「上一轮的 `<plot>`」（`$6` 的 `taskId` 分支）。
 * 这个函数把某一个任务的 `$6` 单独换掉，其余键原样带过。
 */
export function withTaskPreviousPlot(
  replacements: Record<string, string>,
  previousPlot: string | null | undefined,
): Record<string, string> {
  return { ...replacements, $6: text(previousPlot) };
}

/** 汇总这一轮一共产生了哪些标签名（供面板显示「这一轮写了哪些节」）。 */
export function collectTagNames(results: PlotTaskResult[] | null | undefined): string[] {
  const names = new Set<string>();
  for (const result of results || []) {
    if (!result || result.success !== true) continue;
    const tags = result.extractedTags || {};
    for (const name of Object.keys(tags)) names.add(name);
  }
  return [...names];
}
