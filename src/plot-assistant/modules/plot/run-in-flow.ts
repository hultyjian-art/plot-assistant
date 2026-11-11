/**
 * 剧情推进 — 把接线板接到真实环境上的那一层。
 *
 * `round.ts` 不碰任何酒馆全局；这个文件专门负责「把全局里的东西取出来喂给它」：
 * 聊天记录、世界书、表格、预设、AI 调用口。**唯一有副作用的地方是发请求**（调 AI）。
 *
 * 用法只有一句：`await appendPlotBlock(ctx, 用户输入, { floor })`，返回要写进输入框的整段。
 *
 * 失败策略（2026-11-02 用户口径）：**真跑过却没跑完就停在原地**，不删楼层、不发送，
 * 原文放回输入框等用户再点一次 —— 下一次会接着没完成的任务跑。
 * 只有「没开」「没选预设」「预设读不出」这类「根本没开始跑」的情况才原样放行。
 */
import type { RerushContext } from '../types';
import { pickActiveApi, resolveCustomApi } from './api-route';
import { isUserAbortError } from './eng/call-outcome';
import { callPlotApi } from './data/ai-call';
import { describePresetProblem, readPlotPreset } from './data/acu-presets';
import { findStoredPreset } from './data/preset-store';
import { buildSummaryIndexText, readAcuTables } from './data/read-tables';
import { resolvePlotWorldbook } from './data/tavern-worldbook-scan';
import { importPresetConfig } from './eng/preset-import';
import { pickSummaryIndexEntry } from './eng/data-format';
import { buildHistoryDigest, pickHistoryMessages } from './eng/history';
import { applyContextTagFilters } from './eng/context-tags';
import { getPlotFromHistory } from './eng/history-plot';
import { collectDirectiveTagNames, type PlotTaskResult } from './eng/assemble';
import type { TaskProgressInfo } from './eng/engine';
import { makeRoundId } from './eng/writeback';
import type { PlotTask } from './eng/task-model';
import { anchorNameOf, readAnchorGap, type AnchorFloor } from './floor-anchor';
import { runPlotRoundForPreset, type PlotRoundDeps } from './round';
import { UI } from '../copy';
import { readArmedTaskIds, setArmedTaskIds, pruneArmed, toArmedTaskIds } from './manual-arm';
import { presetImportOptions } from './preset-options';
import { commitLanding, commitProgress, planStashRun, tagsFromQrfTaskRaw } from './stash-flow';
import { attachLandingsToChat, collectStashTagMap, type Stash, type StashWorking } from './stash-model';
import { createLogWriter } from './log-flow';
import { resolveChatStateStore } from './data/chat-vars';
import { resolveChatKey } from './chat-key';
import { enqueueWorldbookCheck, enqueueWorldbookLanding } from './worldbook-write';
import { processTavernTemplateText, readRoundIdentity, substituteTavernMacros } from '../tavern';
import { resolveWorldbookBooks, type WorldbookPick } from './worldbook-select';

/** 这一轮锚在哪个楼层。用户发一条消息就是一个锚点，暂存账按它记。 */
export interface PlotFloorAnchor {
  messageId: number;
  /** 这一层**现在**的正文（认领比对用，不是抽出来的干净文本） */
  floorText: string;
}

/**
 * 发送成功之后要补写楼层的那些东西。
 *
 * 为什么不在 `appendPlotBlock` 里直接写：这时楼层还不存在 —— 它是「原文 + plot」被发出去之后
 * 才被酒馆创建出来的。所以只能把料交回给动作层，由它在真点完发送后再落。
 */
export interface PlotCommit {
  floorId: number;
  /** 拼进楼层的那一整段（指令头 + `<plot>`） */
  finalMessage: string;
  /** 写进 `qrf_plot` 的原文 */
  saveContent: string;
  presetName: string;
  roundId: string;
  taskResults: PlotTaskResult[];
  /** 这一轮真跑过的任务的锚点名，楼层落地后由 after-send 补写（空的就不写）。 */
  anchorNames: string[];
}

