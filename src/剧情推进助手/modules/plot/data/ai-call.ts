/**
 * 取数层 · AI 调用（第 2 期）
 *
 * 对应 ACU 剧情推进里「把拼好的任务提示词发出去、拿回文本」这一步。
 *
 * 这里只有一件事要解释清楚：**为什么传 `should_silence` 和 `max_chat_history`**。
 * 它们不是新功能，是为了让送出去的东西和 ACU 送出去的**一模一样**。
 * 少传任何一个，任务提示词都会变样（理由写在下面几行注释里）。
 */

import type { PlotRoundMessage } from '../eng/engine';
import type { CustomApiPayload } from '../api-route';
import { buildTimeoutError, normalizeTimeoutSeconds } from '../eng/call-outcome';
import { tavernPostProcessing } from './post-processing-host';

/** `generateRaw` 正常返回纯文本；只有传了 `tools` 才可能返回工具调用对象。 */
type RawGenerateResult = string | { content?: string } | null | undefined;

export type RawGenerator = (config: Record<string, unknown>) => Promise<RawGenerateResult>;

/** 按 id 停止某次生成；缺了它就退化成「不设超时」。 */
type GenerationStopper = (generationId: string) => boolean;

export interface PlotApiCallOptions {
  /** ACU 的每次任务调用都有自己的 id，便于中止；这里照做。 */
  generationId?: string;
  /** 默认 0（不带聊天记录）。见文件头：这是等价性要求，不是选项功能。 */
  maxChatHistory?: 'all' | number;
  /**
   * 剧情推进助手自己的 API（由 `toCustomApiPayload` 换算而来）。
   * 传 `null` / 不传 = 跟随酒馆当前连接。
   */
  customApi?: CustomApiPayload | null;
  /**
   * 超时秒数。`<= 0` = 不设超时。
   *
   * 生效方式见 `runWithTimeout`：到点调 `stopGenerationById` 掐掉请求，再抛 `TimeoutError`。
   * 这条错误会被重试层当成"接口失败"（与 ACU 一致），不会中止整轮。
   */
  timeoutSeconds?: number;
  /**
   * 提示词后处理（对应酒馆设置里的 `custom_prompt_post_processing`）。
   *
   * 为什么是「借用」而不是直接塞进调用参数：酒馆助手这条链路里，这个键只从**预设设置**里抄
   * （`createGenerationParametersCompat.ts:138`），`custom_api` 的白名单里没有它，
   * `custom_include_body` 也走不通（那个合进的是发往上游的 bodyParams）。
   * 所以只能在调用期间临时改酒馆那一格、结束立刻还原 —— 细节见 `plot/post-processing.ts`。
   *
   * 空串 / 不传 = 不动；`'follow'` 同理。
   */
  promptPostProcessing?: string;
  /** 测试注入用。 */
  raw?: RawGenerator;
  /** 测试注入用：按 id 停生成。 */
  stopGeneration?: GenerationStopper;
  /**
   * 终止信号（用户在等待气泡上点了「终止」）。
   *
   * 为什么不能只靠 `checkAbort` 那个回调：它只在**两次任务之间**被问一次，
   * 一条请求正在飞的时候它管不到。用户按了终止却要等 300 秒超时，那不叫终止。
   * 这里直接掐 `generationId` 对应的请求，并抛 `AbortError`（引擎认得它，不会重试）。
   */
  signal?: AbortSignal;
}

/** 造一个引擎认得的「用户中止」错误：`isUserAbortError` 按 name 判，`/abort/i` 即可。 */
function buildAbortError(): Error {
  const error = new Error('剧情推进：用户终止了这一轮');
  error.name = 'AbortError';
  return error;
}

function resolveRawGenerator(): RawGenerator | null {
  const candidate = (globalThis as Record<string, unknown>).generateRaw;
  return typeof candidate === 'function' ? (candidate as RawGenerator) : null;
}

/** 取酒馆的 `stopGenerationById`；没有就返回 null（超时退化成"不设"）。 */
function resolveGenerationStopper(): GenerationStopper | null {
  const candidate = (globalThis as Record<string, unknown>).stopGenerationById;
  return typeof candidate === 'function' ? (candidate as GenerationStopper) : null;
}

/**
 * 给一次生成挂上限。
 *
 * 实现要点（每一条都踩过或差点踩到）：
 *
 * - **靠"掐请求"而不是"扔掉结果"**：光用 `Promise.race` 只是让我们不再等，
 *   酒馆那边的请求还在跑、还会继续往上下文里写、还占着并发。所以到点要调
 *   `stopGenerationById` 把它真停掉。
 * - **没有 `generation_id` 就没法掐**：`stopGenerationById` 认的是 id。
 *   所以调用方必须给 id；没给时这里**不设超时**（宁可没有上限，也不要挂一个掐不掉的定时器）。
 * - **`stopGenerationById` 可能返回 false**（已结束或没找到）：这不算错，照样抛超时 ——
 *   我们要的是"不再等"，而不是"确认它停了"。返回 false 时它本身也在收尾了。
 * - **清理定时器必须在 finally**：否则成功路径上会留下一个定时器，下次才炸。
 */
