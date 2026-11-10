<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { klona } from 'klona';
import { FALLBACK_SETTINGS, clampCount } from '../settings';
import { dropLogLines, readLogLines } from '../logger';
import { isValidRegex } from '../regex';
import { profile } from '../profile';
import { MSG, UI } from '../copy';
import { pageToastr } from '../tavern';
import { TOAST_URGENT_MS } from '../constants';
import SectionRail from './SectionRail.vue';
import { PANEL_THEMES, asThemeId, themeVars } from '../themes';
import PlotPage from './PlotPage.vue';
import UsageGuide from './UsageGuide.vue';
import type { PlotSettings, RegexPreset, RerushContext, RerushSettings } from '../types';

const props = defineProps<{
  settings: RerushSettings;
  /** 脚本上下文：只给「预览这次会发什么」用（它要真取一遍世界书与表格）。 */
  ctx: RerushContext;
}>();

const emit = defineEmits<{
  /**
   * 保存。父组件通过回传的布尔值告诉面板「有没有真的写进酒馆变量」：
   * 返回 false 时不要把「未保存」标记清掉，否则用户会以为存好了
   * （见 onSave 里 saveSettings 的回读核对）。
   */
  (e: 'save', settings: RerushSettings, done?: (ok: boolean) => void): void;
  (e: 'close'): void;
}>();

/** 草稿：嵌套结构必须逐层拷，否则改一下就把 ctx.settings 一起改了。 */
const draft = reactive<RerushSettings>({
  bindings: { ...props.settings.bindings },
  presets: props.settings.presets.map((preset) => ({ ...preset })),
  capture: { ...props.settings.capture },
  look: { ...props.settings.look },
  timing: { ...props.settings.timing },
  plot: readPlotDraft(props.settings.plot),
  /**
   * 剧情推进的草稿由 PlotPage 自己持有（它那一套有 4 页、字段多），
   * 这里先给一份与 props 同形状的初值，等它挂载后把真实草稿写回来。
   */
});

/**
 * 拷一份剧情推进设置（整份深拷，否则改一下就连 ctx 那份一起改了）。
 *
 * **不要改成手写字段清单。** 2026-11-01 就是那么写的，结果新加的 `presets`
 * 与 `requestTimeoutSeconds` 不在清单里，草稿里成了 undefined，
 * `PlotPage` 里 `props.plot.presets.map()` 当场抛异常，整个剧情推进页渲染成空白。
 * 这一页的字段只会越加越多，手写清单一定会再漏一次。
 */
function readPlotDraft(source: PlotSettings): PlotSettings {
  return klona(source);
}


const activeTab = ref<'bindings' | 'capture' | 'feedback'>('bindings');
/** 左侧功能列当前停在哪一套页面（剧情推进 / 推进重刷 / 使用说明）。批 46：默认落在剧情推进。 */
const activeSection = ref<'rerush' | 'plot' | 'guide'>('plot');
/**
 * 手机上的功能列抽屉是否展开。
 *
 * 为什么需要它：手机上宽 96vw 的卡片本来就窄，左侧 108px 的功能列一直摆在那儿，
 * 内容区会被压到只剩两百来像素，一长条标签直接变成「提示…」。
 * 所以窄屏时功能列收成抽屉，靠标题栏左上角那颗按钮拉开。
 */
const railOpen = ref(false);

function pickSection(key: string): void {
  activeSection.value = key === 'plot' ? 'plot' : key === 'guide' ? 'guide' : 'rerush';
  railOpen.value = false;
}
/**
 * 主题：草稿里存 id，绑成内联 CSS 变量。
 *
 * 跟着 `draft` 走而不是跟着 `props.settings` 走，这样点一下下拉就当场换色（和别处
 * "改了立刻看到、点保存才落盘"的规矩一致）；不保存就关掉，下次打开还是上一份。
 */
const maskStyle = computed(() => themeVars(draft.look.themeId));

