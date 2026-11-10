/**
 * 暂存面板的编辑零件：把一段 `<plot>` 文本拆成「指令头 + 若干标签块」，再拼回去。
 *
 * 为什么不用 DOM 解析：这段文本来自聊天记录，不是 HTML —— 里面有 `<状态>`、`<剧情>` 这种
 * 中文标签，还有 `<plot>` 外面一大段指令说明。拿 DOMParser 解析会把它当非法 HTML 丢掉一半。
 *
 * 为什么只拆一层：用户要的是「按标签删掉某些块」，而块与块之间是平铺的（都在 `<plot>` 里）。
 * 嵌套同名标签在酒馆里几乎不存在，真出现了就整块当成最外层，删起来也不会误伤外面。
 */

export interface TagBlock {
  /** 标签名（不带尖括号） */
  tag: string;
  /** 原始文本，含标签本身 —— 保存时原样拼回去，不改用户的空格和换行 */
  raw: string;
  /** 标签里面的正文（面板上展示的预览用它） */
  body: string;
}

export interface PlotMessageParts {
  /** `<plot>` 之前的一切（含指令头） */
  header: string;
  /** `<plot>` 开标签原文（可能带属性）；没有 `<plot>` 时是空串 */
  open: string;
  /** `<plot>` 里的各个标签块 */
  blocks: TagBlock[];
  /** `</plot>` 之后的一切 */
  footer: string;
  /** 这段文本到底有没有 `<plot>` 包裹 */
  hasPlot: boolean;
}

const OPEN_PLOT_RE = /<plot(\s[^>]*)?>/i;
const CLOSE_PLOT = '</plot>';
// 标签名不能只认 ASCII：预设里的标签就是 `<剧情>`、`<状态>` 这种中文名，
// 用 `[A-Za-z_]` 开头会把它们整块漏掉，面板上点了删除却提示「没找到」。
const BLOCK_RE = /<([^\s<>/]+)(?:\s[^<>]*)?>[\s\S]*?<\/\1>/g;

/** 拆。找不到 `<plot>` 就整段当 header，块为空。 */
export function splitPlotMessage(text: string): PlotMessageParts {
  const source = typeof text === 'string' ? text : '';
  const openMatch = OPEN_PLOT_RE.exec(source);
  const closeIndex = source.lastIndexOf(CLOSE_PLOT);

  if (!openMatch || closeIndex < 0 || closeIndex <= openMatch.index + openMatch[0].length) {
    return { header: source, open: '', blocks: [], footer: '', hasPlot: false };
  }

  const open = openMatch[0];
  const innerStart = openMatch.index + open.length;
  const inner = source.slice(innerStart, closeIndex);

  const blocks: TagBlock[] = [];
  BLOCK_RE.lastIndex = 0;
  let match: RegExpExecArray | null = BLOCK_RE.exec(inner);
  while (match) {
    blocks.push({ tag: match[1], raw: match[0], body: extractBody(match[0]) });
    match = BLOCK_RE.exec(inner);
  }

  return {
    header: source.slice(0, openMatch.index),
    open,
    blocks,
    footer: source.slice(closeIndex + CLOSE_PLOT.length),
    hasPlot: true,
  };
}

/** 拼回去。块与块之间统一空一行 —— 与 `eng/assemble.ts` 的产出格式保持一致。 */
export function joinPlotMessage(parts: PlotMessageParts): string {
  if (!parts.hasPlot) return parts.header;
  const head = parts.header.replace(/\s+$/, '');
  const blocks = parts.blocks.map((item) => item.raw.trim()).filter(Boolean).join('\n\n');
  const tail = parts.footer;
  const open = parts.open || '<plot>';
  const body = blocks ? `\n${blocks}\n` : '\n';
  return `${head ? `${head}\n` : ''}${open}${body}${CLOSE_PLOT}${tail}`;
}

