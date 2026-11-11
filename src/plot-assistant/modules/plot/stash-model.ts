/**
 * plot/stash-model.ts — 暂存的纯数据层
 *
 * 这是「按任务暂存 / 断点续跑 / 两版成果切换」的账本，只管算，不管存。
 * 真正的读写（`getChatMessages` / `setChatMessages` / `chat_metadata`）在 `stash-io.ts`，
 * 这样这一层可以在没有酒馆的环境里被完整测到。
 *
 * 核心约定（与施工方案 §5.2 一致）：
 * - **主键是楼层号**，不是输入哈希。用户改自己的输入不该让锚断掉。
 * - **认领靠楼层正文**：酒馆楼层号是数组下标，删中间一层后面全部前移，
 *   所以「这个号还属不属于我」必须拿正文再确认一次。
 * - **对不上就进孤儿区，不猜、不覆盖**。用户随时能把孤儿恢复成新楼层。
 */
import type { PlotTaskResult } from './eng/assemble';

/** 一次完整的落盘成果。一封楼层最多两份。 */
export interface StashLanding {
  /** 稳定 id，面板与 API 都用它指认某一版 */
  id: string;
  /** 落盘时间（毫秒） */
  createdAt: number;
  /** 最终注入正文的 `<plot>` 全文 */
  finalText: string;
  /** 本次落盘用到的预设名 */
  presetName: string;
  /** 逐任务的原始回传，按任务 id 索引（用于「只跑没完成的任务」） */
  taskRaw: Record<string, string>;
  /**
   * 这一版里每个任务各自产出了哪些标签。**老账没有这个字段**，读的时候按空处理。
   *
   * 有了它，用户在面板上删掉某个标签块之后才能反查「该重跑哪个任务」——
   * 只有 `taskRaw`（原始回传）是不够的，那是整段文本，拆不出标签归属。
   */
  taskTags?: Record<string, WorkingTaskTags>;
  /**
   * 从上一楼层继承来的标签快照（按任务 id 分组）。**老账没有这个字段**，读的时候按空处理。
   *
   * 为什么要有它：账本只留最近三层，低频任务（每 N 楼且 N 大于保留层数）上一次的产出
   * 会随着旧 entry 被裁掉，下一轮拿不到它的标签，差量合并会把补丁当全文。每次落盘时
   * 把上一层还有、这一层没覆盖的标签抄进来，三层窗口就变成一条不断代的滚动带。
   * 它只供历史标签投影读取，不算这一版的 `taskTags`（不会影响缺口语义）。
   */
  carriedTags?: Record<string, WorkingTaskTags>;
  /**
   * 落盘时「最终注入模板」里写了哪些标签 —— 也就是**本该进正文**的那些。
   *
   * 为什么不从 `taskTags` 推：任务抽到的标签和进正文的标签是两回事。用户可以在
   * 最终注入指令里删掉某些 `{{标签}}`，那些标签只存档、只进世界书。
   * **老账没有这个字段**，读的时候退回「全部标签都算」。
   */
  textTagNames?: string[];
  /** 是否已凑齐全部标签 */
  complete: boolean;
  /**
   * 面板上的编号（1、2……）。**老账没有这个字段**，读的时候按「第几版」的位置兜底。
   *
   * 为什么要存下来而不是按下标算：用户 2026-11-03 说得很清楚 —— 删掉「1」之后，
   * 「2」必须还叫「2」；这一层再跑一次，新结果才叫「1」。按下标算的话，删掉第一个
   * 之后第二个立刻变成「1」，用户看着就像自己的成果被换掉了。
   */
  seq?: number;
}

/** 单个已完成任务留下的标签，供断点续跑时重建起点（见 `eng/resume.ts`）。 */
export interface WorkingTaskTags {
  /** 这个任务抽出来的标签：名 → 内容 */
  tags: Record<string, string>;
  /** 只进字段、不进正文的标签名 */
  injectOnly: string[];
}

