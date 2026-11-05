/**
 * 实例隔离模块：同一脚本换版时，保证"新实例接管、旧实例退场、页面不留残骸"。
 *
 * 为什么需要（都在酒馆助手源码里核实过，不是猜的）：
 * - 脚本各自跑在一个 iframe 里（`src/panel/script/Iframe.vue`），渲染它的 v-for
 *   key 是 `source + id + reload_memo`；`reload_memo` 只在"用编辑器保存脚本"或
 *   开发者"允许监听"时才会变（`ScriptItem.vue`、`panel/developer/listener.ts`）。
 *   所以**导入同 id 的新版脚本并不保证 iframe 会重建**。
 * - 更要紧的是：本脚本挂在**酒馆父页面**上的东西——魔法棒入口 `#rh-wand-entry`、
 *   动效样式 `#rh-motion-css`、面板容器 `#rh-prefs-host`——不会随脚本 iframe 消失而消失。
 *   于是新实例启动时 `ensureWandEntry` 看到"入口已存在"就跳过注册，页面上留着的其实是
 *   旧实例的入口；那个入口的点击回调指着一个已经死掉的 iframe，点开自然没反应——
 *   这正是"导入新版后不刷新页面就打不开面板"的成因。
 *
 * 三件事：① 每个实例一个 id，并把"我还在不在位"记进**父窗口**的注册表；
 * ② 新实例启动时先调用旧实例的 dispose（摘监听、清节点）；③ 页面节点都带
 * `data-rh-instance` 标记，清场只删不属于自己的，绝不误删新实例的节点。
 */
import { INSTANCE_ATTR, INSTANCE_REGISTRY_KEY, OWNED_NODE_IDS } from './constants';
import { logInfo } from './logger';
import { pageQuery, parentWindow } from './tavern';
import { MSG, TAG } from './copy';

/** 注册表里一格：某个脚本当前在位的实例。 */
export interface InstanceSlot {
  id: string;
  /** 退场动作：摘监听、清计时器、删自己留下的页面节点 */
  dispose: () => void;
}

/** 父窗口注册表：键是脚本 id（同一脚本只有一个实例在位）。 */
export type InstanceRegistry = Record<string, InstanceSlot>;

/**
 * 抢占脚本的实例位（纯函数，可穷举验证）。
 * 返回被顶替的旧实例；调用方负责把它 dispose 掉。没有旧实例时返回 null。
 */
export function claimSlot(
  registry: InstanceRegistry,
  scriptId: string,
  id: string,
  dispose: () => void,
): InstanceSlot | null {
  const previous = registry[scriptId] ?? null;
  registry[scriptId] = { id, dispose };
  return previous !== null && previous.id !== id ? previous : null;
}

/**
 * 退场（纯函数）。只有当前在位的还是自己时才注销，
 * 避免"已过期实例"把新实例的登记抹掉。
 */
export function releaseSlot(registry: InstanceRegistry, scriptId: string, id: string): boolean {
  if (registry[scriptId]?.id !== id) return false;
  delete registry[scriptId];
  return true;
}

/** 自己是否仍是当前在位的实例（纯函数）。旧实例的手势回调靠它自我否决。 */
export function isActiveSlot(registry: InstanceRegistry, scriptId: string, id: string): boolean {
  return registry[scriptId]?.id === id;
}

/** 生成一个实例 id（不依赖 crypto，够唯一即可）。 */
export function newInstanceId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 取（必要时建立）父窗口上的注册表。 */
export function instanceRegistry(): InstanceRegistry {
  const holder = parentWindow() as unknown as Record<string, unknown>;
  const existing = holder[INSTANCE_REGISTRY_KEY];
  if (existing !== null && typeof existing === 'object') return existing as InstanceRegistry;
  const fresh: InstanceRegistry = {};
  holder[INSTANCE_REGISTRY_KEY] = fresh;
  return fresh;
}

/**
 * 清场：把本脚本在父页面上的节点里，**不属于当前实例**的统统删掉。
 * 包括老版本（没有实例标记）留下的残骸——它们的 iframe 早没了，留着只会挡住新实例。
 */
export function removeStaleNodes(instanceId: string): number {
  const p$ = pageQuery();
  let removed = 0;
  for (const id of OWNED_NODE_IDS) {
    p$('#' + id).each((_index, node) => {
      if (p$(node).attr(INSTANCE_ATTR) !== instanceId) {
        p$(node).remove();
        removed += 1;
      }
    });
  }
  return removed;
}

/** 给本实例创建的页面节点打标记（清场时据此认出"这是我留的"）。 */
export function tagOwnedNode(instanceId: string, id: string): void {
  pageQuery()('#' + id).attr(INSTANCE_ATTR, instanceId);
}

/** 删掉本实例自己留下的页面节点（退场时用）。 */
export function removeOwnNodes(instanceId: string): void {
  const p$ = pageQuery();
  for (const id of OWNED_NODE_IDS) {
    p$('#' + id).each((_index, node) => {
      if (p$(node).attr(INSTANCE_ATTR) === instanceId) p$(node).remove();
    });
  }
}

/**
 * 抢占实例位：踢掉旧实例、清掉页面残骸、把自己登记进去。
 * 返回本实例 id。
 */
export function claimInstance(scriptId: string, dispose: () => void): string {
  const id = newInstanceId();
  const registry = instanceRegistry();

  const evicted = claimSlot(registry, scriptId, id, dispose);
  if (evicted !== null) {
    try {
      evicted.dispose();
      logInfo(TAG.boot, MSG.instanceEvicted(evicted.id));
    } catch (error) {
      // 旧实例来自上一版代码，它的 dispose 可能不存在或抛错——不能因此影响本次装载
      logInfo(TAG.boot, MSG.instanceEvictFailed(String(error)));
    }
  }

  const cleaned = removeStaleNodes(id);
  if (cleaned > 0) logInfo(TAG.boot, MSG.instanceCleaned(cleaned));

  return id;
}

/** 本实例是否仍在位。手势/动作派发前用它自我否决（旧实例的监听可能还挂在父窗口上）。 */
export function isCurrentInstance(ctx: { state: { instanceId: string } }): boolean {
  if (ctx.state.instanceId === '') return true; // 还没登记（极早期）时不拦
  return isActiveSlot(instanceRegistry(), getScriptId(), ctx.state.instanceId);
}

/** 退场：注销登记 + 删自己的节点。摘监听等动作由调用方在此之前完成。 */
export function releaseInstance(scriptId: string, instanceId: string): void {
  if (instanceId === '') return;
  releaseSlot(instanceRegistry(), scriptId, instanceId);
  removeOwnNodes(instanceId);
}
