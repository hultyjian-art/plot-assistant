/**
 * 分阶段调度 —— 移植自 ACU `plot-task-engine.ts` 里 `runPlotTasksRuntime_ACU` 的阶段循环（983-1067 行）
 *
 * 规则只有一条：**同一阶段内部并发，阶段之间串行；任一阶段有任务失败，整轮立刻停。**
 * 这套「宁可不发，也不发半成品」的策略是原版的行为，搬家时要原样保住，别顺手改成「失败也继续」。
 *
 * 这里只负责调度，不负责：
 * - 具体怎么跑一个任务（`runTask` 注入）
 * - 标签怎么聚合（`aggregate` 注入）
 * - 跑完之后拼 `<plot>` 写回楼层（引擎层）
 *
 * 之所以抽成注入式，是为了第 3 期做「按任务暂存 / 断点续跑」时只换 `runTask` 与失败分支，
 * 不必动调度本身。这一层的断言就是那次的回归基线。
 */

import type { PlotTaskResult } from './assemble';

export interface StageTaskLike {
  stage?: number;
  order?: number;
}

export interface StageRunOptions<T extends StageTaskLike, R> {
  tasks: T[];
  /** 跑一个任务。`relayTagMap` 是**本阶段开始时**已累积标签的快照 —— 同阶段的任务互相看不到对方。 */
  runTask: (task: T, ctx: { relayTagMap: Map<string, any[]>; stage: number }) => Promise<R>;
  /** 聚合整轮已完成任务的标签。传入的是**截至本阶段**的成功结果累计。 */
  aggregate: (results: R[]) => { aggregated: Map<string, any[]>; injectOnlyTagNames: Set<string> };
  /** 每阶段结算后调一次；抛异常会终止整轮（原版的 `checkCurrent`） */
  checkAbort?: () => void;
  /**
   * 起点标签（续跑时上一轮已完成任务的产出）。
   *
   * 它必须在**第一个阶段开跑之前**就进 `aggregatedTags`：阶段内的任务拿到的
   * `relayTagMap` 是「本阶段开始那一刻」的快照，晚一步喂进去，第一阶段的任务就白等了。
   */
  initialTags?: { tagMap: Map<string, any[]>; injectTagNames?: Iterable<string> } | null;
  onStageStart?: (stage: number, taskCount: number) => void;
  onStageFailed?: (results: R[]) => void;
}

export interface StageRunOutcome<R> {
  successfulResults: R[];
  failedResults: R[];
  aggregatedTags: Map<string, any[]>;
  injectedTagNames: Set<string>;
  /** 是否因某一阶段有任务失败而中止 */
  abortedByStageFailure: boolean;
  /** 中止时，失败那个阶段的 stage 号（不是数组下标） */
  failedStage: number | null;
  /** 完整跑完的阶段数 */
  stagesRun: number;
}

function normalizeStage(value: unknown): number {
  const num = Math.floor(Number(value));
  return Number.isFinite(num) && num > 0 ? num : 1;
}

/** 按 stage 升序、order 升序排序；再按 stage 切段（不重排，只切连续段） */
export function groupTasksByStage<T extends StageTaskLike>(tasks: T[]): Array<{ stage: number; tasks: T[] }> {
  const sorted = (Array.isArray(tasks) ? [...tasks] : [])
    .filter(Boolean)
    .sort(
      (left, right) =>
        normalizeStage(left?.stage) - normalizeStage(right?.stage) || (left?.order ?? 0) - (right?.order ?? 0),
    );

  const groups: Array<{ stage: number; tasks: T[] }> = [];
  sorted.forEach(task => {
    const stage = normalizeStage(task?.stage);
    const current = groups[groups.length - 1];
    if (!current || current.stage !== stage) {
      groups.push({ stage, tasks: [task] });
      return;
    }
    current.tasks.push(task);
  });
  return groups;
}

/**
 * 按阶段跑完所有任务。
 *
 * 三条硬规则（都是原版行为，改之前想清楚）：
 * 1. 同阶段用 `Promise.allSettled` 并发；只要有**抛异常**的，整轮直接抛出去，不走「中止」返回。
 * 2. 同阶段只要有一条 `success !== true` 的结果，就返回 `abortedByStageFailure: true`，**后续阶段一个都不跑**。
 * 3. 标签聚合是**累计**的：每阶段结束后用「截至目前的全部成功结果」重算一次，而不是增量合并。
 */
export async function runTasksByStage<T extends StageTaskLike, R extends Partial<PlotTaskResult>>(
  options: StageRunOptions<T, R>,
): Promise<StageRunOutcome<R>> {
  const { tasks, runTask, aggregate, checkAbort, onStageStart, onStageFailed, initialTags } = options;
  const groups = groupTasksByStage(Array.isArray(tasks) ? tasks : []);

  const successfulResults: R[] = [];
  const failedResults: R[] = [];
  let aggregatedTags = new Map<string, any[]>(initialTags?.tagMap ?? []);
  let injectedTagNames = new Set<string>(initialTags?.injectTagNames ?? []);
  let completedSuccessfulResults: R[] = [];
  let stagesRun = 0;

  for (let stageIndex = 0; stageIndex < groups.length; stageIndex++) {
    const group = groups[stageIndex];
    onStageStart?.(group.stage, group.tasks.length);

    const stageRelayTagMap = new Map(aggregatedTags);
    const settled = await Promise.allSettled(
      group.tasks.map(task => runTask(task, { relayTagMap: stageRelayTagMap, stage: group.stage })),
    );

    const rejected = settled.find(
      (item): item is PromiseRejectedResult => item.status === 'rejected',
    );
    if (rejected) throw rejected.reason;

    const stageResults = settled.map(item => (item as PromiseFulfilledResult<R>).value);
    checkAbort?.();

    const stageSuccessful = stageResults.filter(result => Boolean(result && result.success));
    const stageFailed = stageResults.filter(result => result && !result.success);
    successfulResults.push(...stageSuccessful);
    failedResults.push(...stageFailed);
    completedSuccessfulResults = [...successfulResults];
    stagesRun = stageIndex + 1;

    if (stageFailed.length > 0) {
      onStageFailed?.(stageFailed);
      return {
        successfulResults,
        failedResults,
        aggregatedTags,
        injectedTagNames,
        abortedByStageFailure: true,
        failedStage: group.stage,
        stagesRun,
      };
    }

    const { aggregated, injectOnlyTagNames } = aggregate(completedSuccessfulResults);
    aggregatedTags = aggregated;
    injectOnlyTagNames.forEach(name => injectedTagNames.add(name));
  }

  return {
    successfulResults,
    failedResults,
    aggregatedTags,
    injectedTagNames,
    abortedByStageFailure: false,
    failedStage: null,
    stagesRun,
  };
}
