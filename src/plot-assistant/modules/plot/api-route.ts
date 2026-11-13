/**
 * 剧情推进 — 把面板里配的一条 API 换算成 `generateRaw` 认的 `custom_api`。
 *
 * 为什么需要这一步：酒馆助手已经给了 `custom_api` 这个口子
 * （`@types/function/generate.d.ts:377` 的 `CustomApiConfig`），我们不需要自己造请求逻辑，
 * 只要把「面板上的字段」翻译成「它认的字段名」。字段名不一致的地方有这几处：
 *
 * | 我们面板 | `custom_api` | 说明 |
 * |---|---|---|
 * | `url` | `apiurl` | 注意是 `apiurl`，全小写，不是 `apiUrl` |
 * | `apiKey` | `key` | |
 * | `source` | `source` | 同名；空串时**显式写成 `custom`**（留空会让酒馆退回自己的 openai 源，顶掉面板配的模型） |
 * | `maxTokens` | `max_tokens` | 支持 `'same_as_preset'` / `'unset'` 两个特殊值 |
 * | `temperature` | `temperature` | 同上 |
 * | `requestTimeoutSeconds` | —— | **酒馆没有这个字段**，只能丢掉（见下） |
 *
 * ## 两个刻意不做的事
 *
 * 1. **`apiMode === 'tavern'` 时返回 `null`**（= 不传 `custom_api`）。
 *    这不是偷懒：不传 `custom_api` 就等价于"用酒馆当前连接"，正是"跟随酒馆"要的效果。
 *    如果硬塞一个空对象进去，酒馆会以为用户要自定义，反而可能把当前连接覆盖掉。
 * 2. **超时秒数不转过去**。酒馆的 `custom_api` 没有超时字段，硬塞进
 *    `custom_include_body` 是错的 —— 那是请求体参数，不是请求超时。
 *    超时由 `data/ai-call.ts` 的 `runWithTimeout` 在外层掐断（`stopGenerationById`），不是请求参数。
 */

import { parseBodyParams, parseExcludeParams } from './api-body';

/** 面板上一条 API 的最小形状（只要这里用得到的字段）。 */
export interface PlotApiLike {
  name: string;
  apiMode: 'custom' | 'tavern';
  url: string;
  apiKey: string;
  model: string;
  source: string;
  maxTokens: number | 'same_as_preset' | 'unset';
  temperature: number | 'same_as_preset' | 'unset';
  /**
   * 可选，且**这里刻意不用它**。
   *
   * 声明出来只为一件事：让「超时不该被塞进 `custom_api`」这条能有测试可写 ——
   * 传进来一个带超时的对象，断言 payload 里没有这个字段。
   * 真正的超时由 `ai-call.ts` 在外层掐（`stopGenerationById`），不是请求参数。
   */
  requestTimeoutSeconds?: number;
  /**
   * 附加请求体参数（YAML 或 JSON 文本，由 `api-body.ts` 解析成对象）。
   *
   * 为什么是字符串而不是对象：它直接来自面板上用户手写的多行格子。
   * 在这里先解析成对象、把「写错一个字」变成「这一轮不跑并告诉他哪错了」，
   * 比让整轮推进带着一个坏请求去打上游要好。
   */
  bodyParams?: string;
  /** 要从请求体里剔掉的参数名（逗号/顿号/空格分隔的原始文本）。 */
  excludeBodyParams?: string;
  /**
   * 附加请求标头（每行一个 `名字: 值` 的原始文本，由 `parseHeaderLines` 解析）。
   *
   * 与 `bodyParams` 一样是原文：面板上就是一格多行文本，解析失败要能把
   * 那一行连同行号一起报出来，否则「填了没生效」查不到原因。
   */
  requestHeaders?: string;
}

/** `generateRaw` 的 `custom_api` 参数（只声明我们用得到的那几个，其余不传）。 */
export interface CustomApiPayload {
  apiurl?: string;
  key?: string;
  model?: string;
  source?: string;
  max_tokens?: number | 'same_as_preset' | 'unset';
  temperature?: number | 'same_as_preset' | 'unset';
  /**
   * 原样拼进上游请求体的参数。
   *
   * ⚠️ **只在 `source === 'custom'` 时被酒馆采纳**（`openai.js:2854` 只在那一个分支里读它）。
   * 选 DeepSeek / OpenAI 官方源时贴进来会被丢掉，面板上要写清这一点，否则用户会以为填了没反应。
   */
  custom_include_body?: Record<string, unknown>;
  /** 从请求体里剔掉的键名。同上，只在 `custom` 源生效。 */
  custom_exclude_body?: string[];
  /**
   * 追加到请求头上的键值对，同样是原样拼进去。
   *
   * 与 `custom_include_body` 一个待遇：**只在 `source === 'custom'` 时被采纳**。
   * 透明中转站常要用自定义头验签，光靠密钥那一格填不进去。
   */
  custom_include_headers?: Record<string, string>;
}

