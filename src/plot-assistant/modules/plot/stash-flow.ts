/**
 * 暂存的「业务动作」层：把纯数据层的零件拼成三个真实场景。
 *
 * 纯数据层（`stash-model.ts`）只认识「加一版 / 减一版 / 认领」这些原子操作，
 * 但调用方真正要问的是三个问题：
 *   1. 这一轮该不该接着上次跑？（`planStashRun`）
 *   2. 又跑完一个任务了，账本怎么记？（`commitProgress`）
 *   3. 整轮跑完了，这一版成果怎么落？（`commitLanding`）
 *
 * 为什么要单独一层：这三个动作都要读旧账、改形状、裁到上限，写进 `run-in-flow.ts`
 * 会把那条本来就很长的链路撑到看不见重点；写进纯数据层又会把「一轮」「一版」
 * 这种业务概念塞进去，那层的对照测试立刻全红。
 */

import type { PlotTaskResult } from './eng/assemble';
import { splitPlotMessage } from './stash-edit';
import {
  ENTRY_MAX,
  ORPHAN_MAX,
  claimFloor,
  createStash,
  getEntry,
  landingGap,
  makeLandingId,
  putLanding,
  reapMissing,
  setActiveLanding,
  sharesOpening,
  taskTagsFromResults,
  updateWorking,
  workingFromResults,
  type Stash,
  type StashEntry,
  type StashLanding,
  type StashOrphan,
  type StashWorking,
  type WorkingTaskTags,
} from './stash-model';

/** 这一轮和这一层的关系。 */
export type StashClaimKind =
  /** 这一层还没有账：全新一轮 */
  | 'new'
  /** 这一层已经有一版完整成果（正文里能找到它）：完成后再点发送 = 重新开始一轮 */
  | 'landed'
  /** 这一层上次没跑完、但正文一字没改：接着跑 */
  | 'pending'
  /** 这一层上次没跑完、正文被改过：不再接着跑，重新开始 */
  | 'differs'
  /** 账上写着这一层，但楼层已经不在了 */
  | 'missing';

export interface PlanStashRunInput {
  stash: Stash;
  floorId: number;
  floorText: string;
  /** 现在聊天里还活着的楼层号（对账用） */
  liveFloorIds: number[];
  /** 这一轮真正要跑的任务 id（判断「是不是全都落盘了」用；不给就按老规矩只认正文一致） */
  taskIds?: string[];
  now: number;
}

export interface PlanStashRunResult {
  stash: Stash;
  entry: StashEntry | null;
  /** 要递给引擎的起点；`null` = 从头跑 */
  working: StashWorking | null;
  claim: StashClaimKind;
  /** 是不是「接着上次跑」 */
  resumed: boolean;
}

/**
 * 开跑之前先对账，再判断这一轮怎么跑。
 *
 * 一条必须守住的规矩：**账本读不懂也不能让推进停摆**。这里的失败分支只会「少续跑一次」，
 * 不会「整轮不跑」——用户点的是发送，最坏的结果也应该是「从头再跑一遍」。
 */
