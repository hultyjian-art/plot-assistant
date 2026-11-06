<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { klona } from 'klona';
import { FALLBACK_SETTINGS, clampCount } from '../settings';
import { dropLogLines, readLogLines } from '../logger';
import { isValidRegex } from '../regex';
import { profile } from '../profile';
import { MSG, UI } from '../copy';
import SectionRail from './SectionRail.vue';
import { PANEL_THEMES, asThemeId, themeVars } from '../themes';
import PlotPage from './PlotPage.vue';
import type { PlotSettings, RegexPreset, RerushContext, RerushSettings } from '../types';

const props = defineProps<{
  settings: RerushSettings;
  /** 脚本上下文：只给「预览这次会发什么」用（它要真取一遍世界书与表格）。 */
  ctx: RerushContext;
}>();

const emit = defineEmits<{
  (e: 'save', settings: RerushSettings): void;
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

/**
 * 拉到的模型列表只放在内存里（不写进设置）：它随时能从插头再拉一次，
 * 落盘只会把酒馆变量撑大。放在模块级，所以关掉面板再打开还在。
 */
const modelCache: Record<string, string[]> = {};

const activeTab = ref<'bindings' | 'capture' | 'feedback'>('bindings');
/** 左侧功能列当前停在哪一套页面（推进重刷 / 剧情推进）。 */
const activeSection = ref<'rerush' | 'plot'>('rerush');
/**
 * 手机上的功能列抽屉是否展开。
 *
 * 为什么需要它：手机上宽 96vw 的卡片本来就窄，左侧 108px 的功能列一直摆在那儿，
 * 内容区会被压到只剩两百来像素，一长条标签直接变成「提示…」。
 * 所以窄屏时功能列收成抽屉，靠标题栏左上角那颗按钮拉开。
 */
const railOpen = ref(false);

function pickSection(key: string): void {
  activeSection.value = key === 'plot' ? 'plot' : 'rerush';
  railOpen.value = false;
}
/**
 * 主题：草稿里存 id，绑成内联 CSS 变量。
 *
 * 跟着 `draft` 走而不是跟着 `props.settings` 走，这样点一下下拉就当场换色（和别处
 * "改了立刻看到、点保存才落盘"的规矩一致）；不保存就关掉，下次打开还是上一份。
 */
const maskStyle = computed(() => themeVars(draft.look.themeId));

/** 功能列的两项。剧情推进不分产物 —— 完整版和轻量版都有这一套。 */
const sections = [
  { key: 'rerush' as const, label: UI.sections.rerush },
  { key: 'plot' as const, label: UI.sections.plot },
];
/** 剧情推进那一页的组件实例，保存时要从它那里取最新草稿。 */
const plotPage = ref<{
  draft: PlotSettings;
  applyEditor: () => boolean;
  isDirtyNow: () => boolean;
  discardDraft: () => void;
  markSaved: () => void;
} | null>(null);
/** 剧情推进那一页有没有改了没存的。别的页没有草稿，所以只看它。 */
const plotDirty = computed(() => plotPage.value?.isDirtyNow() ?? false);
/** 放弃这一页的改动，退回上次保存的样子。 */
function discardPlot(): void {
  plotPage.value?.discardDraft();
}
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

onBeforeUnmount(() => {
  if (liveTimer !== null) {
    window.clearInterval(liveTimer);
    liveTimer = null;
  }
  // 正在拖的时候面板被关掉（例如点了蒙层）：监听与帧循环都要收干净，
  // 否则残留的 pointermove 会指向一段已经没有 DOM 的逻辑
  detachDragListeners();
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
    id: `preset_${Date.now()}`,
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
  if (plotPage.value && !plotPage.value.applyEditor()) return;

  const { tapWindowMs, holdMs } = draft.timing;
  // 手输的数字一律钳回合法区间：脏值写进变量后，下次读取时 zod 校验不过会整份退回默认值
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
  });

  // 存下去了就重新拍一张快照，「还没保存」的提示才会跟着消失。
  // 放在 emit 之后：父组件抛错时走不到这里，提示会留着，这是对的。
  plotPage.value?.markSaved();
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

          <div class="rh-card-body">
            <!-- 剧情推进那一套：交给独立组件，它自己管 4 页与草稿 -->
            <template v-if="activeSection === 'plot'">
              <PlotPage ref="plotPage" :plot="draft.plot" :ctx="props.ctx" />
            </template>

            <template v-else>
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

<style>
/* ══════════════════════════════════════════════════════════════════════════
   隔离层：本面板必须自包含 —— 外观只由本文件决定，不受酒馆主题与任何美化影响。

   污染不是假想，酒馆自带 public/style.css 里就有若干条会直接命中面板元素：
     · 135 行  * { text-shadow: 0 0 calc(var(--shadowWidth)*1px) var(--SmartThemeShadowColor) }
                —— 命中面板内每一个元素；主题把阴影色改亮或宽度调大，文字就发虚发花
     · 150 行  body { font-family: var(--mainFontFamily); font-size: var(--mainFontSize);
                       color: var(--SmartThemeBodyColor) }        —— 沿继承链渗进来
     · 1566 行 input, select, button { font-family/font-size/color: 主题变量 }
     · 1544 行 textarea { background-color: var(--black30a); border/color: 主题变量 }
     · 3039 行 select { background-color: var(--black30a); appearance: none;
                        background-image: url('/img/down-arrow.svg') }
     · 3055 行 select option { background-color: var(--white50a); color: var(--black70a) }
     · 701 行  code { font-family: var(--monoFontFamily); border/background/color: 主题变量 }
     · 2612 行 textarea::placeholder
     · 170 行起 ::-webkit-scrollbar

   这些是**直接命中**而非继承，所以既要给面板根做继承断点，也要在控件上逐项钉死。
   又因为主题作者（尤其美化包）普遍用 !important，本文件对“颜色 / 背景 / 边框 / 阴影 /
   字体族”一律带 !important；同为 !important 时靠选择器特异性与书写顺序决胜，
   因此隔离层一律用 :where() 包裹（特异性 0）并写在本文件最前，
   面板自己的规则（特异性 ≥ 0,1,0 且写在后面）随时可以覆盖它。

   面板内所有色值都是本文件写死的字面量（集中在下面 --rh-* 令牌里），
   不引用 --SmartTheme* / --mainFontFamily 之类的任何酒馆变量。
   ══════════════════════════════════════════════════════════════════════════ */

.rh-mask {
  /* —— 面板内部配色令牌（唯一来源；外界同名变量也会被这里的就近声明盖住）—— */
  --rh-fg: #1b2330;
  --rh-fg-soft: #3a4657;
  --rh-fg-dim: #616b79;
  --rh-fg-faint: #8b93a4;
  --rh-bg: #fbfbfd;
  --rh-bg-soft: #f4f6f9;
  --rh-bg-pure: #fefeff;
  --rh-line: #dfe3ea;
  --rh-line-soft: #e8eaef;
  --rh-line-input: #ccd2dc;
  --rh-accent: #7c3aed;
  --rh-accent-deep: #6a2fd1;
  --rh-accent-wash: #f3eefe;
  --rh-accent-wash-soft: #f7f3fe;
  --rh-danger: #b42318;
  --rh-ok: #15803d;
  --rh-ok-wash: #f2fbf5;
  --rh-scrim: rgba(16, 18, 27, 0.55);
  --rh-shadow: rgba(16, 18, 27, 0.35);
  --rh-thumb: #c3c8d2;
  --rh-bg-hover: #edeff3;
  --rh-fg-mid: #4d5765;
  --rh-line-dashed: #bfc4d0;
  --rh-card-edge: rgba(38, 48, 63, 0.1);
  --rh-accent-ring: rgba(124, 58, 237, 0.12);
  --rh-accent-selection: rgba(124, 58, 237, 0.28);
  --rh-scrim-btn: rgba(27, 35, 48, 0.4);
  --rh-ok-ring: rgba(22, 163, 74, 0.18);
  --rh-ok-glow-faint: rgba(22, 163, 74, 0.05);
  --rh-ok-glow-strong: rgba(22, 163, 74, 0.35);
  --rh-font: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB',
    'Microsoft YaHei', 'Source Han Sans SC', 'Noto Sans CJK SC', sans-serif;
  --rh-font-mono: 'Cascadia Mono', 'JetBrains Mono', Consolas, 'SFMono-Regular', Menlo, monospace;

  /* —— 蒙层布局 —— */
  position: fixed !important;
  inset: 0 !important;
  /*
    蒙层自身规定高度：它有 backdrop-filter，会变成后代 position: fixed 的「参照物」，
    高度塌成 0 时里面的弹窗会被压成一条缝。这里直接按视口钉死，别依赖 inset 推算。
  */
  height: 100vh !important;
  height: 100dvh !important;
  z-index: 99999 !important;
  display: flex !important;
  align-items: flex-start !important;
  justify-content: center !important;
  /*
    卡片默认铺满视口（见下面 .rh-card 的第二段声明），这里的 padding 就是卡片到视口的距离，
    照数据库脚本 `.acu-window.maximized` 的四周留 10px。以前是 `60px 16px 24px` 那条给
    小窗留顶部工具栏空间的写法，卡片变满屏之后它会把卡片挤扁、底边压出视口。
  */
  padding: 10px !important;
  margin: 0 !important;
  background-color: var(--rh-scrim) !important;
  backdrop-filter: blur(4px) !important;

  /* —— 继承断点：外界对 body / * 的声明到这一层为止，进不了面板 ——
     （子元素上的直接声明总是优先于继承值，所以这里加 !important 不会挡住面板内部样式） */
  font-family: var(--rh-font) !important;
  font-size: 14px !important;
  font-weight: 400 !important;
  font-style: normal !important;
  font-variant: normal !important;
  line-height: 1.5 !important;
  letter-spacing: normal !important;
  word-spacing: normal !important;
  text-align: left !important;
  text-transform: none !important;
  text-indent: 0 !important;
  text-shadow: none !important;
  white-space: normal !important;
  word-break: normal !important;
  overflow-wrap: normal !important;
  direction: ltr !important;
  color: var(--rh-fg-soft) !important;
  color-scheme: var(--rh-scheme, light) !important;
  visibility: visible !important;
  opacity: 1 !important;
  filter: none !important;
  transform: none !important;
  mix-blend-mode: normal !important;
  isolation: isolate !important;
}

/* —— 挂载点复位：外界若给 body 下的 div 设了 transform / filter，
      会让我们这个 position: fixed 的蒙层改成相对它定位，整个面板会错位 —— */
#rh-prefs-host {
  all: unset !important;
}

/* —— 全子树兜底（:where() 特异性为 0，只负责挡住面板没写到的属性）—— */
:where(.rh-mask *) {
  box-sizing: border-box !important;
  text-shadow: none !important;
  -webkit-text-fill-color: currentColor !important;
  letter-spacing: normal !important;
  word-spacing: normal !important;
  text-transform: none !important;
  text-indent: 0 !important;
  font-variant: normal !important;
  font-style: normal !important;
  word-break: normal !important;
}

/* —— 控件兜底：酒馆对裸标签 input/select/textarea/button/code 有直接规则 —— */
:where(.rh-mask) :where(input, select, textarea, button, code, pre, kbd, option) {
  font-family: inherit !important;
  font-size: inherit !important;
  line-height: inherit !important;
  -webkit-appearance: none !important;
  appearance: none !important;
  text-shadow: none !important;
}

/* 下拉框：酒馆给它设了 appearance:none + 自己的背景箭头图，这里换成面板自绘的紫色箭头 */
:where(.rh-mask) :where(select) {
  margin: 0 !important;
  padding-right: 22px !important;
  cursor: pointer !important;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='5' viewBox='0 0 8 5'%3E%3Cpath d='M0 0l4 5 4-5z' fill='%237c3aed'/%3E%3C/svg%3E") !important;
  background-repeat: no-repeat !important;
  background-position: right 6px center !important;
  background-size: 8px 5px !important;
}

/*
 * 下拉项：酒馆用主题变量给它上色，浅底深字在深色主题里会翻过来。
 *
 * 这里**不能**用 `:where()` 降到 0 特异性：酒馆页面里有一条内联样式表写着
 * `select option { background-color: var(--ui-color-sec) !important }`（特异性 0,0,1），
 * 两边都是 !important 时比特异性，`:where()` 的 0,0,0 会输——下拉展开就是深底深字。
 * 用 `.rh-mask option`（0,1,1）压过它，同时仍低于面板自己的 `.rh-card ... option`（0,2,1）。
 */
.rh-mask option,
.rh-mask optgroup {
  background-color: var(--rh-bg-pure) !important;
  color: var(--rh-fg) !important;
  color-scheme: var(--rh-scheme, light) !important;
}

.rh-mask option:checked,
.rh-mask option:hover {
  background-color: var(--rh-accent-wash) !important;
  color: var(--rh-fg) !important;
}

