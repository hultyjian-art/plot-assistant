/**
 * 任务回复的验收与重试 —— 移植自 ACU `plot-task-engine.ts` 的 `executeSinglePlotTask_ACU`（660-770 行）
 *
 * 一个任务的产出要过三道关才被认：**非空 → 够长（`minLength`）→ 命中 `extractTags` 里的全部标签**。
 * 不过就重试，重试**每次重发同一份 messages**（不是把上一轮的错误喂回去）。
 * `maxRetries` 次全废，任务判失败，整轮进程按 `stage-run` 的策略停下。
 *
 * 这里只做判定与循环，不碰「用哪个 API 预设」和「怎么组 messages」——
 * 那两件由调用方通过 `callApi` 注入，第 2 期接引擎时才落地。
 *
 * ⚠️ 两条容易被顺手改掉的语义：
 * 1. **长度用的是 `rawResponse.length`（UTF-16 码元）**，不是 `[...str].length`。中文一个字算 1、emoji 算 2，
 *    原版就是这个口径，换了会让「差一个字」的边界移动。
 * 2. **最后一个 `attempt` 失败的类型决定报错文案**：最后一次是接口失败 → 报「API 调用失败」，
 *    否则报「回复验收失败」。不是「只要出现过接口失败就算接口失败」。
 */

import { DEFAULT_RETRY_DELAY_MS } from '../../constants';
import { extractTaskTags, normalizeAdjacentTagNewlines, type TaskTagExtraction } from './tags';

export interface TaskAcceptanceSpec {
  /** 最少字符数，0 表示不设限 */
  minLength: number;
  /** 逗号分隔的标签名 */
  extractTags?: string;
  /** 逗号分隔的「只进字段不进正文」标签名 */
  extractInjectTags?: string;
  /**
   * 逗号分隔的豁免标签名（第 51 批新增）。
   *
   * 这些标签**不要求每轮回传都有**：缺了不判失败、不触发重试；
   * 但 AI 真回传了，仍照常抽取、落盘、进世界书。用于「几轮才触发一次」的任务。
   */
  exemptTags?: string;
}

export type TaskAcceptance =
  | { ok: true; extraction: TaskTagExtraction }
  | { ok: false; reason: string };

