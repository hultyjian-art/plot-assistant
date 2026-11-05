/**
 * plot/log-model.ts — 运行日志的纯数据层
 *
 * 用户的要求（m00190 第 4 条）：像工作流助手那样能看 AI 回传、能查报错。
 * 这里只管「日志这个对象长什么样、怎么加、怎么裁、怎么导出成 md」，不管写进哪。
 *
 * 三条设计约束：
 * - **环形 20 轮**：日志是给人看的，不是数据库。写满就丢最旧的，不留无限增长的历史。
 * - **每任务一条**：一条记录里带 prompt 预览、原始回传、抽到的标签、耗时、重试次数、错误。
 *   要能回答「这一条为什么没成」，光有最终 `<plot>` 是不够的。
 * - **导出成 md 能直接贴给我看**：所以 `toMarkdown` 是核心出口，不是可选功能。
 */
import type { PlotTaskResult } from './eng/assemble';

export const LOG_ROUND_MAX = 20;
/**
 * 提示词在日志里保留多少字符。
 *
 * 以前是 240 —— 一轮两三万字的提示词只剩开头几个字，等于没记。日志的唯一用处
 * 就是「这一轮到底发给了 AI 什么」，所以放到十万：完整提示词通常在几万以内，
 * 放得下；真超了还是会截，但不该是常态。
 */
export const PROMPT_PREVIEW_MAX = 100000;
export const RAW_KEEP_MAX = 4000;

export type LogTaskStatus = 'ok' | 'failed' | 'skipped';

/**
 * 一条真正发出去的消息（= 一个提示词块）。
 *
 * 用户 2026-11-04 要求日志「以提示词块为单位折叠，展示发给 AI 的内容」，
 * 所以这里不再只存一整段 `promptPreview` 文本，而是按块拆开存：
 * 面板上一块一个折叠条，标题用 `name`（预设里那块的名字），没有名字就退回角色。
 */
export interface LogPromptMessage {
  role: string;
  name: string;
  content: string;
}

/** 一个任务一次尝试的记录。重试会产生新的一条，`attempt` 递增。 */
export interface LogTaskEntry {
  taskId: string;
  taskName: string;
  stage: number;
  order: number;
  /** 第几次尝试，从 1 开始 */
  attempt: number;
  status: LogTaskStatus;
  /** prompt 预览（截断，长提示词只留开头，够定位是哪一段） */
  promptPreview: string;
  /** 按提示词块拆开的原文；老记录没有这一格，面板会退回解析 `promptPreview` */
  promptMessages?: LogPromptMessage[];
  /** 原始回传（截断到 RAW_KEEP_MAX，避免日志把聊天文件撑大） */
  rawResponse: string;
  /** 抽到的标签名 */
  tags: string[];
  /** 只进字段不进正文的标签名 */
  injectOnlyTags: string[];
  startedAt: number;
  durationMs: number;
  /** 出错时的原文（含抛错与验收不过两种） */
  error: string | null;
}

export type LogRoundStatus = 'running' | 'ok' | 'partial' | 'failed';

/** 一轮剧情推进。 */
export interface LogRound {
  /** 按用户楼层数算的第几轮 */
  roundIndex: number;
  /** 锚定的用户楼层号 */
  floorId: number;
  presetName: string;
  startedAt: number;
  endedAt: number | null;
  status: LogRoundStatus;
  tasks: LogTaskEntry[];
  /** 本轮整体失败的原因（比如第一阶段就 fail-stop） */
  error: string | null;
}

export interface PlotRunLog {
  version: 1;
  rounds: LogRound[];
}

// ───────────────────────── 构建与追加 ─────────────────────────

export function createLog(): PlotRunLog {
  return { version: 1, rounds: [] };
}

