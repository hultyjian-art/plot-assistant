<script setup lang="ts">
/**
 * 任务表 —— 卡片行 + 内联编辑。
 *
 * 版式照搬工作流助手「任务」页里的「工作流任务」小节：上面一排任务卡（阶段徽标 + 名字 +
 * 停用标记 + ◀ ▶ 排序 + 加号），点中哪个，下面就是哪个的编辑区。原先我们是「任务清单
 * 只能看、编辑藏在预设编辑器里」，同一份信息两处显示，改一个字段要来回切页 —— 这次合成一处。
 *
 * 所有增删改仍然**就地改传进来的数组**（`props.tasks`），由外层在点「应用修改」时交给
 * `applyTaskDrafts` 写回预设本体。这里不碰存储，也不碰数据库脚本。
 *
 * 跨预设 / 跨任务的复制不在本组件里执行：两处复制按钮都只把内容交给外层，
 * 由外层弹出同一个「复制到哪里」子页面，选完目标再统一粘贴。
 */
import { computed, ref, watch } from 'vue';
import { UI } from '../copy';
import {
  copyBlockDraft,
  newBlockDraft,
  newTaskDraft,
  type TaskBlockDraft,
  type TaskDraft,
} from '../plot/preset-edit';
import { anchorNameOf } from '../plot/floor-anchor';
import { readArmedTaskIds, setArmedTaskIds } from '../plot/manual-arm';
import { blockKeyOf } from './block-key';
import PromptBlockCard from './PromptBlockCard.vue';
import { countBlocks, moveBlock as moveBlockInList } from '../plot/eng/prompt-blocks';

const props = defineProps<{
  tasks: TaskDraft[];
  /** 当前预设名：剪贴板提示里显示「从哪份预设复制的」，删任务时也算预约锚点名的前缀。 */
  presetName?: string;
  /** 面板上配好的 API 名字清单：任务可以单独挑一条，也可以跟全局走。 */
  apiNames?: string[];
}>();

/** 复制动作交给外层：外层负责写剪贴板 + 弹同一个选择窗口。 */
const emit = defineEmits<{
  copyTask: [task: TaskDraft];
  copyBlock: [block: TaskBlockDraft];
}>();

const selectedIndex = ref(0);

/** 任务增删后下标可能越界，夹回合法范围。 */
const selectedTask = computed<TaskDraft | undefined>(() => props.tasks[selectedIndex.value]);

const anyBlocksOff = computed(() => {
  const task = selectedTask.value;
  if (!task) return false;
  const counts = countBlocks(task.blocks);
  return counts.enabled < counts.total;
});

watch(
  () => props.tasks.length,
  (length) => {
    if (length === 0) {
      selectedIndex.value = 0;
      return;
    }
    if (selectedIndex.value > length - 1) selectedIndex.value = length - 1;
  },
);

function taskName(task: TaskDraft, index: number): string {
  return task.name.trim() === '' ? `${UI.plot.editorTask} ${index + 1}` : task.name;
}

function addTask(): void {
  props.tasks.push(newTaskDraft(props.tasks));
  selectedIndex.value = props.tasks.length - 1;
}

/**
 * 删任务：先把任务从表里拿掉，再立刻从预约表撤掉它的那一条。
 * 不能只等发送时顺手清死条目 —— 删掉的任务在下次发送前仍是「已预约」状态，
 * 楼层按钮会一直亮着。只按锚点名精确排除这一条，别的一律不动。
 */
function dropTask(index: number): void {
  const task = props.tasks[index];
  if (!task) return;
  props.tasks.splice(index, 1);
  clearArmedForTask(task);
}

/** 把一个任务的预约从聊天变量里撤掉（停用 / 关手动 / 删任务时都要立即生效）。 */
function clearArmedForTask(task: TaskDraft): void {
  const anchorName = anchorNameOf(props.presetName ?? '', task.id);
  const armed = readArmedTaskIds();
  const next = armed.filter(id => id !== anchorName);
  if (next.length !== armed.length) setArmedTaskIds(next);
}

/** 左右移一位：只改列表位置。同一阶段是并发跑的，位置只影响展示与标签合并先后。 */
function moveTask(from: number, delta: -1 | 1): void {
  const to = from + delta;
  if (to < 0 || to >= props.tasks.length) return;
  const [task] = props.tasks.splice(from, 1);
  props.tasks.splice(to, 0, task);
  selectedIndex.value = to;
}

