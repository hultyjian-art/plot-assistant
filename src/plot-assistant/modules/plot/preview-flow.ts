/**
 * plot/preview-flow.ts — 「这一次到底会发给 AI 什么」的只读预演
 *
 * 为什么要有它：面板上看到的永远是**模板**（`$8`、`$1` 原样写着），
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
import { buildSummaryIndexText, readAcuTables } from './data/read-tables';
import { pickSummaryIndexEntry } from './eng/data-format';
import { importPresetConfig } from './eng/preset-import';
import { applyContextTagFilters } from './eng/context-tags';
import { buildResumePlan } from './eng/resume';
import type { PlotRoundMessage } from './eng/engine';
import { buildHistoryDigest, pickHistoryMessages } from './eng/history';
import { getPlotFromHistory } from './eng/history-plot';
import { renderTaskMessagesAsync } from './eng/messages';
import { buildRoundReplacements } from './eng/round-inputs';
import { selectTasksForFloor } from './eng/schedule';
import { anchorNameOf, readAnchorGap, type AnchorFloor } from './floor-anchor';
import { buildTagMap } from './eng/tags';
import { collectKnownTagNames, tagsNeedingFullRefresh } from './eng/tag-diff';
import { buildPlotWorldbookTexts } from './data/worldbook-hits';
import { resolveChatStateStore } from './data/chat-vars';
import { resolveChatKey } from './chat-key';
import { attachLandingsToChat, collectStashTagMap } from './stash-model';
import { readWorldbookEntries, toPlotMessage } from './run-in-flow';
import { processTavernTemplateText, readRoundIdentity, substituteTavernMacros } from '../tavern';
import { presetImportOptions } from './preset-options';

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
  /** 这次发送按楼层间隔被跳过、或被跳过原因说明的任务。 */
  skipped: { taskId: string; reason: string }[];
}

