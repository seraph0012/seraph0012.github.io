import { requireAuth } from "./shared/authGuard.js";
import { renderNav } from "./shared/nav.js";
import {
  listModules,
  listMeetingWeeks,
  listQueueProjects,
  createQueueProject,
  updateQueueProject,
  deleteQueueProject,
  addQueueProjectTask,
  updateQueueProjectTask,
  deleteQueueProjectTask,
  listDeadlineProjects,
  createDeadlineProject,
  updateDeadlineProject,
  deleteDeadlineProject,
  addMilestone,
  updateMilestone,
  deleteMilestone,
  listRecurringTemplates,
  createRecurringTemplate,
  updateRecurringTemplate,
  deleteRecurringTemplate,
  addRecurringInstance,
  updateRecurringInstance,
  deleteRecurringInstance,
  claimTaskNumber,
  setTaskNumberOwner,
  suggestNextTaskNumber,
  hasBeenPlanned,
  countWeeklyTaskEntriesForSource,
  deleteWeeklyTaskEntriesForSource,
} from "./shared/db.js";

const session = await requireAuth();
if (!session) {
  throw new Error("not authenticated");
}
renderNav();

const highlightKey = new URLSearchParams(window.location.search).get("highlight"); // 例如 "queue_task:123"

let allModules = [];
let allWeeksRaw = []; // 未过滤，起始/新增例会周下拉用
let allWeeks = []; // 过滤掉is_normal=false，循环任务编号算法用
let queueProjects = [];
let deadlineProjects = [];
let recurringTemplates = [];
const openDetailKeys = new Set();
if (highlightKey) openDetailKeys.add(highlightKey);

// level2为空代表"项目本身就是任务，没有再往下分解"(比如临时的一次性计划外工作)，
// 这时候编号就是纯"5"而不是"5.2"
function wbsLabel(level1, level2, level3) {
  if (level2 == null) return `${level1}`;
  return level3 != null ? `${level1}.${level2}.${level3}` : `${level1}.${level2}`;
}

function moduleOptionsHtml(selectedId) {
  return (
    `<option value="">(未分类)</option>` +
    allModules.map((m) => `<option value="${m.id}" ${m.id === selectedId ? "selected" : ""}>${m.name}</option>`).join("")
  );
}

function weekOptionsHtml(selectedId) {
  return allWeeksRaw
    .map((w) => `<option value="${w.id}" ${w.id === selectedId ? "selected" : ""}>${w.natural_week_start}（例会${w.meeting_date}）</option>`)
    .join("");
}

// 删除一个（或一批）源任务前，先把引用它们的weekly_task_entries清掉——这些FK没有
// ON DELETE CASCADE(历史周记录不该被源任务删除静默带走)，直接删源任务会被DB挡住。
async function confirmAndCascadeDelete({ label, sourceColumn, sourceIds, deleteFn }) {
  let total = 0;
  for (const id of sourceIds) total += await countWeeklyTaskEntriesForSource(sourceColumn, id);
  const warn =
    total > 0
      ? `\n\n注意：还有${total}条计划/总结条目引用着，会一并删除（如果已经生成过PPT，这些历史记录也会消失）。`
      : "";
  if (!confirm(`确定删除"${label}"？此操作不可撤销。${warn}`)) return false;
  for (const id of sourceIds) {
    await deleteWeeklyTaskEntriesForSource(sourceColumn, id);
  }
  await deleteFn();
  return true;
}

// ---------------- 循环任务编号/候选周算法 ----------------

// weekly频率 - 同月内下一次实例level3=上一实例level3+1(跳过的周顺延递补，不留空号)；
// 跨自然月则level2+1、level3重置为1，且无论中间跳过几个月都只+1(顺延式)。
// monthly频率则level2=上一实例level2+1，不使用level3。
function computeNextNumber(template, instances, targetWeek) {
  if (instances.length === 0) {
    return { level2: 1, level3: template.frequency === "monthly" ? null : 1 };
  }
  const sorted = [...instances].sort((a, b) => {
    const wa = allWeeks.find((w) => w.id === a.meeting_week_id);
    const wb = allWeeks.find((w) => w.id === b.meeting_week_id);
    return new Date((wa ?? {}).natural_week_start || 0) - new Date((wb ?? {}).natural_week_start || 0);
  });
  const last = sorted[sorted.length - 1];
  const lastWeek = allWeeks.find((w) => w.id === last.meeting_week_id);

  if (template.frequency === "monthly") {
    return { level2: last.level2_number + 1, level3: null };
  }
  const sameMonth = lastWeek.calendar_month === targetWeek.calendar_month;
  if (sameMonth) {
    return { level2: last.level2_number, level3: last.level3_number + 1 };
  }
  return { level2: last.level2_number + 1, level3: 1 };
}

