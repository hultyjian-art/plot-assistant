/**
 * 剧情推进 — 「这次调用该怎么收场」的判定规则（纯逻辑，不碰任何酒馆全局）。
 *
 * 这个文件解决两类错误混在一起的老问题：
 *
 * ## 问题一：用户点中止，被当成"接口炸了"白重试三次
 *
 * `runTaskAttempts` 里本来就留了口子（`isAbort`，`eng/task-accept.ts:104`），
 * 但**从来没有人传进去过**（`grep isAbort src/...` 只有定义处与使用处，没有传值处）。
 * 于是用户按停止键、切走的后果是：脚本把这个异常当成「接口失败」，
 * 按 `maxRetries` 又原样重发 2~3 次 —— 用户等了十几秒才发现真的停了。
 *
 * ## 问题二：接口卡住不返回，整轮无限等
 *
 * 酒馆的 `generateRaw` 没有超时参数（`@types/function/generate.d.ts:227` 的 `GenerateConfig`
 * 里没有 timeout 字段）。面板上那个「超时」框因此曾是个摆设。
 * 现在改成：到点用 `stopGenerationById(generation_id)` 掐掉这次请求，再抛 `TimeoutError`。
 * **与 ACU 一致** —— ACU 的 `withApiRequestTimeout_ACU`（`src/service/ai/api-request-timeout.ts`）
 * 就是这么做的，而且它同样把超时当成一次**可重试的失败**交给上层。
 *
 * ## 三个错误类别，怎么分
 *
 * | 类别 | 判据 | 上层动作 |
 * |---|---|---|
 * | 用户中止 | 错误名含 `Abort` / `Cancel`，或不含超时标记但调用方明确说了是中止 | **立刻停**，不重试 |
 * | 超时 | 我们抛的 `TimeoutError` | **交给重试**（和 ACU 一致：网络抖一下不该整轮作废） |
 * | 其它 | 剩下的所有 | 交给重试 |
 *
 * 关键：**超时不能算中止**。算错了会导致"网络抖一下整轮推进作废"，
 * 而算成中止永远是静默的（用户只会觉得"它自己停了"），很难查。
 */

/**
 * 我们超时时抛出的错误名。
 *
 * 用 `TimeoutError` 而不是随便起的名字，是为了与 ACU 对齐 —— 两边日志里看到同一个词，
 * 将来对照排查时能一眼认出"这是超时，不是密钥或地址不对"。
 */
export const TIMEOUT_ERROR_NAME = 'TimeoutError';

/** 造一个超时错误。**不要**包成 `new Error(...)`：重试层靠 `name` 分类，包了判别不出来。 */
export function buildTimeoutError(seconds: number, label: string): Error {
  const error = new Error(
    `${label} 超时（${seconds} 秒未返回），已停止这次请求，按接口失败处理并交给重试。`,
  );
  error.name = TIMEOUT_ERROR_NAME;
  return error;
}

/** 是不是我们抛的超时错误。 */
export function isTimeoutError(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { name?: unknown }).name === TIMEOUT_ERROR_NAME;
}

/**
 * 是不是「用户主动中止」。
 *
 * 判据来自浏览器与酒馆的实际行为，不是猜的：
 *
 * - `AbortError` / `TimeoutError` 由浏览器或我们抛出 —— **`TimeoutError` 被排除在外**，
 *   因为它要交给重试（见文件头）。只排除它一个，其余 `Abort*` 一律当中止。
 * - 酒馆/助手在用户按停止键时会抛一个名字为 `AbortError` 的 `DOMException`；
 *   某些版本会包一层 `name: 'Error'` 但 `message` 里写着中止。两种都认。
 *
 * **未知一律返回 false（= 交给重试）**：把一次真正的接口故障误判成中止，等于让用户
 * 遇到一次偶发失败就整轮作废；反过来把中止误判成故障，只是多试几次。前者代价更大。
 */
export function isUserAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;

  // 超时是"可重试的失败"，绝对不能当成用户中止
  if (isTimeoutError(error)) return false;

  const named = error as { name?: unknown; message?: unknown };

  if (typeof named.name === 'string') {
    // AbortError 及各种 Abort* 变体；DurationAbort / GenerationAborted 这类也归这里
    if (named.name === 'AbortError' || /abort/i.test(named.name)) return true;
  }

  // 有些包装层把 name 换成 'Error'，只在 message 里留下痕迹
  if (typeof named.message === 'string') {
    const text = named.message;
    if (/AbortError|aborted|已中止|已取消|用户取消|用户中止/.test(text)) return true;
  }

  return false;
}

/**
 * 把超时秒数规整成合法值。
 *
 * 规则（每条都有实际意义，不是随手写的）：
 * - **没传 / undefined** → `null`（不设超时）。缺省不等于"给个默认就开"，因为调用方
 *   本来就是从设置里读的；它没传说明这个功能没配，硬给默认值会让"没想设超时的人"被意外掐断。
 * - `<= 0` → `null`（用户明确关掉）
 * - 非数字 / NaN / Infinity → 用 `fallback`（脏值不该让整轮卡死，也不该让超时静默失效）
 * - 上限 3600 秒（1 小时）：再长就等于没设，而且 `setTimeout` 在超大延迟上行为不可靠
 *
 * ⚠️ 曾经写错的一次：这里原本把 `undefined` 归到 `fallback`，调用方传的 `fallback` 是 `0`，
 * 于是 `undefined` 变成 `0` → 不是 `null` → 挂了一个 **0 秒定时器当场超时**。
 * 现在把 `undefined` 与"脏值"分开处理，就是为了不再踩这个。
 */
export function normalizeTimeoutSeconds(raw: unknown, fallback = 120): number | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    // 脏值退回 fallback；fallback 本身 ≤0 时同样表示"不设超时"，
    // 绝不能返回 0 —— 0 秒定时器会在下一拍就触发，等于每次都超时。
    return fallback > 0 ? Math.min(Math.floor(fallback), 3600) : null;
  }
  if (raw <= 0) return null;
  return Math.min(Math.floor(raw), 3600);
}
