/**
 * 暂存面板的编辑零件：把一段 `<plot>` 文本拆成「指令头 + 若干标签块」，再拼回去。
 *
 * 为什么不用 DOM 解析：这段文本来自聊天记录，不是 HTML —— 里面有 `<状态>`、`<剧情>` 这种
 * 中文标签，还有 `<plot>` 外面一大段指令说明。拿 DOMParser 解析会把它当非法 HTML 丢掉一半。
 *
 * 为什么只拆一层：用户要的是「按标签删掉某些块」，而块与块之间是平铺的（都在 `<plot>` 里）。
 * 嵌套同名标签在酒馆里几乎不存在，真出现了就整块当成最外层，删起来也不会误伤外面。
 */

import type { WorkingTaskTags } from './stash-model';

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
  // 带 `<plot>` 外壳时，正则会把外壳本身当成一个「plot 块」，里面的标签一个都拿不到。
  // 先把壳拆掉，再扫里面的内容块 —— 面板列出的必须是用户真正能编辑的标签。
  const parts = splitPlotMessage(source);
  if (parts.hasPlot) return parts.blocks.slice();
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

/**
 * 把「成品正文里的标签块」同步进「标签数据」—— 一段正文改动落回标签数据用。
 *
 * 为什么要它（2026-11-12 用户拍板）：以前正文框改了标签块、标签数据却不动，
 * 下一楼层继承时又从标签数据抄，于是用户删掉的东西会复活。用户认定这是错的：
 * **暂存区里只应该有「被编辑后就被持久改变的标签数据」**，成品正文是它的投影。
 *
 * 差量规则（按**标签名**比对，不按任务 id）：
 * - 正文里有、标签数据里没有 → 加进该标签原属的任务；认不出归属就放进 `reassignTo`
 * - 两边都有但内容不同 → 更新成正文里的
 * - 标签数据里有、正文里没有 → **删掉**（这就是「用户删了就不该复活」）
 *
 * 只读正文、不改正文；调用方负责决定写不写盘。
 *
 * @param records 现有标签数据（任务 id → 该任务的标签 + 只进字段名单）
 * @param text 成品正文（或楼层正文里的那一段）
 * @param options.reassignTo 认不出归属的新标签记到哪个任务下；不传则用第一个任务 id
 * @param options.inheritedRecords 继承标签（只用来认归属，不会被改动）
 * @returns 新的标签数据 + 实际发生的增删改（给调用方记日志/判断要不要动作）
 */
export interface TagSyncDiff {
  /** 新增的标签名 */
  added: string[];
  /** 内容被更新的标签名 */
  updated: string[];
  /** 被删掉的标签名 */
  removed: string[];
}