/* 原生控件（滚动条、日期选择器、下拉弹层）跟着面板的明暗走，别被酒馆的 color-scheme 带跑 */
.rh-mask input,
.rh-mask select,
.rh-mask textarea,
.rh-mask button {
  color-scheme: var(--rh-scheme, light) !important;
}

/* 占位符：酒馆有 textarea::placeholder / .text_pole::placeholder */
:where(.rh-mask) :where(input, textarea)::placeholder {
  color: var(--rh-fg-faint) !important;
  opacity: 1 !important;
}

/* 选中文字：外界可能给 ::selection 设成与背景同色 */
:where(.rh-mask *)::selection {
  background-color: var(--rh-accent-selection) !important;
  color: var(--rh-fg) !important;
}

/* 滚动条：面板内的滚动区（正文区、日志框）也归自己管 */
:where(.rh-mask *)::-webkit-scrollbar {
  width: 10px !important;
  height: 10px !important;
}

:where(.rh-mask *)::-webkit-scrollbar-track {
  background-color: var(--rh-line-soft) !important;
}

:where(.rh-mask *)::-webkit-scrollbar-thumb {
  background-color: var(--rh-thumb) !important;
  border: 2px solid var(--rh-line-soft) !important;
  border-radius: 999px !important;
}

/* 复选框：原生控件跟着面板配色走 */
:where(.rh-mask) :where(input[type='checkbox'], input[type='radio']) {
  accent-color: var(--rh-accent) !important;
  -webkit-appearance: auto !important;
  appearance: auto !important;
  width: 15px !important;
  height: 15px !important;
  flex: none !important;
  cursor: pointer !important;
}

/* ══════════════════════════════════════════════════════════════════════════
   面板自身样式。凡“颜色 / 背景 / 边框 / 阴影 / 字体族”都带 !important，
   以压过主题与美化包同样带 !important 的裸标签规则。
   ══════════════════════════════════════════════════════════════════════════ */

.rh-card {
  width: 480px;
  max-width: calc(100vw - 32px);
  max-height: 82vh;
  display: flex;
  flex-direction: column;
  background-color: var(--rh-bg) !important;
  color: var(--rh-fg) !important;
  border: 1px solid var(--rh-card-edge) !important;
  border-radius: 16px !important;
  box-shadow: 0 20px 60px var(--rh-shadow) !important;
  overflow: hidden;
}

/* ── 左侧功能列 + 右侧内容区 ──
   加了功能列之后面板要更宽：480px 是原来只有一列标签栏时的宽度，塞不下"左列 + 内容"。 */
.rh-card {
  /* 默认铺满视口，照数据库脚本 `.acu-window.maximized` 的规格：
     四周留 10px（窄屏 5px，见下面的 1100px 断点；≤720px 那条已改成真全屏、不留边距）。
     面板里五页内容又多又长，收成一张小窗时每页都得缩着滚。 */
  width: calc(100vw - 20px);
  max-width: none;
  height: calc(100vh - 20px);
  height: calc(100dvh - 20px);
  max-height: none;
}

@media screen and (max-width: 1100px) {
  .rh-mask {
    padding: 5px !important;
  }

  .rh-card {
    width: calc(100vw - 10px);
    height: calc(100vh - 10px);
    height: calc(100dvh - 10px);
    border-radius: 8px !important;
  }
}

.rh-body-wrap {
  display: flex;
  flex: 1 1 auto;
  min-height: 0; /* 让下面的滚动区能真正滚起来，而不是把卡片撑高 */
}

.rh-main-col {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
}

/* 功能列：竖排两个按钮，选中那个左侧亮一条紫杠 */
.rh-rail {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: 0 0 auto;
  width: 108px;
  padding: 12px 8px;
  border-right: 1px solid var(--rh-line-soft) !important;
  background-color: var(--rh-bg-soft) !important;
}

.rh-rail-btn {
  position: relative;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 9px 10px;
  border: 1px solid transparent !important;
  border-radius: 9px !important;
  background: transparent !important;
  color: var(--rh-fg-mid) !important;
  font-family: var(--rh-font) !important;
  font-size: 13px !important;
  font-weight: 500 !important;
  text-align: left;
  cursor: pointer;
  transition: background-color 0.15s, color 0.15s;
}

.rh-rail-btn:hover {
  background-color: var(--rh-bg-hover) !important;
  color: var(--rh-fg) !important;
}

.rh-rail-btn.active {
  background-color: var(--rh-accent-wash) !important;
  border-color: var(--rh-accent-ring) !important;
  color: var(--rh-accent-deep) !important;
  font-weight: 600 !important;
}

.rh-rail-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: 0 0 auto;
  background-color: var(--rh-line-dashed) !important;
  transition: background-color 0.15s, box-shadow 0.15s;
}

.rh-rail-btn.active .rh-rail-dot {
  background-color: var(--rh-accent) !important;
  box-shadow: 0 0 0 3px var(--rh-accent-ring);
}

/* 剧情推进页内部也有自己的标签栏（4 页），窄一点、贴着内容区顶部 */
.rh-tabs-inner {
  border-bottom: 1px solid var(--rh-line-soft) !important;
}

.rh-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 18px 12px;
  border-bottom: 1px solid var(--rh-line-soft) !important;
}

.rh-head-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: none;
}

/* 主题选择：右上角，跟工作流助手的主题开关同一位置 */
.rh-theme-pick {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--rh-fg-dim) !important;
}

.rh-theme-sel {
  padding: 4px 8px;
  font-size: 12px;
  line-height: 1.4;
  color: var(--rh-fg) !important;
  background-color: var(--rh-bg-pure) !important;
  border: 1px solid var(--rh-line-input) !important;
  border-radius: 8px !important;
  cursor: pointer;
}

.rh-theme-sel:focus {
  outline: none !important;
  border-color: var(--rh-accent) !important;
  box-shadow: 0 0 0 2px var(--rh-accent-ring) !important;
}

.rh-card-title {
  font-size: 16px;
  font-weight: 700;
  color: var(--rh-fg) !important;
}

/* 自绘刷新图标：不依赖酒馆的 FontAwesome 字体，酒馆换 FA 版本也不会失效 */
.rh-ico {
  width: 1em;
  height: 1em;
  flex: none;
  display: inline-block;
  vertical-align: -0.1em;
}

.rh-ico path {
  fill: none !important;
  stroke: currentColor !important;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.rh-card-title .rh-ico {
  margin-right: 6px;
  color: var(--rh-accent) !important;
}

.rh-x {
  border: none !important;
  border-color: transparent !important;
  background-color: transparent !important;
  color: var(--rh-fg-dim) !important;
  font-size: 20px !important;
  line-height: 1 !important;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 8px;
  box-shadow: none !important;
}

.rh-x:hover {
  background-color: var(--rh-bg-hover) !important;
  color: var(--rh-fg) !important;
}

.rh-tabs {
  display: flex;
  gap: 4px;
  padding: 8px 12px 0;
  border-bottom: 1px solid var(--rh-line-soft) !important;
}

.rh-tab {
  border: none !important;
  border-color: transparent !important;
  background-color: transparent !important;
  color: var(--rh-fg-dim) !important;
  font-size: 13px !important;
  font-weight: 600 !important;
  padding: 8px 12px;
  cursor: pointer;
  border-radius: 8px 8px 0 0 !important;
  border-bottom: 2px solid transparent !important;
  box-shadow: none !important;
}

.rh-tab.active {
  color: var(--rh-accent) !important;
  border-bottom-color: var(--rh-accent) !important;
}

.rh-card-body {
  flex: 1;
  overflow-y: auto;
  padding: 14px 16px;
}

.rh-block {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.rh-note {
  margin: 0 !important;
  font-size: 12px !important;
  color: var(--rh-fg-dim) !important;
  line-height: 1.55 !important;
  white-space: pre-line !important;
}

.rh-note-alert {
  color: var(--rh-danger) !important;
  font-weight: 600;
}

.rh-line {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.rh-line label {
  font-size: 14px;
  font-weight: 600;
  color: var(--rh-fg-soft) !important;
}

.rh-line select,
.rh-field input,
.rh-form input,
.rh-form textarea {
  border: 1px solid var(--rh-line-input) !important;
  border-radius: 8px !important;
  padding: 6px 8px;
  font-size: 13px !important;
  background-color: var(--rh-bg-soft) !important;
  color: var(--rh-fg) !important;
  outline: none !important;
  box-shadow: none !important;
}

.rh-line select:focus,
.rh-field input:focus,
.rh-form input:focus,
.rh-form textarea:focus {
  border-color: var(--rh-accent) !important;
  box-shadow: 0 0 0 3px var(--rh-accent-ring) !important;
}

.rh-pair {
  display: flex;
  gap: 16px;
  margin-top: 6px;
}

.rh-trio {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 14px;
}

.rh-trio .rh-field input {
  width: 68px;
}

.rh-split {
  height: 1px;
  margin: 4px 0;
  background-color: var(--rh-line-soft) !important;
}

.rh-field {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--rh-fg-soft) !important;
}

.rh-field input {
  width: 64px;
  text-align: center;
}

.rh-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px;
  border: 1px solid var(--rh-line) !important;
  border-radius: 12px !important;
  background-color: var(--rh-bg-soft) !important;
  cursor: grab;
  /* 触屏上条目本身仍可上下滑动列表，只有按住的 ⠿ 才转成拖拽 */
  touch-action: pan-y;
}

/* 正在被拖的那一条：留在流里（顺序已实时换好），只做醒目标记 */
.rh-item.pulling {
  cursor: grabbing;
  border-color: var(--rh-accent) !important;
  background-color: var(--rh-accent-wash) !important;
  box-shadow: 0 4px 14px rgb(0 0 0 / 16%) !important;
}

/* 拖到手势进行中：整块列表禁掉文字选中，免得拖一次就糊蓝一片 */
.rh-pick {
  user-select: none;
}

.rh-grip {
  color: var(--rh-fg-faint) !important;
  font-size: 14px;
  line-height: 1;
  user-select: none;
  /* 内边距把可抓方块撑到约 26×30px，再用负 margin 抵回来：⠿ 的字形位置与改前一致
     （上缘 -5 + 8 = 原来那条 margin-top: 3px 的效果） */
  padding: 8px 6px;
  margin: -5px -6px 3px;
  cursor: grab;
  touch-action: none;
}

.rh-rank {
  flex: none;
  width: 20px;
  height: 20px;
  margin-top: 1px;
  border-radius: 50% !important;
  background-color: var(--rh-accent) !important;
  color: var(--rh-bg) !important;
  font-size: 12px !important;
  font-weight: 700 !important;
  line-height: 20px;
  text-align: center;
}

.rh-item-main {
  flex: 1;
  min-width: 0;
}

.rh-item-name {
  font-weight: 700;
  font-size: 14px;
  color: var(--rh-fg) !important;
}

.rh-item-pattern {
  display: block;
  margin-top: 4px;
  font-family: var(--rh-font-mono) !important;
  font-size: 12px !important;
  color: var(--rh-fg-mid) !important;
  background-color: var(--rh-bg-pure) !important;
  border: 1px solid var(--rh-line) !important;
  border-radius: 6px !important;
  padding: 3px 6px;
  overflow-wrap: anywhere;
}

.rh-item-note {
  margin-top: 4px;
  font-size: 12px;
  color: var(--rh-fg-dim) !important;
}

.rh-item-ops {
  display: flex;
  gap: 4px;
}

.rh-item-ops button {
  border: 1px solid var(--rh-line) !important;
  background-color: var(--rh-bg-pure) !important;
  color: var(--rh-fg-soft) !important;
  border-radius: 6px !important;
  font-size: 13px !important;
  box-shadow: none !important;
  cursor: pointer;
  padding: 2px 6px;
}

.rh-item-ops button:hover {
  background-color: var(--rh-accent-wash) !important;
  color: var(--rh-accent-deep) !important;
}

.rh-plus {
  align-self: flex-start;
  border: 1px dashed var(--rh-line-dashed) !important;
  background-color: transparent !important;
  color: var(--rh-accent) !important;
  font-size: 13px !important;
  padding: 6px 12px;
  border-radius: 8px !important;
  box-shadow: none !important;
  cursor: pointer;
}

.rh-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--rh-accent) !important;
  border-radius: 12px !important;
  background-color: var(--rh-accent-wash-soft) !important;
}

.rh-form-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.rh-form-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--rh-fg-mid) !important;
}

.rh-form-tip {
  font-size: 11px;
  color: var(--rh-fg-faint) !important;
}

.rh-form-pattern {
  font-family: var(--rh-font-mono) !important;
}

.rh-form textarea {
  resize: vertical;
  min-height: 48px;
}

