/**
 * plot/preset-edit.ts — 预设本体的「读成草稿 / 写回预设」（纯函数）
 *
 * 第 3 期要的是一台**能改预设的编辑器**。改预设这件事有个绕不开的坑：
 * 预设本体是个深嵌套对象（顶层 20+ 键、任务表里每个任务还带提示词组），
 * 而面板只认识自己那几个输入框。中间这层转换必须只说一次、只测一次 ——
 * 否则「只写回改过的几个键」这类错误会静默把用户的高级配置（世界书选择、
 * agent 控制、阶段约束……）整块抹掉，界面上还看不出来。
 *
 * 四条不能破的约定：
 *
 * 1. **写回是整份拷贝 + 定点覆盖**。`applyPresetDraft` 先把原对象深拷一份，
 *    只覆盖它认识的那些键，其余键原样留着。绝不「按草稿重建一个新对象」。
 * 2. **不认识的字段带得回去**。任务对象上的 `agentControl`、`mergeStrategy`、
 *    `triggerWhen` 这些这一期不编辑的字段，写回时逐字节不变（`preservedKeys` 里能查）。
 * 3. **读时宽松、写时收口**。脏值（`'3'`、`-1`、`null`、`NaN`）读的时候一律落成能用的值，
 *    写回去的是干净的整数 —— 编辑器不能把用户的脏数据原样再存一遍。
 * 4. **不碰存储、不碰 ACU**。这里只做数据整形，存哪儿、什么时候存是面板的事。
 */

import type { BoundaryRule } from './eng/context-tags';
import { normalizeRules } from './eng/context-tags';
import type { PlotPromptSegment } from './eng/task-model';
import { normalizeEveryRounds } from './eng/schedule';
import { isBlockEnabled } from './eng/prompt-blocks';
import { normalizeTagDiffModes, type TagDiffMode } from './eng/tag-diff';
import { isStoredPresetWrapper, unwrapPresetPayload } from './data/preset-store';

type Loose = Record<string, unknown>;

// ───────────────────────── 类型 ─────────────────────────

/**
 * 面板上的「基础信息」。
 *
 * 只有两项是现行生效的：名称（选择、导出都按它对齐）与上下文轮数（`$7` 取几楼）。
 */
export interface PresetMetaDraft {
  name: string;
  /**
   * 这里**故意没有** `enabled`。
   *
   * ACU 预设里的 `enabled` 是「全局剧情推进总开关」的镜像（`plot-preset-store.ts:36`），
   * 不是「这份预设开不开」。把它做成编辑器里的勾选框，等于给用户一个假开关：
   * 勾掉之后什么都不发生，因为运行时读的是 `plot.enabled`。
   * 所以这里不读、不写，保存时原样留在数据里。
   */
  /** `$7` 取多少条前文 —— 这一版唯一真在用的数。 */
  contextTurnCount: number;
}

/**
 * 提示词正文。
 *
 * 只有「最终注入指令」现行生效（生成时注入正文）。`mainPrompt` / `systemPrompt`
 * 是上游旧格式的兜底字段：**只有预设里一条任务都没有**时，才被拿去拼一条默认任务。
 * 这里不读不写，整份深拷时原样保留。
 */
export interface PresetPromptDraft {
  finalDirective: string;
}

/** 一条「从上下文里抠掉 / 留下」的区间规则。 */
export type PresetRuleDraft = BoundaryRule;

/**
 * 一份预设的可编辑投影。
 *
 * 只装**界面真会改**的东西。上游预设里另有 `extractTags` / `extractInjectTags`
 * （标签摘取、提取写入标签）等预设级字段 —— 那是旧格式兜底路径才读的，
 * 有任务表时不起作用，所以这里没有它们，保存时随整份深拷原样带走。
 */
export interface PresetDraft {
  meta: PresetMetaDraft;
  prompts: PresetPromptDraft;
  /**
   * 标签级差量开关：`标签名 → 模式`。
   *
   * 只存非 `off` 的项；没出现的标签 = 每轮全量。
   */
  tagDiffModes: Record<string, TagDiffMode>;
  extractRules: PresetRuleDraft[];
  excludeRules: PresetRuleDraft[];
}

/** 提示词块（面板上的一段）。 */
export interface TaskBlockDraft {
  role: string;
  content: string;
  /** 缺省视为开 —— 与 `eng/prompt-blocks.ts` 同一口径。 */
  enabled: boolean;
  /** 段名只用于面板上认人，落盘时为空就删键。 */
  name: string;
  /**
    * 这一段上这一期不编辑的键（`id`、`deletable`、上游将来加的扩展）。
   *
   * **必须跟着块走，不能按下标去原数组里捞。** 用户复制、上移、下移之后，
   * 第 N 个草稿块对应的早就不是原来第 N 段了 —— 按下标捞会把上一段的 id
   * 贴到下一段身上，存两三次之后 id 就开始重复，导出的 JSON 自己都对不上。
   */
  extra: Record<string, unknown>;
}

/** 任务草稿。未编辑键的值随草稿带在 `extra` 里，重排后不会串到别的任务身上。 */
export interface TaskDraft {
  /** 面板上的稳定键（原任务 id，或新任务的 `task-N`）。 */
  key: string;
  /** 在原 `plotTasks` 里的下标；`-1` = 这次新加的（写回不靠它，见 `extra`）。 */
  sourceIndex: number;
  id: string;
  name: string;
  enabled: boolean;
  stage: number;
  order: number;
  maxRetries: number;
  minLength: number;
  /** 每 N 条用户楼层跑一次；1 = 每条（上游行为）。 */
  everyRounds: number;
  /** 手动触发：开启后不按间隔自动跑，改由楼层按钮预约。默认 false = 按间隔自动跑。 */
  manual: boolean;
  extractTags: string;
  extractInjectTags: string;
  /** 豁免标签：不要求每轮回传，回传了仍照常抽取/落盘。 */
  exemptTags: string;
  finalDirectiveTemplate: string;
  description: string;
  /** 这个任务单独用哪条 API（名字）；空 = 跟面板上「当前 API」走。 */
  apiName: string;
  blocks: TaskBlockDraft[];
  /** 提示词组原来存在哪个键上；写回时还写回那儿，不另起一个键。 */
  blocksKey: 'promptGroup' | 'prompts';
  /** 原任务里这一期不编辑、写回时原样带走的键名。 */
  preservedKeys: string[];
  /** 原任务里这一期不编辑的键**连值一起**随身带（参照提示词块 `extra` 的写法）。 */
  extra: Record<string, unknown>;
}

