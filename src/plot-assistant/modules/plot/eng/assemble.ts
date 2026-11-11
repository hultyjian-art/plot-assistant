/**
 * 剧情推进 — 结果排序、聚合与最终拼装（纯函数）
 *
 * 对应 ACU `plot-tag-utils.ts` 的后半段（排序 / 聚合 / 拼 `<plot>`），重写为无副作用实现。
 * 对齐由 `tools/plot-parity` 的对照测试保证，改之前先跑。
 *
 * 这里决定的是「哪些标签最终进正文、放在哪」。**这一处与 ACU 有意不同**（见施工方案 §13.4）：
 *   - 正文里出现哪个标签，完全由模板里的 `{{标签}}` 决定；**模板没写的标签一律不注入**
 *     （ACU 原行为是「没写到模板里的自动追加到末尾」，会把后台记录也塞进正文）
 *   - `extractInjectTags` 的标签即使模板里写了也不注入，只留在字段里
 *   - 一个标签都没抽到时退回任务原文，否则内容全丢
 */
import { buildTagBlock, hasContent, lookupTag, normalizeAdjacentTagNewlines, normalizePositiveInteger, normalizeTagBlockNewlines, type TagMap } from './tags';

/** 一次任务跑完的回执。字段宽松到能直接接住 ACU 的形状。 */
export interface PlotTaskResult {
  taskId?: string;
  taskName?: string;
  stage?: number;
  order?: number;
  success?: boolean;
  rawResponse?: string;
  /** 最后一次拿到手的原文（含没过验收的那次）。只给日志用，不参与正文拼接。 */
  lastRawResponse?: string;
  /** 模型推理内容（酒馆支持 `should_return_reasoning` 时才有）；只给日志看，不进正文。 */
  reasoning?: string;
  extractedTags?: Record<string, string>;
  injectOnlyTagNames?: string[];
}

/** 最终注入模板没写内容时用的兜底指令。 */
export const DEFAULT_DIRECTIVE =
  '[SYSTEM_DIRECTIVE: You are a storyteller. The following <plot> block is your absolute script for this turn. You MUST follow the <directive> within it to generate the story.]';

/** 先按阶段、再按任务序号排。阶段与序号都按正整数规整，脏值退回 1 / 原值。 */
export function sortTaskResults(results: ReadonlyArray<PlotTaskResult | null | undefined>): PlotTaskResult[] {
  const list = Array.isArray(results) ? [...results] : [];
  return list
    .filter((result): result is PlotTaskResult => Boolean(result))
    .sort(
      (a, b) =>
        normalizePositiveInteger(a.stage, 1) - normalizePositiveInteger(b.stage, 1) || (a.order ?? 0) - (b.order ?? 0),
    );
}

/**
 * 把每个任务提取到的标签按名字聚到一起。
 *
 * 同一标签被多个任务产出时按「阶段 → 序号」的顺序追加，段落之间后面会用空行拼起来。
 * 只收成功的任务；同时汇总哪些标签名属于 injectOnly（那批不进正文）。
 */
export function aggregateTaskTags(taskResults: ReadonlyArray<PlotTaskResult | null | undefined>): {
  aggregated: Map<string, string[]>;
  injectOnlyTagNames: Set<string>;
} {
  const aggregated = new Map<string, string[]>();
  const injectOnlyTagNames = new Set<string>();

  for (const result of sortTaskResults(taskResults)) {
    if (!result.success || !result.extractedTags || typeof result.extractedTags !== 'object') continue;

    for (const [tagName, content] of Object.entries(result.extractedTags)) {
      const bucket = aggregated.get(tagName);
      if (bucket) bucket.push(content ?? '');
      else aggregated.set(tagName, [content ?? '']);
    }

    if (Array.isArray(result.injectOnlyTagNames)) {
      for (const name of result.injectOnlyTagNames) injectOnlyTagNames.add(name);
    }
  }

  return { aggregated, injectOnlyTagNames };
}

/** 标签表 → 若干 `<标签>…</标签>`，块之间空行分隔。 */
export function buildAggregatedBlocks(aggregatedTags: TagMap): string {
  if (!(aggregatedTags instanceof Map) || aggregatedTags.size === 0) return '';

  const blocks: string[] = [];
  aggregatedTags.forEach((contents, tagName) => {
    const block = buildTagBlock(tagName, contents);
    if (block) blocks.push(block);
  });

  return blocks.join('\n\n');
}

