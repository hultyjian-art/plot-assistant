/**
 * plot/eng/task-model.ts — 剧情任务的规范化（纯函数）
 *
 * 职责：把「用户在预设里写的、形状可能千奇百怪的任务对象」压成引擎内部唯一认得的形状。
 *
 * 三条设计约束：
 * 1. **不认识 ACU**。这里没有全局状态、没有世界书、没有表格，只做数据整形。
 * 2. **不认识默认提示词**。预设没带提示词组时该用什么默认内容，是产品决策，
 *    由调用方通过 `resolvePromptGroup` 的 `buildDefault` 注入（依赖注入，不写死在这里）。
 * 3. **字段顺序即契约**。返回对象的键顺序与 ACU 保持一致，因为落盘后要按 JSON 逐字节比对。
 */

import type { TaskSchedule } from './schedule';

/** 任务级 agent 控制（决定任务能不能被 AI 自己调度、以及阶段顺序约束）。 */
export interface PlotTaskAgentControl {
  enabled: boolean;
  selectable: boolean;
  defaultSelected: boolean;
  allowSequential: boolean;
  allowParallel: boolean;
  dependsOnTaskIds: string[];
  blocksTaskIds: string[];
  preferredStage?: number;
  preferredOrder?: number;
}

/** 提示词组里的一段。`mainSlot` 标出「主提示词 A」与「拦截指令 B」这两个特殊位。 */
export interface PlotPromptSegment {
  role?: string;
  content?: string;
  deletable?: boolean;
  mainSlot?: string;
  isMain?: boolean;
  isMain2?: boolean;
  id?: string;
  [key: string]: unknown;
}

/** 规范化后的任务。字段顺序必须与 ACU 一致。 */
export interface PlotTask {
  id: string;
  name: string;
  enabled: boolean;
  promptGroup: PlotPromptSegment[];
  extractTags: string;
  extractInjectTags: string;
  finalDirectiveTemplate: string;
  minLength: number;
  maxRetries: number;
  mergeStrategy: string;
  stage: number;
  order: number;
  description: string;
  triggerWhen: string;
  agentControl: PlotTaskAgentControl;
  /**
   * 触发周期（第 3 期新增，上游**没有**这个字段）。
   *
   * 只在这一期自己写过的预设里出现；上游数据里没有它，所以 `normalizeTask` 也
   * **只在源数据真的写了才带上这个键** —— 多带一个 `schedule: {}` 会让「与上游逐字节一致」
   * 的那批用例全线变红，而那些用例是刻意锁死形状的。
   */
  schedule?: TaskSchedule;
  /**
   * 这个任务单独用哪条 API（名字，对应设置里 `apis` 的 name）。
   *
   * 空/缺省 = 用面板上「当前 API」那一条。上游**没有**这个字段，
   * 所以和 `schedule` 一样只在源数据真的写了才带上这个键。
   */
  apiName?: string;
}

type Loose = Record<string, any>;

// ───────────────────────── 基础整形 ─────────────────────────

/** 非负整数；不合法就退回 fallback（fallback 再不合法就是 0）。 */
export function normalizeNonNegativeInteger(value: unknown, fallback = 0): number {
  const num = Number(value);
  if (Number.isFinite(num) && num >= 0) return Math.floor(num);
  const fb = Number(fallback);
  return Number.isFinite(fb) && fb >= 0 ? Math.floor(fb) : 0;
}

/** 正整数；不合法就退回 fallback（fallback 再不合法就是 1）。 */
export function normalizePositiveInteger(value: unknown, fallback = 1): number {
  const num = Number(value);
  if (Number.isFinite(num) && num > 0) return Math.floor(num);
  const fb = Number(fallback);
  return Number.isFinite(fb) && fb > 0 ? Math.floor(fb) : 1;
}

function hasOwn(source: Loose | null | undefined, key: string): boolean {
  return !!source && Object.prototype.hasOwnProperty.call(source, key);
}

function optionalString(value: unknown, fallbackValue: unknown = ''): string {
  if (typeof value === 'string') return value;
  if (typeof fallbackValue === 'string') return fallbackValue;
  return '';
}

function stringArray(value: unknown, fallbackValue: unknown = []): string[] {
  const raw = Array.isArray(value) ? value : Array.isArray(fallbackValue) ? fallbackValue : [];
  return raw
    .map((item: unknown) => String(item ?? '').trim())
    .filter((item: string, index: number, array: string[]) => item && array.indexOf(item) === index);
}

