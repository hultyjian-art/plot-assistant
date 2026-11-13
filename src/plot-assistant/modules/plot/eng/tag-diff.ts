/**
 * 标签差量（任务级差量回传）
 *
 * 用户口径（2026-11-06）：
 * - 差量开关放在**标签**上，不放在任务上：一个任务可以同时产出快照标签和积累标签。
 * - 四种模式：
 *   - `off`    ：每轮全量输出（默认；适合 basic_info / plot_judge 这类快照）；
 *   - `keep`   ：整标签保留——本轮没输出这个标签就沿用上一轮，输出了就整块替换；
 *   - `blocks` ：按 `###` 小节合并——只写变动的小节，没写的小节沿用上一轮。
 *   - `table`  ：按 Markdown 表格行合并——按第一列作行键，只写变动的行，没写的行沿用上一轮。
 * - `【无变化】` 等价于「没输出」：保留上一轮内容。
 * - `【删除】名字` 删除一个 `###` 小节（角色离场、条目作废）。
 *
 * 这里只做纯字符串处理，不读酒馆、不碰存储。真正的「上一轮标签投影」由调用方
 * 从上一轮 `<plot>` 里用 `buildTagMap` 建好传进来。
 */

import { isPlainObject } from '../guards';
import { buildTagBlock, extractTaskTags, type TagMap } from './tags';

/** 单个标签的差量模式。 */
export type TagDiffMode = 'off' | 'keep' | 'blocks' | 'table';

/** 脏值一律按「关闭」处理——宁可不省 token，也不要静默改写旧档案。 */
export function normalizeTagDiffMode(value: unknown): TagDiffMode {
  return value === 'keep' || value === 'blocks' || value === 'table' ? value : 'off';
}

/**
 * 预设里的 `tagDiffModes` → 干净的 `标签名 → 模式` 表。
 * `off` 是默认值，不落盘（不写进预设 JSON，避免文件里一堆没用的 off）。
 */
export function normalizeTagDiffModes(value: unknown): Record<string, TagDiffMode> {
  const out: Record<string, TagDiffMode> = {};
  if (!isPlainObject(value)) return out;
  for (const [rawName, rawMode] of Object.entries(value as Record<string, unknown>)) {
    const name = String(rawName ?? '').trim();
    if (name === '') continue;
    const mode = normalizeTagDiffMode(rawMode);
    if (mode !== 'off') out[name] = mode;
  }
  return out;
}

/** `a,b, c` → `['a','b','c']`。只按逗号切，与引擎的标签串口径一致。 */
export function splitTagList(raw: unknown): string[] {
  return String(raw ?? '')
    .split(',')
    .map(item => item.trim())
    .filter(item => item !== '');
}

/** 收集一份预设里所有出现过的标签名：任务抽取标签 + 最终注入里的 `{{标签}}`。 */
export function collectKnownTagNames(
  tasks: ReadonlyArray<{ extractTags?: string; extractInjectTags?: string; exemptTags?: string }>,
  directiveTemplate: string,
): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const push = (name: string): void => {
    const value = String(name ?? '').trim();
    if (value === '' || seen.has(value)) return;
    seen.add(value);
    names.push(value);
  };

  for (const task of tasks) {
    for (const raw of [task.extractTags, task.extractInjectTags, task.exemptTags]) {
      for (const name of splitTagList(raw)) push(name);
    }
  }

  const pattern = /\{\{(\w+)\}\}/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(String(directiveTemplate ?? ''))) !== null) {
    push(match[1]);
  }
  return names;
}

/** 内容是不是「没变化」的声明。空串也算。 */
export function isNoChangeText(text: string): boolean {
  const trimmed = String(text ?? '').trim();
  return trimmed === '' || /^(?:【\s*无变化\s*】|无变化)$/.test(trimmed);
}

/** 取标签在上一轮投影里的内容；多段按空行拼起来。 */
function previousContentOf(previousTags: TagMap | null | undefined, tagName: string): string {
  if (!(previousTags instanceof Map)) return '';
  const lowered = tagName.toLowerCase();
  for (const [name, value] of previousTags.entries()) {
    if (String(name ?? '').trim().toLowerCase() !== lowered) continue;
    if (Array.isArray(value)) return value.map(item => String(item ?? '')).join('\n\n').trim();
    return String(value ?? '').trim();
  }
  return '';
}

