// "交付物文件夹截图"——完全合成生成的图片(不是真实屏幕截图/不读真实文件系统)，数据来自
// weekly_task_entries(summary条目)的deliverable_this_week文字 + deliverable_file_type字段，
// 画成一张"名称"表头+若干"图标+文件名"行的图，模拟Windows资源管理器"详细信息"视图只保留
// "名称"这一列的样子。
//
// 2026-07-29第三版：用户反馈手绘的翻角页面图标"还不如上一版"，要求"表头还是要截进去的，
// 只需要'名称'这一列就够了"，并要求用真实的WPS图标——第一次尝试用Windows API
// (SHGetFileInfo+PrivateExtractIcons)从WPS安装目录的wpsofficeicon.dll现取256x256大图标，
// 结果用户反馈"和我实际看到的不一样"；换成直接从真实文件(而不是拿扩展名假装查)提取，
// 同一次运行里docx提出来的图标对、但xlsx/pptx却提取成了空白通用图标——这条路线本身不可靠
// (Windows图标系统在"jumbo"大图标缓存上有已知的时序/缓存问题，没法保证每次都拿到正确结果)。
// 2026-07-29第四版：用户直接提供了自己Windows资源管理器"列表"视图的真实截图
// (`tools/refs/示例截图.png`)，不再靠程序化猜测。第一次裁剪按肉眼估的固定行高/固定框裁剪，
// 结果偏差很大——把相邻两个图标各截了一半、图标本身占比很小、边缘还带进了文件名最左侧的
// 一撇。改成完全基于像素内容的裁剪算法(numpy)：先按"每一行有没有非白色像素"切出7个图标+
// 文件名所在的行(不是靠肉眼数固定行高)，再在每一行内按"每一列有没有非白色像素"找列方向的
// 连续色块——图标和文件名之间天然有一段空白列做分隔，图标永远是最左边那一块连续色块，据此
// 精确定位图标自己的最小外接矩形(加1px留白)，裁出来的才是图标本身，不多带旁边的文件名文字，
// 也不会跨到下一行/上一行的图标。这样裁出来的图标原生只有约17x18像素(folder/zip更扁一些，
// 分别约18x15/18x14)——保留各自真实宽高比，渲染时用Math.min(iconSize/宽,iconSize/高)等比
// 缩放后居中放进图标格，不强行拉伸变形。生成截图用不到的类型("未选择"/"其他")沿用Windows
// 系统自带的通用文件图标(跟用户截图无关，够中性)。前两版程序化提取的图标(WPS DLL资源提取/
// 当前默认关联提取)都已作废并被替换——这是唯一真正跟用户实际看到的一致的来源。
// 图标资源以PNG形式存在`web/assets/icons/`，这个模块负责预加载+按需绘制，不再在运行时手绘
// 图形。设计细节见tools/.claude/plans/plan-deliverable-screenshot.md。
//
// value / 下拉框中文标签 / assets/icons/下对应的图标文件名(不含扩展名) / 这个类型对应的文件
// 扩展名(null=不知道该补什么后缀，比如"文件夹"本来就没有后缀、"未选择/其他"没法猜)。
export const DELIVERABLE_TYPE_OPTIONS = [
  { value: "", label: "(未选择)", icon: "generic", ext: null },
  { value: "pptx", label: "PPT文件", icon: "pptx", ext: ".pptx" },
  { value: "docx", label: "Word文件", icon: "docx", ext: ".docx" },
  { value: "xlsx", label: "Excel文件", icon: "xlsx", ext: ".xlsx" },
  { value: "pdf", label: "PDF文件", icon: "pdf", ext: ".pdf" },
  { value: "image", label: "图片", icon: "image", ext: ".png" },
  { value: "zip", label: "压缩包", icon: "zip", ext: ".zip" },
  { value: "folder", label: "文件夹(多文件，如代码)", icon: "folder", ext: null },
  { value: "other", label: "其他文件", icon: "generic", ext: null },
];