/** 可缺省的「正整数」：缺省与非法都返回 undefined（用于 agentControl 的可选覆盖）。 */
function optionalPositiveInt(value: unknown, fallbackValue: unknown = undefined): number | undefined {
  const raw = value ?? fallbackValue;
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  const truncated = Math.trunc(n);
  return truncated > 0 ? truncated : undefined;
}

/** 可缺省的「非负整数」，同上。 */
function optionalNonNegativeInt(value: unknown, fallbackValue: unknown = undefined): number | undefined {
  const raw = value ?? fallbackValue;
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  const truncated = Math.trunc(n);
  return truncated >= 0 ? truncated : undefined;
}

/** 布尔字段：有就用它（严格 `=== true`），没有就沿 fallback，再没有就用 defaultValue。 */
function boolField(source: Loose, fallback: Loose, key: string, defaultValue: boolean): boolean {
  if (hasOwn(source, key)) return source[key] === true;
  if (hasOwn(fallback, key)) return fallback[key] === true;
  return defaultValue;
}

// ───────────────────────── agent 控制 ─────────────────────────

/**
 * 规范化 agentControl。
 *
 * 注意「有该字段」与「该字段是 undefined」的区别：`hasOwn` 认的是键存在，
 * 所以 `{enabled: undefined}` 会被当成「用户明确写了 false」，而不是「没写，用默认」。
 * 这是 ACU 的既有行为，照搬。
 */
export function normalizeAgentControl(value: unknown, fallbackValue: unknown = null): PlotTaskAgentControl {
  const source: Loose = value && typeof value === 'object' && !Array.isArray(value) ? (value as Loose) : {};
  const fallback: Loose =
    fallbackValue && typeof fallbackValue === 'object' && !Array.isArray(fallbackValue)
      ? (fallbackValue as Loose)
      : {};

  const preferredStage = optionalPositiveInt(source.preferredStage, fallback.preferredStage);
  const preferredOrder = optionalNonNegativeInt(source.preferredOrder, fallback.preferredOrder);

  const normalized: PlotTaskAgentControl = {
    enabled: boolField(source, fallback, 'enabled', false),
    selectable: boolField(source, fallback, 'selectable', true),
    defaultSelected: boolField(source, fallback, 'defaultSelected', false),
    allowSequential: boolField(source, fallback, 'allowSequential', true),
    allowParallel: boolField(source, fallback, 'allowParallel', true),
    dependsOnTaskIds: stringArray(source.dependsOnTaskIds, fallback.dependsOnTaskIds),
    blocksTaskIds: stringArray(source.blocksTaskIds, fallback.blocksTaskIds),
  };
  if (preferredStage !== undefined) normalized.preferredStage = preferredStage;
  if (preferredOrder !== undefined) normalized.preferredOrder = preferredOrder;
  return normalized;
}

// ───────────────────────── 提示词组 ─────────────────────────

/** 从老式的三段提示词结构里按 id 取一段内容。 */
export function legacyPromptFromThree(prompts: unknown, id: string): string {
  if (!prompts) return '';
  if (Array.isArray(prompts)) return (prompts.find((item: Loose) => item && item.id === id)?.content) || '';
  if (typeof prompts === 'object') return (prompts as Loose)[id] || '';
  return '';
}

/** 判断一个数组是不是「提示词组」（有 role/content，没有 id）。 */
function looksLikeSegmentList(arr: unknown): boolean {
  if (!Array.isArray(arr) || arr.length === 0) return false;
  const first = arr[0] as Loose;
  return !!first && typeof first === 'object' && 'role' in first && 'content' in first && !('id' in first);
}

/** 取一段的槽位：A = 主提示词，B = 拦截指令。兼容老字段 isMain / isMain2。 */
function segmentSlot(segment: Loose | null | undefined): '' | 'A' | 'B' {
  if (!segment) return '';
  const slot = String(segment.mainSlot || '').toUpperCase();
  if (slot === 'A' || slot === 'B') return slot as 'A' | 'B';
  if (segment.isMain) return 'A';
  if (segment.isMain2) return 'B';
  return '';
}

/** 从提示词组里抽出「主提示词」与「系统提示词」两段内容（老式三段结构用）。 */
export function legacyPromptTexts(promptGroup: unknown): { mainPrompt: string; systemPrompt: string } {
  const segments: Loose[] = Array.isArray(promptGroup) ? promptGroup : [];
  return {
    mainPrompt: segments.find(s => segmentSlot(s) === 'A')?.content || '',
    systemPrompt: segments.find(s => segmentSlot(s) === 'B')?.content || '',
  };
}

