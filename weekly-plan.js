import { requireAuth } from "./shared/authGuard.js";
import { renderNav } from "./shared/nav.js";
import {
  listModules,
  listMeetingWeeks,
  listQueueProjects,
  listDeadlineProjects,
  listRecurringInstancesForWeek,
  listWeeklyTaskEntries,
  createWeeklyTaskEntry,
  updateWeeklyTaskEntry,
  deleteWeeklyTaskEntry,
  updateMeetingWeekFields,
} from "./shared/db.js";
import { SOURCE_LABEL, sourceIdOf, sourceColumnFor, buildLabelMap, buildSourceDetailMap } from "./shared/taskLabels.js";
import { dateWithWeekday } from "./shared/dateUtils.js";
import { validateSourceDetail, validateOwnFields } from "./shared/entryValidation.js";

const PLAN_REQUIRED_FIELDS = [
  ["module_id", "模块"],
  ["plan_category", "类别"],
  ["owner", "责任人"],
  ["deliverable_this_week", "本周交付物"],
  ["planned_hours", "计划用时"],
  ["plan_start_date", "计划开始时间"],
  ["execution_deadline", "执行期"],
  ["priority_quadrant", "工作优先级"],
  ["resources_needed", "需协调的资源"],
];

const session = await requireAuth();
if (!session) {
  throw new Error("not authenticated");
}
renderNav();

const PRIORITY_OPTIONS = [
  ["", "(未设置)"],
  ["urgent_important", "紧急且重要"],
  ["important_not_urgent", "重要不紧急"],
  ["urgent_not_important", "紧急不重要"],
  ["neither", "不紧急不重要"],
];

let allModules = [];
let allWeeks = [];
let targetWeek = null;
let previousWeek = null;
let candidates = [];

function findPreviousWeek(week) {
  const earlier = allWeeks.filter((w) => w.natural_week_start < week.natural_week_start);
  if (earlier.length === 0) return null;
  return earlier.reduce((a, b) => (a.natural_week_start > b.natural_week_start ? a : b));
}

// 顺序队列项目里"当前应该推进的任务"：按WBS编号(二级.三级)顺序排好，取第一个还没
// done/skipped的——不再是手动维护的current_task_id指针(2026-07-10跟用户确认去掉这个字段，
// 顺序本来就该按编号来，不需要额外的指针/排序字段)
function currentQueueTask(project) {
  const sorted = [...project.queue_project_tasks].sort((a, b) => {
    if (a.wbs_level2_number !== b.wbs_level2_number) return a.wbs_level2_number - b.wbs_level2_number;
    return (a.wbs_level3_number ?? 0) - (b.wbs_level3_number ?? 0);
  });
  return sorted.find((t) => t.status !== "done" && t.status !== "skipped");
}

async function computeCarryOverSet(prevWeek) {
  if (!prevWeek) return new Set();
  const prevSummary = await listWeeklyTaskEntries(prevWeek.id, "summary");
  const set = new Set();
  for (const e of prevSummary) {
    if (e.status === "未完成") {
      set.add(`${e.source_type}:${sourceIdOf(e)}`);
    }
  }
  return set;
}

async function generateCandidatePool(week) {
  const [queueProjects, deadlineProjects, recurringInstances, existingPlan] = await Promise.all([
    listQueueProjects(),
    listDeadlineProjects(),
    listRecurringInstancesForWeek(week.id),
    listWeeklyTaskEntries(week.id, "plan"),
  ]);

  const alreadyPlanned = new Set(existingPlan.map((e) => `${e.source_type}:${sourceIdOf(e)}`));
  const carryOver = await computeCarryOverSet(previousWeek);

  const raw = [];

  for (const p of queueProjects) {
    if (p.status !== "active") continue;
    // "当前任务"不再是手动维护的指针字段，改成按WBS编号顺序(二级.三级)自动判断——
    // 项目里第一个还没done/skipped的任务，就是当前应该推进的那个
    const task = currentQueueTask(p);
    if (!task) continue;
    raw.push({
      source_type: "queue_task",
      source_id: task.id,
      module_id: null,
      owner: null,
      deliverable_this_week: task.target_deliverable || "",
      execution_deadline: null,
    });
  }

  const weekEnd = new Date(week.natural_week_end);
  for (const p of deadlineProjects) {
    if (p.status !== "active") continue;
    for (const m of p.deadline_milestones) {
      if (m.status === "done" || m.status === "stopped") continue;
      if (new Date(m.planned_date) > weekEnd) continue;
      raw.push({
        source_type: "milestone",
        source_id: m.id,
        module_id: null,
        owner: null,
        deliverable_this_week: m.target_deliverable || "",
        execution_deadline: m.planned_date,
      });
    }
  }

  for (const inst of recurringInstances) {
    raw.push({
      source_type: "recurring_instance",
      source_id: inst.id,
      module_id: inst.recurring_task_templates.module_id,
      owner: inst.recurring_task_templates.owner,
      deliverable_this_week: inst.recurring_task_templates.deliverable_template || "",
      execution_deadline: inst.due_date,
    });
  }

  const filtered = raw.filter((c) => !alreadyPlanned.has(`${c.source_type}:${c.source_id}`));
  const detailMap = await buildSourceDetailMap(filtered);
  // 只有一个模块时不用每次手动选，直接默认选中它
  const soleModuleId = allModules.length === 1 ? allModules[0].id : null;
  for (const c of filtered) {
    c.detail = detailMap.get(`${c.source_type}:${c.source_id}`) || {};
    c.plan_category = carryOver.has(`${c.source_type}:${c.source_id}`) ? "上周未完成" : "本周新增";
    if (c.module_id == null && soleModuleId != null) c.module_id = soleModuleId;
  }
  return filtered;
}

