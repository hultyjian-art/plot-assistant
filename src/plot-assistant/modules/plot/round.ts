/**
 * 剧情推进 — 一轮的接线板（把已经锁住的各层串起来跑一次）。
 *
 * 这里只管**顺序和搬运**，不碰任何酒馆全局：预设从哪来、表格从哪读、世界书怎么扫、
 * 历史从哪切，全部由调用方注入。这样它才能在对照测试里被完整地跑一遍 ——
 * 接线错（少传一个占位符、漏一次写回）在这里就必须红。
 *
 * 顺序（改之前先看这一点）：
 *   预设 → 任务 → 占位符表 → 逐任务渲染+调用 → 聚合 → 最终注入文本 / 落盘文本
 *
 * 不在这里做的事（都在外面，各有一层）：写楼层、存暂存、记日志、UI 提示。
 */
import { buildRoundReplacements, type RoundReplacementsInput } from './eng/round-inputs';
import { importPresetConfig, type ImportPresetOptions, type PlotPresetConfig } from './eng/preset-import';
import { renderTaskMessages, type TaskRenderContext } from './eng/messages';
import { buildResumePlan } from './eng/resume';
import { performReplacements } from './eng/prompt-build';
import { runPlotRound, type PlotRoundMessage, type PlotRoundOutcome, type SettledResult, type TaskLogInfo, type TaskProgressInfo } from './eng/engine';
import { normalizeRound, selectTasksForRound, type ScheduleReason } from './eng/schedule';
import { buildTagMap, type TagMap } from './eng/tags';
import type { PlotTask } from './eng/task-model';
import type { StashWorking } from './stash-model';

/** 调用方注入进来的取数口。全部可选 —— 缺哪个就当那个占位符是空的。 */
export interface PlotRoundDeps {
  /** 预设对象（`getPlotPresetDetails()` 的返回）；缺了就没法跑 */
  preset?: Record<string, unknown> | null;
  /** 建默认提示词组的构造器（产品层决定默认文案） */
  buildDefaultPromptGroup?: ImportPresetOptions['buildDefaultPromptGroup'];
  /** 任务提示词里要替换的东西（`$U` / `$C` / `$8` 等） */
  replacements?: RoundReplacementsInput;
  /** `$1` 世界书内容（含信封的裸文本由 prompt-build 负责套壳） */
  worldbookContent?: string;
  /** `$9` 世界书内容（剔掉数据库生成条目） */
  worldbookDatabaseExcluded?: string;
  /** 每个任务自己的世界书覆盖（上游按任务算 `$1`，这里留出注入点） */
  taskWorldbook?: (task: PlotTask) => string | undefined;
  /** 上一轮剧情（`$6`）；按任务不同可以给不同的值 */
  previousPlot?: string;
  /** 续跑用的暂存快照 */
  working?: StashWorking | null;
  /**
   * 这是第几轮（按用户楼层计，从 1 开始）。缺省 1。
   *
   * 只给「按任务设触发轮次」用（`eng/schedule.ts`）：`everyRounds > 1` 的任务
   * 要靠它判断到期没有。上游没有这个概念，缺省值 1 让所有任务都按「每轮」跑，
   * 行为与上游一致。
   */
  round?: number;
  /**
   * 某个任务上次在第几轮跑过。返回 `undefined` = 没记过（当第一次，跑）。
   *
   * 为什么不直接读任务对象上的 `schedule.lastRound`：账是运行时的，预设是用户的配置文件，
   * 混在一起会让导出的 JSON 带着「我跑到第几轮了」。账本在 `PlotSettings.taskRuns` 里，
   * 由调用方按 `预设名::任务id` 查（见 `plot/round-book.ts`）。
   */
  lastRoundOf?: (taskId: string) => number | undefined;
  /** 调 AI 的口子 */
  callApi: (messages: PlotRoundMessage[], task: PlotTask, attemptIndex: number) => Promise<string>;
  /** 中止信号 */
  checkAbort?: () => void;
  /** 判定「用户主动中止」：命中就立刻停下，不做重试（见 `eng/call-outcome.ts`） */
  isAbort?: (error: unknown) => boolean;
  /** 重试间隔（毫秒），默认 5000；测试里传 0 */
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** 每跑完一个任务回调一次（记日志用） */
  onTaskSettled?: (result: SettledResult, task: PlotTask) => void;
  /** 每个任务跑完时递一份日志素材（耗时、尝试次数、报错原文） */
  onTaskLog?: (info: TaskLogInfo<PlotTask>) => void;
  /** 每个任务**开跑前**回调一次（等待气泡用它显示「现在跑到哪个任务」） */
  onTaskStart?: (info: TaskProgressInfo) => void;
  /**
   * 「这一轮打算跑哪些任务」定稿后回调一次（在发第一个请求之前）。
   *
   * 暂存层要靠它算出 `pending`：只跑完两个任务就失败时，必须知道本来还有几个没跑，
   * 否则账本只记得「谁成了」，续跑时不知道该补谁。
   */
  onRoundPlanned?: (tasks: PlotTask[]) => void;
}

