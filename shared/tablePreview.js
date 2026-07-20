// 网页版"高保真PPT预览"——用跟pptGenerate.js完全相同的row数据(通过buildReportRows()拿到，
// 见shared/pptGenerate.js)渲染出结构一致的HTML表格，方便下载前先核对内容对不对。
// 2026-07-20新增。**明确的简化**（跟用户确认过）：不做真正的合并单元格rowSpan计算
// (pptGenerate.js的blankRepeatingColumns已经把该合并的重复文字置空，这里直接渲染成空白
// 格子，视觉上已经很接近合并效果)，不读取PowerPoint主题色的精确RGB(highlight用一个足够
// 醒目的固定色代替)——目标是"内容核对"，不是"像素级还原PowerPoint排版"。
//
// 列头顺序必须跟pptGenerate.js的buildPlanLikeRows/buildSummaryRows拼row数组的顺序严格
// 一致——改了那边的列顺序，这里的表头必须同步改，否则预览会显示错位的表头。
const PLAN_LIKE_HEADERS = [
  "模块", "类别", "任务1级", "任务2级", "任务3级", "责任人", "本周交付物", "计划用时",
  "计划开始", "执行期", "最终目标交付物", "最终计划完成时间", "优先级", "需协调资源",
];
const SUMMARY_HEADERS = [
  "模块", "类别", "任务1级", "任务2级", "任务3级", "责任人", "本周交付材料", "完成情况",
  "实际用时", "未完成原因", "整改措施", "风险", "最终目标交付物", "最终完成情况", "最终计划完成时间",
];

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

function renderCell(cell) {
  const bg = cell.fill === "highlight" ? "background-color:#ffe58a;" : "";
  const text = escapeHtml(cell.text);
  const inner = cell.textHighlight ? `<span style="background-color:#${cell.textHighlight};">${text}</span>` : text;
  return `<td style="${bg}">${inner}</td>`;
}

function renderTable(title, headers, rows) {
  const headHtml = headers.map((h) => `<th>${h}</th>`).join("");
  const bodyHtml = rows.length
    ? rows.map((row) => `<tr>${row.map(renderCell).join("")}</tr>`).join("")
    : `<tr><td colspan="${headers.length}">(无条目)</td></tr>`;
  return `
    <h4>${title}</h4>
    <div class="table-scroll">
      <table class="preview-table"><thead><tr>${headHtml}</tr></thead><tbody>${bodyHtml}</tbody></table>
    </div>
  `;
}

// reportData: shared/pptGenerate.js的buildReportRows()返回值，原样传进来即可，保证预览
// 和实际生成PPT用的是完全同一份数据+格式化结果。
export function renderPreviewTables(container, reportData) {
  const { planRows, summaryRows, stoppedRows, meetingLine1, meetingLine2, reviewKeyPointsText } = reportData;
  const reviewHtml = reviewKeyPointsText
    ? reviewKeyPointsText.split("\n").map((line) => escapeHtml(line)).join("<br />")
    : "(空)";
  container.innerHTML = `
    <div class="preview-box">
      <p class="status">预览（非精确还原，仅供核对内容）</p>
      <p><strong>${escapeHtml(meetingLine1)}</strong><br />${escapeHtml(meetingLine2)}</p>
      <h4>周工作计划复核情况（重点工作完成情况）</h4>
      <p>${reviewHtml}</p>
      ${renderTable("周工作总结", SUMMARY_HEADERS, summaryRows)}
      ${renderTable("本周工作计划", PLAN_LIKE_HEADERS, planRows)}
      ${renderTable("未启动/中止工作", PLAN_LIKE_HEADERS, stoppedRows)}
    </div>
  `;
}
