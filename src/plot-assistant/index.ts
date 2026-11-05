/**
 * 剧情推进助手 —— 入口。
 *
 * 声明本产物的显示名与脚本按钮文字，然后启动。
 *
 * 面板标题、Console 日志前缀显示「剧情推进助手」；QR 按钮文字沿用「推进重刷」——
 * 按钮是用户肌肉记忆里的位置，改名字会让人找不到。
 *
 * 手势识别、捕获链（含 AI楼层模式与正则排序）、删层、真实点击发送、设置面板都在 modules 里。
 */
import { useProfile } from './modules/profile';
import { startRerush } from './modules/lifecycle';

useProfile({
  displayName: '剧情推进助手',
  buttonName: '推进重刷',
});

startRerush();
