/**
 * 复制粘贴剪贴板 —— 任务与提示词块共用**一个格子**。
 *
 * 形态照搬工作流助手的 useTaskClipboard：模块级内存格，不是「选目标直接写进去」。
 * 「复制 → 弹出选择窗口 → 点目标」这条路上，用户看得见自己粘到了哪份预设的哪个位置，
 * 出了错也只是多了一段，删掉即可；而粘贴前的自动保存（在 PlotPage 里）给了一份可回退的底。
 *
 * 拷贝一律深拷：粘进目标后，改粘贴出来的那份不能回头改到剪贴板里的原件。
 * 只放内存，刷新页面就清空 —— 剪贴板本来就是「这一次操作」的东西。
 */
import { computed, ref } from 'vue';
import type { TaskBlockDraft, TaskDraft } from '../plot/preset-edit';

export type ClipKind = 'block' | 'task';

export interface Clip {
  kind: ClipKind;
  block: TaskBlockDraft | null;
  task: TaskDraft | null;
  /** 从哪份预设复制的，弹窗里显示给用户看 */
  source: string;
}

const clip = ref<Clip | null>(null);

export const clipKind = computed<ClipKind | null>(() => clip.value?.kind ?? null);
export const clipSource = computed(() => clip.value?.source ?? '');

/** 只留草稿里的纯数据，别把 vue 的响应式代理带进剪贴板。 */
function clonePlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function copyTaskToClip(task: TaskDraft, source: string): void {
  if (!task) return;
  clip.value = { kind: 'task', block: null, task: clonePlain(task), source: (source || '').trim() };
}

export function copyBlockToClip(block: TaskBlockDraft, source: string): void {
  if (!block) return;
  clip.value = { kind: 'block', block: clonePlain(block), task: null, source: (source || '').trim() };
}

/** 统一读出：粘的时候只读这一处，调用方不必关心剪贴板里装的是任务还是块。 */
export function readClip(): Clip | null {
  const value = clip.value;
  if (!value) return null;
  return {
    kind: value.kind,
    block: value.block ? clonePlain(value.block) : null,
    task: value.task ? clonePlain(value.task) : null,
    source: value.source,
  };
}
