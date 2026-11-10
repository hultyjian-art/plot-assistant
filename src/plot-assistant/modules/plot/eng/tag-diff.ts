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
