/**
 * 按钮反馈模块：执行中的锁定观感、受阻时的抖动+染红、动作结束后解锁。
 * 按钮默认从 QR 区定位，调用方也可以把自己手里的那个传进来。
 * 动画本体在 button.ts 注入的样式里，这里只管挂/摘 class。
 */
import { REJECT_FLASH_MS } from './constants';
import { findScriptButton } from './script-button';
import type { RerushContext } from './types';

/** 动作执行中：压暗，表示不再接受新手势。 */
const LOCKED_CLASS = 'rh-locked';
/** 受阻：抖一下。 */
const MOTION_CLASS = 'rh-blocked-shake';
/** 受阻：染成警示色。 */
const COLOR_CLASS = 'rh-blocked-color';

export function paintLock($btn: JQuery<HTMLElement>, locked: boolean): void {
  $btn.toggleClass(LOCKED_CLASS, locked);
}

/** 校验没过或执行出错时的一次性提示动效。 */
export function flashRejected(ctx: RerushContext, $target?: JQuery<HTMLElement>): void {
  const $btn = $target ?? findScriptButton();
  if (!$btn || $btn.length === 0) return;

  const { shake, flash } = ctx.settings.look;
  // 先摘掉再强制回流，保证同一按钮连续受阻时动画能重新起手。
  // 这里必须用方法调用：`void el.offsetWidth` 这类属性读取会被生产构建的压缩器
  // 当成无副作用语句整条删掉（实测旧交付产物里就没有了），回流随之失效。
  $btn.removeClass(`${MOTION_CLASS} ${COLOR_CLASS}`);
  $btn[0]?.getBoundingClientRect();

  if (shake) $btn.addClass(MOTION_CLASS);
  if (flash) $btn.addClass(COLOR_CLASS);

  window.setTimeout(() => {
    $btn.removeClass(`${MOTION_CLASS} ${COLOR_CLASS}`);
  }, REJECT_FLASH_MS);
}

/** 动作收尾：解除逻辑锁并还原按钮外观。 */
export function releaseLock(ctx: RerushContext, $btn: JQuery<HTMLElement>): void {
  ctx.state.locked = false;
  paintLock($btn, false);
  $btn.blur();
}
