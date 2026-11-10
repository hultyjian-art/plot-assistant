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
import { blockKeyOf } from './block-key';
import PromptBlockCard from './PromptBlockCard.vue';
import { countBlocks, moveBlock as moveBlockInList } from '../plot/eng/prompt-blocks';

const props = defineProps<{
  tasks: TaskDraft[];
  /** 当前预设名：只用来在剪贴板提示里显示「从哪份预设复制的」 */
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

function dropTask(index: number): void {
  props.tasks.splice(index, 1);
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
      <div class="acu-row">
        <label>{{ UI.plot.editorTaskName }}</label>
        <input v-model="selectedTask.name" class="acu-input" type="text" style="flex: 1 1 220px; min-width: 0" />
        <label class="acu-toggle">
          <input v-model="selectedTask.enabled" type="checkbox" class="acu-toggle__input" :aria-label="UI.plot.editorTaskEnabled" />
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
           「顺序」不再给用户配：同一阶段本来就并发跑，顺序只由任务在列表里的位置决定。 -->
      <div class="acu-field-grid">
        <label class="acu-field">
          <span class="acu-field__label">{{ UI.plot.editorTaskStage }}</span>
          <input v-model.number="selectedTask.stage" class="acu-input" type="number" min="1" />
        </label>
        <label class="acu-field">
          <span class="acu-field__label">{{ UI.plot.editorTaskMaxRetries }}</span>
          <input v-model.number="selectedTask.maxRetries" class="acu-input" type="number" min="0" />
        </label>
        <label class="acu-field">
          <span class="acu-field__label">{{ UI.plot.editorTaskMinLength }}</span>
          <input v-model.number="selectedTask.minLength" class="acu-input" type="number" min="0" />
        </label>
        <label class="acu-field">
          <span class="acu-field__label">{{ UI.plot.editorTaskEvery }}</span>
          <input v-model.number="selectedTask.everyRounds" class="acu-input" type="number" min="1" />
        </label>
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
/* 任务的小参数：一格里「标签在上、框在下」，5 个挤一行，手机上也只折一次 */
.acu-field-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(84px, 1fr));
  gap: 6px 8px;
  margin-top: 8px;
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
</style>
