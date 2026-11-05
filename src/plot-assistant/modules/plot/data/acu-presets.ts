/**
 * 剧情推进 — 从 ACU 读预设（取数层，唯一碰 `window.AutoCardUpdaterAPI` 的地方之一）。
 *
 * 只做三件事：列名字、按名字取详情、把「没得选 / 没选 / 选了个不存在的」讲清楚。
 * **不提供「默认预设」这一项** —— ACU 的默认预设内容只在它自己内存里，对外没有任何接口
 * （`getPlotPresetDetails('')` 返回 `null`，`exportCombinedSettings()` 返回 `{}`）。
 * 与其给用户一个选了什么也读不到的选项，不如让他去 ACU 里挑一个具名预设，或者导一个进来。
 */

/** ACU 暴露给外部的那一小撮接口。字段全可选，缺了就当没有。 */
export interface AcuPresetApiLike {
  getPlotPresetNames?: () => unknown;
  getPlotPresetDetails?: (name: string) => unknown;
  /** 一把全部预设（带内容）。有它就优先用，比按名字逐个取快得多。 */
  getPlotPresets?: () => unknown;
  /** ACU 那边**当前实际在用的**那一份（对当前聊天绑定生效的那份）。 */
  getCurrentPlotPreset?: () => unknown;
}

/** 读预设的结果。`reason` 决定调用方该说什么话。 */
export type PresetReadOutcome =
  | { ok: true; presetName: string; details: Record<string, unknown> }
  | { ok: false; reason: 'no-api' | 'no-presets' | 'not-chosen' | 'missing' | 'unreadable'; presetName: string; available: string[] };

/**
 * 依次检查「自己 → 父窗口 → 顶层窗口」，把挂着的窗口按顺序交出去。
 *
 * **为什么不能只看 `window`**：我们的脚本跑在酒馆助手的 iframe 里，
 * 而数据库脚本把自己的接口挂在了**主页面**的 `window` 上。
 * 在 iframe 里 `window.AutoCardUpdaterAPI` 是 `undefined`，必须往上一层找 ——
 * 这就是「读不到预设」那个 bug 的根因（实测：iframe 里 `undefined`，`parent` 里 `object`）。
 *
 * 反过来也不必担心误取：如果这段代码哪天跑在主页面或前端界面里，
 * `window` 自己就是那一层，第一个就命中。
 *
 * 跨域访问 `parent` / `top` 会抛 SecurityError，那就当它不存在，继续往下试。
 */
export function acuHostWindows(): Array<Record<string, unknown>> {
  if (typeof window === 'undefined') return [];

  const self = window as unknown as Record<string, unknown>;
  const hosts: Array<Record<string, unknown>> = [self];

  for (const get of [() => window.parent, () => window.top]) {
    let win: Window | null = null;
    try {
      win = get();
    } catch {
      continue;
    }
    if (!win || win === window) continue;
    // `top` 常常和 `parent` 是同一个窗口，去重免得白检查两遍
    const asRecord = win as unknown as Record<string, unknown>;
    if (hosts.includes(asRecord)) continue;
    hosts.push(asRecord);
  }

  return hosts;
}

/** 拿 ACU 的接口对象；页面不在或插件没装时返回 null。 */
export function resolveAcuPresetApi(): AcuPresetApiLike | null {
  for (const host of acuHostWindows()) {
    let api: unknown;
    try {
      api = host.AutoCardUpdaterAPI;
    } catch {
      continue;
    }
    if (!api || typeof api !== 'object') continue;
    // 只认真的能列预设的那一份，免得误取到同名空壳
    const candidate = api as AcuPresetApiLike;
    if (typeof candidate.getPlotPresetNames === 'function') return candidate;
  }
  return null;
}