/** 这一轮的结果。`ok=false` 时**不要把 `finalMessage` 拼进正文**。 */
export type PlotRoundRunOutcome =
  | {
      ok: true;
      presetName: string;
      outcome: PlotRoundOutcome;
      /** 拼进用户楼层的整段（含指令头与 `<plot>` 块） */
      finalMessage: string;
      /** 写进 `qrf_plot` 的原文（各任务回传拼接，不是终稿） */
      saveContent: string;
      /** 本轮跳过了哪些任务（断点续跑） */
      skippedTaskIds: string[];
      /** 本轮真正发出请求的任务（成功的那批）；账本按它记「上次跑过」。 */
      ranTaskIds: string[];
      /** 本轮因为「触发轮次还没到 / 被停用」而跳过的任务，带上原因（面板/日志用）。 */
      skippedBySchedule: { taskId: string; reason: ScheduleReason }[];
      /** 提示词块全关掉、发不出任何内容的任务（这些不请求 AI）。 */
      skippedNoPrompt: string[];
    }
  | { ok: false; reason: 'no-preset' | 'aborted-by-stage-failure'; presetName: string; outcome?: PlotRoundOutcome };

/**
 * 跑一轮。
 *
 * 关键三件事：
 *   1. **预设读不出来就不跑** —— 没有任务清单硬跑只会产出一段空指令；
 *   2. 占位符表**一次建好**，逐任务只覆盖 `$1` / `$6` 这类任务级项；
 *   3. 阶段失败时把中间结果原样带回去（第 3 期按任务暂存要靠它）。
 */
