/**
 * 预设导入层：把「数据库脚本（ACU）里那一份剧情预设」整形成 reroll 引擎能直接吃的一份配置。
 *
 * 为什么单独一层：上游 `getPlotPresetDetails()` 交回来的是用户手配过的原始对象，
 * 字段形态五花八门（老式 `prompts` 对象、新式 `prompts` 数组、只剩 `contextExtractTags` 的老标签串），
 * 而引擎要的是一份确定的、缺失即默认的配置。中间这层转换必须只说一次、只测一次。
 *
 * 设计边界：
 * - **只读**。ACU 自己的归一化会改入参（`ensurePlotPromptsArray_ACU` 补数组、
 *   `normalizePlotPresetExcludeRules_ACU` 直接 `delete cloned.contextExtractTags`）。
 *   这里全部改成读时计算 —— 调用方传进来的对象，出去还是一模一样。
 * - **永不抛**。预设是用户手配的，缺字段、类型写歪、甚至整个是 `null`，
 *   都要能出一份能跑的配置。脏值的处理方式一律「当没写」。
 * - **回退链照抄**。`finalSystemDirective → finalDirective → prompts` 这个顺序不能动，
 *   它决定任务最后拿到的「最终注入指令」是哪一句。
 * - **差异单列**。与 ACU 有意不同的地方在注释里标 `[差异]`，并在 `preset-import-test.ts` 里各有用例。
 */

import type { BoundaryRule } from './context-tags';
import { normalizeRules } from './context-tags';
import type { PlotPromptSegment, PlotTask } from './task-model';
import { legacyPromptFromThree, normalizeTasks } from './task-model';
import { normalizeTagDiffModes, type TagDiffMode } from './tag-diff';

/** 引擎整轮拿到的、来自某一份预设的全部配置。 */
export interface PlotPresetConfig {
  /** 预设名。取不到就是空串（不是 `null`，省得调用方到处判空）。 */
  name: string;
  /** 已经过 `normalizeTasks` 的任务表，按 `order` 升序。预设没写任务时是那条兜底任务。 */
  tasks: PlotTask[];
  /** 「最终注入指令」模板，里面的 `{{标签}}` 决定段落落在哪。 */
  directiveTemplate: string;
  /** `$7` 取多少条前文 AI 输出。 */
  contextTurnCount: number;
  /**
   * 预设级「标签名 → 差量模式」。
   *
   * 标签级而不是任务级：一个任务可能同时产出快照标签和积累标签，
   * 真正跨轮存活的是标签，不是任务。
   */
  tagDiffModes: Record<string, TagDiffMode>;
  /** 从上下文里「抠出来」的区间规则。 */
  extractRules: BoundaryRule[];
  /** 从上下文里「删掉」的区间规则。 */
  excludeRules: BoundaryRule[];
  /**
   * 这份配置里的任务是不是兜底任务（预设里压根没配任务）。
   * 界面可以据此提示「这份预设还没配任务」，而不是让用户以为任务丢了。
   */
  usedFallbackTask: boolean;
}

export interface ImportPresetOptions {
  /** 兜底任务用的提示词组构造器。不传就用 `buildEmptyPromptGroup`（A/B 两槽留空）。 */
  buildDefaultPromptGroup?: (init: { mainAContent?: string; mainBContent?: string }) => PlotPromptSegment[];
  /** 兜底任务的名字，默认「默认任务」。 */
  fallbackTaskName?: string;
  /** `contextTurnCount` 缺失时的默认值，默认 1。 */
  defaultContextTurnCount?: number;
}

/** ACU 里 `plotSettings.contextTurnCount ?? 1` 的那个 1。 */
export const DEFAULT_CONTEXT_TURN_COUNT = 1;

type Loose = Record<string, any>;

function asRecord(value: unknown): Loose | null {
  return value && typeof value === 'object' ? (value as Loose) : null;
}

/** 预设名。空、非对象、非字符串一律给空串。 */
export function presetNameOf(preset: unknown): string {
  const record = asRecord(preset);
  if (!record) return '';
  return String(record.name || '').trim();
}

/**
 * 最终注入指令模板。三级回退，顺序照抄
 * `getPlotFinalDirectiveFromSource_ACU`（`src/service/plot/plot-logic.ts:116`）：
 * `finalSystemDirective` → `finalDirective` → 提示词组里 id 为 `finalSystemDirective` 的那一段。
 *
 * [差异] 上游第 3、4 两级其实是同一件事：它先 `ensurePlotPromptsArray_ACU` 把老式对象
 * 转成数组，再按 id 查；而 `legacyPromptFromThree` 直接吃两种形态（数组按 id、对象按 key），
 * 所以这里只写一次。结果一致，少一次 mutate。
 *
 * [差异] 上游用 `||` 直接把值串起来，字段里塞了非字符串（比如数字）会原样传出去；
 * 这里非字符串一律当「没写」，继续往下回退。
 */
