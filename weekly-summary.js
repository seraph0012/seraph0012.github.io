import { requireAuth } from "./shared/authGuard.js";
import { renderNav } from "./shared/nav.js";
import {
  listModules,
  listMeetingWeeks,
  listWeeklyTaskEntries,
  createWeeklyTaskEntry,
  updateWeeklyTaskEntry,
  deleteWeeklyTaskEntry,
  updateMeetingWeekFields,
} from "./shared/db.js";
import { sourceIdOf, sourceColumnFor, buildLabelMap } from "./shared/taskLabels.js";

const session = await requireAuth();
if (!session) {
  throw new Error("not authenticated");
}
renderNav();

const STATUS_OPTIONS = ["", "已完成", "未完成", "中止", "未启动"];
const RISK_OPTIONS = [
  ["", "(未设置)"],
  ["green", "低"],
  ["yellow", "中"],
  ["red", "高"],
];

let allModules = [];
let allWeeks = [];
let targetWeek = null;

function moduleOptionsHtml(selectedId) {
  return (
    `<option value="">(未分类)</option>` +
    allModules
      .map((m) => `<option value="${m.id}" ${m.id === selectedId ? "selected" : ""}>${m.name}</option>`)
      .join("")
  );
}

function statusOptionsHtml(selected) {
  return STATUS_OPTIONS.map(
    (s) => `<option value="${s}" ${s === (selected || "") ? "selected" : ""}>${s || "(未设置)"}</option>`
  ).join("");
}

function riskOptionsHtml(selected) {
  return RISK_OPTIONS.map(
    ([v, l]) => `<option value="${v}" ${v === (selected || "") ? "selected" : ""}>${l}</option>`
  ).join("");
}

function isSummaryLocked() {
  return !!targetWeek?.summary_locked_at;
}

function renderLockUI() {
  const lockBtn = document.getElementById("lock-btn");
  const unlockBtn = document.getElementById("unlock-btn");
  const unlockForm = document.getElementById("unlock-form");
  const statusEl = document.getElementById("lock-status");
  unlockForm.hidden = true;
  if (!targetWeek) return;

  const locked = isSummaryLocked();
  lockBtn.hidden = locked;
  unlockBtn.hidden = !locked;

  let text = locked
    ? `🔒 本周总结已锁定（${new Date(targetWeek.summary_locked_at).toLocaleString()}），编辑前需先解锁`
    : "";
  if (targetWeek.summary_amendment_note) {
    text += `${text ? " ｜ " : ""}⚠ 曾被订正：${targetWeek.summary_amendment_note}`;
  }
  statusEl.textContent = text;
  statusEl.className = locked ? "status warn" : "status";
}

document.getElementById("lock-btn").addEventListener("click", async () => {
  const updated = await updateMeetingWeekFields(targetWeek.id, { summary_locked_at: new Date().toISOString() });
  Object.assign(targetWeek, updated);
  renderLockUI();
  await loadSummary();
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
    summary_locked_at: null,
    summary_amendment_note: note,
  });
  Object.assign(targetWeek, updated);
  document.getElementById("unlock-note").value = "";
  renderLockUI();
  await loadSummary();
});

async function generateSkeleton() {
  const resultEl = document.getElementById("skeleton-result");
  if (isSummaryLocked()) {
    resultEl.textContent = "本周总结已锁定，请先解锁再生成";
    resultEl.className = "status warn";
    return;
  }
  resultEl.textContent = "生成中...";
  resultEl.className = "status";
  try {
    const [planEntries, existingSummary] = await Promise.all([
      listWeeklyTaskEntries(targetWeek.id, "plan"),
      listWeeklyTaskEntries(targetWeek.id, "summary"),
    ]);
    const alreadySummarized = new Set(existingSummary.map((e) => `${e.source_type}:${sourceIdOf(e)}`));
    const toCreate = planEntries.filter((p) => !alreadySummarized.has(`${p.source_type}:${sourceIdOf(p)}`));

    for (const p of toCreate) {
      await createWeeklyTaskEntry({
        meeting_week_id: targetWeek.id,
        appears_in: "summary",
        source_type: p.source_type,
        [sourceColumnFor(p.source_type)]: sourceIdOf(p),
        module_id: p.module_id,
        summary_category: p.source_type === "ad_hoc" ? "计划外" : "计划内",
        owner: p.owner,
        deliverable_this_week: p.deliverable_this_week,
        highlight: p.highlight,
      });
    }
    resultEl.textContent = toCreate.length === 0 ? "本周计划条目都已生成过总结骨架" : `已生成 ${toCreate.length} 条`;
    resultEl.className = "status ok";
    await loadSummary();
  } catch (err) {
    resultEl.textContent = `失败：${err.message}`;
    resultEl.className = "status error";
  }
}

