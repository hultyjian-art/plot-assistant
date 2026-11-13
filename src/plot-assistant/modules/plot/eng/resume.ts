/**
 * plot/eng/resume.ts — 断点续跑的编排决策（纯函数）
 *
 * 场景（施工方案 §7）：一轮推进里阶段 1 全成、阶段 2 跑了一半就断了。
 * 用户重刷时不该从头再来 —— 已经成功的任务不再重跑，但**它们产出的标签必须照样注入**，
 * 否则阶段 2 的任务会拿到一份空的前情，结果还不如重跑。
 *
 * 这一层只做两个决定：
 *   1. 这次跑哪些任务（`working.done` 里的跳过）
 *   2. 起点带着哪些标签（把已完成任务的标签按任务顺序重放成 `relayTagMap`）
 *
 * 不碰存储、不碰引擎。存储形状见 `../stash-model.ts` 的 `StashWorking.taskTags`。
 *
 * 三条约定：
 * - **顺序照入参**。调用方传进来的 `tasks` 应当已经按阶段/序号排好，
 *   这里不再排序 —— 标签的先后会体现在 `buildTagBlock` 的拼接顺序上。
 * - **只认入参里存在的任务**。`working.done` 或 `taskTags` 里有过期的 id（用户删了任务、
 *   换了预设），直接忽略，不报错也不造出幽灵标签。
 * - **同标签名多次出现就堆成数组**。与 `aggregateTaskTags` 同构，
 *   下游 `buildTagBlock` 会用空行把它们连起来。
 */
import type { StashWorking, WorkingTaskTags } from '../stash-model';
import type { TagMap } from './tags';

export interface ResumeTaskLike {
  id: string;
}

export interface ResumePlan<T extends ResumeTaskLike> {
  /** 这次真要跑的（顺序与入参一致） */
  tasks: T[];
  /** 被跳过的任务 id（顺序与入参一致） */
  skippedTaskIds: string[];
  /** 已完成任务留下的标签，直接拿去当阶段接力的起点 */
  relayTagMap: TagMap;
  /** 已完成任务里记进「只进字段」名单的标签名（只作标注，不决定正文注入） */
  injectedTagNames: Set<string>;
}

/**
 * 从账本里算出这一轮该怎么跑。
 *
 * `working` 为空（第一次跑）时返回原样的任务表与空标签 —— 与没有暂存层时的行为完全一致。
 */
export function buildResumePlan<T extends ResumeTaskLike>(
  tasks: T[],
  working: StashWorking | null | undefined,
): ResumePlan<T> {
  const list = Array.isArray(tasks) ? tasks.filter(task => task && typeof task.id === 'string' && task.id) : [];

  const done = new Set<string>();
  if (working && Array.isArray(working.done)) {
    for (const id of working.done) {
      if (typeof id === 'string' && id) done.add(id);
    }
  }

  const stored: Record<string, WorkingTaskTags> = {};
  if (working && working.taskTags && typeof working.taskTags === 'object') {
    for (const [id, entry] of Object.entries(working.taskTags)) {
      if (id && entry && typeof entry === 'object') stored[id] = entry;
    }
  }

  const runnable: T[] = [];
  const skippedTaskIds: string[] = [];
  const relayTagMap: TagMap = new Map();
  const injectedTagNames = new Set<string>();

  for (const task of list) {
    if (!done.has(task.id)) {
      runnable.push(task);
      continue;
    }
    skippedTaskIds.push(task.id);

    const saved = stored[task.id];
    if (!saved) continue;

    if (saved.tags && typeof saved.tags === 'object') {
      for (const [name, content] of Object.entries(saved.tags)) {
        if (!name || typeof content !== 'string' || !content.trim()) continue;
        relayTagMap.set(name, appendTag(relayTagMap.get(name), content));
      }
    }
    if (Array.isArray(saved.injectOnly)) {
      for (const name of saved.injectOnly) {
        if (typeof name === 'string' && name.trim()) injectedTagNames.add(name.trim());
      }
    }
  }

  return { tasks: runnable, skippedTaskIds, relayTagMap, injectedTagNames };
}

/** 把一个标签内容追加到既有的槽位上，保持「同标签堆数组」的形状。 */
function appendTag(previous: string | string[] | undefined, content: string): string[] {
  if (Array.isArray(previous)) return [...previous, content];
  if (typeof previous === 'string') return [previous, content];
  return [content];
}