.rh-form-ops {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.rh-form-ops button {
  border: 1px solid var(--rh-line-input) !important;
  background-color: var(--rh-bg-pure) !important;
  color: var(--rh-fg-soft) !important;
  border-radius: 8px !important;
  padding: 5px 12px;
  cursor: pointer;
  font-size: 13px !important;
  box-shadow: none !important;
}

.rh-form-ops button:hover:not(:disabled) {
  background-color: var(--rh-accent-wash) !important;
  color: var(--rh-accent-deep) !important;
}

.rh-form-ops button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.rh-logbox {
  position: relative;
  margin-top: 8px;
}

.rh-log {
  width: 100%;
  height: 200px;
  resize: none;
  border: 1px solid var(--rh-line) !important;
  border-radius: 10px !important;
  padding: 10px;
  font-family: var(--rh-font-mono) !important;
  font-size: 11px !important;
  line-height: 1.5 !important;
  background-color: var(--rh-bg-soft) !important;
  color: var(--rh-fg-soft) !important;
  outline: none !important;
  box-shadow: none !important;
  white-space: pre-wrap !important;
}

.rh-log-wipe {
  position: absolute;
  top: 8px;
  right: 8px;
  border: none !important;
  border-color: transparent !important;
  background-color: var(--rh-scrim-btn) !important;
  color: var(--rh-bg) !important;
  border-radius: 6px !important;
  padding: 3px 8px;
  font-size: 11px !important;
  box-shadow: none !important;
  cursor: pointer;
}

.rh-card-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px 16px;
  border-top: 1px solid var(--rh-line-soft) !important;
}

/* 「有改动还没保存」——靠左顶住，别把右边四个按钮挤乱（窄屏时它会独占一行） */
.rh-dirty-hint {
  margin-right: auto;
  align-self: center;
  font-size: 12px;
  color: var(--rh-danger);
  white-space: nowrap;
}

.rh-act {
  border: none !important;
  border-color: transparent !important;
  border-radius: 10px !important;
  padding: 8px 14px;
  font-size: 13px !important;
  font-weight: 600 !important;
  box-shadow: none !important;
  cursor: pointer;
}

.rh-act-plain {
  background-color: var(--rh-bg-hover) !important;
  color: var(--rh-fg-mid) !important;
}

.rh-act-plain:hover {
  background-color: var(--rh-line) !important;
}

.rh-act-go {
  background-color: var(--rh-accent) !important;
  color: var(--rh-bg) !important;
}

.rh-act-go:hover {
  background-color: var(--rh-accent-deep) !important;
}

/* ══════════════════════════════════════════════════════════════════════════
   剧情推进页（PlotPage.vue）专用的几个样式。
   那个组件自己不带 <style>：样式留在本文件末尾，和面板其余部分用同一套
   --rh-* 令牌，将来换主题只改这一处。
   ══════════════════════════════════════════════════════════════════════════ */

/* 小号按钮：刷新、导入、新增这类次要动作用，不和底部的保存按钮抢注意力 */
.rh-mini {
  padding: 3px 9px;
  border: 1px solid var(--rh-line-input) !important;
  border-radius: 7px !important;
  background-color: var(--rh-bg-pure) !important;
  color: var(--rh-fg-mid) !important;
  font-family: var(--rh-font) !important;
  font-size: 12px !important;
  cursor: pointer;
  transition: background-color 0.15s, color 0.15s, border-color 0.15s;
}

.rh-mini:hover {
  background-color: var(--rh-accent-wash) !important;
  border-color: var(--rh-accent) !important;
  color: var(--rh-accent-deep) !important;
}

.rh-rowbtns {
  display: flex;
  gap: 8px;
  margin: 8px 0 4px;
}

/* 预设的单选清单 */
.rh-picklist {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 6px 0;
}

.rh-pick {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 5px 8px;
  border: 1px solid var(--rh-line-soft) !important;
  border-radius: 8px !important;
  background-color: var(--rh-bg-pure) !important;
  cursor: pointer;
  user-select: none;
  font-size: 12.5px;
}

.rh-pick input {
  accent-color: var(--rh-accent);
  margin: 0;
}

.rh-pick-name {
  color: var(--rh-fg) !important;
  min-width: 0;
  overflow-wrap: anywhere;
}

/* 本地预设库的一行：选择 + 来源体积 + 删除 */
.rh-stored {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.rh-stored .rh-pick {
  flex: 1 1 auto;
  min-width: 0;
}

.rh-stored-meta {
  flex: 0 0 auto;
  color: var(--rh-fg-dim);
  font-size: 11.5px;
  white-space: nowrap;
}

/* 任务卡片 */
.rh-task {
  padding: 8px 10px;
  margin-bottom: 7px;
  border: 1px solid var(--rh-line-soft) !important;
  border-radius: 9px !important;
  background-color: var(--rh-bg-pure) !important;
}

.rh-task.off {
  opacity: 0.6;
}

.rh-task-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.rh-task-name {
  font-weight: 600 !important;
  font-size: 12.5px;
  color: var(--rh-fg) !important;
  min-width: 0;
  overflow-wrap: anywhere;
}

.rh-task-badge,
.rh-task-stage {
  flex: none;
  padding: 1px 7px;
  border-radius: 999px !important;
  font-size: 11px !important;
  background-color: var(--rh-accent-wash) !important;
  color: var(--rh-accent-deep) !important;
}

.rh-task-stage {
  background-color: var(--rh-bg-soft) !important;
  color: var(--rh-fg-dim) !important;
}

.rh-task-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 5px;
  font-size: 11.5px;
  color: var(--rh-fg-dim) !important;
  overflow-wrap: anywhere;
}

/* API 配置卡片 */
.rh-api {
  padding: 9px 11px;
  margin-bottom: 9px;
  border: 1px solid var(--rh-line-soft) !important;
  border-radius: 10px !important;
  background-color: var(--rh-bg-pure) !important;
}

.rh-api.live {
  border-color: var(--rh-accent-ring) !important;
  background-color: var(--rh-accent-wash-soft) !important;
}

.rh-api-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.rh-api-use {
  display: flex;
  align-items: center;
  gap: 5px;
  flex: none;
}

.rh-api-use input {
  accent-color: var(--rh-accent);
  margin: 0;
}

.rh-api-badge {
  padding: 1px 7px;
  border-radius: 999px !important;
  font-size: 11px !important;
  background-color: var(--rh-accent) !important;
  color: #fff !important;
}

.rh-api-name {
  flex: 1 1 auto;
  min-width: 0;
  border: 1px solid var(--rh-line-input) !important;
  border-radius: 8px !important;
  padding: 5px 8px;
  font-size: 12.5px !important;
  font-weight: 600 !important;
  background-color: var(--rh-bg-pure) !important;
  color: var(--rh-fg) !important;
  outline: none !important;
}

.rh-api-drop {
  flex: none;
  width: 24px;
  height: 24px;
  border: 1px solid var(--rh-line-soft) !important;
  border-radius: 6px !important;
  background-color: transparent !important;
  color: var(--rh-danger) !important;
  font-size: 13px !important;
  line-height: 1;
  cursor: pointer;
}

.rh-api-drop:hover {
  background-color: rgba(180, 35, 24, 0.08) !important;
  border-color: var(--rh-danger) !important;
}

.rh-api-mode {
  display: flex;
  gap: 8px;
  margin: 8px 0;
}

.rh-api-mode .rh-pick {
  flex: 1 1 auto;
}

.rh-api-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.rh-api-row label {
  flex: 0 0 72px;
  font-size: 12px;
  color: var(--rh-fg-dim) !important;
}

.rh-api-row input {
  flex: 1 1 auto;
  min-width: 0;
  border: 1px solid var(--rh-line-input) !important;
  border-radius: 8px !important;
  padding: 5px 8px;
  font-size: 12px !important;
  font-family: var(--rh-font-mono) !important;
  background-color: var(--rh-bg-pure) !important;
  color: var(--rh-fg) !important;
  outline: none !important;
}

.rh-api-trio {
  display: flex;
  gap: 8px;
}

.rh-api-from {
  margin: 7px 0 0;
  font-size: 11px;
  color: var(--rh-fg-faint) !important;
}

/* 超时输入框：贴着行尾，不展开占满整行 */
.rh-timeout-input {
  width: 88px;
  border: 1px solid var(--rh-line-input) !important;
  border-radius: 8px !important;
  padding: 5px 8px;
  font-size: 12px !important;
  background-color: var(--rh-bg-pure) !important;
  color: var(--rh-fg) !important;
  outline: none !important;
}

/* ══════════════════════════════════════════════════════════════════════════
   预设编辑器（PresetEditor.vue / TaskEditor.vue / PresetIo.vue）。
   三个组件同样不带 <style>，理由见本节开头。
   ══════════════════════════════════════════════════════════════════════════ */

/* 编辑区外壳：一圈强调色边框，跟「只读展示」的区域区分开 */
.rh-editor-shell {
  padding: 10px 12px;
  border: 1px solid var(--rh-accent-ring) !important;
  border-radius: 10px !important;
  background-color: var(--rh-accent-wash-soft) !important;
}

.rh-editor-title {
  margin: 10px 0 6px;
  font-size: 12.5px;
  font-weight: 600 !important;
  color: var(--rh-fg) !important;
}

/* 一排数字输入框（召回/轮数/字数/四档强度） */
.rh-editor-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 6px 0;
}

.rh-editor-grid .rh-field {
  flex: 1 1 96px;
  min-width: 96px;
}

/* 一段提示词 / 一个任务 */
.rh-editor-slot,
.rh-editor-task {
  margin: 8px 0;
  padding: 8px 10px;
  border: 1px solid var(--rh-line-soft) !important;
  border-radius: 9px !important;
  background-color: var(--rh-bg-pure) !important;
}

.rh-editor-task.off {
  opacity: 0.65;
}

.rh-editor-label {
  display: block;
  margin: 7px 0 4px;
  font-size: 12px;
  color: var(--rh-fg-dim) !important;
}

/* 提示词正文：等宽字体，让用户看得清缩进和标签 */
.rh-textarea {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid var(--rh-line-input) !important;
  border-radius: 8px !important;
  padding: 6px 8px;
  font-family: var(--rh-font-mono) !important;
  font-size: 12px !important;
  line-height: 1.5;
  background-color: var(--rh-bg-pure) !important;
  color: var(--rh-fg) !important;
  outline: none !important;
  resize: vertical;
}

/* 替换结果预览：只读、可滚动，长模板不至于把面板撑爆 */
.rh-preview {
  margin: 5px 0 0;
  padding: 7px 9px;
  max-height: 220px;
  overflow: auto;
  border-radius: 8px !important;
  background-color: var(--rh-bg-soft) !important;
  color: var(--rh-fg-mid) !important;
  font-family: var(--rh-font-mono) !important;
  font-size: 11.5px;
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

/* 一条边界规则：起点 + 终点 + 删除 */
.rh-rule {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 5px;
}

.rh-rule input {
  flex: 1 1 0;
  min-width: 0;
  border: 1px solid var(--rh-line-input) !important;
  border-radius: 8px !important;
  padding: 4px 8px;
  font-family: var(--rh-font-mono) !important;
  font-size: 11.5px !important;
  background-color: var(--rh-bg-pure) !important;
  color: var(--rh-fg) !important;
  outline: none !important;
}

/* 一块提示词 */
.rh-blockrow {
  margin: 6px 0;
  padding: 7px 9px;
  border: 1px solid var(--rh-line-soft) !important;
  border-radius: 8px !important;
  background-color: var(--rh-bg-soft) !important;
}

.rh-blockrow.off {
  opacity: 0.55;
}

.rh-blockrow-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 5px;
}

.rh-block-role,
.rh-block-name {
  border: 1px solid var(--rh-line-input) !important;
  border-radius: 6px !important;
  padding: 3px 6px;
  font-size: 11.5px !important;
  background-color: var(--rh-bg-pure) !important;
  color: var(--rh-fg) !important;
  outline: none !important;
}

.rh-block-role {
  flex: 0 0 84px;
}

.rh-block-name {
  flex: 1 1 auto;
  min-width: 0;
}

/* 文件选择框本身不显示：样式统一的按钮去触发它 */
.rh-hidden-file {
  display: none;
}

/* ══════════════════════════════════════════════════════════════════════════
   剧情推进页的结构件 —— 移植自工作流助手 `ui/acu-theme.css`

   为什么是移植而不是自己写：那套界面是同一条业务链上的成熟实现（工作流助手本身
   就是数据库剧情推进的二创），分区、间距、控件形态都经过长期使用检验。照抄它的
   结构与数值，比重新发明一套更省事，也更不容易长歪。

   两条改动，其余原样：
     1. 令牌换成宿主颜色 —— 原文件用 --acu-* 变量（由 ui/theme.ts 注入奶油/深色两套
        主题），这里统一映射到本面板既有的 --rh-* 配色，外观与面板其余部分保持一致。
     2. 作用域加 .rh-card 前缀，且视觉属性带 !important —— 理由同本文件开头那段
        隔离层说明：酒馆主题会直接命中控件，必须钉死；前缀则防止这套新规则反过来
        影响推进重刷页。
   ══════════════════════════════════════════════════════════════════════════ */