interface ParsedBlock {
  /** 小节标题（`###` 后面的文字；旧格式的 `[名字]` 会去掉方括号） */
  title: string;
  /** 标题行以下、指令行以外的正文 */
  body: string;
  /**
   * 兼容旧格式：`【状态】前台/后台`。
   * 新格式使用 `【移入 标签名】` / `【移出】`，不再依赖「哪个标签算前台」。
   */
  status: 'front' | 'back' | '';
  /** 这一块现在归属哪个嵌套标签；空串 = 外层（后台） */
  zone: string;
  /** 补丁里是否用 `【移入】/【移出】` 明确改过归属 */
  explicitZone: boolean;
  /** 稳定顺序：合并后保持原顺序 */
  order: number;
}

interface ParsedBlockDoc {
  blocks: ParsedBlock[];
  deletes: string[];
  /** 内容里第一个嵌套标签（如 character_archive / women_miracle） */
  frontTag: string;
}

/** `### [沈青梧]` 与 `### 沈青梧` 当成同一个键。 */
function normalizeTitle(raw: string): string {
  const value = String(raw ?? '').trim();
  const wrapped = /^\[(.*)\]$/.exec(value);
  return wrapped ? wrapped[1].trim() : value;
}

/**
 * 把一段块文档拆成「角色块 + 删除指令 + 嵌套前台标签」。
 *
 * 只认整行的 `<tag>` / `</tag>` 作为分区标记；块正文里偶尔出现的行内尖括号
 * 不会被误当成标签（前端要的是 Markdown，不是 XML）。
 */
function parseBlockDoc(text: string): ParsedBlockDoc {
  const source = String(text ?? '').replace(/\r\n?/g, '\n');
  const lines = source.split('\n');
  const blocks: ParsedBlock[] = [];
  const deletes: string[] = [];
  let frontTag = '';
  let currentZone = '';
  let current: ParsedBlock | null = null;
  let bodyLines: string[] = [];

  const flush = (): void => {
    if (!current) return;
    current.body = bodyLines.join('\n').trim();
    blocks.push(current);
    current = null;
    bodyLines = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');
    const trimmed = line.trim();
    if (trimmed === '') {
      if (current) bodyLines.push('');
      continue;
    }

    const open = /^<([A-Za-z][\w-]*)>\s*$/.exec(trimmed);
    if (open) {
      flush();
      currentZone = open[1];
      if (frontTag === '') frontTag = open[1];
      continue;
    }

    const close = /^<\/\s*([A-Za-z][\w-]*)\s*>\s*$/.exec(trimmed);
    if (close) {
      flush();
      if (currentZone === close[1]) currentZone = '';
      continue;
    }

    const deletion = /^【\s*删除\s*】\s*(.+)$/.exec(trimmed);
    if (deletion) {
      flush();
      deletes.push(deletion[1].trim());
      continue;
    }

    const heading = /^###\s*(.*)$/.exec(line);
    if (heading) {
      flush();
      current = {
        title: normalizeTitle(heading[1]),
        body: '',
        status: '',
        zone: currentZone,
        explicitZone: false,
        order: blocks.length,
      };
      bodyLines = [];
      continue;
    }

    if (current) {
      // 新格式：显式把这一块移入某个标签（由 AI 自己写目标标签名，引擎不猜前台/后台）
      const moveIn = /^【\s*移入\s*([^】]+?)\s*】\s*$/.exec(trimmed);
      if (moveIn) {
        current.zone = moveIn[1].trim();
        current.explicitZone = true;
        continue;
      }
      const moveOut = /^【\s*移出\s*】\s*$/.exec(trimmed);
      if (moveOut) {
        current.zone = '';
        current.explicitZone = true;
        continue;
      }
      // 兼容旧格式：没有「移入/移出」时，`【状态】` 仍然认；最终由旧文档里检测到的
      // 前台标签名兜底，不写死任何具体标签。
      const status = /^【\s*状态\s*】\s*(.*)$/.exec(trimmed);
      if (status) {
        const value = status[1];
        current.status = /前台|前臺/.test(value) ? 'front' : /后台|後台/.test(value) ? 'back' : '';
        continue;
      }
      bodyLines.push(line);
    }
  }

  flush();
  return { blocks, deletes, frontTag };
}

