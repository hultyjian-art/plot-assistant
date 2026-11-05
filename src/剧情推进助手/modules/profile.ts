/**
 * 产物档案（BuildProfile）：记录本产物的显示名与脚本按钮文字。
 *
 * 显示名（displayName）决定菜单入口文字、面板标题、Console 日志前缀；
 * 脚本按钮的文字另由 buttonName 给出 —— 面板叫「剧情推进助手」，
 * 但按钮沿用「推进重刷」这个老名字：按钮是用户肌肉记忆里的位置，跟着改会让人找不到。
 */
import type { RerushContext } from './types';

export interface BuildProfile {
  /** 产物显示名：菜单入口、面板标题、日志前缀都用它 */
  displayName: string;
  /**
   * 脚本按钮（QR / 快捷区）的文字。
   *
   * 与显示名分开：面板已经改名「剧情推进助手」，但按钮沿用「推进重刷」这个老名字 ——
   * 按钮是用户肌肉记忆里的位置，跟着改会让人找不到。
   */
  buttonName: string;
}

let active: BuildProfile;

/** 入口在装载前调用一次；其余模块一律通过 profile() 取本产物的差异。 */
export function useProfile(profile: BuildProfile): void {
  active = profile;
}

export function profile(): BuildProfile {
  return active;
}
