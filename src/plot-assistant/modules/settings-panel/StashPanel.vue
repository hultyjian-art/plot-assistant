<script setup lang="ts">
/**
 * 暂存区面板：把所有已经落盘的推进成果按楼层列出来，点开一版能看、能改、能按标签删。
 *
 * 写盘边界：改动先落本地草稿，点「保存」才写回聊天变量 `reroll_plot_stash`；不写楼层的 qrf，也不碰 ACU 的键。
 * 改「使用中」那版时还会同步写楼层正文、世界书条目与输入框，切版本时同步账本的「当前使用」标记。
 *
 * 「保存才生效」是硬要求（用户 2026-11-02 明确）：所有改动都先落在本地草稿里，
 * 点「保存」才写回聊天变量；改了没保存就点叉，必须再问一次。
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { UI, pickStashEntryLanding } from '../copy';
import type { RerushContext } from '../types';
import { dropLandingVersion, editLanding, listEntries, removeLanding } from '../plot/stash-flow';
import { landingGap, landingSeqOf, setActiveLanding, taskTagRecordsOfLanding, taskTagsOfLanding, type LandingGap } from '../plot/stash-model';
import { readPanelStash, savePanelStash } from '../plot/stash-state';
import { commitStashImport, exportStashToText, prepareStashImport } from '../plot/stash-port-flow';
import type { ImportPlan, StashPortFile } from '../plot/stash-port';
import { blockPreview, removeTagBlocks, scanTagBlocks } from '../plot/stash-edit';
import { landingInFloor } from '../plot/stash-apply';
import { applyLandingToFloorMessage, putLandingIntoInputBox, readFloorText, restoreFloorText } from '../plot/stash-apply-io';
import { enqueueWorldbookStashRecords } from '../plot/worldbook-write';
import {
  buildHighlightHtml,
  findMatches,
  replaceAllMatches,
  replaceMatch,
  type SearchMatch,
} from '../plot/stash-search';
import type { Stash, StashEntry, StashLanding } from '../plot/stash-model';

const t = UI.plot;

/**
 * 脚本上下文用于两件事：读 ctx.state.locked 做推进期间的只读守卫；
 * 把「使用中」版本的编辑同步进世界书（批 45）。同步走的是 ctx.settings.plot 里
 * **已保存**的规则 —— 面板上改了规则还没点总保存时，照旧口径不算数。
 */
const props = defineProps<{ ctx: RerushContext }>();

/**
 * 推进运行期间面板只读。
 *
 * 引擎一轮只 load 一次账本快照，中途多次整份 saveStash（中间 await 可达数分钟）；
 * 面板这时若也 load → 整份 save，后写会把引擎刚落的成果整份盖掉。所以推进期间
 * 一切会写暂存账本的操作都停手，等跑完再改。
 *
 * 标志取 send-gate 的 run() 全程置位的 ctx.state.locked（types.ts 的 RerushState）。
 * ctx.state 是普通对象、不是 Vue 响应式，computed 追踪不到它的变化，所以用一个轻量
 * 定时器把值同步进 ref 给模板用；写操作的守卫则直接读实时值，不吃这点延迟。
 */
function isPlotRunning(): boolean {
  return props.ctx.state.locked === true;
}

const plotRunning = ref(isPlotRunning());
let runningTimer: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
  plotRunning.value = isPlotRunning();
  runningTimer = setInterval(() => {
    plotRunning.value = isPlotRunning();
  }, 200);
});
onUnmounted(() => {
  if (runningTimer !== null) {
    clearInterval(runningTimer);
    runningTimer = null;
  }
});

/** 写账本 / 改草稿前统一挡一道；挡下时给一句提示，返回 true 表示已挡下。 */
function blockWhileRunning(): boolean {
  if (!isPlotRunning()) return false;
  plotRunning.value = true;
  flash(t.stashPlotRunning);
  return true;
}

/** 世界书同步的统一入口：把一版的合并标签数据交给后台队列（没上下文/功能没开时那边自己会退）。 */
function syncWorldbook(records: Record<string, { tags: Record<string, string>; injectOnly: string[] }> | null | undefined): void {
  try {
    enqueueWorldbookStashRecords(props.ctx, records);
  } catch (error) {
    console.warn('[剧情推进助手] 暂存区同步世界书入队失败', error);
  }
}

const stash = ref<Stash | null>(null);
const warning = ref<string | null>(null);
const notice = ref('');
/**
 * 每一层现在真正的正文。判断「哪一版在使用中」只认它，不认账本里的 `activeLandingId`——
 * 楼层里躺着什么才是用户会读到的内容。
 */
const floorTexts = ref<Record<number, string | null>>({});

const entries = computed<StashEntry[]>(() => (stash.value ? listEntries(stash.value) : []));

/** 重新读聊天变量 + 每层正文。面板每次打开、点刷新、保存之后都走它。 */
function reload(): void {
  try {
    const loaded = readPanelStash();
    stash.value = loaded.stash;
    warning.value = loaded.warning;
    readFloorTexts(loaded.stash);
  } catch (error) {
    console.error('[剧情推进助手] 读暂存失败', error);
    stash.value = null;
    warning.value = 'stash_unreadable';
  }
}

/** 把每层的正文读一遍；读不到（楼层被删了）记 null。 */
function readFloorTexts(source: Stash): void {
  const next: Record<number, string | null> = {};
  for (const entry of source.entries) {
    try {
      next[entry.floorId] = readFloorText(entry.floorId);
    } catch (error) {
      console.warn('[剧情推进助手] 读楼层正文失败', entry.floorId, error);
      next[entry.floorId] = null;
    }
  }
  floorTexts.value = next;
}

/** 这一版是不是正写在楼层里（面板上标「使用中」）。 */
function inUse(entry: StashEntry, landing: StashLanding): boolean {
  if (!landingInFloor(floorTexts.value[entry.floorId] ?? null, landing.finalText)) return false;
  // 两版内容可能一字不差（同一轮重跑、或用户把两版改成一样）。这时两版都"在楼层里"，
  // 但真正被标成「使用中」的只能有一个 —— 否则用户会以为两版同时在生效。
  const twins = entry.landings.filter(item => landingInFloor(floorTexts.value[entry.floorId] ?? null, item.finalText));
  if (twins.length <= 1) return true;
  return landing.id === entry.activeLandingId || twins[twins.length - 1].id === landing.id;
}

onMounted(reload);

// ── 导出 / 导入：把账带到别的聊天文件里 ──
//
// 账本认的是楼层号，换个聊天文件楼层号就全变了。所以导入不是「合并」，是把源账的
// 楼层号**重映射**到本聊天最新的几层用户楼层（`claimFloor` 里连正文对不上的
// `pending` 账都认，因为锚本来就是楼层号）。目标层本来就有账时先问一句再覆盖。