export interface PlotAppendResult {
  /** 是否真的拼上了剧情块 */
  ok: boolean;
  /** 要写进输入框的文本；失败时就是传进来的原文 */
  text: string;
  /** 说明：成功时是预设名，失败时是原因（直接给用户看或写日志） */
  note: string;
  /**
   * 这一轮**已经跑过**但没跑完 —— 调用方必须停在原地：不删楼层、不发送。
   *
   * 只有「真的开始跑、结果失败」才算阻塞。没开开关、没选预设、预设读不出来这些
   * 配置问题不阻塞：那时候发送本来就该照常进行，不该因为一个开关没配好就发不出去。
   */
  blocking?: boolean;
  /** 成功时才有：发送之后要补写的 qrf 四字段 */
  commit?: PlotCommit;
}

/** 酒馆消息 → 本模块认的形状（`getChatMessages` 给的是 `message`，不是 `mes`） */
interface RawTavernMessage {
  message_id: number;
  role: string;
  message: string;
  name?: string;
  is_hidden?: boolean;
  extra?: Record<string, unknown>;
  /** qrf 模式写在楼层顶层的成果字段；升级模式下一般只有 extra 里那份。 */
  qrf_plot?: string;
  qrf_plot_preset?: string;
  qrf_plot_tasks?: Record<string, unknown>;
}

/** 聊天楼层 → 渲染层认识的样子；预览也 import 这一个，别再各写一份。 */
export function toPlotMessage(raw: { role?: unknown; message?: unknown; extra?: unknown }): Record<string, unknown> {
  return {
    ...((raw.extra as Record<string, unknown> | undefined) ?? {}),
    is_user: raw.role === 'user',
    mes: raw.message,
  };
}

/**
 * 从聊天记录里取「最近一层带 qrf 成果的楼层」的逐任务回传（`qrf_plot_tasks`）。
 *
 * 只认 `floorId` 之前（不含）的楼层：本轮要核对的是「以前产出过什么」，
 * 把当前这层算进来就等于自读。读不到返回 `null` —— 调用方据此按「没有」处理。
 *
 * 两个位置都看：qrf 模式写在楼层顶层，升级模式摊在 `extra` 里（见 `toPlotMessage` 的展开）。
 */
export function readQrfTaskRaw(
  chat: ReadonlyArray<RawTavernMessage> | null | undefined,
  floorId: number,
): Record<string, string> | null {
  const list = Array.isArray(chat) ? chat : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const item = list[i];
    if (!item) continue;
    const id = Number(item.message_id);
    if (!Number.isFinite(id) || id >= floorId) continue;
    const top = item.qrf_plot_tasks;
    const nested = (item.extra as Record<string, unknown> | undefined)?.qrf_plot_tasks;
    const source = top && typeof top === 'object' ? top : nested;
    if (!source || typeof source !== 'object') continue;
    const out: Record<string, string> = {};
    for (const [taskId, text] of Object.entries(source as Record<string, unknown>)) {
      if (typeof taskId !== 'string' || taskId === '') continue;
      if (typeof text === 'string' && text.trim() !== '') out[taskId] = text;
    }
    if (Object.keys(out).length > 0) return out;
  }
  return null;
}

/**
 * 取 `$1` 要用的世界书条目。读不到的书写进 console 但不中断。
 *
 * `pick` 决定读哪几本：不传（或 source=character）就是角色卡绑定的主要 + 附加书；
 * 传了 manual 就只读用户勾的那几本 —— 这是「世界书与上下文」页那个默认世界书
 * 选择器真正生效的地方。
 */
export async function readWorldbookEntries(
  pick?: WorldbookPick | null,
): Promise<{ bookNames: string[]; entriesByBook: Record<string, unknown> }> {
  let characterBooks: string[] = [];
  try {
    const names = getCharWorldbookNames('current');
    characterBooks = [names.primary ?? '', ...(names.additional ?? [])].filter(
      (name): name is string => typeof name === 'string' && name.trim() !== '',
    );
  } catch (error) {
    console.warn('[剧情推进助手] 读角色卡世界书失败', error);
  }

  let shelf: string[] = [];
  try {
    shelf = getWorldbookNames();
  } catch (error) {
    console.warn('[剧情推进助手] 读世界书列表失败', error);
  }

  const bookNames = resolveWorldbookBooks(pick ?? null, characterBooks, shelf);
  const entriesByBook: Record<string, unknown> = {};
  for (const bookName of bookNames) {
    try {
      entriesByBook[bookName] = await getWorldbook(bookName);
    } catch (error) {
      console.warn(`[剧情推进助手] 读世界书失败：${bookName}`, error);
      entriesByBook[bookName] = [];
    }
  }
  return { bookNames, entriesByBook };
}

