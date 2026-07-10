import { requireAuth } from "./shared/authGuard.js";
import { renderNav } from "./shared/nav.js";
import {
  listModules,
  listMeetingWeeks,
  listQueueProjects,
  createQueueProject,
  updateQueueProject,
  addQueueProjectTask,
  updateQueueProjectTask,
  listDeadlineProjects,
  createDeadlineProject,
  updateDeadlineProject,
  addMilestone,
  updateMilestone,
  listRecurringTemplates,
  getRecurringTemplate,
  createRecurringTemplate,
  addRecurringInstance,
  updateRecurringInstance,
  claimTaskNumber,
  setTaskNumberOwner,
  suggestNextTaskNumber,
  hasBeenPlanned,
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

function lockedDateHtml(date, note) {
  return `<span class="locked-date">🔒 ${date ?? ""}</span>${
    note ? `<br /><span class="badge">订正：${note}</span>` : ""
  } <button type="button" class="secondary f-amend">订正</button>`;
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
      <h3>[${p.level1_number}] ${p.title}</h3>
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
        <thead><tr><th>编号</th><th>标题</th><th>最终交付物</th><th>最终计划完成时间</th><th>实际完成</th><th>状态</th><th>指针</th><th>顺序</th></tr></thead>
        <tbody></tbody>
      </table>
      </div>
    `;
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
        <td>
          <select class="f-status">
            ${["pending", "in_progress", "done", "skipped"]
              .map((s) => `<option value="${s}" ${s === t.status ? "selected" : ""}>${s}</option>`)
              .join("")}
          </select>
        </td>
        <td>${isCurrent ? "★ 当前" : `<button type="button" class="secondary f-set-current">设为当前</button>`}</td>
        <td>
          <button type="button" class="secondary f-up" ${idx === 0 ? "disabled" : ""}>↑</button>
          <button type="button" class="secondary f-down" ${idx === tasks.length - 1 ? "disabled" : ""}>↓</button>
        </td>
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
      tr.querySelector(".f-status").addEventListener("change", async (e) => {
        await updateQueueProjectTask(t.id, { status: e.target.value });
        await reloadAll();
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
      <h3>[${p.level1_number}] ${p.title}</h3>
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
        <thead><tr><th>编号</th><th>标题</th><th>最终交付物</th><th>最终计划完成时间</th><th>实际日期</th><th>状态</th></tr></thead>
        <tbody></tbody>
      </table>
      </div>
    `;
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
        <td>
          <select class="f-status">
            ${["pending", "in_progress", "done", "stopped", "not_started"]
              .map((s) => `<option value="${s}" ${s === m.status ? "selected" : ""}>${s}</option>`)
              .join("")}
          </select>
        </td>
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
      tr.querySelector(".f-status").addEventListener("change", async (e) => {
        await updateMilestone(m.id, { status: e.target.value });
        await reloadAll();
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

function nextUnusedWeek(instances) {
  const usedWeekIds = new Set(instances.map((i) => i.meeting_week_id));
  const sorted = [...allWeeks].sort((a, b) => new Date(a.natural_week_start) - new Date(b.natural_week_start));
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
      <h3>[${t.level1_number}] ${t.title}（${t.frequency}，${t.status}）</h3>
      <p>最终目标交付物：${t.deliverable_template ?? ""}</p>
      <button type="button" class="secondary f-toggle">${isOpen ? "收起实例" : "展开实例"}</button>
      <button type="button" class="f-generate">生成下一个实例</button>
      <p class="f-generate-result status"></p>
      <div class="instances-wrap" ${isOpen ? "" : "hidden"}></div>
    `;
    block.querySelector(".f-toggle").addEventListener("click", () => {
      if (openInstanceTemplateIds.has(t.id)) openInstanceTemplateIds.delete(t.id);
      else openInstanceTemplateIds.add(t.id);
      renderRecurringList();
    });
    block.querySelector(".f-generate").addEventListener("click", async () => {
      const resultEl = block.querySelector(".f-generate-result");
      const full = await getRecurringTemplate(t.id);
      const targetWeek = nextUnusedWeek(full.recurring_task_instances);
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
          <thead><tr><th>编号</th><th>对应例会周</th><th>应完成日期</th><th>实际完成</th><th>状态</th><th>用时(计划/实际)</th></tr></thead>
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
          <td>${week ? week.natural_week_start : inst.meeting_week_id}</td>
          <td>${inst.due_date}</td>
          <td><input type="date" class="f-actual" value="${inst.actual_completion_date ?? ""}" /></td>
          <td>
            <select class="f-status">
              ${["not_started", "pending", "in_progress", "done", "stopped"]
                .map((s) => `<option value="${s}" ${s === inst.status ? "selected" : ""}>${s}</option>`)
                .join("")}
            </select>
          </td>
          <td>
            <input type="number" class="f-planned-hours" value="${inst.planned_hours ?? ""}" style="width:4em" step="0.5" /> /
            <input type="number" class="f-actual-hours" value="${inst.actual_hours ?? ""}" style="width:4em" step="0.5" />
          </td>
        `;
        const save = async () => {
          await updateRecurringInstance(inst.id, {
            actual_completion_date: tr.querySelector(".f-actual").value || null,
            status: tr.querySelector(".f-status").value,
            planned_hours: tr.querySelector(".f-planned-hours").value || null,
            actual_hours: tr.querySelector(".f-actual-hours").value || null,
          });
        };
        tr.querySelectorAll("input, select").forEach((el) => el.addEventListener("change", save));
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
