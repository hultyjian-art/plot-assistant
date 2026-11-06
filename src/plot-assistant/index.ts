/**
 * 剧情推进助手 —— 入口。
 *
 * 声明本产物的显示名与脚本按钮文字，然后启动。
 * 手势识别、捕获链（含 AI楼层模式与正则排序）、删层、真实点击发送、设置面板照常。
 */
import { useProfile } from './modules/profile';
import { startRerush } from './modules/lifecycle';

useProfile({
  displayName: '剧情推进助手',
  buttonName: '推进重刷',
});

startRerush();