/** 预设没带提示词组时用的兜底：A/B 两个槽都留空。 */
export function buildEmptyPromptGroup({
  mainAContent = '',
  mainBContent = '',
}: { mainAContent?: string; mainBContent?: string } = {}): PlotPromptSegment[] {
  const base: PlotPromptSegment[] = [
    { role: 'SYSTEM', content: String(mainAContent), deletable: false, mainSlot: 'A', isMain: true },
    { role: 'USER', content: String(mainBContent), deletable: false, mainSlot: 'B', isMain2: true },
  ];
  return base;
}

/**
 * 解析出任务实际使用的提示词组。四级回退，顺序不能变：
 * `promptGroup` → `prompts`（像是提示词组时）→ 拼两段老的正文/系统提示词 → 调用方给的默认。
 */
export function resolvePromptGroup(
  source: Loose | null,
  {
    fallbackPromptGroup = null as unknown,
    buildDefault = buildEmptyPromptGroup,
  }: {
    fallbackPromptGroup?: unknown;
    buildDefault?: (init: { mainAContent?: string; mainBContent?: string }) => PlotPromptSegment[];
  } = {},
): PlotPromptSegment[] {
  if (Array.isArray(source?.promptGroup) && source.promptGroup.length > 0) {
    return JSON.parse(JSON.stringify(source.promptGroup));
  }
  if (looksLikeSegmentList(source?.prompts)) {
    return JSON.parse(JSON.stringify(source!.prompts));
  }
  const fallbackTexts = legacyPromptTexts(fallbackPromptGroup);
  const legacyMain =
    source?.mainPrompt || legacyPromptFromThree(source?.prompts, 'mainPrompt') || fallbackTexts.mainPrompt || '';
  const legacySystem =
    source?.systemPrompt || legacyPromptFromThree(source?.prompts, 'systemPrompt') || fallbackTexts.systemPrompt || '';
  return buildDefault({ mainAContent: legacyMain, mainBContent: legacySystem });
}

// ───────────────────────── 任务 ─────────────────────────

const DEFAULT_MAX_RETRIES = 3;

/**
 * 读任务上的触发周期。
 *
 * 只在源数据（或兜底任务）真的写了 `schedule.everyRounds` / `schedule.lastRound` 时返回对象，
 * 否则返回 `null` —— 让调用方**不写这个键**。理由见 `PlotTask.schedule` 的注释：
 * 上游数据没有它，凭空多一个空对象会让逐字节比对的用例全红。
 *
 * 脏值一律丢弃（`'abc'`、`0`、`-3`）而不是落成 0/NaN：周期是「每几轮跑一次」，
 * 落成 0 会让 `shouldRunTask` 每轮都判成到期，落成 NaN 会让它永远判成没到期。
 */
function normalizeTaskApiName(primary: unknown, fallback: unknown): string {
  const pick = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
  const own = pick(primary);
  return own !== '' ? own : pick(fallback);
}

function normalizeTaskSchedule(primary: unknown, fallback: unknown): TaskSchedule | null {
  const source = primary && typeof primary === 'object' ? (primary as Loose) : null;
  const backup = fallback && typeof fallback === 'object' ? (fallback as Loose) : null;
  const pick = (key: 'everyRounds' | 'lastRound'): number | undefined => {
    const raw = source && Object.prototype.hasOwnProperty.call(source, key) ? source[key] : backup?.[key];
    const value = Math.floor(Number(raw));
    if (!Number.isFinite(value) || value < 1) return undefined;
    return value;
  };
  const everyRounds = pick('everyRounds');
  const lastRound = pick('lastRound');
  if (everyRounds === undefined && lastRound === undefined) return null;
  return {
    ...(everyRounds === undefined ? {} : { everyRounds }),
    ...(lastRound === undefined ? {} : { lastRound }),
  };
}

/**
 * 规范化单个任务。
 *
 * `fallbackTask` 是「同一份预设里已经算好的那个兜底任务」——它保证
 * 「任务只写了 name、别的一概没写」时也能拿到合理的 id / 提示词组 / 阶段。
 */