/** 切分一份逗号分隔的标签名：trim、小写、去重。 */
function parseTagList(raw?: string): string[] {
  return [
    ...new Set(
      `${raw || ''}`
        .split(',')
        .map(tag => tag.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

/** 拼接两边标签名、切分、trim、小写、去重 —— 原版的 `configuredTags` */
export function parseConfiguredTags(extractTags?: string, extractInjectTags?: string): string[] {
  return [...new Set([...parseTagList(extractTags), ...parseTagList(extractInjectTags)])];
}

/**
 * 必达标签 = 抽取标签 + 只进字段，去掉豁免标签。
 *
 * 豁免只影响「必须回传」这一关，不影响抽取：标签真回来了照样落盘。
 */
export function parseRequiredTags(extractTags?: string, extractInjectTags?: string, exemptTags?: string): string[] {
  const exempt = new Set(parseTagList(exemptTags));
  return parseConfiguredTags(extractTags, extractInjectTags).filter(tag => !exempt.has(tag));
}

/** 抽取时要把豁免标签也纳入普通组，否则只在豁免表里出现的标签永远抽不到。 */
function extractionTags(extractTags?: string, exemptTags?: string): string {
  return [extractTags || '', exemptTags || ''].filter(part => part.trim() !== '').join(',');
}

/** 一次任务调用的回执：正文 +（酒馆支持时）模型的推理内容。 */
export interface PlotApiReply {
  text: string;
  reasoning?: string;
}

function normalizeApiReply(message: string | PlotApiReply | null | undefined): { text: string; reasoning: string } {
  if (typeof message === 'string') return { text: message, reasoning: '' };
  if (message && typeof message === 'object') {
    return {
      text: typeof message.text === 'string' ? message.text : '',
      reasoning: typeof message.reasoning === 'string' ? message.reasoning : '',
    };
  }
  return { text: '', reasoning: '' };
}

/** 失败时也尽量把已回传的标签抽出来 —— 只用于暂存展示与日志，不参与正文。 */
function extractSafely(text: string, spec: TaskAcceptanceSpec): TaskTagExtraction | null {
  if (!text.trim()) return null;
  try {
    return extractTaskTags(text, extractionTags(spec?.extractTags, spec?.exemptTags), spec?.extractInjectTags);
  } catch {
    return null;
  }
}

/**
 * 三道关。顺序不能换：先非空、再长度、最后标签。
 * 标签这一关按「抽取标签 + 只进字段」合并后的清单逐项核对：清单里列出的标签
 * 必须全部回传，少一个就算不合格、整条任务重试。只进字段只是「不进正文」，
 * 不是「可以不抽」—— 它同样要完整落盘。
 * 豁免标签从必达清单里剔除，但仍在抽取组里：回传了就照常落盘，没回传也不判失败。
 * 没配任何必达标签时第三道关直接放行 —— 长度够了就算通过。
 */
export function checkTaskResponse(rawResponse: string, spec: TaskAcceptanceSpec): TaskAcceptance {
  const text = typeof rawResponse === 'string' ? rawResponse : '';
  if (!text.trim()) return { ok: false, reason: '任务回复为空。' };

  const minLength = Number.isFinite(spec?.minLength) && (spec.minLength as number) > 0 ? Math.floor(spec.minLength as number) : 0;
  if (text.length < minLength) {
    return { ok: false, reason: `任务回复长度不足（${text.length}/${minLength}）。` };
  }

  try {
    const extraction = extractTaskTags(text, extractionTags(spec?.extractTags, spec?.exemptTags), spec?.extractInjectTags);
    const extractedNames = new Set(Object.keys(extraction.extractedTags).map(tag => tag.toLowerCase()));

    // 必达清单 = 抽取标签 + 只进字段，去掉豁免标签。前两类都是任务要求产出的标签，
    // 区别只在「进不进正文」，不在「抽不抽」；豁免标签则连「必须出现」都不要求。
    const requiredTags = parseRequiredTags(spec?.extractTags, spec?.extractInjectTags, spec?.exemptTags);
    if (requiredTags.length > 0) {
      const missing = requiredTags.filter(tag => !extractedNames.has(tag));
      if (missing.length > 0) {
        return {
          ok: false,
          reason: `任务回复缺少必需标签：${missing.join('、')}（要求：${requiredTags.join('、')}）。`,
        };
      }
    }
    return { ok: true, extraction };
  } catch {
    return { ok: false, reason: '任务回复标签提取失败。' };
  }
}

export interface ExhaustedDescription {
  error: string;
  apiRetriesExhausted: boolean;
  validationRetriesExhausted: boolean;
}

/** 全废之后怎么向外报 —— 由**最后一次**尝试的失败类型决定，不是「出现过就算」 */
export function describeExhausted(lastAttemptApiFailed: boolean, lastErrorMessage: string): ExhaustedDescription {
  if (lastAttemptApiFailed) {
    return {
      error: 'API 调用失败且已耗尽重试次数。',
      apiRetriesExhausted: true,
      validationRetriesExhausted: false,
    };
  }
  return {
    error: `任务回复验收失败且已耗尽重试次数：${lastErrorMessage}`,
    apiRetriesExhausted: false,
    validationRetriesExhausted: true,
  };
}

export interface AttemptSpec extends TaskAcceptanceSpec {
  /** 最多试几次（含第一次），原版 `normalizePositiveInteger(task.maxRetries, 3)` */
  maxRetries: number;
  /** 两次之间的等待毫秒，原版 5000；测试里传 0 */
  delayMs?: number;
  /** 发一次请求。抛异常 = 接口失败；字符串或 {text,reasoning} 都认 */
  callApi: (attemptIndex: number) => Promise<string | PlotApiReply | null | undefined>;
  /** 每次尝试前后各调一次（原版的 `checkCurrent`），抛异常即中止整轮 */
  checkAbort?: () => void;
  /** 区分「用户点了中止」与「接口炸了」：返回 true 的异常原样抛出，不做重试 */
  isAbort?: (error: unknown) => boolean;
  /** 报错文案的加工，默认取 `error.message` */
  describeFailure?: (error: unknown) => string;
  /** 每次验收不过时回调（原版 `reportWarning`） */
  onRejected?: (attemptIndex: number, reason: string) => void;
  /** 等待函数，默认 `setTimeout`；测试里换成同步推进 */
  sleep?: (ms: number) => Promise<void>;
}

export interface AttemptOutcome {
  success: boolean;
  /** 成功时才保留；失败一律退回空串（原版返回 `rawResponse: ''`） */
  rawResponse: string;
  /**
   * 最后一次拿到手的原文，**不管过没过验收**。
   *
   * 原版失败时把原文丢了，于是日志里只剩一句「验收失败」，用户看不出 AI 到底回了什么 ——
   * 排查时只能去渠道站数调用次数（2026-11-04 用户就是这么查的）。
   * 这一格只给日志用，不参与正文拼接。
   */
  lastRawResponse: string;
  /**
   * 最后一次拿到手的标签抽取结果 —— **失败时也有值**。
   *
   * 用户 2026-11-09 的要求：AI 回传了部分标签也算数，先存进暂存区给人看，
   * 再退回输入框让用户重发。这里只负责「抽出来」，要不要进正文由聚合层按 success 过滤。
   */
  extraction: TaskTagExtraction | null;
  /** 最后一次拿到手的推理内容（酒馆支持 should_return_reasoning 时才有） */
  reasoning: string;
  lastErrorMessage: string;
  /** **最后一次**尝试是否属接口失败 */
  lastAttemptApiFailed: boolean;
  attempts: number;
}

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * 重试循环。每一步都与原版对齐：
 * - 每轮开头 `checkAbort`，调用后再次 `checkAbort`
 * - 接口失败不中断循环，只记文案并进入下一轮
 * - 验收通过立刻 `break`，后面的重试不再发生
 * - **最后一次不等待**（`attemptIndex < maxRetries - 1` 才 sleep）
 */
export async function runTaskAttempts(spec: AttemptSpec): Promise<AttemptOutcome> {
  const maxRetries = Number.isFinite(spec?.maxRetries) && (spec.maxRetries as number) > 0 ? Math.floor(spec.maxRetries as number) : 1;
  const delayMs = Number.isFinite(spec?.delayMs) ? Number(spec.delayMs) : DEFAULT_RETRY_DELAY_MS;
  const sleep = spec.sleep ?? defaultSleep;
  const describeFailure =
    spec.describeFailure ?? ((error: unknown) => (error instanceof Error ? error.message : String(error)));

  let rawResponse = '';
  let lastRawResponse = '';
  let lastErrorMessage = '';
  let extraction: TaskTagExtraction | null = null;
  let lastExtraction: TaskTagExtraction | null = null;
  let reasoning = '';
  let succeeded = false;
  let lastAttemptApiFailed = false;
  let attemptsRun = 0;

  for (let attemptIndex = 0; attemptIndex < maxRetries; attemptIndex++) {
    attemptsRun = attemptIndex + 1;
    spec.checkAbort?.();

    let apiFailed = false;
    let message: string | PlotApiReply | null | undefined = null;
    try {
      message = await spec.callApi(attemptIndex);
    } catch (error) {
      if (spec.isAbort?.(error)) throw error;
      apiFailed = true;
      lastErrorMessage = describeFailure(error);
    }

    spec.checkAbort?.();
    lastAttemptApiFailed = apiFailed;

    if (!apiFailed) {
      const reply = normalizeApiReply(message);
      // 用户 2026-11-09：AI 回传常把父子标签贴在同一行，按行解析会认不出层级。
      // 原始回传入手就补换行，抽取、差量、落盘、日志随后看到的都是层级正确的同一份文本。
      rawResponse = normalizeAdjacentTagNewlines(reply.text);
      reasoning = reply.reasoning;
      lastRawResponse = rawResponse;
      const verdict = checkTaskResponse(rawResponse, spec);
      if (verdict.ok) {
        extraction = verdict.extraction;
        succeeded = true;
        break;
      }
      // 没过验收也先把已回传的标签抽出来：暂存区要能显示「AI 回了什么」，
      // 用户据此判断是重发、改提示词还是手工补。
      lastExtraction = extractSafely(rawResponse, spec);
      lastErrorMessage = verdict.reason;
      spec.onRejected?.(attemptIndex, verdict.reason);
    }

    if (attemptIndex < maxRetries - 1) await sleep(delayMs);
  }

  return {
    success: succeeded,
    rawResponse: succeeded ? rawResponse : '',
    lastRawResponse,
    extraction: succeeded ? extraction : lastExtraction,
    reasoning,
    lastErrorMessage,
    lastAttemptApiFailed,
    attempts: attemptsRun,
  };
}
