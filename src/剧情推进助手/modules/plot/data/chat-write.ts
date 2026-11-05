/**
 * 写回楼层的**执行端**：真正去读楼层、合并 `extra`、再写回去。
 *
 * 和 `eng/writeback.ts` 的分工：那边只算「要写什么」，这边负责「读旧值 → 合并 → 落盘」。
 * 之所以要在这里再读一次旧 `extra`，而不是让调用方自己传进来：
 * `setChatMessages` 的 `extra` 是**整份替换**，漏传一个键就等于把它删了。
 * 少一次「读旧值」的机会，就多一次静默丢数据的可能。
 *
 * 刷新口径用 `'affected'`（酒馆助手的默认值），**不要用 `'all'`**：
 * `'all'` 会重载整份聊天并触发 `CHAT_CHANGED`，附近的脚本（包括本脚本）可能因此重载。
 */

import type { PlotTaskResult } from '../eng/assemble';
import { QRF_PLOT, QRF_PLOT_PRESET, QRF_PLOT_TASKS, QRF_ROUND_ID, buildPlotWriteback, type PlotWriteback } from '../eng/writeback';

/** 只取我们关心的那两个字段，避免把整条 `ChatMessage` 传进来又原样传回去。 */
interface ChatMessageLike {
  message_id: number;
  message: string;
  extra?: Record<string, unknown>;
}

export interface WritePlotFloorInput {
  /** 要写的楼层。通常是这一轮的用户楼层。 */
  messageId: number;
  /** 写进 `mes` 的终稿（`buildFinalMessage` 的产物）。 */
  finalMessage: string;
  /** 写进 `qrf_plot` 的原文（`buildSaveContent` 的产物）。 */
  saveContent: string;
  presetName?: string | null;
  roundId: string;
  taskResults?: PlotTaskResult[] | null;
}

/**
 * 把这一轮的成果写进楼层。**不吞异常** —— 写失败就是失败，由调用方决定记日志还是重试。
 *
 * 返回实际写下去的那一份，方便调用方把它记进运行日志（尤其是 `extra` 里最终留下了什么）。
 */
export async function writePlotToFloor(input: WritePlotFloorInput): Promise<PlotWriteback> {
  const floors = getChatMessages(input.messageId) as unknown as ChatMessageLike[];
  const current = Array.isArray(floors) ? floors[0] : undefined;
  if (!current) {
    throw new Error(`写回失败：读不到第 ${input.messageId} 层`);
  }

  const patch = buildPlotWriteback({
    finalMessage: input.finalMessage,
    saveContent: input.saveContent,
    presetName: input.presetName,
    roundId: input.roundId,
    extra: current.extra,
    taskResults: input.taskResults,
  });

  await setChatMessages([{ message_id: input.messageId, message: patch.message, extra: patch.extra }], {
    refresh: 'affected',
  });

  return patch;
}

export interface WritePlotExtraInput {
  /** 要写的楼层：发送之后坐落在 `floorId` 上的那条用户消息。 */
  messageId: number;
  /** 写进 `qrf_plot` 的原文（`buildSaveContent` 的产物）。 */
  saveContent: string;
  presetName?: string | null;
  roundId: string;
  taskResults?: PlotTaskResult[] | null;
}

/**
 * 只写 `extra` 里的四个 qrf 字段，**不动 `mes`**。
 *
 * 为什么不能用 `writePlotToFloor`：它把 `mes` 整段换成 `finalMessage`（上游的语义是
 * 「楼层正文就是 plot 指令块」，因为上游自己拼出来直接建楼层）。我们的链路是
 * 「用户原文 + 空行 + plot」——换掉 `mes` 就把用户说的话抹了。
 *
 * 而 qrf 又不能省：下一轮的 `$6`（上一轮剧情）就是从楼层顶层的 `qrf_plot` 读的，
 * 不写的话每轮都读不到上一轮，剧情记忆等于断在发送这一步。
 */
export async function writePlotExtraToFloor(input: WritePlotExtraInput): Promise<Record<string, unknown>> {
  const floors = getChatMessages(input.messageId) as unknown as ChatMessageLike[];
  const current = Array.isArray(floors) ? floors[0] : undefined;
  if (!current) {
    throw new Error(`写 qrf 失败：读不到第 ${input.messageId} 层`);
  }

  const patch = buildPlotWriteback({
    // 这里的 `finalMessage` 只用来生成 `message`，我们**不使用**它 —— 见下面一行：
    finalMessage: '',
    saveContent: input.saveContent,
    presetName: input.presetName,
    roundId: input.roundId,
    extra: current.extra,
    taskResults: input.taskResults,
  });

  await setChatMessages([{ message_id: input.messageId, message: current.message, extra: patch.extra }], {
    refresh: 'affected',
  });

  return patch.extra;
}

/**
 * 把 qrf 四字段从楼层 `extra` 里摘掉（切到升级模式时用）。
 *
 * `setChatMessages` 的 `extra` 是整份替换，所以这里先读旧值、只删这四个键，
 * 其它脚本塞进去的键一个都不能丢。
 */
export async function clearPlotExtraFromFloor(messageId: number): Promise<boolean> {
  const floors = getChatMessages(messageId) as unknown as ChatMessageLike[];
  const current = Array.isArray(floors) ? floors[0] : undefined;
  if (!current) throw new Error(`清 qrf 失败：读不到第 ${messageId} 层`);
  const extra = { ...(current.extra ?? {}) };
  let touched = false;
  for (const key of [QRF_PLOT, QRF_PLOT_PRESET, QRF_PLOT_TASKS, QRF_ROUND_ID]) {
    if (key in extra) {
      delete extra[key];
      touched = true;
    }
  }
  if (!touched) return false;
  await setChatMessages([{ message_id: messageId, message: current.message, extra }], { refresh: 'affected' });
  return true;
}
