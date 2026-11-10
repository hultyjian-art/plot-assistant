/**
 * 剧情推进 — 「附加请求体参数」的解析与 DeepSeek 推荐参数。
 *
 * ## 为什么要有这一层
 *
 * 酒馆的 `generateRaw` 只多给了一个口子：`custom_api.custom_include_body`
 * （见 `@types/function/generate.d.ts:406`），它接受**一个对象**，
 * 由酒馆助手转成 YAML 塞进上游请求体。也就是说面板上必须留一格给用户写
 * 「要往请求体里加什么」—— 数据库脚本（ACU）与工作流助手都是这么做的，
 * 用户从那边抄过来的参数才能直接用。
 *
 * ## 为什么同时认 YAML 和 JSON
 *
 * 这件事在用户眼里没有区别，但抄参数时区别很大：
 * - 数据库脚本 / 工作流助手的面板里显示的是 YAML；
 * - 从接口文档抄过来的是 JSON。
 *
 * 两边都认，用户顺手贴哪一种都行。JSON 是 YAML 的子集，理论上只用 YAML 解析就够，
 * 但先用 `JSON.parse` 试一遍有两个实打实的好处：报错信息是 JSON 自己的（更准），
 * 而且 `{"a": "1"}` 这种单行写法不会被 YAML 误读成字符串。
 *
 * ## 一条必须说清的边界
 *
 * 这些参数**只在接口协议（`source`）是 `custom` 时生效** ——
 * 酒馆客户端只在 `chat_completion_source === 'custom'` 的分支里读
 * `custom_include_body`（`SillyTavern/public/scripts/openai.js:2854`）。
 * 选 DeepSeek 官方源、OpenAI 官方源时贴进来的参数会被酒馆丢掉，
 * 所以面板上必须把这句话写给用户看，否则他会以为「填了没反应」是 bug。
 */

import { parse as parseYamlText, stringify as stringifyYamlText } from 'yaml';
import { isPlainObject } from './guards';

/** 解析结果。`value === null` 表示「这格是空的」，不是失败。 */
export interface BodyParamsResult {
  ok: boolean;
  /** 成功时：解析出来的对象；空输入时是 `null`。 */
  value: Record<string, unknown> | null;
  /** 失败时：说清哪一段不对，直接能显示给用户。 */
  error: string;
}

/**
 * 把面板上的「附加请求体参数」解析成对象。
 *
 * 失败时**不抛异常**：这是用户手填的格子，写错一个冒号很常见，
 * 抛出去会连带把整轮推进打断；调用方拿 `ok === false` 决定「这一轮不跑，并告诉他哪里错了」。
 */
export function parseBodyParams(text: string): BodyParamsResult {
  const source = typeof text === 'string' ? text.trim() : '';
  if (source === '') return { ok: true, value: null, error: '' };

  let parsed: unknown;
  try {
    // 先按 JSON 解：单行 JSON 交给 YAML 会因为「看起来像字符串」而解出别的东西。
    parsed = source.startsWith('{') || source.startsWith('[') ? JSON.parse(source) : parseYamlText(source);
  } catch (jsonError) {
    // JSON 失败了再给 YAML 一次机会 —— 大多数情况是用户贴的 YAML，
    // 上面那个分支只是「以 { 开头」的猜测，猜错不该直接判死刑。
    try {
      parsed = parseYamlText(source);
    } catch (yamlError) {
      return { ok: false, value: null, error: describeParseError(yamlError, jsonError) };
    }
  }

  if (!isPlainObject(parsed)) {
    return {
      ok: false,
      value: null,
      error: '附加请求体参数必须是一组「键: 值」，比如 response_format: { type: json_object }。现在解析出来的不是键值表。',
    };
  }
  return { ok: true, value: parsed, error: '' };
}

/** 优先报 YAML 的错（那才是用户大概率写的格式），把 JSON 的错附在后面。 */
function describeParseError(yamlError: unknown, jsonError: unknown): string {
  const yamlMessage = errorMessage(yamlError);
  const jsonMessage = errorMessage(jsonError);
  if (yamlMessage !== '' && jsonMessage !== '') return `${yamlMessage}（按 JSON 解析时：${jsonMessage}）`;
  return yamlMessage || jsonMessage || '格式不对，看不懂。';
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.split('\n')[0] ?? '';
  return typeof error === 'string' ? error.split('\n')[0] ?? '' : '';
}

/**
 * 把「要排除的参数」拆成数组。
 *
 * 用户可能用逗号、顿号、空格或换行分隔 —— 这三种在中文输入法下都会自然出现，
 * 只认逗号会让人填 `top_p reasoning_effort` 时静默失效。拆完去重、保序。
 */
export function parseExcludeParams(text: string): string[] {
  const source = typeof text === 'string' ? text : '';
  const parts = source.split(/[,，、\s]+/);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    const name = part.trim();
    if (name === '' || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/** DeepSeek 关思考的写法。这是网关侧的私有字段，不是 OpenAI 标准。 */
export const DEEPSEEK_THINKING_BODY = 'thinking:\n  type: disabled';

/** 严格 JSON 的写法。 */
export const DEEPSEEK_STRICT_JSON_BODY = 'response_format:\n  type: json_object';

/** 严格 JSON 时酒馆要排除的参数（与工作流助手同一口径）。 */
export const DEEPSEEK_STRICT_JSON_EXCLUDE = 'top_p, reasoning_effort';

/** 「一键写入」的结果：要么给回填内容，要么给一句能显示的错误。 */
export type DeepSeekTemplateResult =
  | { ok: true; bodyParams: string; excludeBodyParams: string }
  | { ok: false; error: string };

/**
 * 一键写入 DeepSeek 推荐参数。
 *
 * 两个开关分开，是因为它们的影响完全不同：
 * - **关思考**（`cot = false`）：只是让模型别把思考过程吐出来，对标签提取只有好处。
 * - **严格 JSON**（`strictJson = true`）：会强制模型输出 JSON ——
 *   而我们的任务产物是 `<标签>…</标签>` 的纯文本，开了它反而抓不到标签。
 *   所以它默认**关**，谁要用谁自己开。
 *
 * 与工作流助手的一处差异：它还会写 `custom_prompt_post_processing: strict`。
 * 我们写不了 —— 那个字段由酒馆**预设**决定，`generateRaw` 这条链路传不进去
 * （`JS-Slash-Runner/src/function/generate/createGenerationParametersCompat.ts:138`
 * 是从预设设置里拷的，不是从 `custom_api` 里读的）。与其写一个不生效的键骗人，不如不写。
 */
export function buildDeepSeekTemplate(
  currentBodyParams: string,
  currentExclude: string,
  options: { cot: boolean; strictJson: boolean },
): DeepSeekTemplateResult {
  const parsed = parseBodyParams(currentBodyParams);
  if (!parsed.ok) {
    return { ok: false, error: `现有参数解析不了，先修好它再一键写入：${parsed.error}` };
  }

  const next: Record<string, unknown> = { ...(parsed.value ?? {}) };
  next.thinking = { type: options.cot ? 'enabled' : 'disabled' };
  if (options.strictJson) next.response_format = { type: 'json_object' };

  let bodyParams = '';
  try {
    bodyParams = stringifyYamlText(next).trimEnd();
  } catch (error) {
    return { ok: false, error: `写不出去：${errorMessage(error) || '序列化失败'}` };
  }

  return {
    ok: true,
    bodyParams,
    // 关思考时不动排除清单：用户可能已经排除过别的参数，清掉是越权。
    excludeBodyParams: options.strictJson ? DEEPSEEK_STRICT_JSON_EXCLUDE : currentExclude,
  };
}
