/**
 * 跨预设剪贴板 —— 任务与提示词块都放这里。
 *
 * 形态照搬工作流助手的 `ui/composables/useTaskClipboard.ts`：**模块级的两个格子**，
 * 不是「选一个目标预设，直接写进去」。理由（也是它当初这么做的原因）：
 * - 跨预设写盘要先读目标预设、合并、再写回，中间任何一步失败都会留下半份数据；
 * - 而「复制 → 切预设 → 粘贴」这条路上，用户看得见自己切到了哪份预设、粘进了哪个位置，
 *   出了错也只是多了一段，删掉即可。
 *
 * 拷贝的是**深拷贝**：粘进新预设后，改粘贴出来的那份不能回头改到剪贴板里的原件。
 * 存储只放内存，刷新页面就清空 —— 剪贴板本来就是「这一次操作」的东西。
 */
import { computed, ref } from 'vue';
import type { TaskBlockDraft, TaskDraft } from '../plot/preset-edit';

interface TaskClip {
  task: TaskDraft;
  /** 从哪份预设复制的，粘贴按钮的提示里会显示 */
  source: string;
}

interface BlockClip {
  block: TaskBlockDraft;
  source: string;
}

const taskClip = ref<TaskClip | null>(null);
const blockClip = ref<BlockClip | null>(null);

export const hasTaskClip = computed(() => taskClip.value !== null);
export const hasBlockClip = computed(() => blockClip.value !== null);
export const taskClipSource = computed(() => taskClip.value?.source ?? '');
export const blockClipSource = computed(() => blockClip.value?.source ?? '');

/** 只留草稿里的纯数据，别把 vue 的响应式代理带进剪贴板。 */
function clonePlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function copyTaskToClip(task: TaskDraft, source: string): void {
  if (!task) return;
  taskClip.value = { task: clonePlain(task), source: (source || '').trim() };
}

export function readTaskClip(): TaskDraft | null {
  const clip = taskClip.value;
  return clip ? clonePlain(clip.task) : null;
}

export function copyBlockToClip(block: TaskBlockDraft, source: string): void {
  if (!block) return;
  blockClip.value = { block: clonePlain(block), source: (source || '').trim() };
}

export function readBlockClip(): TaskBlockDraft | null {
  const clip = blockClip.value;
  return clip ? clonePlain(clip.block) : null;
}
