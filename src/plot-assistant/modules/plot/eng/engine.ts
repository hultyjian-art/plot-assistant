/**
 * 剧情推进 — 一轮任务的编排（引擎骨架）
 *
 * 这一层是**接线**：把已经各自锁住的四层串成一条完整的路。
 *
 * ```
 *   tasks
 *     └─ 按 stage 分组（stage-run）
 *          └─ 每个任务：渲染 messages（prompt-build / 调用方注入）
 *                       → 调 AI 并验收 + 重试（task-accept）
 *                       → 抽标签（tags）
 *          └─ 阶段结束：累计聚合标签（assemble）
 *     └─ 全部成功 → 拼 <plot> 内容（assemble）
 * ```
 *
 * 它**不碰**任何真实数据：消息怎么渲染、AI 怎么调、表格从哪读，全由调用方注入。
 * 这样做的原因很实际 —— 取数那半截依赖酒馆运行时（headless 测不了）；决策点 7
 * 早已定案（读 ACU 原生 `exportTableAsJson()`）并接进主流程。编排层只接线、不碰真实数据，
 * 取数换实现时不用重测。
 *
 * ## 三条与直觉相反的行为（都是原版的，别掰）
 *
 * 1. **宁可不发，也不发半成品**：任一阶段只要有一个任务失败，整轮返回
 *    `ok: false`、`injectedMessage: ''`，后续阶段一个都不跑。
 * 2. **同阶段的任务互相看不见对方的标签**：`relayTagMap` 是阶段**开始那一刻**的快照，
 *    所以阶段内想「A 产出给 B 用」是不成立的 —— 那是跨阶段接力，不是跨任务接力。
 * 3. **重试不重渲染**：消息只渲染一次，重试时原样重发（原版注释：
 *    「每次直接重发原任务消息，失败原因与次数仅用于本地诊断」）。
 */
import { DEFAULT_RETRY_DELAY_MS } from '../../constants';
import { aggregateTaskTags, buildFinalMessage, buildSaveTagBlocks, type PlotTaskResult } from './assemble';
import { runTasksByStage } from './stage-run';
import { runTaskAttempts, type PlotApiReply } from './task-accept';
import type { TagMap } from './tags';

/** 编排层需要任务具备的最小形状。字段名对齐 ACU 的任务对象，方便直接用预设里的数据。 */
export interface PlotRoundTask {
  id: string;
  name?: string;
  enabled?: boolean;
  stage?: number;
  order?: number;
  extractTags?: string;
  extractInjectTags?: string;
  /** 豁免标签：不要求每轮回传，回传了仍照常抽取/落盘 */
  exemptTags?: string;
  minLength?: number;
  maxRetries?: number;
}

/** 发给 AI 的一条消息。只用酒馆认得的三个角色。 */
export interface PlotRoundMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  /**
   * 这条消息来自预设里的哪个提示词块（块名）。
   *
   * 只给日志用：面板要「以提示词块为单位折叠」，光有 role 分不清
   * 「开场白」「世界观」「本轮要求」这几段同角色的块。酒馆本身不认这个字段。
   */
  name?: string;
}

/** 渲染一个任务时拿到的上下文。 */
export interface RenderContext {
  task: PlotRoundTask;
  stage: number;
  /** 阶段开始时已累积的标签快照（同阶段互不可见） */
  relayTagMap: TagMap;
}

/** 一个任务跑完的回执，带上任务标识，方便上层按任务暂存。 */
export type SettledResult = PlotTaskResult & { taskId: string };

/** 任务开跑时的进度快照（等待气泡用它画「现在跑到哪了」）。 */
export interface TaskProgressInfo {
  taskId: string;
  taskName: string;
  stage: number;
  order: number;
  /** 这是本轮第几个开跑的任务，从 1 开始 */
  index: number;
  /** 本轮一共要跑几个任务 */
  total: number;
  /** 本轮一共几个阶段 */
  stageTotal: number;
}

/**
 * 一个任务跑完时的日志素材。
 *
 * 引擎只负责「讲清楚发生了什么」：试了几次、卡在哪、最后一次的提示词长什么样；
 * 要不要落盘、落到哪、留多少，全由日志层决定 —— 引擎不该知道聊天变量存在。
 */