// 循环任务模板不再存"起始例会周"这个字段(2026-07-10跟用户确认去掉——这个信息只在创建
// 模板时用一次，创建时就直接生成第一个实例，之后"下一个实例"永远只看"已有实例里最早的
// 那一个"往后找，不需要模板额外记一个开始日期)
function nextUnusedWeek(instances) {
  if (instances.length === 0) return allWeeks[0] ?? null;
  const usedWeekIds = new Set(instances.map((i) => i.meeting_week_id));
  const usedWeeksSorted = instances
    .map((i) => allWeeks.find((w) => w.id === i.meeting_week_id))
    .filter(Boolean)
    .sort((a, b) => new Date(a.natural_week_start) - new Date(b.natural_week_start));
  const firstWeek = usedWeeksSorted[0];
  if (!firstWeek) return null;
  const sorted = [...allWeeks]
    .filter((w) => new Date(w.natural_week_start) >= new Date(firstWeek.natural_week_start))
    .sort((a, b) => new Date(a.natural_week_start) - new Date(b.natural_week_start));
  return sorted.find((w) => !usedWeekIds.has(w.id));
}

// ---------------- 新建任务表单 ----------------

function ownerOptionsHtml() {
  const queueOpts = queueProjects.map((p) => `<option value="queue:${p.id}">[${p.level1_number}] ${p.title}</option>`).join("");
  const deadlineOpts = deadlineProjects.map((p) => `<option value="deadline:${p.id}">[${p.level1_number}] ${p.title}</option>`).join("");
  const recurringOpts = recurringTemplates.map((t) => `<option value="recurring:${t.id}">[${t.level1_number}] ${t.title}</option>`).join("");
  return `
    <optgroup label="顺序队列"><option value="new:queue">+ 新建顺序队列项目</option>${queueOpts}</optgroup>
    <optgroup label="截止日期"><option value="new:deadline">+ 新建截止日期项目</option>${deadlineOpts}</optgroup>
    <optgroup label="循环任务"><option value="new:recurring">+ 新建循环任务</option>${recurringOpts}</optgroup>
  `;
}

function parseOwnerValue() {
  const raw = document.getElementById("owner-select").value;
  const [kind, rest] = raw.split(":");
  if (kind === "new") return { isNew: true, type: rest };
  return { isNew: false, type: kind, id: Number(rest) };
}

// "无(项目本身就是任务)"这个选项只在项目还完全没有任何任务时才提供——一个项目要么是
// "本身就是一条扁平任务"，要么是"往下分解成二级/三级"，两者互斥(DB层用partial unique
// index强制)，不然会出现"项目自己是任务、同时又有子任务"这种说不清楚该看哪个的状态。
function refreshLevel2Options(sel) {
  const level2Select = document.getElementById("wbs-level2-select");
  if (sel.isNew) {
    // 新项目还没建，必然是空的，两个选项都能选
    level2Select.innerHTML = `<option value="__none__">无(项目本身就是任务)</option><option value="__new__">+ 新建二级</option>`;
    level2Select.value = "__none__";
    onLevel2Change(sel);
    return;
  }
  const list = sel.type === "queue" ? queueProjects : deadlineProjects;
  const project = list.find((p) => p.id === sel.id);
  const children = sel.type === "queue" ? project.queue_project_tasks : project.deadline_milestones;
  const groups = [...new Set(children.filter((c) => c.wbs_level2_number != null).map((c) => c.wbs_level2_number))].sort(
    (a, b) => a - b
  );
  const maxLevel2 = groups.length ? Math.max(...groups) : 0;
  const noneOption = children.length === 0 ? `<option value="__none__">无(项目本身就是任务)</option>` : "";
  level2Select.innerHTML =
    noneOption +
    groups.map((g) => `<option value="${g}">二级 ${g}</option>`).join("") +
    `<option value="__new__">+ 新建二级(预填 ${maxLevel2 + 1})</option>`;
  level2Select.value = children.length === 0 ? "__none__" : groups.length ? String(groups[0]) : "__new__";
  onLevel2Change(sel);
}

