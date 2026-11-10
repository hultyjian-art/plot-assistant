/**
 * 全局常量：页面注入节点 id、日志标记、以及各处定时时长。
 * 界面文字与日志正文不在这里，统一放 copy.ts；
 * 产物显示名（按钮/菜单/面板标题/日志前缀）也不在这里，放 profile.ts——
 * 完整版与轻量版「剧情推进助手·轻」共用同一份源码，差别都在产物档案里。
 */

/** 魔法棒菜单里那条设置入口的 id。 */
export const WAND_ENTRY_ID = 'rh-wand-entry';
/** 设置面板挂载点的 id。 */
export const MODAL_HOST_ID = 'rh-prefs-host';
/** 反馈动画样式所在 style 节点的 id。 */
export const CSS_NODE_ID = 'rh-motion-css';

/** 触发原生重刷后，等酒馆把按钮状态消化完再解锁本脚本的锁。 */
export const NATIVE_SETTLE_MS = 800;
/** 抖动/染红播完到自动摘掉 class 的时长，需与 CSS 动画时长一致。 */
export const REJECT_FLASH_MS = 420;
/** 装载完成后推迟这么久再做自检，给 QR 按钮渲染留余量。 */
export const DIAGNOSTIC_DELAY_MS = 5000;

/**
 * 父窗口上登记"当前活跃实例"的全局键。
 * 同一脚本的新旧实例都写这里，新实例启动时据它把旧实例踢下线。
 */
export const INSTANCE_REGISTRY_KEY = '__rerushInstances__';
/** 标记页面节点属于哪个实例，清场时据此判断"是不是我留下的"。 */
export const INSTANCE_ATTR = 'data-rh-instance';
/**
 * 装载时清场的节点 id：这些节点挂在酒馆父页面上，
 * 旧实例被替换时不会随它的 iframe 一起消失（详见 instance.ts 顶部注释）。
 */
export const OWNED_NODE_IDS = [MODAL_HOST_ID, WAND_ENTRY_ID, CSS_NODE_ID];


/**
 * toastr 气泡停留时长（毫秒）。按信息量与严重程度分档，不是同一个值的手滑重复：
 * 4000 一句短提示 / 5000 一般结果 / 6000 需要读一读的警告 /
 * 7000 带原因的写回提示 / 8000 用户必须注意的重刷与中断。别合并成单一常量。
 */
export const TOAST_BRIEF_MS = 4000;
export const TOAST_NORMAL_MS = 5000;
export const TOAST_NOTICE_MS = 6000;
export const TOAST_DETAIL_MS = 7000;
export const TOAST_URGENT_MS = 8000;

/** maxTokens 缺省值：老数据没写这个字段时用的那个数。 */
export const DEFAULT_MAX_TOKENS = 60000;
/** 生成请求重试间隔缺省（毫秒）；测试里传 0 跳过等待。 */
export const DEFAULT_RETRY_DELAY_MS = 5000;
