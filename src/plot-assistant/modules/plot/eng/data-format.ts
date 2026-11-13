/**
 * 剧情推进 — 表格数据的文本格式化（$5 总体大纲 / $5 纪要索引；$9 归 data/worldbook-hits.ts）
 *
 * 这一层只做「把已经拿到的表格 JSON 变成给 LLM 看的文字」，
 * 不碰世界书、不碰角色卡、不发请求 —— 取数在 data/ 层。
 *
 * 行为以 ACU tag naiv1.3 的 plot-data-format.ts 为准，逐字节对齐，
 * 对照测试见 tools/plot-parity/parity-data.ts。
 */

/** 表格表：content[0] 是表头行，第一列通常是行号，从第二列开始才是真正字段。 */
export interface PlotTableSheet {
  name?: string;
  content?: unknown[][];
}

/** 所有表格，键是表格 id，值是表。 */
export type PlotTablesJson = Record<string, PlotTableSheet | undefined>;

/** 保留的上游对照实现：把整张表拼成文本；当前全仓零调用。 */
export function formatTableDataForLLM(jsonData: PlotTablesJson | null | undefined): string {
  if (!jsonData || typeof jsonData !== 'object' || Object.keys(jsonData).length === 0) {
    return '当前无任何可用的表格数据。';
  }

  let output = '以下是当前角色聊天记录中，由st-memory-enhancement插件保存的全部表格数据：\n';

  for (const sheetId in jsonData) {
    if (!Object.prototype.hasOwnProperty.call(jsonData, sheetId)) continue;

    const sheet = jsonData[sheetId];
    if (!sheet || !sheet.name || !sheet.content || sheet.content.length <= 1) continue;

    output += `\n## 表格: ${sheet.name}\n`;
    const headers = (sheet.content[0] as unknown[]).slice(1);
    const rows = sheet.content.slice(1);

    rows.forEach((row, rowIndex) => {
      const rowData = (row as unknown[]).slice(1);
      let rowOutput = '';
      let hasContent = false;

      headers.forEach((header, index) => {
        const cellValue = rowData[index];
        if (cellValue !== null && cellValue !== undefined && String(cellValue).trim() !== '') {
          rowOutput += `  - ${header}: ${cellValue}\n`;
          hasContent = true;
        }
      });

      if (hasContent) {
        output += `\n### ${sheet.name} - 第 ${rowIndex + 1} 条记录\n${rowOutput}`;
      }
    });
  }

  output += '\n--- 表格数据结束 ---\n';
  return output;
}

/** 总体大纲表的名字。$5 只认这一张。 */
export const OUTLINE_TABLE_NAME = '总体大纲';

/** $5 的大纲形态：只注入「总体大纲」表，带表头，一行一条。 */
export function formatOutlineTable(allTablesJson: PlotTablesJson | null | undefined): string {
  try {
    if (!allTablesJson || typeof allTablesJson !== 'object') {
      return '总体大纲表：未获取到表格数据。';
    }

    const sheets = Object.values(allTablesJson).filter(
      (x): x is PlotTableSheet => !!x && typeof x === 'object' && !!x.name && !!x.content,
    );
    const outline = sheets.find(s => String(s.name || '').trim() === OUTLINE_TABLE_NAME);

    if (!outline || !Array.isArray(outline.content) || outline.content.length === 0) {
      return '总体大纲表：未找到该表或表结构为空。';
    }

    const headerRow = Array.isArray(outline.content[0]) ? outline.content[0] : [];
    const headers = headerRow
      .slice(1)
      .map(h => String(h ?? '').trim())
      .filter(Boolean);

    let out = `## 表格: ${OUTLINE_TABLE_NAME}\n`;
    out += headers.length ? `Columns: ${headers.join(', ')}\n` : 'Columns: (无表头)\n';

    const rows = outline.content.slice(1).filter(r => Array.isArray(r));
    if (rows.length === 0) {
      out += '(无数据行)\n';
      return out;
    }

    rows.forEach((row, idx) => {
      const cells = (row as unknown[]).slice(1);
      const parts: string[] = [];
      for (let i = 0; i < headers.length; i++) {
        const v = cells[i];
        if (v !== null && v !== undefined && String(v).trim() !== '') {
          parts.push(`${headers[i]}: ${String(v)}`);
        }
      }
      out += parts.length ? `- [${idx}] ${parts.join(' | ')}\n` : `- [${idx}] (空行)\n`;
    });

    return out;
  } catch {
    return '总体大纲表：格式化时发生错误。';
  }
}

/** 纪要表的名字候选，按顺序认第一个。 */
export const SUMMARY_TABLE_NAMES = ['纪要表', '总结表'] as const;
/** 概要列的名字候选。 */
export const SUMMARY_COLUMN_NAMES = ['概览', '概要'] as const;
/** 编码索引列的名字。 */
export const SUMMARY_INDEX_COLUMN_NAME = '编码索引';

