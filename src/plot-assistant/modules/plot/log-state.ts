/**
 * plot/log-state.ts — 面板读运行日志的那一道口
 *
 * 面板是只读的：它不写日志，也不修日志。写日志只有引擎旁边那个 `log-flow.ts`。
 * 所以这里只包一层「从聊天变量里拿出来」，让面板不必知道存储键叫什么。
 */

import { resolveChatStateStore } from './data/chat-vars';
import type { PlotRunLog } from './log-model';

export interface PanelLog {
  log: PlotRunLog;
  /** 读坏时的警告码（`log_unreadable`）；正常为 null */
  warning: string | null;
}

export function readPanelLog(): PanelLog {
  const loaded = resolveChatStateStore().loadLog();
  return { log: loaded.log, warning: loaded.warning };
}