function addBlock(task: TaskDraft, position: 'top' | 'bottom' = 'bottom'): void {
  const block = newBlockDraft();
  if (position === 'top') task.blocks.unshift(block);
  else task.blocks.push(block);
}

function copyBlock(task: TaskDraft, index: number): void {
  const block = task.blocks[index];
  if (!block) return;
  task.blocks.splice(index + 1, 0, copyBlockDraft(block));
}

function dropBlock(task: TaskDraft, index: number): void {
  task.blocks.splice(index, 1);
}

function moveBlock(task: TaskDraft, from: number, delta: -1 | 1): void {
  const to = from + delta;
  if (to < 0 || to >= task.blocks.length) return;
  // 就地替换内容而不是换数组引用：props.tasks 是父组件传进来的响应式数组。
  // 列表标识用块对象本身的稳定名字（见 block-key.ts），移动时展开状态不会串位。
  task.blocks.splice(0, task.blocks.length, ...moveBlockInList(task.blocks, from, to));
}

/** 全部块都关掉 = 这个任务发不出任何内容，跑起来只会白等一次 AI。 */
function allBlocksOff(task: TaskDraft): boolean {
  const counts = countBlocks(task.blocks);
  return counts.total > 0 && counts.enabled === 0;
}

/** 手动触发开关：只翻草稿上的状态，写回预设时由 preset-edit 决定落不落键。 */
function toggleManual(): void {
  const task = selectedTask.value;
  if (!task) return;
  task.manual = !task.manual;
  // 关掉手动触发后旧预约立刻失效，下一轮发送前不该再占着它。
  if (!task.manual) clearArmedForTask(task);
}

/** 停用任务：预约立刻撤掉，按钮也会从楼层上消失。 */
function toggleEnabled(task: TaskDraft, event: Event): void {
  const checked = (event.target as HTMLInputElement).checked;
  if (!checked) clearArmedForTask(task);
}
</script>

