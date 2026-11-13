/**
 * plot/stash-migrate.ts — 两种成果存放模式之间的一次性迁移
 *
 * 用户 2026-11-03 定的口径：升级模式（成果记在聊天变量的账本里）与 qrf 模式
 * （成果写进楼层 `qrf_plot*`）**互斥**，同一层不能两份都有 —— 两份各写各的，
 * 用户改了一边另一边不跟着动，就会变成「账本说 A、楼层说 B」。
 *
 * 所以切换模式时把已有成果搬过去，再清掉原来那份：
 * - 切到 qrf：账本里每层「正在使用」的那版 → 写成楼层 qrf 字段 → 清空账本；
 * - 切到升级：楼层上的 qrf → 变成账本里的一版（编号 1）→ 摘掉楼层 qrf 字段。
 *
 * 迁移**不抛异常**：一层失败只记一笔，其余照搬，最后把「成了几层、几层没成」报回去。
 * 一条都搬不动的时候宁可留着旧数据（返回 failed），也不要先清后写 —— 那等于删数据。
 */

import { resolveChatKey } from './chat-key';
import { resolveChatStateStore } from './data/chat-vars';
import { clearPlotExtraFromFloor, writePlotExtraToFloor } from './data/chat-write';
import { makeRoundId } from './eng/writeback';
import { plotSegmentOf } from './stash-apply';
import {
  activeLanding,
  createStash,
  makeLandingId,
  saveContentOfLanding,
  trimEntries,
  type StashEntry,
  type StashLanding,
} from './stash-model';
import { QRF_PLOT, QRF_PLOT_PRESET, QRF_PLOT_TASKS_LEGACY } from './eng/writeback';

/** 迁移结果。`failed` 不为 0 时调用方要在面板上说清楚"有几层没搬成"。 */
export interface ModeMigrationResult {
  /** 成功搬过去的楼层数 */
  moved: number;
  /** 没搬成的楼层数（原数据留着不动） */
  failed: number;
  /** 给面板的一句话 */
  note: string;
}

interface FloorLike {
  message_id: number;
  message: string;
  role?: string;
  extra?: Record<string, unknown>;
}

/**
 * 升级模式 → qrf 模式：把账本里每层「正在使用」的那版写进楼层字段，然后清空账本。
 *
 * 只搬「正在使用」的那版：qrf 模式一楼只有一版（ACU 那边的口径），另一版搬不过去。
 */
export async function migrateStashToQrf(ctx: { state: { chatKey: string | null } }): Promise<ModeMigrationResult> {
  const store = resolveChatStateStore();
  const chatKey = resolveChatKey(ctx.state.chatKey);
  const stash = store.loadStash(chatKey).stash;
  if (stash.entries.length === 0) {
    return { moved: 0, failed: 0, note: '账本是空的，没有要搬的成果。' };
  }

  let moved = 0;
  let failed = 0;
  const movedEntries = new Set<StashEntry>();
  for (const entry of stash.entries) {
    const landing = activeLanding(entry);
    if (!landing) {
      failed += 1;
      console.warn('[剧情推进助手] 迁移到 qrf：这一层没有正在使用的版本，跳过', entry.floorId);
      continue;
    }
    const saveContent = saveContentOfLanding(landing);
    if (saveContent === '') {
      failed += 1;
      console.warn('[剧情推进助手] 迁移到 qrf：这一版没有标签数据可写，跳过', entry.floorId);
      continue;
    }
    try {
      await writePlotExtraToFloor({
        messageId: entry.floorId,
        saveContent,
        presetName: landing.presetName,
        roundId: makeRoundId(),
      });
      moved += 1;
      movedEntries.add(entry);
    } catch (error) {
      failed += 1;
      console.warn('[剧情推进助手] 迁移到 qrf 失败（这一层原样留着）', entry.floorId, error);
    }
  }

  // 一层都没搬成就不动账本：先清后写等于删数据。
  // 全部搬成才整本清空；部分成功时只把已搬成的 entries 剔除，没搬成的原样留在账本里。
  if (moved > 0) {
    if (failed === 0) store.saveStash(createStash(chatKey));
    else store.saveStash({ ...stash, entries: stash.entries.filter(entry => !movedEntries.has(entry)) });
  }
  return {
    moved,
    failed,
    note:
      failed > 0
        ? `${moved} 层已写进楼层字段，${failed} 层没搬成，没搬成的还留在账本里。`
        : `已把 ${moved} 层写进楼层字段，账本已清空。`,
  };
}

