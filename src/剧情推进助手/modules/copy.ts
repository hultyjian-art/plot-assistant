/**
 * 对外文案唯一来源：日志正文、日志分区标签、气泡提示、设置面板界面文字。
 *
 * 集中于此的目的有二：
 * 1. 同一句提示被多处用到时不再各写各的（改一处即全局生效）；
 * 2. 日志一律走「分区标签 + 纯文本」，不再逐条挂表情符号，Console 里可按标签过滤。
 */
import type { DeletePath, SendPath } from './types';

/** 日志分区标签，配合 logger 的等级一起出现在每行开头。 */
export const TAG = {
  boot: '装载',
  check: '自检',
  mount: '装配',
  hand: '手势',
  route: '派发',
  action: '动作',
  gate: '校验',
  grab: '捕获',
  del: '删层',
  post: '发送',
  conf: '配置',
  plotGate: '推进拦截',
} as const;

/** 日志正文。带参数的写成函数，调用方只负责传事实数据。 */
export const MSG = {
  // —— 发送拦截（剧情推进在发送前跑一轮）
  plotGateNoWindow: '找不到酒馆页面窗口，发送拦截没装上：剧情推进不会在正常发送时自动跑',
  plotGateStart: '拦下本次发送，开始跑剧情推进',
  plotGateStopped: '用户终止了本轮剧情推进，正文不发送',
  plotGateNoTask: '这一轮没有任务要跑，原文原样发送',
  plotGateCrashed: '剧情推进拦截里出错了，原文留在输入框里没有发出去',
  // —— 装载与自检
  booting: '开始装载脚本',
  noTavernHelper: '自检未通过：取不到全局 TavernHelper 对象',
  noTavernHelperWhy: '多半是酒馆助手扩展没启用或版本太旧，核心接口会缺失',
  staleTavernHelper: '这版酒馆助手没有 triggerSlash，建议升级 JS-Slash-Runner',
  wandMounted: '魔法棒菜单里的设置入口已添加',
  qrMounted: 'QR 区的脚本按钮已注册',
  qrAbsent: '自检未通过：QR 区里找不到本脚本按钮',
  qrAbsentBecauseNoBar: '追查原因：页面上没有 #qr--bar 快速回复容器',
  qrAbsentBecauseNotRendered: '追查原因：#qr--bar 在，但按钮没渲染出来，留意扩展版本或 QR 类插件冲突',
  menuAbsent: '自检未通过：设置菜单项没有添加成功',
  mountPartial: '有组件没装到位，到设置面板的运行日志里看具体原因',
  mountPartialTitle: '剧情推进助手装载不完整',
  mountOk: '自检通过：外部依赖与注入项都正常',
  chatSwitched: (chatId: string): string => `聊天切换完成，新聊天标识 ${chatId}`,
  eventMounted: '生命周期监听就位：chat_id_changed',
  noEventSource: '取不到 st.eventSource，聊天切换一类的日志会缺失',
  teardownDone: '脚本卸载，监听器与定时器已回收',
  instanceEvicted: (id: string): string => `已让位给新实例，顺手把旧实例（${id}）的监听与页面节点清掉了`,
  instanceEvictFailed: (reason: string): string => `清理旧实例时出错（不影响本次装载）：${reason}`,
  instanceCleaned: (count: number): string => `清掉 ${count} 个旧实例留在酒馆页面上的残骸（入口/样式/面板容器）`,
  panelStaleRemoved: '发现上一版脚本留下的面板挂载点，已清掉再挂新的',
  panelRaised: '设置面板本来就开着，已把它挪到最前面',
  settingsSaved: '保存好了。',

  // —— 手势识别
  captureChannelReady: (eventType: string): string => `捕获通道收到第一个按下事件，事件族 ${eventType}`,
  buttonHitFirstTime: (eventType: string): string => `脚本按钮第一次被命中，事件族 ${eventType}`,
  gesturesMounted: '全局手势监听就位（挂在父窗口捕获阶段，pointer 为主、mouse 与 touch 兜底）',
  compatFamilySkipped: (eventType: string): string =>
    `pointer 通道已生效，忽略兼容事件族的 ${eventType}（同一次按压不重复计数）`,
  holdFired: '按住的时长到点，判为长按',
  tapSingle: '单击',
  tapDouble: '双击',
  tapTriple: '三击',
  tapHold: '长按',
  tapSingleImmediate: '单击（无需再等下一指）',
  tapDoubleImmediate: '双击（无需等第三指）',
  tapTripleImmediate: '三击（落指即触发）',
  rightClick: '右键',
  keyTrigger: '键盘 Enter 或空格（当作单击）',

  // —— 动作派发
  routed: (gestureName: string, actionKey: string): string => `手势「${gestureName}」派发到动作 ${actionKey}`,
  routedToNothing: '这个手势绑的是「不响应」，本轮直接结束',
  staleInstanceIgnored: '本实例已被新版本接管，这次手势忽略（避免一次点击被处理两遍）',
  openPanel: '派发设置面板',

  // —— 安全校验
  gateBegin: '开始前置校验并定位目标用户楼层',
  blockedWhileEditing: '有历史楼层正处于编辑状态，此时删楼会把酒馆界面卡死，已拦下',
  blockedWhileGenerating: 'AI 还在往外输出，等这一轮说完再重刷',
  blockedByDraft: '输入框里还留着没发出去的草稿，先处理掉再重刷',
  blockedByNotEmptyBox: '输入框不是空的，原生重刷要求先清空它',
  blockedByEditingBrief: '有历史楼层正处于编辑状态，原生重刷已拦下',
  blockedNoUserFloor: '这个聊天记录里一条用户楼层都没有',
  targetLocated: (floorId: number): string => `目标锁定为最新用户楼层：楼层号 ${floorId}`,

  // —— 原生重刷
  nativeBegin: '走原生重刷（等价于酒馆自带的重新生成）',
  nativeByDomId: '原生重刷已触发：直接点到 #option_regenerate',
  nativeByTextMatch: '原生重刷已触发：按文字在页面上找到了重新生成入口',
  nativeByLowLevelApi: '原生重刷已触发：退回底层 ctx.generate 通道',
  nativeEveryPathMissed: '原生重刷失败：三条触发路径一条都没命中',
  nativeCrashed: '原生重刷异常中断',

  // —— 全流程重刷 / 回填修改
  fullBegin: '走全流程重刷',
  fillBegin: '走回填修改',
  blockedNoPreset: '一条捕获预设都还没配置',
  toastNoPreset: '没有可用的捕获预设，请到设置面板的「捕获链」里加一条',
  cascadeBegin: (presetNames: string[]): string => `按优先级依次尝试 ${presetNames.length} 条预设：${presetNames.join(' → ')}`,
  cascadeEveryMiss: (presetCount: number): string => `${presetCount} 条预设轮完，一条都没捕到内容`,
  toastCascadeMiss: (presetCount: number): string => `依次试完了 ${presetCount} 条捕获预设都没命中，检查正则写法或拖动调整优先级`,
  captured: (order: number, presetName: string, text: string): string =>
    `第 ${order} 条「${presetName}」命中，取出 ${text.length} 个字符：${text}`,
  deleteRange: (fromFloor: number, toFloor: number, layerCount: number): string =>
    `准备删除楼层号 ${fromFloor} 到 ${toFloor} 这一段，合计 ${layerCount} 层`,
  toastDeleteRange: (fromFloor: number, toFloor: number, layerCount: number): string =>
    `正在删除 ${fromFloor}~${toFloor} 号楼层，合计 ${layerCount} 层`,
  deleted: (path: DeletePath): string => path === '增量'
    ? '楼层删除完成：走酒馆的增量删除，界面就地摘掉被删楼层，没有重载整个对话'
    : '楼层删除完成：这版酒馆没有增量删除接口，已退回整体重载（大聊天会明显慢）',
  sendCommandIssued: (path: SendPath): string => path === '按钮'
    ? '发送已下达：点到 #send_but（真实点击，卡片脚本挂在按钮上的"发送意图"钩子会跟着触发）'
    : path === '接口'
      ? '发送已下达：界面上找不到 #send_but，改直调酒馆的发送函数——注意这条路上卡片的"发送意图"钩子收不到事件，剧情推进一类触发可能不生效'
      : '发送没下达：既找不到 #send_but，也取不到酒馆的发送函数，文本仍留在输入框里',
  sendCrashed: '酒馆的发送函数抛错，这一轮没能发出，文本还留在输入框里',
  toastSendMissed: '楼层已经删掉，但没能替你发出：文本还留在输入框里，你手动点发送即可',
  toastSent: '内容已替你发出，等 AI 回复',
  filledForManualEdit: '文本已放进输入框，等你改完自己发',
  toastFilled: '内容已填进输入框，可以随时改了再发',
  flowAborted: (reason: string): string =>
    `重刷流程中断：${reason}。楼层到底删没删，请对照上面的日志确认`,
  plotChatSwitched: '推进跑完时聊天已经换掉了，这一轮结果作废：没写输入框、没删楼层、没发送',
  plotStoppedByUser: '已按你的意思终止这一轮推进：输入框和楼层都没动',

  // —— 级联捕获过程
  captureSourceUser: (floorId: number): string => `取文来源：最新用户楼层 ${floorId}`,
  captureSourceAi: (floorId: number, deleteFromFloor: number): string =>
    `取文来源：最新用户楼层上方的最近一条 AI 楼层 ${floorId}（AI楼层模式已开启；删层仍从最新用户楼层 ${deleteFromFloor} 起，这条用户消息和它后面的 AI 回复都会被删掉）`,
  blockedNoAiFloor: 'AI楼层模式开着，但最新用户楼层上方没有 AI 楼层（比如开局第一句就是你发的），无文可取',
  toastNoAiFloor: 'AI楼层模式已开启，但你上一条用户消息之前没有 AI 楼层可取文；关掉勾选即回到从用户楼层取文',
  presetInvalid: (order: number, presetName: string, literal: string): string =>
    `第 ${order} 条「${presetName}」正则不合法，跳过（原写法 ${literal}）`,
  presetNoMatch: (order: number, presetName: string): string => `第 ${order} 条「${presetName}」没匹配上，接着看下一条`,
  presetBlankHit: (order: number, presetName: string): string =>
    `第 ${order} 条「${presetName}」只捕到空白字符，按没捕到处理，接着看下一条`,

  // —— 设置读写
  legacyPresetPromoted: (presetName: string): string => `旧设置里勾选的「${presetName}」已放到级联链第 1 位`,
  settingsLoadFailed: '读脚本变量里的设置失败，这一轮先用默认值',
  settingsMigrated: '旧位置的设置已经搬到固定位置，以后换脚本也不会再丢',
  settingsDefaultsMigrated: '默认值升级过一次：右键的默认动作已改成「回填修改」',
} as const;