/**
 * 给一次生成发一个唯一 id。
 *
 * 为什么必须有：超时靠 `stopGenerationById(generation_id)` 掐断请求，它**只认 id**。
 * 没有 id 就没法掐，超时功能整个失效（`ai-call.ts` 的 `runWithTimeout` 会退化成不设超时）。
 *
 * 用自增序号而不是随机数：同一轮里几个任务可能并发（`stage-run` 同阶段并发），
 * 序号天然不撞，也不会因为 `Math.random` 撞号而误停别人的请求。
 */
let generationSeq = 0;
function nextGenerationId(): string {
  generationSeq += 1;
  return `reroll-plot-${Date.now()}-${generationSeq}`;
}

/**
 * 跑一轮剧情推进，把结果拼在用户输入后面。
 *
 * @param ctx  脚本上下文（只用到 `settings.plot`）
 * @param userText 本轮真正的用户输入
 * @param options.floor 这一轮锚在哪个楼层（给了才会记账、才支持断点续跑）
 * @param options.signal 终止信号：用户按「终止」时整轮立刻停，不再重试
 * @param options.join 结果怎么和原文拼：`append`=原文+空行+指令块（手势重刷的旧语义）；
 *   `final`=只要指令块（ACU 的语义：楼层正文就是最终注入指令，原话靠 `$8` 留在提示词里）
 */