/**
 * 兜底正文：把成功的任务原文按顺序拼起来。
 *
 * 一个都没有 → 空串；只有一个 → 就是它本身（不加任何前缀）；
 * 多个才加「【剧情任务：名字】」分隔，否则读者分不清哪段是谁写的。
 */
export function buildRawFallbackText(taskResults: ReadonlyArray<PlotTaskResult | null | undefined>): string {
  const successful = sortTaskResults(taskResults).filter(
    (result) => result.success && typeof result.rawResponse === 'string' && result.rawResponse.trim(),
  );

  if (successful.length === 0) return '';
  if (successful.length === 1) return normalizeTagBlockNewlines((successful[0].rawResponse as string).trim());

  return successful
    .map(
      (result) =>
        `【剧情任务：${result.taskName || result.taskId || '未命名任务'}】\n${normalizeTagBlockNewlines(
          (result.rawResponse as string).trim(),
        )}`,
    )
    .join('\n\n');
}

/** 落盘用正文 = 兜底正文（语义相同，单独一个名字方便以后分叉）。 */
export function buildSaveContent(taskResults: ReadonlyArray<PlotTaskResult | null | undefined>): string {
  return buildRawFallbackText(taskResults);
}

/** 占位符模板：`{{标签}}`。只认 ASCII 名（与上游一致，中文标签名不算占位符）。 */
const PLACEHOLDER_PATTERN = /\{\{(\w+)\}\}/g;

/**
 * 拼最终的 `<plot>` 注入内容。
 *
 * **严格模式（与 ACU 有意不同）**：正文里出现什么，完全由模板里的 `{{标签}}` 决定。
 * 模板没写的标签不注入 —— 这样「只存字段、不进正文」的后台记录才真的不占正文 token。
 *
 * @param finalSystemDirectiveContent 用户配置的最终注入模板；留空则用 DEFAULT_DIRECTIVE
 * @param taskResults 本轮所有任务回执
 * @param aggregatedTags 聚合后的标签表
 */
export function buildFinalMessage(
  finalSystemDirectiveContent: string,
  taskResults: ReadonlyArray<PlotTaskResult | null | undefined>,
  aggregatedTags: TagMap,
): string {
  const baseDirective = String(finalSystemDirectiveContent || '').trim() || DEFAULT_DIRECTIVE;
  const rawFallbackText = buildRawFallbackText(taskResults);
  const placeholderNames = collectPlaceholderNames(baseDirective);

  if (aggregatedTags instanceof Map && aggregatedTags.size > 0) {
    if (placeholderNames.length > 0) {
      return baseDirective
        .replace(PLACEHOLDER_PATTERN, (_placeholder, tagName: string) => {
          const resolved = lookupTag(aggregatedTags, tagName);
          if (!hasContent(resolved.value)) return '';
          // 聚合块拼完就规整（这条路此前零规整，闭标签会贴在表格行尾）；
          // 只规整块本身，不碰指令文本与块之间的换行
          return normalizeAdjacentTagNewlines(buildTagBlock(tagName, resolved.value));
        })
        .trim();
    }

    // 模板里一个 {{标签}} 都没写：不注入任何标签，只留指令
    return baseDirective;
  }

  if (placeholderNames.length > 0) {
    const directiveWithoutTags = baseDirective.replace(PLACEHOLDER_PATTERN, '');
    return [directiveWithoutTags.trim(), rawFallbackText].filter(Boolean).join('\n');
  }

  return [baseDirective, rawFallbackText].filter(Boolean).join('\n');
}

/** 模板里出现的 `{{标签}}` 名字（去重，按出现顺序）—— 暂存区用它判断「哪些标签本该进正文」。 */
export function collectDirectiveTagNames(text: string): string[] {
  return [...new Set(collectPlaceholderNames(text))];
}

/** 模板里出现的 `{{标签}}` 名字（保留重复，判空只看有没有）。 */
function collectPlaceholderNames(text: string): string[] {
  const pattern = /\{\{(\w+)\}\}/g;
  const names: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) names.push(match[1]);
  return names;
}
