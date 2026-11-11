/**
 * plot/eng/task-model.ts — 剧情任务的规范化（纯函数）
 *
 * 职责：把「用户在预设里写的、形状可能千奇百怪的任务对象」压成引擎内部唯一认得的形状。
 *
 * 三条设计约束：
 * 1. **不认识 ACU**。这里没有全局状态、没有世界书、没有表格，只做数据整形。
 * 2. **不认识默认提示词**。任务没写提示词组就是空表，不在这一层塞默认内容。
 * 3. **只认新式 `plotTasks[]`**。老预设那种「预设级两段纯文本 + 主插槽 A/B」的兜底链
 *    已移除：导进来会在引擎入口显式报错，不再静默不跑。
 * 4. **字段顺序即契约**。返回对象的键顺序与 ACU 保持一致，因为落盘后要按 JSON 逐字节比对。
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

/** 提示词组里的一段。 */
export interface PlotPromptSegment {
  role?: string;
  content?: string;
  deletable?: boolean;
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
  /**
   * 豁免标签（第 51 批新增，上游**没有**这个字段）。
   *
   * 这些标签不要求每轮 AI 回传都出现；回传了仍照常抽取、落盘、进世界书。
   * 和 schedule / apiName 一样只在源数据真的写了才带上这个键，
   * 免得改变没有该字段的旧预设的逐字节形状。
   */
  exemptTags?: string;
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

/** 判断一个数组是不是「提示词组」（有 role/content，没有 id）。 */
function looksLikeSegmentList(arr: unknown): boolean {
  if (!Array.isArray(arr) || arr.length === 0) return false;
  const first = arr[0] as Loose;
  return !!first && typeof first === 'object' && 'role' in first && 'content' in first && !('id' in first);
}

/**
 * 解析出任务实际使用的提示词组。只有两级：
 * `promptGroup` → `prompts`（像是提示词组时）。
 *
 * 老预设那种「预设级 mainPrompt / systemPrompt 两段纯文本，或 prompts 三段按 id 查」
 * 的兜底链已移除：那种预设在引擎入口会被显式拦下并报错，这里不再凭空造 A/B 两槽。
 */
export function resolvePromptGroup(source: Loose | null): PlotPromptSegment[] {
  if (Array.isArray(source?.promptGroup) && source.promptGroup.length > 0) {
    return JSON.parse(JSON.stringify(source.promptGroup));
  }
  if (looksLikeSegmentList(source?.prompts)) {
    return JSON.parse(JSON.stringify(source!.prompts));
  }
  return [];
}

// ───────────────────────── 任务 ─────────────────────────

const DEFAULT_MAX_RETRIES = 3;

/**
 * 读任务上的触发周期与手动触发标记。
 *
 * 只在源数据（或兜底任务）真的写了 `schedule.everyRounds` / `schedule.lastRound`
 * / `schedule.manual: true` 时返回对象，否则返回 `null` —— 让调用方**不写这个键**。
 * 理由见 `PlotTask.schedule` 的注释：上游数据没有它，凭空多一个空对象会让逐字节比对的用例全红。
 *
 * 脏值一律丢弃（`'abc'`、`0`、`-3`、`manual: 1`、`manual: "true"`）而不是落成 0/NaN/半成品：
 * 周期是「每几楼进行一次」，落成 0 会让 `shouldRunTask` 每轮都判成到期，落成 NaN 会让它永远判成没到期；
 * 手动标记只认严格 `true`，是面板「只写 true、关闭=删键」那套落盘纪律的入口把关。
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
  // 手动触发标记（批68）：只认真写的 `true`，1 / "true" / false 这些脏值一律丢弃，
  // 与上面两个数字字段同一家风；源数据没写就不带这个键，免得改掉旧预设的逐字节形状。
  const manualRaw =
    source && Object.prototype.hasOwnProperty.call(source, 'manual') ? source.manual : backup?.manual;
  const manual = manualRaw === true;
  if (everyRounds === undefined && lastRound === undefined && !manual) return null;
  return {
    ...(everyRounds === undefined ? {} : { everyRounds }),
    ...(lastRound === undefined ? {} : { lastRound }),
    ...(manual ? { manual: true } : {}),
  };
}

/**
 * 规范化单个任务。
 *
 * `fallbackTask` 是可选的字段来源：任务没写的字段会沿用它的值。
 * 老格式预设那种「整份设置拼一条兜底任务、再拿它喂给每个任务」的用法已删，
 * 现在由调用方自己决定要不要传；不传时每个任务独立按默认值规范化。
 */
export function normalizeTask(
  task: Loose | null,
  {
    index = 0,
    fallbackTask = null as Loose | null,
  }: { index?: number; fallbackTask?: Loose | null } = {},
): PlotTask {
  const cloned: Loose = task && typeof task === 'object' ? JSON.parse(JSON.stringify(task)) : {};
  const fallback: Loose | null = fallbackTask && typeof fallbackTask === 'object' ? fallbackTask : null;
  const defaultId = `plotTask${index + 1}`;

  const rawId = String(cloned.id || cloned.name || fallback?.id || defaultId).trim();
  const taskId = rawId.replace(/[^\w-]+/g, '_') || defaultId;
  const fallbackName = `剧情任务${index + 1}`;
  const taskName = String(cloned.name || fallback?.name || fallbackName).trim() || fallbackName;

  const promptGroup = resolvePromptGroup(cloned);
  const schedule = normalizeTaskSchedule(cloned.schedule, fallback?.schedule);
  const apiName = normalizeTaskApiName(cloned.apiName, fallback?.apiName);
  const exemptTags = typeof cloned.exemptTags === 'string' ? cloned.exemptTags : fallback?.exemptTags || '';

  return {
    id: taskId,
    name: taskName,
    enabled: cloned.enabled !== false,
    promptGroup,
    extractTags: typeof cloned.extractTags === 'string' ? cloned.extractTags : fallback?.extractTags || '',
    extractInjectTags:
      typeof cloned.extractInjectTags === 'string' ? cloned.extractInjectTags : fallback?.extractInjectTags || '',
    ...(exemptTags !== '' ? { exemptTags } : {}),
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

/**
 * 规范化任务列表。只认新式 `plotTasks[]`：
 * 预设没写任务表（或写的是老格式的两段纯文本）就返回空表，
 * 由引擎入口显式报「不支持老格式预设」，不再凭空拼一条兜底任务。
 * 返回按 `order` 升序排列。
 */
export function normalizeTasks(source: Loose | null): PlotTask[] {
  const base: Loose = source && typeof source === 'object' ? source : {};
  const rawTasks = Array.isArray(base.plotTasks) ? base.plotTasks : [];
  if (rawTasks.length === 0) return [];

  // 每个任务独立规范化。原件会把「整份老设置拼成的兜底任务」当 fallback 喂给
  // 每个任务（连 name / agentControl 都会渗透），那是老预设专用的兼容层；
  // 删掉之后不再让第一个任务去顶替它，否则第二个任务的 order / agentControl
  // 会被第一个任务的值悄悄覆盖。
  return rawTasks.map((task, index) => normalizeTask(task, { index })).sort((a, b) => a.order - b.order);
}
