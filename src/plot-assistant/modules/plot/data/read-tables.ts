/**
 * 取数层 · 表格数据（第 2 期，决策点 7 定案：读数据库原生那份）
 *
 * 表格存在聊天消息的 `TavernDB_ACU_*` 字段上，但现代 ACU 用的是帧式存储 v2
 * （一份表拆成多帧，还带自动合并 / 修复 / 迁移几道工序）。自己解析那条链实测
 * 传递闭包 352 个文件 / 120,658 行，不值当。
 *
 * 所以走 ACU 自己的读取器：`AutoCardUpdaterAPI.exportTableAsJson()` 返回的是
 * ACU 内存里那份已经解析好的表格 —— 与面板上看到、正文 AI 读到的是同一份。
 *
 * **表格在这条链上只喂一处**：`$5`（纪要索引）的三级兜底
 * —— 世界书里的「纪要索引」条目 → 纪要表的「概览 / 概要 + 编码索引」列 → 总体大纲表。
 * 另外还喂表名占位符 `{{表名}}`（那部分在注入层做，不在这里）。
 *
 * 注意 `$9` **不是**表格：`$9` 是「世界书内容，但剔掉数据库生成的条目」，
 * 归 `worldbook-hits.ts` 管。上游 `formatTableDataForLLM_ACU` 虽然仍有定义，
 * 但全仓零调用（死代码），这里也不再拿它产出任何占位符。
 *
 * **边界行为照 ACU 原样**：读不到就是读不到，`$5` 按它原有顺序往下兜，任务照跑，
 * 不判定失败、不弹提示。`error` 只交给运行日志，供事后查因。
 */

import { isPlainObject } from '../guards';
import { resolveSummaryIndexText, type PlotTablesJson } from '../eng/data-format';
import { acuHostWindows } from './acu-presets';

/** ACU 对外只暴露这一个命名空间；只声明本文用到的成员，避免和 ACU 类型漂移。 */
export interface AcuTableApiLike {
  exportTableAsJson?: () => unknown;
}

export interface TableReadResult {
  tables: PlotTablesJson;
  /** 只在真出问题时才有值（ACU 不在场 / 它自己抛错）。交给运行日志，不上面板。 */
  error?: string;
}

function toPlainObject(value: unknown): PlotTablesJson {
  if (!isPlainObject(value)) return {};
  return value as PlotTablesJson;
}

/**
 * 拿 ACU 的表格接口。
 *
 * **不能只看 `globalThis`**：我们的脚本跑在酒馆助手的 iframe 里，而数据库脚本把
 * `AutoCardUpdaterAPI` 挂在**主页面**的 window 上 —— 在 iframe 里 `globalThis` 就是
 * 自己这一层，永远取到 `undefined`，`$5` 于是永远是空的。2026-11-01 实测：
 * 主页面 `exportTableAsJson()` 返回 11 张表（纪要表 7 个键），而 iframe 里
 * `globalThis.AutoCardUpdaterAPI` 是 undefined，纪要索引一个字段都没喂进去。
 *
 * 所以交给 `acuHostWindows()` 从自己往父窗口、顶层窗口依次找。它在纯 Node 测试里
 * 返回空数组，行为与原来「读不到就是读不到」一致。
 */
function resolveAcuApi(): AcuTableApiLike | null {
  for (const host of acuHostWindows()) {
    let api: unknown;
    try {
      api = host.AutoCardUpdaterAPI;
    } catch {
      continue;
    }
    if (!api || typeof api !== 'object') continue;
    const candidate = api as AcuTableApiLike;
    if (typeof candidate.exportTableAsJson === 'function') return candidate;
  }
  return null;
}

/**
 * 读一次表格。`api` 可注入，测试里喂个假对象就不必依赖真实酒馆。
 *
 * 「ACU 在、但一张表都没有」不算错误 —— 新聊天还没填过表就是这样，ACU 那边也照跑。
 */
export function readAcuTables(api: AcuTableApiLike | null = resolveAcuApi()): TableReadResult {
  if (!api || typeof api.exportTableAsJson !== 'function') {
    return { tables: {}, error: '没找到 AutoCardUpdaterAPI，$5 的表格兜底取不到数据。' };
  }
  try {
    return { tables: toPlainObject(api.exportTableAsJson()) };
  } catch (error) {
    return { tables: {}, error: `读取表格时数据库脚本报错：${String((error as { message?: unknown })?.message ?? error)}` };
  }
}

export interface SummaryIndexInput {
  tables: PlotTablesJson;
  /** `$5` 的世界书来源（纪要索引条目正文）；没有就交给表格兜底。 */
  worldbookContent?: string | null;
}

/**
 * 算 `$5`。三级顺序照上游：世界书条目 → 纪要表 → 总体大纲 → 一句固定文案。
 * 具体判定在 `resolveSummaryIndexText` 里（第五套已锁 9 条用例）。
 */
export function buildSummaryIndexText(input: SummaryIndexInput): string {
  return resolveSummaryIndexText({
    worldbookContent: input.worldbookContent ?? '',
    tableData: toPlainObject(input.tables),
  });
}