/** 开一轮。楼层号重复时**替换**旧的那轮（同一层重刷会重开，不该留两条同层记录）。 */
export function startRound(
  log: PlotRunLog,
  init: { roundIndex: number; floorId: number; presetName: string; startedAt: number },
): { log: PlotRunLog; round: LogRound } {
  const round: LogRound = {
    roundIndex: init.roundIndex,
    floorId: init.floorId,
    presetName: init.presetName,
    startedAt: init.startedAt,
    endedAt: null,
    status: 'running',
    tasks: [],
    error: null,
  };
  const kept = log.rounds.filter(r => r.floorId !== init.floorId);
  return { log: { ...log, rounds: trimRounds([...kept, round]) }, round };
}

/**
 * 记一个任务的尝试。
 *
 * 同一 `taskId` + 同一 `attempt` 已存在时就替换（引擎可能因为重连而重复回调），
 * 不同 `attempt` 就追加 —— 重试历史必须留着，那正是「为什么慢 / 为什么最后成了」的证据。
 */
export function putTaskEntry(log: PlotRunLog, floorId: number, entry: LogTaskEntry): PlotRunLog {
  const rounds = log.rounds.map(round => {
    if (round.floorId !== floorId) return round;
    const rest = round.tasks.filter(t => !(t.taskId === entry.taskId && t.attempt === entry.attempt));
    return { ...round, tasks: [...rest, entry] };
  });
  return { ...log, rounds };
}

/** 从引擎的一次任务结果直接生成一条记录 —— 省得调用方自己拼。 */
export function entryFromResult(
  result: PlotTaskResult,
  meta: {
    taskName: string;
    stage: number;
    order: number;
    attempt: number;
    promptPreview: string;
    promptMessages?: ReadonlyArray<{ role: string; name?: string; content: string }>;
    startedAt: number;
    now: number;
    error?: string | null;
  },
): LogTaskEntry {
  const entry: LogTaskEntry = {
    taskId: result.taskId || '（未命名任务）',
    taskName: meta.taskName,
    stage: meta.stage,
    order: meta.order,
    attempt: meta.attempt,
    status: result.success === true ? 'ok' : 'failed',
    promptPreview: clip(meta.promptPreview, PROMPT_PREVIEW_MAX),
    // 失败时 `rawResponse` 是空串（原版口径：没过验收的正文不进正文），但日志必须留下原文 ——
    // 否则用户只看到「验收失败」，不知道 AI 到底回了什么。
    rawResponse: clip(result.rawResponse || result.lastRawResponse || '', RAW_KEEP_MAX),
    tags: Object.keys(result.extractedTags || {}),
    injectOnlyTags: [...(result.injectOnlyTagNames || [])],
    startedAt: meta.startedAt,
    durationMs: Math.max(0, meta.now - meta.startedAt),
    error: meta.error ?? null,
  };

  const messages = Array.isArray(meta.promptMessages) ? meta.promptMessages : [];
  if (messages.length > 0) {
    entry.promptMessages = messages.map(message => ({
      role: String(message.role ?? ''),
      name: typeof message.name === 'string' ? message.name : '',
      content: clip(message.content ?? '', PROMPT_PREVIEW_MAX),
    }));
  }

  return entry;
}

/**
 * 收一轮。
 *
 * 状态由任务记录推导，不靠调用方报告 —— 少一个可以写错的地方：
 * 有一条 failed 就是 `failed`（引擎是 fail-stop 语义），全 ok 才是 `ok`。
 */
export function finishRound(log: PlotRunLog, floorId: number, endedAt: number, error: string | null = null): PlotRunLog {
  const rounds = log.rounds.map(round => {
    if (round.floorId !== floorId) return round;
    const failed = round.tasks.some(t => t.status === 'failed');
    const status: LogRoundStatus = error || failed ? 'failed' : round.tasks.length ? 'ok' : 'failed';
    return { ...round, endedAt, status, error };
  });
  return { ...log, rounds };
}

/** 只留最近 `LOG_ROUND_MAX` 轮。按 `startedAt` 排，同时间按楼层号。 */
export function trimRounds(rounds: LogRound[]): LogRound[] {
  if (rounds.length <= LOG_ROUND_MAX) return [...rounds];
  return [...rounds]
    .sort((a, b) => a.startedAt - b.startedAt || a.floorId - b.floorId)
    .slice(-LOG_ROUND_MAX);
}

