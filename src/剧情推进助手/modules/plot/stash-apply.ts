/**
 * 第 6 期：把某一版成果「用起来」的两个纯函数 —— 换到楼层里、塞回输入框。
 *
 * 为什么单独抽一个文件：这两件事都要动 `<plot>` 的位置，而「哪一段是 `<plot>`」这件事
 * 已经在 `stash-edit.ts` 里定过口径（只认 `<plot ...>` 开标签 + 最后一个 `</plot>`，
 * 不吃 DOM 解析那一套）。这里复用它，别再写第二种找法 —— 两种找法一旦漂移，
 * 面板上删标签和「应用到楼层」就会对不上。
 */
import { splitPlotMessage } from './stash-edit';
import type { StashLanding } from './stash-model';

/** `<plot …>` 到最后一个 `</plot>` 的原始片段与起止位置；没有就 null。 */
export function plotSpan(text: string): { start: number; end: number } | null {
  if (typeof text !== 'string' || text.length === 0) return null;
  const open = /<plot(\s[^>]*)?>/i.exec(text);
  if (!open) return null;
  const closeAt = text.toLowerCase().lastIndexOf('</plot>');
  if (closeAt < 0 || closeAt < open.index) return null;
  return { start: open.index, end: closeAt + '</plot>'.length };
}

/** 版本全文里的那一段 `<plot>…</plot>`；版本里没有 `<plot>` 时返回 null。 */
export function plotSegmentOf(finalText: string): string | null {
  const span = plotSpan(finalText);
  if (!span) return null;
  return finalText.slice(span.start, span.end);
}

/**
 * 「应用到楼层」：保留楼层里用户自己写的那段话与指令头，只换掉 `<plot>` 那一段。
 *
 * 为什么不是整段替换成版本全文：楼层正文是「用户原话 + 空行 + 指令头 + <plot>」，
 * 版本全文里没有用户原话。整段替换会把用户说的话抹掉 —— 那正是第 4 期坚决没走的路。
 * 楼层里要是本来没有 `<plot>`（旧楼层 / 手工改过），就把这一版追加到末尾。
 *
 * 版本里没有 `<plot>` 段时，如果楼层本来有，就**一个字都不动**并把它当作失败：
 * 把没有 `<plot>` 的正文写进楼层，下一轮 `$6`（上一轮剧情）就读不到这一轮了，
 * 这比「没换成」更糟 —— 静默毁掉一段还能用的记录。
 */
export function applyLandingToFloor(floorText: string, finalText: string): string {
  const base = typeof floorText === 'string' ? floorText : '';
  const segment = plotSegmentOf(finalText);
  if (!segment) {
    if (plotSpan(base)) return base;
    const plain = typeof finalText === 'string' ? finalText : '';
    if (plain.trim().length === 0) return base;
    const head = base.replace(/\s+$/, '');
    return head.length > 0 ? `${head}\n\n${plain}` : plain;
  }
  const span = plotSpan(base);
  if (span) return `${base.slice(0, span.start)}${segment}${base.slice(span.end)}`;
  const head = base.replace(/\s+$/, '');
  return head.length > 0 ? `${head}\n\n${segment}` : segment;
}

/**
 * 「重跑正文」：把这一版整套塞进输入框（用户原话 + 这一版全文），让用户自己按发送。
 *
 * 为什么不直接调接口重生成：重生成要经过酒馆自己的发送链（上下文、世界书、预设），
 * 从脚本里绕过去就等于另走一条路；而且用户得有机会先看一眼、改两个字再发。
 */
export function inputTextWithLanding(userText: string, finalText: string): string {
  const head = typeof userText === 'string' ? userText.replace(/\s+$/, '') : '';
  const body = typeof finalText === 'string' ? finalText.replace(/^\s+/, '') : '';
  if (body.length === 0) return head;
  return head.length > 0 ? `${head}\n\n${body}` : body;
}

/** 一版成果里每个任务的原始回传，按 key 顺序排好给面板展示。 */
export function landingTaskRows(landing: StashLanding | null): { taskId: string; raw: string }[] {
  if (!landing || !landing.taskRaw) return [];
  return Object.keys(landing.taskRaw)
    .filter((key) => key.length > 0)
    .sort()
    .map((taskId) => ({ taskId, raw: String(landing.taskRaw[taskId] ?? '') }));
}

/** 面板上一行预览：压掉换行、限长。 */
export function rawPreview(text: string, max = 120): string {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max)}…`;
}

/** 这一版里到底有没有 `<plot>`（没有就说明它是个残缺版本，别往楼层里写）。 */
export function hasPlotBlock(text: string): boolean {
  return splitPlotMessage(text).hasPlot;
}

/**
 * 这一版是不是**正写在楼层正文里** —— 也就是面板上要标「使用中」的那一条。
 *
 * 判据用楼层正文，不用账本里的 `activeLandingId`：用户 2026-11-03 的定义是
 * 「作为对应楼层的正式文本、会给酒馆 AI 读到的那一条」。账本记的只是我们以为的，
 * 楼层里真正躺着什么才是事实（他可能在酒馆里手动改过、也可能另一版被写进去过）。
 *
 * 比对用 `<plot>` 那一段：`applyLandingToFloor` 写进去的就是这一段原文。
 * 空白差异（缩进、行尾空格）用折叠空白兜一次，免得因为一个空格标不出来。
 */
export function landingInFloor(floorText: string | null | undefined, finalText: string): boolean {
  const base = typeof floorText === 'string' ? floorText : '';
  if (base.trim().length === 0) return false;
  const segment = plotSegmentOf(finalText);
  if (!segment) return false;
  if (base.includes(segment)) return true;
  return squashSpace(base).includes(squashSpace(segment));
}

function squashSpace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
