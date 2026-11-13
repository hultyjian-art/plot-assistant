/**
 * 剧情推进 — 标签与占位符工具（纯函数）
 *
 * 算法逐条对齐 ACU 的 `src/service/runtime/plot-runtime/plot-tag-utils.ts`（tag naiv1.3），
 * 但重写成不依赖任何全局状态：不读 settings、不碰世界书、不碰表格，输入什么就输出什么。
 *
 * 为什么要重写而不是复制文件：plot-tag-utils 第一行 import 的是 `../template-vars`（桶文件），
 * 顺藤摸瓜的传递闭包是 352 个文件 / 120,658 行 —— 详见施工方案 §4.1 的实测纠正。
 *
 * 对齐由 `tools/plot-parity` 的对照测试保证：同一输入喂给两边，输出必须逐字节相同。
 * 改这个文件之前先去跑那个测试。
 */

/** 标签内容：单个字符串、多段字符串，或还没取到。 */
export type TagValue = string | string[] | undefined;

/** 标签内容表：标签名 → 内容（数组 = 多段，段落之间用空行拼接）。 */
export type TagMap = Map<string, TagValue>;

export interface TagLookup {
  found: boolean;
  value: TagValue;
  /** 命中的真实标签名（大小写可能与查询名不同） */
  actualTagName: string;
}

/** 一次任务回传里提取出来的标签集合。 */
export interface TaskTagExtraction {
  /** 配置里点过名的全部标签（含没提取到的），顺序：inject 组在前、普通组在后 */
  tagNames: string[];
  /** 标签名 → 内容，供跨任务传递与占位符替换 */
  extractedTags: Record<string, string>;
  /** `<标签>内容</标签>` 形式的片段 */
  injectedFragments: string[];
  /** 记进「只进字段」名单的那批标签（只作标注，不决定正文注入） */
  injectOnlyTags: Record<string, string>;
  injectOnlyFragments: string[];
  injectOnlyTagNames: string[];
}

/** 提示词分段，只需要 content 字段。 */
export interface PromptSegmentLike {
  content?: unknown;
}

/** 每次都要一个新的正则实例，避免 lastIndex 在多次 exec 之间残留。 */
function newPlaceholderPattern(): RegExp {
  return /\{\{(\w+)\}\}/g;
}

/** 逗号分隔的标签名列表 → 去空数组（不做去重，与 ACU 一致）。 */
function splitTagNames(raw: string): string[] {
  return String(raw || '')
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
}

/** 把任意数值规整成「正整数」，拿不到就退回 fallback（下限 1）。 */
export function normalizePositiveInteger(value: unknown, fallbackValue: number = 1): number {
  const num = Number(value);
  if (Number.isFinite(num) && num > 0) return Math.floor(num);
  const fallback = Number(fallbackValue);
  return Number.isFinite(fallback) && fallback > 0 ? Math.floor(fallback) : 1;
}

/** 酒馆的 role 写法五花八门，统一成 assistant / system / user。 */
export function normalizeRole(role: string | null | undefined): string {
  const upper = String(role || '').toUpperCase();
  if (upper === 'AI' || upper === 'ASSISTANT') return 'assistant';
  if (upper === 'SYSTEM') return 'system';
  if (upper === 'USER') return 'user';
  return String(role || 'user').toLowerCase();
}

/**
 * 取「最后一个」标签的内容。
 *
 * 注意取的是最后一对：先找最后一个闭合，再在它之前找最近的开启。
 * 所以 `<a>x</a><a>y</a>` 得到 `y`，而 `<a><a>x</a></a>` 得到 `x`。
 */
export function extractLastTag(text: string, rawTagName: string): string | null {
  if (!text || !rawTagName) return null;
  const tagName = String(rawTagName).trim();
  if (!tagName) return null;

  const source = String(text);
  const lower = source.toLowerCase();
  const open = `<${tagName.toLowerCase()}>`;
  const close = `</${tagName.toLowerCase()}>`;

  const closeIdx = lower.lastIndexOf(close);
  if (closeIdx === -1) return null;

  const openIdx = lower.lastIndexOf(open, closeIdx);
  if (openIdx === -1) return null;

  return source.slice(openIdx + open.length, closeIdx);
}

