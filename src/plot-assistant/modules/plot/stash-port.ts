/**
 * plot/stash-port.ts — 把暂存账本装进文件，再倒进另一个聊天
 *
 * 为什么要这个：账本按楼层号存（`stash-model.ts` 文件头三条约定），换一个聊天文件，
 * 楼层号从头开始，旧账一条都对不上 —— 而「角色档案」这类成果是**跨轮累积**的，
 * 新开一个聊天接着玩，前面攒的档案不该白丢。
 *
 * 用户 2026-11-05 定的口径（原话在 `剧情推进助手_用户指令.md` 批 5 m00451）：
 * 导出后导入新聊天时，**直接按楼层号重映射**——把源账本最新的几笔，依次挂到目标聊天
 * 最新的三层用户楼层上；目标层已经有账就问一句要不要覆盖；目标聊天用户楼层不足三层，
 * 就只用源账本最新那一笔盖到最新那一层；一层用户楼层都没有，就挂到当前最新楼层
 * （用户楼层、AI 楼层、第 0 层开场白都行）。
 *
 * 为什么「挂到 AI 楼层」也不坏：升级模式的成果**只存在聊天变量账本里**，账本只认
 * `floorId` 这个数字，压根不关心那层是谁说的（只有 qrf 模式才必须写用户楼层，
 * 见 `stash-migrate.ts:116` 的注释）。所以重映射到哪一层，账本自己都能用。
 *
 * 这一层是纯函数：不读聊天变量、不碰酒馆，输入输出都是对象，方便对着测。
 */

import { ENTRY_MAX, trimEntries, type Stash, type StashEntry, type StashOrphan } from './stash-model';

/** 文件头的标记，用来挡住「随便拿个 JSON 当暂存区导入」。 */
export const STASH_PORT_FORMAT = 'reroll-plot-stash';

/** 文件格式版本。以后改结构时升它，老文件仍然按 v1 读。 */
export const STASH_PORT_VERSION = 1;

/** 导出的文件内容。 */
export interface StashPortFile {
  format: string;
  version: number;
  /** 导出那一刻（毫秒），只用于在文件里留个时间戳 */
  exportedAt: number;
  /** 从哪个聊天导出的。只作参考，导入时不拿它做任何判断。 */
  sourceChatKey: string;
  entries: StashEntry[];
  /**
   * 孤儿区的账（楼层被删、对不上号的那些）。
   *
   * 导出时带上是为了「这份文件就是完整备份」，但**导入时不会挂回去** ——
   * 孤儿之所以是孤儿，就是因为它的楼层号已经不属于它了；换一个聊天同样没有归属。
   * 面板会把「跳过了几条孤儿」说出来，不静默丢。
   */
  orphans: StashOrphan[];
}

/** 目标聊天里的一层楼（重映射的落点）。 */
export interface ImportTarget {
  floorId: number;
  floorText: string;
  /** 是不是用户楼层。优先往用户楼层挂，因为那是「这一轮我说了什么」的位置。 */
  isUser: boolean;
}

/** 一笔「源账 → 目标楼层」的对应关系。 */
export interface ImportPair {
  sourceFloorId: number;
  targetFloorId: number;
  targetText: string;
}

export interface ImportPlan {
  pairs: ImportPair[];
  /** 目标层里已经有账的楼层号。非空时调用方必须先问用户要不要覆盖。 */
  conflicts: number[];
  /** 源账本里没地方挂的笔数（目标楼层不够） */
  skipped: number;
  /**
   * 目标聊天没有用户楼层时的兜底落点：
   * `'last'` = 挂到了最新那一层（可能是 AI 楼层）；`'none'` = 连楼层都没有，挂到第 0 层；
   * `''` = 用不着兜底（有用户楼层）。
   */
  fallback: 'last' | 'none' | '';
}

export type ParseOutcome = { ok: true; file: StashPortFile } | { ok: false; error: string };

/** 深拷一份账。导出不改原对象，导入也不该让文件对象被改动牵连。 */
function cloneEntry(entry: StashEntry): StashEntry {
  return JSON.parse(JSON.stringify(entry)) as StashEntry;
}

function cloneOrphan(orphan: StashOrphan): StashOrphan {
  return JSON.parse(JSON.stringify(orphan)) as StashOrphan;
}

/** 组装导出文件。`chatKey` 只作记录，导入时不用。 */
export function buildStashPortFile(stash: Stash, chatKey: string, now: number): StashPortFile {
  return {
    format: STASH_PORT_FORMAT,
    version: STASH_PORT_VERSION,
    exportedAt: now,
    sourceChatKey: chatKey,
    entries: stash.entries.map(cloneEntry),
    orphans: stash.orphans.map(cloneOrphan),
  };
}