const portInput = ref<HTMLInputElement | null>(null);
const portNote = ref('');
const askPortOverwrite = ref(false);
const pendingPort = ref<{ file: StashPortFile; plan: ImportPlan } | null>(null);

/** 打开系统的选文件框。`ref` 指向模板里那个隐藏的 `<input type="file">`。 */
function pickPortFile(): void {
  if (blockWhileRunning()) return;
  portInput.value?.click();
}

/** 文件名带时间：连着导两次时，两个同名文件在下载夹里不会互相覆盖。 */
function portFileName(): string {
  const now = new Date();
  const two = (value: number): string => String(value).padStart(2, '0');
  const stamp = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}`;
  return `剧情推进助手-暂存区-${stamp}.json`;
}

/**
 * 下载。写法照 `PresetIo.vue:67-77` 抄的：Blob + createObjectURL + `a.click()`，
 * 再**立刻**在下一个事件循环里回收 —— 那时下载已经开始了。
 */
function exportStash(): void {
  try {
    // 导出必须以面板当前持有的账本为准（用户要求：导出的就是暂存区最新状态）。
    // 按钮在有脏改动时禁用，所以这里拿到的是已保存的最新快照；别重新读聊天变量，
    // 那会拿一个比 stash.value 更旧的快照去导出。
    if (!stash.value) {
      portNote.value = t.stashImportNoStash;
      return;
    }
    const text = exportStashToText(stash.value, stash.value.chatKey, Date.now());
    const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = portFileName();
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    portNote.value = t.stashExportDone;
  } catch (error) {
    console.error('[剧情推进助手] 导出暂存失败', error);
    portNote.value = t.ioFailed(String((error as Error)?.message ?? error));
  }
}

/** 选文件 → 解析 → 算配对。有冲突就先问，没冲突直接落。 */
function importFromFile(event: Event): void {
  if (blockWhileRunning()) return;
  const input = event.target as HTMLInputElement | null;
  const file = input && input.files ? input.files[0] : null;
  if (!input || !file) return;
  portNote.value = '';
  const reader = new FileReader();
  reader.onload = () => {
    // 同一个文件改完再导一次时必须清空，否则不会再触发 change（PresetIo.vue:63 同款）。
    input.value = '';
    if (blockWhileRunning()) return;
    const text = typeof reader.result === 'string' ? reader.result : '';
    if (!stash.value) {
      portNote.value = t.stashImportNoStash;
      return;
    }
    const prep = prepareStashImport(text, stash.value);
    if (!prep.ok) {
      portNote.value = t.ioFailed(prep.error);
      return;
    }
    pendingPort.value = { file: prep.file, plan: prep.plan };
    if (prep.plan.conflicts.length > 0) {
      askPortOverwrite.value = true;
      return;
    }
    commitImport(prep.file, prep.plan);
  };
  reader.onerror = () => {
    input.value = '';
    portNote.value = t.ioFailed('读不了这个文件');
  };
  reader.readAsText(file);
}

/** 真正落账：整份替换写回聊天变量（和 `savePanelStash` 同一个口径）。 */
function commitImport(file: StashPortFile, plan: ImportPlan): void {
  if (blockWhileRunning()) return;
  if (!stash.value) return;
  try {
    const next = commitStashImport(stash.value, file, plan, Date.now());
    savePanelStash(next);
    stash.value = next;
    readFloorTexts(next);
    const lines: string[] = [];
    if (plan.pairs.length > 0) lines.push(t.stashImportDone(plan.pairs.length));
    if (file.orphans.length > 0) lines.push(t.stashImportDoneOrphans(file.orphans.length));
    if (plan.fallback === 'last') lines.push(t.stashImportFallbackLast);
    if (plan.fallback === 'none') lines.push(t.stashImportFallbackNone);
    if (plan.skipped > 0) lines.push(t.stashImportSkipped(plan.skipped));
    portNote.value = lines.join(' ');
    askPortOverwrite.value = false;
    pendingPort.value = null;
  } catch (error) {
    console.error('[剧情推进助手] 导入暂存失败', error);
    portNote.value = t.ioFailed(String((error as Error)?.message ?? error));
  }
}

function confirmPortOverwrite(): void {
  const pending = pendingPort.value;
  if (!pending) return;
  commitImport(pending.file, pending.plan);
}

function cancelPortOverwrite(): void {
  askPortOverwrite.value = false;
  pendingPort.value = null;
  portNote.value = t.stashImportCancel;
}

/** 冲突楼层在提示里写成「3、5」这种。 */
const conflictText = computed<string>(() => {
  const pending = pendingPort.value;
  if (!pending) return '';
  return pending.plan.conflicts.map((floorId) => String(floorId)).join('、');
});

// ── 弹层状态 ──
const openFloorId = ref<number | null>(null);
const openLandingId = ref<string | null>(null);
/**
 * 打开的是「某一版成果」还是「这一层还没落盘的进度」。
 *
 * 用户 2026-11-09 第 8 条：一层已经跑完几个任务、还没全跑完时，点那一行必须能立刻
 * 看见落盘了什么 —— 不能因为 `landings` 是空的就整张卡没有可点的地方。
 */
const viewerMode = ref<'landing' | 'working'>('landing');
const draftText = ref('');
const savedText = ref('');
const askDiscard = ref(false);
const askDelete = ref(false);
const askDropVersion = ref(false);
const busy = ref(false);
const saveError = ref('');

const currentEntry = computed<StashEntry | null>(() => {
  if (openFloorId.value === null || !stash.value) return null;
  return stash.value.entries.find((item) => item.floorId === openFloorId.value) ?? null;
});

const currentLanding = computed<StashLanding | null>(() => {
  const entry = currentEntry.value;
  if (!entry || !openLandingId.value) return null;
  return entry.landings.find((item) => item.id === openLandingId.value) ?? null;
});

/** 正在看的这一版是第几号（1、2……），标题上用。 */
const currentSeq = computed<number | null>(() => {
  const entry = currentEntry.value;
  if (!entry || !openLandingId.value) return null;
  const index = entry.landings.findIndex((item) => item.id === openLandingId.value);
  if (index < 0) return null;
  return landingSeqOf(entry.landings[index], index);
});

/** 正在看的这一版是不是楼层里正在用的那条。 */
const currentInUse = computed<boolean>(() => {
  const entry = currentEntry.value;
  const landing = currentLanding.value;
  return Boolean(entry && landing && inUse(entry, landing));
});


/** 账本里的「只进字段 / 写进世界书」标签：没进正文，但落盘时确实存在数据层。 */
const ledgerRows = computed<{ name: string; content: string }[]>(() => {
  const body = new Set(bodyTagNames.value.map((name) => name.toLowerCase()));
  const rows: { name: string; content: string }[] = [];
  const seen = new Set<string>();
  for (const record of Object.values(taskTagsOfLanding(currentLanding.value))) {
    for (const [name, content] of Object.entries(record?.tags ?? {})) {
      if (typeof content !== 'string' || body.has(name.toLowerCase()) || seen.has(name)) continue;
      seen.add(name);
      rows.push({ name, content });
    }
  }
  return rows;
});

/**
 * 继承自之前楼层的标签（可编辑，用户 2026-11-11 拍板）。
 *
 * 单独一组、和本层账本行分开；编辑过的行由 save() 按「本层产出」写进该版
 * taskTags（见 editLanding 的 carriedEdits），carriedTags 是继承历史快照，原样不动。
 * 本层 taskTags 里已有的同名标签不再重复显示（用户 m00155：要继承的只是老楼层
 * 有、而新楼层没有的）；正文里已有的同名标签也跳过，避免两处都能改同一个标签。
 */
const carriedRows = computed<{ name: string; content: string }[]>(() => {
  const body = new Set(bodyTagNames.value.map((name) => name.toLowerCase()));
  const rows: { name: string; content: string }[] = [];
  const seen = new Set<string>();
  for (const record of Object.values(taskTagsOfLanding(currentLanding.value))) {
    for (const name of Object.keys(record?.tags ?? {})) seen.add(name);
  }
  for (const record of Object.values(currentLanding.value?.carriedTags ?? {})) {
    for (const [name, content] of Object.entries(record?.tags ?? {})) {
      if (typeof content !== 'string' || body.has(name.toLowerCase()) || seen.has(name)) continue;
      seen.add(name);
      rows.push({ name, content });
    }
  }
  return rows;
});
const ledgerDraft = ref<Record<string, string>>({});
const carriedDraft = ref<Record<string, string>>({});
const ledgerDirty = computed(() => ledgerRows.value.some((row) => (ledgerDraft.value[row.name] ?? row.content) !== row.content));
const carriedDirty = computed(() => carriedRows.value.some((row) => (carriedDraft.value[row.name] ?? row.content) !== row.content));
const dirty = computed(() => draftText.value !== savedText.value || ledgerDirty.value || carriedDirty.value);

/** 正文里实际出现的标签名 —— 判断「缺口」只认它。 */
const bodyTagNames = computed<string[]>(() => scanTagBlocks(draftText.value).map((block) => block.tag));

interface StashTagRow {
  name: string;
  preview: string;
}

function clipPreview(text: string): string {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  return flat.length > 60 ? `${flat.slice(0, 60)}…` : flat;
}

/** 标签清单只列正文里实际出现的标签：查看器里能看到的，就是能编辑、能删的。 */
const tagRows = computed<StashTagRow[]>(() =>
  scanTagBlocks(draftText.value).map((block) => ({
    name: block.tag,
    preview: blockPreview(block, 60),
  })),
);
/**
 * 这一版现在缺了哪些标签。
 *
 * 删标签块不拦着 —— 用户要的就是自由编辑。但后果得让人看见：
 * 这里算出的 gap 只取自正文草稿，仅用于下面那句提示文案；下次生成楼层时是否补跑，
 * 由引擎按暂存区账本与 qrf 兜底判定，不以这个 gap 为输入。
 */
const gap = computed<LandingGap>(() => {
  const landing = currentLanding.value;
  if (!landing) return { tags: [], taskIds: [] };
  // 只把「正文里现在有哪些标签」交给缺口计算；只存档的标签不算缺口。
  return landingGap(landing, bodyTagNames.value);
});

interface WorkingTagRow {
  name: string;
  preview: string;
}

interface WorkingRow {
  taskId: string;
  done: boolean;
  tags: WorkingTagRow[];
  injectOnly: string[];
}

/** 「进行中」视图：这一层已经跑完谁、还欠谁，各自带回了什么标签。 */
const workingRows = computed<WorkingRow[]>(() => {
  const working = currentEntry.value?.working;
  if (!working) return [];
  const done = new Set(working.done);
  const ids: string[] = [];
  for (const id of [...working.done, ...working.pending]) {
    if (typeof id === 'string' && id && !ids.includes(id)) ids.push(id);
  }
  return ids.map((taskId) => {
    const saved = working.taskTags?.[taskId];
    return {
      taskId,
      done: done.has(taskId),
      // 连内容一起给一眼：只列标签名，用户还是不知道「落盘的到底是什么」。
      tags: Object.entries(saved?.tags ?? {}).map(([name, content]) => ({
        name,
        preview: clipPreview(content),
      })),
      injectOnly: Array.isArray(saved?.injectOnly) ? [...saved.injectOnly] : [],
    };
  });
});

const viewerOpen = computed(
  () => openFloorId.value !== null && (viewerMode.value === 'working' || openLandingId.value !== null),
);

function openViewer(entry: StashEntry, landing: StashLanding): void {
  viewerMode.value = 'landing';
  openFloorId.value = entry.floorId;
  openLandingId.value = landing.id;
  draftText.value = landing.finalText;
  // 账本里那些不进正文的标签也要能改：打开这一版时按标签名把内容装进草稿。
  // 继承标签同样装进草稿（用户 2026-11-11 拍板可编辑）：只有被改过的行会在保存时
  // 按「本层产出」落地，没改过的行不产生任何写入，carriedTags 保持原样。
  const body = new Set(scanTagBlocks(landing.finalText).map((block) => block.tag.toLowerCase()));
  const draft: Record<string, string> = {};
  const carried: Record<string, string> = {};
  const taskTagNames = new Set<string>();
  for (const record of Object.values(taskTagsOfLanding(landing))) {
    for (const [name, content] of Object.entries(record?.tags ?? {})) {
      taskTagNames.add(name);
      if (typeof content !== 'string' || body.has(name.toLowerCase())) continue;
      draft[name] = content;
    }
  }
  for (const record of Object.values(landing.carriedTags ?? {})) {
    for (const [name, content] of Object.entries(record?.tags ?? {})) {
      if (typeof content !== 'string' || body.has(name.toLowerCase()) || taskTagNames.has(name)) continue;
      carried[name] = content;
    }
  }
  ledgerDraft.value = draft;
  carriedDraft.value = carried;
  savedText.value = landing.finalText;
  askDiscard.value = false;
  askDelete.value = false;
  askDropVersion.value = false;
  saveError.value = '';
  notice.value = '';
}

/** 这一层还没有任何落盘成果：打开「进行中」视图，看已跑完/还欠着哪些任务、各带回什么标签。 */
function openWorking(entry: StashEntry): void {
  viewerMode.value = 'working';
  openFloorId.value = entry.floorId;
  openLandingId.value = null;
  draftText.value = '';
  savedText.value = '';
  askDiscard.value = false;
  askDelete.value = false;
  askDropVersion.value = false;
  saveError.value = '';
  notice.value = '';
  closeSearch();
}

/** 这一行点下去会打开什么：有落盘成果就「查看」它，一版都没有才「查看进度」。 */
function entryActionLabel(entry: StashEntry): string {
  return pickStashEntryLanding(entry) ? t.stashOpenView : t.stashViewProgress;
}

/**
 * 点楼层那一行：默认打开已经落盘的成果，让玩家能直接看、直接改标签。
 *
 * 用户 2026-11-10：`working.pending`（还欠着任务）只说明这一层没全量跑完，
 * 不该把已落盘的成果挡在进度视图后面 —— 真正该锁编辑的只有「任务已发给 AI、
 * 还没回传」那段时间（`plotRunning`）。进度改由楼层行上那个
 * 「未完成，还欠 N 个任务 · 查看进度」入口进去。
 *
 * 优先顺序：楼层正文里实际在用的那一版 → 正在用的那一版（activeLandingId）→ 最新一版
 * → 一版都没有才退回进度视图（**任何一层都必须有反应**，2026-11-09 第 8 条）。
 *
 * 先认楼层正文：老账的 activeLandingId 可能指向别的版本（甚至因版本被挤掉而退回最后一版），
 * 只按账本标记打开，会让用户改到一版「没在用」的成果，保存后世界书当然不跟着变。
 */
function openEntry(entry: StashEntry): void {
  const floorText = floorTexts.value[entry.floorId] ?? null;
  const landing = [...entry.landings].reverse().find((item) => landingInFloor(floorText, item.finalText)) ?? pickStashEntryLanding(entry);
  if (landing) {
    openViewer(entry, landing);
    return;
  }
  openWorking(entry);
}

function resetViewer(): void {
  openFloorId.value = null;
  openLandingId.value = null;
  viewerMode.value = 'landing';
  draftText.value = '';
  savedText.value = '';
  askDiscard.value = false;
  askDelete.value = false;
  askDropVersion.value = false;
  saveError.value = '';
  closeSearch();
}

/** 点叉：有没保存的改动就先问，没有就直接关。 */
function requestClose(): void {
  if (dirty.value) {
    askDiscard.value = true;
    return;
  }
  resetViewer();
}

function discardAndClose(): void {
  resetViewer();
}

/** 一条提示显示 2.5 秒，除非期间被别的提示顶掉。 */
function flash(text: string): void {
  notice.value = text;
  window.setTimeout(() => {
    if (notice.value === text) notice.value = '';
  }, 2500);
}

/**
 * 保存改动。
 *
 * 用户 2026-11-03 的要求：改的是**正在使用**的那一版时，楼层正文也要跟着变。
 * 不跟的话，面板上改得再对，酒馆 AI 读到的还是旧的那段 —— 两边各说各话。
 * 改的是没在用的那一版就只落账本，楼层一个字不动（保存才生效，不能偷偷改楼层）。
 */
async function save(): Promise<void> {
  if (blockWhileRunning()) return;
  const entry = currentEntry.value;
  const landing = currentLanding.value;
  if (!entry || !landing || !stash.value || busy.value) return;
  const wasInUse = inUse(entry, landing);
  try {
    // 只把「实际编辑过」的继承标签传给落盘：没改过的行不进 taskTags，
    // carriedTags 保持原样（用户 2026-11-11 拍板：继承标签可编辑，编辑后算本层产出）。
    const carriedEdits: Record<string, string> = {};
    for (const row of carriedRows.value) {
      const content = carriedDraft.value[row.name] ?? row.content;
      if (content !== row.content) carriedEdits[row.name] = content;
    }
    const next = editLanding({
      stash: stash.value,
      floorId: entry.floorId,
      landingId: landing.id,
      finalText: draftText.value,
      ledgerEdits: { ...ledgerDraft.value },
      carriedEdits,
      activate: wasInUse,
      now: Date.now(),
    });
    if (!next) {
      saveError.value = '这一版已经不在账本里了（可能被挤掉了），刷新一下再看。';
      return;
    }
    if (!wasInUse) {
      savePanelStash(next.stash);
      stash.value = next.stash;
      savedText.value = draftText.value;
      saveError.value = '';
      flash(t.stashSaved);
      return;
    }

    // 使用中的那版：先改楼层，楼层写成功后才落聊天变量。
    // 反过来（先落变量再改楼层）一旦楼层失败，账本已经换了新内容、楼层还是旧的 ——
    // 用户再打开面板看到的和 AI 读到的就是两套。楼层失败 = 整次保存失败，账本不动。
    busy.value = true;
    const beforeText = readFloorText(entry.floorId);
    const result = await applyLandingToFloorMessage(entry.floorId, draftText.value);
    if (!result.ok) {
      busy.value = false;
      saveError.value = result.reason || t.stashApplyFailed;
      return;
    }
    try {
      savePanelStash(next.stash);
    } catch (error) {
      // 楼层已改、聊天变量没落：把楼层恢复原样，保持「要么都成功，要么都不变」。
      if (beforeText !== null) await restoreFloorText(entry.floorId, beforeText);
      busy.value = false;
      throw error;
    }
    busy.value = false;
    stash.value = next.stash;
    savedText.value = draftText.value;
    saveError.value = '';
    readFloorTexts(stash.value);
    // 批 45：改的是使用中的那版且楼层已跟上，世界书条目也跟着这份新内容走。
    // 只在这一步同步 —— 楼层写失败时（上面 return 了）世界书保持旧内容，两边不说两样话。
    // 传编辑后这一版的合并标签数据（carriedTags + taskTags），空串 tombstone 会清掉对应条目；
    // 不再拼文本，以免只进字段 / 只写世界书的标签被漏掉。
    const updatedLanding = next.entry.landings.find((item) => item.id === landing.id);
    syncWorldbook(taskTagRecordsOfLanding(updatedLanding));
    flash(t.stashSavedSynced(entry.floorId));
  } catch (error) {
    busy.value = false;
    console.error('[剧情推进助手] 保存暂存失败', error);
    saveError.value = String((error as Error)?.message ?? error);
  }
}

function dropTag(tag: string): void {
  if (blockWhileRunning()) return;
  const result = removeTagBlocks(draftText.value, tag);
  if (result.removed === 0) {
    notice.value = t.stashTagMissing(tag);
    return;
  }
  draftText.value = result.text;
  notice.value = t.stashTagRemoved(tag);
}

/**
 * 把这一版写回楼层正文。
 *
 * 用存下来的 `finalText`（不是正在编辑的草稿）：草稿没点保存就不该影响楼层，
 * 否则「保存才生效」这条就漏了个后门。所以按钮在有未保存改动时是灰的。
 */
async function applyToFloor(): Promise<void> {
  if (blockWhileRunning()) return;
  const entry = currentEntry.value;
  const landing = currentLanding.value;
  if (!entry || !landing || busy.value || !stash.value) return;
  busy.value = true;
  const beforeText = readFloorText(entry.floorId);
  try {
    const result = await applyLandingToFloorMessage(entry.floorId, landing.finalText);
    if (!result.ok) {
      saveError.value = result.reason || t.stashApplyFailed;
      return;
    }
    // 楼层现在用的就是这一版：账本里的「当前使用」也跟上，免得两处各说各话。
    const marked = setActiveLanding(entry, landing.id);
    const nextStash: Stash = {
      ...stash.value,
      entries: stash.value.entries.map((item) => (item.floorId === entry.floorId ? marked : item)),
    };
    try {
      savePanelStash(nextStash);
    } catch (error) {
      // 楼层已改、聊天变量没落：恢复楼层，保持「要么都成功，要么都不变」。
      if (beforeText !== null) await restoreFloorText(entry.floorId, beforeText);
      throw error;
    }
    stash.value = nextStash;
    readFloorTexts(nextStash);
    saveError.value = '';
    // 批 45：切版本 = 换了正在生效的内容。世界书条目跟着切过来的这一版走，
    // 否则楼层里已是新版、世界书条目里还是旧版，AI 两边读到的对不上。
    syncWorldbook(taskTagRecordsOfLanding(landing));
    flash(t.stashApplied);
  } catch (error) {
    console.error('[剧情推进助手] 写入楼层失败', error);
    saveError.value = String((error as Error)?.message ?? error);
  } finally {
    busy.value = false;
  }
}

/** 把「用户原话 + 这一版」放回输入框，让用户自己按发送（不替用户发送）。 */
function rerunText(): void {
  const entry = currentEntry.value;
  const landing = currentLanding.value;
  if (!entry || !landing) return;
  const result = putLandingIntoInputBox(entry.floorText, landing.finalText);
  if (!result.ok) {
    saveError.value = result.reason || t.stashRerunFailed;
    return;
  }
  saveError.value = '';
  flash(t.stashRerunOk);
}

/** 删这一版：先问一次，删完如果这条账一版都不剩，整条卡片就没了。 */
function requestRemove(): void {
  askDropVersion.value = false;
  askDelete.value = true;
}

/** 只删这一版、保留楼层：先问一次，删完这一层的卡片和进度都还在。 */
function requestDropVersion(): void {
  askDelete.value = false;
  askDropVersion.value = true;
}

function confirmDropVersion(): void {
  if (blockWhileRunning()) return;
  const entry = currentEntry.value;
  const landing = currentLanding.value;
  if (!entry || !landing || !stash.value) return;
  try {
    const next = dropLandingVersion(stash.value, entry.floorId, landing.id, Date.now());
    if (!next) {
      saveError.value = t.stashDeleteMissing;
      askDropVersion.value = false;
      return;
    }
    savePanelStash(next.stash);
    stash.value = next.stash;
    askDropVersion.value = false;
    const left = next.entry.landings;
    if (left.length === 0) {
      resetViewer();
      notice.value = t.stashDropVersionDone;
      return;
    }
    openViewer(next.entry, left[left.length - 1]);
    notice.value = t.stashDropVersionDone;
  } catch (error) {
    console.error('[剧情推进助手] 删除版本失败', error);
    saveError.value = String((error as Error)?.message ?? error);
  }
}

function confirmRemove(): void {
  if (blockWhileRunning()) return;
  const entry = currentEntry.value;
  const landing = currentLanding.value;
  if (!entry || !landing || !stash.value) return;
  try {
    const next = removeLanding(stash.value, entry.floorId, landing.id, Date.now());
    if (!next) {
      saveError.value = t.stashDeleteMissing;
      askDelete.value = false;
      return;
    }
    savePanelStash(next.stash);
    stash.value = next.stash;
    askDelete.value = false;
    const left = next.entry.landings;
    if (left.length === 0) {
      resetViewer();
      return;
    }
    openViewer(next.entry, left[left.length - 1]);
    notice.value = t.stashDeleted;
  } catch (error) {
    console.error('[剧情推进助手] 删除成果失败', error);
    saveError.value = String((error as Error)?.message ?? error);
  }
}

/** 楼层卡片上那行小字：几版、预设、时间。 */
function landingTime(landing: StashLanding): string {
  const date = new Date(landing.createdAt);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// ── 搜索与替换（2026-11-09 第 2 条改版）：只在当前打开的这一版里找 ──
//
// 入口是查看器右上角的放大镜；范围 = 正在看的这一版草稿（改动实时可搜、可替换）。
// 大小写不敏感。替换只进草稿，点「保存」才落账 —— 与查看器里手改同一套规矩。

const searchOpen = ref(false);
const searchQuery = ref('');
const replaceQuery = ref('');
/** 当前落在第几处匹配（`allMatches` 的下标；-1 = 还没跳过）。 */
const currentMatchIndex = ref(-1);
const searchInput = ref<HTMLInputElement | null>(null);
const draftTextarea = ref<HTMLTextAreaElement | null>(null);
const backdropRef = ref<HTMLDivElement | null>(null);
const backdropInnerRef = ref<HTMLDivElement | null>(null);

/** 带版本的匹配：除了字符区间，还记着它在哪一层哪一版（替换按钮要用）。 */
interface StashMatch extends SearchMatch {
  floorId: number;
  landingId: string;
}

/**
 * 搜索范围**只有当前打开的这一版正文**（2026-11-09 第 2 条）。
 *
 * 以前是全账本跨版本搜索，放大镜还挂在列表顶部 —— 用户要的是「在看这一段时，
 * 在这一段里找」，不是「在几十版里大海捞针」。所以这里直接复用 `draftMatches`。
 */
const allMatches = computed<StashMatch[]>(() => {
  if (!searchOpen.value || searchQuery.value === '') return [];
  if (viewerMode.value !== 'landing' || openFloorId.value === null || openLandingId.value === null) return [];
  return draftMatches.value.map((match) => ({
    ...match,
    floorId: openFloorId.value as number,
    landingId: openLandingId.value as string,
  }));
});

const currentMatch = computed<StashMatch | null>(() => allMatches.value[currentMatchIndex.value] ?? null);

/** 换关键词就从头算：旧的第几处对新一串匹配没有意义。 */
watch([searchQuery, searchOpen], () => {
  currentMatchIndex.value = -1;
});

/** 计数那格的字：没跳过时报总数，跳过后报「第几处 / 共几处」。 */
const matchCountText = computed<string>(() => {
  if (!searchOpen.value || searchQuery.value === '') return '';
  const total = allMatches.value.length;
  if (total === 0) return t.stashMatchNone;
  const at = currentMatchIndex.value;
  return at >= 0 ? t.stashMatchPosition(at + 1, total) : t.stashMatchTotal(total);
});

/** 当前查看器正文里的匹配（草稿实时算，改动后高亮和计数立刻跟上）。 */
const draftMatches = computed<SearchMatch[]>(() => {
  if (!viewerOpen.value || viewerMode.value !== 'landing' || searchQuery.value === '') return [];
  return findMatches(draftText.value, searchQuery.value);
});

/** 当前匹配在草稿匹配表里的位置（涂橙色用）；草稿改到对不上时给 -1，全按普通匹配涂。 */
const currentDraftIndex = computed<number>(() => {
  const match = currentMatch.value;
  if (!match) return -1;
  return draftMatches.value.findIndex((item) => item.start === match.start && item.end === match.end);
});

/** 投影层的 HTML：先转义再插 mark（正文里的 `<标签>` 必须当纯文字显示）。 */
const highlightHtml = computed<string>(() => buildHighlightHtml(draftText.value, draftMatches.value, currentDraftIndex.value));

/** 替换按钮什么时点得动：正在看某一版、且这一版里有匹配（没按 ▼ 也能直接换第一处）。 */
const canReplace = computed<boolean>(
  () => viewerMode.value === 'landing' && viewerOpen.value && draftMatches.value.length > 0,
);

function toggleSearch(): void {
  searchOpen.value = !searchOpen.value;
  if (searchOpen.value) void nextTick(() => searchInput.value?.focus());
}

function closeSearch(): void {
  searchOpen.value = false;
  searchQuery.value = '';
  replaceQuery.value = '';
  currentMatchIndex.value = -1;
}

function onSearchEnter(event: KeyboardEvent): void {
  stepMatch(event.shiftKey ? -1 : 1);
}

function stepMatch(direction: number): void {
  if (allMatches.value.length === 0) return;
  if (currentMatchIndex.value < 0) {
    goToMatch(direction > 0 ? 0 : allMatches.value.length - 1);
    return;
  }
  goToMatch(currentMatchIndex.value + direction);
}

/** 跳到本版内的第 index 处（循环）。范围只在这一版，不跨版本。 */
function goToMatch(index: number): void {
  const matches = allMatches.value;
  if (matches.length === 0) return;
  currentMatchIndex.value = ((index % matches.length) + matches.length) % matches.length;
  void nextTick(revealCurrentMatch);
}

/**
 * 把当前匹配滚进正文框可视区（上三分之一处）。
 * 投影层与正文框同字体、同内边距、同换行，mark 的 offsetTop 就是正文框里的位置；
 * 判元素不使 instanceof（跨 realm 恒 false，面板 DOM 在酒馆主文档）——直接取属性。
 */
function revealCurrentMatch(): void {
  const textarea = draftTextarea.value;
  const backdrop = backdropRef.value;
  if (!textarea || !backdrop) return;
  syncEditorMetrics();
  const mark = backdrop.querySelector('.acu-hit--current');
  if (!mark) return;
  const top = (mark as HTMLElement).offsetTop;
  textarea.scrollTop = Math.max(0, top - textarea.clientHeight / 3);
}

/**
 * 正文框滚动/变宽时带着投影层一起动（两层各滚各的就错位了）。
 *
 * 宽度这一步是命门：正文框出滚动条时内容区会窄一条，投影层若还全宽，
 * mark 的横向位置就全错了 —— 所以量正文框 `clientWidth`（扣掉滚动条后的
 * 内容+内边距），直接钉给投影层。字体与内边距两层写成同一个显式值
 * （06 分片里注释过），剩下的对齐就全靠这里。
 */
function syncEditorMetrics(): void {
  const textarea = draftTextarea.value;
  const backdrop = backdropRef.value;
  const inner = backdropInnerRef.value;
  if (!textarea || !backdrop || !inner) return;
  backdrop.scrollTop = textarea.scrollTop;
  inner.style.width = `${textarea.clientWidth}px`;
}

// 草稿一变就可能让滚动条出现/消失（打字写到溢出），跟着量一次宽。
watch(draftText, () => {
  void nextTick(syncEditorMetrics);
});

/** 替换当前那一处（只进草稿）。换完自动落到本版内的下一处，本版没了就停在原地。 */
function replaceCurrentMatch(): void {
  if (blockWhileRunning()) return;
  const matches = draftMatches.value;
  if (!canReplace.value || matches.length === 0) return;
  // 没按过 ▼ 时 currentMatch 是空的，这时就从第一处换起，别让按钮看着能点却没反应。
  const at = currentDraftIndex.value;
  const match = matches[at >= 0 ? at : 0];
  if (!match) return;
  const replacement = replaceQuery.value;
  draftText.value = replaceMatch(draftText.value, match, replacement);
  const cursor = match.start + replacement.length;
  const within = findMatches(draftText.value, searchQuery.value);
  const next = within.find((item) => item.start >= cursor) ?? within[0] ?? null;
  if (!next) {
    currentMatchIndex.value = -1;
    return;
  }
  const index = allMatches.value.findIndex(
    (item) =>
      item.floorId === match.floorId && item.landingId === match.landingId && item.start === next.start && item.end === next.end,
  );
  currentMatchIndex.value = index;
  void nextTick(revealCurrentMatch);
}

/** 本版内全部替换（只进草稿）。范围就是当前打开的这一版。 */
function replaceAllInDraft(): void {
  if (blockWhileRunning()) return;
  if (!viewerOpen.value || viewerMode.value !== 'landing' || searchQuery.value === '') return;
  const result = replaceAllMatches(draftText.value, searchQuery.value, replaceQuery.value);
  if (result.count === 0) {
    flash(t.stashReplaceNone);
    return;
  }
  draftText.value = result.text;
  currentMatchIndex.value = -1;
  flash(t.stashReplaceAllDone(result.count));
}


</script>

<template>
  <div class="acu-section">
    <div class="acu-row acu-row--between acu-stash-head">
      <span class="acu-section__title">{{ t.stashTitle }}</span>
      <span class="acu-row acu-stash-actions">
        <button class="acu-btn acu-btn--sm" type="button" :title="t.stashExportHint" @click="exportStash">
          {{ t.stashExport }}
        </button>
        <button class="acu-btn acu-btn--sm" type="button" :disabled="plotRunning" :title="t.stashImportHint" @click="pickPortFile">
          {{ t.stashImport }}
        </button>
        <input
          ref="portInput"
          type="file"
          accept=".json,application/json"
          class="rh-hidden-file"
          :disabled="plotRunning"
          @change="importFromFile"
        />
        <button class="acu-btn acu-btn--sm" type="button" @click="reload">{{ t.stashRefresh }}</button>
      </span>
    </div>
    <p class="acu-notes">{{ t.stashHint }}</p>
    <p v-if="plotRunning" class="acu-notes acu-notes--warn">{{ t.stashPlotRunning }}</p>
    <p v-if="portNote" class="acu-notes">{{ portNote }}</p>

    <template v-if="askPortOverwrite">
      <p class="acu-notes acu-notes--warn">{{ t.stashImportAskOverwrite(conflictText) }}</p>
      <div class="acu-row">
        <button class="acu-btn acu-btn--sm" type="button" :disabled="plotRunning" @click="confirmPortOverwrite">
          {{ t.stashImportOverwrite }}
        </button>
        <button class="acu-btn acu-btn--sm" type="button" @click="cancelPortOverwrite">
          {{ t.stashImportCancel }}
        </button>
      </div>
    </template>
    <p v-if="warning === 'stash_unreadable'" class="acu-notes acu-notes--warn">{{ t.stashUnreadable }}</p>

    <p v-if="entries.length === 0" class="acu-notes">{{ t.stashEmpty }}</p>

    <div v-for="entry in entries" :key="entry.floorId" class="acu-stash-entry">
      <div
        class="acu-stash-entry__head acu-stash-entry__head--clickable"
        role="button"
        tabindex="0"
        :title="entryActionLabel(entry)"
        @click="openEntry(entry)"
        @keydown.enter.prevent="openEntry(entry)"
      >
        <span class="acu-stash-entry__floor">{{ t.stashFloor(entry.floorId) }}</span>
        <span class="acu-stash-entry__meta">{{ t.stashPreset(entry.presetName || '—') }}</span>
        <span
          v-if="entry.state !== 'complete'"
          class="acu-stash-entry__state acu-stash-entry__state--pending acu-stash-entry__state--clickable"
          role="button"
          tabindex="0"
          :title="t.stashViewProgress"
          style="cursor: pointer"
          @click.stop="openWorking(entry)"
          @keydown.enter.prevent.stop="openWorking(entry)"
        >
          {{ t.stashPendingProgress(entry.working ? entry.working.pending.length : 0) }}
        </span>
        <span v-else class="acu-stash-entry__state">{{ t.stashComplete }}</span>
        <span class="acu-stash-entry__open">{{ entryActionLabel(entry) }}</span>
      </div>
      <p v-if="entry.state !== 'complete'" class="acu-notes">{{ t.stashResumeHint }}</p>
      <div class="acu-stash-entry__landings">
        <button
          v-for="(landing, index) in entry.landings"
          :key="landing.id"
          class="acu-btn acu-btn--sm acu-stash-entry__version"
          type="button"
          @click.stop="openViewer(entry, landing)"
        >
          <span class="acu-stash-entry__seq">{{ landingSeqOf(landing, index) }}</span>
          <span v-if="inUse(entry, landing)" class="acu-stash-entry__inuse">{{ t.stashInUse }}</span>
          <span class="acu-stash-entry__time">{{ landingTime(landing) }}</span>
        </button>
      </div>
    </div>
  </div>

  <div v-if="viewerOpen" class="acu-stash-mask">
    <div class="acu-stash-dialog">
      <div class="acu-stash-dialog__head">
        <span class="acu-stash-dialog__title">
          <template v-if="viewerMode === 'working'">{{ t.stashWorkingTitle(openFloorId ?? 0) }}</template>
          <template v-else>
            {{ t.stashEditTarget(openFloorId ?? 0, currentSeq === null ? '' : t.stashVersion(currentSeq)) }}
            <span v-if="currentInUse" class="acu-stash-entry__inuse">{{ t.stashInUse }}</span>
          </template>
        </span>
        <span class="acu-stash-dialog__tools">
          <button
            v-if="viewerMode === 'landing'"
            class="acu-btn acu-btn--sm acu-stash-search__toggle"
            type="button"
            :class="{ 'acu-stash-search__toggle--on': searchOpen }"
            :title="t.stashSearchOpen"
            @click="toggleSearch"
          >
            <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
              <circle cx="6.5" cy="6.5" r="4.5" fill="none" stroke="currentColor" stroke-width="1.6" />
              <line x1="10.2" y1="10.2" x2="14" y2="14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
            </svg>
          </button>
          <button class="acu-stash-dialog__close" type="button" :title="t.stashViewerClose" @click="requestClose">×</button>
        </span>
      </div>

      <div class="acu-stash-dialog__body">
        <template v-if="viewerMode === 'working'">
          <p class="acu-notes">{{ t.stashWorkingHint }}</p>
          <p v-if="workingRows.length === 0" class="acu-notes">{{ t.stashWorkingEmpty }}</p>
          <div v-for="row in workingRows" :key="row.taskId" class="acu-stash-taskrow">
            <span
              class="acu-stash-taskrow__state"
              :class="row.done ? 'acu-stash-taskrow__state--done' : 'acu-stash-taskrow__state--pending'"
            >{{ row.done ? '✓' : '…' }}</span>
            <span class="acu-stash-taskrow__name">{{ row.taskId }}</span>
            <span v-if="row.tags.length" class="acu-stash-taskrow__tags">
              {{ t.stashWorkingTags }}
              <span v-for="(tag, tagIndex) in row.tags" :key="tag.name">{{ tagIndex > 0 ? '、' : '' }}{{ tag.name }}<template v-if="tag.preview">：{{ tag.preview }}</template></span>
            </span>
            <span v-if="row.injectOnly.length" class="acu-stash-taskrow__tags">{{ t.stashWorkingInject }}{{ row.injectOnly.join('、') }}</span>
          </div>
          <p class="acu-notes">{{ t.stashWorkingFoot }}</p>
        </template>
        <template v-else>
        <!-- 搜索与替换：只在当前打开的这一版正文里找（2026-11-09 第 2 条） -->
        <div v-if="searchOpen" class="acu-stash-search">
          <div class="acu-stash-search__row">
            <input
              ref="searchInput"
              v-model="searchQuery"
              class="acu-input acu-stash-search__input"
              type="text"
              :placeholder="t.stashSearchPlaceholder"
              @keydown.enter.prevent="onSearchEnter"
            />
            <span v-if="matchCountText" class="acu-stash-search__count">{{ matchCountText }}</span>
            <button class="acu-btn acu-btn--sm" type="button" :title="t.stashSearchPrev" @click="stepMatch(-1)">▲</button>
            <button class="acu-btn acu-btn--sm" type="button" :title="t.stashSearchNext" @click="stepMatch(1)">▼</button>
            <button class="acu-btn acu-btn--sm" type="button" :title="t.stashSearchClose" @click="closeSearch">×</button>
          </div>
          <div class="acu-stash-search__row">
            <input
              v-model="replaceQuery"
              class="acu-input acu-stash-search__input"
              type="text"
              :placeholder="t.stashReplacePlaceholder"
              @keydown.enter.prevent="replaceCurrentMatch"
            />
            <button
              class="acu-btn acu-btn--sm"
              type="button"
              :disabled="!canReplace || plotRunning"
              :title="t.stashReplaceHint"
              @click="replaceCurrentMatch"
            >
              {{ t.stashReplace }}
            </button>
            <button
              class="acu-btn acu-btn--sm"
              type="button"
              :disabled="searchQuery === '' || !canReplace || plotRunning"
              :title="t.stashReplaceAllHint"
              @click="replaceAllInDraft"
            >
              {{ t.stashReplaceAll }}
            </button>
          </div>
        </div>
        <label class="acu-stash-dialog__label">{{ t.stashTextLabel }}</label>
        <!-- 投影层高亮（批 45）：mark 画在下层、正文框透明叠在上层，两层必须逐字对齐（样式见 06 分片） -->
        <div class="acu-stash-editor">
          <div ref="backdropRef" class="acu-stash-editor__backdrop" aria-hidden="true">
            <div ref="backdropInnerRef" class="acu-stash-editor__inner" v-html="highlightHtml"></div>
          </div>
          <textarea ref="draftTextarea" v-model="draftText" class="acu-stash-dialog__text" :disabled="plotRunning" spellcheck="false" @scroll="syncEditorMetrics"></textarea>
        </div>

        <div class="acu-stash-dialog__tags">
          <span class="acu-stash-dialog__label">{{ t.stashTagsLabel }}</span>
          <p v-if="tagRows.length === 0" class="acu-notes">{{ t.stashNoTags }}</p>
          <div v-for="row in tagRows" :key="row.name" class="acu-stash-tagrow">
            <span class="acu-stash-tagrow__name">{{ row.name }}</span>
            <span class="acu-stash-tagrow__preview">{{ row.preview }}</span>
            <button
              class="acu-stash-tagrow__drop"
              type="button"
              :disabled="plotRunning"
              :title="`删掉 <${row.name}>`"
              @click="dropTag(row.name)"
            >
              ×
            </button>
          </div>
        </div>

        <div class="acu-stash-dialog__tags">
          <span class="acu-stash-dialog__label">{{ t.stashLedgerLabel }}</span>
          <p v-if="ledgerRows.length === 0" class="acu-notes">{{ t.stashLedgerEmpty }}</p>
          <div v-for="row in ledgerRows" :key="row.name" class="acu-stash-tagrow">
            <span class="acu-stash-tagrow__name">{{ row.name }}</span>
            <textarea
              v-model="ledgerDraft[row.name]"
              class="acu-input acu-stash-dialog__text"
              style="min-height: 72px"
              spellcheck="false"
              :disabled="plotRunning"
            ></textarea>
          </div>
        </div>

        <div v-if="carriedRows.length > 0" class="acu-stash-dialog__tags">
          <span class="acu-stash-dialog__label">继承自之前楼层（可编辑）</span>
          <p class="acu-notes">这些标签是从更早的楼层继承来的。改动保存后会算作这一层的产出，写进世界书；没改的保持原样。</p>
          <div v-for="row in carriedRows" :key="row.name" class="acu-stash-tagrow">
            <span class="acu-stash-tagrow__name">{{ row.name }}</span>
            <textarea
              v-model="carriedDraft[row.name]"
              class="acu-input acu-stash-dialog__text"
              style="min-height: 72px"
              spellcheck="false"
              :disabled="plotRunning"
            ></textarea>
          </div>
        </div>

        <p v-if="gap.taskIds.length > 0" class="acu-notes">{{ t.stashGapHint(gap.tags.join('、'), gap.taskIds.length) }}</p>

        <p v-if="saveError" class="acu-notes acu-notes--error">{{ saveError }}</p>
        <p v-else-if="notice" class="acu-notes acu-notes--ok">{{ notice }}</p>
        </template>
      </div>

      <div v-if="viewerMode === 'landing'" class="acu-stash-dialog__foot">
        <p v-if="dirty" class="acu-notes acu-notes--sm acu-stash-dialog__hint">{{ t.stashUseDirty }}</p>
        <button class="acu-btn acu-btn--sm" type="button" :disabled="dirty || plotRunning" @click="applyToFloor">
          {{ t.stashApply }}
        </button>
        <button class="acu-btn acu-btn--sm" type="button" :disabled="dirty" @click="rerunText">
          {{ t.stashRerun }}
        </button>
        <button class="acu-btn acu-btn--sm danger" type="button" :disabled="plotRunning" @click="requestRemove">{{ t.stashDelete }}</button>
        <button class="acu-btn acu-btn--sm" type="button" :disabled="plotRunning" @click="requestDropVersion">{{ t.stashDropVersion }}</button>
        <button class="acu-btn primary" type="button" :disabled="!dirty || plotRunning" @click="save">{{ t.stashSave }}</button>
      </div>
      <div v-else class="acu-stash-dialog__foot">
        <button class="acu-btn acu-btn--sm" type="button" @click="requestClose">{{ t.stashViewerClose }}</button>
      </div>

      <div v-if="viewerMode === 'landing' && askDelete" class="acu-stash-ask">
        <p class="acu-stash-ask__text">{{ t.stashDeleteConfirm }}</p>
        <div class="acu-stash-ask__btns">
          <button class="acu-btn acu-btn--sm" type="button" @click="askDelete = false">{{ t.stashDeleteCancel }}</button>
          <button class="acu-btn acu-btn--sm danger" type="button" :disabled="plotRunning" @click="confirmRemove">{{ t.stashDeleteOk }}</button>
        </div>
      </div>

      <div v-if="viewerMode === 'landing' && askDropVersion" class="acu-stash-ask">
        <p class="acu-stash-ask__text">{{ t.stashDropVersionConfirm }}</p>
        <div class="acu-stash-ask__btns">
          <button class="acu-btn acu-btn--sm" type="button" @click="askDropVersion = false">{{ t.stashDropVersionCancel }}</button>
          <button class="acu-btn acu-btn--sm danger" type="button" :disabled="plotRunning" @click="confirmDropVersion">{{ t.stashDropVersionOk }}</button>
        </div>
      </div>

      <div v-if="viewerMode === 'landing' && askDiscard" class="acu-stash-ask">
        <p class="acu-stash-ask__text">{{ t.stashDirtyClose }}</p>
        <div class="acu-stash-ask__btns">
          <button class="acu-btn acu-btn--sm" type="button" @click="askDiscard = false">{{ t.stashDirtyStay }}</button>
          <button class="acu-btn acu-btn--sm danger" type="button" @click="discardAndClose">{{ t.stashDirtyLeave }}</button>
        </div>
      </div>
    </div>
  </div>
</template>
