/**
 * plot/stash-port-flow.ts — 暂存区导出/导入的副作用层
 *
 * `stash-port.ts` 是纯函数（不碰酒馆）；这里只做三件必须碰酒馆的事：
 * 读当前聊天的全部楼层（导入要拿它当落点）、把账本序列化成文本、把结果写回聊天变量。
 *
 * 面板只调这里，不自己 `getVariables` / `getChatMessages` —— 和 `stash-state.ts`
 * 同一个理由：key 的取法与读写的时机只留一个地方，否则切过聊天之后两边会对不上。
 */

import type { Stash } from './stash-model';
import {
  applyStashImport,
  buildStashPortFile,
  parseStashPort,
  planStashImport,
  serializeStashPort,
  type ImportPlan,
  type ImportTarget,
  type StashPortFile,
} from './stash-port';

/** `getChatMessages` 回来的一层，只要用到的三个字段。 */
interface FloorRow {
  message_id?: number;
  message?: string;
  role?: string;
}

/**
 * 读当前聊天的全部楼层，转成导入时的落点。
 *
 * 含第 0 层（开场白）：`'0-{{lastMessageId}}'` 的范围是从 0 开始的，和
 * `run-in-flow.ts:222`、`stash-migrate.ts:123` 同一个取法。
 * 用户楼层的判据是 `role === 'user'`（`stash-migrate.ts:131` 同款）——
 * 但**只有「本轮用户楼层不足三层」那条兜底会用到它**，正常配对只数楼层号。
 */
export function readImportTargets(): ImportTarget[] {
  const floors = getChatMessages('0-{{lastMessageId}}') as unknown as FloorRow[];
  if (!Array.isArray(floors)) return [];
  const targets: ImportTarget[] = [];
  for (const floor of floors) {
    if (!floor) continue;
    const floorId = typeof floor.message_id === 'number' ? floor.message_id : -1;
    if (floorId < 0) continue;
    targets.push({
      floorId,
      floorText: typeof floor.message === 'string' ? floor.message : '',
      isUser: floor.role === 'user',
    });
  }
  return targets;
}

/** 账本 → 可直接下载的文件文本。`now` 由调用方给，方便测试。 */
export function exportStashToText(stash: Stash, chatKey: string, now: number): string {
  return serializeStashPort(buildStashPortFile(stash, chatKey, now));
}

/** 解析+算计划的结果。`ok:false` 时 `error` 是给用户看的一句话。 */
export type ImportPrep =
  | { ok: true; file: StashPortFile; plan: ImportPlan }
  | { ok: false; error: string };

/**
 * 读文件内容 → 校验 → 算配对计划。**不写账本**，冲突要不要覆盖由面板问用户。
 *
 * 一处刻意的取舍：源文件里一笔账都没有时直接报错，而不是返回一个空计划。
 * 空计划落到面板上就是「导入成功，但什么都没变」，用户没法分辨是文件坏了还是
 * 当前聊天没地方挂 —— 说清楚比装作成功好。
 */
export function prepareStashImport(text: string, stash: Stash): ImportPrep {
  const parsed = parseStashPort(text);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  if (parsed.file.entries.length === 0) {
    return { ok: false, error: '这份文件里一笔暂存账都没有。' };
  }
  const plan = planStashImport(parsed.file, readImportTargets(), stash);
  if (plan.pairs.length === 0) {
    return { ok: false, error: '这份文件里的账挂不到当前聊天的任何楼层上。' };
  }
  return { ok: true, file: parsed.file, plan };
}

/** 把计划落到账本上，返回新的账本（调用方负责 `savePanelStash`）。 */
export function commitStashImport(stash: Stash, file: StashPortFile, plan: ImportPlan, now: number): Stash {
  return applyStashImport(stash, file, plan, now);
}