function onLevel2Change(sel) {
  const level2Select = document.getElementById("wbs-level2-select");
  const val = level2Select.value;
  const isNewLevel2 = val === "__new__";
  const isNone = val === "__none__";
  document.getElementById("wbs-level2-new-wrap").hidden = !isNewLevel2;
  document.getElementById("wbs-level3").closest("label").hidden = isNone;
  if (isNone) return;
  if (sel.isNew) {
    if (isNewLevel2) {
      document.getElementById("wbs-level2-new").value = 1;
      document.getElementById("wbs-level3").value = 1;
    }
    return;
  }
  const list = sel.type === "queue" ? queueProjects : deadlineProjects;
  const project = list.find((p) => p.id === sel.id);
  const children = sel.type === "queue" ? project.queue_project_tasks : project.deadline_milestones;
  if (isNewLevel2) {
    const existingLevel2 = children.filter((c) => c.wbs_level2_number != null).map((c) => c.wbs_level2_number);
    const maxLevel2 = existingLevel2.length ? Math.max(...existingLevel2) : 0;
    document.getElementById("wbs-level2-new").value = maxLevel2 + 1;
    document.getElementById("wbs-level3").value = 1;
  } else {
    const level2Value = Number(val);
    const siblings = children.filter((c) => c.wbs_level2_number === level2Value);
    const maxLevel3 = siblings.reduce((m, c) => Math.max(m, c.wbs_level3_number ?? 0), 0);
    document.getElementById("wbs-level3").value = maxLevel3 + 1;
  }
}

document.getElementById("wbs-level2-select").addEventListener("change", () => onLevel2Change(parseOwnerValue()));

function refreshRecurringPreview(templateId) {
  const t = recurringTemplates.find((x) => x.id === templateId);
  const previewEl = document.getElementById("recurring-instance-preview");
  const targetWeek = nextUnusedWeek(t.recurring_task_instances);
  if (!targetWeek) {
    previewEl.textContent = "没有更多可用的例会周了，请先在例会日历里预生成更多周";
    previewEl.className = "status error";
    return;
  }
  const { level2, level3 } = computeNextNumber(t, t.recurring_task_instances, targetWeek);
  const fullNumber = level3 != null ? `${t.level1_number}.${level2}.${level3}` : `${t.level1_number}.${level2}`;
  previewEl.textContent = `将生成实例 ${fullNumber}（对应例会周 ${targetWeek.natural_week_start}）`;
  previewEl.className = "status";
}

async function onOwnerChange() {
  const sel = parseOwnerValue();
  const isQueueOrDeadline = sel.type === "queue" || sel.type === "deadline";
  document.getElementById("new-project-fields").hidden = !sel.isNew;
  document.getElementById("new-project-deadline-wrap").hidden = sel.type !== "deadline";
  document.getElementById("leaf-fields").hidden = !isQueueOrDeadline;
  document.getElementById("recurring-new-fields").hidden = !(sel.isNew && sel.type === "recurring");
  document.getElementById("recurring-instance-fields").hidden = !(sel.type === "recurring" && !sel.isNew);
  document.getElementById("create-submit-btn").textContent = sel.type === "recurring" && !sel.isNew ? "生成下一个实例" : "新建";

  if (sel.isNew) {
    document.getElementById("new-project-number").value = await suggestNextTaskNumber();
  }
  if (isQueueOrDeadline) {
    refreshLevel2Options(sel);
  }
  if (sel.type === "recurring" && !sel.isNew) {
    refreshRecurringPreview(sel.id);
  }
}

document.getElementById("owner-select").addEventListener("change", onOwnerChange);

async function createQueueOrDeadlineLeaf(sel) {
  const title = document.getElementById("leaf-title").value.trim();
  const deliverable = document.getElementById("leaf-deliverable").value.trim();
  const completionDate = document.getElementById("leaf-completion-date").value;
  const level2Select = document.getElementById("wbs-level2-select");
  let level2 = null;
  let level3 = null;
  if (level2Select.value !== "__none__") {
    level2 = level2Select.value === "__new__" ? Number(document.getElementById("wbs-level2-new").value) : Number(level2Select.value);
    const level3raw = document.getElementById("wbs-level3").value;
    level3 = level3raw ? Number(level3raw) : null;
  }
  if (!title || !deliverable || !completionDate) {
    throw new Error("任务标题/最终目标交付物/最终计划完成时间都是必填项");
  }

  let projectId;
  if (sel.isNew) {
    const projTitle = document.getElementById("new-project-title").value.trim();
    if (!projTitle) throw new Error("请填写项目名");
    const level1Number = Number(document.getElementById("new-project-number").value);
    const numberRow = await claimTaskNumber({
      task_type: sel.type,
      title_snapshot: projTitle,
      owning_table: sel.type === "queue" ? "queue_projects" : "deadline_projects",
      owning_id: 0,
      level1_number: level1Number,
    });
    if (sel.type === "queue") {
      const category = document.getElementById("new-project-category").value.trim() || null;
      const p = await createQueueProject({ title: projTitle, category, level1_number: numberRow.level1_number });
      projectId = p.id;
    } else {
      const deadlineDate = document.getElementById("new-project-deadline").value;
      if (!deadlineDate) throw new Error("请填写项目截止日期");
      const p = await createDeadlineProject({
        title: projTitle,
        deadline_date: deadlineDate,
        level1_number: numberRow.level1_number,
      });
      projectId = p.id;
    }
    await setTaskNumberOwner(numberRow.level1_number, projectId);
  } else {
    projectId = sel.id;
  }

  if (sel.type === "queue") {
    await addQueueProjectTask(projectId, {
      wbs_level2_number: level2,
      wbs_level3_number: level3,
      title,
      target_deliverable: deliverable,
      planned_completion_date: completionDate,
    });
  } else {
    await addMilestone(projectId, {
      wbs_level2_number: level2,
      wbs_level3_number: level3,
      title,
      target_deliverable: deliverable,
      planned_date: completionDate,
    });
  }
}