/** 功能列的三项（批 46：剧情推进提到第一位，进来就是它）。剧情推进不分产物 —— 完整版和轻量版都有这一套。 */
const sections = [
  { key: 'plot' as const, label: UI.sections.plot },
  { key: 'rerush' as const, label: UI.sections.rerush },
  { key: 'guide' as const, label: UI.sections.guide },
];
/** 剧情推进那一页的组件实例，保存时要从它那里取最新草稿。 */
const plotPage = ref<{
  draft: PlotSettings;
  applyEditor: () => boolean;
  isDirtyNow: () => boolean;
  discardDraft: () => void;
  markSaved: () => void;
  validationNote: () => string;
} | null>(null);
/** 剧情推进那一页有没有改了没存的。别的页没有草稿，所以只看它。 */
const plotDirty = computed(() => plotPage.value?.isDirtyNow() ?? false);
/** 放弃这一页的改动，退回上次保存的样子。 */
function discardPlot(): void {
  plotPage.value?.discardDraft();
}
/** 设置面板的分页。 */
const tabs = [
  { key: 'bindings' as const, label: UI.tabs.bindings },
  { key: 'capture' as const, label: UI.tabs.capture },
  { key: 'feedback' as const, label: UI.tabs.feedback },
];
/** 面板标题带产物名，导入后一眼确认装的是哪个。 */
const panelTitle = UI.panelTitleOf(profile().displayName);

/**
 * 捕获链页的说明跟着取文来源换措辞：开了 AI 楼层模式后删层范围并没有变，
 * 这一点必须写在明面上，否则用户会以为删的也是 AI 那一层。
 */
const captureHint = computed(() => (draft.capture.fromAiFloor ? UI.captureHints.on : UI.captureHints.off));

const gestureRows = [
  { field: 'tap' as const, label: UI.gestureRows.tap },
  { field: 'double' as const, label: UI.gestureRows.double },
  { field: 'hold' as const, label: UI.gestureRows.hold },
  { field: 'triple' as const, label: UI.gestureRows.triple },
  { field: 'right' as const, label: UI.gestureRows.right },
];

const logText = ref(readLogLines().join('\n'));

function wipeLog(): void {
  dropLogLines();
  logText.value = '';
}

function restoreDefaults(): void {
  Object.assign(draft.bindings, FALLBACK_SETTINGS.bindings);
  Object.assign(draft.look, FALLBACK_SETTINGS.look);
  Object.assign(draft.timing, FALLBACK_SETTINGS.timing);
  draft.presets = FALLBACK_SETTINGS.presets.map((preset) => ({ ...preset }));
  Object.assign(draft.capture, FALLBACK_SETTINGS.capture);
}

// 拖选冻结的监听（见上面「拖选冻结」一段的说明）。
// 面板 DOM 挂在酒馆主文档上，document 级监听必须挂 ownerDocument，不是 iframe 的 window
// （与上面拖拽排序同一口径，第 27 次的教训）。
onMounted(() => {
  const host = scrollBody.value;
  const doc = host?.ownerDocument;
  if (!host || !doc) return;
  host.addEventListener('pointerdown', armSelectionFreeze, true);
  host.addEventListener('scroll', pinSelectionScroll);
  doc.addEventListener('pointerup', releaseSelectionFreeze);
  doc.addEventListener('pointercancel', releaseSelectionFreeze);
});

onBeforeUnmount(() => {
  // 正在拖的时候面板被关掉（例如点了蒙层）：监听与帧循环都要收干净，
  // 否则残留的 pointermove 会指向一段已经没有 DOM 的逻辑
  detachDragListeners();
  // 拖选冻结的监听一并收掉
  const host = scrollBody.value;
  const doc = host?.ownerDocument;
  if (host) {
    host.removeEventListener('pointerdown', armSelectionFreeze, true);
    host.removeEventListener('scroll', pinSelectionScroll);
  }
  if (doc) {
    doc.removeEventListener('pointerup', releaseSelectionFreeze);
    doc.removeEventListener('pointercancel', releaseSelectionFreeze);
  }
  selectionFreeze = null;
});

const editingShown = ref(false);
const editor = reactive<RegexPreset>({
  id: '',
  name: '',
  regex: '',
  note: '',
});

const editorReady = computed(() => editor.name.trim() !== '' && isValidRegex(editor.regex));

function startNewPreset(): void {
  Object.assign(editor, {
    id: `preset_${crypto.randomUUID()}`,
    name: '',
    regex: '',
    note: '',
  });
  editingShown.value = true;
}

function startEditPreset(preset: RegexPreset): void {
  Object.assign(editor, preset);
  editingShown.value = true;
}

