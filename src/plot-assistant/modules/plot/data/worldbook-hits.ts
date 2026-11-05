/**
 * 取数层 · 世界书命中（第 2 期）—— `$1` 与 `$9` 的唯一产地
 *
 * `$1` 的含义就是一句大白话：**酒馆那个 AI 这轮会读到的世界书内容**。
 * 角色卡绑定的主书 + 附加书，常驻条目（蓝灯）直接进，绿灯条目按关键词扫，
 * 扫进去的条目正文又能继续带出别的条目（递归），最后只把**条目正文**拼起来。
 *
 * `$1` 与 `$9` 都剔掉两类条目：名字像框架的（规则 / MVU / 变量 / 状态 / 思维链…，
 * 见 `BLOCKED_NAME_KEYWORDS`），以及大纲表与纪要索引（它们有 `$5` 专用占位符）。
 * `$9` 再多剔一层：数据库自己生成的条目
 * （comment 以 `TavernDB-ACU-` / `总结条目` / `小总结条目` / `重要人物条目` 开头）。
 * 所以这里**一次扫描两个出口**，与上游 `Promise.allSettled([...])` 的写法对应。
 *
 * 上游来源：`src/service/worldbook/pipeline.ts:1214` 的
 * `collectCombinedWorldbookEntriesByStrategy_ACU` + `:1396`
 * `buildCombinedWorldbookContentByStrategy_ACU`，以及 `plot-task-engine.ts:1333`
 * 那组剧情推进专用的过滤回调。
 *
 * 四处必须照抄、改了就变味的地方：
 *
 * 1. **排序不是按命中顺序**，而是按「插入位置段 → 深度 → order → 原始下标 → 书名 → uid」。
 *    上游就算不传 `sortEntries` 也会用这个默认比较器，所以 `$1` 里的条目顺序是固定的。
 * 2. **常驻条目的正文一定会进「递归扩散源」**，所以蓝灯条目能把绿灯条目「带出来」——
 *    这是酒馆原生行为，不照抄会少一大片。注意它与 `includeConstantEntriesInBaseScan`
 *    不是一回事：后者只额外把常驻正文塞进**基础扫描文本**，真正被它影响的只有
 *    `exclude_recursion` 的条目（那类条目只认基础文本）。
 * 3. **递归最多 10 层**，且 `exclude_recursion` 的条目只认原始扫描文本，
 *    不吃递归扩散出来的文本。
 * 4. **框架条目不进上下文**，且这条屏蔽只对「非数据库生成」的条目生效——
 *    见 `createPlotFilters` 的 `includeEntry`。
 */

/** 酒馆助手 `getWorldbook()` 交回来的条目（嵌套形状）。 */
interface TavernEntryLike {
  uid?: number | string;
  name?: string;
  content?: string;
  enabled?: boolean;
  strategy?: {
    type?: string;
    keys?: (string | RegExp)[];
    keys_secondary?: { logic?: string; keys?: (string | RegExp)[] };
    scan_depth?: 'same_as_global' | number;
  };
  position?: { type?: string; role?: string; depth?: number; order?: number };
  recursion?: { prevent_incoming?: boolean; prevent_outgoing?: boolean; delay_until?: null | number };
  probability?: number;
  [key: string]: unknown;
}

/**
 * 内部统一形状 —— 字段名沿用上游那套（`type` / `key` / `order` / `prevent_recursion` / `exclude_recursion`），
 * 这样算法部分能一行对一行地读。代价是下面 `normalizeTavernEntry` 要做一次显式映射。
 */
export interface WorldbookHitEntry {
  uid: number | string;
  bookName: string;
  /** 条目名（酒馆里叫 comment）。 */
  comment: string;
  rawComment: string;
  /** 去掉 `ACU-[xxx]-` 与 `外部导入-xxx-` 前缀后的名字，用于识别数据库生成的条目。 */
  normalizedComment: string;
  content: string;
  enabled: boolean;
  /** `constant` = 蓝灯常驻，`selective` = 绿灯按关键词。 */
  type: string;
  key: string[];
  position: string;
  depth: number;
  order: number | null;
  prevent_recursion: boolean;
  exclude_recursion: boolean;
  /** 进过滤链之前的全局下标，排序时的兜底键。 */
  placeholderIndex: number;
}

