/**
 * 前置校验与目标楼层定位。
 * 用酒馆助手标准接口 `getChatMessages` 的 role 筛选直接拿到全部用户楼层，
 * 取最后一条即"最新的一条用户消息"——不设固定回溯窗口，
 * 因此连续多层 AI 回复、群聊多段回复都不会把定位范围截断。
 * `latestAiFloorBefore` 用同一套取法拿 AI 楼层（只取用户楼层上方的），供「AI楼层模式」取文。
 */
import { paintLock, flashRejected } from './feedback';
import { logInfo } from './logger';
import { findScriptButton } from './script-button';
import { aiIsStreaming, historyEditOpen, hasDraft } from './tavern';
import { MSG, TAG } from './copy';
import type { FloorTarget, RerushContext } from './types';

/** 定位结果；返回 null 表示校验没过，此时按钮已经给过一次受阻反馈。 */
export function locateLatestUserFloor(ctx: RerushContext): FloorTarget | null {
  const $btn = findScriptButton();
  logInfo(TAG.gate, MSG.gateBegin);

  const blockWith = (reason: string): null => {
    logInfo(TAG.gate, reason);
    if ($btn && $btn.length > 0) {
      paintLock($btn, false);
      $btn.blur();
      flashRejected(ctx, $btn);
    }
    return null;
  };

  if (historyEditOpen()) {
    return blockWith(MSG.blockedWhileEditing);
  }
  if (aiIsStreaming()) {
    return blockWith(MSG.blockedWhileGenerating);
  }
  if (hasDraft()) {
    return blockWith(MSG.blockedByDraft);
  }

  const userFloors = getChatMessages('0-{{lastMessageId}}', { role: 'user' });
  if (userFloors.length === 0) {
    return blockWith(MSG.blockedNoUserFloor);
  }
  const message = userFloors[userFloors.length - 1];

  logInfo(TAG.gate, MSG.targetLocated(message.message_id));

  return {
    message: message,
    messageId: message.message_id,
  };
}

/**
 * 最新用户楼层**上方**的最近一条 AI 楼层（message_id 小于它、且 role 为 assistant 的最大者）。
 * 与用户楼层同样不设回溯窗口，所以群聊里连续多层 AI 回复也能拿到最近那条。
 * 刻意排除掉用户楼层之后的楼层：开着 AI 楼层模式要的是"我上一句之前 AI 说的那段"，
 * 而不是刚生成的那条回复。
 * 一条都没有时返回 null；要不要提示用户由调用方决定（本函数不做按钮反馈）。
 */
export function latestAiFloorBefore(userFloorId: number): FloorTarget | null {
  const aiFloors = getChatMessages('0-{{lastMessageId}}', { role: 'assistant' });
  for (let index = aiFloors.length - 1; index >= 0; index--) {
    const message = aiFloors[index];
    if (message.message_id < userFloorId) {
      return {
        message: message,
        messageId: message.message_id,
      };
    }
  }
  return null;
}