export interface TaskLogInfo<T extends PlotRoundTask = PlotRoundTask> {
  task: T;
  result: SettledResult;
  /** 实际试了几次（含第一次）。1 表示一次过 */
  attempt: number;
  /** 最后一次失败的原文；成功时为 null */
  error: string | null;
  /** 最后一条提示词的原文（裁剪交给日志层，这里不截断，免得两处截断口径不一致） */
  promptPreview: string;
  /** 这一任务实际发出去的消息（= 提示词块），面板按它折叠 */
  promptMessages?: PlotRoundMessage[];
  startedAt: number;
  durationMs: number;
}

export interface PlotRoundOptions<T extends PlotRoundTask = PlotRoundTask> {
  tasks: T[];
  /** 最终注入模板。留空则用 `DEFAULT_DIRECTIVE`。 */
  finalDirectiveTemplate?: string;
  /** 把一个任务渲染成 messages。占位符替换、模板变量都在这里面做；允许异步（EJS 是 Promise）。 */
  renderMessages: (task: T, context: RenderContext) => PlotRoundMessage[] | Promise<PlotRoundMessage[]>;
  /** 调一次 AI，返回正文 + 可选推理内容。第几个 attempt 由编排层传入，方便上层记录。 */
  callApi: (messages: PlotRoundMessage[], task: T, attemptIndex: number) => Promise<string | PlotApiReply>;
  /** 每轮开头与每次调用后都会调一次；抛异常即终止整轮（原版的 `checkCurrent`）。 */
  checkAbort?: () => void;
  /**
   * 区分「用户主动中止」与「接口失败」：返回 true 的错误**原样抛出**、不做重试。
   *
   * 上游对应物是 ACU 的 `callApi` 里对中止错误的识别。必须显式传进来，
   * 否则用户按了停止键，这里会把它当成接口失败又重发 2~3 次（`eng/task-accept.ts:156`）。
   */
  isAbort?: (error: unknown) => boolean;
  /** 每检索到一个任务结果就回调一次 —— 按任务暂存、写运行日志都挂这里。 */
  onTaskSettled?: (result: SettledResult, task: T) => void;
  /**
   * 一个任务跑完（含重试全部用尽）时回调一次，带耗时、尝试次数、报错原文。
   *
   * 与 `onTaskSettled` 分开是因为两件事的失败代价不同：暂存写坏了要影响续跑，
   * 日志写坏了只是少一份记录。上层可以给日志包一层 try/catch，不必连累暂存。
   */
  onTaskLogged?: (info: TaskLogInfo<T>) => void;
  /**
   * 续跑时带进来的起点标签（上一轮已完成任务的产出）。
   *
   * 为什么要从外面喂：续跑会把已完成的任务从任务表里摘掉，它们不再产出任何结果，
   * 于是「最终注入正文」里就少了它们的标签 —— 用户看到的 `<plot>` 比第一遍还短。
   * 这一份当作第 0 阶段的成果参与聚合，排序、去重、`injectOnly` 全都走同一条路。
   */
  seedTags?: { tagMap: TagMap; injectTagNames?: Iterable<string> } | null;
  onStageStart?: (stage: number, taskCount: number) => void;
  /**
   * 一个任务**开始前**回调一次（第一次尝试之前，重试不重复回调）。
   *
   * 用途只有一个：让等待气泡能显示「现在在跑哪个任务」。
   * 没有它，用户只能看到一句「剧情推进中」，长任务跑十分钟也分不清是在跑还是卡死了。
   */
  onTaskStart?: (info: TaskProgressInfo) => void;
  onStageFailed?: (failed: SettledResult[]) => void;
  /** 重试间隔。默认 5000ms（原值），测试里传 0。 */
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  describeFailure?: (error: unknown) => string;
}

export interface PlotRoundOutcome {
  /** 整轮是否完整成功。中止时为 false，且 `injectedMessage` 为空串。 */
  ok: boolean;
  abortedByStageFailure: boolean;
  failedStage: number | null;
  stagesRun: number;
  /** 成功任务的回执（按阶段 → 序号已排好序） */
  taskResults: SettledResult[];
  failedResults: SettledResult[];
  aggregatedTags: Map<string, string[]>;
  injectedTagNames: Set<string>;
  /** 要写进楼层 `<plot>` 里面的内容。中止时为空串。 */
  injectedMessage: string;
  /** 要落进字段的原文（供下一轮 `$6` 用）。中止时为空串。 */
  saveContent: string;
}

const DEFAULT_RETRIES = 3;
const DEFAULT_RETRY_DELAY = DEFAULT_RETRY_DELAY_MS;

/**
 * 把起点标签伪装成一批「第 0 阶段的成功回执」。
 *
 * 不为它单独写一套合并逻辑：那样同标签堆数组、`injectOnly` 收集、排序都得抄第二遍，
 * 抄漏一处就是「续跑后正文顺序变了」这种很难查的 bug。
 */
