// 从weekly-summary.js抽取出来的"总结区块"挂载函数，供weekly-report.js复用。
// 内部一律用 root.querySelector('.xxx')（class，不用id）操作DOM，这样可以在同一个页面里
// 跟planSection.js的区块共存而不撞id（2026-07-13周报工作流重新设计，见
// tools/.claude/plans/plan-weekly-report-unified-workflow.md）。
import {
  listWeeklyTaskEntries,
  createWeeklyTaskEntry,
  updateWeeklyTaskEntry,
  deleteWeeklyTaskEntry,
  updateMeetingWeekFields,
} from "./db.js";
import {
  buildLabelMap,
  buildSourceDetailMap,
  syncTaskStatus,
  listAllActiveCandidates,
} from "./taskLabels.js";
import { validateSourceDetail, validateOwnFields } from "./entryValidation.js";
import { renderTaskPicker } from "./taskPicker.js";

const SUMMARY_REQUIRED_FIELDS = [
  ["module_id", "模块"],
  ["summary_category", "类别"],
  ["owner", "责任人"],
  ["deliverable_this_week", "上周交付材料"],
  ["actual_hours", "实际用时"],
  ["status", "完成情况"],
];
function conditionalFieldErrors(e) {
  if (e.status !== "未完成") return [];
  const errs = [];
  if (!e.incomplete_reason) errs.push("未填未完成原因");
  if (!e.rectification_measures) errs.push("未填整改措施");
  if (!e.risk_level) errs.push("未填风险说明");
  return errs;
}

const STATUS_OPTIONS = ["", "已完成", "未完成", "中止", "未启动"];
const RISK_OPTIONS = [
  ["", "(未设置)"],
  ["green", "低"],
  ["yellow", "中"],
  ["red", "高"],
];

const TEMPLATE = `
  <p class="no-week-msg status" hidden>没有更早的例会周，跳过"上周总结"。</p>
  <div class="summary-body">
    <div class="lock-bar inline-form">
      <button type="button" class="generate-skeleton-btn">复制上周计划生成总结</button>
      <button type="button" class="lock-btn">锁定本周总结</button>
      <button type="button" class="unlock-btn secondary" hidden>解锁编辑</button>
    </div>
    <p>把上周计划里的条目复制过来作为总结的起点，正常一周点一次就够。之后如果又给上周计划补录了新条目，可以再点一次——只会补上还没生成过总结的那些，不会动你已经填好的行。</p>
    <p class="skeleton-result status"></p>
    <p class="lock-status status"></p>
    <form class="unlock-form inline-form" hidden>
      <input type="text" class="unlock-note" placeholder="订正说明（本周总结已锁定，说明这次要改什么/为什么）" style="min-width:320px" required />
      <button type="button" class="unlock-confirm-btn">确认订正</button>
      <button type="button" class="unlock-cancel-btn secondary">取消</button>
    </form>

    <div class="unplanned-block">
      <h3>记录计划外完成的任务</h3>
      <p>"计划外"就是没出现在本周计划里、但本周确实做了的任务，不用单独登记——搜索一个已有的顺序队列/截止日期/循环任务点击即可添加，"计划内/计划外"会自动判定。如果这个任务压根还没建过，先去<a href="tasks.html" target="_blank" rel="noopener">任务管理</a>新建，回来点"刷新"再搜。</p>
      <div class="unplanned-picker"></div>
      <button type="button" class="refresh-unplanned-btn secondary">刷新列表</button>
      <p class="add-unplanned-result status"></p>
    </div>

    <h3>总结条目</h3>
    <p>"任务1/2/3级"、"最终目标交付物"、"最终完成情况"、"最终计划完成时间"是在对应项目/任务详情页维护的字段，这里只读展示，改动请点"编辑任务信息"跳转过去。"最终完成情况"会在你填写下面的"完成情况"时自动同步过去——但只有当"本周交付材料"文字跟"最终目标交付物"严格一致（去首尾空格）时，才会同步成"已完成"；复杂任务允许跨周分批交付，中途每周标"已完成"只代表这周这部分做完了，"最终完成情况"会继续留在"未完成"，任务会继续出现在下周的候选池/搜索里，等哪周的交付材料终于跟最终目标交付物文字对上，才真正标记为最终完成。</p>
    <div class="table-scroll">
    <table>
      <thead>
        <tr>
          <th>任务1级</th>
          <th>任务2级</th>
          <th>任务3级</th>
          <th>最终目标交付物</th>
          <th>最终完成情况</th>
          <th>最终计划完成时间</th>
          <th>类别</th>
          <th>模块</th>
          <th>责任人</th>
          <th>本周交付材料</th>
          <th>实际用时</th>
          <th>完成情况</th>
          <th>未完成原因</th>
          <th>整改措施</th>
          <th>风险</th>
          <th>重点</th>
          <th></th>
          <th></th>
        </tr>
      </thead>
      <tbody class="summary-tbody"></tbody>
    </table>
    </div>
  </div>
`;

