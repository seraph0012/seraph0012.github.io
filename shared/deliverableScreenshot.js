// "交付物文件夹截图"——完全合成生成的图片(不是真实屏幕截图/不读真实文件系统)，数据来自
// weekly_task_entries(summary条目)的deliverable_this_week文字 + deliverable_file_type字段，
// 画成一张只包含"图标+文件名"的图，模拟Windows资源管理器"列表"视图（2026-07-29用户反馈第一版
// 带标题栏/表头/修改日期/类型列的"详细信息"视图观感不对、emoji图标不像真实Windows图标，
// 简化成只保留文件名部分：白色背景，每行一个图标(手绘的"翻角页面+色带徽标"样式模拟Office类
// 文件图标，folder类型画独立的文件夹形状)+文件名，不画标题栏/表头/日期/类型列）。
// 设计细节见tools/.claude/plans/plan-deliverable-screenshot.md。
//
// value / 下拉框中文标签 / 图标形状(page=翻角页面、folder=文件夹) / 图标主色(null=不画色带，
// 用于"未选择"这种没有具体类型的情况) / 色带上的徽标字母(参照真实Office图标的P/W/X/PDF的A
// 风格单字母标识，空字符串=只画纯色带不写字)
export const DELIVERABLE_TYPE_OPTIONS = [
  { value: "", label: "(未选择)", kind: "page", color: null, badge: "" },
  { value: "pptx", label: "PPT文件", kind: "page", color: "#D24726", badge: "P" },
  { value: "docx", label: "Word文件", kind: "page", color: "#2B579A", badge: "W" },
  { value: "xlsx", label: "Excel文件", kind: "page", color: "#217346", badge: "X" },
  { value: "pdf", label: "PDF文件", kind: "page", color: "#DC3E15", badge: "A" },
  { value: "image", label: "图片", kind: "page", color: "#7C4DFF", badge: "" },
  { value: "zip", label: "压缩包", kind: "page", color: "#8D8D8D", badge: "" },
  { value: "folder", label: "文件夹(多文件，如代码)", kind: "folder", color: "#FFCA28", badge: "" },
  { value: "other", label: "其他文件", kind: "page", color: null, badge: "" },
];

export const DELIVERABLE_TYPE_MAP = Object.fromEntries(DELIVERABLE_TYPE_OPTIONS.map((t) => [t.value, t]));

const EMPTY_MESSAGE = "本周没有可展示的交付物";

// entries: weekly_task_entries里appears_in='summary'的行数组，每行至少有
// deliverable_this_week/deliverable_file_type两个字段。按换行拆行，每一行(排除空文本和
// 占位符"无")变成截图里独立一条——不按任务status过滤：未完成但用时不为0的任务一样可能有
// 真实的部分交付物要出现在截图里，"无"这个占位符本身才是"没有交付物"的信号(呼应
// entryValidation.js的E5/E6规则：用时为0要求交付物填"无"，此时不该出现在截图里)。
export function buildDeliverableItemsFromEntries(entries) {
  const items = [];
  for (const e of entries) {
    const t = DELIVERABLE_TYPE_MAP[e.deliverable_file_type] ?? DELIVERABLE_TYPE_MAP[""];
    const lines = String(e.deliverable_this_week ?? "")
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s !== "" && s !== "无");
    for (const name of lines) {
      items.push({ name, kind: t.kind, color: t.color, badge: t.badge });
    }
  }
  return items;
}

const PADDING = 16;
const ICON_W = 22;
const ICON_H = 26;
const GAP = 8;
const ROW_HEIGHT = 30;
const MIN_WIDTH = 240;
const MAX_WIDTH = 520;
const FONT = `13px "Segoe UI", "Microsoft YaHei", sans-serif`;

// 粗略估算文字像素宽度(不需要真实canvas/ctx，computeLayout保持纯函数好独立测试)——全角字符
// (中文/中文标点)按13px字号约14px一个算，半角(英文数字/符号)约7px一个算，够用来估画布宽度，
// 真正逐字符精确的显示宽度由drawToContext()里用ctx.measureText()现测。
function estimateTextWidth(text) {
  let w = 0;
  for (const ch of text) {
    w += /[^\x00-\xff]/.test(ch) ? 14 : 7;
  }
  return w;
}

// 纯函数，只算画布尺寸，不碰任何canvas API——可独立单元测试。宽度按最长文件名撑开(夹在
// [MIN_WIDTH, MAX_WIDTH]之间，超过上限的会在drawToContext()里用真实ctx.measureText()截断
// 显示"…")，高度按条目数增长。
export function computeLayout(items) {
  const rowCount = Math.max(items.length, 1);
  const longestTextWidth = items.length === 0 ? estimateTextWidth(EMPTY_MESSAGE) : Math.max(...items.map((it) => estimateTextWidth(it.name)));
  const contentWidth = PADDING + ICON_W + GAP + longestTextWidth + PADDING;
  const width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(contentWidth)));
  const height = PADDING * 2 + rowCount * ROW_HEIGHT;
  return { width, height, padding: PADDING, iconW: ICON_W, iconH: ICON_H, gap: GAP, rowHeight: ROW_HEIGHT };
}