async function loadSummary() {
  if (!targetWeek) return;
  const entries = await listWeeklyTaskEntries(targetWeek.id, "summary");
  const labelItems = entries.map((e) => ({ source_type: e.source_type, source_id: sourceIdOf(e) }));
  const labelMap = await buildLabelMap(labelItems);

  const tbody = document.getElementById("summary-tbody");
  tbody.innerHTML = "";
  const dis = isSummaryLocked() ? "disabled" : "";
  for (const e of entries) {
    const label = labelMap.get(`${e.source_type}:${sourceIdOf(e)}`) || "(未知任务)";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${label}</td>
      <td>
        <select class="f-category" ${dis}>
          <option value="计划内" ${e.summary_category === "计划内" ? "selected" : ""}>计划内</option>
          <option value="计划外" ${e.summary_category === "计划外" ? "selected" : ""}>计划外</option>
        </select>
      </td>
      <td><select class="f-module" ${dis}>${moduleOptionsHtml(e.module_id)}</select></td>
      <td><input type="text" class="f-owner" value="${e.owner || ""}" style="width:5em" ${dis} /></td>
      <td><input type="text" class="f-deliverable" value="${e.deliverable_this_week || ""}" style="width:12em" ${dis} /></td>
      <td><input type="number" class="f-hours" step="0.5" value="${e.actual_hours ?? ""}" style="width:4em" ${dis} /></td>
      <td><select class="f-status" ${dis}>${statusOptionsHtml(e.status)}</select></td>
      <td><input type="text" class="f-reason" value="${e.incomplete_reason || ""}" style="width:10em" ${dis} /></td>
      <td><input type="text" class="f-rectify" value="${e.rectification_measures || ""}" style="width:10em" ${dis} /></td>
      <td><select class="f-risk" ${dis}>${riskOptionsHtml(e.risk_level)}</select></td>
      <td><input type="checkbox" class="f-highlight" ${e.highlight ? "checked" : ""} ${dis} /></td>
      <td><button type="button" class="secondary f-delete" ${dis}>删除</button></td>
    `;
    const save = async () => {
      await updateWeeklyTaskEntry(e.id, {
        summary_category: tr.querySelector(".f-category").value,
        module_id: tr.querySelector(".f-module").value || null,
        owner: tr.querySelector(".f-owner").value || null,
        deliverable_this_week: tr.querySelector(".f-deliverable").value || null,
        actual_hours: tr.querySelector(".f-hours").value || null,
        status: tr.querySelector(".f-status").value || null,
        incomplete_reason: tr.querySelector(".f-reason").value || null,
        rectification_measures: tr.querySelector(".f-rectify").value || null,
        risk_level: tr.querySelector(".f-risk").value || null,
        highlight: tr.querySelector(".f-highlight").checked,
      });
    };
    tr.querySelectorAll("select, input").forEach((el) => el.addEventListener("change", save));
    tr.querySelector(".f-delete").addEventListener("click", async () => {
      await deleteWeeklyTaskEntry(e.id);
      await loadSummary();
    });
    tbody.appendChild(tr);
  }
}

document.getElementById("generate-skeleton-btn").addEventListener("click", generateSkeleton);

async function init() {
  const [modules, weeks] = await Promise.all([listModules(), listMeetingWeeks()]);
  allModules = modules;
  // 没开例会的整周（春节假期等，在meeting-weeks.html取消勾选"正常"）不参与本周总结的周选择
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
  const concluded = sorted.filter((w) => new Date(w.natural_week_end) <= today);
  const defaultWeek = concluded[concluded.length - 1] || sorted[0];
  if (defaultWeek) {
    weekSelect.value = defaultWeek.id;
    targetWeek = defaultWeek;
    renderLockUI();
    await loadSummary();
  }

  weekSelect.addEventListener("change", async () => {
    targetWeek = allWeeks.find((w) => w.id === Number(weekSelect.value));
    renderLockUI();
    await loadSummary();
  });
}

await init();
