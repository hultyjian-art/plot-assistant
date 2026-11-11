/**
 * 设置模块：结构用 zod 描述，存进酒馆脚本变量。
 *
 * 读取入口要同时接受两种形态：
 * 1. 当前形态（bindings / presets / capture / look / timing 嵌套结构）
 * 2. 上一版形态（single、double、shakeAnim、clickDelay、regexPresets 平铺字段，
 *    以及单选启用项 activeRegexId——它同样落在脚本变量里）
 *    该形态没有 capture 段，缺字段一律取默认值。
 * 任何形态都先规整成当前形态再校验，校验失败则整份退回默认值。
 */
import { isPlainObject } from './plot/guards';
import { DEFAULT_MAX_TOKENS } from './constants';
import { z } from 'zod';
import { klona } from 'klona';
import { obfuscateApiKey, unobfuscateApiKey } from './plot/api-key';
import { unwrapPresetPayload } from './plot/data/preset-store';
import { FALLBACK_PRESETS } from './regex';
import { logWarn, logInfo } from './logger';
import { MSG, TAG, UI } from './copy';
import { DEFAULT_THEME_ID, asThemeId } from './themes';
import type {
  ActionKey,
  CaptureSettings,
  PlotApiEntry,
  PlotContextRule,
  PlotWorldbookWriteRule,
  RegexPreset,
  RerushContext,
  RerushSettings,
} from './types';

/**
 * 设置存在这个固定槽里，**不跟脚本 id 走**。
 *
 * 以前用 `{type:'script'}`，那是以脚本实例为键的：重新导入一版脚本会拿到新 id，
 * 所有 API、预设、开关全读不到，看起来就像「更新一下就丢数据」。
 * 换成固定 `extension_id` 之后，只要槽名不变，换几次脚本都读同一份。
 */
const SETTINGS_EXTENSION_ID = 'reroll-plot-store';

/**
 * 设置结构/默认值的印章。改了默认值又想让老用户也吃到时，换一个值即可。
 *
 * 为什么要印章：默认值只对新装的人生效，存过盘的人手里还是旧值。
 * 但也不能每读一次就强行覆盖 —— 用户自己把右键改回「不响应」之后，
 * 再读一次又给改回来，那就是跟他抢方向盘。所以只在「印章对不上」时迁一次，
 * 迁完立刻落盘，之后再不动他。
 */
const SETTINGS_STAMP = '2026-11-04b';

const ActionKeyZ = z.enum(['native', 'full', 'edit', 'settings', 'none']);

const PresetZ = z.object({
  id: z.string(),
  name: z.string(),
  regex: z.string(),
  note: z.string(),
});

const CaptureZ = z.object({
  fromAiFloor: z.boolean(),
});

/** 剧情推进单次任务调用的默认超时（秒）。与 ACU 的 `API_REQUEST_TIMEOUT_DEFAULT_ACU` 一致。 */
export const PLOT_DEFAULT_TIMEOUT_SECONDS = 300;