function seedResults(seed: PlotRoundOptions['seedTags']): PlotTaskResult[] {
  if (!seed || !(seed.tagMap instanceof Map) || seed.tagMap.size === 0) return [];
  const inject = new Set<string>();
  for (const name of seed.injectTagNames ?? []) {
    if (typeof name === 'string' && name.trim()) inject.add(name.trim());
  }

  const out: PlotTaskResult[] = [];
  let order = 0;
  seed.tagMap.forEach((contents, name) => {
    if (!name) return;
    const text = Array.isArray(contents) ? contents.join('\n\n') : String(contents ?? '');
    out.push({
      taskId: `__resume_${order}`,
      taskName: '',
      stage: 0,
      order,
      success: true,
      extractedTags: { [name]: text },
      injectOnlyTagNames: [...inject],
    });
    order += 1;
  });
  return out;
}

function positiveInt(value: unknown, fallback: number): number {
  const num = Math.floor(Number(value));
  return Number.isFinite(num) && num > 0 ? num : fallback;
}

/**
 * 日志里那条「提示词预览」取哪一条：**最后一条**。
 *
 * 任务的 messages 是 system + 若干史前上下文 + 最后一条真正的要求；
 * 前面几条在面板上全是同一段开场白，只有最后一条能回答「这次到底让他干嘛」。
 */
/**
 * 这一轮真正发出去的全部提示词。
 *
 * 以前这里取的是「最后一条有内容的消息」—— 但一轮请求有 system 和好几段上下文，
 * 最后一条往往只是一点尾巴，日志里看到的东西跟实际发出去的完全不是一回事。
 */
function fullPromptOf(messages: PlotRoundMessage[]): string {
  const list = Array.isArray(messages) ? messages : [];
  const pieces: string[] = [];
  for (const item of list) {
    const content = typeof item?.content === 'string' ? item.content : '';
    if (!content.trim()) continue;
    const role = typeof item?.role === 'string' && item.role ? item.role : 'user';
    pieces.push(`【${role}】\n${content}`);
  }
  return pieces.join('\n\n');
}

/**
 * 跑完一轮剧情推进。
 *
 * 中止（`ok: false`）与抛异常的区别要分清：
 * - **抛异常**：调度本身出了意外（`checkAbort` 认为聊天切走了、任务实现里崩了）——
 *   这是「这轮不算数」，上层应该保留暂存、允许原样重刷。
 * - **返回 ok: false**：任务跑了，但结果不合格 —— 这是「这轮有失败任务」，
 *   上层应该把已完成的部分按任务暂存起来，等重刷时只跑没完成的。
 */
