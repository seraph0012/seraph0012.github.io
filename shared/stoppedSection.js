// "未启动/中止工作"表格挂载函数，供index.js跟summarySection.js/planSection.js并列挂载。
// 2026-07-20新增，同日晚些时候用户重新设计——此前网页上完全没有UI能创建appears_in='stopped'的
// weekly_task_entries，PPT这一张表一直是空的；pptGenerate.js/db.js那半边其实早就支持，缺的
// 是网页录入入口。**第一版**(复制上周+手动搜索添加+选"未启动"或"中止")被用户推翻——用户
// 指出这张表的真实语义是"自动列出所有状态为中止的任务"，不需要按周维护/复制：①"未启动"
// 不该出现在这张表——如果以后把年度计划全部导入，未启动的任务会非常多，这张表会被刷屏，
// "未启动"这个状态本身在这张PPT表格设计之初只是为了"新添加的一系列任务"这个特定场景，
// 不适合作为通用规则；②任务状态变成"中止"这件事只应该发生在别的地方(tasks.html详情面板
// 的"标记中止"按钮)，这张表不该有自己的一套"选任务+指定状态"的添加流程，它只是把"当前
// 所有中止任务"这个查询结果同步进本周的weekly_task_entries(仍然是按周存储，因为需协调
// 资源/重点这些字段还是要能逐周编辑，且PPT本来就是读某一周的appears_in='stopped'数据)。
//
// 操作对象是targetWeek(变量名就叫week)。锁定语义：不自建锁定/解锁按钮，只读态直接跟随
// week.plan_locked_at——跟"本周计划"共享同一个"这周定稿了没有"语义。
import {
  listWeeklyTaskEntries,
  createWeeklyTaskEntry,
  updateWeeklyTaskEntry,
  deleteWeeklyTaskEntry,
  updateTask,
} from "./db.js";
import { buildSourceDetailMap, listStoppedTasks } from "./taskLabels.js";
import { moveRow } from "./rowReorder.js";

// 需协调资源是这张表唯一的自由文本字段，沿用其它表格的textarea+转义模式，避免<>&被当成
// HTML解析。
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

const TEMPLATE = `
  <p class="stopped-lock-status status"></p>
  <div class="lock-bar inline-form">
    <button type="button" class="refresh-stopped-btn">刷新（搜索所有中止任务）</button>
    <button type="button" class="save-stopped-btn">保存</button>
  </div>
  <p class="refresh-stopped-result status"></p>
  <p class="save-stopped-result status"></p>
  <p class="stopped-action-result status"></p>
  <div class="table-scroll">
  <table class="report-table" style="min-width:1080px">
    <colgroup>
      <col style="width:36px" /><!-- 排序 -->
      <col style="width:40px" /><!-- 模块 -->
      <col style="width:130px" /><!-- 任务1级 -->
      <col style="width:130px" /><!-- 任务2级 -->
      <col style="width:130px" /><!-- 任务3级 -->
      <col style="width:40px" /><!-- 责任人 -->
      <col style="width:70px" /><!-- 状态 -->
      <col style="width:160px" /><!-- 需协调资源 -->
      <col style="width:40px" /><!-- 重点 -->
      <col style="width:90px" /><!-- 续做 -->
      <col style="width:90px" /><!-- 补记总结 -->
      <col style="width:50px" /><!-- 编辑 -->
      <col style="width:36px" /><!-- 删除 -->
    </colgroup>
    <thead>
      <tr>
        <th></th>
        <th>模块</th>
        <th>任务1级</th>
        <th>任务2级</th>
        <th>任务3级</th>
        <th>责任人</th>
        <th>状态</th>
        <th>需协调资源</th>
        <th>重点</th>
        <th></th>
        <th></th>
        <th></th>
        <th></th>
      </tr>
    </thead>
    <tbody class="stopped-tbody"></tbody>
  </table>
  </div>
`;

const TABLE_COLSPAN = 13;

