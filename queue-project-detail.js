import { requireAuth } from "./shared/authGuard.js";
import { renderNav } from "./shared/nav.js";
import {
  getQueueProject,
  updateQueueProject,
  addQueueProjectTask,
  updateQueueProjectTask,
} from "./shared/db.js";

const session = await requireAuth();
if (!session) {
  throw new Error("not authenticated");
}
renderNav();

const projectId = Number(new URLSearchParams(window.location.search).get("id"));
if (!projectId) {
  document.body.textContent = "缺少 ?id= 参数";
  throw new Error("missing id");
}

let project = null;

function wbsLabel(t) {
  return t.wbs_level3_number != null
    ? `${project.level1_number}.${t.wbs_level2_number}.${t.wbs_level3_number}`
    : `${project.level1_number}.${t.wbs_level2_number}`;
}

async function load() {
  project = await getQueueProject(projectId);
  document.getElementById("project-title").textContent = `[${project.level1_number}] ${project.title}`;
  const form = document.getElementById("project-form");
  form.category.value = project.category ?? "";
  form.status.value = project.status;
  renderTasks();
}

function renderTasks() {
  const tasks = [...project.queue_project_tasks].sort((a, b) => a.execution_ordinal - b.execution_ordinal);
  const tbody = document.getElementById("tasks-tbody");
  tbody.innerHTML = "";
  tasks.forEach((t, idx) => {
    const tr = document.createElement("tr");
    const isCurrent = t.id === project.current_task_id;
    tr.innerHTML = `
      <td>${wbsLabel(t)}</td>
      <td>${t.title}</td>
      <td>${t.target_deliverable ?? ""}</td>
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

    tr.querySelector(".f-status").addEventListener("change", async (e) => {
      await updateQueueProjectTask(t.id, { status: e.target.value });
      await load();
    });

    if (!isCurrent) {
      tr.querySelector(".f-set-current").addEventListener("click", async () => {
        await updateQueueProject(projectId, { current_task_id: t.id });
        await load();
      });
    }

    tr.querySelector(".f-up").addEventListener("click", async () => {
      const other = tasks[idx - 1];
      await Promise.all([
        updateQueueProjectTask(t.id, { execution_ordinal: other.execution_ordinal }),
        updateQueueProjectTask(other.id, { execution_ordinal: t.execution_ordinal }),
      ]);
      await load();
    });
    tr.querySelector(".f-down").addEventListener("click", async () => {
      const other = tasks[idx + 1];
      await Promise.all([
        updateQueueProjectTask(t.id, { execution_ordinal: other.execution_ordinal }),
        updateQueueProjectTask(other.id, { execution_ordinal: t.execution_ordinal }),
      ]);
      await load();
    });

    tbody.appendChild(tr);
  });
}

document.getElementById("project-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const resultEl = document.getElementById("project-save-result");
  const form = new FormData(e.target);
  try {
    await updateQueueProject(projectId, {
      category: form.get("category") || null,
      status: form.get("status"),
    });
    resultEl.textContent = "已保存";
    resultEl.className = "status ok";
    await load();
  } catch (err) {
    resultEl.textContent = `失败：${err.message}`;
    resultEl.className = "status error";
  }
});

document.getElementById("task-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const resultEl = document.getElementById("task-create-result");
  const form = new FormData(e.target);
  const maxOrdinal = project.queue_project_tasks.reduce((m, t) => Math.max(m, t.execution_ordinal), 0);
  try {
    await addQueueProjectTask(projectId, {
      wbs_level2_number: Number(form.get("wbs_level2_number")),
      wbs_level3_number: form.get("wbs_level3_number") ? Number(form.get("wbs_level3_number")) : null,
      title: form.get("title"),
      target_deliverable: form.get("target_deliverable") || null,
      execution_ordinal: maxOrdinal + 1,
    });
    e.target.reset();
    resultEl.textContent = "";
    await load();
  } catch (err) {
    resultEl.textContent = `失败：${err.message}`;
    resultEl.className = "status error";
  }
});

load();