interface BodySection {
  name: string;
  content: string;
}

interface BodySections {
  preamble: string;
  sections: BodySection[];
}

/** 把块正文拆成 `【信息边界】【短期记忆】…` 这样的小节。 */
function splitBodySections(body: string): BodySections {
  const lines = String(body ?? '').replace(/\r\n?/g, '\n').split('\n');
  const preamble: string[] = [];
  const sections: BodySection[] = [];
  let current: BodySection | null = null;

  for (const line of lines) {
    const heading = /^【([^】]+)】\s*$/.exec(line.trim());
    if (heading) {
      if (current) sections.push(current);
      current = { name: heading[1].trim(), content: '' };
      continue;
    }
    if (current) current.content += (current.content === '' ? '' : '\n') + line;
    else preamble.push(line);
  }
  if (current) sections.push(current);

  return {
    preamble: preamble.join('\n').trim(),
    sections: sections.map(section => ({ name: section.name, content: section.content.trim() })),
  };
}

function renderBodySections(doc: BodySections): string {
  const parts: string[] = [];
  if (doc.preamble !== '') parts.push(doc.preamble);
  for (const section of doc.sections) {
    parts.push(`【${section.name}】${section.content === '' ? '' : `\n${section.content}`}`);
  }
  return parts.join('\n').trim();
}

/**
 * 合并一个角色块的正文：只替换补丁里出现的小节，其余小节原样保留。
 * 补丁正文里一个 `【小节】` 都没有时，视为对整块正文做完整替换。
 */
function mergeBlockBody(previousBody: string, patchBody: string): string {
  const previous = String(previousBody ?? '');
  const patch = String(patchBody ?? '');
  if (patch.trim() === '') return previous;

  const previousDoc = splitBodySections(previous);
  const patchDoc = splitBodySections(patch);
  if (patchDoc.sections.length === 0) return patch.trim();

  const merged = previousDoc.sections.map(section => ({ ...section }));
  for (const section of patchDoc.sections) {
    const index = merged.findIndex(item => item.name === section.name);
    if (index >= 0) merged[index] = { ...section };
    else merged.push({ ...section });
  }
  return renderBodySections({ preamble: previousDoc.preamble, sections: merged });
}

function findBlockKey(blocks: Map<string, ParsedBlock>, title: string): string | null {
  const wanted = normalizeTitle(title).toLowerCase();
  for (const key of blocks.keys()) {
    if (key.toLowerCase() === wanted) return key;
  }
  return null;
}

/**
 * 把合并后的块按「归属标签」重新排版：
 * - 没写 `【移入】` 的块留在外层（后台）；
 * - 写在 `【移入 character_archive】` 里的块放进对应的 `<character_archive>`；
 * - 旧格式的 `【状态】前台` 只在能从上一轮检测到前台标签时兜底映射过去。
 */
function renderBlockDoc(blocks: readonly ParsedBlock[], frontTag: string): string {
  if (blocks.length === 0) return '';

  const groups = new Map<string, string[]>();
  const order: string[] = [];
  const push = (zone: string, text: string): void => {
    if (!groups.has(zone)) {
      groups.set(zone, []);
      order.push(zone);
    }
    groups.get(zone)!.push(text);
  };

  for (const block of blocks) {
    let zone = block.zone;
    // 显式【移入/移出】优先于旧格式的【状态】；旧状态只在没有显式归属时兜底。
    if (!block.explicitZone) {
      if (block.status === 'back') zone = '';
      else if (zone === '' && block.status === 'front' && frontTag !== '') zone = frontTag;
    }
    const body = block.body.trim();
    const text = `### ${block.title}${body === '' ? '' : `\n${body}`}`;
    push(zone, text);
  }

  const parts: string[] = [];
  for (const zone of order) {
    const textBlocks = groups.get(zone) ?? [];
    if (textBlocks.length === 0) continue;
    if (zone === '') parts.push(...textBlocks);
    else parts.push(`<${zone}>\n${textBlocks.join('\n\n')}\n</${zone}>`);
  }
  return parts.join('\n\n');
}

