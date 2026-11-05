/**
 * 当前聊天的稳定标识。
 *
 * 为什么不能只用 `state.chatKey`：那个值只在 `chat_id_changed` 事件里写，脚本刚加载、
 * 还没切过聊天时它是空的 —— 而暂存账要按聊天分家，空 key 会让两份不同聊天的账互相盖掉。
 * 所以以酒馆上下文的 `chatId` 为准，事件里那份只当兜底。
 */

import { stContext } from '../tavern';

export function resolveChatKey(stateKey?: string | null): string {
  const chatId = stContext()?.chatId;
  if (typeof chatId === 'string' && chatId.trim()) return chatId.trim();
  if (typeof chatId === 'number') return String(chatId);
  if (typeof stateKey === 'string' && stateKey) return stateKey;
  return '';
}
