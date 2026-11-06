/**
 * 脚本按钮模块：
 * - 用酒馆助手官方接口把按钮注册到 QR / 脚本按钮区
 * - 从 `#script_container_<scriptId>` 里把渲染出来的按钮找回来
 * 按钮文字就是产物显示名（完整版「剧情推进助手」/ 轻量版「剧情推进助手·轻」），注册与找回共用同一个来源。
 */
import { profile } from './profile';
import { pageQuery } from './tavern';

/** 幂等注册：替换式写入，不会残留历史版本的按钮文字。 */
export function declareScriptButton(): void {
  replaceScriptButtons([{ name: profile().buttonName, visible: true }]);
}

/** 找到本脚本在 QR 区的按钮，找不到返回 null。 */
export function findScriptButton(): JQuery<HTMLElement> | null {
  const p$ = pageQuery();
  const buttonName = profile().buttonName;

  const byLabel = ($scope: JQuery): JQuery<HTMLElement> =>
    $scope
      .find('.qr--button')
      .filter(function (this: HTMLElement) {
        return p$(this).text().trim() === buttonName;
      }) as JQuery<HTMLElement>;

  // 先按本脚本的容器精确定位
  const $own = p$(`#script_container_${getScriptId()}`);
  if ($own.length > 0) {
    const $btn = byLabel($own);
    if ($btn.length > 0) return $btn.first();
  }

  // 容器 id 拿不到时（扩展版本差异、容器被重建），退而按按钮文字在整条 QR 栏里找
  const $bar = p$('#qr--bar');
  if ($bar.length > 0) {
    const $btn = byLabel($bar);
    if ($btn.length > 0) return $btn.first();
  }

  return null;
}

export function scriptButtonExists(): boolean {
  return findScriptButton() !== null;
}
