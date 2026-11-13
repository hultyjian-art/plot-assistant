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
  settingsSaveFailed: '设置没能存进酒馆，可能是酒馆变量写入失败，请重试；若反复失败请重载脚本。',
  settingsPresetInvalid: (reason: string): string => `预设校验未通过，全部改动未保存：${reason}`,

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
  plotChatSwitched: '推进跑完时聊天已经换掉了，这一轮结果作废：原文已放进输入框，旧聊天的楼层已按重刷流程删除，这一轮不发送',
  plotStoppedByUser: '已按你的意思终止这一轮推进：原文已放进输入框，楼层已按重刷流程删除，这一轮不发送',

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
  /** 标题与菜单提示都带产物名：完整版「剧情推进助手」，轻量版「剧情推进助手·轻」 */
  panelTitleOf: (name: string): string => `${name}设置`,
  menuTooltipOf: (name: string): string => `打开${name}的设置`,
  /** 左侧功能列：三个大功能，点哪个右边就进哪一套页面 */
  sections: {
    rerush: '推进重刷',
    plot: '剧情推进',
    guide: '使用说明',
  },
  tabs: {
    bindings: '手势绑定',
    capture: '捕获链',
    feedback: '反馈与日志',
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
    bubbleProgress: '推进中',
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
    /** 打开总开关时，若数据库脚本那边的剧情推进也开着，弹这条提醒（只提醒，不代关） */
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

    /** 预设编辑器：标签差量 */
    editorTagDiff: '标签差量',
    editorTagDiffHint:
      '按标签单独设置：关闭 = 每轮全量；整标签保留 = 没输出就沿用上一轮；按块合并 = 只写变动的 ### 小节；按表格行 = 只写变动的表格行（首列作键，【删除】可删行）。',
    editorTagDiffEmpty: '这个预设里还没有标签。先在任务的「抽取标签」里写标签名，或在最终注入指令里用 {{标签}}。',
    tagDiffOff: '关闭（每轮全量）',
    tagDiffKeep: '整标签保留',
    tagDiffBlocks: '按块合并',
    tagDiffTable: '按表格行合并',

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
    editorTaskMaxRetries: '重试次数',
    editorTaskApi: '这个任务的 API',
    editorTaskApiGlobal: '跟「当前 API」走',
    editorTaskApiHint:
      '单独挑一条的话，这个任务的请求就走那一条；留空就用 API 页里选中的那条。想把重活分给好一点的接口，就靠这一格。',
    editorTaskMinLength: '最少字数',
    editorTaskEvery: '每几楼进行一次',
    editorTaskEveryHint: '1 = 每条用户楼层都跑；填 3 = 每隔 3 条用户楼层跑一次。只数用户发的楼层（被隐藏的也算），AI 回复不算；删层重刷不新增楼层，所以不会误触发。手动触发开启的任务不受间隔限制。',
    editorTaskManual: '手动触发',
    editorTaskManualHint: '开启后任务不再按每几楼自动跑，改为在聊天页面最新用户楼层的底部点按钮预约：点一下＝下一次用户输入时执行（按钮发光），再点＝取消。除非在这里关掉并保存，任务一直保持手动触发才进行。',
    editorTaskTags: '抽取标签',
    editorTaskInject: '只留字段',
    editorTaskExempt: '豁免标签',
    editorTaskExemptHint: '列在这里的标签不要求每轮都回传；真回传了仍照常抽取、落盘、进世界书。',
    editorTaskCopy: '复制',
    editorTaskCopyHint: '复制整条任务：点了会弹出选择窗口，直接挑目标预设',
    editorTaskBlocks: '提示词块',
    editorTaskBlocksHint: '关掉的块不会发给 AI；块按这里的顺序发，可以复制、上下移。',
    editorBlockRole: '角色',
    editorBlockName: '块名',
    editorBlockAddTop: '＋ 在最上方插入',
    editorBlockAddBottom: '＋ 在最下方插入',
    editorBlockCopy: '复制',
    editorBlockSend: '跨预设/任务复制',
    editorBlockSendHint: '复制这块提示词：点了会弹出选择窗口，直接挑目标预设和任务',
    editorBlockDrop: '删掉',

    /** 复制粘贴子页面：任务与提示词块共用同一个去处 */
    copyPasteTitle: '复制到哪里',
    copyPasteHint: (kind: 'block' | 'task'): string =>
      kind === 'block' ? '点下面任意一条任务，这块提示词就粘进那条任务里。' : '点下面任意一份预设，这条任务就加进那份预设里。',
    copyPasteSafety: '粘之前会先自动保存一次当前设置；粘进去的内容还要再点面板右上角的「保存」才会留下，直接关掉页面就不会保留。',
    copyPasteEmpty: '还没有导入过预设 —— 先在任务页把预设导入到本脚本里。',
    copyPasteNoTasks: '这份预设里还没有任务。',
    copyPasteWholePreset: '粘到这份预设',
    copyPasteCancel: '取消',
    copyPasteFrom: (name: string): string => `来自「${name}」`,
    copyPasteDone: (preset: string, task: string): string =>
      `已经粘到「${preset} › ${task}」。还要点面板右上角的「保存」才会留下。`,
    copyPasteDoneTask: (preset: string): string =>
      `已经把任务加进「${preset}」。还要点面板右上角的「保存」才会留下。`,
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
      { code: '$1', desc: '本轮命中的世界书内容，会包进 <worldbook_context> 信封；内容为空时整个信封消失。本脚本写进世界书的托管条目（plot_assistant- 开头）不算在内' },
      { code: '$9', desc: '世界书里剔掉数据库生成条目后的那一份，同样走信封，也不含本脚本的托管条目' },
      { code: '$5', desc: '纪要索引（世界书里的纪要条目）；取不到就用纪要表的概要与编码索引列，再取不到就用总体大纲表' },
      { code: '$7', desc: '默认上下文：最近 N 条 AI 楼层，按上面的提取／排除规则处理过' },
      { code: '$6', desc: '上一轮剧情推进的输出（<plot> 那一段）' },
      { code: '$8', desc: '本轮的玩家输入（也就是你刚发的那句话）' },
    ],

    /** 世界书预留位 */

    /** 任务清单 */
    tasksLabel: '这套预设里有哪些任务',
    tasksHint:
      '这里列出的是选中预设里的任务，只做展示。要改提示词、开关、触发间隔，去「预设与开关」页点「编辑这份预设」—— 改的是本地库里那份副本，数据库脚本那边不会被动到。',
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
    /** 推进运行期间面板只读：引擎整轮只 load 一次账本，中途整份写回会把成果盖掉 */
    stashPlotRunning: '正在推进，跑完再改',
    stashRefresh: '刷新',
    stashFloor: (floorId: number): string => `第 ${floorId} 楼`,
    stashPending: (pending: number): string => `未完成，还欠 ${pending} 个任务`,
    /** 楼层行上的进度入口：同一句话里直接告诉玩家「点这里能看进度」。 */
    stashPendingProgress: (pending: number): string => `未完成，还欠 ${pending} 个任务 · 查看进度`,
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
    stashExport: '导出',
    stashExportHint: '把这一份暂存区存成一个文件，带到别的聊天文件里去用。',
    stashExportDone: '已导出。',
    stashImport: '导入',
    stashImportHint: '把另一个聊天导出过的暂存区文件读进来，按楼层号挂到最新几层上。',
    stashImportNoStash: '账本还没读出来，先点一次刷新。',
    stashImportAskOverwrite: (floors: string): string =>
      `第 ${floors} 楼本来就有暂存成果，导入会把它换掉（换掉的还可以从旧版里找回）。确定覆盖吗？`,
    stashImportOverwrite: '覆盖',
    stashImportCancel: '先不导',
    stashImportDone: (moved: number): string => `已导入 ${moved} 层账。`,
  stashImportDoneOrphans: (count: number): string => `已恢复 ${count} 笔孤儿记录。`,
    stashImportFallbackLast: '当前聊天的用户楼层不够三层，只挂到了最新那一层。',
    stashImportFallbackNone: '当前聊天还没有楼层，账挂到了第 0 层。',
    stashImportSkipped: (skipped: number): string => `源文件还有 ${skipped} 层没地方挂，已略过。`,
    stashQrfModeNote: '当前是 qrf 模式：成果直接写进楼层字段，一层一版，这里没有可切换的版本。',
    stashDirtyClose: '这一版还有没保存的改动，关掉就没了。',
    stashDirtyStay: '继续编辑',
    stashDirtyLeave: '放弃改动并关掉',
    stashTextLabel: '注入用户楼层内容',
    stashTagsLabel: '标签块（点 × 删掉这一块）',
  stashLedgerLabel: '账本里的标签（只进字段 / 写进世界书，改完点「保存」才生效）',
  stashLedgerEmpty: '这一版里没有只进字段的标签。',
    stashNoTags: '这一版里没有独立的标签块。',
    stashGapHint: (tags: string, tasks: number): string =>
      `这一版现在缺 ${tags}。下次拿它生成楼层时，会自动把产出这些标签的 ${tasks} 个任务重跑一遍补回来。`,
    stashTagRemoved: (tag: string): string => `已删掉 <${tag}>，点「保存」才生效`,
    stashTagMissing: (tag: string): string => `没找到 <${tag}>`,
    stashEditTarget: (floorId: number, label: string): string => `第 ${floorId} 楼 · ${label}`,
    stashOpenView: '查看',
    stashViewProgress: '查看进度',
    stashWorkingTitle: (floorId: number): string => `第 ${floorId} 楼 · 进行中`,
    stashWorkingHint: '这一层还没跑完。下面是已经完成和还欠着的任务；关掉这里点发送，就会接着没跑完的继续跑。',
    stashWorkingEmpty: '这一层还没开始跑任何任务。',
    stashWorkingFoot: '带「只进字段」的标签不会写进正文，只跟着世界书写入走。',
    stashWorkingTags: '带回的标签：',
    stashWorkingInject: '只进字段：',
    stashApply: '应用到楼层',
    stashApplyFailed: '写入楼层失败。',
    stashApplied: '已写回楼层正文（只换了 <plot> 那一段，你的原话还在）。',
    stashRerun: '重跑正文',
    stashRerunFailed: '没找到输入框，填不进去。',
    stashRerunOk: '已把这一版放回输入框，确认无误后点发送。',
    stashUseDirty: '先把改动保存（或放弃）再动楼层，免得用上没保存的内容。',
    stashDelete: '删除这一版（删光会连整层移除）',
    stashDeleteConfirm: '这一版删掉就找不回来了（楼层里已经写进去的内容不受影响）。如果这是最后一版，这一层的暂存卡片也会一起移除。确定删？',
    stashDeleteCancel: '先不删',
    stashDeleteOk: '删掉',
    stashDeleted: '这一版已删除。',
    stashDeleteMissing: '这一版已经不在账本里了（可能刚被挤掉），刷新一下再看。',
    stashDropVersion: '删这一版，保留楼层',
    stashDropVersionConfirm: '只删掉这一版，这一层的暂存卡片和还没跑完的进度都留着（楼层里已经写进去的内容不受影响）。确定删？',
    stashDropVersionCancel: '先不删',
    stashDropVersionOk: '删掉这一版',
    stashDropVersionDone: '这一版已删除，楼层还留着。',

    /** 搜索与替换（2026-11-08 批 45）：跨所有楼层、所有版本找一段文字 */
    stashSearchOpen: '搜索暂存区（在所有楼层的所有版本里找）',
    stashSearchPlaceholder: '搜索内容…',
    stashSearchPrev: '上一处（Shift+Enter）',
    stashSearchNext: '下一处（Enter）',
    stashSearchClose: '收起搜索',
    stashMatchNone: '没找到',
    stashMatchTotal: (total: number): string => `共 ${total} 处`,
    stashMatchPosition: (at: number, total: number): string => `${at} / ${total}`,
    stashReplacePlaceholder: '替换成…',
    stashReplace: '替换',
    stashReplaceAll: '全部替换',
    stashReplaceHint: '把当前高亮的那处换掉（先进草稿，点「保存」才生效）',
    stashReplaceAllHint: '把当前打开的这一版里的匹配全换掉（先进草稿，点「保存」才生效）',
    stashReplaceAllDone: (count: number): string => `这一版里替换了 ${count} 处（还没保存，点「保存」才生效）。`,
    stashReplaceNone: '这一版里没有可替换的匹配。',
    stashSearchDirtyBlock: '这一版还有没保存的改动，先保存或关掉，再跳到别的版本。',

    /** 运行日志（每轮每个任务：提示词、回传、耗时、重试、报错） */
    logTitle: '运行日志',
    logHint: '每一轮剧情推进的每个任务都记一条：提示词开头、AI 原样回传、抽到的标签、耗时、重试次数。失败原因写在最前面。最近 20 轮，更早的会被挤掉。',
    logEmpty: '还没有运行日志。跑一次剧情推进就会记下来。',
    logUnreadable: '日志读不出来（原文已另存），这里先显示空。',
    logRefresh: '刷新',
    logExport: '导出 md',
    logExportOk: '已复制到剪贴板，直接粘给我就行。',
    logExportFallback: '复制失败，已改成下载 plot-log.md。',
    logRound: (floorId: number): string => `第 ${floorId} 楼`,
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
    logReasoningEmpty: '这条记录没有推理内容：可能是升级前跑的老记录，或者这个模型/渠道不返回思考过程。',
    logNoReasoning: '没有记录',
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
    apisPullModelsCancelled: '已取消（切换了渠道或关闭了面板）。',
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
    previewTitle: '这次发送会发给 AI 的内容',
    previewHint: '这里就是这一次真正发给 AI 的请求内容（占位符已换成真值）。点任务名切任务；$1 世界书与 $5 纪要都按当前聊天现读。',
    previewBusy: '正在拼提示词……',
    previewRoundMeta: (preset: string, round: number, count: number) => `预设：${preset} · 第 ${round} 条用户楼层 · 要跑 ${count} 个任务`,
    previewSkipped: (count: number) => `另有 ${count} 个任务按楼层间隔被跳过。`,
    previewManualSkipped: (count: number): string => `另有 ${count} 个任务等待手动触发。`,
    manualToastArmed: (name: string): string => `将在下一次用户输入时进行任务「${name}」`,
    manualToastDisarmed: (name: string): string => `已取消任务「${name}」的预约`,
    manualIdleReason: '等待手动触发',
    previewNoTask: '这次发送没有任务要跑：可能全部停用、提示词块全关，或者都没到楼层间隔。',
    previewTaskMeta: (stage: number, count: number) => `阶段 ${stage} · ${count} 条消息`,
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
      '名字里带这些词的条目会被自动排除：思维链、cot、MVU、mvu、变量、状态、Status、Rule、rule、检定、判断、叙事、文风、InitVar、格式。'
    + '它们多半是给 MVU 变量框架和正则用的，AI 读了只会照着写代码；中文「规则」不在名单里，「王国规则总览」这类正经设定能正常进 $1，但英文 Rule / rule 仍会被排除。'
    + '此外，大纲表与纪要索引有专用占位符、本脚本自己写进世界书的条目（plot_assistant- 开头）防止与任务里的 {{标签}} 重复，也都不进 $1，这里一并标出来。'
    + '数据库脚本生成的条目会进 $1，但不会进 $9；给条目起名时避开上面那批词即可。',
    worldbookEntryReadError: (message: string) => `读条目失败：${message}`,
    // —— 世界书写入（把标签块写成条目；2026-11-07 批 36-38 用户定）——
    wbWriteSection: '世界书写入（标签块 → 条目）',
    wbWriteHint:
      '这里决定一轮推进跑完后，把哪些标签块写成世界书条目。它与上面的「世界书（$1）」是两件事：那块管任务提示词读哪几本书，这一块管把成果写进哪本书。条目在每轮跑完后自动写入、自动更新；换聊天或换角色卡后，世界书里只留当前聊天写下的条目，切回来会自动恢复。把规则停用后，下次切换时它的条目也会被清掉。',
    wbWriteSource: '写到哪本书',
    wbWriteFollow: '跟随角色卡',
    wbWriteManual: '手动选择',
    wbWriteFollowHint: '写到当前角色卡的主要知识书（只写这一本，附加知识书不写）。',
    wbWriteManualHint: '写到下面勾选的那几本书，可以是没绑到角色卡上的全局设定书。',
    wbWritePickHint: '勾哪几本，条目就写进哪几本。一本都不勾等于不写。',
    wbWriteSearch: '搜书名…',
    wbWriteRuleSection: '写入规则',
    wbWriteRuleHint:
      '每条规则 = 选一个标签 + 起一个条目名。条目名默认就是标签名，可以改；完整条目名会自动带上固定前缀 plot_assistant-（写死，不可改）。注意：条目名改了之后，「切聊天 / 切角色卡自动切换」对这条规则就失效（旧名字认不出来），改回标签名又恢复，脚本不做兼容。',
    wbWriteAdd: '加一条规则',
    wbWriteNoTags: '当前预设里没有可写的标签。先在预设里给任务配「提取标签」，或在最终注入指令里写 {{标签}}。',
    wbWriteEnabled: '启用',
    wbWriteEntryNamePlaceholder: (tagName: string) => `默认：${tagName}`,
    wbWriteDepthHint: '深度 = 插入深度（系统深度消息），默认 2，照工作流助手。',
    wbWriteOrderHint: '顺序 = 插入顺序，越小越靠前，默认 10000，照工作流助手。',
    wbWriteRemove: '删',
    wbWriteCleanCurrent: '只清当前角色卡的',
    wbWriteCleanAll: '清理本机所有世界书的',
    wbWriteCleanHint:
      '「只清当前角色卡的」删角色卡绑定书里、按当前规则名认得出的条目；手动写进别的书的条目不归它管。「清理本机所有世界书的」按 plot_assistant- 前缀扫本机全部书，改名或删规则留下的孤儿也要靠它清。两个按钮都绝不会碰你手写的条目。',
    wbWriteCleanCurrentConfirm:
      '删掉当前角色卡绑定的世界书里、本脚本写入的条目？只删按当前规则名认得出的条目，你手写的条目不动。',
    wbWriteCleanAllConfirm:
      '扫本机全部世界书，删掉所有名字以 plot_assistant- 开头的条目？你手写的条目不动；改名或删规则留下的孤儿也会一并删掉。',
    wbWriteCleanDone: (deleted: number, books: number) => `清理完成：删了 ${deleted} 条，涉及 ${books} 本书`,
    wbWriteCleanNone: '没有找到要删的条目。',
    wbWriteCleanFail: (message: string) => `清理失败：${message}`,
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
  /** 「使用说明」页（批 46 重写：按功能区讲透机制，玩家看用法、创作者看规则） */
  usage: {
    intro:
      '这里按功能区整理剧情推进助手的用法与机制。顶部按钮切换区域；这一页只看说明，不会改动任何设置。玩家看「快速上手」就够了；做预设的创作者请把「任务与楼层」「标签与差量更新」读完——里面是脚本认的全部规则。',
    tabs: {
      start: '快速上手',
      stash: '暂存区',
      tasks: '任务与楼层',
      tagDiff: '标签与差量更新',
      worldbook: '世界书写入',
      placeholders: '占位符',
    },

    // ── ① 快速上手 ──
    startTitle: '快速上手',
    startIntro:
      '剧情推进是一套独立于主对话的推进引擎：它把你预设里的一组「任务」按阶段依次发给 AI，把回传整理成剧情资料（角色信息、状态、剧情判定……），注入后续上下文，让主对话的 AI 拿着最新资料接着写。',
    startPoints: [
      '怎么触发一轮：正常发消息就行。发送会被引擎接住，先跑任务、再把最终注入指令写进你的楼层——你只管聊，任务在后台排队。',
      '进度在哪看：左侧「剧情推进 → 运行日志」按轮记着每个任务的提示词、回传、耗时与报错；跑到一半关页面也不怕，已成功的任务落了账，下次发送接着跑。',
      '结果在哪看/改：「剧情推进 → 暂存」页按楼层列出每一轮成果，能改文字、按标签删块、切版本、重跑。',
      '资料给谁用：成果里的标签块按预设的「最终注入指令」写进楼层，后续对话通过占位符（见「占位符」页）引用它们；开了「标签块写入世界书」的还会同步进世界书长期在场（见「世界书写入」页）。',
      '和左侧「推进重刷」的关系：那是另一套功能（抓取/重刷主对话楼层用的），与剧情推进互不干涉，各用各的设置。',
    ],

    // ── ② 暂存区 ──
    stashTitle: '暂存区',
    stashIntro:
      '剧情推进每一轮的成果会先落进暂存区，按用户楼层记账；换一个聊天文件就是另一份账，不会串。这一页讲清它的存放规则，以及「再点一次发送，是接着跑还是重头跑」的判定机制。',
    stashPoints: [
      '两种存放模式：升级模式（默认）成果记在本脚本自己的账本（聊天变量）里，楼层正文只放最终注入指令；qrf 模式成果直接写进楼层的 qrf_plot 字段，与数据库脚本那套兼容，一层一版、没有暂存页。',
      '容量：每个用户楼层最多留两版，第三版会挤掉最旧的那版；账本最多挂最近 3 个用户楼层。',
      '版本编号跟着内容走：删掉「第 1 版」后「第 2 版」还叫第 2 版；再跑出新结果补的是空出来的「第 1 版」号。',
      '编辑与保存：点开一版可以改正文、按标签删块；所有改动先落在草稿，点「保存」才写进账本；改的是「使用中」那版时楼层正文会跟着更新。',
      '删掉某个标签块后，缺的这块会在下次拿这一版生成楼层时自动重跑产出它的任务补回来；改了「使用中」版本的内容还会同步进世界书（见「世界书写入」页）。',
      '楼层被删了账不会丢：对账时这些账搬进孤儿区（最多留 3 份，满了淘汰最旧的），只搬不删；导出文件时孤儿账也会一并带上。',
      '导出与导入：导出存成一个 json 文件，可以带到别的聊天文件导入；导入按楼层号重新挂到最新几层用户楼层上（最多回溯三层，一层都没有就挂第 0 层），目标楼层已有账会先问你再覆盖。',
    ],
    stashMatchTitle: '再点一次发送，是接着跑还是重头跑？',
    stashMatchIntro:
      '脚本拿你这次发送的楼层正文和账本里的记录比对来决定。判定口径（2026-11-04 定）：**去掉首尾空白后，开头十个字符一样就算「同一段输入」**——所以重新发送、或在原话基础上补了几个字，都还能接上进度；不足十个字的输入要求完全一致。各种情形的走向如下：',
    stashMatchRules: [
      { input: '这一层已经有完整成果（正文里已含某一版全文）', result: '再点发送 = 重新开始全新一轮。' },
      {
        input: '这一层还没跑完，开头十个字符一致',
        result: '断点续跑：已经落盘的任务不再重发，只跑还没完成的任务；阶段 2 还能直接拿到阶段 1 的产出。',
      },
      {
        input: '这一层还没跑完，但开头十个字符不一致（你改了输入）',
        result: '仍然认这一层的账（锚本来就是楼层号），照常续跑。',
      },
      {
        input: '全新楼层，正文里整段带着某一版成果（例如用「重跑正文」把它放回输入框后发送）',
        result: '识别出你重发的是哪一版：只补跑产出被删标签块的那几个任务，其余不重跑。',
      },
      {
        input: '全新楼层，另一层有没跑完的账且开头十个字符一致',
        result: '把那层的进度搬到新楼层接着跑（多条候选接最近用过的）。',
      },
      { input: '全新楼层且以上都不匹配', result: '全新一轮，从第一个任务跑起。' },
    ],
    stashMatchNote:
      '判定是「每跑完一个任务落一次账」的：中途关页面、切聊天、脚本重载，已成功的任务都在账上，回来接着跑就行。qrf 模式没有这套账，每次都是整轮。',

    // ── ③ 任务与楼层 ──
    tasksTitle: '任务与楼层',
    tasksIntro:
      '一套预设就是一组「任务」。引擎每轮按阶段分组：同一阶段的任务并发发给 AI，上一阶段全部回来才进下一阶段；任务产出的标签块拼成这一轮的成果。这一页给创作者讲清每个字段与触发规则（编辑入口：剧情推进 → 预设与开关 → 编辑这份预设）。',
    taskFields: [
      { name: '启用', desc: '关掉的任务这一轮直接跳过，不占调用、也不留日志。' },
      { name: '阶段', desc: '阶段从小到大依次执行（阶段 1 全跑完才进阶段 2）；同一阶段内的任务同时并发，没有先后之分。后阶段任务的提示词里可以引用前阶段的产出。' },
      { name: '抽取标签', desc: '这个任务负责产出哪些标签（如 recall、character_info）。回传里按 <标签名>…</标签名> 抽取；这里列出的标签必须全部回传，少一个就算这个任务失败。失败后按任务设置的重试上限重试，次数用尽仍缺就按任务失败处理：这一轮不注入，输入框保留原文，已回传的标签先存进暂存区。' },
      { name: '只进字段', desc: '写在这里的标签只存进数据、不写进最终注入正文——适合纯后台记录，不占正文 token。注意：它同样要完整回传，只是不进正文；少一个照样算任务失败。' },
      { name: '最短长度 / 重试上限', desc: '回传字数低于下限视为失败，按任务设置的重试上限重试；次数用尽仍失败则该任务判失败，这一轮不注入，原文退回输入框。' },
      { name: '每 N 楼（触发周期）', desc: '不填=每条用户楼层都跑；填 N=每隔 N 条用户楼层跑一次。只数用户发的楼层（被隐藏的也算），AI 回复不算。每个任务自己记锚点：任务成功跑完，就在那条用户楼层上单独打一个记号；下次发送时从最新楼层往回数，隔够 N 条才再跑。' },
      { name: '手动触发', desc: '开启后任务不再按每 N 楼自动跑。聊天页面最新用户楼层的底部出现带任务名的按钮：点一下＝预约在下一次用户输入时执行（按钮发光，再点＝取消）；跑完自动回到待命。除非在任务里关掉手动触发并保存，任务一直保持手动才跑。停用任务不显示按钮，已预约的停用时预约清除。' },
      { name: '单独 API', desc: '这个任务可以指定走设置里哪一条 API（不填用「当前 API」）。适合把便宜模型留给轻任务、贵模型留给重任务。' },
      { name: '任务说明', desc: '纯备注，给自己看的，不进提示词。' },
    ],
    taskPoints: [
      '怎么算隔了几楼：从最新一条用户楼层往回数，只看用户发的（被隐藏的也算），AI 回复跳过。每个任务只找自己的锚点，遇到就停；隔了 N 条或更多就跑，一条锚点都找不到就当第一次、一定跑。锚点写在楼层上，删层重刷时它跟着那条楼层一起消失，更早的锚点还在，所以连续重刷不会把本该隔开的任务挤到一起。',
      '哪些任务会跑：启用的、（设了间隔的话）已隔够楼层的任务。全部任务都没到期时，这次发送不发生任何 AI 调用、也不留运行日志。',
      '任务提示词里可以写占位符（$1…$9、{{标签}} 等，见「占位符」页），发送前替换；任务级还有自己的最终注入模板，决定它的产出怎么进正文。',
      '任务回传里只有 <标签名> 包住的段落会被抽取；标签差量（见下一页）决定这些回传怎么与上一轮合并。断点续跑按任务记账：每个任务抽到过哪些标签都留在账上，阶段 2 续跑时直接拿阶段 1 的产出，不用重跑。',
    ],

    // ── ④ 标签与差量更新 ──
    tagDiffTitle: '标签与差量更新',
    tagDiffIntro:
      '标签差量按标签单独设置（入口：预设编辑器 → 标签差量）。开启后，AI 不用每轮重写全部内容，只写有变化的部分，脚本按上一轮内容自动合并。这一页列全四种模式的行为，以及 AI 回传里可以用的全部命令——勾选「按块合并 / 按表格行合并」后，脚本会按每个任务实际命中的标签，自动在任务提示词最前面加一段规则，不需要你再写进任务提示词。这段规则会把标签包裹（开始和结束标记各自单独占一行）、首次全量、块标题与小节标题必须单独占一行、表格必须带原表头与分隔行等边界一并写清。',
    tagDiffAutoTitle: '自动注入的规则提示词',
    tagDiffAutoIntro:
      '只有任务自己的抽取标签 / 只进字段 / 豁免标签里出现了按块合并或按表格行合并的标签，才会注入。两个占位符分别换成该任务命中的标签名，多个标签用顿号隔开；每个任务各换各的，不会把所有任务的标签混在一起。没有命中就不加这条消息。模板会明确要求：所有标签用完整的一对 <标签名>…</标签名> 包住且开始/结束标记各自独占一行、首次生成必须全量、块标题和小节标题必须各自独占一行、表格必须原样带表头与分隔行、删除与移入指令必须单独一行。',
    tagDiffAutoTemplateNote: '下面是模板原文（{{按块合并标签}} / {{按表格行合并标签}} 是占位符）：',
    tagDiffModes: [
      { name: '关闭（每轮全量）', desc: '每轮输出完整内容，整块替换。适合 basic_info、plot_judge 这类每轮都变的快照。' },
      { name: '整标签保留', desc: '本轮没输出这个标签、或只回了个【无变化】，就沿用上一轮；输出了就整块替换。' },
      { name: '按块合并', desc: '按 ### 标题分块合并：AI 只写有变化的块，块内只写有变化的小节；没有提到的块和小节，脚本会自动保留上一轮的内容。小节标题必须独占一行，不能写成【小节名】正文。' },
      { name: '按表格行合并', desc: 'Markdown 表格按第一列作行键：AI 只写有变化的行，【删除】行名可删行；没有提到的行，脚本会自动保留上一轮的内容。补丁必须原样带表头和分隔行，第一列（行键）不能改名。' },
    ],
    tagDiffCommandsTitle: 'AI 可用的命令（回传里写这些，脚本认）',
    tagDiffCommands: [
      { syntax: '【无变化】', where: '单个差量标签内', effect: '这个标签沿用上一轮内容。必须连同完整标签对一起写（<标签名>【无变化】</标签名>），不能只写这四个字，也不能用在首次生成。' },
      { syntax: '### 角色名', where: '按块合并', effect: '开一个角色块；必须单独占一行，### 后要有一个空格，### 要从行首开始。### [角色名] 与它等价，同名块（去方括号后）按标题匹配替换；已有块不要改块名。' },
      { syntax: '【小节名】', where: '按块合并的块正文里', effect: '只写有变化的小节（如【信息边界】【短期记忆】【长期记忆】），脚本按小节整节替换。小节标题必须单独占一行，只写【小节名】，正文从下一行开始；不要把【小节名】正文写在同一行。小节名要和上一轮完全一致，改名会当成新增小节、旧小节还留着。只写小节标题、下面不写正文，脚本会把这个小节的内容清空；没有变化就不要写它。小节名不要使用【删除】【移入】【移出】【状态】这些脚本保留的指令名。如果写了块正文但一个【小节】行都没写，脚本会把这段正文当作整块的新正文，完整替换上一轮这一块；如果只写 ### 角色名、不写正文，已有块保留上一轮正文，新块会变成空块。块正文第一个【小节】之前的说明文字会被丢掉。' },
      { syntax: '【删除】名字', where: '按块 / 按表格行合并', effect: '必须单独写一行，行内不能有别的内容。按块合并时删除同名块；表格模式下删除这个标签里所有表第一列匹配的行，名字要和第一列完全一致。' },
      { syntax: '【移入 标签名】', where: '按块合并的块正文里', effect: '必须写在对应块标题下面的正文里，并且单独占一行。把这一块移进指定的嵌套前台标签（例如【移入 character_archive】）；写在块外或和正文挤在同一行不会生效。' },
      { syntax: '【移出】', where: '按块合并的块正文里', effect: '必须写在对应块标题下面的正文里，并且单独占一行。把这一块移回外层（后台）。' },
      { syntax: '【状态】前台 / 【状态】后台', where: '旧格式兼容', effect: '没有【移入/移出】时仍然认，由上一轮内容里检测到的前台标签兜底映射。' },
      { syntax: '整行 <标签名> / </标签名>', where: '按块合并的回传里', effect: '前台/后台分区标记：写在一对标签之间的块属于前台（会进正文），外面的属于后台。' },
    ],
    tagDiffPoints: [
      '差量只改变「任务回传怎么落盘、怎么与上一轮合并」，不改变 AI 本轮正文的写法——正文里注入什么仍由最终注入指令与占位符决定。',
      '按块合并的铁律：块标题必须单独占一行、从行首写 ### 块名；块正文里不能出现以 ### 开头的行（会被当成新块标题，把正文截断或拆成新块）。小节标题也必须单独占一行，只写【小节名】，正文另起一行；小节名要和上一轮完全一致，改名会多出一个新小节、旧小节还留着。写了哪个小节，就要写出这个小节更新后的**完整**内容——脚本按小节整节替换，只写新增条目会把旧内容冲掉；只写小节标题、不写正文会把这个小节清空；把【小节名】正文写在同一行，会被当成没有小节，整块替换。小节名不要用【删除】【移入】【移出】【状态】这些脚本保留的指令名。块正文第一个【小节】之前的说明文字会被丢掉；块标题之外的文字也不会保存，只写块内容。上一轮已有内容时，如果整段一个 ### 块都没有（也没有【删除】行），脚本会认为没有更新、整份补丁不生效，不要用表格或纯文本代替块。只写 ### 块名、不写正文时，已有块保留旧正文，新块会建出一个空块。',
      '按表格行合并的铁律：补丁必须原样带**表头和分隔行**（表头行、数据行都要以 | 开头并以 | 结尾），脚本靠表头定位是哪张表；表头改一个空格或列名就会被当成新表追加，旧表还留着。行键是第一列（角色名），不能改名；改行就按原列数整行重写，加行直接写新行，删除行写单独一行【删除】行名。如果这一轮要更新表格却完全没写表格、也没写【删除】行，脚本会认为没有表格更新，整份补丁不生效。',
      '首次生成（上一轮没有这个标签）时没有旧内容可合并，必须输出完整内容：按块合并要给完整块结构，按表格行合并要给完整表头和所有行；不能写【无变化】。',
      '所有标签都要用完整的一对 <标签名>…</标签名> 包住，同一个标签本轮只写一对，不要拆成多段同名标签；标签的开始标记和结束标记必须各自单独占一行，不能和正文、其他标签或 ### 标题挤在同一行；嵌套标签只写在父标签里面，不要在外层之外再单独输出一次。',
      '上一轮的格式和当前模式对不上（例如 character_info 上一轮还是表格、这轮改成了按块合并）时，本轮会自动要求全量输出并整份替换，不会拿旧格式硬合并。',
      '按块合并 / 按表格行合并的规则由脚本按任务自动注入，不用抄进任务提示词；任务提示词只管写剧情要求和本任务要产出的内容。',
      '只写非「关闭」的标签，关闭的标签不占配置；差量开启的标签在断点续跑时同样按任务粒度记账。',
    ],

    // ── ⑤ 世界书写入 ──
    worldbookTitle: '标签块写入世界书',
    worldbookIntro:
      '一轮推进落盘后，可以把规则选中的标签块写成世界书条目，让「大包裹」拆成「一张便条 + 书架上的资料」——正文里只留轻的，重的资料长期挂在世界书里供 AI 随时读取。入口：剧情推进第 2 页「标签块写入世界书」。',
    worldbookPoints: [
      '写入时机：每轮推进成功落盘后自动写；你在暂存区改「使用中」版本的内容、或把另一版「应用到楼层」后，世界书条目会跟着改成那份内容。',
      '条目形态：固定加 plot_assistant- 前缀，蓝灯常驻（永远在场）、系统角色、深度默认 2 / 顺序默认 10000、双向防递归——照工作流助手同款。',
      '账本与对账：条目的「有没有、有哪些」记在本聊天的账本里，按「聊天 + 角色卡」对账。换聊天或换卡，旧条目自动清掉；切回来自动恢复，不用手动管。',
      '改了规则怎么生效：停用一条规则后，下次重算会把它的条目清掉（内容仍留在账本里，重新启用后会按账本恢复）；给规则改条目名等于换了一个新名字——旧条目不再被认领（走手动清理），新条目按新名字写。',
      '不重复注入：托管条目在世界书触发里被屏蔽（$1/$9 都不再展开它们），不会和任务 {{标签}} 的正文注入重复。',
      '清理按钮两档：「只清当前角色卡的」扫角色卡绑定的书，按当前规则推导的完整条目名认领；「清理本机所有世界书的」按 plot_assistant- 前缀全盘扫（能兜住改名/删规则留下的孤儿）。都有二次确认，用户手写的条目一律不碰。',
    ],

    // ── ⑥ 占位符 ──
    placeholderTitle: '占位符',
    placeholderNote:
      '这些占位符写在任务提示词或最终注入指令里，发送前会被换成实际内容。酒馆原生宏也可以直接写：<user>、{{user}}、<char>、{{char}}，同样会在发送前替换成当前用户名和角色名。',
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
    sections: '切换功能（剧情推进 / 推进重刷 / 使用说明）',
    reset: '恢复默认',
    clearLog: '清掉以上记录',
  },
  logPlaceholder: '还没有日志，先点一次按钮试试',
  /** 用户新建的正则没填名称时用的占位名 */
  unnamedPreset: '没名字',
} as const;

/**
 * 暂存楼层行的默认落点：正在用的那一版 → 最新一版 → 一版都没有返回 null。
 *
 * 抽成纯函数放本文件，是为了让 tools/plot-parity 能直接 import 真实实现做对照
 * 测试（那套 commonjs 编译图静态引入不了 .vue）。
 *
 * 只看有没有落盘成果，**不看 working.pending**：「还欠着任务」只说明这层没全量
 * 跑完，不该把已落盘的成果挡住（用户 2026-11-10 口径）；真正锁编辑的只有
 * 「任务已发给 AI、还没回传」那段时间。
 */
export function pickStashEntryLanding<T extends { id: string }>(entry: {
  landings: T[];
  activeLandingId: string | null;
}): T | null {
  return (
    entry.landings.find((item) => item.id === entry.activeLandingId) ??
    entry.landings[entry.landings.length - 1] ??
    null
  );
}
