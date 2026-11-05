/**
 * 第 6 期：面板按钮真正动手的那一层（读楼层、写楼层、塞输入框）。
 *
 * 放在这里而不是面板里：面板只管「点了哪个按钮、要不要弹确认」，
 * 碰聊天记录和 DOM 的事集中在这一层，将来改口径只改一处。
 */
import { pageQuery } from '../tavern';
import { applyLandingToFloor, hasPlotBlock, inputTextWithLanding } from './stash-apply';

export interface StashApplyResult {
  ok: boolean;
  /** 失败时给人看的一句话；成功时是空串 */
  reason?: string;
}

/** 读楼层正文；楼层不存在（被删了）返回 null。 */
export function readFloorText(floorId: number): string | null {
  const rows = getChatMessages(floorId);
  const first = Array.isArray(rows) ? rows[0] : null;
  if (!first) return null;
  const message = (first as { message?: unknown }).message;
  return typeof message === 'string' ? message : null;
}

/**
 * 把某一版换进楼层正文。
 *
 * 只改 `message` 一个字段：`extra` 里那四个 qrf 键是发送链补写的，
 * 这里动它等于把「上一轮剧情」和「这一版」拆成两套，下一轮 `$6` 会读错。
 */
export async function applyLandingToFloorMessage(floorId: number, finalText: string): Promise<StashApplyResult> {
  const current = readFloorText(floorId);
  if (current === null) {
    return { ok: false, reason: `第 ${floorId} 楼不在了（可能已经被删除或回退），没法写入。` };
  }
  if (hasPlotBlock(current) && !hasPlotBlock(finalText)) {
    return { ok: false, reason: '这一版里没有 <plot> 段，写进楼层会让下一轮读不到这段剧情，所以没写。' };
  }
  const next = applyLandingToFloor(current, finalText);
  if (next === current) return { ok: true };
  try {
    await setChatMessages([{ message_id: floorId, message: next }], { refresh: 'affected' });
    return { ok: true };
  } catch (error) {
    console.error('[剧情推进助手] 写入楼层失败', error);
    return { ok: false, reason: String((error as Error)?.message ?? error) };
  }
}

/** 把「用户原话 + 这一版」塞进输入框，并补一次 input 事件让酒馆自己重算高度。 */
export function putLandingIntoInputBox(userText: string, finalText: string): StashApplyResult {
  const p$ = pageQuery();
  const $box = p$('#send_textarea');
  if (!$box || $box.length === 0) {
    return { ok: false, reason: '没找到酒馆的输入框（页面可能还没加载完）。' };
  }
  const text = inputTextWithLanding(userText, finalText);
  $box.val(text).trigger('input');
  const node = $box[0] as HTMLTextAreaElement | undefined;
  if (node) {
    $box.css('height', 'auto').css('height', `${node.scrollHeight}px`);
  }
  return { ok: true };
}
