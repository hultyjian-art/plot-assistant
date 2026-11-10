/**
 * 剧情推进 — 「拉取模型列表」里**碰网络的那一层**。
 *
 * 单独一个文件的原因与 `acu-apis-io.ts` 一样：纯逻辑（地址拼装 / 解析 / 措辞）
 * 留在 `api-models.ts` 好让 Node 里的对照测试直接编；`fetch` 只出现在这里。
 *
 * 三点要求：
 *   1. 一定带超时 —— `fetch()` 本身**没有默认超时**，地址填错或中转站挂了会挂到天荒地老
 *      （2026-11-07 真机踩过：中转站 502，酒馆助手代理那条路挂着不还，按钮一直忙，
 *      用户连换渠道再拉都拉不了）
 *   2. 失败要说清是哪一类 —— 超时 / 连不上 / 状态码 / 被取消，几种的修法完全不同
 *   3. 调用方要能中途掐断 —— 切换了 API 渠道、关闭面板时，在途的拉取立刻放弃（批 42 用户定）
 */
import { buildModelsUrl, describeModelsError, parseModelList, type ModelListSource } from './api-models';
import { stContext } from '../tavern';

/**
 * 单次请求的超时：15 秒。拉一个清单本身很轻，但这个值不能太小 —— 2026-11-01 实测同一个地址，
 * 一次 2 秒内回了 14 个模型，紧接着一次 8 秒还没回话（中转站自己的抖动）。
 * 超时设短了会把「对方慢」报成「拉取失败」，用户会以为钥匙填错了。
 */
export const MODEL_FETCH_TIMEOUT_MS = 15000;

/**
 * 一次「拉取」的**总预算**：30 秒（2026-11-07 批 42 用户定）。
 *
 * 三条路（酒馆后端 status → 酒馆助手代理 → 直连）共享这一个截止时刻：
 * 每条路最多拿到剩下的时间，预算耗尽就出最终结论，绝不无限等下去。
 * 30 秒是交互式读取类请求的行业惯例区间（常见 5–30 秒）的上限，也落在
 * 用户建议的「半分钟到 1 分钟」里偏利落的那头。
 */
export const MODEL_FETCH_BUDGET_MS = 30000;

/** 调用方的中止口径：signal 一旦 abort，在途拉取立刻放弃并返回「已取消」。 */
export interface ModelFetchOptions {
  signal?: AbortSignal | null;
}

export type ModelListResult = { ok: true; models: string[] } | { ok: false; reason: string };

/** 带名字的 AbortError（Node / 浏览器两边都认）。 */
function abortError(kind: 'timeout' | 'cancelled'): Error {
  const error = new Error(kind);
  error.name = 'AbortError';
  return error;
}

/**
 * 给一段异步工作套上「到点就散」的壳。工作本身没有 abort 参数也能限时 ——
 * 超时后这边不再等它（原promise 稍后自己落定，结果作废，不会变成 unhandled rejection）。
 */