function renderWeekRangeHint() {
  const el = document.getElementById("week-range-hint");
  if (!targetWeek) {
    el.textContent = "";
    return;
  }
  el.textContent = `本周工作日范围：${dateWithWeekday(targetWeek.meeting_date)} ~ ${dateWithWeekday(targetWeek.work_week_end)} —— 填"计划开始"/"执行截止"时不要选到这个范围之外（节假日）`;
}

function isPlanLocked() {
  return !!targetWeek?.plan_locked_at;
}

function renderLockUI() {
  const lockBtn = document.getElementById("lock-btn");
  const unlockBtn = document.getElementById("unlock-btn");
  const unlockForm = document.getElementById("unlock-form");
  const statusEl = document.getElementById("lock-status");
  unlockForm.hidden = true;
  if (!targetWeek) return;

  const locked = isPlanLocked();
  lockBtn.hidden = locked;
  unlockBtn.hidden = !locked;

  let text = locked ? `🔒 本周计划已锁定（${new Date(targetWeek.plan_locked_at).toLocaleString()}），编辑前需先解锁` : "";
  if (targetWeek.plan_amendment_note) {
    text += `${text ? " ｜ " : ""}⚠ 曾被订正：${targetWeek.plan_amendment_note}`;
  }
  statusEl.textContent = text;
  statusEl.className = locked ? "status warn" : "status";
}

// 锁定前完整性校验——本周计划表里所有条目的必填字段、以及各自源任务(项目/里程碑/循环任务
// 详情页填的标题/最终目标交付物/最终计划完成时间)必须都补全，否则报错列出缺哪些，不给锁定
async function validatePlanBeforeLock() {
  const entries = await listWeeklyTaskEntries(targetWeek.id, "plan");
  const labelItems = entries.map((e) => ({ source_type: e.source_type, source_id: sourceIdOf(e) }));
  const [labelMap, detailMap] = await Promise.all([buildLabelMap(labelItems), buildSourceDetailMap(labelItems)]);
  const problems = [];
  for (const e of entries) {
    const label = labelMap.get(`${e.source_type}:${sourceIdOf(e)}`) || "(未知任务)";
    const detail = detailMap.get(`${e.source_type}:${sourceIdOf(e)}`);
    const errs = [...validateOwnFields(e, PLAN_REQUIRED_FIELDS), ...validateSourceDetail(e, detail)];
    if (errs.length > 0) problems.push(`${label}：${errs.join("；")}`);
  }
  return problems;
}

document.getElementById("lock-btn").addEventListener("click", async () => {
  const problems = await validatePlanBeforeLock();
  if (problems.length > 0) {
    alert(`本周计划还有内容没填完，暂不能锁定：\n\n${problems.join("\n")}`);
    return;
  }
  const updated = await updateMeetingWeekFields(targetWeek.id, { plan_locked_at: new Date().toISOString() });
  Object.assign(targetWeek, updated);
  renderLockUI();
  await loadSavedPlan();
});

