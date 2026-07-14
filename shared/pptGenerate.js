// 从ppt-export.js抽取出来的纯生成逻辑，供weekly-report.js调用。不在这里触发下载，
// 下载动作留给调用方（2026-07-13周报工作流重新设计，见
// tools/.claude/plans/plan-weekly-report-unified-workflow.md）。
import JSZip from "https://esm.sh/jszip@3";
import { listWeeklyTaskEntries } from "./db.js";
import { buildSourceDetailMap } from "./taskLabels.js";
import { weekdayLabel, monthDayLabel } from "./dateUtils.js";
import {
  parseXml,
  serializeXml,
  findTable,
  fillTable,
  mergeVerticalCells,
  rewriteMeetingHeader,
  clearReviewSlide,
  getOrderedSlidePaths,
} from "./pptxTable.js";

const TEMPLATE_URL = "./assets/weekly_report_template.pptx";

const PRIORITY_LABEL = {
  urgent_important: "重要紧急",
  important_not_urgent: "重要不紧急",
  urgent_not_important: "不重要紧急",
  neither: "不重要不紧急",
};
const RISK_LABEL = { green: "低", yellow: "中", red: "高" };

const RISK_HIGHLIGHT = { green: "00FF00", yellow: "FFFF00", red: "FF0000" };
const PRIORITY_HIGHLIGHT = {
  urgent_important: "FF0000",
  important_not_urgent: "FFFF00",
  urgent_not_important: "00FFFF",
  neither: "00FF00",
};

const MERGE_COLS = [0, 1, 2, 3];
const MERGE_DEPENDENCY = { 3: 2 };

const TITLE_REVIEW = "周工作计划复核情况";
const TITLE_SUMMARY = "周工作总结";
const TITLE_PLAN = "本周工作计划";
const TITLE_STOPPED = "未启动/中止工作";

function blankRepeatingColumns(rows, cols, dependency = {}) {
  const out = rows.map((r) => [...r]);
  const prevVal = {};
  const prevParent = {};
  for (let i = 0; i < rows.length; i++) {
    for (const c of cols) {
      const parent = dependency[c];
      const parentChanged = parent !== undefined && rows[i][parent] !== prevParent[c];
      if (i > 0 && rows[i][c] !== "" && rows[i][c] === prevVal[c] && !parentChanged) {
        out[i][c] = "";
      }
      prevVal[c] = rows[i][c];
      if (parent !== undefined) prevParent[c] = rows[i][parent];
    }
  }
  return out;
}

function rowFills(highlight, colCount) {
  return Array.from({ length: colCount }, (_, c) => (c < 2 ? "white" : highlight ? "highlight" : "white"));
}

function sortKey(e, detail, moduleNameById) {
  return [moduleNameById.get(e.module_id) || "", detail.level1 ?? 0, detail.level2 ?? 0, detail.level3 ?? 0].join("");
}

function buildPlanLikeRows(entries, detailMap, moduleNameById) {
  const sorted = [...entries].sort((a, b) =>
    sortKey(a, detailMap.get(a.task_id) || {}, moduleNameById).localeCompare(
      sortKey(b, detailMap.get(b.task_id) || {}, moduleNameById)
    )
  );
  const rows = sorted.map((e) => {
    const detail = detailMap.get(e.task_id) || {};
    return [
      moduleNameById.get(e.module_id) || "",
      e.plan_category || "",
      detail.level1Text || "",
      detail.level2Text || "",
      detail.level3Text || "",
      e.owner || "",
      e.deliverable_this_week || "",
      e.planned_hours != null ? `${e.planned_hours}h` : "",
      weekdayLabel(e.plan_start_date),
      weekdayLabel(e.execution_deadline),
      detail.targetDeliverable || "",
      monthDayLabel(detail.completionDate),
      PRIORITY_LABEL[e.priority_quadrant] || "",
      e.resources_needed || "无",
    ];
  });
  const blanked = blankRepeatingColumns(rows, [0, 1, 2, 3], { 3: 2 });
  const PRIORITY_COL = 12;
  return blanked.map((row, i) => {
    const fills = rowFills(!!sorted[i].highlight, row.length);
    return row.map((text, c) => ({
      text,
      fill: fills[c],
      textHighlight: c === PRIORITY_COL ? PRIORITY_HIGHLIGHT[sorted[i].priority_quadrant] : undefined,
    }));
  });
}

function buildSummaryRows(entries, detailMap, moduleNameById) {
  const sorted = [...entries].sort((a, b) =>
    sortKey(a, detailMap.get(a.task_id) || {}, moduleNameById).localeCompare(
      sortKey(b, detailMap.get(b.task_id) || {}, moduleNameById)
    )
  );
  const rows = sorted.map((e) => {
    const detail = detailMap.get(e.task_id) || {};
    return [
      moduleNameById.get(e.module_id) || "",
      e.summary_category || "",
      detail.level1Text || "",
      detail.level2Text || "",
      detail.level3Text || "",
      e.owner || "",
      e.deliverable_this_week || "",
      e.status || "",
      e.actual_hours != null ? `${e.actual_hours}h` : "",
      e.incomplete_reason || "",
      e.rectification_measures || "",
      RISK_LABEL[e.risk_level] || "",
      detail.targetDeliverable || "",
      detail.sourceStatus || "",
      monthDayLabel(detail.completionDate),
    ];
  });
  const blanked = blankRepeatingColumns(rows, [0, 1, 2, 3], { 3: 2 });
  const RISK_COL = 11;
  return blanked.map((row, i) => {
    const fills = rowFills(!!sorted[i].highlight, row.length);
    return row.map((text, c) => ({
      text,
      fill: fills[c],
      textHighlight: c === RISK_COL ? RISK_HIGHLIGHT[sorted[i].risk_level] : undefined,
    }));
  });
}

