/**
 * 取数层 · 世界书命中（第 2 期）—— `$1` 与 `$9` 的唯一产地
 *
 * **现行主路径吃酒馆预演的激活结果**（`tavern-worldbook-scan.ts` 调
 * `buildPlotWorldbookTextsFromActivation`）；下面按关键词扫描、递归扩散那套旧算法
 * 只用于降级链，不是主路径，别据它判断 $1 现在怎么取。
 *
 * `$1` 的含义就是一句大白话：**酒馆那个 AI 这轮会读到的世界书内容**。
 * 角色卡绑定的主书 + 附加书，常驻条目（蓝灯）直接进，绿灯条目按关键词扫，
 * 扫进去的条目正文又能继续带出别的条目（递归），最后只把**条目正文**拼起来。
 *
 * `$1` 与 `$9` 都剔掉三类条目：名字带屏蔽词的（MVU / 变量 / 状态 / 思维链…，
 * 见 `BLOCKED_NAME_KEYWORDS`；中文「规则」不在其中）、大纲表与纪要索引（它们有 `$5` 专用占位符）、
 * 以及本脚本自己写入的托管条目（名字带 `plot_assistant-` 前缀，见
 * `isManagedWorldbookEntry` —— 资料进了世界书就别在占位符里再展开一遍）。
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
 * 4. **名字带屏蔽词的条目不进上下文**，且这条屏蔽只对「非数据库生成」的条目生效——
 *    见 `createPlotFilters` 的 `includeEntry`。中文「规则」不屏蔽（2026-11-11 批 76 用户定，
 *    防止「王国规则总览」这类正经设定被误杀），英文 `Rule` / `rule` 照旧屏蔽。
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
 * 酒馆插入位置段位（`world_info_position`：before=0 / after=1 / ANTop=2 / ANBottom=3 /
 * atDepth=4 / EMTop=5 / EMBottom=6 / outlet=7）。数字与字符串两种写法都认，
 * 因为预演接口给的是数字、酒馆助手 getWorldbook() 给的是字符串。
 */
function nativePositionRank(position: string | number | undefined | null): number {
  const raw = String(position ?? '').trim().toLowerCase();
  switch (raw) {
    case '0': case 'before': case 'before_char': case 'before_character':
    case 'before_character_definition': return 0;
    case '1': case 'after': case 'after_char': case 'after_character':
    case 'after_character_definition': return 1;
    case '2': case 'antop': case 'before_author_note': return 2;
    case '3': case 'anbottom': case 'after_author_note': return 3;
    case '4': case 'atdepth': case 'at_depth': case 'at_depth_as_system': case 'system': return 4;
    case '5': case 'emtop': case 'before_example_messages': return 5;
    case '6': case 'embottom': case 'after_example_messages': return 6;
    case '7': case 'outlet': return 7;
    default: return 4;
  }
}

/**
 * 按酒馆拼提示词的先后排 $1/$9：插入位置段位 → 顺序号升序 → 原始下标。
 *
 * 酒馆 `world-info.js:5084` 先 `[...allActivatedEntries.values()].sort((a,b) => b.order - a.order)`，
 * 再对各槽 `unshift`，所以同槽里 order 小的在前；position 只决定条目落在提示词哪一段。
 * $1 是一整段资料、不分槽，这里只保留「段位 → order → 原序」这条线性顺序。
 * 缺省值统一成「atDepth / 100」，让老版广播（不带这些字段）仍能保持激活清单原序。
 */