.rh-card {
  --acu-bg-0: var(--rh-bg);
  --acu-bg-1: var(--rh-bg-pure);
  --acu-bg-2: var(--rh-bg-soft);
  --acu-bg-3: var(--rh-bg-hover);
  --acu-border: var(--rh-line);
  --acu-border-2: var(--rh-line-input);
  --acu-text-1: var(--rh-fg);
  --acu-text-2: var(--rh-fg-soft);
  --acu-text-3: var(--rh-fg-dim);
  --acu-accent: var(--rh-accent);
  --acu-accent-2: var(--rh-accent-deep);
  --acu-on-accent: #fefeff;
  --acu-accent-glow: var(--rh-accent-ring);
  --acu-success: var(--rh-ok);
  --acu-warning: #b45309;
  --acu-danger: var(--rh-danger);
  --acu-hover-overlay: rgba(16, 18, 27, 0.06);
  --acu-radius-lg: 12px;
  --acu-radius-md: 10px;
  --acu-radius-sm: 8px;
  --acu-shadow: 0 12px 32px var(--rh-shadow);
  --acu-font-ui: var(--rh-font);
  --acu-font-mono: var(--rh-font-mono);
  --acu-font-size-caption: 11px;
  --acu-font-size-body: 12px;
  --acu-font-size-body-lg: 13px;
  --acu-font-size-panel-title: 14px;
  --acu-line-height-body: 1.45;
}

/* ── 分页标签 ── */
.rh-card .acu-page-tabs {
  display: flex !important;
  gap: 4px !important;
  padding: 10px 14px !important;
  background: var(--acu-bg-1) !important;
  border-bottom: 1px solid var(--acu-border) !important;
  /* 照工作流助手：页签在内容滚动时钉在顶部（滚动容器是 .rh-card-body） */
  position: sticky !important;
  top: 0 !important;
  z-index: 3 !important;
}

.rh-card .acu-page-tab {
  flex: 1 !important;
  border: 0 !important;
  background: transparent !important;
  padding: 8px 10px !important;
  font-family: inherit !important;
  font-size: var(--acu-font-size-body-lg) !important;
  color: var(--acu-text-3) !important;
  cursor: pointer !important;
  border-radius: var(--acu-radius-sm) !important;
  transition: background 0.15s ease, color 0.15s ease;
}

.rh-card .acu-page-tab:hover {
  color: var(--acu-text-1) !important;
  background: var(--acu-hover-overlay) !important;
}

.rh-card .acu-page-tab__short {
  display: none;
}

.rh-card .acu-page-tab.active {
  color: var(--acu-on-accent) !important;
  background: var(--acu-accent) !important;
  font-weight: 600 !important;
}

.rh-card .acu-page {
  min-height: 200px !important;
  width: 100% !important;
}

/* ── 区块 ── */
.rh-card .acu-section {
  display: flex !important;
  flex-direction: column !important;
  align-items: stretch !important;
  width: 100% !important;
  padding: 16px !important;
  margin-bottom: 14px !important;
  background: var(--acu-bg-1) !important;
  border: 1px solid var(--acu-border) !important;
  border-radius: var(--acu-radius-md) !important;
}

.rh-card .acu-section h4 {
  margin: 0 0 10px !important;
  font-size: var(--acu-font-size-panel-title) !important;
  font-weight: 600 !important;
  line-height: 1.3 !important;
  color: var(--acu-text-1) !important;
}

.rh-card .acu-row {
  display: flex !important;
  gap: 8px !important;
  align-items: center !important;
  flex-wrap: wrap !important;
  width: 100% !important;
  min-width: 0 !important;
  margin-bottom: 8px !important;
}

.rh-card .acu-row--inline {
  flex-wrap: nowrap !important;
}

/*
 行内字段名。
 固定一列宽、不换行：否则「这个任务的最终指令」这种长标签会折成两截，
 而「最少字数」这类短标签又会被前面几个输入框挤到下一行去。
*/
.rh-card .rh-field-label {
  flex: 0 0 auto !important;
  white-space: nowrap !important;
}

.rh-card .acu-row label {
  color: var(--acu-text-2) !important;
  font-size: var(--acu-font-size-body) !important;
}

.rh-card .acu-notes {
  margin-bottom: 8px !important;
  font-size: var(--acu-font-size-body) !important;
  line-height: var(--acu-line-height-body) !important;
  color: var(--acu-text-3) !important;
}

.rh-card .acu-notes--sm {
  margin-bottom: 4px !important;
  font-size: var(--acu-font-size-caption) !important;
}

/* 提示文字的三档语气：账本读坏了/保存失败要红，操作成功要绿，其余警示用橙。
   暂存面板用它们区分三句话，否则三句长得一样，用户看不出哪句是坏消息。 */

/* 世界书勾选列表：一列铺开、能滚，书多的时候不至于把页面顶到很远 */
.rh-card .acu-wb-list {
  display: flex !important;
  flex-direction: column !important;
  gap: 6px !important;
  max-height: 220px !important;
  overflow-y: auto !important;
  padding: 8px 10px !important;
  border: 1px solid var(--acu-border) !important;
  border-radius: 10px !important;
  background: var(--acu-bg-2) !important;
}

.rh-card .acu-wb-item {
  display: flex !important;
  align-items: center !important;
  gap: 8px !important;
  font-size: 13px !important;
  line-height: 1.4 !important;
  white-space: normal !important;
  overflow-wrap: anywhere !important;
}

/* 条目级勾选：跟书单长得像，但一本书一个块，条目多了在框里滚 */
.rh-card .acu-wb-entries {
  display: flex !important;
  flex-direction: column !important;
  gap: 6px !important;
  margin-top: 10px !important;
}

.rh-card .acu-wb-entry-box {
  display: flex !important;
  flex-direction: column !important;
  gap: 10px !important;
  max-height: 340px !important;
  overflow-y: auto !important;
  padding: 10px 12px !important;
  border: 1px solid var(--acu-border) !important;
  border-radius: 10px !important;
  background: var(--acu-bg-2) !important;
}

.rh-card .acu-wb-entry-book {
  display: flex !important;
  flex-direction: column !important;
  gap: 4px !important;
}

/* 书名行：书名长了会换行，别把按钮挤成竖排 */
.rh-card .acu-wb-entry-head {
  display: flex !important;
  flex-wrap: wrap !important;
  align-items: center !important;
  gap: 6px !important;
  padding-bottom: 4px !important;
  border-bottom: 1px dashed var(--acu-border) !important;
}

.rh-card .acu-wb-entry-name {
  font-size: 13px !important;
  font-weight: 600 !important;
  line-height: 1.4 !important;
  white-space: normal !important;
  overflow-wrap: anywhere !important;
}

.rh-card .acu-wb-entry-tag {
  flex: 0 0 auto !important;
  padding: 0 5px !important;
  border: 1px solid var(--acu-border) !important;
  border-radius: 6px !important;
  font-size: 11px !important;
  line-height: 16px !important;
  opacity: 0.75 !important;
  white-space: nowrap !important;
}

.rh-card .acu-wb-entry-item {
  display: flex !important;
  align-items: flex-start !important;
  gap: 6px !important;
  padding-left: 2px !important;
  font-size: 13px !important;
  line-height: 1.45 !important;
  white-space: normal !important;
  overflow-wrap: anywhere !important;
}

.rh-card .acu-wb-entry-item input {
  flex: 0 0 auto !important;
  margin-top: 3px !important;
}

/* 本来就不进上下文的条目：灰掉，勾也勾不上，省得有人以为勾回来就能救 */
.rh-card .acu-wb-entry-item--off {
  opacity: 0.45 !important;
}

.rh-card .acu-notes--warn {
  color: var(--acu-warning) !important;
}

.rh-card .acu-notes--error {
  color: var(--acu-danger) !important;
}

.rh-card .acu-notes--ok {
  color: var(--acu-success) !important;
}

/* ── 表单控件 ── */
.rh-card .acu-input:not([type='checkbox']):not([type='radio']),
.rh-card .acu-select,
.rh-card .acu-textarea {
  min-height: 32px !important;
  padding: 6px 9px !important;
  border: 1px solid var(--acu-border) !important;
  border-radius: var(--acu-radius-sm) !important;
  background-color: var(--acu-bg-2) !important;
  color: var(--acu-text-1) !important;
  font: inherit !important;
  font-size: var(--acu-font-size-body) !important;
  caret-color: var(--acu-text-1) !important;
}

.rh-card .acu-input:focus,
.rh-card .acu-select:focus,
.rh-card .acu-textarea:focus {
  outline: none !important;
  border-color: var(--acu-accent) !important;
  box-shadow: 0 0 0 2px var(--acu-accent-glow) !important;
}

.rh-card .acu-select {
  appearance: none !important;
  -webkit-appearance: none !important;
  padding-right: 28px !important;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23616b79' d='M2.5 4.5 6 8l3.5-3.5'/%3E%3C/svg%3E") !important;
  background-repeat: no-repeat !important;
  background-position: right 8px center !important;
  background-size: 12px !important;
}

.rh-card .acu-select option {
  background-color: var(--acu-bg-1) !important;
  color: var(--acu-text-1) !important;
}

.rh-card .acu-textarea {
  width: 100% !important;
  min-height: 96px !important;
  padding: 8px 10px !important;
  line-height: var(--acu-line-height-body) !important;
  resize: vertical !important;
}

.rh-card .acu-input::placeholder,
.rh-card .acu-textarea::placeholder {
  color: var(--acu-text-3) !important;
  opacity: 1 !important;
}

/* ── 开关 ── */
.rh-card .acu-toggle {
  position: relative !important;
  display: inline-flex !important;
  align-items: center !important;
  gap: 10px !important;
  cursor: pointer !important;
  user-select: none !important;
  color: var(--acu-text-1) !important;
  flex: 0 0 auto !important;
}

.rh-card .acu-toggle__input[type='checkbox'] {
  position: absolute !important;
  width: 1px !important;
  height: 1px !important;
  margin: -1px !important;
  padding: 0 !important;
  overflow: hidden !important;
  clip-path: inset(50%) !important;
  opacity: 0 !important;
  pointer-events: none !important;
}

.rh-card .acu-toggle__track {
  position: relative !important;
  flex: 0 0 auto !important;
  width: 44px !important;
  height: 26px !important;
  border-radius: 999px !important;
  background: var(--acu-bg-3) !important;
  border: 1px solid var(--acu-border) !important;
  transition: background 0.2s ease, border-color 0.2s ease !important;
}

.rh-card .acu-toggle__track::after {
  content: '' !important;
  position: absolute !important;
  top: 2px !important;
  left: 2px !important;
  width: 20px !important;
  height: 20px !important;
  border-radius: 50% !important;
  background: #ffffff !important;
  box-shadow: 0 1px 3px rgba(16, 18, 27, 0.28) !important;
  transition: transform 0.2s ease !important;
}

.rh-card .acu-toggle:has(.acu-toggle__input:checked) .acu-toggle__track {
  background: var(--acu-accent) !important;
  border-color: var(--acu-accent) !important;
}

.rh-card .acu-toggle:has(.acu-toggle__input:checked) .acu-toggle__track::after {
  transform: translateX(18px) !important;
}

.rh-card .acu-toggle__label {
  font-size: var(--acu-font-size-body-lg) !important;
  line-height: 1.35 !important;
  color: var(--acu-text-1) !important;
  overflow-wrap: anywhere !important;
}

/* ── 按钮 ── */
.rh-card .acu-btn {
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  gap: 6px !important;
  min-height: 32px !important;
  padding: 6px 12px !important;
  border: 0 !important;
  border-radius: var(--acu-radius-sm) !important;
  background: var(--acu-bg-2) !important;
  color: var(--acu-text-1) !important;
  font: inherit !important;
  font-size: var(--acu-font-size-body-lg) !important;
  cursor: pointer !important;
  transition: background 0.15s ease, color 0.15s ease, opacity 0.15s ease;
}

.rh-card .acu-btn:hover:not(:disabled) {
  background: var(--acu-bg-3) !important;
}

.rh-card .acu-btn:disabled {
  opacity: 0.5 !important;
  cursor: not-allowed !important;
}

.rh-card .acu-btn.primary {
  background: var(--acu-accent) !important;
  color: var(--acu-on-accent) !important;
  font-weight: 500 !important;
}

.rh-card .acu-btn.danger {
  background: rgba(180, 35, 24, 0.1) !important;
  color: var(--acu-danger) !important;
}

.rh-card .acu-btn--sm {
  min-height: 28px !important;
  padding: 4px 10px !important;
  font-size: var(--acu-font-size-body) !important;
}

/* ── 任务卡片行 ── */
.rh-card .acu-task-tabs {
  display: flex !important;
  flex-wrap: wrap !important;
  align-items: center !important;
  gap: 6px !important;
  margin-bottom: 10px !important;
}

.rh-card .task-card {
  display: inline-flex !important;
  align-items: center !important;
  gap: 6px !important;
  padding: 7px 12px !important;
  border: 0 !important;
  border-radius: var(--acu-radius-sm) !important;
  background: var(--acu-bg-2) !important;
  color: var(--acu-text-2) !important;
  font-size: var(--acu-font-size-body) !important;
  cursor: pointer !important;
}

.rh-card .task-card:hover {
  background: var(--acu-bg-3) !important;
  color: var(--acu-text-1) !important;
}