const OUTLINE_PREFIX = 'TavernDB-ACU-OutlineTable';
const SUMMARY_INDEX_PREFIX = 'TavernDB-ACU-CustomExport-纪要索引';
const DB_GENERATED_PREFIXES = ['TavernDB-ACU-', '总结条目', '小总结条目', '重要人物条目'];
const MAX_RECURSION_DEPTH = 10;

/** 上游 `getWorldbookCommentInfo_ACU`：剥掉两种自动前缀，留下可判定的名字。 */
export function getCommentInfo(entry: { comment?: unknown; name?: unknown } | null | undefined) {
  const rawComment = String(entry?.comment ?? entry?.name ?? '').trim();
  let normalizedComment = rawComment.replace(/^ACU-\[[^\]]+\]-/, '');
  normalizedComment = normalizedComment.replace(/^外部导入-(?:[^-]+-)?/, '');
  return { rawComment, normalizedComment };
}

/** 上游 `getWorldbookEntryKeywords_ACU`：`key` 与 `keys` 去重小写。只认字符串。 */
export function getEntryKeywords(entry: Record<string, unknown> | null | undefined): string[] {
  const toStrArray = (value: unknown): string[] => {
    if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
    if (typeof value === 'string' && value.trim()) return [value];
    return [];
  };
  return [...new Set([...toStrArray(entry?.key), ...toStrArray(entry?.keys)])].map(keyword => keyword.toLowerCase());
}

/** 上游 `normalizeLorebookPosition_ACU`：只认得出三个段位，其余落 `at_depth_as_system`。 */
export function normalizePosition(position: unknown): string {
  const raw = String(position ?? '').trim().toLowerCase();
  if (raw === 'at_depth_as_system' || raw === 'system') return 'at_depth_as_system';
  if (raw === 'before_char' || raw === 'before_character' || raw === 'before_character_definition' || raw === '0') return 'before_character_definition';
  if (raw === 'after_char' || raw === 'after_character' || raw === 'after_character_definition' || raw === '1') return 'after_character_definition';
  return 'at_depth_as_system';
}

function getOrderNumber(order: unknown): number | null {
  const numeric = typeof order === 'number' ? order : parseInt(String(order ?? ''), 10);
  return Number.isFinite(numeric) ? numeric : null;
}

/**
 * 上游 `compareWorldbookEntriesForPlaceholder_ACU` 逐字搬。
 * 段 → 深度（越深越靠前）→ order → 原始下标 → 书名 → uid。
 */
export function compareForPlaceholder(a: WorldbookHitEntry, b: WorldbookHitEntry): number {
  const segmentOf = (entry: WorldbookHitEntry) => {
    if (entry.position === 'before_character_definition') return 0;
    if (entry.position === 'after_character_definition') return 1;
    return 2;
  };
  const segmentA = segmentOf(a);
  const segmentB = segmentOf(b);
  if (segmentA !== segmentB) return segmentA - segmentB;

  const depthRankA = -a.depth;
  const depthRankB = -b.depth;
  if (depthRankA !== depthRankB) return depthRankA - depthRankB;

  const orderA = a.order === null ? Number.MAX_SAFE_INTEGER : a.order;
  const orderB = b.order === null ? Number.MAX_SAFE_INTEGER : b.order;
  if (orderA !== orderB) return orderA - orderB;

  if (a.placeholderIndex !== b.placeholderIndex) return a.placeholderIndex - b.placeholderIndex;
  if (a.bookName !== b.bookName) return a.bookName.localeCompare(b.bookName, 'zh-Hans-CN');
  return String(a.uid ?? '').localeCompare(String(b.uid ?? ''), 'zh-Hans-CN');
}

/**
 * 把酒馆助手给的**嵌套**条目压成上面那个平形状。
 *
 * 字段对照（左边是酒馆助手，右边是上游算法认的名字）：
 * - `strategy.type` → `type`
 * - `strategy.keys` → `key`（只留字符串；正则型关键字上游那套字符串匹配本来就不支持）
 * - `position.order` → `order`，`position.type` → `position`，`position.depth` → `depth`
 * - `recursion.prevent_incoming` → `exclude_recursion`（不许被递归带进来）
 * - `recursion.prevent_outgoing` → `prevent_recursion`（不拿它去带别人）
 */
