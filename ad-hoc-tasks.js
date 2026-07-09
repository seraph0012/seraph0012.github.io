import { requireAuth } from "./shared/authGuard.js";
import { renderNav } from "./shared/nav.js";
import {
  listAdHocTasks,
  createAdHocTask,
  updateAdHocTask,
  listMeetingWeeks,
  claimTaskNumber,
  setTaskNumberOwner,
  createQueueProject,
  createDeadlineProject,
  createRecurringTemplate,
} from "./shared/db.js";

const session = await requireAuth();
if (!session) {
  throw new Error("not authenticated");
}
renderNav();

let allMeetingWeeks = [];

function promotionLabel(t) {
  if (!t.promoted_to_type) return "";
  const idMap = {
    queue: t.promoted_to_queue_project_id,
    deadline: t.promoted_to_deadline_project_id,
    recurring: t.promoted_to_recurring_template_id,
  };
  return `已转正为类型${t.promoted_to_type === "queue" ? "A" : t.promoted_to_type === "deadline" ? "B" : "C"}（id=${idMap[t.promoted_to_type]}）`;
}

function renderPromoteForm(task) {
  const wrap = document.createElement("div");
  wrap.innerHTML = `
    <form class="inline-form promote-form">
      <select name="type">
        <option value="queue">转为类型A（顺序队列）</option>
        <option value="deadline">转为类型B（截止日期）</option>
        <option value="recurring">转为类型C（循环任务）</option>
      </select>
      <span class="extra-fields"></span>
      <button type="submit">确认转正</button>
      <button type="button" class="secondary cancel-btn">取消</button>
    </form>
  `;
  const form = wrap.querySelector("form");
  const extra = wrap.querySelector(".extra-fields");

  function renderExtra() {
    const type = form.type.value;
    if (type === "deadline") {
      extra.innerHTML = `<label>截止日期 <input type="date" name="deadline_date" required /></label>`;
    } else if (type === "recurring") {
      extra.innerHTML = `
        <select name="frequency">
          <option value="weekly">weekly</option>
          <option value="monthly">monthly</option>
        </select>
        <select name="start_meeting_week_id" required></select>
      `;
      const weekSelect = extra.querySelector('select[name="start_meeting_week_id"]');
      for (const w of allMeetingWeeks) {
        const opt = document.createElement("option");
        opt.value = w.id;
        opt.textContent = `${w.natural_week_start}（例会${w.meeting_date}）`;
        weekSelect.appendChild(opt);
      }
    } else {
      extra.innerHTML = "";
    }
  }
  form.type.addEventListener("change", renderExtra);
  renderExtra();

  wrap.querySelector(".cancel-btn").addEventListener("click", () => wrap.remove());

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const type = fd.get("type");
    try {
      const numberRow = await claimTaskNumber({
        task_type: type,
        title_snapshot: task.title,
        owning_table:
          type === "queue" ? "queue_projects" : type === "deadline" ? "deadline_projects" : "recurring_task_templates",
        owning_id: 0,
      });

      let newId;
      if (type === "queue") {
        const p = await createQueueProject({ title: task.title, level1_number: numberRow.level1_number });
        newId = p.id;
        await setTaskNumberOwner(numberRow.level1_number, p.id);
        await updateAdHocTask(task.id, {
          promoted_to_type: "queue",
          promoted_to_queue_project_id: newId,
          status: "closed",
        });
      } else if (type === "deadline") {
        const p = await createDeadlineProject({
          title: task.title,
          deadline_date: fd.get("deadline_date"),
          level1_number: numberRow.level1_number,
        });
        newId = p.id;
        await setTaskNumberOwner(numberRow.level1_number, p.id);
        await updateAdHocTask(task.id, {
          promoted_to_type: "deadline",
          promoted_to_deadline_project_id: newId,
          status: "closed",
        });
      } else {
        const startWeekId = Number(fd.get("start_meeting_week_id"));
        const startWeek = allMeetingWeeks.find((w) => w.id === startWeekId);
        const p = await createRecurringTemplate({
          title: task.title,
          frequency: fd.get("frequency"),
          start_date: startWeek.natural_week_start,
          start_meeting_week_id: startWeekId,
          level1_number: numberRow.level1_number,
        });
        newId = p.id;
        await setTaskNumberOwner(numberRow.level1_number, newId);
        await updateAdHocTask(task.id, {
          promoted_to_type: "recurring",
          promoted_to_recurring_template_id: newId,
          status: "closed",
        });
      }

      await loadTable();
    } catch (err) {
      alert(`转正失败：${err.message}`);
    }
  });

  return wrap;
}

async function loadTable() {
  const tasks = await listAdHocTasks();
  const tbody = document.getElementById("tasks-tbody");
  tbody.innerHTML = "";
  for (const t of tasks) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${t.title}</td>
      <td>${t.actual_start}</td>
      <td><input type="date" class="f-end" value="${t.actual_end ?? ""}" /></td>
      <td>${t.status}</td>
      <td>${promotionLabel(t)}</td>
      <td>${t.promoted_to_type ? "" : `<button type="button" class="secondary f-promote">转正</button>`}</td>
    `;
    tr.querySelector(".f-end").addEventListener("change", async (e) => {
      await updateAdHocTask(t.id, { actual_end: e.target.value || null });
    });
    if (!t.promoted_to_type) {
      tr.querySelector(".f-promote").addEventListener("click", () => {
        const existing = tbody.querySelector(".promote-row");
        if (existing) existing.remove();
        const promoteTr = document.createElement("tr");
        promoteTr.className = "promote-row";
        const td = document.createElement("td");
        td.colSpan = 6;
        td.appendChild(renderPromoteForm(t));
        promoteTr.appendChild(td);
        tr.after(promoteTr);
      });
    }
    tbody.appendChild(tr);
  }
}

document.getElementById("create-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const resultEl = document.getElementById("create-result");
  const form = new FormData(e.target);
  try {
    await createAdHocTask({
      title: form.get("title"),
      actual_start: form.get("actual_start"),
      description: form.get("description") || null,
    });
    e.target.reset();
    resultEl.textContent = "";
    await loadTable();
  } catch (err) {
    resultEl.textContent = `失败：${err.message}`;
    resultEl.className = "status error";
  }
});

allMeetingWeeks = await listMeetingWeeks();
await loadTable();
