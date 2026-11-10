/**
 * 剧情推进 — 从 ACU 读「API 预设」的**纯逻辑**部分（换算 + 合并 + 措辞）。
 *
 * 为什么纯逻辑和碰酒馆的那几行要分成两个文件：对照测试在 Node 里跑，
 * 一 import 就带上 `tavern.ts`（里面有 jQuery / toastr 类型），整个套件当场编译失败。
 * 项目里的 `state.ts` / `data/chat-vars.ts` 也是这么切开的，这里沿用同一个做法：
 *
 *   - 本文件：不 import 任何酒馆全局，可以在 Node 里单独编译与被测
 *   - `acu-apis-io.ts`：唯一碰 `SillyTavern.getContext()` 的那几行
 *
 * ## 为什么要自己读存储，而不调 ACU 的接口
 *
 * 查过 ACU 的对外门面（`src/presentation/bootstrap/api-registry.ts` 汇总了全部 16 个
 * api-groups 文件）：**它压根没有开放「API 预设」的读写接口**。
 * `plot-preset-api.ts` 只管剧情推进预设（`getPlotPresets` / `getPlotPresetDetails` …），
 * 与 API 预设是两回事。所以想「一键导入」，只能去读它落盘的那份设置。
 *
 * ## 它落在哪
 *
 * - 命名空间：`extension_settings.__userscripts['shujuku_v120__userscript_settings_v1']`
 *   （`src/data/storage/tavern-storage.ts:17` 的 `TAVERN_SETTINGS_NAMESPACE_ACU`，
 *   前缀 `shujuku_v120` 来自 `src/shared/constants.ts:15` 的 `UNIQUE_SCRIPT_ID`）
 * - 键名：**profile 键**，不是 `allSettings_v2`（见下面 `ACU_PROFILE_KEY_PREFIX`）
 * - 键值是**字符串**（`setItem` 里 `String(value)` 过），内容是一段 JSON
 * - 里面 `apiPresets` 是数组，元素形状见 `api-preset-service.ts:122` 的 `ApiPreset_ACU`：
 *   `{ name, apiMode: 'custom' | 'tavern', apiConfig: {...}, tavernProfile }`
 *
 * ## ⚠ 一个踩过的坑：键名不是 `allSettings_v2`
 *
 * 老版本（v9x/v10x）把全部设置塞在 `shujuku_v120_allSettings_v2` 里；
 * 现在的 v120 改成了 **profile 分档存储**，`allSettings_v2` 只剩迁移兼容，
 * 迁移完就被 `removeItem` 删掉了（`settings-service.ts:477`）。
 * 实测当前存储里根本没有那个键 —— 按它读会永远返回「没有设置键」。
 *
 * 现在真实的键由 `data-constants.ts:41` 拼出来：
 *
 *     shujuku_v120_profile_v1 + "__" + <隔离槽> + "__settings"
 *
 * 隔离槽 = 隔离码对 `encodeURIComponent`，空码时是 `__default__`，
 * 于是默认档就是 `shujuku_v120_profile_v1____default____settings`。
 * 当前用哪一档要看 `shujuku_v120_globalMeta_v1` 里的 `activeIsolationCode`。
 *
 * ## 两条纪律
 *
 * 1. **只读**：本模块不写 ACU 的存储。写进去等于改人家的设置，
 *    而且它的 `setItem` 会连带触发它自己的 `persistTavernSettings_ACU()`。
 *    用户明确要求两边各自独立存储，所以导入之后就是两份数据。
 * 2. **永不抛**：ACU 没装、没加载完、存储格式变了 —— 一律返回「读不到 + 原因」，
 *    让面板把话讲清楚，绝不能因为读不到 ACU 就把面板打挂。
 */

import { DEFAULT_MAX_TOKENS } from '../../constants';
import { isPlainObject } from '../guards';

/**
 * 本文件所需的最小形状。
 *
 * 为什么**不** `import type { PlotApiEntry } from '../../types'`：
 * `types.ts` 里带着 `RerushWindow`，它引用 `toastr` / `JQueryStatic` 两个酒馆全局类型，
 * 在 Node 里（对照测试）根本编不过。用 `import type` 也一样 —— 编译器仍会去解析那个文件。
 * 这里是结构类型，与 `types.ts` 的 `PlotApiEntry` 字段一一对应；
 * 真对不上时，`types.ts` 那边的赋值会当场报错（而不是悄悄跑偏）。
 */
export interface PlotApiEntryLike {
  name: string;
  apiMode: 'custom' | 'tavern';
  url: string;
  apiKey: string;
  model: string;
  source: string;
  maxTokens: number | 'same_as_preset' | 'unset';
  temperature: number | 'same_as_preset' | 'unset';
  importedFrom: string;
  /** 附加请求体参数（ACU 面板里也是这一格 YAML 原文） */
  bodyParams: string;
  /** 要剔掉的请求体参数名 */
  excludeBodyParams: string;
  /** 提示词后处理（ACU 的 `apiConfig.promptPostProcessing`，缺省时跟随酒馆） */
  promptPostProcessing: string;
}