/** 一条校验结果。`error` 拦保存，`warn` 只提示。 */
export interface PresetEditIssue {
  level: 'error' | 'warn';
  field: string;
  message: string;
}

/** JSON 导入的解析结果。 */
export type PresetJsonParseResult =
  | { ok: true; presets: Loose[]; skipped: number }
  | { ok: false; error: string };

// ───────────────────────── 常量 ─────────────────────────

/**
 * 最终注入指令那一段的 id。
 *
 * id 必须与上游一致（`finalSystemDirective`），因为读取只认顶层同名键
 * —— 换个 id 等于这段内容再也读不到。
 */
export const FINAL_DIRECTIVE_ID = 'finalSystemDirective';
export const FINAL_DIRECTIVE_NAME = '最终注入指令';

/**
 * `contextTurnCount` 缺省值取 **1**，不是上游骨架里的 3。
 *
 * 原因：上游运行时读的是 `plotSettings.contextTurnCount ?? 1`，缺字段时真正生效的是 1。
 * 面板要显示「实际会跑成什么样」，所以按运行时口径来。新建预设走 `newPresetData`，
 * 那里用骨架默认 3 —— 那是「刚建出来的一份预设长什么样」，两件事。
 */
export const DEFAULT_CONTEXT_TURN_COUNT_DRAFT = 1;

/** 任务没写 `maxRetries` 时引擎用的次数（`eng/engine.ts` 的 `DEFAULT_RETRIES`）。 */
const DEFAULT_TASK_MAX_RETRIES = 3;

/** 任务表里这一期会编辑的键。剩下的都进 `preservedKeys`。 */
const TASK_EDITABLE_KEYS = new Set([
  'id',
  'name',
  'enabled',
  'stage',
  'order',
  'maxRetries',
  'minLength',
  'schedule',
  'extractTags',
  'extractInjectTags',
  'exemptTags',
  'finalDirectiveTemplate',
  'description',
  'promptGroup',
  'prompts',
]);

// ───────────────────────── 基础整形 ─────────────────────────

function asRecord(value: unknown): Loose | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Loose) : null;
}

function hasOwn(source: Loose | null | undefined, key: string): boolean {
  return !!source && Object.prototype.hasOwnProperty.call(source, key);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** 深拷一份对象。`structuredClone` 在老 WebView 里不一定有，走 JSON 更稳。 */
function cloneRecord(value: unknown): Loose {
  const record = asRecord(value);
  if (!record) return {};
  return JSON.parse(JSON.stringify(record)) as Loose;
}

/**
 * ACU 旧预设里那几个「只为填占位符而存在、引擎现在一律不读」的顶层字段。
 *
 * 保存与导出时剥掉，让重新导出的预设不再带着它们；导入侧不校验字段，剥掉不影响兼容。
 */
const LEGACY_PLACEHOLDER_FIELDS = [
  'recallCount',
  'rateMain',
  'ratePersonal',
  'rateErotic',
  'rateCuckold',
] as const;

function stripLegacyPlaceholderFields(record: Loose): Loose {
  for (const key of LEGACY_PLACEHOLDER_FIELDS) delete record[key];
  return record;
}

/**
 * 「这个值等于没写」。
 *
 * `Number(null)` / `Number('')` 都等于 0 —— 如果直接交给 `Number`，一份
 * 值为 `null` 的预设会被读成 0 而不是「没写、用默认值」，这种静默偏差最难发现。
 */
function isBlankNumber(value: unknown): boolean {
  return value === null || value === undefined || value === '' || typeof value === 'boolean';
}

/** 非负整数：脏值退回 fallback，再夹到 `[min, max]`。 */
function clampInt(value: unknown, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (isBlankNumber(value)) return fallback;
  const num = Math.floor(Number(value));
  if (!Number.isFinite(num)) return fallback;
  return Math.min(Math.max(min, num), max);
}

/**
 * 标签串：引擎只按 `,` 切（`eng/tags.ts` 的 `splitTagNames`），
 * 所以写回去也必须用 `,` 连接 —— 用 `、` 或空格连，用户下次打开就看到一串怪标签。
 */
function joinTags(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    return value
      .map(item => (typeof item === 'string' ? item.trim() : ''))
      .filter(item => item !== '')
      .join(',');
  }
  return '';
}

function splitRuleList(rules: BoundaryRule[]): PresetRuleDraft[] {
  return rules.map(rule => ({ start: String(rule?.start ?? ''), end: String(rule?.end ?? '') }));
}

// ───────────────────────── 预设本体：读 ─────────────────────────

/**
 * 一份预设 → 面板要的那几个字段。读不到的一律给「引擎会用的默认值」。
 *
 * 只读**界面真会改**的那几项；其余字段（世界书选择、任务表、旧格式兜底字段……）
 * 一概不进草稿，保存时随整份深拷带走。摆到界面上就是骗人（用户改了也不生效）。
 */
