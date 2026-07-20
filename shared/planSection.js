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
import { dateWithWeekday, weekdayLabel } from "./dateUtils.js";
import { validateSourceDetail, validateOwnFields } from "./entryValidation.js";
import { renderTaskPicker } from "./taskPicker.js";
import { moveRow } from "./rowReorder.js";

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

// 2026-07-20新增：跨周字段自动填充。只认"文本末尾v/V+数字"这一种版本号格式(比如
// "项目计划书v1"->"v2")，不匹配就原样返回、不做任何模糊猜测——用户明确要求保守，
// 宁可不递增也不要在不该改的地方误触发。
function bumpVersion(text) {
  const m = /^(.*?)([vV])(\d+)\s*$/.exec(text || "");
  if (!m) return text;
  return `${m[1]}${m[2]}${Number(m[3]) + 1}`;
}

// 给定一个候选task_id，如果它在上周计划里也出现过，返回"应该默认沿用/递增的字段"；
// 没出现过返回null(维持现状——新任务默认用task.target_deliverable，不做任何自动填充)。
// 版本号递增只在"3级任务(detail.level3!=null)且本周不是最终计划完成周"时对交付物文字生效，
// 其余情况(用时/计划开始/执行截止，以及不满足递增条件时的交付物)一律原样复制上周的值。
function computeCarryOverDefaults(taskId, prevPlanEntries, detail, targetWeek) {
  const prev = prevPlanEntries.find((e) => e.task_id === taskId);
  if (!prev) return null;
  const completionDate = detail?.completionDate;
  const isFinalWeek =
    !!completionDate && completionDate >= targetWeek.natural_week_start && completionDate <= targetWeek.natural_week_end;
  const isLevel3 = detail?.level3 != null;
  const deliverable = isLevel3 && !isFinalWeek ? bumpVersion(prev.deliverable_this_week) : prev.deliverable_this_week;
  return {
    deliverable,
    hours: prev.planned_hours,
    planStart: prev.plan_start_date,
    executionDeadline: prev.execution_deadline,
  };
}

const PRIORITY_OPTIONS = [
  ["", "(未设置)"],
  ["urgent_important", "紧急且重要"],
  ["important_not_urgent", "重要不紧急"],
  ["urgent_not_important", "紧急不重要"],
  ["neither", "不紧急不重要"],
];

