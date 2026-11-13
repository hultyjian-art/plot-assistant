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
import { renderTaskMessagesAsync, type TaskRenderContext } from './eng/messages';
import { buildResumePlan } from './eng/resume';
import { performReplacements } from './eng/prompt-build';
import { runPlotRound, type PlotRoundMessage, type PlotRoundOutcome, type SettledResult, type TaskLogInfo, type TaskProgressInfo } from './eng/engine';
import { selectTasksForFloor, type ScheduleReason } from './eng/schedule';
import { buildTagMap, type TagMap } from './eng/tags';
import { applyTagDiffs, collectKnownTagNames, tagsNeedingFullRefresh } from './eng/tag-diff';
import type { PlotTask } from './eng/task-model';
import type { PlotApiReply } from './eng/task-accept';
import type { StashWorking } from './stash-model';
import type { TavernPromptMacroSource } from '../tavern';

/** 调用方注入进来的取数口。全部可选 —— 缺哪个就当那个占位符是空的。 */
export interface PlotRoundDeps {
  /** 预设对象（`getPlotPresetDetails()` 的返回）；缺了就没法跑 */
  preset?: Record<string, unknown> | null;
  /** 预设导入的兜底项（`$7 默认上下文`的全局值）；预览与真跑必须递同一份。 */
  importOptions?: ImportPresetOptions;
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
  /**
   * 暂存区账本里的上一轮标签投影 —— `{{标签}}` 的主来源（用户 2026-11-06 口径）。
   * 不传（qrf 模式 / 对照测试）时退回 `previousPlot` 建表，行为与旧版一致。
   */
  stashHistoryTags?: Map<string, string[]> | null;
  /** 续跑用的暂存快照 */
  working?: StashWorking | null;
  /**
   * 每个任务距上一次带自己锚点的用户楼层隔了几条（见 `plot/floor-anchor.ts`）。
   * 返回 null = 现存楼层里找不到锚点，判为「第一次跑」。缺省时所有任务都按第一次处理。
   *
   * 锚点记在楼层自己的 extra 里，不在预设、也不在脚本设置的账本里：
   * 删层重刷时锚点跟着楼层一起消失，换聊天自动各算各的。
   */
  gapOf?: (taskId: string) => number | null;
  /**
   * 这一楼层被手动预约的任务 id 集合（见方案「任务手动触发」，批68）。
   * 只影响标了 schedule.manual 的任务：在集合里就跑、不在就跳过并报「等待手动触发」。
   *
   * 不传 = 重刷 / 回填等流程：手动标记不生效，所有任务按原有周期判定，行为与此参数
   * 存在之前完全一致。集合由调用方从聊天变量里读，这一层不碰存储。
   */
  armedTaskIds?: ReadonlySet<string>;
  /**
   * 酒馆原生宏替换（`<user>` / `{{user}}` / `<char>` / `{{char}}` 等）。
   * 在任务 messages 和最终注入指令拼好之后调用；不传 = 不处理（纯函数测试保持原样）。
   */
  macroReplace?: (text: string) => string;
  /**
   * 完整提示词模板链（酒馆正则 + ST 宏 + MacroLike → EJS → 再跑一遍宏）。
   * 传了它时任务消息走异步渲染；最终注入模板也走同一套。
   */
  templateProcess?: (text: string, source: TavernPromptMacroSource) => Promise<string>;
  /** 调 AI 的口子（正文 + 可选推理内容） */
  callApi: (messages: PlotRoundMessage[], task: PlotTask, attemptIndex: number) => Promise<string | PlotApiReply>;
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
      /**
       * 续跑路径里「发现已经完成」的任务 id（纯上报：面板要能区分「这轮没跑」
       * 和「上轮已经跑过、这轮接着走」）。没有续跑快照时是空数组。
       */
      alreadyDone: string[];
      /** 本轮真正发出请求的任务（成功的那批）；账本按它记「上次跑过」。 */
      ranTaskIds: string[];
      /** 本轮因为「楼层间隔还没到 / 被停用」而跳过的任务，带上原因（面板/日志用）。 */
      skippedBySchedule: { taskId: string; reason: ScheduleReason }[];
      /** 提示词块全关掉、发不出任何内容的任务（这些不请求 AI）。 */
      skippedNoPrompt: string[];
    }
  | { ok: false; reason: 'no-preset' | 'unsupported-legacy-preset' | 'aborted-by-stage-failure'; presetName: string; outcome?: PlotRoundOutcome };

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

  const config: PlotPresetConfig = importPresetConfig(deps.preset, deps.importOptions);

  // 老格式预设（没有任务表）：以前会拼一条兜底任务、最后「整轮不发请求也不报错」。
  // 现在显式挡在入口，交给调用方把原因显示给用户。
  if (config.tasks.length === 0) {
    return { ok: false, reason: 'unsupported-legacy-preset', presetName: config.name };
  }

  // 续跑：把已完成的任务摘出去，并把它们的标签带回起点
  const resume = buildResumePlan(config.tasks, deps.working ?? null);

  // ── 触发间隔：这条用户楼层哪些任务到期 ──
  //
  // 放在续跑**之后**：续跑摘掉的是「这一轮不用再跑」的任务，剩下的是候选；
  // 再按周期筛一遍，才是这一轮真正要发请求的。
  // 顺序反过来的话，一个「每 3 条用户楼层」的任务会被续跑先摘掉、被记成跑过 —— 它会越拖越久。
  //
  // 间隔由调用方从现存楼层里数好递进来（锚点在楼层 extra 里），这里只做纯策略判断。
  const selection = selectTasksForFloor(resume.tasks, deps.gapOf ?? (() => null), deps.armedTaskIds);
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
  // 已知标签名：任务抽取标签 + 最终注入里的 {{标签}}。多传这一列是为了让
  // `buildTagMap` 在「最外层整块扫描」之后再按名字逐个补一遍——嵌套在
  // `character_info` 里的 `character_archive` 也能单独取到。
  const knownTagNames = collectKnownTagNames(config.tasks, config.directiveTemplate);
  const historyTagMap = buildTagMap(String(deps.previousPlot ?? ''), null, knownTagNames);
  // `{{标签}}` 看暂存区账本：账本按标签存着上一轮的投影，父标签内容本来就带着子标签。
  // 上一楼层正文只作补充 —— 它存的是原始回传，升级模式下成果根本在账本里、楼层没有。
  if (deps.stashHistoryTags instanceof Map) {
    deps.stashHistoryTags.forEach((value, name) => historyTagMap.set(name, value));
  }

  const renderMessages = async (task: PlotTask, relayTagMap?: TagMap): Promise<PlotRoundMessage[]> => {
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
      macroReplace: deps.macroReplace ?? null,
      templateProcess: deps.templateProcess ?? null,
      // 差量规则要和回传合并用同一份配置：规则顶在任务消息最前面，实际按任务命中替换标签名。
      tagDiffModes: config.tagDiffModes,
    };
    const messages = await renderTaskMessagesAsync(task, context);

    // 旧格式保底：上一轮某个差量标签还是表格、这一轮已改成块（或反过来），
    // 先提醒 AI 本轮必须输出完整内容；合并端也会按「全量替换」处理。
    const refreshTags = tagsNeedingFullRefresh(task, config.tagDiffModes, historyTagMap);
    if (refreshTags.length > 0) {
      messages.push({
        role: 'system',
        content: `【差量格式提醒】上一轮的这些标签不是当前模式要求的格式：${refreshTags.join('、')}。本轮必须输出这些标签的完整内容（不要只写变化块，也不要写【无变化】），否则旧格式会被整份替换。`,
      });
    }
    return messages;
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
  const rawDirectiveTemplate = performReplacements(config.directiveTemplate, {
    replacements: baseReplacements,
    worldbookContent: deps.worldbookContent,
  });
  // 最终注入模板里的 `{{user}}` / `{{char}}` 也是酒馆宏；必须在 buildFinalMessage
  // 把它当内部标签占位符清掉之前替换，否则会被换成空串。装了 EJS 时同样走完整链。
  // 与任务提示词同一口径：固定「斜杠命令」作用域，不套用户 / AI 输出正则。
  const directiveTemplate = deps.templateProcess
    ? await deps.templateProcess(rawDirectiveTemplate, 'slash_command')
    : deps.macroReplace
      ? deps.macroReplace(rawDirectiveTemplate)
      : rawDirectiveTemplate;

  // ── 提示词全关掉的任务不请求 AI ──
  //
  // 面板上「全部块都关掉」的任务会被标黄，这里必须真的不发：发一个空 messages 出去，
  // 接口要么 400 要么返回一句废话，整轮还会被判成「阶段失败」，用户只看到
  // 「剧情推进未完成」—— 他明明只是关了几个开关。
  //
  // 只渲一次，顺手把条数记下来：`renderTaskMessages` 里有一整套占位符替换，
  // 为了判空再跑一遍不值当。
  const messageCounts = new Map<string, number>();
  for (const task of scheduledTasks) messageCounts.set(task.id, (await renderMessages(task)).length);
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
    // 标签级差量：AI 回传的只是变化补丁，先按上一轮标签投影合并成完整回传，
    // 再交给原来的验收/聚合/落盘链。没有开启任何差量标签时原样返回。
    callApi: async (messages, task, attemptIndex) => {
      const reply = await deps.callApi(messages, task, attemptIndex);
      const text = typeof reply === 'string' ? reply : reply.text;
      const reasoning = typeof reply === 'string' ? '' : reply.reasoning;
      return {
        text: applyTagDiffs({
          rawResponse: text,
          task,
          modes: config.tagDiffModes,
          previousTags: historyTagMap,
        }),
        reasoning,
      };
    },
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

  // 最终注入指令里可能写着酒馆宏（比如 `<user>` / `{{char}}`）。任务消息在
  // `renderTaskMessages` 里已经替换过；最终注入是引擎在全部任务跑完后才拼的，
  // 这里补一次，保证写进楼层的正文也拿到真实用户名/角色名。
  const finalMessage = deps.macroReplace ? deps.macroReplace(outcome.injectedMessage) : outcome.injectedMessage;

  return {
    ok: true,
    presetName: config.name,
    outcome,
    finalMessage,
    saveContent: outcome.saveContent,
    skippedTaskIds: resume.skippedTaskIds,
    // 续跑里「上轮已经完成」的名单单独报一份（纯上报，不参与任何判定），
    // 面板要拿它显示「这轮是接着上轮走」；与 skippedTaskIds 同值但用途不同。
    alreadyDone: resume.skippedTaskIds,
    // 只有**真发出请求**的任务才记「这条楼层跑过」：失败的下轮要重试，
    // 但这一轮它已经占了一次调用，不该在「每 N 条用户楼层」上再记一次便宜。
    ranTaskIds: outcome.taskResults.map(result => result.taskId),
    skippedBySchedule,
    skippedNoPrompt,
  };
}