/** 取「全部」同名标签的内容，按出现顺序。 */
export function extractAllTags(text: string, rawTagName: string): string[] {
  if (!text || !rawTagName) return [];
  const tagName = String(rawTagName).trim();
  if (!tagName) return [];

  const source = String(text);
  const lower = source.toLowerCase();
  const open = `<${tagName.toLowerCase()}>`;
  const close = `</${tagName.toLowerCase()}>`;
  const contents: string[] = [];
  let searchIndex = 0;

  while (searchIndex < lower.length) {
    const openIdx = lower.indexOf(open, searchIndex);
    if (openIdx === -1) break;
    const contentStart = openIdx + open.length;
    const closeIdx = lower.indexOf(close, contentStart);
    if (closeIdx === -1) break;
    contents.push(source.slice(contentStart, closeIdx));
    searchIndex = closeIdx + close.length;
  }

  return contents;
}

/**
 * 按配置的两个标签名单从一次回传里提取内容。
 *
 * 关键规则：`extractInjectTags` 里的标签优先，同名（不分大小写）标签不会再被普通组提取一遍。
 * 这批标签同时进入 `extractedTags`（供聚合与 `{{标签}}` 占位符替换），另外记一份
 * `injectOnlyTagNames` 供日志/暂存区标注；是否进正文只由模板里的 `{{标签}}` 决定。
 */
export function extractTaskTags(text: string, extractTags: string, extractInjectTags: string = ''): TaskTagExtraction {
  const injectTagNames = splitTagNames(extractInjectTags);
  const normalTagNames = splitTagNames(extractTags);
  const injectLower = new Set(injectTagNames.map((tag) => tag.toLowerCase()));

  const extractedTags: Record<string, string> = {};
  const injectedFragments: string[] = [];
  const injectOnlyTags: Record<string, string> = {};
  const injectOnlyFragments: string[] = [];
  const injectOnlyTagNames: string[] = [];

  for (const tagName of injectTagNames) {
    const content = extractLastTag(text, tagName);
    if (content === null) continue;
    const fragment = buildTagBlock(tagName, content);
    injectOnlyTags[tagName] = content;
    injectOnlyFragments.push(fragment);
    injectOnlyTagNames.push(tagName);
    // 同时并入普通集合：跨任务传递与占位符替换都要能用
    extractedTags[tagName] = content;
    injectedFragments.push(fragment);
  }

  for (const tagName of normalTagNames) {
    if (injectLower.has(tagName.toLowerCase())) continue;
    const content = extractLastTag(text, tagName);
    if (content === null) continue;
    extractedTags[tagName] = content;
    injectedFragments.push(buildTagBlock(tagName, content));
  }

  return {
    tagNames: [...injectTagNames, ...normalTagNames],
    extractedTags,
    injectedFragments,
    injectOnlyTags,
    injectOnlyFragments,
    injectOnlyTagNames,
  };
}

/** 文本里所有 `{{标签}}` 的名字，去重保序。 */
export function listPlaceholderNames(text: string): string[] {
  const pattern = newPlaceholderPattern();
  const names: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(String(text || ''))) !== null) {
    const tagName = String(match[1] || '').trim();
    if (tagName) names.push(tagName);
  }

  return [...new Set(names)];
}

/**
 * 从一段文本建标签表。
 *
 * 给了名单就只找这几个（大小写不敏感、每名可多段）；没给名单就全扫 `<名>内容</名>`。
 * 没给名单时正则用的是反向引用 `\1`，所以 `<a>x</b>` 配不上。
 */
export function buildTagMap(
  text: string,
  requestedTagNames: string[] | null = null,
  extraTagNames: readonly string[] = [],
): Map<string, string[]> {
  const sourceText = String(text || '');
  const tagMap = new Map<string, string[]>();
  if (!sourceText.trim()) return tagMap;

  if (Array.isArray(requestedTagNames) && requestedTagNames.length > 0) {
    const names = [...new Set(requestedTagNames.map((name) => String(name || '').trim()).filter(Boolean))];
    for (const name of names) {
      const contents = extractAllTags(sourceText, name);
      if (contents.length > 0) tagMap.set(name, contents);
    }
    for (const rawName of extraTagNames) {
      const name = String(rawName || '').trim();
      if (!name) continue;
      const contents = extractAllTags(sourceText, name);
      if (contents.length > 0) tagMap.set(name, contents);
    }
    return tagMap;
  }

  const tagPattern = /<(\w+)>([\s\S]*?)<\/\1>/g;
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(sourceText)) !== null) {
    const tagName = String(match[1] || '').trim();
    if (!tagName) continue;
    const content = match[2] ?? '';
    const bucket = tagMap.get(tagName);
    if (bucket) bucket.push(content);
    else tagMap.set(tagName, [content]);
  }

  // 上面那轮只认最外层的一对 `<英文名>`；`character_archive` 嵌在 `character_info`
  // 里面时会被外层整块吃掉。这里再按已知标签名逐个找一遍，嵌套标签也能单独取到。
  for (const rawName of extraTagNames) {
    const name = String(rawName || '').trim();
    if (!name) continue;
    const contents = extractAllTags(sourceText, name);
    if (contents.length > 0) tagMap.set(name, contents);
  }

  return tagMap;
}

