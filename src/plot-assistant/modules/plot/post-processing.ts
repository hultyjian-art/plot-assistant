/**
 * 剧情推进 — 「提示词后处理」借用器。
 *
 * ## 为什么需要「借」
 *
 * 这个参数在酒馆里叫 `custom_prompt_post_processing`，作用是**在服务端拼好 messages 之后、
 * 发往上游之前**，按指定策略合并/规整消息（合并连续同角色、严格合并系统提示等）。
 * 它由服务端（`SillyTavern/src/endpoints/backends/chat-completions.js:2161`）从
 * **请求体顶层**读取 —— 必须出现在 generate 请求的 body 里才算数。
 *
 * 而酒馆助手 `generateRaw` 这条链路里，这个字段是**从酒馆预设设置里抄的**
 * （`createGenerationParametersCompat.ts:138`：`custom_prompt_post_processing: settings.custom_prompt_post_processing`），
 * 不读 `custom_api`。所以想按剧情推进的 API 条目单独设一个值，只有一条路：
 * 调用期间临时改酒馆那一格，调用结束**立刻还原**。
 *
 * ## 为什么单独抽一层
 *
 * 「临时改全局、用完还回去」最怕两件事：
 * 1. **并发**：同一阶段的任务是一起发的。两个任务同时改同一格，后完成的那个会把值还原成
 *    「它进来之前的那个」—— 也就是另一个任务设置的值，于是第三个任务拿到错的值。
 *    所以用引用计数：只在第一次借用时写、最后一次归还时还原。
 * 2. **覆盖用户的选择**：万一用户在借用期间自己改了那一格，归还时不能拿旧值硬盖回去。
 *    所以还原前先读一次，只有「还是我们写进去的那个值」才还。
 *
 * 本文件不碰酒馆全局：读写都走注入的 `PostProcessingPort`，可在 Node 里直接测。
 * 真正接酒馆的实现见 `data/post-processing-host.ts`。
 */

/** 设置里代表「跟随酒馆，不动它」的哨兵值。空串则是「显式要求不处理」。 */
export const POST_PROCESSING_FOLLOW = 'follow';

/** 借用期间读写酒馆设置的接口。读不到时 `read()` 返回 `null`。 */
export interface PostProcessingPort {
  read(): string | null;
  write(value: string): void;
}

export interface PostProcessingBorrow {
  /** 归还：幂等，重复调用无副作用。 */
  release(): void;
  /** 这次借用是否真的改动了酒馆设置。 */
  changed: boolean;
  /** 没能按预期生效时的说明（给用户看），正常为 `null`。 */
  note: string | null;
}

export interface PostProcessingBorrower {
  borrow(mode: string): PostProcessingBorrow;
  /** 当前借用状态，测试与排查用。 */
  peek(): { active: number; value: string | null };
}

export function createPostProcessingBorrower(port: PostProcessingPort): PostProcessingBorrower {
  let active = 0;
  let applied: string | null = null;
  let previous = '';

  /** 归还所有权的公共逻辑：最后一个走的负责还原。 */
  const makeRelease = (): (() => void) => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active = Math.max(0, active - 1);
      if (active > 0) return;
      // 用户在借用期间自己改过 → 那是他的新选择，不许拿旧值盖回去
      const now = port.read();
      if (now === applied) port.write(previous);
      applied = null;
      previous = '';
    };
  };

  const noop = (note: string | null): PostProcessingBorrow => ({
    release: () => undefined,
    changed: false,
    note,
  });

  return {
    borrow(mode: string): PostProcessingBorrow {
      const wanted = typeof mode === 'string' ? mode.trim() : '';
      // 「跟随酒馆」与没填都不该动别人的设置
      if (wanted === '' || wanted === POST_PROCESSING_FOLLOW) return noop(null);

      if (active > 0) {
        // 已经有人在借：同值就只加计数；不同值这一轮沿用它，并说清原因 ——
        // 偷偷改成两种值之一，会让另一个任务拿到错的设置而毫无提示。
        if (applied === wanted) {
          active += 1;
          return { changed: true, note: null, release: makeRelease() };
        }
        return noop(`同一时刻另一批任务正在用「${applied ?? ''}」，这一轮沿用了它`);
      }

      const current = port.read();
      if (current === null) {
        return noop('读不到酒馆的「提示词后处理」设置，这一轮没有改它');
      }
      if (current === wanted) return noop(null);

      previous = current;
      applied = wanted;
      active = 1;
      port.write(wanted);
      return { changed: true, note: null, release: makeRelease() };
    },

    peek(): { active: number; value: string | null } {
      return { active, value: applied };
    },
  };
}
