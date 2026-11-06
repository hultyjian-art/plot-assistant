/**
 * 日志模块：一处写、三处看（Console、设置面板运行日志、气泡提示由调用方决定）。
 *
 * 每行形如 `[19:20:31.482] info | 校验 | 正文`：
 * 带毫秒是因为本脚本大量依赖定时器（删层后延迟发送、动画结束摘 class），
 * 出问题时秒级时间戳看不出先后。
 */
import { profile } from './profile';

/** 面板里最多留多少行，超出丢弃最早的。 */
const LINE_LIMIT = 60;

const lines: string[] = [];

/** 日志前缀取产物显示名：酒馆 Console 里能一眼分清是完整版还是「剧情推进助手·轻」。 */
function tag(): string {
  return profile().displayName;
}

function clock(): string {
  const now = new Date();
  const hms = now.toLocaleTimeString('en-GB', { hour12: false });
  return `${hms}.${String(now.getMilliseconds()).padStart(3, '0')}`;
}

function record(rank: 'info' | 'warn' | 'error', zone: string, text: string): string {
  const line = `[${clock()}] ${rank.padEnd(5)}| ${zone} | ${text}`;
  lines.push(line);
  if (lines.length > LINE_LIMIT) {
    lines.shift();
  }
  return line;
}

export function logInfo(zone: string, text: string): void {
  console.log(`${tag()} ${record('info', zone, text)}`);
}

export function logWarn(zone: string, text: string, ...extra: unknown[]): void {
  console.warn(`${tag()} ${record('warn', zone, text)}`, ...extra);
}

export function logError(zone: string, text: string, ...extra: unknown[]): void {
  console.error(`${tag()} ${record('error', zone, text)}`, ...extra);
}

/** 给设置面板展示用的副本，避免调用方改到内部数组。 */
export function readLogLines(): string[] {
  return [...lines];
}

export function dropLogLines(): void {
  lines.length = 0;
}