export const DELIVERABLE_TYPE_MAP = Object.fromEntries(DELIVERABLE_TYPE_OPTIONS.map((t) => [t.value, t]));

const EMPTY_MESSAGE = "本周没有可展示的交付物";

// 判断文字末尾是不是已经像个文件后缀(.xxx，1~5位字母数字)——用户自己在"本周交付材料"里
// 打了后缀的话(比如"报告.doc"，即使跟选的类型不完全一致)要原样尊重，不重复叠加。
const EXTENSION_PATTERN = /\.[A-Za-z0-9]{1,5}$/;

// entries: weekly_task_entries里appears_in='summary'的行数组，每行至少有
// deliverable_this_week/deliverable_file_type两个字段。按换行拆行，每一行(排除空文本和
// 占位符"无")变成截图里独立一条——不按任务status过滤：未完成但用时不为0的任务一样可能有
// 真实的部分交付物要出现在截图里，"无"这个占位符本身才是"没有交付物"的信号(呼应
// entryValidation.js的E5/E6规则：用时为0要求交付物填"无"，此时不该出现在截图里)。
//
// 2026-07-29用户反馈"文件名是要有后缀的，现在没有"——"本周交付材料"这个字段本来就是给
// 人念的描述性文字，很多时候不会习惯性带上".pptx"这种后缀，但截图要看起来像真的文件列表，
// 没后缀就不像。这里按选定的"交付物类型"自动补上对应后缀(已经自己带了看起来像后缀的文字
// 就不重复补，尊重用户原样输入)。
export function buildDeliverableItemsFromEntries(entries) {
  const items = [];
  for (const e of entries) {
    const t = DELIVERABLE_TYPE_MAP[e.deliverable_file_type] ?? DELIVERABLE_TYPE_MAP[""];
    const lines = String(e.deliverable_this_week ?? "")
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s !== "" && s !== "无");
    for (const raw of lines) {
      const name = t.ext && !EXTENSION_PATTERN.test(raw) ? `${raw}${t.ext}` : raw;
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
// 2026-07-29用户反馈："名称"表头字体应该跟下面文件名称的字体差不多，只是颜色比较灰
// （不是加粗/更小号）——所以直接复用FONT，不单独定义粗体表头字号。
const HEADER_FONT = FONT;
// 表头文字的左边界应该比图标左边界稍微靠右一点（不能跟图标严格对齐），这里往右挪4px。
const HEADER_TEXT_INDENT = 4;

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

  // 表头：只保留"名称"这一列(2026-07-29用户明确要求去掉修改日期/类型列，但要留表头)。
  // 表头文字字体跟下面文件名一致(FONT)，只是颜色更灰；左边界比图标左边界稍微靠右一点
  // (HEADER_TEXT_INDENT)，不跟图标严格对齐——这两点都是2026-07-29用户对照真实资源管理器
  // 截图明确指出的观感差异。
  ctx.fillStyle = "#666666";
  ctx.font = HEADER_FONT;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText("名称", padding + HEADER_TEXT_INDENT, headerHeight / 2);
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
    const img = iconMap[item.icon];
    if (img) {
      // 图标素材是直接从用户截图裁剪出来的真实图标(2026-07-29第四版)，folder/zip这些原生
      // 宽高比不是正方形——按iconSize等比缩放、居中放进图标格，不强行拉伸变形。
      const naturalW = img.naturalWidth || img.width || iconSize;
      const naturalH = img.naturalHeight || img.height || iconSize;
      const scale = Math.min(iconSize / naturalW, iconSize / naturalH);
      const drawW = naturalW * scale;
      const drawH = naturalH * scale;
      const iconX = padding + (iconSize - drawW) / 2;
      const iconY = rowY + (rowHeight - drawH) / 2;
      ctx.drawImage(img, iconX, iconY, drawW, drawH);
    }

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
