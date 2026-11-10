/**
 * plot/floor-sync.ts — 楼层被手动改过之后，把改动同步回「当前模式的存储」
 *
 * 用户 2026-11-03 的口径：账本（或楼层字段）与楼层正文对不上时，靠**双向同步**解决 ——
 * 他在酒馆里改完楼层、点保存，这边就跟着更新；qrf 模式同步到 qrf 字段，
 * 升级模式同步到账本。两种存储互斥，所以这里只看当前模式，绝不两边都写。
 *
 * 只认用户楼层：`qrf_plot` / 账本都只挂在「这一轮用户说了什么、产出了什么」那层上。
 * 改 assistant 楼层是改正文，与剧情推进的成果无关，直接放过。
 *
 * 写回时带 `refresh: 'affected'`，酒馆发的是 `MESSAGE_UPDATED` 而不是 `MESSAGE_EDITED`，
 * 不会自己触发自己。
 *
 * 推进运行期间（`ctx.state.locked` 为真）不写盘：引擎整轮只 load 一次账本快照，
 * 中途多次整份 saveStash，若这时插一次「读旧快照 → 整份写回」，后写会把引擎成果盖掉。
 * 编辑事件先排队，推进结束后按序补同步；同步进行中（busy）到达的事件也排队，不丢。
 */

import { isPlainObject } from './guards';
import type { RerushContext } from '../types';
import { resolveChatKey } from './chat-key';
import { resolveChatStateStore } from './data/chat-vars';
import { writePlotExtraToFloor } from './data/chat-write';
import type { PlotTaskResult } from './eng/assemble';
import { QRF_PLOT, QRF_PLOT_PRESET, QRF_PLOT_TASKS, makeRoundId } from './eng/writeback';
import { plotSegmentOf } from './stash-apply';
import { activeLanding } from './stash-model';

interface FloorLike {
  message_id: number;
  message: string;
  role?: string;
  extra?: Record<string, unknown>;
}

export interface FloorSyncHandle {
  /** 卸掉监听（脚本卸载时调） */
  stop(): void;
}

/** 把 `qrf_plot_tasks` 那份 map 还原成写回层认识的形状，免得同步时把它清空。 */
function taskResultsFrom(extra: Record<string, unknown>): PlotTaskResult[] {
  const raw = extra[QRF_PLOT_TASKS];
  if (!isPlainObject(raw)) return [];
  return Object.entries(raw as Record<string, unknown>)
    .filter(([, value]) => typeof value === 'string' && value.trim() !== '')
    .map(([taskId, value], index) => ({
      taskId,
      taskName: taskId,
      stage: 1,
      order: index + 1,
      success: true,
      rawResponse: String(value),
    }));
}

/**
 * 一次同步。导出是为了能在没有酒馆事件的环境里直接测（`tools/plot-parity`）。
 */
export async function syncFloorEdit(ctx: RerushContext, messageId: number): Promise<string> {
  const floors = getChatMessages(messageId) as unknown as FloorLike[];
  const floor = Array.isArray(floors) ? floors[0] : undefined;
  if (!floor || floor.role !== 'user') return 'skip:not-user';

  const segment = plotSegmentOf(floor.message);
  if (!segment) return 'skip:no-plot';

  if (ctx.settings.plot.stashMode === 'qrf') {
    const extra = floor.extra ?? {};
    const current = typeof extra[QRF_PLOT] === 'string' ? extra[QRF_PLOT] : '';
    if (current.trim() === segment.trim()) return 'skip:same';
    await writePlotExtraToFloor({
      messageId,
      saveContent: segment,
      presetName: typeof extra[QRF_PLOT_PRESET] === 'string' ? extra[QRF_PLOT_PRESET] : '',
      roundId: makeRoundId(),
      taskResults: taskResultsFrom(extra),
    });
    return 'qrf-updated';
  }

  // 升级模式：只改账本，楼层一个字不动。
  const store = resolveChatStateStore();
  const chatKey = resolveChatKey(ctx.state.chatKey);
  const loaded = store.loadStash(chatKey);
  const stash = loaded.stash;
  const entry = stash.entries.find(item => item.floorId === messageId);
  if (!entry) return 'skip:no-entry';
  const landing = activeLanding(entry);
  if (!landing) return 'skip:no-landing';
  const before = plotSegmentOf(landing.finalText);
  if (before !== null && before.trim() === segment.trim()) return 'skip:same';

  // 楼层里改的是 `<plot>` 段：把它当作这一版的新全文。逐任务回传保持原样 ——
  // 那是"AI 当时回了什么"的记录，用户手改的是最终注入，不是回传。
  const next = {
    ...stash,
    entries: stash.entries.map(item =>
      item.floorId !== messageId
        ? item
        : {
            ...item,
            floorText: floor.message,
            landings: item.landings.map(version =>
              version.id === landing.id ? { ...version, finalText: segment } : version,
            ),
          },
    ),
  };
  store.saveStash(next);
  return 'stash-updated';
}

