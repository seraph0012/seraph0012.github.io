import JSZip from "https://esm.sh/jszip@3";
import { requireAuth } from "./shared/authGuard.js";
import { renderNav } from "./shared/nav.js";
import { listModules, listMeetingWeeks, listWeeklyTaskEntries } from "./shared/db.js";
import { sourceIdOf, buildSourceDetailMap } from "./shared/taskLabels.js";
import { weekdayLabel } from "./shared/dateUtils.js";
import {
  parseXml,
  serializeXml,
  findTable,
  fillTable,
  mergeVerticalCells,
  rewriteMeetingHeader,
  clearReviewSlide,
  getOrderedSlidePaths,
} from "./shared/pptxTable.js";

const session = await requireAuth();
if (!session) {
  throw new Error("not authenticated");
}
renderNav();

const TEMPLATE_URL = "./assets/weekly_report_template.pptx";

const PRIORITY_LABEL = {
  urgent_important: "紧急且重要",
  important_not_urgent: "重要不紧急",
  urgent_not_important: "紧急不重要",
  neither: "不紧急不重要",
};
const RISK_LABEL = { green: "低", yellow: "中", red: "高" };

// PLAN/SUMMARY/STOPPED三张表的前4列都是模块/类别/任务1级/任务2级，竖向合并规则一致：
// 任务2级(列3)即使文字重复，只要任务1级(列2)换了也要断开合并，不能跨1级边界合并
const MERGE_COLS = [0, 1, 2, 3];
const MERGE_DEPENDENCY = { 3: 2 };

// 幻灯片按标题文字定位，不写死slide序号——模板哪天在PowerPoint里重新保存、内部XML文件
// 重新编号也不受影响（跟ppt_utils.py的extract_ppt()按标题文字识别topic是同一个思路）。
const TITLE_REVIEW = "周工作计划复核情况";
const TITLE_SUMMARY = "周工作总结";
const TITLE_PLAN = "本周工作计划";
const TITLE_STOPPED = "未启动/中止工作";

let allModules = [];
let moduleNameById = new Map();
let allWeeks = [];
let targetWeek = null;
let previousWeek = null;

function findPreviousWeek(week) {
  const earlier = allWeeks.filter((w) => w.natural_week_start < week.natural_week_start);
  if (earlier.length === 0) return null;
  return earlier.reduce((a, b) => (a.natural_week_start > b.natural_week_start ? a : b));
}

function renderInfo() {
  const el = document.getElementById("week-info");
  if (!targetWeek) {
    el.textContent = "";
    return;
  }
  const monthLabel = targetWeek.calendar_month ? targetWeek.calendar_month.slice(5, 7) : "?";
  el.textContent =
    `本周计划：${monthLabel}月份第${targetWeek.week_index_in_month}周（例会${targetWeek.meeting_date}）｜` +
    `上周总结来源：${previousWeek ? previousWeek.natural_week_start + " ~ " + previousWeek.natural_week_end : "（没有更早的例会周，本次不生成上周总结部分）"}`;
}

// ---- 分组延续行留空，配合mergeVerticalCells按空/非空识别合并区间（跟历史PPT数据的
// 编写约定一致：同组的第2行起模块/类别/任务1/2级留空，见plan文件"OOXML表格合并结构"一节）----
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

function sortKey(e, detail) {
  return [moduleNameById.get(e.module_id) || "", detail.level1 ?? 0, detail.level2 ?? 0, detail.level3 ?? 0].join("");
}

// entries + detailMap -> 二维字符串数组（每行14列，PLAN/STOPPED共用同一套列布局）
function buildPlanLikeRows(entries, detailMap) {
  const sorted = [...entries].sort((a, b) =>
    sortKey(a, detailMap.get(`${a.source_type}:${sourceIdOf(a)}`) || {}).localeCompare(
      sortKey(b, detailMap.get(`${b.source_type}:${sourceIdOf(b)}`) || {})
    )
  );
  const rows = sorted.map((e) => {
    const detail = detailMap.get(`${e.source_type}:${sourceIdOf(e)}`) || {};
    return [
      moduleNameById.get(e.module_id) || "",
      e.plan_category || "",
      detail.level1Text || "",
      detail.level2Text || "",
      detail.level3Text || "",
      e.owner || "",
      e.deliverable_this_week || "",
      e.planned_hours != null ? String(e.planned_hours) : "",
      weekdayLabel(e.plan_start_date),
      weekdayLabel(e.execution_deadline),
      detail.targetDeliverable || "",
      detail.completionDate || "",
      PRIORITY_LABEL[e.priority_quadrant] || "",
      e.resources_needed || "无",
    ];
  });
  const blanked = blankRepeatingColumns(rows, [0, 1, 2, 3], { 3: 2 });
  return blanked.map((row, i) => {
    const fills = rowFills(!!sorted[i].highlight, row.length);
    return row.map((text, c) => ({ text, fill: fills[c] }));
  });
}