/**
 * 拼一个 `<标签>内容</标签>` 块。
 *
 * 空内容会拼成 `<标签></标签>`（不是空串）——因为单值传进来必然是长度 1 的数组。
 * 只有传空数组才会返回空串。这个边界跟 ACU 一致，别顺手「优化」掉。
 */
export function buildTagBlock(tagName: string, contents: TagValue): string {
  const normalizedTagName = String(tagName || '').trim();
  if (!normalizedTagName) return '';

  const list = (Array.isArray(contents) ? contents : [contents]).map((content) => ensureTableBodyNewline(content ?? ''));
  if (!list.length) return '';

  return `<${normalizedTagName}>${list.join('\n\n')}</${normalizedTagName}>`;
}

/**
 * 表格类标签内容如果紧贴着开标签（`<tag>| 表头 |`），补一个换行再拼。
 *
 * AI 有时会省掉开标签后的换行；这里只在「内容以竖线开头」时补，
 * 不碰普通正文，也不把已经有的换行再加一遍。
 */
function ensureTableBodyNewline(content: string): string {
  if (content === '') return content;
  if (content.startsWith('\n') || content.startsWith('\r')) return content;
  return /^[ \t]*\|/.test(content) ? `\n${content}` : content;
}

/**
 * 内容紧贴闭标签时，把闭标签单独挪到一行。
 *
 * 只处理「跨行块」：闭标签所在行之前已经存在换行（开标签另有其行、内容分了多行），
 * 最后一行内容才会紧贴 `</tag>` —— 表格 / 列表类标签的 `| 值 |</tag>` 就是这么来的。
 * 单行短标签（`<a>内容</a>`）不动：它本来就一行到尾，补换行反而把短标签拆开，
 * 也会挪动既有回传的字节；换行后紧跟开标签（指令另起一行、标签仍是一行到尾）也不动。
 * 闭标签前已经是换行、或闭标签已在行首时都不动，不重复补。
 * 标签名沿用 [A-Za-z_][\w-]*（与其余规则一致，中文标签名不在规整范围）。
 */
function ensureClosingTagNewline(text: string): string {
  return text.replace(/(\n)(?![ \t]*<[A-Za-z_][\w-]*>)([^\n]*\S)(<\/[A-Za-z_][\w-]*>)/g, '$1$2\n$3');
}

/**
 * 把一段完整回传里「开标签后紧跟表格」的地方统一补一个换行，
 * 并让「内容紧贴闭标签」的跨行块把闭标签独占一行。
 *
 * 用于兜底正文（没有聚合标签、直接把任务原文拼进 <plot> 的那条路）；
 * 只补这两处换行，不动标签内部其它换行，也不改标签名。
 */
export function normalizeTagBlockNewlines(text: string): string {
  return ensureClosingTagNewline(String(text ?? '').replace(/(<([A-Za-z_][\w-]*)>)(?=[ \t]*\|)/g, '$1\n'));
}

/**
 * 把「两个尖角标签紧贴、中间没有换行」的地方补一个换行。
 *
 * 标签独占一行才是最不含糊的边界表达：按行扫的前端 / 解析器靠「这一行
 * 只有标签」认层级，贴在一起就得靠猜括号配对。用户 2026-11-09 定的口径
 * 是三种紧贴都补：开-开（左为父）、闭-闭（右为父）让父标签正确包住子标签；
 * 闭-开（相互独立的标签并排）让右边那个换到下一行。
 * 同一对的空标签（`<a></a>`）不是两个独立标签，不动；标签内部文字、
 * 已有换行也不动，不会重复补。
 *
 * 第四类（用户 2026-11-11）：跨行块的内容紧贴闭标签（`| 值 |</tag>`），
 * 让闭标签独占一行；由 ensureClosingTagNewline 统一处理，单行短标签不受影响。
 */