const PlotZ = z.object({
  /**
   * 总开关。默认关 —— 关着的时候脚本行为与加进这个功能之前逐字节一致。
   * 用户必须在设置页里主动打开，才会在发送前跑一轮剧情推进。
   */
  enabled: z.boolean(),
  /**
   * `$7 默认上下文`的全局兜底（没选预设时用的那一份）。
   * 预设里也有同名字段，选上预设时以预设的为准。
   */
  contextDefaults: z.object({
    turnCount: z.number(),
    extractRules: z.array(z.object({ start: z.string(), end: z.string() })),
    excludeRules: z.array(z.object({ start: z.string(), end: z.string() })),
  }),
  /** 用户选定的剧情推进预设名（ACU 那边预设的名字）。空串 = 还没选。 */
  presetName: z.string(),
  /** 自己的一份 API 清单（与 ACU 的存储互不相干） */
  apis: z.array(
    z.object({
      name: z.string(),
      apiMode: z.enum(['custom', 'tavern']),
      url: z.string(),
      apiKey: z.string(),
      model: z.string(),
      source: z.string(),
      maxTokens: z.union([z.number().int(), z.literal('same_as_preset'), z.literal('unset')]),
      temperature: z.union([z.number(), z.literal('same_as_preset'), z.literal('unset')]),
      importedFrom: z.string(),
      /**
       * 附加请求体参数（YAML/JSON 原文）。存字符串而不是对象：面板上一格多行文本，
       * 原样留着用户自己看得懂、改得动；解析在每次调用前做（见 `plot/api-route.ts`）。
       */
      bodyParams: z.string(),
      /** 要剔掉的请求体参数名，逗号/顿号/空格分隔。 */
      excludeBodyParams: z.string(),
      requestHeaders: z.string(),
      /**
       * 提示词后处理（酒馆的 `custom_prompt_post_processing`）。
       *
       * 取值：`'follow'`（跟随酒馆，不动那一格）/ `''`（这一轮不处理）/
       * `'merge'` / `'merge_tools'` / `'semi'` / `'semi_tools'` / `'strict'` / `'strict_tools'` / `'single'`。
       * 存字符串而不是枚举：酒馆以后加新值时要能原样带过去，不该被我们的校验拦死。
       */
      promptPostProcessing: z.string(),
    }),
  ),
  /**
   * 「解除发送伪装」：true = 等待期间不显示气泡/生成中外壳（只留输入框原文）。
   * 默认 false（显示气泡），与 ACU 的 `plotSendDisguiseDisabled` 同名同义。
   */
  sendDisguiseDisabled: z.boolean(),
  /**
   * `$1` 默认世界书的来源：`character` = 角色卡绑定的主要 + 附加书（老行为），
   * `manual` = 用户在「世界书与上下文」页勾的那几本（可以是没绑角色卡的全局设定书）。
   */
  worldbookSource: z.enum(['character', 'manual']),
  /** 手动模式勾选的书名。来源是 character 时这份清单留着不动，方便切回去。 */
  worldbookBooks: z.array(z.string()),
  /**
   * 条目级的勾选：`书名 → 允许注入的 uid 列表`。
   *
   * 缺一本书（没有这个键）就当作「这本书全选」—— 新加进世界书的条目默认生效，
   * 用户不必每次加条目都回面板补勾。只有他真动手取消了某几条，才会写下这份清单。
   */
  worldbookEntries: z.record(z.string(), z.array(z.string())),
  /** 用哪一条 API（按名字对齐） */
  activeApiName: z.string(),
  /** 单次任务调用的超时秒数；<= 0 = 不设 */
  requestTimeoutSeconds: z.number(),
  /**
   * 本地预设库。`data` 是数据库脚本那边的原始形状，这里刻意用 `z.record(z.string(), z.unknown())`
   * 而不是照着 ACU 的字段一个个写 —— 那边字段随版本变，抄一份等于给自己埋一份要跟着改的债。
   */
  presets: z.array(
    z.object({
      name: z.string(),
      data: z.record(z.string(), z.unknown()),
      source: z.union([z.literal('acu'), z.literal('paste')]),
      importedAt: z.number(),
    }),
  ),
  /**
   * 推进结果的存放方式（2026-11-03 用户定）：
   *
   * - `'upgrade'`：成果进聊天变量里的暂存账本（本脚本自己的账，支持每层两版、面板里改）。
   * - `'qrf'`：成果直接写进楼层的 `qrf_plot*` 字段，与数据库脚本那套完全兼容。
   *
   * **两者互斥**：同一层不会既有账本又有 qrf 字段 —— 两份数据各写各的，用户改了一边
   * 另一边不跟着动，就变成"账本说 A、楼层说 B"。切换时做一次单向迁移并把另一边清掉。
   */
  stashMode: z.enum(['upgrade', 'qrf']),
  /**
   * 世界书写入规则（2026-11-07 新增）：把规则选中的标签块写成世界书条目。
   * 结构宽松校验：脏规则在 `readWorldbookWriteRules` 里逐条丢，不让整份设置退回默认。
   */
  worldbookWriteRules: z.array(
    z.object({
      tagName: z.string(),
      entryName: z.string(),
      depth: z.number(),
      order: z.number(),
      enabled: z.boolean(),
    }),
  ),
  /** 条目写进哪本书：character = 角色卡的主要知识书（只写主书）；manual = 勾的那几本。 */
  worldbookWriteSource: z.enum(['character', 'manual']),
  /** 写入手动模式勾选的书名。 */
  worldbookWriteBooks: z.array(z.string()),
});

export const SettingsZ = z.object({
  // 默认值印章：见 SETTINGS_STAMP。旧设置里没有这一项，读出来就是空串。
  stamp: z.string(),
  bindings: z.object({
    tap: ActionKeyZ,
    double: ActionKeyZ,
    hold: ActionKeyZ,
    triple: ActionKeyZ,
    right: ActionKeyZ,
  }),
  presets: z.array(PresetZ),
  capture: CaptureZ,
  look: z.object({
    shake: z.boolean(),
    flash: z.boolean(),
    toast: z.boolean(),
    // 主题 id 用裸 string 而不是 enum：面板以后加主题时，老版本脚本读到未知 id
    // 不该让整份设置校验失败退回默认（那会连用户的手势绑定一起抹掉）。
    themeId: z.string(),
  }),
  timing: z.object({
    tapWindowMs: z.number().int().min(10),
    holdMs: z.number().int().min(10),
  }),
  plot: PlotZ,
});