export async function runPlotRoundForPreset(deps: PlotRoundDeps): Promise<PlotRoundRunOutcome> {
  if (!deps.preset || typeof deps.preset !== 'object') {
    return { ok: false, reason: 'no-preset', presetName: '' };
  }

  const config: PlotPresetConfig = importPresetConfig(deps.preset, {
    buildDefaultPromptGroup: deps.buildDefaultPromptGroup,
  });

  // 续跑：把已完成的任务摘出去，并把它们的标签带回起点
  const resume = buildResumePlan(config.tasks, deps.working ?? null);

  // ── 触发轮次：这一轮哪些任务到期 ──
  //
  // 放在续跑**之后**：续跑摘掉的是「这一轮不用再跑」的任务，剩下的是候选；
  // 再按周期筛一遍，才是这一轮真正要发请求的。
  // 顺序反过来的话，一个「每 3 轮」的任务会被续跑先摘掉，账本记成跑过 —— 它会越拖越久。
  //
  // 账本（上次跑过第几轮）不在任务对象上，由调用方按 `预设名::任务id` 查好了递进来，
  // 这里只负责覆盖上去。见 `plot/round-book.ts` 里为什么不把账写进预设。
  const round = normalizeRound(deps.round ?? 1);
  const candidates = resume.tasks.map(task => withLedgerLastRound(task, deps.lastRoundOf));
  const selection = selectTasksForRound(candidates, round);
  const scheduledTasks = selection.due;
  const skippedBySchedule = selection.skipped.map(item => ({ taskId: item.id, reason: item.decision.reason }));

  const baseReplacements = buildRoundReplacements({
    ...deps.replacements,
    worldbookContent: deps.worldbookContent ?? deps.replacements?.worldbookContent,
    worldbookDatabaseExcluded: deps.worldbookDatabaseExcluded ?? deps.replacements?.worldbookDatabaseExcluded,
    previousPlot: deps.previousPlot ?? deps.replacements?.previousPlot,
  });

  // ── 历史标签表：上一轮 `<plot>` 里的 `<标签>内容</标签>` ──
  //
  // `{{标签}}` 的兜底来源。不建这张表时，`resolveTag` 查不到就吐 `<标签></标签>`
  // 空壳 —— 用户预设里「以下是上一轮的相关记录：{{basic_info}}{{plot_judge}}……」
  // 发出去会是一串空标签，而且不报错（2026-11-05 修）。
  //
  // 上游在 `plot-task-engine.ts:474` 用 `buildPlotTagMapFromText_ACU(lastPlotContent, null)`
  // 建同一张表；我们 `resolveTag` 的「先查阶段接力、查不到退历史」已经是上游那个优先级，
  // 缺的只是把值喂进来。传 `null` = 不限定名单，把上一轮出现的标签全扫进来。
  const historyTagMap = buildTagMap(String(deps.previousPlot ?? ''), null);

  const renderMessages = (task: PlotTask, relayTagMap?: TagMap): PlotRoundMessage[] => {
    const context: TaskRenderContext = {
      replacements: baseReplacements,
      // `$1` 走信封，`performReplacements` 只认 `worldbookContent` 这个位置，
      // **不会**回头去 `replacements.$1` 里拿。之前这里没传，于是每个任务里的 `$1`
      // 都被换成一对空标签 —— 模型拿不到世界书，还不报错（2026-11-01 修）。
      // 任务自己的世界书（`taskWorldbook`）优先，它和上游一样是任务级覆盖。
      worldbookContent: deps.taskWorldbook?.(task) ?? deps.worldbookContent,
      historyTagMap,
      // 阶段接力：引擎每一步都会递进来「本阶段开始那一刻」的标签快照；
      // 没递（比如算提示词条数那一次）就退到续跑起点。
      relayTagMap: relayTagMap ?? resume.relayTagMap,
    };
    return renderTaskMessages(task, context);
  };

  // ── 最终注入指令也要走一遍 `$` 占位符替换 ──
  //
  // 上游明说这一段的 `$8` 会被换成本轮用户输入（`main-popup-plot.ts:186`：
  // 「你可以用 $8 自行决定是否/放置位置」），实现是在拼装前先跑
  // `performReplacements(rawFinal)`（`plot-task-engine.ts:437`）。
  // 我们漏了这一步，2026-11-01 真机实测注入正文里躺着字面量 `$8`。
  //
  // 与任务提示词共用同一张占位符表：`$1` / `$9` 走信封，其余平铺，顺序由
  // `performReplacements` 自己保证，不在这里另起一套。
  const directiveTemplate = performReplacements(config.directiveTemplate, {
    replacements: baseReplacements,
    worldbookContent: deps.worldbookContent,
  });

  // ── 提示词全关掉的任务不请求 AI ──
  //
  // 面板上「全部块都关掉」的任务会被标黄，这里必须真的不发：发一个空 messages 出去，
  // 接口要么 400 要么返回一句废话，整轮还会被判成「阶段失败」，用户只看到
  // 「剧情推进未完成」—— 他明明只是关了几个开关。
  //
  // 只渲一次，顺手把条数记下来：`renderTaskMessages` 里有一整套占位符替换，
  // 为了判空再跑一遍不值当。
  const messageCounts = new Map<string, number>();
  for (const task of scheduledTasks) messageCounts.set(task.id, renderMessages(task).length);
  const runnableTasks = scheduledTasks.filter(task => (messageCounts.get(task.id) ?? 0) > 0);
  const skippedNoPrompt = scheduledTasks
    .filter(task => (messageCounts.get(task.id) ?? 0) === 0)
    .map(task => task.id);

  // 先告诉调用方「这一轮本来打算跑谁」，再发第一个请求 —— 暂存层靠它算 pending。
  deps.onRoundPlanned?.(runnableTasks);

  const outcome = await runPlotRound<PlotTask>({
    tasks: runnableTasks,
    finalDirectiveTemplate: directiveTemplate,
    renderMessages: (task, context) => renderMessages(task, context.relayTagMap),
    callApi: (messages, task, attemptIndex) => deps.callApi(messages, task, attemptIndex),
    checkAbort: deps.checkAbort,
    isAbort: deps.isAbort,
    onTaskSettled: deps.onTaskSettled,
    onTaskLogged: deps.onTaskLog,
    onTaskStart: deps.onTaskStart,
    retryDelayMs: deps.retryDelayMs,
    sleep: deps.sleep,
    seedTags: { tagMap: resume.relayTagMap, injectTagNames: resume.injectedTagNames },
  });

  if (outcome.abortedByStageFailure) {
    return {
      ok: false,
      reason: 'aborted-by-stage-failure',
      presetName: config.name,
      outcome,
    };
  }

  return {
    ok: true,
    presetName: config.name,
    outcome,
    finalMessage: outcome.injectedMessage,
    saveContent: outcome.saveContent,
    skippedTaskIds: resume.skippedTaskIds,
    // 只有**真发出请求**的任务才记「这轮跑过」：失败的下轮要重试，
    // 但这一轮它已经占了一次调用，不该在「每 N 轮」上再记一次便宜。
    ranTaskIds: outcome.taskResults.map(result => result.taskId),
    skippedBySchedule,
    skippedNoPrompt,
  };
}

/**
 * 把账本里的「上次跑过第几轮」盖到任务的 `schedule.lastRound` 上。
 *
 * 账本值优先于预设里可能残留的 `lastRound`：预设是用户导来导去的文件，
 * 里面写着的轮号只可能是别人机器上的，或者上一次导出的旧账 —— 以本机账本为准。
 * 账本没有记录（`undefined`）时**不动**任务，让它保持「第一次跑」的判定。
 */
function withLedgerLastRound(
  task: PlotTask,
  lastRoundOf?: (taskId: string) => number | undefined,
): PlotTask {
  const last = lastRoundOf?.(task.id);
  if (last === undefined) return task;
  const at = Math.floor(Number(last));
  if (!Number.isFinite(at) || at < 1) return task;
  return { ...task, schedule: { ...(task.schedule || {}), lastRound: at } };
}
