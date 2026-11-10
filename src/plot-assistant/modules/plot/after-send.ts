/**
 * 发送之后的收尾：等用户楼层真的出现 → 回读自检 → 补写 qrf 四字段。
 *
 * 为什么要等：`issueSend()` 只是「点了发送按钮」，楼层是酒馆随后自己建的。
 * 点击之后立刻 `getChatMessages(floorId)` 大概率还是空的（或者还是被删掉的旧楼层）。
 *
 * 为什么要回读自检：这一轮注入的 `<plot>` 只能出现一次。出现两次说明用户自己还开着
 * 上游的剧情推进（两份都在往里塞），那不是崩，是配置冲突 —— 得让人知道，不然下一轮
 * `$6` 会读到两段互相打架的剧情。
 *
 * 这里**不抛异常**：消息已经发出去了，收尾失败只能记一笔。让用户看见「发出去了但 qrf 没写上」
 * 比让他以为整轮白跑要好。
 */

import { writePlotExtraToFloor } from './data/chat-write';
import { markAnchorsOnFloor } from './floor-anchor';
import type { PlotCommit } from './run-in-flow';

export interface PlotSendCheckResult {
  /** 楼层在超时之前出现了没有 */
  landed: boolean;
  /** 正文里 `<plot` 出现了几次（正常应为 1） */
  plotCount: number;
  /** qrf 四字段是否写成功 */
  written: boolean;
  /** 给日志/提示的一句话 */
  note: string;
}

const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_POLL_MS = 250;

interface FloorLike {
  message_id: number;
  role: string;
  message: string;
  /** 读来合锚点用：setChatMessages 的 extra 是整份替换，别的脚本塞的键不能丢。 */
  extra?: Record<string, unknown>;
}

/** 数 `<plot` 出现几次。不用 DOM、不用 JSON，纯文本数一遍就够。 */
export function countPlotBlocks(text: string): number {
  if (typeof text !== 'string' || !text) return 0;
  const matches = text.match(/<plot\b/gi);
  return matches ? matches.length : 0;
}

export interface PlotSendOptions {
  timeoutMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * 成果存在哪（与 `plot.stashMode` 同义）。
   *
   * - `'qrf'`：写楼层 `qrf_plot*` 四字段，与数据库脚本那套兼容。
   * - `'upgrade'`（默认）：成果已经在聊天变量的暂存账本里了，楼层一个字都不写。
   *   两边都写就会各说各话 —— 用户改了一边，另一边不跟着动。
   */
  mode?: 'upgrade' | 'qrf';
  /**
   * 这一轮真正写进输入框、发出去的文本。
   * 等楼层时拿它认领「是不是刚发出的那一条」：导入聊天 / 删层重刷之后，同一个楼层号上
   * 可能还留着上一版或别的输入，光看楼层号就把锚点写上去会记到别人的楼层。
   * 不传时退回 `commit.finalMessage`（两条发送路径都是 join:'final'，它就是发出去的文本）。
   */
  expectedText?: string;
}

/**
 * 跑收尾。
 *
 * @param commit 发送前攒好的那一份（楼层号 / qrf 内容 / 回传）
 */