<template>
  <div class="acu-section">
    <h4>{{ UI.plot.editorTasks }}</h4>
    <p class="acu-notes">{{ UI.plot.editorTasksHint }}</p>

    <div class="acu-task-tabs">
      <span
        v-for="(task, index) in props.tasks"
        :key="task.key"
        class="task-card"
        :class="{ active: index === selectedIndex }"
        @click="selectedIndex = index"
      >
        <span class="task-card__stage" :title="`${UI.plot.editorTaskStage} ${task.stage}`">S{{ task.stage }}</span>
        <span class="task-card__name">{{ taskName(task, index) }}</span>
        <span v-if="!task.enabled" class="task-card__flag">{{ UI.plot.taskDisabled }}</span>
        <template v-if="index === selectedIndex">
          <button class="task-card__move" type="button" title="向左移动" :disabled="index === 0" @click.stop="moveTask(index, -1)">
            ◀
          </button>
          <button
            class="task-card__move"
            type="button"
            title="向右移动"
            :disabled="index === props.tasks.length - 1"
            @click.stop="moveTask(index, 1)"
          >
            ▶
          </button>
        </template>
      </span>
      <button class="acu-btn acu-btn--sm" type="button" :title="UI.plot.editorTaskAdd" @click="addTask">＋</button>
      <button class="acu-btn acu-btn--sm" type="button" :title="UI.plot.editorTaskCopyHint" :disabled="!selectedTask" @click="selectedTask && emit('copyTask', selectedTask)">
        {{ UI.plot.editorTaskCopy }}
      </button>
    </div>

    <p v-if="props.tasks.length === 0" class="acu-notes">{{ UI.plot.presetEditNoTasks }}</p>

    <div v-if="selectedTask" class="acu-task-editor">
      <!-- 手动触发：圆圈按钮 + 右侧标签与说明。圆圈内部被颜色块填满 = 已开启。 -->
      <div class="task-manual-row">
        <button
          type="button"
          class="task-manual-switch"
          role="switch"
          :aria-pressed="selectedTask.manual ? 'true' : 'false'"
          :aria-label="UI.plot.editorTaskManual"
          @click="toggleManual"
        >
          <span class="task-manual-switch__ring" aria-hidden="true" />
        </button>
        <div class="task-manual-copy">
          <span class="task-manual-copy__label">{{ UI.plot.editorTaskManual }}</span>
          <span class="task-manual-copy__hint">{{ UI.plot.editorTaskManualHint }}</span>
        </div>
      </div>

      <div class="acu-row">
        <label>{{ UI.plot.editorTaskName }}</label>
        <input v-model="selectedTask.name" class="acu-input" type="text" style="flex: 1 1 220px; min-width: 0" />
        <label class="acu-toggle">
          <input v-model="selectedTask.enabled" type="checkbox" class="acu-toggle__input" :aria-label="UI.plot.editorTaskEnabled" @change="toggleEnabled(selectedTask, $event)" />
          <span class="acu-toggle__track" aria-hidden="true" />
          <span class="acu-toggle__label">{{ UI.plot.editorTaskEnabled }}</span>
        </label>
      </div>

      <!-- 这个任务单独用哪条 API：留空 = 跟面板上「当前 API」走 -->
      <div class="acu-row">
        <label class="rh-field-label">{{ UI.plot.editorTaskApi }}</label>
        <select v-model="selectedTask.apiName" class="acu-select" style="flex: 1 1 auto; min-width: 0">
          <option value="">{{ UI.plot.editorTaskApiGlobal }}</option>
          <option v-for="name in props.apiNames ?? []" :key="name" :value="name">{{ name }}</option>
        </select>
      </div>
      <p class="acu-notes acu-notes--sm">{{ UI.plot.editorTaskApiHint }}</p>

      <!-- 小参数挤进一张网格：标签在上、输入框在下，比「一行一个标签」省一半高度。
           「顺序」不再给用户配：同一阶段本来就并发跑，顺序只由任务在列表里的位置决定。
           两行各包一个两列子网格：第一行「阶段 / 每几楼」，第二行「重试次数 / 最少字数」。
           手动触发隐藏「每几楼」时，阶段仍留在原来的位置，布局不塌。 -->
      <div class="acu-field-grid">
        <div class="task-manual-field-row">
          <label class="acu-field">
            <span class="acu-field__label">{{ UI.plot.editorTaskStage }}</span>
            <input v-model.number="selectedTask.stage" class="acu-input" type="number" min="1" />
          </label>
          <label v-if="!selectedTask.manual" class="acu-field">
            <span class="acu-field__label">{{ UI.plot.editorTaskEvery }}</span>
            <input v-model.number="selectedTask.everyRounds" class="acu-input" type="number" min="1" />
          </label>
        </div>
        <div class="task-manual-field-row">
          <label class="acu-field">
            <span class="acu-field__label">{{ UI.plot.editorTaskMaxRetries }}</span>
            <input v-model.number="selectedTask.maxRetries" class="acu-input" type="number" min="0" />
          </label>
          <label class="acu-field">
            <span class="acu-field__label">{{ UI.plot.editorTaskMinLength }}</span>
            <input v-model.number="selectedTask.minLength" class="acu-input" type="number" min="0" />
          </label>
        </div>
      </div>
      <p class="acu-notes acu-notes--sm">{{ UI.plot.editorTaskEveryHint }}</p>

      <div class="acu-row">
        <label class="rh-field-label">{{ UI.plot.editorTaskTags }}</label>
        <input v-model="selectedTask.extractTags" class="acu-input" type="text" placeholder="act,scene,recall" style="flex: 1 1 200px; min-width: 0" />
      </div>

      <div class="acu-row">
        <label class="rh-field-label">{{ UI.plot.editorTaskInject }}</label>
        <input v-model="selectedTask.extractInjectTags" class="acu-input" type="text" placeholder="留空 = 全部注入" style="flex: 1 1 200px; min-width: 0" />
      </div>

      <div class="acu-row">
        <label class="rh-field-label">{{ UI.plot.editorTaskExempt }}</label>
        <input v-model="selectedTask.exemptTags" class="acu-input" type="text" placeholder="留空 = 全部必达" style="flex: 1 1 200px; min-width: 0" />
      </div>
      <p class="acu-notes acu-notes--sm">{{ UI.plot.editorTaskExemptHint }}</p>

      <!--
        这里原来还有两块：「这个任务的最终指令」和「说明」。

        两块都不摆：
        - `finalDirectiveTemplate` 全仓除了读写自身没有任何地方读它，引擎真正用的是**预设级**
          的 `finalSystemDirective`（`round.ts:155` 做好替换后交给 `buildFinalMessage`）。
          界面上两个长得一样、一个有用一个没用，用户根本分不清。
        - `description` 只在读写自身时出现，运行时没有代码读它，纯给人看的备注。

        数据层两个字段都原样保留（兼容上游），只是不给编辑。
      -->

      <h4 style="margin-top: 14px">{{ UI.plot.editorTaskBlocks }}</h4>
      <p class="acu-notes">{{ UI.plot.editorTaskBlocksHint }}</p>
      <p v-if="allBlocksOff(selectedTask)" class="acu-notes" style="color: var(--acu-warning)">
        {{ UI.plot.editorTaskNoBlocks }}
      </p>
      <p v-else-if="anyBlocksOff" class="acu-notes acu-notes--sm">
        {{ UI.plot.editorTaskBlocksSomeOff }}
      </p>

      <div class="acu-task-prompt-zone">
        <!-- 上下各一个「插入」：ACU 就是这么摆的（`AcuPromptSegments.vue:2-7` 与 :90-94），
             用户在第一块上方要加内容时不必先滚到底部点一次再加一次上移 -->
        <div class="acu-block-add">
          <button class="acu-btn acu-btn--sm" type="button" @click="addBlock(selectedTask, 'top')">
            {{ UI.plot.editorBlockAddTop }}
          </button>
        </div>

        <PromptBlockCard
          v-for="(block, blockIndex) in selectedTask.blocks"
          :key="blockKeyOf(block)"
          :block="block"
          :index="blockIndex"
          :count="selectedTask.blocks.length"
          @move="moveBlock(selectedTask, blockIndex, $event)"
          @copy="copyBlock(selectedTask, blockIndex)"
          @send="emit('copyBlock', block)"
          @remove="dropBlock(selectedTask, blockIndex)"
        />

        <div class="acu-block-add">
          <button class="acu-btn acu-btn--sm" type="button" @click="addBlock(selectedTask, 'bottom')">
            {{ UI.plot.editorBlockAddBottom }}
          </button>
        </div>
      </div>

      <div class="acu-row" style="margin-top: 12px; justify-content: flex-end">
        <button class="acu-btn danger acu-btn--sm" type="button" @click="dropTask(selectedIndex)">
          {{ UI.plot.editorTaskDrop }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 任务的小参数：两行两列 —— 第一行「阶段 / 每几楼」，第二行「重试次数 / 最少字数」。
   每行各包一个两列子网格，手动触发隐藏「每几楼」时另一个仍留在原位，布局不塌。 */
.acu-field-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 6px 8px;
  margin-top: 8px;
}