/** 序列化成文本（缩进两格，用户拿文本编辑器打开也看得懂）。 */
export function serializeStashPort(file: StashPortFile): string {
  return JSON.stringify(file, null, 2);
}

/**
 * 解析并校验一份文件。
 *
 * 校验只挡「明显不是我们的文件」和「结构坏到没法用」这两类；
 * 字段缺一点点（老版本导出的、手工删过几个可选字段的）用默认值补上，不吹毛求疵。
 */
export function parseStashPort(text: string): ParseOutcome {
  if (text.trim() === '') return { ok: false, error: '文件是空的' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: `不是合法的 JSON（${String((error as Error)?.message ?? error)}）` };
  }
  // 数组也是 `typeof 'object'`，得单独挡掉：`[1,2,3]` 会被说成「不是暂存区文件」，
  // 而它真正的问题是顶层就不是一条记录。
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: '文件内容不是一个对象' };
  }

  const record = parsed as Record<string, unknown>;
  if (record.format !== STASH_PORT_FORMAT) {
    return { ok: false, error: `不是剧情推进助手的暂存区文件（format 是「${String(record.format)}」）` };
  }
  if (!Array.isArray(record.entries)) return { ok: false, error: '文件里没有 entries 列表' };

  const entries: StashEntry[] = [];
  for (let index = 0; index < record.entries.length; index += 1) {
    const entry = normalizeEntry(record.entries[index]);
    if (!entry) return { ok: false, error: `第 ${index + 1} 条账缺楼层号或版本内容，文件可能坏了` };
    entries.push(entry);
  }

  const orphans: StashOrphan[] = [];
  if (Array.isArray(record.orphans)) {
    for (const item of record.orphans) {
      const orphan = normalizeOrphan(item);
      if (orphan) orphans.push(orphan);
    }
  }

  return {
    ok: true,
    file: {
      format: STASH_PORT_FORMAT,
      version: toNumber(record.version, STASH_PORT_VERSION),
      exportedAt: toNumber(record.exportedAt, 0),
      sourceChatKey: typeof record.sourceChatKey === 'string' ? record.sourceChatKey : '',
      entries,
      orphans,
    },
  };
}

function normalizeEntry(value: unknown): StashEntry | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const floorId = toNumber(record.floorId, -1);
  if (floorId < 0) return null;
  if (!Array.isArray(record.landings)) return null;

  const landings = record.landings
    .map(normalizeLanding)
    .filter((item): item is NonNullable<typeof item> => item !== null);
  if (landings.length === 0) return null;

  const activeLandingId = typeof record.activeLandingId === 'string' ? record.activeLandingId : null;
  return {
    floorId,
    floorText: typeof record.floorText === 'string' ? record.floorText : '',
    presetName: typeof record.presetName === 'string' ? record.presetName : '',
    createdAt: toNumber(record.createdAt, 0),
    lastUsedAt: toNumber(record.lastUsedAt, 0),
    landings,
    // 指空了就当没选：`activeLanding()` 会退到最新那一版，不会崩。
    activeLandingId: landings.some(item => item.id === activeLandingId) ? activeLandingId : null,
    working: record.working && typeof record.working === 'object' ? (record.working as StashEntry['working']) : null,
    state: record.state === 'pending' ? 'pending' : 'complete',
  };
}

function normalizeLanding(value: unknown): StashEntry['landings'][number] | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id : '';
  if (id === '') return null;
  const taskRaw: Record<string, string> = {};
  if (record.taskRaw && typeof record.taskRaw === 'object') {
    for (const [taskId, raw] of Object.entries(record.taskRaw as Record<string, unknown>)) {
      if (typeof raw === 'string') taskRaw[taskId] = raw;
    }
  }
  return {
    id,
    createdAt: toNumber(record.createdAt, 0),
    finalText: typeof record.finalText === 'string' ? record.finalText : '',
    presetName: typeof record.presetName === 'string' ? record.presetName : '',
    taskRaw,
    taskTags: record.taskTags && typeof record.taskTags === 'object' ? (record.taskTags as StashEntry['landings'][number]['taskTags']) : undefined,
    complete: record.complete !== false,
    seq: typeof record.seq === 'number' ? record.seq : undefined,
  };
}

