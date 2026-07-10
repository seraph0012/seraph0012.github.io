import { requireAuth } from "./shared/authGuard.js";
import { renderNav } from "./shared/nav.js";
import {
  getDeadlineProject,
  updateDeadlineProject,
  addMilestone,
  updateMilestone,
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

function wbsLabel(m) {
  return m.wbs_level3_number != null
    ? `${project.level1_number}.${m.wbs_level2_number}.${m.wbs_level3_number}`
    : `${project.level1_number}.${m.wbs_level2_number}`;
}

// 按周粒度检测delay：有未完成节点且计划日期已过 → 生成预警提示，不自动改动planned_date
function computeDelayAlert(p) {
  const today = new Date();
  const overdue = p.deadline_milestones.filter(
    (m) => m.status !== "done" && m.status !== "stopped" && new Date(m.planned_date) < today
  );
  if (overdue.length === 0) {
    return { delay_alert_active: false, delay_alert_note: null };
  }
  const remaining = p.deadline_milestones.filter((m) => m.status !== "done" && m.status !== "stopped").length;
  const weeksToDeadline = Math.max(
    0,
    Math.ceil((new Date(p.deadline_date) - today) / (7 * 24 * 3600 * 1000))
  );
  return {
    delay_alert_active: true,
    delay_alert_note: `已落后计划，剩余${remaining}项待完成，原计划剩余约${weeksToDeadline}周`,
  };
}

async function load() {
  project = await getDeadlineProject(projectId);
  document.getElementById("project-title").textContent = `[${project.level1_number}] ${project.title}`;
  const form = document.getElementById("project-form");
  form.deadline_date.value = project.deadline_date;
  form.status.value = project.status;
  form.target_deliverable.value = project.target_deliverable ?? "";

  const banner = document.getElementById("delay-banner");
  if (project.delay_alert_active) {
    banner.className = "status warn";
    banner.textContent = `⚠ ${project.delay_alert_note}`;
  } else {
    banner.className = "";
    banner.textContent = "";
  }

  renderMilestones();
  prefillNextWbsNumber();
}

// 新增节点表单预填"当前最大二级编号+1"，跟一级编号同样的默认预填+可手动改逻辑
function prefillNextWbsNumber() {
  const maxLevel2 = project.deadline_milestones.reduce((m, x) => Math.max(m, x.wbs_level2_number), 0);
  document.querySelector('#milestone-form input[name="wbs_level2_number"]').value = maxLevel2 + 1;
}

async function refreshDelayAlert() {
  const alert = computeDelayAlert(project);
  if (
    alert.delay_alert_active !== project.delay_alert_active ||
    alert.delay_alert_note !== project.delay_alert_note
  ) {
    await updateDeadlineProject(projectId, alert);
  }
}

function renderMilestones() {
  const milestones = [...project.deadline_milestones].sort(
    (a, b) => new Date(a.planned_date) - new Date(b.planned_date)
  );
  const tbody = document.getElementById("milestones-tbody");
  tbody.innerHTML = "";
  for (const m of milestones) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${wbsLabel(m)}</td>
      <td>${m.title}</td>
      <td>${m.planned_date}</td>
      <td><input type="date" class="f-actual" value="${m.actual_date ?? ""}" /></td>
      <td>
        <select class="f-status">
          ${["pending", "in_progress", "done", "stopped", "not_started"]
            .map((s) => `<option value="${s}" ${s === m.status ? "selected" : ""}>${s}</option>`)
            .join("")}
        </select>
      </td>
    `;
    const save = async () => {
      await updateMilestone(m.id, {
        actual_date: tr.querySelector(".f-actual").value || null,
        status: tr.querySelector(".f-status").value,
      });
      project = await getDeadlineProject(projectId);
      await refreshDelayAlert();
      await load();
    };
    tr.querySelector(".f-actual").addEventListener("change", save);
    tr.querySelector(".f-status").addEventListener("change", save);
    tbody.appendChild(tr);
  }
}

document.getElementById("project-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const resultEl = document.getElementById("project-save-result");
  const form = new FormData(e.target);
  try {
    await updateDeadlineProject(projectId, {
      deadline_date: form.get("deadline_date"),
      status: form.get("status"),
      target_deliverable: form.get("target_deliverable") || null,
    });
    resultEl.textContent = "已保存";
    resultEl.className = "status ok";
    await load();
  } catch (err) {
    resultEl.textContent = `失败：${err.message}`;
    resultEl.className = "status error";
  }
});

document.getElementById("milestone-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const resultEl = document.getElementById("milestone-create-result");
  const form = new FormData(e.target);
  const maxOrdinal = project.deadline_milestones.reduce((m, x) => Math.max(m, x.ordinal), 0);
  try {
    await addMilestone(projectId, {
      wbs_level2_number: Number(form.get("wbs_level2_number")),
      wbs_level3_number: form.get("wbs_level3_number") ? Number(form.get("wbs_level3_number")) : null,
      title: form.get("title"),
      planned_date: form.get("planned_date"),
      ordinal: maxOrdinal + 1,
    });
    e.target.reset();
    resultEl.textContent = "";
    await load();
  } catch (err) {
    resultEl.textContent = `失败：${err.message}`;
    resultEl.className = "status error";
  }
});

await load();
