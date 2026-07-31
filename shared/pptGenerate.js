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

// 任务1/2/3级(标题)列在buildPlanLikeRows/buildSummaryRows里都固定是索引2/3/4——两个函数
// 拼row数组时module/category永远是0/1，紧接着level1Text/level2Text/level3Text，后面才是
// 各自不同的字段。2026-07-16用户反馈：重点工作(highlight)只应该给任务标题这几列的单元格
// 上背景色，不该整行都上色(此前是"module/category之外的所有列都上色"，范围太大)。
const TITLE_COLS = [2, 3, 4];

// row传的是blankRepeatingColumns处理过之后的最终文本(即将写进单元格的内容)——同一个标题
// 列如果文本是空的(没有3级任务时level3Text本来就是""，或者该列因为跟上一行重复被合并
// 逻辑清空)，就不该上色，不然会出现一个染色但看起来空空如也的单元格(2026-07-16用户反馈)。
// mergedHighlight是mergedColHighlight()算出的"这一行(如果是合并区间起点)所在的合并区间
// 内，是否有任意成员被标记重点"，只对col 2/3(1级/2级，同时也是MERGE_COLS的一部分)有意义——
// 2026-07-24用户反馈的真实bug：OOXML竖向合并单元格里，PowerPoint渲染整块合并区域用的是
// "起点单元格"自己的格式，延续行单元格的格式在mergeVerticalCells()里会被整个清空(见
// pptxTable.js的mergeRange())。如果被标记重点的3级任务恰好挂在一个"1级/2级单元格已经跟
// 上面几行合并在一起、起点行本身没被标记重点"的位置，只看这一行自己的highlight算出来的
// 起点单元格填色永远是白色，整块合并区域都不会显示重点色——必须看"这个合并区间里有没有
// 任意一行被标记重点"，而不是只看起点行自己。
function rowFills(highlight, row, mergedHighlight = {}) {
  return row.map((text, c) => {
    if (!TITLE_COLS.includes(c) || text === "") return "white";
    const effective = mergedHighlight[c] !== undefined ? mergedHighlight[c] : highlight;
    return effective ? "highlight" : "white";
  });
}

// 按跟blankRepeatingColumns完全一致的分组规则(相邻行原始值相等 + dependency父列在区间内
// 不变)，对cols里每一列算出"合并区间起点那一行，这个区间内是否有任意一行被标记重点"——
// 只在起点行的返回对象里写入这一列的结果(非起点行不写，调用方据此判断"这一行是不是这一列
// 的合并起点"，不是起点的话直接沿用它自己的highlight即可，反正延续行的填色会被合并逻辑
// 整个清空，写不写都不影响最终视觉效果)。rows必须是原始(未blank)的行数组，因为分组边界
// 判断依据的是相邻原始值是否相等，跟blankRepeatingColumns内部用的比较基准完全一致。
function mergedColHighlight(rows, highlights, cols, dependency = {}) {
  const result = rows.map(() => ({}));
  for (const c of cols) {
    const parent = dependency[c];
    let groupStart = 0;
    let groupAny = !!highlights[0];
    for (let i = 1; i <= rows.length; i++) {
      const isEnd = i === rows.length;
      const parentChanged = !isEnd && parent !== undefined && rows[i][parent] !== rows[i - 1][parent];
      const breakGroup = isEnd || rows[i][c] !== rows[i - 1][c] || parentChanged;
      if (breakGroup) {
        result[groupStart][c] = groupAny;
        if (!isEnd) {
          groupStart = i;
          groupAny = !!highlights[i];
        }
      } else {
        groupAny = groupAny || !!highlights[i];
      }
    }
  }
  return result;
}