export function readPresetDraft(data: unknown): PresetDraft {
  const record = asRecord(data) || {};
  return {
    meta: {
      name: text(record.name).trim(),
      contextTurnCount: clampInt(record.contextTurnCount, DEFAULT_CONTEXT_TURN_COUNT_DRAFT, 0),
    },
    prompts: {
      // 回退链与 `eng/preset-import.ts` 的 `readDirectiveTemplate` 一致，
      // 否则面板显示的值与引擎实际用的值会分叉（用户改了却没效果，最难查）。
      finalDirective: readFinalDirective(record),
    },
    tagDiffModes: normalizeTagDiffModes(record.tagDiffModes),
    extractRules: splitRuleList(normalizeRules(record.contextExtractRules, text(record.contextExtractTags))),
    excludeRules: splitRuleList(normalizeRules(record.contextExcludeRules, text(record.contextExcludeTags))),
  };
}

/** 单段提示词：`prompts` 数组按 id 找，老式对象按 key 找。 */
function readPromptContent(record: Loose, id: string): string {
  const prompts = record.prompts;
  if (Array.isArray(prompts)) {
    const hit = prompts.find(item => asRecord(item)?.id === id);
    return text(asRecord(hit)?.content);
  }
  const legacy = asRecord(prompts);
  if (legacy) return text(legacy[id]);
  return '';
}

/** 最终注入指令：`finalSystemDirective → finalDirective → prompts` 三级回退。 */
function readFinalDirective(record: Loose): string {
  const top = text(record.finalSystemDirective) || text(record.finalDirective);
  return top || readPromptContent(record, 'finalSystemDirective');
}

// ───────────────────────── 预设本体：写 ─────────────────────────

/**
 * 草稿 → 新的预设对象。**深拷原对象后定点覆盖**，不认识的键原样保留。
 *
 * 为什么不做字段级 merge（只写改过的键）：那需要「读的时候记住原值」，
 * 而读是有损的（规则会归一化、标签会重排）。一旦读和写两套口径对不上，
 * 用户没动过的字段也会被悄悄改掉。整份写回虽然多写几个键，但行为是可预测的。
 * 唯一的例外是 `stripLegacyPlaceholderFields`：那几个字段引擎已不读，留着只会让导出的
 * 预设继续带着旧垃圾，所以保存时剥掉。
 */
export function applyPresetDraft(data: unknown, draft: PresetDraft): Loose {
  const base = stripLegacyPlaceholderFields(cloneRecord(data));
  const meta = draft.meta || ({} as PresetMetaDraft);

  base.name = text(meta.name).trim();
  // 不碰 `enabled`：那是全局总开关的镜像，编辑预设不该改它（改了就变成「悄悄替你开关剧情推进」）。
  base.contextTurnCount = clampInt(meta.contextTurnCount, DEFAULT_CONTEXT_TURN_COUNT_DRAFT, 0);

  // 标签差量：只写非 off 的项；用户没配就删键，别给导出的 JSON 添一堆空对象。
  if (draft.tagDiffModes !== undefined) {
    const modes = normalizeTagDiffModes(draft.tagDiffModes);
    if (Object.keys(modes).length > 0) base.tagDiffModes = modes;
    else delete base.tagDiffModes;
  }

  base.contextExtractRules = writeRules(draft.extractRules);
  base.contextExcludeRules = writeRules(draft.excludeRules);
  // 老式标签串：面板已经把它们的值并进规则里了，写回时清空，免得 ACU 那边看到两份对不上的口径。
  // 只在原本就有这个键时才写 —— 凭空加一个空串键等于给导出文件添垃圾。
  if (hasOwn(base, 'contextExtractTags')) base.contextExtractTags = '';
  if (hasOwn(base, 'contextExcludeTags')) base.contextExcludeTags = '';

  base.prompts = writePrompts(base.prompts, draft.prompts || ({} as PresetPromptDraft));

  // 顶层那两个老字段：**存在才同步**。
  // `readFinalDirective` 的优先级是「顶层优先于 prompts」，不同步的话用户改完保存、
  // 下次跑还是用旧的顶层值 —— 界面显示改了、实际没改，这是最难查的一类错。
  const directive = text(draft.prompts?.finalDirective);
  if (hasOwn(base, 'finalSystemDirective')) base.finalSystemDirective = directive;
  if (hasOwn(base, 'finalDirective')) base.finalDirective = directive;

  return base;
}

function writeRules(rules: PresetRuleDraft[] | null | undefined): PresetRuleDraft[] {
  const list = Array.isArray(rules) ? rules : [];
  return list
    .map(rule => ({ start: text(rule?.start).trim(), end: text(rule?.end).trim() }))
    .filter(rule => rule.start !== '' || rule.end !== '');
}

/**
 * 最终注入指令写回。
 *
 * **只动这一段。** 上游预设里另外两段（`mainPrompt` / `systemPrompt`）是旧格式兜底字段，
 * 界面不给改，这里也就不该重写它们 —— 重写会顺手把 role / name / deletable 一起改掉，
 * 用户没碰过的东西凭空变了。
 *
 * 形态保持原样：原来是数组就还在数组里（找不到这一段才 append），
 * 原来是老式对象就写回对象，两者都没有才建一个单段数组。
 */
function writePrompts(existing: unknown, draft: PresetPromptDraft): PlotPromptSegment[] | Loose {
  const content = text(draft.finalDirective);

  if (Array.isArray(existing)) {
    const list = existing.map(item => ({ ...(asRecord(item) || {}) })) as Loose[];
    const hit = list.find(segment => text(segment.id) === FINAL_DIRECTIVE_ID);
    if (hit) {
      hit.content = content;
      return list as unknown as PlotPromptSegment[];
    }
    list.push(newDirectiveSegment(content));
    return list as unknown as PlotPromptSegment[];
  }

  const legacy = asRecord(existing);
  if (legacy && Object.keys(legacy).length > 0) {
    const next: Loose = { ...legacy };
    next[FINAL_DIRECTIVE_ID] = content;
    return next;
  }

  return [newDirectiveSegment(content)] as unknown as PlotPromptSegment[];
}

