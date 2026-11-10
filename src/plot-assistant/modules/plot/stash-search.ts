/**
 * plot/stash-search.ts — 暂存区搜索的纯函数层
 *
 * 面板上的搜索/替换（2026-11-08 批 45）要跨「所有楼层的所有版本」找一段文字，
 * 还要在查看器的正文框里把匹配处涂上颜色。找匹配、算替换、拼高亮这三件事
 * 只依赖传进来的字符串，不碰任何酒馆或面板状态 —— 这一文件可以在没有酒馆的
 * 环境里被完整测到（tools/plot-parity/stash-search-test.ts）。
 *
 * 口径：
 * - **大小写不敏感**（与记事本默认一致；中文场景本就没有大小写之分）。
 * - query 是空串就不搜：返回空表，面板那层拿空表隐藏全部高亮与导航。
 * - **匹配不重叠**：从上一个匹配的结尾接着找（`aba` 里搜 `ab` 只中一处），
 *   免得替换时前一处吃掉后一处的起点。
 * - 高亮 HTML 走「先转义、再切片插 mark」：暂存正文里满是 `<标签>`，
 *   直接塞 v-html 会把正文当标签渲染，必须整段转义。
 */

/** 一处匹配在文本里的字符区间（`end` 不含，`[start, end)` 半开区间）。 */
export interface SearchMatch {
  start: number;
  end: number;
}

/**
 * 找出 query 在 text 里的全部位置（大小写不敏感，不重叠，按出现顺序）。
 * query 为空串（或 text 不是字符串）给空表。
 */
export function findMatches(text: string, query: string): SearchMatch[] {
  const source = typeof text === 'string' ? text : '';
  const needle = typeof query === 'string' ? query : '';
  if (needle === '' || source === '') return [];
  const haystack = source.toLowerCase();
  const target = needle.toLowerCase();
  if (target.length > haystack.length) return [];

  const out: SearchMatch[] = [];
  let from = 0;
  for (;;) {
    const index = haystack.indexOf(target, from);
    if (index < 0) break;
    out.push({ start: index, end: index + target.length });
    // 从匹配结尾继续找。target 长度至少 1，循环必然前进，不会死循环。
    from = index + target.length;
  }
  return out;
}

/** 把一处匹配换成 replacement，返回新文本。区间外的字符一个不动。 */
export function replaceMatch(text: string, match: SearchMatch, replacement: string): string {
  const source = typeof text === 'string' ? text : '';
  if (match.start < 0 || match.end > source.length || match.start > match.end) return source;
  return source.slice(0, match.start) + replacement + source.slice(match.end);
}

/**
 * 全部替换（大小写不敏感，与 `findMatches` 同一套匹配口径）。
 * 返回新文本和替换处数，面板拿处数提示「替换了 N 处」。
 */
export function replaceAllMatches(
  text: string,
  query: string,
  replacement: string,
): { text: string; count: number } {
  const source = typeof text === 'string' ? text : '';
  const matches = findMatches(source, query);
  if (matches.length === 0) return { text: source, count: 0 };
  let out = '';
  let cursor = 0;
  for (const match of matches) {
    out += source.slice(cursor, match.start) + replacement;
    cursor = match.end;
  }
  out += source.slice(cursor);
  return { text: out, count: matches.length };
}

/** 把文本转义成安全的 HTML 片段（v-html 用，正文里的 `<标签>` 必须当纯文字显示）。 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 拼查看器投影层的高亮 HTML：全部匹配包淡色 `mark.acu-hit`，
 * `currentIndex` 指的那处再叠 `acu-hit--current`（面板样式里给橙色）。
 *
 * @param currentIndex 当前匹配在 `matches` 里的下标；越界或 -1 表示没有「当前」，
 *   全部按普通匹配涂色（输入到一半还没跳转时的样子）。
 */
export function buildHighlightHtml(text: string, matches: SearchMatch[], currentIndex: number): string {
  const source = typeof text === 'string' ? text : '';
  const safeMatches = Array.isArray(matches) ? matches : [];
  if (safeMatches.length === 0) return escapeHtml(source);

  // 保险丝：匹配区间必须在文本范围内且互不越界，脏区间按没有处理（宁可不高亮，不可错位）。
  const usable = safeMatches.filter(
    (match) =>
      Number.isInteger(match.start) &&
      Number.isInteger(match.end) &&
      match.start >= 0 &&
      match.end <= source.length &&
      match.start < match.end,
  );
  if (usable.length === 0) return escapeHtml(source);

  let out = '';
  let cursor = 0;
  usable.forEach((match, index) => {
    out += escapeHtml(source.slice(cursor, match.start));
    const cls = index === currentIndex ? 'acu-hit acu-hit--current' : 'acu-hit';
    out += `<mark class="${cls}">${escapeHtml(source.slice(match.start, match.end))}</mark>`;
    cursor = match.end;
  });
  out += escapeHtml(source.slice(cursor));
  return out;
}
