/**
 * 对外接口：给其他前端界面 / 脚本在改完暂存账本后调用。
 *
 * 只做一件事：把暂存账本里「标记为正在使用」的那一版重新应用 —— 同步楼层正文与世界书，
 * 等价于暂存区面板对正在使用的那一版点「保存」时的后半段（StashPanel.vue:588-617）。
 * 不改写暂存账本（不调 setActiveLanding / savePanelStash），避免与调用方刚写完的账本抢写。
 *
 * 全局名 RerollStashApi 在 lifecycle.ts 的 bootstrap 里注册；多实例失效由本文件的
 * isCurrentInstance 校验挡住，见 instance.ts 的抢占说明。
 */
import { isCurrentInstance } from '../instance';
import type { RerushContext } from '../types';
import { applyLandingToFloorMessage, readFloorText } from './stash-apply-io';
import { getEntry, taskTagRecordsOfLanding } from './stash-model';
import { readPanelStash } from './stash-state';
import { enqueueWorldbookStashRecords } from './worldbook-write';

/** 调用方传进来的定位信息。 */
export interface StashExternalApplyInput {
  /** 暂存账本里的楼层号（用户楼层号，不是界面挂靠的 AI 楼层号） */
  floorId: number;
  /** 调用方刚改完的那一版的稳定 id（StashLanding.id） */
  landingId: string;
}

/** 同步结果。ok:false 时 reason 一定有一句能给人看的话。 */
export interface StashExternalApplyResult {
  ok: boolean;
  /** 失败或跳过时给人看的一句话；成功为空串 */
  reason?: string;
  /** 楼层正文是否真的被改写 */
  floorUpdated: boolean;
  /** 世界书同步入口是否已调用（不等于队列里真有任务，更不等于条目已写完，队列后台跑） */
  worldbookQueued: boolean;
}

/** 挂到全局的那一整个接口：只放这一个函数，不暴露 ctx / settings / 暂存账本。 */
export interface RerollStashApi {
  applyStashLanding(input: StashExternalApplyInput): Promise<StashExternalApplyResult>;
}

function failed(reason: string): StashExternalApplyResult {
  return { ok: false, reason, floorUpdated: false, worldbookQueued: false };
}

/**
 * 实现。ctx 由注册时的那个实例闭包带进来，先校验实例还在位：
 * 脚本被新版顶替后旧 iframe 可能还活着（instance.ts），旧闭包拿的是失效 ctx，
 * 此时宁可明确报错，也不用旧设置 / 旧监听去写楼层正文与世界书。
 */
export async function applyStashLandingFromExternal(
  ctx: RerushContext,
  input: StashExternalApplyInput,
): Promise<StashExternalApplyResult> {
  try {
    if (!isCurrentInstance(ctx)) {
      console.warn('[剧情推进助手] 对外接口：脚本实例已被新版替换，已跳过本次同步');
      return failed('脚本实例已被新版替换，已跳过本次同步');
    }

    // 对外边界：调用方在另一个工作区，参数不可信，先验形再往下走。
    if (
      !input ||
      typeof input !== 'object' ||
      !Number.isFinite(input.floorId) ||
      typeof input.landingId !== 'string' ||
      input.landingId.trim() === ''
    ) {
      console.warn('[剧情推进助手] 对外接口：参数不合法，已跳过', input);
      return failed('floorId 必须是楼层号、landingId 必须是非空版本 id');
    }
    const { floorId, landingId } = input;
    console.info('[剧情推进助手] 对外接口：收到同步请求', { floorId, landingId });

    const { stash } = readPanelStash();
    const entry = getEntry(stash, floorId);
    if (!entry) {
      return failed(`第 ${floorId} 楼在暂存账本里没有对应条目，已跳过楼层正文与世界书同步`);
    }
    const landing = entry.landings.find(item => item.id === landingId);
    if (!landing) {
      return failed(`第 ${floorId} 楼的暂存账本里找不到版本 ${landingId}，已跳过楼层正文与世界书同步`);
    }

    // 硬校验：只认暂存账本明确标记为正在使用的那一版，两边口径漂了宁可不写。
    if (entry.activeLandingId !== landingId) {
      console.warn('[剧情推进助手] 对外接口：这一版不是账本标记的正在使用版本，已跳过', {
        floorId,
        landingId,
        activeLandingId: entry.activeLandingId,
      });
      return failed('这一版不是账本标记的正在使用版本，已跳过楼层正文与世界书同步');
    }

    // applyLandingToFloorMessage 只改 message 一个字段、发 MESSAGE_UPDATED，
    // 不会触发 floor-sync 的 MESSAGE_EDITED 监听，也就不会把差量反写回暂存账本。
    const before = readFloorText(floorId);
    const applied = await applyLandingToFloorMessage(floorId, landing.finalText);
    if (!applied.ok) {
      console.warn('[剧情推进助手] 对外接口：写楼层正文失败，已跳过世界书同步', applied.reason);
      return failed(`写楼层正文失败：${applied.reason ?? '未知原因'}`);
    }
    const after = readFloorText(floorId);
    const floorUpdated = after !== null && after !== before;
    console.info('[剧情推进助手] 对外接口：写楼层正文完成', { floorId, floorUpdated });

    const records = taskTagRecordsOfLanding(landing);
    // 传合并后的结构化标签数据，不自己拼文本；空串是 tombstone，会清掉对应世界书条目。
    // 入口在剧情关闭 / 无规则 / 标签数据为空时自行 return，故 worldbookQueued 只表示
    // 「已调用入队入口」，不代表队列里真有任务，更不代表条目已写完。
    enqueueWorldbookStashRecords(ctx, records);
    console.info('[剧情推进助手] 对外接口：世界书同步入口已调用', {
      floorId,
      recordCount: Object.keys(records).length,
    });

    return { ok: true, reason: '', floorUpdated, worldbookQueued: true };
  } catch (error) {
    const reason = String((error as Error)?.message ?? error);
    console.warn('[剧情推进助手] 对外接口：同步失败', error);
    return failed(`同步失败：${reason}`);
  }
}
