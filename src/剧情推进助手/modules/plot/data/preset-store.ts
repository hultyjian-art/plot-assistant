/**
 * 剧情推进 — 本地预设库（纯逻辑，不碰酒馆、不碰 DOM）。
 *
 * 为什么需要这一层：原来我们**每次运行都去数据库脚本里实时读预设**，自己一份都不存。
 * 后果有两个，都很难受：
 *   ① 数据库脚本没加载 / 被关掉 / 改过键名，这里就整个跑不起来；
 *   ② 用户在数据库里改一下预设，我们这边的行为**静默地跟着变**，没法「冻住一份稳定的」。
 *
 * 所以加了「导入」：把数据库里的预设**整份快照**存进我们自己的设置，之后运行只认这一份。
 * 快照存的是原始形状而不是转换后的配置 —— 转换逻辑（`importPresetConfig`）以后还能改，
 * 存下来的数据不用跟着迁移。
 *
 * 设计边界：
 * - **永不抛**。预设是用户从别处弄来的，字段缺失、类型写歪都要能存下来，脏值留给运行层当没写。
 * - **不改入参**。合并时一律深拷，调用方交进来的数组出去还是原样。
 * - **按名字对齐**。数据库脚本也是按 `name` 找预设的，这里保持一致，不做 id。
 * - **体积有上限**。预设动辄几十 KB，无限导入会把酒馆的脚本变量撑爆，
 *   所以单份超过 `MAX_STORED_PRESET_CHARS` 就拒收，并把原因说清楚。
 */

/** 一份被导入到本地的预设快照。 */
export interface StoredPlotPreset {
  /** 预设名。运行时就靠它对齐 —— 与数据库脚本一致，按名字而非 id。 */
  name: string;
  /**
   * 整份预设的原始对象（数据库脚本那边是什么形状，这里就是什么形状）。
   *
   * 刻意**不在这里做转换**：转换规则以后还会改（上游加了新字段、我们改了回退链），
   * 存原始数据的话，改转换逻辑不需要迁移用户已经导入的预设。
   */
  data: Record<string, unknown>;
  /** 从哪来的。界面上要区分「从数据库导的」和「粘进来的」。 */
  source: StoredPresetSource;
  /** 导入时间（毫秒）。只用于展示，不参与运行。 */
  importedAt: number;
}

/** 从哪来的。`local` = 面板里新建或另存为出来的，没经过任何导入。 */
export type StoredPresetSource = 'acu' | 'paste' | 'local';

/**
 * 单份预设的体积上限（按 JSON 字符数算）。
 *
 * 实测数据库里那份「时间召回」约 29000 字符、「实验预设」约 11600 字符，
 * 也就是真实世界大概在 1 万到 5 万量级。给到 50 万（约 500KB）已经非常宽松 ——
 * 再大就不像手配的预设了，多半是选错了文件。
 */
export const MAX_STORED_PRESET_CHARS = 500_000;

/** 一个预设该显示成什么名字；取不到就是空串。 */
export function storedPresetName(preset: unknown): string {
  if (!preset || typeof preset !== 'object') return '';
  const name = (preset as Record<string, unknown>).name;
  return typeof name === 'string' ? name.trim() : '';
}

/** 量一份预设有多大（JSON 字符数）。序列化不了就当无穷大 —— 宁可控死也不放进存储。 */
export function measurePresetSize(preset: unknown): number {
  try {
    const text = JSON.stringify(preset);
    return typeof text === 'string' ? text.length : Number.POSITIVE_INFINITY;
  } catch {
    // 循环引用之类。这种东西存进酒馆变量会在写盘那一刻炸，不如现在就拦住。
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * 本地预设条目自己那一层包装上才会有的键。
 * 判据收得很紧（正好四个键、`source` 只有两个取值、`importedAt` 是数字），
 * 因为数据库脚本那边一份真预设是二十多个键，不会撞上。
 */
const WRAPPER_KEYS = ['data', 'importedAt', 'name', 'source'] as const;

/**
 * 这个对象是不是「本地预设条目」那一层包装，而不是预设本体？
 *
 * 用来兜住 2026-11-01 那个双层包装的坑：`mergeStoredPresets` 收的是**原始预设**、
 * 内部会自己包一层，而当时调用方已经先调过 `makeStoredPreset` 包好了，
 * 于是落盘的是 `{name, data:{name, data:(真正的预设), …}, …}` —— 任务表和提示词全被埋进第二层。
 */
export function isStoredPresetWrapper(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (Object.keys(item).length !== WRAPPER_KEYS.length) return false;
  if (!WRAPPER_KEYS.every((key) => key in item)) return false;
  if (item.source !== 'acu' && item.source !== 'paste') return false;
  if (typeof item.importedAt !== 'number') return false;
  return !!item.data && typeof item.data === 'object' && !Array.isArray(item.data);
}

/**
 * 把误包了不止一层的预设剥回本体；正常预设原样返回。
 *
 * 老数据（已经存成双层的那份）读的时候会经过这里，所以不必让用户手动删掉重导。
 * `maxDepth` 只是防呆 —— 数据真坏成环了也别在这儿打转。
 */
export function unwrapPresetPayload(value: unknown, maxDepth = 8): unknown {
  let current = value;
  for (let i = 0; i < maxDepth; i += 1) {
    if (!isStoredPresetWrapper(current)) return current;
    current = (current as Record<string, unknown>).data;
  }
  return current;
}

/** 深拷一份普通 JSON 结构；拷不动就原样返回（下面会当成坏数据拒收）。 */
function cloneJson<T>(value: T): T {
  try {
    const text = JSON.stringify(value);
    return typeof text === 'string' ? (JSON.parse(text) as T) : value;
  } catch {
    return value;
  }
}

/** `makeStoredPreset` 的结果。拒收时要能告诉用户为什么。 */
export type MakeStoredPresetResult =
  | { ok: true; preset: StoredPlotPreset }
  | { ok: false; reason: 'not-object' | 'no-name' | 'too-large'; name: string; size: number };

/**
 * 把一份「数据库脚本形状」的预设整形成本地快照。
 *
 * `now` / `source` 都从外面传进来，这个函数自己不看时钟 —— 否则用例里没法断言。
 */
export function makeStoredPreset(
  raw: unknown,
  source: StoredPresetSource,
  now: number,
): MakeStoredPresetResult {
  // 传进来的可能已经被包过一层（见 `isStoredPresetWrapper` 的注释），先剥回本体再包。
  const body = unwrapPresetPayload(raw);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, reason: 'not-object', name: '', size: 0 };
  }

  const name = storedPresetName(body);
  const size = measurePresetSize(body);
  if (name === '') return { ok: false, reason: 'no-name', name, size };
  if (size > MAX_STORED_PRESET_CHARS) return { ok: false, reason: 'too-large', name, size };

  return {
    ok: true,
    preset: { name, data: cloneJson(body as Record<string, unknown>), source, importedAt: now },
  };
}

