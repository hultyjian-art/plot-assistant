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
import { isBlockEnabled } from './prompt-blocks';
import { buildTagDiffInstruction, type TagDiffMode } from './tag-diff';
import type { TavernPromptMacroSource } from '../../tavern';

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
  /**
   * 酒馆原生宏替换（`<user>` / `{{user}}` / `<char>` / `{{char}}` 等）。
   * 不传就不处理，保证纯函数测试与没有酒馆的环境行为不变。
   */
  macroReplace?: ((text: string) => string) | null;
  /**
   * 完整提示词模板链（酒馆正则 + ST 宏 + MacroLike → EJS → 再跑一遍宏）。
   * 传了它就走异步渲染；不传时仍走上面的同步 `macroReplace`，老调用方不受影响。
   */
  templateProcess?: ((text: string, source: TavernPromptMacroSource) => Promise<string>) | null;
  /** 预设级「标签名 → 差量模式」；有命中 blocks/table 时，按任务生成规则并顶在最前面。 */
  tagDiffModes?: Record<string, TagDiffMode> | null;
}

/**
 * 把本任务的差量规则顶到最前面。注入发生在 `{{标签}}` 替换之后，
 * 所以规则里的占位符不会被当成内部标签清掉。
 */
function withTagDiffInstruction(
  task: PlotTask | null | undefined,
  messages: PlotRoundMessage[],
  modes: Record<string, TagDiffMode> | null | undefined,
): PlotRoundMessage[] {
  if (messages.length === 0) return messages;
  const instruction = buildTagDiffInstruction(task || {}, modes || {});
  if (!instruction) return messages;
  return [{ role: 'system', content: instruction, name: '标签差量规则' }, ...messages];
}

/**
 * 异步渲染时提示词块一律按「斜杠命令」送进酒馆正则链，不按块上标的角色分流
 * （同步版 `renderTaskMessages` 只做宏替换与占位符替换，不走正则链）。
 *
 * 块上的 SYSTEM / USER / ASSISTANT 只是这段提示词给 AI 看的「发言身份」，
 * 并不是酒馆里真实的用户输入或 AI 回复。拿它去套酒馆正则的
 * 「用户输入 / AI 输出」作用范围，会让玩家为主对话配的正则误伤剧情推进任务。
 * 与工作流助手一致：预设段固定 slash_command，不套用用户 / AI 输出作用域。
 */

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
    // reroll 扩展：块级开关（需求二①）。判定收在 eng/prompt-blocks.ts 一处；
    // 上游数据里没有 `enabled`，只有显式 false 才跳过，未标记的数据与上游逐字节一致。
    if (!isBlockEnabled(segment)) continue;
    const raw = segment.content === null || segment.content === undefined ? '' : String(segment.content);
    if (!raw) continue;

    const filled = performReplacements(raw, {
      replacements,
      worldbookContent: context.worldbookContent ?? undefined,
      // `performReplacements` 的过滤器收 `unknown`（脏值也要过一遍），这里包一层转成字符串再交给调用方。
      filter: context.filter ? (value: unknown) => context.filter!(String(value ?? '')) : undefined,
      taskOverrides,
    });
    // 宏要在 `{{标签}}` 之前先换一次：`{{user}}` / `{{char}}` 同时也是酒馆宏，
    // 如果先走 `replacePlaceholders`，它们会被当成不存在的内部标签换成空壳。
    // 换完宏之后再替换内部标签；最后再走一次宏，兜住标签内容里自带的宏。
    const macroed = context.macroReplace ? context.macroReplace(filled) : filled;
    const withTags = replacePlaceholders(macroed, relayTagMap, historyTagMap);
    const withMacros = context.macroReplace ? context.macroReplace(withTags) : withTags;
    if (!withMacros.trim()) continue;

    messages.push({
      role: normalizeRole(segment.role) as PlotRoundMessage['role'],
      content: withMacros,
      // 块名只进日志：面板要按提示词块折叠，光看 role 分不清同角色的几段
      name: typeof (segment as { name?: unknown }).name === 'string' ? String((segment as { name?: string }).name) : '',
    });
  }
  return withTagDiffInstruction(task, messages, context.tagDiffModes);
}

/**
 * 异步版渲染：在同步版的基础上接完整模板链。
 *
 * `templateProcess` 是「酒馆正则 + ST 宏 + MacroLike → EJS → 再跑一遍宏」，
 * 位置与同步版的 `macroReplace` 相同：先于内部标签替换，最后再兜一遍。
 * 没有传 `templateProcess` 时退回同步 `macroReplace`，避免测试和旧调用方改行为。
 */
export async function renderTaskMessagesAsync(
  task: PlotTask | null | undefined,
  context: TaskRenderContext = {},
): Promise<PlotRoundMessage[]> {
  const segments = Array.isArray(task?.promptGroup) ? task!.promptGroup : [];
  if (segments.length === 0) return [];

  const replacements = context.replacements || {};
  const taskOverrides = context.taskOverrides || {};
  const relayTagMap: TagMap = context.relayTagMap || new Map();
  const historyTagMap: TagMap = context.historyTagMap || new Map();

  const messages: PlotRoundMessage[] = [];
  for (const segment of segments) {
    if (!segment) continue;
    if (!isBlockEnabled(segment)) continue;
    const raw = segment.content === null || segment.content === undefined ? '' : String(segment.content);
    if (!raw) continue;

    const filled = performReplacements(raw, {
      replacements,
      worldbookContent: context.worldbookContent ?? undefined,
      filter: context.filter ? (value: unknown) => context.filter!(String(value ?? '')) : undefined,
      taskOverrides,
    });

    // 固定作用域，见上方说明：不按提示词块角色套用户 / AI 输出正则。
    const source: TavernPromptMacroSource = 'slash_command';
    let withMacros: string;
    if (context.templateProcess) {
      const macroed = await context.templateProcess(filled, source);
      const withTags = replacePlaceholders(macroed, relayTagMap, historyTagMap);
      // 模板链只在预设原文上跑一次；标签内容来自上一轮正文，不能被当成 EJS 模板执行。
      withMacros = context.macroReplace ? context.macroReplace(withTags) : withTags;
    } else {
      const macroed = context.macroReplace ? context.macroReplace(filled) : filled;
      const withTags = replacePlaceholders(macroed, relayTagMap, historyTagMap);
      withMacros = context.macroReplace ? context.macroReplace(withTags) : withTags;
    }
    if (!withMacros.trim()) continue;

    messages.push({
      role: normalizeRole(segment.role) as PlotRoundMessage['role'],
      content: withMacros,
      name: typeof (segment as { name?: unknown }).name === 'string' ? String((segment as { name?: string }).name) : '',
    });
  }
  return withTagDiffInstruction(task, messages, context.tagDiffModes);
}