export async function appendPlotBlock(
  ctx: RerushContext,
  userText: string,
  options: {
    floor?: PlotFloorAnchor | null;
    signal?: AbortSignal | null;
    join?: 'append' | 'final';
    /** 每个任务开跑前回调一次（等待气泡用它显示进度） */
    onTaskStart?: (info: TaskProgressInfo) => void;
    /** 每个任务跑完回调一次（成功或失败都调；等待气泡用它把任务标成完成/失败） */
    onTaskSettled?: (result: PlotTaskResult) => void;
  } = {},
): Promise<PlotAppendResult> {
  const plotSettings = ctx.settings.plot;
  if (!plotSettings.enabled) return { ok: false, text: userText, note: '剧情推进未开启' };

  // ── 世界书写入：开跑前对一次账（2026-11-07 批 36/37）──
  //
  // 聊天 / 角色卡换了就按当前账本重算（清托管条目 + 重放）。比对键没变时它不会动
  // 世界书（没有要改的条目就直接短路）。托管条目本来就被挡在 `$1` 之外，
  // 所以它与本轮读世界书并发也互不干扰。后台排队跑，不阻塞推进。
  enqueueWorldbookCheck(ctx);

  // ── 预设从哪来：先看本地库（导入过的），没有再实时读数据库脚本 ──
  //
  // 为什么是这个顺序：用户点过「导入」就是想要一份**冻住**的预设 ——
  // 数据库那边后来改了、删了、甚至脚本都没加载，都不该影响这边。
  // 没导入过的人才回退到实时读，这样老用户升级后行为不变。
  const wantedPreset = plotSettings.presetName.trim();
  if (wantedPreset === '') {
    return { ok: false, text: userText, note: '还没选剧情推进预设。去设置面板里选一个，或先「从数据库导入」。' };
  }

  const stored = findStoredPreset(plotSettings.presets, wantedPreset);
  let preset: Record<string, unknown>;
  if (stored) {
    preset = stored.data;
  } else {
    const presetOutcome = readPlotPreset(wantedPreset);
    if (!presetOutcome.ok) return { ok: false, text: userText, note: describePresetProblem(presetOutcome) };
    preset = presetOutcome.details as Record<string, unknown>;
  }

  const presetOptions = presetImportOptions(plotSettings);
  const config = importPresetConfig(preset, presetOptions);
  const historyLimit = Math.max(0, config.contextTurnCount);

  // ── 触发间隔：这条用户楼层，每个任务距自己上一次锚点隔了几条 ──
  //
  // 数的是「第几条用户楼层」，不是绝对楼层号：AI 回复不算、被隐藏的用户楼层算。
  // 锚点由每个任务各自记在跑过的那条楼层的 extra 里（见 plot/floor-anchor.ts），
  // 所以删层重刷时锚点跟着楼层消失、换聊天自动各算各的，不需要全局账本。
  //
  // 锚点名带预设名，防止不同预设里同名同序号的任务串账；用本地库里存的名字
  // （用户选的那个），不是预设内部写的 name —— 用户在编辑器里改了名，锚点也跟着走。
  const presetKey = stored ? stored.name : config.name;

  // ── 聊天记录：一份给 `$7` 摘要、一份给 `$6` 上一轮、一份数触发间隔 ──
  const rawChat = getChatMessages('0-{{lastMessageId}}') as unknown as RawTavernMessage[];
  const chat = rawChat.map(toPlotMessage);
  const taskAnchorNames = new Map<string, string>(
    config.tasks.map(task => [task.id, anchorNameOf(presetKey, task.id)]),
  );

  // ── 手动触发：先把预约表里的死条目清掉，再把这一轮要用的名单交给引擎 ──
  //
  // 预约存的是锚点名（预设名::任务id），按聊天分家。任务改名、删掉、停用、
  // 或关掉「手动触发」之后，旧锚点名会留在表里，发送前顺手清掉，免得越积越多。
  const armed = readArmedTaskIds();
  const liveAnchorNames = new Set<string>(
    config.tasks
      .filter((task) => task.enabled !== false && task.schedule?.manual === true)
      .map((task) => taskAnchorNames.get(task.id) ?? ''),
  );
  liveAnchorNames.delete('');
  const pruned = pruneArmed(armed, liveAnchorNames);
  const armedChanged = pruned.length !== armed.length || pruned.some((id, index) => id !== armed[index]);
  if (armedChanged) setArmedTaskIds(pruned);
  // 预约表按锚点名分家，执行引擎只认任务 id；这里必须显式翻译，
  // 否则手动任务会被当成「没预约」跳过。
  const armedTaskIds = toArmedTaskIds(pruned, taskAnchorNames);

  const lastAnchorGapOf = (taskId: string): number | null =>
    readAnchorGap(rawChat as AnchorFloor[], taskAnchorNames.get(taskId) ?? '');
  // 日志按绝对楼层号标识：roundIndex 字段沿用旧名，值取这一轮锚定的楼层号。
  const round = options.floor?.messageId ?? -1;

  // ── 暂存：这一层之前有没有没跑完的账 ──
  //
  // 口径（2026-11-02 用户明确）：点发送时如果上次没把该抽的标签全部落盘，就**接着上次的进度跑**，
  // 直到「这一轮该跑的任务全部成了」才算完成；完成之后再点发送，才是重新开始一轮。
  // 这里只负责把「要接着跑的那份进度」找出来，具体跑哪几个任务由 `buildResumePlan` 决定。
  const anchor = options.floor ?? null;
  const store = resolveChatStateStore();
  const chatKey = chatKeyOf(ctx);
  let stash: Stash = store.loadStash(chatKey).stash;
  let working: StashWorking | null = null;
  // qrf 模式不碰账本：成果直接写楼层字段，一楼一版，没有「续跑」这回事。
  // 反过来，升级模式也不写楼层字段 —— 两边各管一份，才不会出现"账本说 A、楼层说 B"。
  const useStash = plotSettings.stashMode !== 'qrf';
  if (anchor && useStash) {
    try {
      const plan = planStashRun({
        stash,
        floorId: anchor.messageId,
        floorText: anchor.floorText,
        liveFloorIds: rawChat.map((item) => item.message_id),
        taskIds: config.tasks.filter((task) => task.enabled !== false).map((task) => task.id),
        // 缺口口径（用户 2026-11-11 定）：**必达标签 = 抽取标签 − 豁免标签**，
        // 逐个查它在暂存区里有没有实物；齐了就不重跑，缺了才重跑。
        requiredTagsOfTask: (taskId: string) => config.tasks.find((task) => task.id === taskId)?.extractTags,
        exemptTagsOfTask: (taskId: string) => config.tasks.find((task) => task.id === taskId)?.exemptTags,
        // 暂存区查不到 → 兜底查楼层的 qrf 字段（用户 2026-11-11 的口径）。
        // qrf_plot_tasks 里存的是每个任务的原始回传，用该任务自己的抽取名单重抽一遍。
        qrfTagsOfTask: (taskId: string) => {
          const task = config.tasks.find((item) => item.id === taskId);
          if (!task) return null;
          const rawMap = readQrfTaskRaw(rawChat, anchor?.messageId ?? Number.POSITIVE_INFINITY);
          const rawForTask = rawMap?.[taskId];
          if (rawForTask === undefined) return null;
          return tagsFromQrfTaskRaw(
            { [taskId]: rawForTask },
            task.extractTags,
            task.exemptTags,
            task.extractInjectTags,
          );
        },
        now: Date.now(),
      });
      // 对账把「楼层没了」的账搬进了孤儿区：这一步本身就是一次写盘，不改就白算。
      if (plan.stash !== stash) store.saveStash(plan.stash);
      stash = plan.stash;
      working = plan.working;
    } catch (error) {
      // 账本读坏了不该让推进停摆：没有进度就从头跑，比整轮不跑好。
      console.warn('[剧情推进助手] 暂存对账失败，本轮按全新一轮处理', error);
    }
  }

  // 进度写照：每跑完一个任务落一次盘。一次推进可能跑十几分钟，
  // 中途关页面、切聊天、脚本重载，内存里那份就没了 —— 写一次只是一次变量补丁。
  let plannedIds: string[] = [];
  const settled: PlotTaskResult[] = [];
  const flushProgress = (): void => {
    if (!useStash || !anchor || plannedIds.length === 0) return;
    try {
      const next = commitProgress({
        stash,
        floorId: anchor.messageId,
        floorText: anchor.floorText,
        presetName: presetKey,
        plannedIds,
        results: settled,
        now: Date.now(),
      });
      stash = next.stash;
      store.saveStash(stash);
    } catch (error) {
      console.warn('[剧情推进助手] 写暂存进度失败', error);
    }
  };
  // ── 运行日志：从谁开始跑就记谁 ──
  //
  // 刻意**不**在这里 `start`：这一轮可能一个任务都不跑（全停用/没到期/提示词块全关），
  // 那就该一条记录都不留，而不是在面板上堆一串「0 个任务」的空轮。
  // 所以开轮挂在 `onRoundPlanned` 上 —— 它是「真要发第一个请求了」的信号。
  const logWriter = anchor ? createLogWriter({ store }) : null;

  // 升级模式的上一轮成果在账本里、不在楼层字段上：先贴回聊天记录，再让 `$6` 去挑。
  const historyChat = useStash ? attachLandingsToChat(chat, rawChat, stash, config.name) : chat;
  // 提取/排除规则只作用在 `$7` 的前文楼层上（ACU 原版口径），世界书 `$1` 不过滤。
  const hasTagRules = config.extractRules.length > 0 || config.excludeRules.length > 0;
  const historyDigest = buildHistoryDigest(
    pickHistoryMessages(
      chat,
      historyLimit,
      (content) =>
        applyContextTagFilters(String(content ?? ''), {
          extractRules: config.extractRules,
          excludeRules: config.excludeRules,
        }),
      hasTagRules,
    ),
  );
  const previousPlot = getPlotFromHistory(historyChat, {}, config.name);
  // `{{标签}}` 的主来源：暂存区账本里上一轮的标签投影（qrf 模式没有账本，退回上一楼层正文）。
  const stashHistoryTags = useStash ? collectStashTagMap(stash, anchor?.messageId ?? Number.POSITIVE_INFINITY) : null;
  const recentText = (historyLimit === 0 ? [] : rawChat.slice(-historyLimit))
    .map((item) => String(item.message ?? ''))
    .join('\n');

  // `$U` / `$C`：从宿主窗口取用户人设与当前角色卡描述，取不到给空串。
  const identity = readRoundIdentity();

  // ── 世界书：`$1` 全量、`$9` 剔掉数据库生成条目、`$5` 的纪要索引 ──
  //
  // 顺序上必须先读世界书：`$5` 的第一档要问「世界书里有没有那条纪要索引条目」，
  // 表格只是它的兜底。以前读世界书在算 `$5` 之后，于是第一档永远轮不到 —— 补回 ACU 的链。
  const { bookNames, entriesByBook } = await readWorldbookEntries({
    source: plotSettings.worldbookSource,
    books: plotSettings.worldbookBooks,
  });

  // ── 表格：只喂 `$5` 的兜底（`$9` 是世界书，不是表格） ──
  const tableResult = readAcuTables();
  const summaryIndex = buildSummaryIndexText({
    tables: tableResult.tables,
    // ACU 的优先级：世界书纪要索引条目 > 纪要表 > 总体大纲表。
    // 那个条目是 ACU 自己导出的成品文本，内容比两张表的拼接更完整。
    worldbookContent: pickSummaryIndexEntry(entriesByBook as never, bookNames),
  });

  // $1 / $9 改吃酒馆本轮原生扫描的激活结果（批 75，A 方案）。
  const worldbook = await resolvePlotWorldbook({
    bookNames,
    entriesByBook,
    enabledEntries: plotSettings.worldbookEntries,
    rawChat,
    userText,
    baseScanText: [recentText, userText].filter(Boolean).join('\n'),
  });

  // ── 用哪条 API：面板里选中的那条；没选/选了个不存在的 → 跟随酒馆当前连接 ──
  const activeApi = pickActiveApi(plotSettings.apis, plotSettings.activeApiName);
  const apiPlan = resolveCustomApi(activeApi);
  // 附加请求体参数解析不了 → 这一轮不跑。理由：静默丢掉这段参数，
  // 用户会看着面板上明写着 `response_format: json_object` 却拿到非 JSON 输出，
  // 而且他没有任何线索能查到「是这一格写错了」。
  if (apiPlan.problem !== null) {
    return { ok: false, text: userText, note: apiPlan.problem, blocking: true };
  }
  // 超时**与用哪条 API 无关**：跟随酒馆时同样要有保护，否则「没配独立 API」的人
  // 一旦遇到接口卡死就只能干等。所以它是剧情推进自己的一个设置位，不从 API 条目上读。
  const timeoutSeconds = plotSettings.requestTimeoutSeconds;

  try {
    // 显式标注类型是为了保住 deps 字面量里那几个回调参数的上下文推断
    // （callApi / onTaskSettled / onTaskLog 的形参没写类型，靠函数参数推断）。
    const roundDeps: PlotRoundDeps = {
      preset,
      previousPlot,
      stashHistoryTags,
      worldbookContent: worldbook.content,
      worldbookDatabaseExcluded: worldbook.contentExcludingDatabase,
      gapOf: lastAnchorGapOf,
      working,
      // 引擎在发第一个请求之前会告诉我们「这一轮本来打算跑谁」——没有它就算不出还欠几个任务
      onRoundPlanned: (tasks: PlotTask[]) => {
        plannedIds = tasks.map((task) => task.id);
        // 真要跑了才开轮：空轮不该占日志的一格
        if (tasks.length > 0) {
          // 续跑时保留上一轮已经跑完的任务记录：否则日志里只剩最后这一批，
          // 用户看不到前半场是谁跑完的、跑了什么（2026-11-09 第 7 条）。
          logWriter?.start({
            floorId: anchor ? anchor.messageId : -1,
            roundIndex: round,
            presetName: presetKey,
            resume: Boolean(working),
            // 这一轮要重跑的任务，上一轮的旧失败记录先摘掉；否则同一条任务
            // 会同时留着旧 failed 和新 ok，整轮状态被旧失败拖成 failed。
            rerunTaskIds: plannedIds,
          });
        }
      },
      // 每跑完一个任务落一次盘：成功后失败时都靠它续跑
      onTaskSettled: (result) => {
        if (result && typeof result.taskId === 'string' && result.taskId) settled.push(result);
        flushProgress();
        // 气泡要把「这个任务跑完了」画出来；回调失败不能连累推进。
        try {
          options.onTaskSettled?.(result);
        } catch (error) {
          console.warn('[剧情推进助手] 任务完成回调失败', error);
        }
      },
      // 日志与暂存分开：日志写坏了只是少一份记录，不能让这一轮的进度跟着丢
      onTaskLog: (info) => {
        logWriter?.task(info);
      },
      onTaskStart: options.onTaskStart,
      importOptions: presetOptions,
      replacements: {
        ...identity,
        worldbookContent: worldbook.content,
        worldbookDatabaseExcluded: worldbook.contentExcludingDatabase,
        summaryIndex,
        historyDigest,
        previousPlot,
        userInput: userText,
      },
      // 酒馆原生宏（<user> / {{user}} / <char> / {{char}} …）统一在渲染层换掉；
      // templateProcess 额外接入酒馆正则、MacroLike 与 EJS 模板。
      macroReplace: substituteTavernMacros,
      templateProcess: processTavernTemplateText,
      callApi: (messages, task) => {
        // 任务级 API：任务自己指了名字就用那条，没指（空）就跟面板上「当前 API」走。
        // 指的那条被删了/改名了就回落到当前那条 —— 跑得下去比跑得「严格」重要，
        // 但只在真的配了却找不到时才回落，不静默吞掉拼错的名字（下面会记 note）。
        const wanted = task.apiName ?? '';
        const picked = wanted === '' ? activeApi : pickActiveApi(plotSettings.apis, wanted);
        const taskApi = wanted === '' ? activeApi : picked ?? activeApi;
        const taskPlan = taskApi === activeApi ? apiPlan : resolveCustomApi(taskApi);
        if (taskPlan.problem !== null) throw new Error(taskPlan.problem);
        return callPlotApi(messages, {
          customApi: taskPlan.payload,
          // 提示词后处理是每条 API 自己的选择：'follow'/空串 = 不动酒馆那一格。
          // 它不能塞进 custom_api（酒馆助手白名单里没有这个键），所以由 callPlotApi 临时借用、用完还原。
          promptPostProcessing: taskApi?.promptPostProcessing ?? '',
          // 每次调用一个独立 id：超时靠它掐断（stopGenerationById 只认 id）
          generationId: nextGenerationId(),
          timeoutSeconds,
          // 用户点「终止」时把在飞的这条请求也掐掉，别让他干等到超时
          signal: options.signal ?? undefined,
        });
      },
      // 用户按了停止键：立刻结束整轮，不要当成接口失败再重发几次
      isAbort: isUserAbortError,
      checkAbort: () => options.signal?.aborted === true,
      // 被预约的手动任务这轮无视「每几楼」直接参与（引擎按 §8 认这个字段）。
      armedTaskIds,
    };

    const outcome = await runPlotRoundForPreset(roundDeps);

    if (!outcome.ok) {
      // 真的开始跑了却没跑完：留在原地等用户再点一次（下一次会接着这几个欠账跑）。
      flushProgress();
      const reasonText =
        outcome.reason === 'unsupported-legacy-preset'
          ? '这份预设是老格式（正文只写在 mainPrompt / systemPrompt 或 prompts 三段里，没有任务表），本版本已不再支持；请改用带「任务清单」的预设'
          : outcome.reason;
      logWriter?.finish(`剧情推进未完成（${reasonText}）`);
      return { ok: false, text: userText, note: `剧情推进未完成（${reasonText}）`, blocking: true };
    }

    // ── 手动触发：结果 ok，把这一轮用掉的预约解除，回到手动待命 ──
    //
    // 「用掉」= 这一轮真跑过它，或续跑发现它早已完成；被阻塞 / 失败的一轮
    // 在上面就返回了，预约表原样保留，下一次用户输入还会再试。
    //
    // 形状对齐：预约表存的是锚点名（预设名::任务id），而结果里的 ranTaskIds /
    // alreadyDone 按引擎既有字段是任务 id；这里用 taskAnchorNames 把任务 id
    // 映射成锚点名再求交集，同时也把结果里的原样值放进集合（万一引擎直接给锚点名）。
    const doneIds = new Set<string>();
    for (const id of [...outcome.ranTaskIds, ...outcome.alreadyDone]) {
      doneIds.add(id);
      const anchor = taskAnchorNames.get(id);
      if (anchor !== undefined) doneIds.add(anchor);
    }
    const toDisarm = pruned.filter((id) => doneIds.has(id));
    if (toDisarm.length > 0) {
      setArmedTaskIds(pruned.filter((id) => !doneIds.has(id)));
    }

    // ── 记账：哪些任务这一轮真的跑了 ──
    //
    // 锚点不在这里写：这时楼层还没发出去。要交回给动作层，等楼层真的落地后
    // 由 after-send 把锚点补写在楼层 extra 上（升级模式也要写）。失败的一轮
    // 没有 commit，自然不会打锚点；删层重刷会把锚点一起删掉。

    // 一个任务都没跑（全停用、这一轮都没到期、或者提示词块全关了）：
    // 原样放行，别往输入框后面拼一个空块。
    if (outcome.ranTaskIds.length === 0) {
      return {
        ok: true,
        text: userText,
        note: `这条楼层没有任务要跑（${describeSkipped(outcome.skippedBySchedule, outcome.skippedNoPrompt.length)}）`,
      };
    }

    // ── 落盘：整轮成功才产生「一版成果」 ──
    //
    // 同一层已经有两版时，`putLanding` 会把最旧那版挤掉（用户 2026-11-02 的口径：
    // 不再问「覆盖哪一版」，自动跑、完成之后删最旧）。挤掉的只是成果，锚点不动。
    // 写账失败不能拖累发送：账是辅助，消息才是用户要的。
    let commit: PlotCommit | undefined;
    if (anchor) {
      // qrf 模式不记两版成果：这一版直接进楼层字段（由 after-send 写），账本一个字不动。
      if (useStash) {
        try {
          const landed = commitLanding({
            stash,
            floorId: anchor.messageId,
            floorText: anchor.floorText,
            presetName: presetKey,
            finalText: outcome.finalMessage,
            saveContent: outcome.saveContent,
            results: settled,
            // 哪些标签「本该进正文」由最终注入模板决定，不是由任务抽了哪些决定。
            // 用户把某些标签从模板里删掉后，它们只该存档/进世界书，不该被当成暂存缺口。
            textTagNames: collectDirectiveTagNames(config.directiveTemplate),
            // 只保留预设里还在、还启用的任务：删任务或停用后，旧标签不会被继承带无限续命。
            taskIds: config.tasks.filter((task) => task.enabled !== false).map((task) => task.id),
            now: Date.now(),
          });
          stash = landed.stash;
          store.saveStash(stash);
        } catch (error) {
          console.warn('[剧情推进助手] 保存暂存成果失败（不影响本次发送）', error);
        }
      }
      commit = {
        floorId: anchor.messageId,
        finalMessage: outcome.finalMessage,
        saveContent: outcome.saveContent,
        presetName: outcome.presetName || presetKey,
        roundId: makeRoundId(),
        taskResults: settled.slice(),
        anchorNames: outcome.ranTaskIds
          .map((id) => taskAnchorNames.get(id))
          .filter((name): name is string => Boolean(name)),
      };
    }

    // 整轮跑完（没失败任务）才收尾；日志写的是「这一轮的结果」，与暂存是否写成功无关。
    logWriter?.finish(null);

    // ── 世界书写入（2026-11-07 批 36/37）：落盘后把规则选中的标签块写进世界书 ──
    //
    // 用引擎聚合出的**完整**标签表（含续跑时从账本补齐的上半场），不是只看本轮结果 ——
    // 分两次跑完的一轮，落盘成果里两个半场的标签都算数。后台排队写，不阻塞返回。
    enqueueWorldbookLanding(ctx, outcome.outcome.aggregatedTags);

    // 楼层正文写什么，由调用方决定：
    // - 手势重刷沿用「原文 + 空行 + 指令块」，用户回头还能看见自己说了什么；
    // - 发送拦截走 ACU 的语义，正文只放最终注入指令（原话由 $8 进了任务提示词，
    //   再拼一遍反而会让主 AI 把同一段话读两遍）。
    const text = options.join === 'final' ? outcome.finalMessage : `${userText}\n\n${outcome.finalMessage}`;
    return { ok: true, text, note: outcome.presetName, commit };
  } catch (error) {
    // 不吞异常：先让用户看见，再把原文放行
    console.error('[剧情推进助手] 剧情推进失败', error);
    // 跑了一半炸了：进度已经按任务落过盘，下一次点发送会接着跑；这一轮不能发出去。
    logWriter?.finish(`剧情推进出错：${(error as Error)?.message ?? error}`);
    return { ok: false, text: userText, note: `剧情推进出错：${(error as Error)?.message ?? error}`, blocking: true };
  }
}


/** 当前聊天的稳定标识 —— 见 `plot/chat-key.ts`（面板也要用同一份，所以搬出去了）。 */
function chatKeyOf(ctx: RerushContext): string {
  return resolveChatKey(ctx.state.chatKey);
}

/** 给日志/提示用的一句话：这一轮为什么没跑任务。 */
function describeSkipped(skipped: { taskId: string; reason: string }[], emptyPromptCount: number): string {
  const parts: string[] = [];
  const notDue = skipped.filter((item) => item.reason === 'not_due').length;
  const disabled = skipped.filter((item) => item.reason === 'disabled').length;
  const manualIdle = skipped.filter((item) => item.reason === 'manual_idle').length;
  if (notDue > 0) parts.push(`${notDue} 个还没到楼层间隔`);
  if (disabled > 0) parts.push(`${disabled} 个已停用`);
  if (manualIdle > 0) parts.push(`${manualIdle} 个任务${UI.plot.manualIdleReason}`);
  if (emptyPromptCount > 0) parts.push(`${emptyPromptCount} 个提示词块全关了`);
  if (parts.length) return parts.join('，');
  return skipped.length ? `跳过 ${skipped.length} 个任务` : '没有可跑的任务';
}