/** ACU 脚本 id（`UNIQUE_SCRIPT_ID`）。改这里的前提是 ACU 自己改了 id。 */
export const ACU_SCRIPT_ID = 'shujuku_v120';
/** ACU 的设置命名空间 */
export const ACU_NAMESPACE = `${ACU_SCRIPT_ID}__userscript_settings_v1`;
/** ACU 存「全局元信息」的键 —— 里面有当前用哪一档隔离码 */
export const ACU_GLOBAL_META_KEY = `${ACU_SCRIPT_ID}_globalMeta_v1`;
/** ACU 的 profile 键前缀（`STORAGE_KEY_PROFILE_PREFIX_ACU`） */
export const ACU_PROFILE_KEY_PREFIX = `${ACU_SCRIPT_ID}_profile_v1`;
/** 没有隔离码时用的那一档（`DEFAULT_ISOLATION_SLOT_ACU`） */
export const ACU_DEFAULT_ISOLATION_SLOT = '__default__';

/**
 * 拼出某一档 profile 的设置键。
 *
 * 照抄 `data-constants.ts:40` 的 `getProfileSettingsKey_ACU`：
 * 隔离码空 → `__default__`；非空 → `encodeURIComponent(码)`。
 * **这个 `__` 的连接方式不能改**，改了就跟 ACU 自己的键对不上。
 */
export function acuProfileSettingsKey(isolationCode = ''): string {
  const code = typeof isolationCode === 'string' ? isolationCode.trim() : '';
  const slot = code === '' ? ACU_DEFAULT_ISOLATION_SLOT : encodeURIComponent(code);
  return `${ACU_PROFILE_KEY_PREFIX}__${slot}__settings`;
}

/**
 * 从 `globalMeta` 的 JSON 文本里读出当前生效的隔离码。
 *
 * 读不懂就给空串（= 默认档）—— 这是最安全的方向：绝大多数用户从没设过隔离码，
 * 默认档就是他们数据所在的那一档。读失败还硬要报错，只会让用户多一步无谓操作。
 */
export function readActiveIsolationCode(metaText: unknown): string {
  if (typeof metaText !== 'string' || metaText.trim() === '') return '';
  let parsed: unknown;
  try {
    parsed = JSON.parse(metaText);
  } catch {
    return '';
  }
  if (!parsed || typeof parsed !== 'object') return '';
  const code = (parsed as Record<string, unknown>).activeIsolationCode;
  return typeof code === 'string' ? code.trim() : '';
}

/** 「读不到」分几种 —— 用户要做的事不一样，所以不能混成一句话。 */
export type AcuApiReadOutcome =
  | { ok: true; presets: PlotApiEntryLike[]; skipped: number }
  | { ok: false; reason: 'no-tavern' | 'no-namespace' | 'no-key' | 'bad-json' | 'no-presets'; detail: string };

/** 把 ACU 的接口协议（`customApiFormat`）换算成酒馆认的 `chat_completion_source`。 */
export function toTavernSource(format: unknown): string {
  if (typeof format !== 'string') return 'custom';
  switch (format.trim()) {
    case 'claude_messages':
      return 'claude';
    case 'gemini_interactions':
      return 'makersuite';
    case 'openai_compat':
    case 'openai_responses':
      return 'custom';
    case '':
      return 'custom';
    default:
      // 认不出来的协议一律当 OpenAI 兼容：这是 ACU 自己的兜底方向（非法值回退 openai_compat）
      return 'custom';
  }
}