export type PlotPreviewResult = { ok: true; preview: PlotPreview } | { ok: false; note: string };

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

  const config = importPresetConfig(preset, presetImportOptions(plotSettings));
  const historyLimit = Math.max(0, config.contextTurnCount);
  const presetKey = stored ? stored.name : config.name;

  const rawChat = getChatMessages('0-{{lastMessageId}}') as unknown as Record<string, unknown>[];
  const chat = rawChat.map(toPlotMessage);
  // 触发间隔和真跑用同一套口径：数现存的第几条用户楼层，从新往旧找每个任务自己的锚点。
  const anchorFloors = rawChat as unknown as AnchorFloor[];
  const taskAnchorNames = new Map<string, string>(
    config.tasks.map(task => [task.id, anchorNameOf(presetKey, task.id)]),
  );
  const gapOf = (taskId: string): number | null =>
    readAnchorGap(anchorFloors, taskAnchorNames.get(taskId) ?? '');
  // 预览这一栏显示的是判定用的「第几条用户楼层」，不是绝对楼层号；日志才按绝对楼层号标识。
  const round = anchorFloors.filter((item) => item?.role === 'user').length + 1;
  // 升级模式的上一轮成果在账本里、不在楼层字段上：和真跑那条链一样先贴回去，
  // 否则"预览这次会发什么"里的 `$6` 会是空的，预览与实跑对不上。
  const useStash = plotSettings.stashMode !== 'qrf';
  const stash = useStash ? resolveChatStateStore().loadStash(resolveChatKey(ctx.state.chatKey)).stash : null;
  const historyChat = stash ? attachLandingsToChat(chat, rawChat as never, stash, config.name) : chat;
  const hasTagRules = config.extractRules.length > 0 || config.excludeRules.length > 0;
  const historyDigest = buildHistoryDigest(
    pickHistoryMessages(
      chat as never,
      historyLimit,
      (content) =>
        applyContextTagFilters(String(content ?? ''), {
          extractRules: config.extractRules,
          excludeRules: config.excludeRules,
        }),
      hasTagRules,
    ),
  );
  const previousPlot = getPlotFromHistory(historyChat as never, {}, config.name);
  const recentText = (historyLimit === 0 ? [] : rawChat.slice(-historyLimit))
    .map((item) => String(item.message ?? ''))
    .join('\n');

  // 世界书要先读：`$5` 的第一档要问「世界书里有没有那条纪要索引条目」，表格只是兜底。
  // 顺序与真跑路径（`run-in-flow.ts`）一致，否则预览与实跑对不上。
  const { bookNames, entriesByBook } = await readWorldbookEntries({
    source: plotSettings.worldbookSource,
    books: plotSettings.worldbookBooks,
  });

  const tableResult = readAcuTables();
  const summaryIndex = buildSummaryIndexText({
    tables: tableResult.tables,
    worldbookContent: pickSummaryIndexEntry(entriesByBook as never, bookNames),
  });

  const worldbook = buildPlotWorldbookTexts({
    bookNames,
    entriesByBook: entriesByBook as never,
    baseScanText: [recentText, userText].filter(Boolean).join('\n'),
    // 预览必须跟真跑一样认条目勾选，否则用户会照着预览放行、实际生成时却少几条
    enabledEntries: plotSettings.worldbookEntries,
  });

  const identity = readRoundIdentity();
  const replacements = buildRoundReplacements({
    ...identity,
    worldbookContent: worldbook.content,
    worldbookDatabaseExcluded: worldbook.contentExcludingDatabase,
    summaryIndex,
    historyDigest,
    previousPlot,
    userInput: userText,
  });

  const enabled = config.tasks.filter((task) => task.enabled !== false);
  const selection = selectTasksForFloor(enabled, gapOf);
  // ── 历史标签表：上一轮 `<plot>` 里的 `<标签>内容</标签>` ──
  //
  // 与真跑路径（`round.ts`）同一张表：`{{标签}}` 查不到就吐 `<标签></标签>` 空壳，
  // 而且不报错。预览必须跟真跑对得上，否则用户照着预览放行，实际发出去却是空标签。
  const knownTagNames = collectKnownTagNames(config.tasks, config.directiveTemplate);
  const historyTagMap = buildTagMap(String(previousPlot ?? ''), null, knownTagNames);
  // 与真跑（round.ts）同一口径：{{标签}} 优先看暂存区账本里的上一轮标签投影。
  if (stash) collectStashTagMap(stash).forEach((value, name) => historyTagMap.set(name, value));
  // 预览只读、不算续跑：`null` 起点给出的快照就是真跑「全新一轮」的那张接力表。
  const relayTagMap = buildResumePlan(config.tasks, null).relayTagMap;
  const tasks: PlotPreviewTask[] = [];
  for (const task of selection.due) {
    const messages: PlotRoundMessage[] = await renderTaskMessagesAsync(task, {
      replacements,
      worldbookContent: worldbook.content,
      relayTagMap,
      historyTagMap,
      // 预览要和真跑一致：宏与 EJS 也在发送前处理掉，否则用户看到的是 `{{char}}` 字面量。
      macroReplace: substituteTavernMacros,
      templateProcess: processTavernTemplateText,
    });
    // 与真跑 `round.ts` 同一条差量格式提醒：上一轮标签格式和本轮模式对不上时，
    // 预览里也要看得见这句 system，否则用户照着预览放行、实际请求却多一条。
    const refreshTags = tagsNeedingFullRefresh(task, config.tagDiffModes, historyTagMap);
    if (refreshTags.length > 0) {
      messages.push({
        role: 'system',
        content: `【差量格式提醒】上一轮的这些标签不是当前模式要求的格式：${refreshTags.join('、')}。本轮必须输出这些标签的完整内容（不要只写变化块，也不要写【无变化】），否则旧格式会被整份替换。`,
      });
    }
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
      presetName: presetKey,
      round,
      tasks,
      skipped: selection.skipped.map((item) => ({ taskId: item.id, reason: String(item.decision.reason) })),
    },
  };
}
