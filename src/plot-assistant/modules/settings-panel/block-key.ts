/**
 * 提示词块的「跟着块走」的稳定标识。
 *
 * 为什么需要：块的展开 / 折叠状态存在块卡片组件内部，而任务编辑器原先拿
 * 「数组下标」当列表标识。上移下移只是换位置，标识却跟着位置走 ——
 * 于是展开状态被换到旁边那块身上（点丙上移，丙反而折叠、乙自动展开）。
 *
 * 这里用模块级 WeakMap 给每个块对象发一个只在本次运行期有效的名字：
 * 不写进预设数据、不污染导出的 JSON，块被删掉后也能被回收。
 * 块对象本身不变（moveBlock 是原对象重排，不克隆），所以移动后标识不变。
 */
import type { TaskBlockDraft } from '../plot/preset-edit';

const keys = new WeakMap<TaskBlockDraft, string>();
let sequence = 0;

/** 同一个块对象永远返回同一个名字；不同块对象永远不同名。 */
export function blockKeyOf(block: TaskBlockDraft): string {
  let key = keys.get(block);
  if (key === undefined) {
    sequence += 1;
    key = `block-${sequence}`;
    keys.set(block, key);
  }
  return key;
}
