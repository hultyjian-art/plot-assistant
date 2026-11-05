/**
 * 连击结算判定（纯函数，不碰 DOM，便于穷举验证）。
 *
 * 规则来源：一次物理按压抬起后累计"第几指"，
 * 只要后面不可能再来一指（对应的连击档位被绑成"不响应"，或已达三击上限），
 * 就当场结算，省掉一个点击间隔的等待；否则等间隔窗口结束后按累计指数的档位结算。
 */
import { MSG } from './copy';
import type { ActionKey, GestureBinding } from './types';

/** 三击是设计上限：达到三指就不再等第四指。 */
const TAP_LIMIT = 3;

/** 累计到 taps 指时，是否已经确定不会再多的指、可以当场结算。 */
export function settlesAtOnce(bindings: GestureBinding, taps: number): boolean {
  if (taps >= TAP_LIMIT) return true;
  if (taps === 2) return bindings.triple === 'none';
  return bindings.double === 'none' && bindings.triple === 'none';
}

/**
 * 把"累计几指"翻译成要执行的动作和日志里的手势名。
 * waited 表示是等完间隔窗口后才结算，只影响措辞，不影响动作。
 */
export function outcomeOfTaps(
  bindings: GestureBinding,
  taps: number,
  waited: boolean,
): { key: ActionKey; name: string } {
  if (taps >= TAP_LIMIT) return { key: bindings.triple, name: waited ? MSG.tapTriple : MSG.tapTripleImmediate };
  if (taps === 2) return { key: bindings.double, name: waited ? MSG.tapDouble : MSG.tapDoubleImmediate };
  return { key: bindings.tap, name: waited ? MSG.tapSingle : MSG.tapSingleImmediate };
}
