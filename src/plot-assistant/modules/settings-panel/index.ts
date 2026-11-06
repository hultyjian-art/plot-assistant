/**
 * 设置面板入口：建挂载点、挂 Vue 组件、把样式搬到酒馆页面上。
 *
 * 面板组件本身不碰酒馆，只负责显示与编辑。
 */
import { createApp } from 'vue';
import { createScriptIdDiv, teleportStyle } from '@util/script';
import { INSTANCE_ATTR, MODAL_HOST_ID } from '../constants';
import { pageQuery, pageToastr } from '../tavern';
import { loadSettings, saveSettings } from '../settings';
import { logInfo } from '../logger';
import { MSG, TAG } from '../copy';
import SettingsPanel from './SettingsPanel.vue';
import type { RerushContext, RerushSettings } from '../types';

export function showPrefsPanel(ctx: RerushContext): void {
  const p$ = pageQuery();
  const $existing = p$('#' + MODAL_HOST_ID);
  if ($existing.length > 0) {
    // 自己这个实例的面板已经开着：不重建，但也不能一声不响地 return。
    // 之前就是直接 return，面板一旦被别的浮层压住、或者挂载点被页面脚本挪走，
    // 用户点按钮看不到任何变化，只会认定"打不开设置"。
    if ($existing.attr(INSTANCE_ATTR) === ctx.state.instanceId) {
      $existing.appendTo(p$('body'));
      $existing[0]?.style.setProperty('all', 'unset', 'important');
      logInfo(TAG.mount, MSG.panelRaised);
      return;
    }
    // 别的实例（或上一版脚本）留下的挂载点：删掉再挂，否则它会把新面板一直挡在外面
    $existing.remove();
    logInfo(TAG.mount, MSG.panelStaleRemoved);
  }

  loadSettings(ctx);

  const $host = createScriptIdDiv().attr('id', MODAL_HOST_ID).appendTo('body');
  $host.attr(INSTANCE_ATTR, ctx.state.instanceId);
  // 挂载点自身先复位：外界的美化规则若给 body 下的 div 设了 transform / filter /
  // perspective，面板这个 position: fixed 的蒙层就会改成相对它定位，整个面板会错位。
  // 样式表里也有一条 #rh-prefs-host 的同类规则，两处互为保险（这里不依赖 id 拼写）。
  $host[0]?.style.setProperty('all', 'unset', 'important');

  let destroyStyles = (): void => {};
  let alreadyClosed = false;

  const close = (): void => {
    if (alreadyClosed) return;
    alreadyClosed = true;
    app.unmount();
    $host.remove();
    destroyStyles();
  };

  const app = createApp(SettingsPanel, {
    settings: ctx.settings,
    // 面板里「预览这次会发什么」要真去取一遍世界书/表格，必须拿着同一个 ctx
    ctx,
    onSave: (settings: RerushSettings) => {
      saveSettings(ctx, settings);
      ctx.onSettingsSaved?.();
      // 存完要当场告诉人一声：面板底部的按钮没有任何回执，用户会以为没点上。
      pageToastr()?.success(MSG.settingsSaved);
    },
    onClose: close,
  });

  app.mount($host[0]);
  // 面板样式在 iframe 里生成，酒馆页面看不到，必须复制过去
  destroyStyles = teleportStyle().destroy;
}
