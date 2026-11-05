/**
 * plot/preview-flow.ts — 「这一次到底会发给 AI 什么」的只读预演
 *
 * 为什么要有它：面板上看到的永远是**模板**（`$8`、`$1`、`{{zhaohui}}` 原样写着），
 * 而用户真正想确认的是「点这一次发送，AI 收到的到底是一段什么字」。
 * 以前的「最终注入指令预览」只把模板贴出来，占位符一个都没换，等于没预览。
 *
 * 三条纪律：
 *
 * 1. **和真跑用同一套零件**。这里不新写一套渲染逻辑，`buildRoundReplacements` /
 *    `renderTaskMessages` / `performReplacements` 全是真跑路径上那几个函数 ——
 *    否则预览和实际总会差一处，而且差在哪谁都查不出来。
 * 2. **只读**。不读暂存、不写日志、不碰设置、不发请求。它唯一的作用是把字拼出来。
 *
 * ## 为什么这里不算「最终注入指令」
 *
 * 那一段是**我们自己拼、自己写进楼层**的产物，面板上本来就有它的模板；
 * 把占位符换掉再预览一遍，对用户判断「AI 会读到什么」没有帮助（用户 2026-11-02 反馈）。
 * 用户真正要确认的是**发出去的那几条请求**，所以这里只渲染任务 messages。
 * 3. **不装懂**。取数失败（预设读不出、世界书读不到）就如实说出来，
 *    不拿一份残缺的提示词冒充「就是这样」。
 */

import type { RerushContext } from '../types';
import { findStoredPreset } from './data/preset-store';
import { describePresetProblem, readPlotPreset } from './data/acu-presets';
import { buildSummaryIndexText } from './data/read-tables';
import { importPresetConfig } from './eng/preset-import';
import type { PlotRoundMessage } from './eng/engine';
import { buildHistoryDigest, pickHistoryMessages } from './eng/history';
import { getPlotFromHistory } from './eng/history-plot';
import { renderTaskMessages } from './eng/messages';
import { buildRoundReplacements } from './eng/round-inputs';
import { normalizeRound, selectTasksForRound } from './eng/schedule';
import { buildTagMap } from './eng/tags';
import { buildPlotWorldbookTexts } from './data/worldbook-hits';
import { resolveChatStateStore } from './data/chat-vars';
import { resolveChatKey } from './chat-key';
import { attachLandingsToChat } from './stash-model';
import { readPresetPlaceholders } from './preset-edit';
import { readAcuTables } from './data/read-tables';
import { readWorldbookEntries } from './run-in-flow';

/** 一条要发出去的 message（role 已归一化）。 */
export interface PlotPreviewMessage {
  role: string;
  content: string;
}

/** 一个任务这一次会发的全部 message。 */
export interface PlotPreviewTask {
  taskId: string;
  taskName: string;
  stage: number;
  order: number;
  messages: PlotPreviewMessage[];
}

/** 一整轮的预演结果。 */
export interface PlotPreview {
  presetName: string;
  round: number;
  tasks: PlotPreviewTask[];
  /** 这一轮按轮次规则被跳过、或被跳过原因说明的任务。 */
  skipped: { taskId: string; reason: string }[];
}

export type PlotPreviewResult = { ok: true; preview: PlotPreview } | { ok: false; note: string };

/** 聊天楼层 → 渲染层认识的样子（`mes` + `is_user`，其余键平铺）。 */
function toPlotMessageFrom(raw: Record<string, unknown>): Record<string, unknown> {
  const extra = (raw as { extra?: Record<string, unknown> }).extra;
  return {
    ...(extra ?? {}),
    is_user: raw.role === 'user',
    mes: raw.message,
  };
}

/**
 * 预演一轮剧情推进。
 *
 * `userText` 就是用户准备发出去的那句话 —— 它进 `$8`，并且参与世界书的关键词扫描，
 * 所以预览必须拿它来算，不能拿空串糊弄（那会让 `$1` 少掉一批本该命中的条目）。
 */
