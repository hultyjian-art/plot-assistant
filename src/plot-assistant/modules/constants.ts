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