.rh-card .task-card.active {
  background: var(--acu-accent) !important;
  color: var(--acu-on-accent) !important;
  font-weight: 600 !important;
}

.rh-card .task-card__stage {
  flex: 0 0 auto !important;
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  min-width: 22px !important;
  padding: 1px 6px !important;
  border-radius: 999px !important;
  background: rgba(124, 58, 237, 0.14) !important;
  color: var(--rh-accent-deep) !important;
  font-size: var(--acu-font-size-caption) !important;
  font-weight: 600 !important;
  line-height: 1.4 !important;
}

.rh-card .task-card.active .task-card__stage {
  background: rgba(255, 255, 255, 0.24) !important;
  color: var(--acu-on-accent) !important;
}

.rh-card .task-card__name {
  min-width: 0 !important;
}

.rh-card .task-card__flag {
  flex: 0 0 auto !important;
  padding: 1px 6px !important;
  border-radius: 999px !important;
  background: rgba(180, 83, 9, 0.16) !important;
  color: var(--acu-warning) !important;
  font-size: var(--acu-font-size-caption) !important;
  font-weight: 600 !important;
  line-height: 1.4 !important;
}

.rh-card .task-card__move {
  flex: 0 0 auto !important;
  width: 20px !important;
  height: 20px !important;
  padding: 0 !important;
  border: 0 !important;
  border-radius: 4px !important;
  background: rgba(255, 255, 255, 0.22) !important;
  color: inherit !important;
  font-size: 10px !important;
  line-height: 1 !important;
  cursor: pointer !important;
}

.rh-card .task-card__move:disabled {
  opacity: 0.35 !important;
  cursor: not-allowed !important;
}

/* ── 提示词块（折叠卡） ── */
.rh-card .acu-prompt-group {
  margin-bottom: 10px !important;
  border: 1px solid var(--acu-border) !important;
  border-radius: var(--acu-radius-sm) !important;
  overflow: hidden !important;
  background: var(--acu-bg-2) !important;
}

.rh-card .acu-prompt-group--disabled {
  opacity: 0.72 !important;
}

.rh-card .acu-prompt-group__header-row {
  display: flex !important;
  align-items: stretch !important;
  width: 100% !important;
  min-width: 0 !important;
}

.rh-card .acu-prompt-group__header {
  display: flex !important;
  align-items: center !important;
  gap: 8px !important;
  flex: 1 1 auto !important;
  min-width: 0 !important;
  padding: 10px 12px !important;
  border: 0 !important;
  background: transparent !important;
  color: inherit !important;
  font: inherit !important;
  text-align: left !important;
  cursor: pointer !important;
}

.rh-card .acu-prompt-group__header:hover {
  background: var(--acu-hover-overlay) !important;
}

.rh-card .acu-prompt-group__header-main {
  display: flex !important;
  align-items: center !important;
  gap: 8px !important;
  flex: 1 1 auto !important;
  min-width: 0 !important;
  overflow: hidden !important;
}

.rh-card .acu-prompt-group__header-name {
  flex: 1 1 auto !important;
  min-width: 0 !important;
  overflow: hidden !important;
  text-overflow: ellipsis !important;
  white-space: nowrap !important;
  font-size: var(--acu-font-size-body) !important;
  font-weight: 600 !important;
  color: var(--acu-text-1) !important;
}

.rh-card .acu-prompt-group__role-tag {
  flex: 0 0 auto !important;
  padding: 1px 6px !important;
  border: 1px solid var(--acu-border) !important;
  border-radius: 4px !important;
  background: var(--acu-bg-1) !important;
  color: var(--acu-text-3) !important;
  font-size: 11px !important;
  line-height: 1.2 !important;
}

.rh-card .acu-prompt-group__chevron {
  flex: 0 0 auto !important;
  font-size: 12px !important;
  color: var(--acu-text-3) !important;
}

.rh-card .acu-prompt-group__body {
  padding: 0 12px 12px !important;
  border-top: 1px solid var(--acu-border) !important;
}

.rh-card .acu-prompt-group__toolbar {
  display: flex !important;
  align-items: center !important;
  /* 一行放得下就别折：折了之后开关和「删除」会被挤到下一行，看着像两个不相干的控件 */
  flex-wrap: nowrap !important;
  gap: 6px !important;
  width: 100% !important;
  margin-top: 8px !important;
}

.rh-card .acu-prompt-group__name {
  /* 名字这一格可以被压窄（它只是个备注），其余控件保持各自宽度 */
  flex: 1 1 70px !important;
  min-width: 72px !important;
  width: auto !important;
}

.rh-card .acu-prompt-group__toolbar > .acu-btn,
.rh-card .acu-prompt-group__toolbar > .acu-select,
.rh-card .acu-prompt-group__enable,
.rh-card .acu-prompt-group__delete {
  flex: 0 0 auto !important;
}

.rh-card .acu-prompt-group__enable {
  display: inline-flex !important;
  align-items: center !important;
  flex: 0 0 auto !important;
}

.rh-card .acu-prompt-group__delete {
  margin-left: auto !important;
  flex: 0 0 auto !important;
}

.rh-card .acu-prompt-group .acu-textarea {
  margin-top: 6px !important;
  background-color: var(--acu-bg-1) !important;
}

/* ── 帮助气泡 ── */
.rh-card .acu-label-with-help {
  display: inline-flex !important;
  align-items: center !important;
  gap: 4px !important;
  flex: 0 0 auto !important;
}

.rh-card .acu-help-icon-btn {
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  padding: 0 !important;
  margin: 0 !important;
  border: 0 !important;
  background: transparent !important;
  color: var(--acu-text-3) !important;
  font-size: 0.95em !important;
  line-height: 1 !important;
  cursor: pointer !important;
}

.rh-card .acu-help-icon-btn:hover,
.rh-card .acu-help-icon-btn[aria-expanded='true'] {
  color: var(--acu-accent) !important;
}

.rh-card .acu-collapsible-help {
  margin: 4px 0 10px !important;
  padding: 10px 12px !important;
  border: 1px solid var(--acu-border) !important;
  border-left: 3px solid var(--acu-accent) !important;
  border-radius: var(--acu-radius-sm) !important;
  background: var(--acu-bg-2) !important;
}

.rh-card .acu-collapsible-help p {
  margin: 0 !important;
  font-size: var(--acu-font-size-body) !important;
  line-height: var(--acu-line-height-body) !important;
  color: var(--acu-text-2) !important;
}

.rh-card .acu-collapsible-help code {
  padding: 1px 4px !important;
  border-radius: 4px !important;
  background: var(--acu-bg-1) !important;
  color: var(--acu-text-1) !important;
  font-family: var(--acu-font-mono) !important;
  font-size: 11px !important;
}

/* ── 分页脚 ── */
.rh-card .acu-page-footer {
  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
  gap: 10px !important;
  padding: 10px 0 2px !important;
}

.rh-card .acu-page-indicator {
  min-width: 48px !important;
  text-align: center !important;
  font-size: var(--acu-font-size-caption) !important;
  color: var(--acu-text-3) !important;
}

/* ── 预设工具栏（照工作流助手「任务预设」区：下拉 + 一排动作按钮） ── */
.rh-card .acu-preset-section {
  padding: 10px 12px !important;
}

.rh-card .acu-preset-toolbar {
  flex-wrap: wrap !important;
  gap: 6px !important;
}

.rh-card .acu-preset-select {
  flex: 1 1 160px !important;
  min-width: 0 !important;
}

.rh-card .acu-preset-actions {
  display: flex !important;
  flex-wrap: wrap !important;
  align-items: center !important;
  gap: 4px !important;
}

.rh-card .acu-preset-actions .acu-btn {
  flex: 0 0 auto !important;
  white-space: nowrap !important;
  padding-left: 6px !important;
  padding-right: 6px !important;
}

/* ── 占位符说明 ── */
.rh-card .acu-placeholder-legend {
  display: flex !important;
  flex-direction: column !important;
  gap: 4px !important;
  margin: 4px 0 0 0 !important;
}

.rh-card .acu-placeholder-item {
  font-size: var(--acu-font-size-body) !important;
  line-height: 1.5 !important;
  color: var(--acu-text-2) !important;
}

.rh-card .acu-placeholder-item code {
  display: inline-block !important;
  min-width: 52px !important;
  margin-right: 4px !important;
  padding: 0 4px !important;
  border-radius: 4px !important;
  background: var(--acu-bg-3) !important;
  color: var(--acu-accent-2) !important;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace !important;
  font-size: var(--acu-font-size-caption) !important;
}

/* 提示词块区的「插入 / 粘贴」按钮行：居中对齐，与 ACU 的 `acu-prompt-segs__add` 一致 */
.rh-card .acu-block-add {
  display: flex !important;
  justify-content: center !important;
  gap: 8px !important;
}

/* ══════════════════════════════════════════════════════════════════════════
   暂存区（StashPanel.vue）。同样不带 <style>，理由见上一节。
   这里只做「列出来 + 点开看」两件事，弹层用 fixed 盖住整个面板，避免跟着页面滚。
   ══════════════════════════════════════════════════════════════════════════ */

.rh-card .acu-stash-entry {
  margin-top: 10px !important;
  padding: 10px 12px !important;
  border: 1px solid var(--acu-line) !important;
  border-radius: 10px !important;
  background: var(--acu-bg-2) !important;
}

.rh-card .acu-stash-entry__head {
  display: flex !important;
  align-items: center !important;
  gap: 10px !important;
  flex-wrap: wrap !important;
}

.rh-card .acu-stash-entry__floor {
  font-size: var(--acu-font-size-body) !important;
  font-weight: 700 !important;
  color: var(--acu-text-1) !important;
}

.rh-card .acu-stash-entry__meta {
  font-size: var(--acu-font-size-caption) !important;
  color: var(--acu-text-2) !important;
}

.rh-card .acu-stash-entry__state {
  margin-left: auto !important;
  padding: 1px 8px !important;
  border-radius: 999px !important;
  background: var(--acu-bg-3) !important;
  color: var(--acu-text-2) !important;
  font-size: var(--acu-font-size-caption) !important;
}

.rh-card .acu-stash-entry__state--pending {
  background: var(--acu-accent-wash) !important;
  color: var(--acu-accent-2) !important;
}

.rh-card .acu-stash-entry__landings {
  display: flex !important;
  flex-wrap: wrap !important;
  gap: 8px !important;
  margin-top: 8px !important;
}

.rh-card .acu-stash-entry__time {
  margin-left: 6px !important;
  opacity: 0.7 !important;
  font-size: var(--acu-font-size-caption) !important;
}

/* 每版左上角那个号：1、2…… 删掉 1 之后 2 还叫 2（号存在账里，不按位置算）。 */
.rh-card .acu-stash-entry__version {
  display: inline-flex !important;
  align-items: center !important;
  gap: 6px !important;
}

.rh-card .acu-stash-entry__seq {
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  min-width: 18px !important;
  height: 18px !important;
  padding: 0 5px !important;
  border-radius: 999px !important;
  background: var(--acu-accent-wash) !important;
  color: var(--acu-accent-2) !important;
  font-weight: 700 !important;
  font-size: var(--acu-font-size-caption) !important;
}

/* 「使用中」= 这一版正躺在楼层正文里，酒馆 AI 读到的就是它。 */
.rh-card .acu-stash-entry__inuse {
  padding: 0 6px !important;
  border-radius: 999px !important;
  border: 1px solid var(--acu-accent) !important;
  background: var(--acu-accent-wash) !important;
  color: var(--acu-accent-2) !important;
  font-size: var(--acu-font-size-caption) !important;
}

.rh-card .acu-stash-mask {
  position: fixed !important;
  inset: 0 !important;
  z-index: 30 !important;
  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
  background: rgba(20, 18, 16, 0.45) !important;
}

.rh-card .acu-stash-dialog {
  display: flex !important;
  flex-direction: column !important;
  width: min(760px, 92vw) !important;
  max-height: 86vh !important;
  border: 1px solid var(--acu-line) !important;
  border-radius: 12px !important;
  background: var(--acu-bg-1) !important;
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.28) !important;
  overflow: hidden !important;
}

.rh-card .acu-stash-dialog__head {
  display: flex !important;
  align-items: center !important;
  justify-content: space-between !important;
  padding: 10px 14px !important;
  border-bottom: 1px solid var(--acu-line) !important;
}

.rh-card .acu-stash-dialog__title {
  font-size: var(--acu-font-size-body) !important;
  font-weight: 700 !important;
  color: var(--acu-text-1) !important;
}

.rh-card .acu-stash-dialog__close {
  border: none !important;
  background: transparent !important;
  color: var(--acu-text-2) !important;
  font-size: 20px !important;
  line-height: 1 !important;
  cursor: pointer !important;
}

.rh-card .acu-stash-dialog__close:hover {
  color: var(--acu-accent-2) !important;
}

.rh-card .acu-stash-dialog__body {
  display: flex !important;
  flex-direction: column !important;
  gap: 8px !important;
  padding: 12px 14px !important;
  overflow: auto !important;
}