async function runWithTimeout(
  run: () => Promise<RawGenerateResult>,
  options: {
    seconds: number | null;
    generationId: string;
    stopper: GenerationStopper | null;
    label: string;
    signal?: AbortSignal;
  },
): Promise<RawGenerateResult> {
  const { seconds, generationId, stopper, label, signal } = options;

  // 已经中止了的：连请求都别发
  if (signal?.aborted === true) throw buildAbortError();

  // 不设超时、或掐不断（没 id / 没接口）→ 老实等着（中止仍然要管：下面单独挂监听）
  const canStop = seconds !== null && generationId !== '' && stopper !== null;

  return new Promise<RawGenerateResult>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      // 掐掉在飞的请求：拿不到 id / 没有接口时就只能等它自己结束，
      // 但至少这一轮不再往下跑（引擎收到 AbortError 会立刻收尾）。
      if (generationId !== '' && stopper) {
        try {
          stopper(generationId);
        } catch (error) {
          console.warn(`[剧情推进助手] 终止时停止生成请求失败（${generationId}）`, error);
        }
      }
      reject(buildAbortError());
    };

    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    if (canStop) {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          stopper(generationId);
        } catch (error) {
          // 掐失败不掩盖真正的问题：仍按超时收场，但把原因记下来
          console.warn(`[剧情推进助手] 停止超时的生成请求失败（${generationId}）`, error);
        }
        reject(buildTimeoutError(seconds, label));
      }, seconds * 1000);
    }

    run()
      .then((value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        reject(error);
      })
      .finally(() => {
        signal?.removeEventListener('abort', onAbort);
      });
  });
}

/**
 * 发一次任务调用，拿回纯文本。
 *
 * 两个必须照 ACU 来的点：
 *
 * - **`ordered_prompts` 用我们拼好的数组**：ACU 的 `callApi` 收的是完整 messages，
 *   不经过酒馆预设。换成 `generate()` 会把预设、角色卡、聊天记录再叠一层，
 *   任务就不再是「执行这条指令」而是「接着聊天往下写」。
 * - **`max_chat_history: 0`**：`generateRaw` 这个参数默认是 `'all'`，也就是会把
 *   真实聊天记录塞在消息前面。不显式关掉，等于把同一段故事喂两遍（`$7` 已经给过一份）。
 *
 * 失败一律**原样抛出**：`runTaskAttempts` 判「用户主动中止」靠的是错误对象的 `name`，
 * 包一层 `new Error(...)` 会让中止退化成「接口失败」，白重试三次。
 */
