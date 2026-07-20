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
  buildSourceDetailMap,
  syncTaskStatus,
  computeSyncedTaskStatus,
  SOURCE_STATUS_LABEL,
  listAllActiveCandidates,
} from "./taskLabels.js";
import { validateSummaryEntry } from "./entryValidation.js";
import { renderTaskPicker } from "./taskPicker.js";
import { moveRow } from "./rowReorder.js";

const STATUS_OPTIONS = ["", "已完成", "未完成", "中止", "未启动"];
const RISK_OPTIONS = [
  ["", "(未设置)"],
  ["green", "低"],
  ["yellow", "中"],
  ["red", "高"],
];

// 2026-07-16：本周交付材料/未完成原因/整改措施改用<textarea>多行显示后，插入的是文本节点
// (标签之间)而不是value=""属性——不能再沿用"只在value属性里转义引号"的老习惯，< > &
// 不转义的话会直接被当成HTML标签解析、破坏页面结构，这里补一个最小转义。
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

const TEMPLATE = `
  <p class="no-week-msg status" hidden>没有更早的例会周，跳过"上周总结"。</p>
  <div class="summary-body">
    <div class="lock-bar inline-form">
      <button type="button" class="generate-skeleton-btn">复制上周计划生成总结</button>
      <button type="button" class="lock-btn">锁定本周总结</button>
      <button type="button" class="unlock-btn secondary" hidden>解锁编辑</button>
    </div>
    <p class="skeleton-result status"></p>
    <p class="lock-status status"></p>
    <form class="unlock-form inline-form" hidden>
      <input type="text" class="unlock-note" placeholder="订正说明（本周总结已锁定，说明这次要改什么/为什么）" style="min-width:320px" required />
      <button type="button" class="unlock-confirm-btn">确认订正</button>
      <button type="button" class="unlock-cancel-btn secondary">取消</button>
    </form>

    <div class="review-key-points-block">
      <h3>重点工作完成情况</h3>
      <textarea class="review-key-points" rows="4" placeholder="从工作群例会纪要粘贴，如：&#10;1）重点工作1：未完成。已部分完成xxx，还有yyy未完成。&#10;2）重点工作2：已完成。"></textarea>
      <button type="button" class="review-key-points-save">保存</button>
      <p class="review-key-points-result status"></p>
    </div>

    <div class="unplanned-block">
      <h3>记录计划外完成的任务</h3>
      <div class="unplanned-picker"></div>
      <button type="button" class="refresh-unplanned-btn secondary">刷新列表</button>
      <p class="add-unplanned-result status"></p>
    </div>

    <h3>总结条目</h3>
    <button type="button" class="save-summary-btn">保存</button>
    <p class="save-summary-result status"></p>
    <div class="table-scroll">
    <table class="report-table" style="min-width:1520px">
      <colgroup>
        <col style="width:36px" /><!-- 排序 -->
        <col style="width:40px" /><!-- 模块 -->
        <col style="width:32px" /><!-- 类别 -->
        <col style="width:130px" /><!-- 任务1级 -->
        <col style="width:130px" /><!-- 任务2级 -->
        <col style="width:130px" /><!-- 任务3级 -->
        <col style="width:32px" /><!-- 责任人 -->
        <col style="width:130px" /><!-- 本周交付材料 -->
        <col style="width:90px" /><!-- 完成情况 -->
        <col style="width:60px" /><!-- 实际用时 -->
        <col style="width:110px" /><!-- 未完成原因 -->
        <col style="width:110px" /><!-- 整改措施 -->
        <col style="width:100px" /><!-- 风险(等级+说明) -->
        <col style="width:110px" /><!-- 最终目标交付物 -->
        <col style="width:70px" /><!-- 最终完成情况 -->
        <col style="width:84px" /><!-- 最终计划完成时间 -->
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
          <th>本周交付材料</th>
          <th>完成情况</th>
          <th>实际用时</th>
          <th>未完成原因</th>
          <th>整改措施</th>
          <th>风险</th>
          <th>最终目标交付物</th>
          <th>最终完成情况</th>
          <th>最终计划完成时间</th>
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

export function mountSummarySection(root, { allModules, allPeople }) {
  root.innerHTML = TEMPLATE;

  let week = null;
  let unplannedCandidates = [];
  // 当前"总结条目"表格里已用到的最大sort_order，新插入的行追加到末尾时用它+1(本地维护，
  // 不用每次插入都额外查一次数据库要max)。loadSummary()整表刷新时重新算一遍。
  let currentMaxSortOrder = 0;

  // 2026-07-16用户要求：模块/责任人不再在计划/总结表格里做成下拉选择框(这两个字段实际上
  // 长期固定不变，逐行选择纯属浪费空间)，改成settings.html维护的"当前模块"/"当前责任人"
  // (modules.is_current/people.is_current，见sql/0022)，这里只读展示对应任务自己的
  // module_id/owner——真正想改一个任务的模块/责任人，去tasks.html那边改。defaultModuleId/
  // defaultOwnerName优先用is_current标记，标记之前退回旧的"候选值只有一个时自动选中"
  // 启发式(迁移刚跑完、用户还没去设置页面点"设为当前"之前，预填功能不应该直接失效)，
  // 是记录计划外完成任务/复制上周计划生成骨架时給module_id/owner兜底默认值的唯一来源，
  // 跟tasks.js的soleModuleId()/solePersonName()用同一套优先级规则。
  function moduleNameFor(moduleId) {
    return allModules.find((m) => m.id === moduleId)?.name ?? "";
  }
  function defaultModuleId() {
    return allModules.find((m) => m.is_current)?.id ?? (allModules.length === 1 ? allModules[0].id : null);
  }
  function defaultOwnerName() {
    return allPeople.find((p) => p.is_current)?.name ?? (allPeople.length === 1 ? allPeople[0].name : null);
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
    root.querySelector(".review-key-points").disabled = locked;
    root.querySelector(".review-key-points-save").disabled = locked;
  }

  async function saveReviewKeyPoints() {
    const resultEl = root.querySelector(".review-key-points-result");
    const text = root.querySelector(".review-key-points").value;
    const updated = await updateMeetingWeekFields(week.id, { review_key_points: text || null });
    Object.assign(week, updated);
    if (resultEl) {
      resultEl.textContent = "已保存";
      resultEl.className = "review-key-points-result status ok";
    }
  }
  root.querySelector(".review-key-points-save").addEventListener("click", () => {
    saveReviewKeyPoints().catch((err) => {
      const resultEl = root.querySelector(".review-key-points-result");
      resultEl.textContent = `保存失败：${err.message}`;
      resultEl.className = "review-key-points-result status error";
    });
  });

  root.querySelector(".lock-btn").addEventListener("click", async () => {
    // 锁定是最终确认动作，点它前先把表格里当前显示的值(不管点没点过"保存")落库一遍，
    // 避免"改了字段但忘了点保存，一锁定这些改动就跟着旧数据被冲掉"——重点工作文本框
    // 同理，2026-07-20新增，一并落库。saveAllSummaryRows()现在本身就会做完整的审核校验
    // (entryValidation.js)，校验不过会throw，被下面的catch挡住，不需要再单独查一遍(旧的
    // validateSummaryBeforeLock()已删除，那套字段级校验统一在saveAllSummaryRows()里做，
    // 标红定位到具体输入框，比alert列文字更清楚)。
    try {
      await saveAllSummaryRows();
      await saveReviewKeyPoints();
    } catch {
      return; // 保存失败，错误已经标红+显示在对应的status提示里，不要继续往下锁
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
      // planEntries已经是按sort_order排好的"上周计划"顺序(db.js的listWeeklyTaskEntries)，
      // toCreate原样保留这个相对顺序、依次追加sort_order——这样"总结"里计划内任务的顺序
      // 默认就跟上周计划一致(2026-07-15用户明确要求)，用户之后仍可以用↑/↓单独调整总结的顺序。
      const toCreate = planEntries.filter((p) => !alreadySummarized.has(p.task_id));

      for (const p of toCreate) {
        await createWeeklyTaskEntry({
          meeting_week_id: week.id,
          appears_in: "summary",
          task_id: p.task_id,
          module_id: p.module_id ?? defaultModuleId(),
          summary_category: "计划内",
          owner: p.owner,
          deliverable_this_week: p.deliverable_this_week,
          actual_hours: p.planned_hours,
          highlight: p.highlight,
          sort_order: ++currentMaxSortOrder,
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

  // 抽成独立函数，供loadSummary()整表渲染和"记录计划外完成的任务"乐观本地追加行共用
  // (2026-07-14用户反馈：加入候选后不需要重新整个查一遍数据库，页面上已经有的信息直接
  // 拼出这一行就够了)
  function buildSummaryRowElement(e, detail, locked) {
    const dis = locked ? "disabled" : "";
    const isIncompleteInit = e.status === "未完成";
    const disReason = dis || !isIncompleteInit ? "disabled" : "";
    // 审核功能(2026-07-20)：未完成原因/整改措施/风险等级/风险说明只在"完成情况"选了
    // "未完成"时才必填——required属性跟着disabled状态一起切换(disabled的控件本来就不参与
    // checkValidity()，所以理论上不加required也不会误报，但显式加上更清楚地表达"这四个
    // 字段现在是必填的"，配合下面.f-status的change监听联动更新)。
    const reqReason = !dis && isIncompleteInit ? "required" : "";
    const tr = document.createElement("tr");
    tr.dataset.entryId = e.id;
    tr.dataset.taskId = e.task_id;
    tr.dataset.targetDeliverable = detail.targetDeliverable || "";
    tr.dataset.sortOrder = e.sort_order ?? "";
    tr.innerHTML = `
      <td><div class="sort-cell"><button type="button" class="secondary sort-btn f-up" ${dis} title="上移">↑</button><button type="button" class="secondary sort-btn f-down" ${dis} title="下移">↓</button></div></td>
      <td class="readonly-col">${moduleNameFor(e.module_id)}</td>
      <td class="readonly-col">${e.summary_category || ""}</td>
      <td class="task-col readonly-col">${detail.level1Text || ""}</td>
      <td class="task-col readonly-col">${detail.level2Text || ""}</td>
      <td class="task-col readonly-col">${detail.level3Text || ""}</td>
      <td class="readonly-col">${e.owner || ""}</td>
      <td><textarea class="f-deliverable" rows="2" required ${dis}>${escapeHtml(e.deliverable_this_week)}</textarea></td>
      <td><select class="f-status" required ${dis}>${statusOptionsHtml(e.status)}</select></td>
      <td><input type="number" class="f-hours" step="0.5" min="0" required value="${e.actual_hours ?? ""}" ${dis} /></td>
      <td><textarea class="f-reason" rows="2" ${reqReason} ${disReason}>${escapeHtml(e.incomplete_reason)}</textarea></td>
      <td><textarea class="f-rectify" rows="2" ${reqReason} ${disReason}>${escapeHtml(e.rectification_measures)}</textarea></td>
      <td><select class="f-risk" ${reqReason} ${disReason}>${riskOptionsHtml(e.risk_level)}</select><textarea class="f-risk-note" rows="2" placeholder="风险说明" ${reqReason} ${disReason}>${escapeHtml(e.risk_note)}</textarea></td>
      <td class="task-col readonly-col target-deliverable-col">${detail.targetDeliverable || ""}</td>
      <td class="readonly-col source-status-col">${detail.sourceStatus || ""}</td>
      <td class="readonly-col completion-date-col">${detail.completionDate || ""}</td>
      <td><input type="checkbox" class="f-highlight" ${e.highlight ? "checked" : ""} ${dis} /></td>
      <td>${detail.detailUrl ? `<a href="${detail.detailUrl}" target="_blank" rel="noopener">编辑</a>` : ""}</td>
      <td><button type="button" class="secondary delete-x" ${dis} title="删除">×</button></td>
    `;
    // 2026-07-14用户要求：字段改动不再随change事件即时落库，统一改成点整张表格上方的
    // "保存"按钮批量提交(saveAllSummaryRows())。"完成情况"这个下拉是唯一例外——它变化时
    // 要马上切换"未完成原因/整改措施/风险等级/风险说明"这四个字段是否可编辑(纯本地UI状态，不涉及
    // 网络请求)，所以单独保留一个change监听，但只做本地disabled切换，不再触发保存/
    // 整表reload(reload会把其他还没点保存的行的改动一起冲掉)。required属性同步跟着切换。
    tr.querySelector(".f-status").addEventListener("change", () => {
      const isIncomplete = tr.querySelector(".f-status").value === "未完成";
      const reasonDisabled = !!dis || !isIncomplete;
      for (const sel of [".f-reason", ".f-rectify", ".f-risk", ".f-risk-note"]) {
        const el = tr.querySelector(sel);
        el.disabled = reasonDisabled;
        el.required = !reasonDisabled;
      }
    });
    tr.querySelector(".delete-x").addEventListener("click", async () => {
      await deleteWeeklyTaskEntry(e.id);
      tr.remove();
      await loadUnplannedCandidates();
    });
    tr.querySelector(".f-up").addEventListener("click", () => moveRow(tr, "up"));
    tr.querySelector(".f-down").addEventListener("click", () => moveRow(tr, "down"));
    return tr;
  }

  async function loadSummary() {
    if (!week) return;
    root.querySelector(".summary-tbody").innerHTML = `<tr><td colspan="19">加载中...</td></tr>`;
    const entries = await listWeeklyTaskEntries(week.id, "summary");
    const detailMap = await buildSourceDetailMap(entries.map((e) => e.task_id));

    const tbody = root.querySelector(".summary-tbody");
    tbody.innerHTML = "";
    const locked = isSummaryLocked();
    root.querySelector(".save-summary-btn").hidden = locked;
    for (const e of entries) {
      const detail = detailMap.get(e.task_id) || {};
      tbody.appendChild(buildSummaryRowElement(e, detail, locked));
    }
    currentMaxSortOrder = entries.reduce((m, e) => Math.max(m, e.sort_order ?? 0), 0);
  }

  // 遍历当前表格里所有行，把显示的值一次性批量提交——不逐字段自动保存，改成"填完点保存"
  // 的模式(2026-07-14用户明确要求)。被"锁定本周总结"按钮和独立的"保存"按钮共用。
  // 2026-07-20新增审核功能：写库前先跑一遍entryValidation.js的规则校验，有问题就标红对应
  // 输入框/列、不写库、直接throw——校验规则本身(必填/用时非负/跨页面字段缺失，以及用户
  // 根据实际开会经验总结的交付物一致性规则E1/E3/E4/E5/E6)见
  // tools/.claude/plans/plan-audit-rules-v1.md。E3/E4需要这一周(week.id，即previousWeek)
  // 对应的PLAN条目做比对基准。
  async function saveAllSummaryRows() {
    const resultEl = root.querySelector(".save-summary-result");
    const rows = [...root.querySelectorAll(".summary-tbody tr[data-entry-id]")];
    if (rows.length === 0) return;
    resultEl.textContent = "保存中...";
    resultEl.className = "save-summary-result status";
    root.querySelectorAll(".field-error").forEach((el) => el.classList.remove("field-error"));
    const taskIds = rows.map((tr) => Number(tr.dataset.taskId));
    const [detailMap, planEntries] = await Promise.all([
      buildSourceDetailMap(taskIds),
      listWeeklyTaskEntries(week.id, "plan"),
    ]);
    const planByTaskId = new Map(planEntries.map((p) => [p.task_id, p]));

    let errorCount = 0;
    for (const tr of rows) {
      const taskId = Number(tr.dataset.taskId);
      const detail = detailMap.get(taskId) || {};
      const errors = validateSummaryEntry(tr, detail, planByTaskId.get(taskId));
      for (const { field } of errors) {
        const el = tr.querySelector(`.${field}`);
        if (el) el.classList.add("field-error");
        errorCount++;
      }
    }
    if (errorCount > 0) {
      resultEl.textContent = `保存失败：${errorCount}处错误，已用红色标出，请修正后重新保存`;
      resultEl.className = "save-summary-result status error";
      throw new Error("校验未通过");
    }

    try {
      for (const tr of rows) {
        const entryId = Number(tr.dataset.entryId);
        const taskId = Number(tr.dataset.taskId);
        const targetDeliverable = tr.dataset.targetDeliverable || "";
        const status = tr.querySelector(".f-status").value || null;
        const isIncomplete = status === "未完成";
        const deliverableThisWeek = tr.querySelector(".f-deliverable").value || null;
        await updateWeeklyTaskEntry(entryId, {
          deliverable_this_week: deliverableThisWeek,
          actual_hours: tr.querySelector(".f-hours").value || null,
          status,
          incomplete_reason: isIncomplete ? tr.querySelector(".f-reason").value || null : null,
          rectification_measures: isIncomplete ? tr.querySelector(".f-rectify").value || null : null,
          risk_level: isIncomplete ? tr.querySelector(".f-risk").value || null : null,
          risk_note: isIncomplete ? tr.querySelector(".f-risk-note").value || null : null,
          highlight: tr.querySelector(".f-highlight").checked,
        });
        if (status) {
          // "已完成"不等于任务本身最终完成——本周交付材料要跟最终目标交付物文字严格相等
          // (去首尾空格)才算数，复杂任务允许跨周分批交付，见taskLabels.js的syncTaskStatus注释。
          const isFinal = !!(targetDeliverable && deliverableThisWeek && deliverableThisWeek.trim() === targetDeliverable.trim());
          await syncTaskStatus(taskId, status, { isFinal });
          // 2026-07-16用户反馈：这一步在数据库里确实正确写入了，但表格里"最终完成情况"这一格
          // 显示的还是保存前的旧值(saveAllSummaryRows()本来就不会整表reload，见上面注释)，
          // 看起来像"没有自动判断"。用跟syncTaskStatus()完全同一套判断逻辑(computeSyncedTaskStatus，
          // 避免两处逻辑各写一份、以后改一边忘了改另一边)在本地算出新状态，直接刷新这个只读格，
          // 不用为了刷新这一个字段专门重新查一次数据库。
          const newStatus = computeSyncedTaskStatus(status, { isFinal });
          const sourceStatusEl = tr.querySelector(".source-status-col");
          if (newStatus && sourceStatusEl) {
            sourceStatusEl.textContent = SOURCE_STATUS_LABEL[newStatus] ?? newStatus;
          }
        }
      }
      resultEl.textContent = `已保存 ${rows.length} 条`;
      resultEl.className = "save-summary-result status ok";
    } catch (err) {
      resultEl.textContent = `保存失败：${err.message}`;
      resultEl.className = "save-summary-result status error";
      throw err;
    }
  }

  root.querySelector(".save-summary-btn").addEventListener("click", () => {
    saveAllSummaryRows().catch(() => {});
  });

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
      const row = {
        meeting_week_id: week.id,
        appears_in: "summary",
        task_id: c.task_id,
        module_id: c.module_id ?? defaultModuleId(),
        summary_category: "计划外",
        owner: c.owner || defaultOwnerName(),
        deliverable_this_week: c.deliverable_this_week,
        sort_order: ++currentMaxSortOrder,
      };
      const entry = await createWeeklyTaskEntry(row);
      resultEl.textContent = `已添加：${c.label}`;
      resultEl.className = "add-unplanned-result status ok";
      // 2026-07-14用户反馈：不用为了刷新界面再整个重新查一遍数据——本地直接从候选数组里
      // 摘掉这一条、把新行追加进"总结条目"表格就够了，detail直接复用c.detail(listAllActiveCandidates
      // 已经查过一次buildSourceDetailMap，没必要为同一条数据再查一遍)
      unplannedCandidates = unplannedCandidates.filter((x) => x.task_id !== c.task_id);
      renderUnplannedPicker();
      root.querySelector(".summary-tbody").appendChild(buildSummaryRowElement(entry, c.detail || {}, isSummaryLocked()));
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
    root.querySelector(".review-key-points").value = week.review_key_points ?? "";
    root.querySelector(".review-key-points-result").textContent = "";
    renderLockUI();
    await loadSummary();
    await loadUnplannedCandidates();
  }

  // 2026-07-20新增：供shared/taskCreateSection.js"新建任务"表单创建成功后调用，让新任务
  // 立刻能在"记录计划外完成的任务"搜索到，不用用户自己点"刷新列表"。
  return { setWeek, refreshUnplannedCandidates: loadUnplannedCandidates };
}