export const FALLBACK_SETTINGS: RerushSettings = {
  stamp: SETTINGS_STAMP,
  // 用户 2026-10-11 定的默认口径：三击比长按更难按准，把最重的动作（全流程重刷）放三击，
  // 打开设置这种不误伤剧情的动作放单击。
  // 2026-11-04 用户再定：右键默认「回填修改」，跟长按同一个动作。
  bindings: { tap: 'settings', double: 'native', hold: 'edit', triple: 'full', right: 'edit' },
  presets: klona(FALLBACK_PRESETS),
  capture: { fromAiFloor: false },
  look: { shake: true, flash: true, toast: true, themeId: DEFAULT_THEME_ID },
  // 长按阈值 500→350→450 毫秒：350 在手机上太容易误判 —— 想单击却没弹起来的那一下
  // 会被判成长按，于是设置页没开、反倒跑了一轮推进。450 是慢慢按也还算跟手的折中。
  // 计时从按下那一刻起（gesture.ts 的 holdTimer），所以连击时若某一下按住超过 450 毫秒
  // 就会当场判成长按，每下按得干脆才不会。
  timing: { tapWindowMs: 230, holdMs: 450 },
  // 剧情推进预设默认不选：ACU 的「默认预设」内容对外读不到，所以这里只存具名预设。
  plot: {
    enabled: false,
    // 没选预设时改的就是这一份；条数缺省 3，与 ACU 预设里的默认一致
    contextDefaults: { turnCount: 3, extractRules: [], excludeRules: [] },
    presetName: '',
    apis: [],
    activeApiName: '',
    // 默认 300 秒：和 ACU 一致。用户可能一次都没打开这个面板，那时也该有保护。
    requestTimeoutSeconds: PLOT_DEFAULT_TIMEOUT_SECONDS,
    // 默认空库：没导入过就回退到「实时读数据库脚本」，老用户升级后行为不变
    presets: [],
    // 默认升级模式：账本在聊天变量里，楼层不写 qrf 字段（用户 2026-11-03 定）
    stashMode: 'upgrade',
    // 默认显示等待气泡（= 不解除伪装），与 ACU 的默认一致
    sendDisguiseDisabled: false,
    // 默认跟随角色卡绑定的世界书：老用户升级后 `$1` 内容不变
    worldbookSource: 'character',
    worldbookBooks: [],
    // 空表 = 每本书都全选
    worldbookEntries: {},
    // 世界书写入（2026-11-07）：默认没配规则 = 什么都不写，行为与加功能前一致；
    // 目标书默认跟角色卡走：只写主要知识书。
    worldbookWriteRules: [],
    worldbookWriteSource: 'character',
    worldbookWriteBooks: [],
  },
};

/** 平铺形态里出现过的字段，用于识别"这是旧设置"。 */
interface FlatLegacy {
  single?: unknown;
  double?: unknown;
  long?: unknown;
  triple?: unknown;
  right?: unknown;
  shakeAnim?: unknown;
  redAnim?: unknown;
  showToasts?: unknown;
  clickDelay?: unknown;
  longPressDelay?: unknown;
  regexPresets?: unknown;
  activeRegexId?: unknown;
}

/** 只认得这五个动作值，其余一律退回默认，避免脏值进 schema。 */
function asAction(value: unknown, fallback: ActionKey): ActionKey {
  return value === 'native' || value === 'full' || value === 'edit' || value === 'settings' || value === 'none'
    ? value
    : fallback;
}

function asFlag(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asDelay(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n >= 10 ? Math.round(n) : fallback;
}

/**
 * 面板保存前把数字钳回合法区间（与 SettingsZ 的下限同源）。
 * 不钳的话，面板里手输一个 0 会先落到酒馆变量里，下次读取时 zod 校验不过，
 * 整份设置会被退回默认值——用户会看到"我改一项，别的全没了"。
 */
export function clampCount(value: number, fallback: number, min: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.round(value));
}

/** 旧版把正则按 pattern/flags 两个字段存，现在统一成一个 `/表达式/标志` 字面量。 */
function toPreset(raw: Record<string, unknown>): RegexPreset {
  const id = typeof raw.id === 'string' && raw.id !== '' ? raw.id : `preset_${crypto.randomUUID()}`;
  const name = typeof raw.name === 'string' && raw.name !== '' ? raw.name : UI.unnamedPreset;
  const note = typeof raw.note === 'string' ? raw.note : '';
  if (typeof raw.regex === 'string' && raw.regex !== '') {
    return { id, name, regex: raw.regex, note };
  }
  const pattern = typeof raw.pattern === 'string' ? raw.pattern : '.*';
  const flags = typeof raw.flags === 'string' ? raw.flags : '';
  return { id, name, regex: `/${pattern}/${flags}`, note };
}

