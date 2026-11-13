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

import type { RerushContext } from '../types';
import { resolveChatKey } from './chat-key';
import { resolveChatStateStore } from './data/chat-vars';
import { writePlotExtraToFloor } from './data/chat-write';
import { QRF_PLOT, QRF_PLOT_PRESET, makeRoundId } from './eng/writeback';
import { landingSegmentOf, plotSegmentOf } from './stash-apply';
import { collectTextTagMap, syncTextIntoTagRecords } from './stash-edit';
import { activeLanding } from './stash-model';
import { enqueueWorldbookStashRecords } from './worldbook-write';

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

/** 这一版里第一个有标签的任务 id —— 正文里出现「谁也不认识」的新标签时记到它名下。 */
function firstTaskIdOf(landing: {
  taskTags?: Record<string, unknown>;
  carriedTags?: Record<string, unknown>;
}): string | undefined {
  const own = Object.keys(landing.taskTags ?? {});
  if (own.length > 0) return own[0];
  const carried = Object.keys(landing.carriedTags ?? {});
  return carried[0];
}

/**
 * 一次同步。导出是为了能在没有酒馆事件的环境里直接测（`tools/plot-parity`）。
 */
export async function syncFloorEdit(ctx: RerushContext, messageId: number): Promise<string> {
  const floors = getChatMessages(messageId) as unknown as FloorLike[];
  const floor = Array.isArray(floors) ? floors[0] : undefined;
  if (!floor || floor.role !== 'user') return 'skip:not-user';

  if (ctx.settings.plot.stashMode === 'qrf') {
    // qrf 模式楼层里认 `<plot>` 段（上游语义）；没有 plot 段说明不是这一路，跳过。
    const segment = plotSegmentOf(floor.message);
    if (!segment) return 'skip:no-plot';
    const extra = floor.extra ?? {};
    const current = typeof extra[QRF_PLOT] === 'string' ? extra[QRF_PLOT] : '';
    if (current.trim() === segment.trim()) return 'skip:same';
    await writePlotExtraToFloor({
      messageId,
      saveContent: segment,
      presetName: typeof extra[QRF_PLOT_PRESET] === 'string' ? extra[QRF_PLOT_PRESET] : '',
      roundId: makeRoundId(),
      // 2026-11-12 起 qrf 只记一份标签块，不再写 qrf_plot_tasks，所以这里不传 taskResults。
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
  // 升级模式楼层正文就是成果全文；没有 plot 壳时拿整篇比，不能直接跳过。
  // 空楼层是有效编辑（用户清空正文）：要按空串同步，才能把正文标签清成 tombstone。
  const messageText = typeof floor.message === 'string' ? floor.message : '';
  const segment = landingSegmentOf(messageText) ?? (messageText.trim() === '' ? '' : null);
  if (segment === null) return 'skip:no-plot';
  const before = landingSegmentOf(landing.finalText);
  if (before !== null && before.trim() === segment.trim()) return 'skip:same';

  // 楼层里改的是 `<plot>` 段：把它当作这一版的新全文。
  //
  // 2026-11-12 起，正文改动要**同时落回标签数据**（用户拍板：数据主源是标签数据，
  // 成品正文是它的投影）。以前只写 finalText，标签数据不动，下一楼层继承又抄回去，
  // 用户在楼层里删掉/改掉的标签会复活。
  //
  // 复用面板保存的同一套差量函数（stash-edit 的 syncTextIntoTagRecords），
  // 不另写一份 —— 两条同步路一旦各写一套，迟早漂移。
  const synced = landing.taskTags
    ? syncTextIntoTagRecords(landing.taskTags, segment, {
        reassignTo: firstTaskIdOf(landing),
        inheritedRecords: landing.carriedTags,
        textTagNames: landing.textTagNames ?? [...collectTextTagMap(landing.finalText).keys()],
        onlyKnownTags: landing.textTagNames === undefined,
      }).records
    : landing.taskTags;

  const next = {
    ...stash,
    entries: stash.entries.map(item =>
      item.floorId !== messageId
        ? item
        : {
            ...item,
            floorText: floor.message,
            landings: item.landings.map(version =>
              version.id === landing.id
                ? { ...version, finalText: segment, ...(synced ? { taskTags: synced } : {}) }
                : version,
            ),
          },
    ),
  };
  store.saveStash(next);
  // 楼层正文改了，正在生效的世界书条目也要跟上同一份标签数据。
  enqueueWorldbookStashRecords(ctx, synced);
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