export async function runPlotRound<T extends PlotRoundTask = PlotRoundTask>(
  options: PlotRoundOptions<T>,
): Promise<PlotRoundOutcome> {
  const {
    tasks,
    finalDirectiveTemplate = '',
    renderMessages,
    callApi,
    checkAbort,
    onTaskSettled,
    onTaskLogged,
    onStageStart,
    onTaskStart,
    onStageFailed,
    retryDelayMs = DEFAULT_RETRY_DELAY,
    sleep,
    describeFailure,
    isAbort,
    seedTags,
  } = options;

  // 关掉的任务不参与调度。原版就是先过滤再分组，所以关掉的任务不会占位、也不会触发空阶段。
  const activeTasks = (Array.isArray(tasks) ? tasks : []).filter(task => Boolean(task) && task.enabled !== false);

  // 续跑起点：先算好一次，聚合回调用的是同一份，别在循环里重复造。
  const seed = seedResults(seedTags);
  const seedAggregate = aggregateTaskTags(seed);

  // 进度：气泡要显示「第 3 个 / 共 5 个」「阶段 2 / 共 3 阶段」。
  // 这里只数**这一轮真要跑的**任务 —— 续跑与触发间隔筛掉的不该出现在分母里。
  const totalTasks = activeTasks.length;
  const totalStages = new Set(activeTasks.map(task => positiveInt(task.stage, 1))).size;
  let startedTasks = 0;

  const runTask = async (task: T, context: { relayTagMap: TagMap; stage: number }): Promise<SettledResult> => {
    // 进度回调放在最前面：用户要看到的是「现在在跑谁」，不是「刚刚跑完了谁」。
    // 重试发生在 runTaskAttempts 内部，不会重复回调（分母不该因为重试而变大）。
    startedTasks += 1;
    if (onTaskStart) {
      try {
        onTaskStart({
          taskId: String(task.id || ''),
          taskName: task.name || String(task.id || ''),
          stage: context.stage,
          order: task.order ?? 0,
          index: startedTasks,
          total: totalTasks,
          stageTotal: totalStages,
        });
      } catch (error) {
        // 进度显示失败不能连累整轮
        console.warn('[剧情推进助手] 进度回调失败', error);
      }
    }

    // 只渲染一次：重试时原样重发，与原版一致。
    const messages = await renderMessages(task, { task, stage: context.stage, relayTagMap: context.relayTagMap });

    // 计时包住「整段尝试」而不是单次请求：用户问的是「这条任务卡了多久」，
    // 退避等待也算在里面，否则 3 次重试各 5 秒的等待会凭空消失。
    const startedAt = Date.now();
    const attempt = await runTaskAttempts({
      minLength: Math.max(0, Math.floor(Number(task.minLength) || 0)),
      extractTags: task.extractTags || '',
      extractInjectTags: task.extractInjectTags || '',
      exemptTags: task.exemptTags || '',
      maxRetries: positiveInt(task.maxRetries, DEFAULT_RETRIES),
      delayMs: retryDelayMs,
      callApi: (attemptIndex: number) => callApi(messages, task, attemptIndex),
      checkAbort,
      isAbort,
      sleep,
      describeFailure,
    });
    const endedAt = Date.now();

    const result: SettledResult = {
      taskId: String(task.id || ''),
      taskName: task.name || task.id || '',
      stage: context.stage,
      order: task.order ?? 0,
      success: attempt.success,
      rawResponse: attempt.rawResponse,
      lastRawResponse: attempt.lastRawResponse,
      reasoning: attempt.reasoning,
      extractedTags: attempt.extraction?.extractedTags,
      injectOnlyTagNames: attempt.extraction?.injectOnlyTagNames,
    };

    onTaskSettled?.(result, task);
    // 日志回调单独兜一层：日志是旁路，写坏了不该把这一轮的成果一起带走。
    if (onTaskLogged) {
      try {
        onTaskLogged({
          task,
          result,
          attempt: attempt.attempts,
          error: attempt.success ? null : attempt.lastErrorMessage || '任务失败（未给出原因）',
          promptPreview: fullPromptOf(messages),
          promptMessages: messages,
          startedAt,
          durationMs: endedAt - startedAt,
        });
      } catch (error) {
        console.warn('[剧情推进助手] 写运行日志失败', error);
      }
    }
    return result;
  };

  const outcome = await runTasksByStage<T, SettledResult>({
    tasks: activeTasks,
    runTask,
    aggregate: results => {
      // 起点标签当成「第 0 阶段的成果」混进去：排序、同标签堆数组、injectOnly 全走同一条路，
      // 这样续跑出来的正文与第一遍跑完整轮的顺序一致。
      const { aggregated, injectOnlyTagNames } = aggregateTaskTags([...seed, ...results]);
      return { aggregated, injectOnlyTagNames };
    },
    // 第一阶段的任务也要看得见起点标签：它们的 relayTagMap 是「阶段开始那一刻」的快照。
    initialTags: seed.length > 0 ? { tagMap: seedAggregate.aggregated, injectTagNames: seedAggregate.injectOnlyTagNames } : null,
    checkAbort,
    onStageStart,
    onStageFailed,
  });

  if (outcome.abortedByStageFailure) {
    return {
      ok: false,
      abortedByStageFailure: true,
      failedStage: outcome.failedStage,
      stagesRun: outcome.stagesRun,
      taskResults: outcome.successfulResults,
      failedResults: outcome.failedResults,
      aggregatedTags: outcome.aggregatedTags,
      injectedTagNames: outcome.injectedTagNames,
      injectedMessage: '',
      saveContent: '',
    };
  }

  return {
    ok: true,
    abortedByStageFailure: false,
    failedStage: null,
    stagesRun: outcome.stagesRun,
    taskResults: outcome.successfulResults,
    failedResults: [],
    aggregatedTags: outcome.aggregatedTags,
    injectedTagNames: outcome.injectedTagNames,
    injectedMessage: buildFinalMessage(finalDirectiveTemplate, outcome.successfulResults, outcome.aggregatedTags),
    // 2026-11-12：存档正文改成「标签块」而不是「任务原话」——
    // qrf 模式会把它写进 qrf_plot 给下一轮 $6 读，原话里的杂质会一起进去。
    saveContent: buildSaveTagBlocks(outcome.aggregatedTags),
  };
}