function dismissEditor(): void {
  editingShown.value = false;
}

function commitEditor(): void {
  if (!editorReady.value) return;
  const at = draft.presets.findIndex((preset) => preset.id === editor.id);
  const next = { ...editor };
  if (at >= 0) {
    draft.presets[at] = next;
  } else {
    draft.presets.push(next);
  }
  editingShown.value = false;
}

function dropPreset(id: string): void {
  const at = draft.presets.findIndex((preset) => preset.id === id);
  if (at < 0) return;
  draft.presets.splice(at, 1);
}

/**
 * 拖动排序（指针事件 Pointer Events 版）。
 *
 * 为什么不用 HTML5 拖放（draggable + dragover/drop）：实测有三处按不动，
 * ① 触屏根本不触发 drag 事件，手机上完全拖不了；
 * ② drop 只绑在条目自己身上，指针落到条目缝隙、标题或"＋新增"那一带就取消，
 *    而 dragleave 会在进入条目内的子节点时被触发，虚线框乱闪，看着就像"拖一半掉了"；
 * ③ 往列表下方拖有 off-by-one——splice 摘掉自己后面元素整体左移，插回原索引会多跳一格，
 *    用户"往下挪一位"经常等于没动。
 * 现在改成：起拖只要 4px 位移；落点按"指针压在谁的上半段"实时算插入槽；
 * 顺序在拖动过程中就地换掉（所见即所得）；拖到卡片上下边缘 34px 内自动滚动列表。
 */
const PICK_THRESHOLD_PX = 4;
/** 指针离滚动容器上下边缘小于这个距离就开始自动滚动。 */
const AUTO_SCROLL_EDGE_PX = 34;
/** 自动滚动每一帧挪多少像素。 */
const AUTO_SCROLL_STEP_PX = 8;

/** 正在拖的那一条当前落在第几格（拖动过程中会随实时换位而变）。 */
const dragging = ref<number | null>(null);
/** 拖到手势进行中：给整块列表挂 user-select:none，避免拖动顺带选中文字。 */
const picking = ref(false);

interface PendingPress {
  pointerId: number;
  /** 起手时这条在第几格 */
  index: number;
  startY: number;
  /** 位移还没过阈值时只记账，不算开始拖——点编辑/删除按钮不该被吞掉 */
  started: boolean;
  item: HTMLElement;
}

let pending: PendingPress | null = null;
let lastClientY = 0;
let scrollHost: HTMLElement | null = null;
let scrollRaf: number | null = null;
/**
 * 拖动期间 pointermove / pointerup 挂在**面板所属的那份 document**（即酒馆父页面），不是 window。
 * 面板这坨 DOM 挂在酒馆父页面上（见 README「换版不用刷新」一节），而脚本代码跑在自己的
 * iframe 里，iframe 的 window 永远收不到父页面里派发的指针事件：第27次第一版就是把监听
 * 挂在 window 上，结果 pointerdown 还能收到（那是 Vue 直接绑在元素上的），后续的
 * pointermove 一个都收不到，表现就是"按 ⠿ 一点反应也没有"。
 * 为什么用 ownerDocument 而不是元素自己：条目在实时换序时会被 Vue 搬动，父页面又有 interact.js
 * 那类会干预指针事件的库；挂在文档上，事件从任何目标冒泡上来都收得到，配合 setPointerCapture
 * 保证松手（哪怕在面板外、在窗口外）一定收到 pointerup。
 */
let dragDoc: Document | null = null;
/** 面板所在文档的 window。自动滚动的 requestAnimationFrame 用它——iframe 自己的帧循环不可靠。 */
let dragView: Window | null = null;

/** 同一容器里所有条目（按 DOM 顺序）；拖动中的列表顺序就是 draft.presets 的顺序。 */
function itemElements(): HTMLElement[] {
  const host = pending?.item.parentElement;
  if (!host) return [];
  return Array.from(host.children).filter((child) => child.classList.contains('rh-item')) as HTMLElement[];
}

/**
 * 指针 y 对应的插入槽：落在哪一条的上半段就插到它前面；
 * 比最后一条的中线还靠下就追到末尾（返回 length）。
 */
