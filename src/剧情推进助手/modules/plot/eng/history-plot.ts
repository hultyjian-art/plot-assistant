/**
 * 剧情推进 — `$6`「上一轮的规划结果」
 *
 * 从聊天记录里往回找**上一次落盘的 `<plot>` 正文**，按当前预设名做隔离。
 * 纯函数：只读传进来的数组，不碰全局状态。
 *
 * 为什么单独一层：这一层的判断错一点，剧情就接不上或串戏，而且**不报错**：
 *  - 找太近 → 读到本轮自己（自读），AI 把自己的上一稿当历史；
 *  - 找太远 / 跨预设 → 拿到别的预设留下的规划，剧情串味；
 *  - 只认新结构 → 老聊天里的无标签旧数据读不到，历史断层。
 *
 * 五个约定（都有用例）：
 *  1. 锚点只在**给的时候**才生效；不给锚点就从头到尾扫。
 *  2. 锚点给了却匹配不上（swipe / 重试时标记已被消费），末条带 `qrf_plot` 的用户层
 *     就是"当前层"，上界要退一格 —— **否则会自读**。
 *  3. 预设名非空时必须精确相等；`''` 表示"不隔离，取最新的一条"。
 *  4. 精确匹配失败后有一次**兼容回退**：找 `qrf_plot_preset` 为空的旧数据。
 *  5. `taskId` 给了就先在新结构 `qrf_plot_tasks` 里按任务取，取不到再回退旧结构。
 */
import { hashUserInput } from './hash';

/** 只用到这些字段；其余字段与本层无关。 */
export interface PlotHistoryMessageLike {
  is_user?: boolean;
  mes?: string;
  qrf_plot?: string;
  qrf_plot_preset?: string;
  qrf_plot_tasks?: Record<string, unknown>;
  _qrf_plot_pending_hash?: string;
}

export interface PlotHistoryOptions {
  /** 只读本轮用户输入之前的楼层：优先用哈希定位，其次用原文定位。 */
  beforeUserInputHash?: string;
  beforeUserInputText?: string;
  /** 显式指定检索上界（不含），优先级高于锚点。 */
  beforeIndex?: number;
  /** 指定任务 id 时走 `qrf_plot_tasks` 分支。 */
  taskId?: string;
  /** 预设名；不给由调用方另行传入 `currentPresetName`。 */
  presetName?: string;
}

/**
 * 找到「本轮用户输入」所在楼层，作为检索上界的锚点。找不到返回 -1。
 */
export function findPlotHistoryAnchor(
  chat: PlotHistoryMessageLike[] | null | undefined,
  options: PlotHistoryOptions = {},
): number {
  if (!Array.isArray(chat) || chat.length === 0) return -1;
  const beforeUserInputHash = String(options?.beforeUserInputHash || '').trim();
  const beforeUserInputText = String(options?.beforeUserInputText || '');
  if (!beforeUserInputHash && !beforeUserInputText.trim()) return -1;

  for (let i = chat.length - 1; i >= 0; i -= 1) {
    const message = chat[i];
    if (!message?.is_user) continue;
    if (beforeUserInputHash && message._qrf_plot_pending_hash === beforeUserInputHash) {
      return i;
    }
    const messageText = String(message.mes || '');
    if (beforeUserInputHash && hashUserInput(messageText) === beforeUserInputHash) {
      return i;
    }
    if (!beforeUserInputHash && beforeUserInputText && messageText === beforeUserInputText) {
      return i;
    }
  }

  return -1;
}

/**
 * 检索上界（含）。返回 -1 表示没有可检索的范围。
 */
export function getPlotHistorySearchUpperBound(
  chat: PlotHistoryMessageLike[] | null | undefined,
  options: PlotHistoryOptions = {},
): number {
  if (!Array.isArray(chat) || chat.length === 0) return -1;

  if (Number.isFinite(options?.beforeIndex)) {
    return Math.min(chat.length - 1, Math.floor(Number(options.beforeIndex)) - 1);
  }

  const hasHistoryAnchor = Boolean(
    String(options?.beforeUserInputHash || '').trim() || String(options?.beforeUserInputText || '').trim(),
  );
  if (!hasHistoryAnchor) return chat.length - 1;

  const anchorIndex = findPlotHistoryAnchor(chat, options);
  if (anchorIndex >= 0) return anchorIndex - 1;

  // 给了锚点却匹配不上：末条带 plot 的用户层就是"当前层"，不能当上一轮返回。
  const lastIndex = chat.length - 1;
  const lastMessage = chat[lastIndex];
  if (lastMessage?.is_user && lastMessage.qrf_plot) {
    return lastIndex - 1;
  }
  return lastIndex;
}

/**
 * 取上一次落盘的 `<plot>` 正文。找不到返回空串。
 *
 * @param currentPresetName 当前预设名。`''` = 不隔离（取最新一条）；非空 = 必须精确相等
 */
export function getPlotFromHistory(
  chat: PlotHistoryMessageLike[] | null | undefined,
  options: PlotHistoryOptions = {},
  currentPresetName: string | null | undefined = '',
): string {
  if (!chat || chat.length === 0) return '';

  const presetName = typeof currentPresetName === 'string' ? currentPresetName : '';
  const upperBound = getPlotHistorySearchUpperBound(chat, options);
  if (upperBound < 0) return '';

  // 指定了 taskId：先从新结构 qrf_plot_tasks 按任务维度读
  const targetTaskId = String(options?.taskId || '').trim();
  if (targetTaskId) {
    for (let i = upperBound; i >= 0; i -= 1) {
      const message = chat[i];
      if (message && message.qrf_plot_tasks && typeof message.qrf_plot_tasks === 'object') {
        const plotPresetName = message.qrf_plot_preset || '';
        if (presetName !== '' && plotPresetName !== presetName) continue;
        const taskContent = message.qrf_plot_tasks[targetTaskId];
        if (typeof taskContent === 'string' && taskContent.trim()) {
          return taskContent;
        }
      }
    }
  }

  let latestPlotContent = '';
  for (let i = upperBound; i >= 0; i -= 1) {
    const message = chat[i];
    if (!message || !message.qrf_plot) continue;
    const plotPresetName = message.qrf_plot_preset || '';
    if (presetName === '') {
      latestPlotContent = message.qrf_plot;
      break;
    }
    if (plotPresetName === presetName) {
      latestPlotContent = message.qrf_plot;
      break;
    }
  }

  // 精确匹配失败 → 兼容回退到无标签旧数据
  if (!latestPlotContent && presetName !== '') {
    for (let i = upperBound; i >= 0; i -= 1) {
      const message = chat[i];
      if (!message || !message.qrf_plot) continue;
      if ((message.qrf_plot_preset || '') === '') {
        latestPlotContent = message.qrf_plot;
        break;
      }
    }
  }

  return latestPlotContent;
}
