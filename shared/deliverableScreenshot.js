// "交付物文件夹截图"——完全合成生成的图片(不是真实屏幕截图/不读真实文件系统)，数据来自
// weekly_task_entries(summary条目)的deliverable_this_week文字 + deliverable_file_type字段，
// 画成一张"名称"表头+若干"图标+文件名"行的图，模拟Windows资源管理器"详细信息"视图只保留
// "名称"这一列的样子。
//
// 2026-07-29第三版：用户反馈手绘的翻角页面图标"还不如上一版"，要求"表头还是要截进去的，
// 只需要'名称'这一列就够了"，并且要求用真实的Windows/WPS图标(用户日常用WPS而不是
// Microsoft Office)。手绘图标改成直接使用从这台机器上WPS安装目录里的wpsofficeicon.dll
// 现取的真实图标(通过读取HKEY_CLASSES_ROOT里WPS.Docx.6/KET.Sheet.12/KWPP.Presentation.12/
// KWPS.PDF.9/WPS.ARC.zip这几个WPS自己的ProgID的DefaultIcon注册表值，定位到具体是
// wpsofficeicon.dll的第几号资源，再用PrivateExtractIcons在256x256分辨率下提取导出成PNG——
// 不是从当前系统"默认关联程序"直接截(这台机器.docx当前默认关联的是Microsoft Word，会拿到
// Office的图标而不是WPS的)，图片/文件夹/未选择类型三个用的是Windows系统自带图标(WPS不会
// 覆盖这几类的图标，没有额外找WPS版本的必要)。图标资源以PNG形式存在`web/assets/icons/`，
// 这个模块负责预加载+按需绘制，不再在运行时手绘图形。设计细节见
// tools/.claude/plans/plan-deliverable-screenshot.md。
//
// value / 下拉框中文标签 / assets/icons/下对应的图标文件名(不含扩展名)
export const DELIVERABLE_TYPE_OPTIONS = [
  { value: "", label: "(未选择)", icon: "generic" },
  { value: "pptx", label: "PPT文件", icon: "pptx" },
  { value: "docx", label: "Word文件", icon: "docx" },
  { value: "xlsx", label: "Excel文件", icon: "xlsx" },
  { value: "pdf", label: "PDF文件", icon: "pdf" },
  { value: "image", label: "图片", icon: "image" },
  { value: "zip", label: "压缩包", icon: "zip" },
  { value: "folder", label: "文件夹(多文件，如代码)", icon: "folder" },
  { value: "other", label: "其他文件", icon: "generic" },
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
      items.push({ name, icon: t.icon });
    }
  }
  return items;
}

const PADDING = 16;
const HEADER_HEIGHT = 30;
const ICON_SIZE = 20;
const GAP = 8;
const ROW_HEIGHT = 28;
const MIN_WIDTH = 240;
const MAX_WIDTH = 520;
const FONT = `13px "Segoe UI", "Microsoft YaHei", sans-serif`;
const HEADER_FONT = `bold 12px "Segoe UI", "Microsoft YaHei", sans-serif`;

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
// 显示"…")，高度按条目数增长(表头固定高度+每行固定高度)。
export function computeLayout(items) {
  const rowCount = Math.max(items.length, 1);
  const longestTextWidth = items.length === 0 ? estimateTextWidth(EMPTY_MESSAGE) : Math.max(...items.map((it) => estimateTextWidth(it.name)));
  const contentWidth = PADDING + ICON_SIZE + GAP + longestTextWidth + PADDING;
  const width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(contentWidth)));
  const height = HEADER_HEIGHT + rowCount * ROW_HEIGHT + PADDING;
  return { width, height, padding: PADDING, iconSize: ICON_SIZE, gap: GAP, rowHeight: ROW_HEIGHT, headerHeight: HEADER_HEIGHT };
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

// ctx只要求实现：fillRect/fillText/measureText/drawImage/beginPath/moveTo/lineTo/stroke，
// 以及fillStyle/strokeStyle/lineWidth/font/textAlign/textBaseline属性——测试时可以传一个记录
// 调用参数的假对象，不需要真实canvas(jsdom本身不支持canvas 2D绘制)。iconMap是
// {图标名: 可绘制对象(真实渲染时是Image，测试时可以是任意占位对象)}，由调用方(通常是
// renderDeliverableScreenshot())预先加载好传进来，这个函数本身不做任何图片加载(保持同步、
// 不做I/O，方便测试)。
export function drawToContext(ctx, layout, items, iconMap = {}) {
  const { width, height, padding, iconSize, gap, rowHeight, headerHeight } = layout;

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  // 表头：只保留"名称"这一列(2026-07-29用户明确要求去掉修改日期/类型列，但要留表头)
  ctx.fillStyle = "#666666";
  ctx.font = HEADER_FONT;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText("名称", padding, headerHeight / 2);
  ctx.strokeStyle = "#e0e0e0";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, headerHeight);
  ctx.lineTo(width, headerHeight);
  ctx.stroke();

  const bodyTop = headerHeight;
  if (items.length === 0) {
    ctx.fillStyle = "#999999";
    ctx.font = FONT;
    ctx.fillText(EMPTY_MESSAGE, padding, bodyTop + rowHeight / 2);
    return;
  }

  items.forEach((item, i) => {
    const rowY = bodyTop + i * rowHeight;
    const iconY = rowY + (rowHeight - iconSize) / 2;
    const img = iconMap[item.icon];
    if (img) ctx.drawImage(img, padding, iconY, iconSize, iconSize);

    ctx.fillStyle = "#1a1a1a";
    ctx.font = FONT;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    const textX = padding + iconSize + gap;
    const maxTextWidth = width - textX - padding;
    ctx.fillText(fitText(ctx, item.name, maxTextWidth), textX, rowY + rowHeight / 2);
  });
}

// 图标图片相对于这个模块自身文件位置解析(不依赖调用方页面在哪个目录)，配一个模块级缓存，
// 同一个图标在同一次页面会话里只会真正发一次请求。
const ICON_DIR = new URL("../assets/icons/", import.meta.url);
const iconCache = new Map();
function loadIcon(name) {
  if (iconCache.has(name)) return iconCache.get(name);
  const promise = new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`图标加载失败: ${name}.png`));
    img.src = new URL(`${name}.png`, ICON_DIR).href;
  });
  iconCache.set(name, promise);
  return promise;
}

// 公开入口(async——需要先把用到的图标图片加载完才能画)：canvas是真实的<canvas>元素。按
// devicePixelRatio放大画布物理像素、缩小回CSS显示尺寸，保证下载出来的PNG在高分屏上不糊。
export async function renderDeliverableScreenshot(canvas, items) {
  const uniqueIconNames = [...new Set(items.map((it) => it.icon))];
  const images = await Promise.all(uniqueIconNames.map((name) => loadIcon(name)));
  const iconMap = Object.fromEntries(uniqueIconNames.map((name, i) => [name, images[i]]));

  const layout = computeLayout(items);
  const dpr = window.devicePixelRatio || 1;
  canvas.width = layout.width * dpr;
  canvas.height = layout.height * dpr;
  canvas.style.width = `${layout.width}px`;
  canvas.style.height = `${layout.height}px`;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  drawToContext(ctx, layout, items, iconMap);
  return layout;
}
