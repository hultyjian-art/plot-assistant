/**
 * 动作派发模块：把手势识别的结果（哪个手势）按设置里的绑定换算成动作并执行。
 */
import { paintLock } from './feedback';
import { runNativeRefresh, runRerushFlow } from './actions';
import { showPrefsPanel } from './settings-panel';
import { findScriptButton } from './script-button';
import { isCurrentInstance } from './instance';
import { logInfo, logWarn } from './logger';
import { MSG, TAG } from './copy';
import type { ActionKey, RerushContext } from './types';

export function runGestureAction(ctx: RerushContext, actionKey: ActionKey, gestureName: string): void {
  const standDown = (): void => {
    ctx.state.locked = false;
    const $btn = findScriptButton();
    if ($btn) {
      paintLock($btn, false);
      $btn.blur();
    }
  };

  // 旧实例被新版本顶替后，它挂在父窗口捕获阶段的手势监听可能还活着
  // （脚本 iframe 没被销毁时不会触发卸载事件）。这里靠实例位自我否决，
  // 否则同一次点击会被新旧两个实例各处理一遍（表现为一次点击重刷两次）。
  if (!isCurrentInstance(ctx)) {
    logInfo(TAG.route, MSG.staleInstanceIgnored);
    // 按钮的灰底是旧实例自己按下去的（`gesture.ts` 在派发前就 paintLock 了），
    // 它已经不会再执行任何动作，不在这里还原就会一直灰着不动。
    standDown();
    return;
  }

  logInfo(TAG.route, MSG.routed(gestureName, actionKey));

  if (actionKey === 'none') {
    logInfo(TAG.route, MSG.routedToNothing);
    standDown();
    return;
  }

  ctx.state.locked = true;

  switch (actionKey) {
    case 'native':
      // 原生重刷里含"换插头"的异步步骤，这里不阻塞派发
      void runNativeRefresh(ctx);
      break;
    case 'full':
      void runRerushFlow(ctx, true).catch((error: unknown) => {
        logWarn(TAG.route, MSG.flowAborted(error instanceof Error ? error.message : String(error)), error);
        standDown();
      });
      break;
    case 'edit':
      void runRerushFlow(ctx, false).catch((error: unknown) => {
        logWarn(TAG.route, MSG.flowAborted(error instanceof Error ? error.message : String(error)), error);
        standDown();
      });
      break;
    case 'settings': {
      logInfo(TAG.route, MSG.openPanel);
      standDown();
      showPrefsPanel(ctx);
      break;
    }
  }
}