export function normalizeTask(
  task: Loose | null,
  {
    index = 0,
    fallbackTask = null as Loose | null,
  }: { index?: number; fallbackTask?: Loose | null } = {},
  deps: { buildDefault?: (init: { mainAContent?: string; mainBContent?: string }) => PlotPromptSegment[] } = {},
): PlotTask {
  const cloned: Loose = task && typeof task === 'object' ? JSON.parse(JSON.stringify(task)) : {};
  const fallback: Loose | null = fallbackTask && typeof fallbackTask === 'object' ? fallbackTask : null;
  const defaultId = `plotTask${index + 1}`;

  const rawId = String(cloned.id || cloned.name || fallback?.id || defaultId).trim();
  const taskId = rawId.replace(/[^\w-]+/g, '_') || defaultId;
  const fallbackName = `剧情任务${index + 1}`;
  const taskName = String(cloned.name || fallback?.name || fallbackName).trim() || fallbackName;

  const promptGroup = resolvePromptGroup(cloned, {
    fallbackPromptGroup: fallback?.promptGroup || null,
    buildDefault: deps.buildDefault,
  });
  const schedule = normalizeTaskSchedule(cloned.schedule, fallback?.schedule);
  const apiName = normalizeTaskApiName(cloned.apiName, fallback?.apiName);

  return {
    id: taskId,
    name: taskName,
    enabled: cloned.enabled !== false,
    promptGroup,
    extractTags: typeof cloned.extractTags === 'string' ? cloned.extractTags : fallback?.extractTags || '',
    extractInjectTags:
      typeof cloned.extractInjectTags === 'string' ? cloned.extractInjectTags : fallback?.extractInjectTags || '',
    finalDirectiveTemplate:
      typeof cloned.finalDirectiveTemplate === 'string'
        ? cloned.finalDirectiveTemplate
        : fallback?.finalDirectiveTemplate || '',
    minLength: normalizeNonNegativeInteger(cloned.minLength, fallback?.minLength ?? 0),
    maxRetries: normalizePositiveInteger(
      cloned.maxRetries ?? cloned.loopSettings?.maxRetries,
      fallback?.maxRetries ?? DEFAULT_MAX_RETRIES,
    ),
    mergeStrategy:
      typeof cloned.mergeStrategy === 'string' && cloned.mergeStrategy.trim()
        ? cloned.mergeStrategy.trim()
        : fallback?.mergeStrategy || 'append',
    stage: normalizePositiveInteger(cloned.stage, fallback?.stage ?? 1),
    order: normalizeNonNegativeInteger(cloned.order, fallback?.order ?? index),
    description: optionalString(cloned.description, fallback?.description),
    triggerWhen: optionalString(cloned.triggerWhen, fallback?.triggerWhen),
    agentControl: normalizeAgentControl(cloned.agentControl, fallback?.agentControl),
    ...(schedule ? { schedule } : {}),
    ...(apiName !== '' ? { apiName } : {}),
  };
}

/** 用老式「整份设置」拼出一个默认任务（预设还是老格式时用）。 */
export function legacyWrappedTask(
  source: Loose | null,
  { taskId = 'defaultPlotTask', taskName = '默认任务', order = 0 } = {},
  deps: { buildDefault?: (init: { mainAContent?: string; mainBContent?: string }) => PlotPromptSegment[] } = {},
): PlotTask {
  return normalizeTask(
    {
      id: taskId,
      name: taskName,
      enabled: true,
      promptGroup: resolvePromptGroup(source, { buildDefault: deps.buildDefault }),
      extractTags: typeof source?.extractTags === 'string' ? source.extractTags : '',
      minLength: source?.minLength,
      maxRetries: source?.loopSettings?.maxRetries,
      mergeStrategy: 'append',
      stage: 1,
      order,
    },
    { index: order },
    deps,
  );
}

/**
 * 规范化任务列表。
 *
 * 三种来源都吃得下：新式 `plotTasks[]`、老式单任务（整份设置当任务）、以及「空」。
 * 返回按 `order` 升序排列。
 */
export function normalizeTasks(
  source: Loose | null,
  { fallbackTaskId = 'defaultPlotTask', fallbackTaskName = '默认任务' } = {},
  deps: { buildDefault?: (init: { mainAContent?: string; mainBContent?: string }) => PlotPromptSegment[] } = {},
): PlotTask[] {
  const base: Loose = source && typeof source === 'object' ? source : {};
  const fallbackTask = legacyWrappedTask(base, { taskId: fallbackTaskId, taskName: fallbackTaskName, order: 0 }, deps);

  const rawTasks: Loose[] =
    Array.isArray(base.plotTasks) && base.plotTasks.length > 0 ? base.plotTasks : [fallbackTask];

  return rawTasks
    .map((task, index) =>
      normalizeTask(task, { index, fallbackTask: { ...fallbackTask, order: index } }, deps),
    )
    .sort((a, b) => a.order - b.order);
}
