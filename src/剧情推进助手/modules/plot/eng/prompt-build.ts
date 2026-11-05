/**
 * 剧情推进 — 提示词里的占位符替换（`$1 $5 $6 $7 $8 $9 $U $C` + `sulv1..4` + `zhaohui`）
 *
 * 这一层是「按占位符取数」的最后一步：上面各层把内容取好，这里负责把它们准确塞进提示词。
 * 纯字符串变换，不取数、不发请求。
 *
 * 三条容易改错、改错了又不报错的规则（都写了用例）：
 *  1. `$1` / `$9` 不是直接替换 —— 它们被包进 `<worldbook_context>` 信封，**内容为空时整个信封消失**。
 *  2. `$1` / `$9` 的正则带负向后行断言 `(?<!\\)`，所以写成 `\$1` 的**转义写法原样保留**，方便你不想替换时打转义。
 *  3. 其余键用**函数式替换**（`() => 值`），否则值里出现 `$&`、`$'` 这类字样会被 JS 当成替换模式串，静默吐出乱七八糟的东西。
 */

/** 允许被包进 `<worldbook_context>` 信封的键。其余键直接平铺。 */
const ENVELOPE_KEYS = ['$1', '$9'];

/** 走信封的两个键之外，其余按这个顺序替换（顺序会影响互相包含时的结果）。 */
export const REPLACEMENT_KEYS = [
  'sulv1',
  'sulv2',
  'sulv3',
  'sulv4',
  'zhaohui',
  '$5',
  '$6',
  '$7',
  '$8',
  '$U',
  '$C',
] as const;

/** 把字符串里的正则元字符转义，供 `new RegExp` 使用。 */
export function escapeRegExp(text: string): string {
  return String(text ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 去 HTML：br 变换行，其余标签删掉，实体反转义，最后 trim。 */
export function sanitizeHtml(htmlString: string | null | undefined): string {
  if (!htmlString) return '';
  return String(htmlString)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?[^>]+(>|$)/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();
}

/** 把世界书内容包成信封；内容为空（或过滤后为空）时返回空串，信封不留残渣。 */
export function wrapWorldbookContext(
  content: unknown,
  filter: (value: unknown, key: string) => string = defaultFilter,
  key = '$1',
): string {
  const filteredContent = filter(content, key);
  return filteredContent ? `\n<worldbook_context>\n${filteredContent}\n</worldbook_context>\n` : '';
}

/** 默认过滤：只做「空值变空串、其余转字符串」，不裁剪内容。 */
export function defaultFilter(value: unknown): string {
  return value === undefined || value === null ? '' : String(value);
}

export interface PerformOptions {
  /** 各占位符对应的值。`$9` 也放这里，但它在替换时走信封，不进平铺循环。 */
  replacements: Record<string, unknown>;
  /** 共享的世界书内容（任务级可用 `taskOverrides.$1` 覆盖）。 */
  worldbookContent?: unknown;
  /** 内容过滤器。默认只做空值归一，可注入「排除规则」实现。 */
  filter?: (value: unknown, key: string) => string;
  /** 任务级覆盖：某个键只对本次任务换值。 */
  taskOverrides?: Record<string, unknown>;
}

/**
 * 执行占位符替换。
 *
 * 顺序很重要，照原样：先 `$1`，再 `$9`（这两个走信封），然后 `REPLACEMENT_KEYS` 逐个平铺。
 * 平铺的顺序决定「值里恰好含另一个占位符」时谁先被吃 —— 不要重排。
 */
export function performReplacements(text: string | null | undefined, options: PerformOptions): string {
  if (!text) return '';

  const { replacements, taskOverrides = {} } = options;
  const filter = options.filter ?? defaultFilter;
  let processed = text;

  // ── $1：任务级覆盖优先，否则用共享值 ──
  const effectiveWorldbookContent =
    taskOverrides.$1 !== undefined ? String(taskOverrides.$1) : options.worldbookContent;
  processed = processed.replace(
    /(?<!\\)\$1/g,
    wrapWorldbookContext(effectiveWorldbookContent, filter, '$1'),
  );

  // ── $9：任务级覆盖优先，否则用 values 里那份 ──
  const effectiveDatabaseContent =
    taskOverrides.$9 !== undefined ? String(taskOverrides.$9) : String(replacements.$9 || '');
  processed = processed.replace(
    /(?<!\\)\$9/g,
    wrapWorldbookContext(effectiveDatabaseContent, filter, '$9'),
  );

  // ── 其余键平铺 ──
  // 遍历的是 `replacements` 自己的键（不是上面那个常量），与原件一致：
  // 只在 taskOverrides 里出现、replacements 里没有的键**不会**被替换。
  for (const key in replacements) {
    if (key === '$9') continue;

    const value = taskOverrides[key] !== undefined ? taskOverrides[key] : replacements[key];
    const regex = new RegExp(escapeRegExp(key), 'g');
    const filteredValue = filter(value, key);
    // 函数式替换：避免值里的 $& / $1 / $` 被当成替换模式串
    processed = processed.replace(regex, () => filteredValue);
  }

  return processed;
}

/** 判断某个键是不是走信封的那两个。UI 上给提示用。 */
export function isEnvelopeKey(key: string): boolean {
  return ENVELOPE_KEYS.includes(key);
}