/**
 * 楼层编辑事件的等待队列。导出是为了能在没有酒馆事件的环境里直接测（`tools/plot-parity`）。
 *
 * 推进期间不写盘，事件按到达顺序攒着；推进结束后逐条补同步。每条同步内部都会
 * 重新 loadStash，因此读到的一定是推进写完之后的最新账本，不会拿旧快照盖掉成果。
 * 同步进行中（busy）到达的事件同样排队，不再像以前那样直接 return 丢掉。
 */
export interface PendingEditQueue {
  /** 收到一次编辑事件 */
  push(messageId: number): void;
  /** 卸载时清掉等待中的事件与定时器 */
  stop(): void;
}

export interface PendingEditQueueOptions {
  /** 推进正在跑（send-gate 的 run() 全程置位的 ctx.state.locked）：为真时只排队 */
  isRunning: () => boolean;
  /** 真正同步一次 */
  sync: (messageId: number) => Promise<string>;
  /** 同步结果的处理（日志） */
  onResult?: (messageId: number, result: string) => void;
  /** 等推进结束的检查间隔（毫秒），测试里可给小值 */
  pollMs?: number;
}

export function createPendingEditQueue(options: PendingEditQueueOptions): PendingEditQueue {
  const pending: number[] = [];
  const pollMs = options.pollMs ?? 200;
  let busy = false;
  let stopped = false;
  let wakeTimer: ReturnType<typeof setTimeout> | null = null;

  /** 一次只跑一条：按序补同步，跑完再接上下一条（含 busy 期间新到的）。 */
  const drain = async (): Promise<void> => {
    if (stopped || busy || options.isRunning() || pending.length === 0) return;
    const messageId = pending.shift()!;
    busy = true;
    try {
      const result = await options.sync(messageId);
      options.onResult?.(messageId, result);
    } catch (error) {
      console.warn('[剧情推进助手] 楼层改动同步失败', error);
    } finally {
      busy = false;
    }
    wake();
  };

  function wake(): void {
    if (stopped || pending.length === 0) return;
    if (options.isRunning()) {
      // 还在推进：排队等它跑完，期间一次盘都不写。
      if (wakeTimer === null) {
        wakeTimer = setTimeout(() => {
          wakeTimer = null;
          wake();
        }, pollMs);
      }
      return;
    }
    if (busy) return;
    void drain();
  }

  return {
    push(messageId) {
      if (stopped) return;
      pending.push(messageId);
      wake();
    },
    stop() {
      stopped = true;
      pending.length = 0;
      if (wakeTimer !== null) {
        clearTimeout(wakeTimer);
        wakeTimer = null;
      }
    },
  };
}

/**
 * 挂上「楼层编辑」监听。返回的 `stop()` 由 `ctx.state.detachListeners` 一起收尾。
 */
export function mountFloorSync(ctx: RerushContext): FloorSyncHandle {
  const queue = createPendingEditQueue({
    // run() 从置 true 到 finally 的 finishUi() 全程锁着 state.locked，
    // 引擎那几次整份 saveStash 都落在这个窗口里。
    isRunning: () => ctx.state.locked === true,
    sync: messageId => syncFloorEdit(ctx, messageId),
    onResult: (messageId, result) => {
      if (result !== 'skip:not-user' && result !== 'skip:no-plot' && result !== 'skip:same') {
        console.info(`[剧情推进助手] 楼层 ${messageId} 改动已同步：${result}`);
      }
    },
  });
  const handler = (messageId: number): void => {
    if (typeof messageId !== 'number' || !Number.isFinite(messageId)) return;
    queue.push(messageId);
  };
  const off = eventOn(tavern_events.MESSAGE_EDITED, handler);
  return {
    stop: () => {
      queue.stop();
      try {
        off.stop();
      } catch (error) {
        console.warn('[剧情推进助手] 卸掉楼层编辑监听失败', error);
      }
    },
  };
}
