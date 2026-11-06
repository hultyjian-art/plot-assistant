/**
 * 脚本核心类型定义。
 * 只用最小接口描述酒馆/酒馆助手 API，不臆造结构。
 */

import type { StoredPlotPreset } from './plot/data/preset-store';

export type { StoredPlotPreset } from './plot/data/preset-store';

/** 一个手势能绑定到的动作。value 会写进酒馆变量，改值要做迁移。 */
export type ActionKey = 'native' | 'full' | 'edit' | 'settings' | 'none';

/**
 * 删层实际走的路径：
 * '增量' = 酒馆自己的批量删除（不重载对话），'重载' = 退回酒馆助手的全量重载。
 * 只用于日志措辞，两条路的结果都是"目标楼层及其后的楼层已删除"。
 */
export type DeletePath = '增量' | '重载';

/**
 * 发送实际走的路径。
 * '按钮' = 点酒馆的发送按钮（唯一会走完整 DOM 事件、因而能被卡片脚本的"发送意图"钩子看到的走法）；
 * '接口' = 界面上找不到按钮时才直调酒馆的发送函数（此时卡片的发送意图门控不会被喂到）；
 * '落空' = 两条都不成，文本还留在输入框里，本轮没有发出。
 */
export type SendPath = '按钮' | '接口' | '落空';

/**
 * 捕获预设。regex 存酒馆风格字面量 `/表达式/标志`。
 * 在设置里按数组顺序组成级联链：越靠前越先尝试。
 */
export interface RegexPreset {
  id: string;
  name: string;
  regex: string;
  note: string;
}

/**
 * 捕获链的取文来源设置。
 * `fromAiFloor` 为真时，级联链改成对"最新用户楼层上方的最近一条 AI 楼层"取文
 * （那条 AI 回复在你上一句之前；刚生成的回复不参与）；
 * 删层起点不动，仍是被定位到的最新用户楼层（见 safety.ts / actions.ts）。
 */
export interface CaptureSettings {
  fromAiFloor: boolean;
}

/** 五个手势各自绑到什么动作。 */
export interface GestureBinding {
  tap: ActionKey;
  double: ActionKey;
  hold: ActionKey;
  triple: ActionKey;
  right: ActionKey;
}

/** 按钮反馈与提示偏好。 */
export interface FeedbackLook {
  /** 受阻时抖动 */
  shake: boolean;
  /** 受阻时染红 */
  flash: boolean;
  /** 关键节点弹气泡 */
  toast: boolean;
  /** 面板主题 id（见 `themes.ts` 的 `PANEL_THEMES`）；老数据没有这个键时读成默认主题 */
  themeId: string;
}

/** 手势判定的两个灵敏度（毫秒）。 */
export interface TimingSensitivity {
  /** 两指间隔小于此值算连击 */
  tapWindowMs: number;
  /** 按下到抬起超过此值算长按 */
  holdMs: number;
}

/** 持久化到酒馆脚本变量的设置结构。 */
export interface RerushSettings {
  /** 默认值印章：改动默认值又想让老用户也吃到时，换一个值（见 settings.ts 的 SETTINGS_STAMP）。 */
  stamp: string;
  bindings: GestureBinding;
  /** 级联链：按顺序依次尝试，首个捕到内容的生效 */
  presets: RegexPreset[];
  /** 级联链对哪一层取文（最新用户楼层 / 最近的 AI 楼层） */
  capture: CaptureSettings;
  look: FeedbackLook;
  timing: TimingSensitivity;
  /** 剧情推进：选中的 ACU 预设名（空串 = 还没选） */
  plot: PlotSettings;
}

/**
 * 剧情推进用的一条 API 配置。
 *
 * 这是**剧情推进助手自己的**一份清单，与 ACU 的 `settings_ACU.apiPresets` 各自独立存储。
 * 从 ACU「一键导入」只是把它的字段抄过来当初始值，之后两边互不影响 ——
 * 这样助手将来脱离数据库单独使用时，用户仍然能自己加 API。
 *
 * 字段对应酒馆助手的 `custom_api`（`@types/function/generate.d.ts` 的 `CustomApiConfig`），
 * 因为我们发任务请求走的是 `generateRaw`，它只认这一套名字。
 */
