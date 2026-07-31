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
  wbsNumber,
} from "./taskLabels.js";
import { validateSummaryEntry } from "./entryValidation.js";
import { renderTaskPicker } from "./taskPicker.js";
import { moveRow } from "./rowReorder.js";
import { DELIVERABLE_TYPE_OPTIONS } from "./deliverableScreenshot.js";

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
    </div>
    <p class="skeleton-result status"></p>

    <div class="review-key-points-block">
      <h3>重点工作完成情况</h3>
      <textarea class="review-key-points" rows="4" placeholder="从工作群例会纪要粘贴，如：&#10;1）重点工作1：未完成。已部分完成xxx，还有yyy未完成。&#10;2）重点工作2：已完成。"></textarea>
      <button type="button" class="review-key-points-save">保存</button>
      <p class="review-key-points-result status"></p>
    </div>

    <div class="review-remarks-block">
      <h3>备注</h3>
      <textarea class="review-remarks" rows="3" placeholder="对之前计划有改动等需要说明的情况，不是每次都要填"></textarea>
      <button type="button" class="review-remarks-save">保存</button>
      <p class="review-remarks-result status"></p>
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
  // "交付物类型"下拉——供"交付物文件夹截图"功能挑选图标用(见shared/deliverableScreenshot.js)。
  // 唯一权威选项列表定义在那个模块里，这里直接复用，不重复维护一份容易走样的选项。
  function deliverableTypeOptionsHtml(selected) {
    return DELIVERABLE_TYPE_OPTIONS.map(
      (t) => `<option value="${t.value}" ${t.value === (selected || "") ? "selected" : ""}>${t.label}</option>`
    ).join("");
  }

  // 2026-07-31：锁定/解锁的UI+快照写入统一挪到index.js的页面级"锁定"控制(一次点击同时锁定
  // 本周计划+上周总结，见plan-unified-lock-compact-view.md)——原来这里的.lock-btn/
  // .unlock-btn/.unlock-form整块markup+事件监听(含快照写入)、以及renderLockUI()disable
  // 重点工作/备注文本框那部分都删掉了：已锁定的周现在index.js会整个隐藏editable-view
  // (这个区块所在的容器)，不需要再对区块内单个字段做disabled。isSummaryLocked()保留：
  // 生成PPT时previousWeek.summary_locked_at仍然要读，且理论上不会再被这个文件内部
  // 触发true(setWeek()以后只会在index.js确认未锁定时才被调用)，保留作为防御性兜底。
  function isSummaryLocked() {
    return !!week?.summary_locked_at;
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

  // 2026-07-20新增：对应PPT"周工作计划复核情况"表格的"备注"列——用户手动填写(跟"重点工作
  // 完成情况"同一种模式，不是从"解锁编辑"那套强制订正说明(plan_amendment_note/
  // summary_amendment_note)里自动带过来的，跟用户确认过是两回事：订正说明是"改已锁定数据
  // 时被迫填的一句话"，这里是"每周都可以自由写、不是每次都要填"的备注，语义更宽松)。
  async function saveReviewRemarks() {
    const resultEl = root.querySelector(".review-remarks-result");
    const text = root.querySelector(".review-remarks").value;
    const updated = await updateMeetingWeekFields(week.id, { review_remarks: text || null });
    Object.assign(week, updated);
    if (resultEl) {
      resultEl.textContent = "已保存";
      resultEl.className = "review-remarks-result status ok";
    }
  }
  root.querySelector(".review-remarks-save").addEventListener("click", () => {
    saveReviewRemarks().catch((err) => {
      const resultEl = root.querySelector(".review-remarks-result");
      resultEl.textContent = `保存失败：${err.message}`;
      resultEl.className = "review-remarks-result status error";
    });
  });

  // 2026-07-31：供index.js页面级统一"锁定"按钮调用——把原来.lock-btn点击处理器里"落库"
  // 那部分(saveAllSummaryRows+两个review字段的保存)抽出来，快照写入+真正设置
  // summary_locked_at的部分交给index.js统一做(同时处理targetWeek的plan/stopped)。
  // 这里必须判空：previousWeek可能是null(系统里最早一周，没有更早的周可总结)，这时候
  // week也是null，saveReviewKeyPoints()/saveReviewRemarks()内部都是直接
  // updateMeetingWeekFields(week.id,...)，不判空会崩——这是design review阶段发现的真实
  // gap：原来的锁定按钮只在.summary-body可见(即week非空)时才可能被点到，现在从页面级
  // 统一按钮触发，不再有这层隐式保护。
  async function prepareForLock() {
    if (!week) return;
    await saveAllSummaryRows();
    await saveReviewKeyPoints();
    await saveReviewRemarks();
  }

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

  // 2026-07-31新增：记录每一行"加载/上次保存成功时"的字段原始值，供saveAllSummaryRows()
  // 判断"这一行到底有没有真的被改动过"——见该函数内部注释，修复的是一个真实的数据损坏bug
  // (持续多周的任务，只要任意一周的总结表格被保存，哪怕这一行完全没被动过，也会被强制
  // 重新计算一次任务的最终完成状态，用这一周自己的数据覆盖掉可能是"更晚一周"已经正确算出
  // 的"已完成"状态)。用WeakMap(键是tr元素本身)而不是按entryId存的Map，行被删除后自动
  // 失效，不用额外清理。
  const rowOriginals = new WeakMap();
  function snapshotRowValues(tr) {
    return {
      deliverable_this_week: tr.querySelector(".f-deliverable").value,
      deliverable_file_type: tr.querySelector(".f-deliverable-type").value,
      status: tr.querySelector(".f-status").value,
      actual_hours: tr.querySelector(".f-hours").value,
      incomplete_reason: tr.querySelector(".f-reason").value,
      rectification_measures: tr.querySelector(".f-rectify").value,
      risk_level: tr.querySelector(".f-risk").value,
      risk_note: tr.querySelector(".f-risk-note").value,
      highlight: tr.querySelector(".f-highlight").checked,
    };
  }
  function rowValuesChanged(tr) {
    const original = rowOriginals.get(tr);
    if (!original) return true; // 没记录过原始值(理论上不会发生，保险起见当作"改过"处理)
    const current = snapshotRowValues(tr);
    return Object.keys(current).some((k) => current[k] !== original[k]);
  }

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
      <td><textarea class="f-deliverable" rows="2" required ${dis}>${escapeHtml(e.deliverable_this_week)}</textarea><select class="f-deliverable-type" ${dis}>${deliverableTypeOptionsHtml(e.deliverable_file_type)}</select></td>
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
    rowOriginals.set(tr, snapshotRowValues(tr)); // 记录这一行刚渲染出来时的字段值，供保存时判断"有没有真的被改过"
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
  // 2026-07-20新增审核功能：写库前先跑一遍entryValidation.js的规则校验，校验不过的行标红
  // 对应输入框/列+不写库；校验通过的行照常保存——不因为某一行有错就把其它已经填好的行也
  // 一起拦住(2026-07-20用户反馈：避免"改了好几行，其中一行有个小错，结果全部没保存"这种
  // 丢填写进度的情况)。只要有任意一行没通过，最后仍然throw，"锁定"按钮的调用方会因此
  // 中止锁定流程。校验规则本身(必填/用时非负/跨页面字段缺失，以及用户根据实际开会经验
  // 总结的交付物一致性规则E1/E3/E4/E5/E6)见tools/.claude/plans/plan-audit-rules-v1.md。
  // E3/E4需要这一周(week.id，即previousWeek)对应的PLAN条目做比对基准。
  async function saveAllSummaryRows() {
    const resultEl = root.querySelector(".save-summary-result");
    const rows = [...root.querySelectorAll(".summary-tbody tr[data-entry-id]")];
    if (rows.length === 0) return;
    resultEl.textContent = "保存中...";
    resultEl.className = "save-summary-result status";
    root.querySelectorAll(".field-error").forEach((el) => {
      el.classList.remove("field-error");
      el.removeAttribute("title");
    });
    const taskIds = rows.map((tr) => Number(tr.dataset.taskId));
    const [detailMap, planEntries] = await Promise.all([
      buildSourceDetailMap(taskIds),
      listWeeklyTaskEntries(week.id, "plan"),
    ]);
    const planByTaskId = new Map(planEntries.map((p) => [p.task_id, p]));

    // 2026-07-20用户反馈：①只标红+报"N处错误"，看不出具体错在哪——除了标红，还要把每条
    // 错误的具体原因列出来，把原因也写进对应输入框的title属性(hover能看到)；②错误提示不
    // 用重复整条任务描述，用裸编号(wbsNumber，比如"80.3")定位是哪一行就够了，措辞要简洁；
    // ③校验没通过的行不保存，但不能连累其它没问题的行——这里先分好"能保存"和"不能保存"
    // 两组，再各自处理。
    const validRows = [];
    const problemLines = [];
    for (const tr of rows) {
      const taskId = Number(tr.dataset.taskId);
      const detail = detailMap.get(taskId) || {};
      const errors = validateSummaryEntry(tr, detail, planByTaskId.get(taskId));
      if (errors.length === 0) {
        validRows.push(tr);
        continue;
      }
      const label = wbsNumber(detail.level1, detail.level2, detail.level3);
      for (const { field, message } of errors) {
        const el = tr.querySelector(`.${field}`);
        if (el) {
          el.classList.add("field-error");
          el.title = el.title ? `${el.title}\n${message}` : message;
        }
        problemLines.push(`${label}：${message}`);
      }
    }

    // 2026-07-31修复一个真实的数据损坏bug：持续多周的任务，只要任意一周的总结表格被
    // "保存"，哪怕这一行完全没被改动过，也会走到下面的syncTaskStatus()、用这一周自己的
    // 数据重新计算一次任务的最终完成状态——如果这个任务在"更晚一周"已经被正确判定"已完成"，
    // 这一步会用"更早一周"(此刻还没到最终交付、isFinal天然是false)的数据把它覆盖回"未完成"。
    // 用户实测到"持续2周的任务最终完成情况被莫名改回未完成"就是这个原因触发的——不是这次
    // 新功能直接写坏的，是"保存"从来没区分过"这一行真的被改了"还是"只是恰好在同一张表格里"
    // 这个早就存在的设计缺陷，被这次测试新流程时save了一张包含这类任务、但当时还没锁定的
    // 历史周表格意外触发了。跳过没有真的被改动过的行——不写库、不调用syncTaskStatus，从根上
    // 避免"点保存牵连同一张表格里其他没被动过的任务"。
    let skippedUnchanged = 0;
    try {
      for (const tr of validRows) {
        if (!rowValuesChanged(tr)) {
          skippedUnchanged++;
          continue;
        }
        const entryId = Number(tr.dataset.entryId);
        const taskId = Number(tr.dataset.taskId);
        const targetDeliverable = tr.dataset.targetDeliverable || "";
        const status = tr.querySelector(".f-status").value || null;
        const isIncomplete = status === "未完成";
        const deliverableThisWeek = tr.querySelector(".f-deliverable").value || null;
        await updateWeeklyTaskEntry(entryId, {
          deliverable_this_week: deliverableThisWeek,
          deliverable_file_type: tr.querySelector(".f-deliverable-type").value || null,
          actual_hours: tr.querySelector(".f-hours").value || null,
          status,
          incomplete_reason: isIncomplete ? tr.querySelector(".f-reason").value || null : null,
          rectification_measures: isIncomplete ? tr.querySelector(".f-rectify").value || null : null,
          risk_level: isIncomplete ? tr.querySelector(".f-risk").value || null : null,
          risk_note: isIncomplete ? tr.querySelector(".f-risk-note").value || null : null,
          highlight: tr.querySelector(".f-highlight").checked,
        });
        rowOriginals.set(tr, snapshotRowValues(tr)); // 写成功后更新"原始值"基准，避免下次保存又被当成"改过"重新处理一遍
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
    } catch (err) {
      resultEl.textContent = `已保存部分行时失败：${err.message}`;
      resultEl.className = "save-summary-result status error";
      throw err;
    }

    const skippedNote = skippedUnchanged > 0 ? `（其中${skippedUnchanged}条未改动，跳过写入）` : "";
    if (problemLines.length > 0) {
      resultEl.textContent =
        validRows.length === 0
          ? `保存失败，${problemLines.length}处未通过校验（已标红，鼠标悬停可看原因）：\n${problemLines.join("\n")}`
          : `已保存${validRows.length}条${skippedNote}，另有${problemLines.length}处未通过校验没有保存（已标红，鼠标悬停可看原因）：\n${problemLines.join("\n")}`;
      resultEl.className = "save-summary-result status error";
      throw new Error("部分行未通过校验");
    }

    resultEl.textContent = `已保存 ${validRows.length} 条${skippedNote}`;
    resultEl.className = "save-summary-result status ok";
  }

  root.querySelector(".save-summary-btn").addEventListener("click", () => {
    saveAllSummaryRows().catch(() => {});
  });

  function renderUnplannedPicker() {
    renderTaskPicker(root.querySelector(".unplanned-picker"), unplannedCandidates, addUnplannedTask);
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

  // 2026-07-31：抽成独立命名函数并显式返回true/false(不是throw)——taskPicker.js的onPick
  // 调用点没有await/catch，如果改成throw会在picker触发时产生未处理的promise rejection；
  // stoppedSection.js"添加到上周总结"按钮(新增，见plan-locked-week-ppt-snapshot.md)需要
  // 知道这次添加到底成不成功。
  async function addUnplannedTask(c) {
    const resultEl = root.querySelector(".add-unplanned-result");
    if (isSummaryLocked()) {
      resultEl.textContent = "本周总结已锁定，请先解锁再添加";
      resultEl.className = "add-unplanned-result status warn";
      return false;
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
      return true;
    } catch (err) {
      resultEl.textContent = `失败：${err.message}`;
      resultEl.className = "add-unplanned-result status error";
      return false;
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
    root.querySelector(".review-remarks").value = week.review_remarks ?? "";
    root.querySelector(".review-remarks-result").textContent = "";
    await loadSummary();
    await loadUnplannedCandidates();
  }

  // 2026-07-20新增：供shared/taskCreateSection.js"新建任务"表单创建成功后调用，让新任务
  // 立刻能在"记录计划外完成的任务"搜索到，不用用户自己点"刷新列表"。2026-07-31新增
  // addUnplannedTask：供shared/stoppedSection.js"添加到上周总结"按钮调用；prepareForLock：
  // 供index.js页面级统一锁定按钮调用。
  return { setWeek, refreshUnplannedCandidates: loadUnplannedCandidates, addUnplannedTask, prepareForLock };
}