/**
 * 内置预设的历史写法 → 当前内置写法。只认"整条一字不差"，所以你自己写/改过的预设永远不会被动。
 * 历史上这两类写法都出过问题：
 * ① 早期内置漏了 `s` 标志，跨行楼层根本捕不到；
 * ② 后来用 `(.*?)/s` 靠标志跨行，但标志写在输入框最末尾——手改表达式时很容易连带删掉，
 *    删掉的后果是"看起来正常、跨行的那块抓不到"，静默失效最难查。
 * 第31次起内置一律写成 `[\s\S]`，跨行不依赖任何标志；这里把还挂着历史写法的内置条目升级过来。
 */
const LEGACY_BUILTIN_REGEX: Record<string, string[]> = {
  progress: ['/<user_input>(.*?)</user_input>/', '/<user_input>(.*?)<\\/user_input>/s'],
  all: ['/.*/', '/.*/s'],
};

function repairBuiltinPresets(presets: RegexPreset[]): RegexPreset[] {
  return presets.map((preset) => {
    const legacy = LEGACY_BUILTIN_REGEX[preset.id];
    if (!legacy || !legacy.includes(preset.regex)) return preset;
    const builtin = FALLBACK_PRESETS.find((item) => item.id === preset.id);
    return builtin ? { ...preset, regex: builtin.regex } : preset;
  });
}

/**
 * 旧版是"从列表里勾选启用一条"，新版按数组顺序级联。
 * 升级后保持原有行为：把旧设置里勾选的那条挪到第 1 位。
 */
function promotePreset(presets: RegexPreset[], legacyChosenId: unknown): RegexPreset[] {
  if (typeof legacyChosenId !== 'string' || legacyChosenId === '') return presets;
  const index = presets.findIndex((preset) => preset.id === legacyChosenId);
  if (index <= 0) return presets;
  const next = [...presets];
  const [chosen] = next.splice(index, 1);
  next.unshift(chosen);
  logInfo(TAG.conf, MSG.legacyPresetPromoted(chosen.name));
  return next;
}

function readPresetList(source: unknown): RegexPreset[] {
  if (!Array.isArray(source) || source.length === 0) {
    return klona(FALLBACK_PRESETS);
  }
  return repairBuiltinPresets((source as Record<string, unknown>[]).map(toPreset));
}

/**
 * 捕获链的取文来源同样是后加的一段：旧设置里没有 capture，缺字段一律判为"关"，
 * 也就是沿用原有行为——从最新用户楼层取文。
 */
function readCapture(source: unknown): CaptureSettings {
  const raw = (source ?? {}) as Partial<CaptureSettings>;
  return { fromAiFloor: asFlag(raw.fromAiFloor, FALLBACK_SETTINGS.capture.fromAiFloor) };
}


/**
 * 世界书条目勾选表：`书名 → 允许注入的 uid 列表`。
 *
 * 空数组是**有意义的**（这本书一条都不注入），所以空表不能丢；
 * 而没有这个键才是「全选」。uid 一律存字符串，见 normalizePlot 里的说明。
 */
function readEntrySelection(raw: unknown): Record<string, string[]> {
  if (!isPlainObject(raw)) return {};
  const next: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const name = key.trim();
    if (!name || !Array.isArray(value)) continue;
    const uids = value.map(uid => String(uid ?? '').trim()).filter(uid => uid !== '');
    next[name] = [...new Set(uids)];
  }
  return next;
}

