// 批量手动导入：Excel(.xlsx)两个sheet("项目"/"任务")→浏览器内用SheetJS解析→前置校验
// (汇总报错，不真正写库)→预览→逐行导入(项目编号已存在则复用，不重复创建；每行独立
// try/catch，一行失败不影响其他行)。跟tools/import/(历史PPT自动解析流水线，独立Python
// 脚本，需要service role key直连Postgres)是完全不同的两套东西——这里只导入`projects`/
// `tasks`/`task_groups`这类静态结构数据，不涉及某一周做了什么的历史流水记录，也不支持
// 循环任务(数量太少，直接用tasks.html建更快)。详见
// tools/.claude/plans/plan-ppt-doc-word-spreadsheet-ppt-tingly-platypus.md
import { requireAuth } from "./shared/authGuard.js";
import { renderNav } from "./shared/nav.js";
import {
  listModules,
  listPeople,
  listProjectHeaders,
  createProject,
  claimTaskNumberSafe,
  suggestNextTaskNumber,
  setTaskNumberOwner,
  addTask,
  upsertTaskGroup,
} from "./shared/db.js";
import { PROJECT_TYPE_LABEL } from "./shared/taskLabels.js";
import * as XLSX from "https://esm.sh/xlsx@0.18.5";

const session = await requireAuth();
if (!session) {
  throw new Error("not authenticated");
}
renderNav();

const PROJECT_SHEET = "项目";
const TASK_SHEET = "任务";
const PROJECT_HEADERS = ["编号", "类型", "标题", "分类", "项目截止日期", "项目最终交付物", "状态"];
const TASK_HEADERS = [
  "项目编号", "二级编号", "二级标题", "三级编号", "标题", "模块", "责任人",
  "最终目标交付物", "最终计划完成时间", "预计开始日期", "实际完成时间", "状态",
];
const PROJECT_TYPE_MAP = { 顺序队列: "sequential", 截止日期: "nonsequential" };
const PROJECT_STATUS_MAP = { 进行中: "active", 暂停: "paused", 已完成: "completed" };
const TASK_STATUS_MAP = { 未启动: "not_started", 进行中: "in_progress", 已完成: "done", 中止: "stopped" };

let modules = [];
let people = [];
let existingProjects = [];
let currentProjectItems = [];
let currentTaskItems = [];

function checkDate(raw, label, rowErrors, required = false) {
  const s = String(raw ?? "").trim();
  if (!s) {
    if (required) rowErrors.push(`${label}不能为空`);
    return null;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    rowErrors.push(`${label}格式不对："${s}"，应为YYYY-MM-DD`);
    return null;
  }
  return s;
}

function downloadTemplate() {
  const projectAoa = [PROJECT_HEADERS, [1, "顺序队列", "示例项目——完成年度报告", "科研", "", "", ""]];
  const taskAoa = [
    TASK_HEADERS,
    [
      1, "", "", "", "示例任务——完成初稿",
      "示例模块(请替换成\"设置\"页面已有的模块名称)",
      "示例责任人(请替换成\"设置\"页面已有的责任人姓名)",
      "完整初稿", "2026-08-01", "", "", "",
    ],
    // 二级+三级示例：哪怕这个二级编号下只有1条三级任务，也要填"二级标题"——只要填了
    // 三级编号，这个二级就会在任务管理页面显示成一个分组，不填标题会显示成占位符
    // "(未命名，点详情补充)"，不是留空就没事。
    [
      1, 2, "示例二级分组", 1, "示例三级子任务",
      "示例模块(请替换成\"设置\"页面已有的模块名称)",
      "示例责任人(请替换成\"设置\"页面已有的责任人姓名)",
      "子任务交付物", "2026-08-15", "", "", "",
    ],
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(projectAoa), PROJECT_SHEET);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(taskAoa), TASK_SHEET);
  XLSX.writeFile(wb, "批量导入模板.xlsx");
}