/** 未完成时的进度：哪些任务成了、哪些还欠着。 */
export interface StashWorking {
  /** 已成功回传的任务 id */
  done: string[];
  /** 还欠着的任务 id */
  pending: string[];
  /** 最后一次更新时间 */
  updatedAt: number;
  /**
   * 已完成任务各自的标签。**老账没有这个字段**，读的时候按空处理。
   * 没有它就只能知道「谁成了」，续跑时阶段 2 拿不到阶段 1 的产出。
   */
  taskTags?: Record<string, WorkingTaskTags>;
}

/** 一封用户楼层对应的暂存账。 */
export interface StashEntry {
  floorId: number;
  /** 落账那一刻的楼层正文快照，用来做认领比对 */
  floorText: string;
  presetName: string;
  createdAt: number;
  lastUsedAt: number;
  landings: StashLanding[];
  activeLandingId: string | null;
  working: StashWorking | null;
  state: 'pending' | 'complete';
}

/** 楼层没了（或号被别人占了）但从没被主动删掉的账，进这里等恢复。 */
export interface StashOrphan extends Omit<StashEntry, 'floorId'> {
  originFloorId: number;
  orphanedAt: number;
  reason: 'floor_missing' | 'floor_mismatch';
}

export interface Stash {
  version: 1;
  chatKey: string;
  entries: StashEntry[];
  orphans: StashOrphan[];
}

export const LANDING_MAX = 2;
export const ENTRY_MAX = 3;
export const ORPHAN_MAX = 3;

/**
 * 新一版该拿到的编号：**现有编号里最小的空号**，从 1 开始。
 *
 * 例：这一层有「1」「2」→ 再落一版得先挤掉最旧的（`LANDING_MAX`），挤完剩「2」，
 * 新来的就是「1」。用户 2026-11-03 要的正是这个：删掉 1 之后 2 不变，重跑出来的叫 1。
 */
export function nextLandingSeq(landings: StashLanding[]): number {
  const used = new Set<number>();
  for (const item of landings) {
    const seq = toSeq(item.seq);
    if (seq > 0) used.add(seq);
  }
  let next = 1;
  while (used.has(next)) next += 1;
  return next;
}

/** 面板上显示的那个编号。老账没有 `seq` 就按位置兜底，绝不留空。 */
export function landingSeqOf(landing: StashLanding, index: number): number {
  const seq = toSeq(landing.seq);
  return seq > 0 ? seq : index + 1;
}

