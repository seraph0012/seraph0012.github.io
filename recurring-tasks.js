import { requireAuth } from "./shared/authGuard.js";
import { renderNav } from "./shared/nav.js";
import {
  listModules,
  listMeetingWeeks,
  listRecurringTemplates,
  createRecurringTemplate,
  getRecurringTemplate,
  addRecurringInstance,
  updateRecurringInstance,
  claimTaskNumber,
  setTaskNumberOwner,
} from "./shared/db.js";

const session = await requireAuth();
if (!session) {
  throw new Error("not authenticated");
}
renderNav();

let allMeetingWeeks = [];
let selectedTemplateId = Number(new URLSearchParams(window.location.search).get("template")) || null;

async function populateLookups() {
  const [modules, weeks] = await Promise.all([listModules(), listMeetingWeeks()]);
  // 没开例会的整周（比如春节假期，在meeting-weeks.html里取消勾选"正常"）不参与
  // 起始周选择/顺延递补编号计算——保留在日历里，只是不算作可用的例会周
  allMeetingWeeks = weeks.filter((w) => w.is_normal !== false);

  const moduleSelect = document.querySelector('select[name="module_id"]');
  for (const m of modules) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.name;
    moduleSelect.appendChild(opt);
  }

  const weekSelect = document.querySelector('select[name="start_meeting_week_id"]');
  for (const w of weeks) {
    const opt = document.createElement("option");
    opt.value = w.id;
    opt.textContent = `${w.natural_week_start}（例会${w.meeting_date}）`;
    weekSelect.appendChild(opt);
  }
}

async function loadTemplates() {
  const templates = await listRecurringTemplates();
  const tbody = document.getElementById("templates-tbody");
  tbody.innerHTML = "";
  for (const t of templates) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${t.level1_number}</td>
      <td>${t.title}</td>
      <td>${t.frequency}</td>
      <td>${t.status}</td>
      <td><button type="button" class="secondary f-view">查看实例</button></td>
    `;
    tr.querySelector(".f-view").addEventListener("click", () => {
      selectedTemplateId = t.id;
      history.replaceState(null, "", `?template=${t.id}`);
      loadInstances();
    });
    tbody.appendChild(tr);
  }
}

// 编号算法：weekly频率 - 同月内下一次实例level3=上一实例level3+1（跳过的周顺延递补，不留空号）；
// 跨自然月则level2+1、level3重置为1，且无论中间跳过几个月都只+1（顺延式，已与用户确认）。
// monthly频率则level2=上一实例level2+1，不使用level3。
function computeNextNumber(template, instances, targetWeek) {
  if (instances.length === 0) {
    return { level2: 1, level3: template.frequency === "monthly" ? null : 1 };
  }
  const sorted = [...instances].sort((a, b) => {
    const wa = allMeetingWeeks.find((w) => w.id === a.meeting_week_id);
    const wb = allMeetingWeeks.find((w) => w.id === b.meeting_week_id);
    return new Date(wa.natural_week_start) - new Date(wb.natural_week_start);
  });
  const last = sorted[sorted.length - 1];
  const lastWeek = allMeetingWeeks.find((w) => w.id === last.meeting_week_id);

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
  const sorted = [...allMeetingWeeks].sort(
    (a, b) => new Date(a.natural_week_start) - new Date(b.natural_week_start)
  );
  return sorted.find((w) => !usedWeekIds.has(w.id));
}

async function loadInstances() {
  if (!selectedTemplateId) return;
  const template = await getRecurringTemplate(selectedTemplateId);
  document.getElementById("instances-section").hidden = false;
  document.getElementById("instances-title").textContent = `[${template.level1_number}] ${template.title} 的实例`;

  const tbody = document.getElementById("instances-tbody");
  tbody.innerHTML = "";
  const sorted = [...template.recurring_task_instances].sort(
    (a, b) => {
      const wa = allMeetingWeeks.find((w) => w.id === a.meeting_week_id);
      const wb = allMeetingWeeks.find((w) => w.id === b.meeting_week_id);
      return new Date(wa.natural_week_start) - new Date(wb.natural_week_start);
    }
  );
  for (const inst of sorted) {
    const week = allMeetingWeeks.find((w) => w.id === inst.meeting_week_id);
    const tr = document.createElement("tr");
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
      await loadInstances();
    };
    tr.querySelector(".f-actual").addEventListener("change", save);
    tr.querySelector(".f-status").addEventListener("change", save);
    tr.querySelector(".f-planned-hours").addEventListener("change", save);
    tr.querySelector(".f-actual-hours").addEventListener("change", save);
    tbody.appendChild(tr);
  }

  document.getElementById("generate-next-btn").onclick = async () => {
    const resultEl = document.getElementById("generate-result");
    const targetWeek = nextUnusedWeek(template.recurring_task_instances);
    if (!targetWeek) {
      resultEl.textContent = "没有更多可用的例会周了，请先在例会日历里预生成更多周";
      resultEl.className = "status error";
      return;
    }
    try {
      const { level2, level3 } = computeNextNumber(template, template.recurring_task_instances, targetWeek);
      const fullNumber =
        level3 != null ? `${template.level1_number}.${level2}.${level3}` : `${template.level1_number}.${level2}`;
      await addRecurringInstance(selectedTemplateId, {
        meeting_week_id: targetWeek.id,
        level2_number: level2,
        level3_number: level3,
        full_number: fullNumber,
        due_date: targetWeek.meeting_date,
      });
      resultEl.textContent = `已生成实例 ${fullNumber}（例会周 ${targetWeek.natural_week_start}）`;
      resultEl.className = "status ok";
      await loadInstances();
    } catch (err) {
      resultEl.textContent = `失败：${err.message}`;
      resultEl.className = "status error";
    }
  };
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
      task_type: "recurring",
      title_snapshot: title,
      owning_table: "recurring_task_templates",
      owning_id: 0,
    });
    const startWeekId = Number(form.get("start_meeting_week_id"));
    const startWeek = allMeetingWeeks.find((w) => w.id === startWeekId);
    const template = await createRecurringTemplate({
      title,
      module_id: form.get("module_id") || null,
      owner: form.get("owner") || null,
      frequency: form.get("frequency"),
      start_date: startWeek.natural_week_start,
      start_meeting_week_id: startWeekId,
      level1_number: numberRow.level1_number,
    });
    await setTaskNumberOwner(numberRow.level1_number, template.id);
    e.target.reset();
    resultEl.textContent = "";
    await loadTemplates();
  } catch (err) {
    resultEl.textContent = `失败：${err.message}`;
    resultEl.className = "status error";
  }
});

await populateLookups();
await loadTemplates();
if (selectedTemplateId) {
  await loadInstances();
}
