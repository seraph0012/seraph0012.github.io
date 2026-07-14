// 从weekly-plan.js抽取出来的"计划区块"挂载函数，供weekly-report.js复用。
// 内部一律用 root.querySelector('.xxx')（class，不用id）操作DOM，参见summarySection.js顶部注释。
import {
  listProjects,
  listWeeklyTaskEntries,
  createWeeklyTaskEntry,
  updateWeeklyTaskEntry,
  deleteWeeklyTaskEntry,
  updateMeetingWeekFields,
  updateTask,
} from "./db.js";
import {
  PROJECT_TYPE_LABEL,
  buildLabelMap,
  buildSourceDetailMap,
  listAllActiveCandidates,
  taskCandidateFields,
} from "./taskLabels.js";
import { dateWithWeekday } from "./dateUtils.js";
import { validateSourceDetail, validateOwnFields } from "./entryValidation.js";
import { renderTaskPicker } from "./taskPicker.js";

const PLAN_REQUIRED_FIELDS = [
  ["module_id", "模块"],
  ["plan_category", "类别"],
  ["owner", "责任人"],
  ["deliverable_this_week", "本周交付物"],
  ["planned_hours", "计划用时"],
  ["plan_start_date", "计划开始时间"],
  ["execution_deadline", "执行期"],
  ["priority_quadrant", "工作优先级"],
  ["resources_needed", "需协调的资源"],
];

const PRIORITY_OPTIONS = [
  ["", "(未设置)"],
  ["urgent_important", "紧急且重要"],
  ["important_not_urgent", "重要不紧急"],
  ["urgent_not_important", "紧急不重要"],
  ["neither", "不紧急不重要"],
];

const TEMPLATE = `
  <div class="lock-bar inline-form">
    <button type="button" class="generate-candidates-btn">生成候选池</button>
    <button type="button" class="lock-btn">锁定本周计划</button>
    <button type="button" class="unlock-btn secondary" hidden>解锁编辑</button>
  </div>
  <p class="candidates-result status"></p>
  <p class="week-range-hint status"></p>
  <p class="lock-status status"></p>
  <form class="unlock-form inline-form" hidden>
    <input type="text" class="unlock-note" placeholder="订正说明（本周计划已锁定，说明这次要改什么/为什么）" style="min-width:320px" required />
    <button type="button" class="unlock-confirm-btn">确认订正</button>
    <button type="button" class="unlock-cancel-btn secondary">取消</button>
  </form>

  <div class="candidates-section" hidden>
    <h3>候选任务（勾选后加入计划）</h3>
    <div class="table-scroll">
    <table>
      <thead>
        <tr>
          <th><input type="checkbox" class="check-all" checked /></th>
          <th>来源</th>
          <th>任务1级</th>
          <th>任务2级</th>
          <th>任务3级</th>
          <th>类别</th>
          <th>模块</th>
          <th>本周交付物</th>
          <th>计划用时(h)</th>
          <th>优先级</th>
        </tr>
      </thead>
      <tbody class="candidates-tbody"></tbody>
    </table>
    </div>
    <button type="button" class="add-selected-btn">加入本周计划</button>
    <p class="add-result status"></p>
  </div>

  <div class="manual-add-block">
    <h3>手动搜索添加任务</h3>
    <p>候选池是按规则自动推荐的，可能有遗漏——按编号/标题搜索后点击即可直接加入本周计划（默认归类"本周新增"，加入后可以在下面表格里改）。</p>
    <div class="manual-picker"></div>
    <button type="button" class="refresh-manual-btn secondary">刷新列表</button>
    <p class="manual-add-result status"></p>
  </div>

  <h3>本周计划（已保存）</h3>
  <p>"任务1/2/3级"、"最终目标交付物"、"最终计划完成时间"是在对应项目/任务详情页维护的静态字段，这里只读展示，改动请点"编辑任务信息"跳转过去。</p>
  <div class="table-scroll">
  <table>
    <thead>
      <tr>
        <th>任务1级</th>
        <th>任务2级</th>
        <th>任务3级</th>
        <th>最终目标交付物</th>
        <th>最终计划完成时间</th>
        <th>类别</th>
        <th>模块</th>
        <th>责任人</th>
        <th>本周交付物</th>
        <th>计划用时</th>
        <th>计划开始</th>
        <th>执行截止</th>
        <th>优先级</th>
        <th>需协调资源</th>
        <th>重点</th>
        <th></th>
        <th></th>
      </tr>
    </thead>
    <tbody class="plan-tbody"></tbody>
  </table>
  </div>
`;