export function planStashRun(input: PlanStashRunInput): PlanStashRunResult {
  const now = Number.isFinite(input.now) ? input.now : Date.now();
  // 本层若是「还没建出来的下一层」，对账时要保它一命。
  //
  // 「点发送」这条路锚的是**还没建的下一层**（`send-gate` 传 `最后一层 + 1`）。
  // 这个号当然不在 liveFloorIds 里 —— 直接对账就会把本层的账当成「楼层已删」搬进孤儿区，
  // 于是第二次点发送时 `getEntry` 落空、carried 也搜不到（它已经被搬走了），
  // 整轮从头重跑 = 用户什么都没改也全量发送（2026-11-04 实测，与文本比对无关）。
  //
  // 只保护「比现存最大楼层还大」的号：那一定是待建的新层。
  // 若号落在现存区间里却不在聊天中，那是真被删了，照旧搬孤儿区。
  const maxLiveFloor = input.liveFloorIds.length > 0 ? Math.max(...input.liveFloorIds) : -1;
  const liveFloorIds = input.floorId > maxLiveFloor
    ? [...input.liveFloorIds, input.floorId]
    : input.liveFloorIds;
  // 先对账：楼层被删掉的账搬进孤儿区（只搬不删，恢复时还能找回那一版）。
  let stash = reapMissing(input.stash, liveFloorIds, now);
  const entry = getEntry(stash, input.floorId);

  if (!entry) {
    // 用户可能拿某一版成果当输入重新发（面板上的「应用到输入框」就是这条路）。
    // 那一版要是被删过标签，这里就只补跑缺的那几个任务，而不是整轮从头再来。
    const reused = findReusedLanding(stash, input.floorText);
    if (reused) {
      const gap = landingGap(reused.landing, presentTagNames(input.floorText));
      if (gap.taskIds.length > 0) {
        const taskTags = reused.landing.taskTags ?? {};
        const done = Object.keys(taskTags).filter((id) => !gap.taskIds.includes(id));
        return {
          stash,
          entry: reused.entry,
          working: { done, pending: gap.taskIds, updatedAt: now, taskTags },
          claim: 'pending',
          resumed: true,
        };
      }
    }
    // 用户口径（2026-11-04）：上一轮没跑完、用户又点了一次发送 —— 新楼层、同一句话。
    // 这时候不能整轮重跑：把上一层的进度（哪些任务已经落盘）接到这一层上，只补没跑完的。
    // 同日再放宽：别认死「一模一样」，重新发送时输入框里常多一个空格或少几个字，
    // 只要开头十个字符一样就当成同一段输入。候选有多条时接最近用过的那条。
    const carried = stash.entries
      .filter(
        (item) =>
          item.floorId !== input.floorId
          && item.landings.length === 0
          && (item.working?.done.length ?? 0) > 0
          && sharesOpening(item.floorText, input.floorText),
      )
      .sort((left, right) => (right.lastUsedAt ?? 0) - (left.lastUsedAt ?? 0))[0];
    if (carried && carried.working) {
      const moved: StashEntry = { ...carried, floorId: input.floorId, lastUsedAt: now };
      const rest: Stash = { ...stash, entries: stash.entries.filter((item) => item.floorId !== carried.floorId) };
      return {
        stash: upsertEntry(rest, moved),
        entry: moved,
        working: carried.working,
        claim: 'pending',
        resumed: true,
      };
    }
    return { stash, entry: null, working: null, claim: 'new', resumed: false };
  }

  const claim = claimFloor(entry, input.floorText);
  if (claim.kind === 'landed') {
    // 这一层已经有一版完整成果。用户说得很清楚：完成之后再点发送就是重新开始一轮。
    return { stash, entry, working: null, claim: 'landed', resumed: false };
  }

  if (claim.kind === 'pending' && claim.reason === 'text_match' && entry.working) {
    // 用户口径（2026-11-04）：已经落盘的任务不再重发；**只有这一轮的任务全都落盘了才整轮重发**。
    const planned = (input.taskIds ?? []).filter((id) => typeof id === 'string' && id);
    const allDone = planned.length > 0 && planned.every((id) => entry.working?.done.includes(id) === true);
    if (!allDone) {
      return { stash, entry, working: entry.working, claim: 'pending', resumed: true };
    }
  }

  if (claim.kind === 'pending' && claim.reason === 'text_differs' && entry.landings.length > 0) {
    // 同一层换了话：旧账属于旧的那段输入，留着只会在面板上冒充这一层的成果。
    // 搬进孤儿区（不删），然后从空白开始。
    const archived = archiveEntry(stash, entry, 'floor_mismatch', now);
    stash = archived;
    return { stash, entry: null, working: null, claim: 'differs', resumed: false };
  }

  // 其余情况（正文一致但没进度 / 正文改了但还没有成果 / 楼层结构不对劲）都当重新开始。
  return { stash, entry, working: null, claim: claim.kind, resumed: false };
}

