/**
 * plot/guards.ts — 数据整形层共用的最小类型守卫。
 *
 * 之前 `state.ts` 与 `api-body.ts` 各写了一份 `isPlainObject`，判定逐字一样，
 * 只有返回类型里的 `any` / `unknown` 不同。收在一处，改判定口径时不必两头对齐。
 */

/** 是不是一个「键值表」—— 数组、null、标量都不算。 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