function buildSummaryRows(entries, detailMap) {
  const sorted = [...entries].sort((a, b) =>
    sortKey(a, detailMap.get(`${a.source_type}:${sourceIdOf(a)}`) || {}).localeCompare(
      sortKey(b, detailMap.get(`${b.source_type}:${sourceIdOf(b)}`) || {})
    )
  );
  const rows = sorted.map((e) => {
    const detail = detailMap.get(`${e.source_type}:${sourceIdOf(e)}`) || {};
    return [
      moduleNameById.get(e.module_id) || "",
      e.summary_category || "",
      detail.level1Text || "",
      detail.level2Text || "",
      detail.level3Text || "",
      e.owner || "",
      e.deliverable_this_week || "",
      e.status || "",
      e.actual_hours != null ? String(e.actual_hours) : "",
      e.incomplete_reason || "",
      e.rectification_measures || "",
      RISK_LABEL[e.risk_level] || "",
      detail.targetDeliverable || "",
      detail.sourceStatus || "",
      detail.completionDate || "",
    ];
  });
  const blanked = blankRepeatingColumns(rows, [0, 1, 2, 3], { 3: 2 });
  const RISK_COL = 11; // 风险说明——按risk_level(green/yellow/red)填色，跟highlight强调色互不干扰
  return blanked.map((row, i) => {
    const fills = rowFills(!!sorted[i].highlight, row.length);
    if (sorted[i].risk_level) fills[RISK_COL] = sorted[i].risk_level;
    return row.map((text, c) => ({ text, fill: fills[c] }));
  });
}

// 模板里SUMMARY/PLAN/STOPPED各有一张"分节标题"幻灯片（大号章节数字，无表格）紧挨在正式的
// "标题+表格"幻灯片之前，而且两张幻灯片的标题文字是一样的——所以光靠标题文字匹配会先命中
// 分节标题那张空页。这里额外要求命中的幻灯片必须带表格，跳过纯分节标题页。
function findSlideDocByTitle(slideDocs, titleText) {
  for (const doc of slideDocs) {
    const texts = Array.from(doc.getElementsByTagNameNS("http://schemas.openxmlformats.org/drawingml/2006/main", "t"));
    const joined = texts.map((t) => t.textContent).join("");
    if (joined.includes(titleText) && findTable(doc)) return doc;
  }
  return null;
}

async function generatePpt() {
  const [planEntries, summaryEntries, stoppedEntries] = await Promise.all([
    listWeeklyTaskEntries(targetWeek.id, "plan"),
    previousWeek ? listWeeklyTaskEntries(previousWeek.id, "summary") : Promise.resolve([]),
    listWeeklyTaskEntries(targetWeek.id, "stopped"),
  ]);

  const detailItems = [...planEntries, ...summaryEntries, ...stoppedEntries].map((e) => ({
    source_type: e.source_type,
    source_id: sourceIdOf(e),
  }));
  const detailMap = await buildSourceDetailMap(detailItems);

  const planRows = buildPlanLikeRows(planEntries, detailMap);
  const summaryRows = buildSummaryRows(summaryEntries, detailMap);
  const stoppedRows = buildPlanLikeRows(stoppedEntries, detailMap);

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
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);

  return {
    planCount: planRows.length,
    summaryCount: summaryRows.length,
    stoppedCount: stoppedRows.length,
    filename,
  };
}

document.getElementById("generate-btn").addEventListener("click", async () => {
  const resultEl = document.getElementById("generate-result");
  if (!targetWeek) return;
  resultEl.textContent = "生成中...";
  resultEl.className = "status";
  try {
    const r = await generatePpt();
    resultEl.textContent =
      `已生成并下载 ${r.filename}（上周总结 ${r.summaryCount} 条，本周计划 ${r.planCount} 条，` +
      `未启动/中止 ${r.stoppedCount} 条）——请打开核对合并单元格/颜色/文字是否正确`;
    resultEl.className = "status ok";
  } catch (err) {
    resultEl.textContent = `失败：${err.message}`;
    resultEl.className = "status error";
  }
});

async function init() {
  const [modules, weeks] = await Promise.all([listModules(), listMeetingWeeks()]);
  allModules = modules;
  moduleNameById = new Map(allModules.map((m) => [m.id, m.name]));
  allWeeks = weeks.filter((w) => w.is_normal !== false);

  const weekSelect = document.getElementById("week-select");
  const sorted = [...allWeeks].sort((a, b) => new Date(a.natural_week_start) - new Date(b.natural_week_start));
  for (const w of sorted) {
    const opt = document.createElement("option");
    opt.value = w.id;
    opt.textContent = `${w.natural_week_start} ~ ${w.natural_week_end}（例会${w.meeting_date}）`;
    weekSelect.appendChild(opt);
  }
  const today = new Date();
  const defaultWeek = sorted.find((w) => new Date(w.natural_week_start) > today) || sorted[sorted.length - 1];
  if (defaultWeek) {
    weekSelect.value = defaultWeek.id;
    targetWeek = defaultWeek;
    previousWeek = findPreviousWeek(targetWeek);
    renderInfo();
  }

  weekSelect.addEventListener("change", () => {
    targetWeek = allWeeks.find((w) => w.id === Number(weekSelect.value));
    previousWeek = findPreviousWeek(targetWeek);
    renderInfo();
  });
}

await init();