// 2026-07-16：本周交付物/需协调资源改用<textarea>多行显示后，插入的是文本节点(标签之间)
// 而不是value=""属性——不能再沿用"只在value属性里转义引号"的老习惯，< > &不转义的话会
// 直接被当成HTML标签解析、破坏页面结构，这里补一个最小转义。
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

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
    <div class="manual-picker"></div>
    <button type="button" class="refresh-manual-btn secondary">刷新列表</button>
    <p class="manual-add-result status"></p>
  </div>

  <h3>本周计划（已保存）</h3>
  <button type="button" class="save-plan-btn">保存</button>
  <p class="save-plan-result status"></p>
  <div class="table-scroll">
  <table class="report-table" style="min-width:1408px">
    <colgroup>
      <col style="width:36px" /><!-- 排序 -->
      <col style="width:40px" /><!-- 模块 -->
      <col style="width:32px" /><!-- 类别 -->
      <col style="width:130px" /><!-- 任务1级 -->
      <col style="width:130px" /><!-- 任务2级 -->
      <col style="width:130px" /><!-- 任务3级 -->
      <col style="width:32px" /><!-- 责任人 -->
      <col style="width:130px" /><!-- 本周交付物 -->
      <col style="width:60px" /><!-- 计划用时 -->
      <col style="width:100px" /><!-- 计划开始 -->
      <col style="width:100px" /><!-- 执行截止 -->
      <col style="width:110px" /><!-- 最终目标交付物 -->
      <col style="width:84px" /><!-- 最终计划完成时间 -->
      <col style="width:84px" /><!-- 优先级 -->
      <col style="width:84px" /><!-- 需协调资源 -->
      <col style="width:40px" /><!-- 重点 -->
      <col style="width:50px" /><!-- 编辑 -->
      <col style="width:36px" /><!-- 删除 -->
    </colgroup>
    <thead>
      <tr>
        <th></th>
        <th>模块</th>
        <th>类别</th>
        <th>任务1级</th>
        <th>任务2级</th>
        <th>任务3级</th>
        <th>责任人</th>
        <th>本周交付物</th>
        <th>计划用时</th>
        <th>计划开始</th>
        <th>执行截止</th>
        <th>最终目标交付物</th>
        <th>最终计划完成时间</th>
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
  // 当前"本周计划"表格里已用到的最大sort_order，新插入的行追加到末尾时用它+1（本地维护，
  // 不用每次插入都额外查一次数据库要max）。loadSavedPlan()整表刷新时重新算一遍。
  let currentMaxSortOrder = 0;

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
    const [projects, existingPlan, prevPlanEntries] = await Promise.all([
      listProjects(),
      listWeeklyTaskEntries(w.id, "plan"),
      previousWeek ? listWeeklyTaskEntries(previousWeek.id, "plan") : Promise.resolve([]),
    ]);

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
    for (const c of filtered) {
      c.detail = detailMap.get(c.task_id) || {};
      c.plan_category = carryOver.has(c.task_id) ? "上周未完成" : "本周新增";
      if (c.module_id == null) c.module_id = defaultModuleId();
      // 2026-07-20新增：这个任务如果上周计划里也出现过，默认沿用上周的用时/交付物/开始
      // 时间/执行截止(3级任务且非最终完成周时交付物文字里的版本号自动+1)，减少重复手填。
      const carryDefaults = computeCarryOverDefaults(c.task_id, prevPlanEntries, c.detail, w);
      if (carryDefaults) {
        c.deliverable_this_week = carryDefaults.deliverable;
        c.suggestedHours = carryDefaults.hours;
        c.suggestedPlanStart = carryDefaults.planStart;
        c.suggestedExecutionDeadline = carryDefaults.executionDeadline;
      }
    }
    // 2026-07-20用户反馈：上周未完成的任务应该排在本周新增前面(手动做PPT时的习惯顺序)。
    // Array.sort是稳定排序，同一类别内部原有的项目遍历顺序不受影响。
    const CATEGORY_ORDER = { 上周未完成: 0, 本周新增: 1 };
    filtered.sort((a, b) => CATEGORY_ORDER[a.plan_category] - CATEGORY_ORDER[b.plan_category]);
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
    // 锁定本身就是"最终确认"动作，点它前先把表格里当前显示的值(不管点没点过"保存")
    // 落库一遍，避免"改了字段但忘了点保存，一锁定这些改动就跟着旧数据被冲掉"这种情况
    try {
      await saveAllPlanRows();
    } catch {
      return; // 保存失败，错误已经显示在save-plan-result里，不要继续往下锁
    }
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

  function priorityOptionsHtml(selected) {
    return PRIORITY_OPTIONS.map(
      ([v, l]) => `<option value="${v}" ${v === (selected || "") ? "selected" : ""}>${l}</option>`
    ).join("");
  }
  // 2026-07-16用户要求：模块/责任人不再在计划/总结表格里做成下拉选择框(这两个字段实际上
  // 长期固定不变，逐行选择纯属浪费空间)，改成settings.html维护的"当前模块"/"当前责任人"
  // (modules.is_current/people.is_current，见sql/0022)，这里只读展示对应任务自己的
  // module_id/owner——真正想改一个任务的模块/责任人，去tasks.html那边改(跟其它"WBS级
  // 静态字段"用同一套"改动请去对应任务详情页"的约定)。defaultModuleId/defaultOwnerName
  // 优先用is_current标记，标记之前退回旧的"候选值只有一个时自动选中"启发式(迁移刚跑完、
  // 用户还没去设置页面点"设为当前"之前，预填功能不应该直接失效)，成为候选池/手动添加
  // 任务时給module_id/owner兜底默认值的唯一来源，跟tasks.js的soleModuleId()/solePersonName()
  // 用同一套优先级规则。
  function moduleNameFor(moduleId) {
    return allModules.find((m) => m.id === moduleId)?.name ?? "";
  }
  function defaultModuleId() {
    return allModules.find((m) => m.is_current)?.id ?? (allModules.length === 1 ? allModules[0].id : null);
  }
  function defaultOwnerName() {
    return allPeople.find((p) => p.is_current)?.name ?? (allPeople.length === 1 ? allPeople[0].name : null);
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
        <td>${moduleNameFor(c.module_id)}</td>
        <td><input type="text" class="f-deliverable" value="${c.deliverable_this_week || ""}" style="width:14em" /></td>
        <td><input type="number" class="f-hours" step="0.5" style="width:4em" value="${c.suggestedHours ?? ""}" /></td>
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
          module_id: c.module_id ?? defaultModuleId(),
          plan_category: c.plan_category,
          owner: c.owner || defaultOwnerName(),
          deliverable_this_week: tr.querySelector(".f-deliverable").value || null,
          planned_hours: tr.querySelector(".f-hours").value || null,
          priority_quadrant: tr.querySelector(".f-priority").value || null,
          plan_start_date: c.suggestedPlanStart ?? null,
          execution_deadline: c.suggestedExecutionDeadline ?? c.execution_deadline ?? null,
          resources_needed: "无",
          sort_order: ++currentMaxSortOrder,
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
      // 2026-07-14用户反馈：这些字段的值(交付物/用时/优先级等)已经在候选池表格里了，不需要
      // 写完之后再整个重新查一遍generateCandidatePool()+loadSavedPlan()才能显示——真正
      // 必须等的只有createWeeklyTaskEntry本身(需要拿到数据库分配的id)，改成并发写入(不再
      // 一条条await)，写完直接用已有数据在本地把新行追加进"本周计划"表格、并从候选池数组
      // 里移除已插入的几条，不用再打两次额外的查询。maybeSetActualStart不影响这里任何
      // 界面显示，不等它完成(fire-and-forget，失败了下次还有机会自动补)。
      const created = await Promise.all(
        toInsert.map(async ({ c, row }) => {
          const entry = await createWeeklyTaskEntry(row);
          maybeSetActualStart(c.task_id, c.actualStartDate, week.meeting_date).catch(() => {});
          return { c, entry };
        })
      );
      resultEl.textContent = `已加入 ${created.length} 条`;
      resultEl.className = "add-result status ok";
      const insertedTaskIds = new Set(toInsert.map(({ c }) => c.task_id));
      candidates = candidates.filter((c) => !insertedTaskIds.has(c.task_id));
      renderCandidates();
      const tbody = root.querySelector(".plan-tbody");
      for (const { c, entry } of created) {
        tbody.appendChild(buildPlanRowElement(entry, c.detail, isPlanLocked()));
      }
    } catch (err) {
      resultEl.textContent = `失败：${err.message}`;
      resultEl.className = "add-result status error";
      // 部分写入部分失败时本地状态可能跟数据库不一致了，稳妥起见老实重新拉一次真实状态
      candidates = await generateCandidatePool(week);
      renderCandidates();
      await loadSavedPlan();
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
      const [carryOver, prevPlanEntries] = await Promise.all([
        computeCarryOverSet(previousWeek),
        previousWeek ? listWeeklyTaskEntries(previousWeek.id, "plan") : Promise.resolve([]),
      ]);
      // 2026-07-20新增：手动添加同样套用跟自动候选池一样的"沿用上周计划字段"逻辑
      const carryDefaults = computeCarryOverDefaults(c.task_id, prevPlanEntries, c.detail, week);
      const row = {
        meeting_week_id: week.id,
        appears_in: "plan",
        task_id: c.task_id,
        module_id: c.module_id ?? defaultModuleId(),
        plan_category: carryOver.has(c.task_id) ? "上周未完成" : "本周新增",
        owner: c.owner || defaultOwnerName(),
        deliverable_this_week: carryDefaults?.deliverable ?? c.deliverable_this_week,
        planned_hours: carryDefaults?.hours ?? null,
        plan_start_date: carryDefaults?.planStart ?? null,
        execution_deadline: carryDefaults?.executionDeadline ?? c.execution_deadline ?? null,
        resources_needed: "无",
        sort_order: ++currentMaxSortOrder,
      };
      const entry = await createWeeklyTaskEntry(row);
      maybeSetActualStart(c.task_id, c.actualStartDate, week.meeting_date).catch(() => {});
      resultEl.textContent = `已添加：${c.label}（可以在下方表格里继续编辑用时/优先级等字段）`;
      resultEl.className = "manual-add-result status ok";
      // 2026-07-14用户反馈：不用为了刷新界面再整个重新查一遍数据——本地直接从候选数组
      // 里摘掉这一条、把新行追加进"本周计划"表格就够了，detail直接复用c.detail(候选池
      // 生成时已经查过一次buildSourceDetailMap，没必要为同一条数据再查一遍)
      manualCandidates = manualCandidates.filter((x) => x.task_id !== c.task_id);
      renderManualPicker();
      root.querySelector(".plan-tbody").appendChild(buildPlanRowElement(entry, c.detail || {}, isPlanLocked()));
    } catch (err) {
      resultEl.textContent = `失败：${err.message}`;
      resultEl.className = "manual-add-result status error";
    }
  }

  root.querySelector(".refresh-manual-btn").addEventListener("click", loadManualCandidates);

  // 抽成独立函数，供loadSavedPlan()整表渲染和"加入本周计划"/"手动搜索添加"两处乐观本地
  // 追加行共用(2026-07-14用户反馈：加入候选后不需要重新整个查一遍数据库，页面上已经有
  // 的信息直接拼出这一行就够了，不然每次点"加入本周计划"都要等好几秒)
  function buildPlanRowElement(e, detail, locked) {
    const dis = locked ? "disabled" : "";
    const tr = document.createElement("tr");
    tr.dataset.entryId = e.id;
    tr.dataset.sortOrder = e.sort_order ?? "";
    tr.innerHTML = `
      <td><div class="sort-cell"><button type="button" class="secondary sort-btn f-up" ${dis} title="上移">↑</button><button type="button" class="secondary sort-btn f-down" ${dis} title="下移">↓</button></div></td>
      <td class="readonly-col">${moduleNameFor(e.module_id)}</td>
      <td class="readonly-col">${e.plan_category || ""}</td>
      <td class="task-col readonly-col">${detail.level1Text || ""}</td>
      <td class="task-col readonly-col">${detail.level2Text || ""}</td>
      <td class="task-col readonly-col">${detail.level3Text || ""}</td>
      <td class="readonly-col">${e.owner || ""}</td>
      <td><textarea class="f-deliverable" rows="2" ${dis}>${escapeHtml(e.deliverable_this_week)}</textarea></td>
      <td><input type="number" class="f-hours" step="0.5" value="${e.planned_hours ?? ""}" ${dis} /></td>
      <td><input type="date" class="f-start" value="${e.plan_start_date || ""}" min="${week.meeting_date}" max="${week.work_week_end || ""}" ${dis} /><br /><span class="f-start-weekday status">${weekdayLabel(e.plan_start_date)}</span></td>
      <td><input type="date" class="f-deadline" value="${e.execution_deadline || ""}" min="${week.meeting_date}" max="${week.work_week_end || ""}" ${dis} /><br /><span class="f-deadline-weekday status">${weekdayLabel(e.execution_deadline)}</span></td>
      <td class="task-col readonly-col">${detail.targetDeliverable || ""}</td>
      <td class="readonly-col">${detail.completionDate || ""}</td>
      <td><select class="f-priority" ${dis}>${priorityOptionsHtml(e.priority_quadrant)}</select></td>
      <td><textarea class="f-resources" rows="2" ${dis}>${escapeHtml(e.resources_needed || "无")}</textarea></td>
      <td><input type="checkbox" class="f-highlight" ${e.highlight ? "checked" : ""} ${dis} /></td>
      <td>${detail.detailUrl ? `<a href="${detail.detailUrl}" target="_blank" rel="noopener">编辑</a>` : ""}</td>
      <td><button type="button" class="secondary delete-x" ${dis} title="删除">×</button></td>
    `;
    // 2026-07-14用户要求：字段改动不再随change事件即时落库，统一改成点整张表格上方的
    // "保存"按钮批量提交(saveAllPlanRows())，跟这里的"删除"这类立即生效的破坏性操作分开
    tr.querySelector(".delete-x").addEventListener("click", async () => {
      await deleteWeeklyTaskEntry(e.id);
      tr.remove();
    });
    tr.querySelector(".f-up").addEventListener("click", () => moveRow(tr, "up"));
    tr.querySelector(".f-down").addEventListener("click", () => moveRow(tr, "down"));
    // 2026-07-20用户反馈：光看日期不知道选的是周几，容易选到假期——纯本地即时更新，不触发保存
    tr.querySelector(".f-start").addEventListener("change", (ev) => {
      tr.querySelector(".f-start-weekday").textContent = weekdayLabel(ev.target.value);
    });
    tr.querySelector(".f-deadline").addEventListener("change", (ev) => {
      tr.querySelector(".f-deadline-weekday").textContent = weekdayLabel(ev.target.value);
    });
    return tr;
  }

  async function loadSavedPlan() {
    if (!week) return;
    root.querySelector(".plan-tbody").innerHTML = `<tr><td colspan="18">加载中...</td></tr>`;
    const entries = await listWeeklyTaskEntries(week.id, "plan");
    const detailMap = await buildSourceDetailMap(entries.map((e) => e.task_id));

    const tbody = root.querySelector(".plan-tbody");
    tbody.innerHTML = "";
    const locked = isPlanLocked();
    root.querySelector(".save-plan-btn").hidden = locked;
    for (const e of entries) {
      const detail = detailMap.get(e.task_id) || {};
      tbody.appendChild(buildPlanRowElement(e, detail, locked));
    }
    currentMaxSortOrder = entries.reduce((m, e) => Math.max(m, e.sort_order ?? 0), 0);
  }

  // 遍历当前表格里所有行，把显示的值一次性批量提交——不逐字段自动保存，改成"填完点保存"
  // 的模式(2026-07-14用户明确要求)。被"锁定本周计划"按钮和独立的"保存"按钮共用。
  async function saveAllPlanRows() {
    const resultEl = root.querySelector(".save-plan-result");
    const rows = [...root.querySelectorAll(".plan-tbody tr[data-entry-id]")];
    if (rows.length === 0) return;
    resultEl.textContent = "保存中...";
    resultEl.className = "save-plan-result status";
    try {
      for (const tr of rows) {
        const entryId = Number(tr.dataset.entryId);
        await updateWeeklyTaskEntry(entryId, {
          deliverable_this_week: tr.querySelector(".f-deliverable").value || null,
          planned_hours: tr.querySelector(".f-hours").value || null,
          plan_start_date: tr.querySelector(".f-start").value || null,
          execution_deadline: tr.querySelector(".f-deadline").value || null,
          priority_quadrant: tr.querySelector(".f-priority").value || null,
          resources_needed: tr.querySelector(".f-resources").value || "无",
          highlight: tr.querySelector(".f-highlight").checked,
        });
      }
      resultEl.textContent = `已保存 ${rows.length} 条`;
      resultEl.className = "save-plan-result status ok";
    } catch (err) {
      resultEl.textContent = `保存失败：${err.message}`;
      resultEl.className = "save-plan-result status error";
      throw err;
    }
  }

  root.querySelector(".save-plan-btn").addEventListener("click", () => {
    saveAllPlanRows().catch(() => {});
  });

  async function setWeek(w, prevWeek) {
    week = w;
    previousWeek = prevWeek;
    candidates = [];
    renderCandidates();
    renderLockUI();
    renderWeekRangeHint();
    await Promise.all([loadSavedPlan(), loadManualCandidates()]);
  }

  // 2026-07-20新增：供shared/taskCreateSection.js"新建任务"表单创建成功后调用，让新任务
  // 立刻能在"手动搜索添加任务"搜索到，不用用户自己点"刷新列表"。
  return { setWeek, refreshManualCandidates: loadManualCandidates };
}
