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
  getRecurringTemplate,
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
let allWeeksRaw = []; // 未过滤，起始例会周下拉用（历史订正场景可能要选到is_normal=false的周）
let allWeeks = []; // 过滤掉is_normal=false，循环任务编号算法/候选周用
let queueProjects = [];
let deadlineProjects = [];
let recurringTemplates = [];
const openInstanceTemplateIds = new Set();

function wbsLabel(level1, level2, level3) {
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

function lockedDateHtml(date, note) {
  return `<span class="locked-date">🔒 ${date ?? ""}</span>${
    note ? `<br /><span class="badge">订正：${note}</span>` : ""
  } <button type="button" class="secondary f-amend">订正</button>`;
}

// 状态列只读展示——唯一来源是weekly-summary.js填完成情况时自动同步过来(syncSourceStatus)，
// 这里不能自由改，避免跟总结历史对不上。"标记中止"是唯一允许在这个页面直接触发的状态变更，
// 用于不想等到总结周期就直接终止一个任务的场景。
function statusBadgeHtml(status) {
  return `<span class="readonly-col">${status}</span>`;
}

// 删除一个（或一批）源任务前，先把引用它们的weekly_task_entries清掉——这些FK没有
// ON DELETE CASCADE(历史周记录不该被源任务删除静默带走)，直接删源任务会被DB挡住。
// 2026-07-10发现的真实case：用户想清空不合格的测试任务重新填，但每个任务背后可能已经
// 挂着计划/总结条目，需要一并处理，跟之前ad_hoc_tasks删除时用的是同一套模式。
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

// ---------------- 新建任务表单 ----------------

function typeSelectValue() {
  return document.getElementById("type-select").value;
}

async function refreshWbsPrefill() {
  const type = typeSelectValue();
  if (type === "recurring") return;
  const sel = document.getElementById("project-select");
  if (sel.value === "__new__") {
    document.getElementById("new-project-number").value = await suggestNextTaskNumber();
    document.getElementById("wbs-level2").value = 1;
    document.getElementById("wbs-level3").value = "";
  } else {
    const projectId = Number(sel.value);
    const list = type === "queue" ? queueProjects : deadlineProjects;
    const project = list.find((p) => p.id === projectId);
    const children = type === "queue" ? project?.queue_project_tasks ?? [] : project?.deadline_milestones ?? [];
    const maxLevel2 = children.reduce((m, t) => Math.max(m, t.wbs_level2_number), 0);
    document.getElementById("wbs-level2").value = maxLevel2 + 1;
    document.getElementById("wbs-level3").value = "";
  }
}

function renderProjectOptions() {
  const type = typeSelectValue();
  const sel = document.getElementById("project-select");
  const list = type === "queue" ? queueProjects : deadlineProjects;
  sel.innerHTML =
    `<option value="__new__">+ 新建项目</option>` +
    list.map((p) => `<option value="${p.id}">[${p.level1_number}] ${p.title}</option>`).join("");
  sel.value = "__new__";
  onProjectSelectChange();
}

function onProjectSelectChange() {
  const type = typeSelectValue();
  const isNew = document.getElementById("project-select").value === "__new__";
  document.getElementById("new-project-fields").hidden = type === "recurring" ? true : !isNew;
  document.getElementById("new-project-deadline-wrap").hidden = type !== "deadline";
  refreshWbsPrefill();
}

async function onTypeChange() {
  const type = typeSelectValue();
  document.getElementById("leaf-fields").hidden = type === "recurring";
  document.getElementById("recurring-fields").hidden = type !== "recurring";
  document.getElementById("project-picker-wrap").hidden = type === "recurring";
  if (type === "recurring") {
    document.getElementById("new-project-fields").hidden = true;
    document.getElementById("recurring-number").value = await suggestNextTaskNumber();
  } else {
    renderProjectOptions();
  }
}

document.getElementById("type-select").addEventListener("change", onTypeChange);
document.getElementById("project-select").addEventListener("change", onProjectSelectChange);

async function createQueueOrDeadlineLeaf(type) {
  const sel = document.getElementById("project-select");
  const title = document.getElementById("leaf-title").value.trim();
  const deliverable = document.getElementById("leaf-deliverable").value.trim();
  const completionDate = document.getElementById("leaf-completion-date").value;
  const level2 = Number(document.getElementById("wbs-level2").value);
  const level3raw = document.getElementById("wbs-level3").value;
  const level3 = level3raw ? Number(level3raw) : null;
  if (!title || !deliverable || !completionDate) {
    throw new Error("任务标题/最终目标交付物/最终计划完成时间都是必填项");
  }

  let projectId;
  if (sel.value === "__new__") {
    const projTitle = document.getElementById("new-project-title").value.trim();
    if (!projTitle) throw new Error("请填写项目名");
    const level1Number = Number(document.getElementById("new-project-number").value);
    const numberRow = await claimTaskNumber({
      task_type: type,
      title_snapshot: projTitle,
      owning_table: type === "queue" ? "queue_projects" : "deadline_projects",
      owning_id: 0,
      level1_number: level1Number,
    });
    if (type === "queue") {
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
    projectId = Number(sel.value);
  }

  if (type === "queue") {
    const project = queueProjects.find((p) => p.id === projectId);
    const maxOrdinal = project ? project.queue_project_tasks.reduce((m, t) => Math.max(m, t.execution_ordinal), 0) : 0;
    await addQueueProjectTask(projectId, {
      wbs_level2_number: level2,
      wbs_level3_number: level3,
      title,
      target_deliverable: deliverable,
      planned_completion_date: completionDate,
      execution_ordinal: maxOrdinal + 1,
    });
  } else {
    const project = deadlineProjects.find((p) => p.id === projectId);
    const maxOrdinal = project ? project.deadline_milestones.reduce((m, x) => Math.max(m, x.ordinal), 0) : 0;
    await addMilestone(projectId, {
      wbs_level2_number: level2,
      wbs_level3_number: level3,
      title,
      target_deliverable: deliverable,
      planned_date: completionDate,
      ordinal: maxOrdinal + 1,
    });
  }
}

async function createRecurringLeaf() {
  const title = document.getElementById("recurring-title").value.trim();
  const deliverable = document.getElementById("recurring-deliverable").value.trim();
  const startWeekId = Number(document.getElementById("recurring-start-week").value);
  const level1Number = Number(document.getElementById("recurring-number").value);
  if (!title || !deliverable || !startWeekId) {
    throw new Error("任务标题/最终目标交付物/起始例会周都是必填项");
  }
  const numberRow = await claimTaskNumber({
    task_type: "recurring",
    title_snapshot: title,
    owning_table: "recurring_task_templates",
    owning_id: 0,
    level1_number: level1Number,
  });
  const startWeek = allWeeksRaw.find((w) => w.id === startWeekId);
  const template = await createRecurringTemplate({
    title,
    module_id: document.getElementById("recurring-module").value || null,
    owner: document.getElementById("recurring-owner").value.trim() || null,
    frequency: document.getElementById("recurring-frequency").value,
    start_date: startWeek.natural_week_start,
    start_meeting_week_id: startWeekId,
    deliverable_template: deliverable,
    level1_number: numberRow.level1_number,
  });
  await setTaskNumberOwner(numberRow.level1_number, template.id);
}

document.getElementById("create-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const resultEl = document.getElementById("create-result");
  const type = typeSelectValue();
  resultEl.textContent = "创建中...";
  resultEl.className = "status";
  try {
    if (type === "recurring") {
      await createRecurringLeaf();
    } else {
      await createQueueOrDeadlineLeaf(type);
    }
    resultEl.textContent = "已创建";
    resultEl.className = "status ok";
    await reloadAll();
    document.getElementById("leaf-title").value = "";
    document.getElementById("leaf-deliverable").value = "";
    document.getElementById("leaf-completion-date").value = "";
    document.getElementById("recurring-title").value = "";
    document.getElementById("recurring-deliverable").value = "";
    await onTypeChange();
  } catch (err) {
    resultEl.textContent = `失败：${err.message}`;
    resultEl.className = "status error";
  }
});

// ---------------- 顺序队列列表 ----------------

async function renderQueueList() {
  const container = document.getElementById("queue-list");
  container.innerHTML = "";
  for (const p of queueProjects) {
    const tasks = [...p.queue_project_tasks].sort((a, b) => a.execution_ordinal - b.execution_ordinal);
    const lockFlags = await Promise.all(tasks.map((t) => hasBeenPlanned("source_queue_task_id", t.id)));
    const block = document.createElement("div");
    block.className = "project-block";
    block.innerHTML = `
      <h3>[${p.level1_number}] ${p.title} <button type="button" class="secondary f-delete-project">删除项目</button></h3>
      <form class="inline-form proj-form">
        <label>分类 <input type="text" name="category" value="${p.category ?? ""}" style="width:10em" /></label>
        <label>状态
          <select name="status">
            ${["active", "paused", "completed"]
              .map((s) => `<option value="${s}" ${s === p.status ? "selected" : ""}>${s}</option>`)
              .join("")}
          </select>
        </label>
      </form>
      <div class="table-scroll">
      <table>
        <thead><tr><th>编号</th><th>标题</th><th>最终交付物</th><th>最终计划完成时间</th><th>实际完成</th><th>状态</th><th>指针</th><th>顺序</th><th></th></tr></thead>
        <tbody></tbody>
      </table>
      </div>
    `;
    block.querySelector(".f-delete-project").addEventListener("click", async () => {
      const ok = await confirmAndCascadeDelete({
        label: `项目"${p.title}"（含其下全部${p.queue_project_tasks.length}个任务）`,
        sourceColumn: "source_queue_task_id",
        sourceIds: p.queue_project_tasks.map((t) => t.id),
        deleteFn: () => deleteQueueProject(p.id),
      });
      if (ok) await reloadAll();
    });
    const projForm = block.querySelector(".proj-form");
    projForm.querySelectorAll("input, select").forEach((el) =>
      el.addEventListener("change", async () => {
        await updateQueueProject(p.id, { category: projForm.category.value || null, status: projForm.status.value });
        await reloadAll();
      })
    );
    const tbody = block.querySelector("tbody");
    tasks.forEach((t, idx) => {
      const locked = lockFlags[idx];
      const isCurrent = t.id === p.current_task_id;
      const rowKey = `queue_task:${t.id}`;
      const tr = document.createElement("tr");
      if (rowKey === highlightKey) tr.className = "row-highlight";
      tr.innerHTML = `
        <td>${wbsLabel(p.level1_number, t.wbs_level2_number, t.wbs_level3_number)}</td>
        <td><input type="text" class="f-title" value="${t.title}" style="width:14em" /></td>
        <td><input type="text" class="f-deliverable" value="${t.target_deliverable ?? ""}" style="width:12em" /></td>
        <td>${
          locked
            ? lockedDateHtml(t.planned_completion_date, t.completion_date_amendment_note)
            : `<input type="date" class="f-completion" value="${t.planned_completion_date ?? ""}" />`
        }</td>
        <td>${t.actual_completion_date ?? ""}</td>
        <td>${statusBadgeHtml(t.status)}${
          t.status !== "skipped" ? `<br /><button type="button" class="secondary f-terminate">标记中止</button>` : ""
        }</td>
        <td>${isCurrent ? "★ 当前" : `<button type="button" class="secondary f-set-current">设为当前</button>`}</td>
        <td>
          <button type="button" class="secondary f-up" ${idx === 0 ? "disabled" : ""}>↑</button>
          <button type="button" class="secondary f-down" ${idx === tasks.length - 1 ? "disabled" : ""}>↓</button>
        </td>
        <td><button type="button" class="secondary f-delete">删除</button></td>
      `;
      tr.querySelector(".f-title").addEventListener("change", async (e) => {
        await updateQueueProjectTask(t.id, { title: e.target.value });
      });
      tr.querySelector(".f-deliverable").addEventListener("change", async (e) => {
        await updateQueueProjectTask(t.id, { target_deliverable: e.target.value || null });
      });
      const completionInput = tr.querySelector(".f-completion");
      if (completionInput) {
        completionInput.addEventListener("change", async (e) => {
          await updateQueueProjectTask(t.id, { planned_completion_date: e.target.value || null });
          await reloadAll();
        });
      }
      const amendBtn = tr.querySelector(".f-amend");
      if (amendBtn) {
        amendBtn.addEventListener("click", async () => {
          const note = prompt("请填写订正说明（为什么要修改已锁定的最终计划完成时间，这条会被记录）：");
          if (!note) return;
          const newDate = prompt("新的最终计划完成时间(YYYY-MM-DD)：", t.planned_completion_date ?? "");
          if (!newDate) return;
          await updateQueueProjectTask(t.id, { planned_completion_date: newDate, completion_date_amendment_note: note });
          await reloadAll();
        });
      }
      const terminateBtn = tr.querySelector(".f-terminate");
      if (terminateBtn) {
        terminateBtn.addEventListener("click", async () => {
          if (!confirm(`确定把任务"${t.title}"标记为中止？不用等总结周期，直接生效。`)) return;
          await updateQueueProjectTask(t.id, { status: "skipped" });
          await reloadAll();
        });
      }
      tr.querySelector(".f-delete").addEventListener("click", async () => {
        const ok = await confirmAndCascadeDelete({
          label: `任务"${t.title}"`,
          sourceColumn: "source_queue_task_id",
          sourceIds: [t.id],
          deleteFn: () => deleteQueueProjectTask(t.id),
        });
        if (ok) await reloadAll();
      });
      const setCurrentBtn = tr.querySelector(".f-set-current");
      if (setCurrentBtn) {
        setCurrentBtn.addEventListener("click", async () => {
          await updateQueueProject(p.id, { current_task_id: t.id });
          await reloadAll();
        });
      }
      tr.querySelector(".f-up").addEventListener("click", async () => {
        const other = tasks[idx - 1];
        await Promise.all([
          updateQueueProjectTask(t.id, { execution_ordinal: other.execution_ordinal }),
          updateQueueProjectTask(other.id, { execution_ordinal: t.execution_ordinal }),
        ]);
        await reloadAll();
      });
      tr.querySelector(".f-down").addEventListener("click", async () => {
        const other = tasks[idx + 1];
        await Promise.all([
          updateQueueProjectTask(t.id, { execution_ordinal: other.execution_ordinal }),
          updateQueueProjectTask(other.id, { execution_ordinal: t.execution_ordinal }),
        ]);
        await reloadAll();
      });
      tbody.appendChild(tr);
    });
    container.appendChild(block);
  }
}

// ---------------- 截止日期列表 ----------------

function computeDelayAlert(p) {
  const today = new Date();
  const overdue = p.deadline_milestones.filter(
    (m) => m.status !== "done" && m.status !== "stopped" && new Date(m.planned_date) < today
  );
  if (overdue.length === 0) {
    return { delay_alert_active: false, delay_alert_note: null };
  }
  const remaining = p.deadline_milestones.filter((m) => m.status !== "done" && m.status !== "stopped").length;
  const weeksToDeadline = Math.max(0, Math.ceil((new Date(p.deadline_date) - today) / (7 * 24 * 3600 * 1000)));
  return {
    delay_alert_active: true,
    delay_alert_note: `已落后计划，剩余${remaining}项待完成，原计划剩余约${weeksToDeadline}周`,
  };
}

async function refreshDelayAlert(p) {
  const alert = computeDelayAlert(p);
  if (alert.delay_alert_active !== p.delay_alert_active || alert.delay_alert_note !== p.delay_alert_note) {
    await updateDeadlineProject(p.id, alert);
  }
}

async function renderDeadlineList() {
  const container = document.getElementById("deadline-list");
  container.innerHTML = "";
  for (const p of deadlineProjects) {
    await refreshDelayAlert(p);
    const milestones = [...p.deadline_milestones].sort((a, b) => new Date(a.planned_date) - new Date(b.planned_date));
    const lockFlags = await Promise.all(milestones.map((m) => hasBeenPlanned("source_milestone_id", m.id)));
    const block = document.createElement("div");
    block.className = "project-block";
    block.innerHTML = `
      <h3>[${p.level1_number}] ${p.title} <button type="button" class="secondary f-delete-project">删除项目</button></h3>
      ${p.delay_alert_active ? `<p class="status warn">⚠ ${p.delay_alert_note}</p>` : ""}
      <form class="inline-form proj-form">
        <label>截止日期 <input type="date" name="deadline_date" value="${p.deadline_date}" /></label>
        <label>状态
          <select name="status">
            ${["active", "completed"].map((s) => `<option value="${s}" ${s === p.status ? "selected" : ""}>${s}</option>`).join("")}
          </select>
        </label>
        <input type="text" name="target_deliverable" placeholder="项目最终交付物" value="${p.target_deliverable ?? ""}" />
      </form>
      <div class="table-scroll">
      <table>
        <thead><tr><th>编号</th><th>标题</th><th>最终交付物</th><th>最终计划完成时间</th><th>实际日期</th><th>状态</th><th></th></tr></thead>
        <tbody></tbody>
      </table>
      </div>
    `;
    block.querySelector(".f-delete-project").addEventListener("click", async () => {
      const ok = await confirmAndCascadeDelete({
        label: `项目"${p.title}"（含其下全部${p.deadline_milestones.length}个节点）`,
        sourceColumn: "source_milestone_id",
        sourceIds: p.deadline_milestones.map((m) => m.id),
        deleteFn: () => deleteDeadlineProject(p.id),
      });
      if (ok) await reloadAll();
    });
    const projForm = block.querySelector(".proj-form");
    projForm.querySelectorAll("input, select").forEach((el) =>
      el.addEventListener("change", async () => {
        await updateDeadlineProject(p.id, {
          deadline_date: projForm.deadline_date.value,
          status: projForm.status.value,
          target_deliverable: projForm.target_deliverable.value || null,
        });
        await reloadAll();
      })
    );
    const tbody = block.querySelector("tbody");
    milestones.forEach((m, idx) => {
      const locked = lockFlags[idx];
      const rowKey = `milestone:${m.id}`;
      const tr = document.createElement("tr");
      if (rowKey === highlightKey) tr.className = "row-highlight";
      tr.innerHTML = `
        <td>${wbsLabel(p.level1_number, m.wbs_level2_number, m.wbs_level3_number)}</td>
        <td><input type="text" class="f-title" value="${m.title}" style="width:14em" /></td>
        <td><input type="text" class="f-deliverable" value="${m.target_deliverable ?? ""}" style="width:12em" /></td>
        <td>${
          locked
            ? lockedDateHtml(m.planned_date, m.planned_date_amendment_note)
            : `<input type="date" class="f-completion" value="${m.planned_date}" />`
        }</td>
        <td><input type="date" class="f-actual" value="${m.actual_date ?? ""}" /></td>
        <td>${statusBadgeHtml(m.status)}${
          m.status !== "stopped" ? `<br /><button type="button" class="secondary f-terminate">标记中止</button>` : ""
        }</td>
        <td><button type="button" class="secondary f-delete">删除</button></td>
      `;
      tr.querySelector(".f-title").addEventListener("change", async (e) => {
        await updateMilestone(m.id, { title: e.target.value });
      });
      tr.querySelector(".f-deliverable").addEventListener("change", async (e) => {
        await updateMilestone(m.id, { target_deliverable: e.target.value || null });
      });
      const completionInput = tr.querySelector(".f-completion");
      if (completionInput) {
        completionInput.addEventListener("change", async (e) => {
          await updateMilestone(m.id, { planned_date: e.target.value });
          await reloadAll();
        });
      }
      const amendBtn = tr.querySelector(".f-amend");
      if (amendBtn) {
        amendBtn.addEventListener("click", async () => {
          const note = prompt("请填写订正说明（为什么要修改已锁定的最终计划完成时间，这条会被记录）：");
          if (!note) return;
          const newDate = prompt("新的最终计划完成时间(YYYY-MM-DD)：", m.planned_date ?? "");
          if (!newDate) return;
          await updateMilestone(m.id, { planned_date: newDate, planned_date_amendment_note: note });
          await reloadAll();
        });
      }
      tr.querySelector(".f-actual").addEventListener("change", async (e) => {
        await updateMilestone(m.id, { actual_date: e.target.value || null });
        await reloadAll();
      });
      const terminateBtn = tr.querySelector(".f-terminate");
      if (terminateBtn) {
        terminateBtn.addEventListener("click", async () => {
          if (!confirm(`确定把节点"${m.title}"标记为中止？不用等总结周期，直接生效。`)) return;
          await updateMilestone(m.id, { status: "stopped" });
          await reloadAll();
        });
      }
      tr.querySelector(".f-delete").addEventListener("click", async () => {
        const ok = await confirmAndCascadeDelete({
          label: `节点"${m.title}"`,
          sourceColumn: "source_milestone_id",
          sourceIds: [m.id],
          deleteFn: () => deleteMilestone(m.id),
        });
        if (ok) await reloadAll();
      });
      tbody.appendChild(tr);
    });
    container.appendChild(block);
  }
}

// ---------------- 循环任务列表 ----------------

function computeNextNumber(template, instances, targetWeek) {
  if (instances.length === 0) {
    return { level2: 1, level3: template.frequency === "monthly" ? null : 1 };
  }
  const sorted = [...instances].sort((a, b) => {
    const wa = allWeeks.find((w) => w.id === a.meeting_week_id);
    const wb = allWeeks.find((w) => w.id === b.meeting_week_id);
    return new Date(wa.natural_week_start) - new Date(wb.natural_week_start);
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

// 候选周不能从全年第一周找起——要从模板自己的起始例会周(start_meeting_week_id)开始找，
// 不然点"生成下一个实例"永远从年初开始，跟模板实际的开始时间对不上
// (2026-07-10发现的真实bug，之前nextUnusedWeek完全没看start_meeting_week_id)
function nextUnusedWeek(instances, template) {
  const usedWeekIds = new Set(instances.map((i) => i.meeting_week_id));
  const startWeek = allWeeksRaw.find((w) => w.id === template.start_meeting_week_id);
  const startDate = startWeek ? new Date(startWeek.natural_week_start) : null;
  const sorted = [...allWeeks]
    .filter((w) => !startDate || new Date(w.natural_week_start) >= startDate)
    .sort((a, b) => new Date(a.natural_week_start) - new Date(b.natural_week_start));
  return sorted.find((w) => !usedWeekIds.has(w.id));
}

async function renderRecurringList() {
  const container = document.getElementById("recurring-list");
  container.innerHTML = "";
  for (const t of recurringTemplates) {
    const block = document.createElement("div");
    block.className = "project-block";
    const isOpen = openInstanceTemplateIds.has(t.id);
    block.innerHTML = `
      <h3>[${t.level1_number}] ${t.title} <button type="button" class="secondary f-delete-template">删除任务</button></h3>
      <form class="inline-form proj-form">
        <input type="text" name="title" value="${t.title}" style="min-width:200px" />
        <select name="module_id">${moduleOptionsHtml(t.module_id)}</select>
        <input type="text" name="owner" value="${t.owner ?? ""}" placeholder="责任人" />
        <select name="frequency">
          ${["weekly", "monthly", "custom"].map((f) => `<option value="${f}" ${f === t.frequency ? "selected" : ""}>${f}</option>`).join("")}
        </select>
        <label>起始例会周 <select name="start_meeting_week_id">${weekOptionsHtml(t.start_meeting_week_id)}</select></label>
        <input type="text" name="deliverable_template" value="${t.deliverable_template ?? ""}" placeholder="最终目标交付物" style="min-width:180px" />
        <select name="status">
          ${["active", "completed", "paused"].map((s) => `<option value="${s}" ${s === t.status ? "selected" : ""}>${s}</option>`).join("")}
        </select>
      </form>
      <button type="button" class="secondary f-toggle">${isOpen ? "收起实例" : "展开实例"}</button>
      <button type="button" class="f-generate">生成下一个实例</button>
      <p class="f-generate-result status"></p>
      <div class="instances-wrap" ${isOpen ? "" : "hidden"}></div>
    `;
    block.querySelector(".f-delete-template").addEventListener("click", async () => {
      const full = await getRecurringTemplate(t.id);
      const ok = await confirmAndCascadeDelete({
        label: `循环任务"${t.title}"（含其下全部${full.recurring_task_instances.length}个实例）`,
        sourceColumn: "source_recurring_instance_id",
        sourceIds: full.recurring_task_instances.map((i) => i.id),
        deleteFn: () => deleteRecurringTemplate(t.id),
      });
      if (ok) await reloadAll();
    });
    const projForm = block.querySelector(".proj-form");
    projForm.querySelectorAll("input, select").forEach((el) =>
      el.addEventListener("change", async () => {
        await updateRecurringTemplate(t.id, {
          title: projForm.title.value,
          module_id: projForm.module_id.value || null,
          owner: projForm.owner.value.trim() || null,
          frequency: projForm.frequency.value,
          start_meeting_week_id: Number(projForm.start_meeting_week_id.value),
          deliverable_template: projForm.deliverable_template.value.trim() || null,
          status: projForm.status.value,
        });
        await reloadAll();
      })
    );
    block.querySelector(".f-toggle").addEventListener("click", () => {
      if (openInstanceTemplateIds.has(t.id)) openInstanceTemplateIds.delete(t.id);
      else openInstanceTemplateIds.add(t.id);
      renderRecurringList();
    });
    block.querySelector(".f-generate").addEventListener("click", async () => {
      const resultEl = block.querySelector(".f-generate-result");
      const full = await getRecurringTemplate(t.id);
      const targetWeek = nextUnusedWeek(full.recurring_task_instances, t);
      if (!targetWeek) {
        resultEl.textContent = "没有更多可用的例会周了，请先在例会日历里预生成更多周";
        resultEl.className = "status error";
        return;
      }
      try {
        const { level2, level3 } = computeNextNumber(full, full.recurring_task_instances, targetWeek);
        const fullNumber = level3 != null ? `${t.level1_number}.${level2}.${level3}` : `${t.level1_number}.${level2}`;
        await addRecurringInstance(t.id, {
          meeting_week_id: targetWeek.id,
          level2_number: level2,
          level3_number: level3,
          full_number: fullNumber,
          due_date: targetWeek.meeting_date,
        });
        resultEl.textContent = `已生成实例 ${fullNumber}（例会周 ${targetWeek.natural_week_start}）`;
        resultEl.className = "status ok";
        openInstanceTemplateIds.add(t.id);
        await reloadAll();
      } catch (err) {
        resultEl.textContent = `失败：${err.message}`;
        resultEl.className = "status error";
      }
    });
    if (isOpen) {
      const full = await getRecurringTemplate(t.id);
      const wrap = block.querySelector(".instances-wrap");
      const sorted = [...full.recurring_task_instances].sort((a, b) => {
        const wa = allWeeks.find((w) => w.id === a.meeting_week_id);
        const wb = allWeeks.find((w) => w.id === b.meeting_week_id);
        return new Date((wa ?? {}).natural_week_start || 0) - new Date((wb ?? {}).natural_week_start || 0);
      });
      wrap.innerHTML = `
        <div class="table-scroll">
        <table>
          <thead><tr><th>编号</th><th>标题</th><th>最终交付物</th><th>对应例会周</th><th>应完成日期</th><th>实际完成</th><th>状态</th><th></th></tr></thead>
          <tbody></tbody>
        </table>
        </div>
      `;
      const tbody = wrap.querySelector("tbody");
      for (const inst of sorted) {
        const week = allWeeks.find((w) => w.id === inst.meeting_week_id);
        const rowKey = `recurring_instance:${inst.id}`;
        const tr = document.createElement("tr");
        if (rowKey === highlightKey) tr.className = "row-highlight";
        tr.innerHTML = `
          <td>${inst.full_number}</td>
          <td class="task-col readonly-col">${t.title}</td>
          <td class="task-col readonly-col">${t.deliverable_template ?? ""}</td>
          <td>${week ? week.natural_week_start : inst.meeting_week_id}</td>
          <td>${inst.due_date}</td>
          <td><input type="date" class="f-actual" value="${inst.actual_completion_date ?? ""}" /></td>
          <td>${statusBadgeHtml(inst.status)}${
            inst.status !== "stopped" ? `<br /><button type="button" class="secondary f-terminate">标记中止</button>` : ""
          }</td>
          <td><button type="button" class="secondary f-delete">删除</button></td>
        `;
        tr.querySelector(".f-actual").addEventListener("change", async (e) => {
          await updateRecurringInstance(inst.id, { actual_completion_date: e.target.value || null });
          await reloadAll();
        });
        const terminateBtn = tr.querySelector(".f-terminate");
        if (terminateBtn) {
          terminateBtn.addEventListener("click", async () => {
            if (!confirm(`确定把实例"${inst.full_number}"标记为中止？不用等总结周期，直接生效。`)) return;
            await updateRecurringInstance(inst.id, { status: "stopped" });
            await reloadAll();
          });
        }
        tr.querySelector(".f-delete").addEventListener("click", async () => {
          const ok = await confirmAndCascadeDelete({
            label: `实例"${inst.full_number}"`,
            sourceColumn: "source_recurring_instance_id",
            sourceIds: [inst.id],
            deleteFn: () => deleteRecurringInstance(inst.id),
          });
          if (ok) await reloadAll();
        });
        tbody.appendChild(tr);
      }
    }
    container.appendChild(block);
  }
}

// ---------------- 加载 ----------------

async function reloadAll() {
  [queueProjects, deadlineProjects, recurringTemplates] = await Promise.all([
    listQueueProjects(),
    listDeadlineProjects(),
    listRecurringTemplates(),
  ]);
  await renderQueueList();
  await renderDeadlineList();
  await renderRecurringList();
  if (typeSelectValue() !== "recurring") renderProjectOptions();
  if (highlightKey) {
    const el = document.querySelector(".row-highlight");
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

async function init() {
  const [modules, weeks] = await Promise.all([listModules(), listMeetingWeeks()]);
  allModules = modules;
  allWeeksRaw = weeks;
  allWeeks = weeks.filter((w) => w.is_normal !== false);

  const moduleSelect = document.getElementById("recurring-module");
  for (const m of allModules) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.name;
    moduleSelect.appendChild(opt);
  }
  const weekSelect = document.getElementById("recurring-start-week");
  for (const w of allWeeksRaw) {
    const opt = document.createElement("option");
    opt.value = w.id;
    opt.textContent = `${w.natural_week_start}（例会${w.meeting_date}）`;
    weekSelect.appendChild(opt);
  }

  await reloadAll();
  await onTypeChange();
}

await init();