/** $5 的纪要索引形态：只取「概要 + 编码索引」两列。 */
export function formatSummaryIndex(allTablesJson: PlotTablesJson | null | undefined): {
  success: boolean;
  content: string;
} {
  try {
    if (!allTablesJson || typeof allTablesJson !== 'object') {
      return { success: false, content: '纪要索引：未获取到表格数据。' };
    }

    const sheets = Object.values(allTablesJson).filter(
      (x): x is PlotTableSheet => !!x && typeof x === 'object' && !!x.name && !!x.content,
    );
    const summaryTable = sheets.find(s => {
      const name = String(s.name || '').trim();
      return (SUMMARY_TABLE_NAMES as readonly string[]).includes(name);
    });

    if (!summaryTable) {
      return { success: false, content: '纪要索引：未找到纪要表。' };
    }

    if (!Array.isArray(summaryTable.content) || summaryTable.content.length <= 1) {
      return { success: false, content: '纪要索引：纪要表为空。' };
    }

    const headerRow = Array.isArray(summaryTable.content[0]) ? summaryTable.content[0] : [];

    const summaryColIdx = headerRow.findIndex(h => {
      const name = String(h ?? '').trim();
      return (SUMMARY_COLUMN_NAMES as readonly string[]).includes(name);
    });
    const indexColIdx = headerRow.findIndex(
      h => String(h ?? '').trim() === SUMMARY_INDEX_COLUMN_NAME,
    );

    if (summaryColIdx === -1 || indexColIdx === -1) {
      return { success: false, content: '纪要索引：未找到概要列或编码索引列。' };
    }

    let out = `## 表格: 纪要索引\n`;
    out += `Columns: 概要, 编码索引\n`;

    const rows = summaryTable.content.slice(1).filter(r => Array.isArray(r));
    if (rows.length === 0) {
      out += '(无数据行)\n';
      return { success: true, content: out };
    }

    rows.forEach((row, idx) => {
      const cells = row as unknown[];
      const summary = cells[summaryColIdx] ? String(cells[summaryColIdx]).trim() : '';
      const indexCode = cells[indexColIdx] ? String(cells[indexColIdx]).trim() : '';
      if (summary || indexCode) {
        out += `- [${idx}] 概要: ${summary} | 编码索引: ${indexCode}\n`;
      }
    });

    return { success: true, content: out };
  } catch {
    return { success: false, content: '纪要索引：格式化时发生错误。' };
  }
}

/** 世界书里那条「纪要索引」条目的 comment 后缀。 */
export const SUMMARY_INDEX_COMMENT = 'TavernDB-ACU-CustomExport-纪要索引';

/**
 * 从世界书条目里挑出「纪要索引」那一条的正文。
 *
 * 取数（哪个世界书、哪些条目）在这一层之外，这里只负责挑。
 * 三个细节必须照原样保留，测试都盯着它们：
 *  1. 按 bookNames 的顺序逐个书找，**先命中的书优先**，不是全书一起找。
 *  2. 同一本书内 `.find` 只取**第一条** comment 匹配的条目；这条没有正文也**不会**继续在这本书里往下找。
 *  3. comment 的判定是「等于（带隔离前缀）」或「以裸名结尾」，后者兼容被加了前缀的情况。
 */
export function pickSummaryIndexEntry(
  entriesByBook: Record<string, unknown[] | undefined>,
  bookNames: readonly string[],
  isolationPrefix = '',
): string | null {
  const targetComment = isolationPrefix + SUMMARY_INDEX_COMMENT;

  for (const bookName of bookNames) {
    const indexEntry = entriesByBook[bookName]?.find((entry: any) => {
      const comment = String(entry?.comment || '').trim();
      return comment === targetComment || comment.endsWith(SUMMARY_INDEX_COMMENT);
    }) as { content?: unknown } | undefined;

    if (indexEntry?.content) {
      return String(indexEntry.content);
    }
  }

  return null;
}

/**
 * `$5` 的取值链 —— 移植自 `plot-task-engine.ts:241-257`。
 *
 * 三档，顺序不能换：
 *   ① 世界书里那条「纪要索引」条目有正文 → 用它（交火模式下会覆盖这一条，所以要先看）
 *   ② 否则退到本地表格：`formatSummaryIndex`（纪要表的「概要 + 编码索引」两列）
 *   ③ 纪要表读不到 → `formatOutlineTable`（总体大纲表）
 *   ④ 连表格数据都没有 → 一句固定占位文案
 *
 * ⚠️ ②③ 之间**不是按内容长短或完整度挑**，是「纪要表能不能读出来」的二选一。
 * 顺手改成「两个都格式化取更长的」会让用户在只填了总体大纲时看到一份不存在于任何表里的混合文本。
 *
 * 取数（世界书条目从哪读、表格从哪合并）不在这里，`worldbookContent` 与 `tableData` 都由调用方给。
 */
export const NO_TABLE_FALLBACK_TEXT = '纪要索引：当前未加载到数据库数据。';

export interface SummaryIndexInput {
  /** 世界书「纪要索引」条目的正文 */
  worldbookContent?: string | null;
  /** 已合并的表格数据 */
  tableData?: PlotTablesJson | null;
}

export function resolveSummaryIndexText(input: SummaryIndexInput): string {
  const worldbook = typeof input?.worldbookContent === 'string' ? input.worldbookContent : '';
  if (worldbook.trim()) return worldbook;

  const tableData = input?.tableData;
  if (!tableData || typeof tableData !== 'object') return NO_TABLE_FALLBACK_TEXT;

  const summary = formatSummaryIndex(tableData);
  if (summary.success) return summary.content;
  return formatOutlineTable(tableData);
}
