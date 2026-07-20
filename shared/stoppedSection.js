// "未启动/中止工作"表格挂载函数，供index.js跟summarySection.js/planSection.js并列挂载。
// 2026-07-20新增——此前网页上完全没有UI能创建appears_in='stopped'的weekly_task_entries，
// PPT这一张表一直是空的；pptGenerate.js/db.js那半边其实早就支持，这里只是补上缺失的编辑入口。
//
// 操作对象是targetWeek(跟planSection.js一样，变量名就叫week)。锁定语义：不自建锁定/解锁
// 按钮，只读态直接跟随week.plan_locked_at——用户明确纠正过"锁定=这周例会已经开完、
// 最终定稿"这个语义跟"本周计划"是同一件事，未启动/中止工作作为本周计划的一部分，理应
// 共享同一个锁定状态，不需要另一套锁定流程。已知权衡：点"本周计划"区块的"锁定本周计划"
// 按钮不会自动保存这个表格里未点保存的改动——这个表格改动频率非常低(用户原话"基本上
// 每周都不变")，为此单独做跨模块保存编排不成比例，是明确接受的取舍，不是疏漏。
import { listWeeklyTaskEntries, createWeeklyTaskEntry, updateWeeklyTaskEntry, deleteWeeklyTaskEntry, updateTask } from "./db.js";
import { buildSourceDetailMap, listAllActiveCandidates, SOURCE_STATUS_LABEL } from "./taskLabels.js";
import { renderTaskPicker } from "./taskPicker.js";
import { moveRow } from "./rowReorder.js";

// 交付物/未完成原因这类字段这张表不需要(见下方表格列设计)，唯一自由文本字段"需协调资源"
// 沿用其它表格的textarea+转义模式，避免<>&被当成HTML解析。
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

const TEMPLATE = `
  <div class="lock-bar inline-form">
    <button type="button" class="copy-prev-btn">复制上周</button>
  </div>
  <p class="copy-prev-result status"></p>
  <p class="stopped-lock-status status"></p>

  <div class="stopped-add-block">
    <h3>手动添加</h3>
    <label>加入后状态
      <select class="stopped-status-select">
        <option value="stopped">中止</option>
        <option value="not_started">未启动</option>
      </select>
    </label>
    <div class="stopped-picker"></div>
    <button type="button" class="refresh-stopped-btn secondary">刷新列表</button>
    <p class="stopped-add-result status"></p>
  </div>

  <h3>未启动/中止工作</h3>
  <button type="button" class="save-stopped-btn">保存</button>
  <p class="save-stopped-result status"></p>
  <div class="table-scroll">
  <table class="report-table" style="min-width:900px">
    <colgroup>
      <col style="width:36px" /><!-- 排序 -->
      <col style="width:40px" /><!-- 模块 -->
      <col style="width:130px" /><!-- 任务1级 -->
      <col style="width:130px" /><!-- 任务2级 -->
      <col style="width:130px" /><!-- 任务3级 -->
      <col style="width:40px" /><!-- 责任人 -->
      <col style="width:110px" /><!-- 状态 -->
      <col style="width:160px" /><!-- 需协调资源 -->
      <col style="width:40px" /><!-- 重点 -->
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
      </tr>
    </thead>
    <tbody class="stopped-tbody"></tbody>
  </table>
  </div>
`;

const TABLE_COLSPAN = 11;