async function createRecurringNew() {
  const title = document.getElementById("new-project-title").value.trim();
  const deliverable = document.getElementById("recurring-deliverable").value.trim();
  const firstWeekId = Number(document.getElementById("recurring-first-week").value);
  const level1Number = Number(document.getElementById("new-project-number").value);
  if (!title || !deliverable || !firstWeekId) {
    throw new Error("标题/最终目标交付物/第一次的例会周都是必填项");
  }
  const numberRow = await claimTaskNumber({
    task_type: "recurring",
    title_snapshot: title,
    owning_table: "recurring_task_templates",
    owning_id: 0,
    level1_number: level1Number,
  });
  const frequency = document.getElementById("recurring-frequency").value;
  const template = await createRecurringTemplate({
    title,
    module_id: document.getElementById("recurring-module").value || null,
    owner: document.getElementById("recurring-owner").value.trim() || null,
    frequency,
    deliverable_template: deliverable,
    level1_number: numberRow.level1_number,
  });
  await setTaskNumberOwner(numberRow.level1_number, template.id);
  // 起始例会周只在这里用一次，直接生成第一个实例，不作为模板的持久字段保存
  const firstWeek = allWeeksRaw.find((w) => w.id === firstWeekId);
  const level3 = frequency === "monthly" ? null : 1;
  const fullNumber = level3 != null ? `${numberRow.level1_number}.1.${level3}` : `${numberRow.level1_number}.1`;
  await addRecurringInstance(template.id, {
    meeting_week_id: firstWeekId,
    level2_number: 1,
    level3_number: level3,
    full_number: fullNumber,
    due_date: firstWeek.meeting_date,
  });
}

async function generateNextInstance(templateId) {
  const t = recurringTemplates.find((x) => x.id === templateId);
  const targetWeek = nextUnusedWeek(t.recurring_task_instances);
  if (!targetWeek) throw new Error("没有更多可用的例会周了，请先在例会日历里预生成更多周");
  const { level2, level3 } = computeNextNumber(t, t.recurring_task_instances, targetWeek);
  const fullNumber = level3 != null ? `${t.level1_number}.${level2}.${level3}` : `${t.level1_number}.${level2}`;
  await addRecurringInstance(t.id, {
    meeting_week_id: targetWeek.id,
    level2_number: level2,
    level3_number: level3,
    full_number: fullNumber,
    due_date: targetWeek.meeting_date,
  });
}

document.getElementById("create-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const resultEl = document.getElementById("create-result");
  const sel = parseOwnerValue();
  resultEl.textContent = "处理中...";
  resultEl.className = "status";
  try {
    if (sel.type === "recurring" && sel.isNew) {
      await createRecurringNew();
    } else if (sel.type === "recurring" && !sel.isNew) {
      await generateNextInstance(sel.id);
    } else {
      await createQueueOrDeadlineLeaf(sel);
    }
    resultEl.textContent = "成功";
    resultEl.className = "status ok";
    await reloadAll();
    document.getElementById("leaf-title").value = "";
    document.getElementById("leaf-deliverable").value = "";
    document.getElementById("leaf-completion-date").value = "";
    await onOwnerChange();
  } catch (err) {
    resultEl.textContent = `失败：${err.message}`;
    resultEl.className = "status error";
  }
});

// ---------------- 合并任务表(按项目分组、项目下按二级分组) ----------------

// direct: level2为空的那一条(项目本身就是任务)，最多1条；level2Groups: 按二级编号分组、
// 组内按三级编号排好序——一个二级分组如果只有1条且没有三级编号，说明这个二级本身就是
// 叶子任务(没有再往下分)，不需要单独显示一个分组标题行，直接当普通任务行展示
function groupChildren(children) {
  const direct = children.find((c) => c.wbs_level2_number == null) || null;
  const rest = children.filter((c) => c.wbs_level2_number != null);
  const byLevel2 = new Map();
  for (const c of rest) {
    if (!byLevel2.has(c.wbs_level2_number)) byLevel2.set(c.wbs_level2_number, []);
    byLevel2.get(c.wbs_level2_number).push(c);
  }
  const level2Groups = [...byLevel2.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([level2, items]) => ({
      level2,
      items: items.sort((a, b) => (a.wbs_level3_number ?? 0) - (b.wbs_level3_number ?? 0)),
    }));
  return { direct, level2Groups };
}