// entries不在这里重排——2026-07-15起改成直接沿用weekly_task_entries.sort_order的顺序
// (db.js的listWeeklyTaskEntries已经按这个排好)，不再自动按模块+WBS编号重排。用户反馈
// 手动做PPT时顺序是当时开会念到的顺序，比如"上周未完成"经常排在"本周新增"前面，不一定
// 按编号——现在顺序由用户在网页上用上/下箭头控制(planSection.js/summarySection.js)。
// executionColumnMode: 'date'(默认，PLAN表用，第9列=计划执行截止日期对应星期几) |
// 'status'(STOPPED表用，2026-07-20新增——STOPPED条目的执行期不是日期，而是任务自身的
// 当前状态"未启动"/"中止"，从detail.sourceStatus读，跟"总体完成情况"列同一个数据来源)。
// PLAN/STOPPED两张表结构完全一样，只有这一列取值方式不同，用可选参数复用同一份实现，
// 避免维护两份几乎相同的拼行代码逐渐分叉。
function buildPlanLikeRows(entries, detailMap, moduleNameById, { executionColumnMode = "date", frozen = false } = {}) {
  const sorted = entries;
  const rows = sorted.map((e) => {
    const detail = resolveDetail(e, detailMap, frozen);
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
      executionColumnMode === "status" ? detail.sourceStatus || "" : weekdayLabel(e.execution_deadline),
      detail.targetDeliverable || "",
      monthDayLabel(detail.completionDate),
      PRIORITY_LABEL[e.priority_quadrant] || "",
      e.resources_needed || "无",
    ];
  });
  const blanked = blankRepeatingColumns(rows, MERGE_COLS, MERGE_DEPENDENCY);
  const mergedHighlight = mergedColHighlight(rows, sorted.map((e) => !!e.highlight), MERGE_COLS, MERGE_DEPENDENCY);
  const PRIORITY_COL = 12;
  return blanked.map((row, i) => {
    const fills = rowFills(!!sorted[i].highlight, row, mergedHighlight[i]);
    return row.map((text, c) => ({
      text,
      fill: fills[c],
      textHighlight: c === PRIORITY_COL ? PRIORITY_HIGHLIGHT[sorted[i].priority_quadrant] : undefined,
    }));
  });
}

function buildSummaryRows(entries, detailMap, moduleNameById, { frozen = false } = {}) {
  const sorted = entries;
  const rows = sorted.map((e) => {
    const detail = resolveDetail(e, detailMap, frozen);
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
      e.risk_note || "",
      detail.targetDeliverable || "",
      detail.sourceStatus || "",
      monthDayLabel(detail.completionDate),
    ];
  });
  const blanked = blankRepeatingColumns(rows, MERGE_COLS, MERGE_DEPENDENCY);
  const mergedHighlight = mergedColHighlight(rows, sorted.map((e) => !!e.highlight), MERGE_COLS, MERGE_DEPENDENCY);
  const RISK_COL = 11;
  return blanked.map((row, i) => {
    const fills = rowFills(!!sorted[i].highlight, row, mergedHighlight[i]);
    return row.map((text, c) => ({
      text,
      fill: fills[c],
      textHighlight: c === RISK_COL ? RISK_HIGHLIGHT[sorted[i].risk_level] : undefined,
    }));
  });
}

// 2026-07-31新增：已锁定的周读"锁定那一刻"冻结进entry自己snapshot_*列的值，没锁定的周
// (草稿中，或者locked但快照还没被一次性历史回填补上——见诊断页的回填按钮)继续读实时
// detailMap，行为完全不变。见plan-locked-week-ppt-snapshot.md。
function resolveDetail(entry, detailMap, frozen) {
  if (frozen && entry.snapshot_captured_at) {
    return {
      level1Text: entry.snapshot_level1_text || "",
      level2Text: entry.snapshot_level2_text || "",
      level3Text: entry.snapshot_level3_text || "",
      targetDeliverable: entry.snapshot_target_deliverable || "",
      sourceStatus: entry.snapshot_source_status || "",
      completionDate: entry.snapshot_completion_date,
    };
  }
  return detailMap.get(entry.task_id) || {};
}

function findSlideDocByTitle(slideDocs, titleText) {
  for (const doc of slideDocs) {
    const texts = Array.from(doc.getElementsByTagNameNS("http://schemas.openxmlformats.org/drawingml/2006/main", "t"));
    const joined = texts.map((t) => t.textContent).join("");
    if (joined.includes(titleText) && findTable(doc)) return doc;
  }
  return null;
}

