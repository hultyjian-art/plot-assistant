/**
 * 渲染层：把一个任务的提示词组，变成真正要发给 AI 的那串 messages。
 *
 * 这一层是 `runPlotRound` 的 `renderMessages` 注入点的**真实现**，
 * 对应上游 `renderPlotTaskMessages_ACU`（`plot-task-engine.ts:469-512`）里的 ③④ 两步：
 *
 * ```
 * 段内容  →  performReplacements（$U/$C/$1/$5/$6/$7/$8/$9 …）  →  replacePlaceholders（{{标签}}）  →  归一化 role  →  丢掉空段
 * ```
 *
 * 上游那五步里，① `resolveTaskTableWorldbookTokens`、② `tryRenderPlotTemplateWithEjs_ACU`、
 * ⑤ `renderPlotTaskContentWithIsolatedVariables_ACU` 分别要摸表格、`window.EjsTemplate` 和模板变量引擎，
 * 都属取数/模板层，本体不在这一层 —— 需要的话由调用方在把内容喂进来之前自己做完。
 *
 * 三条不能改的约定：
 * - **顺序**：先 $ 占位符、后 `{{标签}}`。反过来会让「标签内容里带的 $8」被二次替换。
 * - **空段丢弃**：trim 之后为空就不发。上游同样如此（`filter(content => content.trim())`）。
 * - **role 归一化**：预设里写的是 `SYSTEM` / `AI` 这类大写词，酒馆要的是小写 `system` / `assistant`。
 */

import type { PlotRoundMessage } from './engine';
import { performReplacements } from './prompt-build';
import type { TagMap } from './tags';
import { normalizeRole, replacePlaceholders } from './tags';
import type { PlotTask } from './task-model';

/** 渲染一个任务时，调用方要准备好的东西。全是「已经取好的值」，本层不碰数据源。 */
export interface TaskRenderContext {
  /**
   * `$` 占位符的取值表，键就是占位符本身（`'$8'`、`'$U'`、`'$5'` …）。
   * `$1` 与 `$9` 不在这里 —— 它们走信封（`worldbookContent` / `replacements.$9`），见 `performReplacements`。
   */
  replacements?: Record<string, string> | null;
  /** `$1` 的世界书正文。空串或 `null` 时整个 `<worldbook_context>` 信封消失。 */
  worldbookContent?: string | null;
  /** 个别任务对占位符的覆盖值（比如某任务想用更大的 `$7` 窗口）。 */
  taskOverrides?: Record<string, string> | null;
  /** 取值过滤，默认 `defaultFilter`（原样返回）。 */
  filter?: (value: string) => string;
  /** 本阶段内已完成任务产出的标签（阶段开始时的快照）。 */
  relayTagMap?: TagMap | null;
  /** 历史标签（上一轮 `<plot>` 里那些），给 `{{标签}}` 兜底。 */
  historyTagMap?: TagMap | null;
}

/**
 * 任务的提示词组 → messages。
 *
 * 返回的每条 `content` 都保证 trim 后非空；`role` 已归一化。
 * `promptGroup` 缺失或为空时返回空数组（调用方据此判断「这个任务没配提示词」）。
 */
export function renderTaskMessages(task: PlotTask | null | undefined, context: TaskRenderContext = {}): PlotRoundMessage[] {
  const segments = Array.isArray(task?.promptGroup) ? task!.promptGroup : [];
  if (segments.length === 0) return [];

  const replacements = context.replacements || {};
  const taskOverrides = context.taskOverrides || {};
  const relayTagMap: TagMap = context.relayTagMap || new Map();
  const historyTagMap: TagMap = context.historyTagMap || new Map();

  const messages: PlotRoundMessage[] = [];
  for (const segment of segments) {
    if (!segment) continue;
    // reroll 扩展：块级开关（需求二①）。上游数据里没有 `enabled`，只有显式 false 才跳过，
    // 因此未标记的数据与上游逐字节一致。
    if ((segment as { enabled?: boolean }).enabled === false) continue;
    const raw = segment.content === null || segment.content === undefined ? '' : String(segment.content);
    if (!raw) continue;

    const filled = performReplacements(raw, {
      replacements,
      worldbookContent: context.worldbookContent ?? undefined,
      // `performReplacements` 的过滤器收 `unknown`（脏值也要过一遍），这里包一层转成字符串再交给调用方。
      filter: context.filter ? (value: unknown) => context.filter!(String(value ?? '')) : undefined,
      taskOverrides,
    });
    const withTags = replacePlaceholders(filled, relayTagMap, historyTagMap);
    if (!withTags.trim()) continue;

    messages.push({
      role: normalizeRole(segment.role) as PlotRoundMessage['role'],
      content: withTags,
      // 块名只进日志：面板要按提示词块折叠，光看 role 分不清同角色的几段
      name: typeof (segment as { name?: unknown }).name === 'string' ? String((segment as { name?: string }).name) : '',
    });
  }
  return messages;
}