function makeLeafRow(type, typeLabel, project, item, number) {
  const isQueue = type === "queue";
  const isDeadline = type === "deadline";
  const isRecurring = type === "recurring";
  return {
    kind: "leaf",
    key: isQueue ? `queue_task:${item.id}` : isDeadline ? `milestone:${item.id}` : `recurring_instance:${item.id}`,
    type,
    typeLabel,
    number,
    projectName: project.title,
    title: isRecurring ? project.title : item.title,
    deliverable: isRecurring ? project.deliverable_template : item.target_deliverable,
    completionDate: isQueue ? item.planned_completion_date : isDeadline ? item.planned_date : item.due_date,
    actualDate: item.actual_completion_date ?? item.actual_date,
    status: item.status,
    project,
    item,
  };
}

function buildDisplayRows() {
  const displayRows = [];

  for (const p of queueProjects) {
    const { direct, level2Groups } = groupChildren(p.queue_project_tasks);
    if (!direct && level2Groups.length === 0) continue; // 空项目(还没建任何任务)暂不展示
    displayRows.push({ kind: "project-header", label: `[${p.level1_number}] ${p.title}`, typeLabel: "顺序队列" });
    if (direct) displayRows.push(makeLeafRow("queue", "顺序队列", p, direct, wbsLabel(p.level1_number, null, null)));
    for (const g of level2Groups) {
      if (g.items.length === 1 && g.items[0].wbs_level3_number == null) {
        displayRows.push(makeLeafRow("queue", "顺序队列", p, g.items[0], wbsLabel(p.level1_number, g.level2, null)));
      } else {
        displayRows.push({ kind: "level2-header", label: `${p.level1_number}.${g.level2}` });
        for (const t of g.items) {
          displayRows.push(makeLeafRow("queue", "顺序队列", p, t, wbsLabel(p.level1_number, g.level2, t.wbs_level3_number)));
        }
      }
    }
  }

  for (const p of deadlineProjects) {
    const { direct, level2Groups } = groupChildren(p.deadline_milestones);
    if (!direct && level2Groups.length === 0) continue;
    displayRows.push({ kind: "project-header", label: `[${p.level1_number}] ${p.title}`, typeLabel: "截止日期" });
    if (direct) displayRows.push(makeLeafRow("deadline", "截止日期", p, direct, wbsLabel(p.level1_number, null, null)));
    for (const g of level2Groups) {
      if (g.items.length === 1 && g.items[0].wbs_level3_number == null) {
        displayRows.push(makeLeafRow("deadline", "截止日期", p, g.items[0], wbsLabel(p.level1_number, g.level2, null)));
      } else {
        displayRows.push({ kind: "level2-header", label: `${p.level1_number}.${g.level2}` });
        for (const m of g.items) {
          displayRows.push(makeLeafRow("deadline", "截止日期", p, m, wbsLabel(p.level1_number, g.level2, m.wbs_level3_number)));
        }
      }
    }
  }

  for (const t of recurringTemplates) {
    if (t.recurring_task_instances.length === 0) continue;
    displayRows.push({ kind: "project-header", label: `[${t.level1_number}] ${t.title}`, typeLabel: "循环任务" });
    const byLevel2 = new Map();
    for (const inst of t.recurring_task_instances) {
      if (!byLevel2.has(inst.level2_number)) byLevel2.set(inst.level2_number, []);
      byLevel2.get(inst.level2_number).push(inst);
    }
    const groups = [...byLevel2.entries()].sort((a, b) => a[0] - b[0]);
    for (const [level2, items] of groups) {
      const sortedItems = items.sort((a, b) => (a.level3_number ?? 0) - (b.level3_number ?? 0));
      if (sortedItems.length === 1 && sortedItems[0].level3_number == null) {
        displayRows.push(makeLeafRow("recurring", "循环任务", t, sortedItems[0], sortedItems[0].full_number));
      } else {
        displayRows.push({ kind: "level2-header", label: `${t.level1_number}.${level2}` });
        for (const inst of sortedItems) {
          displayRows.push(makeLeafRow("recurring", "循环任务", t, inst, inst.full_number));
        }
      }
    }
  }

  return displayRows;
}

function terminateStatusFor(type) {
  return type === "queue" ? "skipped" : "stopped";
}