export function mountStoppedSection(root, { allModules }) {
  root.innerHTML = TEMPLATE;

  let week = null; // targetWeek
  let previousWeek = null;
  let pickCandidates = [];
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

  function buildStoppedRowElement(e, detail, locked) {
    const dis = locked ? "disabled" : "";
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
      <td class="readonly-col">
        <span class="stopped-status-text">${detail.sourceStatus || ""}</span>
        ${dis ? "" : `<div><button type="button" class="secondary mini f-mark-not-started" title="改成未启动">未启动</button><button type="button" class="secondary mini f-mark-stopped" title="改成中止">中止</button></div>`}
      </td>
      <td><textarea class="f-resources" rows="2" ${dis}>${escapeHtml(e.resources_needed || "无")}</textarea></td>
      <td><input type="checkbox" class="f-highlight" ${e.highlight ? "checked" : ""} ${dis} /></td>
      <td>${detail.detailUrl ? `<a href="${detail.detailUrl}" target="_blank" rel="noopener">编辑</a>` : ""}</td>
      <td><button type="button" class="secondary delete-x" ${dis} title="删除">×</button></td>
    `;
    tr.querySelector(".delete-x").addEventListener("click", async () => {
      await deleteWeeklyTaskEntry(e.id);
      tr.remove();
    });
    tr.querySelector(".f-up").addEventListener("click", () => moveRow(tr, "up"));
    tr.querySelector(".f-down").addEventListener("click", () => moveRow(tr, "down"));
    const markNotStartedBtn = tr.querySelector(".f-mark-not-started");
    const markStoppedBtn = tr.querySelector(".f-mark-stopped");
    if (markNotStartedBtn) {
      markNotStartedBtn.addEventListener("click", async () => {
        await updateTask(e.task_id, { status: "not_started" });
        tr.querySelector(".stopped-status-text").textContent = SOURCE_STATUS_LABEL.not_started;
      });
    }
    if (markStoppedBtn) {
      markStoppedBtn.addEventListener("click", async () => {
        await updateTask(e.task_id, { status: "stopped" });
        tr.querySelector(".stopped-status-text").textContent = SOURCE_STATUS_LABEL.stopped;
      });
    }
    return tr;
  }

  async function loadStoppedList() {
    if (!week) return;
    root.querySelector(".stopped-tbody").innerHTML = `<tr><td colspan="${TABLE_COLSPAN}">加载中...</td></tr>`;
    const entries = await listWeeklyTaskEntries(week.id, "stopped");
    const detailMap = await buildSourceDetailMap(entries.map((e) => e.task_id));
    const tbody = root.querySelector(".stopped-tbody");
    tbody.innerHTML = "";
    const locked = isLocked();
    root.querySelector(".save-stopped-btn").hidden = locked;
    for (const e of entries) {
      tbody.appendChild(buildStoppedRowElement(e, detailMap.get(e.task_id) || {}, locked));
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

  root.querySelector(".copy-prev-btn").addEventListener("click", async () => {
    const resultEl = root.querySelector(".copy-prev-result");
    if (isLocked()) {
      resultEl.textContent = "本周计划已锁定，请先去「本周计划」区块解锁再复制";
      resultEl.className = "copy-prev-result status warn";
      return;
    }
    if (!previousWeek) {
      resultEl.textContent = "没有更早的例会周";
      resultEl.className = "copy-prev-result status warn";
      return;
    }
    resultEl.textContent = "复制中...";
    resultEl.className = "copy-prev-result status";
    try {
      const [prevEntries, currentEntries] = await Promise.all([
        listWeeklyTaskEntries(previousWeek.id, "stopped"),
        listWeeklyTaskEntries(week.id, "stopped"),
      ]);
      const existing = new Set(currentEntries.map((e) => e.task_id));
      const toCreate = prevEntries.filter((e) => !existing.has(e.task_id));
      for (const e of toCreate) {
        await createWeeklyTaskEntry({
          meeting_week_id: week.id,
          appears_in: "stopped",
          task_id: e.task_id,
          module_id: e.module_id,
          owner: e.owner,
          resources_needed: e.resources_needed || "无",
          highlight: e.highlight,
          sort_order: ++currentMaxSortOrder,
        });
      }
      resultEl.textContent = toCreate.length === 0 ? "上周的条目都已经复制过了" : `已复制 ${toCreate.length} 条`;
      resultEl.className = "copy-prev-result status ok";
      await loadStoppedList();
      await loadPickCandidates();
    } catch (err) {
      resultEl.textContent = `失败：${err.message}`;
      resultEl.className = "copy-prev-result status error";
    }
  });

  function renderPicker() {
    renderTaskPicker(root.querySelector(".stopped-picker"), pickCandidates, handlePick);
  }

  async function loadPickCandidates() {
    if (!week) {
      pickCandidates = [];
      renderPicker();
      return;
    }
    const [all, stoppedEntries] = await Promise.all([listAllActiveCandidates(week.id), listWeeklyTaskEntries(week.id, "stopped")]);
    const excluded = new Set(stoppedEntries.map((e) => e.task_id));
    pickCandidates = all.filter((c) => !excluded.has(c.task_id));
    renderPicker();
  }

  async function handlePick(c) {
    const resultEl = root.querySelector(".stopped-add-result");
    if (isLocked()) {
      resultEl.textContent = "本周计划已锁定，请先去「本周计划」区块解锁再添加";
      resultEl.className = "stopped-add-result status warn";
      return;
    }
    const status = root.querySelector(".stopped-status-select").value; // 'stopped' | 'not_started'
    resultEl.textContent = "添加中...";
    resultEl.className = "stopped-add-result status";
    try {
      const entry = await createWeeklyTaskEntry({
        meeting_week_id: week.id,
        appears_in: "stopped",
        task_id: c.task_id,
        module_id: c.module_id,
        owner: c.owner,
        resources_needed: "无",
        sort_order: ++currentMaxSortOrder,
      });
      await updateTask(c.task_id, { status });
      resultEl.textContent = `已添加：${c.label}`;
      resultEl.className = "stopped-add-result status ok";
      pickCandidates = pickCandidates.filter((x) => x.task_id !== c.task_id);
      renderPicker();
      const detail = { ...(c.detail || {}), sourceStatus: SOURCE_STATUS_LABEL[status] };
      root.querySelector(".stopped-tbody").appendChild(buildStoppedRowElement(entry, detail, isLocked()));
    } catch (err) {
      resultEl.textContent = `失败：${err.message}`;
      resultEl.className = "stopped-add-result status error";
    }
  }
  root.querySelector(".refresh-stopped-btn").addEventListener("click", loadPickCandidates);

  async function setWeek(w, prevWeek) {
    week = w;
    previousWeek = prevWeek;
    renderLockHint();
    await Promise.all([loadStoppedList(), loadPickCandidates()]);
  }

  // 供shared/taskCreateSection.js"新建任务"表单创建成功后调用，让新任务立刻能在这里的
  // 手动添加候选里搜到，不用用户自己点"刷新列表"。
  return { setWeek, refreshCandidates: loadPickCandidates };
}