function findSlideDocByTitle(slideDocs, titleText) {
  for (const doc of slideDocs) {
    const texts = Array.from(doc.getElementsByTagNameNS("http://schemas.openxmlformats.org/drawingml/2006/main", "t"));
    const joined = texts.map((t) => t.textContent).join("");
    if (joined.includes(titleText) && findTable(doc)) return doc;
  }
  return null;
}

// targetWeek的计划 + previousWeek的总结，生成PPT。返回 {blob, filename, planCount, summaryCount,
// stoppedCount}，调用方负责触发下载（不在这里直接下载，方便以后如果要加预览环节）。
export async function generatePptForWeek(targetWeek, previousWeek, allModules) {
  const moduleNameById = new Map(allModules.map((m) => [m.id, m.name]));

  const [planEntries, summaryEntries, stoppedEntries] = await Promise.all([
    listWeeklyTaskEntries(targetWeek.id, "plan"),
    previousWeek ? listWeeklyTaskEntries(previousWeek.id, "summary") : Promise.resolve([]),
    listWeeklyTaskEntries(targetWeek.id, "stopped"),
  ]);

  const taskIds = [...planEntries, ...summaryEntries, ...stoppedEntries].map((e) => e.task_id);
  const detailMap = await buildSourceDetailMap(taskIds);

  const planRows = buildPlanLikeRows(planEntries, detailMap, moduleNameById);
  const summaryRows = buildSummaryRows(summaryEntries, detailMap, moduleNameById);
  const stoppedRows = buildPlanLikeRows(stoppedEntries, detailMap, moduleNameById);

  const templateBuf = await fetch(TEMPLATE_URL).then((r) => {
    if (!r.ok) throw new Error(`模板文件加载失败（${r.status}），检查 web/assets/weekly_report_template.pptx 是否存在`);
    return r.arrayBuffer();
  });
  const zip = await JSZip.loadAsync(templateBuf);
  const slidePaths = await getOrderedSlidePaths(zip);

  const slideDocs = [];
  for (const path of slidePaths) {
    const text = await zip.file(path).async("string");
    slideDocs.push({ path, doc: parseXml(text) });
  }

  const meetingDate = new Date(`${targetWeek.meeting_date}T00:00:00Z`);
  const line1 = `${meetingDate.getUTCMonth() + 1}月份第${targetWeek.week_index_in_month}周`;
  const line2 = `${meetingDate.getUTCFullYear()}年${meetingDate.getUTCMonth() + 1}月${meetingDate.getUTCDate()}日`;
  let meetingSlideFound = false;
  for (const { doc } of slideDocs) {
    if (rewriteMeetingHeader(doc, line1, line2)) {
      meetingSlideFound = true;
      break;
    }
  }
  if (!meetingSlideFound) throw new Error("模板里没找到例会日期标题幻灯片（匹配不到形如\"5月份第4周\"的文本框）");

  const reviewDoc = findSlideDocByTitle(slideDocs.map((s) => s.doc), TITLE_REVIEW);
  if (!reviewDoc) throw new Error(`模板里没找到"${TITLE_REVIEW}"幻灯片`);
  clearReviewSlide(reviewDoc);

  const summaryDoc = findSlideDocByTitle(slideDocs.map((s) => s.doc), TITLE_SUMMARY);
  if (!summaryDoc) throw new Error(`模板里没找到"${TITLE_SUMMARY}"幻灯片`);
  const summaryTable = findTable(summaryDoc);
  fillTable(summaryTable, summaryRows);
  mergeVerticalCells(summaryTable, MERGE_COLS, MERGE_DEPENDENCY);

  const planDoc = findSlideDocByTitle(slideDocs.map((s) => s.doc), TITLE_PLAN);
  if (!planDoc) throw new Error(`模板里没找到"${TITLE_PLAN}"幻灯片`);
  const planTable = findTable(planDoc);
  fillTable(planTable, planRows);
  mergeVerticalCells(planTable, MERGE_COLS, MERGE_DEPENDENCY);

  const stoppedDoc = findSlideDocByTitle(slideDocs.map((s) => s.doc), TITLE_STOPPED);
  if (!stoppedDoc) throw new Error(`模板里没找到"${TITLE_STOPPED}"幻灯片`);
  const stoppedTable = findTable(stoppedDoc);
  fillTable(stoppedTable, stoppedRows);
  mergeVerticalCells(stoppedTable, MERGE_COLS, MERGE_DEPENDENCY);

  for (const { path, doc } of slideDocs) {
    zip.file(path, serializeXml(doc));
  }

  const blob = await zip.generateAsync({ type: "blob" });
  const filename = `周例会${targetWeek.meeting_date.replace(/-/g, "")}-刘璇.pptx`;

  return {
    blob,
    filename,
    planCount: planRows.length,
    summaryCount: summaryRows.length,
    stoppedCount: stoppedRows.length,
  };
}