function slotOf(clientY: number, items: HTMLElement[]): number {
  for (let index = 0; index < items.length; index++) {
    const box = items[index].getBoundingClientRect();
    if (clientY < box.top + box.height / 2) return index;
  }
  return items.length;
}

/** 按指针位置实时换位。 */
function moveTo(clientY: number): void {
  const current = dragging.value;
  if (current === null) return;
  const items = itemElements();
  if (items.length === 0) return;
  const slot = slotOf(clientY, items);
  // 摘掉自己后面，槽位大于自己时要回退一格，否则会多跳一位
  const to = slot > current ? slot - 1 : slot;
  if (to === current || to < 0 || to >= draft.presets.length) return;
  reorder(current, to);
  dragging.value = to;
}

function reorder(from: number, to: number): void {
  if (from === to || from < 0 || to < 0 || to >= draft.presets.length) return;
  const [moved] = draft.presets.splice(from, 1);
  draft.presets.splice(to, 0, moved);
}

/** 拖到边缘时的自动滚动，一帧一次，滚动后立刻重算一次落点。 */
function tickAutoScroll(): void {
  scrollRaf = null;
  if (!scrollHost || dragging.value === null) return;
  const box = scrollHost.getBoundingClientRect();
  let delta = 0;
  if (lastClientY - box.top < AUTO_SCROLL_EDGE_PX) delta = -AUTO_SCROLL_STEP_PX;
  else if (box.bottom - lastClientY < AUTO_SCROLL_EDGE_PX) delta = AUTO_SCROLL_STEP_PX;
  if (delta !== 0) {
    const before = scrollHost.scrollTop;
    scrollHost.scrollTop += delta;
    if (scrollHost.scrollTop !== before) moveTo(lastClientY);
  }
  if (dragging.value !== null) scrollRaf = (dragView ?? window).requestAnimationFrame(tickAutoScroll);
}

/** 起拖时挂上的监听全部收干净（pointerup、pointercancel、面板卸载三条路都走这里）。 */
function detachDragListeners(): void {
  const view = dragView ?? window;
  if (dragDoc) {
    dragDoc.removeEventListener('pointermove', onPointerMove);
    dragDoc.removeEventListener('pointerup', onPointerUp);
    dragDoc.removeEventListener('pointercancel', onPointerUp);
  }
  if (scrollRaf !== null) {
    view.cancelAnimationFrame(scrollRaf);
    scrollRaf = null;
  }
  dragDoc = null;
  dragView = null;
  pending = null;
  scrollHost = null;
  dragging.value = null;
  picking.value = false;
}

// ── 拖选冻结（2026-11-07 批 42 提出，2026-11-08 批 43 定稿为唯一修法）──
//
// 成因：从输入框 / 正文框起手划选、光标滑出面板边缘后，浏览器的**原生拖选自动滚动**
// 会持续滚 `.rh-card-body` 这个滚动容器 —— 面板只有 700 来像素高，滚起来一瞬到底。
// 而从框里起手的选中**永远出不了这个框**（表单控件的选中 confined 在控件内），
// 这时候面板跟着滚纯属白滚，所以钉住它没有任何副作用；框外起手的划选不经过这里，
// 行为与从前一致（批 43 用户定：不做 user-select: none 那层，不牺牲别处的划选）。
//
// 做法：输入框 / 正文框上按下左键就记住当前 scrollTop，此后这段容器的每次 scroll
// 都弹回记住的位置（浏览器的自动滚动也不过就是改 scrollTop，弹回即抵消）；
// 松手（pointerup / pointercancel）解除。判元素用 tagName 而不是 instanceof ——
// 面板 DOM 挂在酒馆主文档上，而这段代码跑在脚本 iframe 里，跨 realm 的
// instanceof 恒为 false（2026-11-07 真机踩过）。

/** 面板滚动容器。模板里那个 `ref="scrollBody"`。 */
const scrollBody = ref<HTMLElement | null>(null);

/** 冻结状态：null = 没在划选；有值 = 记住的位置。 */
let selectionFreeze: { top: number } | null = null;

function armSelectionFreeze(event: PointerEvent): void {
  const tag = (event.target as HTMLElement | null)?.tagName ?? '';
  if (tag !== 'TEXTAREA' && tag !== 'INPUT') return;
  const host = scrollBody.value;
  if (!host) return;
  selectionFreeze = { top: host.scrollTop };
}