/** 一段正文里现在还剩哪些标签名。 */
function presentTagNames(text: string): string[] {
  return splitPlotMessage(text).blocks.map((block) => block.tag);
}

/**
 * 这段正文是不是带着某一版成果的全文。
 *
 * 面板的「应用到输入框」把「用户原话 + 这一版」整段搬进发送框，用户再点发送时，
 * 新楼层里就原样有这一版。找回它是为了知道「用户用的是哪一版、缺了哪些标签」——
 * 不这么找，新楼层对账时只会被判成「全新一轮」，缺的那段剧情永远补不回来。
 */
function findReusedLanding(stash: Stash, floorText: string): { entry: StashEntry; landing: StashLanding } | null {
  const text = typeof floorText === 'string' ? floorText : '';
  if (!text) return null;
  for (const entry of stash.entries) {
    for (const landing of entry.landings) {
      const marker = typeof landing.finalText === 'string' ? landing.finalText.trim() : '';
      if (marker.length > 0 && text.includes(marker)) return { entry, landing };
    }
  }
  return null;
}

export interface CommitProgressInput {
  stash: Stash;
  floorId: number;
  floorText: string;
  presetName: string;
  /** 这一轮**打算**跑的任务（引擎在发第一个请求前给的） */
  plannedIds: string[];
  /** 这一轮**已经**跑完的任务（含失败的） */
  results: PlotTaskResult[];
  now: number;
}

export interface CommitProgressResult {
  stash: Stash;
  entry: StashEntry;
}

/**
 * 每跑完一个任务落一次账。
 *
 * `done` 必须是**累计**的：续跑这一轮只跑剩下那两个，但上一次跑成的三个不能从账上掉下去，
 * 否则下一次续跑会把它们再跑一遍 —— 同一段剧情被抽两次，标签就会叠成两份。
 */
export function commitProgress(input: CommitProgressInput): CommitProgressResult {
  const now = Number.isFinite(input.now) ? input.now : Date.now();
  const prev = getEntry(input.stash, input.floorId);
  const planned = input.plannedIds.filter((id) => typeof id === 'string' && id).map((id) => ({ id }));
  const run = workingFromResults(planned, input.results);

  const prevDone = prev?.working?.done ?? [];
  const done = dedupe([...prevDone, ...run.done]);
  const pending = run.pending.filter((id) => !done.includes(id));
  const taskTags = mergeTaskTags(prev?.working?.taskTags, run.taskTags);

  const base: StashEntry = prev ?? newEntry(input.floorId, input.floorText, input.presetName, now);
  const updated = updateWorking(
    { ...base, floorText: input.floorText, presetName: input.presetName, lastUsedAt: now },
    done,
    pending,
    now,
    taskTags,
  );

  return { stash: upsertEntry(input.stash, updated), entry: updated };
}

export interface CommitLandingInput {
  stash: Stash;
  floorId: number;
  floorText: string;
  presetName: string;
  /** 拼进楼层的那一整段（指令头 + `<plot>`） */
  finalText: string;
  /** 写进 `qrf_plot` 的原文 */
  saveContent: string;
  results: PlotTaskResult[];
  /** 最终注入模板里写了的标签名（本该进正文的那些）；不传则按「全部标签」处理 */
  textTagNames?: string[];
  now: number;
}

export interface CommitLandingResult {
  stash: Stash;
  entry: StashEntry;
  landing: StashLanding;
  /** 被挤掉的最旧那一版（没有就是 null） */
  evicted: StashLanding | null;
}

/**
 * 整轮跑完了：把这一版成果落到这一层。
 *
 * 同一层已经有两版时，`putLanding` 会挤掉最旧那版 —— 用户 2026-11-02 明确要的行为
 * （原方案 §7.3 的「问用户覆盖第 1 版还是第 2 版」作废：自动跑，跑完删最旧）。
 */