.rh-card .acu-stash-dialog__label {
  font-size: var(--acu-font-size-caption) !important;
  color: var(--acu-text-2) !important;
}

.rh-card .acu-stash-dialog__text {
  width: 100% !important;
  min-height: 260px !important;
  resize: vertical !important;
  box-sizing: border-box !important;
  padding: 8px 10px !important;
  border: 1px solid var(--acu-line) !important;
  border-radius: 8px !important;
  background: var(--acu-bg-pure) !important;
  color: var(--acu-text-1) !important;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace !important;
  font-size: var(--acu-font-size-caption) !important;
  line-height: 1.5 !important;
}

/* 标签块列表：一行一个，长正文省略成一行预览，右边是删除按钮。 */
.rh-card .acu-stash-dialog__tags {
  display: flex !important;
  flex-direction: column !important;
  gap: 4px !important;
  margin-top: 4px !important;
}

.rh-card .acu-stash-tagrow {
  display: flex !important;
  align-items: center !important;
  gap: 8px !important;
  padding: 4px 8px !important;
  border-radius: 8px !important;
  background: var(--acu-bg-2) !important;
}

.rh-card .acu-stash-tagrow__name {
  flex: 0 0 auto !important;
  color: var(--acu-accent-2) !important;
  font-size: var(--acu-font-size-caption) !important;
  font-weight: 700 !important;
}

.rh-card .acu-stash-tagrow__preview {
  flex: 1 1 auto !important;
  min-width: 0 !important;
  overflow: hidden !important;
  white-space: nowrap !important;
  text-overflow: ellipsis !important;
  color: var(--acu-text-2) !important;
  font-size: var(--acu-font-size-caption) !important;
}

.rh-card .acu-stash-tagrow__drop {
  flex: 0 0 auto !important;
  width: 22px !important;
  height: 22px !important;
  border: 1px solid var(--acu-line) !important;
  border-radius: 6px !important;
  background: transparent !important;
  color: var(--acu-text-2) !important;
  cursor: pointer !important;
}