export function normalizeTavernEntry(raw: TavernEntryLike, bookName: string, placeholderIndex: number): WorldbookHitEntry {
  const { rawComment, normalizedComment } = getCommentInfo({ comment: raw.name, name: raw.name });
  const stringKeys = (Array.isArray(raw.strategy?.keys) ? raw.strategy!.keys : []).filter(
    (key): key is string => typeof key === 'string',
  );
  return {
    uid: raw.uid ?? '',
    bookName,
    comment: raw.name ? String(raw.name) : '',
    rawComment,
    normalizedComment,
    content: String(raw.content ?? ''),
    enabled: raw.enabled !== false,
    type: String(raw.strategy?.type ?? 'selective'),
    key: stringKeys,
    // 酒馆助手给的是规范位置（`before_character_definition` / `at_depth` …），
    // 但排序比较器只认上游那三个段位名，所以这里必须过一遍归一化。
    position: normalizePosition(raw.position?.type),
    depth: typeof raw.position?.depth === 'number' ? raw.position.depth : parseInt(String(raw.position?.depth ?? ''), 10) || 0,
    order: getOrderNumber(raw.position?.order),
    prevent_recursion: raw.recursion?.prevent_outgoing === true,
    exclude_recursion: raw.recursion?.prevent_incoming === true,
    placeholderIndex,
  };
}

/** 是不是数据库自己生成的条目（`$9` 要剔掉的就是这批）。 */
export function isDatabaseGeneratedEntry(entry: Pick<WorldbookHitEntry, 'normalizedComment'>): boolean {
  return DB_GENERATED_PREFIXES.some(prefix => entry.normalizedComment.startsWith(prefix));
}

export interface CollectHitsOptions {
  bookNames: string[];
  entriesByBook: Record<string, TavernEntryLike[]>;
  /** 扫描文本（调用方先拼好「最近 N 条消息 + 本轮用户输入」）。这层负责转小写。 */
  baseScanText?: string;
  /** 剧情推进传 true：蓝灯条目的正文参与扫描，从而能带出绿灯条目。 */
  includeConstantEntriesInBaseScan?: boolean;
  /** 默认 true：`enabled === false` 的条目直接排除。 */
  excludeDisabledEntries?: boolean;
  excludeEntry?: (entry: WorldbookHitEntry) => boolean;
  includeEntry?: (entry: WorldbookHitEntry) => boolean;
  isSelected?: (entry: WorldbookHitEntry) => boolean;
  forceIncludeEntry?: (entry: WorldbookHitEntry) => boolean;
  maxRecursionDepth?: number;
}

/**
 * 扫描世界书，返回命中的条目（已按上游比较器排好序）。
 *
 * 顺序照上游：先按书顺序铺开并过滤 → 常驻条目进池 → 关键词递归扩散。
 */