function pinSelectionScroll(): void {
  const host = scrollBody.value;
  if (!host || selectionFreeze === null) return;
  host.scrollTop = selectionFreeze.top;
}

function releaseSelectionFreeze(): void {
  selectionFreeze = null;
}

function onPointerDown(index: number, event: PointerEvent): void {
  if (pending || event.button !== 0) return;
  const hit = event.target as HTMLElement;
  // 条目里的 ✎ ✕ 按钮不参与拖拽
  if (hit.closest('button')) return;
  // 触屏只能按住左侧 ⠿ 起拖，否则会和"上下滑列表"这个手势打架
  if (event.pointerType !== 'mouse' && !hit.closest('.rh-grip')) return;
  // 鼠标：起手就压掉浏览器的文本选中（click 照常派发，编辑/删除按钮上面已放行）
  if (event.pointerType === 'mouse') event.preventDefault();

  const item = event.currentTarget as HTMLElement;
  const doc = item.ownerDocument;
  if (!doc) return;
  pending = { pointerId: event.pointerId, index, startY: event.clientY, started: false, item };
  dragDoc = doc;
  dragView = doc.defaultView ?? window;
  // 捕获到这一条元素：手指或光标滑出条目、滑出面板都不掉线，松手必定回到这里
  item.setPointerCapture(event.pointerId);
  doc.addEventListener('pointermove', onPointerMove, { passive: false });
  doc.addEventListener('pointerup', onPointerUp);
  doc.addEventListener('pointercancel', onPointerUp);
}

function onPointerMove(event: PointerEvent): void {
  if (!pending || event.pointerId !== pending.pointerId) return;
  lastClientY = event.clientY;

  if (!pending.started) {
    if (Math.abs(event.clientY - pending.startY) < PICK_THRESHOLD_PX) return;
    pending.started = true;
    dragging.value = pending.index;
    picking.value = true;
    scrollHost = pending.item.closest('.rh-card-body');
    if (scrollRaf === null) scrollRaf = (dragView ?? window).requestAnimationFrame(tickAutoScroll);
  }

  // 拦下原生选中与页面滚动，拖动才跟手
  event.preventDefault();
  moveTo(event.clientY);
}

function onPointerUp(event: PointerEvent): void {
  if (pending && event.pointerId !== pending.pointerId) return;
  detachDragListeners();
}

function save(): void {
  // 剧情推进那一页的预设编辑器改的是自己那份副本，不先写回去，它那一页的改动会整个丢掉
  // （2026-11-02 用户实测：关掉一个任务、点保存、重开还是开着）。
  // 校验不过就停在这里 —— 存一份和屏幕上不一样的东西，比不存更糟。
  if (plotPage.value && !plotPage.value.applyEditor()) {
    pageToastr()?.error(MSG.settingsPresetInvalid(plotPage.value.validationNote()), '', { timeOut: TOAST_URGENT_MS });
    return;
  }

  const { tapWindowMs, holdMs } = draft.timing;
  // 手输的数字一律钳回合法区间：脏值写进变量后，下次读取时 zod 校验不过会整份退回默认值
  //
  // 收尾统一走 done 回调：父组件用它告诉我们「有没有真的写进酒馆变量」。
  // 不能无条件 markSaved —— 写盘可能静默失败，那时清掉「未保存」标记等于骗人。
  // 父组件没调用回调（老路径）时按「存好了」处理，行为与以前一致。
  let settled = false;
  const done = (ok: boolean): void => {
    settled = true;
    if (ok) plotPage.value?.markSaved();
  };
  emit('save', {
    bindings: { ...draft.bindings },
    presets: draft.presets.map((preset) => ({ ...preset })),
    capture: { ...draft.capture },
    look: { ...draft.look },
    timing: {
      tapWindowMs: clampCount(tapWindowMs, FALLBACK_SETTINGS.timing.tapWindowMs, 10),
      holdMs: clampCount(holdMs, FALLBACK_SETTINGS.timing.holdMs, 10),
    },
    // 剧情推进的草稿在 PlotPage 手里，从它那里读最新的一份；
    // 那一页从没打开过时它还没挂载，就沿用初始化时拷的那份（等同于"没改动"）。
    plot: readPlotDraft(plotPage.value?.draft ?? draft.plot),
  }, done);

  // 父组件是同步调用的，走到这里回调已经跑过了；没跑说明是老路径（没人关心结果）。
  if (!settled) plotPage.value?.markSaved();
}
</script>

