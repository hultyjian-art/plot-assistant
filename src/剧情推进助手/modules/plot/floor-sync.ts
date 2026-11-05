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
 * 不会自己触发自己；再加一个 `busy` 闸，双保险。
 */

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
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
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
 * 挂上「楼层编辑」监听。返回的 `stop()` 由 `ctx.state.detachListeners` 一起收尾。
 */
export function mountFloorSync(ctx: RerushContext): FloorSyncHandle {
  let busy = false;
  const handler = (messageId: number): void => {
    if (busy) return;
    if (typeof messageId !== 'number' || !Number.isFinite(messageId)) return;
    busy = true;
    void syncFloorEdit(ctx, messageId)
      .then(result => {
        if (result !== 'skip:not-user' && result !== 'skip:no-plot' && result !== 'skip:same') {
          console.info(`[剧情推进助手] 楼层 ${messageId} 改动已同步：${result}`);
        }
      })
      .catch(error => console.warn('[剧情推进助手] 楼层改动同步失败', error))
      .finally(() => {
        busy = false;
      });
  };
  const off = eventOn(tavern_events.MESSAGE_EDITED, handler);
  return {
    stop: () => {
      try {
        off.stop();
      } catch (error) {
        console.warn('[剧情推进助手] 卸掉楼层编辑监听失败', error);
      }
    },
  };
}
