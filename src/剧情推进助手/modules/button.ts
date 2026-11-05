/**
 * 装配模块：往酒馆页面里塞东西。
 * - 反馈动画用到的样式（一次性注入）
 * - 注册 QR 区的脚本按钮
 * - 在魔法棒菜单里挂一个设置入口
 *
 * 手势绑定在 gesture.ts：挂在父窗口捕获阶段做动态命中测试，
 * 不依赖按钮元素存活，所以这里不需要 MutationObserver 盯着按钮重建。
 */
import { WAND_ENTRY_ID, CSS_NODE_ID } from './constants';
import { profile } from './profile';
import { pageQuery } from './tavern';
import { declareScriptButton } from './script-button';
import { showPrefsPanel } from './settings-panel';
import { tagOwnedNode } from './instance';
import { logInfo } from './logger';
import { MSG, TAG, UI } from './copy';
import type { RerushContext } from './types';

export function ensureMotionCss(instanceId: string): void {
  const p$ = pageQuery();
  if (p$('#' + CSS_NODE_ID).length > 0) return;

  // 抖动时长要和 feedback.ts 里摘 class 的 REJECT_FLASH_MS 对上。
  // 三条规则都带 !important：QR 按钮自身的样式表同样写 opacity / animation / color。
  const css = `
      @keyframes rh-blocked-wobble {
          0%, 100% { transform: none; }
          15% { transform: translate(-3px, 1px) rotate(-4deg); }
          35% { transform: translate(3px, -1px) rotate(4deg); }
          55% { transform: translate(-2px, 1px) rotate(-2deg); }
          75% { transform: translate(2px, -1px) rotate(2deg); }
      }
      .rh-blocked-shake {
          animation: rh-blocked-wobble 0.42s ease-out 1 !important;
      }
      .rh-blocked-color {
          color: #e11d48 !important;
          text-shadow: 0 0 10px rgba(225, 29, 72, 0.35);
      }
      .rh-locked {
          opacity: 0.45 !important;
      }
  `;
  p$('<style>').attr('id', CSS_NODE_ID).html(css).appendTo('head');
  tagOwnedNode(instanceId, CSS_NODE_ID);
}

/** 在魔法棒（扩展）菜单里加一条打开设置的入口，重复调用不会加第二遍。 */
export function ensureWandEntry(ctx: RerushContext): void {
  const p$ = pageQuery();
  const name = profile().displayName;
  const $menu = p$('#extensionsMenu, #extensions_menu');

  if ($menu.length > 0 && p$('#' + WAND_ENTRY_ID).length === 0) {
    const $entry = p$(`
        <div id="${WAND_ENTRY_ID}" class="list-group-item flex-container flexGap5 interactable" tabindex="0" title="${UI.menuTooltipOf(name)}">
            <div class="fa-fw fa-solid fa-rotate extensionsMenuExtensionButton"></div>
            <span>${name}</span>
        </div>
    `);
    $entry.on('click', () => {
      // 先把菜单本身收起来，否则面板会被压在展开的菜单下面
      p$('#extensionsMenuButton, #extensions_menu_button').trigger('click');
      showPrefsPanel(ctx);
    });
    $menu.append($entry);
    tagOwnedNode(ctx.state.instanceId, WAND_ENTRY_ID);
    logInfo(TAG.mount, MSG.wandMounted);
  }
}

/**
 * 注册 QR 区的脚本按钮（幂等）。
 * 手势是动态命中测试，按钮即使被 QR/JSLR 重建也照样认，所以无需重复挂载监听。
 */
export function mountScriptButton(): void {
  declareScriptButton();
  logInfo(TAG.mount, MSG.qrMounted);
}