<template>
  <div
    class="rh-mask"
    :style="maskStyle"
    :data-rh-theme="draft.look.themeId"
    @mousedown.self="emit('close')"
  >
    <div class="rh-card">
      <header class="rh-card-head">
        <button
          class="rh-burger"
          type="button"
          :aria-expanded="railOpen"
          :title="UI.buttons.sections"
          @click="railOpen = !railOpen"
        >
          <span class="rh-burger-bar" aria-hidden="true"></span>
          <span class="rh-burger-bar" aria-hidden="true"></span>
          <span class="rh-burger-bar" aria-hidden="true"></span>
        </button>
        <div class="rh-card-title">
          <svg class="rh-ico" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M13.2 8a5.2 5.2 0 1 1-1.6-3.8" />
            <path d="M13.6 2.2v3.2h-3.2" />
          </svg>
          {{ panelTitle }}
        </div>
        <div class="rh-head-actions">
          <label class="rh-theme-pick" :title="UI.themeHint">
            <span class="rh-theme-pick-label">{{ UI.themeLabel }}</span>
            <select
              class="rh-theme-sel"
              :value="draft.look.themeId"
              @change="draft.look.themeId = asThemeId(($event.target as HTMLSelectElement).value)"
            >
              <option v-for="theme in PANEL_THEMES" :key="theme.id" :value="theme.id">{{ theme.name }}</option>
            </select>
          </label>
          <button class="rh-x" :title="UI.buttons.close" @click="emit('close')">×</button>
        </div>
      </header>

      <!-- 左侧功能列：两个大功能，点哪个右边就进哪一套页面 -->
      <div class="rh-body-wrap">
        <div v-if="railOpen" class="rh-rail-veil" @click="railOpen = false"></div>
        <SectionRail
          :class="{ open: railOpen }"
          :items="sections"
          :active="activeSection"
          @pick="pickSection($event)"
        />

        <div class="rh-main-col">
          <!-- 推进重刷那一套：沿用原来的标签栏与页面 -->
          <template v-if="activeSection === 'rerush'">
            <nav class="rh-tabs">
              <button
                v-for="tab in tabs"
                :key="tab.key"
                type="button"
                class="rh-tab"
                :class="{ active: activeTab === tab.key }"
                @click="activeTab = tab.key"
              >
                {{ tab.label }}
              </button>
            </nav>
          </template>

          <div ref="scrollBody" class="rh-card-body">
            <!-- 剧情推进那一套：常驻挂载，切页签只隐藏不卸载，草稿与已导入预设才不会丢 -->
            <PlotPage v-show="activeSection === 'plot'" ref="plotPage" :plot="draft.plot" :ctx="props.ctx" />

            <template v-if="activeSection === 'guide'">
              <UsageGuide />
            </template>

            <template v-else-if="activeSection === 'rerush'">
        <!-- 手势绑定 -->
        <section v-if="activeTab === 'bindings'" class="rh-block">
          <div v-for="row in gestureRows" :key="row.field" class="rh-line">
            <label>{{ row.label }}</label>
            <select v-model="draft.bindings[row.field]">
              <option v-for="choice in UI.actionChoices" :key="choice.value" :value="choice.value">
                {{ choice.label }}
              </option>
            </select>
          </div>

          <div class="rh-pair">
            <div class="rh-field">
              <label>{{ UI.timingRows.tapWindow }}</label>
              <input v-model.number="draft.timing.tapWindowMs" type="number" min="10" />
              <span>ms</span>
            </div>
            <div class="rh-field">
              <label>{{ UI.timingRows.holdSpan }}</label>
              <input v-model.number="draft.timing.holdMs" type="number" min="10" />
              <span>ms</span>
            </div>
          </div>
          <p class="rh-note">{{ UI.timingHints.tapWindow }}</p>
          <p class="rh-note">{{ UI.timingHints.holdSpan }}</p>

        </section>

        <!-- 捕获链 -->
        <section v-if="activeTab === 'capture'" class="rh-block" :class="{ 'rh-pick': picking }">
          <label class="rh-line">
            <span>{{ UI.captureRows.aiFloor }}</span>
            <input v-model="draft.capture.fromAiFloor" type="checkbox" />
          </label>

          <p class="rh-note">{{ captureHint }}</p>

          <div
            v-for="(preset, index) in draft.presets"
            :key="preset.id"
            class="rh-item"
            :class="{ pulling: dragging === index }"
            :title="UI.presetDragTitle"
            @pointerdown="onPointerDown(index, $event)"
          >
            <span class="rh-grip" aria-hidden="true">⠿</span>
            <span class="rh-rank">{{ index + 1 }}</span>
            <div class="rh-item-main">
              <div class="rh-item-name">{{ preset.name }}</div>
              <code class="rh-item-pattern">{{ preset.regex }}</code>
              <div class="rh-item-note">{{ preset.note }}</div>
            </div>
            <div class="rh-item-ops">
              <button type="button" :title="UI.buttons.editPreset" @click="startEditPreset(preset)">✎</button>
              <button type="button" :title="UI.buttons.deletePreset" @click="dropPreset(preset.id)">✕</button>
            </div>
          </div>

          <p v-if="draft.presets.length === 0" class="rh-note rh-note-alert">{{ UI.captureEmptyHint }}</p>

          <button type="button" class="rh-plus" @click="startNewPreset">＋ {{ UI.buttons.addPreset }}</button>

          <div v-if="editingShown" class="rh-form">
            <div class="rh-form-row">
              <label class="rh-form-label">{{ UI.regexEditor.name }}</label>
              <input v-model="editor.name" :placeholder="UI.regexEditor.namePlaceholder" />
            </div>
            <div class="rh-form-row">
              <label class="rh-form-label">{{ UI.regexEditor.pattern }}</label>
              <input v-model="editor.regex" class="rh-form-pattern" :placeholder="UI.regexEditor.patternPlaceholder" />
              <span class="rh-form-tip">{{ UI.regexEditor.patternHint }}</span>
            </div>
            <div class="rh-form-row">
              <label class="rh-form-label">{{ UI.regexEditor.note }}</label>
              <textarea v-model="editor.note" :placeholder="UI.regexEditor.notePlaceholder"></textarea>
            </div>
            <div class="rh-form-ops">
              <button type="button" @click="dismissEditor">{{ UI.buttons.cancel }}</button>
              <button type="button" :disabled="!editorReady" @click="commitEditor">{{ UI.buttons.save }}</button>
            </div>
          </div>
        </section>

        <!-- 反馈与日志 -->
        <section v-if="activeTab === 'feedback'" class="rh-block">
          <label class="rh-line">
            <span>{{ UI.switchRows.shake }}</span>
            <input v-model="draft.look.shake" type="checkbox" />
          </label>
          <label class="rh-line">
            <span>{{ UI.switchRows.flash }}</span>
            <input v-model="draft.look.flash" type="checkbox" />
          </label>
          <label class="rh-line">
            <span>{{ UI.switchRows.toast }}</span>
            <input v-model="draft.look.toast" type="checkbox" />
          </label>

          <div class="rh-logbox">
            <textarea v-model="logText" readonly class="rh-log" :placeholder="UI.logPlaceholder"></textarea>
            <button type="button" class="rh-log-wipe" @click="wipeLog">{{ UI.buttons.clearLog }}</button>
          </div>
        </section>
            </template>
          </div>
        </div>
      </div>

      <footer class="rh-card-foot">
        <span v-if="plotDirty" class="rh-dirty-hint">{{ UI.buttons.unsaved }}</span>
        <button
          type="button"
          class="rh-act rh-act-plain"
          :disabled="!plotDirty"
          @click="discardPlot"
        >
          {{ UI.buttons.discard }}
        </button>
        <button type="button" class="rh-act rh-act-plain" @click="restoreDefaults">{{ UI.buttons.reset }}</button>
        <button type="button" class="rh-act rh-act-plain" @click="emit('close')">{{ UI.buttons.close }}</button>
        <button type="button" class="rh-act rh-act-go" @click="save">{{ UI.buttons.save }}</button>
      </footer>
    </div>
  </div>
</template>

<style src="./settings-panel.css"></style>