export function syncTextIntoTagRecords(
  records: Record<string, WorkingTaskTags>,
  text: string,
  options: {
    reassignTo?: string;
    inheritedRecords?: Record<string, WorkingTaskTags>;
    /** 模板里真正会进正文的标签名；只有这批标签允许被正文删除。省略 = 不做删除（老账保守处理）。 */
    textTagNames?: string[];
    /** 老账没有 textTagNames 时只允许更新已有标签，不凭正文新建标签（正文里可能有 <user_input> 这类指令字面量）。 */
    onlyKnownTags?: boolean;
  } = {},
): { records: Record<string, WorkingTaskTags>; diff: TagSyncDiff } {
  const next: Record<string, WorkingTaskTags> = {};
  for (const [taskId, record] of Object.entries(records ?? {})) {
    next[taskId] = { tags: { ...(record?.tags ?? {}) }, injectOnly: [...(record?.injectOnly ?? [])] };
  }

  // 正文里现在有哪些标签：「标签名 → 内容」，同名只认最后一块（与配对面板的展示一致）
  const fromText = new Map<string, string>();
  const blocks = (() => {
    const parts = splitPlotMessage(text);
    return parts.hasPlot ? parts.blocks : scanTagBlocks(text);
  })();
  for (const block of blocks) {
    const name = String(block.tag ?? '').trim();
    if (!name) continue;
    fromText.set(name, String(block.body ?? ''));
  }

  // 「标签名 → 原本属于哪个任务」：先看标签数据，再看继承快照（继承标签编辑过的也算本层产出）
  const ownerOf = new Map<string, string>();
  for (const source of [records ?? {}, options.inheritedRecords ?? {}]) {
    for (const [taskId, record] of Object.entries(source)) {
      for (const name of Object.keys(record?.tags ?? {})) {
        const lower = name.toLowerCase();
        if (!ownerOf.has(lower)) ownerOf.set(lower, taskId);
      }
    }
  }
  const fallbackTaskId =
    options.reassignTo && options.reassignTo.trim() !== ''
      ? options.reassignTo
      : Object.keys(next)[0] ?? '';

  const diff: TagSyncDiff = { added: [], updated: [], removed: [] };

  // 只有已知标签才参与正文差量：正文里可能有 <user_input> 这类指令字面量，
  // 不能把模板语法当成业务标签；用户临时手打的新标签也不在这里凭空建档。
  const knownNames = new Set<string>();
  const ownedNames = new Set<string>();
  for (const source of [records ?? {}, options.inheritedRecords ?? {}]) {
    for (const record of Object.values(source)) {
      for (const name of Object.keys(record?.tags ?? {})) {
        knownNames.add(name.toLowerCase());
        ownedNames.add(name.toLowerCase());
      }
    }
  }
  for (const name of options.textTagNames ?? []) {
    const lower = String(name ?? '').trim().toLowerCase();
    if (lower) knownNames.add(lower);
  }
  const textTagNames = (options.textTagNames ?? [])
    .map((name) => String(name ?? '').trim().toLowerCase())
    .filter(Boolean);
  const textTagSet = textTagNames.length > 0 ? new Set(textTagNames) : null;

  // 1) 正文里的每个标签：缺的补、变了的更新
  for (const [name, content] of fromText) {
    if (!knownNames.has(name.toLowerCase())) continue;
    // 老账没有 textTagNames：正文里的标签只用于更新已有记录，不新建。
    // 否则真实预设里的 <user_input> 字面量会被当成业务标签建进 taskTags。
    if (options.onlyKnownTags && !ownedNames.has(name.toLowerCase())) continue;
    let placed = false;
    for (const record of Object.values(next)) {
      const actualName = Object.keys(record.tags).find((key) => key.toLowerCase() === name.toLowerCase());
      if (actualName === undefined) continue;
      placed = true;
      if (record.tags[actualName] !== content) {
        record.tags[actualName] = content;
        diff.updated.push(actualName);
      }
    }
    if (placed) continue;
    const taskId = ownerOf.get(name.toLowerCase()) ?? fallbackTaskId;
    if (taskId === '') continue; // 没有任何任务容器，加了也无处安放
    if (!next[taskId]) next[taskId] = { tags: {}, injectOnly: [] };
    next[taskId].tags[name] = content;
    diff.added.push(name);
  }

  // 2) 标签数据里有、正文里没有的：只删「模板会注入正文」的那批标签。
  //
  // 只进字段 / 只写世界书的标签本来就不在正文里，拿正文当唯一真相会把它们误删。
  // 删掉 = 写空串 tombstone，而不是删键：这样下一层继承时知道「本层明确不要了」，
  // 不会把 carriedTags 的旧值又捡回来；世界书同步也能据此清掉对应条目。
  // 老账没有 textTagNames 时不删除（正文与数据可能本来就对不上，保守不动）。
  if (textTagSet) {
    const fromTextLower = new Set([...fromText.keys()].map((name) => name.toLowerCase()));
    for (const record of Object.values(next)) {
      for (const name of Object.keys(record.tags)) {
        if (!textTagSet.has(name.toLowerCase())) continue;
        if (fromTextLower.has(name.toLowerCase())) continue;
        if (record.tags[name] === '') continue;
        record.tags[name] = '';
        diff.removed.push(name);
      }
    }
  }

  return { records: next, diff };
}