function toSeq(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function createStash(chatKey: string): Stash {
  return { version: 1, chatKey, entries: [], orphans: [] };
}

/**
 * 升级模式：把账本里「正在使用」的那版贴回聊天记录，喂给 `$6`（也喂给预览）。
 *
 * 升级模式不往楼层写 `qrf_plot*`（用户 2026-11-03 定的互斥口径），摊出来的 extra 里
 * 自然没有上一轮成果。但 `$6` 只认顶层那几个字段，所以在这里按楼层号把账本贴回去 ——
 * 账本仍是唯一真相源，楼层一个字都不用改。
 */
export function attachLandingsToChat(
  chat: Record<string, unknown>[],
  floors: ReadonlyArray<{ message_id?: number }>,
  stash: Stash,
  presetName: string,
): Record<string, unknown>[] {
  if (stash.entries.length === 0) return chat;
  const byFloor = new Map<number, StashEntry>();
  for (const entry of stash.entries) byFloor.set(entry.floorId, entry);
  return chat.map((message, index) => {
    const floorId = floors[index]?.message_id;
    const entry = typeof floorId === 'number' ? byFloor.get(floorId) : undefined;
    if (!entry) return message;
    const landing = activeLanding(entry);
    if (!landing) return message;
    const plotText = saveContentOfLanding(landing);
    if (plotText === '') return message;
    return {
      ...message,
      qrf_plot: plotText,
      qrf_plot_preset: presetName,
      qrf_plot_tasks: { ...landing.taskRaw },
    };
  });
}

/**
 * 从一版成果的逐任务回传重建 `qrf_plot`（形状与 `eng/assemble.ts` 的 `buildSaveContent` 一致）。
 *
 * 两个用途：升级模式下把账本贴回聊天记录给 `$6` 读；切到 qrf 模式时把账本迁进楼层字段。
 * 单任务时就是那段原始回传；多任务时按 `【剧情任务：id】` 分段 —— 读它的只有 `$6`，
 * 分段标题用 id 而不是任务名，内容不受影响。
 */
/**
 * 从暂存区账本取「上一轮的标签投影」，供 `{{标签}}` 占位符使用。
 *
 * 用户 2026-11-06 定下的口径：AI 读到暂存区里存的上一轮对应标签的投影，
 * 不是从上一楼层的原始回传里现扫（当时明确否决了「按任务 id 取完整回传」）。
 * 账本里每个任务的 `tags` 已是抽好的标签内容 —— 父标签（character_info）
 * 本来就带着子标签（character_archive），只有单独写 `{{character_archive}}`
 * 才只给子标签那份内容。
 *
 * 取「当前楼层之前」最近一层的标签，按 floorId 排，不看 lastUsedAt：同一楼层重跑第二版时
 * 本层的 lastUsedAt 一定最新，按时间排序会选中本层自己，AI 就成了照抄上一版。
 * 同名标签被多个任务产出时按序堆成数组，与 `buildTagMap` 产出的形状一致，可直接并进 `{{标签}}` 的历史表。
 *
 * @param currentFloorId 这一轮锚在哪一楼；只认 floorId 更小的层，本层及其之后的层一律不看。
 *                       不传 = 没有「当前楼层」这个概念，取账本里楼层号最大的那一层。
 */
export function collectStashTagMap(
  stash: Stash | null | undefined,
  currentFloorId: number = Number.POSITIVE_INFINITY,
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const entries = Array.isArray(stash?.entries) ? [...(stash as Stash).entries] : [];
  // 先按楼层号从新到旧排好，再逐层找标签；没标签的层往前让，走完仍没有就返回空表（绝不回退读本层）。
  const candidates = entries
    .filter(entry => (Number(entry.floorId) || 0) < currentFloorId)
    .sort((a, b) => (Number(b.floorId) || 0) - (Number(a.floorId) || 0));
  for (const entry of candidates) {
    const landing = activeLanding(entry);
    const saved = landing ? taskTagRecordsOfLanding(landing) : entry.working?.taskTags;
    if (!saved) continue;
    for (const record of Object.values(saved)) {
      for (const [name, content] of Object.entries(record?.tags ?? {})) {
        if (typeof content !== 'string' || content.trim() === '') continue;
        const bucket = map.get(name);
        if (bucket) bucket.push(content);
        else map.set(name, [content]);
      }
    }
    if (map.size > 0) break;
  }
  return map;
}

export function saveContentOfLanding(landing: StashLanding): string {
  const pairs = Object.entries(landing.taskRaw ?? {}).filter(
    ([, text]) => typeof text === 'string' && text.trim() !== '',
  );
  if (pairs.length === 0) return '';
  if (pairs.length === 1) return pairs[0][1].trim();
  return pairs.map(([taskId, text]) => `【剧情任务：${taskId}】\n${text.trim()}`).join('\n\n');
}

// ───────────────────────── 账本维护 ─────────────────────────

/** 生成一个新的落盘 id。不用随机数是为了让测试可预期：调用方可以把 seed 传进来。 */
export function makeLandingId(floorId: number, createdAt: number, existing: StashLanding[]): string {
  const base = `${floorId}-${createdAt}`;
  if (!existing.some(l => l.id === base)) return base;
  let n = 2;
  while (existing.some(l => l.id === `${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

/**
 * 落一份成果。同楼层已有同 id 的会替换，不会重复。
 * 超过 `LANDING_MAX` 时丢**最旧**的；如果丢掉的正好是当前选中那版，
 * 选中项自动改指向剩下里最新的那版（绝不留一个指向空气的 activeLandingId）。
 */
export function putLanding(entry: StashEntry, landing: StashLanding): StashEntry {
  const rest = entry.landings
    .filter(l => l.id !== landing.id)
    .sort((a, b) => a.createdAt - b.createdAt);
  // 新来的编号要按「挤掉最旧之后还剩谁」算：满两版时最旧那版会被挤走，
  // 它的号就空出来了，新的一版正好接这个号（用户 2026-11-03 的口径）。
  const survivors = rest.length >= LANDING_MAX ? rest.slice(-(LANDING_MAX - 1)) : rest;
  // 没带编号的（老调用方 / 老账补写）在这里补一个，避免面板上出现空号。
  const incoming: StashLanding =
    toSeq(landing.seq) > 0 ? landing : { ...landing, seq: nextLandingSeq(survivors) };
  const landings = [...rest, incoming]
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(-LANDING_MAX);

  let activeLandingId = entry.activeLandingId;
  if (!activeLandingId || !landings.some(l => l.id === activeLandingId)) {
    activeLandingId = landings.length ? landings[landings.length - 1].id : null;
  }
  return { ...entry, landings, activeLandingId, lastUsedAt: landing.createdAt };
}

/** 选某一版为「当前使用」。id 不存在就原样返回，不抛错、不改别的。 */
export function setActiveLanding(entry: StashEntry, landingId: string): StashEntry {
  if (!entry.landings.some(l => l.id === landingId)) return entry;
  return { ...entry, activeLandingId: landingId };
}

/** 丢弃某一版。丢掉当前选中那版时，选中项顺延到剩下最新的一版。 */
export function dropLanding(entry: StashEntry, landingId: string): StashEntry {
  const landings = entry.landings.filter(l => l.id !== landingId);
  let activeLandingId = entry.activeLandingId;
  if (activeLandingId === landingId) {
    activeLandingId = landings.length ? landings[landings.length - 1].id : null;
  }
  return { ...entry, landings, activeLandingId };
}

/** 记进度：谁成了、谁还欠着。全部欠账清零时顺带把 state 标成 complete。 */
export function updateWorking(
  entry: StashEntry,
  done: string[],
  pending: string[],
  now: number,
  taskTags?: Record<string, WorkingTaskTags>,
): StashEntry {
  const working: StashWorking = { done: unique(done), pending: unique(pending), updatedAt: now };
  if (taskTags && Object.keys(taskTags).length) working.taskTags = taskTags;
  return { ...entry, working, state: working.pending.length === 0 ? 'complete' : 'pending', lastUsedAt: now };
}

/** 从任务结果里算出「成了哪些、欠哪些、各自带了什么标签」——引擎每跑完一个阶段就调它一次。 */
export function workingFromResults(
  tasks: { id: string }[],
  results: PlotTaskResult[],
): { done: string[]; pending: string[]; taskTags: Record<string, WorkingTaskTags> } {
  const byId = new Map<string, PlotTaskResult>();
  for (const result of results) {
    if (result && typeof result.taskId === 'string' && result.taskId) byId.set(result.taskId, result);
  }
  const done: string[] = [];
  const pending: string[] = [];
  const taskTags: Record<string, WorkingTaskTags> = {};
  for (const task of tasks) {
    const result = byId.get(task.id);
    if (!result) {
      pending.push(task.id);
      continue;
    }
    // 失败的任务也把**已经回传的标签**记下来：用户要能在暂存区看见 AI 到底回了什么，
    // 而不是因为「没回全」就一片空白。它不进 done，续跑时仍按任务整体重跑。
    if (result.success) done.push(task.id);
    else pending.push(task.id);
    taskTags[task.id] = {
      tags: { ...(result.extractedTags || {}) },
      injectOnly: Array.isArray(result.injectOnlyTagNames) ? [...result.injectOnlyTagNames] : [],
    };
  }
  return { done, pending, taskTags };
}

/** 从这一轮的逐任务结果里算出「任务 → 产出的标签」——落盘时存进 landing，供日后补跑定位。 */
export function taskTagsFromResults(results: PlotTaskResult[]): Record<string, WorkingTaskTags> {
  const out: Record<string, WorkingTaskTags> = {};
  for (const result of results) {
    if (!result || !result.success) continue;
    const id = result.taskId;
    if (typeof id !== 'string' || !id) continue;
    out[id] = {
      tags: { ...(result.extractedTags || {}) },
      injectOnly: Array.isArray(result.injectOnlyTagNames) ? [...result.injectOnlyTagNames] : [],
    };
  }
  return out;
}

/** 一版成果现在缺了哪些标签、分别该由哪个任务重跑。 */
export interface LandingGap {
  /** 缺掉的标签名 */
  tags: string[];
  /** 这些标签分别由哪个任务产出 → 重跑它们就能补回来 */
  taskIds: string[];
}

/**
 * 算缺口时的附加口径。
 *
 * 两个用途，都源于同一条口径（用户 2026-11-11 定）：
 * **核对「这个任务的标签齐不齐」要看它该产出什么，而不是看楼层正文里还剩什么。**
 *
 * 1. `requiredOfTask`：该任务**必达**的标签（抽取标签 − 豁免标签）。
 *    有了它，缺口就只按「它本来就该产出、却一个都没落到暂存区」来算，
 *    不再被 `textTagNames`（模板里写了哪些 `{{标签}}`）牵着走 ——
 *    很多标签只写世界书、根本不进正文，按正文算必然误判。
 * 2. `exemptOfTask`：该任务哪些标签豁免。必达清单没给时作为兜底口径。
 */
export interface LandingGapOptions {
  /** 该任务**必达**的标签名单（小写、已去重）。给了就以它为准。 */
  requiredOfTask?: (taskId: string) => ReadonlySet<string> | null | undefined;
  /** 该任务哪些标签是豁免的（小写、已去重）；必达清单没给时用它兜底。 */
  exemptOfTask?: (taskId: string) => ReadonlySet<string> | null | undefined;
}

/**
 * 算出一版成果相对「它刚跑完时」少了哪些标签。
 *
 * 用户能删的就是面板上那些标签块；删完之后这一版就不完整了，
 * 拿它去生成楼层会把缺的那部分剧情带丢。这里只负责算出缺口，
 * 补不补、什么时候补由调用方决定（见 `planStashRun`）。
 *
 * `presentTags` 传的是**这一版正文里现在还剩的标签名**：
 * 由调用方用 `splitPlotMessage` 拆出来，这一层不碰文本格式。
 */
export function landingGap(
  landing: StashLanding,
  presentTags: Iterable<string>,
  options?: LandingGapOptions,
): LandingGap {
  const saved = landing.taskTags;
  if (!saved || typeof saved !== 'object') return { tags: [], taskIds: [] };

  const present = new Set<string>();
  for (const name of presentTags) {
    if (typeof name === 'string' && name) present.add(name.toLowerCase());
  }

  // 「本该进正文」的清单只在没有必达清单时兜底用。
  // 注意它回答的是「模板里写了多少个 {{标签}}」，不是「这个任务该产出什么」——
  // 很多标签只写世界书、根本不进正文，拿它当核对依据必然误判（2026-11-11 用户指出）。
  const expected = Array.isArray(landing.textTagNames)
    ? new Set(landing.textTagNames.filter((name) => typeof name === 'string' && name).map((name) => name.toLowerCase()))
    : null;

  const tags: string[] = [];
  const taskIds: string[] = [];
  for (const [taskId, entry] of Object.entries(saved)) {
    if (!taskId || !entry || typeof entry !== 'object') continue;
    const injectOnly = new Set((entry.injectOnly || []).map((name) => String(name).toLowerCase()));
    const required = options?.requiredOfTask?.(taskId);
    const exempt = options?.exemptOfTask?.(taskId);
    const savedNames = Object.keys(entry.tags || {}).filter((name) => typeof name === 'string' && name !== '');

    let names: string[];
    if (required) {
      // 主口径（用户 2026-11-11 定）：**必达标签 = 抽取标签 − 豁免标签**。
      // 逐个查它在暂存区里有没有实物：缺了才算缺口，齐了就不该重跑。
      // 这样「一个标签都没回传」的任务会整条被算成缺口（它必然 != 齐全），
      // 而「只差豁免标签」的任务不受影响。
      names = [...required];
    } else {
      names = savedNames.filter((name) => {
        const lower = name.toLowerCase();
        // 豁免标签不要求每轮回传：缺了不算缺口，也就不该把产出它的任务退回去重跑。
        if (exempt && exempt.has(lower)) return false;
        if (expected) return expected.has(lower);
        return !injectOnly.has(lower);
      });
    }

    const missing = names.filter((name) => !present.has(name.toLowerCase()));
    if (missing.length === 0) continue;
    taskIds.push(taskId);
    for (const name of missing) if (!tags.includes(name)) tags.push(name);
  }
  return { tags, taskIds };
}

// ───────────────────────── 楼层锚定 ─────────────────────────

/** 「同一段输入」的开头取样长度。用户 2026-11-04 定的放宽口径：开头十个字符一样就认。 */
export const INPUT_OPENING_LENGTH = 10;

/**
 * 两段输入算不算同一段。
 *
 * 用户口径（2026-11-04）：别认死「一模一样」——重新发送、或在输入框里补了几个字之后，
 * 只要开头十个字符一样就当成同一段输入，接着上一层的进度跑。
 * 取两边较短的长度，所以不足十个字的输入仍然要求全等。
 */
export function sharesOpening(left: string | null | undefined, right: string | null | undefined): boolean {
  const a = String(left ?? '').trim();
  const b = String(right ?? '').trim();
  const length = Math.min(a.length, b.length, INPUT_OPENING_LENGTH);
  return length > 0 && a.slice(0, length) === b.slice(0, length);
}

/**
 * 判断这一层还是不是「我那一层」。
 *
 * 三种结论：
 * - `landed`：楼层正文里已经含某一版的 `finalText` → 铁定是我的，且能指认是哪一版。
 * - `pending`：还没落盘。正文快照是同一段输入（`text_match`，按开头十个字符比）就是原样；
 *   不是（`text_differs`）多半是用户改了自己的输入 —— **仍然认**，只做标记，因为锚本来就是楼层号。
 * - `missing`：楼层号越界了，账要进孤儿区。
 */
export type ClaimResult =
  | { kind: 'landed'; landingId: string }
  | { kind: 'pending'; reason: 'text_match' | 'text_differs' }
  | { kind: 'missing' };

export function claimFloor(entry: StashEntry, floorText: string | null | undefined): ClaimResult {
  if (typeof floorText !== 'string') return { kind: 'missing' };

  // 从新到旧找，先命中哪版就是哪版（同层两份成果可能内容相同，取最新的更合理）
  const landed = [...entry.landings]
    .sort((a, b) => b.createdAt - a.createdAt)
    .find(l => l.finalText && floorText.includes(l.finalText));
  if (landed) return { kind: 'landed', landingId: landed.id };

  return { kind: 'pending', reason: sharesOpening(floorText, entry.floorText) ? 'text_match' : 'text_differs' };
}

/**
 * 对账：把「楼层已经不存在」的账挪进孤儿区。
 *
 * `liveFloorIds` 由调用方从酒馆现取。注意只搬不删 —— 孤儿区本身按 `ORPHAN_MAX` 环形淘汰。
 */
export function reapMissing(stash: Stash, liveFloorIds: number[], now: number): Stash {
  const live = new Set(liveFloorIds);
  const entries: StashEntry[] = [];
  const moved: StashOrphan[] = [];

  for (const entry of stash.entries) {
    if (live.has(entry.floorId)) {
      entries.push(entry);
      continue;
    }
    const { floorId, ...rest } = entry;
    moved.push({ ...rest, originFloorId: floorId, orphanedAt: now, reason: 'floor_missing' });
  }

  if (!moved.length) return stash;
  return {
    ...stash,
    entries,
    orphans: [...stash.orphans, ...moved]
      .sort((a, b) => a.orphanedAt - b.orphanedAt)
      .slice(-ORPHAN_MAX),
  };
}

/**
 * 把孤儿恢复成新楼层。
 *
 * 只挑一版成果带走（默认取它当时选中的那版，没有就取最新那版），
 * 因为「恢复」这个动作的语义是「再造一条用户楼层」，一条楼层只能有一份 `<plot>`。
 * 恢复后从孤儿区移除；新楼层号已存在同名账时覆盖（用户明确点了恢复，以这次为准）。
 */
export function restoreOrphan(
  stash: Stash,
  originFloorId: number,
  newFloorId: number,
  floorText: string,
  landingId: string | null,
  now: number,
): { stash: Stash; entry: StashEntry | null } {
  const orphan = stash.orphans.find(o => o.originFloorId === originFloorId);
  if (!orphan) return { stash, entry: null };

  const chosen =
    orphan.landings.find(l => l.id === landingId) ||
    orphan.landings.find(l => l.id === orphan.activeLandingId) ||
    orphan.landings[orphan.landings.length - 1] ||
    null;

  const entry: StashEntry = {
    floorId: newFloorId,
    floorText,
    presetName: orphan.presetName,
    createdAt: orphan.createdAt,
    lastUsedAt: now,
    landings: chosen ? [chosen] : [],
    activeLandingId: chosen ? chosen.id : null,
    working: orphan.working,
    state: orphan.state,
  };

  return {
    stash: {
      ...stash,
      entries: trimEntries([...stash.entries.filter(e => e.floorId !== newFloorId), entry]),
      orphans: stash.orphans.filter(o => o.originFloorId !== originFloorId),
    },
    entry,
  };
}

// ───────────────────────── 保留策略 ─────────────────────────

/** 只留最近 `ENTRY_MAX` 封楼层的账（楼层号越大越新）。多出来的真删。 */
export function trimEntries(entries: StashEntry[]): StashEntry[] {
  if (entries.length <= ENTRY_MAX) return [...entries];
  return [...entries].sort((a, b) => b.floorId - a.floorId).slice(0, ENTRY_MAX).sort((a, b) => a.floorId - b.floorId);
}

/** 拿一封楼层的账；没有就是 null（调用方据此决定「新建」还是「续跑」）。 */
export function getEntry(stash: Stash, floorId: number): StashEntry | null {
  return stash.entries.find(e => e.floorId === floorId) || null;
}

/** 拿到当前该用哪一版成果。没有选中或指空了就退最新那一版。 */
export function activeLanding(entry: StashEntry): StashLanding | null {
  const picked = entry.landings.find(l => l.id === entry.activeLandingId);
  if (picked) return picked;
  return entry.landings.length ? entry.landings[entry.landings.length - 1] : null;
}

/**
 * 把两组「任务 id → 标签」的记录并起来。同名标签后者覆盖前者，injectOnly 取并集。
 *
 * 为什么单独抽出来：taskTags 是这一版自己的产出，carriedTags 是从上一层继承来的
 * 老标签；读历史投影时两者要按同一个形状合并，写继承快照时又要按同样的规则算差集。
 */
export function mergeTaskTagRecords(
  left: Record<string, WorkingTaskTags> | null | undefined,
  right: Record<string, WorkingTaskTags> | null | undefined,
): Record<string, WorkingTaskTags> {
  const out: Record<string, WorkingTaskTags> = {};
  for (const source of [left, right]) {
    if (!source || typeof source !== 'object') continue;
    for (const [taskId, record] of Object.entries(source)) {
      if (!taskId || !record || typeof record !== 'object') continue;
      const tags: Record<string, string> = {};
      for (const [name, content] of Object.entries(record.tags ?? {})) {
        if (typeof content !== 'string') continue;
        tags[name] = content;
      }
      const injectOnly = Array.isArray(record.injectOnly)
        ? record.injectOnly.filter((name): name is string => typeof name === 'string' && name !== '')
        : [];
      const prev = out[taskId];
      const mergedInject = [...(prev?.injectOnly ?? [])];
      for (const name of injectOnly) if (!mergedInject.includes(name)) mergedInject.push(name);
      out[taskId] = { tags: { ...(prev?.tags ?? {}), ...tags }, injectOnly: mergedInject };
    }
  }
  return out;
}

/** 一版成果的完整标签记录：从上一层继承的缺失标签 + 本版产出（本版同名标签优先）。 */
export function taskTagRecordsOfLanding(landing: StashLanding | null | undefined): Record<string, WorkingTaskTags> {
  if (!landing) return {};
  return mergeTaskTagRecords(landing.carriedTags, landing.taskTags);
}

/** 一封楼层账的完整标签记录：优先读当前成果，没成果时退回工作区里累计的标签。 */
export function taskTagRecordsOfEntry(entry: StashEntry | null | undefined): Record<string, WorkingTaskTags> {
  if (!entry) return {};
  const landing = activeLanding(entry);
  if (landing) return taskTagRecordsOfLanding(landing);
  return mergeTaskTagRecords(entry.working?.taskTags, undefined);
}

/**
 * 新一版成果落盘时，从「当前楼层之前最近的一封账」里挑出本版没覆盖的标签，做成继承快照。
 *
 * 只继承当前版本没有的标签名：本版重写了某个标签就以本版为准，不能被旧内容盖回去。
 * 空内容不继承（空值本来就不会被 collectStashTagMap 收进投影，继承了也没用）。
 * 带了 liveTaskIds 时只继承「当前预设里还在的任务」：任务被删掉后，旧标签不能靠这条
 * 滚动带一直传下去，否则删了任务还会往提示词里续它的旧内容。
 */
export function carryMissingTaskTags(
  previous: StashEntry | null | undefined,
  current: Record<string, WorkingTaskTags> | null | undefined,
  liveTaskIds?: ReadonlySet<string>,
): Record<string, WorkingTaskTags> {
  const previousRecords = taskTagRecordsOfEntry(previous);
  const present = new Set<string>();
  for (const record of Object.values(current ?? {})) {
    for (const name of Object.keys(record?.tags ?? {})) if (name) present.add(name);
  }
  const carried: Record<string, WorkingTaskTags> = {};
  for (const [taskId, record] of Object.entries(previousRecords)) {
    if (liveTaskIds && !liveTaskIds.has(taskId)) continue;
    const tags: Record<string, string> = {};
    for (const [name, content] of Object.entries(record.tags ?? {})) {
      if (!name || present.has(name)) continue;
      if (typeof content !== 'string' || content.trim() === '') continue;
      tags[name] = content;
    }
    if (Object.keys(tags).length === 0) continue;
    carried[taskId] = {
      tags,
      injectOnly: (record.injectOnly ?? []).filter(name => Object.prototype.hasOwnProperty.call(tags, name)),
    };
  }
  return carried;
}

function unique(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}
