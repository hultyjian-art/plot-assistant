/**
 * 剧情推进 — 从 ACU 读 API 预设时**唯一碰酒馆全局**的那几行。
 *
 * 与 `acu-apis.ts` 的分工：那边是纯逻辑（换算 / 合并 / 措辞），这个文件只负责
 * 「把酒馆扩展设置里那个字符串取出来」，取不到就把原因讲清楚。
 * 切开的原因见 `acu-apis.ts` 文件头 —— 对照测试在 Node 里跑，不能带进 jQuery/toastr 类型。
 */

import { stContext } from '../../tavern';
import {
  ACU_GLOBAL_META_KEY,
  ACU_NAMESPACE,
  acuProfileSettingsKey,
  parseAcuSettingsJson,
  readActiveIsolationCode,
  type AcuApiReadOutcome,
} from './acu-apis';

/** 读 ACU 设置文本时能遇到的全部失败原因。 */
type ReadFailure = { ok: false; reason: 'no-tavern' | 'no-namespace' | 'no-key'; detail: string };

/** 酒馆扩展设置里 ACU 的那个命名空间对象；取不到返回 null。 */
function acuNamespace(): Record<string, unknown> | null {
  const context = stContext();
  if (!context) return null;

  const ext = (context as Record<string, unknown>).extensionSettings;
  const userscripts = ext && typeof ext === 'object' ? (ext as Record<string, unknown>).__userscripts : undefined;
  const ns = userscripts && typeof userscripts === 'object' ? (userscripts as Record<string, unknown>)[ACU_NAMESPACE] : undefined;
  return ns && typeof ns === 'object' ? (ns as Record<string, unknown>) : null;
}

/**
 * 从酒馆扩展设置里取出 ACU 存设置的那段文本；取不到时返回「为什么取不到」。
 *
 * 顺序是「先看当前用哪一档 → 再按那一档拼键」，不能直接写死默认档：
 * 用户一旦在 ACU 里设过隔离码，数据就搬去另一档了，
 * 写死默认档会读到一份空的旧档案，表现成「明明有预设却读不到」。
 */
function readAcuSettingsText(): { ok: true; text: string } | ReadFailure {
  if (!stContext()) {
    return { ok: false, reason: 'no-tavern', detail: '取不到酒馆上下文（SillyTavern.getContext），无法读数据库脚本的设置。' };
  }

  const ns = acuNamespace();
  if (!ns) {
    return {
      ok: false,
      reason: 'no-namespace',
      detail: `酒馆扩展设置里没有数据库脚本的存储命名空间（${ACU_NAMESPACE}）。多半是数据库脚本没装或还没加载完。`,
    };
  }

  // 隔离码放在 globalMeta 里；读不到就当空码（= 默认档，绝大多数人就在这一档）
  const isolationCode = readActiveIsolationCode(ns[ACU_GLOBAL_META_KEY]);
  const key = acuProfileSettingsKey(isolationCode);

  const stored = ns[key];
  if (typeof stored !== 'string' || stored === '') {
    return {
      ok: false,
      reason: 'no-key',
      detail: `数据库脚本的存储里没有设置键（${key}）。可能它还没保存过设置，先打开一次它的设置页再看。`,
    };
  }

  return { ok: true, text: stored };
}

/**
 * 从 ACU 读出全部 API 预设。
 *
 * 返回的 `presets` 已经是我们的形状，可以直接塞进 `settings.plot.apis`。
 * 调用方拿到之后必须做**合并**（用 `mergePlotApis`），别整份覆盖 ——
 * 用户手建的条目不能被一次导入冲掉。
 */
export function readAcuApiPresets(): AcuApiReadOutcome {
  const text = readAcuSettingsText();
  if (!text.ok) {
    return { ok: false, reason: text.reason, detail: text.detail };
  }
  return parseAcuSettingsJson(text.text);
}
