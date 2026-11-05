/**
 * 面板侧存取暂存的唯一入口。
 *
 * 面板跑在 iframe 里，和引擎共用同一份聊天变量；但两边**不该**各自 `getVariables`
 * 再各自拼 key —— 一边按 `chatId`、一边按 `state.chatKey`，切过聊天之后就会各写各的，
 * 面板上看得见、引擎里续不上。所以 key 的取法只留 `plot/chat-key.ts` 一份。
 */

import { resolveChatKey } from './chat-key';
import { resolveChatStateStore } from './data/chat-vars';
import type { Stash } from './stash-model';

export interface PanelStash {
  stash: Stash;
  chatKey: string;
  /** 账本读坏了会带一句原因（面板上要显示，否则用户只看到「空」） */
  warning: string | null;
}

/** 重新从聊天变量里读一次。面板在打开、点刷新、保存之后都调它。 */
export function readPanelStash(stateKey?: string | null): PanelStash {
  const chatKey = resolveChatKey(stateKey);
  const loaded = resolveChatStateStore().loadStash(chatKey);
  return {
    stash: loaded.stash,
    chatKey,
    warning: loaded.warning ? String(loaded.warning) : null,
  };
}

/**
 * 保存整份暂存账。
 *
 * 刻意是「整份替换」而不是「打补丁」：面板的编辑本来就是在一份快照上改完再交，
 * 打补丁的话，用户删掉的那一版会因为补丁里没有它而留在旧账里 —— 看起来像没保存。
 */
export function savePanelStash(stash: Stash): void {
  resolveChatStateStore().saveStash(stash);
}