export function mountSummarySection(root, { allModules }) {
  root.innerHTML = TEMPLATE;

  let week = null;
  let unplannedCandidates = [];

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
    return !!week?.summary_locked_at;
  }

  function renderLockUI() {
    const lockBtn = root.querySelector(".lock-btn");
    const unlockBtn = root.querySelector(".unlock-btn");
    const unlockForm = root.querySelector(".unlock-form");
    const statusEl = root.querySelector(".lock-status");
    unlockForm.hidden = true;
    if (!week) return;

    const locked = isSummaryLocked();
    lockBtn.hidden = locked;
    unlockBtn.hidden = !locked;

    let text = locked
      ? `🔒 本周总结已锁定（${new Date(week.summary_locked_at).toLocaleString()}），编辑前需先解锁`
      : "";
    if (week.summary_amendment_note) {
      text += `${text ? " ｜ " : ""}⚠ 曾被订正：${week.summary_amendment_note}`;
    }
    statusEl.textContent = text;
    statusEl.className = locked ? "lock-status status warn" : "lock-status status";
  }

  async function validateSummaryBeforeLock() {
    const entries = await listWeeklyTaskEntries(week.id, "summary");
    const taskIds = entries.map((e) => e.task_id);
    const [labelMap, detailMap] = await Promise.all([buildLabelMap(taskIds), buildSourceDetailMap(taskIds)]);
    const problems = [];
    for (const e of entries) {
      const label = labelMap.get(e.task_id) || "(未知任务)";
      const detail = detailMap.get(e.task_id);
      const errs = [
        ...validateOwnFields(e, SUMMARY_REQUIRED_FIELDS),
        ...conditionalFieldErrors(e),
        ...validateSourceDetail(e, detail),
      ];
      if (errs.length > 0) problems.push(`${label}：${errs.join("；")}`);
    }
    return problems;
  }

  root.querySelector(".lock-btn").addEventListener("click", async () => {
    const problems = await validateSummaryBeforeLock();
    if (problems.length > 0) {
      alert(`本周总结还有内容没填完，暂不能锁定：\n\n${problems.join("\n")}`);
      return;
    }
    const updated = await updateMeetingWeekFields(week.id, { summary_locked_at: new Date().toISOString() });
    Object.assign(week, updated);
    renderLockUI();
    await loadSummary();
  });

  root.querySelector(".unlock-btn").addEventListener("click", () => {
    root.querySelector(".unlock-form").hidden = false;
  });
  root.querySelector(".unlock-cancel-btn").addEventListener("click", () => {
    root.querySelector(".unlock-form").hidden = true;
  });
  root.querySelector(".unlock-confirm-btn").addEventListener("click", async () => {
    const noteEl = root.querySelector(".unlock-note");
    const note = noteEl.value.trim();
    if (!note) {
      alert("请填写订正说明");
      return;
    }
    const updated = await updateMeetingWeekFields(week.id, {
      summary_locked_at: null,
      summary_amendment_note: note,
    });
    Object.assign(week, updated);
    noteEl.value = "";
    renderLockUI();
    await loadSummary();
  });

  async function generateSkeleton() {
    const resultEl = root.querySelector(".skeleton-result");
    if (isSummaryLocked()) {
      resultEl.textContent = "本周总结已锁定，请先解锁再生成";
      resultEl.className = "skeleton-result status warn";
      return;
    }
    resultEl.textContent = "生成中...";
    resultEl.className = "skeleton-result status";
    try {
      const [planEntries, existingSummary] = await Promise.all([
        listWeeklyTaskEntries(week.id, "plan"),
        listWeeklyTaskEntries(week.id, "summary"),
      ]);
      const alreadySummarized = new Set(existingSummary.map((e) => e.task_id));
      const toCreate = planEntries.filter((p) => !alreadySummarized.has(p.task_id));
      const soleModuleId = allModules.length === 1 ? allModules[0].id : null;

      for (const p of toCreate) {
        await createWeeklyTaskEntry({
          meeting_week_id: week.id,
          appears_in: "summary",
          task_id: p.task_id,
          module_id: p.module_id ?? soleModuleId,
          summary_category: "计划内",
          owner: p.owner,
          deliverable_this_week: p.deliverable_this_week,
          actual_hours: p.planned_hours,
          highlight: p.highlight,
        });
      }
      resultEl.textContent = toCreate.length === 0 ? "上周计划条目都已经复制过了" : `已复制 ${toCreate.length} 条`;
      resultEl.className = "skeleton-result status ok";
      await loadSummary();
      await loadUnplannedCandidates();
    } catch (err) {
      resultEl.textContent = `失败：${err.message}`;
      resultEl.className = "skeleton-result status error";
    }
  }
  root.querySelector(".generate-skeleton-btn").addEventListener("click", generateSkeleton);

  async function loadSummary() {
    if (!week) return;
    root.querySelector(".summary-tbody").innerHTML = `<tr><td colspan="18">加载中...</td></tr>`;
    const entries = await listWeeklyTaskEntries(week.id, "summary");
    const detailMap = await buildSourceDetailMap(entries.map((e) => e.task_id));

    const tbody = root.querySelector(".summary-tbody");
    tbody.innerHTML = "";
    const dis = isSummaryLocked() ? "disabled" : "";
    for (const e of entries) {
      const detail = detailMap.get(e.task_id) || {};
      const disReason = dis || e.status !== "未完成" ? "disabled" : "";
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td class="task-col readonly-col">${detail.level1Text || ""}</td>
        <td class="task-col readonly-col">${detail.level2Text || ""}</td>
        <td class="task-col readonly-col">${detail.level3Text || ""}</td>
        <td class="task-col readonly-col">${detail.targetDeliverable || ""}</td>
        <td class="readonly-col">${detail.sourceStatus || ""}</td>
        <td class="readonly-col">${detail.completionDate || ""}</td>
        <td class="readonly-col">${e.summary_category || ""}</td>
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
        const isIncomplete = status === "未完成";
        const deliverableThisWeek = tr.querySelector(".f-deliverable").value || null;
        await updateWeeklyTaskEntry(e.id, {
          module_id: tr.querySelector(".f-module").value || null,
          owner: tr.querySelector(".f-owner").value || null,
          deliverable_this_week: deliverableThisWeek,
          actual_hours: tr.querySelector(".f-hours").value || null,
          status,
          incomplete_reason: isIncomplete ? tr.querySelector(".f-reason").value || null : null,
          rectification_measures: isIncomplete ? tr.querySelector(".f-rectify").value || null : null,
          risk_level: isIncomplete ? tr.querySelector(".f-risk").value || null : null,
          highlight: tr.querySelector(".f-highlight").checked,
        });
        if (status) {
          // "已完成"不等于任务本身最终完成——本周交付材料要跟最终目标交付物文字严格相等
          // (去首尾空格)才算数，复杂任务允许跨周分批交付，见taskLabels.js的syncTaskStatus注释。
          const isFinal = !!(
            detail.targetDeliverable &&
            deliverableThisWeek &&
            deliverableThisWeek.trim() === detail.targetDeliverable.trim()
          );
          await syncTaskStatus(e.task_id, status, { isFinal });
        }
      };
      tr.querySelectorAll("select:not(.f-status), input").forEach((el) => el.addEventListener("change", save));
      tr.querySelector(".f-status").addEventListener("change", async () => {
        await save();
        await loadSummary();
      });
      tr.querySelector(".f-delete").addEventListener("click", async () => {
        await deleteWeeklyTaskEntry(e.id);
        await loadSummary();
        await loadUnplannedCandidates();
      });
      tbody.appendChild(tr);
    }
  }

  function renderUnplannedPicker() {
    renderTaskPicker(root.querySelector(".unplanned-picker"), unplannedCandidates, handleUnplannedPick);
  }

  async function loadUnplannedCandidates() {
    if (!week) {
      unplannedCandidates = [];
      renderUnplannedPicker();
      return;
    }
    const [all, planEntries, summaryEntries] = await Promise.all([
      listAllActiveCandidates(week.id),
      listWeeklyTaskEntries(week.id, "plan"),
      listWeeklyTaskEntries(week.id, "summary"),
    ]);
    const excluded = new Set([...planEntries.map((e) => e.task_id), ...summaryEntries.map((e) => e.task_id)]);
    unplannedCandidates = all.filter((c) => !excluded.has(c.task_id));
    renderUnplannedPicker();
  }

  async function handleUnplannedPick(c) {
    const resultEl = root.querySelector(".add-unplanned-result");
    if (isSummaryLocked()) {
      resultEl.textContent = "本周总结已锁定，请先解锁再添加";
      resultEl.className = "add-unplanned-result status warn";
      return;
    }
    resultEl.textContent = "添加中...";
    resultEl.className = "add-unplanned-result status";
    try {
      const soleModuleId = allModules.length === 1 ? allModules[0].id : null;
      await createWeeklyTaskEntry({
        meeting_week_id: week.id,
        appears_in: "summary",
        task_id: c.task_id,
        module_id: c.module_id ?? soleModuleId,
        summary_category: "计划外",
        owner: c.owner,
        deliverable_this_week: c.deliverable_this_week,
      });
      resultEl.textContent = `已添加：${c.label}`;
      resultEl.className = "add-unplanned-result status ok";
      await loadUnplannedCandidates();
      await loadSummary();
    } catch (err) {
      resultEl.textContent = `失败：${err.message}`;
      resultEl.className = "add-unplanned-result status error";
    }
  }

  root.querySelector(".refresh-unplanned-btn").addEventListener("click", loadUnplannedCandidates);

  async function setWeek(w) {
    week = w;
    const noWeekMsg = root.querySelector(".no-week-msg");
    const body = root.querySelector(".summary-body");
    if (!week) {
      noWeekMsg.hidden = false;
      body.hidden = true;
      return;
    }
    noWeekMsg.hidden = true;
    body.hidden = false;
    renderLockUI();
    await loadSummary();
    await loadUnplannedCandidates();
  }

  return { setWeek };
}
