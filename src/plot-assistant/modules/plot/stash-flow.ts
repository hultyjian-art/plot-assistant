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
import { extractTaskTags } from './eng/tags';
import {
  ENTRY_MAX,
  ORPHAN_MAX,
  carryMissingTaskTags,
  claimFloor,
  createStash,
  dropLanding,
  getEntry,
  landingGap,
  makeLandingId,
  putLanding,
  reapMissing,
  setActiveLanding,
  sharesOpening,
  taskTagRecordsOfEntry,
  taskTagsFromResults,
  updateWorking,
  workingFromResults,
  type LandingGap,
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
  /**
   * 某个任务的「抽取标签」原文（逗号分隔）。缺省 = 按账本里已抽到的标签算。
   *
   * 缺口语义必须和验收一致（用户 2026-11-11 定的口径）：
   * **必达标签 = 抽取标签 − 豁免标签**，逐个查它在暂存区里有没有实物。
   */
  requiredTagsOfTask?: (taskId: string) => string | undefined;
  /**
   * 某个任务的「豁免标签」原文（逗号分隔）。缺省 = 没有豁免。
   *
   * 豁免不要求每轮回传，所以它在缺口核算里也必须一样不算数 ——
   * 否则「验收放过 → 续跑又判它缺 → 整条重发」，豁免形同虚设。
   */
  exemptTagsOfTask?: (taskId: string) => string | undefined;
  /**
   * 暂存区查不到时，兜底去查楼层 `qrf` 字段里这个任务已经产出过哪些标签（用户 2026-11-11）。
   *
   * 账本只留最近三层、换设备后也可能没跟着过来，但楼层的 `qrf_plot_tasks`
   * 还留着那一轮的原始回传。返回 `null`/`undefined` = 这一格查不到，按没有处理。
   */
  qrfTagsOfTask?: (taskId: string) => ReadonlySet<string> | null | undefined;
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
      const gap = landingGap(
        reused.landing,
        collectSavedTagNames(reused.landing.taskTags),
        requiredOption(input.requiredTagsOfTask, input.exemptTagsOfTask),
      );
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

    // 玩家可能把已完成任务的标签从正文里删掉了：那些任务不能再算「已完成」。
    // 缺口口径完全复用 landingGap（含「只进字段的标签不算缺口」），把不齐的从 done 挪回 pending。
    const gap = workingTagGap(
      entry,
      input.requiredTagsOfTask,
      input.exemptTagsOfTask,
      input.qrfTagsOfTask,
    );
    const lost = gap.taskIds.filter((id) => entry.working?.done.includes(id) === true);
    const working: StashWorking = {
      ...entry.working,
      done: entry.working.done.filter((id) => !lost.includes(id)),
      pending: dedupe([...entry.working.pending, ...lost]),
    };
    if (!allDone || lost.length > 0) {
      return { stash, entry, working, claim: 'pending', resumed: true };
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

/**
 * 续跑前的标签核对：把「进度里记的账」当成一版成果，交给 `landingGap` 用同一套口径比。
 *
 * `StashWorking` 本身没有 `textTagNames`，就从这一层已落盘的某一版借「本该进正文的清单」；
 * 老账（没有这个字段）由 `landingGap` 自己退回「全部标签减 injectOnly」。
 *
 * **只认带成果的正文。** 这个核对回答的是「玩家把已落盘任务的标签删了吗」，
 * 前提是正文里确实摆着一份成果。点发送时递进来的正文是玩家的输入原文（没有 `<plot>`），
 * 里面本来就没有任何标签块 —— 照算的话每个标签都算「被删了」，所有已完成任务全部退回
 * 待跑，续跑就退化成每轮全量重发（用户 2026-11-11 报的正是这个）。正文里没有成果，
 * 就说明没人删过东西，缺口为空。
 */
function workingTagGap(
  entry: StashEntry,
  requiredTagsOfTask?: (taskId: string) => string | undefined,
  exemptTagsOfTask?: (taskId: string) => string | undefined,
  qrfFallback?: (taskId: string) => ReadonlySet<string> | null | undefined,
): LandingGap {
  const working = entry.working;
  if (!working) return { tags: [], taskIds: [] };
  const textTagNames = entry.landings.find((item) => Array.isArray(item.textTagNames))?.textTagNames;
  const probe: StashLanding = {
    id: '',
    createdAt: 0,
    finalText: '',
    presetName: '',
    taskRaw: {},
    complete: false,
    taskTags: working.taskTags ?? {},
    ...(textTagNames ? { textTagNames } : {}),
  };
  // 核对来源是**暂存区**（这一层进度里已经落盘的标签），不是楼层正文。
  // 很多标签只写世界书、根本不进正文，拿正文对照必然误判（用户 2026-11-11）。
  const saved = collectSavedTagNames(working.taskTags);
  // 暂存区查不到 → 兜底查楼层的 qrf 字段（用户口径）。两处取并集：
  // 任意一边能证明「这个标签产出过」，就不该把它算成缺口。
  const present = qrfFallback
    ? new Set<string>([
        ...saved,
        ...[...collectQrfTagNames(working.taskTags, qrfFallback)],
      ])
    : saved;
  return landingGap(probe, present, requiredOption(requiredTagsOfTask, exemptTagsOfTask));
}

/** 对每个任务问一次 qrf 兜底，取并集。查不到就是空集，不影响原有判定。 */
function collectQrfTagNames(
  taskTags: Record<string, WorkingTaskTags> | undefined,
  qrfFallback: (taskId: string) => ReadonlySet<string> | null | undefined,
): Set<string> {
  const out = new Set<string>();
  const ids = new Set<string>(Object.keys(taskTags ?? {}));
  for (const taskId of ids) {
    if (!taskId) continue;
    const got = qrfFallback(taskId);
    if (!got) continue;
    for (const name of got) if (typeof name === 'string' && name) out.add(name.toLowerCase());
  }
  return out;
}

/**
 * 从楼层的 `qrf` 字段兜底还原「某个任务已经产出过哪些标签」。
 *
 * 用户口径（2026-11-11）：核对先看暂存区，**暂存区查不到再兜底查 qrf 字段**。
 * 什么时候会查不到：账本被裁掉（只留最近三层）、换设备后账本没跟着过来、
 * 或者用户手动清过聊天变量 —— 而楼层里的 `qrf_plot_tasks` 还留着那一轮的原始回传。
 *
 * `qrf_plot_tasks` 存的是**每个任务的原始回传文本**（不是抽好的标签），
 * 所以要用这个任务自己的抽取名单重新抽一遍，抽到什么就算它产出过什么。
 */
export function tagsFromQrfTaskRaw(
  taskRaw: unknown,
  extractTags?: string,
  exemptTags?: string,
  extractInjectTags?: string,
): Set<string> {
  const out = new Set<string>();
  if (!taskRaw || typeof taskRaw !== 'object') return out;
  const configured = [extractTags || '', exemptTags || '', extractInjectTags || '']
    .filter((part) => part.trim() !== '')
    .join(',');
  if (configured.trim() === '') return out;
  for (const raw of Object.values(taskRaw as Record<string, unknown>)) {
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    try {
      const extraction = extractTaskTags(raw, configured, '');
      for (const [name, content] of Object.entries(extraction.extractedTags)) {
        if (typeof content === 'string' && content.trim() !== '') out.add(name.toLowerCase());
      }
    } catch {
      // 单条回传抽不出来不该连累整轮：跳过它，继续看别的任务。
    }
  }
  return out;
}

/** 暂存区里这个任务已经落下实物的标签名（去重、小写）。 */
function collectSavedTagNames(taskTags: Record<string, WorkingTaskTags> | undefined): Set<string> {
  const out = new Set<string>();
  for (const record of Object.values(taskTags ?? {})) {
    for (const [name, content] of Object.entries(record?.tags ?? {})) {
      if (typeof content !== 'string' || content.trim() === '') continue;
      out.add(name.toLowerCase());
    }
  }
  return out;
}

/** 必达清单 = 抽取标签 − 豁免标签；算好包成 `landingGap` 要的查询函数。 */
function requiredOption(
  requiredTagsOfTask?: (taskId: string) => string | undefined,
  exemptTagsOfTask?: (taskId: string) => string | undefined,
): { requiredOfTask: (taskId: string) => ReadonlySet<string> } | undefined {
  if (!requiredTagsOfTask && !exemptTagsOfTask) return undefined;
  return {
    requiredOfTask: (taskId: string): ReadonlySet<string> => {
      const exempt = new Set(splitTagNames(exemptTagsOfTask?.(taskId)));
      const required = splitTagNames(requiredTagsOfTask?.(taskId)).filter((name) => !exempt.has(name));
      return new Set(required);
    },
  };
}

/** 逗号分隔的标签名 → 小写去重数组。 */
function splitTagNames(raw?: string): string[] {
  const names = `${raw ?? ''}`
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(names)];
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
  /** 当前预设里还在的任务 id；传了以后，被删任务的旧标签不再沿继承带往下传 */
  taskIds?: string[];
  now: number;
}

export interface CommitLandingResult {
  stash: Stash;
  entry: StashEntry;
  landing: StashLanding;
  /** 被挤掉的最旧那一版（没有就是 null） */
  evicted: StashLanding | null;
}

/** 这封账里有没有一条能进历史投影的标签记录（空账、半成品账不算）。 */
function hasTagRecords(entry: StashEntry): boolean {
  const records = taskTagRecordsOfEntry(entry);
  for (const record of Object.values(records)) {
    for (const content of Object.values(record?.tags ?? {})) {
      // 与 collectStashTagMap 同口径：空内容不算数，否则只有空标签记录的半成品账会被当成来源。
      if (typeof content === 'string' && content.trim() !== '') return true;
    }
  }
  return false;
}

/**
 * 当前楼层之前最近的一封「有标签记录」的账（按楼层号从新到旧，跳过空账 / 半成品账）。
 *
 * 为什么要跳：collectStashTagMap 读历史时也是逐层往前让、遇到有标签的那一层才停，
 * 继承快照得跟它挑同一层，否则中间夹一封空账就会把滚动带掐断。
 */
function previousEntryOf(stash: Stash, floorId: number): StashEntry | null {
  const candidates = stash.entries
    .filter(entry => (Number(entry.floorId) || 0) < floorId)
    .sort((a, b) => (Number(b.floorId) || 0) - (Number(a.floorId) || 0));
  for (const entry of candidates) {
    if (hasTagRecords(entry)) return entry;
  }
  return null;
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
  // 续跑时本轮只跑剩下的任务，先前跑完的标签在 base.working.taskTags 里 ——
  // 落盘必须把两半合起来，否则这一版会看起来「缺了上半场」。
  const taskTags = mergeTaskTags(base.working?.taskTags, taskTagsFromResults(input.results));
  // 账本只留最近三层，低频任务上一次的产出会随旧 entry 被裁掉。落盘时从上一层
  // 抄走本版没覆盖的标签，读历史投影时就不会因为窗口太短而丢上一轮。
  const liveTaskIds = Array.isArray(input.taskIds)
    ? new Set(input.taskIds.filter((id): id is string => typeof id === 'string' && id !== ''))
    : undefined;
  const carriedTags = carryMissingTaskTags(previousEntryOf(input.stash, input.floorId), taskTags, liveTaskIds);
  const landing: StashLanding = {
    id: landingId,
    createdAt: now,
    finalText: input.finalText,
    presetName: input.presetName,
    taskRaw: collectTaskRaw(input.results),
    // 老账没这个字段，新落的都记上：日后用户删了某个标签块，才能反查该重跑谁
    ...(Object.keys(taskTags).length > 0 ? { taskTags } : {}),
    ...(Object.keys(carriedTags).length > 0 ? { carriedTags } : {}),
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

/** 面板编辑保存：改正文、删标签块、编辑本层或继承来的标签，都落到这里。 */
export interface EditLandingInput {
  stash: Stash;
  floorId: number;
  landingId: string;
  finalText: string;
  /** 标签名 → 编辑后内容；空串 = 删掉这个标签。 */
  ledgerEdits?: Record<string, string>;
  /**
   * 继承标签的编辑：标签名 → 编辑后内容（只放用户实际改过的行）。
   * 按 carriedTags 里该标签名所属的原任务 id 归组，并入该版 taskTags；
   * carriedTags 是继承来的历史快照，保存时原样不动（用户 2026-11-11 拍板）。
   */
  carriedEdits?: Record<string, string>;
  now?: number;
}

/** 继承标签名 → 它原本属于哪个任务（同名第一次出现为准）。 */
function carriedTaskIdsOf(carriedTags: Record<string, WorkingTaskTags> | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const [taskId, record] of Object.entries(carriedTags ?? {})) {
    for (const name of Object.keys(record?.tags ?? {})) {
      if (!map.has(name)) map.set(name, taskId);
    }
  }
  return map;
}

/**
 * 不重跑、不新增版本：直接在原版上改。
 *
 * ledgerEdits 只动账本里本来就有这个标签名的记录 —— 用户删掉正文里的标签块、
 * 或清空了账本里某格，不该把新标签凭空塞进别的任务里。
 * carriedEdits 是另一条路：继承标签本来不在 taskTags 里，用户编辑过的行按
 * 「本层产出」写进对应任务的 taskTags（carriedTags 完全不动）。这样投影合并时
 * 本版同名标签覆盖旧版、下一楼继承也读到编辑后的内容（用户 2026-11-11 拍板）。
 */
export function editLanding(input: EditLandingInput): { stash: Stash; entry: StashEntry } | null {
  const entry = getEntry(input.stash, input.floorId);
  if (!entry) return null;
  const index = entry.landings.findIndex((item) => item.id === input.landingId);
  if (index < 0) return null;

  const landings = entry.landings.slice();
  const landing = landings[index];
  const savedTags = landing.taskTags;
  const ledgerEdits = input.ledgerEdits;
  const carriedEdits = input.carriedEdits;
  const hasCarriedEdits = !!carriedEdits && Object.keys(carriedEdits).length > 0;

  if ((ledgerEdits && savedTags) || hasCarriedEdits) {
    const next: Record<string, WorkingTaskTags> = {};
    for (const [taskId, record] of Object.entries(savedTags ?? {})) {
      next[taskId] = { tags: { ...(record.tags ?? {}) }, injectOnly: [...(record.injectOnly ?? [])] };
    }
    for (const [name, content] of Object.entries(ledgerEdits ?? {})) {
      for (const record of Object.values(next)) {
        if (!Object.prototype.hasOwnProperty.call(record.tags, name)) continue;
        if (content === '') {
          delete record.tags[name];
          const at = record.injectOnly.indexOf(name);
          if (at >= 0) record.injectOnly.splice(at, 1);
        } else {
          record.tags[name] = content;
        }
      }
    }
    if (hasCarriedEdits) {
      const taskOf = carriedTaskIdsOf(landing.carriedTags);
      for (const [name, content] of Object.entries(carriedEdits ?? {})) {
        const taskId = taskOf.get(name);
        if (!taskId) continue;
        if (!next[taskId]) next[taskId] = { tags: {}, injectOnly: [] };
        // 空串也写进去：本版同名标签覆盖旧版，投影 / 继承都会跳过空内容，
        // 效果等于「本层不再产出这个标签」；若删键反而会回落到 carriedTags 的旧内容。
        next[taskId].tags[name] = content;
        // injectOnly 同步：继承快照里标了「只进字段」的标签，本层产出也跟着标
        const inherited = landing.carriedTags?.[taskId]?.injectOnly ?? [];
        if (inherited.includes(name) && !next[taskId].injectOnly.includes(name)) {
          next[taskId].injectOnly.push(name);
        }
      }
    }
    landings[index] = { ...landing, finalText: input.finalText, taskTags: next };
  } else {
    landings[index] = { ...landing, finalText: input.finalText };
  }
  const now = typeof input.now === 'number' && Number.isFinite(input.now) ? input.now : Date.now();
  const updated: StashEntry = { ...entry, landings, lastUsedAt: now };
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

/**
 * 面板「只删这一版、保留楼层」：删掉指定的一版，楼层条目（连同进度）留在账上。
 * 和 `removeLanding` 的区别：那个删光最后一版会把整条卡片撤掉，这个不会。
 */
export function dropLandingVersion(stash: Stash, floorId: number, landingId: string, now: number): { stash: Stash; entry: StashEntry } | null {
  const entry = getEntry(stash, floorId);
  if (!entry) return null;
  if (!entry.landings.some((item) => item.id === landingId)) return null;
  const updated: StashEntry = {
    ...dropLanding(entry, landingId),
    lastUsedAt: Number.isFinite(now) ? now : Date.now(),
  };
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
