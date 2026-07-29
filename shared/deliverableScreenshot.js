// "交付物文件夹截图"——完全合成生成的图片(不是真实屏幕截图/不读真实文件系统)，数据来自
// weekly_task_entries(summary条目)的deliverable_this_week文字 + 新增的deliverable_file_type
// 字段，画成一张"看起来像Windows资源管理器详细信息视图"的canvas图，供审核人核对交付物文件
// 是否存在，不需要真实建文件/不需要上传存储。设计细节见
// tools/.claude/plans/plan-deliverable-screenshot.md。
//
// value / 下拉框中文标签 / 截图里的emoji图标 / 资源管理器"类型"列文案
export const DELIVERABLE_TYPE_OPTIONS = [
  ["", "(未选择)", "📄", "文件"],
  ["pptx", "PPT文件", "📊", "Microsoft PowerPoint 演示文稿"],
  ["docx", "Word文件", "📄", "Microsoft Word 文档"],
  ["xlsx", "Excel文件", "📈", "Microsoft Excel 工作表"],
  ["pdf", "PDF文件", "📕", "PDF 文件"],
  ["image", "图片", "🖼️", "图片"],
  ["zip", "压缩包", "🗜️", "压缩文件夹"],
  ["folder", "文件夹(多文件，如代码)", "📁", "文件夹"],
  ["other", "其他文件", "📄", "文件"],
];

export const DELIVERABLE_TYPE_MAP = Object.fromEntries(
  DELIVERABLE_TYPE_OPTIONS.map(([value, label, emoji, typeLabel]) => [value, { value, label, emoji, typeLabel }])
);

// "YYYY-MM-DD" -> "2026/7/20"，资源管理器"修改日期"列的常见格式。跟dateUtils.js的
// monthDayLabel()"x月y日"是不同用途(那个是PPT表格专用约定)，这里要看起来像真的资源管理器。
export function explorerDateLabel(dateStr) {
  if (!dateStr) return "";
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getUTCFullYear()}/${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

// entries: weekly_task_entries里appears_in='summary'的行数组，每行至少有
// deliverable_this_week/deliverable_file_type两个字段。按换行拆行，每一行(排除空文本和
// 占位符"无")变成截图里独立一条——不按任务status过滤：未完成但用时不为0的任务一样可能有
// 真实的部分交付物要出现在截图里，"无"这个占位符本身才是"没有交付物"的信号(呼应
// entryValidation.js的E5/E6规则：用时为0要求交付物填"无"，此时不该出现在截图里)。
export function buildDeliverableItemsFromEntries(entries, weekMeetingDate) {
  const dateLabel = explorerDateLabel(weekMeetingDate);
  const items = [];
  for (const e of entries) {
    const typeInfo = DELIVERABLE_TYPE_MAP[e.deliverable_file_type] ?? DELIVERABLE_TYPE_MAP[""];
    const lines = String(e.deliverable_this_week ?? "")
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s !== "" && s !== "无");
    for (const name of lines) {
      items.push({ name, emoji: typeInfo.emoji, typeLabel: typeInfo.typeLabel, dateLabel });
    }
  }
  return items;
}

const PADDING = 16;
const TITLE_HEIGHT = 40;
const HEADER_HEIGHT = 32;
const ROW_HEIGHT = 30;
const FOOTER_HEIGHT = 28;
const WIDTH = 640;
const NAME_COL_X = PADDING + 34;
const DATE_COL_X = 380;
const TYPE_COL_X = 500;

// 纯函数，只算尺寸/坐标，不碰任何canvas API——可独立单元测试。
export function computeLayout(items) {
  const rowCount = Math.max(items.length, 1); // 空列表也至少留一行高度画提示文字
  const height = TITLE_HEIGHT + HEADER_HEIGHT + rowCount * ROW_HEIGHT + FOOTER_HEIGHT;
  return {
    width: WIDTH,
    height,
    padding: PADDING,
    titleHeight: TITLE_HEIGHT,
    headerHeight: HEADER_HEIGHT,
    rowHeight: ROW_HEIGHT,
    footerHeight: FOOTER_HEIGHT,
    nameColX: NAME_COL_X,
    dateColX: DATE_COL_X,
    typeColX: TYPE_COL_X,
  };
}

