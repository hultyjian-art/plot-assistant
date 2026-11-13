<script setup lang="ts">
/**
 * 剧情推进那一套页面（左侧功能列选「剧情推进」时显示的内容）。
 *
 * **版式照搬工作流助手**（同一个作者、同一条业务链上的成熟界面）：顶上一排等宽页签，
 * 每页里是一串圆角区块，页底「上一页 / N / PAGE_COUNT / 下一页」。原先那套「预设与开关 /
 * 任务清单 / 暂存与日志 / API 配置」的自造分区已经拆掉 —— 其中「任务清单」只读不写，
 * 跟预设里那份重复；真正能改的东西反而被埋在预设编辑器里。
 *
 * 五页各管一件事：
 *   1 API      —— 总开关 + API 条目 + 超时（对应工作流助手第 1 页）
 *   2 上下文   —— 取多少条前文 + 标签筛选规则（对应它的「$7 默认上下文」）
 *   3 任务     —— 预设（选哪份 / 导入导出）+ 最终注入指令 + 任务卡片与提示词块
 *   4 暂存     —— 同一楼层的多版成果在这里看、改、删
 *   5 运行日志 —— 每轮每任务的提示词 / 回传 / 耗时 / 报错（对应工作流助手第 4 页）
 *
 * **这一页除了「打开总开关时若数据库脚本的剧情推进也开着，只弹一条提示让用户自己去关」，不写数据库脚本任何东西**：
 * 预设从它那里按名字取，API 则是"导入一份到本地"后就与它无关了（用户要求的独立存储）。
 */
import { DEFAULT_MAX_TOKENS } from '../constants';
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { klona } from 'klona';
import { UI } from '../copy';
import PresetEditor from './PresetEditor.vue';
import PresetIo from './PresetIo.vue';
import StashPanel from './StashPanel.vue';
import RunLogPanel from './RunLogPanel.vue';
import TagRuleEditor from './TagRuleEditor.vue';
import TaskEditor from './TaskEditor.vue';
import CopyPasteDialog from './CopyPasteDialog.vue';
import { clipKind, clipSource, copyBlockToClip, copyTaskToClip, readClip } from './clipboard';
import {
  describePresetProblem,
  listPlotPresetNames,
  readAllPlotPresets,
  readCurrentPlotPresetName,
  readPlotPreset,
  resolveAcuPresetApi,
} from '../plot/data/acu-presets';
import { describeAcuApiProblem, mergePlotApis } from '../plot/data/acu-apis';
import { buildDeepSeekTemplate } from '../plot/api-body';
import { readAcuApiPresets } from '../plot/data/acu-apis-io';
import { readAcuPlotFlag } from '../plot/data/acu-plot-flag';
import { migrateQrfToStash, migrateStashToQrf } from '../plot/stash-migrate';
import { readArmedTaskIds, setArmedTaskIds } from '../plot/manual-arm';
import { saveSettings } from '../settings';
import { pageQuery, pageToastr } from '../tavern';
import {
  MAX_STORED_PRESET_CHARS,
  describePresetSource,
  describeStoredPresetSize,
  findStoredPreset,
  listStoredPresetNames,
  measurePresetSize,
  mergeStoredPresets,
} from '../plot/data/preset-store';
import {
  WORLD_BOOK_WRITE_KEY,
  adoptBlockDraft,
  applyPresetDraft,
  applyTaskDrafts,
  cloneTaskDraft,
  findNameConflict,
  newPresetData,
  packWorldbookWrite,
  presetFileName,
  readPresetDraft,
  readTaskDrafts,
  readWorldbookWriteFromPreset,
  toPresetExportJson,
  validatePresetDraft,
  type PresetDraft,
  type PresetWorldbookWrite,
  type TaskBlockDraft,
  type TaskDraft,
} from '../plot/preset-edit';
import { maskApiKey } from '../plot/api-key';
import { fetchModelList } from '../plot/api-models-io';
import type { PlotApiEntry, PlotSettings, RerushContext, StoredPlotPreset } from '../types';
import { previewPlotRound, type PlotPreview } from '../plot/preview-flow';
import { collectKnownTagNames } from '../plot/eng/tag-diff';
import { cleanupAllWorldbooks, cleanupCurrentCardWorldbooks } from '../plot/worldbook-write';
import { getCommentInfo, isDatabaseGeneratedEntry, isFrameworkEntry, isManagedWorldbookEntry } from '../plot/data/worldbook-hits';

const props = defineProps<{
  plot: PlotSettings;
  /** 脚本上下文：预览要真取一遍世界书与表格，所以得拿着它。 */
  ctx: RerushContext;
}>();

/**
 * 草稿：从 ctx.settings 整份拷一份，改完由外层统一 emit('save')。
 *
 * **不要改回手写字段清单。** 早先这里是一张手写的键表，每加一个字段都得记得补；
 * 漏一个，面板改完一保存那一项就被静默抹掉。整份 `klona` 之后，以后再加字段不用动这里。
 */
const draft = reactive<PlotSettings>(klona(props.plot));

/**
 * 上一次落盘时的样子，只用来回答一个问题：「这一页有没有改过还没存？」
 *
 * 用整份 JSON 比而不是逐字段比：字段还会继续加，手写清单必然漏，
 * 漏了就是「明明改了却说不脏」——那还不如没有这个提示。
 */
const snapshot = ref(JSON.stringify(props.plot));

/** 这一页有没有没保存的改动。 */
const isDirty = computed(() => JSON.stringify(draft) !== snapshot.value);

/** 把草稿退回上一次保存的样子（连同选中项一起重载，别留下指向已被丢弃内容的编辑器）。 */
function discardDraft(): void {
  Object.assign(draft, klona(props.plot));
  snapshot.value = JSON.stringify(props.plot);
  loadEditor();
}

/** 保存成功后由外层调用，重新拍一张快照。 */
function markSaved(): void {
  snapshot.value = JSON.stringify(draft);
}

/**
 * 给外层的「有没有改过」。
 *
 * 暴露函数而不是 `isDirty` 这个 ref 本身：`defineExpose` 出来的 ref 在父组件那边
 * 是 ref 对象，模板里才会自动拆包，两种写法混着用最容易出现「永远不脏」或「永远脏」。
 */
function isDirtyNow(): boolean {
  return isDirty.value;
}

defineExpose({ draft, applyEditor, isDirtyNow, discardDraft, markSaved, validationNote: () => presetNote.value });

/**
 * 立刻把这一页的草稿写进设置。
 *
 * 只给「导入」这类一次动一批的操作用：导完还要再点一次保存才生效的话，
 * 中间切页或者随手关掉面板就白导了。其余控件仍然走「改完统一保存」——
 * 不然每敲一个字符就写一次盘。
 */
function commitPlot(): void {
  if (saveSettings(props.ctx, { plot: klona(draft) })) {
    // 导入预设会一次改一批任务；保存成功后要让楼层下的手动按钮立即重排，
    // 不用等用户再点一次设置面板的保存或换角色卡（2026-11-11 用户实测反馈）。
    props.ctx.onSettingsSaved?.();
  }
}


/**
 * 页签。`short` 是窄屏用的短名 —— 照工作流助手的 `acu-page-tab__short`：
 * 手机上 390px 装不下五个全名，靠短名保持一行；全名在宽屏照旧。
 */
const pageTabs = [
  { id: 1 as const, label: UI.plot.pageApi, short: UI.plot.pageApi },
  { id: 2 as const, label: UI.plot.pageContext, short: UI.plot.pageContextShort },
  { id: 3 as const, label: UI.plot.pageTasks, short: UI.plot.pageTasks },
  // 暂存是我们自己的东西（工作流助手没有），单列一页；
  // 日志排在最后，与工作流助手的页序一致（它第 4 页就是日志）。
  { id: 4 as const, label: UI.plot.pageStash, short: UI.plot.pageStash },
  { id: 5 as const, label: UI.plot.pageLogs, short: UI.plot.pageLogs },
];
const PAGE_COUNT = pageTabs.length;

/**
 * 当前第几页。
 *
 * 编号就是页码，和页底那个「N / PAGE_COUNT」用的是同一个数 —— 以前这里是标签 key
 * （preset/tasks/assets/apis），翻页按钮得自己做一次"前后是谁"的映射，
 * 加一页就要改三处。用数字页码，加页只是往 pageTabs 里多塞一项。
 */
const page = ref(1);

function goToPage(target: number): void {
  page.value = Math.min(PAGE_COUNT, Math.max(1, target));
}

/** 数据库脚本里列出来的预设名：点「重新读取」时才重读一遍（避免每次渲染都摸一次 ACU）。 */
const acuPresetNames = ref<string[]>([]);
/**
 * 可以选的预设名 = 数据库脚本里有的 + 本地库里抄下来的。
 *
 * 只列数据库那一份是不够的：本地库存在的意义就是「数据库关了也能跑」，
 * 而那种时候数据库一个名字都给不出来，用户就没法选自己导入过的预设了。
 * 顺序上数据库的排前面 —— 那边是活的，改了什么立刻能选。
 */
const presetNames = computed(() => {
  const names = [...acuPresetNames.value];
  for (const name of listStoredPresetNames(draft.presets)) {
    if (!names.includes(name)) names.push(name);
  }
  return names;
});
const presetProblem = ref('');
/** 数据库脚本那边当前正在用的那一份（只做展示，也用来给空白的人兜个底）。 */
const presetCurrent = ref('');
/** 选中预设的任务表（只做展示） */
const presetTasks = ref<Array<Record<string, unknown>>>([]);

function refreshPresets(): void {
  const api = resolveAcuPresetApi();
  acuPresetNames.value = listPlotPresetNames(api);
  presetCurrent.value = readCurrentPlotPresetName(api);

  // 还没选过的人，顺手跟数据库当前在用的那份对齐 —— 他多半就是想要那一个。
  // 已经选过的不动：选择权在用户手上，我们只在他空白时给个合理的起点。
  if (draft.presetName === '' && presetCurrent.value !== '') draft.presetName = presetCurrent.value;

  // 本地抄过一份的，直接看本地那份：运行时就先查本地，
  // 面板要是还去问数据库，数据库一关这里就报「读不到」，跟实际会跑什么对不上。
  const stored = findStoredPreset(draft.presets, draft.presetName);
  if (stored) {
    presetProblem.value = '';
    const localTasks = stored.data.plotTasks;
    presetTasks.value = Array.isArray(localTasks) ? (localTasks as Array<Record<string, unknown>>) : [];
    return;
  }

  const outcome = readPlotPreset(draft.presetName, api);
  if (!outcome.ok) {
    presetProblem.value = outcome.reason === 'not-chosen' ? '' : describePresetProblem(outcome);
    presetTasks.value = [];
    return;
  }

  presetProblem.value = '';
  const raw = outcome.details.plotTasks;
  presetTasks.value = Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : [];
}

// 打开这一页就先读一次：用户点进来就是想看现在有什么
refreshPresets();