/** 剧情推进预设：只认字符串，其它一律当成「还没选」。 */
function readPlot(raw: unknown): RerushSettings['plot'] {
  const source = (raw ?? {}) as Partial<RerushSettings['plot']>;
  return {
    enabled: source.enabled === true,
    contextDefaults: readContextDefaults(source.contextDefaults),
    presetName: typeof source.presetName === 'string' ? source.presetName.trim() : '',
    apis: Array.isArray(source.apis) ? source.apis.map(readPlotApi).filter((api): api is PlotApiEntry => api !== null) : [],
    activeApiName: typeof source.activeApiName === 'string' ? source.activeApiName.trim() : '',
    // 缺省给 300 秒（与 ACU 的 API_REQUEST_TIMEOUT_DEFAULT_ACU 一致）。
    // 0 与负数表示"不设"（用户明确关掉），要保留原值，不能当成缺省。
    requestTimeoutSeconds:
      typeof source.requestTimeoutSeconds === 'number' && Number.isFinite(source.requestTimeoutSeconds)
        ? source.requestTimeoutSeconds
        : PLOT_DEFAULT_TIMEOUT_SECONDS,
    presets: Array.isArray(source.presets)
      ? source.presets
          .map(readStoredPreset)
          .filter((preset): preset is RerushSettings['plot']['presets'][number] => preset !== null)
      : [],
    // 缺省升级模式：老用户升级上来时，账本里已有的东西继续用，楼层不写 qrf。
    stashMode: source.stashMode === 'qrf' ? 'qrf' : 'upgrade',
    // 「解除发送伪装」默认关（= 显示等待气泡），与 ACU 的默认一致。
    // 只影响等待外观：无论开关，失败都不会把正文发出去。
    sendDisguiseDisabled: source.sendDisguiseDisabled === true,
    worldbookSource: source.worldbookSource === 'manual' ? 'manual' : 'character',
    worldbookBooks: Array.isArray(source.worldbookBooks)
      ? source.worldbookBooks.filter((name): name is string => typeof name === 'string' && name.trim() !== '').map(name => name.trim())
      : [],
    // 条目级勾选：只认「书 → 字符串数组」的形状，脏键直接丢。
    // uid 统一存字符串 —— 酒馆助手给的 uid 有时是数字、有时是字符串，
    // 存成一种形式，比较时两边都 String()，才不会出现「勾了却永远不生效」。
    worldbookEntries: readEntrySelection(source.worldbookEntries),
    // 世界书写入（2026-11-07）：老设置里没有这几项，缺了就按默认值补 ——
    // 没规则 = 不写，目标书默认跟角色卡绑定走。
    worldbookWriteRules: readWorldbookWriteRules(source.worldbookWriteRules),
    worldbookWriteSource: source.worldbookWriteSource === 'manual' ? 'manual' : 'character',
    worldbookWriteBooks: Array.isArray(source.worldbookWriteBooks)
      ? source.worldbookWriteBooks
          .filter((name): name is string => typeof name === 'string' && name.trim() !== '')
          .map(name => name.trim())
      : [],
  };
}

/**
 * 世界书写入规则：逐条认，脏条目丢掉而不是整份清空。
 *
 * 规则是用户一条条配出来的，一条坏了（比如手改变量改坏了）只该丢那一条；
 * 整份清空会让「我配了三条，改错一处就全没了」。tagName 为空的条目没有意义，直接丢。
 */
function readWorldbookWriteRules(raw: unknown): PlotWorldbookWriteRule[] {
  if (!Array.isArray(raw)) return [];
  const out: PlotWorldbookWriteRule[] = [];
  for (const item of raw) {
    const rule = (item ?? {}) as Partial<PlotWorldbookWriteRule>;
    const tagName = typeof rule.tagName === 'string' ? rule.tagName.trim() : '';
    if (tagName === '') continue;
    out.push({
      tagName,
      entryName: typeof rule.entryName === 'string' ? rule.entryName : '',
      // 位置两个数只认正数：0/负数/脏值退回工作流助手的默认（深度 2 / 顺序 10000），
      // 那是用户拍板要照抄的值（批 36），不是拍脑袋给的。
      depth:
        typeof rule.depth === 'number' && Number.isFinite(rule.depth) && rule.depth >= 1
          ? Math.floor(rule.depth)
          : 2,
      order:
        typeof rule.order === 'number' && Number.isFinite(rule.order) && rule.order >= 0
          ? Math.floor(rule.order)
          : 10000,
      enabled: rule.enabled === true,
    });
  }
  return out;
}

/**
 * 归整 `$7 默认上下文`的全局兜底。
 *
 * 条数缺省给 3 —— 这是全局兜底的默认值；预设里若写了 `contextTurnCount` 就以预设为准
 * （预设缺这个字段时，上游运行时读的是 `?? 1`，这里的 3 只在没选预设时生效）。
 * 给 3 是为了让「没设过」和「设成 0（不抓前文）」看起来不一样。
 */
function readContextDefaults(raw: unknown): RerushSettings['plot']['contextDefaults'] {
  const source = (raw ?? {}) as Partial<RerushSettings['plot']['contextDefaults']>;
  return {
    turnCount:
      typeof source.turnCount === 'number' && Number.isFinite(source.turnCount) && source.turnCount >= 0
        ? Math.floor(source.turnCount)
        : 3,
    extractRules: readRulePairs(source.extractRules),
    excludeRules: readRulePairs(source.excludeRules),
  };
}

/** 规则对：只认 `start` / `end` 都是字符串的条目，别的丢掉。 */
function readRulePairs(raw: unknown): PlotContextRule[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (item): item is PlotContextRule =>
        !!item &&
        typeof item === 'object' &&
        typeof (item as PlotContextRule).start === 'string' &&
        typeof (item as PlotContextRule).end === 'string',
    )
    .map((item) => ({ start: item.start, end: item.end }));
}