/** 换算结果：`problem` 非空表示「配置本身有错」，调用方应当停下而不是继续发。 */
export interface CustomApiPlan {
  payload: CustomApiPayload | null;
  problem: string | null;
}

/**
 * 换算成 `custom_api`。
 *
 * @returns 要传进 `generateRaw` 的对象；`null` 表示「不要传 `custom_api`」（跟随酒馆）
 *
 * **空地址或空模型时不传**：酒馆遇到 `custom` 模式但 `url` 为空会报错中止整次生成，
 * 而任务调用失败会连带让这一轮推进失败。宁可退回跟随酒馆（能用），也不要因为面板没填全就整轮挂掉。
 */
export function toCustomApiPayload(api: PlotApiLike | null | undefined): CustomApiPayload | null {
  return resolveCustomApi(api).payload;
}

/**
 * 换算成 `custom_api`，**并顺手把「附加请求体参数」解析掉**。
 *
 * 与 `toCustomApiPayload` 的区别只有一处：这里会把「用户手写的参数有语法错误」
 * 变成一句能显示的话（`problem`），而不是静默丢掉这段参数继续跑。
 * 静默丢掉是这里最不能接受的结果 —— 用户会看着面板上明明白白写着
 * `response_format: json_object` 却依然拿到非 JSON 的输出，然后来问「为什么没生效」。
 */
export function resolveCustomApi(api: PlotApiLike | null | undefined): CustomApiPlan {
  if (!api) return { payload: null, problem: null };
  if (api.apiMode !== 'custom') return { payload: null, problem: null };

  const url = api.url.trim();
  const model = api.model.trim();
  // 缺关键字段就别传：传了只会让酒馆走自定义分支然后失败
  if (url === '' || model === '') return { payload: null, problem: null };

  const payload: CustomApiPayload = { apiurl: url, model };

  // 密钥允许为空（有些自建反代不需要密钥）。空串不传，让酒馆用它自己的默认行为
  const key = api.apiKey.trim();
  if (key !== '') payload.key = key;

  // 源为空时**必须**显式写成 custom。
  // 原来的想法是「留空让酒馆按地址推断」，实测推不出来：酒馆退回它自己那份 openai 源，
  // 于是用上 chatCompletionSettings 里的 reverse_proxy 与 custom_model ——
  // 面板里配的 gemini-3.7-flash 被顶成酒馆的 gemini-4-argon，请求直接 503 model_not_found。
  const source = api.source.trim();
  payload.source = source !== '' ? source : 'custom';

  payload.max_tokens = api.maxTokens;
  payload.temperature = api.temperature;

  const body = parseBodyParams(api.bodyParams ?? '');
  if (!body.ok) return { payload, problem: `「${api.name}」的附加请求体参数有问题：${body.error}` };
  if (body.value !== null) payload.custom_include_body = body.value;

  const exclude = parseExcludeParams(api.excludeBodyParams ?? '');
  if (exclude.length > 0) payload.custom_exclude_body = exclude;

  const headers = parseHeaderLines(api.requestHeaders ?? '');
  if (!headers.ok) return { payload, problem: `「${api.name}」的附加请求标头有问题：${headers.error}` };
  if (headers.value !== null) payload.custom_include_headers = headers.value;

  return { payload, problem: null };
}

/**
 * 解析「附加请求标头」——每行一个 `Header: Value`。
 *
 * 空行与 `#` 开头的行一律跳过（和 YAML 那边一个脾气：注释不算内容）。
 * 没冒号的行按错误处理，不静默丢弃 —— 用户会看着面板上明明写了一行、
 * 请求却没带上这个头，然后来问「为什么没生效」。
 */
function parseHeaderLines(text: string): { ok: true; value: Record<string, string> | null } | { ok: false; error: string } {
  const source = typeof text === 'string' ? text : '';
  const headers: Record<string, string> = {};
  let count = 0;
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const at = line.indexOf(':');
    if (at <= 0) {
      return { ok: false, error: `第 ${count + 1} 行「${line}」没有冒号，写不成「名字: 值」` };
    }
    const name = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();
    if (name === '') return { ok: false, error: `第 ${count + 1} 行冒号前面是空的` };
    headers[name] = value;
    count += 1;
  }
  return { ok: true, value: count > 0 ? headers : null };
}

/**
 * 从一份 API 清单里按名字挑出当前要用的那条。
 *
 * 三种"挑不到"都返回 `null`（= 跟随酒馆），且**都不报错**：
 * - 清单是空的（用户还没配）
 * - `activeName` 是空的（用户没指定）
 * - 指定的名字不在清单里（那条被删了 / 改名了）
 *
 * 为什么不报错：这是每轮发送都会走一遍的热路径，为"没配 API"去弹窗会烦死人，
 * 而"跟随酒馆"本身是完全可用的合法状态。
 */
export function pickActiveApi<T extends PlotApiLike>(apis: readonly T[], activeName: string): T | null {
  const wanted = activeName.trim();
  if (wanted === '') return null;
  return apis.find((api) => api.name === wanted) ?? null;
}
