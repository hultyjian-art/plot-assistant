/**
 * plot/eng/schedule.ts — 「按任务设置触发间隔」（纯策略）
 *
 * 这是需求二③。上游 ACU 没有这个东西：它的 triggerWhen 是喂给 agent 判断「要不要选这个任务」
 * 的白话线索，不是条件求值；引擎里每个任务每轮都跑。所以这一层是新建，不是移植，
 * 也就没有原件可比对（tools/plot-parity/schedule-test.ts 的期望值全部写死）。
 *
 * 口径（用户 2026-11-09 拍板，改为锚定楼层身份）：
 * - 数的是**第几条用户楼层**，不是绝对楼层号。AI 回复不算，被隐藏的用户楼层算。
 * - 每个任务各自在跑过的那条用户楼层上留一个锚点（见 plot/floor-anchor.ts）。
 * - gap = 即将发出的这条用户楼层，与上一次带本任务锚点的用户楼层之间隔了几条用户楼层；
 *   gap 为 null 表示全表找不到锚点 = 第一次跑，一定跑。
 * - everyRounds 缺省或为 1 → 每条用户楼层都触发，默认值不改变任何现有用法。
 * - everyRounds = N > 1 → gap >= N 才再跑一次。
 * - enabled === false → 不跑，且不算欠账。
 *
 * 这一层只回答「这条楼层跑不跑」，不写锚点 —— 跑完之后谁去打锚点是调用方的事。
 *
 * 一条纪律：**脏值一律往「跑」的方向倒**。少跑一次是静默的（正文缺一段，没人报错），
 * 多跑一次只是多花 token，用户能看见。所以任何拿不准的输入都判 run: true。
 * 旧方案里「上次轮号比当前还大 → 判 due」的兜底，在锚点法里天然不成立（锚点只记存在、
 * 不记号码，gap 不会是负数）；等价的兜底是「找不到锚点 / 锚点数据读不懂 → first，一定跑」。
 */

/** 一个任务的触发周期设置。存在任务对象上，随预设一起走。 */
export interface TaskSchedule {
  /** 每 N 条用户楼层触发一次；缺省 1（每条都跑）。非正整数按 1 处理。 */
  everyRounds?: number;
  /** 老版本记的「上次跑过的轮号」。现在判定不再读它，保留只为兼容旧预设数据。 */
  lastRound?: number;
}

export type ScheduleReason = 'always' | 'first' | 'due' | 'not_due' | 'disabled';

export interface ScheduleDecision {
  /** 这条楼层跑不跑 */
  run: boolean;
  /** 为什么 —— 面板上要能解释，否则用户只会看到「任务没反应」 */
  reason: ScheduleReason;
}

export interface ScheduleInput {
  /** 距上一次带本任务锚点的用户楼层隔了几条；null = 全表没有锚点（第一次跑） */
  gap: number | null;
  everyRounds?: number;
  enabled?: boolean;
}

/** 周期规整：缺省 / 脏值 / <1 一律回到 1（= 每条用户楼层都跑）。 */
export function normalizeEveryRounds(value: unknown): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1) return 1;
  return n;
}

/**
 * 这条用户楼层该不该跑这个任务。
 *
 * gap 拿不准（null / 非数字 / <1）一律判 first —— 宁可多跑一次，
 * 也不要让一个任务永远卡在「还没到期」上，那种静默失效最难查。
 */
export function shouldRunTask(input: ScheduleInput): ScheduleDecision {
  if (input && input.enabled === false) return { run: false, reason: 'disabled' };

  const every = normalizeEveryRounds(input?.everyRounds);
  if (every === 1) return { run: true, reason: 'always' };

  const rawGap = input?.gap;
  if (rawGap === null || rawGap === undefined || !Number.isFinite(Number(rawGap)) || Number(rawGap) < 1) {
    return { run: true, reason: 'first' };
  }
  if (Math.floor(Number(rawGap)) >= every) return { run: true, reason: 'due' };
  return { run: false, reason: 'not_due' };
}

export interface ScheduledTaskLike {
  id: string;
  enabled?: boolean;
  schedule?: TaskSchedule;
}

export interface FloorSelection<T extends ScheduledTaskLike> {
  /** 这条楼层要跑的任务（顺序与入参一致） */
  due: T[];
  /** 被跳过的：带上原因，面板要显示 */
  skipped: { id: string; decision: ScheduleDecision }[];
}

/**
 * 从整张任务表里挑出这条用户楼层要跑的。
 *
 * 顺序不变 —— 后面还要按阶段分组，这里改动顺序会让阶段的相对次序变得不可预期。
 * gapOf 由调用方提供：它负责从现存楼层里数出每个任务自己的间隔。
 */
export function selectTasksForFloor<T extends ScheduledTaskLike>(
  tasks: T[],
  gapOf: (taskId: string) => number | null,
): FloorSelection<T> {
  const list = Array.isArray(tasks) ? tasks.filter(task => task && typeof task.id === 'string' && task.id) : [];
  const due: T[] = [];
  const skipped: { id: string; decision: ScheduleDecision }[] = [];

  for (const task of list) {
    const decision = shouldRunTask({
      gap: gapOf(task.id),
      everyRounds: task.schedule?.everyRounds,
      enabled: task.enabled,
    });
    if (decision.run) due.push(task);
    else skipped.push({ id: task.id, decision });
  }

  return { due, skipped };
}
