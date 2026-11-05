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
import { buildPlotWorldbookTexts } from './data/worldbook-hits';
import { importPresetConfig } from './eng/preset-import';
import { buildHistoryDigest, pickHistoryMessages } from './eng/history';
import { applyContextTagFilters } from './eng/context-tags';
import { getPlotFromHistory } from './eng/history-plot';
import { normalizeRound } from './eng/schedule';
import type { PlotTaskResult } from './eng/assemble';
import type { TaskProgressInfo } from './eng/engine';
import { makeRoundId } from './eng/writeback';
import type { PlotTask } from './eng/task-model';
import { readPresetPlaceholders } from './preset-edit';
import { advanceRoundIndex, pruneTaskRuns, readTaskLastRound, writeTaskRuns } from './round-book';
import { runPlotRoundForPreset } from './round';
import { commitLanding, commitProgress, planStashRun } from './stash-flow';
import { attachLandingsToChat, type Stash, type StashWorking } from './stash-model';
import { createLogWriter } from './log-flow';
import { resolveChatStateStore } from './data/chat-vars';
import { resolveChatKey } from './chat-key';
import { saveSettings } from '../settings';
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
  is_hidden?: boolean;
  extra?: Record<string, unknown>;
}

function toPlotMessage(raw: RawTavernMessage): Record<string, unknown> {
  return {
    ...(raw.extra ?? {}),
    is_user: raw.role === 'user',
    mes: raw.message,
  };
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
  } = {},
): Promise<PlotAppendResult> {
  const plotSettings = ctx.settings.plot;
  if (!plotSettings.enabled) return { ok: false, text: userText, note: '剧情推进未开启' };

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

  const config = importPresetConfig(preset);
  const historyLimit = Math.max(1, config.contextTurnCount);

  // ── 触发轮次 + 强度/召回：都从预设本体读 ──
  //
  // 轮号 = 已经跑过的轮数 + 1。`roundIndex` 是脚本设置里的计数，跟着这次对话往下数。
  //
  // 账本的键用**用户选的那个名字**（本地库里存的名字），不是预设内部写的 `name`：
  // 用户在编辑器里改了名，账要跟着「这个预设」走，不能因为改名字就把周期重置一遍。
  const round = normalizeRound(plotSettings.roundIndex + 1);
  const presetKey = stored ? stored.name : config.name;
  const lastRoundOf = (taskId: string) => readTaskLastRound(plotSettings.taskRuns, presetKey, taskId);

  // 强度四档与召回条数：上游是 `plotSettings.rateMain/ratePersonal/rateErotic/rateCuckold`
  // 与 `recallCount` 直接进占位符表（`plot-task-engine.ts:387-392`）。
  //
  // 走 `readPresetPlaceholders` 而不是 `readPresetDraft`：这几项界面上已经没有输入框了
  // （它们是兼容字段，召回多少条由提示词自己说），但仍然要按「预设里有就用、没有就用默认」
  // 算出一个数，否则提示词里的 `{{zhaohui}}` / `{{sulv1}}` 会被替换成空串。
  const placeholders = readPresetPlaceholders(preset);

  // ── 聊天记录：一份给 `$7` 摘要、一份给 `$6` 上一轮 ──
  const rawChat = getChatMessages('0-{{lastMessageId}}') as unknown as RawTavernMessage[];
  const chat = rawChat.map(toPlotMessage);

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
  const settled: PlotTaskResult[] = [];  const flushProgress = (): void => {
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
      userText,
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
  const recentText = rawChat
    .slice(-historyLimit)
    .map((item) => String(item.message ?? ''))
    .join('\n');

  // ── 表格：只喂 `$5`（`$9` 是世界书，不是表格） ──
  const tableResult = readAcuTables();
  const summaryIndex = buildSummaryIndexText({ tables: tableResult.tables });

  // ── 世界书：`$1` 全量、`$9` 剔掉数据库生成条目 ──
  const { bookNames, entriesByBook } = await readWorldbookEntries({
    source: plotSettings.worldbookSource,
    books: plotSettings.worldbookBooks,
  });
  const worldbook = buildPlotWorldbookTexts({
    bookNames,
    entriesByBook: entriesByBook as never,
    baseScanText: [recentText, userText].filter(Boolean).join('\n'),
    // 用户在「上下文」页取消勾选的条目从这里生效（缺这本书 = 全选）
    enabledEntries: plotSettings.worldbookEntries,
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
    const outcome = await runPlotRoundForPreset({
      preset,
      previousPlot,
      worldbookContent: worldbook.content,
      worldbookDatabaseExcluded: worldbook.contentExcludingDatabase,
      round,
      lastRoundOf,
      working,
      // 引擎在发第一个请求之前会告诉我们「这一轮本来打算跑谁」——没有它就算不出还欠几个任务
      onRoundPlanned: (tasks: PlotTask[]) => {
        plannedIds = tasks.map((task) => task.id);
        // 真要跑了才开轮：空轮不该占日志的一格
        if (tasks.length > 0) {
          logWriter?.start({ floorId: anchor ? anchor.messageId : -1, roundIndex: round, presetName: presetKey });
        }
      },
      // 每跑完一个任务落一次盘：成功后失败时都靠它续跑
      onTaskSettled: (result) => {
        if (result && typeof result.taskId === 'string' && result.taskId) settled.push(result);
        flushProgress();
      },
      // 日志与暂存分开：日志写坏了只是少一份记录，不能让这一轮的进度跟着丢
      onTaskLog: (info) => {
        logWriter?.task(info);
      },
      onTaskStart: options.onTaskStart,
      replacements: {
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
      },
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
    });

    if (!outcome.ok) {
      // 真的开始跑了却没跑完：留在原地等用户再点一次（下一次会接着这几个欠账跑）。
      flushProgress();
      logWriter?.finish(`剧情推进未完成（${outcome.reason}）`);
      return { ok: false, text: userText, note: `剧情推进未完成（${outcome.reason}）`, blocking: true };
    }

    // ── 记账：哪些任务这一轮真的跑了 ──
    //
    // 只在**成功**分支记账并推进轮号：失败的那一轮用户会重刷，重刷应该还算同一轮。
    // 轮号一前进，「每 3 轮」的任务就会因为差了一轮而晚跑一次。
    persistRoundBook(ctx, presetKey, outcome.ranTaskIds, round);

    // 一个任务都没跑（全停用、这一轮都没到期、或者提示词块全关了）：
    // 原样放行，别往输入框后面拼一个空块。
    if (outcome.ranTaskIds.length === 0) {
      return {
        ok: true,
        text: userText,
        note: `本轮没有任务要跑（${describeSkipped(outcome.skippedBySchedule, outcome.skippedNoPrompt.length)}）`,
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
      };
    }

    // 整轮跑完（没失败任务）才收尾；日志写的是「这一轮的结果」，与暂存是否写成功无关。
    logWriter?.finish(null);

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

/**
 * 把这一轮的账写回脚本设置：记「哪些任务在第几轮跑过」+ 轮号前进。
 *
 * 用 `saveSettings` 而不是自己 `replaceVariables`：设置只有一个写入口
 * （`forStorage` 的 API 密钥混淆、zod 形状都归它管），绕过去早晚会把密钥写成明文。
 *
 * 顺带清掉已经不存在的预设的账 —— 用户删掉预设后，那几条账永远不会再被读到，
 * 留在变量里只会让对象越攒越大。
 */
function persistRoundBook(
  ctx: RerushContext,
  presetName: string,
  ranTaskIds: string[],
  round: number,
): void {
  const plot = ctx.settings.plot;
  const book = writeTaskRuns(plot.taskRuns, presetName, ranTaskIds, round);
  const kept = pruneTaskRuns(
    book,
    plot.presets.map((item) => item.name),
  );
  saveSettings(ctx, {
    plot: {
      ...plot,
      roundIndex: advanceRoundIndex(plot.roundIndex),
      taskRuns: kept,
    },
  });
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
  if (notDue > 0) parts.push(`${notDue} 个还没到轮次`);
  if (disabled > 0) parts.push(`${disabled} 个已停用`);
  if (emptyPromptCount > 0) parts.push(`${emptyPromptCount} 个提示词块全关了`);
  if (parts.length) return parts.join('，');
  return skipped.length ? `跳过 ${skipped.length} 个任务` : '没有可跑的任务';
}
