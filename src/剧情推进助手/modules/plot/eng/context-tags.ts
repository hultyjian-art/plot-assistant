/**
 * 上下文标签过滤 —— 移植自 ACU `src/service/runtime/helpers-context-tags.ts`
 *
 * 用途：`$7` 前文、`$1` 世界书这类「贴一段原文给 AI」的内容，进去之前先清洗一遍。
 * 两种动作：只留指定的几段（extract）、删掉指定的几段（exclude）。
 *
 * 规则不是正则，是「起止边界字符串」—— 例如 `{ start: '<disclaimer', end: '</disclaimer>' }`。
 * 所以边界串里的 `<`、`>`、`[`、`(` 一律按字面匹配，不需要转义，也不会被当成模式。
 * 这一点和项目里其它地方用正则的做法不同，改的时候别顺手换成 RegExp。
 */

export interface BoundaryRule {
  start: string;
  end: string;
}

export interface ContextFilterOptions {
  /** 旧式「标签名列表」字符串，逗号 / 中文逗号 / 空格分隔；只在规则数组为空时兜底生效 */
  extractTags?: string;
  extractRules?: BoundaryRule[] | null;
  excludeTags?: string;
  excludeRules?: BoundaryRule[] | null;
}

/** 把 `tagA,tagB` 这种旧写法拆成标签名数组；尖括号会被剥掉 */
function parseTagList(input: unknown): string[] {
  if (!input || typeof input !== 'string') return [];
  return input
    .split(/[,，\s]+/g)
    .map(t => t.trim())
    .filter(Boolean)
    .map(t => t.replace(/[<>]/g, ''));
}

/** 旧式标签名 → 边界规则：`tagA` ⇒ `{ start: '<tagA', end: '</tagA>' }` */
export function boundaryRulesFromLegacyTags(tagsText = ''): BoundaryRule[] {
  return parseTagList(tagsText).map(tag => ({ start: `<${tag}`, end: `</${tag}>` }));
}

/**
 * 规则归一化。提取与排除共用同一套（ACU 里 extract 就是直接转调 exclude）。
 *
 * 三形态兼容：
 * - 字符串 `'<a>|</a>'` —— 最后一个 `|` 右边全部当 end（所以 end 里可以有 `|`）
 * - 对象 `{ start, end }`，也认 `begin` / `open` 与 `close` / `finish`
 * - 整个数组为空（或压根不是数组）时，退回 `legacyTags` 拼出来的规则
 */
export function normalizeRules(
  input: BoundaryRule[] | string[] | null | undefined | unknown,
  legacyTags = '',
): BoundaryRule[] {
  const normalized: BoundaryRule[] = [];
  const dedup = new Set<string>();

  const pushRule = (startRaw: unknown, endRaw: unknown) => {
    const start = String(startRaw || '').trim();
    const end = String(endRaw || '').trim();
    if (!start || !end) return;
    const key = `${start}\u0000${end}`;
    if (dedup.has(key)) return;
    dedup.add(key);
    normalized.push({ start, end });
  };

  if (Array.isArray(input)) {
    (input as unknown[]).forEach(rule => {
      if (!rule) return;
      if (typeof rule === 'string') {
        const parts = rule.split('|');
        if (parts.length >= 2) {
          const start = parts.shift();
          const end = parts.join('|');
          pushRule(start, end);
        }
        return;
      }
      if (typeof rule === 'object') {
        const obj = rule as Record<string, unknown>;
        pushRule(obj.start ?? obj.begin ?? obj.open, obj.end ?? obj.close ?? obj.finish);
      }
    });
  }

  if (normalized.length === 0) {
    boundaryRulesFromLegacyTags(legacyTags).forEach(rule => pushRule(rule.start, rule.end));
  }

  return normalized;
}

/**
 * 删掉所有成对出现的区间。用栈配对 —— 支持嵌套，也容忍落单的开头/结尾。
 *
 * 落单的处理：只有「配上了对」的区间才删，孤立的 `<x` 或 `</x>` 原样留着。
 * 多个区间先排序再合并重叠，最后从后往前切，避免下标失效。
 */