/**
 * 合并块文档。
 *
 * 关键行为：
 * - 上一轮为空 = 第一次建账，补丁就是全文；
 * - 补丁里没提到的小节/角色 = 保留上一轮；
 * - `【删除】名字` = 删掉这个角色块；
 * - `【状态】前台/后台` = 角色在前台/后台之间移动。
 */
export function mergeBlockDocument(previousText: string, patchText: string): string {
  const previous = String(previousText ?? '').trim();
  const patch = String(patchText ?? '').trim();
  if (previous === '') return patch;
  if (isNoChangeText(patch)) return previous;

  const previousDoc = parseBlockDoc(previous);
  const patchDoc = parseBlockDoc(patch);
  if (patchDoc.blocks.length === 0 && patchDoc.deletes.length === 0) {
    // 双方都不是块文档时，`blocks` 模式退化成整标签替换：至少不把用户/旧版
    // 表格类的更新吞掉。上一轮是块文档、补丁却没有块，才按「无变化」保留旧档。
    return previousDoc.blocks.length === 0 ? patch : previous;
  }

  const merged = new Map<string, ParsedBlock>();
  for (const block of previousDoc.blocks) merged.set(block.title, { ...block });

  for (const name of patchDoc.deletes) {
    const key = findBlockKey(merged, name);
    if (key !== null) merged.delete(key);
  }

  for (const block of patchDoc.blocks) {
    const key = findBlockKey(merged, block.title);
    if (key !== null) {
      const existing = merged.get(key)!;
      merged.set(key, {
        ...existing,
        body: mergeBlockBody(existing.body, block.body),
        status: block.status !== '' ? block.status : existing.status,
        zone: block.explicitZone ? block.zone : existing.zone,
        explicitZone: block.explicitZone || existing.explicitZone,
      });
    } else {
      merged.set(block.title, { ...block, order: merged.size });
    }
  }

  const blocks = Array.from(merged.values()).sort((left, right) => left.order - right.order);
  const frontTag = previousDoc.frontTag !== '' ? previousDoc.frontTag : patchDoc.frontTag;
  return renderBlockDoc(blocks, frontTag);
}

interface TablePart {
  kind: 'text' | 'table';
  /** 文本区（kind=text） */
  lines?: string[];
  /** 表格区（kind=table） */
  header?: string;
  separator?: string;
  rows?: string[];
}

interface TableDocument {
  parts: TablePart[];
}

const TABLE_LINE_RE = /^\s*\|.*\|\s*$/;
const TABLE_SEPARATOR_RE = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/;

/** 把一段含 Markdown 表格的文本拆成「文字区 / 表格区」。 */
function parseTableDocument(text: string): TableDocument {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const parts: TablePart[] = [];
  let buffer: string[] = [];

  const flushText = (): void => {
    if (buffer.length === 0) return;
    parts.push({ kind: 'text', lines: buffer });
    buffer = [];
  };

  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const next = index + 1 < lines.length ? lines[index + 1] : '';
    if (TABLE_LINE_RE.test(line) && TABLE_SEPARATOR_RE.test(next)) {
      flushText();
      const rows: string[] = [];
      index += 2;
      while (index < lines.length && TABLE_LINE_RE.test(lines[index])) {
        rows.push(lines[index]);
        index += 1;
      }
      parts.push({ kind: 'table', header: line, separator: next, rows });
      continue;
    }
    buffer.push(line);
    index += 1;
  }
  flushText();
  return { parts };
}

function renderTableDocument(doc: TableDocument): string {
  const chunks: string[] = [];
  for (const part of doc.parts) {
    if (part.kind === 'text') {
      const text = (part.lines ?? []).join('\n');
      if (text.trim() !== '') chunks.push(text);
      continue;
    }
    chunks.push([part.header ?? '', part.separator ?? '', ...(part.rows ?? [])].join('\n'));
  }
  return chunks.join('\n\n').trim();
}

/** 表格行键：第一列。 */
function tableRowKey(row: string): string {
  const cells = String(row ?? '')
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|');
  return (cells[0] ?? '').trim();
}