document.getElementById("unlock-btn").addEventListener("click", () => {
  document.getElementById("unlock-form").hidden = false;
});
document.getElementById("unlock-cancel-btn").addEventListener("click", () => {
  document.getElementById("unlock-form").hidden = true;
});
document.getElementById("unlock-confirm-btn").addEventListener("click", async () => {
  const note = document.getElementById("unlock-note").value.trim();
  if (!note) {
    alert("请填写订正说明");
    return;
  }
  const updated = await updateMeetingWeekFields(targetWeek.id, {
    plan_locked_at: null,
    plan_amendment_note: note,
  });
  Object.assign(targetWeek, updated);
  document.getElementById("unlock-note").value = "";
  renderLockUI();
  await loadSavedPlan();
});

function moduleOptionsHtml(selectedId) {
  return (
    `<option value="">(未分类)</option>` +
    allModules
      .map((m) => `<option value="${m.id}" ${m.id === selectedId ? "selected" : ""}>${m.name}</option>`)
      .join("")
  );
}

function priorityOptionsHtml(selected) {
  return PRIORITY_OPTIONS.map(
    ([v, l]) => `<option value="${v}" ${v === (selected || "") ? "selected" : ""}>${l}</option>`
  ).join("");
}

function renderCandidates() {
  const section = document.getElementById("candidates-section");
  const tbody = document.getElementById("candidates-tbody");
  tbody.innerHTML = "";
  section.hidden = candidates.length === 0;
  candidates.forEach((c, idx) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><input type="checkbox" class="f-check" checked /></td>
      <td>${SOURCE_LABEL[c.source_type]}</td>
      <td class="task-col">${c.detail.level1Text || ""}</td>
      <td class="task-col">${c.detail.level2Text || ""}</td>
      <td class="task-col">${c.detail.level3Text || ""}</td>
      <td>${c.plan_category}</td>
      <td><select class="f-module">${moduleOptionsHtml(c.module_id)}</select></td>
      <td><input type="text" class="f-deliverable" value="${c.deliverable_this_week || ""}" style="width:14em" /></td>
      <td><input type="number" class="f-hours" step="0.5" style="width:4em" /></td>
      <td><select class="f-priority">${priorityOptionsHtml(null)}</select></td>
    `;
    tr.dataset.idx = idx;
    tbody.appendChild(tr);
  });
}

document.getElementById("check-all").addEventListener("change", (e) => {
  document.querySelectorAll(".f-check").forEach((cb) => (cb.checked = e.target.checked));
});

document.getElementById("generate-candidates-btn").addEventListener("click", async () => {
  const resultEl = document.getElementById("candidates-result");
  const weekId = Number(document.getElementById("week-select").value);
  targetWeek = allWeeks.find((w) => w.id === weekId);
  previousWeek = findPreviousWeek(targetWeek);
  if (isPlanLocked()) {
    resultEl.textContent = "本周计划已锁定，请先解锁再生成候选";
    resultEl.className = "status warn";
    return;
  }
  resultEl.textContent = "生成中...";
  resultEl.className = "status";
  try {
    candidates = await generateCandidatePool(targetWeek);
    renderCandidates();
    resultEl.textContent = candidates.length === 0 ? "没有新的候选任务（可能都已加入本周计划）" : `找到 ${candidates.length} 条候选`;
    resultEl.className = "status ok";
  } catch (err) {
    resultEl.textContent = `失败：${err.message}`;
    resultEl.className = "status error";
  }
});

document.getElementById("add-selected-btn").addEventListener("click", async () => {
  const resultEl = document.getElementById("add-result");
  if (isPlanLocked()) {
    resultEl.textContent = "本周计划已锁定，请先解锁再加入";
    resultEl.className = "status warn";
    return;
  }
  const rows = [...document.querySelectorAll("#candidates-tbody tr")];
  const toInsert = [];
  for (const tr of rows) {
    if (!tr.querySelector(".f-check").checked) continue;
    const c = candidates[Number(tr.dataset.idx)];
    toInsert.push({
      meeting_week_id: targetWeek.id,
      appears_in: "plan",
      source_type: c.source_type,
      [sourceColumnFor(c.source_type)]: c.source_id,
      module_id: tr.querySelector(".f-module").value || null,
      plan_category: c.plan_category,
      owner: c.owner || "刘璇",
      deliverable_this_week: tr.querySelector(".f-deliverable").value || null,
      planned_hours: tr.querySelector(".f-hours").value || null,
      priority_quadrant: tr.querySelector(".f-priority").value || null,
      execution_deadline: c.execution_deadline || null,
    });
  }
  if (toInsert.length === 0) {
    resultEl.textContent = "没有勾选任何候选";
    resultEl.className = "status warn";
    return;
  }
  resultEl.textContent = "写入中...";
  resultEl.className = "status";
  try {
    for (const row of toInsert) {
      await createWeeklyTaskEntry(row);
    }
    resultEl.textContent = `已加入 ${toInsert.length} 条`;
    resultEl.className = "status ok";
    candidates = await generateCandidatePool(targetWeek);
    renderCandidates();
    await loadSavedPlan();
  } catch (err) {
    resultEl.textContent = `失败：${err.message}`;
    resultEl.className = "status error";
  }
});

async function loadSavedPlan() {
  if (!targetWeek) return;
  const entries = await listWeeklyTaskEntries(targetWeek.id, "plan");
  const labelItems = entries.map((e) => ({ source_type: e.source_type, source_id: sourceIdOf(e) }));
  const detailMap = await buildSourceDetailMap(labelItems);

  const tbody = document.getElementById("plan-tbody");
  tbody.innerHTML = "";
  const locked = isPlanLocked();
  const dis = locked ? "disabled" : "";
  for (const e of entries) {
    const detail = detailMap.get(`${e.source_type}:${sourceIdOf(e)}`) || {};
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="task-col readonly-col">${detail.level1Text || ""}</td>
      <td class="task-col readonly-col">${detail.level2Text || ""}</td>
      <td class="task-col readonly-col">${detail.level3Text || ""}</td>
      <td class="task-col readonly-col">${detail.targetDeliverable || ""}</td>
      <td class="readonly-col">${detail.completionDate || ""}</td>
      <td class="readonly-col">${e.plan_category || ""}</td>
      <td><select class="f-module" ${dis}>${moduleOptionsHtml(e.module_id)}</select></td>
      <td><input type="text" class="f-owner" value="${e.owner || ""}" style="width:5em" ${dis} /></td>
      <td><input type="text" class="f-deliverable" value="${e.deliverable_this_week || ""}" style="width:12em" ${dis} /></td>
      <td><input type="number" class="f-hours" step="0.5" value="${e.planned_hours ?? ""}" style="width:4em" ${dis} /></td>
      <td><input type="date" class="f-start" value="${e.plan_start_date || ""}" min="${targetWeek.meeting_date}" max="${targetWeek.work_week_end || ""}" ${dis} /></td>
      <td><input type="date" class="f-deadline" value="${e.execution_deadline || ""}" min="${targetWeek.meeting_date}" max="${targetWeek.work_week_end || ""}" ${dis} /></td>
      <td><select class="f-priority" ${dis}>${priorityOptionsHtml(e.priority_quadrant)}</select></td>
      <td><input type="text" class="f-resources" value="${e.resources_needed || ""}" style="width:8em" ${dis} /></td>
      <td><input type="checkbox" class="f-highlight" ${e.highlight ? "checked" : ""} ${dis} /></td>
      <td>${detail.detailUrl ? `<a href="${detail.detailUrl}" target="_blank" rel="noopener">编辑任务信息</a>` : ""}</td>
      <td><button type="button" class="secondary f-delete" ${dis}>删除</button></td>
    `;
    const save = async () => {
      await updateWeeklyTaskEntry(e.id, {
        module_id: tr.querySelector(".f-module").value || null,
        owner: tr.querySelector(".f-owner").value || null,
        deliverable_this_week: tr.querySelector(".f-deliverable").value || null,
        planned_hours: tr.querySelector(".f-hours").value || null,
        plan_start_date: tr.querySelector(".f-start").value || null,
        execution_deadline: tr.querySelector(".f-deadline").value || null,
        priority_quadrant: tr.querySelector(".f-priority").value || null,
        resources_needed: tr.querySelector(".f-resources").value || null,
        highlight: tr.querySelector(".f-highlight").checked,
      });
    };
    tr.querySelectorAll("select, input").forEach((el) => el.addEventListener("change", save));
    tr.querySelector(".f-delete").addEventListener("click", async () => {
      await deleteWeeklyTaskEntry(e.id);
      await loadSavedPlan();
    });
    tbody.appendChild(tr);
  }
}

async function init() {
  const [modules, weeks] = await Promise.all([listModules(), listMeetingWeeks()]);
  allModules = modules;
  // 没开例会的整周（春节假期等，在meeting-weeks.html取消勾选"正常"）不参与本周计划的周选择
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
    renderLockUI();
    renderWeekRangeHint();
    await loadSavedPlan();
  }

  weekSelect.addEventListener("change", async () => {
    targetWeek = allWeeks.find((w) => w.id === Number(weekSelect.value));
    previousWeek = findPreviousWeek(targetWeek);
    candidates = [];
    renderCandidates();
    renderLockUI();
    renderWeekRangeHint();
    await loadSavedPlan();
  });
}

await init();