export function commitLanding(input: CommitLandingInput): CommitLandingResult {
  const now = Number.isFinite(input.now) ? input.now : Date.now();
  const prev = getEntry(input.stash, input.floorId);
  const base: StashEntry = prev ?? newEntry(input.floorId, input.floorText, input.presetName, now);

  const landingId = makeLandingId(input.floorId, now, base.landings);
  // 续跑时本轮只跑剩下的任务，先前跑完的标签在 `base.working.taskTags` 里 ——
  // 落盘必须把两半合起来，否则这一版会看起来「缺了上半场」。
  const taskTags = mergeTaskTags(base.working?.taskTags, taskTagsFromResults(input.results));
  const landing: StashLanding = {
    id: landingId,
    createdAt: now,
    finalText: input.finalText,
    presetName: input.presetName,
    taskRaw: collectTaskRaw(input.results),
    // 老账没这个字段，新落的都记上：日后用户删了某个标签块，才能反查该重跑谁
    ...(Object.keys(taskTags).length > 0 ? { taskTags } : {}),
    // 「哪些标签本该进正文」由最终注入模板决定（调用方算好传进来），不是任务抽了什么就要求什么
    ...(Array.isArray(input.textTagNames) ? { textTagNames: [...input.textTagNames] } : {}),
    complete: true,
  };

  let entry = putLanding(
    { ...base, floorText: input.floorText, presetName: input.presetName, working: null, state: 'complete' },
    landing,
  );
  entry = setActiveLanding(entry, landing.id);
  // 编号是 `putLanding` 按「挤掉最旧之后还剩谁」算出来的，这里把它捞回来再返回，
  // 免得调用方拿到一份没有 seq 的副本。
  const stored = entry.landings.find((item) => item.id === landingId) ?? landing;
  const evicted = base.landings.find((item) => !entry.landings.some((kept) => kept.id === item.id)) ?? null;

  return { stash: upsertEntry(input.stash, entry), entry, landing: stored, evicted };
}

/**
 * 把一条账挪进孤儿区（只搬不删）。
 *
 * 用在「同一层换了话」：旧成果属于旧输入，硬留着会在面板上冒充这一层的成果，
 * 直接删又违背「用户没让我删就别删」——所以搬走，恢复流程还能捡回来。
 */
export function archiveEntry(stash: Stash, entry: StashEntry, reason: StashOrphan['reason'], now: number): Stash {
  const orphan: StashOrphan = {
    ...entry,
    originFloorId: entry.floorId,
    orphanedAt: Number.isFinite(now) ? now : Date.now(),
    reason,
  };
  const orphans = [...stash.orphans, orphan].slice(-ORPHAN_MAX);
  return {
    ...stash,
    entries: stash.entries.filter((item) => item.floorId !== entry.floorId),
    orphans,
  };
}

/**
 * 面板用：按楼层号从小到大排好的条目。
 *
 * 用户 2026-11-02 描述面板时写的是「第 4、5、6 楼各自暂存了两次，从上到下列着三个横栏」——
 * 也就是从上往下就是剧情往后走的顺序。新楼层在上虽然更「最近优先」，但读起来像倒着翻剧本。
 */
export function listEntries(stash: Stash): StashEntry[] {
  return [...stash.entries].sort((a, b) => a.floorId - b.floorId);
}

/** 面板编辑保存：改正文、删标签块都落到这里。 */
export interface EditLandingInput {
  stash: Stash;
  floorId: number;
  landingId: string;
  finalText: string;
  /**
   * 账本里「只进字段 / 写进世界书」标签的编辑：标签名 → 新内容。
   * 空串 = 从账本删掉这个标签。正文里没有这些块，所以不能用删正文块的办法改。
   */
  ledgerEdits?: Record<string, string>;
  now: number;
}