function raceWithAbort<T>(promise: Promise<T>, ms: number, external?: AbortSignal | null): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (external?.aborted) {
      reject(abortError('cancelled'));
      return;
    }
    const onAbort = () => reject(abortError('cancelled'));
    const timer = setTimeout(() => reject(abortError('timeout')), Math.max(0, ms));
    if (external) external.addEventListener('abort', onAbort);
    promise.then(
      (value) => {
        clearTimeout(timer);
        external?.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        external?.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/**
 * 照 ACU 的做法直接问酒馆后端要模型列表。
 *
 * 请求体是照着 ACU `fetchAvailableModels_ACU` 抄的：`chat_completion_source: 'custom'`
 * 加上 `custom_url`，钥匙走 `custom_include_headers`。这套组合与本项目「用户手填明文钥匙」
 * 的情形对得上；`getModelList` 那条路走的是酒馆密钥库的 `secret_id`，填了钥匙也没用。
 *
 * 拿不到（没上下文 / 非 2xx / 形状不认识）就返回 null，交给下面几条路继续试 ——
 * 这里只负责多提供一条能走通的路，不负责报错；但降级原因要留一条日志，
 * 免得排查时以为这条路从来没被问过。
 */
async function fetchViaTavernStatus(
  url: string,
  key: string,
  budgetLeftMs: number,
  external?: AbortSignal | null,
  fetchImpl?: typeof fetch,
): Promise<string[] | null> {
  const headers = stContext()?.getRequestHeaders?.();
  if (!headers) return null;
  const doFetch = fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined);
  if (!doFetch) return null;

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  // 单次请求上限 = 15 秒与剩余预算取小；外部中止（切渠道 / 关面板）一并接上
  const waitMs = Math.min(MODEL_FETCH_TIMEOUT_MS, Math.max(0, budgetLeftMs));
  const timer = controller ? setTimeout(() => controller.abort(), waitMs) : null;
  const onAbort = () => controller?.abort();
  if (external) {
    if (external.aborted) onAbort();
    else external.addEventListener('abort', onAbort);
  }
  try {
    const response = await doFetch('/api/backends/chat-completions/status', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reverse_proxy: url,
        proxy_password: '',
        chat_completion_source: 'custom',
        custom_url: url,
        custom_include_headers: key === '' ? '' : `Authorization: Bearer ${key}`,
      }),
      cache: 'no-cache',
      signal: controller?.signal ?? undefined,
    });
    if (!response.ok) return null;
    const parsed = parseModelList(await response.json());
    return parsed.ok ? parsed.models : null;
  } catch (error) {
    console.warn('[剧情推进助手] 酒馆后端拉取模型列表失败，改走下面的路', error);
    return null;
  } finally {
    if (timer !== null) clearTimeout(timer);
    if (external) external.removeEventListener('abort', onAbort);
  }
}

/**
 * 拉一次模型清单。
 *
 * @param source 用户在面板上填的地址与钥匙（钥匙此时已是明文，读设置时就解过混淆）
 * @param fetchImpl 测试时可注入；不传就用全局 `fetch`
 * @param options.signal 面板的在途拉取闸门：切换渠道 / 关闭面板时 abort，
 *   三条在途的请求立刻全部放弃，返回「已取消」
 */