function normalizeOrphan(value: unknown): StashOrphan | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const originFloorId = toNumber(record.originFloorId, -1);
  if (originFloorId < 0) return null;
  if (!Array.isArray(record.landings)) return null;
  const landings = record.landings
    .map(normalizeLanding)
    .filter((item): item is NonNullable<typeof item> => item !== null);
  if (landings.length === 0) return null;
  return {
    originFloorId,
    orphanedAt: toNumber(record.orphanedAt, 0),
    reason: record.reason === 'floor_mismatch' ? 'floor_mismatch' : 'floor_missing',
    floorText: typeof record.floorText === 'string' ? record.floorText : '',
    presetName: typeof record.presetName === 'string' ? record.presetName : '',
    createdAt: toNumber(record.createdAt, 0),
    lastUsedAt: toNumber(record.lastUsedAt, 0),
    landings,
    activeLandingId: typeof record.activeLandingId === 'string' ? record.activeLandingId : null,
    working: record.working && typeof record.working === 'object' ? (record.working as StashEntry['working']) : null,
    state: record.state === 'pending' ? 'pending' : 'complete',
  };
}

function toNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * 算一份「源账挂到目标哪一层」的计划。
 *
 * 配对规则（用户 m00451 原话的落地）：
 * - 目标聊天的**用户楼层**按楼层号从新到旧取，最多 `ENTRY_MAX`（= 3）个，当落点；
 * - 源账本也按楼层号从新到旧排，第 1 新对第 1 新，依次往下；
 * - 源账多于落点：多出来的没地方挂，记进 `skipped`；
 * - 目标没有用户楼层：退回「最新那一层」（AI 楼层也行），只挂一间；
 * - 连楼层都没有：挂到第 0 层（开场白）。
 */
export function planStashImport(file: StashPortFile, targets: ImportTarget[], stash: Stash): ImportPlan {
  const sources = [...file.entries].sort((a, b) => b.floorId - a.floorId);
  if (sources.length === 0) return { pairs: [], conflicts: [], skipped: 0, fallback: '' };

  const users = targets.filter(item => item.isUser).sort((a, b) => a.floorId - b.floorId);
  const newestUsers = users.slice(-ENTRY_MAX).reverse();

  let slots: ImportTarget[] = newestUsers;
  let fallback: ImportPlan['fallback'] = '';
  if (slots.length === 0) {
    const latest = [...targets].sort((a, b) => b.floorId - a.floorId)[0];
    if (latest) {
      slots = [latest];
      fallback = 'last';
    } else {
      slots = [{ floorId: 0, floorText: '', isUser: false }];
      fallback = 'none';
    }
  }

  const count = Math.min(sources.length, slots.length);
  const pairs: ImportPair[] = [];
  for (let index = 0; index < count; index += 1) {
    pairs.push({
      sourceFloorId: sources[index].floorId,
      targetFloorId: slots[index].floorId,
      targetText: slots[index].floorText,
    });
  }

  // 排一下再交出去：配对是「最新在前」，直接给出去提示框会写「第 7、6 层」，
  // 读着别扭。楼层号从小到大才是人看的样子。
  const conflicts = pairs
    .filter(pair => stash.entries.some(entry => entry.floorId === pair.targetFloorId))
    .map(pair => pair.targetFloorId)
    .sort((a, b) => a - b);

  return { pairs, conflicts, skipped: sources.length - count, fallback };
}

/**
 * 按计划把账写进目标账本。**同名楼层直接替换**（调用方问过用户了才该走到这里）。
 *
 * 不做「保留旧账、另挂一层」这种聪明事：账本按楼层号做主键，一层只能有一笔，
 * 两笔挤一起会让 `getEntry()` 分不清该用哪个。
 */
export function applyStashImport(stash: Stash, file: StashPortFile, plan: ImportPlan, now: number): Stash {
  if (plan.pairs.length === 0) return stash;

  const bySource = new Map(file.entries.map(entry => [entry.floorId, entry]));
  const replaced = new Set(plan.pairs.map(pair => pair.targetFloorId));
  const kept = stash.entries.filter(entry => !replaced.has(entry.floorId));

  const imported: StashEntry[] = [];
  for (const pair of plan.pairs) {
    const source = bySource.get(pair.sourceFloorId);
    if (!source) continue;
    imported.push({
      ...source,
      floorId: pair.targetFloorId,
      // 正文换成目标那一层的：认领时按开头十个字比，挂过去就是「同一段输入」
      floorText: pair.targetText,
      lastUsedAt: now,
    });
  }

  // 合并后统一按楼层号升序：`trimEntries` 只在超过三层时才排序，三层以内原样返回，
  // 于是「按配对顺序拼起来的」那一摞会变成 7、6、5。排一次，面板上看着才是从上到下。
  return { ...stash, entries: trimEntries([...kept, ...imported].sort((a, b) => a.floorId - b.floorId)) };
}