// ctx只要求实现用到的这几个基础2D API方法(fillRect/fillText/strokeRect/save/restore +
// fillStyle/font/textBaseline属性)，测试时可以传一个记录调用参数的假对象，不需要真实canvas。
export function drawToContext(ctx, layout, items, { folderTitle } = {}) {
  const { width, height, padding, titleHeight, headerHeight, rowHeight, nameColX, dateColX, typeColX } = layout;

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  // 标题栏(模拟资源管理器地址栏)
  ctx.fillStyle = "#f3f3f3";
  ctx.fillRect(0, 0, width, titleHeight);
  ctx.strokeStyle = "#d0d0d0";
  ctx.strokeRect(0, 0, width, titleHeight);
  ctx.fillStyle = "#333333";
  ctx.font = "14px sans-serif";
  ctx.textBaseline = "middle";
  ctx.fillText(`📂 ${folderTitle || "交付物"}`, padding, titleHeight / 2);

  // 列头
  const headerY = titleHeight;
  ctx.fillStyle = "#fafafa";
  ctx.fillRect(0, headerY, width, headerHeight);
  ctx.strokeStyle = "#e0e0e0";
  ctx.strokeRect(0, headerY, width, headerHeight);
  ctx.fillStyle = "#666666";
  ctx.font = "bold 12px sans-serif";
  ctx.fillText("名称", nameColX, headerY + headerHeight / 2);
  ctx.fillText("修改日期", dateColX, headerY + headerHeight / 2);
  ctx.fillText("类型", typeColX, headerY + headerHeight / 2);

  const bodyTop = headerY + headerHeight;
  if (items.length === 0) {
    ctx.fillStyle = "#999999";
    ctx.font = "13px sans-serif";
    ctx.fillText("本周没有可展示的交付物", padding, bodyTop + rowHeight / 2);
  } else {
    items.forEach((item, i) => {
      const rowY = bodyTop + i * rowHeight;
      if (i % 2 === 1) {
        ctx.fillStyle = "#f7f9fc";
        ctx.fillRect(0, rowY, width, rowHeight);
      }
      ctx.fillStyle = "#222222";
      ctx.font = "16px sans-serif";
      ctx.fillText(item.emoji, padding, rowY + rowHeight / 2);
      ctx.font = "13px sans-serif";
      ctx.fillText(item.name, nameColX, rowY + rowHeight / 2);
      ctx.fillStyle = "#555555";
      ctx.fillText(item.dateLabel, dateColX, rowY + rowHeight / 2);
      ctx.fillText(item.typeLabel, typeColX, rowY + rowHeight / 2);
      ctx.strokeStyle = "#eeeeee";
      ctx.beginPath();
      ctx.moveTo(0, rowY + rowHeight);
      ctx.lineTo(width, rowY + rowHeight);
      ctx.stroke();
    });
  }

  // 底部状态栏
  const footerY = height - layout.footerHeight;
  ctx.fillStyle = "#f3f3f3";
  ctx.fillRect(0, footerY, width, layout.footerHeight);
  ctx.strokeStyle = "#d0d0d0";
  ctx.strokeRect(0, footerY, width, layout.footerHeight);
  ctx.fillStyle = "#666666";
  ctx.font = "12px sans-serif";
  ctx.fillText(`共 ${items.length} 个项目`, padding, footerY + layout.footerHeight / 2);
}

// 公开入口：canvas是真实的<canvas>元素。按devicePixelRatio放大画布物理像素、缩小回CSS显示
// 尺寸，保证下载出来的PNG在高分屏上不糊。
export function renderDeliverableScreenshot(canvas, items, { folderTitle } = {}) {
  const layout = computeLayout(items);
  const dpr = window.devicePixelRatio || 1;
  canvas.width = layout.width * dpr;
  canvas.height = layout.height * dpr;
  canvas.style.width = `${layout.width}px`;
  canvas.style.height = `${layout.height}px`;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  drawToContext(ctx, layout, items, { folderTitle });
  return layout;
}
