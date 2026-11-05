/**
 * 剧情推进 — `$7`「以下是前文的故事发展」
 *
 * 从聊天记录里倒着数 N 条 AI 输出（`plotSettings.contextTurnCount`，默认 1），
 * 拼成一段给 AI 看的参考文本。纯函数：只读传进来的数组，不碰全局状态。
 *
 * 四个容易数错的地方（都写了用例）：
 *  1. 尾部若有「真实 AI 占位的假楼层」，要先跳过去 —— 那不是历史。
 *  2. 当前这条用户输入不参与（ACU 有一处位移判断，但**位移与否对 `$7` 结果没有影响**，
 *     因为扫描循环本来就跳过 `is_user`；这个结论有用例钉着，别"优化"掉）。
 *  3. 扫描时同时跳过 `is_user`、`_qrf_from_planning`、`_qrf_plot_pending_placeholder`。
 *  4. `contextTurnCount` 为 0 直接给空数组，不是"默认 1"。
 */
import { sanitizeHtml } from './prompt-build';

/** 只用到这四个字段；其余字段（楼层号、名字等）与本层无关。 */
export interface HistoryMessageLike {
  is_user?: boolean;
  mes?: string;
  /** 由「预规划」产生的楼层，不属于正式历史。 */
  _qrf_from_planning?: boolean;
  /** 真实 AI 占位的假楼层，不属于历史。 */
  _qrf_plot_pending_placeholder?: boolean;
}

/** 取出来的一段历史。`content` 允许是 undefined（原件就是这么传的，由 sanitize 兜底）。 */
export interface HistorySegment {
  role: 'assistant';
  content: string | undefined;
}

/** 前文注入文本的固定抬头（原件一字不差，含末尾全角冒号）。 */
export const HISTORY_PREFIX = '以下是前文的故事发展（AI输出），给你用作参考：';

/** 多段之间的连接符：空格 + 换行 + 空格（不是单纯的换行，别"顺手简化"）。 */
export const HISTORY_JOINER = ' \n ';

/** 默认过滤器：原样返回，把内容当字符串。 */
function identityFilter(content: string | undefined): string | undefined {
  return content;
}

/**
 * 从 `chat` 里倒着取最近 `contextTurnCount` 条 AI 输出（正序返回）。
 *
 * @param chat 聊天楼层数组（下标即楼层号）
 * @param userMessage 本轮用户输入。原件拿它做一次位移判断，但对 `$7` 无影响，保留是为了将来对齐
 * @param contextTurnCount 取几条，`<= 0` 返回空数组
 * @param filter 每条正文的预处理器（对应原件的标签抽取/剔除），默认透传
 * @param hasFilters 是否启用过滤器（原件按四个配置字段是否非空来决定要不要过滤）
 */
export function pickHistoryMessages(
  chat: HistoryMessageLike[] | null | undefined,
  userMessage: string,
  contextTurnCount: number,
  filter: (content: string | undefined) => string | undefined = identityFilter,
  hasFilters = false,
): HistorySegment[] {
  const list: HistoryMessageLike[] = Array.isArray(chat) ? chat : [];
  let contextEndIndex = list.length - 1;

  // 真实 AI 占位不属于历史；当前 user 通过独立用户输入注入。
  while (contextEndIndex >= 0 && list[contextEndIndex] && list[contextEndIndex]._qrf_plot_pending_placeholder) {
    contextEndIndex -= 1;
  }
  // 当前位置若是本轮用户输入，原件会再退一格。
  // 注意：退与不退对 `$7` 结果没有区别（下面循环本来就跳过 is_user），此处如实保留。
  if (contextEndIndex >= 0 && list[contextEndIndex] && list[contextEndIndex].is_user) {
    if (String(list[contextEndIndex].mes || '') === String(userMessage || '')) {
      contextEndIndex -= 1;
    }
  }

  if (!(contextTurnCount > 0)) return [];

  const extracted: HistorySegment[] = [];
  let aiCount = 0;
  for (let i = contextEndIndex; i >= 0 && aiCount < contextTurnCount; i -= 1) {
    const msg = list[i];
    if (!msg) continue;
    if (msg.is_user) continue;
    if (msg._qrf_from_planning || msg._qrf_plot_pending_placeholder) continue;

    const content = hasFilters ? filter(msg.mes) : msg.mes;
    extracted.unshift({ role: 'assistant', content });
    aiCount += 1;
  }
  return extracted;
}

/**
 * 把取到的历史拼成注入文本。空数组或全空白时返回空串（提示词里不留半截抬头）。
 */
export function buildHistoryDigest(segments: HistorySegment[] | null | undefined): string {
  const list = Array.isArray(segments) ? segments : [];
  const formattedHistory = list
    .map(segment => `assistant："${sanitizeHtml(segment.content)}"`)
    .join(HISTORY_JOINER);
  return formattedHistory && formattedHistory.trim() ? `${HISTORY_PREFIX}\n ${formattedHistory}` : '';
}