export interface PlotApiEntry {
  /** 名字，同时是导入时用来判重的键 */
  name: string;
  /** 'tavern' = 跟随酒馆当前连接；'custom' = 用下面这套自定义地址与密钥 */
  apiMode: 'custom' | 'tavern';
  /** 自定义接口地址（apiMode 为 custom 时用） */
  url: string;
  /** 密钥（apiMode 为 custom 时用）。只存在酒馆脚本变量里，日志里一律打码 */
  apiKey: string;
  /** 模型名 */
  model: string;
  /** API 源类型，对应 custom_api.source；空串 = 不传，交给酒馆按地址推断 */
  source: string;
  /** 最大回复 tokens；`'same_as_preset'` / `'unset'` 是酒馆认可的两个特殊值 */
  maxTokens: number | 'same_as_preset' | 'unset';
  /** 温度；同上 */
  temperature: number | 'same_as_preset' | 'unset';
  /**
   * 附加请求体参数（YAML/JSON 原文，运行时由 `plot/api-body.ts` 解析）。
   *
   * 存原文而不是对象有两个理由：面板上它就是一格多行文本，用户要能原样改；
   * 解析失败时也能把这行原文连同错误一起显示，不至于「填了没生效」查不到原因。
   */
  bodyParams: string;
  /** 要从请求体里剔掉的参数名（逗号/顿号/空格分隔）。 */
  excludeBodyParams: string;
  /**
   * 附加请求标头（每行一个 `Header: Value`，原文）。
   *
   * 与「附加请求体参数」成对：有些中转站要用自定义头验签，光靠密钥填不进去。
   * 运行时由 `plot/api-route.ts` 解析成 `custom_include_headers`。
   */
  requestHeaders: string;
  /**
   * 提示词后处理（酒馆的 `custom_prompt_post_processing`）。
   *
   * `'follow'` = 跟随酒馆那一格、完全不动；`''` = 这一轮显式要求不处理；
   * 其余是酒馆认的值（`merge` / `merge_tools` / `semi` / `semi_tools` / `strict` / `strict_tools` / `single`）。
   *
   * 它不是 `custom_api` 的字段（酒馆助手白名单里没有），运行时靠「调用期间借用酒馆设置、
   * 结束立刻还原」生效，见 `plot/post-processing.ts`。
   */
  promptPostProcessing: string;
  /**
   * 超时**不在这里**：它是整页一个设置（`PlotSettings.requestTimeoutSeconds`）。
   *
   * 为什么从每条 API 上拿掉：选「跟随酒馆」时压根没有 API 条目，超时就没地方取了 ——
   * 而那正是最需要保护的人（他连自定义地址都没配，出了事更不会去翻设置）。
   * ACU 把超时放在每条预设上，是因为它永远有一份 apiConfig；我们这里没有这个前提。
   */
  /** ACU 侧的原名字（导入来的才有；手工新建的为空串）。仅用于显示来源，不参与运行 */
  importedFrom: string;
}

/** 剧情推进的脚本级设置。 */
/** 「从……到……」的一对边界词（上下文的提取 / 排除规则都是这个形状）。 */
export interface PlotContextRule {
  start: string;
  end: string;
}

/** `$7 默认上下文`的全局兜底：没选预设时用的那一份。 */
export interface PlotContextDefaults {
  /** 抓最近几条 AI 楼层 */
  turnCount: number;
  extractRules: PlotContextRule[];
  excludeRules: PlotContextRule[];
}