export async function callPlotApi(messages: PlotRoundMessage[], options: PlotApiCallOptions = {}): Promise<string> {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('剧情推进：这次任务没有任何提示词，拒绝发起调用');
  }

  const raw = options.raw || resolveRawGenerator();
  if (!raw) {
    throw new Error('剧情推进：当前环境没有 generateRaw，无法发起任务调用');
  }

  const config: Record<string, unknown> = {
    max_chat_history: options.maxChatHistory ?? 0,
    // 静默生成：ACU 的任务调用不占酒馆正常的发送流程，界面上也不该出现「正在输入」。
    should_silence: true,
    ordered_prompts: messages.map(message => ({ role: message.role, content: message.content })),
  };
  if (options.generationId) config.generation_id = options.generationId;
  // 只有真的配了独立 API 才传这个键：不传 = 跟随酒馆当前连接，
  // 传一个空对象反而会让酒馆走进"自定义"分支然后拿不到地址。
  if (options.customApi) config.custom_api = options.customApi;

  // 超时：到点掐掉这次生成（靠 generation_id），再抛 TimeoutError。
  // 没给 id 就掐不掉，那时退化成不设超时 —— 挂一个掐不掉的定时器只会让请求在后台继续跑。
  const seconds = normalizeTimeoutSeconds(options.timeoutSeconds, 0);

  // 后处理参数只能「借」：调用前改酒馆那一格，结束（成功、超时、报错、中止）一律还原。
  // 还原放在 finally 里，否则一次超时就会把用户设置永久留在我们改过的状态。
  const borrow = options.promptPostProcessing ? tavernPostProcessing.borrow(options.promptPostProcessing) : null;
  if (borrow && borrow.note !== null) console.warn(`[剧情推进助手] ${borrow.note}`);

  let result: RawGenerateResult;
  try {
    result = await runWithTimeout(() => raw(config), {
      seconds,
      generationId: options.generationId ?? '',
      stopper: options.stopGeneration ?? resolveGenerationStopper(),
      label: '剧情推进任务调用',
      signal: options.signal,
    });
  } finally {
    borrow?.release();
  }

  if (typeof result === 'string') return result;
  // ⚠️ 这里必须判「非空」：宿主开着工具调用/防截断时，正文被搬进 `tool_calls`，
  // 回来的就是 `{ content: '', tool_calls: [...] }`。原版只判 `typeof content === 'string'`
  // 就直接返回空串，于是任务永远被判「回复为空」，而渠道站那边明明每次都成功、回了上百字
  // —— 2026-11-04 用户报的「记忆召回永远没有 AI 回传」就是这个形状。
  if (result && typeof result === 'object' && typeof result.content === 'string' && result.content.trim() !== '') {
    return result.content;
  }

  // 正文可能不在 content 里，而在**工具调用的参数**里：
  // 酒馆侧的「防截断」一类脚本会 hook fetch，给请求追加一个工具、把 AI 的正文塞进
  // tool_calls[].function.arguments 再发回来。ACU 有 chatTurnFromJson 专门吃这种返回，
  // 我们以前只认纯文本 —— 于是同一套提示词、同一个 API，ACU 能跑通，
  // 我们报「任务回复长度不足」或「aborted-by-stage-failure」（2026-11-02 用户实测）。
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const carried = textFromToolCalls(result as Record<string, unknown>);
    if (carried !== null && carried.trim() !== '') return carried;
  }

  // 走到这里说明拿到的是个对象，但里面没有 content。
  //
  // 最常见的成因是酒馆那边开着「API 工具调用 / 函数调用」：正文被塞进 tool_calls 的
  // 函数参数里发回来了，于是 `content` 是空的。只报「返回了非文本结果」等于什么都没说 ——
  // 现场必须能看出「到底回来了什么」，所以把键名原样列出来，让人一眼认出是 tool_calls。
  if (result === null || result === undefined) {
    throw new Error('剧情推进：任务调用没有返回任何内容（null）。这条请求被宿主直接吞掉了，先看酒馆控制台有没有生成报错。');
  }
  const keys = result && typeof result === 'object' && !Array.isArray(result) ? Object.keys(result) : [];
  const listed = keys.length > 0 ? keys.join(', ') : '（一个键都没有）';
  throw new Error(
    `剧情推进：任务调用返回的是对象，里面没有正文。拿到的键名：${listed}。` +
      '如果列表里有 tool_calls 或 function_call，说明正文确实在工具调用里，但参数格式没认出来。',
  );
}

/**
 * 从工具调用的参数里拣正文。
 *
 * 参数通常是 JSON 字符串；也有渠道直接把正文整段当 arguments 给（解析失败就整段当正文）。
 * 键名按可能性从高到低试，取最长的那段 —— 与 ACU `readArgsContent` 同口径。
 */
/**
 * 正文所在的键名。
 *
 * 只认 `content`，这不是猜的：宿主的「防截断」扩展声明工具时写的就是
 * `parameters: { properties: { content: { type: 'string' } }, required: ['content'] }`，
 * 正文只能放在这一个键里。多认几个键只会在别的扩展上撞运气，撞错了还会把参数壳当正文。
 */
function pickCarriedText(args: unknown): string | null {
  let parsed = args;
  if (typeof args === 'string') {
    const raw = args.trim();
    if (raw === '') return null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const record = parsed as Record<string, unknown>;
  const carried = record.content;
  if (typeof carried === 'string' && carried !== '') return carried;

  // 没有 `content` 键：不猜别的键名，只看这个对象里有没有一段像正文的字符串。
  // 我们最终要的是「按闭合标签对提取」而不是「原样注入」—— 拿到最长那段交给提取器就够了，
  // 提不出标签自然会被判成这一轮没产出，不会被误当正文塞进楼层。
  const strings = Object.values(record).filter(
    (value): value is string => typeof value === 'string' && value !== '',
  );
  if (strings.length === 0) return null;
  return strings.reduce((longest, value) => (value.length > longest.length ? value : longest));
}

/**
 * 从工具调用里把文本捞出来。
 *
 * 多个 tool_call 一律**拼起来**而不是取最长那个：一轮任务可能把不同标签拆在几次
 * 调用里，只留最长的一段等于把别的标签丢掉 —— 而后面正是按标签对提取，缺一个就是
 * 缺一块成果。
 */
function textFromToolCalls(result: Record<string, unknown>): string | null {
  const calls = result.tool_calls;
  if (!Array.isArray(calls)) {
    const single = result.function_call;
    if (single && typeof single === 'object') {
      return pickCarriedText((single as { arguments?: unknown }).arguments);
    }
    return null;
  }

  const pieces: string[] = [];
  for (const call of calls) {
    const args = (call as { function?: { arguments?: unknown } } | null)?.function?.arguments;
    const text = pickCarriedText(args);
    if (text !== null) pieces.push(text);
  }
  return pieces.length === 0 ? null : pieces.join('\n');
}
