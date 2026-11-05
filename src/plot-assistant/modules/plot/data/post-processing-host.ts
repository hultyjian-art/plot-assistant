/**
 * 剧情推进 — 「提示词后处理」与酒馆设置之间的适配层。
 *
 * 纯逻辑在 `plot/post-processing.ts`，这里只负责把它接到酒馆那本设置上。
 *
 * ## 借的是哪一格
 *
 * 酒馆把预设设置挂在 `oai_settings` 上，酒馆助手通过 `getContext()` 暴露为
 * `chatCompletionSettings`（`SillyTavern/public/scripts/st-context.js:226`）。
 * 那一格里既有界面上的「提示词后处理」下拉，也有发送时真正被抄进请求体的值
 * （`openai.js:2765`），所以改它等于替用户临时动一次那个下拉 —— 用完必须还回去，
 * 归还逻辑（含并发与「用户中途自己改过」）在 `plot/post-processing.ts` 里。
 *
 * ## 为什么不能走 custom_api
 *
 * 酒馆助手的 `applyCustomApiOverrides` 白名单里没有这个键
 * （`createGenerationParametersCompat.ts`），`custom_include_body` 也不是同一条路：
 * 那个是合进**发往上游的 bodyParams**，而这个键要出现在**发给酒馆后端的请求体顶层**
 * 才会被 `postProcessPrompt` 认（`chat-completions.js:2161`）。所以只能借。
 *
 * ## 为什么不直接 import `modules/tavern.ts`
 *
 * 那个模块引用了 `$` / `toastr` 两个酒馆全局类型，是给打包后的脚本用的；
 * 本文件会被对照测试的编译器一路拖进去，那边没有这两个全局，一引就整份编不过。
 * 所以这里只用 `globalThis` 走一遍 self → parent 取 `SillyTavern.getContext()`，
 * 与 `tavern.ts` 的取法一致，但不依赖它的类型环境。
 */

import { createPostProcessingBorrower, type PostProcessingBorrower, type PostProcessingPort } from '../post-processing';

/** 酒馆设置里我们关心的那一格的最小形状。 */
interface PostProcessingSettingsLike {
  custom_prompt_post_processing?: unknown;
}

interface ContextApiLike {
  getContext?: () => unknown;
}

/**
 * 依次在当前窗口与父窗口上找 `SillyTavern.getContext()`。
 *
 * 脚本本身跑在 iframe 里，`SillyTavern` 通常挂在父窗口；但也有版本把它挂在自己窗口上。
 * 取不到（未加载完、跨域、Node 里跑测试）一律返回 null，调用方按「读不到」处理。
 */
function tavernContext(): Record<string, unknown> | null {
  const seen: unknown[] = [];
  let current: unknown = globalThis;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    if (seen.includes(current)) break;
    seen.push(current);
    const holder = current as Record<string, unknown>;
    const api = holder.SillyTavern as ContextApiLike | undefined;
    if (api && typeof api.getContext === 'function') {
      try {
        const context = api.getContext();
        if (context && typeof context === 'object') return context as Record<string, unknown>;
      } catch (error) {
        // 这一版酒馆的 getContext 可能因为没初始化完而抛错 —— 继续往上找，别把面板打挂
        console.warn('[剧情推进助手] 读酒馆上下文失败，继续找父窗口', error);
      }
    }
    const parent = holder.parent;
    if (parent && typeof parent === 'object' && parent !== current) {
      current = parent;
      continue;
    }
    break;
  }
  return null;
}

function settingsOf(): PostProcessingSettingsLike | null {
  const context = tavernContext();
  const settings = context?.chatCompletionSettings;
  if (!settings || typeof settings !== 'object') return null;
  return settings as PostProcessingSettingsLike;
}

export const tavernPostProcessingPort: PostProcessingPort = {
  read(): string | null {
    const settings = settingsOf();
    if (!settings) return null;
    const value = settings.custom_prompt_post_processing;
    // 酒馆里这一格没写过时是 undefined，语义等于「不处理」，用空串表达
    if (typeof value === 'string') return value;
    return value === undefined ? '' : null;
  },
  write(value: string): void {
    const settings = settingsOf();
    if (!settings) return;
    settings.custom_prompt_post_processing = value;
  },
};

/** 全局单例：引用计数必须在进程内共享，否则并发任务各自记账、互相覆盖。 */
export const tavernPostProcessing: PostProcessingBorrower = createPostProcessingBorrower(tavernPostProcessingPort);
