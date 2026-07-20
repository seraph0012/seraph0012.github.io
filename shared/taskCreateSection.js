// "制作周报"页面内嵌的完整版"新建任务"表单——2026-07-20用户明确要求支持到"新建项目/
// 循环任务实例都要支持"（不是简化版），逻辑照抄tasks.js的新建任务表单(ownerOptionsHtml/
// parseOwnerValue/refreshLevel2Options/onLevel2Change/onOwnerChange/createTaskListLeaf/
// createRecurringNew/generateNextInstance)，只是：
//   - document.getElementById改成root.querySelector(".xxx")（class选择器，跟
//     planSection.js/summarySection.js同一套"挂载函数用class不用id"模式，避免跟页面上
//     其它组件的id冲突）；
//   - 不搬tasks.js里任务树渲染相关的代码(buildTree/renderNode等)，那是"任务管理"页面
//     自己的展示逻辑，跟"新建任务表单"是两回事；
//   - 整个表单包在<details>里默认折叠，首次展开才发起listProjects()查询（懒加载，不在
//     "制作周报"首屏就承担这个额外请求）；因为总是等listProjects()完整数据回来才启用表单，
//     不需要像tasks.js那样处理"project_headers缓存但tasks还没到"的加载中占位分支；
//   - 创建成功后不调tasks.js式的reloadAll()(那是任务树的刷新)，只reloadProjects()刷新
//     本模块自己的projects状态，并调用onCreated()回调，把"通知外部有新任务"的职责交给
//     挂载方（index.js借此让"手动搜索添加任务"/"记录计划外完成的任务"两个picker立刻能
//     搜到新任务）。
// 循环任务编号算法(computeNextNumber/nextUnusedWeek/generateInstanceTitle/
// generateInstanceDeliverable/monthWeekLabel/wbsLabel)抽在shared/recurringNumbering.js，
// tasks.js跟这里共用同一份实现。
import {
  listProjects,
  createProject,
  createRecurringProject,
  addTask,
  upsertTaskGroup,
  claimTaskNumberSafe,
  setTaskNumberOwner,
  suggestNextTaskNumber,
} from "./db.js";
import {
  computeNextNumber,
  nextUnusedWeek,
  generateInstanceTitle,
  generateInstanceDeliverable,
  wbsLabel,
} from "./recurringNumbering.js";

const TEMPLATE = `
  <details class="task-create-details">
    <summary>+ 新建任务</summary>
    <div class="task-create-body">
      <p class="tc-loading status">展开后加载项目列表...</p>
      <form class="create-form inline-form" hidden>
        <label>归属 <select class="owner-select"></select></label>

        <span class="new-project-fields" hidden>
          <label class="new-project-title-wrap">项目名 <input type="text" class="new-project-title" style="min-width:160px" /></label>
          <label>编号 <input type="number" class="new-project-number" style="width:5em" /></label>
          <span class="new-project-extra-wrap">
            <label>分类 <input type="text" class="new-project-category" style="width:8em" /></label>
            <label>项目截止日期 <input type="date" class="new-project-deadline" /></label>
            <label>项目最终交付物 <input type="text" class="new-project-deliverable" style="min-width:140px" /></label>
          </span>
        </span>

        <span class="leaf-fields" hidden>
          <label>标题 <input type="text" class="leaf-title" style="min-width:160px" /></label>
          <label>模块 <select class="leaf-module"></select></label>
          <label>责任人 <select class="leaf-owner"></select></label>
          <label>二级编号 <select class="wbs-level2-select"></select></label>
          <span class="wbs-level2-new-wrap" hidden>新二级编号 <input type="number" class="wbs-level2-new" style="width:5em" /></span>
          <span class="wbs-level2-title-wrap" hidden>二级标题 <input type="text" class="wbs-level2-title" style="min-width:140px" /></span>
          <label>三级编号(留空=无三级) <input type="number" class="wbs-level3" style="width:5em" /></label>
          <label>最终目标交付物 <input type="text" class="leaf-deliverable" style="min-width:140px" /></label>
          <label>最终计划完成时间 <input type="date" class="leaf-completion-date" /></label>
          <label>预计开始日期 <input type="date" class="leaf-start-date" /></label>
        </span>

        <span class="recurring-new-fields" hidden>
          <label>动词前缀 <input type="text" class="recurring-title-verb" style="width:6em" placeholder="如：制作" /></label>
          <label>名词部分(交付物基础名) <input type="text" class="recurring-title-noun" style="min-width:140px" placeholder="如：周例会PPT" /></label>
          <label>模块 <select class="recurring-module"></select></label>
          <label>责任人 <select class="recurring-owner-select"></select></label>
          <label>频率
            <select class="recurring-frequency">
              <option value="weekly">weekly</option>
              <option value="monthly">monthly</option>
              <option value="custom">custom</option>
            </select>
          </label>
          <label>第一次的例会周 <select class="recurring-first-week"></select></label>
        </span>

        <span class="recurring-instance-fields" hidden>
          <p class="recurring-instance-preview status"></p>
        </span>

        <button type="submit" class="create-submit-btn">新建</button>
      </form>
      <p class="create-result status"></p>
    </div>
  </details>
`;