/** 列出所有具名预设（去空、去重、保序）。读不到就给空数组，不抛。 */
export function listPlotPresetNames(api: AcuPresetApiLike | null = resolveAcuPresetApi()): string[] {
  if (!api || typeof api.getPlotPresetNames !== 'function') return [];

  let raw: unknown;
  try {
    raw = api.getPlotPresetNames();
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];

  const seen = new Set<string>();
  const names: string[] = [];
  for (const item of raw) {
    const name = typeof item === 'string' ? item.trim() : '';
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

/**
 * 按名字取预设详情。
 *
 * 三种「读不到」分开报，因为用户要做的事不一样：
 *   - `no-api` / `no-presets`：去装 ACU、去导预设
 *   - `not-chosen`：去面板里选一个
 *   - `missing`：选的那个被删/改名了，重新选
 */
export function readPlotPreset(presetName: string, api: AcuPresetApiLike | null = resolveAcuPresetApi()): PresetReadOutcome {
  const wanted = String(presetName || '').trim();

  if (!api) return { ok: false, reason: 'no-api', presetName: wanted, available: [] };

  const available = listPlotPresetNames(api);
  if (available.length === 0) return { ok: false, reason: 'no-presets', presetName: wanted, available };
  if (!wanted) return { ok: false, reason: 'not-chosen', presetName: wanted, available };
  if (!available.includes(wanted)) return { ok: false, reason: 'missing', presetName: wanted, available };

  let details: unknown;
  try {
    details = typeof api.getPlotPresetDetails === 'function' ? api.getPlotPresetDetails(wanted) : null;
  } catch {
    details = null;
  }
  if (!details || typeof details !== 'object' || Array.isArray(details)) {
    return { ok: false, reason: 'unreadable', presetName: wanted, available };
  }

  return { ok: true, presetName: wanted, details: details as Record<string, unknown> };
}

/** 「一次取回全部预设（带内容）」的结果。 */
export type PresetListOutcome =
  | { ok: true; presets: Array<Record<string, unknown>>; skipped: number }
  | { ok: false; reason: 'no-api' | 'no-presets'; available: string[] };

/**
 * 一次把 ACU 里的全部剧情预设连内容一起取回来 —— 「一键导入」用的就是这个。
 *
 * 优先走 `getPlotPresets()`（一次拿到全部，含内容）；
 * 老版本 ACU 若没有这个接口，就退回去按名字逐个 `getPlotPresetDetails()`。
 * 两条路都会跳过「没有名字」和「取不回对象」的坏条目，并把条数报给调用方，
 * 免得用户以为「明明有 3 个，怎么只导进来 2 个」。
 */
export function readAllPlotPresets(api: AcuPresetApiLike | null = resolveAcuPresetApi()): PresetListOutcome {
  if (!api) return { ok: false, reason: 'no-api', available: [] };

  const available = listPlotPresetNames(api);
  if (available.length === 0) return { ok: false, reason: 'no-presets', available };

  const presets: Array<Record<string, unknown>> = [];
  let skipped = 0;

  // 列表接口先跑一遍，只当「按名字取不到详情」时的退路。
  const listedByName = new Map<string, Record<string, unknown>>();
  if (typeof api.getPlotPresets === 'function') {
    let raw: unknown;
    try {
      raw = api.getPlotPresets();
    } catch {
      raw = null;
    }
    if (Array.isArray(raw)) {
      for (const item of raw) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          skipped += 1;
          continue;
        }
        const record = item as Record<string, unknown>;
        const name = typeof record.name === 'string' ? record.name.trim() : '';
        if (name === '') {
          skipped += 1;
          continue;
        }
        listedByName.set(name, record);
      }
    }
  }

  // 一律优先按名字取详情。列表里那份可能是「轻」的（没有 plotTasks / prompts），
  // 存下来会让任务表整页空白 —— 2026-11-01 就是踩在这个上面。
  for (const name of available) {
    const detail = readPlotPreset(name, api);
    if (detail.ok) {
      presets.push(detail.details);
      continue;
    }
    const fallback = listedByName.get(name);
    if (fallback) {
      presets.push(fallback);
      continue;
    }
    skipped += 1;
  }

  return presets.length === 0 ? { ok: false, reason: 'no-presets', available } : { ok: true, presets, skipped };
}

/**
 * ACU 那边**当前正在用**的预设名。读不到就是空串，不抛。
 *
 * 注意这是「对当前这张卡/这个聊天」生效的那一份，不一定等于它在设置页里
 * 全局选的那份 —— ACU 对每个聊天单独存了绑定（`plotPresetBindings`），
 * 用户在全局页改过之后没重进聊天，看到的仍是旧的。所以这里只用来做
 * 「新装的人先给他选上」，不做任何覆盖。
 */
export function readCurrentPlotPresetName(api: AcuPresetApiLike | null = resolveAcuPresetApi()): string {
  if (!api || typeof api.getCurrentPlotPreset !== 'function') return '';
  let raw: unknown;
  try {
    raw = api.getCurrentPlotPreset();
  } catch {
    return '';
  }
  return typeof raw === 'string' ? raw.trim() : '';
}

/** 「读不到」时该对用户说的话。调用方直接拿去 toast / 面板提示。 */
export function describePresetProblem(outcome: PresetReadOutcome): string {
  if (outcome.ok) return '';

  switch (outcome.reason) {
    case 'no-api':
      return '没找到数据库脚本的接口（AutoCardUpdaterAPI）。请确认数据库脚本已加载。';
    case 'no-presets':
      return '数据库脚本里还没有任何剧情推进预设。请先导入或下载一个预设。';
    case 'not-chosen':
      return `还没选剧情推进预设。可选的有：${outcome.available.join('、')}`;
    case 'missing':
      return `预设「${outcome.presetName}」不在了。现在可选的有：${outcome.available.join('、')}`;
    case 'unreadable':
      return `预设「${outcome.presetName}」读不出内容，可能已损坏，换一个试试。`;
    default:
      return '读取剧情推进预设失败。';
  }
}