function newDirectiveSegment(content: string): Loose {
  return {
    id: FINAL_DIRECTIVE_ID,
    name: FINAL_DIRECTIVE_NAME,
    role: 'SYSTEM',
    content,
    deletable: false,
  };
}

// ───────────────────────── 任务表：读 ─────────────────────────

/** 预设里的任务表 → 任务草稿列表。没有任务表就是空数组（不编造兜底任务）。 */
export function readTaskDrafts(data: unknown): TaskDraft[] {
  const record = asRecord(data);
  const list = Array.isArray(record?.plotTasks) ? (record!.plotTasks as unknown[]) : [];
  return list
    .map((item) => asRecord(item))
    .filter((item): item is Loose => item !== null)
    .map((item, index) => readTaskDraft(item, index));
}

function readTaskDraft(task: Loose, index: number): TaskDraft {
  const id = text(task.id).trim() || `task-${index + 1}`;
  const group = readTaskBlocks(task);
  const preserved: string[] = [];
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(task)) {
    if (!TASK_EDITABLE_KEYS.has(key)) {
      preserved.push(key);
      extra[key] = value;
    }
  }
  // `schedule` 只有 `everyRounds` 这一期可编辑，整个对象仍要原样随身带：
  // 写回时 `writeSchedule` 在它上面合并，否则 `lastRound` 之类的键会被抹掉。
  if (asRecord(task.schedule)) extra.schedule = task.schedule;
  return {
    key: id,
    sourceIndex: index,
    id,
    name: text(task.name).trim(),
    enabled: task.enabled !== false,
    stage: clampInt(task.stage, 1, 1),
    order: clampInt(task.order, index, 0),
    maxRetries: clampInt(task.maxRetries, DEFAULT_TASK_MAX_RETRIES, 1),
    minLength: clampInt(task.minLength, 0, 0),
    everyRounds: normalizeEveryRounds(asRecord(task.schedule)?.everyRounds),
    manual: asRecord(task.schedule)?.manual === true,
    extractTags: joinTags(task.extractTags),
    extractInjectTags: joinTags(task.extractInjectTags),
    exemptTags: joinTags(task.exemptTags),
    finalDirectiveTemplate: text(task.finalDirectiveTemplate),
    description: text(task.description),
    apiName: text(task.apiName).trim(),
    blocks: group.blocks,
    blocksKey: group.key,
    preservedKeys: preserved,
    extra,
  };
}

/**
 * 任务的提示词组：`promptGroup` 优先，其次「看起来像段列表的 `prompts`」，都没有就给一块空段。
 *
 * 判据与 `eng/task-model.ts` 的 `resolvePromptGroup` 一致 —— 两边不一致的话，
 * 面板显示三块、引擎实际发四块，用户会以为编辑器坏了。
 */
function readTaskBlocks(task: Loose): { blocks: TaskBlockDraft[]; key: 'promptGroup' | 'prompts' } {
  const group = Array.isArray(task.promptGroup) && task.promptGroup.length > 0 ? task.promptGroup : null;
  if (group) return { blocks: group.map(toBlockDraft), key: 'promptGroup' };

  const prompts = Array.isArray(task.prompts) ? task.prompts : null;
  if (prompts && prompts.length > 0 && looksLikeSegmentList(prompts)) {
    return { blocks: prompts.map(toBlockDraft), key: 'prompts' };
  }

  return { blocks: emptyBlocks(), key: 'promptGroup' };
}

function looksLikeSegmentList(list: unknown[]): boolean {
  const first = asRecord(list[0]);
  return !!first && hasOwn(first, 'role') && hasOwn(first, 'content') && !hasOwn(first, 'id');
}

/** 段上这一期编辑的键；剩下的进 `extra` 原样带走。 */
const BLOCK_EDITABLE_KEYS = new Set(['role', 'content', 'enabled', 'name']);

function toBlockDraft(segment: unknown): TaskBlockDraft {
  const record = asRecord(segment) || {};
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!BLOCK_EDITABLE_KEYS.has(key)) extra[key] = value;
  }
  return {
    role: text(record.role).trim() || 'USER',
    content: text(record.content),
    enabled: record.enabled !== false,
    name: text(record.name).trim(),
    extra,
  };
}

// ───────────────────────── 任务表：写 ─────────────────────────

/**
 * 草稿 → 新的任务表。
 *
 * 三条：
 * - **未编辑的键从草稿自己的 `extra` 带回**（深拷后覆盖编辑键），`mergeStrategy` / `triggerWhen` /
 *   `agentControl` 这些逐字节不变；不回 `original` 按 `sourceIndex` 捞，那样上移/下移/删除后会贴错任务；
 * - 新任务的 `extra` 是空的，另建一个干净对象；
 * - 块上的 A/B 槽标记不再由界面管理，随 `extra` 原样回到段上（见 `BLOCK_EDITABLE_KEYS`）。
 */