/** 把 ACU 的一条 `ApiPreset_ACU` 换算成我们自己的形状。名字为空就返回 null（会被计为 skipped）。 */
export function toPlotApiEntry(raw: unknown, ordinal: number): PlotApiEntryLike | null {
  if (!isPlainObject(raw)) return null;
  const preset = raw as Record<string, unknown>;
  const name = typeof preset.name === 'string' ? preset.name.trim() : '';
  if (!name) return null;

  const config = (preset.apiConfig ?? {}) as Record<string, unknown>;
  const apiMode = preset.apiMode === 'tavern' ? 'tavern' : 'custom';

  // max_tokens 与 maxTokens 是同一件事的两个字段名（ACU 自己两处都写）。
  // 取 0 也是合法值（含义是「尽量不限制」），所以不能用 `||` 兜底。
  const maxTokensRaw = typeof config.max_tokens === 'number' ? config.max_tokens : config.maxTokens;

  return {
    name,
    apiMode,
    // 跟随酒馆时不保留地址与密钥：留着会让面板显示一段用不上的东西，也更容易误以为在生效
    url: apiMode === 'custom' && typeof config.url === 'string' ? config.url : '',
    apiKey: apiMode === 'custom' && typeof config.apiKey === 'string' ? config.apiKey : '',
    model: typeof config.model === 'string' ? config.model : '',
    // ACU 用 customApiFormat 表示接口协议，酒馆要的是 chat_completion_source，
    // 两者不是同一套字符串：直接把 `openai_compat` 塞给酒馆，后端会回
    // `Unsupported chat_completion_source: openai_compat`，整轮任务全废（2026-11-02 用户实测）。
    // 映射规则照 ACU 自己的做法（`api-call.ts:302` 的 ST_NATIVE_SOURCE_BY_FORMAT）：
    //   claude_messages → claude、gemini_interactions → makersuite、
    //   openai_compat / openai_responses → custom（酒馆没有 responses 后端，回退 chat/completions）。
    source: apiMode === 'custom' ? toTavernSource(config.customApiFormat) : '',
    maxTokens: typeof maxTokensRaw === 'number' && Number.isFinite(maxTokensRaw) ? Math.floor(maxTokensRaw) : DEFAULT_MAX_TOKENS,
    temperature: typeof config.temperature === 'number' && Number.isFinite(config.temperature) ? config.temperature : 1,
    /** 记下它原来叫什么，面板上能一眼看出「这条是从 ACU 抄来的」 */
    importedFrom: name || `第 ${ordinal + 1} 条`,
    // 这两格 ACU 面板上也有（ApiConfigPanel 的 bodyParams / excludeBodyParams），原样带过来，
    // 用户在两边之间搬配置时不用重抄。跟随酒馆时留空：那套参数在跟随模式下不会生效。
    bodyParams: apiMode === 'custom' && typeof config.bodyParams === 'string' ? config.bodyParams : '',
    excludeBodyParams:
      apiMode === 'custom' && typeof config.excludeBodyParams === 'string' ? config.excludeBodyParams : '',
    // 提示词后处理：ACU 存在 apiConfig 里，值是 ''/merge_tools/semi/strict/single。
    // 只在自定义模式下带过来 —— ACU 走「酒馆预设」模式时并不发这个字段，
    // 照搬过来会让我们多做一件它原本没做的事。缺省='跟随酒馆'，即完全不动。
    promptPostProcessing:
      apiMode === 'custom' && typeof config.promptPostProcessing === 'string' ? config.promptPostProcessing : 'follow',
  };
}

/** 把一段 ACU 设置的原始 JSON 文本解析成我们的条目清单。纯函数，可被单测直接喂字符串。 */
export function parseAcuSettingsJson(stored: string): AcuApiReadOutcome {
  if (typeof stored !== 'string' || stored === '') {
    return {
      ok: false,
      reason: 'no-key',
      detail: '数据库脚本的存储里找不到当前这一档的设置。可能它还没保存过设置，先打开一次它的设置页再看。',
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return { ok: false, reason: 'bad-json', detail: '数据库脚本的设置不是合法 JSON，可能已损坏。为避免读错，这次不导入。' };
  }

  const settings = (parsed ?? {}) as Record<string, unknown>;
  const rawList = settings.apiPresets;
  if (!Array.isArray(rawList) || rawList.length === 0) {
    return { ok: false, reason: 'no-presets', detail: '数据库脚本里还没有任何 API 预设。先去它的设置里建一条。' };
  }

  const presets: PlotApiEntryLike[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  rawList.forEach((raw, ordinal) => {
    const entry = toPlotApiEntry(raw, ordinal);
    // 名字为空、或重名的一律跳过（ACU 自己也按名字去重）
    if (!entry || seen.has(entry.name)) {
      skipped += 1;
      return;
    }
    seen.add(entry.name);
    presets.push(entry);
  });

  if (presets.length === 0) {
    return { ok: false, reason: 'no-presets', detail: '数据库脚本里的 API 预设都没有可用的名字，无法导入。' };
  }

  return { ok: true, presets, skipped };
}

/**
 * 把导入来的条目合并进现有清单。
 *
 * 判重按名字；重名时**保留用户已经改过的本地版本**（`keepLocal` 为真，默认），
 * 因为用户可能把导入来的地址改成了自己的反代，再导一次不该把它覆盖回去。
 * 想强制用 ACU 的版本时把 `keepLocal` 传假。
 */
export function mergePlotApis(
  local: readonly PlotApiEntryLike[],
  incoming: readonly PlotApiEntryLike[],
  options: { keepLocal?: boolean } = {},
): { apis: PlotApiEntryLike[]; added: number; replaced: number; kept: number } {
  const keepLocal = options.keepLocal !== false;
  const result = local.map((api) => ({ ...api }));
  const indexByName = new Map<string, number>();
  result.forEach((api, index) => indexByName.set(api.name, index));

  let added = 0;
  let replaced = 0;
  let kept = 0;

  for (const item of incoming) {
    const at = indexByName.get(item.name);
    if (at === undefined) {
      indexByName.set(item.name, result.length);
      result.push({ ...item });
      added += 1;
      continue;
    }
    if (keepLocal) {
      kept += 1;
      continue;
    }
    result[at] = { ...item };
    replaced += 1;
  }

  return { apis: result, added, replaced, kept };
}

/** 「读不到」时该对用户说的话。面板直接拿去显示。 */
export function describeAcuApiProblem(outcome: AcuApiReadOutcome): string {
  return outcome.ok ? '' : outcome.detail;
}
