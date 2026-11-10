/**
 * 触发周期的锚点：把「这个任务上一次是在哪条用户楼层跑的」记在楼层自己的 extra 里。
 *
 * 为什么记在楼层上，而不是像以前那样记在脚本设置里的一个轮号：
 * - 楼层号是酒馆给的客观事实，不需要我们自己维护「已经跑到第几轮」这种会飘的计数；
 * - 删层重刷 / 回填修改会删掉最新用户楼层及其后面的楼层，锚点跟着被删的楼层一起消失，
 *   更早的锚点还在，所以不会像旧账本那样因为「连点两次重刷各推进一格」而误触发；
 * - 换聊天、换角色卡会换一整套楼层，天然各算各的，不需要额外的聊天级账本。
 *
 * 判据：只数 role === 'user' 的楼层（AI 回复不算），is_hidden 的用户楼层也算
 * —— 与 getChatMessages('0-{{lastMessageId}}') 的默认口径保持一致。
 *
 * 锚点写在 extra[PLOT_ANCHOR_KEY] 这一个独立键里，不在 qrf 那四个键里：
 * clearPlotExtraFromFloor() 只清 qrf 四键，切换暂存模式不会把锚点抹掉。
 */

/** 楼层 extra 里放锚点的键名。 */
export const PLOT_ANCHOR_KEY = 'reroll_plot_anchors';

/** 判定只需要楼层的这几样，不依赖酒馆的完整消息类型。 */
export interface AnchorFloor {
  message_id: number;
  role?: string;
  extra?: Record<string, unknown> | null;
  is_hidden?: boolean;
}

/**
 * 锚点名 = 预设名::任务自带的稳定 id。
 *
 * 后半截用任务 id 而不是「序号 + 任务名」：用户改任务名、上下挪任务顺序之后，
 * 记号名不变，旧锚点不会失配（失配会被判成第一次跑、多跑一次）。
 * 带上预设名前缀仍是必要的：不同预设里可能有同 id 的任务，若共用锚点，
 * 换预设之后新任务会误以为「上一轮刚跑过」而静默少跑一次。
 */
export function anchorNameOf(presetName: string, taskId: string): string {
  const preset = typeof presetName === 'string' ? presetName.trim() : '';
  const id = typeof taskId === 'string' ? taskId.trim() : '';
  return preset + '::' + id;
}

/** 读 extra 里的锚点表；脏值（不是对象 / 数组 / null）一律当空表，判为「没有锚点」→ 跑。 */
export function readAnchorMarks(extra: unknown): Record<string, unknown> {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return {};
  const marks = (extra as Record<string, unknown>)[PLOT_ANCHOR_KEY];
  if (!marks || typeof marks !== 'object' || Array.isArray(marks)) return {};
  return marks as Record<string, unknown>;
}

/** 只有显式写了 true 才算有锚点，别的值（字符串 'true'、1）当作脏值忽略。 */
export function hasAnchor(extra: unknown, anchorName: string): boolean {
  if (!anchorName) return false;
  return readAnchorMarks(extra)[anchorName] === true;
}

/**
 * 从新往旧扫现存楼层，数「距上一条带本任务锚点的用户楼层」隔了几条用户楼层。
 *
 * 返回值是即将发出的那一条与上次锚点之间的间隔：
 * - 现存最后一条用户楼层就带锚点 → 1（下一条才刚过去 1 条）；
 * - 中间隔了 k 条没有锚点的用户楼层 → 1 + k；
 * - 全表找不到锚点 → null（判为「第一次跑」，一定跑）。
 *
 * AI 楼层直接跳过，不计入间隔；被隐藏的用户楼层照常计入。
 */
export function readAnchorGap(floors: AnchorFloor[], anchorName: string): number | null {
  if (!Array.isArray(floors) || !anchorName) return null;
  let gap = 1;
  for (let index = floors.length - 1; index >= 0; index -= 1) {
    const floor = floors[index];
    if (!floor || floor.role !== 'user') continue;
    if (hasAnchor(floor.extra, anchorName)) return gap;
    gap += 1;
  }
  return null;
}

/**
 * 算出要写回的 extra：保留原 extra 里所有别的键（别的脚本塞进来的不能丢），
 * 只在锚点表里补上这一轮真正跑过的任务。
 */
export function buildAnchorExtra(extra: unknown, anchorNames: string[]): Record<string, unknown> {
  const kept: Record<string, unknown> =
    extra && typeof extra === 'object' && !Array.isArray(extra)
      ? { ...(extra as Record<string, unknown>) }
      : {};
  const marks = { ...readAnchorMarks(extra) };
  for (const name of anchorNames) {
    if (typeof name === 'string' && name) marks[name] = true;
  }
  kept[PLOT_ANCHOR_KEY] = marks;
  return kept;
}

/**
 * 给已经落地的用户楼层打锚点。调用方必须确认这是用户楼层。
 *
 * 写楼层的动作由调用方注入（本模块是纯策略，不碰酒馆全局接口）；
 * extra 是整份替换，所以这里用 buildAnchorExtra 先合好再交给它。
 * 写失败不抛：消息已经发出去了，锚点没写上最多让下一条多跑一次，不至于让整轮白跑。
 */
export async function markAnchorsOnFloor(
  floor: { message_id: number; message: string; extra?: Record<string, unknown> | null },
  anchorNames: string[],
  write: (row: { message_id: number; message: string; extra: Record<string, unknown> }) => unknown,
): Promise<boolean> {
  if (!floor || !Number.isFinite(floor.message_id) || anchorNames.length === 0) return false;
  const extra = buildAnchorExtra(floor.extra, anchorNames);
  await write({ message_id: floor.message_id, message: floor.message, extra });
  return true;
}