export function applyTaskDrafts(data: unknown, drafts: TaskDraft[]): Loose {
  const base = cloneRecord(data);

  base.plotTasks = (Array.isArray(drafts) ? drafts : []).map((draft, index) => {
    const task: Loose = cloneRecord(draft.extra);

    task.id = text(draft.id).trim() || draft.key;
    task.name = text(draft.name).trim();
    task.enabled = draft.enabled === true;
    task.stage = clampInt(draft.stage, 1, 1);
    // 「顺序」不再由用户配：数组位置就是顺序。同阶段是并发的，它只影响展示与标签合并的先后。
    task.order = index;
    task.maxRetries = clampInt(draft.maxRetries, DEFAULT_TASK_MAX_RETRIES, 1);
    task.minLength = clampInt(draft.minLength, 0, 0);
    task.extractTags = joinTags(draft.extractTags);
    task.extractInjectTags = joinTags(draft.extractInjectTags);
    // 空值不落键：没有豁免标签的旧任务写回后仍保持原来的键形状。
    const exemptTags = joinTags(draft.exemptTags);
    if (exemptTags !== '') task.exemptTags = exemptTags;
    else delete task.exemptTags;
    task.finalDirectiveTemplate = text(draft.finalDirectiveTemplate);
    task.description = text(draft.description);

    writeSchedule(task, draft);
    writeTaskApi(task, draft.apiName);
    writeTaskBlocks(task, draft);
    return task;
  });

  return base;
}

/**
 * 任务级 API。
 *
 * 存在 `task.apiName` 上（`eng/task-model.ts` 的 `normalizeTask` 认这个键）。
 * 空串时**删掉这个键**而不是写空串：缺省就是「跟当前 API 走」，
 * 写死空串会让人分不清「显式选了跟随」与「从上游抄来、本来就没这个键」。
 */
function writeTaskApi(task: Loose, apiName: unknown): void {
  const name = text(apiName).trim();
  if (name === '') delete task.apiName;
  else task.apiName = name;
}

/**
 * 触发周期 + 手动触发标记。
 *
 * 两个键都落在 `task.schedule` 上：`everyRounds` 归 `eng/schedule.ts` 认，
 * `manual` 归手动触发那边认。三条形状纪律由逐字节比对测试锁着，别顺手加键：
 *
 * - `everyRounds === 1` 时**删掉这个键**而不是写 1：缺省就是每轮，
 *   写死 1 会让「用户显式设成每轮」与「上游数据从来没有这个键」无法区分；
 * - `manual` **只写 `true`，不写 `false`**：关闭 = 删键，绝不把默认值塞进导出文件；
 * - `schedule` 里其它键（`lastRound` 之类）一律不动，合并完整个对象变空才删 `schedule`。
 *
 * 早退那句要带 `!manual`：新建任务原本没有 `schedule`，打开手动触发时
 * 「每轮 + 没有 schedule」已经不是缺省状态，得为 `manual: true` 把这个对象建出来。
 */
function writeSchedule(task: Loose, draft: TaskDraft): void {
  const every = normalizeEveryRounds(draft.everyRounds);
  const manual = draft.manual === true;
  const existing = asRecord(task.schedule);
  if (every === 1 && !manual && !existing) return;
  const schedule: Loose = { ...(existing || {}) };
  if (every === 1) delete schedule.everyRounds;
  else schedule.everyRounds = every;
  if (manual) schedule.manual = true;
  else delete schedule.manual;
  if (Object.keys(schedule).length === 0) delete task.schedule;
  else task.schedule = schedule;
}

/** 提示词块写回。段上不编辑的键从 `extra` 原样带回来。 */
function writeTaskBlocks(task: Loose, draft: TaskDraft): void {
  const key = draft.blocksKey === 'prompts' ? 'prompts' : 'promptGroup';
  const blocks = Array.isArray(draft.blocks) ? draft.blocks : [];

  const segments = blocks.map((block) => {
    // 段上不编辑的键从**块自己**身上带回来（不是按原数组下标捞，理由见 `TaskBlockDraft.extra`）
    const segment: Loose = { ...(asRecord(block.extra) || {}) };

    segment.role = text(block.role).trim() || 'USER';
    segment.content = text(block.content);
    if (text(block.name).trim() !== '') segment.name = text(block.name).trim();
    else delete segment.name;

    // 开关：关 = 写 `enabled: false`；开 = 删键（缺省即开）。判定与渲染层共用。
    if (!isBlockEnabled(block)) segment.enabled = false;
    else delete segment.enabled;

    return segment;
  });

  task[key] = segments;
  // 写回 `prompts` 时把旧的 `promptGroup` 摘掉：引擎优先读 promptGroup，
  // 留着它等于让编辑结果被一份旧数据盖住。
  if (key === 'prompts' && hasOwn(task, 'promptGroup')) delete task.promptGroup;
}

// ───────────────────────── 新建 ─────────────────────────

/**
 * 新任务的提示词块：**一块空普通段**。
 *
 * 不再照抄上游的 A/B 两槽骨架 —— 主槽这一版不做，造两个用户看不见也改不了的槽，
 * 只会让导出的 JSON 里多出两个空段。
 */
function emptyBlocks(): TaskBlockDraft[] {
  return [newBlockDraft()];
}

/** 一块新的空提示词（普通段，默认开着）。 */
export function newBlockDraft(): TaskBlockDraft {
  return { role: 'USER', content: '', enabled: true, name: '', extra: {} };
}

/**
 * 复制一块：换 id，其余键（含 `extra`）原样深拷。
 *
 * 两段同一个 id 时，上游按 id 找段的地方会一直命中第一段，所以必须换。
 */
export function copyBlockDraft(block: TaskBlockDraft): TaskBlockDraft {
  const extra: Record<string, unknown> = { ...(asRecord(block.extra) || {}) };
  if (typeof extra.id === 'string' && extra.id.trim() !== '') extra.id = `${extra.id.trim()}-copy`;
  return {
    role: text(block.role).trim() || 'USER',
    content: text(block.content),
    enabled: block.enabled !== false,
    name: text(block.name),
    extra,
  };
}

/**
 * 一条新任务。id / 名字都按现有任务表避重 —— 两条任务同名同 id 会让
 * 楼层锚点认错人，引擎里的续跑与结果记账也会串在一起。
 */