export interface PlotSettings {
  /** 总开关。默认 false —— 关着的时候不跑剧情推进，脚本行为与加功能前一致。 */
  enabled: boolean;
  presetName: string;
  /**
   * 上一轮跑到第几个「轮次」了。触发轮次（每 N 轮跑一次）靠它判断该不该跑。
   * 换聊天不会重置 —— 轮次是跟着这次对话往下数的。
   */
  roundIndex: number;
  /** 自己的一份 API 清单。空 = 还没配（面板会提示去 ACU 导入或手填） */
  apis: PlotApiEntry[];
  /** 跑任务时用哪一条 API（按名字对齐；名字找不到就退回酒馆当前连接） */
  activeApiName: string;
  /**
   * 单次任务调用的超时秒数（`<= 0` = 不设）。
   *
   * 为什么放在这里而不是挂在某条 API 上：超时是「等多久就放弃」的保护，
   * 与用哪条 API 无关。跟着 API 走的话，选「跟随酒馆」的人就完全没有保护了。
   */
  requestTimeoutSeconds: number;
  /**
   * 「解除发送伪装」：true = 等待剧情任务返回期间不显示气泡（只把原文留在输入框）。
   *
   * 默认 false —— 与 ACU 的 `plotSendDisguiseDisabled` 同名同义、默认值也一致。
   * 它**只改等待外观**：无论开关，任务失败或用户终止都不会把正文发出去。
   */
  sendDisguiseDisabled: boolean;
  /** `$1` 用哪几本世界书：character = 角色卡绑定，manual = 下面勾选的那几本 */
  worldbookSource: 'character' | 'manual';
  /** 手动模式勾选的书名 */
  worldbookBooks: string[];
  /**
   * 条目级勾选：`书名 → 允许注入的 uid 列表`。
   * 缺这个键 = 这本书全选；空数组 = 一条都不注入。uid 统一存字符串。
   */
  worldbookEntries: Record<string, string[]>;
  /**
   * `$7 默认上下文`的全局兜底：没选预设时改的就是这一份。
   *
   * 为什么要有一份全局的：条数、提取规则、排除规则本来只存在预设的 `data` 里
   * （ACU 那边也是预设字段），结果是没导入预设的人打开这一页，整块设置直接消失，
   * 只剩一个标题 —— 本末倒置。存一份全局的之后，没预设也能设；
   * 选上预设仍以预设里的为准（预设覆盖全局）。
   */
  contextDefaults: PlotContextDefaults;
  /**
   * 本地预设库：导入来的预设**整份快照**（见 `plot/data/preset-store.ts`）。
   *
   * 有这个之后，运行**先看本地**，本地没有才回去实时读数据库脚本。
   * 这么设计是为了让「导入」真的有意义 —— 导入过的预设，数据库脚本关了也照样能跑。
   */
  presets: StoredPlotPreset[];
  /**
   * 「每个任务上次在第几轮跑过」的账本，键是 `预设名::任务id`（见 `plot/round-book.ts`）。
   *
   * 为什么不写进预设本体：预设是用户会导来导去的配置文件，账混进去会让导出的 JSON
   * 带着「我这边跑到第几轮了」，而且每跑一轮都要改一次预设。
   */
  taskRuns: Record<string, number>;
  /**
   * 推进结果的存放方式（2026-11-03 用户定）：
   *
   * - `'upgrade'`：成果进聊天变量里的暂存账本（本脚本自己的账，每层最多两版）。
   * - `'qrf'`：成果直接写进楼层的 `qrf_plot*` 字段，与数据库脚本那套兼容。
   *
   * 两者**互斥**：同一层不会既有账本又有 qrf 字段。切换时做一次单向迁移并把另一边清掉，
   * 否则两份数据各写各的，用户改了一边另一边不跟着动，就成了"账本说 A、楼层说 B"。
   */
  stashMode: 'upgrade' | 'qrf';
}

