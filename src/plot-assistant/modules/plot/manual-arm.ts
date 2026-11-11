/**
 * 「手动触发」的预约表读写口（批 68 工位 B）。
 *
 * 预约存在聊天变量里（换聊天＝另一份账），值是被预约任务的锚点名数组
 * （锚点名 = 预设名::任务id，见 plot/floor-anchor.ts）。楼层按钮只调这里两个函数，
 * 不直接碰聊天变量；每轮发送前由 run-in-flow.ts 顺手清死条目、跑完解除预约。
 *
 * 为什么自己组装 store：兄弟文件用的 `resolveChatStateStore()` 返回类型标的是
 * 窄的 `ChatStateStore`，看不到新加的 loadArmed / saveArmed；这里用同一个
 * `createChatStateStore` 配真实聊天存储，拿到的就是全量版本（家风一致）。
 */

import { resolveChatStorage } from './data/chat-vars';
import { createChatStateStore } from './state';

function armedStore(): ReturnType<typeof createChatStateStore> {
  return createChatStateStore(resolveChatStorage());
}

/** 读当前聊天的预约表：坏值、非数组一律当空表，数组里只留字符串。 */
export function readArmedTaskIds(): string[] {
  return armedStore().loadArmed();
}

/** 整表写回（不是追加）。传入的应是已经清理 / 解除后的最终名单。 */
export function setArmedTaskIds(ids: string[]): void {
  armedStore().saveArmed(ids);
}

/**
 * 纯函数：滤掉已经不在当前预设「启用且手动触发」名单里的锚点名。
 * 改名、删任务、停用、关掉手动触发后留下的死预约都靠它清掉。
 */
export function pruneArmed(armed: string[], liveAnchorNames: ReadonlySet<string>): string[] {
  return armed.filter(id => liveAnchorNames.has(id));
}

/**
 * 纯函数：把预约表里的锚点名翻成引擎认识的短任务 id。
 *
 * 预约表存锚点名，是为了按聊天分家、防不同预设串账；引擎的 armedTaskIds
 * 只认任务自己的 id（见 eng/schedule.ts）。这一层必须显式翻译，不能把锚点名直接塞过去。
 * 只翻译当前预设里存在的任务；翻译不出来的锚点名丢弃（它们本应在 pruneArmed 清掉）。
 */
export function toArmedTaskIds(
  armedAnchorNames: readonly string[],
  taskAnchorNames: ReadonlyMap<string, string>,
): Set<string> {
  const armed = new Set(armedAnchorNames);
  const ids = new Set<string>();
  for (const [taskId, anchorName] of taskAnchorNames) {
    if (armed.has(anchorName)) ids.add(taskId);
  }
  return ids;
}