export function normalizeAdjacentTagNewlines(text: string): string {
  const source = String(text ?? '');
  return ensureClosingTagNewline(
    source
      // 开标签紧贴开标签：靠左的是父（<父><子>…</子></父>）
      .replace(/(<[A-Za-z_][\w-]*>)(?=<[A-Za-z_][\w-]*>)/g, '$1\n')
      // 闭标签紧贴闭标签：靠右的是父
      .replace(/(<\/[A-Za-z_][\w-]*>)(?=<\/[A-Za-z_][\w-]*>)/g, '$1\n')
      // 相互独立的标签并排：右边那个换到下一行，让每个标签独占一行
      .replace(/(<\/[A-Za-z_][\w-]*>)(?=<[A-Za-z_][\w-]*>)/g, '$1\n'),
  );
}

/** 内容里有没有「非空白」的实质东西。 */
export function hasContent(contents: unknown): boolean {
  if (Array.isArray(contents)) {
    return contents.some((content) => String(content ?? '').trim() !== '');
  }
  return String(contents ?? '').trim() !== '';
}

/** 按标签名查表：先精确匹配，再退化成大小写不敏感匹配。 */
export function lookupTag(tagSourceMap: TagMap, rawTagName: string): TagLookup {
  const normalizedTagName = String(rawTagName || '').trim();
  if (!(tagSourceMap instanceof Map) || !normalizedTagName) {
    return { found: false, value: undefined, actualTagName: '' };
  }

  if (tagSourceMap.has(normalizedTagName)) {
    return { found: true, value: tagSourceMap.get(normalizedTagName), actualTagName: normalizedTagName };
  }

  const lowered = normalizedTagName.toLowerCase();
  for (const [candidateName, candidateValue] of tagSourceMap.entries()) {
    if (String(candidateName || '').trim().toLowerCase() === lowered) {
      return { found: true, value: candidateValue, actualTagName: String(candidateName || '').trim() };
    }
  }

  return { found: false, value: undefined, actualTagName: '' };
}

/** 先看主表，主表没有或内容为空白，再看兜底表。 */
function resolveTag(primaryTagMap: TagMap, fallbackTagMap: TagMap, rawTagName: string): TagLookup {
  const primary = lookupTag(primaryTagMap, rawTagName);
  if (primary.found && hasContent(primary.value)) return primary;
  return lookupTag(fallbackTagMap, rawTagName);
}

/** 把文本里的 `{{标签}}` 全部换成 `<标签>内容</标签>`；查不到就换成 `<标签></标签>`。 */
export function replacePlaceholders(text: string, tagSourceMap: TagMap, fallbackTagSourceMap: TagMap = new Map()): string {
  const sourceText = String(text || '');
  if (!sourceText) return '';

  return sourceText.replace(newPlaceholderPattern(), (_placeholder, tagName: string) => {
    const resolved = resolveTag(tagSourceMap, fallbackTagSourceMap, tagName);
    return buildTagBlock(tagName, resolved.value);
  });
}

/**
 * 构造任务级世界书触发文本。
 *
 * 只关心这个任务的提示词里真正用到的那几个 `{{标签}}`：用到了才去取内容、才拿去扫世界书。
 * 内容来源优先级：本轮先前阶段的聚合结果 → 上轮剧情历史文本。
 */
export function buildWorldbookTriggerText(
  taskPromptGroup: PromptSegmentLike[],
  plotContent: string,
  relayTagMap?: TagMap,
  fallbackTagMap?: TagMap,
): string {
  const segments = Array.isArray(taskPromptGroup) ? taskPromptGroup : [];
  if (!segments.length) return '';

  const allTagNames: string[] = [];
  const seenTagNames = new Set<string>();
  for (const seg of segments) {
    if (!seg || typeof seg.content !== 'string') continue;
    for (const name of listPlaceholderNames(seg.content)) {
      if (seenTagNames.has(name)) continue;
      seenTagNames.add(name);
      allTagNames.push(name);
    }
  }
  if (!allTagNames.length) return '';

  const historyTagMap = fallbackTagMap instanceof Map ? fallbackTagMap : buildTagMap(String(plotContent || ''), allTagNames);
  const relay = relayTagMap instanceof Map ? relayTagMap : new Map();

  const blocks: string[] = [];
  for (const tagName of allTagNames) {
    const resolved = resolveTag(relay, historyTagMap, tagName);
    if (!resolved.found || !hasContent(resolved.value)) continue;
    const block = buildTagBlock(tagName, resolved.value);
    if (block) blocks.push(block);
  }

  return blocks.join('\n');
}