export function readDirectiveTemplate(preset: unknown): string {
  const record = asRecord(preset);
  if (!record) return '';
  const pick = (value: unknown): string => (typeof value === 'string' ? value : '');
  return (
    pick(record.finalSystemDirective) ||
    pick(record.finalDirective) ||
    legacyPromptFromThree(record.prompts, 'finalSystemDirective') ||
    ''
  );
}

/**
 * `$7` 取多少条前文。
 *
 * 上游是 `plotSettings.contextTurnCount ?? 1` —— 只有 `null`/`undefined` 才回默认，`0` 是合法值
 * （意思是「不要前文」）。
 * [差异] 上游没做数字校验，`'3'` / `-1` / `2.7` / `NaN` 会被原样带进循环。这里统一收口成非负整数。
 */
export function readContextTurnCount(preset: unknown, fallback = DEFAULT_CONTEXT_TURN_COUNT): number {
  const record = asRecord(preset);
  if (!record) return fallback;
  const raw = record.contextTurnCount;
  if (raw === null || raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

/** 提取规则。新式 `contextExtractRules` 优先，退回老式 `contextExtractTags`。 */
export function readExtractRules(preset: unknown): BoundaryRule[] {
  const record = asRecord(preset);
  if (!record) return [];
  const legacyTags = typeof record.contextExtractTags === 'string' ? record.contextExtractTags : '';
  return normalizeRules(record.contextExtractRules, legacyTags);
}

/** 排除规则。新式 `contextExcludeRules` 优先，退回老式 `contextExcludeTags`。 */
export function readExcludeRules(preset: unknown): BoundaryRule[] {
  const record = asRecord(preset);
  if (!record) return [];
  const legacyTags = typeof record.contextExcludeTags === 'string' ? record.contextExcludeTags : '';
  return normalizeRules(record.contextExcludeRules, legacyTags);
}

/**
 * 一份预设 → 一份引擎配置。
 *
 * 任务那一段完全交给 `normalizeTasks`：它已经能吃新式 `plotTasks[]`、
 * 老式「整份设置当任务」和「空」三种来源，所以这里把整个预设递进去就够了
 * （`plotTasks` 为空时它会用预设自身的 `mainPrompt`/`systemPrompt`/`extractTags` 拼兜底任务，
 * 与 `buildLegacyWrappedPlotTask_ACU` 的做法一致）。
 */
export function importPresetConfig(preset: unknown, options: ImportPresetOptions = {}): PlotPresetConfig {
  const record = asRecord(preset);
  const base: Loose = record || {};
  const rawTasks = Array.isArray(base.plotTasks) ? base.plotTasks : [];
  const deps = options.buildDefaultPromptGroup ? { buildDefault: options.buildDefaultPromptGroup } : {};

  return {
    name: presetNameOf(base),
    tasks: normalizeTasks(base, { fallbackTaskName: String(options.fallbackTaskName || '默认任务') }, deps),
    directiveTemplate: readDirectiveTemplate(base),
    contextTurnCount: readContextTurnCount(base, options.defaultContextTurnCount ?? DEFAULT_CONTEXT_TURN_COUNT),
    tagDiffModes: normalizeTagDiffModes(record?.tagDiffModes),
    extractRules: readExtractRules(base),
    excludeRules: readExcludeRules(base),
    usedFallbackTask: rawTasks.length === 0,
  };
}

/** 批量导入（`getPlotPresets()` 那种一次给一叠的场景）。非数组给空表，元素里的脏值跳过。 */
export function importPresetList(presets: unknown, options: ImportPresetOptions = {}): PlotPresetConfig[] {
  if (!Array.isArray(presets)) return [];
  return presets
    .filter(item => item && typeof item === 'object')
    .map(item => importPresetConfig(item, options));
}

/**
 * 按名字挑一份（`switchPlotPreset(name)` 之后的取数入口）。
 * 名字先精确比、再 trim 后比，都没有就返回 `null` —— 不做模糊匹配，选错预设比找不到更危险。
 */
export function findPresetConfig(
  presets: unknown,
  name: string,
  options: ImportPresetOptions = {},
): PlotPresetConfig | null {
  if (!Array.isArray(presets)) return null;
  const wanted = String(name || '').trim();
  if (!wanted) return null;
  const list = presets.filter(item => item && typeof item === 'object');
  const exact = list.find(item => (item as Loose).name === name);
  const loose = exact || list.find(item => presetNameOf(item) === wanted);
  return loose ? importPresetConfig(loose, options) : null;
}