/** 设置面板界面文字。 */
export const UI = {
  /** 标题与菜单提示都带产物名 */
  panelTitleOf: (name: string): string => `${name}设置`,
  menuTooltipOf: (name: string): string => `打开${name}的设置`,
  /** 左侧功能列：两个大功能，点哪个右边就进哪一套页面 */
  sections: {
    rerush: '推进重刷',
    plot: '剧情推进',
  },
  tabs: {
    bindings: '手势绑定',
    capture: '捕获链',
    feedback: '反馈与日志',
  },
  /** 剧情推进那一套的标签页 */
  plotTabs: {
    preset: '预设与开关',
    tasks: '任务清单',
    assets: '暂存与日志',
    apis: 'API 配置',
  },
  /** 剧情推进页的文案 */
  plot: {
    /** 四页的页签：版式照工作流助手，一页一件事 */
    pageApi: 'API',
    pageContext: '世界书与上下文',
    /** 窄屏页签用的短名（照工作流助手：全名在宽屏，短名在窄屏） */
    pageContextShort: '上下文',
    pageTasks: '任务',
    pageStash: '暂存',
    pageLogs: '日志',
    pagePrev: '上一页',
    pageNext: '下一页',

    /** 发送拦截：等待气泡与「解除发送伪装」 */
    bubbleTitle: '剧情推进',
    bubbleRunning: '推进中，稍后自动落成楼层',
    bubbleStop: '终止',
    bubbleStopping: '正在终止…',
    disguiseLabel: '解除发送伪装',
    disguiseHint:
      '默认关闭。开启后原文留在输入框等待剧情 AI 返回，不显示等待气泡或生成中外壳。此开关只改变等待外观：任务成功后由酒馆继续本次发送，最终失败或手动终止都不会把正文发出去。',

    /** 总开关那一行 */
    enableLabel: '剧情推进总开关',
    enableHint:
      '打开后，每次点重刷、在把正文交给 AI 之前，会先按预设里的任务跑几个小请求，把结果整理成一段推进内容接在你的输入后面。关着的时候，脚本行为与没有这个功能时完全一样。',
    enableHintOff: '现在是关着的。打开它的时候会顺手把数据库脚本那边的剧情推进关掉，免得两边同时跑。',
    /** 打开总开关时顺手关 ACU 剧情推进的结果 */
    acuPlotOnWarn: '数据库脚本的剧情推进也开着 —— 两边一起开会同时跑两轮。去那边把它关掉吧。',
    acuPlotCloseFailed: (why: string): string => `想替你把数据库脚本的剧情推进也关掉，但没成功：${why}`,

    /** 预设选择 */
    presetLabel: '剧情推进预设',
    presetHint:
      '预设来自数据库脚本，列在这里的是它里面具名的那些。选中的名字会记在本脚本设置里，之后每轮都用它。',
    presetDefaultNotOffered:
      '这里刻意不提供「默认预设」这一项：数据库脚本的默认预设内容只在它自己内存里，对外读不到，选了也拿不到任务。想用哪套就在它那边另存一个具名预设，再回来选。',
    presetRefresh: '刷新',
    presetRefreshHint: '重新读一遍本地预设库（导入、删除之后想马上看到时用）',
    presetEmpty: '还没读到任何预设。',
    presetNone: '还没选预设。',
    presetPicked: '本地已有',
    presetAcuUsing: (name: string) => `数据库脚本当前对这张卡用的是「${name}」。`,

    /** 本地预设库（从数据库抄进来的一份完整副本） */
    presetStoreTitle: '本地预设库',
    presetStoreHint:
      '这里的每一份都是导入时抄下来的完整副本。导入之后数据库那边改了、删了、甚至脚本根本没加载，这边都照旧能用。',
    presetImportAll: '从数据库导入',
    presetStoreEmpty: '本地还没有预设。点上面的「从数据库导入」，把数据库里的预设抄一份过来。',
    presetStoreDelete: '删掉这份本地副本',
    presetImportDone: (added: number, replaced: number, kept: number, skipped: number) => {
      const parts = [`新增 ${added} 份`];
      if (replaced > 0) parts.push(`覆盖 ${replaced} 份`);
      if (kept > 0) parts.push(`${kept} 份重名已保留你本地的版本`);
      if (skipped > 0) parts.push(`${skipped} 份读不出来被跳过`);
      return `导入完成：${parts.join('，')}。`;
    },

    /** 预设编辑器（改的是本地库里的副本，绝不写数据库脚本） */
    presetEditOpen: '编辑这份预设',
    presetEditNotLocal:
      '这份预设是实时从数据库脚本读的，本页不写它任何东西。想改就先点上面的「从数据库导入」抄一份到本地，再编辑本地那份。',
    presetEditIntro:
      '改的是本地库里这份副本，数据库脚本那边不会被动到。改完点「应用修改」，再点面板底部的「保存设置」才真正落盘。',
    presetEditApply: '应用修改',
    presetEditCancel: '取消',
    presetEditApplied: (size: string) => `已写进面板草稿（${size}）。别忘了点面板底部的「保存设置」。`,
    presetEditNameEmpty: '预设名不能为空。',
    presetEditNameTaken: (name: string) => `本地库里已经有叫「${name}」的预设了，换个名字。`,
    presetEditTooBig: (size: string, limit: string) => `这份预设太大了：${size}，上限 ${limit}。删掉一些提示词再存。`,
    presetEditWarnPrefix: '还能存，但跑起来会有问题：',
    presetEditNoTasks: '一个任务都没有 —— 跑一轮不会请求 AI，正文里只会多一段空指令。',

    /** 预设编辑器：基础信息 */
    editorMeta: '基础信息',
    editorName: '预设名',
    editorTurn: '取多少条前文',
    editorTurnHint: '提示词里的 $7 按这个条数取前文摘要，引擎缺省按 1 条算。',

    /** 预设编辑器：最终注入指令 */
    editorPrompts: '最终注入指令',
    editorPromptsHint: '这一段是整份预设共用的底稿，跑完之后接在你的输入后面；每个任务自己的提示词在下面「任务」里。',
    editorPromptFinal: '正文',
    editorPromptFinalHint: '这一段的正文会在跑完之后接在你的输入后面。留空 = 什么都不注入。',

    /** 预设编辑器：标签与规则 */
    editorTags: '标签筛选',
    editorExtractRules: '提取规则',
    editorExcludeRules: '排除规则',
    editorRuleHint: '按「起止边界字符串」匹配（不是正则），例如起点 <disclaimer、终点 </disclaimer>。只作用在 $7 抓来的前文上。',
    editorRuleStart: '起点',
    editorRuleEnd: '终点',
    editorRuleAdd: '加一条',
    editorRuleDrop: '删掉这条',
    editorRuleRowEmpty: '未填（点开填起止）',
    editorRulesEmpty: '没有规则 = 原样使用。',

    /** 预设编辑器：任务 */
    editorTask: '任务',
    editorBlock: '提示词块',
    editorTaskBlocksSomeOff: '有块是关着的 —— 关掉的块不会发给 AI。',
    editorTasks: '任务',
    editorTasksHint: '一轮里按「阶段」顺序跑：同一阶段并发，下一阶段等上一阶段全部回来。',
    editorTaskAdd: '加一个任务',
    editorTaskDrop: '删掉这个任务',
    editorTaskName: '任务名',
    editorTaskEnabled: '启用',
    editorTaskStage: '阶段',
    editorTaskOrder: '顺序',
    editorTaskMaxRetries: '重试次数',
    editorTaskApi: '这个任务的 API',
    editorTaskApiGlobal: '跟「当前 API」走',
    editorTaskApiHint:
      '单独挑一条的话，这个任务的请求就走那一条；留空就用 API 页里选中的那条。想把重活分给好一点的接口，就靠这一格。',
    editorTaskMinLength: '最少字数',
    editorTaskEvery: '每几轮跑一次',
    editorTaskEveryHint: '1 = 每轮都跑；填 3 = 每三轮回一次。',
    editorTaskTags: '抽取标签',
    editorTaskInject: '只留字段',
    editorTaskCopy: '复制',
    editorTaskCopyHint: '跨预设复制：先把它放进剪贴板，再切到另一份预设点「粘贴」',
    editorTaskPaste: '粘贴',
    editorTaskPasteEmpty: '剪贴板里还没有任务 —— 先在别的预设里点「复制」',
    clipFrom: '来自',
    editorTaskBlocks: '提示词块',
    editorTaskBlocksHint: '关掉的块不会发给 AI；块按这里的顺序发，可以复制、上下移。',
    editorBlockRole: '角色',
    editorBlockName: '块名',
    editorBlockAddTop: '＋ 在最上方插入',
    editorBlockAddBottom: '＋ 在最下方插入',
    editorBlockCopy: '复制',
    editorBlockSend: '跨预设复制',
    editorBlockSendHint: '把这复制到另一份预设的任务里：先切预设，再在那边点「粘贴块」',
    editorBlockPaste: '粘贴块',
    editorBlockPasteEmpty: '剪贴板里还没有块 —— 先在别处点「跨预设复制」',
    editorBlockDrop: '删掉',
    editorBlockUp: '上移',
    editorBlockDown: '下移',
    editorBlockOn: '开',
    editorBlockOff: '关',
    editorTaskNoBlocks: '这个任务的提示词块全关了 —— 它会被跳过，不请求 AI。',

    /** 导入 / 导出 */
    ioTitle: '导入 / 导出',
    ioHint: '导出的格式与数据库脚本一致（一个 JSON 数组），它能直接吃下；它导出的文件这里也能直接导入。',
    ioImportFile: '导入',
    ioImportFileHint: '挑一个 JSON 文件，同名会覆盖本地那份。',
    ioExportHint: '把当前选中的预设存成 .json，可以直接喂给数据库脚本的「导入预设」。',
    ioPaste: '粘贴 JSON',
    ioPastePlaceholder: '把预设 JSON 粘在这里（数组、单个预设对象、或 {presets:[...]} 都行）',
    ioPasteDo: '导入这段 JSON',
    ioExport: '导出',
    ioExportCopy: '复制',
    ioExportDownload: '下载 .json',
    ioExportEmpty: '先在列表里选一份预设，再导出。',
    ioExportCopied: '已复制到剪贴板。',
    ioImported: (added: number, replaced: number, skipped: number) => {
      const parts = [`导入 ${added} 份`];
      if (replaced > 0) parts.push(`覆盖同名 ${replaced} 份`);
      if (skipped > 0) parts.push(`${skipped} 份没名字被跳过`);
      return `${parts.join('，')}。`;
    },
    ioFailed: (reason: string) => `导入失败：${reason}`,

    /** 预设工具栏（照工作流助手：下拉框旁边一排动作用按钮） */
    presetActionSave: '应用',
    presetActionSaveHint: '把这一页的改动写进这份预设。落盘还要点面板底部的「保存」。',
    presetActionNewHint: '新建一份空预设并切过去',
    presetActionDuplicateHint: '把当前这份复制一份另起名字',
    presetActionDeleteHint: '从本地库里删掉当前这份（数据库那边不受影响）',
    presetActionNew: '新建',
    presetActionNewBase: '新预设',
    presetActionDuplicate: '另存',
    presetActionDelete: '删除',
    presetCreated: (name: string) => `已新建并切到「${name}」，改完记得点「保存」。`,
    presetDeleted: (name: string) => `已删除本地预设「${name}」。数据库那边那份不受影响。`,

    /** 上下文页 */
    contextTitle: '$7 默认上下文',
    contextHint: '这一节决定提示词里的 $7 换成什么：取最近几条 AI 楼层，再按下面的规则只留／剔掉一部分。',

    /** 占位符说明（照 ACU 那一套，不是工作流助手的） */
    placeholderTitle: '占位符说明',
    placeholderHint:
      '上面这些是提示词里能用的全部占位符，写进正文就会在发送前被换成实际内容。工作流助手的 $2（托管条目）与「$6 记忆回溯」在我们这里没有 —— 那是它世界书写入功能的配套。',
    placeholderLegend: [
      { code: '$U', desc: '用户人设（酒馆里的 persona 描述 + 主角信息）' },
      { code: '$C', desc: '当前角色卡的描述' },
      { code: '$1', desc: '本轮命中的世界书内容，会包进 <worldbook_context> 信封；内容为空时整个信封消失' },
      { code: '$9', desc: '世界书里剔掉数据库生成条目后的那一份，同样走信封' },
      { code: '$5', desc: '纪要索引（世界书里的纪要条目）；取不到就用纪要表的概要与编码索引列，再取不到就用总体大纲表' },
      { code: '$7', desc: '默认上下文：最近 N 条 AI 楼层，按上面的提取／排除规则处理过' },
      { code: '$6', desc: '上一轮剧情推进的输出（<plot> 那一段）' },
      { code: '$8', desc: '本轮的玩家输入（也就是你刚发的那句话）' },
    ],

    /** 世界书预留位 */

    /** 任务清单 */
    tasksLabel: '这套预设里有哪些任务',
    tasksHint:
      '这里列出的是选中预设里的任务，只做展示。要改提示词、开关、触发轮次，去「预设与开关」页点「编辑这份预设」—— 改的是本地库里那份副本，数据库脚本那边不会被动到。',
    tasksEmpty: '还没选预设，或者这套预设里没有任务。',
    taskEnabled: '启用',
    taskDisabled: '已停用',
    taskStage: (stage: number): string => `第 ${stage} 阶段`,
    taskTags: (tags: string): string => `抽取标签：${tags}`,
    taskInjectTags: (tags: string): string => `只留字段：${tags}`,

    /** 暂存与日志 */
    logsTitle: '运行日志',
    assetsHint:
      '暂存的账本和每轮的运行日志都存在聊天变量里，跟着聊天文件走：换个聊天就是另一份，不会串。',
    assetsLogHint: '下面是本脚本的运行日志（和剧情推进助手那一套共用同一个日志缓冲）。',

    /** 暂存区（断点续跑的那份账） */
    stashTitle: '暂存区',
    stashHint:
      '每一层用户楼层都有自己的推进成果。同一层最多留两版（第三次会挤掉最旧的那版）；点开一版可以看内容、改文字、按标签删掉某一块 —— 只有点「保存」才真的写进去。',
    stashEmpty: '还没有暂存的成果。跑一次剧情推进，成功之后就会出现在这里。',
    stashRefresh: '刷新',
    stashFloor: (floorId: number): string => `第 ${floorId} 楼`,
    stashPending: (pending: number): string => `未完成，还欠 ${pending} 个任务`,
    stashResumeHint: '点发送会接着这一版没跑完的任务继续跑。',
    stashComplete: '已完成',
    stashPreset: (name: string): string => `预设：${name}`,
    stashUnreadable: '暂存账本读不出来（原文已另存），这里先显示空。',
    stashViewerClose: '关掉',
    stashSave: '保存',
    stashSaved: '已保存',
    stashSavedSynced: (floorId: number): string => `已保存，并同步进第 ${floorId} 楼正文。`,
    stashInUse: '使用中',
    stashVersion: (seq: number): string => `第 ${seq} 版`,
    stashModeLabel: '推进结果存在哪',
    stashModeUpgrade: '升级模式',
    stashModeQrf: 'qrf 模式',
    stashModeUpgradeHint:
      '成果记在本脚本自己的账本里（聊天变量）。每层最多留两版，能在「暂存」页切换、编辑、重跑；楼层正文只放最终注入指令。',
    stashModeQrfHint:
      '成果直接写进楼层的 qrf_plot 字段，与数据库脚本那套兼容。一层只有一版，没有「暂存」页。',
    stashModeBusy: '正在搬运已有成果…',
    stashQrfModeNote: '当前是 qrf 模式：成果直接写进楼层字段，一层一版，这里没有可切换的版本。',
    stashDirtyClose: '这一版还有没保存的改动，关掉就没了。',
    stashDirtyStay: '继续编辑',
    stashDirtyLeave: '放弃改动并关掉',
    stashTextLabel: '正文（可以直接改）',
    stashTagsLabel: '标签块（点 × 删掉这一块）',
    stashNoTags: '这一版里没有独立的标签块。',
    stashGapHint: (tags: string, tasks: number): string =>
      `这一版现在缺 ${tags}。下次拿它生成楼层时，会自动把产出这些标签的 ${tasks} 个任务重跑一遍补回来。`,
    stashTagRemoved: (tag: string): string => `已删掉 <${tag}>，点「保存」才生效`,
    stashTagMissing: (tag: string): string => `没找到 <${tag}>`,
    stashEditTarget: (floorId: number, label: string): string => `第 ${floorId} 楼 · ${label}`,
    stashApply: '应用到楼层',
    stashApplyFailed: '写入楼层失败。',
    stashApplied: '已写回楼层正文（只换了 <plot> 那一段，你的原话还在）。',
    stashRerun: '重跑正文',
    stashRerunFailed: '没找到输入框，填不进去。',
    stashRerunOk: '已把这一版放回输入框，确认无误后点发送。',
    stashUseDirty: '先把改动保存（或放弃）再动楼层，免得用上没保存的内容。',
    stashDelete: '删除这一版',
    stashDeleteConfirm: '这一版删掉就找不回来了（楼层里已经写进去的内容不受影响）。确定删？',
    stashDeleteCancel: '先不删',
    stashDeleteOk: '删掉',
    stashDeleted: '这一版已删除。',
    stashDeleteMissing: '这一版已经不在账本里了（可能刚被挤掉），刷新一下再看。',

    /** 运行日志（每轮每个任务：提示词、回传、耗时、重试、报错） */
    logTitle: '运行日志',
    logHint: '每一轮剧情推进的每个任务都记一条：提示词开头、AI 原样回传、抽到的标签、耗时、重试次数。失败原因写在最前面。最近 20 轮，更早的会被挤掉。',
    logEmpty: '还没有运行日志。跑一次剧情推进就会记下来。',
    logUnreadable: '日志读不出来（原文已另存），这里先显示空。',
    logRefresh: '刷新',
    logExport: '导出 md',
    logExportOk: '已复制到剪贴板，直接粘给我就行。',
    logExportFallback: '复制失败，已改成下载 plot-log.md。',
    logRound: (roundIndex: number, floorId: number): string => `第 ${roundIndex} 轮 · 第 ${floorId} 楼`,
    logRoundMeta: (preset: string, at: string, count: number): string => `${preset} · ${at} · ${count} 个任务`,
    logStatusRunning: '进行中',
    logStatusOk: '全部成功',
    logStatusPartial: '部分失败',
    logStatusFailed: '失败',
    logTaskLine: (stage: number, attempt: number, ms: number): string => `阶段 ${stage} · 第 ${attempt} 次 · ${ms} ms`,
    logTasksLabel: '任务明细',
    logPromptLabel: '提示词开头',
    logRawLabel: '原始回传',
    logSentLabel: '发送给 AI 的内容',
    logSentHint: '一块一条，点开看这一块到底写了什么。',
    logReasoningLabel: 'AI 推理内容',
    logReasoningEmpty: '这次没有拿到推理内容 —— 酒馆的生成接口只回正文，不把模型的思考过程交出来。',
    logBlockTitle: (role: string, name: string): string => (name === '' ? role : `${name} · ${role}`),
    logBlockSize: (chars: number): string => `${chars} 字`,
    logExpand: '展开查看',
    logTabsHint: '上面一条一个任务，点它切到那个任务的发送内容与回传。',
    logTabEmpty: '（这一轮还没有任务落账）',
    logTagsLabel: '标签',
    logErrorLabel: '报错',
    logNoRaw: '（没有回传）',
    logNoTags: '（没抽到标签）',
    logRoundError: (reason: string): string => `整轮失败：${reason}`,


    /** API 配置 */
    apisLabel: '剧情推进用的 API',
    apisTitle: 'API 预设',
    apisHint:
      '这里的 API 是剧情推进助手自己的一份清单，和数据库脚本的 API 预设各自独立存储 —— 改这边不会动它，改它也不会动这边。',
    apisCurrent: '当前 API',
    apisPickHint: '点名字只是翻看这一条（下面只显示它）；点名字右边的 ★ 才把它设成默认，新聊天也用它。',
    apisSetDefault: '设为默认',
    apisSetDefaultOk: (name: string) => `已把「${name}」设为默认 API。`,
    apisNoneOption: '（还没有 API）',
    apisImport: '从数据库脚本导入',
    apisImportHint:
      '只是把数据库脚本里现有的 API 预设抄一份过来当初始值。重名的默认保留你这边已经改过的版本，不会被覆盖。',
    apisAdd: '手动新增一条',
    apisEmpty: '还没有任何 API。可以从数据库脚本导入，也可以自己新增一条。',
    apisUse: '当前使用',
    apisUsePick: '点这里用这条',
    apisModeCustom: '自定义地址',
    apisModeTavern: '跟随酒馆',
    apisName: '名字',
    apisUrl: '接口地址',
    apisKey: '密钥',
    apisModel: '模型',
    apisModelPick: '模型列表',
    apisModelPickHint: '从拉取到的模型里挑一个',
    apisPullModels: '拉取模型',
    apisPullModelsBusy: '拉取中…',
    apisPullModelsOk: (count: number) => `拉到 ${count} 个模型，在下面的「模型列表」里挑。`,
    apisPullModelsFailed: (reason: string) => `拉取失败：${reason}`,
    apisSource: '接口协议',
    apisMaxTokens: '回复上限',
    apisTemperature: '温度',
    apisTimeout: '超时（秒）',
    /**
     * 超时是真的会生效的：到点用「按 id 停止生成」把那一次请求掐掉，再按接口失败处理、交给重试。
     * 两条用户必须知道的边界写在文案里：填 0 = 不设；它只管「多久没回音就放弃」，不管整轮总耗时。
     */
    apisTimeoutHint:
      '秒数到了还没回音，就掐掉这次请求并按接口失败重试（与数据库脚本的做法一致）。填 0 = 不设超时。注意它管的是「单次请求多久没响应就放弃」，不是整轮的总时长。',
    apisImportedFrom: (name: string): string => `导入自数据库脚本：${name}`,
    apisDelete: '删除这条',
    apisExpand: '展开设置',
    apisCollapse: '收起',
    previewOpen: '预览这次会发什么',
    previewOpenHint: '拿真数据把占位符换掉再给你看，不写设置、不发请求。',
    previewTitle: '这一轮会发给 AI 的内容',
    previewHint: '这里就是这一次真正发给 AI 的请求内容（占位符已换成真值）。点任务名切任务；$1 世界书与 $5 纪要都按当前聊天现读。',
    previewBusy: '正在拼提示词……',
    previewRoundMeta: (preset: string, round: number, count: number) => `预设：${preset} · 第 ${round} 轮 · 要跑 ${count} 个任务`,
    previewSkipped: (count: number) => `另有 ${count} 个任务按轮次规则被跳过。`,
    previewNoTask: '这一轮没有任务要跑：可能全部停用、提示词块全关，或者都没到触发轮次。',
    previewTaskMeta: (stage: number, order: number, count: number) => `阶段 ${stage} · 顺序 ${order} · ${count} 条消息`,
    // —— 世界书（`$1`）——
    worldbookSection: '世界书（$1）',
    worldbookHint:
      '这里决定任务提示词里的 $1 是哪几本书。默认跟随角色卡绑定的世界书；要拿没绑到角色卡上的全局设定书，就切成手动勾选。',
    worldbookFollow: '跟随角色卡',
    worldbookManual: '手动选择',
    worldbookRefresh: '刷新书单',
    worldbookLoading: '读取中…',
    worldbookEmpty: '没读到任何世界书。检查一下酒馆里是不是还没有世界书。',
    worldbookPickHint: '勾哪几本，$1 就只带哪几本的内容；一本都不勾等于没有 $1。',
    worldbookSearch: '搜书名…',
    worldbookCount: (shown: number, total: number) => `${shown} / ${total} 本`,
    worldbookNoMatch: '没有书名含这几个字的世界书。',
    // —— 世界书条目（`$1` 的条目级勾选）——
    worldbookEntrySection: '条目',
    worldbookEntryHint:
      '这里列出上面那几本书里的条目，取消勾选的条目不会进 $1。只影响剧情推进读到的内容，不会改动世界书本身。',
    worldbookEntryLoad: '读取条目',
    worldbookEntryLoading: '读取中…',
    worldbookEntryEmpty: '这几本书里没有可勾选的条目。',
    worldbookEntryNoMatch: '没有名字含这几个字的条目。',
    worldbookEntryAll: '全选',
    worldbookEntryNone: '全不选',
    worldbookEntryCount: (on: number, total: number) => `${on} / ${total} 条`,
    worldbookEntrySearch: '搜条目名…',
    worldbookEntryBlockedTag: '自动排除',
    worldbookEntryDbTag: '数据库',
    worldbookEntryPrimaryTag: '主书',
    worldbookEntryAdditionalTag: '附加',
    worldbookEntryBlockedHint:
      '名字里带「规则 / 变量 / MVU / 状态 / 格式」这类词的条目、以及数据库脚本生成的条目，本来就不会进 $1（和上游一致），所以这里标出来。',
    worldbookEntryReadError: (message: string) => `读条目失败：${message}`,
    apisKeyHint:
      '密钥存在酒馆的脚本变量里，存之前会做一层混淆，面板与日志一律打码显示。这层混淆只能防「截图 / 贴给别人时不小心露出来」，不是加密——能跑脚本读你浏览器存储的人照样拿得到。',
    apisNoActive:
      '还没指定用哪一条。不指定时，任务调用会走酒馆当前的连接配置（等同于「跟随酒馆」）。',
    /** 附加请求体参数（与数据库脚本 / 工作流助手同一件事） */
    apisBodyParams: '附加请求体参数',
    apisBodyParamsHint: '每行一个「键: 值」，也可以贴 JSON。比如：\nthinking:\n  type: disabled',
    apisExcludeParams: '排除参数',
    apisExcludeParamsHint: '要从请求体里剔掉的参数名，用逗号或空格分隔，比如 top_p, reasoning_effort',
    apisRequestHeaders: '附加请求标头',
    apisRequestHeadersHint: '每行一个「名字: 值」，会追加到请求头上。没冒号的行会拦下来报错，不静默丢掉。',
    apisExtrasWarn: '两格都填着：这一格改请求体、上面那格改请求头，互不覆盖。同一个名字两边都写时，以对方怎么读为准。',
    apisSourceCustom: 'OpenAI 兼容',
    apisSourceOpenai: 'OpenAI 官方',
    apisSourceClaude: 'Claude Messages',
    apisSourceGemini: 'Gemini',
    apisSourceHint: 'Claude / Gemini 走酒馆原生协议；其余都是 OpenAI 兼容接口。选错的话请求会直接失败，不会悄悄换个协议再试。',
    apisDeepSeekCot: 'DeepSeek：关思考',
    apisDeepSeekJson: 'DeepSeek：严格 JSON',
    apisDeepSeekCotDone: '已写入「关思考」。改完记得点保存。',
    apisDeepSeekJsonDone: '已写入「严格 JSON」。改完记得点保存。',
    /**
     * 这句话必须写在面板上：这些参数只在接口协议选 custom 时生效。
     * 不写的话，用户在 DeepSeek 官方源下填了参数、发现没反应，会当成 bug 来报。
     */
    apisBodyNote:
      '这两格只在接口协议选 custom（自定义地址）时生效 —— 酒馆只在那一个分支里读它们。选 DeepSeek / OpenAI 官方源时填了也会被丢掉。',
    apisBodyBroken: (reason: string): string => `参数没生效，这一轮没跑：${reason}`,

    /**
     * 提示词后处理。文案要交代清楚「它其实是借酒馆那一格」——
     * 否则用户改了这里、又去酒馆设置里看，会以为两边各自独立、互相打架。
     */
    apisPostProcess: '提示词后处理',
    apisPostProcessFollow: '跟随酒馆（不动）',
    apisPostProcessNone: '不处理',
    apisPostProcessMergeTools: '合并相同角色连续的发言',
    apisPostProcessSemi: '半严格（强制对话角色交替）',
    apisPostProcessStrict: '严格（强制角色交替、用户最先）',
    apisPostProcessSingle: '单一用户消息',
    apisPostProcessHint:
      '这一格借的是酒馆设置里的「提示词后处理」：调用期间临时改成这里选的值，调用一结束立刻还原。选「跟随酒馆」就完全不动它。',

    /** 预设读不到的说明 */
    presetProblemPrefix: '读不到预设：',
  },
  gestureRows: {
    tap: '单击',
    double: '双击',
    hold: '长按',
    triple: '三连击',
    right: '右键',
  },
  /** 下拉框里可选的动作。value 是持久化用的枚举，勿随意改。 */
  actionChoices: [
    { value: 'native', label: '原生重刷' },
    { value: 'full', label: '全流程重刷' },
    { value: 'edit', label: '回填修改' },
    { value: 'settings', label: '打开设置' },
    { value: 'none', label: '不响应' },
  ],
  timingRows: {
    tapWindow: '点击间隔',
    holdSpan: '按住时长',
  },
  timingHints: {
    tapWindow: '两指之间隔多久以内算连击。调小触发更快，但更容易把一次连击误判成单击',
    holdSpan: '按住多久算长按。调小更跟手，但容易和快速点击混淆',
  },
  switchRows: {
    shake: '受阻时抖动',
    flash: '受阻时染红',
    toast: '关键节点弹气泡',
  },
  captureRows: {
    aiFloor: 'AI楼层模式（从最新用户楼层上方的 AI 楼层取文）',
  },
  captureHints: {
    off: '按下面的顺序对最新用户楼层逐条尝试捕获：先命中的那条生效，全部落空才报错并抖动。按住条目可以拖动排序。',
    on: '已开启：下方正则不再对最新用户楼层取文，改为对它上方最近的那条 AI 楼层逐条尝试——也就是"你上一句消息之前 AI 说的那段"，刚生成的那条回复不参与。其它规则不变：先命中的生效、全部落空才报错并抖动、按住条目可拖动排序。删层范围没有跟着改：仍从最新用户楼层删到末尾，所以你上一条用户消息和它后面的 AI 回复都会被删掉，发出去的是从上面那条 AI 楼层里取到的文本。',
  },
  captureEmptyHint: '当前一条预设都没有，重刷会直接报错，请先新增。',
  presetDragTitle: '鼠标按住条目即可拖动；触屏按住左边的 ⠿ 拖动排序（拖到边缘会自动滚动）',
  regexEditor: {
    name: '名称',
    namePlaceholder: '例：剧情推进',
    pattern: '正则写法',
    patternPlaceholder: '例：/[\\s\\S]*/ 或 /<user_input>([\\s\\S]*?)<\\/user_input>/',
    patternHint:
      '与酒馆正则同款写法：/表达式/标志，标志可留空。要吃下换行请写 [\\s\\S]（内置两条都这么写，不依赖 s 标志）；s 是让 . 也吃换行，i 是忽略大小写。',
    note: '备注',
    notePlaceholder: '这条正则打算抓出哪部分内容',
  },
  themeLabel: '主题',
  themeHint: '配色。奶龙配色是数据库那边的默认主题。',
  buttons: {
    addPreset: '新增一条正则',
    editPreset: '编辑这条',
    deletePreset: '删除这条',
    cancel: '取消',
    save: '保存',
    discard: '放弃修改',
    unsaved: '有改动还没保存',
    close: '关闭',
    sections: '切换功能（推进重刷 / 剧情推进）',
    reset: '恢复默认',
    clearLog: '清掉以上记录',
  },
  logPlaceholder: '还没有日志，先点一次按钮试试',
  /** 用户新建的正则没填名称时用的占位名 */
  unnamedPreset: '没名字',
} as const;