export async function previewPlotRound(ctx: RerushContext, userText = ''): Promise<PlotPreviewResult> {
  const plotSettings = ctx.settings.plot;
  const wantedPreset = plotSettings.presetName.trim();
  if (wantedPreset === '') return { ok: false, note: '还没选剧情推进预设，先在第 3 页选一个。' };

  const stored = findStoredPreset(plotSettings.presets, wantedPreset);
  let preset: Record<string, unknown>;
  if (stored) {
    preset = stored.data as Record<string, unknown>;
  } else {
    const outcome = readPlotPreset(wantedPreset);
    if (!outcome.ok) return { ok: false, note: describePresetProblem(outcome) };
    preset = outcome.details as Record<string, unknown>;
  }

  const config = importPresetConfig(preset);
  const round = normalizeRound(plotSettings.roundIndex + 1);
  const placeholders = readPresetPlaceholders(preset);
  const historyLimit = Math.max(1, config.contextTurnCount);

  const rawChat = getChatMessages('0-{{lastMessageId}}') as unknown as Record<string, unknown>[];
  const chat = rawChat.map(toPlotMessageFrom);
  // 升级模式的上一轮成果在账本里、不在楼层字段上：和真跑那条链一样先贴回去，
  // 否则"预览这次会发什么"里的 `$6` 会是空的，预览与实跑对不上。
  const useStash = plotSettings.stashMode !== 'qrf';
  const stash = useStash ? resolveChatStateStore().loadStash(resolveChatKey(ctx.state.chatKey)).stash : null;
  const historyChat = stash ? attachLandingsToChat(chat, rawChat as never, stash, config.name) : chat;
  const historyDigest = buildHistoryDigest(pickHistoryMessages(chat as never, userText, historyLimit));
  const previousPlot = getPlotFromHistory(historyChat as never, {}, config.name);
  const recentText = rawChat
    .slice(-historyLimit)
    .map((item) => String(item.message ?? ''))
    .join('\n');

  const tableResult = readAcuTables();
  const summaryIndex = buildSummaryIndexText({ tables: tableResult.tables });

  const { bookNames, entriesByBook } = await readWorldbookEntries({
    source: plotSettings.worldbookSource,
    books: plotSettings.worldbookBooks,
  });
  const worldbook = buildPlotWorldbookTexts({
    bookNames,
    entriesByBook: entriesByBook as never,
    baseScanText: [recentText, userText].filter(Boolean).join('\n'),
    // 预览必须跟真跑一样认条目勾选，否则用户会照着预览放行、实际生成时却少几条
    enabledEntries: plotSettings.worldbookEntries,
  });

  const replacements = buildRoundReplacements({
    worldbookContent: worldbook.content,
    worldbookDatabaseExcluded: worldbook.contentExcludingDatabase,
    summaryIndex,
    historyDigest,
    previousPlot,
    userInput: userText,
    strengths: {
      sulv1: placeholders.sulv1,
      sulv2: placeholders.sulv2,
      sulv3: placeholders.sulv3,
      sulv4: placeholders.sulv4,
    },
    zhaohui: placeholders.zhaohui,
  });

  const enabled = config.tasks.filter((task) => task.enabled !== false);
  const selection = selectTasksForRound(enabled, round);
  // ── 历史标签表：上一轮 `<plot>` 里的 `<标签>内容</标签>` ──
  //
  // 与真跑路径（`round.ts`）同一张表：`{{标签}}` 查不到就吐 `<标签></标签>` 空壳，
  // 而且不报错。预览必须跟真跑对得上，否则用户照着预览放行，实际发出去却是空标签。
  const historyTagMap = buildTagMap(String(previousPlot ?? ''), null);
  const tasks: PlotPreviewTask[] = [];
  for (const task of selection.due) {
    const messages: PlotRoundMessage[] = renderTaskMessages(task, {
      replacements,
      worldbookContent: worldbook.content,
      relayTagMap: null,
      historyTagMap,
    });
    tasks.push({
      taskId: task.id,
      taskName: task.name || task.id,
      stage: Number(task.stage ?? 1),
      order: Number(task.order ?? 0),
      messages: messages.map((message) => ({ role: message.role, content: message.content })),
    });
  }

  return {
    ok: true,
    preview: {
      presetName: stored ? stored.name : config.name,
      round,
      tasks,
      skipped: selection.skipped.map((item) => ({ taskId: item.id, reason: String(item.decision.reason) })),
    },
  };
}