function collectTableDeletes(text: string): string[] {
  const out: string[] = [];
  for (const line of String(text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const match = /^【\s*删除\s*】\s*(.+)$/.exec(line.trim());
    if (match) out.push(match[1].trim());
  }
  return out;
}

/**
 * 表格行级合并：
 * - 表头/分隔行保持原样；
 * - 有变化的数据行按第一列（角色名）替换或新增；
 * - `【删除】角色名` 删除所有表里第一列匹配的行；
 * - 没提到的行保留上一轮。
 */
export function mergeTableDocument(previousText: string, patchText: string): string {
  const previous = String(previousText ?? '').trim();
  const patch = String(patchText ?? '').trim();
  if (previous === '') return patch;
  if (isNoChangeText(patch)) return previous;

  const previousDoc = parseTableDocument(previous);
  const patchDoc = parseTableDocument(patch);
  const deletes = collectTableDeletes(patch);
  const previousTables = previousDoc.parts.filter(part => part.kind === 'table');
  const patchTables = patchDoc.parts.filter(part => part.kind === 'table');

  if (previousTables.length === 0) return patch;
  if (patchTables.length === 0 && deletes.length === 0) return previous;

  const nextParts: TablePart[] = previousDoc.parts.map(part => {
    if (part.kind !== 'table') return { ...part, lines: [...(part.lines ?? [])] };
    const rows = (part.rows ?? []).filter(row => !deletes.includes(tableRowKey(row)));
    return { ...part, rows };
  });

  for (const patchTable of patchTables) {
    const header = String(patchTable.header ?? '').trim();
    const targetIndex = nextParts.findIndex(
      part => part.kind === 'table' && String(part.header ?? '').trim() === header,
    );
    if (targetIndex < 0) {
      nextParts.push({
        kind: 'table',
        header: patchTable.header,
        separator: patchTable.separator,
        rows: [...(patchTable.rows ?? [])],
      });
      continue;
    }
    const target = nextParts[targetIndex];
    const rows = [...(target.rows ?? [])];
    const byKey = new Map<string, number>();
    rows.forEach((row, rowIndex) => byKey.set(tableRowKey(row), rowIndex));
    for (const patchRow of patchTable.rows ?? []) {
      const key = tableRowKey(patchRow);
      const at = byKey.get(key);
      if (at === undefined) {
        byKey.set(key, rows.length);
        rows.push(patchRow);
      } else {
        rows[at] = patchRow;
      }
    }
    nextParts[targetIndex] = { ...target, rows };
  }

  return renderTableDocument({ parts: nextParts });
}

/** 这内容像不像块文档（至少一个 `###` 标题）。 */
export function hasBlockStructure(text: string): boolean {
  return /^###\s+\S/m.test(String(text ?? ''));
}

/** 这内容像不像 Markdown 表格（至少一张有分隔行的表）。 */
export function hasTableStructure(text: string): boolean {
  return parseTableDocument(text).parts.some(part => part.kind === 'table');
}

/**
 * 上一轮该标签的格式跟当前模式对不上吗？
 *
 * 用户口径（2026-11-06）：比如 `character_info` 上一轮还是表格、这一轮已经改成块模式，
 * 即使这个标签设了「按块合并」，也要先触发一次全量更新，而不是拿表格当底稿做差量。
 */
export function tagNeedsFullRefresh(mode: TagDiffMode, previousText: string): boolean {
  const previous = String(previousText ?? '').trim();
  if (previous === '') return false;
  if (mode === 'blocks') return !hasBlockStructure(previous);
  if (mode === 'table') return !hasTableStructure(previous);
  return false;
}

/**
 * 一个任务里有哪些差量标签需要「本轮先全量」。
 * `round.ts` 用它给 AI 追加一段系统提醒；`applyTagDiffs` 用它决定不合并、直接替换。
 */
export function tagsNeedingFullRefresh(
  task: TagDiffTaskLike,
  modes: Record<string, TagDiffMode>,
  previousTags: TagMap,
): string[] {
  const names = splitTagList(`${task.extractTags || ''},${task.extractInjectTags || ''},${task.exemptTags || ''}`);
  const out: string[] = [];
  for (const name of names) {
    const mode = normalizeTagDiffMode(modes[name]);
    if (!tagNeedsFullRefresh(mode, previousContentOf(previousTags, name))) continue;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

export interface TagDiffTaskLike {
  id?: string;
  extractTags?: string;
  extractInjectTags?: string;
  /** 豁免标签：不要求必达，但回传了仍要参与抽取与差量合并 */
  exemptTags?: string;
}

/** 内置差量规则提示词的头部。两个占位符由 buildTagDiffInstruction 按任务替换。 */
const TAG_DIFF_INSTRUCTION_HEAD =
  '【标签差量更新规则】\n这条规则由脚本自动附加，不是剧情内容。下列标签本轮采用差量更新：你只需要回传有变化的部分，脚本会自动把它和上一轮的内容合并；你没有提到的内容，脚本会保留上一轮的原内容。\n不在名单里的标签仍按任务要求输出完整内容，不要对它们使用差量写法。\n所有要回传的标签都必须用完整的一对 <标签名>…</标签名> 包住，标签名不要加属性或空格；同一个标签本轮只写一对，不要拆成多段同名标签。标签的开始标记和结束标记必须各自单独占一行：<标签名> 和 </标签名> 不能和正文、其他标签或 ### 标题挤在同一行。';

const TAG_DIFF_BLOCK_SECTION =
  '- 按块合并（{{按块合并标签}}）：\n  1. 块标题必须单独占一行，格式正好是「### 块名」：三个 # 后跟一个空格，并且 ### 必须从行首开始，前面不要空格或缩进。不要用 ####，不要把正文写在标题同一行。已有块必须沿用上一轮的块名，不能改名；改名会被当成新增块，旧块不会消失。同一个块名本轮只写一次，多个小节写在同一块里；块名不能为空。块的正文里不要出现以 ### 开头的行——脚本会把任何 ### 开头的行当成新块标题，正文会被截断或拆成新块。\n  2. 每个块里只写有变化的小节。小节标题必须单独占一行，格式正好是「【小节名】」：方括号里只有小节名，前后不要加字；小节正文从下一行开始。不要把「【小节名】正文」写在同一行——脚本不认这种写法，会把整段当成块正文整块替换，导致这一块其他小节丢失。小节名也要和上一轮完全一致，不能改名；改名会被当成新增小节，旧小节还留着，同一内容会重复。小节标题不要使用【删除】【移入】【移出】【状态】这些脚本保留的指令名当小节名，否则会被当成指令处理。\n  3. 写了哪个小节，就必须写出这个小节更新后的完整内容，不能只写变化的几句话；只写小节标题、下面不写正文，脚本会把这个小节的内容清空；这个小节没有变化就不要写它，没有写的小节脚本会保留上一轮。\n  4. 如果你不写任何【小节】行，只写一段块正文，脚本会把这段正文当作这一块的完整新正文，整块替换上一轮的旧正文；所以这种情况必须写出这一块的完整内容。只写「### 块名」、下面不写正文：已有块会保留上一轮正文不变，新块会创建一个空块，所以新块必须写正文。块正文第一个【小节】之前不要写任何说明文字，脚本会丢掉补丁里的这段开头；要保留的内容请写进某个小节。块标题之外的文字（第一个块标题之前、块与块之间的说明）不会被保存，只写块内容。按块合并的标签，整段必须是块文档；上一轮已有内容时，如果一个 ### 块都没有（也没有【删除】行），脚本会认为没有更新，整份补丁不生效、上一轮原样保留，不要用表格或纯文本代替块。\n  5. 要删除整块，单独写一行「【删除】块名」，这一行不能有别的内容，块名要和上一轮完全一致。要改变归属，在块正文里单独写一行「【移入 目标标签名】」或「【移出】」；写在块标题上面、块外面或和正文挤在同一行都不会生效。';

const TAG_DIFF_TABLE_SECTION =
  '- 按表格行合并（{{按表格行合并标签}}）：\n  1. 每次都必须带上原表的表头行和分隔行。表头行必须以 | 开头并以 | 结尾，原样抄上一轮的表头（列名、顺序、空格都不要改），下一行是 |---|---| 这样的分隔行。缺了表头或分隔行，整张表不会被识别，补丁不会合并。\n  2. 数据行也必须以 | 开头并以 | 结尾，列数和表头一致。只写有变化的行；没有写到的行脚本会自动保留上一轮。如果这一轮要更新表格，却完全没有写表格（也没有写【删除】行），脚本会认为没有表格更新，整份补丁不生效，上一轮原样保留。\n  3. 第一列是行键（通常是名字），不能改行键；改行键会被当成新增行，旧行不会消失。要改某一行，按原列数整行重写；要新增一行，直接写这一行；要删除一行，单独写一行「【删除】行名」，这一行不能有别的内容，行名要和第一列完全一致。删除会作用到这个标签里所有第一列同名的行。\n  4. 同一个标签里有多张表时，每张表都要带自己的表头行和分隔行，表头必须原样；脚本按表头找表，表头变了会被当成新表追加，旧表还在。不要放两张表头完全相同的表，脚本只会往第一张里合并。表格外的说明文字不会被保存，补丁里不要写。';

const TAG_DIFF_INSTRUCTION_TAIL_COMMON =
  '某个差量标签这轮不需要更新时，仍然要写出完整的一对 <标签名>【无变化】</标签名>，不能只写【无变化】四个字，也不能省略标签本身；【无变化】必须单独占满整个标签内容，不要加解释。某个标签上一轮没有内容（首次生成）时，必须输出完整内容，不能写【无变化】。';

const TAG_DIFF_INSTRUCTION_TAIL_BLOCK = '首次生成按块合并的标签必须写出完整块结构。';

const TAG_DIFF_INSTRUCTION_TAIL_TABLE = '首次生成按表格行合并的标签必须写出完整表头和所有行。';

const TAG_DIFF_INSTRUCTION_NESTED =
  '如果标签内部还包含别的标签（嵌套标签），把内层标签写在外层标签里面，不要在外层之外再单独输出内层标签；重复输出可能被脚本当作嵌套内容丢掉。';

const TAG_DIFF_INSTRUCTION_TAIL = [
  TAG_DIFF_INSTRUCTION_TAIL_COMMON,
  TAG_DIFF_INSTRUCTION_TAIL_BLOCK,
  TAG_DIFF_INSTRUCTION_TAIL_TABLE,
  TAG_DIFF_INSTRUCTION_NESTED,
].join('\n');

/**
 * 使用说明页直接展示这段模板，保证「说明里的写法」和「实际注入的提示词」是同一份。
 * 两个占位符分别对应按块合并、按表格行合并的标签名单。
 */
export const TAG_DIFF_INSTRUCTION_TEMPLATE = [
  TAG_DIFF_INSTRUCTION_HEAD,
  TAG_DIFF_BLOCK_SECTION,
  TAG_DIFF_TABLE_SECTION,
  TAG_DIFF_INSTRUCTION_TAIL,
].join('\n');

/** 一个任务里实际命中差量模式的标签，按模式分组；保持标签串里的原顺序并去重。 */
export function collectTaskDiffTags(
  task: TagDiffTaskLike,
  modes: Record<string, TagDiffMode>,
): { blocks: string[]; table: string[] } {
  const blocks: string[] = [];
  const table: string[] = [];
  const seen = new Set<string>();
  // 和三处缺口/合并端同一口径：抽取标签 + 只进字段 + 豁免标签都可能回传并参与差量。
  const names = splitTagList(`${task.extractTags || ''},${task.extractInjectTags || ''},${task.exemptTags || ''}`);
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    const mode = normalizeTagDiffMode(modes[name]);
    if (mode === 'blocks') blocks.push(name);
    else if (mode === 'table') table.push(name);
  }
  return { blocks, table };
}

/**
 * 按任务生成要顶在任务消息最前面的差量规则。
 * 只写本任务实际命中 blocks / table 的标签；一个都没有时返回空串，不打扰 AI。
 */
export function buildTagDiffInstruction(
  task: TagDiffTaskLike,
  modes: Record<string, TagDiffMode>,
): string {
  const { blocks, table } = collectTaskDiffTags(task, modes);
  if (blocks.length === 0 && table.length === 0) return '';
  const lines = [TAG_DIFF_INSTRUCTION_HEAD];
  if (blocks.length > 0) {
    lines.push(TAG_DIFF_BLOCK_SECTION.replace('{{按块合并标签}}', blocks.join('、')));
  }
  if (table.length > 0) {
    lines.push(TAG_DIFF_TABLE_SECTION.replace('{{按表格行合并标签}}', table.join('、')));
  }
  lines.push(TAG_DIFF_INSTRUCTION_TAIL_COMMON);
  if (blocks.length > 0) lines.push(TAG_DIFF_INSTRUCTION_TAIL_BLOCK);
  if (table.length > 0) lines.push(TAG_DIFF_INSTRUCTION_TAIL_TABLE);
  lines.push(TAG_DIFF_INSTRUCTION_NESTED);
  return lines.join('\n');
}

export interface ApplyTagDiffsInput {
  /** AI 这一轮实际回传的补丁原文 */
  rawResponse: string;
  /** 这个任务的标签配置（只处理它自己产出的标签） */
  task: TagDiffTaskLike;
  /** 预设级「标签名 → 差量模式」 */
  modes: Record<string, TagDiffMode>;
  /** 上一轮 `<plot>` 里扫出来的标签投影 */
  previousTags: TagMap;
}

/**
 * 把一次任务回传里的差量标签合并成完整标签，再拼回成「完整回传」。
 *
 * 没有启用任何差量标签时原样返回——保证非差量任务逐字节不变。
 * 解析不出块（或补丁是空/无变化）时保留上一轮内容，不把旧档弄丢。
 */
export function applyTagDiffs(input: ApplyTagDiffsInput): string {
  const raw = typeof input.rawResponse === 'string' ? input.rawResponse : '';
  const task = input.task || {};
  const modes = input.modes || {};
  // 豁免标签也要进抽取组：它们不强制出现，但出现时必须能被合并/落盘。
  const extractGroup = [task.extractTags || '', task.exemptTags || ''].filter(part => part.trim() !== '').join(',');
  const extraction = extractTaskTags(raw, extractGroup, task.extractInjectTags || '');
  const names = splitTagList(`${task.extractTags || ''},${task.extractInjectTags || ''},${task.exemptTags || ''}`);
  const uniqueNames: string[] = [];
  for (const name of names) {
    if (!uniqueNames.includes(name)) uniqueNames.push(name);
  }

  const hasDiff = uniqueNames.some(name => normalizeTagDiffMode(modes[name]) !== 'off');
  if (!hasDiff) return raw;

  const contents = new Map<string, string>();
  for (const name of uniqueNames) {
    const mode = normalizeTagDiffMode(modes[name]);
    const current = extraction.extractedTags[name];
    if (mode === 'off') {
      if (typeof current === 'string' && current.trim() !== '') contents.set(name, current);
      continue;
    }

    const previous = previousContentOf(input.previousTags, name);
    if (typeof current !== 'string' || isNoChangeText(current)) {
      if (previous !== '') contents.set(name, previous);
      continue;
    }

    // 旧格式（如上一轮还是表格）遇到块模式：本轮先全量替换，不拿旧格式当底稿做差量。
    if (tagNeedsFullRefresh(mode, previous)) {
      contents.set(name, current);
      continue;
    }

    if (mode === 'keep') {
      contents.set(name, current);
    } else if (mode === 'table') {
      contents.set(name, mergeTableDocument(previous, current));
    } else {
      contents.set(name, mergeBlockDocument(previous, current));
    }
  }

  // 嵌套标签（character_archive 在 character_info 里、women_miracle 在 beauty_miracle 里）
  // 不能当兄弟标签再输出一遍；父标签自己会把它们带上。
  const nested = new Set<string>();
  for (const [parent, content] of contents.entries()) {
    for (const child of contents.keys()) {
      if (child === parent) continue;
      if (content.includes(`<${child}>`) || content.includes(`<${child} `)) nested.add(child);
    }
  }

  const blocks: string[] = [];
  for (const name of uniqueNames) {
    const content = contents.get(name);
    if (content === undefined || nested.has(name)) continue;
    blocks.push(buildTagBlock(name, content));
  }
  return blocks.join('\n\n');
}