/** 换预设时立刻重读任务表，不用再点一次刷新。 */
function pickPreset(name: string): void {
  if (draft.presetName !== name) clearArmedForOtherPresets(name);
  draft.presetName = name;
  refreshPresets();
}

/** 预约锚点名带预设名前缀；换预设时旧前缀的预约就是死数据，直接清掉。 */
function clearArmedForOtherPresets(nextName: string): void {
  const armed = readArmedTaskIds();
  if (armed.length === 0) return;
  const prefix = `${nextName}::`;
  const next = armed.filter((id) => id.startsWith(prefix));
  if (next.length !== armed.length) setArmedTaskIds(next);
}

/** 删预设 / 改名时清掉它名下的全部预约。 */
function clearArmedOfPreset(name: string): void {
  const armed = readArmedTaskIds();
  if (armed.length === 0) return;
  const prefix = `${name}::`;
  const next = armed.filter((id) => !id.startsWith(prefix));
  if (next.length !== armed.length) setArmedTaskIds(next);
}

// ——— 本地预设库 ———

/** 导入结果的提示语。 */
const presetNote = ref('');

/**
 * 把数据库里的预设整套抄一份到本地。
 *
 * 为什么要抄：数据库那边的预设是它的私有数据，我们只能按名字实时问它要。
 * 它一关、一改、一删，这边就没得用了。抄一份之后这边是自足的 ——
 * 这也正是用户要的「独立储存、不共用键」。
 */
function importPresetsFromAcu(): void {
  const outcome = readAllPlotPresets();
  if (!outcome.ok) {
    presetNote.value =
      outcome.reason === 'no-api'
        ? '导入失败：读不到数据库脚本的接口。确认它在酒馆里装着并已加载。'
        : '导入失败：数据库脚本里一个具名预设都没有。';
    return;
  }

  // 直接把数据库给的原样交给 mergeStoredPresets —— 包一层是它的事。
  // 2026-11-01 这里先自己包了一次、它又包一次，落盘成了双层，任务表和提示词被埋进第二层。
  const merged = mergeStoredPresets(draft.presets, outcome.presets, { source: 'acu' });
  draft.presets = merged.presets;
  if (draft.presetName === '' && merged.presets.length > 0) draft.presetName = merged.presets[0].name;

  presetNote.value = UI.plot.presetImportDone(merged.added, merged.replaced, merged.kept, merged.skipped);
  // 导入是「一次动一批」：直接落盘 + 重装编辑器，不用再点一次「保存」再切回来
  commitPlot();
  loadEditor();
  refreshPresets();
}

/** 删掉一份本地副本。删的正好是当前选中的，就把选择也清掉，免得指向不存在的东西。 */
function dropPreset(name: string): void {
  clearArmedOfPreset(name);
  draft.presets = draft.presets.filter((preset) => preset.name !== name);
  if (draft.presetName === name) {
    draft.presetName = '';
    presetTasks.value = [];
  }
}

/** 列表里显示体积：只量数据本体，不含名字/来源这些包装字段。 */
function presetSizeText(preset: StoredPlotPreset): string {
  return describeStoredPresetSize(measurePresetSize(preset.data));
}

// ——— 工具栏上的三个动作（新建 / 另存为 / 删除）———
//
// 全都在本地库里动：新建是往 `draft.presets` 里塞一条空预设，另存为是拷一份改个名。
// 名字撞了不覆盖 —— 直接加序号，因为这几下都是用户主动点出来的，不该弹窗打断。

