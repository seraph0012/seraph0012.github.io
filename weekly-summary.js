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
import { sourceIdOf, sourceColumnFor, buildLabelMap, buildSourceDetailMap, syncSourceStatus } from "./shared/taskLabels.js";
import { validateSourceDetail, validateOwnFields } from "./shared/entryValidation.js";

const SUMMARY_REQUIRED_FIELDS = [
  ["module_id", "模块"],
  ["summary_category", "类别"],
  ["owner", "责任人"],
  ["deliverable_this_week", "上周交付材料"],
  ["actual_hours", "实际用时"],
  ["status", "完成情况"],
];
// 未完成原因/整改措施/风险说明只在"未完成"时才必填（也只有这时候才允许填，见下方disabled逻辑）
function conditionalFieldErrors(e) {
  if (e.status !== "未完成") return [];
  const errs = [];
  if (!e.incomplete_reason) errs.push("未填未完成原因");
  if (!e.rectification_measures) errs.push("未填整改措施");
  if (!e.risk_level) errs.push("未填风险说明");
  return errs;
}

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

// 锁定前完整性校验，规则同weekly-plan.js：本周总结所有条目的必填字段+源任务的标题/最终
// 目标交付物/最终计划完成时间都要补全；"未完成"的条目还要求未完成原因/整改措施/风险都填了
async function validateSummaryBeforeLock() {
  const entries = await listWeeklyTaskEntries(targetWeek.id, "summary");
  const labelItems = entries.map((e) => ({ source_type: e.source_type, source_id: sourceIdOf(e) }));
  const [labelMap, detailMap] = await Promise.all([buildLabelMap(labelItems), buildSourceDetailMap(labelItems)]);
  const problems = [];
  for (const e of entries) {
    const label = labelMap.get(`${e.source_type}:${sourceIdOf(e)}`) || "(未知任务)";
    const detail = detailMap.get(`${e.source_type}:${sourceIdOf(e)}`);
    const errs = [
      ...validateOwnFields(e, SUMMARY_REQUIRED_FIELDS),
      ...conditionalFieldErrors(e),
      ...validateSourceDetail(e, detail),
    ];
    if (errs.length > 0) problems.push(`${label}：${errs.join("；")}`);
  }
  return problems;
}

document.getElementById("lock-btn").addEventListener("click", async () => {
  const problems = await validateSummaryBeforeLock();
  if (problems.length > 0) {
    alert(`本周总结还有内容没填完，暂不能锁定：\n\n${problems.join("\n")}`);
    return;
  }
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
    // 只有一个模块时不用每次手动选，直接默认选中它
    const soleModuleId = allModules.length === 1 ? allModules[0].id : null;

    for (const p of toCreate) {
      await createWeeklyTaskEntry({
        meeting_week_id: targetWeek.id,
        appears_in: "summary",
        source_type: p.source_type,
        [sourceColumnFor(p.source_type)]: sourceIdOf(p),
        module_id: p.module_id ?? soleModuleId,
        summary_category: p.source_type === "ad_hoc" ? "计划外" : "计划内",
        owner: p.owner,
        deliverable_this_week: p.deliverable_this_week,
        // 实际用时先预填计划用时，省得每次都要重填一遍，实际有出入时用户自己改
        actual_hours: p.planned_hours,
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
  const detailMap = await buildSourceDetailMap(labelItems);

  const tbody = document.getElementById("summary-tbody");
  tbody.innerHTML = "";
  const dis = isSummaryLocked() ? "disabled" : "";
  for (const e of entries) {
    // 截止日期任务(milestone)的原计划日期只读展示出来，方便判断这周完成情况是否偏离原计划
    const detail = detailMap.get(`${e.source_type}:${sourceIdOf(e)}`) || {};
    // 未完成原因/整改措施/风险只有"未完成"才允许填，其他完成情况下锁定禁止填写
    const disReason = dis || e.status !== "未完成" ? "disabled" : "";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="task-col readonly-col">${detail.level1Text || ""}</td>
      <td class="task-col readonly-col">${detail.level2Text || ""}</td>
      <td class="task-col readonly-col">${detail.level3Text || ""}</td>
      <td class="task-col readonly-col">${detail.targetDeliverable || ""}</td>
      <td class="readonly-col">${detail.sourceStatus || ""}</td>
      <td class="readonly-col">${detail.completionDate || ""}</td>
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
      <td><input type="text" class="f-reason" value="${e.incomplete_reason || ""}" style="width:10em" ${disReason} /></td>
      <td><input type="text" class="f-rectify" value="${e.rectification_measures || ""}" style="width:10em" ${disReason} /></td>
      <td><select class="f-risk" ${disReason}>${riskOptionsHtml(e.risk_level)}</select></td>
      <td><input type="checkbox" class="f-highlight" ${e.highlight ? "checked" : ""} ${dis} /></td>
      <td>${detail.detailUrl ? `<a href="${detail.detailUrl}" target="_blank" rel="noopener">编辑任务信息</a>` : ""}</td>
      <td><button type="button" class="secondary f-delete" ${dis}>删除</button></td>
    `;
    const save = async () => {
      const status = tr.querySelector(".f-status").value || null;
      // 未完成才允许填未完成原因/整改措施/风险；一旦不是"未完成"就强制清空，
      // 不留着上次填的旧值——这几栏对已完成/中止/未启动的条目没意义
      const isIncomplete = status === "未完成";
      await updateWeeklyTaskEntry(e.id, {
        summary_category: tr.querySelector(".f-category").value,
        module_id: tr.querySelector(".f-module").value || null,
        owner: tr.querySelector(".f-owner").value || null,
        deliverable_this_week: tr.querySelector(".f-deliverable").value || null,
        actual_hours: tr.querySelector(".f-hours").value || null,
        status,
        incomplete_reason: isIncomplete ? tr.querySelector(".f-reason").value || null : null,
        rectification_measures: isIncomplete ? tr.querySelector(".f-rectify").value || null : null,
        risk_level: isIncomplete ? tr.querySelector(".f-risk").value || null : null,
        highlight: tr.querySelector(".f-highlight").checked,
      });
      // 完成情况要同步回源表自身的status字段，不然候选池的过滤逻辑看不出任务已经做完，
      // 已完成的任务会一直出现在下一周的候选池里（2026-07-10发现的真实bug）
      if (status) await syncSourceStatus(e.source_type, sourceIdOf(e), status);
    };
    tr.querySelectorAll("select:not(.f-status), input").forEach((el) => el.addEventListener("change", save));
    // 完成情况一变，未完成原因/整改措施/风险是否可编辑要跟着变，得重新渲染整行才能更新disabled状态
    tr.querySelector(".f-status").addEventListener("change", async () => {
      await save();
      await loadSummary();
    });
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