export function collectWorldbookHits(options: CollectHitsOptions): WorldbookHitEntry[] {
  const bookNames = [...new Set((Array.isArray(options.bookNames) ? options.bookNames : []).filter(Boolean))];
  if (bookNames.length === 0) return [];

  const excludeEntry = options.excludeEntry ?? (() => false);
  const includeEntry = options.includeEntry ?? (() => true);
  const isSelected = options.isSelected ?? (() => true);
  const forceIncludeEntry = options.forceIncludeEntry ?? (() => false);
  const excludeDisabledEntries = options.excludeDisabledEntries !== false;

  let placeholderIndex = 0;
  const allEntries: WorldbookHitEntry[] = [];
  for (const bookName of bookNames) {
    const bookEntries = Array.isArray(options.entriesByBook?.[bookName]) ? options.entriesByBook[bookName] : [];
    for (const raw of bookEntries) {
      const entry = normalizeTavernEntry(raw, bookName, placeholderIndex++);
      if (excludeEntry(entry)) continue;
      if (includeEntry(entry) === false) continue;
      allEntries.push(entry);
    }
  }
  if (allEntries.length === 0) return [];

  const forcedSet = new Set(allEntries.filter(entry => forceIncludeEntry(entry) === true));
  const userEnabledEntries = allEntries
    .filter(entry => (excludeDisabledEntries ? entry.enabled : true) || forcedSet.has(entry))
    .filter(entry => isSelected(entry) !== false);
  if (userEnabledEntries.length === 0) return [];

  let baseScanText = String(options.baseScanText ?? '').toLowerCase();
  const constantEntries = userEnabledEntries.filter(entry => entry.type === 'constant');
  let keywordEntries = userEnabledEntries.filter(entry => entry.type !== 'constant' && !forcedSet.has(entry));

  if (options.includeConstantEntriesInBaseScan === true) {
    const constantBaseText = constantEntries
      .filter(entry => !entry.prevent_recursion)
      .map(entry => entry.content || '')
      .join('\n')
      .toLowerCase();
    if (constantBaseText) baseScanText = [baseScanText, constantBaseText].filter(Boolean).join('\n');
  }

  const triggered = new Set<WorldbookHitEntry>([
    ...constantEntries,
    ...userEnabledEntries.filter(entry => forcedSet.has(entry)),
  ]);

  const maxDepth = options.maxRecursionDepth ?? MAX_RECURSION_DEPTH;
  let depth = 0;
  while (depth < maxDepth) {
    depth += 1;
    let changed = false;

    const recursionSourceContent = Array.from(triggered)
      .filter(entry => !entry.prevent_recursion)
      .map(entry => entry.content)
      .join('\n')
      .toLowerCase();
    const fullSearchText = `${baseScanText}\n${recursionSourceContent}`;

    const remaining: WorldbookHitEntry[] = [];
    for (const entry of keywordEntries) {
      const keywords = entry.key.map(keyword => keyword.toLowerCase());
      const hit =
        keywords.length > 0 &&
        keywords.some(keyword => (entry.exclude_recursion ? baseScanText.includes(keyword) : fullSearchText.includes(keyword)));
      if (hit) {
        triggered.add(entry);
        changed = true;
      } else {
        remaining.push(entry);
      }
    }
    if (!changed) break;
    keywordEntries = remaining;
  }

  return Array.from(triggered).sort(compareForPlaceholder);
}

/**
 * 上游 `formatCombinedWorldbookEntries_ACU`：**只拼正文**，不加条目名。
 * 剧情推进传的 `formatEntry` 就是 `content.trim()`，所以这里默认同款。
 */
export function formatWorldbookHits(entries: WorldbookHitEntry[], formatEntry?: (entry: WorldbookHitEntry) => string): string {
  const format = formatEntry ?? ((entry: WorldbookHitEntry) => String(entry.content || '').trim());
  return entries
    .map(entry => format(entry))
    .filter(chunk => typeof chunk === 'string' && chunk.trim() !== '')
    .join('\n\n')
    .trim();
}

/**
 * 条目名字里出现这些词就当作「框架条目」，不进世界书上下文。
 *
 * 抄自工作流助手 `src/工作流助手/worldbook/blocked.ts` 的 `BLOCKED_KEYWORDS`：
 * 状态栏、变量、规则、思维链这些条目是给 MVU 和正则用的，AI 读了只会照着它们写代码，
 * 而不是照它们写剧情。ACU 那边同名函数（`shared/utils.ts:393` `isEntryBlocked_ACU`）
 * 留着壳但词表是空的，所以真正在过滤的从来只有工作流助手这一份。
 *
 * 大小写敏感是照抄的：`cot` 小写、`Status` / `Rule` 首字母大写各自算独立一条。
 */
const BLOCKED_NAME_KEYWORDS = [
  '规则',
  '思维链',
  'cot',
  'MVU',
  'mvu',
  '变量',
  '状态',
  'Status',
  'Rule',
  'rule',
  '检定',
  '判断',
  '叙事',
  '文风',
  'InitVar',
  '格式',
];

/**
 * 名字（酒馆里的 comment）含屏蔽词 → 不进世界书上下文。
 *
 * 取的是**原始名字**（`rawComment`），不是剥掉 `ACU-[xxx]-` 前缀的那份 ——
 * 前缀本身也可能带词，剥掉反而会漏。
 */
export function isBlockedByName(entry: Pick<WorldbookHitEntry, 'rawComment'>): boolean {
  const name = String(entry.rawComment ?? '').trim();
  if (!name) return false;
  return BLOCKED_NAME_KEYWORDS.some(keyword => name.includes(keyword));
}

/**
 * 这条「本来就不会进 `$1`」。
 *
 * 面板上要标出这批条目（用户在勾选框里看得见它们、但勾不勾都不影响生成），
 * 所以判定必须和运行时用同一份 —— 这里抽出来，`createPlotFilters` 与面板都调它。
 */