/** 在一堆本地预设里按名字找一份；找不到返回 `null`。 */
export function findStoredPreset(presets: readonly StoredPlotPreset[], name: string): StoredPlotPreset | null {
  const wanted = typeof name === 'string' ? name.trim() : '';
  if (wanted === '') return null;
  for (const preset of presets) {
    if (preset && preset.name === wanted) return preset;
  }
  return null;
}

/** 本地预设的名字清单（去空、去重、保序）。 */
export function listStoredPresetNames(presets: readonly StoredPlotPreset[]): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const preset of presets) {
    const name = preset && typeof preset.name === 'string' ? preset.name.trim() : '';
    if (name === '' || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

/** `mergeStoredPresets` 的结果统计。 */
export interface MergeStoredPresetsResult {
  presets: StoredPlotPreset[];
  /** 本地原先没有、这次加进来的条数 */
  added: number;
  /** 名字撞上、被新版本覆盖掉的条数 */
  replaced: number;
  /** 名字撞上、按 `keepLocal` 保住了本地版本的条数 */
  kept: number;
  /** 没名字或体积超标被丢掉的条数 */
  skipped: number;
  /** 被丢掉的预设名，界面上要能点名 */
  skippedNames: string[];
}

/**
 * 把一批新预设并进本地库。
 *
 * 默认 `keepLocal: true` —— **用户改过的本地版本优先**。
 * 这条默认值是有意的：导入多半是「再拉一次看看有没有新的」，
 * 如果每次都拿数据库那边覆盖本地，用户在这里做的任何调整都会被静默冲掉。
 *
 * 纯函数：不修改 `local` / `incoming`，返回全新数组。
 */
export function mergeStoredPresets(
  local: readonly StoredPlotPreset[],
  incoming: readonly unknown[],
  options: { keepLocal?: boolean; source?: StoredPresetSource; now?: number } = {},
): MergeStoredPresetsResult {
  const keepLocal = options.keepLocal !== false;
  const source = options.source ?? 'acu';
  const now = typeof options.now === 'number' ? options.now : Date.now();

  const presets: StoredPlotPreset[] = (local || [])
    .filter((item) => !!item && typeof item.name === 'string' && item.name.trim() !== '')
    .map((item) => cloneJson(item));

  const index = new Map<string, number>();
  presets.forEach((item, i) => index.set(item.name, i));

  let added = 0;
  let replaced = 0;
  let kept = 0;
  let skipped = 0;
  const skippedNames: string[] = [];

  for (const raw of incoming || []) {
    const made = makeStoredPreset(raw, source, now);
    if (!made.ok) {
      if (made.reason !== 'not-object' || made.name !== '') skippedNames.push(made.name || '(没有名字)');
      else skippedNames.push('(不是对象)');
      skipped += 1;
      continue;
    }

    const at = index.get(made.preset.name);
    if (at === undefined) {
      index.set(made.preset.name, presets.length);
      presets.push(made.preset);
      added += 1;
      continue;
    }

    if (keepLocal) {
      kept += 1;
      continue;
    }

    presets[at] = made.preset;
    replaced += 1;
  }

  return { presets, added, replaced, kept, skipped, skippedNames };
}

/** 从本地库里删掉一条；返回新数组（找不到就原样返回一份拷贝）。 */
export function removeStoredPreset(presets: readonly StoredPlotPreset[], name: string): StoredPlotPreset[] {
  const wanted = typeof name === 'string' ? name.trim() : '';
  return (presets || []).filter((item) => item && item.name !== wanted).map((item) => cloneJson(item));
}

/** 来源该显示成什么。 */
export function describePresetSource(source: StoredPresetSource): string {
  if (source === 'acu') return '数据库';
  if (source === 'local') return '本地新建';
  return '粘贴导入';
}

/** 导入一条预设的结果，直接拿去当面板提示。 */
export function describeStoredPresetSize(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return '0 字符';
  if (size < 1000) return `${size} 字符`;
  return `${(size / 1000).toFixed(1)}k 字符`;
}
