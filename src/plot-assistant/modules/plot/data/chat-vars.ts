/**
 * 聊天变量的真实读写口。
 *
 * 单独一个文件，是因为 `state.ts` 要能在 `tools/plot-parity` 里单独编译：
 * 那边用 `tsc --ignoreConfig` 只编入口与它的 import，拿不到 `@types/function/*.d.ts`
 * 里的全局声明。把「碰酒馆全局」的部分切出来，纯逻辑就能照常被测。
 */

import { createChatStateStore, type ChatStateStore, type VariableStorage } from '../state';

/**
 * 酒馆助手的聊天变量表。
 *
 * `replaceVariables` 是**整份替换**，所以这里不给「追加」的假象 ——
 * 谁调 `writeAll` 谁必须自己先把全部读出来。这条约束由 `createChatStateStore` 保证。
 */
export function resolveChatStorage(): VariableStorage {
  return {
    readAll: () => getVariables({ type: 'chat' }) || {},
    writeAll: (next) => replaceVariables(next, { type: 'chat' }),
  };
}

/** 真实环境用的账本存储。 */
export function resolveChatStateStore(): ChatStateStore {
  return createChatStateStore(resolveChatStorage());
}