export function newTaskDraft(existing: TaskDraft[]): TaskDraft {
  const list = Array.isArray(existing) ? existing : [];
  const usedIds = new Set(list.map(task => task.id));
  const usedNames = new Set(list.map(task => task.name.trim()));

  let ordinal = list.length + 1;
  let id = `task-${ordinal}`;
  while (usedIds.has(id)) {
    ordinal += 1;
    id = `task-${ordinal}`;
  }
  let name = `任务 ${ordinal}`;
  let nameOrdinal = ordinal;
  while (usedNames.has(name)) {
    nameOrdinal += 1;
    name = `任务 ${nameOrdinal}`;
  }

  return {
    key: id,
    sourceIndex: -1,
    id,
    name,
    enabled: true,
    stage: 1,
    order: list.length,
    maxRetries: DEFAULT_TASK_MAX_RETRIES,
    minLength: 0,
    everyRounds: 1,
    manual: false,
    extractTags: '',
    extractInjectTags: '',
    exemptTags: '',
    finalDirectiveTemplate: '',
    description: '',
    apiName: '',
    blocks: emptyBlocks(),
    blocksKey: 'promptGroup',
    preservedKeys: [],
    extra: {},
  };
}

/**
 * 从剪贴板粘一块进来。
 *
 * 与 `copyBlockDraft` 的差别只有一条：**id 要在这个任务的现有块里也唯一**。
 * 复制一块是在同一任务里派生，`-copy` 基本够用；粘贴进来的块可能来自别的预设，
 * 那个 id 在本任务里完全可能已经存在（用户在两份预设里各复制过一次同一块）。
 */
export function adoptBlockDraft(block: TaskBlockDraft, existing: TaskBlockDraft[]): TaskBlockDraft {
  const base = copyBlockDraft(block);
  const extra: Record<string, unknown> = { ...(asRecord(base.extra) || {}) };
  const id = typeof extra.id === 'string' ? extra.id.trim() : '';
  if (id === '') return base;

  const used = new Set(
    (Array.isArray(existing) ? existing : []).map(item => {
      const itemExtra = asRecord(item.extra);
      return typeof itemExtra?.id === 'string' ? itemExtra.id.trim() : '';
    }),
  );
  let next = id;
  let n = 2;
  while (used.has(next)) {
    next = `${id}-${n}`;
    n += 1;
  }
  extra.id = next;
  return { ...base, extra };
}

/**
 * 给一条任务起一个不撞名的名字。
 *
 * 规则抄工作流助手的 `uniqueTaskName`（`tasks/task-clone.ts:8-19`）：
 * 原名能用就用原名，撞了才叫「原名 副本」，再撞就叫「原名 副本 2、3……」——
 * 用户一眼能看出这是复制出来的，而不是一串随机后缀。
 */
export function uniqueTaskName(base: string, existingNames: string[]): string {
  const trimmed = text(base).trim() || '未命名任务';
  const used = new Set((Array.isArray(existingNames) ? existingNames : []).map(name => text(name).trim()));
  if (!used.has(trimmed)) return trimmed;

  const copyBase = `${trimmed} 副本`;
  if (!used.has(copyBase)) return copyBase;

  let n = 2;
  while (used.has(`${copyBase} ${n}`)) n += 1;
  return `${copyBase} ${n}`;
}

/**
 * 把一个任务复制进当前预设（「复制 → 切预设 → 粘贴」用；同预设粘贴也走这里）。
 *
 * 三件事必须做，缺一个就出事：
 * - **换 `key` / `id`**：id 是任务的身份键，沿用旧 id 会让两条任务在引擎里分不开，
 *   续跑与结果记账直接串台。
 * - **名字避重**：卡片行上两条同名任务分不出谁是谁。
 * - **`sourceIndex` 归 -1**：它记的是「在原 `plotTasks` 里的下标」，外来任务在本预设里没有那个下标。
 *
 * 提示词块**一律当成普通段**（见 `cloneBlockAsPlain`）：面板里没有「主槽」这个概念，复制出来的块
 * 不该带着旧槽位标记进去。
 */
export function cloneTaskDraft(source: TaskDraft, existing: TaskDraft[]): TaskDraft {
  const list = Array.isArray(existing) ? existing : [];
  const usedIds = new Set(list.map(task => task.id));

  let ordinal = list.length + 1;
  let id = `task-${ordinal}`;
  while (usedIds.has(id)) {
    ordinal += 1;
    id = `task-${ordinal}`;
  }

  const sourceBlocks = Array.isArray(source.blocks) ? source.blocks : [];
  const blocks = sourceBlocks.map((block, index) => cloneBlockAsPlain(block, id, index));

  return {
    key: id,
    sourceIndex: -1,
    id,
    name: uniqueTaskName(source.name, list.map(task => task.name)),
    enabled: source.enabled !== false,
    stage: clampInt(source.stage, 1, 1),
    order: list.length,
    maxRetries: clampInt(source.maxRetries, DEFAULT_TASK_MAX_RETRIES, 0),
    minLength: clampInt(source.minLength, 0, 0),
    everyRounds: normalizeEveryRounds(source.everyRounds),
    manual: source.manual === true,
    extractTags: text(source.extractTags),
    extractInjectTags: text(source.extractInjectTags),
    exemptTags: text(source.exemptTags),
    finalDirectiveTemplate: text(source.finalDirectiveTemplate),
    description: text(source.description),
    apiName: text(source.apiName),
    blocks: blocks.length > 0 ? blocks : emptyBlocks(),
    blocksKey: source.blocksKey === 'prompts' ? 'prompts' : 'promptGroup',
    preservedKeys: [],
    extra: {},
  };
}

/**
 * 复制一块，但**留下主槽标记**（只有整条任务克隆时才用它）。
 *
 * 块 id 重编成「新任务 id + 序号」：同一任务里两段同 id 时，上游按 id 找段永远命中第一段；
 * 用序号重编既保证唯一，也不依赖原 id 长什么样（可能没有，可能是上游生成的 uuid）。
 */
