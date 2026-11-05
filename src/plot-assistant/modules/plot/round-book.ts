/**
 * plot/round-book.ts — 「每个任务上次在第几轮跑过」的账本（纯函数）
 *
 * `eng/schedule.ts` 只回答「这轮跑不跑」，它需要两个输入：`everyRounds`（用户设的周期）
 * 和 `lastRound`（上次真跑是第几轮）。周期跟着预设走，**账不能跟着预设走** ——
 * 预设是用户随时会导来导去、改来改去的配置文件，把运行时账写进它会带来两个麻烦：
 * 导出给别人的 JSON 里带着「我这边跑到第 37 轮了」，以及每跑一轮就要改一次预设本体。
 *
 * 所以账放在脚本设置里（`PlotSettings.taskRuns`），键是 `预设名::任务id`：
 * - 换预设不串账；
 * - 删掉预设之后那几条账由 `pruneTaskRuns` 顺手清掉，变量不会越攒越大；
 * - 重导一份同名预设时账继续有效（用户视角是「同一个预设又导了一次」，不是新预设）。
 *
 * 一条纪律：**账本里的脏值一律当「没记过」**，也就是 `readTaskLastRound` 返回 `undefined`，
 * 让 `shouldRunTask` 走 `first` 分支去跑。少跑一次是静默的，多跑一次只是多花 token。
 */

/** 账本：`预设名::任务id` → 上次跑过的轮号。 */
export type TaskRunBook = Record<string, number>;

/** 键的分隔符。任务 id 里出现 `::` 的概率远低于预设名里出现，够用。 */
const KEY_SEPARATOR = '::';

export function taskRunKey(presetName: string, taskId: string): string {
  return `${String(presetName ?? '').trim()}${KEY_SEPARATOR}${String(taskId ?? '').trim()}`;
}

/**
 * 这个任务上次在第几轮跑过。没记过、记的是脏值、轮号 < 1 —— 一律 `undefined`。
 */
export function readTaskLastRound(book: unknown, presetName: string, taskId: string): number | undefined {
  const record = book && typeof book === 'object' && !Array.isArray(book) ? (book as TaskRunBook) : null;
  if (!record) return undefined;
  const raw = record[taskRunKey(presetName, taskId)];
  const round = Math.floor(Number(raw));
  if (!Number.isFinite(round) || round < 1) return undefined;
  return round;
}

/**
 * 跑完一轮之后的新账本：把这一轮真正跑过的任务盖上轮号，别的键原样留着。
 *
 * 「真正跑过」指**发出了请求**（成功与否都算）—— 失败的任务下一轮还要重试，
 * 但这一轮它确实消耗了一次调用，不该在「每 N 轮」这件事上被再记一次便宜。
 * 空 id 跳过：记一条 `预设名::` 的空账只会污染账本。
 */
export function writeTaskRuns(
  book: unknown,
  presetName: string,
  ranTaskIds: string[],
  round: number,
): TaskRunBook {
  const record = book && typeof book === 'object' && !Array.isArray(book) ? { ...(book as TaskRunBook) } : {};
  const at = Math.floor(Number(round));
  if (!Number.isFinite(at) || at < 1) return record;
  const name = String(presetName ?? '').trim();
  if (name === '') return record;

  for (const id of Array.isArray(ranTaskIds) ? ranTaskIds : []) {
    const taskId = String(id ?? '').trim();
    if (taskId === '') continue;
    record[taskRunKey(name, taskId)] = at;
  }
  return record;
}

/**
 * 只留下还存在的预设的账。
 *
 * 不清理的后果很实际：用户试过十几个预设，每个预设十来条任务，
 * 账本会变成一个几百键的对象，跟着脚本变量一起被整份写进酒馆 —— 白占体积还难看。
 * 名字取不到（空串）时**不清理**：宁可留着，也别因为一次读空就把账全抹了。
 */
export function pruneTaskRuns(book: unknown, keepPresetNames: string[]): TaskRunBook {
  const record = book && typeof book === 'object' && !Array.isArray(book) ? (book as TaskRunBook) : {};
  const keep = new Set(
    (Array.isArray(keepPresetNames) ? keepPresetNames : []).map(name => String(name ?? '').trim()).filter(Boolean),
  );
  if (keep.size === 0) return { ...record };

  const next: TaskRunBook = {};
  for (const [key, value] of Object.entries(record)) {
    const at = key.lastIndexOf(KEY_SEPARATOR);
    if (at <= 0) continue;
    const name = key.slice(0, at);
    if (keep.has(name)) next[key] = value;
  }
  return next;
}

/**
 * 下一轮的轮号。
 *
 * **每真正跑完一轮就 +1**，哪怕这轮一个任务都没到期 —— 否则「每 3 轮」的任务
 * 会永远等在第 1 轮：轮号不前进，`lastRound` 与当前轮的差就永远不够。
 * 失败的一轮不调用它（调用方负责）：那一轮用户会重刷，重刷应该还是同一轮。
 */
export function advanceRoundIndex(roundIndex: unknown): number {
  const current = Math.floor(Number(roundIndex));
  if (!Number.isFinite(current) || current < 0) return 1;
  return current + 1;
}
