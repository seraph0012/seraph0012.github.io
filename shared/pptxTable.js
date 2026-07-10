// PPT表格DOM操作 — port自 refs/ppt_utils.py 的 reset_table/replace_text_keep_format/
// merge_vertical_cells/fill_table/highlight_cell，操作对象从python-pptx对象换成DOMParser
// 解析出的DrawingML XML元素。OOXML表格合并模型（rowSpan/vMerge、gridSpan/hMerge）已用
// refs/sample_ppt.pptx实测验证，见 tools/.claude/plans/plan-ppt-export-jszip-browser.md。

const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_CT = "http://schemas.openxmlformats.org/package/2006/content-types";
const NS_RELS = "http://schemas.openxmlformats.org/package/2006/relationships";

export function parseXml(text) {
  return new DOMParser().parseFromString(text, "application/xml");
}
export function serializeXml(doc) {
  return new XMLSerializer().serializeToString(doc);
}

function el(doc, name) {
  return doc.createElementNS(NS_A, name);
}

// ---- 定位幻灯片顺序（不能假设slideN.xml文件名顺序=演示顺序，要按presentation.xml的
// sldIdLst + presentation.xml.rels解析，跟PowerPoint/python-pptx内部逻辑一致） ----
export async function getOrderedSlidePaths(zip) {
  const presXml = parseXml(await zip.file("ppt/presentation.xml").async("string"));
  const relsXml = parseXml(await zip.file("ppt/_rels/presentation.xml.rels").async("string"));

  const relMap = {};
  for (const rel of Array.from(relsXml.getElementsByTagNameNS(NS_RELS, "Relationship"))) {
    relMap[rel.getAttribute("Id")] = rel.getAttribute("Target");
  }

  const sldIds = Array.from(presXml.getElementsByTagNameNS(NS_P, "sldId"));
  return sldIds.map((sldId) => {
    const rId = sldId.getAttributeNS(NS_R, "id");
    const target = relMap[rId]; // 形如 "slides/slide6.xml"
    return "ppt/" + target.replace(/^\.?\//, "");
  });
}

export function findTable(slideDoc) {
  const tbls = slideDoc.getElementsByTagNameNS(NS_A, "tbl");
  return tbls.length ? tbls[0] : null;
}

function getRows(tblEl) {
  return Array.from(tblEl.getElementsByTagNameNS(NS_A, "tr")).filter(
    (tr) => tr.parentNode === tblEl
  );
}
function getCells(trEl) {
  return Array.from(trEl.getElementsByTagNameNS(NS_A, "tc")).filter(
    (tc) => tc.parentNode === trEl
  );
}
function getTcPr(tcEl) {
  return tcEl.getElementsByTagNameNS(NS_A, "tcPr")[0] || null;
}
function ensureTcPr(tcEl) {
  let tcPr = getTcPr(tcEl);
  if (!tcPr) {
    tcPr = el(tcEl.ownerDocument, "a:tcPr");
    tcEl.appendChild(tcPr);
  }
  return tcPr;
}

// ---- 文字（保留首个run的格式，只换文字，对应replace_text_keep_format/replace_paragraph） ----
export function replaceTextKeepFormat(tcEl, newText) {
  const doc = tcEl.ownerDocument;
  let txBody = tcEl.getElementsByTagNameNS(NS_A, "txBody")[0];
  if (!txBody) {
    txBody = el(doc, "a:txBody");
    txBody.appendChild(el(doc, "a:bodyPr"));
    const tcPr = getTcPr(tcEl);
    tcEl.insertBefore(txBody, tcPr || null);
  }
  let ps = Array.from(txBody.getElementsByTagNameNS(NS_A, "p"));
  if (ps.length === 0) {
    const p = el(doc, "a:p");
    txBody.appendChild(p);
    ps = [p];
  }
  for (let i = ps.length - 1; i >= 1; i--) ps[i].parentNode.removeChild(ps[i]);
  const p0 = ps[0];

  const runs = Array.from(p0.getElementsByTagNameNS(NS_A, "r"));
  if (runs.length > 0) {
    const r0 = runs[0];
    let t = r0.getElementsByTagNameNS(NS_A, "t")[0];
    if (!t) {
      t = el(doc, "a:t");
      r0.appendChild(t);
    }
    t.textContent = newText;
    for (let i = runs.length - 1; i >= 1; i--) runs[i].parentNode.removeChild(runs[i]);
  } else {
    const r = el(doc, "a:r");
    const t = el(doc, "a:t");
    t.textContent = newText;
    r.appendChild(t);
    p0.appendChild(r);
  }
}

// ---- 填色 ----
// 注意：不能用getElementsByTagNameNS找tcPr的填充子元素——它会递归到lnL/lnR/lnT/lnB
// 边框线里各自嵌套的<a:solidFill>（边框颜色，不是单元格底色），错误地把边框色当成
// 待清除的旧填充删掉。必须只看tcPr的直接子节点。
const FILL_TAGS = ["noFill", "solidFill", "gradFill", "blipFill", "pattFill", "grpFill"];
function clearExistingFill(tcPr) {
  for (const child of Array.from(tcPr.childNodes)) {
    if (child.nodeType === 1 && child.namespaceURI === NS_A && FILL_TAGS.includes(child.localName)) {
      tcPr.removeChild(child);
    }
  }
}
export function setCellFillWhite(tcEl) {
  const doc = tcEl.ownerDocument;
  const tcPr = ensureTcPr(tcEl);
  clearExistingFill(tcPr);
  const solidFill = el(doc, "a:solidFill");
  const srgb = el(doc, "a:srgbClr");
  srgb.setAttribute("val", "FFFFFF");
  solidFill.appendChild(srgb);
  tcPr.appendChild(solidFill);
}
// 对应 highlight_cell()：浅灰色 RGB(210,210,210)，用于REVIEW表复核列
export function setCellFillGrey(tcEl) {
  const doc = tcEl.ownerDocument;
  const tcPr = ensureTcPr(tcEl);
  clearExistingFill(tcPr);
  const solidFill = el(doc, "a:solidFill");
  const srgb = el(doc, "a:srgbClr");
  srgb.setAttribute("val", "D2D2D2");
  solidFill.appendChild(srgb);
  tcPr.appendChild(solidFill);
}
// 对应 fill_table() 里 highlight=true 时的主题色: accent6, brightness=0.6
export function setCellFillHighlight(tcEl) {
  const doc = tcEl.ownerDocument;
  const tcPr = ensureTcPr(tcEl);
  clearExistingFill(tcPr);
  const solidFill = el(doc, "a:solidFill");
  const schemeClr = el(doc, "a:schemeClr");
  schemeClr.setAttribute("val", "accent6");
  const lumMod = el(doc, "a:lumMod");
  lumMod.setAttribute("val", "40000");
  const lumOff = el(doc, "a:lumOff");
  lumOff.setAttribute("val", "60000");
  schemeClr.appendChild(lumMod);
  schemeClr.appendChild(lumOff);
  solidFill.appendChild(schemeClr);
  tcPr.appendChild(solidFill);
}
// 风险说明列专用：按risk_level(green/yellow/red)填对应底色，对应模板脚注"风险等级按
// 绿色、黄色、红色依次递增"——跟highlight的强调色是两套独立的填色语义，互不覆盖
const RISK_COLORS = { green: "92D050", yellow: "FFFF00", red: "FF0000" };
export function setCellFillRisk(tcEl, riskLevel) {
  const doc = tcEl.ownerDocument;
  const tcPr = ensureTcPr(tcEl);
  clearExistingFill(tcPr);
  const solidFill = el(doc, "a:solidFill");
  const srgb = el(doc, "a:srgbClr");
  srgb.setAttribute("val", RISK_COLORS[riskLevel] || "FFFFFF");
  solidFill.appendChild(srgb);
  tcPr.appendChild(solidFill);
}

// ---- 重置表格（对应reset_table()）：清除body行(不含表头行0、不含末尾说明行)的合并/填色/文字 ----
export function resetTable(tblEl) {
  const rows = getRows(tblEl);
  for (let r = 1; r < rows.length - 1; r++) {
    for (const tc of getCells(rows[r])) {
      tc.removeAttribute("rowSpan");
      tc.removeAttribute("gridSpan");
      tc.removeAttribute("hMerge");
      tc.removeAttribute("vMerge");
      setCellFillWhite(tc);
      replaceTextKeepFormat(tc, "");
    }
  }
}

// ---- 竖向合并（对应merge_vertical_cells()）：cols是要合并的列号数组，dependency={col: 上级col}
// 表示该列即使文字重复也要在"上级列"换值时断开合并（如任务3级不能跨任务2级边界合并）。
// 调用前caller必须已经把"延续行"的cols文字置空（模拟python-pptx原始数据里合并单元格
// 除首行外都是空字符串的约定），本函数只负责按空/非空识别分组区间并设置rowSpan/vMerge。 ----
export function mergeVerticalCells(tblEl, cols, dependency = {}) {
  const rows = getRows(tblEl);
  const lastBodyRowIdx = rows.length - 1; // 末尾说明行不参与
  for (const c of cols) {
    let curr = 1;
    let nxt = curr;
    const parent = dependency[c];
    while (nxt < lastBodyRowIdx) {
      nxt += 1;
      const nxtCells = getCells(rows[nxt]);
      const parentHasNxt = parent !== undefined && (nxtCells[parent].textContent || "").trim().length > 0;
      const cText = (nxtCells[c].textContent || "").trim();
      if (cText.length > 0 || parentHasNxt || nxt === lastBodyRowIdx) {
        if (nxt - curr > 1) {
          mergeRange(tblEl, curr, nxt - 1, c);
        }
        curr = nxt;
      }
    }
  }
}

// 把[startRow, endRow]区间在列c上合并成一个单元格：起点设rowSpan，其余设vMerge=1并清空
// （已用sample_ppt.pptx实测验证起点/延续单元格的OOXML结构）
function mergeRange(tblEl, startRow, endRow, c) {
  const rows = getRows(tblEl);
  const originCell = getCells(rows[startRow])[c];
  originCell.setAttribute("rowSpan", String(endRow - startRow + 1));
  for (let r = startRow + 1; r <= endRow; r++) {
    const tc = getCells(rows[r])[c];
    tc.setAttribute("vMerge", "1");
    const txBody = tc.getElementsByTagNameNS(NS_A, "txBody")[0];
    if (txBody) txBody.parentNode.removeChild(txBody);
    const tcPr = getTcPr(tc);
    if (tcPr) {
      while (tcPr.firstChild) tcPr.removeChild(tcPr.firstChild);
    }
  }
}

function cloneRowAsBlank(templateRow) {
  const clone = templateRow.cloneNode(true);
  for (const tc of getCells(clone)) {
    tc.removeAttribute("rowSpan");
    tc.removeAttribute("gridSpan");
    tc.removeAttribute("hMerge");
    tc.removeAttribute("vMerge");
  }
  return clone;
}

// ---- 填表（对应fill_table()）----
// rows: Array<Array<{text: string, fill?: "white"|"highlight"|"green"|"yellow"|"red"}>>，
// 每个子数组是一行的全部列（包括模块/类别等列，跟原脚本"部分列硬编码"的做法不同——本项目
// 模块/类别是每行真实数据，由调用方在传入前按"同组延续行留空"的约定预处理好，供
// mergeVerticalCells识别分组边界）。fill缺省是"white"；"highlight"是重点工作强调色，
// green/yellow/red是风险说明列专用色，两套填色逻辑由调用方按列决定用哪个，互不干扰。
export function fillTable(tblEl, rows) {
  const before = getRows(tblEl);
  const currBodyRows = before.length - 2; // 去掉表头行、末尾说明行
  const targetRows = rows.length;

  resetTable(tblEl);

  const afterReset = getRows(tblEl);
  const templateRow = afterReset[1];
  const footerRow = afterReset[afterReset.length - 1];

  if (currBodyRows < targetRows) {
    for (let i = 0; i < targetRows - currBodyRows; i++) {
      tblEl.insertBefore(cloneRowAsBlank(templateRow), footerRow);
    }
  } else if (currBodyRows > targetRows) {
    const rowsNow = getRows(tblEl);
    for (let i = 0; i < currBodyRows - targetRows; i++) {
      // 从倒数第2行（footer前一行）开始删
      const idx = rowsNow.length - 2 - i;
      tblEl.removeChild(rowsNow[idx]);
    }
  }

  const finalRows = getRows(tblEl);
  for (let r = 0; r < targetRows; r++) {
    const cells = getCells(finalRows[r + 1]);
    const rowData = rows[r];
    for (let c = 0; c < rowData.length; c++) {
      const { text, fill } = rowData[c];
      replaceTextKeepFormat(cells[c], text ?? "");
      if (fill === "highlight") setCellFillHighlight(cells[c]);
      else if (fill === "green" || fill === "yellow" || fill === "red") setCellFillRisk(cells[c], fill);
      else setCellFillWhite(cells[c]);
    }
  }
}

// ---- MEETING日期头：直接整体覆盖，不用+7天算术（改由调用方传入目标周已经算好的
// 月份/月内第几周/日期），对应原handle_summary_meeting，但数据来源换成meeting_weeks表 ----
const DATE_HEADER_RE = /^\d{1,2}月份第\d周[\s\S]*\d{4}年\d{1,2}月\d{1,2}日$/;

export function rewriteMeetingHeader(slideDoc, line1, line2) {
  const shapes = Array.from(slideDoc.getElementsByTagNameNS(NS_P, "sp"));
  for (const sp of shapes) {
    const txBody = sp.getElementsByTagNameNS(NS_P, "txBody")[0];
    if (!txBody) continue;
    const ps = Array.from(txBody.getElementsByTagNameNS(NS_A, "p"));
    const fullText = ps.map((p) => Array.from(p.getElementsByTagNameNS(NS_A, "t")).map((t) => t.textContent).join("")).join("\n").trim();
    if (!DATE_HEADER_RE.test(fullText)) continue;
    if (ps.length < 2) continue;
    setParagraphText(ps[0], line1);
    setParagraphText(ps[1], line2);
    return true;
  }
  return false;
}

function setParagraphText(pEl, newText) {
  const runs = Array.from(pEl.getElementsByTagNameNS(NS_A, "r"));
  if (runs.length > 0) {
    const r0 = runs[0];
    let t = r0.getElementsByTagNameNS(NS_A, "t")[0];
    if (!t) {
      t = el(pEl.ownerDocument, "a:t");
      r0.appendChild(t);
    }
    t.textContent = newText;
    for (let i = runs.length - 1; i >= 1; i--) runs[i].parentNode.removeChild(runs[i]);
  }
}

// ---- REVIEW表签字列清空（对应handle_summary_review）----
export function clearReviewSlide(slideDoc) {
  const table = findTable(slideDoc);
  if (!table) return;
  const rows = getRows(table);
  const cells = getCells(rows[1]);
  replaceTextKeepFormat(cells[4], "");
  setCellFillGrey(cells[4]);
  replaceTextKeepFormat(cells[5], "");
}
