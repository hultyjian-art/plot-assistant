/**
 * 页面访问辅助模块。
 * 把"跨 iframe 拿酒馆那边的 jQuery / toastr / SillyTavern"这类动作收在一处，
 * 其余模块不直接碰 window.parent。
 */
import type { RerushWindow, TavernContextLike, TavernLike } from './types';

function hostWindow(win: Window): RerushWindow {
  return win as RerushWindow;
}

/** 脚本自己所在的窗口。 */
function selfWindow(): RerushWindow {
  // node 里（对照测试直接 require 本模块）没有 window，取它会直接 ReferenceError。
  // 返回空壳让调用方照常走「拿不到就降级」的分支，而不是把整个测试套件炸掉。
  if (typeof window === 'undefined') return {} as RerushWindow;
  return hostWindow(window);
}

/** 酒馆页面所在的父窗口。 */
export function parentWindow(): RerushWindow {
  // 同 selfWindow：node 里没有 window.parent，返回空壳让调用方降级。
  if (typeof window === 'undefined') return {} as RerushWindow;
  return hostWindow(window.parent);
}

/** 作用于酒馆页面的 jQuery（脚本 iframe 里的 $ 选不到宿主 DOM）。 */
export function pageQuery(): JQueryStatic {
  return parentWindow().$ || selfWindow().$ || $;
}

/** 酒馆页面的 toastr 实例。 */
export function pageToastr(): typeof toastr {
  return parentWindow().toastr || selfWindow().toastr || toastr;
}

/** SillyTavern 全局对象；先找当前窗口，再找父窗口。 */
export function tavernGlobal(): TavernLike | null {
  return selfWindow().SillyTavern || parentWindow().SillyTavern || null;
}

/** 酒馆助手挂出的全局对象；先找当前窗口，再找父窗口。 */
export function helperGlobal(): RerushWindow['TavernHelper'] | undefined {
  return selfWindow().TavernHelper || parentWindow().TavernHelper;
}

/**
 * 酒馆上下文（`SillyTavern.getContext()` 的返回值）。
 * 取不到、或这版酒馆的 getContext 抛错时返回 null——调用方负责降级。
 */
export function stContext(): TavernContextLike | null {
  const tavern = tavernGlobal();
  if (!tavern || typeof tavern.getContext !== 'function') return null;
  try {
    return tavern.getContext() ?? null;
  } catch {
    return null;
  }
}

/** AI 是否正在输出：停止按钮可见或发送按钮隐藏都算。 */
export function aiIsStreaming(): boolean {
  const p$ = pageQuery();
  return p$('#stop_but').is(':visible') || p$('#send_but').is(':hidden');
}

/**
 * 输入框里是否留着没发出去的草稿。
 * 原生重刷要求输入框为空，删层流程也怕踩到没发出的内容；
 * 判定逻辑集中在此，避免各模块各写一遍。
 */
export function hasDraft(): boolean {
  return String(pageQuery()('#send_textarea').val() ?? '').trim() !== '';
}

/**
 * 用户是否正在编辑某个历史楼层。
 * 三种呈现都算：楼层自带编辑框、编辑取消按钮、QR 区编辑器展开。
 * 编辑态下删楼会让酒馆停在半完成状态，所以此时一律拒绝动作。
 */
export function historyEditOpen(): boolean {
  const p$ = pageQuery();
  const editBoxShown = p$('.mes_edit_box:visible, .mes_edit_textarea:visible, .edit_textarea:visible').length > 0;
  const editCancelShown = p$('.mes_edit_cancel:visible, .qr--editor-cancel:visible').length > 0;
  const qrEditorShown = p$('#qr--editor:visible').length > 0;
  return editBoxShown || editCancelShown || qrEditorShown;
}