function removeMatchedBoundaries(text: string, startBoundary: string, endBoundary: string): string {
  const source = String(text ?? '');
  const start = String(startBoundary || '');
  const end = String(endBoundary || '');
  if (!source || !start || !end) return source;

  const lowerSource = source.toLowerCase();
  const lowerStart = start.toLowerCase();
  const lowerEnd = end.toLowerCase();
  const openStartIndexes: number[] = [];
  const matchedRanges: Array<{ start: number; end: number }> = [];
  let searchIndex = 0;

  while (searchIndex < lowerSource.length) {
    const nextStartIdx = lowerSource.indexOf(lowerStart, searchIndex);
    const nextEndIdx = lowerSource.indexOf(lowerEnd, searchIndex);
    if (nextStartIdx === -1 && nextEndIdx === -1) break;

    const isStartBoundary = nextStartIdx !== -1 && (nextEndIdx === -1 || nextStartIdx <= nextEndIdx);
    if (isStartBoundary) {
      openStartIndexes.push(nextStartIdx);
      searchIndex = nextStartIdx + lowerStart.length;
      continue;
    }

    if (openStartIndexes.length > 0) {
      const matchedStartIdx = openStartIndexes.pop() as number;
      const matchedEndIdx = nextEndIdx + lowerEnd.length;
      if (matchedEndIdx > matchedStartIdx) {
        matchedRanges.push({ start: matchedStartIdx, end: matchedEndIdx });
      }
    }
    searchIndex = nextEndIdx + lowerEnd.length;
  }

  if (matchedRanges.length === 0) return source;

  matchedRanges.sort((left, right) => left.start - right.start || left.end - right.end);
  const mergedRanges: Array<{ start: number; end: number }> = [];
  matchedRanges.forEach(range => {
    const previousRange = mergedRanges[mergedRanges.length - 1];
    if (!previousRange || range.start > previousRange.end) {
      mergedRanges.push({ ...range });
      return;
    }
    previousRange.end = Math.max(previousRange.end, range.end);
  });

  let result = source;
  for (let rangeIndex = mergedRanges.length - 1; rangeIndex >= 0; rangeIndex--) {
    const range = mergedRanges[rangeIndex];
    result = result.slice(0, range.start) + result.slice(range.end);
  }
  return result;
}

/**
 * 按排除规则清洗。所有规则依次作用（不是任一命中）。
 * 收尾会压掉三连以上换行并 trim —— 删掉一段后留下的空行靠这个收干净。
 */
export function applyExcludeRules(
  text: string,
  { excludeRules = [] as BoundaryRule[], excludeTags = '' }: Pick<ContextFilterOptions, 'excludeRules' | 'excludeTags'> = {},
): string {
  let result = String(text ?? '');
  const rules = normalizeRules(excludeRules, excludeTags);
  if (!result || rules.length === 0) return result;

  rules.forEach(rule => {
    result = removeMatchedBoundaries(result, rule.start, rule.end);
  });

  return result.replace(/\n{3,}/g, '\n\n').trim();
}

/** 取最后一个完整的 `<start ... end>` 区间（含两端边界本身） */
function extractLastMatchedBoundary(text: string, startBoundary: string, endBoundary: string): string | null {
  const source = String(text ?? '');
  const start = String(startBoundary || '');
  const end = String(endBoundary || '');
  if (!source || !start || !end) return null;

  const lowerSource = source.toLowerCase();
  const lowerStart = start.toLowerCase();
  const lowerEnd = end.toLowerCase();

  const endIdx = lowerSource.lastIndexOf(lowerEnd);
  if (endIdx === -1) return null;
  const startIdx = lowerSource.lastIndexOf(lowerStart, Math.max(0, endIdx - 1));
  if (startIdx === -1) return null;

  const rangeEnd = endIdx + end.length;
  if (rangeEnd <= startIdx) return null;
  return source.slice(startIdx, rangeEnd);
}

/**
 * 按提取规则清洗：每条规则各取最后一段命中，用空行拼起来。
 *
 * 注意「一条都没命中就原样返回」—— 这里不是「返回空」。
 * 含义是：这段文本压根没有这些结构，说明它本来就不是被包裹的格式，保持原样更安全。
 */
function applyExtractRules(
  text: string,
  { extractRules = [] as BoundaryRule[], extractTags = '' }: Pick<ContextFilterOptions, 'extractRules' | 'extractTags'> = {},
): string {
  const source = String(text ?? '');
  const rules = normalizeRules(extractRules, extractTags);
  if (!source || rules.length === 0) return source;

  const parts: string[] = [];
  rules.forEach(rule => {
    const matched = extractLastMatchedBoundary(source, rule.start, rule.end);
    if (matched !== null) parts.push(matched);
  });
  if (parts.length === 0) return source;
  return parts.join('\n\n');
}

/** 总入口：先提取、后排除。顺序不可换 —— 先删后提会把要提的内容一起删掉。 */
export function applyContextTagFilters(text: string, options: ContextFilterOptions = {}): string {
  const { extractTags = '', extractRules = [] as BoundaryRule[], excludeTags = '', excludeRules = [] as BoundaryRule[] } = options;
  let result = String(text ?? '');
  result = applyExtractRules(result, { extractRules, extractTags });
  result = applyExcludeRules(result, { excludeRules, excludeTags });
  return result;
}