export function editLanding(input: EditLandingInput): { stash: Stash; entry: StashEntry } | null {
  const entry = getEntry(input.stash, input.floorId);
  if (!entry) return null;
  const index = entry.landings.findIndex((item) => item.id === input.landingId);
  if (index < 0) return null;

  const landings = entry.landings.slice();
  const ledgerEdits = input.ledgerEdits;
  const savedTags = landings[index].taskTags;
  if (ledgerEdits && savedTags) {
    const next: typeof savedTags = {};
    for (const [taskId, record] of Object.entries(savedTags)) {
      const tags = { ...(record.tags ?? {}) };
      const injectOnly = [...(record.injectOnly ?? [])];
      for (const [name, content] of Object.entries(ledgerEdits)) {
        if (!Object.prototype.hasOwnProperty.call(tags, name)) continue;
        if (content === '') {
          delete tags[name];
          const at = injectOnly.indexOf(name);
          if (at >= 0) injectOnly.splice(at, 1);
        } else {
          tags[name] = content;
        }
      }
      next[taskId] = { tags, injectOnly };
    }
    landings[index] = { ...landings[index], finalText: input.finalText, taskTags: next };
  } else {
    landings[index] = { ...landings[index], finalText: input.finalText };
  }
  const updated: StashEntry = {
    ...entry,
    landings,
    lastUsedAt: Number.isFinite(input.now) ? input.now : Date.now(),
  };
  return { stash: upsertEntry(input.stash, updated), entry: updated };
}

/** 面板编辑保存：整版删掉（用户明确要删才走这里）。 */
export function removeLanding(stash: Stash, floorId: number, landingId: string, now: number): { stash: Stash; entry: StashEntry } | null {
  const entry = getEntry(stash, floorId);
  if (!entry) return null;
  const landings = entry.landings.filter((item) => item.id !== landingId);
  if (landings.length === entry.landings.length) return null;

  const activeLandingId =
    entry.activeLandingId && landings.some((item) => item.id === entry.activeLandingId)
      ? entry.activeLandingId
      : (landings[landings.length - 1]?.id ?? null);

  const updated: StashEntry = {
    ...entry,
    landings,
    activeLandingId,
    lastUsedAt: Number.isFinite(now) ? now : Date.now(),
  };
  // 一版都不剩的账没有意义：整条撤掉，下一次发送就是全新一轮。
  if (landings.length === 0) {
    return {
      stash: { ...stash, entries: stash.entries.filter((item) => item.floorId !== floorId) },
      entry: updated,
    };
  }
  return { stash: upsertEntry(stash, updated), entry: updated };
}

/** 全新的空账（导出给测试与面板用）。 */
export function emptyStash(chatKey: string): Stash {
  return createStash(chatKey);
}

function newEntry(floorId: number, floorText: string, presetName: string, now: number): StashEntry {
  return {
    floorId,
    floorText,
    presetName,
    createdAt: now,
    lastUsedAt: now,
    landings: [],
    activeLandingId: null,
    working: null,
    state: 'pending',
  };
}

/** 写进一条账；顺手裁到上限（多的整条删，和文档一致：只留最近几层）。 */
function upsertEntry(stash: Stash, entry: StashEntry): Stash {
  const others = stash.entries.filter((item) => item.floorId !== entry.floorId);
  const entries = [...others, entry].sort((a, b) => a.floorId - b.floorId).slice(-ENTRY_MAX);
  return { ...stash, entries };
}

function mergeTaskTags(
  prev: Record<string, WorkingTaskTags> | undefined,
  next: Record<string, WorkingTaskTags> | undefined,
): Record<string, WorkingTaskTags> {
  const merged: Record<string, WorkingTaskTags> = { ...(prev ?? {}) };
  for (const [taskId, value] of Object.entries(next ?? {})) {
    if (!value || typeof value !== 'object') continue;
    merged[taskId] = { tags: { ...(value.tags ?? {}) }, injectOnly: [...(value.injectOnly ?? [])] };
  }
  return merged;
}

function collectTaskRaw(results: PlotTaskResult[]): Record<string, string> {
  const raw: Record<string, string> = {};
  for (const result of results) {
    if (!result || result.success !== true) continue;
    if (typeof result.taskId !== 'string' || !result.taskId) continue;
    raw[result.taskId] = typeof result.rawResponse === 'string' ? result.rawResponse : '';
  }
  return raw;
}

function dedupe(ids: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (typeof id !== 'string' || !id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}