function buildDetailPanel(r, locked) {
  const wrap = document.createElement("div");
  if (r.type === "queue" || r.type === "deadline") {
    const t = r.item;
    const isQueue = r.type === "queue";
    const completionValue = isQueue ? t.planned_completion_date : t.planned_date;
    const noteValue = isQueue ? t.completion_date_amendment_note : t.planned_date_amendment_note;
    const updateItemFn = isQueue ? updateQueueProjectTask : updateMilestone;
    wrap.innerHTML = `
      <div class="inline-form">
        <label>标题 <input type="text" class="d-title" value="${t.title}" style="min-width:200px" /></label>
        <label>最终目标交付物 <input type="text" class="d-deliverable" value="${t.target_deliverable ?? ""}" style="min-width:200px" /></label>
        <span>最终计划完成时间：${
          locked
            ? `🔒 ${completionValue ?? ""}${noteValue ? ` <span class="badge">订正：${noteValue}</span>` : ""} <button type="button" class="secondary d-amend">订正</button>`
            : `<input type="date" class="d-completion" value="${completionValue ?? ""}" />`
        }</span>
        ${
          !isQueue
            ? `<label>实际日期 <input type="date" class="d-actual" value="${t.actual_date ?? ""}" /></label>`
            : `<span>实际完成时间：${t.actual_completion_date ?? "(未完成)"}</span>`
        }
        <span>状态：${t.status}</span>
        ${t.status !== terminateStatusFor(r.type) ? `<button type="button" class="secondary d-terminate">标记中止</button>` : ""}
        <button type="button" class="secondary d-delete">删除此任务</button>
      </div>
      <div class="inline-form" style="margin-top:6px;border-top:1px dashed #ccc;padding-top:6px;">
        <strong>所属项目设置：</strong>
        ${isQueue ? `<label>分类 <input type="text" class="p-category" value="${r.project.category ?? ""}" style="width:10em" /></label>` : ""}
        ${!isQueue ? `<label>截止日期 <input type="date" class="p-deadline" value="${r.project.deadline_date}" /></label>` : ""}
        <label>项目状态
          <select class="p-status">
            ${(isQueue ? ["active", "paused", "completed"] : ["active", "completed"])
              .map((s) => `<option value="${s}" ${s === r.project.status ? "selected" : ""}>${s}</option>`)
              .join("")}
          </select>
        </label>
        ${!isQueue ? `<label>项目最终交付物 <input type="text" class="p-deliverable" value="${r.project.target_deliverable ?? ""}" /></label>` : ""}
        <button type="button" class="secondary d-delete-project">删除整个项目</button>
      </div>
    `;
    wrap.querySelector(".d-title").addEventListener("change", async (e) => {
      await updateItemFn(t.id, { title: e.target.value });
      await reloadAll();
    });
    wrap.querySelector(".d-deliverable").addEventListener("change", async (e) => {
      await updateItemFn(t.id, { target_deliverable: e.target.value || null });
      await reloadAll();
    });
    const completionInput = wrap.querySelector(".d-completion");
    if (completionInput) {
      completionInput.addEventListener("change", async (e) => {
        await updateItemFn(t.id, isQueue ? { planned_completion_date: e.target.value } : { planned_date: e.target.value });
        await reloadAll();
      });
    }
    const amendBtn = wrap.querySelector(".d-amend");
    if (amendBtn) {
      amendBtn.addEventListener("click", async () => {
        const note = prompt("请填写订正说明（为什么要修改已锁定的最终计划完成时间，这条会被记录）：");
        if (!note) return;
        const newDate = prompt("新的最终计划完成时间(YYYY-MM-DD)：", completionValue ?? "");
        if (!newDate) return;
        await updateItemFn(
          t.id,
          isQueue
            ? { planned_completion_date: newDate, completion_date_amendment_note: note }
            : { planned_date: newDate, planned_date_amendment_note: note }
        );
        await reloadAll();
      });
    }
    const actualInput = wrap.querySelector(".d-actual");
    if (actualInput) {
      actualInput.addEventListener("change", async (e) => {
        await updateMilestone(t.id, { actual_date: e.target.value || null });
        await reloadAll();
      });
    }
    const terminateBtn = wrap.querySelector(".d-terminate");
    if (terminateBtn) {
      terminateBtn.addEventListener("click", async () => {
        if (!confirm(`确定把"${t.title}"标记为中止？不用等总结周期，直接生效。`)) return;
        await updateItemFn(t.id, { status: terminateStatusFor(r.type) });
        await reloadAll();
      });
    }
    wrap.querySelector(".d-delete").addEventListener("click", async () => {
      const ok = await confirmAndCascadeDelete({
        label: `任务"${t.title}"`,
        sourceColumn: isQueue ? "source_queue_task_id" : "source_milestone_id",
        sourceIds: [t.id],
        deleteFn: () => (isQueue ? deleteQueueProjectTask(t.id) : deleteMilestone(t.id)),
      });
      if (ok) {
        openDetailKeys.delete(r.key);
        await reloadAll();
      }
    });
    const categoryInput = wrap.querySelector(".p-category");
    const deadlineInput = wrap.querySelector(".p-deadline");
    const deliverableInput = wrap.querySelector(".p-deliverable");
    const statusSelect = wrap.querySelector(".p-status");
    const saveProject = async () => {
      if (isQueue) {
        await updateQueueProject(r.project.id, {
          category: categoryInput.value.trim() || null,
          status: statusSelect.value,
        });
      } else {
        await updateDeadlineProject(r.project.id, {
          deadline_date: deadlineInput.value,
          status: statusSelect.value,
          target_deliverable: deliverableInput.value.trim() || null,
        });
      }
      await reloadAll();
    };
    [categoryInput, deadlineInput, deliverableInput, statusSelect].filter(Boolean).forEach((el) => el.addEventListener("change", saveProject));
    wrap.querySelector(".d-delete-project").addEventListener("click", async () => {
      const children = isQueue ? r.project.queue_project_tasks : r.project.deadline_milestones;
      const ok = await confirmAndCascadeDelete({
        label: `项目"${r.project.title}"（含其下全部${children.length}个任务）`,
        sourceColumn: isQueue ? "source_queue_task_id" : "source_milestone_id",
        sourceIds: children.map((c) => c.id),
        deleteFn: () => (isQueue ? deleteQueueProject(r.project.id) : deleteDeadlineProject(r.project.id)),
      });
      if (ok) {
        openDetailKeys.delete(r.key);
        await reloadAll();
      }
    });
  } else {
    // recurring instance
    const inst = r.item;
    const template = r.project;
    wrap.innerHTML = `
      <div class="inline-form">
        <span>应完成日期：${inst.due_date}（按编号算法自动生成，不可手改）</span>
        <label>实际完成时间 <input type="date" class="d-actual" value="${inst.actual_completion_date ?? ""}" /></label>
        <span>状态：${inst.status}</span>
        ${inst.status !== "stopped" ? `<button type="button" class="secondary d-terminate">标记中止</button>` : ""}
        <button type="button" class="secondary d-delete">删除此实例</button>
      </div>
      <div class="inline-form" style="margin-top:6px;border-top:1px dashed #ccc;padding-top:6px;">
        <strong>所属循环任务设置（会影响这个模板下的所有实例）：</strong>
        <label>标题 <input type="text" class="p-title" value="${template.title}" style="min-width:180px" /></label>
        <select class="p-module">${moduleOptionsHtml(template.module_id)}</select>
        <input type="text" class="p-owner" value="${template.owner ?? ""}" placeholder="责任人" />
        <select class="p-frequency">
          ${["weekly", "monthly", "custom"].map((f) => `<option value="${f}" ${f === template.frequency ? "selected" : ""}>${f}</option>`).join("")}
        </select>
        <input type="text" class="p-deliverable" value="${template.deliverable_template ?? ""}" placeholder="最终目标交付物" style="min-width:180px" />
        <select class="p-status">
          ${["active", "completed", "paused"].map((s) => `<option value="${s}" ${s === template.status ? "selected" : ""}>${s}</option>`).join("")}
        </select>
        <button type="button" class="secondary d-delete-template">删除整个循环任务</button>
      </div>
    `;
    wrap.querySelector(".d-actual").addEventListener("change", async (e) => {
      await updateRecurringInstance(inst.id, { actual_completion_date: e.target.value || null });
      await reloadAll();
    });
    const terminateBtn = wrap.querySelector(".d-terminate");
    if (terminateBtn) {
      terminateBtn.addEventListener("click", async () => {
        if (!confirm(`确定把实例"${inst.full_number}"标记为中止？不用等总结周期，直接生效。`)) return;
        await updateRecurringInstance(inst.id, { status: "stopped" });
        await reloadAll();
      });
    }
    wrap.querySelector(".d-delete").addEventListener("click", async () => {
      const ok = await confirmAndCascadeDelete({
        label: `实例"${inst.full_number}"`,
        sourceColumn: "source_recurring_instance_id",
        sourceIds: [inst.id],
        deleteFn: () => deleteRecurringInstance(inst.id),
      });
      if (ok) {
        openDetailKeys.delete(r.key);
        await reloadAll();
      }
    });
    const titleInput = wrap.querySelector(".p-title");
    const moduleSelect = wrap.querySelector(".p-module");
    const ownerInput = wrap.querySelector(".p-owner");
    const frequencySelect = wrap.querySelector(".p-frequency");
    const deliverableInput = wrap.querySelector(".p-deliverable");
    const statusSelect = wrap.querySelector(".p-status");
    const saveTemplate = async () => {
      await updateRecurringTemplate(template.id, {
        title: titleInput.value.trim(),
        module_id: moduleSelect.value || null,
        owner: ownerInput.value.trim() || null,
        frequency: frequencySelect.value,
        deliverable_template: deliverableInput.value.trim() || null,
        status: statusSelect.value,
      });
      await reloadAll();
    };
    [titleInput, moduleSelect, ownerInput, frequencySelect, deliverableInput, statusSelect].forEach((el) =>
      el.addEventListener("change", saveTemplate)
    );
    wrap.querySelector(".d-delete-template").addEventListener("click", async () => {
      const ok = await confirmAndCascadeDelete({
        label: `循环任务"${template.title}"（含其下全部${template.recurring_task_instances.length}个实例）`,
        sourceColumn: "source_recurring_instance_id",
        sourceIds: template.recurring_task_instances.map((i) => i.id),
        deleteFn: () => deleteRecurringTemplate(template.id),
      });
      if (ok) {
        openDetailKeys.delete(r.key);
        await reloadAll();
      }
    });
  }
  return wrap;
}