/** 复制一个块进别的任务：重新编号 id，其余键原样深拷。 */
function cloneBlockAsPlain(block: TaskBlockDraft, taskId: string, index: number): TaskBlockDraft {
  const extra: Record<string, unknown> = { ...(asRecord(block.extra) || {}) };
  if (typeof extra.id === 'string' && extra.id.trim() !== '') extra.id = `${taskId}-b${index + 1}`;
  return {
    role: text(block.role).trim() || 'USER',
    content: text(block.content),
    enabled: block.enabled !== false,
    name: text(block.name),
    extra,
  };
}

/**
 * 一份空预设骨架。
 *
 * 只写**现行生效**的那几项：名称、上下文轮数、两个空规则数组、空任务表、
 * 一段空的最终注入指令。旧格式兜底字段一个都不凭空加 —— 多写了反而给导出文件添垃圾。
 *
 * 提示词正文留空，**不抄 ACU 的默认提示词**：那是它的产品文案，抄过来就成了我们替用户写剧本，
 * 而且它一改我们就过时。用户自己填，或者从 ACU 导入。
 */
export function newPresetData(name: string): Loose {
  const base = cloneRecord({});
  base.name = text(name).trim();
  // 不写 `enabled`：那是全局总开关的镜像，新建一份预设不该替用户声明「剧情推进开着」。
  base.prompts = writePrompts(null, { finalDirective: '' });
  base.contextTurnCount = 3;
  base.contextExtractRules = [];
  base.contextExcludeRules = [];
  base.plotTasks = [];
  return base;
}

// ───────────────────────── 校验 ─────────────────────────

/**
 * 保存前的检查。只报「用户现在就该知道」的事，不拦不该拦的。
 *
 * 为什么要有：验收里那条「新建空预设能保存；跑一轮缺什么就说缺什么」——
 * 空预设**允许**保存（用户可以先存着慢慢填），但必须当场告诉他跑起来会缺什么。
 */
export function validatePresetDraft(draft: PresetDraft, taskCount: number): PresetEditIssue[] {
  const issues: PresetEditIssue[] = [];
  const meta = draft?.meta || ({} as PresetMetaDraft);
  const prompts = draft?.prompts || ({} as PresetPromptDraft);

  if (text(meta.name).trim() === '') {
    issues.push({ level: 'error', field: 'name', message: '预设名不能为空' });
  }
  if (text(prompts.finalDirective).trim() === '') {
    issues.push({
      level: 'warn',
      field: 'finalDirective',
      message: '最终注入指令是空的 —— 跑完这一轮不会往正文里放任何东西',
    });
  }
  if (taskCount <= 0) {
    issues.push({
      level: 'warn',
      field: 'tasks',
      message: '一个任务都没有 —— 跑一轮不会请求 AI，正文里只会多一段空指令',
    });
  }
  return issues;
}

/** 名字是否与本地库里别的预设撞了（撞了就必须改名：账本和选择都按名字对齐）。 */
export function findNameConflict(draftName: string, otherNames: string[]): string | null {
  const wanted = text(draftName).trim();
  if (wanted === '') return null;
  const hit = (Array.isArray(otherNames) ? otherNames : []).find(name => text(name).trim() === wanted);
  return hit === undefined ? null : hit;
}

// ───────────────────────── JSON 导入 / 导出 ─────────────────────────

/**
 * 解析一段预设 JSON。
 *
 * 能吃三种形态：
 * - **数组**（ACU 导出的就是 `[预设]`）—— 逐个收，没名字的跳过并计数；
 * - **单个对象**（手工粘一份出来）；
 * - **`{ presets: [...] }`** 或本地库那种包装对象（`isStoredPresetWrapper`）—— 剥一层再收。
 *
 * 只做形状判断，不校验字段内容：预设字段随上游版本变，卡太死会让用户明明格式对却导不进来。
 */
export function parsePresetJson(raw: string): PresetJsonParseResult {
  const source = text(raw).trim();
  if (source === '') return { ok: false, error: '粘贴框是空的' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `不是合法的 JSON：${detail}` };
  }

  const candidates = collectCandidates(parsed);
  if (candidates === null) {
    return { ok: false, error: '没认出这份 JSON 的形状（要数组、单个预设对象，或 {presets:[...]}）' };
  }

  const presets: Loose[] = [];
  let skipped = 0;
  for (const item of candidates) {
    const record = asRecord(item);
    if (!record || text(record.name).trim() === '') {
      skipped += 1;
      continue;
    }
    presets.push(record);
  }

  if (presets.length === 0) {
    return { ok: false, error: skipped > 0 ? '里面每一条都没有名字（预设必须有 name）' : '里面没有预设' };
  }
  return { ok: true, presets, skipped };
}

/** 把各种外壳拆成「候选预设数组」；认不出来给 `null`。 */
function collectCandidates(parsed: unknown): unknown[] | null {
  if (Array.isArray(parsed)) return parsed;

  const record = asRecord(parsed);
  if (!record) return null;

  // 本地库的包装：{name,data,source,importedAt} —— 先剥成 data 本体
  if (isStoredPresetWrapper(record)) {
    const unwrapped = unwrapPresetPayload(record);
    return unwrapped ? [unwrapped] : null;
  }
  if (Array.isArray(record.presets)) return record.presets;
  return [record];
}

/**
 * 预设级「老格式正文」的残留字段。
 *
 * 引擎只认任务里的提示词组（`plotTasks[].promptGroup`，见 `eng/preset-import.ts`
 * 的 `normalizeTasks` 与 `eng/task-model.ts` 的 `resolvePromptGroup`）；预设顶层这
 * 四个键是 ACU 老格式的兜底/镜像，有任务表时一条都不读。面板的「读成草稿 /
 * 写回预设」也完全不碰它们 —— 于是老预设一旦被导进来，这几份旧正文就一直跟着
 * 「整份深拷」的导出走：用户在任务里把提示词改了、导出的文件里却还是老那份。
 *
 * 只在**导出**时剥，本地库里存的预设本体一个字不动。
 */
