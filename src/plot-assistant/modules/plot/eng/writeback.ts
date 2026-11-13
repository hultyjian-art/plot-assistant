/**
 * 写回：把这一轮的成果落到**用户楼层**上。
 *
 * 契约全部照 ACU 抄，一个字段都不改名字 —— 因为外面的美化脚本（黑天鹅、阿格莱雅那类）
 * 是按这些名字读的，改名等于把它们全废掉。
 *
 * 三件事必须同时做对，少一件都会「看着像成功」：
 *
 * 1. **`mes` 换成 `finalMessage`，不是「原文 + 追加」。**
 *    ACU 是 `userFloor.message.mes = result.finalMessage`（`init.ts:1003`）——
 *    整段替换。`finalMessage` 由 `buildFinalMessage()` 拼好（指令头 + `<plot>` 块）。
 *    写成追加会让下一轮 `$8`（本轮用户输入）把上一轮的 `<plot>` 也读进去。
 *
 * 2. **`qrf_plot` 存的是**标签块**（`<标签>…</标签>` 若干段），不是 AI 原话、也不是整段成品。**
 *    2026-11-12 用户拍板：qrf 只记一份标签数据，"AI 原话带思维链，直接复现会污染 $6"。
 *    以前存 `buildSaveContent`（原始回传拼接）有问题——原话里的杂质会一起进 $6。
 *    现在按 `buildTagBlock` 拼标签块，与楼层正文用的是同一套块格式。
 *
 * 3. **写进 `extra`，不写顶层。**
 *    ACU 写的是消息对象顶层字段，而 `getChatMessages()` 只还原七个字段（`message` 也在其中，
 *    所以 `mes` 没问题），顶层自定义字段会被丢掉。`extra` 是完整暴露的。
 *    外面那些美化脚本读的时候两处都会看（`msg.qrf_plot ?? msg.extra.qrf_plot`），所以放 `extra` 不丢兼容。
 */

import type { PlotTaskResult } from './assemble';

/** 写回的四个 qrf 字段名 + 一个「已处理」标记。**不要改**，外面脚本按名字读。 */
export const QRF_PLOT = 'qrf_plot';
export const QRF_PLOT_PRESET = 'qrf_plot_preset';
/** 旧字段，已不再写入（2026-11-12 起 qrf 只记标签块）。读端遇到它就当没有。 */
export const QRF_PLOT_TASKS_LEGACY = 'qrf_plot_tasks';
export const QRF_ROUND_ID = '_qrf_plot_round_id';
export const QRF_PLOT_PROCESSED = '_plot_processed';

export interface PlotWritebackInput {
  /** 写进 `mes` 的终稿（`buildFinalMessage` 的产物）。 */
  finalMessage: string;
  /** 写进 `qrf_plot` 的原文（`buildSaveContent` 的产物）。 */
  saveContent: string;
  /** 本轮用的预设名。空串是合法的（= 默认预设），`$6` 的回退逻辑就靠这个判据。 */
  presetName?: string | null;
  /** 本轮身份。用 `makeRoundId()` 生成。 */
  roundId: string;
  /** 楼层原有的 `extra`，**必须原样传进来** —— `setChatMessages` 的 `extra` 是整份替换。 */
  extra?: Record<string, unknown> | null;
  /** 本轮任务结果，用来拼 `qrf_plot_tasks`。 */
  taskResults?: PlotTaskResult[] | null;
}

export interface PlotWriteback {
  /** 要写进楼层的正文。 */
  message: string;
  /** 要写进楼层的 `extra`（已经和原有键合并好）。 */
  extra: Record<string, unknown>;
}

/**
 * 按 ACU 的 roundId 规则生成：`Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)`。
 *
 * `now` 与 `random` 都从外面传，好处是用例能钉住格式；坏处是调用方必须记得传 —— 所以给了默认值。
 */
export function makeRoundId(now: number = Date.now(), random: () => number = Math.random): string {
  return `${now.toString(36)}-${random().toString(36).slice(2, 10)}`;
}

/**
 * 收集这一轮要写进 `qrf_plot_tasks` 的原始回传。
 *
 * 照 ACU 的三条判据（`plot-history-preset.ts:480`）：成功、有 `taskId`、`rawResponse` 去掉首尾空白后非空。
 * 不满足的一律不写 —— 写进去会让下一轮 `$6` 的按任务分支读到半截内容。
 */
export function collectTaskRawResponses(taskResults: PlotTaskResult[] | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const result of taskResults || []) {
    if (!result || result.success !== true) continue;
    const taskId = String(result.taskId || '').trim();
    if (!taskId) continue;
    const raw = typeof result.rawResponse === 'string' ? result.rawResponse.trim() : '';
    if (!raw) continue;
    out[taskId] = raw;
  }
  return out;
}

/**
 * 拼出要写回楼层的那一份数据。纯函数，不碰酒馆。
 *
 * `taskResults` 全失败时**不新建** `qrf_plot_tasks` 键（ACU 只在 `length > 0` 时才建），
 * 但楼层里原有的旧值要留着 —— 上一轮的任务级回传不该被这一轮的失败擦掉。
 */
export function buildPlotWriteback(input: PlotWritebackInput): PlotWriteback {
  const extra: Record<string, unknown> = { ...(input.extra || {}) };

  // saveContent 现在是「标签块」拼成的文本（2026-11-12 起），不再是 AI 原话。
  extra[QRF_PLOT] = String(input.saveContent ?? '');
  extra[QRF_PLOT_PRESET] = String(input.presetName ?? '');
  extra[QRF_ROUND_ID] = String(input.roundId || '');
  extra[QRF_PLOT_PROCESSED] = true;

  // 旧的 qrf_plot_tasks 不再写入；楼里原有的那份留着不动，读端会忽略它。
  return { message: String(input.finalMessage ?? ''), extra };
}