.task-manual-field-row {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px 8px;
  min-width: 0;
}

.acu-field {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.acu-field__label {
  font-size: 11px;
  line-height: 1.3;
  color: var(--acu-text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 手动触发开关：圆圈按钮，开启时圆圈内部被颜色块填满。
   类名统一加 task-manual- 前缀，不与公共样式里的 acu-toggle 撞名。
   #c9a86a 是初定的金色调，真机过目后再定；关键可视属性带 !important，抗酒馆页面默认按钮样式。 */
.task-manual-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin-bottom: 10px;
}

.task-manual-switch {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px !important;
  height: 26px !important;
  padding: 0 !important;
  border: 0 !important;
  background: transparent !important;
  cursor: pointer;
}

.task-manual-switch__ring {
  position: relative;
  display: block;
  box-sizing: border-box;
  width: 20px !important;
  height: 20px !important;
  border: 2px solid var(--acu-border) !important;
  border-radius: 50% !important;
  background: transparent !important;
  transition: border-color 0.2s ease;
}

/* 内圆 = 「圆圈内部被颜色块填满」：关闭时透明，开启时填金色。 */
.task-manual-switch__ring::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: transparent;
  transition: background 0.2s ease;
}

.task-manual-switch[aria-pressed='true'] .task-manual-switch__ring {
  border-color: #c9a86a !important;
}

.task-manual-switch[aria-pressed='true'] .task-manual-switch__ring::after {
  background: #c9a86a !important;
}

.task-manual-copy {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.task-manual-copy__label {
  font-size: var(--acu-font-size-body-lg);
  line-height: 1.35;
  color: var(--acu-text-1);
}

.task-manual-copy__hint {
  font-size: 11px;
  line-height: 1.4;
  color: var(--acu-text-3);
}
</style>