/**
 * 把 API 条目的 `source` 规整成酒馆认的 `chat_completion_source`。
 *
 * 为什么要在**读**的时候做：早先版本把 ACU 的协议名原样存了进去（`openai_compat`），
 * 而酒馆后端只认 `custom`/`openai`/`claude`/`deepseek`/`makersuite`… 这一套。
 * 存量的脏值会一直躺在变量里，只在写入口修的话，用户得手动改一遍才恢复。
 */
function normalizeTavernSource(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const value = raw.trim();
  switch (value) {
    case 'openai_compat':
    case 'openai_responses':
      return 'custom';
    case 'claude_messages':
      return 'claude';
    case 'gemini_interactions':
      return 'makersuite';
    default:
      return value;
  }
}

/**
 * 一条本地预设快照：名字必须有，数据必须是对象。
 *
 * **不在这里做体积校验** —— 用户可能从别的版本升上来，旧数据已经存进去了；
 * 读的时候把它踢掉等于让用户的预设静默消失。体积限制只拦「新导入」那一步。
 */
function readStoredPreset(raw: unknown): RerushSettings['plot']['presets'][number] | null {
  if (!isPlainObject(raw)) return null;
  const item = raw as Partial<RerushSettings['plot']['presets'][number]>;
  const name = typeof item.name === 'string' ? item.name.trim() : '';
  if (!name) return null;
  // 2026-11-01 曾把预设存成双层（`{name,data:{name,data:本体,…},…}`），
  // 读的时候统一剥回本体，老用户不用手动删掉重导。
  const data = unwrapPresetPayload(item.data);
  if (!isPlainObject(data)) return null;
  return {
    name,
    data: data as Record<string, unknown>,
    source: item.source === 'paste' ? 'paste' : 'acu',
    importedAt: typeof item.importedAt === 'number' && Number.isFinite(item.importedAt) ? item.importedAt : 0,
  };
}

/** 一条 API 配置：脏字段一律回落默认，整条无效才丢弃（名字为空的丢掉）。 */
function readPlotApi(raw: unknown): PlotApiEntry | null {
  if (!isPlainObject(raw)) return null;
  const item = raw as Partial<PlotApiEntry>;
  const name = typeof item.name === 'string' ? item.name.trim() : '';
  if (!name) return null;
  return {
    name,
    apiMode: item.apiMode === 'tavern' ? 'tavern' : 'custom',
    url: typeof item.url === 'string' ? item.url : '',
    // 落盘的是混淆过的；这里解成明文让运行时直接用。取不到就原样返回（兼容老明文数据）
    apiKey: typeof item.apiKey === 'string' ? unobfuscateApiKey(item.apiKey) : '',
    model: typeof item.model === 'string' ? item.model : '',
    // 老数据里可能还存着 ACU 的协议名（openai_compat 等）：读的时候就换成酒馆认的值，
    // 否则下次调用会被后端以 `Unsupported chat_completion_source` 直接打回。
    source: normalizeTavernSource(item.source),
    maxTokens: readNumberOrLiteral(item.maxTokens, DEFAULT_MAX_TOKENS),
    temperature: readNumberOrLiteral(item.temperature, 1),
    importedFrom: typeof item.importedFrom === 'string' ? item.importedFrom : '',
    // 老版本存下来的条目没有这两个字段：补空串，别让整份设置校验失败
    bodyParams: typeof item.bodyParams === 'string' ? item.bodyParams : '',
    excludeBodyParams: typeof item.excludeBodyParams === 'string' ? item.excludeBodyParams : '',
    requestHeaders: typeof item.requestHeaders === 'string' ? item.requestHeaders : '',
    // 老版本没有这一格：默认「跟随酒馆」—— 不借、不改，等于这个功能不存在
    promptPostProcessing: typeof item.promptPostProcessing === 'string' ? item.promptPostProcessing : 'follow',
  };
}

/** 数字参数允许酒馆的两个特殊字面量 `same_as_preset` / `unset`。 */function readNumberOrLiteral<T extends number | 'same_as_preset' | 'unset'>(
  raw: unknown,
  fallback: T,
): number | 'same_as_preset' | 'unset' {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (raw === 'same_as_preset' || raw === 'unset') return raw;
  return fallback;
}

function readStamp(raw: { stamp?: unknown }): string {
  return typeof raw.stamp === 'string' ? raw.stamp : '';
}

/**
 * 默认值迁移：只对「印章对不上」的老设置做一次。
 *
 * 现在有两条：
 * 1. 右键默认从「不响应」改成「回填修改」（用户 2026-11-04 定）。
 * 2. 长按阈值 350→450（同上，手机上 350 太容易把单击误判成长按）。
 * 两条都只迁还停在旧默认值上的人 —— 自己改过的一律不动。
 */