export function isFrameworkEntry(entry: Pick<WorldbookHitEntry, 'rawComment' | 'normalizedComment'>): boolean {
  const comment = String(entry.normalizedComment ?? '');
  if (comment.startsWith(OUTLINE_PREFIX) || comment.startsWith(SUMMARY_INDEX_PREFIX)) return true;
  return !isDatabaseGeneratedEntry(entry) && isBlockedByName(entry);
}

/**
 * 剧情推进专用的「进不进池」判定（对应 `plot-task-engine.ts:1333` 那组回调）。
 *
 * 三处照抄：
 * - 大纲表条目与纪要索引条目**一律排除** —— 它们有专用占位符（`$5` 一族）。
 * - 名字含 `BLOCKED_NAME_KEYWORDS` 的**一律排除**，但数据库生成的条目不筛：
 *   那些名字里常带「变量」「状态」，可它们是数据不是框架。这条对应工作流助手
 *   `worldbook/content.ts:144` 的 `if (!autoIncluded && isEntryBlocked(entry)) continue;`。
 * - `enabledEntries` 为空的按「全选」处理；非空时按「这本书的 uid 列表」筛。
 *
 * agent 绿名单（`agentGreenlights`）属于第 7 期，没开 agent 时它本来就是空集，先不做。
 */
export function createPlotFilters(options: {
  enabledEntries?: Record<string, unknown> | null;
}): {
  includeEntry: (entry: WorldbookHitEntry) => boolean;
  isSelected: (entry: WorldbookHitEntry) => boolean;
} {
  const enabledMap = options.enabledEntries;
  const hasAnySelection = !!enabledMap && typeof enabledMap === 'object' && Object.keys(enabledMap).length > 0;

  return {
    includeEntry: entry => !isFrameworkEntry(entry),
    isSelected: entry => {
      if (!hasAnySelection) return true;
      if (isDatabaseGeneratedEntry(entry)) return true;
      const list = (enabledMap as Record<string, unknown>)[entry.bookName];
      if (typeof list === 'undefined') return true;
      if (!Array.isArray(list)) return true;
      // uid 在酒馆助手里时而是数字时而是字符串，两边都 String() 再比，
      // 否则会出现「界面上明明勾着，生成出来的 `$1` 里却没有它」。
      return list.some(uid => String(uid) === String(entry.uid));
    },
  };
}

export interface PlotWorldbookOptions {
  bookNames: string[];
  entriesByBook: Record<string, TavernEntryLike[]>;
  /** 最近 N 条消息正文 + 本轮用户输入。 */
  baseScanText: string;
  /** 额外参与扫描的文本（上游 `extraBaseText`，例如上一轮命中标签的内容）。 */
  extraScanText?: string;
  enabledEntries?: Record<string, unknown> | null;
}

export interface PlotWorldbookResult {
  /** `$1`：含数据库生成条目的完整内容。 */
  content: string;
  /** `$9`：同一套扫描，但剔掉数据库生成的条目。 */
  contentExcludingDatabase: string;
}

/**
 * 剧情推进的 `$1` / `$9`：同一次铺开、两次过滤。
 *
 * 上游是并发跑两次 `getWorldbookContentForPlot_ACU`（一次带 `excludeEntry`、一次不带），
 * 因为两边的读取可以共享缓存；这里条目已经在手，铺开之后各过滤一遍即可，结果一致。
 */
export function buildPlotWorldbookTexts(options: PlotWorldbookOptions): PlotWorldbookResult {
  const filters = createPlotFilters({ enabledEntries: options.enabledEntries });
  const baseScanText = [options.baseScanText || '', options.extraScanText || ''].filter(Boolean).join('\n');

  const content = formatWorldbookHits(
    collectWorldbookHits({
      bookNames: options.bookNames,
      entriesByBook: options.entriesByBook,
      baseScanText,
      includeConstantEntriesInBaseScan: true,
      ...filters,
    }),
  );

  const contentExcludingDatabase = formatWorldbookHits(
    collectWorldbookHits({
      bookNames: options.bookNames,
      entriesByBook: options.entriesByBook,
      baseScanText,
      includeConstantEntriesInBaseScan: true,
      ...filters,
      excludeEntry: entry => filters.includeEntry(entry) === false || isDatabaseGeneratedEntry(entry),
    }),
  );

  return { content, contentExcludingDatabase };
}