/**
 * qrf 模式 → 升级模式：把楼层上的 qrf 变成账本里的一版（编号 1），再摘掉楼层字段。
 *
 * 只认用户楼层：`qrf_plot` 只该挂在用户层上（那是"这一轮用户说了什么 + 产出了什么"）。
 */
export async function migrateQrfToStash(ctx: { state: { chatKey: string | null } }): Promise<ModeMigrationResult> {
  const store = resolveChatStateStore();
  const chatKey = resolveChatKey(ctx.state.chatKey);
  const stash = store.loadStash(chatKey).stash;

  const floors = getChatMessages('0-{{lastMessageId}}') as unknown as FloorLike[];
  if (!Array.isArray(floors) || floors.length === 0) {
    return { moved: 0, failed: 0, note: '这个聊天还没有楼层。' };
  }

  const now = Date.now();
  const added: StashEntry[] = [];
  for (const floor of floors) {
    if (floor?.role !== 'user') continue;
    const extra = floor.extra ?? {};
    const plot = typeof extra[QRF_PLOT] === 'string' ? extra[QRF_PLOT] : '';
    if (plot.trim() === '') continue;
    const presetName = typeof extra[QRF_PLOT_PRESET] === 'string' ? extra[QRF_PLOT_PRESET] : '';
    // 版本全文 = 楼层正文里的 `<plot>` 段；楼层没有 plot 段时退回 qrf 原文。
    //
    // 老 qrf 页面上的 `qrf_plot_tasks` 原话一并带进账本：新账不再写 taskRaw，但旧账
    // 只有靠它才能把当时的标签数据恢复出来；下一次推进落盘后新账会覆盖成 taskTags。
    const finalText = plotSegmentOf(floor.message) ?? plot;
    const rawTasks = extra[QRF_PLOT_TASKS_LEGACY];
    const taskRaw = rawTasks && typeof rawTasks === 'object'
      ? Object.fromEntries(Object.entries(rawTasks).filter(([, raw]) => typeof raw === 'string')) as Record<string, string>
      : undefined;
    const landing: StashLanding = {
      id: makeLandingId(floor.message_id, now, []),
      createdAt: now,
      finalText,
      presetName,
      taskRaw,
      complete: true,
      seq: 1,
    };
    added.push({
      floorId: floor.message_id,
      floorText: floor.message,
      presetName,
      createdAt: now,
      lastUsedAt: now,
      landings: [landing],
      activeLandingId: landing.id,
      working: null,
      state: 'complete',
    });
  }

  if (added.length === 0) {
    return { moved: 0, failed: 0, note: '楼层上没有 qrf 字段，没有要搬的成果。' };
  }

  const next = { ...stash, entries: trimEntries([...stash.entries, ...added]) };
  store.saveStash(next);

  let cleared = 0;
  let failed = 0;
  for (const entry of added) {
    try {
      if (await clearPlotExtraFromFloor(entry.floorId)) cleared += 1;
    } catch (error) {
      failed += 1;
      console.warn('[剧情推进助手] 摘掉楼层 qrf 失败（账本已经搬好了）', entry.floorId, error);
    }
  }

  return {
    moved: added.length,
    failed,
    note:
      failed > 0
        ? `已把 ${added.length} 层搬进账本，${failed} 层的楼层字段没清掉（不影响使用）。`
        : `已把 ${added.length} 层搬进账本，楼层字段已清掉 ${cleared} 层。`,
  };
}