export function mountPlanSection(root, { allModules, allPeople }) {
  root.innerHTML = TEMPLATE;

  let week = null;
  let previousWeek = null;
  let candidates = [];
  let manualCandidates = [];

  function currentSequentialTask(project) {
    const sorted = [...project.tasks].sort((a, b) => {
      if (a.wbs_level2_number !== b.wbs_level2_number) return a.wbs_level2_number - b.wbs_level2_number;
      return (a.wbs_level3_number ?? 0) - (b.wbs_level3_number ?? 0);
    });
    return sorted.find((t) => t.status !== "done" && t.status !== "stopped");
  }

  async function computeCarryOverSet(prevWeek) {
    if (!prevWeek) return new Set();
    const prevSummary = await listWeeklyTaskEntries(prevWeek.id, "summary");
    const set = new Set();
    for (const e of prevSummary) {
      if (e.status === "未完成") {
        set.add(e.task_id);
      }
    }
    return set;
  }

  // 若该任务从未进入过任何一周的计划(actual_start_date还没记录过)，这是它第一次被排进
  // 计划，把这一周的开始日期记成"实际开始日期"(2026-07-14用户要求：自动记录，不用手动填)。
  async function maybeSetActualStart(taskId, actualStartDate, weekStartDate) {
    if (!actualStartDate) {
      await updateTask(taskId, { actual_start_date: weekStartDate });
    }
  }

  async function generateCandidatePool(w) {
    const [projects, existingPlan] = await Promise.all([listProjects(), listWeeklyTaskEntries(w.id, "plan")]);

    const alreadyPlanned = new Set(existingPlan.map((e) => e.task_id));
    const carryOver = await computeCarryOverSet(previousWeek);

    const raw = [];
    const weekEnd = new Date(w.natural_week_end);

    for (const p of projects) {
      if (p.project_type === "sequential") {
        if (p.status !== "active") continue;
        const task = currentSequentialTask(p);
        if (!task) continue;
        raw.push(taskCandidateFields(p, task));
      } else if (p.project_type === "nonsequential") {
        if (p.status !== "active") continue;
        for (const t of p.tasks) {
          if (t.status === "done" || t.status === "stopped") continue;
          if (t.planned_completion_date && new Date(t.planned_completion_date) > weekEnd) continue;
          raw.push(taskCandidateFields(p, t));
        }
      } else {
        for (const t of p.tasks) {
          if (t.meeting_week_id !== w.id) continue;
          raw.push(taskCandidateFields(p, t));
        }
      }
    }

    const filtered = raw.filter((c) => !alreadyPlanned.has(c.task_id));
    const detailMap = await buildSourceDetailMap(filtered.map((c) => c.task_id));
    const soleModuleId = allModules.length === 1 ? allModules[0].id : null;
    for (const c of filtered) {
      c.detail = detailMap.get(c.task_id) || {};
      c.plan_category = carryOver.has(c.task_id) ? "上周未完成" : "本周新增";
      if (c.module_id == null && soleModuleId != null) c.module_id = soleModuleId;
    }
    return filtered;
  }

  function renderWeekRangeHint() {
    const el = root.querySelector(".week-range-hint");
    if (!week) {
      el.textContent = "";
      return;
    }
    el.textContent = `本周工作日范围：${dateWithWeekday(week.meeting_date)} ~ ${dateWithWeekday(week.work_week_end)} —— 填"计划开始"/"执行截止"时不要选到这个范围之外（节假日）`;
  }

  function isPlanLocked() {
    return !!week?.plan_locked_at;
  }

  function renderLockUI() {
    const lockBtn = root.querySelector(".lock-btn");
    const unlockBtn = root.querySelector(".unlock-btn");
    const unlockForm = root.querySelector(".unlock-form");
    const statusEl = root.querySelector(".lock-status");
    unlockForm.hidden = true;
    if (!week) return;

    const locked = isPlanLocked();
    lockBtn.hidden = locked;
    unlockBtn.hidden = !locked;

    let text = locked ? `🔒 本周计划已锁定（${new Date(week.plan_locked_at).toLocaleString()}），编辑前需先解锁` : "";
    if (week.plan_amendment_note) {
      text += `${text ? " ｜ " : ""}⚠ 曾被订正：${week.plan_amendment_note}`;
    }
    statusEl.textContent = text;
    statusEl.className = locked ? "lock-status status warn" : "lock-status status";
  }

  async function validatePlanBeforeLock() {
    const entries = await listWeeklyTaskEntries(week.id, "plan");
    const taskIds = entries.map((e) => e.task_id);
    const [labelMap, detailMap] = await Promise.all([buildLabelMap(taskIds), buildSourceDetailMap(taskIds)]);
    const problems = [];
    for (const e of entries) {
      const label = labelMap.get(e.task_id) || "(未知任务)";
      const detail = detailMap.get(e.task_id);
      const errs = [...validateOwnFields(e, PLAN_REQUIRED_FIELDS), ...validateSourceDetail(e, detail)];
      if (errs.length > 0) problems.push(`${label}：${errs.join("；")}`);
    }
    return problems;
  }

  root.querySelector(".lock-btn").addEventListener("click", async () => {
    const problems = await validatePlanBeforeLock();
    if (problems.length > 0) {
      alert(`本周计划还有内容没填完，暂不能锁定：\n\n${problems.join("\n")}`);
      return;
    }
    const updated = await updateMeetingWeekFields(week.id, { plan_locked_at: new Date().toISOString() });
    Object.assign(week, updated);
    renderLockUI();
    await loadSavedPlan();
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
      plan_locked_at: null,
      plan_amendment_note: note,
    });
    Object.assign(week, updated);
    noteEl.value = "";
    renderLockUI();
    await loadSavedPlan();
  });

  function moduleOptionsHtml(selectedId) {
    return (
      `<option value="">(未分类)</option>` +
      allModules
        .map((m) => `<option value="${m.id}" ${m.id === selectedId ? "selected" : ""}>${m.name}</option>`)
        .join("")
    );
  }
  function priorityOptionsHtml(selected) {
    return PRIORITY_OPTIONS.map(
      ([v, l]) => `<option value="${v}" ${v === (selected || "") ? "selected" : ""}>${l}</option>`
    ).join("");
  }

  function renderCandidates() {
    const section = root.querySelector(".candidates-section");
    const tbody = root.querySelector(".candidates-tbody");
    tbody.innerHTML = "";
    section.hidden = candidates.length === 0;
    candidates.forEach((c, idx) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><input type="checkbox" class="f-check" checked /></td>
        <td>${PROJECT_TYPE_LABEL[c.project_type]}</td>
        <td class="task-col">${c.detail.level1Text || ""}</td>
        <td class="task-col">${c.detail.level2Text || ""}</td>
        <td class="task-col">${c.detail.level3Text || ""}</td>
        <td>${c.plan_category}</td>
        <td><select class="f-module">${moduleOptionsHtml(c.module_id)}</select></td>
        <td><input type="text" class="f-deliverable" value="${c.deliverable_this_week || ""}" style="width:14em" /></td>
        <td><input type="number" class="f-hours" step="0.5" style="width:4em" /></td>
        <td><select class="f-priority">${priorityOptionsHtml(null)}</select></td>
      `;
      tr.dataset.idx = idx;
      tbody.appendChild(tr);
    });
  }

  root.querySelector(".check-all").addEventListener("change", (e) => {
    root.querySelectorAll(".f-check").forEach((cb) => (cb.checked = e.target.checked));
  });

  root.querySelector(".generate-candidates-btn").addEventListener("click", async () => {
    const resultEl = root.querySelector(".candidates-result");
    if (!week) return;
    if (isPlanLocked()) {
      resultEl.textContent = "本周计划已锁定，请先解锁再生成候选";
      resultEl.className = "candidates-result status warn";
      return;
    }
    resultEl.textContent = "生成中...";
    resultEl.className = "candidates-result status";
    try {
      candidates = await generateCandidatePool(week);
      renderCandidates();
      resultEl.textContent = candidates.length === 0 ? "没有新的候选任务（可能都已加入本周计划）" : `找到 ${candidates.length} 条候选`;
      resultEl.className = "candidates-result status ok";
    } catch (err) {
      resultEl.textContent = `失败：${err.message}`;
      resultEl.className = "candidates-result status error";
    }
  });

  root.querySelector(".add-selected-btn").addEventListener("click", async () => {
    const resultEl = root.querySelector(".add-result");
    if (isPlanLocked()) {
      resultEl.textContent = "本周计划已锁定，请先解锁再加入";
      resultEl.className = "add-result status warn";
      return;
    }
    const rows = [...root.querySelectorAll(".candidates-tbody tr")];
    const toInsert = [];
    for (const tr of rows) {
      if (!tr.querySelector(".f-check").checked) continue;
      const c = candidates[Number(tr.dataset.idx)];
      toInsert.push({
        c,
        row: {
          meeting_week_id: week.id,
          appears_in: "plan",
          task_id: c.task_id,
          module_id: tr.querySelector(".f-module").value || null,
          plan_category: c.plan_category,
          owner: c.owner || (allPeople.length === 1 ? allPeople[0].name : null),
          deliverable_this_week: tr.querySelector(".f-deliverable").value || null,
          planned_hours: tr.querySelector(".f-hours").value || null,
          priority_quadrant: tr.querySelector(".f-priority").value || null,
          execution_deadline: c.execution_deadline || null,
          resources_needed: "无",
        },
      });
    }
    if (toInsert.length === 0) {
      resultEl.textContent = "没有勾选任何候选";
      resultEl.className = "add-result status warn";
      return;
    }
    resultEl.textContent = "写入中...";
    resultEl.className = "add-result status";
    try {
      for (const { c, row } of toInsert) {
        await createWeeklyTaskEntry(row);
        await maybeSetActualStart(c.task_id, c.actualStartDate, week.meeting_date);
      }
      resultEl.textContent = `已加入 ${toInsert.length} 条`;
      resultEl.className = "add-result status ok";
      candidates = await generateCandidatePool(week);
      renderCandidates();
      await loadSavedPlan();
    } catch (err) {
      resultEl.textContent = `失败：${err.message}`;
      resultEl.className = "add-result status error";
    }
  });

  function renderManualPicker() {
    renderTaskPicker(root.querySelector(".manual-picker"), manualCandidates, handleManualPick);
  }

  async function loadManualCandidates() {
    if (!week) {
      manualCandidates = [];
      renderManualPicker();
      return;
    }
    const [all, planEntries] = await Promise.all([
      listAllActiveCandidates(week.id),
      listWeeklyTaskEntries(week.id, "plan"),
    ]);
    const excluded = new Set(planEntries.map((e) => e.task_id));
    manualCandidates = all.filter((c) => !excluded.has(c.task_id));
    renderManualPicker();
  }

  async function handleManualPick(c) {
    const resultEl = root.querySelector(".manual-add-result");
    if (isPlanLocked()) {
      resultEl.textContent = "本周计划已锁定，请先解锁再添加";
      resultEl.className = "manual-add-result status warn";
      return;
    }
    resultEl.textContent = "添加中...";
    resultEl.className = "manual-add-result status";
    try {
      const carryOver = await computeCarryOverSet(previousWeek);
      const soleModuleId = allModules.length === 1 ? allModules[0].id : null;
      await createWeeklyTaskEntry({
        meeting_week_id: week.id,
        appears_in: "plan",
        task_id: c.task_id,
        module_id: c.module_id ?? soleModuleId,
        plan_category: carryOver.has(c.task_id) ? "上周未完成" : "本周新增",
        owner: c.owner || (allPeople.length === 1 ? allPeople[0].name : null),
        deliverable_this_week: c.deliverable_this_week,
        execution_deadline: c.execution_deadline || null,
        resources_needed: "无",
      });
      await maybeSetActualStart(c.task_id, c.actualStartDate, week.meeting_date);
      resultEl.textContent = `已添加：${c.label}（可以在下方表格里继续编辑用时/优先级等字段）`;
      resultEl.className = "manual-add-result status ok";
      await loadManualCandidates();
      await loadSavedPlan();
    } catch (err) {
      resultEl.textContent = `失败：${err.message}`;
      resultEl.className = "manual-add-result status error";
    }
  }

  root.querySelector(".refresh-manual-btn").addEventListener("click", loadManualCandidates);

  async function loadSavedPlan() {
    if (!week) return;
    root.querySelector(".plan-tbody").innerHTML = `<tr><td colspan="17">加载中...</td></tr>`;
    const entries = await listWeeklyTaskEntries(week.id, "plan");
    const detailMap = await buildSourceDetailMap(entries.map((e) => e.task_id));

    const tbody = root.querySelector(".plan-tbody");
    tbody.innerHTML = "";
    const locked = isPlanLocked();
    const dis = locked ? "disabled" : "";
    for (const e of entries) {
      const detail = detailMap.get(e.task_id) || {};
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td class="task-col readonly-col">${detail.level1Text || ""}</td>
        <td class="task-col readonly-col">${detail.level2Text || ""}</td>
        <td class="task-col readonly-col">${detail.level3Text || ""}</td>
        <td class="task-col readonly-col">${detail.targetDeliverable || ""}</td>
        <td class="readonly-col">${detail.completionDate || ""}</td>
        <td class="readonly-col">${e.plan_category || ""}</td>
        <td><select class="f-module" ${dis}>${moduleOptionsHtml(e.module_id)}</select></td>
        <td><input type="text" class="f-owner" value="${e.owner || ""}" style="width:5em" ${dis} /></td>
        <td><input type="text" class="f-deliverable" value="${e.deliverable_this_week || ""}" style="width:12em" ${dis} /></td>
        <td><input type="number" class="f-hours" step="0.5" value="${e.planned_hours ?? ""}" style="width:4em" ${dis} /></td>
        <td><input type="date" class="f-start" value="${e.plan_start_date || ""}" min="${week.meeting_date}" max="${week.work_week_end || ""}" ${dis} /></td>
        <td><input type="date" class="f-deadline" value="${e.execution_deadline || ""}" min="${week.meeting_date}" max="${week.work_week_end || ""}" ${dis} /></td>
        <td><select class="f-priority" ${dis}>${priorityOptionsHtml(e.priority_quadrant)}</select></td>
        <td><input type="text" class="f-resources" value="${e.resources_needed || "无"}" style="width:8em" ${dis} /></td>
        <td><input type="checkbox" class="f-highlight" ${e.highlight ? "checked" : ""} ${dis} /></td>
        <td>${detail.detailUrl ? `<a href="${detail.detailUrl}" target="_blank" rel="noopener">编辑任务信息</a>` : ""}</td>
        <td><button type="button" class="secondary f-delete" ${dis}>删除</button></td>
      `;
      const save = async () => {
        await updateWeeklyTaskEntry(e.id, {
          module_id: tr.querySelector(".f-module").value || null,
          owner: tr.querySelector(".f-owner").value || null,
          deliverable_this_week: tr.querySelector(".f-deliverable").value || null,
          planned_hours: tr.querySelector(".f-hours").value || null,
          plan_start_date: tr.querySelector(".f-start").value || null,
          execution_deadline: tr.querySelector(".f-deadline").value || null,
          priority_quadrant: tr.querySelector(".f-priority").value || null,
          resources_needed: tr.querySelector(".f-resources").value || "无",
          highlight: tr.querySelector(".f-highlight").checked,
        });
      };
      tr.querySelectorAll("select, input").forEach((el) => el.addEventListener("change", save));
      tr.querySelector(".f-delete").addEventListener("click", async () => {
        await deleteWeeklyTaskEntry(e.id);
        await loadSavedPlan();
      });
      tbody.appendChild(tr);
    }
  }

  async function setWeek(w, prevWeek) {
    week = w;
    previousWeek = prevWeek;
    candidates = [];
    renderCandidates();
    renderLockUI();
    renderWeekRangeHint();
    await Promise.all([loadSavedPlan(), loadManualCandidates()]);
  }

  return { setWeek };
}