function applyDefaultMigrations(settings: RerushSettings): RerushSettings {
  const next: RerushSettings = { ...settings, stamp: SETTINGS_STAMP };
  if (next.bindings.right === 'none') {
    next.bindings = { ...next.bindings, right: FALLBACK_SETTINGS.bindings.right };
  }
  if (next.timing.holdMs === 350) {
    next.timing = { ...next.timing, holdMs: FALLBACK_SETTINGS.timing.holdMs };
  }
  return next;
}

/**
 * 把任意形态的存量设置规整成当前结构。
 * 判定顺序：先看有没有嵌套的 bindings，没有再按平铺字段读。
 */
function normalizeSettings(raw: Partial<RerushSettings> & FlatLegacy): RerushSettings {
  const nestedOk = raw.bindings != null && typeof raw.bindings === 'object';
  if (nestedOk) {
    const b = raw.bindings as Partial<RerushSettings['bindings']>;
    const l = (raw.look ?? {}) as Partial<RerushSettings['look']>;
    const t = (raw.timing ?? {}) as Partial<RerushSettings['timing']>;
    return {
      stamp: readStamp(raw),
      bindings: {
        tap: asAction(b.tap, FALLBACK_SETTINGS.bindings.tap),
        double: asAction(b.double, FALLBACK_SETTINGS.bindings.double),
        hold: asAction(b.hold, FALLBACK_SETTINGS.bindings.hold),
        triple: asAction(b.triple, FALLBACK_SETTINGS.bindings.triple),
        right: asAction(b.right, FALLBACK_SETTINGS.bindings.right),
      },
      presets: readPresetList(raw.presets),
      capture: readCapture(raw.capture),
      look: {
        shake: asFlag(l.shake, FALLBACK_SETTINGS.look.shake),
        flash: asFlag(l.flash, FALLBACK_SETTINGS.look.flash),
        toast: asFlag(l.toast, FALLBACK_SETTINGS.look.toast),
        themeId: asThemeId(l.themeId),
      },
      timing: {
        tapWindowMs: asDelay(t.tapWindowMs, FALLBACK_SETTINGS.timing.tapWindowMs),
        holdMs: asDelay(t.holdMs, FALLBACK_SETTINGS.timing.holdMs),
      },
      plot: readPlot(raw.plot),
    };
  }

  return {
    stamp: readStamp(raw),
    bindings: {
      tap: asAction(raw.single, FALLBACK_SETTINGS.bindings.tap),
      double: asAction(raw.double, FALLBACK_SETTINGS.bindings.double),
      hold: asAction(raw.long, FALLBACK_SETTINGS.bindings.hold),
      triple: asAction(raw.triple, FALLBACK_SETTINGS.bindings.triple),
      right: asAction(raw.right, FALLBACK_SETTINGS.bindings.right),
    },
    presets: promotePreset(readPresetList(raw.regexPresets), raw.activeRegexId),
    capture: readCapture(raw.capture),
    look: {
      shake: asFlag(raw.shakeAnim, FALLBACK_SETTINGS.look.shake),
      flash: asFlag(raw.redAnim, FALLBACK_SETTINGS.look.flash),
      toast: asFlag(raw.showToasts, FALLBACK_SETTINGS.look.toast),
      // 平铺那一版还没有主题，一律走默认。
      themeId: DEFAULT_THEME_ID,
    },
    timing: {
      tapWindowMs: asDelay(raw.clickDelay, FALLBACK_SETTINGS.timing.tapWindowMs),
      holdMs: asDelay(raw.longPressDelay, FALLBACK_SETTINGS.timing.holdMs),
    },
    plot: readPlot(raw.plot),
  };
}

export function loadSettings(ctx: RerushContext): void {
  try {
    const stored = readStoredSettings();
    const parsed = SettingsZ.parse(normalizeSettings(stored));
    ctx.settings = parsed.stamp === SETTINGS_STAMP ? parsed : applyDefaultMigrations(parsed);
    if (parsed.stamp !== SETTINGS_STAMP) {
      // 迁完立刻落盘：不落盘的话每次装载都会再迁一遍，用户改回「不响应」会被反复纠正。
      saveSettings(ctx, {});
      logInfo(TAG.conf, MSG.settingsDefaultsMigrated);
    }
  } catch (e) {
    logWarn(TAG.conf, MSG.settingsLoadFailed, e);
    ctx.settings = klona(FALLBACK_SETTINGS);
  }
}

