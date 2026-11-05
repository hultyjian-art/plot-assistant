/**
 * ACU（数据库脚本）的剧情推进总开关 —— 只读、只关，不碰它别的东西。
 *
 * 为什么要有这个文件：两个脚本都是「发送前先跑一轮剧情推进，再把结果并进正文」，
 * 同时开着就会一次发送被两边同时接住，用户看到的是两个推进并立。
 * 所以打开我们的总开关时，顺手把 ACU 那个关掉。
 *
 * 同一个开关在 ACU 存了两份（`service/settings/settings-service.ts:76-81`
 * 的 `applyGlobalPlotEnabledSetting_ACU`）：
 *  - `globalMeta` 里的 `plotEnabledGlobal` —— ACU 启动时拿它**覆盖**另一份
 *  - profile 里的 `plotSettings.enabled` —— 实际生效的那份
 * 只关一处，下次 ACU 启动会被另一处拉回来，所以两处一起关。
 *
 * 局限：这里改的是**存储**。ACU 若正在运行，它内存里还留着旧值，
 * 下次它自己保存设置时会写回 true。检测到这个情况时，提示语会请用户去 ACU 面板确认。
 */

import { stContext } from '../../tavern';
import {
  ACU_GLOBAL_META_KEY,
  ACU_NAMESPACE,
  acuProfileSettingsKey,
  readActiveIsolationCode,
} from './acu-apis';

/** 三态：开着 / 关着 / 读不到（没装、没加载完、还没保存过设置） */
export type AcuPlotFlag = 'on' | 'off' | 'unknown';

/** 酒馆扩展设置里 ACU 的命名空间对象；取不到返回 null。 */
function acuNamespace(): Record<string, unknown> | null {
  const context = stContext() as Record<string, unknown> | null;
  if (!context) return null;

  const ext = context.extensionSettings;
  const userscripts = ext && typeof ext === 'object' ? (ext as Record<string, unknown>).__userscripts : undefined;
  const ns = userscripts && typeof userscripts === 'object' ? (userscripts as Record<string, unknown>)[ACU_NAMESPACE] : undefined;
  return ns && typeof ns === 'object' ? (ns as Record<string, unknown>) : null;
}

/** 从一段 JSON 文本里顺着一串键位读布尔值；读不出来返回 undefined。 */
function readBoolField(text: unknown, path: string[]): boolean | undefined {
  if (typeof text !== 'string' || text.trim() === '') return undefined;

  let node: unknown;
  try {
    node = JSON.parse(text);
  } catch {
    return undefined;
  }

  for (const key of path) {
    if (!node || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return typeof node === 'boolean' ? node : undefined;
}

/**
 * ACU 的剧情推进现在是不是开着。
 *
 * 两处只要有一处是 true 就算开着 —— 那正是「下次启动会被拉回来」的状态，
 * 宁可多关一次，也别漏掉一个会让两个推进并立的配置。
 */
export function readAcuPlotFlag(): AcuPlotFlag {
  const ns = acuNamespace();
  if (!ns) return 'unknown';

  const meta = ns[ACU_GLOBAL_META_KEY];
  const profileKey = acuProfileSettingsKey(readActiveIsolationCode(meta));
  const global = readBoolField(meta, ['plotEnabledGlobal']);
  const perProfile = readBoolField(ns[profileKey], ['plotSettings', 'enabled']);

  if (global === true || perProfile === true) return 'on';
  if (global === false && perProfile === false) return 'off';
  return 'unknown';
}