function moduleOptionsHtmlStrict(allModules, selectedId) {
  if (allModules.length === 0) return `<option value="">(请先去"设置"页面添加)</option>`;
  return allModules.map((m) => `<option value="${m.id}" ${m.id === selectedId ? "selected" : ""}>${m.name}</option>`).join("");
}
function soleModuleId(allModules) {
  return allModules.find((m) => m.is_current)?.id ?? (allModules.length === 1 ? allModules[0].id : null);
}
function peopleOptionsHtml(allPeople, selectedName) {
  if (allPeople.length === 0) return `<option value="">(请先去"设置"页面添加)</option>`;
  return allPeople.map((p) => `<option value="${p.name}" ${p.name === selectedName ? "selected" : ""}>${p.name}</option>`).join("");
}
function solePersonName(allPeople) {
  return allPeople.find((p) => p.is_current)?.name ?? (allPeople.length === 1 ? allPeople[0].name : null);
}
function weekOptionsHtml(allWeeksRaw) {
  return allWeeksRaw.map((w) => `<option value="${w.id}">${w.natural_week_start}（例会${w.meeting_date}）</option>`).join("");
}

export function mountTaskCreateSection(root, { allModules, allPeople, allWeeksRaw, onCreated }) {
  root.innerHTML = TEMPLATE;

  let projects = [];
  const allWeeks = allWeeksRaw.filter((w) => w.is_normal !== false);

  function ownerOptionsHtml() {
    const seqOpts = projects
      .filter((p) => p.project_type === "sequential")
      .map((p) => `<option value="sequential:${p.id}">[${p.level1_number}] ${p.title}</option>`)
      .join("");
    const nonseqOpts = projects
      .filter((p) => p.project_type === "nonsequential")
      .map((p) => `<option value="nonsequential:${p.id}">[${p.level1_number}] ${p.title}</option>`)
      .join("");
    const recurringOpts = projects
      .filter((p) => p.project_type === "recurring")
      .map((p) => `<option value="recurring:${p.id}">[${p.level1_number}] ${p.title}</option>`)
      .join("");
    return `
      <optgroup label="顺序队列"><option value="new:sequential">+ 新建顺序队列项目</option>${seqOpts}</optgroup>
      <optgroup label="截止日期"><option value="new:nonsequential">+ 新建截止日期项目</option>${nonseqOpts}</optgroup>
      <optgroup label="循环任务"><option value="new:recurring">+ 新建循环任务</option>${recurringOpts}</optgroup>
    `;
  }

  function parseOwnerValue() {
    const raw = root.querySelector(".owner-select").value;
    const [kind, rest] = raw.split(":");
    if (kind === "new") return { isNew: true, type: rest };
    return { isNew: false, type: kind, id: Number(rest) };
  }

  // "无(项目本身就是任务)"这个选项只在项目还完全没有任何任务时才提供——两种状态互斥
  // (DB层partial unique index强制)。这里不需要处理"project.tasks==null"的加载占位分支
  // (对照tasks.js)——这个模块总是等listProjects()完整数据回来才启用表单，projects数组
  // 里的每个项目都一定带着真实的tasks。
  function refreshLevel2Options(sel) {
    const level2Select = root.querySelector(".wbs-level2-select");
    if (sel.isNew) {
      level2Select.innerHTML = `<option value="__none__">无(项目本身就是任务)</option><option value="__new__">+ 新建二级</option>`;
      level2Select.value = "__none__";
      onLevel2Change(sel);
      return;
    }
    const project = projects.find((p) => p.id === sel.id);
    const children = project.tasks;
    const groups = [...new Set(children.filter((c) => c.wbs_level2_number != null).map((c) => c.wbs_level2_number))].sort(
      (a, b) => a - b
    );
    const maxLevel2 = groups.length ? Math.max(...groups) : 0;
    const noneOption = children.length === 0 ? `<option value="__none__">无(项目本身就是任务)</option>` : "";
    level2Select.innerHTML =
      noneOption +
      groups.map((g) => `<option value="${g}">二级 ${g}</option>`).join("") +
      `<option value="__new__">+ 新建二级(预填 ${maxLevel2 + 1})</option>`;
    level2Select.value = children.length === 0 ? "__none__" : groups.length ? String(groups[0]) : "__new__";
    onLevel2Change(sel);
  }

  // 三级编号默认留空(=这个二级本身就是任务)，只有明确已经存在三级子任务的二级分组才自动
  // 预填"下一个三级编号"；新建二级分组时不假设一定会有三级。
  function onLevel2Change(sel) {
    const level2Select = root.querySelector(".wbs-level2-select");
    const val = level2Select.value;
    const isNewLevel2 = val === "__new__";
    const isNone = val === "__none__";
    const level3Input = root.querySelector(".wbs-level3");
    root.querySelector(".wbs-level2-new-wrap").hidden = !isNewLevel2;
    root.querySelector(".wbs-level2-title-wrap").hidden = !isNewLevel2;
    if (isNewLevel2) root.querySelector(".wbs-level2-title").value = "";
    level3Input.closest("label").hidden = isNone;
    if (isNone) return;
    if (sel.isNew) {
      if (isNewLevel2) {
        root.querySelector(".wbs-level2-new").value = 1;
        level3Input.value = "";
      }
      return;
    }
    const project = projects.find((p) => p.id === sel.id);
    const children = project.tasks;
    if (isNewLevel2) {
      const existingLevel2 = children.filter((c) => c.wbs_level2_number != null).map((c) => c.wbs_level2_number);
      const maxLevel2 = existingLevel2.length ? Math.max(...existingLevel2) : 0;
      root.querySelector(".wbs-level2-new").value = maxLevel2 + 1;
      level3Input.value = "";
    } else {
      const level2Value = Number(val);
      const siblings = children.filter((c) => c.wbs_level2_number === level2Value);
      const hasLevel3 = siblings.some((c) => c.wbs_level3_number != null);
      if (hasLevel3) {
        const maxLevel3 = siblings.reduce((m, c) => Math.max(m, c.wbs_level3_number ?? 0), 0);
        level3Input.value = maxLevel3 + 1;
      } else {
        level3Input.value = "";
      }
    }
  }
  root.querySelector(".wbs-level2-select").addEventListener("change", () => onLevel2Change(parseOwnerValue()));

  function refreshRecurringPreview(projectId) {
    const p = projects.find((x) => x.id === projectId);
    const previewEl = root.querySelector(".recurring-instance-preview");
    const s = p.recurring_project_settings;
    const targetWeek = nextUnusedWeek(p.tasks, allWeeks);
    if (!targetWeek) {
      previewEl.textContent = "没有更多可用的例会周了，请先在例会日历里预生成更多周";
      previewEl.className = "recurring-instance-preview status error";
      return;
    }
    const { level2, level3 } = computeNextNumber(p, p.tasks, targetWeek, allWeeks);
    const fullNumber = wbsLabel(p.level1_number, level2, level3);
    const title = generateInstanceTitle(s.title_verb, s.title_noun, s.frequency, targetWeek, level3);
    const deliverable = generateInstanceDeliverable(s.title_verb, s.title_noun, s.frequency, targetWeek, level3);
    previewEl.textContent = `将生成实例 ${fullNumber}「${title}」（对应例会周 ${targetWeek.natural_week_start}，最终交付物：${deliverable}）`;
    previewEl.className = "recurring-instance-preview status";
  }

  async function onOwnerChange() {
    const sel = parseOwnerValue();
    const isTaskList = sel.type === "sequential" || sel.type === "nonsequential";
    root.querySelector(".new-project-fields").hidden = !sel.isNew;
    root.querySelector(".new-project-title-wrap").hidden = sel.type === "recurring";
    root.querySelector(".new-project-extra-wrap").hidden = sel.type === "recurring";
    root.querySelector(".leaf-fields").hidden = !isTaskList;
    root.querySelector(".recurring-new-fields").hidden = !(sel.isNew && sel.type === "recurring");
    root.querySelector(".recurring-instance-fields").hidden = !(sel.type === "recurring" && !sel.isNew);
    root.querySelector(".create-submit-btn").textContent = sel.type === "recurring" && !sel.isNew ? "生成下一个实例" : "新建";

    if (sel.isNew) {
      root.querySelector(".new-project-number").value = await suggestNextTaskNumber();
    }
    if (isTaskList) {
      refreshLevel2Options(sel);
      root.querySelector(".leaf-module").innerHTML = moduleOptionsHtmlStrict(allModules, soleModuleId(allModules));
      root.querySelector(".leaf-owner").innerHTML = peopleOptionsHtml(allPeople, solePersonName(allPeople));
    }
    if (sel.type === "recurring" && sel.isNew) {
      root.querySelector(".recurring-module").innerHTML = moduleOptionsHtmlStrict(allModules, soleModuleId(allModules));
      root.querySelector(".recurring-owner-select").innerHTML = peopleOptionsHtml(allPeople, solePersonName(allPeople));
    }
    if (sel.type === "recurring" && !sel.isNew) {
      refreshRecurringPreview(sel.id);
    }
  }
  root.querySelector(".owner-select").addEventListener("change", onOwnerChange);

  async function createTaskListLeaf(sel) {
    const title = root.querySelector(".leaf-title").value.trim();
    const deliverable = root.querySelector(".leaf-deliverable").value.trim();
    const completionDate = root.querySelector(".leaf-completion-date").value;
    const startDate = root.querySelector(".leaf-start-date").value;
    const moduleId = root.querySelector(".leaf-module").value || null;
    const owner = root.querySelector(".leaf-owner").value.trim();
    const level2Select = root.querySelector(".wbs-level2-select");
    const isNewLevel2Group = level2Select.value === "__new__";
    const level2Title = root.querySelector(".wbs-level2-title").value.trim();
    let level2 = null;
    let level3 = null;
    if (level2Select.value !== "__none__") {
      level2 = level2Select.value === "__new__" ? Number(root.querySelector(".wbs-level2-new").value) : Number(level2Select.value);
      const level3raw = root.querySelector(".wbs-level3").value;
      level3 = level3raw ? Number(level3raw) : null;
    }
    if (!title || !deliverable || !completionDate || !moduleId || !owner) {
      throw new Error("任务标题/模块/责任人/最终目标交付物/最终计划完成时间都是必填项");
    }
    if (isNewLevel2Group && level3 != null && !level2Title) {
      throw new Error("这个二级任务下有三级子任务，必须填写二级标题");
    }

    let projectId;
    if (sel.isNew) {
      const projTitle = root.querySelector(".new-project-title").value.trim();
      if (!projTitle) throw new Error("请填写项目名");
      const level1Number = Number(root.querySelector(".new-project-number").value);
      const numberRow = await claimTaskNumberSafe(
        { task_type: sel.type, title_snapshot: projTitle, owning_table: "projects", owning_id: 0, level1_number: level1Number },
        (n) => {
          root.querySelector(".new-project-number").value = n;
        }
      );
      const category = root.querySelector(".new-project-category").value.trim() || null;
      const deadlineDate = root.querySelector(".new-project-deadline").value || null;
      const projectDeliverable = root.querySelector(".new-project-deliverable").value.trim() || null;
      const p = await createProject({
        title: projTitle,
        project_type: sel.type,
        category,
        deadline_date: deadlineDate,
        target_deliverable: projectDeliverable,
        level1_number: numberRow.level1_number,
      });
      projectId = p.id;
      await setTaskNumberOwner(numberRow.level1_number, projectId);
    } else {
      projectId = sel.id;
    }

    await addTask(projectId, {
      wbs_level2_number: level2,
      wbs_level3_number: level3,
      title,
      module_id: moduleId,
      owner,
      target_deliverable: deliverable,
      planned_completion_date: completionDate,
      planned_start_date: startDate || null,
    });
    if (isNewLevel2Group && level3 != null && level2Title) {
      await upsertTaskGroup(projectId, level2, level2Title);
    }
  }

  async function createRecurringNew() {
    const titleVerb = root.querySelector(".recurring-title-verb").value.trim();
    const titleNoun = root.querySelector(".recurring-title-noun").value.trim();
    const firstWeekId = Number(root.querySelector(".recurring-first-week").value);
    const level1Number = Number(root.querySelector(".new-project-number").value);
    const moduleId = root.querySelector(".recurring-module").value || null;
    const owner = root.querySelector(".recurring-owner-select").value.trim();
    if (!titleNoun || !firstWeekId || !moduleId || !owner) {
      throw new Error("名词部分(交付物)/模块/责任人/第一次的例会周都是必填项");
    }
    const title = titleVerb + titleNoun;
    const numberRow = await claimTaskNumberSafe(
      { task_type: "recurring", title_snapshot: title, owning_table: "projects", owning_id: 0, level1_number: level1Number },
      (n) => {
        root.querySelector(".new-project-number").value = n;
      }
    );
    const frequency = root.querySelector(".recurring-frequency").value;
    const project = await createRecurringProject(
      { title, project_type: "recurring", level1_number: numberRow.level1_number },
      { title_verb: titleVerb, title_noun: titleNoun, frequency, module_id: moduleId, owner }
    );
    await setTaskNumberOwner(numberRow.level1_number, project.id);
    const firstWeek = allWeeksRaw.find((w) => w.id === firstWeekId);
    const level3 = frequency === "monthly" ? null : 1;
    await addTask(project.id, {
      meeting_week_id: firstWeekId,
      wbs_level2_number: 1,
      wbs_level3_number: level3,
      module_id: moduleId,
      owner,
      planned_completion_date: firstWeek.work_week_end,
      title: generateInstanceTitle(titleVerb, titleNoun, frequency, firstWeek, level3),
      target_deliverable: generateInstanceDeliverable(titleVerb, titleNoun, frequency, firstWeek, level3),
    });
  }

  async function generateNextInstance(projectId) {
    const p = projects.find((x) => x.id === projectId);
    const s = p.recurring_project_settings;
    const targetWeek = nextUnusedWeek(p.tasks, allWeeks);
    if (!targetWeek) throw new Error("没有更多可用的例会周了，请先在例会日历里预生成更多周");
    const { level2, level3 } = computeNextNumber(p, p.tasks, targetWeek, allWeeks);
    await addTask(p.id, {
      meeting_week_id: targetWeek.id,
      wbs_level2_number: level2,
      wbs_level3_number: level3,
      module_id: s.module_id,
      owner: s.owner,
      planned_completion_date: targetWeek.work_week_end,
      title: generateInstanceTitle(s.title_verb, s.title_noun, s.frequency, targetWeek, level3),
      target_deliverable: generateInstanceDeliverable(s.title_verb, s.title_noun, s.frequency, targetWeek, level3),
    });
  }

  async function reloadProjects() {
    projects = await listProjects();
    const ownerSelect = root.querySelector(".owner-select");
    const prevValue = ownerSelect.value;
    ownerSelect.innerHTML = ownerOptionsHtml();
    if ([...ownerSelect.options].some((o) => o.value === prevValue)) ownerSelect.value = prevValue;
    await onOwnerChange();
  }

  root.querySelector(".create-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const resultEl = root.querySelector(".create-result");
    const sel = parseOwnerValue();
    resultEl.textContent = "处理中...";
    resultEl.className = "create-result status";
    try {
      if (sel.type === "recurring" && sel.isNew) {
        await createRecurringNew();
      } else if (sel.type === "recurring" && !sel.isNew) {
        await generateNextInstance(sel.id);
      } else {
        await createTaskListLeaf(sel);
      }
      resultEl.textContent = "成功";
      resultEl.className = "create-result status ok";
      await reloadProjects();
      root.querySelector(".leaf-title").value = "";
      root.querySelector(".leaf-deliverable").value = "";
      root.querySelector(".leaf-completion-date").value = "";
      root.querySelector(".leaf-start-date").value = "";
      root.querySelector(".wbs-level2-title").value = "";
      root.querySelector(".recurring-title-verb").value = "";
      root.querySelector(".recurring-title-noun").value = "";
      await onOwnerChange();
      if (onCreated) onCreated();
    } catch (err) {
      resultEl.textContent = `失败：${err.message}`;
      resultEl.className = "create-result status error";
    }
  });

  root.querySelector(".recurring-first-week").innerHTML = weekOptionsHtml(allWeeksRaw);

  // 默认折叠，首次展开才发起listProjects()查询——"制作周报"首屏不该被这个不是每次都要用
  // 的功能拖慢(2026-07-20用户确认要完整版功能，但没有要求它跟主流程一样默认展开)。
  const detailsEl = root.querySelector(".task-create-details");
  let loadedOnce = false;
  detailsEl.addEventListener("toggle", async () => {
    if (!detailsEl.open || loadedOnce) return;
    loadedOnce = true;
    const loadingEl = root.querySelector(".tc-loading");
    loadingEl.textContent = "加载中...";
    try {
      await reloadProjects();
      loadingEl.hidden = true;
      root.querySelector(".create-form").hidden = false;
    } catch (err) {
      loadingEl.textContent = `加载失败：${err.message}`;
      loadedOnce = false; // 允许重新展开/收起后重试
    }
  });
}