export function compareByNativeOrder(a: WorldbookHitEntry, b: WorldbookHitEntry): number {
  const rankA = nativePositionRank(a.position);
  const rankB = nativePositionRank(b.position);
  if (rankA !== rankB) return rankA - rankB;
  const orderA = a.order === null ? 100 : a.order;
  const orderB = b.order === null ? 100 : b.order;
  if (orderA !== orderB) return orderA - orderB;
  return a.placeholderIndex - b.placeholderIndex;
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
 * 名单与 ACU 剧情推进、工作流助手的 `BLOCKED_KEYWORDS` 一致（各 16 词，见
 * `D:/Github/可视化前端/src/数据库源代码.js:2492`、`:30863`、`:88393`、`:89036`）。
 * **唯一例外**：中文「规则」按 2026-11-11 批 76 用户裁定不滤，避免「王国规则总览」
 * 这类正经设定条目被误杀；英文 `Rule` / `rule` 仍滤（用户同批明确要求）。
 *
 * 为什么滤：这些名字多半属于给 MVU 变量框架、正则、状态栏用的条目，正文是变量定义或
 * 格式说明，AI 读了只会照着写代码而不是写剧情。数据库生成的条目不在此列——
 * 它们名字里常带「变量」「状态」，可它们是数据不是框架，由 `isFrameworkEntry` 放行。
 *
 * 大小写敏感：`cot` / `mvu` / `rule` 小写、`Status` / `Rule` 首字母大写，各自算独立一条；
 * 不做大小写折叠，与上游一致。
 */
const BLOCKED_NAME_KEYWORDS = [
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
 * 本脚本写入世界书的条目统一挂这个前缀（2026-11-07 批 38 用户定，**写死不可改**）。
 *
 * 完整条目名 = 前缀 + 条目名（默认标签名）。这个常量放在取数层而不是写入模块：
 * 「别把自己写的资料再读一遍」的过滤要在这里生效，而这一层必须保持纯函数
 * （`tools/plot-parity` 要单独编译它），不能反过来 import 碰酒馆全局的写入模块。
 */
export const PLOT_WB_WRITE_PREFIX = 'plot_assistant-';

/**
 * 名字带托管前缀 → 本脚本自己写的条目，不进 `$1` / `$9`。
 *
 * 为什么（批 37 用户定）：资料搬进世界书后，任务提示词里的世界书占位符会把它展开一遍，
 * 与任务里 `{{标签}}` 的内容重复 —— 等于白搬还翻倍。与「不加防御代码」不冲突：
 * 那条管用户楼层的注入，这条管脚本自己读世界书时别把自己写的再读一遍。
 */
export function isManagedWorldbookEntry(entry: Pick<WorldbookHitEntry, 'rawComment'>): boolean {
  return String(entry.rawComment ?? '').trim().startsWith(PLOT_WB_WRITE_PREFIX);
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
 * 四处照抄：
 * - 大纲表条目与纪要索引条目**一律排除** —— 它们有专用占位符（`$5` 一族）。
 * - 名字含 `BLOCKED_NAME_KEYWORDS` 的**一律排除**（中文「规则」已按批 76 移出名单），
 *   但数据库生成的条目不筛：那些名字里常带「变量」「状态」，可它们是数据不是框架。
 * - 名字带托管前缀（`plot_assistant-`）的**一律排除** —— 那是本功能自己写进去的条目，
 *   再读一遍就与任务里 `{{标签}}` 的内容重复（2026-11-07 批 37 用户定）。
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
    includeEntry: entry => !isFrameworkEntry(entry) && !isManagedWorldbookEntry(entry),
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

/**
 * 酒馆本轮「真的激活了」的世界书条目（A 方案，2026-11-11 批 75）。
 *
 * 数据来源是酒馆自己的扫描结果（Luker `simulateWorldInfoActivation()` 返回的
 * `activatedEntries`）：蓝灯常驻、绿灯关键词、次关键词逻辑、正则、概率、
 * 大小写/全词、sticky/cooldown/delay、分组互斥、token 预算、每条目的扫描深度
 * 全都由酒馆自己算，脚本不再自己重算，也就不会跟酒馆差一条。
 *
 * 与旧版 `buildPlotWorldbookTexts` 的差别只有「谁算激活」：
 * 过滤层（`createPlotFilters`）、$9 剔数据库生成条目、条目勾选、手动选书全部原样保留。
 *
 * 分两种书（用户批 75 第 3 条）：
 * - 角色卡绑定书 / 全局书 / 聊天书：酒馆这轮会扫描它们，只发酒馆算出来的激活条目；
 * - 既不是绑定书也不是全局书（没启用、根本不会被关键词触发）：勾哪个条目就整条发哪个条目。
 */
export interface ActivatedWorldbookEntry {
  /** 条目所在的世界书文件名（酒馆 `WIScanEntry.world`，运行时带、类型声明里没有）。 */
  world?: string;
  uid?: number | string;
  comment?: string;
  content?: string;
  /** 酒馆原生 `world_info_position`：数字 0~7，或酒馆助手给的字符串位置名。 */
  position?: number | string;
  /** at_depth 条目的插入深度。 */
  depth?: number;
  /** 插入顺序号。酒馆按它排序、再分槽拼进提示词；$1 靠它还原原生条序。 */
  order?: number;
}

export interface ActivationWorldbookOptions {
  /** 这次要发给剧情推进 AI 的书（设置页「跟随角色卡」或「手动选择」的结果）。 */
  bookNames: string[];
  /** 酒馆当前真正会扫描的书：角色卡主书 + 附加书 + 全局书 + 聊天书。 */
  enabledBooks: string[];
  /** 酒馆本轮原生扫描激活的条目。顺序是「谁先被扫到」，取数层会按 position/order 重排成酒馆提示词的顺序。 */
  activatedEntries: ActivatedWorldbookEntry[];
  /** 每本书的全量条目，给「没启用、根本不会被扫描」的书兜底用。 */
  entriesByBook: Record<string, TavernEntryLike[]>;
  enabledEntries?: Record<string, unknown> | null;
}

function activatedToHit(raw: ActivatedWorldbookEntry, index: number): WorldbookHitEntry {
  const { rawComment, normalizedComment } = getCommentInfo({
    comment: raw.comment,
    name: raw.comment,
  });
  return {
    uid: raw.uid ?? '',
    bookName: String(raw.world ?? ''),
    comment: rawComment,
    rawComment,
    normalizedComment,
    content: String(raw.content ?? ''),
    enabled: true,
    type: 'selective',
    key: [],
    position: String(raw.position ?? ''),
    depth: typeof raw.depth === 'number' && Number.isFinite(raw.depth) ? raw.depth : 0,
    order: typeof raw.order === 'number' && Number.isFinite(raw.order) ? raw.order : null,
    prevent_recursion: false,
    exclude_recursion: false,
    placeholderIndex: index,
  };
}

export function buildPlotWorldbookTextsFromActivation(
  options: ActivationWorldbookOptions,
): PlotWorldbookResult {
  const filters = createPlotFilters({ enabledEntries: options.enabledEntries });
  const enabledSet = new Set((options.enabledBooks ?? []).filter(Boolean));
  const scanBooks = new Set((options.bookNames ?? []).filter(bookName => enabledSet.has(bookName)));
  const directBooks = (options.bookNames ?? []).filter(bookName => !enabledSet.has(bookName));

  const collect = (excludeDatabase: boolean): string => {
    const kept: WorldbookHitEntry[] = [];
    const accept = (entry: WorldbookHitEntry): boolean =>
      filters.includeEntry(entry) &&
      filters.isSelected(entry) &&
      (!excludeDatabase || !isDatabaseGeneratedEntry(entry));

    // ① 参与酒馆扫描的书：只认酒馆自己算出来的激活结果，一条不多一条不少。
    const activatedList = options.activatedEntries ?? [];
    activatedList.forEach((activated, index) => {
      const bookName = String(activated?.world ?? '');
      if (!scanBooks.has(bookName)) return;
      const entry = activatedToHit(activated, index);
      if (accept(entry)) kept.push(entry);
    });

    // ② 没启用的书：酒馆根本不会扫它，谈不上「原生激活」。
    //    按批 75 用户定的口径——勾哪个条目就整条发哪个条目，不勾的不发。
    for (const bookName of directBooks) {
      const rawEntries = options.entriesByBook?.[bookName] ?? [];
      rawEntries.forEach((raw, index) => {
        if (raw.enabled === false) return;
        const entry = normalizeTavernEntry(raw, bookName, activatedList.length + index);
        if (accept(entry)) kept.push(entry);
      });
    }

    // 激活清单是「谁先被扫到谁在前」，酒馆拼提示词时按插入位置 + 顺序号重排过；
    // $1 不分槽，但要按酒馆原生条序发给剧情推进 AI（批 78 用户定）。
    return formatWorldbookHits(kept.sort(compareByNativeOrder));
  };

  return { content: collect(false), contentExcludingDatabase: collect(true) };
}

/**
 * 把酒馆给的各种形状的「本轮激活条目」归一成 `ActivatedWorldbookEntry[]`。
 *
 * 三种来源：预演接口给数组、WORLD_INFO_ACTIVATED 广播给数组、
 * WORLDINFO_SCAN_DONE 给 `Map<"书名.uid", 条目>`（连 0 激活也会发，用来清旧缓存）。
 * 不用 `instanceof Map`：脚本在 iframe、事件来自父窗口，跨 realm 恒为 false。
 */
export function normalizeActivatedEntries(entries: unknown): ActivatedWorldbookEntry[] {
  const isMapLike = (value: unknown): boolean =>
    !!value &&
    typeof (value as { entries?: unknown }).entries === 'function' &&
    typeof (value as { size?: unknown }).size === 'number';
  const list: unknown[] = isMapLike(entries)
    ? Array.from((entries as { entries: () => Iterable<[unknown, unknown]> }).entries()).map(([key, value]) => {
        const raw = (value ?? {}) as Record<string, unknown>;
        // Map 的 key 是 `${world}.${uid}`；值偶尔不带 world，就从 key 兜底。
        if (raw.world === undefined || raw.world === null || raw.world === '') {
          return { ...raw, world: String(key).replace(/\.[^.]+$/, '') };
        }
        return value;
      })
    : Array.isArray(entries) ? entries : [];
  const numberOrUndefined = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  return list.map(item => {
    const raw = (item ?? {}) as Record<string, unknown>;
    return {
      world: String(raw.world ?? ''),
      uid: typeof raw.uid === 'number' || typeof raw.uid === 'string' ? raw.uid : '',
      comment: String(raw.comment ?? ''),
      content: String(raw.content ?? ''),
      position: typeof raw.position === 'number' || typeof raw.position === 'string' ? raw.position : undefined,
      depth: numberOrUndefined(raw.depth),
      order: numberOrUndefined(raw.order),
    };
  });
}

