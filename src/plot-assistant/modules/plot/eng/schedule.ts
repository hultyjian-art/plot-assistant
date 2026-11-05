/**
 * plot/eng/schedule.ts — 「按任务设置触发轮次」（纯策略）
 *
 * 这是需求二③。上游 ACU **没有**这个东西：它的 `triggerWhen` 是喂给 agent 判断「要不要选这个任务」
 * 的白话线索，不是条件求值；引擎里每个任务每轮都跑。所以这一层是**新建**，不是移植，
 * 也就没有原件可比对（`tools/plot-parity/schedule-test.ts` 的期望值全部写死）。
 *
 * 口径（与施工方案 §6.3 一致）：
 * - `everyRounds` 缺省或为 1 → **每轮都触发**，与上游行为一致，默认值不改变任何现有用法
 * - `everyRounds = N > 1` → 距上次触发满 N 轮才再跑一次
 * - `lastRound` 缺失 → 视为「从未跑过」，**第一次一定跑**
 * - `enabled === false` → 不跑，且不算「欠账」
 *
 * 这一层只回答「这轮跑不跑」，不记录账 —— 跑完之后谁去写 `lastRound` 是调用方的事
 * （`markRan` 提供那个纯函数式的写法）。
 *
 * 一条纪律：**脏值一律往「跑」的方向倒**。少跑一次是静默的（正文缺一段，没人报错），
 * 多跑一次只是多花 token，用户能看见。所以任何拿不准的输入都判 `run: true`。
 */

/** 一个任务的触发周期设置。存在任务对象上，随预设一起走。 */
export interface TaskSchedule {
  /** 每 N 轮触发一次；缺省 1（每轮）。非正整数按 1 处理。 */
  everyRounds?: number;
  /** 上次真正触发的轮号；缺省表示从未跑过。 */
  lastRound?: number;
}

export type ScheduleReason = 'always' | 'first' | 'due' | 'not_due' | 'disabled';

export interface ScheduleDecision {
  /** 这轮跑不跑 */
  run: boolean;
  /** 为什么 —— 面板上要能解释，否则用户只会看到「任务没反应」 */
  reason: ScheduleReason;
  /** 按当前设置，下一次该跑的轮号；不可知（被停用）时为 null */
  nextRound: number | null;
}

export interface ScheduleInput {
  /** 当前第几轮（按用户楼层计） */
  round: number;
  everyRounds?: number;
  lastRound?: number;
  enabled?: boolean;
}

/** 轮号规整：非数字、<1、小数都退回一个能用的整数。 */
export function normalizeRound(value: unknown): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1) return 1;
  return n;
}

/** 周期规整：缺省 / 脏值 / <1 一律回到 1（= 每轮）。 */
export function normalizeEveryRounds(value: unknown): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1) return 1;
  return n;
}

/**
 * 这轮该不该跑这个任务。
 *
 * `lastRound` 比当前轮还大（账本错乱、用户回退过楼层）时判 `due` —— 宁可多跑一次，
 * 也不要让一个任务永远卡在「还没到期」上，那种静默失效最难查。
 */
export function shouldRunTask(input: ScheduleInput): ScheduleDecision {
  if (input && input.enabled === false) return { run: false, reason: 'disabled', nextRound: null };

  const round = normalizeRound(input?.round);
  const every = normalizeEveryRounds(input?.everyRounds);

  if (every === 1) return { run: true, reason: 'always', nextRound: round + 1 };

  const rawLast = Number(input?.lastRound);
  if (!Number.isFinite(rawLast) || rawLast < 1) return { run: true, reason: 'first', nextRound: round + every };

  const last = Math.floor(rawLast);
  if (last >= round) return { run: true, reason: 'due', nextRound: round + every };

  const elapsed = round - last;
  if (elapsed >= every) return { run: true, reason: 'due', nextRound: round + every };
  return { run: false, reason: 'not_due', nextRound: last + every };
}

export interface ScheduledTaskLike {
  id: string;
  enabled?: boolean;
  schedule?: TaskSchedule;
}

export interface RoundSelection<T extends ScheduledTaskLike> {
  /** 这轮要跑的任务（顺序与入参一致） */
  due: T[];
  /** 被跳过的：带上原因，面板要显示 */
  skipped: { id: string; decision: ScheduleDecision }[];
}

/**
 * 从整张任务表里挑出这一轮要跑的。
 *
 * 顺序不变 —— 后面还要按阶段分组，这里改动顺序会让阶段的相对次序变得不可预期。
 */
export function selectTasksForRound<T extends ScheduledTaskLike>(tasks: T[], round: number): RoundSelection<T> {
  const list = Array.isArray(tasks) ? tasks.filter(task => task && typeof task.id === 'string' && task.id) : [];
  const due: T[] = [];
  const skipped: { id: string; decision: ScheduleDecision }[] = [];

  for (const task of list) {
    const decision = shouldRunTask({
      round,
      everyRounds: task.schedule?.everyRounds,
      lastRound: task.schedule?.lastRound,
      enabled: task.enabled,
    });
    if (decision.run) due.push(task);
    else skipped.push({ id: task.id, decision });
  }

  return { due, skipped };
}

/** 记下「这个任务在第 N 轮跑过了」。不改入参，返回新对象。 */
export function markRan<T extends ScheduledTaskLike>(task: T, round: number): T {
  const at = normalizeRound(round);
  return { ...task, schedule: { ...(task.schedule || {}), lastRound: at } };
}

/** 批量记：跑完之后把这一轮真正跑过的任务都盖上轮号。 */
export function markRanAll<T extends ScheduledTaskLike>(tasks: T[], ranIds: string[], round: number): T[] {
  const ran = new Set(Array.isArray(ranIds) ? ranIds.filter(id => typeof id === 'string' && id) : []);
  return (Array.isArray(tasks) ? tasks : []).map(task => (task && ran.has(task.id) ? markRan(task, round) : task));
}