export function mountStoppedSection(root, { allModules, onAddToPlan, onAddToSummary }) {
  root.innerHTML = TEMPLATE;

  let week = null; // targetWeek
  let previousWeek = null; // 供"添加到上周总结"用——这个应用里"总结"固定指previousWeek
  let currentMaxSortOrder = 0;

  function moduleNameFor(moduleId) {
    return allModules.find((m) => m.id === moduleId)?.name ?? "";
  }

  function isLocked() {
    return !!week?.plan_locked_at;
  }

  function renderLockHint() {
    const el = root.querySelector(".stopped-lock-status");
    el.textContent = isLocked() ? '🔒 本周计划已锁定，这张表跟"本周计划"共享锁定状态——需要编辑请先去"本周计划"区块解锁' : "";
    el.className = isLocked() ? "stopped-lock-status status warn" : "stopped-lock-status status";
  }

  // 2026-07-31新增：中止后又决定继续做的"续做"入口，直接放在这张表每一行上，不需要用户
  // 再去②/①区块搜索(那条路径被用户否决，见plan-locked-week-ppt-snapshot.md)。
  // "添加到本周计划"：把任务状态从stopped改回in_progress(深思熟虑的显式动作，跟"标记中止"
  // 按钮同构，不违反"状态只能被动同步"的原则)，再调用onAddToPlan(candidate)把这一行插入
  // targetWeek的计划表格(复用planSection.js的addTaskManually，跟"手动搜索添加任务"走
  // 完全相同的逻辑)。
  async function handleAddToPlan(candidate, btn) {
    const resultEl = root.querySelector(".stopped-action-result");
    btn.disabled = true;
    resultEl.textContent = "添加中...";
    resultEl.className = "stopped-action-result status";
    try {
      await updateTask(candidate.task_id, { status: "in_progress" });
    } catch (err) {
      btn.disabled = false;
      resultEl.textContent = `更新任务状态失败：${err.message}`;
      resultEl.className = "stopped-action-result status error";
      return;
    }
    const ok = await onAddToPlan(candidate);
    if (ok) {
      btn.textContent = "已添加";
      resultEl.textContent = `已把「${candidate.label}」重新排入本周计划，任务状态改回"进行中"（详见②本周计划区块）`;
      resultEl.className = "stopped-action-result status ok";
    } else {
      btn.disabled = false;
      resultEl.textContent = `添加到本周计划失败，详见②本周计划区块的提示`;
      resultEl.className = "stopped-action-result status error";
    }
  }

  // "添加到上周总结"：只是把这一行补记进previousWeek的总结(summary_category自动判定"计划
  // 外"，完成情况留空)，不在这一步改任务状态——用户还要去①区块把完成情况/交付材料填完整，
  // 走一遍既有的"完成情况=已完成+交付材料文字跟最终目标一致才会同步状态"流程，才能把任务
  // 状态从stopped纠正成done。
  async function handleAddToSummary(candidate, btn) {
    const resultEl = root.querySelector(".stopped-action-result");
    btn.disabled = true;
    resultEl.textContent = "添加中...";
    resultEl.className = "stopped-action-result status";
    const ok = await onAddToSummary(candidate);
    if (ok) {
      btn.textContent = "已添加";
      resultEl.textContent = `已把「${candidate.label}」补记到上周总结，请去"①上周总结"区块填写完成情况`;
      resultEl.className = "stopped-action-result status ok";
    } else {
      btn.disabled = false;
      resultEl.textContent = `添加到上周总结失败，详见①上周总结区块的提示`;
      resultEl.className = "stopped-action-result status error";
    }
  }

  // 状态列是纯展示(detail.sourceStatus，从任务自身status反查而来)——这张表里出现的每一行
  // 按定义都应该是"中止"，这一列的作用是给个直观核对(万一某行的任务后来被手动改回了别的
  // 状态、还没被清理掉，这里能看出"这行数据可能过期了，该删")。candidate是listStoppedTasks()
  // 里跟这一行task_id匹配的taskCandidateFields形状数据，供"续做"两个按钮直接使用；如果这行
  // 对应的任务当前已经不是"中止"状态了(candidate为空，即上面说的"过期"情况)，两个续做按钮
  // 直接disabled，不提供continue的入口(数据已经不新鲜，不该再基于它做添加动作)。
  function buildStoppedRowElement(e, detail, locked, candidate) {
    const dis = locked ? "disabled" : "";
    const canAct = !!candidate;
    const planBtnDis = dis || (canAct ? "" : "disabled");
    const summaryBtnDis = dis || (canAct ? "" : "disabled");
    const tr = document.createElement("tr");
    tr.dataset.entryId = e.id;
    tr.dataset.taskId = e.task_id;
    tr.dataset.sortOrder = e.sort_order ?? "";
    tr.innerHTML = `
      <td><div class="sort-cell"><button type="button" class="secondary sort-btn f-up" ${dis} title="上移">↑</button><button type="button" class="secondary sort-btn f-down" ${dis} title="下移">↓</button></div></td>
      <td class="readonly-col">${moduleNameFor(e.module_id)}</td>
      <td class="task-col readonly-col">${detail.level1Text || ""}</td>
      <td class="task-col readonly-col">${detail.level2Text || ""}</td>
      <td class="task-col readonly-col">${detail.level3Text || ""}</td>
      <td class="readonly-col">${e.owner || ""}</td>
      <td class="readonly-col">${detail.sourceStatus || ""}</td>
      <td><textarea class="f-resources" rows="2" ${dis}>${escapeHtml(e.resources_needed || "无")}</textarea></td>
      <td><input type="checkbox" class="f-highlight" ${e.highlight ? "checked" : ""} ${dis} /></td>
      <td><button type="button" class="secondary add-to-plan-btn" ${planBtnDis} title="中止后又决定继续做——重新排入本周计划，任务状态改回进行中">→本周计划</button></td>
      <td>${previousWeek ? `<button type="button" class="secondary add-to-summary-btn" ${summaryBtnDis} title="补记到上周总结，作为计划外完成的任务">→上周总结</button>` : ""}</td>
      <td>${detail.detailUrl ? `<a href="${detail.detailUrl}" target="_blank" rel="noopener">编辑</a>` : ""}</td>
      <td><button type="button" class="secondary delete-x" ${dis} title="删除">×</button></td>
    `;
    tr.querySelector(".delete-x").addEventListener("click", async () => {
      await deleteWeeklyTaskEntry(e.id);
      tr.remove();
    });
    tr.querySelector(".f-up").addEventListener("click", () => moveRow(tr, "up"));
    tr.querySelector(".f-down").addEventListener("click", () => moveRow(tr, "down"));
    if (canAct) {
      tr.querySelector(".add-to-plan-btn").addEventListener("click", (ev) => handleAddToPlan(candidate, ev.target));
      const summaryBtn = tr.querySelector(".add-to-summary-btn");
      if (summaryBtn) summaryBtn.addEventListener("click", (ev) => handleAddToSummary(candidate, ev.target));
    }
    return tr;
  }

  async function loadStoppedList() {
    if (!week) return;
    root.querySelector(".stopped-tbody").innerHTML = `<tr><td colspan="${TABLE_COLSPAN}">加载中...</td></tr>`;
    // stoppedCandidates: listStoppedTasks()已经是taskCandidateFields形状的完整候选数据
    // (task_id/module_id/owner/deliverable_this_week/execution_deadline/actualStartDate/
    // label/detail)，"续做"两个按钮直接拿这份数据传给onAddToPlan/onAddToSummary，跟手动
    // 搜索选中后拿到的形状完全一致，不用另外拼。按task_id匹配不到(即这一行对应的任务
    // 当前已经不是"中止"状态了)的行，两个按钮会被disabled——见buildStoppedRowElement注释。
    const [entries, stoppedCandidates] = await Promise.all([
      listWeeklyTaskEntries(week.id, "stopped"),
      listStoppedTasks(),
    ]);
    const candidateByTaskId = new Map(stoppedCandidates.map((c) => [c.task_id, c]));
    const detailMap = await buildSourceDetailMap(entries.map((e) => e.task_id));
    const tbody = root.querySelector(".stopped-tbody");
    tbody.innerHTML = "";
    const locked = isLocked();
    root.querySelector(".save-stopped-btn").hidden = locked;
    for (const e of entries) {
      tbody.appendChild(buildStoppedRowElement(e, detailMap.get(e.task_id) || {}, locked, candidateByTaskId.get(e.task_id)));
    }
    currentMaxSortOrder = entries.reduce((m, e) => Math.max(m, e.sort_order ?? 0), 0);
  }

  async function saveAllStoppedRows() {
    const resultEl = root.querySelector(".save-stopped-result");
    const rows = [...root.querySelectorAll(".stopped-tbody tr[data-entry-id]")];
    if (rows.length === 0) return;
    resultEl.textContent = "保存中...";
    resultEl.className = "save-stopped-result status";
    try {
      for (const tr of rows) {
        await updateWeeklyTaskEntry(Number(tr.dataset.entryId), {
          resources_needed: tr.querySelector(".f-resources").value || "无",
          highlight: tr.querySelector(".f-highlight").checked,
        });
      }
      resultEl.textContent = `已保存 ${rows.length} 条`;
      resultEl.className = "save-stopped-result status ok";
    } catch (err) {
      resultEl.textContent = `保存失败：${err.message}`;
      resultEl.className = "save-stopped-result status error";
      throw err;
    }
  }
  root.querySelector(".save-stopped-btn").addEventListener("click", () => {
    saveAllStoppedRows().catch(() => {});
  });

  // 核心同步逻辑：查一遍全部任务里状态为"中止"的，跟本周已有的stopped条目做差集，把还没
  // 出现的补进来。silent=true(setWeek()内部自动跑一遍时用)不弹锁定提示——不然每次切换到
  // 一个已锁定的历史周都会跳出一条警告，很吵；用户主动点"刷新"按钮时(silent=false，默认)
  // 才提示。只新增不删除——任务如果后来被手动改回非中止状态，这一行不会自动消失(避免
  // "PPT显示过的历史记录被静默改掉"的意外)，需要手动点"删除"清理。
  async function syncStoppedTasks({ silent = false } = {}) {
    const resultEl = root.querySelector(".refresh-stopped-result");
    if (isLocked()) {
      if (!silent) {
        resultEl.textContent = "本周计划已锁定，请先去「本周计划」区块解锁再刷新";
        resultEl.className = "refresh-stopped-result status warn";
      }
      return;
    }
    if (!silent) {
      resultEl.textContent = "搜索中...";
      resultEl.className = "refresh-stopped-result status";
    }
    try {
      const [allStopped, currentEntries] = await Promise.all([listStoppedTasks(), listWeeklyTaskEntries(week.id, "stopped")]);
      const existing = new Set(currentEntries.map((e) => e.task_id));
      const toCreate = allStopped.filter((c) => !existing.has(c.task_id));
      for (const c of toCreate) {
        await createWeeklyTaskEntry({
          meeting_week_id: week.id,
          appears_in: "stopped",
          task_id: c.task_id,
          module_id: c.module_id,
          owner: c.owner,
          resources_needed: "无",
          sort_order: ++currentMaxSortOrder,
        });
      }
      if (!silent || toCreate.length > 0) {
        resultEl.textContent = toCreate.length === 0 ? "没有新的中止任务" : `已加入 ${toCreate.length} 条`;
        resultEl.className = "refresh-stopped-result status ok";
      }
      if (toCreate.length > 0) await loadStoppedList();
    } catch (err) {
      resultEl.textContent = `失败：${err.message}`;
      resultEl.className = "refresh-stopped-result status error";
    }
  }
  root.querySelector(".refresh-stopped-btn").addEventListener("click", () => syncStoppedTasks());

  async function setWeek(w, prevWeek) {
    week = w;
    previousWeek = prevWeek;
    renderLockHint();
    root.querySelector(".stopped-action-result").textContent = "";
    await loadStoppedList();
    await syncStoppedTasks({ silent: true });
  }

  return { setWeek };
}
