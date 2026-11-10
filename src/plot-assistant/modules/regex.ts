/**
 * 捕获模块：
 * - 内置的默认捕获预设
 * - 解析酒馆风格的正则字面量 `/表达式/标志`
 * - 正则编译与合法性校验
 * - 按预设顺序级联尝试，返回首个捕到内容的结果
 */
import { logInfo, logWarn } from './logger';
import { MSG, TAG } from './copy';
import type { RegexPreset } from './types';

/**
 * 解析酒馆正则风格（与 SillyTavern 正则扩展一致）的字面量：
 * - `/表达式/标志` 形式：取首尾斜杠之间的内容为表达式，末尾斜杠之后为标志；
 * - 不以 `/` 开头时宽容处理，整串视为表达式（无标志）。
 * 标志本身非法（如未知字母）时由 new RegExp 抛错，交由调用方处理。
 */
export function parseRegexLiteral(literal: string): { pattern: string; flags: string } {
  const trimmed = literal.trim();
  if (trimmed.startsWith('/')) {
    // 从后往前找最后一个未被反斜杠转义的 '/'，兼容表达式中含 '/' 的写法
    for (let i = trimmed.length - 1; i > 0; i--) {
      if (trimmed[i] !== '/') continue;
      let backslashes = 0;
      for (let j = i - 1; j >= 0 && trimmed[j] === '\\'; j--) backslashes++;
      if (backslashes % 2 === 0) {
        return { pattern: trimmed.slice(1, i), flags: trimmed.slice(i + 1) };
      }
    }
  }
  return { pattern: trimmed, flags: '' };
}

export function compileRegex(literal: string): RegExp {
  const { pattern, flags } = parseRegexLiteral(literal);
  return new RegExp(pattern, flags);
}

export function isValidRegex(literal: string): boolean {
  try {
    compileRegex(literal);
    return true;
  } catch {
    return false;
  }
}

/**
 * 用正则从文本中提取内容：
 * - 有捕获组时取第一个捕获组；
 * - 无捕获组时取整个匹配；
 * - 匹配失败或正则非法时返回 null。
 */
export function captureByRegex(text: string, preset: RegexPreset): string | null {
  try {
    const regex = compileRegex(preset.regex);
    const match = regex.exec(text);
    if (!match) return null;
    // 捕获组未参与匹配时 match[1] 是 undefined（RegExpExecArray 的声明却写成 string）。
    // 按「无匹配、继续下一条预设」口径返回 null：否则调用方会对 undefined 调 .trim()
    // 抛 TypeError，而那处异常跑在解锁之外，会把按钮手势永久锁死。
    const captured: string | undefined = match.length > 1 ? match[1] : match[0];
    return captured ?? null;
  } catch {
    return null;
  }
}

/** 级联捕获的成功结果：命中的预设与捕获到的文本。 */
export interface CaptureResult {
  preset: RegexPreset;
  /** 命中预设的序号，从 1 开始，便于日志说明优先级 */
  order: number;
  text: string;
}

/**
 * 按数组顺序对文本做级联捕获，返回第一个成功的预设；全部失败返回 null。
 * 以下三种情况都算失败并继续尝试下一项：正则非法、无匹配、匹配结果为空白。
 */
export function captureWithPresets(text: string, presets: RegexPreset[]): CaptureResult | null {
  for (const [index, preset] of presets.entries()) {
    const order = index + 1;
    if (!isValidRegex(preset.regex)) {
      logWarn(TAG.grab, MSG.presetInvalid(order, preset.name, preset.regex));
      continue;
    }
    const captured = captureByRegex(text, preset);
    if (captured === null) {
      logInfo(TAG.grab, MSG.presetNoMatch(order, preset.name));
      continue;
    }
    if (captured.trim() === '') {
      logInfo(TAG.grab, MSG.presetBlankHit(order, preset.name));
      continue;
    }
    return { preset, order, text: captured };
  }
  return null;
}

/**
 * 内置预设，数组顺序即默认优先级：先具体、后兜底。
 * 两条都不带任何标志：跨行靠字符类 `[\s\S]` 本身，而不是靠 `s` 标志——
 * 标志写在字面量最末尾，手改表达式时很容易被连带删掉，删掉后跨行的块会静默抓不到。
 */
export const FALLBACK_PRESETS: RegexPreset[] = [
  {
    id: 'progress',
    name: '剧情推进',
    regex: '/<user_input>([\\s\\S]*?)<\\/user_input>/',
    note: '配合“剧情推进”格式使用，只取 <user_input> 标签里的内容；跨行由 [\\s\\S] 负责，不需要 s 标志',
  },
  {
    id: 'all',
    name: '全部文本',
    regex: '/[\\s\\S]*/',
    note: '原样取回本轮取文那一层的全部文字（含换行）。因为它永远会命中，一般拖到级联链最后当兜底',
  },
];
