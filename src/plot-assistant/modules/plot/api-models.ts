/**
 * 剧情推进 — 「拉取模型列表」的**纯逻辑**（地址拼装 / 响应解析 / 报错措辞）。
 *
 * 为什么要有这个功能：面板上模型名只能手输，输错了不会当场报错，
 * 要等真跑一轮才暴露（2026-11-01 实测：填 `deepseek-v4-flash-0731` 返回
 * `503 model_not_found`，而这个站在 `/v1/models` 里明明写着
 * `deepseek-ai/DeepSeek-V4-Flash-0731`）。让用户对着真实清单点选，比记名字可靠。
 *
 * 边界：
 *   - 只做 OpenAI 兼容的 `GET {base}/models`，不猜别家端点
 *   - 不碰网络：发请求的那 20 行在 `api-models-io.ts`，这里是纯函数、可在 Node 里测
 *   - 永不抛：地址空、返回不是 JSON、格式不认 —— 一律返回「读不到 + 原因」
 */

/** 与 `PlotApiEntry` 对齐的最小形状（只用这两个字段，且不 import types.ts，理由同 acu-apis.ts）。 */
export interface ModelListSource {
  url: string;
  apiKey: string;
}

/**
 * 从用户填的地址推出 `/models` 的完整地址。
 *
 * 要处理的几种真实输入：
 *   - `https://host/v1`              → `https://host/v1/models`
 *   - `https://host/v1/`             → 同上（去掉尾斜杠）
 *   - `https://host/v1/chat/completions` → 同上（很多人直接粘贴请求地址）
 *   - `https://host/v1/models`       → 原样（别拼成 `/models/models`）
 *   - 空串                           → 空串（调用方据此提示「先填地址」）
 */
export function buildModelsUrl(baseUrl: string): string {
  const text = typeof baseUrl === 'string' ? baseUrl.trim() : '';
  if (text === '') return '';

  let url = text.replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(url)) {
    url = url.replace(/\/chat\/completions$/i, '').replace(/\/+$/, '');
  }
  if (/\/models$/i.test(url)) return url;
  return `${url}/models`;
}

/** 解析结果。`empty` = 结构认得但一个模型都没有；`bad-shape` = 认不出来。 */
export type ModelListParse =
  | { ok: true; models: string[] }
  | { ok: false; reason: 'bad-shape' | 'empty' };

/**
 * 把 `/models` 的 JSON 解析成名字数组。
 *
 * 兼容三种见得最多的形状（其余一律 `bad-shape`，不猜）：
 *   - `{ data: [{ id }] }` —— OpenAI 兼容站标准形状
 *   - `{ data: ["a", "b"] }` —— 有的站省掉对象
 *   - `{ models: [...] }`    —— Ollama 一类
 * 也直接吃裸数组。
 *
 * 顺序保留服务端给的顺序（有些站把它当推荐序），只做去重与去空白。
 */
export function parseModelList(payload: unknown): ModelListParse {
  const items = pickArray(payload);
  if (items === null) return { ok: false, reason: 'bad-shape' };

  const models: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const name = readModelName(item);
    if (name === '') continue;
    if (seen.has(name)) continue;
    seen.add(name);
    models.push(name);
  }

  if (models.length === 0) return { ok: false, reason: 'empty' };
  return { ok: true, models };
}

/** 取出候选数组；认不出就是 null。 */
function pickArray(payload: unknown): unknown[] | null {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return null;
  const map = payload as Record<string, unknown>;
  if (Array.isArray(map.data)) return map.data;
  if (Array.isArray(map.models)) return map.models;
  return null;
}

/** 一条候选 → 模型名；字符串直接用，对象读 `id` / `name` / `model`。 */
function readModelName(item: unknown): string {
  if (typeof item === 'string') return item.trim();
  if (!item || typeof item !== 'object') return '';
  const map = item as Record<string, unknown>;
  for (const key of ['id', 'name', 'model']) {
    const value = map[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return '';
}

/**
 * 把失败翻译成一句人话。
 *
 * 这些状态码不是猜的，是「拉模型列表」这件事上最常撞到的四种：
 * 钥匙不对（401/403）、地址少写或多写了一层（404）、被限流（429）、
 * 以及服务端自己挂了（5xx）。其余统一带状态码 + 响应开头，方便对日志。
 */
export function describeModelsError(status: number, body: string): string {
  const excerpt = String(body ?? '').trim().slice(0, 120);
  if (status === 401 || status === 403) {
    return '钥匙不对或没有权限（401/403）。检查 API Key 填的是不是这个站的。';
  }
  if (status === 404) {
    return '这个地址上没有 /models（404）。多半是地址少写了 /v1，或者多写了一层。';
  }
  if (status === 429) {
    return '拉太快被限流了（429），等一会儿再点。';
  }
  if (status >= 500) {
    return `对方服务端出错（${status}）${excerpt === '' ? '' : `：${excerpt}`}`;
  }
  return `拉取失败（HTTP ${status}）${excerpt === '' ? '' : `：${excerpt}`}`;
}
