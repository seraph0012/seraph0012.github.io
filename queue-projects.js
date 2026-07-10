import { requireAuth } from "./shared/authGuard.js";
import { renderNav } from "./shared/nav.js";
import {
  listQueueProjects,
  createQueueProject,
  deleteQueueProject,
  claimTaskNumber,
  setTaskNumberOwner,
  suggestNextTaskNumber,
} from "./shared/db.js";

const session = await requireAuth();
if (!session) {
  throw new Error("not authenticated");
}
renderNav();

async function loadTable() {
  const projects = await listQueueProjects();
  const tbody = document.getElementById("projects-tbody");
  tbody.innerHTML = "";
  for (const p of projects) {
    const current = p.queue_project_tasks.find((t) => t.id === p.current_task_id);
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${p.level1_number}</td>
      <td>${p.title}</td>
      <td>${p.category ?? ""}</td>
      <td>${p.status}</td>
      <td>${current ? current.title : "（未设置指针）"}</td>
      <td><a href="queue-project-detail.html?id=${p.id}">详情</a></td>
      <td><button type="button" class="secondary f-delete">删除</button></td>
    `;
    tr.querySelector(".f-delete").addEventListener("click", async () => {
      if (!confirm(`确定删除项目"${p.title}"？子任务会一并删除，此操作不可撤销。`)) return;
      try {
        await deleteQueueProject(p.id);
        await loadTable();
      } catch (err) {
        alert(`删除失败：${err.message}`);
      }
    });
    tbody.appendChild(tr);
  }
}

document.getElementById("create-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const resultEl = document.getElementById("create-result");
  const form = new FormData(e.target);
  const title = form.get("title");
  const category = form.get("category") || null;
  const level1Number = Number(form.get("level1_number"));
  resultEl.textContent = "创建中...";
  resultEl.className = "status";
  try {
    const numberRow = await claimTaskNumber({
      task_type: "queue",
      title_snapshot: title,
      owning_table: "queue_projects",
      owning_id: 0,
      level1_number: level1Number,
    });
    const project = await createQueueProject({
      title,
      category,
      level1_number: numberRow.level1_number,
    });
    await setTaskNumberOwner(numberRow.level1_number, project.id);
    e.target.reset();
    resultEl.textContent = "";
    await prefillNextNumber();
    await loadTable();
  } catch (err) {
    resultEl.textContent = `失败：${err.message}`;
    resultEl.className = "status error";
  }
});

async function prefillNextNumber() {
  document.querySelector('#create-form input[name="level1_number"]').value = await suggestNextTaskNumber();
}

await prefillNextNumber();
loadTable();