// ───────────────────────── 查询 ─────────────────────────

export function getRound(log: PlotRunLog, floorId: number): LogRound | null {
  return log.rounds.find(r => r.floorId === floorId) || null;
}

/** 某一轮里某个任务的全部尝试，按 attempt 升序。 */
export function taskAttempts(log: PlotRunLog, floorId: number, taskId: string): LogTaskEntry[] {
  const round = getRound(log, floorId);
  if (!round) return [];
  return round.tasks.filter(t => t.taskId === taskId).sort((a, b) => a.attempt - b.attempt);
}

/** 本轮第一次尝试就失败的任务 id —— 「该重试但没重试」与「重试了还是不行」靠它分。 */
export function firstTryFailures(log: PlotRunLog, floorId: number): string[] {
  const round = getRound(log, floorId);
  if (!round) return [];
  return [...new Set(round.tasks.filter(t => t.attempt === 1 && t.status === 'failed').map(t => t.taskId))];
}

// ───────────────────────── 导出 ─────────────────────────

/** 导成 md。给人看的，所以「失败原因」永远排在「回传内容」前面。 */
export function toMarkdown(log: PlotRunLog): string {
  const lines: string[] = ['# 剧情推进运行日志', ''];
  if (!log.rounds.length) {
    lines.push('（还没有记录）');
    return lines.join('\n');
  }

  for (const round of [...log.rounds].sort((a, b) => b.floorId - a.floorId)) {
    const badge = round.status === 'ok' ? '✅' : round.status === 'running' ? '⏳' : '❌';
    lines.push(`## ${badge} 第 ${round.roundIndex} 轮（楼层 ${round.floorId}）`);
    lines.push('');
    lines.push(`- 预设：${round.presetName || '（未记录）'}`);
    lines.push(`- 开始：${stamp(round.startedAt)}　结束：${round.endedAt ? stamp(round.endedAt) : '未结束'}`);
    lines.push(`- 任务数：${round.tasks.length}`);
    if (round.error) lines.push(`- 本轮失败：${round.error}`);
    lines.push('');

    if (!round.tasks.length) {
      lines.push('（本轮没有任何任务记录）');
      lines.push('');
      continue;
    }

    for (const task of [...round.tasks].sort((a, b) => a.stage - b.stage || a.order - b.order || a.attempt - b.attempt)) {
      const mark = task.status === 'ok' ? '✅' : task.status === 'skipped' ? '⏭️' : '❌';
      lines.push(`### ${mark} ${task.taskName || task.taskId}（stage ${task.stage} · 第 ${task.attempt} 次 · ${task.durationMs} ms）`);
      lines.push('');
      if (task.error) lines.push(`**失败原因**：${task.error}`, '');
      if (task.tags.length) lines.push(`- 标签：${task.tags.join('、')}`);
      if (task.injectOnlyTags.length) lines.push(`- 只进字段：${task.injectOnlyTags.join('、')}`);
      if (task.promptMessages && task.promptMessages.length > 0) {
        lines.push('', '**发送给 AI 的内容**', '');
        task.promptMessages.forEach((message, index) => {
          const title = message.name ? `${message.name} · ${message.role}` : message.role;
          lines.push(
            `<details><summary>${index + 1}. ${title}</summary>`,
            '',
            '```',
            message.content,
            '```',
            '',
            '</details>',
            '',
          );
        });
      } else if (task.promptPreview) {
        lines.push('', '<details><summary>提示词预览</summary>', '', '```', task.promptPreview, '```', '', '</details>');
      }
      lines.push('', '<details><summary>原始回传</summary>', '', '```', task.rawResponse || '（空）', '```', '', '</details>', '');
    }
  }

  return lines.join('\n');
}

// ───────────────────────── 小工具 ─────────────────────────

function clip(text: string, max: number): string {
  const value = String(text ?? '');
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…（已截断，原长 ${value.length}）`;
}

function stamp(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