// Excel里真正的日期单元格几乎总是带着自己的显示格式(比如"m/d/yy")，sheet_to_json的
// dateNF选项只在单元格没有自带格式时才生效——实测直接用dateNF+raw:false拿到的是
// "8/15/26"这种按Excel原格式显示的字符串，不是我们要的YYYY-MM-DD，会被checkDate()的
// 正则挡下来报"格式不对"，等于每个用Excel真正日期单元格填的日期都会导致校验失败。
// 改成raw:true拿原始值(配合XLSX.read的cellDates:true，日期单元格会是真正的JS Date对象)
// 自己格式化——统一用getUTC*而不是本地时区的get*，因为Excel序列号转JS Date时是按UTC天数
// 换算的，用本地时区取值在UTC-8以西的地区会直接错一天。加了到天的四舍五入兜底
// 序列号换算可能带的亚毫秒级浮点误差(极端情况下会让本该是当天0点的时间变成前一天23:59:59)。
function formatCellValue(v) {
  if (v instanceof Date) {
    const rounded = new Date(Math.round(v.getTime() / 86400000) * 86400000);
    const y = rounded.getUTCFullYear();
    const m = String(rounded.getUTCMonth() + 1).padStart(2, "0");
    const d = String(rounded.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return v == null ? "" : String(v).trim();
}

// 按header:1读原始二维数组，手动核对列名(而不是直接信任sheet_to_json按第一行当key)，
// 这样列名缺失/打错时能给出明确的"缺哪个列"提示，而不是静默产出undefined字段。
function sheetToRows(ws, expectedHeaders, sheetLabel) {
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", raw: true });
  if (aoa.length === 0) return { rows: [], errors: [`"${sheetLabel}"sheet是空的`] };
  const headerRow = aoa[0].map((h) => String(h).trim());
  const missing = expectedHeaders.filter((h) => !headerRow.includes(h));
  if (missing.length > 0) {
    return { rows: [], errors: [`"${sheetLabel}"sheet缺少列：${missing.join("、")}（请使用下载的模板，不要改列名）`] };
  }
  const idx = Object.fromEntries(expectedHeaders.map((h) => [h, headerRow.indexOf(h)]));
  const rows = [];
  for (let r = 1; r < aoa.length; r++) {
    const raw = aoa[r];
    if (raw.every((c) => c === "" || c == null)) continue;
    const obj = { __row: r + 1 };
    for (const h of expectedHeaders) obj[h] = formatCellValue(raw[idx[h]]);
    rows.push(obj);
  }
  return { rows, errors: [] };
}

function validateProjects(rows) {
  const errors = [];
  const items = [];
  const seenNumbers = new Set();
  for (const row of rows) {
    const rowErrors = [];
    const numberRaw = String(row["编号"]).trim();
    const level1Number = numberRaw ? Number(numberRaw) : null;
    if (numberRaw && (!Number.isInteger(level1Number) || level1Number <= 0)) {
      rowErrors.push("编号必须是正整数或留空");
    }
    const typeLabel = String(row["类型"]).trim();
    const projectType = PROJECT_TYPE_MAP[typeLabel];
    if (!projectType) rowErrors.push(`类型必须填"顺序队列"或"截止日期"，当前是"${typeLabel}"`);
    const title = String(row["标题"]).trim();
    if (!title) rowErrors.push("标题不能为空");
    const statusRaw = String(row["状态"]).trim();
    const status = statusRaw ? PROJECT_STATUS_MAP[statusRaw] : "active";
    if (statusRaw && !status) {
      rowErrors.push(`状态必须是进行中/暂停/已完成之一或留空，当前是"${statusRaw}"`);
    }
    const deadlineDate = checkDate(row["项目截止日期"], "项目截止日期", rowErrors);
    const targetDeliverable = String(row["项目最终交付物"]).trim() || null;
    if (numberRaw && Number.isInteger(level1Number)) {
      if (seenNumbers.has(level1Number)) rowErrors.push(`编号${level1Number}在"项目"sheet里重复出现`);
      seenNumbers.add(level1Number);
    }
    const existing = level1Number != null ? existingProjects.find((p) => p.level1_number === level1Number) : null;
    if (existing && projectType && existing.project_type !== projectType) {
      rowErrors.push(
        `编号${level1Number}在数据库里已存在，但类型是"${PROJECT_TYPE_LABEL[existing.project_type]}"，跟这行填的"${typeLabel}"不一致——请改成一致，或者留空交给系统自动分配新编号`
      );
    }
    if (rowErrors.length > 0) {
      errors.push({ sheet: "项目", row: row.__row, messages: rowErrors });
    } else {
      items.push({
        excelRow: row.__row, level1Number, projectType, title,
        category: String(row["分类"]).trim() || null,
        deadlineDate, targetDeliverable, status,
        reuseExisting: existing || null,
      });
    }
  }
  return { items, errors };
}

function validateTasks(rows, projectItems) {
  const errors = [];
  const items = [];
  const knownProjectNumbers = new Set(existingProjects.map((p) => p.level1_number));
  for (const p of projectItems) {
    if (p.level1Number != null) knownProjectNumbers.add(p.level1Number);
  }
  for (const row of rows) {
    const rowErrors = [];
    const projNumRaw = String(row["项目编号"]).trim();
    const projectNumber = projNumRaw ? Number(projNumRaw) : NaN;
    if (!projNumRaw || !Number.isInteger(projectNumber)) {
      rowErrors.push("项目编号必须填一个整数");
    } else if (!knownProjectNumbers.has(projectNumber)) {
      rowErrors.push(
        `找不到项目编号${projectNumber}——如果这是新建项目，请检查"项目"sheet里对应行是否也填了同样的编号(不能留空)；如果想复用数据库里已有项目，请确认编号没打错`
      );
    }
    const level2Raw = String(row["二级编号"]).trim();
    const level2 = level2Raw ? Number(level2Raw) : null;
    if (level2Raw && (!Number.isInteger(level2) || level2 <= 0)) rowErrors.push("二级编号必须是正整数或留空");
    const level3Raw = String(row["三级编号"]).trim();
    const level3 = level3Raw ? Number(level3Raw) : null;
    if (level3Raw && (!Number.isInteger(level3) || level3 <= 0)) rowErrors.push("三级编号必须是正整数或留空");
    if (level3 != null && level2 == null) rowErrors.push("填了三级编号就必须同时填二级编号");
    const level2Title = String(row["二级标题"]).trim() || null;
    const title = String(row["标题"]).trim();
    if (!title) rowErrors.push("标题不能为空");
    const moduleName = String(row["模块"]).trim();
    const moduleMatch = modules.find((m) => m.name === moduleName);
    if (!moduleName) rowErrors.push("模块不能为空");
    else if (!moduleMatch) rowErrors.push(`模块"${moduleName}"在"设置"页面里找不到，请先去建好，或者检查有没有打错字`);
    const ownerName = String(row["责任人"]).trim();
    const ownerMatch = people.find((p) => p.name === ownerName);
    if (!ownerName) rowErrors.push("责任人不能为空");
    else if (!ownerMatch) rowErrors.push(`责任人"${ownerName}"在"设置"页面里找不到，请先去建好，或者检查有没有打错字`);
    const targetDeliverable = String(row["最终目标交付物"]).trim();
    if (!targetDeliverable) rowErrors.push("最终目标交付物不能为空");
    const plannedCompletionDate = checkDate(row["最终计划完成时间"], "最终计划完成时间", rowErrors, true);
    const plannedStartDate = checkDate(row["预计开始日期"], "预计开始日期", rowErrors);
    const actualCompletionDate = checkDate(row["实际完成时间"], "实际完成时间", rowErrors);
    const statusRaw = String(row["状态"]).trim();
    const status = statusRaw ? TASK_STATUS_MAP[statusRaw] : "not_started";
    if (statusRaw && !status) rowErrors.push(`状态必须是未启动/进行中/已完成/中止之一或留空，当前是"${statusRaw}"`);

    if (rowErrors.length > 0) {
      errors.push({ sheet: "任务", row: row.__row, messages: rowErrors });
    } else {
      items.push({
        excelRow: row.__row, projectNumber, level2, level3, level2Title, title,
        moduleId: moduleMatch.id, owner: ownerMatch.name,
        targetDeliverable, plannedCompletionDate, plannedStartDate, actualCompletionDate,
        status: status || "not_started",
      });
    }
  }

  // 二级分组标题条件校验：只要这个(项目,二级编号)会在tasks.js里被渲染成"分组容器"就
  // 需要标题——判断条件必须跟tasks.js的level2NodeForTaskList()完全一致：不是"level2Title
  // 一定,当level2下有>=1条子任务(level2+level3都填了)时也需要，即使只有单独一条三级任务"
  // (2026-07-16修复：原来的判断条件是group.length>1，漏了"只有1条记录但填了三级编号"这种
  // 最常见的场景——这种情况下tasks.js照样会把它当分组容器渲染，只是分组里恰好只有一个
  // 子任务，之前误判成"不需要标题"，导致task_groups行没被创建，树状展示里2级标题显示成
  // 占位符"(未命名，点详情补充)"，看起来就像"2级标题没有被正确导入"）。
  const groups = new Map();
  for (const it of items) {
    if (it.level2 == null) continue;
    const key = `${it.projectNumber}::${it.level2}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  for (const [key, group] of groups) {
    const isContainer = !(group.length === 1 && group[0].level3 == null);
    if (isContainer && !group.some((it) => it.level2Title)) {
      const [projectNumber, level2] = key.split("::");
      errors.push({
        sheet: "任务",
        row: group.map((it) => it.excelRow).join(","),
        messages: [`项目${projectNumber}的二级编号${level2}下的任务包含三级编号(会显示成一个分组)，必须至少有一行填"二级标题"`],
      });
    }
  }

  return { items, errors };
}

function renderValidationErrors(errors) {
  const el = document.getElementById("validation-errors");
  el.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "status error";
  const ul = document.createElement("ul");
  for (const e of errors) {
    for (const msg of e.messages) {
      const li = document.createElement("li");
      li.textContent = e.row === "-" ? `[${e.sheet}] ${msg}` : `[${e.sheet}sheet 第${e.row}行] ${msg}`;
      ul.appendChild(li);
    }
  }
  wrap.appendChild(ul);
  el.appendChild(wrap);
}

function renderPreview(projectItems, taskItems) {
  currentProjectItems = projectItems;
  currentTaskItems = taskItems;
  const newCount = projectItems.filter((p) => !p.reuseExisting).length;
  document.getElementById("preview-summary").textContent =
    `即将处理 ${projectItems.length} 个项目行（新建 ${newCount} 个，复用已有 ${projectItems.length - newCount} 个）、共 ${taskItems.length} 条任务`;
  document.getElementById("preview-projects-tbody").innerHTML = projectItems
    .map(
      (p) => `
    <tr>
      <td>${p.level1Number ?? "（自动分配）"}</td>
      <td>${PROJECT_TYPE_LABEL[p.projectType]}</td>
      <td>${p.title}</td>
      <td>${p.reuseExisting ? "复用已有项目" : "新建"}</td>
    </tr>`
    )
    .join("");
  document.getElementById("preview-tasks-tbody").innerHTML = taskItems
    .map(
      (t) => `
    <tr>
      <td>${t.projectNumber}</td>
      <td>${t.level2 ?? ""}</td>
      <td>${t.level3 ?? ""}</td>
      <td>${t.title}</td>
      <td>${modules.find((m) => m.id === t.moduleId)?.name ?? ""}</td>
      <td>${t.owner}</td>
      <td>${t.targetDeliverable}</td>
      <td>${t.plannedCompletionDate}</td>
    </tr>`
    )
    .join("");
  document.getElementById("preview-section").hidden = false;
}

async function handleFile(file) {
  const statusEl = document.getElementById("parse-status");
  document.getElementById("validation-errors").innerHTML = "";
  document.getElementById("preview-section").hidden = true;
  document.getElementById("result-section").hidden = true;
  statusEl.textContent = "解析中...";
  statusEl.className = "status";
  try {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array", cellDates: true });
    const projSheet = wb.Sheets[PROJECT_SHEET];
    const taskSheet = wb.Sheets[TASK_SHEET];
    if (!projSheet || !taskSheet) {
      throw new Error(`找不到"${PROJECT_SHEET}"或"${TASK_SHEET}"sheet，请使用下载的模板`);
    }
    const projParse = sheetToRows(projSheet, PROJECT_HEADERS, "项目");
    const taskParse = sheetToRows(taskSheet, TASK_HEADERS, "任务");
    let allErrors = [
      ...projParse.errors.map((m) => ({ sheet: "项目", row: "-", messages: [m] })),
      ...taskParse.errors.map((m) => ({ sheet: "任务", row: "-", messages: [m] })),
    ];
    if (allErrors.length > 0) {
      renderValidationErrors(allErrors);
      statusEl.textContent = "解析完成，但表头有问题";
      statusEl.className = "status error";
      return;
    }
    const { items: projectItems, errors: projectErrors } = validateProjects(projParse.rows);
    const { items: taskItems, errors: taskErrors } = validateTasks(taskParse.rows, projectItems);
    allErrors = [...projectErrors, ...taskErrors];
    if (allErrors.length > 0) {
      renderValidationErrors(allErrors);
      statusEl.textContent = `校验发现${allErrors.length}处问题，请修正后重新上传`;
      statusEl.className = "status error";
      return;
    }
    statusEl.textContent = `校验通过：${projectItems.length}个项目，${taskItems.length}条任务`;
    statusEl.className = "status ok";
    renderPreview(projectItems, taskItems);
  } catch (err) {
    statusEl.textContent = `解析失败：${err.message}`;
    statusEl.className = "status error";
  }
}

function renderResult(results) {
  document.getElementById("result-tbody").innerHTML = results
    .map((r) => `<tr><td>${r.type}</td><td>${r.label}</td><td>${r.ok ? "✓ " + r.message : "✗ " + r.message}</td></tr>`)
    .join("");
  const okCount = results.filter((r) => r.ok).length;
  const failCount = results.length - okCount;
  const summaryEl = document.getElementById("import-summary");
  summaryEl.textContent = `成功 ${okCount} 条，失败 ${failCount} 条`;
  summaryEl.className = failCount > 0 ? "status warn" : "status ok";
  document.getElementById("result-section").hidden = false;
}

async function runImport() {
  const importBtn = document.getElementById("import-btn");
  importBtn.disabled = true;
  const results = [];
  const numberToProjectId = new Map();
  for (const p of existingProjects) numberToProjectId.set(p.level1_number, p.id);

  for (const p of currentProjectItems) {
    if (p.reuseExisting) {
      numberToProjectId.set(p.level1Number, p.reuseExisting.id);
      results.push({ type: "项目", label: `[${p.level1Number}] ${p.title}`, ok: true, message: "复用已有项目" });
      continue;
    }
    try {
      const explicitOrSuggested = p.level1Number ?? (await suggestNextTaskNumber());
      const numberRow = await claimTaskNumberSafe({
        task_type: p.projectType,
        title_snapshot: p.title,
        owning_table: "projects",
        owning_id: 0,
        level1_number: explicitOrSuggested,
      });
      const project = await createProject({
        level1_number: numberRow.level1_number,
        title: p.title,
        project_type: p.projectType,
        status: p.status,
        category: p.category,
        deadline_date: p.deadlineDate,
        target_deliverable: p.targetDeliverable,
      });
      await setTaskNumberOwner(numberRow.level1_number, project.id);
      if (p.level1Number != null) numberToProjectId.set(p.level1Number, project.id);
      numberToProjectId.set(numberRow.level1_number, project.id);
      results.push({ type: "项目", label: `[${numberRow.level1_number}] ${p.title}`, ok: true, message: "已创建" });
    } catch (err) {
      results.push({ type: "项目", label: `[${p.level1Number ?? "自动"}] ${p.title}`, ok: false, message: err.message });
    }
  }

  const groupsDone = new Set();
  for (const t of currentTaskItems) {
    const projectId = numberToProjectId.get(t.projectNumber);
    if (!projectId) {
      results.push({ type: "任务", label: t.title, ok: false, message: `项目编号${t.projectNumber}没有成功建立/找到，跳过` });
      continue;
    }
    try {
      if (t.level2 != null && t.level2Title) {
        const groupKey = `${projectId}::${t.level2}`;
        if (!groupsDone.has(groupKey)) {
          await upsertTaskGroup(projectId, t.level2, t.level2Title);
          groupsDone.add(groupKey);
        }
      }
      await addTask(projectId, {
        wbs_level2_number: t.level2,
        wbs_level3_number: t.level3,
        title: t.title,
        target_deliverable: t.targetDeliverable,
        planned_completion_date: t.plannedCompletionDate,
        planned_start_date: t.plannedStartDate,
        actual_completion_date: t.actualCompletionDate,
        status: t.status,
        module_id: t.moduleId,
        owner: t.owner,
      });
      results.push({ type: "任务", label: t.title, ok: true, message: "已创建" });
    } catch (err) {
      results.push({ type: "任务", label: t.title, ok: false, message: err.message });
    }
  }

  renderResult(results);
  importBtn.disabled = false;
}

async function init() {
  [modules, people, existingProjects] = await Promise.all([listModules(), listPeople(), listProjectHeaders()]);
  document.getElementById("download-template-btn").addEventListener("click", downloadTemplate);
  document.getElementById("file-input").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) handleFile(file);
  });
  document.getElementById("import-btn").addEventListener("click", runImport);
}

await init();
