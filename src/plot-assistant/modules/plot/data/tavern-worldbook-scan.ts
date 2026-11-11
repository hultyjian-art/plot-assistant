/**
 * 让「世界书与上下文」($1 / $9) 直接吃酒馆本轮原生的激活结果（2026-11-11 批 75，A 方案）。
 *
 * 为什么不自己重算关键词：旧版 `buildPlotWorldbookTexts` 只做了「常驻 + 关键词递归」，
 * 酒馆原生的次关键词逻辑、正则、概率、大小写/全词、时序效果、分组互斥、token 预算、
 * 每条目的扫描深度一概不认，所以「酒馆 AI 看得到什么」和「$1 里有什么」天生对不上。
 *
 * 时序难点：剧情推进拦在「用户点发送」那一刻，跑在主 AI 生成之前，而酒馆的
 * WORLD_INFO_ACTIVATED 广播要等生成时才发，此刻只能拿到上一次的清单。
 * Luker 为此内置了 `simulateWorldInfoActivation()`：传一段聊天快照就能干跑一次
 * 和真实生成完全同一套的世界书扫描，dryRun=true 不写 sticky/cooldown 状态、不发广播。
 *
 * 降级链（原版 SillyTavern 兼容，批 78 复查保留）：预演接口 → 上一次生成的激活广播
 * （WORLD_INFO_ACTIVATED 与 WORLDINFO_SCAN_DONE 都监听，后者连 0 激活也会发）→ 旧版关键词匹配。
 * 后两档都会给用户可见提示。
 */

import { pageToastr, stContext, tavernGlobal } from '../../tavern';
import {
  buildPlotWorldbookTexts,
  buildPlotWorldbookTextsFromActivation,
  normalizeActivatedEntries,
  type ActivatedWorldbookEntry,
  type PlotWorldbookResult,
} from './worldbook-hits';

export interface RawChatMessageLike {
  role?: unknown;
  message?: unknown;
  name?: unknown;
}

export interface ResolvePlotWorldbookOptions {
  bookNames: string[];
  entriesByBook: Record<string, unknown>;
  enabledEntries?: Record<string, unknown> | null;
  rawChat: RawChatMessageLike[];
  userText: string;
  /** 旧版降级时用的扫描文本。 */
  baseScanText: string;
}

let cachedActivated: ActivatedWorldbookEntry[] | null = null;
let warnedStale = false;
let warnedFallback = false;

/** 降级提示只是提示：找不到 toastr（如纯 Node 的对照测试）时不能把整轮剧情推进带崩。 */
function notify(kind: 'warning' | 'error', message: string): void {
  try {
    const toast = pageToastr();
    if (kind === 'warning') toast.warning(message, '剧情推进助手');
    else toast.error(message, '剧情推进助手');
  } catch (error) {
    console.warn('[剧情推进] 世界书降级提示发不出去', error, message);
  }
}

/**
 * 兜底：原版 SillyTavern 没有预演接口时，至少能拿到「上一次生成」广播的激活清单。
 * 事件监听挂在生命周期里（本文件会被 parity 测试链编译，那里没有 iframe 全局类型）。
 * 空清单也要写进来：上一轮 0 激活时能清掉更早的旧缓存，不会拿旧条目凑数。
 */
export function setCachedActivatedEntries(entries: unknown): void {
  cachedActivated = normalizeActivatedEntries(entries);
}

/** 酒馆这一刻真正会扫描的书。四类里酒馆助手只暴露了三类，人设书没有对应接口。 */
export function readEnabledBookNames(): string[] {
  const names: string[] = [];
  const push = (value: unknown): void => {
    const name = String(value ?? '').trim();
    if (name && !names.includes(name)) names.push(name);
  };
  try {
    const char = getCharWorldbookNames('current');
    push(char?.primary);
    (char?.additional ?? []).forEach(push);
  } catch (error) {
    console.warn('[剧情推进] 读取角色卡绑定世界书失败', error);
  }
  try {
    (getGlobalWorldbookNames() ?? []).forEach(push);
  } catch (error) {
    console.warn('[剧情推进] 读取全局世界书失败', error);
  }
  try {
    push(getChatWorldbookName('current'));
  } catch (error) {
    console.warn('[剧情推进] 读取聊天绑定世界书失败', error);
  }
  return names;
}

function buildCoreChat(rawChat: RawChatMessageLike[], userText: string): Record<string, unknown>[] {
  const playerName = String(tavernGlobal()?.name1 ?? '');
  const chat = (rawChat ?? []).map(item => ({
    name: String(item?.name ?? ''),
    mes: String(item?.message ?? ''),
    is_user: item?.role === 'user',
    is_system: item?.role === 'system',
  }));
  // 剧情推进拦在「用户点发送」那一刻，这条用户消息还只在输入框里，没进聊天记录；
  // 不补上它，本条消息里的关键词就一个都扫不到。
  const last = chat[chat.length - 1];
  if (userText && !(last && last.is_user === true && last.mes === userText)) {
    chat.push({ name: playerName, mes: userText, is_user: true, is_system: false });
  }
  return chat;
}

async function readActivatedEntries(
  options: ResolvePlotWorldbookOptions,
): Promise<ActivatedWorldbookEntry[] | null> {
  const context = stContext();
  const simulate = context?.simulateWorldInfoActivation;
  if (typeof simulate === 'function') {
    try {
      const coreChat = buildCoreChat(options.rawChat, options.userText);
      const resolution = await simulate.call(context, { coreChat, dryRun: true, type: 'normal' });
      const list = (resolution as { activatedEntries?: unknown } | null)?.activatedEntries;
      if (Array.isArray(list)) return normalizeActivatedEntries(list);
      console.warn('[剧情推进] 世界书预演没返回 activatedEntries，改用上一次生成的激活清单');
    } catch (error) {
      console.warn('[剧情推进] 世界书预演失败，改用上一次生成的激活清单', error);
    }
  }

  if (cachedActivated !== null) {
    if (!warnedStale) {
      warnedStale = true;
      notify(
        'warning',
        '当前酒馆没有世界书预演能力，$1 改用上一次生成时激活的条目，可能漏掉本条消息里的关键词。',
      );
    }
    return cachedActivated;
  }
  return null;
}

export async function resolvePlotWorldbook(
  options: ResolvePlotWorldbookOptions,
): Promise<PlotWorldbookResult> {
  const enabledBooks = readEnabledBookNames();
  const activatedEntries = await readActivatedEntries(options);

  if (activatedEntries !== null) {
    return buildPlotWorldbookTextsFromActivation({
      bookNames: options.bookNames,
      enabledBooks,
      activatedEntries,
      entriesByBook: options.entriesByBook as never,
      enabledEntries: options.enabledEntries,
    });
  }

  if (!warnedFallback) {
    warnedFallback = true;
    notify(
      'error',
      '酒馆没有提供世界书预演能力，本轮 $1 退回旧版关键词匹配，可能与酒馆实际激活不一致。',
    );
  }
  console.error('[剧情推进] 世界书激活清单不可用，$1 回退旧版关键词匹配');
  return buildPlotWorldbookTexts({
    bookNames: options.bookNames,
    entriesByBook: options.entriesByBook as never,
    baseScanText: options.baseScanText,
    enabledEntries: options.enabledEntries,
  });
}
