/**
 * plot/log-flow.ts — 运行日志的「什么时候落盘」
 *
 * `log-model.ts` 只管数据长什么样，这里管**把数据写进聊天变量**这件事。
 * 分成两层的原因很简单：数据层要能纯函数测，写盘那半截摸酒馆接口。
 *
 * ## 为什么要节流
 *
 * 一轮推进可能跑十几个任务、耗时十几分钟。每跑完一个任务就整份写一次聊天变量，
 * 等于把「找结论」这件事的 IO 量翻一倍，而且每次 `replaceVariables` 都是整份变量表重写 ——
 * 日记账不该按秒结算。
 *
 * 所以：写完先攥在内存里，400ms 内的多次修改合并成一次写盘；
 * 但 `finish` 例外，它必须立刻落盘 —— 那是「这一轮结束了」的唯一标记，
 * 不写下去的话用户刷新页面会看到一轮永远「进行中」的记录。
 *
 * ## 为什么失败不抛
 *
 * 日志是旁路。写不进去只该在控制台留一句，不该让用户这一轮的剧情推进白跑。
 */

import { entryFromResult, finishRound, createLog, putTaskEntry, startRound, type LogTaskEntry, type PlotRunLog } from './log-model';
import type { TaskLogInfo } from './eng/engine';
import type { PlotTask } from './eng/task-model';
import type { ChatStateStore } from './state';

/** 两次写盘之间至少隔这么久（毫秒）。 */
export const LOG_FLUSH_DELAY_MS = 400;

export interface PlotLogWriter {
  /**
   * 开一轮。`resume=true` 时保留同楼层上一轮已跑完的任务记录（断点续跑）；
   * `rerunTaskIds` 是这一轮要重跑的任务，它们上一轮的旧记录会被摘掉。
   */
  start(init: {
    floorId: number;
    roundIndex: number;
    presetName: string;
    resume?: boolean;
    rerunTaskIds?: string[];
  }): void;
  /** 记一个任务的结果（成功与失败都记）。 */
  task(info: TaskLogInfo<PlotTask>): void;
  /** 收尾：写结束时间与整体状态，并且**立刻**落盘。 */
  finish(error: string | null): void;
  /** 手动落盘（测试与「用户点刷新前先冲一下」用）。 */
  flush(): void;
  /** 当前内存里的日志（面板导出 md 时用得到，测试里也靠它断言）。 */
  snapshot(): PlotRunLog;
}

export interface LogWriterOptions {
  store: ChatStateStore;
  now?: () => number;
  flushDelayMs?: number;
  /** 定时器注入，测试里换成同步收集，避免真的等 400ms */
  schedule?: (run: () => void, delayMs: number) => void;
}

export function createLogWriter(options: LogWriterOptions): PlotLogWriter {
  const store = options.store;
  const now = options.now ?? (() => Date.now());
  const flushDelayMs = Number.isFinite(options.flushDelayMs) ? Math.max(0, Number(options.flushDelayMs)) : LOG_FLUSH_DELAY_MS;
  const schedule = options.schedule ?? ((run: () => void, delayMs: number) => void setTimeout(run, delayMs));

  /** 懒加载：用户一晚上没开过日志页，就没必要在每次发送时读一遍聊天变量。 */
  let log: PlotRunLog | null = null;
  /** 当前正在写的那一轮锚在哪个楼层；null 表示还没 `start`。 */
  let floorId: number | null = null;
  let timerPending = false;

  const ensure = (): PlotRunLog => {
    if (log) return log;
    try {
      log = store.loadLog().log;
    } catch (error) {
      console.warn('[剧情推进助手] 读取运行日志失败，本轮日志从头记起', error);
      log = createLog();
    }
    return log;
  };

  const flush = (): void => {
    timerPending = false;
    if (!log) return;
    try {
      store.saveLog(log);
    } catch (error) {
      console.warn('[剧情推进助手] 写运行日志失败', error);
    }
  };

  const scheduleFlush = (): void => {
    if (timerPending) return;
    timerPending = true;
    schedule(flush, flushDelayMs);
  };

  return {
    start(init) {
      const base = ensure();
      log = startRound(base, {
        roundIndex: Number(init.roundIndex) || 1,
        floorId: Number(init.floorId),
        presetName: String(init.presetName ?? ''),
        startedAt: now(),
        keepTasks: init.resume === true,
        rerunTaskIds: init.rerunTaskIds,
      }).log;
      floorId = Number(init.floorId);
      scheduleFlush();
    },

    task(info) {
      if (floorId === null) return;
      const entry: LogTaskEntry = entryFromResult(info.result, {
        taskName: info.result.taskName || info.task.name || info.result.taskId,
        stage: info.result.stage ?? 0,
        order: info.result.order ?? 0,
        attempt: info.attempt,
        promptPreview: info.promptPreview,
        promptMessages: info.promptMessages,
        startedAt: info.startedAt,
        // `entryFromResult` 用 `now - startedAt` 算耗时；这里把已经量好的时长还原成同一个终点，
        // 免得再取一次时钟、两次取值之间还夹着回调，耗时对不上。
        now: info.startedAt + Math.max(0, Number(info.durationMs) || 0),
        error: info.error,
      });
      log = putTaskEntry(ensure(), floorId, entry);
      scheduleFlush();
    },

    finish(error) {
      if (floorId === null) {
        // 一轮还没开始就结束了（比如第一个任务之前就中止）：不该凭空造一条空记录。
        return;
      }
      log = finishRound(ensure(), floorId, now(), error);
      flush();
    },

    flush,

    snapshot() {
      return ensure();
    },
  };
}