const LEGACY_PRESET_PROMPT_FIELDS = [
  'promptGroup',
  'promptPresets',
  'extractTags',
  'extractInjectTags',
] as const;

function stripLegacyPresetPromptFields(record: Loose): Loose {
  for (const key of LEGACY_PRESET_PROMPT_FIELDS) delete record[key];
  return record;
}

/** 随预设文件一起带走的「世界书写入」设置。 */
export interface PresetWorldbookWrite {
  rules: {
    tagName: string;
    entryName: string;
    depth: number;
    order: number;
    enabled: boolean;
  }[];
  source: 'character' | 'manual';
  books: string[];
}

/** 上面这份设置在预设文件里的键名。 */
export const WORLD_BOOK_WRITE_KEY = 'worldbookWrite';

/**
 * 逐条收口世界书写入规则，口径与 `settings.ts` 的 `readWorldbookWriteRules` 一致：
 * 坏一条只丢一条，不整份清空；位置两个数只认正数，脏值退回默认（深度 2 / 顺序 10000）。
 */
function normalizeWorldbookWriteRules(raw: unknown): PresetWorldbookWrite['rules'] {
  if (!Array.isArray(raw)) return [];
  const out: PresetWorldbookWrite['rules'] = [];
  for (const item of raw) {
    const rule = asRecord(item);
    if (!rule) continue;
    const tagName = text(rule.tagName).trim();
    if (tagName === '') continue;
    out.push({
      tagName,
      entryName: typeof rule.entryName === 'string' ? rule.entryName : '',
      depth:
        typeof rule.depth === 'number' && Number.isFinite(rule.depth) && rule.depth >= 1
          ? Math.floor(rule.depth)
          : 2,
      order:
        typeof rule.order === 'number' && Number.isFinite(rule.order) && rule.order >= 0
          ? Math.floor(rule.order)
          : 10000,
      enabled: rule.enabled === true,
    });
  }
  return out;
}

/** 把任意来源的「世界书写入」设置收口成能写进文件的干净形状。 */
function normalizeWorldbookWrite(raw: unknown): PresetWorldbookWrite {
  const record = asRecord(raw) ?? {};
  const books: string[] = [];
  if (Array.isArray(record.books)) {
    for (const book of record.books) {
      if (typeof book === 'string' && book.trim() !== '') books.push(book);
    }
  }
  return {
    rules: normalizeWorldbookWriteRules(record.rules),
    source: record.source === 'manual' ? 'manual' : 'character',
    books,
  };
}

/**
 * 从脚本设置（`settings.plot`）里取出「世界书写入」设置，收口成能写进文件的形状。
 *
 * 这三个字段是全局设置、不在预设本体上，所以导出时得由面板显式带过来；
 * 传进来的不是对象（比如单测只给了预设本体）时返回 `null` = 文件里不带这个键。
 */
export function packWorldbookWrite(plot: unknown): PresetWorldbookWrite | null {
  const record = asRecord(plot);
  if (!record) return null;
  return normalizeWorldbookWrite({
    rules: record.worldbookWriteRules,
    source: record.worldbookWriteSource,
    books: record.worldbookWriteBooks,
  });
}

/**
 * 从一份导入进来的预设里读出随文件带过来的「世界书写入」设置。
 *
 * 文件里没这个键（老文件、或者别处导出的预设）返回 `null`，调用方据此**不动**
 * 设备上现有的设置；只有确实带了这份设置才以文件为准恢复。
 */
export function readWorldbookWriteFromPreset(preset: unknown): PresetWorldbookWrite | null {
  const record = asRecord(preset);
  if (!record) return null;
  const carried = asRecord(record[WORLD_BOOK_WRITE_KEY]);
  if (!carried) return null;
  return normalizeWorldbookWrite(carried);
}

/**
 * 导出成 ACU 能直接吃的格式：`JSON.stringify([预设], null, 2)`。
 *
 * 为什么是数组：上游导入 `importPresetFromJson` 走 `normalizeImportedPresetPayloads`，
 * 它要求顶层是数组。我们导成单个对象的话，用户拿去 ACU 导入会得到「解析失败」，
 * 而文件明明长得很正常 —— 这种不兼容最难解释。
 *
 * 导出前做两件事：
 * 1. 剥掉 `LEGACY_PLACEHOLDER_FIELDS` 与 `LEGACY_PRESET_PROMPT_FIELDS`：前者引擎
 *    已不读，后者是老格式正文的残留。留着它们，「重新导出一份干净预设」就做不到。
 *    ACU 导入不校验字段，剥掉不影响兼容。
 * 2. 把 `worldbookWrite` 附上（给了第二参数时）：那三项是脚本全局设置，
 *    不写进文件就带不到另一台设备。第二参数可选，老调用点不受影响。
 */
export function toPresetExportJson(
  data: unknown,
  worldbookWrite?: PresetWorldbookWrite | null,
): string {
  const record = stripLegacyPresetPromptFields(stripLegacyPlaceholderFields(cloneRecord(data)));
  if (worldbookWrite !== undefined && worldbookWrite !== null) {
    record[WORLD_BOOK_WRITE_KEY] = normalizeWorldbookWrite(worldbookWrite);
  }
  return JSON.stringify([record], null, 2);
}

/** 导出文件名：去掉路径分隔符与引号，空名字给个兜底。 */
export function presetFileName(name: string): string {
  const cleaned = text(name)
    .trim()
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ');
  return `${cleaned === '' ? '剧情推进预设' : cleaned}.json`;
}
