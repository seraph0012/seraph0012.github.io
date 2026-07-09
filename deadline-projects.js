import { requireAuth } from "./shared/authGuard.js";
import { renderNav } from "./shared/nav.js";
import {
  listDeadlineProjects,
  createDeadlineProject,
  claimTaskNumber,
  setTaskNumberOwner,
} from "./shared/db.js";

const session = await requireAuth();
if (!session) {
  throw new Error("not authenticated");
}
renderNav();

async function loadTable() {
  const projects = await listDeadlineProjects();
  const tbody = document.getElementById("projects-tbody");
  tbody.innerHTML = "";
  for (const p of projects) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${p.level1_number}</td>
      <td>${p.title}</td>
      <td>${p.deadline_date}</td>
      <td>${p.status}</td>
      <td>${p.delay_alert_active ? `<span class="badge risk-yellow">${p.delay_alert_note ?? "已落后"}</span>` : ""}</td>
      <td><a href="deadline-project-detail.html?id=${p.id}">详情</a></td>
    `;
    tbody.appendChild(tr);
  }
}

document.getElementById("create-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const resultEl = document.getElementById("create-result");
  const form = new FormData(e.target);
  const title = form.get("title");
  resultEl.textContent = "创建中...";
  resultEl.className = "status";
  try {
    const numberRow = await claimTaskNumber({
      task_type: "deadline",
      title_snapshot: title,
      owning_table: "deadline_projects",
      owning_id: 0,
    });
    const project = await createDeadlineProject({
      title,
      deadline_date: form.get("deadline_date"),
      target_deliverable: form.get("target_deliverable") || null,
      level1_number: numberRow.level1_number,
    });
    await setTaskNumberOwner(numberRow.level1_number, project.id);
    e.target.reset();
    resultEl.textContent = "";
    await loadTable();
  } catch (err) {
    resultEl.textContent = `失败：${err.message}`;
    resultEl.className = "status error";
  }
});

loadTable();