.rh-card .acu-stash-tagrow__drop:hover {
  border-color: var(--acu-danger, #c0392b) !important;
  color: var(--acu-danger, #c0392b) !important;
}

.rh-card .acu-stash-dialog__foot {
  display: flex !important;
  flex-wrap: wrap !important;
  align-items: center !important;
  justify-content: flex-end !important;
  gap: 8px !important;
  padding: 10px 14px !important;
  border-top: 1px solid var(--acu-line) !important;
}

/* 有没保存的改动时，这行提示要独占一行，否则四个按钮会被挤乱。 */
.rh-card .acu-stash-dialog__hint {
  flex: 1 1 100% !important;
  margin: 0 !important;
  text-align: left !important;
}

/* 每个任务的原始回传：左边任务名，右边压平的一行预览。 */
.rh-card .acu-stash-dialog__tasks {
  display: flex !important;
  flex-direction: column !important;
  gap: 4px !important;
  margin-top: 10px !important;
}

.rh-card .acu-stash-task {
  display: flex !important;
  align-items: baseline !important;
  gap: 8px !important;
  padding: 4px 8px !important;
  border-radius: 8px !important;
  background: var(--acu-bg-2) !important;
}

.rh-card .acu-stash-task__name {
  flex: 0 0 auto !important;
  color: var(--acu-accent-2) !important;
  font-size: var(--acu-font-size-caption) !important;
}

.rh-card .acu-stash-task__preview {
  flex: 1 1 auto !important;
  min-width: 0 !important;
  overflow: hidden !important;
  text-overflow: ellipsis !important;
  white-space: nowrap !important;
  color: var(--acu-text-2) !important;
  font-size: var(--acu-font-size-caption) !important;
}

.rh-card .acu-stash-ask {
  padding: 10px 14px 14px !important;
  border-top: 1px solid var(--acu-line) !important;
  background: var(--acu-bg-2) !important;
}

.rh-card .acu-stash-ask__text {
  margin: 0 0 8px !important;
  color: var(--acu-text-1) !important;
  font-size: var(--acu-font-size-body) !important;
}

.rh-card .acu-stash-ask__btns {
  display: flex !important;
  justify-content: flex-end !important;
  gap: 8px !important;
}

/* ── 运行日志（RunLogPanel） ──
   样式跟着面板走，组件里不写 <style>：这个面板的整体主题由这里统一管，
   散落的 scoped 样式会与 `--acu-*` 令牌打架。 */
.rh-card .acu-log-actions {
  display: flex !important;
  gap: 8px !important;
}

.rh-card .acu-log-round {
  margin-top: 10px !important;
  padding: 10px 12px !important;
  border: 1px solid var(--acu-border) !important;
  border-radius: 10px !important;
  background: var(--acu-bg-1) !important;
}

.rh-card .acu-log-round__head {
  display: flex !important;
  align-items: center !important;
  justify-content: space-between !important;
  gap: 8px !important;
}

.rh-card .acu-log-round__title {
  font-weight: 600 !important;
  color: var(--acu-text-1) !important;
}

.rh-card .acu-log-round__meta {
  margin-top: 2px !important;
  font-size: 12px !important;
  color: var(--acu-text-2) !important;
}

.rh-card .acu-log-status {
  padding: 1px 8px !important;
  border-radius: 999px !important;
  font-size: 12px !important;
  border: 1px solid transparent !important;
}

.rh-card .acu-log-status--ok {
  color: var(--acu-success) !important;
  border-color: var(--acu-success) !important;
}

.rh-card .acu-log-status--running {
  color: var(--acu-text-2) !important;
  border-color: var(--acu-border) !important;
}

.rh-card .acu-log-status--failed,
.rh-card .acu-log-status--partial {
  color: var(--acu-danger) !important;
  border-color: var(--acu-danger) !important;
}

.rh-card .acu-log-task {
  margin-top: 6px !important;
  border-top: 1px dashed var(--acu-border) !important;
  padding-top: 6px !important;
}

.rh-card .acu-log-task__head {
  display: flex !important;
  align-items: center !important;
  gap: 8px !important;
  width: 100% !important;
  text-align: left !important;
  background: transparent !important;
  border: 0 !important;
  padding: 2px 0 !important;
  cursor: pointer !important;
  color: var(--acu-text-1) !important;
}

.rh-card .acu-log-task__mark {
  width: 16px !important;
  flex: 0 0 16px !important;
  text-align: center !important;
  font-weight: 700 !important;
}

.rh-card .acu-log-task__mark.is-ok {
  color: var(--acu-success) !important;
}

.rh-card .acu-log-task__mark.is-failed {
  color: var(--acu-danger) !important;
}

.rh-card .acu-log-task__name {
  flex: 1 1 auto !important;
  overflow: hidden !important;
  text-overflow: ellipsis !important;
  white-space: nowrap !important;
}

.rh-card .acu-log-task__meta {
  flex: 0 0 auto !important;
  font-size: 12px !important;
  color: var(--acu-text-2) !important;
}

.rh-card .acu-log-task__caret {
  flex: 0 0 auto !important;
  color: var(--acu-text-2) !important;
}

.rh-card .acu-log-task__body {
  padding: 4px 0 6px 24px !important;
}

.rh-card .acu-log-task__field {
  margin-top: 6px !important;
}

.rh-card .acu-log-task__label {
  display: block !important;
  font-size: 12px !important;
  color: var(--acu-text-2) !important;
}

.rh-card .acu-log-task__pre {
  margin: 2px 0 0 !important;
  padding: 6px 8px !important;
  max-height: 200px !important;
  overflow: auto !important;
  white-space: pre-wrap !important;
  word-break: break-word !important;
  font-size: 12px !important;
  line-height: 1.5 !important;
  background: var(--acu-bg-2) !important;
  border: 1px solid var(--acu-border) !important;
  border-radius: 8px !important;
  color: var(--acu-text-1) !important;
}

/* ── 运行日志：顶部任务标签 + 提示词块折叠（照工作流助手的四层） ── */
.rh-card .acu-log-tabs {
  display: flex !important;
  flex-wrap: wrap !important;
  gap: 6px !important;
  margin-top: 8px !important;
}

.rh-card .acu-log-tab {
  display: flex !important;
  align-items: center !important;
  gap: 6px !important;
  max-width: 100% !important;
  padding: 4px 10px !important;
  border: 1px solid var(--acu-border) !important;
  border-radius: 999px !important;
  background: var(--acu-bg-2) !important;
  color: var(--acu-text-1) !important;
  font-size: 12px !important;
  cursor: pointer !important;
}

.rh-card .acu-log-tab.is-active {
  border-color: var(--rh-accent, #7b6fd6) !important;
  background: var(--rh-accent-wash, rgba(120, 108, 220, 0.14)) !important;
}

.rh-card .acu-log-tab__mark {
  flex: 0 0 auto !important;
  font-weight: 700 !important;
}

.rh-card .acu-log-tab__mark.is-ok {
  color: var(--acu-success) !important;
}

.rh-card .acu-log-tab__mark.is-failed {
  color: var(--acu-danger) !important;
}

.rh-card .acu-log-tab__name {
  flex: 0 0 auto !important;
  font-weight: 600 !important;
  white-space: nowrap !important;
}

.rh-card .acu-log-tab__snippet {
  flex: 0 1 auto !important;
  max-width: 160px !important;
  overflow: hidden !important;
  text-overflow: ellipsis !important;
  white-space: nowrap !important;
  color: var(--acu-text-2) !important;
}

.rh-card .acu-log-panel {
  margin-top: 8px !important;
  padding-top: 8px !important;
  border-top: 1px dashed var(--acu-border) !important;
}

.rh-card .acu-log-panel__title {
  margin: 10px 0 2px !important;
  font-size: 13px !important;
  color: var(--acu-text-1) !important;
}

.rh-card .acu-log-block {
  margin-top: 6px !important;
  border: 1px solid var(--acu-border) !important;
  border-radius: 8px !important;
  background: var(--acu-bg-2) !important;
}

.rh-card .acu-log-block__summary {
  display: flex !important;
  align-items: center !important;
  justify-content: space-between !important;
  gap: 8px !important;
  padding: 6px 8px !important;
  cursor: pointer !important;
  font-size: 12px !important;
  color: var(--acu-text-1) !important;
}

.rh-card .acu-log-block__title {
  font-weight: 600 !important;
}

.rh-card .acu-log-block__size {
  flex: 0 0 auto !important;
  color: var(--acu-text-2) !important;
}

.rh-card .acu-log-block__pre {
  margin: 0 !important;
  padding: 8px !important;
  max-height: 260px !important;
  overflow: auto !important;
  white-space: pre-wrap !important;
  word-break: break-word !important;
  font-size: 12px !important;
  line-height: 1.5 !important;
  border-top: 1px solid var(--acu-border) !important;
  color: var(--acu-text-1) !important;
}

/* 附加请求体参数：这格是给用户贴 YAML / JSON 的，等宽字体才看得清缩进 */
.rh-card .acu-api-body__text {
  width: 100% !important;
  min-height: 88px !important;
  resize: vertical !important;
  font-family: ui-monospace, SFMono-Regular, Consolas, 'Liberation Mono', monospace !important;
  font-size: 12px !important;
  line-height: 1.55 !important;
  white-space: pre !important;
  overflow-x: auto !important;
  box-sizing: border-box !important;
}

.rh-card .acu-api-body__head {
  margin-top: 6px !important;
}

/* ── 预览弹窗：把这一轮真会发出去的字摊开 ── */
.rh-card .acu-preview-mask {
  position: fixed !important;
  inset: 0 !important;
  z-index: 2147482000 !important;
  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
  padding: 24px 16px !important;
  background-color: rgba(16, 18, 27, 0.55) !important;
}

.rh-card .acu-preview {
  display: flex !important;
  flex-direction: column !important;
  width: min(760px, 94vw) !important;
  max-height: min(78vh, 760px) !important;
  padding: 14px 16px !important;
  border-radius: 14px !important;
  background-color: var(--acu-bg-1) !important;
  border: 1px solid var(--acu-border) !important;
  color: var(--acu-text-1) !important;
  overflow: hidden !important;
}

.rh-card .acu-preview__head {
  display: flex !important;
  align-items: center !important;
  justify-content: space-between !important;
  gap: 10px !important;
  margin-bottom: 6px !important;
}

.rh-card .acu-preview__title {
  font-size: 15px !important;
  font-weight: 600 !important;
}

.rh-card .acu-preview__note {
  margin: 4px 0 !important;
}

.rh-card .acu-preview__tabs {
  display: flex !important;
  flex-wrap: wrap !important;
  gap: 6px !important;
  margin: 6px 0 !important;
}

.rh-card .acu-preview__tab {
  padding: 4px 10px !important;
  border-radius: 999px !important;
  border: 1px solid var(--acu-border) !important;
  background-color: var(--acu-bg-2) !important;
  color: var(--acu-text-2) !important;
  font-size: 12px !important;
  cursor: pointer !important;
}

.rh-card .acu-preview__tab.active {
  background-color: var(--acu-accent-wash) !important;
  border-color: var(--acu-accent) !important;
  color: var(--acu-accent-deep) !important;
}

.rh-card .acu-preview__body {
  flex: 1 1 auto !important;
  min-height: 120px !important;
  overflow: auto !important;
  padding: 6px 2px !important;
}

.rh-card .acu-preview__msg {
  margin-bottom: 10px !important;
}

.rh-card .acu-preview__role {
  display: inline-block !important;
  margin-bottom: 2px !important;
  padding: 1px 6px !important;
  border-radius: 6px !important;
  font-size: 11px !important;
  letter-spacing: 0.04em !important;
  text-transform: uppercase !important;
  background-color: var(--acu-bg-3) !important;
  color: var(--acu-text-2) !important;
}

.rh-card .acu-preview__text {
  margin: 0 !important;
  padding: 8px 10px !important;
  max-height: 260px !important;
  overflow: auto !important;
  white-space: pre-wrap !important;
  word-break: break-word !important;
  font-family: var(--rh-font-mono) !important;
  font-size: 12px !important;
  line-height: 1.55 !important;
  background-color: var(--acu-bg-2) !important;
  border: 1px solid var(--acu-border) !important;
  border-radius: 8px !important;
  color: var(--acu-text-1) !important;
}


/* ══════════════════════════════════════════════════════════════════════════
   手机 / 窄窗：功能列收成抽屉，卡片吃满屏幕，横向一行挤不下的改竖排
   ══════════════════════════════════════════════════════════════════════════
   为什么要有这一段：手机上 96vw ≈ 360px，左侧固定 108px 的功能列一占，
   内容区只剩两百多像素 —— 提示词块只剩「提示…」四个字，按钮挤成一堆。
   这里不改数据也不改结构，只改「多窄的时候怎么摆」。
*/

/* 三横线按钮：宽屏不出现，窄屏才出现（见下面的媒体查询） */
.rh-burger {
  display: none;
  flex-direction: column;
  justify-content: center;
  gap: 3px;
  flex: 0 0 auto;
  width: 30px;
  height: 30px;
  padding: 0 6px;
  border: 1px solid var(--rh-line-input) !important;
  border-radius: 8px !important;
  background-color: transparent !important;
  cursor: pointer;
}

.rh-burger-bar {
  display: block;
  height: 2px;
  border-radius: 1px;
  background-color: var(--rh-fg-soft) !important;
}

/* 星空神庙：三横线换成星光蓝，按钮框加一圈白晕。其他主题一个字不动。 */
.rh-mask[data-rh-theme="starry-temple"] .rh-burger {
  border-color: rgba(255, 255, 255, 0.6) !important;
  background-color: rgba(16, 24, 56, 0.42) !important;
  box-shadow:
    0 0 0 1px rgba(255, 255, 255, 0.3),
    0 0 12px rgba(120, 180, 255, 0.55),
    inset 0 0 10px rgba(120, 180, 255, 0.35) !important;
}

.rh-mask[data-rh-theme="starry-temple"] .rh-burger:hover {
  box-shadow:
    0 0 0 1px rgba(255, 255, 255, 0.45),
    0 0 18px rgba(140, 195, 255, 0.85),
    inset 0 0 12px rgba(140, 195, 255, 0.5) !important;
}

.rh-mask[data-rh-theme="starry-temple"] .rh-burger-bar {
  background-color: transparent !important;
  background-image: linear-gradient(90deg, #ffffff 0%, #a9d8ff 50%, #6fa8ff 100%) !important;
  box-shadow:
    0 0 6px rgba(150, 205, 255, 0.95),
    0 0 2px rgba(255, 255, 255, 0.9) !important;
}

.rh-rail-veil {
  position: absolute;
  inset: 0;
  z-index: 3;
  background-color: rgba(0, 0, 0, 0.32);
}

@media (max-width: 720px) {
  .rh-mask {
    padding: 0 !important;
    align-items: stretch !important;
    justify-content: stretch !important;
  }

  .rh-card {
    width: 100vw !important;
    max-width: 100vw !important;
    height: 100vh !important;
    height: 100dvh !important;
    max-height: 100vh !important;
    max-height: 100dvh !important;
    border: none !important;
    border-radius: 0 !important;
    position: relative !important;
  }

  /* 块卡片那排工具条：宽屏为了「开关和删除别掉到第二行」用了 nowrap，
     但手机上 390px 放不下 8 个控件，右边几个（开关、删除）会被直接挤出可视区 ——
     用户实测「手机上根本看不到开关」。窄屏改成可换行，删除也不再靠 margin-left:auto 顶到最右。 */
  .rh-card .acu-prompt-group__toolbar {
    flex-wrap: wrap !important;
  }

  .rh-card .acu-prompt-group__delete {
    margin-left: 0 !important;
  }

  .rh-card-head {
    gap: 8px !important;
    padding: 10px 12px 8px !important;
  }

  .rh-burger {
    display: flex !important;
  }

  .rh-card-title {
    flex: 1 1 auto !important;
    min-width: 0 !important;
    font-size: 15px !important;
  }

  /* 功能列变左侧抽屉：默认整体挪到屏幕外，露出时盖在内容上 */
  .rh-rail {
    position: absolute !important;
    left: 0 !important;
    top: 0 !important;
    bottom: 0 !important;
    z-index: 4 !important;
    width: 168px !important;
    max-width: 70vw !important;
    transform: translateX(-102%);
    transition: transform 0.18s ease;
  }

  .rh-rail.open {
    transform: none;
  }

  .rh-body-wrap {
    position: relative !important;
  }

  .rh-card-body {
    padding: 10px 12px 16px !important;
  }

  /* 一行「标题 + 输入框 + 单位」在窄屏竖着摆，标题另起一行 */
  .rh-line {
    flex-wrap: wrap !important;
    gap: 6px !important;
  }

  .rh-line label {
    flex: 1 1 100% !important;
  }

  .rh-card .acu-row {
    flex-direction: column !important;
    align-items: stretch !important;
    flex-wrap: wrap !important;
  }

  .rh-card .acu-row--inline {
    flex-wrap: wrap !important;
  }

  /*
    窄屏下「一行」全部改成竖排后，子元素身上那些 `flex: 1 1 120px` 会变成
    「高度 120px」——输入框会鼓成一个两百像素高的方块，名字只剩底部一行。
    这里把子元素的伸缩基础清掉，让高度重新由内容决定。
  */
  .rh-card .acu-row > * {
    flex: 0 0 auto !important;
  }

  .rh-card .acu-input,
  .rh-card .acu-select {
    height: auto !important;
    min-height: 32px !important;
  }

  /*
    竖排之后 `align-items: stretch` 会把按钮也拉成整行宽 —— 一个「✕」变成一条粉色长条。
    按钮按内容宽就好，靠左对齐。
  */
  .rh-card .acu-row > .acu-btn,
  .rh-card .acu-row > button {
    align-self: flex-start !important;
    flex: 0 0 auto !important;
    width: auto !important;
  }

  /* 控制类按钮（开关行里的）本来就该占满，别被上面那条误伤 */
  .rh-card .acu-row > .acu-btn.primary,
  .rh-card .acu-row > .acu-btn.acu-btn--block {
    align-self: stretch !important;
  }

  /* 页脚是粘在底部的，正文最后一段否则会被它压住 */
  .rh-card-body {
    padding-bottom: 78px !important;
  }

  /* 长标签（「这个任务的最终指令」）压到一行会变成「这个任务…」，逼它换行 */
  .rh-card .rh-field-label,
  .rh-card .acu-row label {
    white-space: normal !important;
    overflow-wrap: anywhere !important;
  }

  /*
    窄屏五页签：等宽 + 小字号 + 单行不换行。
    上一版靠横向滚动，结果「世界书与上下文」在 390px 里折成三行，比滚动更难认。
  */
  .rh-card .acu-page-tabs {
    gap: 2px !important;
    padding: 6px 6px !important;
  }

  .rh-card .acu-page-tab {
    flex: 1 1 0 !important;
    min-width: 0 !important;
    padding: 8px 2px !important;
    font-size: 11px !important;
    line-height: 1.25 !important;
    white-space: nowrap !important;
  }

  /* 窄屏换短名（工作流助手同一招：全名隐藏、短名显示） */
  .rh-card .acu-page-tab__full {
    display: none !important;
  }

  .rh-card .acu-page-tab__short {
    display: inline !important;
  }

  .acu-stash-dialog,
  .rh-card .acu-preview {
    width: 100vw !important;
    max-width: 100vw !important;
    max-height: 100vh !important;
    max-height: 100dvh !important;
    border-radius: 0 !important;
  }

  .acu-stash-tagrow {
    flex-wrap: wrap !important;
  }
}

/* ════════════════════════════════════════════════════════════════════
   主题「星空神庙」（id = starry-temple）

   大理石底 + 古希腊回纹金线 + 桂枝 + 灰色浮雕 + 紫水晶毛玻璃 + 蓝紫星空。
   所有纹理都是 CSS 渐变与**内联** SVG：面板会被塞进任何酒馆环境，外链图片
   一旦 404 或跨域被拦，整块背景就塌了，所以一张外链图都不引。

   只在 `[data-rh-theme='starry-temple']` 下生效——别的主题不背这层绘制成本。
   ════════════════════════════════════════════════════════════════════ */

/* 令牌兜底：样式表里没声明时也有值，免得哪天单独用某段样式时 var() 落空 */
.rh-mask {
  --rh-gold: #b08d4f;
  --rh-gold-soft: rgba(176, 141, 79, 0.28);
  --rh-gold-line: rgba(176, 141, 79, 0.55);
  --rh-amethyst: #7b6fd6;
  --rh-amethyst-deep: #5b4fb2;
  --rh-star: rgba(120, 108, 220, 0.55);
}

/* —— 卡面：大理石 —— */
.rh-mask[data-rh-theme='starry-temple'] .rh-card {
  /* 桂枝纹章是绝对定位的，得有个定位上下文 */
  position: relative !important;
  background-color: #f7f4ef !important;
  background-image:
    /* 星点（240px 平铺，很淡，只在暗处能看出来） */
    url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='240' height='240'><g fill='%237b6fd6' fill-opacity='0.28'><circle cx='18' cy='26' r='1.1'/><circle cx='92' cy='12' r='0.9'/><circle cx='151' cy='38' r='1.3'/><circle cx='210' cy='18' r='0.8'/><circle cx='46' cy='98' r='0.9'/><circle cx='128' cy='122' r='1'/><circle cx='196' cy='96' r='1.2'/><circle cx='24' cy='176' r='1'/><circle cx='104' cy='204' r='0.8'/><circle cx='168' cy='166' r='1.1'/><circle cx='226' cy='212' r='0.9'/></g></svg>"),
    /* 大理石纹路（520px 平铺；0.18 是「看得出是石头、又不抢正文」的那一档） */
    url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='520' height='520'><g fill='none' stroke='%237f8398' stroke-opacity='0.26' stroke-width='1'><path d='M-20 62 C 96 34 168 118 268 88 S 404 132 540 96'/><path d='M-20 186 C 82 158 148 236 252 208 S 392 250 540 216'/><path d='M-20 322 C 110 296 176 366 278 344 S 414 380 540 352'/><path d='M-20 452 C 92 426 166 490 266 468 S 400 500 540 474'/><path d='M78 -20 C 100 86 44 158 88 262 S 52 396 82 540'/><path d='M372 -20 C 394 74 338 172 384 274 S 348 408 378 540'/><path d='M-20 248 C 140 214 300 268 540 226' stroke-opacity='0.10'/></g></svg>"),
    /* 更细的一层碎纹：跟上面那层错开平铺，两层叠起来才不像手绘线条 */
    url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='260' height='260'><g fill='none' stroke='%238b8fa3' stroke-opacity='0.16' stroke-width='0.8'><path d='M-10 30 C 60 18 96 62 150 44 S 220 66 270 50'/><path d='M-10 108 C 54 96 92 138 146 122 S 214 144 270 128'/><path d='M-10 190 C 58 178 96 218 152 202 S 218 224 270 208'/><path d='M40 -10 C 52 60 22 100 46 160 S 28 220 44 270'/><path d='M196 -10 C 208 52 178 108 202 166 S 184 226 200 270'/></g></svg>"),
    /* 左上高光（收窄，别把整张卡洗白） */
    radial-gradient(760px 360px at 2% -18%, rgba(255, 255, 255, 0.72), rgba(255, 255, 255, 0) 66%),
    /* 右下紫水晶反光 */
    radial-gradient(900px 520px at 100% 118%, rgba(108, 96, 201, 0.18), rgba(108, 96, 201, 0) 64%),
    /* 顶部一层蓝紫雾，给星空垫底 */
    radial-gradient(1200px 260px at 50% -8%, rgba(123, 111, 214, 0.10), rgba(123, 111, 214, 0) 70%),
    /* 底：暖灰大理石墙。小节卡是压在这面墙上的白石板，墙得比石板暗一档才看得出层次 */
    linear-gradient(158deg, #efe9dd 0%, #e4dbcc 34%, #d6cab7 70%, #c9bca8 100%) !important;
  background-size:
    240px 240px,
    520px 520px,
    260px 260px,
    auto,
    auto,
    auto,
    auto !important;
  background-repeat: repeat, repeat, repeat, no-repeat, no-repeat, no-repeat, no-repeat !important;
  /* 灰边 + 金线：外圈一道冷灰渐变，内圈一道 1px 金，再内一道 4px 的暗金 */
  border-color: rgba(176, 141, 79, 0.38) !important;
  box-shadow:
    0 24px 70px rgba(38, 34, 64, 0.30),
    0 0 0 1px rgba(176, 141, 79, 0.18),
    0 0 0 6px rgba(120, 116, 140, 0.07),
    inset 0 0 0 1px rgba(255, 255, 255, 0.62),
    inset 0 0 0 5px rgba(176, 141, 79, 0.10),
    inset 0 0 200px rgba(96, 92, 112, 0.20) !important;
}

/* —— 卡头：夜空带 ——
   上面是天、下面是神庙的石墙，这是整套主题唯一一处「深色」的地方：
   天不深就压不住下面的白石板，但也不能压成纯黑——所以用中等蓝紫，靠星点和
   左上那团星云提亮，读起来是「入夜的天」，不是「黑色标题栏」。 */
.rh-mask[data-rh-theme='starry-temple'] .rh-card-head {
  position: relative;
  background-color: #2f2b4b !important;
  background-image:
    url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='180' height='180'><g fill='%23ffffff'><circle cx='12' cy='18' r='0.9' fill-opacity='0.55'/><circle cx='48' cy='6' r='0.7' fill-opacity='0.4'/><circle cx='86' cy='30' r='1.1' fill-opacity='0.6'/><circle cx='132' cy='12' r='0.6' fill-opacity='0.35'/><circle cx='168' cy='38' r='0.9' fill-opacity='0.5'/><circle cx='26' cy='74' r='0.7' fill-opacity='0.4'/><circle cx='70' cy='96' r='0.8' fill-opacity='0.45'/><circle cx='112' cy='66' r='0.6' fill-opacity='0.3'/><circle cx='150' cy='104' r='1' fill-opacity='0.5'/><circle cx='16' cy='132' r='0.8' fill-opacity='0.42'/><circle cx='58' cy='160' r='0.6' fill-opacity='0.32'/><circle cx='104' cy='146' r='0.9' fill-opacity='0.5'/><circle cx='146' cy='172' r='0.7' fill-opacity='0.36'/><circle cx='176' cy='146' r='0.8' fill-opacity='0.44'/></g></svg>"),
    radial-gradient(720px 190px at 16% -60%, rgba(150, 138, 240, 0.62), rgba(150, 138, 240, 0) 68%),
    radial-gradient(560px 150px at 84% -30%, rgba(96, 86, 190, 0.55), rgba(96, 86, 190, 0) 70%),
    linear-gradient(100deg, #2c2a45 0%, #38335c 38%, #463d7e 68%, #332e52 100%) !important;
  background-size: 180px 180px, auto, auto, auto !important;
  background-repeat: repeat, no-repeat, no-repeat, no-repeat !important;
  border-bottom: 1px solid rgba(176, 141, 79, 0.62) !important;
  box-shadow: inset 0 -18px 30px -18px rgba(0, 0, 0, 0.45) !important;
}

/* 夜空上的字与按钮：一律提亮，否则深底上读不出来 */
.rh-mask[data-rh-theme='starry-temple'] .rh-card-title,
.rh-mask[data-rh-theme='starry-temple'] .rh-card-title .rh-ico {
  color: #f7f3ea !important;
}

.rh-mask[data-rh-theme='starry-temple'] .rh-theme-pick,
.rh-mask[data-rh-theme='starry-temple'] .rh-x {
  color: rgba(247, 243, 234, 0.74) !important;
}

.rh-mask[data-rh-theme='starry-temple'] .rh-x:hover {
  background-color: rgba(255, 255, 255, 0.14) !important;
  color: #ffffff !important;
}

.rh-mask[data-rh-theme='starry-temple'] .rh-theme-sel {
  color: #2a2740 !important;
  background-color: rgba(253, 251, 247, 0.96) !important;
  border-color: rgba(176, 141, 79, 0.5) !important;
}

/* 希腊回纹：卡头底边一条 8px 的金线带，两端淡出，只当收口不当花边 */
.rh-mask[data-rh-theme='starry-temple'] .rh-card-head::after {
  content: '';
  position: absolute;
  left: 16px;
  right: 16px;
  bottom: -5px;
  height: 8px;
  pointer-events: none;
  background-image: url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='24' height='8'><path d='M0 7 H7 V2 H17 V7 H11 V4 H14' fill='none' stroke='%23b08d4f' stroke-opacity='0.34' stroke-width='1'/></svg>");
  background-size: 24px 8px;
  background-repeat: repeat-x;
  -webkit-mask-image: linear-gradient(90deg, transparent, #000 26%, #000 74%, transparent);
  mask-image: linear-gradient(90deg, transparent, #000 26%, #000 74%, transparent);
}

/* 标题：浮雕感（上白下灰），不描边、不加发光，免得糊 */
.rh-mask[data-rh-theme='starry-temple'] .rh-card-title {
  text-shadow:
    0 1px 2px rgba(12, 10, 26, 0.55),
    0 0 14px rgba(176, 162, 255, 0.32) !important;
  letter-spacing: 0.03em !important;
}

/* —— 左列：大理石壁柱 + 金线压边 + 底部一枚桂枝纹章 ——
   纹章走背景层而不是绝对定位的伪元素：手机上这一列是抽屉，靠 position:absolute
   挪到屏幕外，给它写死 position 会把抽屉顶回文档流、把内容挤成一条。 */
.rh-mask[data-rh-theme='starry-temple'] .rh-rail {
  background-image:
    url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='132' height='132'><g fill='none' stroke='%23b08d4f' stroke-width='1.3' stroke-linecap='round'><path d='M18 116 C 40 84 68 50 104 22'/><path d='M34 100 c -9 -2 -15 -10 -14 -20 c 10 0 17 7 18 17'/><path d='M46 86 c -9 -2 -15 -10 -14 -20 c 10 0 17 7 18 17'/><path d='M58 72 c -9 -2 -15 -10 -14 -20 c 10 0 17 7 18 17'/><path d='M70 58 c -9 -2 -15 -10 -14 -20 c 10 0 17 7 18 17'/><path d='M40 92 c 8 -5 17 -3 23 5 c -6 8 -16 10 -23 5'/><path d='M54 74 c 8 -5 17 -3 23 5 c -6 8 -16 10 -23 5'/><path d='M68 56 c 8 -5 17 -3 23 5 c -6 8 -16 10 -23 5'/><path d='M82 38 c 8 -5 17 -3 23 5 c -6 8 -16 10 -23 5'/></g></svg>"),
    linear-gradient(180deg, rgba(255, 255, 255, 0.78), rgba(238, 233, 225, 0.6)),
    linear-gradient(90deg, rgba(120, 116, 140, 0.05), rgba(120, 116, 140, 0)) !important;
  background-size: 88px 88px, auto, auto !important;
  background-position: center calc(100% - 26px), 0 0, 0 0 !important;
  background-repeat: no-repeat, no-repeat, no-repeat !important;
  box-shadow:
    inset -1px 0 0 rgba(176, 141, 79, 0.28),
    inset 1px 0 0 rgba(255, 255, 255, 0.7) !important;
}

.rh-mask[data-rh-theme='starry-temple'] .rh-rail-btn.active {
  background-image: linear-gradient(135deg, rgba(123, 111, 214, 0.18), rgba(123, 111, 214, 0.06)) !important;
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.8),
    0 2px 8px rgba(38, 34, 64, 0.10) !important;
}

/* —— 正文区：顶部一层极淡的雾，让内容「浮」在墙上（浓了会盖掉大理石纹）—— */
.rh-mask[data-rh-theme='starry-temple'] .rh-card-body {
  background-image: linear-gradient(180deg, rgba(255, 255, 255, 0.22), rgba(255, 255, 255, 0) 120px) !important;
  background-repeat: no-repeat !important;
}

/* —— 小节卡：羊皮纸白的紫水晶玻璃 ——
   半透明是有意的：整页几乎都被小节卡盖住，卡面再不透，大理石纹路就白画了。
   这里**不能用 backdrop-filter**——它会成为 position: fixed 后代的包含块，
   暂存区的全屏弹窗会被按小节卡裁掉。 */
.rh-mask[data-rh-theme='starry-temple'] .rh-card .acu-section {
  background-color: rgba(253, 251, 247, 0.94) !important;
  /* 石板自己也带一层极淡的石纹：整页九成面积都是小节卡，纹路只画在墙上等于白画 */
  background-image:
    url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='300' height='300'><g fill='none' stroke='%23888ca0' stroke-opacity='0.07' stroke-width='0.8'><path d='M-10 242 C 58 204 92 152 152 120 S 250 62 312 30'/><path d='M-10 152 C 40 132 78 96 118 60 S 200 18 302 -10'/><path d='M42 312 C 72 252 60 200 100 160 S 152 90 140 18'/><path d='M200 312 C 222 260 258 220 312 198'/><path d='M92 160 C 102 190 80 220 100 250'/><path d='M152 120 C 172 140 192 150 222 150'/><path d='M232 96 C 246 76 262 66 286 62'/></g></svg>"),
    linear-gradient(
      168deg,
      rgba(255, 255, 255, 0.92) 0%,
      rgba(253, 251, 247, 0.7) 44%,
      rgba(123, 111, 214, 0.05) 100%
    ) !important;
  background-size: 300px 300px, auto !important;
  background-repeat: repeat, no-repeat !important;
  border: 1px solid rgba(176, 141, 79, 0.34) !important;
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.95),
    inset 0 0 0 1px rgba(255, 255, 255, 0.4),
    0 1px 0 rgba(255, 255, 255, 0.6),
    0 6px 18px rgba(38, 34, 64, 0.13) !important;
}

/* 小节标题：石刻浮雕（上白下灰两道 1px 投影），跟卡头同一套做法 */
.rh-mask[data-rh-theme='starry-temple'] .rh-card .acu-section h4,
.rh-mask[data-rh-theme='starry-temple'] .rh-card .acu-section__title {
  text-shadow:
    0 1px 0 rgba(255, 255, 255, 0.95),
    0 -1px 0 rgba(120, 116, 140, 0.22) !important;
}

/* —— 页签：选中那条是紫水晶，未选是石刻灰 —— */
.rh-mask[data-rh-theme='starry-temple'] .rh-card .acu-page-tab.is-active,
.rh-mask[data-rh-theme='starry-temple'] .rh-card .acu-page-tab.active {
  background-image: linear-gradient(135deg, rgba(123, 111, 214, 0.22), rgba(91, 79, 178, 0.10)) !important;
  box-shadow: inset 0 -2px 0 rgba(108, 96, 201, 0.75) !important;
}

/* —— 输入框：白瓷面 + 内阴影，避免在大理石上「飘」 —— */
.rh-mask[data-rh-theme='starry-temple'] .rh-card .acu-input,
.rh-mask[data-rh-theme='starry-temple'] .rh-card .acu-select,
.rh-mask[data-rh-theme='starry-temple'] .rh-card .acu-textarea,
.rh-mask[data-rh-theme='starry-temple'] .rh-theme-sel {
  background-color: #fdfbf7 !important;
  box-shadow:
    inset 0 1px 2px rgba(38, 34, 64, 0.07),
    inset 0 0 0 1px rgba(255, 255, 255, 0.7) !important;
}

.rh-mask[data-rh-theme='starry-temple'] .rh-card .acu-input:focus,
.rh-mask[data-rh-theme='starry-temple'] .rh-card .acu-select:focus,
.rh-mask[data-rh-theme='starry-temple'] .rh-card .acu-textarea:focus {
  box-shadow:
    0 0 0 2px rgba(108, 96, 201, 0.24),
    inset 0 1px 2px rgba(38, 34, 64, 0.06) !important;
}

/* —— 主按钮：紫水晶切面（渐变 + 顶部高光 + 底部压深）—— */
.rh-mask[data-rh-theme='starry-temple'] .rh-card .rh-act-go {
  background-image: linear-gradient(150deg, #8b80e2 0%, #6c60c9 52%, #554aa8 100%) !important;
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.42),
    inset 0 -1px 0 rgba(40, 32, 90, 0.35),
    0 2px 8px rgba(85, 74, 168, 0.28) !important;
}

/* 页脚：一条金线收口，跟卡头的回纹上下呼应 */
.rh-mask[data-rh-theme='starry-temple'] .rh-card .rh-card-foot {
  background-image: linear-gradient(0deg, rgba(120, 116, 140, 0.06), rgba(255, 255, 255, 0)) !important;
  border-top: 1px solid rgba(176, 141, 79, 0.42) !important;
}
</style>