/** 找一个没被占用的名字：`基础`、`基础 2`、`基础 3`…… */
function uniquePresetName(base: string): string {
  const taken = new Set(draft.presets.map((preset) => preset.name));
  if (!taken.has(base)) return base;
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${base} ${index}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base} ${Date.now()}`;
}

/** 新建一份空预设，并立刻选中它（选中 → 自动装载编辑器）。 */
function createPreset(): void {
  const name = uniquePresetName(UI.plot.presetActionNewBase);
  const merged = mergeStoredPresets(draft.presets, [newPresetData(name)], { keepLocal: false, source: 'local' });
  draft.presets = merged.presets;
  if (draft.presetName !== name) clearArmedForOtherPresets(name);
  draft.presetName = name;
  presetNote.value = UI.plot.presetCreated(name);
}

/** 把当前这份拷一份改个名。数据整份深拷，改哪份都不会串到另一份。 */
function duplicatePreset(): void {
  const stored = editingStored.value;
  if (!stored) return;
  const name = uniquePresetName(`${stored.name} 副本`);
  // 直接把原数据交给 mergeStoredPresets —— 它自己会包成 { name, data }。
  // （2026-11-01 在「从数据库导入」那里先包了一次、它又包一次，落盘成了双层，别再犯。）
  const merged = mergeStoredPresets(draft.presets, [{ ...klona(stored.data as Record<string, unknown>), name }], {
    keepLocal: false,
    source: 'local',
  });
  draft.presets = merged.presets;
  if (draft.presetName !== name) clearArmedForOtherPresets(name);
  draft.presetName = name;
  presetNote.value = UI.plot.presetCreated(name);
}

/** 删掉当前选中的那份（工具栏的删除按钮）。 */
function removeCurrentPreset(): void {
  const name = draft.presetName;
  if (name === '') return;
  dropPreset(name);
  presetNote.value = UI.plot.presetDeleted(name);
}

/** 导出用的文本与文件名（工具栏按钮要）。 */
const exportText = computed(() =>
  exportData.value === null ? '' : toPresetExportJson(exportData.value, packWorldbookWrite(draft)),
);
const exportName = computed(() => presetFileName(draft.presetName));

/** 任务表里某一条的展示用字段（都是预设自带的可选字段，缺了就是空）。 */
function taskName(task: Record<string, unknown>, index: number): string {
  const name = typeof task.name === 'string' ? task.name.trim() : '';
  return name === '' ? `任务 ${index + 1}` : name;
}

function taskEnabled(task: Record<string, unknown>): boolean {
  return task.enabled !== false;
}

function taskStage(task: Record<string, unknown>): number {
  const stage = typeof task.stage === 'number' ? task.stage : 1;
  return Number.isFinite(stage) ? stage : 1;
}

function taskTagText(task: Record<string, unknown>, key: 'extractTags' | 'extractInjectTags'): string {
  const raw = task[key];
  if (typeof raw === 'string') return raw.trim();
  if (Array.isArray(raw)) {
    return raw.map((item) => (typeof item === 'string' ? item : '')).filter((item) => item !== '').join('、');
  }
  return '';
}

// ——— 预设编辑器 ———
//
// 编辑的**只有本地库里那份副本**：选中一个实时从数据库读来的预设时，
// 这里连编辑入口都不给（只提示先导入）。数据库脚本是别人的数据，
// 我们读它是为了跑起来，不是为了替它改东西。

/** 当前选中、且确实在本地库里的那一份。 */
const editingStored = computed<StoredPlotPreset | undefined>(() => findStoredPreset(draft.presets, draft.presetName));

const editorDraft = ref<PresetDraft | null>(null);
const editorTasks = ref<TaskDraft[]>([]);
/** 打开编辑器时那份预设叫什么：应用时要靠它找到被覆盖的那一条（用户可能在里面改了名）。 */
const editorOrigin = ref('');

function loadEditor(): void {
  const stored = editingStored.value;
  if (!stored) {
    editorDraft.value = null;
    editorTasks.value = [];
    editorOrigin.value = '';
    return;
  }
  editorOrigin.value = stored.name;
  editorDraft.value = readPresetDraft(stored.data);
  editorTasks.value = readTaskDrafts(stored.data);
}

/**
 * `$7` 条数改哪儿：有预设就写预设（预设覆盖全局），没预设就写全局兜底。
 *
 * 为什么不同时写两处：预设覆盖全局，两边同写的话，切到另一份预设时会被全局值拽回来，
 * 用户会看到「我刚设的又变了」。
 */
function setContextTurnCount(value: number): void {
  const target = editorDraft.value;
  if (target !== null) {
    target.meta.contextTurnCount = value;
    return;
  }
  draft.contextDefaults.turnCount = value;
}

// 选中哪份就读哪份：上下文页、任务页都要拿这份草稿来渲染，
// 靠一个「打开编辑器」按钮开关会很别扭（切到上下文页却发现是空的）。
/**
 * 世界书（`$1`）清单。
 *
 * 为什么要在这里现读：世界书是聊天期间随时会加/删的，面板开着半小时就可能多出一本。
 * 存一份清单在设置里，用户切回来看见的会是"当年"的书架，勾了不存在的书还以为生效了。
 */
const wbBooks = ref<string[]>([]);
const wbLoading = ref(false);
const wbError = ref('');
/** 书单搜索词。496 本书不给人搜索框，等于逼人用滚轮找 —— 工作流助手那边也有这一格。 */
const wbQuery = ref('');
const filteredBooks = computed(() => {
  const q = wbQuery.value.trim().toLowerCase();
  if (q === '') return wbBooks.value;
  return wbBooks.value.filter((name) => name.toLowerCase().includes(q));
});

async function loadWorldbooks(): Promise<void> {
  wbLoading.value = true;
  wbError.value = '';
  try {
    const names = getWorldbookNames();
    wbBooks.value = Array.isArray(names) ? names.filter((name) => typeof name === 'string' && name.trim() !== '') : [];
  } catch (error) {
    wbBooks.value = [];
    wbError.value = `读不到世界书列表：${error instanceof Error ? error.message : String(error)}`;
    console.warn('[剧情推进助手] 读世界书列表失败', error);
  } finally {
    wbLoading.value = false;
  }
}

function toggleWorldbook(name: string): void {
  const list = draft.worldbookBooks.slice();
  const at = list.indexOf(name);
  if (at >= 0) list.splice(at, 1);
  else list.push(name);
  draft.worldbookBooks = list;
}

/**
 * 世界书条目：`$1` 到底会读到哪些条目，用户能不能少要几条。
 *
 * 上游（工作流助手）是给一个框，把当前绑定世界的条目列出来逐条勾。这里照做，
 * 但只列**这一轮真正会读的那几本书** —— 书架上有几百本，全列出来等于让人自己在海里捞。
 * 角色卡模式列「主书 + 附加知识书」，手动模式列他勾的那几本。
 */
interface WbEntryRow {
  uid: string;
  label: string;
  /** 本来就不进 `$1`（框架条目名 / 大纲表 / 纪要索引） */
  blocked: boolean;
  /** 数据库脚本生成的条目（`$9` 整批剔掉的那一批） */
  db: boolean;
}

const wbEntryRows = ref<Record<string, WbEntryRow[]>>({});
const wbEntryLoading = ref(false);
const wbEntryError = ref('');
const wbEntryQuery = ref('');
/** 角色卡绑定的书：主书 + 附加知识书 */
const wbCharBooks = ref<{ primary: string; additional: string[] }>({ primary: '', additional: [] });

function readCharBooks(): void {
  try {
    const names = getCharWorldbookNames('current');
    wbCharBooks.value = {
      primary: typeof names?.primary === 'string' ? names.primary.trim() : '',
      additional: Array.isArray(names?.additional)
        ? names.additional.filter((name): name is string => typeof name === 'string' && name.trim() !== '').map(name => name.trim())
        : [],
    };
  } catch (error) {
    wbCharBooks.value = { primary: '', additional: [] };
    console.warn('[剧情推进助手] 读角色卡绑定的世界书失败', error);
  }
}

/** 当前 `$1` 会读的那几本书（带「主书 / 附加」标记）。 */
const wbShownBooks = computed<Array<{ name: string; tag: string }>>(() => {
  const out: Array<{ name: string; tag: string }> = [];
  if (draft.worldbookSource === 'manual') {
    for (const name of draft.worldbookBooks) out.push({ name, tag: '' });
    return out;
  }
  if (wbCharBooks.value.primary !== '') out.push({ name: wbCharBooks.value.primary, tag: UI.plot.worldbookEntryPrimaryTag });
  for (const name of wbCharBooks.value.additional) out.push({ name, tag: UI.plot.worldbookEntryAdditionalTag });
  return out;
});

async function loadWorldbookEntries(): Promise<void> {
  const books = wbShownBooks.value.map(item => item.name);
  wbEntryError.value = '';
  if (books.length === 0) {
    wbEntryRows.value = {};
    return;
  }
  wbEntryLoading.value = true;
  try {
    const next: Record<string, WbEntryRow[]> = {};
    for (const book of books) {
      const entries = await getWorldbook(book);
      next[book] = (Array.isArray(entries) ? entries : []).map((entry) => {
        const name = String(entry.name ?? '').trim();
        const { rawComment, normalizedComment } = getCommentInfo({ comment: name, name });
        return {
          uid: String(entry.uid ?? ''),
          label: name || `条目 ${String(entry.uid ?? '')}`,
          blocked: isFrameworkEntry({ rawComment, normalizedComment }) || isManagedWorldbookEntry({ rawComment }),
          db: isDatabaseGeneratedEntry({ normalizedComment }),
        };
      });
    }
    wbEntryRows.value = next;
  } catch (error) {
    wbEntryRows.value = {};
    wbEntryError.value = UI.plot.worldbookEntryReadError(error instanceof Error ? error.message : String(error));
    console.warn('[剧情推进助手] 读世界书条目失败', error);
  } finally {
    wbEntryLoading.value = false;
  }
}

/** 这本书的勾选清单；`null` = 缺键 = 全选。 */
function entrySelection(book: string): string[] | null {
  const list = draft.worldbookEntries[book];
  return Array.isArray(list) ? list : null;
}

function isEntryOn(book: string, uid: string): boolean {
  const list = entrySelection(book);
  return list === null ? true : list.includes(uid);
}

function setEntry(book: string, uid: string, on: boolean): void {
  const all = (wbEntryRows.value[book] ?? []).map(row => row.uid);
  const current = entrySelection(book) ?? all;
  const next = current.filter(id => id !== uid);
  if (on) next.push(uid);
  const map: Record<string, string[]> = { ...draft.worldbookEntries };
  // 全勾回去就把键删掉，回到「缺键 = 全选」—— 这样以后新加的条目自动生效，
  // 否则用户会看到一个自己没动过的新条目莫名其妙不生效。
  if (all.length > 0 && next.length === all.length) delete map[book];
  else map[book] = next;
  draft.worldbookEntries = map;
}

function onEntryToggle(book: string, uid: string, event: Event): void {
  const checked = (event.target as HTMLInputElement | null)?.checked === true;
  setEntry(book, uid, checked);
}

function setAllEntries(book: string, on: boolean): void {
  const map: Record<string, string[]> = { ...draft.worldbookEntries };
  if (on) delete map[book];
  else map[book] = [];
  draft.worldbookEntries = map;
}

function entryRowsOf(book: string): WbEntryRow[] {
  const rows = wbEntryRows.value[book] ?? [];
  const query = wbEntryQuery.value.trim().toLowerCase();
  if (query === '') return rows;
  return rows.filter(row => row.label.toLowerCase().includes(query));
}

function entryOnCount(book: string): number {
  const list = entrySelection(book);
  const rows = wbEntryRows.value[book] ?? [];
  return list === null ? rows.length : rows.filter(row => list.includes(row.uid)).length;
}

// ───────────────────────── 世界书写入（2026-11-07 批 36-38） ─────────────────────────
//
// 与上面「世界书（$1）」是读与写两件事：那块管任务提示词读哪几本书，这一块管
// 把一轮推进的标签块写进哪本书。字段分开（worldbookWrite*）、控件分开，别混着改。

/** 当前预设里出现过的标签名：任务抽取标签 + 最终注入里的 `{{标签}}`，规则下拉从这选。 */
const wbWriteTagOptions = computed<string[]>(() => {
  const ed = editorDraft.value;
  if (ed === null) return [];
  return collectKnownTagNames(editorTasks.value, ed.prompts.finalDirective);
});

function addWbWriteRule(): void {
  const used = new Set(draft.worldbookWriteRules.map(rule => rule.tagName));
  // 优先补还没被用过的标签：连点几下「加一条」不该全是同一个标签
  const tag = wbWriteTagOptions.value.find(name => !used.has(name)) ?? wbWriteTagOptions.value[0] ?? '';
  if (tag === '') return;
  draft.worldbookWriteRules = [
    ...draft.worldbookWriteRules,
    // 位置默认照工作流助手（批 36 用户定）：系统深度 / 深度 2 / 顺序 10000
    { tagName: tag, entryName: '', depth: 2, order: 10000, enabled: true },
  ];
}

function removeWbWriteRule(index: number): void {
  draft.worldbookWriteRules = draft.worldbookWriteRules.filter((_, at) => at !== index);
}

/** 写入手动模式的搜索词。与读侧那格分开 —— 两个书单同时开着时互不干扰。 */
const wbWriteQuery = ref('');
const filteredWriteBooks = computed(() => {
  const q = wbWriteQuery.value.trim().toLowerCase();
  if (q === '') return wbBooks.value;
  return wbBooks.value.filter((name) => name.toLowerCase().includes(q));
});

function toggleWbWriteBook(name: string): void {
  const list = draft.worldbookWriteBooks.slice();
  const at = list.indexOf(name);
  if (at >= 0) list.splice(at, 1);
  else list.push(name);
  draft.worldbookWriteBooks = list;
}

watch(
  () => draft.worldbookWriteSource,
  (source) => {
    if (source === 'manual' && wbBooks.value.length === 0) void loadWorldbooks();
  },
);

/** 清理按钮的忙态：两个按钮共用，防止连点并发删。 */
const wbWriteCleaning = ref<'current' | 'all' | null>(null);

/**
 * 两个清理按钮（批 36 用户定）。都要二次确认 —— 会动世界书数据。
 *
 * 范围与认领口径刻意不同（交接文档 §4.4）：
 * - 只清当前角色卡的：角色卡绑定的书里、按**当前规则推导出的完整条目名**删；
 * - 清理本机所有世界书的：按**前缀**扫全部书，兜得住改名 / 删规则留下的孤儿。
 * 用的是**已保存**的设置（`ctx.settings.plot`），面板上没保存的草稿不算数 ——
 * 与引擎实际写入用的规则保持同一个口径。
 */
async function runWbCleanup(kind: 'current' | 'all'): Promise<void> {
  if (wbWriteCleaning.value !== null) return;
  // 用父窗口的 confirm —— iframe 自己那个在部分浏览器里会被拦（见 dropApi 的注释）。
  const ask = (window.parent as { confirm?: (text: string) => boolean }).confirm;
  const message = kind === 'current' ? UI.plot.wbWriteCleanCurrentConfirm : UI.plot.wbWriteCleanAllConfirm;
  if (typeof ask === 'function' && !ask(message)) return;

  wbWriteCleaning.value = kind;
  try {
    const rules = props.ctx.settings.plot.worldbookWriteRules;
    const result = kind === 'current' ? await cleanupCurrentCardWorldbooks(rules) : await cleanupAllWorldbooks();
    if (result.deleted === 0) pageToastr()?.success(UI.plot.wbWriteCleanNone, UI.plot.wbWriteSection);
    else pageToastr()?.success(UI.plot.wbWriteCleanDone(result.deleted, result.books.length), UI.plot.wbWriteSection);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    pageToastr()?.error(UI.plot.wbWriteCleanFail(message), UI.plot.wbWriteSection);
    console.warn('[剧情推进助手] 清理世界书写入条目失败', error);
  } finally {
    wbWriteCleaning.value = null;
  }
}

watch(
  () => draft.worldbookSource,
  (source) => {
    if (source === 'manual' && wbBooks.value.length === 0) void loadWorldbooks();
    // 换来源 = 换了一本书，旧条目清单不能继续挂着（会让人以为勾的是新书里的条目）
    wbEntryRows.value = {};
    if (source === 'character') readCharBooks();
  },
);

// 条目是异步读的（一本书几百条），所以等用户真翻到「上下文」页再读，
// 面板一打开就把三本书全拉一遍会明显卡一下。
watch(page, (current) => {
  if (current !== 2) return;
  if (Object.keys(wbEntryRows.value).length > 0 || wbEntryLoading.value) return;
  void loadWorldbookEntries();
});

watch(() => draft.presetName, loadEditor, { flush: 'sync' });

/**
 * 数据库脚本的剧情推进也开着 —— 弹一条提示，让用户自己去关。
 *
 * 为什么不代劳：ACU 的开关在它自己内存里有一份，改存储它看不见（下次保存还会把
 * true 写回）。能把它内存里那份关掉的只有它自己的开关，而那个开关只在它面板打开
 * 时才存在 —— 一个「用户恰好开着它的面板才生效」的按钮，不如让他直接去关快。
 */
function warnAcuPlotOn(): void {
  pageToastr().warning(UI.plot.acuPlotOnWarn, '', { timeOut: 0, extendedTimeOut: 0 });
}

watch(
  () => draft.enabled,
  (on) => {
    if (!on) return;
    if (readAcuPlotFlag() !== 'on') return;
    warnAcuPlotOn();
  },
);

onMounted(() => {
  readCharBooks();
  loadEditor();
});

/**
 * 应用修改：校验 → 写回预设本体 → 换掉本地库里那一条。
 *
 * 整份写回（`applyPresetDraft` 是「深拷原对象 + 定点覆盖」），**不做字段级 merge**：
 * 预设本体有二十多个键，只写回改过的那几个，剩下的迟早被漏掉一个。
 */
function applyEditor(): boolean {
  const draftData = editorDraft.value;
  const stored = findStoredPreset(draft.presets, editorOrigin.value);
  if (draftData === null || stored === undefined) {
    loadEditor();
    return true;
  }

  const issues = validatePresetDraft(draftData, editorTasks.value.length);
  const error = issues.find((issue) => issue.level === 'error');
  if (error) {
    presetNote.value = error.message;
    return false;
  }

  const nextName = draftData.meta.name.trim();
  const others = draft.presets.filter((item) => item.name !== editorOrigin.value).map((item) => item.name);
  const conflict = findNameConflict(nextName, others);
  if (conflict !== null) {
    presetNote.value = UI.plot.presetEditNameTaken(conflict);
    return false;
  }

  const data = applyTaskDrafts(applyPresetDraft(stored.data, draftData), editorTasks.value);
  const size = measurePresetSize(data);
  if (size > MAX_STORED_PRESET_CHARS) {
    presetNote.value = UI.plot.presetEditTooBig(
      describeStoredPresetSize(size),
      describeStoredPresetSize(MAX_STORED_PRESET_CHARS),
    );
    return false;
  }

  const oldName = editorOrigin.value;
  const index = draft.presets.indexOf(stored);
  draft.presets[index] = { ...stored, name: nextName, data };
  if (oldName !== nextName) clearArmedOfPreset(oldName);
  if (draft.presetName === oldName) draft.presetName = nextName;

  const warns = issues.filter((issue) => issue.level === 'warn');
  const applied = UI.plot.presetEditApplied(describeStoredPresetSize(size));
  presetNote.value = warns.length > 0 ? `${UI.plot.presetEditWarnPrefix}${warns.map((issue) => issue.message).join('；')} —— ${applied}` : applied;

  editorOrigin.value = nextName;
  loadEditor();
  refreshPresets();
  return true;
}

/**
 * 复制粘贴的唯一去处：一个子页面（CopyPasteDialog）。
 *
 * 复制按钮只把内容交给这里，弹窗里点一下目标就完成粘贴，不再需要
 * 「切预设 → 滚到底部 → 挑任务 → 点粘贴」四步。
 *
 * 安全机制（用户 2026-11-09 要求）：
 *   ① 粘之前**先自动保存一次**当前设置 —— 中途出错，磁盘上仍是完整的旧状态；
 *   ② 粘进去的内容只改内存草稿，不落盘；
 *   ③ 因此用户不点面板右上角「保存」就退出，这份粘贴不会保留。
 */
const copyPasteOpen = ref(false);

/** 弹窗里的目标：本地库里每一份已经导入的预设 + 它的所有任务。 */
const pasteTargets = computed(() =>
  draft.presets.map(preset => ({
    name: preset.name,
    tasks: readTaskDrafts(preset.data).map((task, index) => ({
      index,
      name: task.name.trim() || `${UI.plot.editorTask} ${index + 1}`,
    })),
  })),
);

function openCopyPaste(kind: 'block' | 'task', payload: TaskBlockDraft | TaskDraft): void {
  if (kind === 'block') copyBlockToClip(payload as TaskBlockDraft, draft.presetName);
  else copyTaskToClip(payload as TaskDraft, draft.presetName);
  copyPasteOpen.value = true;
}

function pasteTo(presetName: string, taskIndex: number): void {
  const current = readClip();
  const index = draft.presets.findIndex(preset => preset.name === presetName);
  if (!current || index < 0) {
    copyPasteOpen.value = false;
    return;
  }
  const stored = draft.presets[index];
  const tasks = readTaskDrafts(stored.data);

  // 先把要粘的东西算出来：目标不合法就直接收工，别动任何状态
  let newBlock: TaskBlockDraft | null = null;
  let newTask: TaskDraft | null = null;
  let taskLabel = '';
  if (current.kind === 'block' && current.block) {
    const target = tasks[taskIndex];
    if (!target) {
      copyPasteOpen.value = false;
      return;
    }
    taskLabel = target.name.trim() || `${UI.plot.editorTask} ${taskIndex + 1}`;
    // 粘进来的块 id 要在目标任务的现有块里唯一（第 48 次定下的规矩）
    newBlock = adoptBlockDraft(current.block, target.blocks);
    target.blocks.push(newBlock);
  } else if (current.kind === 'task' && current.task) {
    newTask = cloneTaskDraft(current.task, tasks);
    tasks.push(newTask);
  } else {
    copyPasteOpen.value = false;
    return;
  }

  // ① 粘贴之前先存一次盘：磁盘上留一份完整的「粘贴前」状态
  commitPlot();
  markSaved();

  // ② 只改内存草稿 —— 不点「保存」就退出，这份粘贴不会留下
  draft.presets[index] = { ...stored, data: applyTaskDrafts(stored.data, tasks) };

  // ③ 目标正是当前正在编辑的预设：编辑器草稿同步一份，免得点「应用修改」把它盖掉
  if (presetName === editorOrigin.value) {
    if (newBlock && editorTasks.value[taskIndex]) editorTasks.value[taskIndex].blocks.push(klona(newBlock));
    if (newTask) editorTasks.value.push(klona(newTask));
  }

  copyPasteOpen.value = false;
  presetNote.value = newBlock
    ? UI.plot.copyPasteDone(presetName, taskLabel)
    : UI.plot.copyPasteDoneTask(presetName);
}


/** 导出用：当前选中那份预设的数据（不在本地就是 null）。 */
const exportData = computed<Record<string, unknown> | null>(() => editingStored.value?.data ?? null);

/**
 * 导入一份文件/一段粘贴进来的 JSON。
 *
 * 这里用 `keepLocal: false`（同名覆盖），和「从数据库导入」的默认值相反 ——
 * 用户拿着文件点导入，意思是「用这份替换掉我本地的」；而拉数据库那次是
 * 「看看那边有没有新的」，本地改过的不能被静默冲掉。
 */
function onPresetImport(payload: { presets: Record<string, unknown>[]; skipped: number }): void {
  // 「世界书写入」那三项是脚本全局设置、不在预设本体上：导出时把它们塞进了文件，
  // 这里读回来恢复，再从预设本体里摘掉 —— 本地库只存预设自己的数据，
  // 免得以后改了设置、库里那份过期副本又被写回文件。
  // 文件里没带这个键就不动设备上现有的设置（老文件、别处导出的预设都走这条）。
  let restored: PresetWorldbookWrite | null = null;
  for (const preset of payload.presets) {
    const carried = readWorldbookWriteFromPreset(preset);
    if (carried !== null) {
      restored = carried;
      break;
    }
  }
  if (restored !== null) {
    draft.worldbookWriteRules = restored.rules;
    draft.worldbookWriteSource = restored.source;
    draft.worldbookWriteBooks = restored.books;
  }
  const cleanPresets = payload.presets.map(preset => {
    if (preset[WORLD_BOOK_WRITE_KEY] === undefined) return preset;
    const copy = { ...preset };
    delete copy[WORLD_BOOK_WRITE_KEY];
    return copy;
  });
  const merged = mergeStoredPresets(draft.presets, cleanPresets, { keepLocal: false, source: 'paste' });
  draft.presets = merged.presets;
  if (draft.presetName === '' && merged.presets.length > 0) draft.presetName = merged.presets[0].name;
  presetNote.value = UI.plot.ioImported(merged.added, merged.replaced, merged.skipped + payload.skipped);
  // 导入是「一次动一批」，和 `importPresetsFromAcu` 一样要立刻落盘 + 重装编辑器。
  // 少这两步时，同名覆盖只换了内存里的草稿：编辑器还摆着旧任务，面板一关这次导入就没了
  // —— 用户看到的就是「导了新版，里面还是旧版」（2026-11-06 修）。
  commitPlot();
  loadEditor();
  refreshPresets();
}

// ——— 成果存放模式（升级 / qrf） ———

/** 切换模式后的结果提示（搬了几层、几层没搬成）。 */
const modeNote = ref('');

/**
 * 切模式时把已有成果搬过去。
 *
 * 两种模式是互斥的（用户 2026-11-03 定）：升级模式成果在账本里、qrf 模式成果在楼层字段里。
 * 只切开关不搬数据，等于把上一轮的成果丢掉 —— 所以这里必须搬一次，并清掉原来那份。
 */
async function onStashModeChange(): Promise<void> {
  modeNote.value = UI.plot.stashModeBusy;
  try {
    const result = draft.stashMode === 'qrf' ? await migrateStashToQrf(props.ctx) : await migrateQrfToStash(props.ctx);
    modeNote.value = result.note;
  } catch (error) {
    modeNote.value = `迁移失败：${(error as Error)?.message ?? String(error)}`;
  }
}

// ——— API 配置 ———

/** 导入结果的提示语。 */
const apiNote = ref('');

/**
 * 拉取模型列表。
 *
 * 为什么要有这个按钮：模型名手输错了**不会当场报错**，要等真跑一轮才暴露成
 * `503 model_not_found` —— 2026-11-01 就踩过一次，那时填的是服务商文档上的名字，
 * 而它实际登记的 id 前面还带厂商前缀。
 *
 * 候选按 API 名缓存（不是按位置）：重名那条被删掉时不会串行；
 * 改名等于换了对象，缓存失效、重新拉一次即可。
 */
const modelOptions = reactive<Record<string, string[]>>({});
const modelNotes = reactive<Record<string, string>>({});
const pullingModelOf = ref('');

/** 当前在途的模型拉取；切渠道、关面板、超时总预算都靠它掐断（批 42）。 */
let modelsFetchCtl: AbortController | null = null;

async function pullModels(api: PlotApiEntry): Promise<void> {
  if (pullingModelOf.value !== '') return;
  // 在途拉取的闸门（批 42）：切换渠道 / 关闭面板时 abort，30 秒总预算到点也会自动断
  modelsFetchCtl?.abort();
  const ctl = new AbortController();
  modelsFetchCtl = ctl;
  pullingModelOf.value = api.name;
  modelNotes[api.name] = UI.plot.apisPullModelsBusy;
  try {
    const outcome = await fetchModelList({ url: api.url, apiKey: api.apiKey }, undefined, { signal: ctl.signal });
    if (ctl.signal.aborted) {
      // 已被掐断：结果作废，只把那一条的忙态文案收尾（别的渠道不受影响）
      modelOptions[api.name] = [];
      modelNotes[api.name] = UI.plot.apisPullModelsCancelled;
      return;
    }
    if (outcome.ok) {
      modelOptions[api.name] = outcome.models;
      // 只有一个候选时直接填上：这种情况下让用户再点一次毫无意义
      if (api.model.trim() === '' && outcome.models.length === 1) api.model = outcome.models[0];
      modelNotes[api.name] = UI.plot.apisPullModelsOk(outcome.models.length);
    } else {
      modelOptions[api.name] = [];
      modelNotes[api.name] = UI.plot.apisPullModelsFailed(outcome.reason);
    }
  } finally {
    if (modelsFetchCtl === ctl) modelsFetchCtl = null;
    pullingModelOf.value = '';
  }
}

/** 从「模型列表」下拉里挑一条：直接写回这条 API 的模型名。 */
function pickModel(api: PlotApiEntry, event: Event): void {
  const target = event.target as HTMLSelectElement | null;
  const value = target === null ? '' : target.value;
  if (value === '') return;
  api.model = value;
}

function importFromAcu(): void {
  const outcome = readAcuApiPresets();
  if (!outcome.ok) {
    apiNote.value = `导入失败：${describeAcuApiProblem(outcome)}`;
    return;
  }

  const merged = mergePlotApis(draft.apis, outcome.presets);
  draft.apis = merged.apis;

  // 一条都没有指定过「用哪条」时，顺手把第一条选上，省得用户还要多点一下
  if (draft.activeApiName === '' && merged.apis.length > 0) {
    draft.activeApiName = merged.apis[0].name;
  }
  ensureDraftApi();

  const parts = [`新增 ${merged.added} 条`];
  if (merged.kept > 0) parts.push(`${merged.kept} 条重名已保留你原来的版本`);
  if (outcome.skipped > 0) parts.push(`${outcome.skipped} 条没名字或重名被跳过`);
  apiNote.value = `导入完成：${parts.join('，')}。`;
  // 同上：导完立刻落盘，切页/关面板都不会白导
  commitPlot();
}

/** 手动新增一条空白配置：名字先给个不重复的，免得一进来就因重名被拦。 */
function addApi(): void {
  const base = '新 API';
  let name = base;
  let ordinal = 2;
  while (draft.apis.some((api) => api.name === name)) {
    name = `${base} ${ordinal}`;
    ordinal += 1;
  }
  draft.apis.push({
    name,
    apiMode: 'custom',
    url: '',
    apiKey: '',
    model: '',
    source: '',
    maxTokens: DEFAULT_MAX_TOKENS,
    temperature: 1,
    importedFrom: '',
    bodyParams: '',
    excludeBodyParams: '',
    promptPostProcessing: 'follow',
  });
  apiNote.value = '';
  // 新建完直接切到它：否则用户点了「+」还要自己在下拉里找一遍
  draftApiName.value = name;
}

/**
 * 一键写入 DeepSeek 推荐参数。
 *
 * 为什么分两个按钮而不是一个「全部打开」：严格 JSON 会强制模型输出 JSON，
 * 而我们的任务产物是 `<标签>…</标签>` 的纯文本 —— 开了它反而抓不到标签。
 * 关思考则只有好处。所以默认只给「关思考」，严格 JSON 让用户自己决定。
 */
function applyDeepSeek(api: PlotApiEntry, strictJson: boolean): void {
  const result = buildDeepSeekTemplate(api.bodyParams, api.excludeBodyParams, { cot: false, strictJson });
  if (!result.ok) {
    apiNote.value = result.error;
    return;
  }
  api.bodyParams = result.bodyParams;
  api.excludeBodyParams = result.excludeBodyParams;
  apiNote.value = strictJson ? UI.plot.apisDeepSeekJsonDone : UI.plot.apisDeepSeekCotDone;
}

function dropApi(name: string): void {
  // 删之前问一句。填一条 API 要填地址、钥匙、模型好几格，误点一下全没了。
  // 用父窗口的 confirm —— iframe 自己那个在部分浏览器里会被拦。
  const ask = (window.parent as { confirm?: (text: string) => boolean }).confirm;
  const label = name === '' ? '这一条' : `「${name}」`;
  if (typeof ask === 'function' && !ask(`删掉${label}？删掉就没了，要重新填。`)) return;
  draft.apis = draft.apis.filter((api) => api.name !== name);
  // 删掉的正好是当前在用的那条：退回「跟随酒馆」，免得指向一个已经不存在的东西
  if (draft.activeApiName === name) draft.activeApiName = '';
  // 正在看的那条被删了就换一条，否则编辑区会空着、像卡死了
  if (draftApiName.value === name) {
    draftApiName.value = '';
    ensureDraftApi();
  }
}

/** 当前在用的那条（没有就返回 undefined）。 */
const activeApi = computed(() => draft.apis.find((api) => api.name === draft.activeApiName));

/**
 * 下拉里「正在看」的那条。
 *
 * 与 `activeApiName` 分开是用户明确要求的（2026-11-04）：下拉里翻看别的 API
 * 只是为了改它，不该顺手把默认也换掉 —— 那样"改一下再改回来"就把默认改丢了。
 * 只有点星星才动 `activeApiName`。
 */
const draftApiName = ref('');

const editingApi = computed(() => draft.apis.find((api) => api.name === draftApiName.value));

// ── 在途拉取的自动掐断（批 42 用户定）──
// 切换正在查看的渠道、切换「当前 API」、面板关闭：三条路上挂着的那次拉取立刻放弃，
// 不许它占着忙态让别的渠道拉不了。onUnmounted 由 vue 自动导入。
watch(draftApiName, () => modelsFetchCtl?.abort());
watch(
  () => draft.activeApiName,
  () => modelsFetchCtl?.abort(),
);
onUnmounted(() => modelsFetchCtl?.abort());

/** 保证「正在看」的那条仍然存在：导入、删除、改名之后都要过一遍。 */
function ensureDraftApi(): void {
  if (draft.apis.length === 0) {
    draftApiName.value = '';
    return;
  }
  if (draft.apis.some((api) => api.name === draftApiName.value)) return;
  const active = draft.apis.find((api) => api.name === draft.activeApiName);
  draftApiName.value = active ? active.name : draft.apis[0].name;
}

/** 点星星：把这一条设成默认（列表里直接点，不再另放一个按钮）。 */
function makeDefaultApi(api: PlotApiEntry): void {
  if (!api) return;
  draft.activeApiName = api.name;
  apiNote.value = UI.plot.apisSetDefaultOk(api.name);
}

/** 下拉面板开没开。 */
const apiOpen = ref(false);

/** 点名字：只是「翻看这一条」，不动默认。 */
function pickApi(name: string): void {
  draftApiName.value = name;
  apiOpen.value = false;
}

watch(() => draft.apis.length, ensureDraftApi, { immediate: true });


// ——— 「预览这次会发什么」 ———
//
// 为什么要有：面板上列的是模板（`$8` 等占位符原样写着），用户看不出
// 「这一按下去 AI 到底读到什么」。这里拿真数据跑一遍同一套渲染，把结果摊开给他看。
// 只读：不写设置、不碰暂存、不发请求。
const previewOpen = ref(false);
const previewBusy = ref(false);
const previewError = ref('');
const previewData = ref<PlotPreview | null>(null);
const previewTaskIndex = ref(0);

/** 读酒馆输入框里现在那段字 —— 它会进 `$8`，也决定世界书命中哪些条目。 */
function readSendText(): string {
  const $area = pageQuery()('#send_textarea');
  return $area.length > 0 ? String($area.val() ?? '') : '';
}

async function openPreview(): Promise<void> {
  previewOpen.value = true;
  previewBusy.value = true;
  previewError.value = '';
  previewData.value = null;
  previewTaskIndex.value = 0;
  try {
    const result = await previewPlotRound(props.ctx, readSendText());
    if (!result.ok) {
      previewError.value = result.note;
      return;
    }
    previewData.value = result.preview;
  } catch (error) {
    previewError.value = `预览失败：${error instanceof Error ? error.message : String(error)}`;
    console.warn('[剧情推进助手] 预览这次会发什么失败', error);
  } finally {
    previewBusy.value = false;
  }
}

const previewTask = computed(() => {
  const data = previewData.value;
  if (!data || data.tasks.length === 0) return null;
  const index = Math.min(Math.max(previewTaskIndex.value, 0), data.tasks.length - 1);
  return data.tasks[index] ?? null;
});

/** 重命名时防止重名（两个同名的条目在「用哪条」这事上没法区分）。 */
function renameApi(api: PlotApiEntry, value: string): void {
  const next = value.trim();
  const duplicate = draft.apis.some((item) => item !== api && item.name === next);
  if (duplicate) return;
  const wasActive = draft.activeApiName === api.name;
  const wasEditing = draftApiName.value === api.name;
  api.name = next;
  if (wasActive) draft.activeApiName = next;
  if (wasEditing) draftApiName.value = next;
}

/** 密钥展示打码：面板截屏、录屏时不至于把密钥漏出去。 */
function keyMask(key: string): string {
  return maskApiKey(key);
}
</script>

<template>
  <div class="rh-plot">
    <div class="acu-page-tabs">
      <button
        v-for="tab in pageTabs"
        :key="tab.id"
        type="button"
        class="acu-page-tab"
        :class="{ active: page === tab.id }"
        @click="goToPage(tab.id)"
      >
        <span class="acu-page-tab__full">{{ tab.label }}</span>
        <span class="acu-page-tab__short">{{ tab.short }}</span>
      </button>
    </div>

    <!-- ① API：总开关 + API 条目 + 超时 -->
    <div v-show="page === 1" class="acu-page">
      <div class="acu-section">
        <h4>{{ UI.plot.enableLabel }}</h4>
        <div class="acu-row">
          <label class="acu-toggle">
            <input v-model="draft.enabled" type="checkbox" class="acu-toggle__input" :aria-label="UI.plot.enableLabel" />
            <span class="acu-toggle__track" aria-hidden="true" />
            <span class="acu-toggle__label">{{ UI.plot.enableLabel }}</span>
          </label>
        </div>
        <p class="acu-notes">{{ UI.plot.enableHint }}</p>
        <p v-if="!draft.enabled" class="acu-notes" style="color: var(--acu-warning)">{{ UI.plot.enableHintOff }}</p>

        <div class="acu-row" style="margin-top: 10px">
          <label class="acu-toggle">
            <input
              v-model="draft.sendDisguiseDisabled"
              type="checkbox"
              class="acu-toggle__input"
              :aria-label="UI.plot.disguiseLabel"
            />
            <span class="acu-toggle__track" aria-hidden="true" />
            <span class="acu-toggle__label">{{ UI.plot.disguiseLabel }}</span>
          </label>
        </div>
        <p class="acu-notes">{{ UI.plot.disguiseHint }}</p>

        <!--
          成果存哪：两种模式互斥。切一次就搬一次，不搬等于把上一轮成果丢掉。
        -->
        <h4 style="margin-top: 14px">{{ UI.plot.stashModeLabel }}</h4>
        <div class="acu-row acu-row--inline">
          <label class="acu-toggle">
            <input v-model="draft.stashMode" type="radio" value="upgrade" @change="onStashModeChange" />
            <span class="acu-toggle__label">{{ UI.plot.stashModeUpgrade }}</span>
          </label>
          <label class="acu-toggle">
            <input v-model="draft.stashMode" type="radio" value="qrf" @change="onStashModeChange" />
            <span class="acu-toggle__label">{{ UI.plot.stashModeQrf }}</span>
          </label>
        </div>
        <p class="acu-notes">
          {{ draft.stashMode === 'qrf' ? UI.plot.stashModeQrfHint : UI.plot.stashModeUpgradeHint }}
        </p>
        <p v-if="modeNote !== ''" class="acu-notes" style="color: var(--acu-accent-2)">{{ modeNote }}</p>
      </div>

      <div class="acu-section">
        <h4>{{ UI.plot.apisTitle }}</h4>
        <p class="acu-notes">{{ UI.plot.apisHint }}</p>
        <p v-if="apiNote !== ''" class="acu-notes">{{ apiNote }}</p>

        <div class="acu-row">
          <button class="acu-btn acu-btn--sm" type="button" @click="importFromAcu">{{ UI.plot.apisImport }}</button>
          <button class="acu-btn acu-btn--sm" type="button" @click="addApi">{{ UI.plot.apisAdd }}</button>
        </div>
        <p class="acu-notes acu-notes--sm">{{ UI.plot.apisImportHint }}</p>

        <p v-if="draft.apis.length === 0" class="acu-notes" style="color: var(--acu-warning)">{{ UI.plot.apisEmpty }}</p>

        <!--
          一条一条摊开太占地方：改成「先选一条，下面只显示这一条」，
          和工作流助手的 API 预设区块同一个形状。
        -->
        <div class="acu-row acu-row--inline">
          <label class="rh-field-label" style="flex: 0 0 auto">{{ UI.plot.apisCurrent }}</label>
          <!--
            下拉自己画：原生 <select> 的选项里放不了按钮，星星只能另摆一个 ——
            用户要的是「列表里每条右边一颗星」，点名字只是翻看，点星才设默认。
          -->
          <div class="rh-api-pick">
            <button class="acu-select rh-api-pick__trigger" type="button" @click="apiOpen = !apiOpen">
              <span class="rh-api-pick__name">{{ editingApi === undefined ? UI.plot.apisNoneOption : editingApi.name }}</span>
              <span class="rh-api-pick__caret" aria-hidden="true">▾</span>
            </button>
            <div v-if="apiOpen" class="rh-api-backdrop" @click="apiOpen = false"></div>
            <div v-if="apiOpen" class="rh-api-menu">
              <div v-for="api in draft.apis" :key="api.name" class="rh-api-item">
                <button class="rh-api-item__name" :class="{ 'is-editing': api.name === draftApiName }" type="button" @click="pickApi(api.name)">
                  {{ api.name }}
                </button>
                <button
                  class="rh-api-item__star"
                  :class="{ 'is-default': api.name === draft.activeApiName }"
                  type="button"
                  :title="UI.plot.apisSetDefault"
                  :aria-label="UI.plot.apisSetDefault"
                  @click="makeDefaultApi(api)"
                >
                  ★
                </button>
              </div>
              <p v-if="draft.apis.length === 0" class="acu-notes acu-notes--sm">{{ UI.plot.apisEmpty }}</p>
            </div>
          </div>
          <button class="acu-btn acu-btn--sm" type="button" :title="UI.plot.apisAdd" @click="addApi">+</button>
          <button
            class="acu-btn danger acu-btn--sm"
            type="button"
            :title="UI.plot.apisDelete"
            :disabled="editingApi === undefined"
            @click="dropApi(draftApiName)"
          >
            ✕
          </button>
        </div>
        <p class="acu-notes acu-notes--sm">{{ UI.plot.apisPickHint }}</p>

        <template v-for="api in draft.apis" :key="api.name">
          <div v-if="api.name === draftApiName" class="acu-section" style="background: var(--acu-bg-2)">
          <!-- 下面只渲染下拉里选中的那一条（v-show 控制），这里就只有它自己的字段。 -->
          <div class="acu-row">
            <label style="flex: 0 0 72px">{{ UI.plot.apisName }}</label>
            <input
              class="acu-input"
              type="text"
              :value="api.name"
              :placeholder="UI.plot.apisName"
              style="flex: 1 1 auto; min-width: 0"
              @change="renameApi(api, ($event.target as HTMLInputElement).value)"
            />
          </div>
          <p class="acu-notes acu-notes--sm">
            {{ api.apiMode === 'custom' ? UI.plot.apisModeCustom : UI.plot.apisModeTavern }}
            <template v-if="api.model !== ''">· {{ api.model }}</template>
          </p>

          <div class="acu-row">
            <label>
              <input v-model="api.apiMode" type="radio" value="custom" />
              {{ UI.plot.apisModeCustom }}
            </label>
            <label>
              <input v-model="api.apiMode" type="radio" value="tavern" />
              {{ UI.plot.apisModeTavern }}
            </label>
          </div>

          <template v-if="api.apiMode === 'custom'">
            <div class="acu-row">
              <label style="flex: 0 0 72px">{{ UI.plot.apisUrl }}</label>
              <input v-model="api.url" class="acu-input" type="text" placeholder="https://..." style="flex: 1 1 auto; min-width: 0" />
            </div>
            <div class="acu-row">
              <label style="flex: 0 0 72px">{{ UI.plot.apisKey }}</label>
              <input v-model="api.apiKey" class="acu-input" type="text" :placeholder="keyMask(api.apiKey) || 'sk-...'" style="flex: 1 1 auto; min-width: 0" />
            </div>
          </template>

          <div class="acu-row">
            <label style="flex: 0 0 72px">{{ UI.plot.apisModel }}</label>
            <input v-model="api.model" class="acu-input" type="text" placeholder="模型名" style="flex: 1 1 auto; min-width: 0" />
            <button
              v-if="api.apiMode === 'custom'"
              class="acu-btn acu-btn--sm"
              type="button"
              :disabled="pullingModelOf !== ''"
              @click="pullModels(api)"
            >
              {{ pullingModelOf === api.name ? UI.plot.apisPullModelsBusy : UI.plot.apisPullModels }}
            </button>
          </div>
          <!-- 拉取到的模型单独占一行：以前是挂在输入框上的 datalist，手机点输入框
               根本不弹下拉（没有下三角、点了也不出列表），等于白拉。 -->
          <div v-if="(modelOptions[api.name] ?? []).length > 0" class="acu-row">
            <label style="flex: 0 0 72px">{{ UI.plot.apisModelPick }}</label>
            <select
              class="acu-input"
              style="flex: 1 1 auto; min-width: 0"
              :value="api.model"
              @change="pickModel(api, $event)"
            >
              <option value="">{{ UI.plot.apisModelPickHint }}</option>
              <option v-for="model in modelOptions[api.name] ?? []" :key="model" :value="model">{{ model }}</option>
            </select>
          </div>
          <p v-if="modelNotes[api.name]" class="acu-notes acu-notes--sm">{{ modelNotes[api.name] }}</p>

          <div class="acu-row">
            <label>{{ UI.plot.apisMaxTokens }}</label>
            <input v-model.number="api.maxTokens" class="acu-input" type="number" min="0" style="width: 96px" />
            <label>{{ UI.plot.apisTemperature }}</label>
            <input v-model.number="api.temperature" class="acu-input" type="number" step="0.1" style="width: 88px" />
          </div>

          <!-- 附加请求体参数：与数据库脚本 / 工作流助手同一件事，只是换了个地方存 -->
          <template v-if="api.apiMode === 'custom'">
            <div class="acu-row acu-api-body__head">
              <label style="flex: 0 0 96px">{{ UI.plot.apisBodyParams }}</label>
            </div>
            <textarea
              v-model="api.bodyParams"
              class="acu-textarea acu-api-body__text"
              rows="4"
              spellcheck="false"
              :placeholder="UI.plot.apisBodyParamsHint"
            ></textarea>
            <div class="acu-row">
              <label style="flex: 0 0 96px">{{ UI.plot.apisExcludeParams }}</label>
              <input
                v-model="api.excludeBodyParams"
                class="acu-input"
                type="text"
                :placeholder="UI.plot.apisExcludeParamsHint"
                style="flex: 1 1 auto; min-width: 0"
              />
            </div>
            <div class="acu-row">
              <label style="flex: 0 0 96px">{{ UI.plot.apisRequestHeaders }}</label>
            </div>
            <textarea
              v-model="api.requestHeaders"
              class="acu-textarea"
              rows="2"
              spellcheck="false"
              :placeholder="UI.plot.apisRequestHeadersHint"
            ></textarea>
            <p
              v-if="api.bodyParams.trim() !== '' && api.requestHeaders.trim() !== ''"
              class="acu-notes acu-notes--sm"
            >
              {{ UI.plot.apisExtrasWarn }}
            </p>
            <div class="acu-row">
              <button class="acu-btn acu-btn--sm" type="button" @click="applyDeepSeek(api, false)">
                {{ UI.plot.apisDeepSeekCot }}
              </button>
              <button class="acu-btn acu-btn--sm" type="button" @click="applyDeepSeek(api, true)">
                {{ UI.plot.apisDeepSeekJson }}
              </button>
            </div>
            <p class="acu-notes acu-notes--sm">{{ UI.plot.apisBodyNote }}</p>
          </template>

          <!-- 接口协议：直接存成酒馆认的 chat_completion_source，不再经过一层换算 -->
          <div class="acu-row">
            <label style="flex: 0 0 96px">{{ UI.plot.apisSource }}</label>
            <select v-model="api.source" class="acu-select" style="flex: 1 1 auto; min-width: 0">
              <option value="custom">{{ UI.plot.apisSourceCustom }}</option>
              <option value="openai">{{ UI.plot.apisSourceOpenai }}</option>
              <option value="claude">{{ UI.plot.apisSourceClaude }}</option>
              <option value="makersuite">{{ UI.plot.apisSourceGemini }}</option>
            </select>
          </div>
          <p class="acu-notes acu-notes--sm">{{ UI.plot.apisSourceHint }}</p>

          <!-- 提示词后处理：对自定义与跟随酒馆两种模式都成立（它借的是酒馆那一格） -->
          <div class="acu-row">
            <label style="flex: 0 0 96px">{{ UI.plot.apisPostProcess }}</label>
            <select v-model="api.promptPostProcessing" class="acu-select" style="flex: 1 1 auto; min-width: 0">
              <option value="follow">{{ UI.plot.apisPostProcessFollow }}</option>
              <option value="">{{ UI.plot.apisPostProcessNone }}</option>
              <option value="merge_tools">{{ UI.plot.apisPostProcessMergeTools }}</option>
              <option value="semi">{{ UI.plot.apisPostProcessSemi }}</option>
              <option value="strict">{{ UI.plot.apisPostProcessStrict }}</option>
              <option value="single">{{ UI.plot.apisPostProcessSingle }}</option>
            </select>
          </div>
          <p class="acu-notes acu-notes--sm">{{ UI.plot.apisPostProcessHint }}</p>

          <p v-if="api.importedFrom !== ''" class="acu-notes acu-notes--sm">{{ UI.plot.apisImportedFrom(api.importedFrom) }}</p>
        </div>
        </template>

        <p v-if="activeApi === undefined" class="acu-notes" style="color: var(--acu-warning)">{{ UI.plot.apisNoActive }}</p>

        <div class="acu-row">
          <label style="flex: 0 0 96px">{{ UI.plot.apisTimeout }}</label>
          <input v-model.number="draft.requestTimeoutSeconds" class="acu-input" type="number" min="0" style="width: 88px" />
        </div>
        <p class="acu-notes acu-notes--sm">{{ UI.plot.apisTimeoutHint }}</p>
        <p class="acu-notes acu-notes--sm">{{ UI.plot.apisKeyHint }}</p>
      </div>
    </div>

    <!-- ② 上下文：取多少条前文 + 标签筛选 -->
    <div v-show="page === 2" class="acu-page">
      <!--
        世界书（`$1`）：照工作流助手放在这一页的最上面。
        默认跟角色卡绑定的书走；要拿没绑到卡上的全局设定书，就切成手动勾选。
      -->
      <div class="acu-section">
        <h4>{{ UI.plot.worldbookSection }}</h4>
        <p class="acu-notes">{{ UI.plot.worldbookHint }}</p>
        <div class="acu-row acu-row--inline">
          <label class="acu-toggle">
            <input v-model="draft.worldbookSource" type="radio" value="character" />
            <span class="acu-toggle__label">{{ UI.plot.worldbookFollow }}</span>
          </label>
          <label class="acu-toggle">
            <input v-model="draft.worldbookSource" type="radio" value="manual" />
            <span class="acu-toggle__label">{{ UI.plot.worldbookManual }}</span>
          </label>
          <button class="acu-btn acu-btn--sm" type="button" :disabled="wbLoading" @click="loadWorldbooks">
            {{ wbLoading ? UI.plot.worldbookLoading : UI.plot.worldbookRefresh }}
          </button>
        </div>
        <p v-if="wbError !== ''" class="acu-notes acu-notes--warn">{{ wbError }}</p>

        <!--
          条目级勾选：照工作流助手那个显示框做的 —— 列出当前会读的那几本书里的条目，
          条目多了在框里滚动。取消勾选的条目不进 $1，世界书本身不动。
        -->
        <div class="acu-wb-entries">
          <div class="acu-row acu-row--inline">
            <span class="acu-toggle__label">{{ UI.plot.worldbookEntrySection }}</span>
            <button class="acu-btn acu-btn--sm" type="button" :disabled="wbEntryLoading" @click="loadWorldbookEntries">
              {{ wbEntryLoading ? UI.plot.worldbookEntryLoading : UI.plot.worldbookEntryLoad }}
            </button>
            <input
              v-model="wbEntryQuery"
              class="acu-input"
              type="search"
              :placeholder="UI.plot.worldbookEntrySearch"
              style="flex: 1 1 auto; min-width: 0"
            />
          </div>
          <p class="acu-notes acu-notes--sm">{{ UI.plot.worldbookEntryHint }}</p>
          <p v-if="wbEntryError !== ''" class="acu-notes acu-notes--warn">{{ wbEntryError }}</p>
          <p v-else-if="wbShownBooks.length === 0" class="acu-notes acu-notes--warn">{{ UI.plot.worldbookEntryEmpty }}</p>
          <div v-else class="acu-wb-entry-box">
            <div v-for="book in wbShownBooks" :key="book.name" class="acu-wb-entry-book">
              <div class="acu-wb-entry-head">
                <span class="acu-wb-entry-name" :title="book.name">{{ book.name }}</span>
                <span v-if="book.tag !== ''" class="acu-wb-entry-tag">{{ book.tag }}</span>
                <span class="acu-notes acu-notes--sm" style="margin: 0">
                  {{ UI.plot.worldbookEntryCount(entryOnCount(book.name), (wbEntryRows[book.name] || []).length) }}
                </span>
                <button class="acu-btn acu-btn--sm" type="button" @click="setAllEntries(book.name, true)">
                  {{ UI.plot.worldbookEntryAll }}
                </button>
                <button class="acu-btn acu-btn--sm" type="button" @click="setAllEntries(book.name, false)">
                  {{ UI.plot.worldbookEntryNone }}
                </button>
              </div>
              <p v-if="entryRowsOf(book.name).length === 0" class="acu-notes acu-notes--sm">
                {{ UI.plot.worldbookEntryNoMatch }}
              </p>
              <label
                v-for="row in entryRowsOf(book.name)"
                :key="book.name + ':' + row.uid"
                class="acu-toggle acu-wb-entry-item"
                :class="{ 'acu-wb-entry-item--off': row.blocked }"
              >
                <input
                  type="checkbox"
                  :checked="!row.blocked && isEntryOn(book.name, row.uid)"
                  :disabled="row.blocked"
                  @change="onEntryToggle(book.name, row.uid, $event)"
                />
                <span class="acu-toggle__label">{{ row.label }}</span>
                <span v-if="row.db" class="acu-wb-entry-tag">{{ UI.plot.worldbookEntryDbTag }}</span>
                <span v-if="row.blocked" class="acu-wb-entry-tag">{{ UI.plot.worldbookEntryBlockedTag }}</span>
              </label>
            </div>
          </div>
          <p class="acu-notes acu-notes--sm">{{ UI.plot.worldbookEntryBlockedHint }}</p>
        </div>

        <template v-if="draft.worldbookSource === 'manual'">
          <p class="acu-notes acu-notes--sm">{{ UI.plot.worldbookPickHint }}</p>
          <p v-if="wbBooks.length === 0 && !wbLoading" class="acu-notes acu-notes--warn">{{ UI.plot.worldbookEmpty }}</p>
          <template v-else>
            <div class="acu-row">
              <input
                v-model="wbQuery"
                class="acu-input"
                type="search"
                :placeholder="UI.plot.worldbookSearch"
                style="flex: 1 1 auto; min-width: 0"
              />
              <span class="acu-notes acu-notes--sm" style="margin: 0">
                {{ UI.plot.worldbookCount(filteredBooks.length, wbBooks.length) }}
              </span>
            </div>
            <p v-if="filteredBooks.length === 0" class="acu-notes acu-notes--sm">{{ UI.plot.worldbookNoMatch }}</p>
          </template>
          <div v-if="filteredBooks.length > 0" class="acu-wb-list">
            <label v-for="name in filteredBooks" :key="name" class="acu-toggle acu-wb-item">
              <input
                type="checkbox"
                :checked="draft.worldbookBooks.includes(name)"
                @change="toggleWorldbook(name)"
              />
              <span class="acu-toggle__label">{{ name }}</span>
            </label>
          </div>
        </template>
      </div>

      <!--
        世界书写入（2026-11-07 批 36-38）：把规则选中的标签块写成世界书条目。
        与上面「世界书（$1）」是读与写两件事 —— 那块管任务提示词读哪几本书，
        这一块管把成果写进哪本书。字段（worldbookWrite*）与控件都分开摆。
      -->
      <div class="acu-section">
        <h4>{{ UI.plot.wbWriteSection }}</h4>
        <p class="acu-notes">{{ UI.plot.wbWriteHint }}</p>

        <div class="acu-row acu-row--inline">
          <span class="acu-toggle__label">{{ UI.plot.wbWriteSource }}</span>
          <label class="acu-toggle">
            <input v-model="draft.worldbookWriteSource" type="radio" value="character" />
            <span class="acu-toggle__label">{{ UI.plot.wbWriteFollow }}</span>
          </label>
          <label class="acu-toggle">
            <input v-model="draft.worldbookWriteSource" type="radio" value="manual" />
            <span class="acu-toggle__label">{{ UI.plot.wbWriteManual }}</span>
          </label>
        </div>
        <p class="acu-notes acu-notes--sm">
          {{ draft.worldbookWriteSource === 'manual' ? UI.plot.wbWriteManualHint : UI.plot.wbWriteFollowHint }}
        </p>

        <!-- 手动选书：与读侧那格同一个书架（wbBooks），搜索词分开，互不打扰 -->
        <template v-if="draft.worldbookWriteSource === 'manual'">
          <p class="acu-notes acu-notes--sm">{{ UI.plot.wbWritePickHint }}</p>
          <p v-if="wbBooks.length === 0 && !wbLoading" class="acu-notes acu-notes--warn">{{ UI.plot.worldbookEmpty }}</p>
          <template v-else>
            <div class="acu-row">
              <input
                v-model="wbWriteQuery"
                class="acu-input"
                type="search"
                :placeholder="UI.plot.wbWriteSearch"
                style="flex: 1 1 auto; min-width: 0"
              />
              <span class="acu-notes acu-notes--sm" style="margin: 0">
                {{ UI.plot.worldbookCount(filteredWriteBooks.length, wbBooks.length) }}
              </span>
            </div>
            <p v-if="filteredWriteBooks.length === 0" class="acu-notes acu-notes--sm">{{ UI.plot.worldbookNoMatch }}</p>
            <div v-else class="acu-wb-list">
              <label v-for="name in filteredWriteBooks" :key="'wbw-book-' + name" class="acu-toggle acu-wb-item">
                <input
                  type="checkbox"
                  :checked="draft.worldbookWriteBooks.includes(name)"
                  @change="toggleWbWriteBook(name)"
                />
                <span class="acu-toggle__label">{{ name }}</span>
              </label>
            </div>
          </template>
        </template>

        <div class="acu-row acu-row--inline">
          <span class="acu-toggle__label">{{ UI.plot.wbWriteRuleSection }}</span>
          <button
            class="acu-btn acu-btn--sm"
            type="button"
            :disabled="wbWriteTagOptions.length === 0"
            @click="addWbWriteRule"
          >
            {{ UI.plot.wbWriteAdd }}
          </button>
        </div>
        <p class="acu-notes acu-notes--sm">{{ UI.plot.wbWriteRuleHint }}</p>
        <p v-if="wbWriteTagOptions.length === 0" class="acu-notes acu-notes--warn">{{ UI.plot.wbWriteNoTags }}</p>
        <div
          v-for="(rule, index) in draft.worldbookWriteRules"
          :key="'wbw-rule-' + index"
          class="acu-row acu-row--inline"
        >
          <label class="acu-toggle">
            <input v-model="rule.enabled" type="checkbox" />
            <span class="acu-toggle__label">{{ UI.plot.wbWriteEnabled }}</span>
          </label>
          <select v-model="rule.tagName" class="acu-select" style="flex: 0 1 160px; min-width: 0">
            <option v-for="name in wbWriteTagOptions" :key="name" :value="name">{{ name }}</option>
            <!-- 预设换了之后规则里可能留着旧标签名：补一个选项，别让下拉显示成空白 -->
            <option v-if="!wbWriteTagOptions.includes(rule.tagName)" :value="rule.tagName">{{ rule.tagName }}</option>
          </select>
          <input
            v-model="rule.entryName"
            class="acu-input"
            type="text"
            :placeholder="UI.plot.wbWriteEntryNamePlaceholder(rule.tagName)"
            style="flex: 1 1 140px; min-width: 0"
          />
          <input v-model.number="rule.depth" class="acu-input" type="number" min="1" style="width: 64px" :title="UI.plot.wbWriteDepthHint" />
          <input v-model.number="rule.order" class="acu-input" type="number" min="0" style="width: 84px" :title="UI.plot.wbWriteOrderHint" />
          <button class="acu-btn acu-btn--sm" type="button" @click="removeWbWriteRule(index)">
            {{ UI.plot.wbWriteRemove }}
          </button>
        </div>
        <p v-if="draft.worldbookWriteRules.length > 0" class="acu-notes acu-notes--sm">
          {{ UI.plot.wbWriteDepthHint }}{{ UI.plot.wbWriteOrderHint }}
        </p>

        <!-- 两个清理按钮（批 36 用户定）：范围与认领口径刻意不同，见 wbWriteCleanHint -->
        <div class="acu-row acu-row--inline">
          <button
            class="acu-btn acu-btn--sm"
            type="button"
            :disabled="wbWriteCleaning !== null"
            @click="runWbCleanup('current')"
          >
            {{ UI.plot.wbWriteCleanCurrent }}
          </button>
          <button
            class="acu-btn acu-btn--sm"
            type="button"
            :disabled="wbWriteCleaning !== null"
            @click="runWbCleanup('all')"
          >
            {{ UI.plot.wbWriteCleanAll }}
          </button>
        </div>
        <p class="acu-notes acu-notes--sm">{{ UI.plot.wbWriteCleanHint }}</p>
      </div>

      <!--
        `$7 默认上下文`：有预设就改预设里的（预设覆盖全局），没预设就改全局兜底 ——
        没导入预设也能设，这一块不再整块消失、只剩一个标题。
      -->
      <TagRuleEditor
        :turn-count="editorDraft !== null ? editorDraft.meta.contextTurnCount : draft.contextDefaults.turnCount"
        :extract-rules="editorDraft !== null ? editorDraft.extractRules : draft.contextDefaults.extractRules"
        :exclude-rules="editorDraft !== null ? editorDraft.excludeRules : draft.contextDefaults.excludeRules"
        @update:turn-count="setContextTurnCount"
      />
    </div>

    <!-- ③ 任务：预设（顶部下拉 + 一排动作按钮）→ 预设本体 → 任务表 -->
    <div v-show="page === 3" class="acu-page">
      <div class="acu-section acu-preset-section">
        <h4>{{ UI.plot.presetLabel }}</h4>
        <p class="acu-notes">{{ UI.plot.presetHint }}</p>

        <div class="acu-row acu-preset-toolbar">
          <select v-model="draft.presetName" class="acu-select acu-preset-select">
            <option value="">{{ UI.plot.presetNone }}</option>
            <option v-for="name in presetNames" :key="name" :value="name">{{ name }}</option>
          </select>
          <PresetIo
            :current="draft.presetName"
            :can-export="exportData !== null"
            :can-delete="editingStored !== undefined"
            :export-text="exportText"
            :export-name="exportName"
            @import="onPresetImport"
            @create="createPreset"
            @duplicate="duplicatePreset"
            @remove="removeCurrentPreset"
            @refresh="refreshPresets"
          />
        </div>

        <p v-if="presetProblem !== ''" class="acu-notes" style="color: var(--acu-warning)">
          {{ UI.plot.presetProblemPrefix }}{{ presetProblem }}
        </p>
        <p v-else-if="presetNames.length === 0" class="acu-notes" style="color: var(--acu-warning)">{{ UI.plot.presetEmpty }}</p>
        <p v-else-if="presetCurrent !== ''" class="acu-notes acu-notes--sm">{{ UI.plot.presetAcuUsing(presetCurrent) }}</p>

        <!-- 预览按钮放在「最终注入指令」这张编辑器上面的同一段：
             用户改完指令最想知道的就是「这样改完 AI 会读到什么」。 -->
        <div class="acu-row">
          <button class="acu-btn acu-btn--sm" type="button" @click="openPreview">{{ UI.plot.previewOpen }}</button>
          <span class="acu-notes acu-notes--sm" style="margin: 0">{{ UI.plot.previewOpenHint }}</span>
        </div>

        <div class="acu-row">
          <button class="acu-btn acu-btn--sm" type="button" @click="importPresetsFromAcu">{{ UI.plot.presetImportAll }}</button>
          <span class="acu-notes acu-notes--sm" style="margin: 0">{{ UI.plot.presetStoreHint }}</span>
        </div>
        <p v-if="draft.presets.length === 0" class="acu-notes acu-notes--sm">{{ UI.plot.presetStoreEmpty }}</p>
        <p v-else-if="editingStored" class="acu-notes acu-notes--sm">{{ presetSizeText(editingStored) }}</p>
        <p v-else-if="draft.presetName !== ''" class="acu-notes" style="color: var(--acu-warning)">{{ UI.plot.presetEditNotLocal }}</p>

        <p v-if="presetNote !== ''" class="acu-notes">{{ presetNote }}</p>
      </div>

      <template v-if="editorDraft !== null">
        <PresetEditor :draft="editorDraft" :tasks="editorTasks" />
        <TaskEditor
          :tasks="editorTasks"
          :preset-name="draft.presetName"
          :api-names="draft.apis.map((api) => api.name)"
          @copy-task="openCopyPaste('task', $event)"
          @copy-block="openCopyPaste('block', $event)"
        />
        <p class="acu-notes acu-notes--sm">{{ UI.plot.presetEditIntro }}</p>
      </template>

      <p class="acu-notes acu-notes--sm">{{ UI.plot.presetDefaultNotOffered }}</p>
    </div>

    <!-- ④ 暂存：同一楼层的多版成果在这里看、改、删 -->
    <div v-show="page === 4" class="acu-page">
      <p v-if="draft.stashMode === 'qrf'" class="acu-notes">{{ UI.plot.stashQrfModeNote }}</p>
      <!-- ctx 只为把「使用中」版本的编辑同步进世界书（批 45） -->
      <StashPanel v-else :ctx="ctx" />
    </div>

    <!-- ⑤ 运行日志（对应工作流助手第 4 页）：每轮每任务的提示词 / 回传 / 耗时 / 报错 -->
    <div v-show="page === 5" class="acu-page">
      <RunLogPanel />
      <p class="acu-notes acu-notes--sm">{{ UI.plot.assetsHint }}</p>
    </div>

    <div class="acu-page-footer">
      <button class="acu-btn acu-btn--sm" type="button" :disabled="page <= 1" @click="goToPage(page - 1)">
        {{ UI.plot.pagePrev }}
      </button>
      <span class="acu-page-indicator">{{ page }} / {{ PAGE_COUNT }}</span>
      <button class="acu-btn acu-btn--sm" type="button" :disabled="page >= PAGE_COUNT" @click="goToPage(page + 1)">
        {{ UI.plot.pageNext }}
      </button>
    </div>

    <!--
      预览弹窗：把这一轮真要发给 AI 的字摊开。
      为什么不放在页内：一份提示词动辄几千字，塞在页里会把下面的设置全推下去；
      弹窗自带滚动条，看完点叉就关，不打断编辑。
    -->
    <div v-if="previewOpen" class="acu-preview-mask" @click.self="previewOpen = false">
      <div class="acu-preview">
        <div class="acu-preview__head">
          <span class="acu-preview__title">{{ UI.plot.previewTitle }}</span>
          <button class="acu-btn acu-btn--sm" type="button" @click="previewOpen = false">×</button>
        </div>
        <p class="acu-notes acu-notes--sm acu-preview__note">{{ UI.plot.previewHint }}</p>

        <div v-if="previewBusy" class="acu-preview__body">{{ UI.plot.previewBusy }}</div>
        <div v-else-if="previewError !== ''" class="acu-preview__body" style="color: var(--acu-danger)">
          {{ previewError }}
        </div>
        <template v-else-if="previewData !== null">
          <p class="acu-notes acu-notes--sm acu-preview__note">
            {{ UI.plot.previewRoundMeta(previewData.presetName, previewData.round, previewData.tasks.length) }}
          </p>
          <div v-if="previewData.skipped.length > 0" class="acu-notes acu-notes--sm acu-preview__note">
            {{ UI.plot.previewSkipped(previewData.skipped.length) }}
          </div>

          <div class="acu-preview__tabs">
            <button
              v-for="(task, index) in previewData.tasks"
              :key="task.taskId"
              type="button"
              class="acu-preview__tab"
              :class="{ active: previewTaskIndex === index }"
              @click="previewTaskIndex = index"
            >
              {{ task.taskName }}
            </button>
          </div>

          <div class="acu-preview__body">
            <div v-if="previewTask === null" class="acu-notes">{{ UI.plot.previewNoTask }}</div>
            <template v-else>
              <p class="acu-notes acu-notes--sm acu-preview__note">
                {{ UI.plot.previewTaskMeta(previewTask.stage, previewTask.messages.length) }}
              </p>
              <div v-for="(message, index) in previewTask.messages" :key="index" class="acu-preview__msg">
                <span class="acu-preview__role">{{ message.role }}</span>
                <pre class="acu-preview__text">{{ message.content }}</pre>
              </div>
            </template>
          </div>

        </template>
      </div>
    </div>

    <CopyPasteDialog
      v-if="copyPasteOpen"
      :kind="clipKind ?? 'block'"
      :source="clipSource"
      :targets="pasteTargets"
      @pick="pasteTo"
      @close="copyPasteOpen = false"
    />
  </div>
</template>

<style scoped>
/* API 下拉：自己画的列表，每条右边一颗星（点名字=翻看，点星=设默认） */
.rh-api-pick {
  position: relative;
  flex: 1 1 auto;
  min-width: 0;
}

.rh-api-pick__trigger {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  text-align: left;
  cursor: pointer;
}

.rh-api-pick__name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rh-api-pick__caret {
  flex: 0 0 auto;
  opacity: 0.6;
}

.rh-api-backdrop {
  position: fixed;
  inset: 0;
  z-index: 40;
}

.rh-api-menu {
  position: absolute;
  z-index: 41;
  left: 0;
  right: 0;
  top: calc(100% + 4px);
  max-height: 260px;
  overflow-y: auto;
  padding: 4px;
  border: 1px solid var(--rh-card-edge, rgba(120, 116, 140, 0.26));
  border-radius: 8px;
  background: var(--rh-bg-pure, #fdfbf7);
  box-shadow: 0 10px 26px var(--rh-shadow, rgba(38, 34, 64, 0.26));
}

.rh-api-item {
  display: flex;
  align-items: center;
  gap: 4px;
}

.rh-api-item__name {
  flex: 1 1 auto;
  min-width: 0;
  padding: 7px 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 13px;
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}

.rh-api-item__name.is-editing {
  background: var(--rh-accent-wash, rgba(176, 141, 79, 0.14));
  color: var(--rh-accent-2, #8a6a2f);
}

.rh-api-item__star {
  flex: 0 0 auto;
  width: 34px;
  padding: 6px 0;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--rh-fg-dim, #9a8a6b);
  line-height: 1;
  cursor: pointer;
}

.rh-api-item__star.is-default {
  color: var(--rh-accent, #b08d4f);
  border-color: var(--rh-accent, #b08d4f);
  background: var(--rh-accent-wash, rgba(176, 141, 79, 0.14));
}
</style>