// 用ctx.measureText()精确截断文字到maxWidth以内(超出部分换成"…")，text本身能放下时原样返回。
function fitText(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = `${text.slice(0, mid)}…`;
    if (ctx.measureText(candidate).width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return lo === 0 ? "…" : `${text.slice(0, lo)}…`;
}

// 手绘"翻角页面"图标，模拟常见Office类文件图标的样式——白色页面+右上角折角+(可选)底部色带
// +色带上的单字母徽标。color为null时只画白色页面轮廓，不画色带(用于"未选择类型"这种没有
// 具体归类的情况，视觉上刻意显得中性)。
function drawPageIcon(ctx, x, y, w, h, color, badge) {
  const fold = Math.round(w * 0.35);
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + w - fold, y);
  ctx.lineTo(x + w, y + fold);
  ctx.lineTo(x + w, y + h);
  ctx.lineTo(x, y + h);
  ctx.closePath();
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.strokeStyle = "#c9c9c9";
  ctx.lineWidth = 1;
  ctx.stroke();

  // 折角三角
  ctx.beginPath();
  ctx.moveTo(x + w - fold, y);
  ctx.lineTo(x + w, y + fold);
  ctx.lineTo(x + w - fold, y + fold);
  ctx.closePath();
  ctx.fillStyle = "#e8e8e8";
  ctx.fill();
  ctx.strokeStyle = "#c9c9c9";
  ctx.stroke();

  if (color) {
    const bandH = Math.round(h * 0.32);
    const bandY = y + h - bandH;
    ctx.fillStyle = color;
    ctx.fillRect(x, bandY, w, bandH);
    if (badge) {
      ctx.fillStyle = "#ffffff";
      ctx.font = `bold ${Math.max(7, Math.round(bandH * 0.75))}px "Segoe UI", sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(badge, x + w / 2, bandY + bandH / 2 + 0.5);
      ctx.textAlign = "left";
    }
  }
}

// 手绘黄色文件夹图标(标签页+主体两块矩形路径，Windows经典配色)。
function drawFolderIcon(ctx, x, y, w, h, color) {
  const tabW = Math.round(w * 0.5);
  const tabH = Math.round(h * 0.18);
  const bodyY = y + tabH;

  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + tabW, y);
  ctx.lineTo(x + tabW + 3, y + tabH);
  ctx.lineTo(x, y + tabH);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(x, bodyY);
  ctx.lineTo(x + w, bodyY);
  ctx.lineTo(x + w, y + h);
  ctx.lineTo(x, y + h);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = "#d9a300";
  ctx.lineWidth = 1;
  ctx.stroke();
}

// ctx只要求实现：fillRect/fillText/measureText/beginPath/moveTo/lineTo/closePath/fill/stroke，
// 以及fillStyle/strokeStyle/lineWidth/font/textAlign/textBaseline属性——测试时可以传一个记录
// 调用参数的假对象，不需要真实canvas(jsdom本身不支持canvas 2D绘制)。
export function drawToContext(ctx, layout, items) {
  const { width, height, padding, iconW, iconH, gap, rowHeight } = layout;

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  if (items.length === 0) {
    ctx.fillStyle = "#999999";
    ctx.font = FONT;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(EMPTY_MESSAGE, padding, padding + rowHeight / 2);
    return;
  }

  items.forEach((item, i) => {
    const rowY = padding + i * rowHeight;
    const iconY = rowY + (rowHeight - iconH) / 2;
    if (item.kind === "folder") {
      drawFolderIcon(ctx, padding, iconY, iconW, iconH, item.color);
    } else {
      drawPageIcon(ctx, padding, iconY, iconW, iconH, item.color, item.badge);
    }
    ctx.fillStyle = "#1a1a1a";
    ctx.font = FONT;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    const textX = padding + iconW + gap;
    const maxTextWidth = width - textX - padding;
    ctx.fillText(fitText(ctx, item.name, maxTextWidth), textX, rowY + rowHeight / 2);
  });
}

// 公开入口：canvas是真实的<canvas>元素。按devicePixelRatio放大画布物理像素、缩小回CSS显示
// 尺寸，保证下载出来的PNG在高分屏上不糊。
export function renderDeliverableScreenshot(canvas, items) {
  const layout = computeLayout(items);
  const dpr = window.devicePixelRatio || 1;
  canvas.width = layout.width * dpr;
  canvas.height = layout.height * dpr;
  canvas.style.width = `${layout.width}px`;
  canvas.style.height = `${layout.height}px`;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  drawToContext(ctx, layout, items);
  return layout;
}