// 抽出"查数据+拼rows"这部分，独立导出——generatePptForWeek()和网页预览(shared/tablePreview.js，
// 由index.js调用)共用同一份数据+格式化逻辑，保证不会出现"预览显示对但实际导出的PPT错"或
// 反过来的情况(2026-07-20新增，配合"预览PPT"功能)。
// 2026-07-31新增skipLiveDetail选项：已锁定的会话(见plan-unified-lock-compact-view.md的
// 精简只读视图)不需要再查tasks/projects/task_groups这个昂贵的嵌套join——已锁定周该有的
// detail字段全部已经在锁定那一刻冻结进了每一行自己的snapshot_*列。true时detailMap传空
// Map(resolveDetail对没有snapshot_captured_at的行会退回detailMap.get()||{}，也就是全部
// 留空——宁可留白也不为了兜底又发起一次实时查询)，frozen无条件为true(不看两个week自己的
// 锁定字段，调用方已经确认这个会话是锁定状态才会传这个选项)。missingSnapshotCount统计
// 有多少行缺快照，供页面提示用户去补一次历史快照回填。
export async function buildReportRows(targetWeek, previousWeek, allModules, { skipLiveDetail = false } = {}) {
  const moduleNameById = new Map(allModules.map((m) => [m.id, m.name]));

  const [planEntries, summaryEntries, stoppedEntries] = await Promise.all([
    listWeeklyTaskEntries(targetWeek.id, "plan"),
    previousWeek ? listWeeklyTaskEntries(previousWeek.id, "summary") : Promise.resolve([]),
    listWeeklyTaskEntries(targetWeek.id, "stopped"),
  ]);

  const allEntries = [...planEntries, ...summaryEntries, ...stoppedEntries];
  const detailMap = skipLiveDetail ? new Map() : await buildSourceDetailMap(allEntries.map((e) => e.task_id));

  // 已锁定的周读锁定那一刻冻结的快照，没锁定的周继续读实时detailMap(现状不变)。STOPPED表
  // 跟随plan_locked_at(跟stoppedSection.js自己的isLocked()判断一致)。
  const planFrozen = skipLiveDetail || !!targetWeek.plan_locked_at;
  const summaryFrozen = skipLiveDetail || !!(previousWeek && previousWeek.summary_locked_at);

  const planRows = buildPlanLikeRows(planEntries, detailMap, moduleNameById, { frozen: planFrozen });
  const summaryRows = buildSummaryRows(summaryEntries, detailMap, moduleNameById, { frozen: summaryFrozen });
  const stoppedRows = buildPlanLikeRows(stoppedEntries, detailMap, moduleNameById, {
    executionColumnMode: "status",
    frozen: planFrozen,
  });
  const missingSnapshotCount = skipLiveDetail ? allEntries.filter((e) => !e.snapshot_captured_at).length : 0;

  const meetingDate = new Date(`${targetWeek.meeting_date}T00:00:00Z`);
  const meetingLine1 = `${meetingDate.getUTCMonth() + 1}月份第${targetWeek.week_index_in_month}周`;
  const meetingLine2 = `${meetingDate.getUTCFullYear()}年${meetingDate.getUTCMonth() + 1}月${meetingDate.getUTCDate()}日`;

  return {
    planRows,
    summaryRows,
    stoppedRows,
    meetingLine1,
    meetingLine2,
    // "重点工作完成情况"来自previousWeek(被复核的那一周)，见sql/0024
    reviewKeyPointsText: previousWeek?.review_key_points || "",
    // "备注"同样来自previousWeek，见sql/0025
    reviewRemarksText: previousWeek?.review_remarks || "",
    missingSnapshotCount,
  };
}

// targetWeek的计划 + previousWeek的总结，生成PPT。返回 {blob, filename, planCount, summaryCount,
// stoppedCount}，调用方负责触发下载（不在这里直接下载，方便以后如果要加预览环节）。
export async function generatePptForWeek(targetWeek, previousWeek, allModules, { skipLiveDetail = false } = {}) {
  const { planRows, summaryRows, stoppedRows, meetingLine1, meetingLine2, reviewKeyPointsText, reviewRemarksText } =
    await buildReportRows(targetWeek, previousWeek, allModules, { skipLiveDetail });

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

  let meetingSlideFound = false;
  for (const { doc } of slideDocs) {
    if (rewriteMeetingHeader(doc, meetingLine1, meetingLine2)) {
      meetingSlideFound = true;
      break;
    }
  }
  if (!meetingSlideFound) throw new Error("模板里没找到例会日期标题幻灯片（匹配不到形如\"5月份第4周\"的文本框）");

  const reviewDoc = findSlideDocByTitle(slideDocs.map((s) => s.doc), TITLE_REVIEW);
  if (!reviewDoc) throw new Error(`模板里没找到"${TITLE_REVIEW}"幻灯片`);
  clearReviewSlide(reviewDoc, reviewKeyPointsText, reviewRemarksText);

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
