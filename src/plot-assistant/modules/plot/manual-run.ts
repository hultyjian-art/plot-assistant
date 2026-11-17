/**
 * 批 109：手动触发「独立跑」的入口。
 *
 * 改动前：点楼层按钮只是往聊天变量里写一条预约，等用户下一次点发送，才由
 * mountPlotSendGate 拦下来跑。用户 2026-11-15 拍板改成：点按钮后等 3 秒，不看有没有
 * 发消息，直接以「最新一条用户楼层」为锚跑一轮，并把成果写回那一层。
 *
 * 这里刻意不碰 clearTail / issueSend / completePlotSend：用户明确说过「不能是重跑
 * 已经存在的用户楼层，是额外进行任务，不能清空已经存在的用户楼层」。
 */

import type { RerushContext } from '../types';
import { captureWithPresets } from '../regex';
import { appendPlotBlock } from './run-in-flow';
import { pageToastr } from '../tavern';

/** 两轮独立跑串行：一轮要调好几次 LLM，跑动中再点按钮不该并发写同一层的账本。 */
let queue: Promise<void> = Promise.resolve();

/**
 * 由 manual-buttons.ts 的 3 秒定时器调用。
 * 预约表由 appendPlotBlock 自己读：三秒内点的多个按钮自然合并成一轮，
 * 引擎照旧按阶段先后、同阶段并行（用户 2026-11-15「别的任务流程还是和现版本一样」）。
 */
export function runManualTriggeredRound(ctx: RerushContext): Promise<void> {
  queue = queue.then(() => runOnce(ctx)).catch((error) => {
    console.error('[剧情推进助手] 手动触发独立跑失败', error);
    pageToastr().warning('手动触发的这一轮出错了，详情看控制台');
  });
  return queue;
}

async function runOnce(ctx: RerushContext): Promise<void> {
  const floors = getChatMessages('0-{{lastMessageId}}');
  const last = [...floors].reverse().find((item) => item?.role === 'user');
  if (!last) {
    pageToastr().warning('手动触发没找到用户楼层，这一轮已跳过');
    return;
  }
  const floorId = Number(last.message_id);
  if (!Number.isFinite(floorId)) {
    pageToastr().warning('手动触发读不到楼层号，这一轮已跳过');
    return;
  }
  const floorText = String(last.message ?? '');
  // 任务提示词里的「你这轮说了什么」不取输入框，改从最新用户楼层抓原话，
  // 与「推进重刷」的取文口径一致（actions.ts:224）。抓不到就退回楼层正文。
  const userText = captureWithPresets(floorText, ctx.settings.presets)?.text ?? floorText;
  const result = await appendPlotBlock(ctx, userText, {
    floor: { messageId: floorId, floorText },
    join: 'final',
    independent: true,
  });
  if (!result.ok) {
    // 跑砸了只弹提示：不碰输入框、不删楼层，预约表由 appendPlotBlock 原样留着。
    pageToastr().warning(result.note || '手动触发的这一轮没跑成');
  }
}