export async function fetchModelList(
  source: ModelListSource,
  fetchImpl?: typeof fetch,
  options?: ModelFetchOptions,
): Promise<ModelListResult> {
  const external = options?.signal ?? null;
  const deadline = Date.now() + MODEL_FETCH_BUDGET_MS;
  const budgetLeft = (): number => Math.max(0, deadline - Date.now());
  const cancelledResult = (): ModelListResult => ({
    ok: false,
    reason: `拉取已取消（切换了渠道或关闭了面板）。`,
  });

  const url = buildModelsUrl(source.url);
  if (url === '') return { ok: false, reason: '先把 API 地址填上，再点拉取。' };
  if (external?.aborted) return cancelledResult();

  const key = typeof source.apiKey === 'string' ? source.apiKey.trim() : '';

  // 先照 ACU 的做法问酒馆要一份。
  //
  // 为什么不直接只用下面的 `getModelList`：它内部把密钥走 `secret_id` 那条路
  // （从酒馆密钥库按 id 取），而我们这儿是用户手填的明文钥匙，得塞进
  // `custom_include_headers` 才认。同一个地址 ACU 拉得到、我们拉不到，
  // 差的就是这一处 —— 2026-11-03 用户实测确认。
  const viaStatus = await fetchViaTavernStatus(source.url, key, budgetLeft(), external, fetchImpl);
  if (viaStatus !== null && viaStatus.length > 0) return { ok: true, models: viaStatus };
  if (external?.aborted) return cancelledResult();

  // 再走酒馆助手那个通用入口。
  //
  // 在 iframe 里直接 `fetch` 一个第三方域名会被浏览器按 CORS 拦下来 —— 对方没给
  // 我们 `Access-Control-Allow-Origin` 就一律失败，跟钥匙对不对、地址通不通都没关系。
  // 工作流助手一直能拉到，就是因为它走的是酒馆后端转发（`getModelList`）。
  // 这里不写 `typeof getModelList`：那是酒馆助手注入的全局声明，parity 的编译环境里没有，
  // 写成函数签名就与运行环境解耦了。
  //
  // ⚠️ 这条路**必须限时**：它没有 abort 参数，中转站挂了就挂着不还（2026-11-07 实测）。
  // 用剩余预算跟它赛跑，到点不等 —— 后台那个孤儿请求自己落定，结果作废。
  type GetModelListFn = (input: { apiurl: string; key?: string }) => Promise<string[]>;
  const proxy = (globalThis as { getModelList?: GetModelListFn }).getModelList;
  if (typeof proxy === 'function') {
    try {
      const list = await raceWithAbort(
        proxy({ apiurl: source.url, key: key === '' ? undefined : key }),
        budgetLeft(),
        external,
      );
      const models = (Array.isArray(list) ? list : []).map(item => String(item).trim()).filter(item => item !== '');
      if (models.length > 0) return { ok: true, models: Array.from(new Set(models)) };
      // 代理回了空清单：不急着判死，落到下面用直连再试一次，取那边的措辞。
    } catch (error) {
      if (external?.aborted) return cancelledResult();
      const name = (error as { name?: string } | null)?.name ?? '';
      if (name === 'AbortError') {
        return {
          ok: false,
          reason: `拉取超时（总预算 ${MODEL_FETCH_BUDGET_MS / 1000} 秒用完了，酒馆助手代理一直没回话）。`,
        };
      }
      // 代理这条走不通（酒馆没装、被关掉、或对方拒绝）也落到直连，让下面的报错说话。
      console.warn('[剧情推进助手] 酒馆助手代理拉取模型列表失败，改走直连', error);
    }
  }

  const doFetch = fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined);
  if (!doFetch) return { ok: false, reason: '这个环境没有 fetch，没法拉取。' };

  const directBudget = budgetLeft();
  if (directBudget < 3000) {
    // 直连至少要留 3 秒，否则拖着半条命走完也只会得到一句超时，不如现在就说清
    return { ok: false, reason: `拉取超时（总预算 ${MODEL_FETCH_BUDGET_MS / 1000} 秒用完了）。` };
  }

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const waitMs = Math.min(MODEL_FETCH_TIMEOUT_MS, directBudget);
  const timer = controller ? setTimeout(() => controller.abort(), waitMs) : null;
  const onAbort = () => controller?.abort();
  if (external) {
    if (external.aborted) onAbort();
    else external.addEventListener('abort', onAbort);
  }

  try {
    const response = await doFetch(url, {
      method: 'GET',
      headers: key === '' ? {} : { Authorization: `Bearer ${key}` },
      signal: controller?.signal,
    });
    const text = await response.text();
    if (!response.ok) return { ok: false, reason: describeModelsError(response.status, text) };

    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      // 有的站把 HTML 错误页也回 200，这里必须当失败，不能当成「没有模型」
      return { ok: false, reason: '返回的不是 JSON，可能地址指到了网页而不是接口。' };
    }

    const parsed = parseModelList(payload);
    if (parsed.ok) return { ok: true, models: parsed.models };
    return {
      ok: false,
      reason: parsed.reason === 'empty' ? '接口通了，但清单是空的（这个钥匙可能没有可用模型）。' : '返回的格式认不出来，不是常见的 OpenAI 兼容清单。',
    };
  } catch (error) {
    if (external?.aborted) return cancelledResult();
    const name = (error as { name?: string } | null)?.name ?? '';
    if (name === 'AbortError') {
      // 15 秒的单请求超时与总预算耗尽，报法分开：前者多半是「对方慢」，后者是「几条路都没戏」
      return {
        ok: false,
        reason:
          waitMs < MODEL_FETCH_TIMEOUT_MS
            ? `拉取超时（总预算 ${MODEL_FETCH_BUDGET_MS / 1000} 秒用完了）。`
            : `拉取超时（${MODEL_FETCH_TIMEOUT_MS / 1000} 秒没回话）。`,
      };
    }
    const message = (error as { message?: string } | null)?.message ?? String(error);
    return { ok: false, reason: `连不上这个地址：${message}` };
  } finally {
    if (timer !== null) clearTimeout(timer);
    if (external) external.removeEventListener('abort', onAbort);
  }
}