async function renderTaskTable() {
  const rows = buildDisplayRows();
  const leafRows = rows.filter((r) => r.kind === "leaf");
  const lockable = leafRows.filter((r) => r.type !== "recurring");
  const lockFlags = await Promise.all(
    lockable.map((r) => hasBeenPlanned(r.type === "queue" ? "source_queue_task_id" : "source_milestone_id", r.item.id))
  );
  const lockMap = new Map(lockable.map((r, i) => [r.key, lockFlags[i]]));

  const tbody = document.getElementById("tasks-tbody");
  tbody.innerHTML = "";
  for (const r of rows) {
    if (r.kind === "project-header") {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td colspan="9" style="background:#f2f2f2;font-weight:600;">${r.label}（${r.typeLabel}）</td>`;
      tbody.appendChild(tr);
      continue;
    }
    if (r.kind === "level2-header") {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td colspan="9" style="padding-left:2em;color:#666;">${r.label}</td>`;
      tbody.appendChild(tr);
      continue;
    }

    const locked = lockMap.get(r.key) || false;
    const tr = document.createElement("tr");
    if (r.key === highlightKey) tr.className = "row-highlight";
    tr.innerHTML = `
      <td>${r.number}</td>
      <td>${r.typeLabel}</td>
      <td class="task-col">${r.projectName}</td>
      <td class="task-col">${r.title}</td>
      <td class="task-col">${r.deliverable ?? ""}</td>
      <td>${locked ? `🔒 ${r.completionDate ?? ""}` : r.completionDate ?? ""}</td>
      <td>${r.actualDate ?? ""}</td>
      <td>${r.status}</td>
      <td><button type="button" class="secondary f-toggle-detail">${openDetailKeys.has(r.key) ? "收起" : "详情"}</button></td>
    `;
    tr.querySelector(".f-toggle-detail").addEventListener("click", () => {
      if (openDetailKeys.has(r.key)) openDetailKeys.delete(r.key);
      else openDetailKeys.add(r.key);
      renderTaskTable();
    });
    tbody.appendChild(tr);

    if (openDetailKeys.has(r.key)) {
      const detailTr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 9;
      td.appendChild(buildDetailPanel(r, locked));
      detailTr.appendChild(td);
      tbody.appendChild(detailTr);
    }
  }
  if (highlightKey) {
    const el = document.querySelector(".row-highlight");
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

// ---------------- 加载 ----------------

async function reloadAll() {
  [queueProjects, deadlineProjects, recurringTemplates] = await Promise.all([
    listQueueProjects(),
    listDeadlineProjects(),
    listRecurringTemplates(),
  ]);
  await renderTaskTable();
  const ownerSelect = document.getElementById("owner-select");
  const prevValue = ownerSelect.value;
  ownerSelect.innerHTML = ownerOptionsHtml();
  if ([...ownerSelect.options].some((o) => o.value === prevValue)) ownerSelect.value = prevValue;
  await onOwnerChange();
}

async function init() {
  const [modules, weeks] = await Promise.all([listModules(), listMeetingWeeks()]);
  allModules = modules;
  allWeeksRaw = weeks;
  allWeeks = weeks.filter((w) => w.is_normal !== false);

  const weekSelect = document.getElementById("recurring-first-week");
  weekSelect.innerHTML = weekOptionsHtml(null);

  await reloadAll();
}

await init();