/**
 * 全文扫一遍闭合标签块 —— 不管有没有 `<plot>` 外壳。
 *
 * 面板上的标签列表用它，而不是 `splitPlotMessage`：那一份是给「拆开改写再拼回去」
 * 用的，必须知道块外面还包着什么；但只要看到哪些标签块，不需要那层外壳。
 * 用户的成果里标签本来就是散在正文里的，用结构解析当然一个都扫不到。
 */
export function scanTagBlocks(text: string): TagBlock[] {
  const source = typeof text === 'string' ? text : '';
  const blocks: TagBlock[] = [];
  BLOCK_RE.lastIndex = 0;
  let match: RegExpExecArray | null = BLOCK_RE.exec(source);
  while (match) {
    blocks.push({ tag: match[1], raw: match[0], body: extractBody(match[0]) });
    match = BLOCK_RE.exec(source);
  }
  return blocks;
}

/** 按标签名删掉所有同名块；返回删了几个（面板拿它决定要不要提示「没找到」）。 */
export function removeTagBlocks(text: string, tag: string): { text: string; removed: number } {
  const parts = splitPlotMessage(text);
  if (parts.hasPlot) {
    const kept = parts.blocks.filter((item) => item.tag !== tag);
    const removed = parts.blocks.length - kept.length;
    if (removed === 0) return { text, removed: 0 };
    return { text: joinPlotMessage({ ...parts, blocks: kept }), removed };
  }

  // 没有 `<plot>` 外壳：块散在正文里，没法拆开再拼回去（拼回去会丢掉块外的文字），
  // 直接在原文上按同名闭合标签整段挖掉。
  const name = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`<${name}(?:\\s[^<>]*)?>[\\s\\S]*?<\\/${name}>`, 'g');
  const removed = text.match(pattern)?.length ?? 0;
  if (removed === 0) return { text, removed: 0 };
  return { text: text.replace(pattern, '').replace(/\n{3,}/g, '\n\n'), removed };
}

/** 面板列表用：每个块一行标题 + 一段预览。 */
export function blockPreview(block: TagBlock, max = 80): string {
  const flat = String(block.body ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function extractBody(raw: string): string {
  const openEnd = raw.indexOf('>');
  const closeStart = raw.lastIndexOf('</');
  if (openEnd < 0 || closeStart <= openEnd) return '';
  return raw.slice(openEnd + 1, closeStart);
}

/**
 * 全文标签块 → 引擎聚合表的形状（`Map<标签名, 内容 | 内容[]>`）。
 *
 * 世界书写入（`worldbook-write.ts`）要从「面板编辑后的文本」取规则选中的标签内容，
 * 而 `collectLandingContents` 吃的是引擎的 `aggregatedTags`（Map）—— 中间就靠这一步
 * 把形状对齐，两边走同一个 `lookupTag` 口径。同名多块并成数组，与引擎聚合一致；
 * 空内容的块不收（那边对空内容本来就是跳过，收进来只会白占账本）。
 *
 * 两种形态都认：日常的成果是「标签块散在指令正文里」（`buildFinalMessage` 的产出，
 * 没有外壳）；但用户自定义模板可能自己包一层 `<plot>` —— 那种要先拆壳再扫，
 * 否则外壳会被外层正则当成一个「plot 块」，里面的标签一个都拿不到。
 */
export function collectTextTagMap(text: string): Map<string, string[] | string> {
  const parts = splitPlotMessage(text);
  const blocks = parts.hasPlot ? parts.blocks : scanTagBlocks(text);
  const map = new Map<string, string[] | string>();
  for (const block of blocks) {
    const body = String(block.body ?? '');
    if (body.trim() === '') continue;
    const existing = map.get(block.tag);
    if (existing === undefined) map.set(block.tag, body);
    else if (Array.isArray(existing)) existing.push(body);
    else map.set(block.tag, [existing, body]);
  }
  return map;
}

/** 只做一件事的导出，给测试用：一段文本里有哪些标签名（按出现顺序去重）。 */
export function tagNames(text: string): string[] {
  const parts = splitPlotMessage(text);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const block of parts.blocks) {
    if (seen.has(block.tag)) continue;
    seen.add(block.tag);
    out.push(block.tag);
  }
  return out;
}