/**
 * 读设置：先读固定槽；固定槽是空的，再去脚本变量里看一眼（老版本存那儿），
 * 有就顺手搬过来 —— 这样升级一次之后位置就固定了，下次换脚本还能读到。
 */
function readStoredSettings(): Partial<RerushSettings> & FlatLegacy {
  const slot = getVariables({ type: 'extension', extension_id: SETTINGS_EXTENSION_ID });
  if (slot && Object.keys(slot).length > 0) return slot as Partial<RerushSettings> & FlatLegacy;

  const legacy = getVariables({ type: 'script' }) as Partial<RerushSettings> & FlatLegacy;
  if (legacy && Object.keys(legacy).length > 0) {
    replaceVariables(klona(legacy), { type: 'extension', extension_id: SETTINGS_EXTENSION_ID });
    logInfo(TAG.conf, MSG.settingsMigrated);
    return legacy;
  }

  return {};
}

/**
 * 存设置，并**如实回答存成了没有**。
 *
 * 为什么要有返回值：`replaceVariables` 的签名是 `void`，调用方拿不到任何回执
 * （@types/function/variables.d.ts:91）。写盘万一失败，内存里已经是新值、界面显示新值，
 * 而酒馆变量还是旧的 —— 用户看到「保存好了」，重开面板才发现全回退了。
 * 所以这里写完回读一次，把「真写进去了」变成可判断的事实。
 *
 * 返回值只表示**写盘**的结果；`ctx.settings` 在写盘前就已更新（内存先行是既有约定，
 * 当前会话要立刻按新设置跑）。写盘失败时调用方应提示用户并保留「未保存」标记。
 */
export function saveSettings(ctx: RerushContext, patch: Partial<RerushSettings>): boolean {
  ctx.settings = { ...ctx.settings, ...patch };
  const payload = klona(forStorage(ctx.settings));
  try {
    // 写酒馆变量前用 klona 剥掉 Vue 的 proxy 层，否则响应式对象无法正确序列化。
    replaceVariables(klona(payload), { type: 'extension', extension_id: SETTINGS_EXTENSION_ID });
  } catch (error) {
    logWarn(TAG.conf, '设置写盘失败（replaceVariables 抛错）', error);
    return false;
  }
  // 回读核对：不依赖接口给回执，用「读回来的和写下去的像不像」判断。
  // 只比关键几段而不是整份字符串 —— apiKey 落盘前会混淆、来回解一次未必逐字节相同。
  try {
    const readBack = getVariables({ type: 'extension', extension_id: SETTINGS_EXTENSION_ID });
    return settingsLandingLooksRight(payload, readBack);
  } catch (error) {
    logWarn(TAG.conf, '设置写盘后回读失败', error);
    return false;
  }
}

/**
 * 回读核对：比版本号 + 几个稳定字段，而不是整份 JSON。
 *
 * 判据是「够不够发现写盘没生效」，不是「逐字节相同」——apiKey 混淆、zod 补默认值
 * 都会让两边不完全一样，而那些都不是失败。
 */
function settingsLandingLooksRight(written: RerushSettings, readBack: unknown): boolean {
  if (!readBack || typeof readBack !== 'object') return false;
  const got = readBack as Partial<RerushSettings> & Record<string, unknown>;
  // 默认值印章：每次写盘都带着，读回来没有/不一样说明这份根本不是我们刚写的那份。
  if (typeof got.stamp !== 'string' || got.stamp !== written.stamp) return false;
  const gotPlot = got.plot as Partial<RerushSettings['plot']> | undefined;
  if (!gotPlot || typeof gotPlot !== 'object') return false;
  // 再挑三个用户能改、且不涉及密钥混淆的字段：对不上就是真没写进去。
  if (gotPlot.enabled !== written.plot.enabled) return false;
  if (gotPlot.stashMode !== written.plot.stashMode) return false;
  if ((gotPlot.presetName ?? '') !== (written.plot.presetName ?? '')) return false;
  if (Array.isArray(gotPlot.apis) && gotPlot.apis.length !== written.plot.apis.length) return false;
  return true;
}

/**
 * 落盘前把该藏的东西藏起来。
 *
 * **只在写盘这一步做**，`ctx.settings` 内存里始终是明文 —— 否则每发一次请求都要解一遍，
 * 而且面板显示、日志打码全都要跟着改。收敛在这一个函数里最不容易漏。
 *
 * 目前只有一样：剧情推进的 API 密钥（用户 2026-11-01 指定要混淆，防截图/贴日志误露）。
 */
function forStorage(settings: RerushSettings): RerushSettings {
  return {
    ...settings,
    plot: {
      ...settings.plot,
      apis: settings.plot.apis.map((api) => ({ ...api, apiKey: obfuscateApiKey(api.apiKey) })),
    },
  };
}