export async function completePlotSend(
  commit: PlotCommit,
  options: PlotSendOptions = {},
): Promise<PlotSendCheckResult> {
  const timeoutMs = typeof options.timeoutMs === 'number' && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const pollMs = typeof options.pollMs === 'number' && options.pollMs > 0 ? options.pollMs : DEFAULT_POLL_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  // 认领刚发出的那一条要三样都对上：楼层号、role、正文。
  // 只等「这一层出现」不够 —— 导入/删层之后同一个楼层号上可能还是上一版或别的输入，
  // 直接写锚点就记到别人的楼层了。对不上就继续等，直到超时，全程不碰写回。
  const expectedText = typeof options.expectedText === 'string' ? options.expectedText : commit.finalMessage;
  const deadline = Date.now() + timeoutMs;
  let floor: FloorLike | null = null;
  let mismatchNote = '';

  for (;;) {
    const candidate = readFloor(commit.floorId);
    if (candidate) {
      if (isThisSend(candidate, commit.floorId, expectedText)) {
        floor = candidate;
        break;
      }
      mismatchNote = describeMismatch(candidate, commit.floorId, expectedText);
    }
    if (Date.now() > deadline) break;
    await sleep(pollMs);
  }

  if (!floor) {
    return {
      landed: false,
      plotCount: 0,
      written: false,
      note: mismatchNote
        ? `第 ${commit.floorId} 层不是本次发出的那条（${mismatchNote}），等到超时也没对上，跳过写回`
        : `发送后 ${Math.round(timeoutMs / 1000)} 秒内没等到第 ${commit.floorId} 层`,
    };
  }

  const plotCount = countPlotBlocks(floor.message);

  // 锚点是「这条楼层跑过哪些任务」的触发账本，不是 qrf 的成果写回 ——
  // 升级模式也要写，否则「每 N 条用户楼层」的任务永远判成第一次跑。
  // 写失败只记一笔：消息已经发出去了，不能让补写失败显示成整轮失败。
  if ((commit.anchorNames?.length ?? 0) > 0) {
    try {
      await markAnchorsOnFloor(
        { message_id: floor.message_id, message: floor.message, extra: floor.extra },
        commit.anchorNames,
        row => setChatMessages([row], { refresh: 'affected' }),
      );
    } catch (error) {
      console.warn('[剧情推进助手] 补写楼层锚点失败', error);
    }
  }

  // 升级模式：成果在账本里，楼层不写 qrf。正文里出现多个 <plot> 仍然要提醒 ——
  // 那是"上游 ACU 的剧情推进也开着"，与本模式无关，但会让下一轮读到两份剧情。
  if (options.mode !== 'qrf') {
    return {
      landed: true,
      plotCount,
      written: false,
      note:
        plotCount > 1
          ? `升级模式：楼层不写 qrf；正文里有 ${plotCount} 个 <plot> —— 上游 ACU 的「剧情推进」是不是也开着？`
          : '升级模式：成果记在暂存账本里，楼层不写 qrf',
    };
  }

  try {
    await writePlotExtraToFloor({
      messageId: commit.floorId,
      saveContent: commit.saveContent,
      presetName: commit.presetName,
      roundId: commit.roundId,
      taskResults: commit.taskResults,
    });
  } catch (error) {
    console.error('[剧情推进助手] 写 qrf 失败', error);
    return {
      landed: true,
      plotCount,
      written: false,
      note: `写回失败：${(error as Error)?.message ?? String(error)}`,
    };
  }

  if (plotCount === 0) {
    // 写成功了但正文里没有 plot：发送时那段可能被别的脚本吃掉了。
    // 仍然算写成功（qrf 在），只是要提示。
    return { landed: true, plotCount, written: true, note: 'qrf 已写，但正文里没找到 <plot>（可能被别的脚本截走了）' };
  }
  if (plotCount > 1) {
    return {
      landed: true,
      plotCount,
      written: true,
      note: `正文里有 ${plotCount} 个 <plot> —— 上游 ACU 的「剧情推进」是不是也开着？关掉一个，否则下一轮会读到两份剧情`,
    };
  }
  return { landed: true, plotCount, written: true, note: 'qrf 已写' };
}

function readFloor(messageId: number): FloorLike | null {
  const floors = getChatMessages(messageId) as unknown as FloorLike[];
  const first = Array.isArray(floors) ? floors[0] : undefined;
  if (!first || typeof first.message !== 'string') return null;
  return first;
}

/**
 * 楼层号、role、正文三样都对上，才认作「刚发出的那一条」。
 * message_id 也要核对：`readFloor` 按号取层，取回来的那条理论上就是它，
 * 但导入/删层后的边界情况宁可再核一次，别把锚点写到别人身上。
 */
function isThisSend(floor: FloorLike, floorId: number, expectedText: string): boolean {
  return floor.message_id === floorId
    && floor.role === 'user'
    && floor.message === expectedText;
}

/** 给日志一句话说明差在哪，方便真机排查「为什么等不到」。 */
function describeMismatch(floor: FloorLike, floorId: number, expectedText: string): string {
  if (floor.message_id !== floorId) return `读到的 message_id=${floor.message_id}，预期 ${floorId}`;
  if (floor.role !== 'user') return `role=${floor.role}，预期 user`;
  if (floor.message !== expectedText) return '正文与发出去的文本不一致';
  return '身份未确认';
}