/** 本次运行期间的可变状态。 */
export interface RerushState {
  /** 有动作正在执行时为 true，期间不接收新手势 */
  locked: boolean;
  chatKey: string | null;
  /** 全局手势监听的卸载函数，由 gesture.ts 写入，pagehide 时调用 */
  detachListeners?: () => void;
  /**
   * 本次装载的实例 id。
   * 同一脚本被新版替换时，旧实例可能还活着（iframe 未销毁时它的监听仍在父窗口上），
   * 靠这个 id 与父窗口里的注册表判断"我还在不在位"。
   */
  instanceId: string;
}

/** 贯穿各模块的上下文。 */
export interface RerushContext {
  state: RerushState;
  settings: RerushSettings;
  /** 设置保存后的回调，由入口注入（刷新脚本按钮等） */
  onSettingsSaved?: () => void;
}

/** 酒馆消息楼层的最小结构（来自酒馆助手标准接口）。 */
export interface ChatMessageLike {
  message_id: number;
  role: 'system' | 'assistant' | 'user';
  message: string;
}

/** 目标楼层解析的结果。 */
export interface FloorTarget {
  message: ChatMessageLike;
  messageId: number;
}

/** SillyTavern 全局对象的最小接口。 */
export interface TavernLike {
  getContext(): TavernContextLike;
  name1?: string;
  name2?: string;
  eventSource?: {
    on(event: string, listener: (...args: unknown[]) => void): void;
    /** 部分版本才有；卸载时用它摘掉监听，缺了就交给 iframe 回收 */
    removeListener?(event: string, listener: (...args: unknown[]) => void): void;
  };
  /** 把酒馆设置写盘（防抖版，改完连接配置的模型后用它） */
  saveSettingsDebounced?: () => Promise<void>;
  /** 把酒馆设置立刻写盘 */
  saveSettings?: () => Promise<void>;
}

/**
 * 酒馆上下文（`getContext()` 的返回值）里本脚本用得到的部分。
 * 上游字段的名称在 `D:\Github\SillyTavern\public\scripts\st-context.js:128-205` 核实过；
 * `deleteMessages` 与 `sendTextareaMessage` 是 Luker 才有的（`D:\Github\Luker\public\scripts\st-context.js:2512、2811`），
 * 上游酒馆没有，所以两者都声明为可选，调用方负责特性探测与降级。
 */
export interface TavernContextLike {
  chatId?: string;
  chat?: ChatMessageLike[];
  generate?(mode: string): void;
  /** Luker 的批量删层：改 chat 数组、摘掉 DOM 块、一次增量保存，不重载整个对话 */
  deleteMessages?(messageIndices: number[]): Promise<unknown>;
  /** Luker 暴露的发送入口，等价于点发送按钮（读输入框并发出请求） */
  sendTextareaMessage?(): Promise<unknown>;
  /** 酒馆的扩展设置；「API 连接配置」就在 connectionManager 里 */
  extensionSettings?: Record<string, unknown>;
  /** 带 CSRF 令牌的请求头，调酒馆自己的后端接口时要用 */
  getRequestHeaders?: () => Record<string, string>;
  /** 酒馆当前的连接状态字符串，'no_connection' 表示没连上 */
  onlineStatus?: string;
  /** 当前主 API：openai（聊天补全）或 textgenerationwebui 等 */
  mainApi?: string;
}

/** 酒馆里一条「API 连接配置」（connection profile）里本脚本用得到的字段。 */
export interface TavernProfile {
  id: string;
  name: string;
  /** 聊天补全源 id（custom / deepseek / makersuite …） */
  api: string;
  /** 接口地址（反代地址或自定义端点） */
  apiUrl: string;
  /** 密钥编号（可能为空，空则服务端取该源的默认密钥） */
  secretId: string;
  /** 该配置当前使用的模型 */
  model: string;
}

/** 带本脚本自定义挂载点的 Window 描述。 */
export type RerushWindow = Window & {
  SillyTavern?: TavernLike;
  TavernHelper?: { triggerSlash?: unknown };
  toastr?: typeof toastr;
  $?: JQueryStatic;
};
