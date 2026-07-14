import { requireAuth } from "./shared/authGuard.js";
import { renderNav } from "./shared/nav.js";
import {
  listModules,
  listPeople,
  listMeetingWeeks,
  listProjects,
  createProject,
  createRecurringProject,
  updateProject,
  updateRecurringSettings,
  deleteProject,
  addTask,
  updateTask,
  deleteTask,
  upsertTaskGroup,
  claimTaskNumber,
  setTaskNumberOwner,
  suggestNextTaskNumber,
  deleteTaskNumber,
  listPlannedTaskIds,
  countWeeklyTaskEntriesForTask,
  deleteWeeklyTaskEntriesForTask,
} from "./shared/db.js";
import { cacheFirst } from "./shared/localCache.js";
import { SOURCE_STATUS_LABEL, PROJECT_TYPE_LABEL } from "./shared/taskLabels.js";

const session = await requireAuth();
if (!session) {
  throw new Error("not authenticated");
}
renderNav();

const highlightKey = new URLSearchParams(window.location.search).get("highlight"); // 例如 "task:123"

let allModules = [];
let allPeople = [];
let allWeeksRaw = []; // 未过滤，起始/新增例会周下拉用
let allWeeks = []; // 过滤掉is_normal=false，循环任务编号算法用
let projects = []; // 2026-07-14统一任务模型：sequential/nonsequential/recurring三种project_type都在这一个数组里
const openDetailKeys = new Set();
if (highlightKey) openDetailKeys.add(highlightKey);

// level2为空代表"项目本身就是任务，没有再往下分解"(比如临时的一次性计划外工作)，
// 这时候编号就是纯"5"而不是"5.2"
function wbsLabel(level1, level2, level3) {
  if (level2 == null) return `${level1}`;
  return level3 != null ? `${level1}.${level2}.${level3}` : `${level1}.${level2}`;
}

function moduleOptionsHtml(selectedId) {
  return (
    `<option value="">(未分类)</option>` +
    allModules.map((m) => `<option value="${m.id}" ${m.id === selectedId ? "selected" : ""}>${m.name}</option>`).join("")
  );
}

// 模块/责任人现在是每个任务创建时都要填的必填项(2026-07-10跟用户确认)——新建表单用这个
// "严格版"(没有留空选项)，默认预填"唯一模块/唯一责任人"，避免每次都要手动选。
// 编辑已有任务时仍用上面允许留空的moduleOptionsHtml，不强行修正历史数据。
function moduleOptionsHtmlStrict(selectedId) {
  if (allModules.length === 0) return `<option value="">(请先去模块管理页面添加)</option>`;
  return allModules.map((m) => `<option value="${m.id}" ${m.id === selectedId ? "selected" : ""}>${m.name}</option>`).join("");
}
function soleModuleId() {
  return allModules.length === 1 ? allModules[0].id : null;
}

function peopleOptionsHtml(selectedName, { allowEmpty = false } = {}) {
  const emptyOpt = allowEmpty ? `<option value="">(未设置)</option>` : "";
  if (allPeople.length === 0) return emptyOpt || `<option value="">(请先去责任人管理页面添加)</option>`;
  return emptyOpt + allPeople.map((p) => `<option value="${p.name}" ${p.name === selectedName ? "selected" : ""}>${p.name}</option>`).join("");
}
function solePersonName() {
  return allPeople.length === 1 ? allPeople[0].name : null;
}

function weekOptionsHtml(selectedId) {
  return allWeeksRaw
    .map((w) => `<option value="${w.id}" ${w.id === selectedId ? "selected" : ""}>${w.natural_week_start}（例会${w.meeting_date}）</option>`)
    .join("");
}

// 删除一个（或一批）任务前，先把引用它们的weekly_task_entries清掉——这些FK没有
// ON DELETE CASCADE(历史周记录不该被源任务删除静默带走)，直接删任务会被DB挡住。
async function confirmAndCascadeDelete({ label, taskIds, deleteFn }) {
  let total = 0;
  for (const id of taskIds) total += await countWeeklyTaskEntriesForTask(id);
  const warn =
    total > 0
      ? `\n\n注意：还有${total}条计划/总结条目引用着，会一并删除（如果已经生成过PPT，这些历史记录也会消失）。`
      : "";
  if (!confirm(`确定删除"${label}"？此操作不可撤销。${warn}`)) return false;
  for (const id of taskIds) {
    await deleteWeeklyTaskEntriesForTask(id);
  }
  await deleteFn();
  return true;
}

// ---------------- 循环任务编号/候选周算法 ----------------

// weekly频率 - 同月内下一次实例level3=上一实例level3+1(跳过的周顺延递补，不留空号)；
// 跨自然月则level2+1、level3重置为1，且无论中间跳过几个月都只+1(顺延式)。
// monthly频率则level2=上一实例level2+1，不使用level3。
function computeNextNumber(project, instances, targetWeek) {
  const frequency = project.recurring_project_settings.frequency;
  if (instances.length === 0) {
    return { level2: 1, level3: frequency === "monthly" ? null : 1 };
  }
  const sorted = [...instances].sort((a, b) => {
    const wa = allWeeks.find((w) => w.id === a.meeting_week_id);
    const wb = allWeeks.find((w) => w.id === b.meeting_week_id);
    return new Date((wa ?? {}).natural_week_start || 0) - new Date((wb ?? {}).natural_week_start || 0);
  });
  const last = sorted[sorted.length - 1];
  const lastWeek = allWeeks.find((w) => w.id === last.meeting_week_id);

  if (frequency === "monthly") {
    return { level2: last.wbs_level2_number + 1, level3: null };
  }
  const sameMonth = lastWeek.calendar_month === targetWeek.calendar_month;
  if (sameMonth) {
    return { level2: last.wbs_level2_number, level3: last.wbs_level3_number + 1 };
  }
  return { level2: last.wbs_level2_number + 1, level3: 1 };
}

// 循环任务项目不再存"起始例会周"这个字段(2026-07-10跟用户确认去掉——这个信息只在创建
// 项目时用一次，创建时就直接生成第一个实例，之后"下一个实例"永远只看"已有实例里最早的
// 那一个"往后找，不需要项目额外记一个开始日期)
function nextUnusedWeek(instances) {
  if (instances.length === 0) return allWeeks[0] ?? null;
  const usedWeekIds = new Set(instances.map((i) => i.meeting_week_id));
  const usedWeeksSorted = instances
    .map((i) => allWeeks.find((w) => w.id === i.meeting_week_id))
    .filter(Boolean)
    .sort((a, b) => new Date(a.natural_week_start) - new Date(b.natural_week_start));
  const firstWeek = usedWeeksSorted[0];
  if (!firstWeek) return null;
  const sorted = [...allWeeks]
    .filter((w) => new Date(w.natural_week_start) >= new Date(firstWeek.natural_week_start))
    .sort((a, b) => new Date(a.natural_week_start) - new Date(b.natural_week_start));
  return sorted.find((w) => !usedWeekIds.has(w.id));
}

// ---------------- 新建任务表单 ----------------

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
  const raw = document.getElementById("owner-select").value;
  const [kind, rest] = raw.split(":");
  if (kind === "new") return { isNew: true, type: rest };
  return { isNew: false, type: kind, id: Number(rest) };
}

// "无(项目本身就是任务)"这个选项只在项目还完全没有任何任务时才提供——一个项目要么是
// "本身就是一条扁平任务"，要么是"往下分解成二级/三级"，两者互斥(DB层用partial unique
// index强制)，不然会出现"项目自己是任务、同时又有子任务"这种说不清楚该看哪个的状态。
function refreshLevel2Options(sel) {
  const level2Select = document.getElementById("wbs-level2-select");
  if (sel.isNew) {
    // 新项目还没建，必然是空的，两个选项都能选
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

// 三级编号默认留空(=这个二级本身就是任务，不再往下分解)——只有明确已经存在三级子任务的
// 二级分组，才自动预填"下一个三级编号"；新建二级分组时不假设一定会有三级，用户测试的任务
// 大多只到二级为止，强行默认填1会导致无法创建纯1+2级任务(2026-07-10用户反馈修正)。
function onLevel2Change(sel) {
  const level2Select = document.getElementById("wbs-level2-select");
  const val = level2Select.value;
  const isNewLevel2 = val === "__new__";
  const isNone = val === "__none__";
  const level3Input = document.getElementById("wbs-level3");
  document.getElementById("wbs-level2-new-wrap").hidden = !isNewLevel2;
  document.getElementById("wbs-level2-title-wrap").hidden = !isNewLevel2;
  if (isNewLevel2) document.getElementById("wbs-level2-title").value = "";
  level3Input.closest("label").hidden = isNone;
  if (isNone) return;
  if (sel.isNew) {
    if (isNewLevel2) {
      document.getElementById("wbs-level2-new").value = 1;
      level3Input.value = "";
    }
    return;
  }
  const project = projects.find((p) => p.id === sel.id);
  const children = project.tasks;
  if (isNewLevel2) {
    const existingLevel2 = children.filter((c) => c.wbs_level2_number != null).map((c) => c.wbs_level2_number);
    const maxLevel2 = existingLevel2.length ? Math.max(...existingLevel2) : 0;
    document.getElementById("wbs-level2-new").value = maxLevel2 + 1;
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

document.getElementById("wbs-level2-select").addEventListener("change", () => onLevel2Change(parseOwnerValue()));

// 循环任务标题/最终交付物按当次生成的月/周动态拼出来——项目只存"动词前缀(title_verb)+
// 名词部分(title_noun)"，比如"制作"+"周例会PPT"，每次生成实例时现算出"7月第4周"这种限定语
// 插进去。monthly频率没有level3(月内不再细分)，限定语只用月份。交付物不带动词前缀。
// "第几周"用的是level3(这个循环任务在本月内的第几次执行，顺延递补算法算出来的)，不是
// 自然日历的week_index_in_month。
function monthWeekLabel(targetWeek, frequency, level3) {
  const month = Number(targetWeek.calendar_month.slice(5, 7));
  return frequency === "monthly" ? `${month}月` : `${month}月第${level3}周`;
}
function generateInstanceTitle(titleVerb, titleNoun, frequency, targetWeek, level3) {
  return `${titleVerb}${monthWeekLabel(targetWeek, frequency, level3)}${titleNoun}`;
}
function generateInstanceDeliverable(titleVerb, titleNoun, frequency, targetWeek, level3) {
  return `${monthWeekLabel(targetWeek, frequency, level3)}${titleNoun}`;
}

function refreshRecurringPreview(projectId) {
  const p = projects.find((x) => x.id === projectId);
  const s = p.recurring_project_settings;
  const previewEl = document.getElementById("recurring-instance-preview");
  const targetWeek = nextUnusedWeek(p.tasks);
  if (!targetWeek) {
    previewEl.textContent = "没有更多可用的例会周了，请先在例会日历里预生成更多周";
    previewEl.className = "status error";
    return;
  }
  const { level2, level3 } = computeNextNumber(p, p.tasks, targetWeek);
  const fullNumber = wbsLabel(p.level1_number, level2, level3);
  const title = generateInstanceTitle(s.title_verb, s.title_noun, s.frequency, targetWeek, level3);
  const deliverable = generateInstanceDeliverable(s.title_verb, s.title_noun, s.frequency, targetWeek, level3);
  previewEl.textContent = `将生成实例 ${fullNumber}「${title}」（对应例会周 ${targetWeek.natural_week_start}，最终交付物：${deliverable}）`;
  previewEl.className = "status";
}

async function onOwnerChange() {
  const sel = parseOwnerValue();
  const isTaskList = sel.type === "sequential" || sel.type === "nonsequential";
  document.getElementById("new-project-fields").hidden = !sel.isNew;
  document.getElementById("new-project-title-wrap").hidden = sel.type === "recurring";
  document.getElementById("new-project-extra-wrap").hidden = sel.type === "recurring";
  document.getElementById("leaf-fields").hidden = !isTaskList;
  document.getElementById("recurring-new-fields").hidden = !(sel.isNew && sel.type === "recurring");
  document.getElementById("recurring-instance-fields").hidden = !(sel.type === "recurring" && !sel.isNew);
  document.getElementById("create-submit-btn").textContent = sel.type === "recurring" && !sel.isNew ? "生成下一个实例" : "新建";

  if (sel.isNew) {
    document.getElementById("new-project-number").value = await suggestNextTaskNumber();
  }
  if (isTaskList) {
    refreshLevel2Options(sel);
    document.getElementById("leaf-module").innerHTML = moduleOptionsHtmlStrict(soleModuleId());
    document.getElementById("leaf-owner").innerHTML = peopleOptionsHtml(solePersonName());
  }
  if (sel.type === "recurring" && sel.isNew) {
    document.getElementById("recurring-module").innerHTML = moduleOptionsHtmlStrict(soleModuleId());
    document.getElementById("recurring-owner-select").innerHTML = peopleOptionsHtml(solePersonName());
  }
  if (sel.type === "recurring" && !sel.isNew) {
    refreshRecurringPreview(sel.id);
  }
}

document.getElementById("owner-select").addEventListener("change", onOwnerChange);

async function createTaskListLeaf(sel) {
  const title = document.getElementById("leaf-title").value.trim();
  const deliverable = document.getElementById("leaf-deliverable").value.trim();
  const completionDate = document.getElementById("leaf-completion-date").value;
  const startDate = document.getElementById("leaf-start-date").value;
  const moduleId = document.getElementById("leaf-module").value || null;
  const owner = document.getElementById("leaf-owner").value.trim();
  const level2Select = document.getElementById("wbs-level2-select");
  const isNewLevel2Group = level2Select.value === "__new__";
  const level2Title = document.getElementById("wbs-level2-title").value.trim();
  let level2 = null;
  let level3 = null;
  if (level2Select.value !== "__none__") {
    level2 = level2Select.value === "__new__" ? Number(document.getElementById("wbs-level2-new").value) : Number(level2Select.value);
    const level3raw = document.getElementById("wbs-level3").value;
    level3 = level3raw ? Number(level3raw) : null;
  }
  if (!title || !deliverable || !completionDate || !moduleId || !owner) {
    throw new Error("任务标题/模块/责任人/最终目标交付物/最终计划完成时间都是必填项");
  }
  // 有1、2、3级的任务每一级都要有标题——新建一个从没出现过的二级编号、同时又填了三级编号，
  // 说明这是在从头搭一个真正的3级任务，二级本身也要有标题
  if (isNewLevel2Group && level3 != null && !level2Title) {
    throw new Error("这个二级任务下有三级子任务，必须填写二级标题");
  }

  let projectId;
  if (sel.isNew) {
    const projTitle = document.getElementById("new-project-title").value.trim();
    if (!projTitle) throw new Error("请填写项目名");
    const level1Number = Number(document.getElementById("new-project-number").value);
    const numberRow = await claimTaskNumber({
      task_type: sel.type,
      title_snapshot: projTitle,
      owning_table: "projects",
      owning_id: 0,
      level1_number: level1Number,
    });
    // 分类/截止日期/项目最终交付物现在是任何task_list类型项目都可选填的通用字段
    // (2026-07-14统一重构前，分类只属于顺序队列、截止日期+项目交付物只属于截止日期类型；
    // 用户核实过下游代码没有真正依赖这种区分，统一放开)
    const category = document.getElementById("new-project-category").value.trim() || null;
    const deadlineDate = document.getElementById("new-project-deadline").value || null;
    const projectDeliverable = document.getElementById("new-project-deliverable").value.trim() || null;
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
  const titleVerb = document.getElementById("recurring-title-verb").value.trim();
  const titleNoun = document.getElementById("recurring-title-noun").value.trim();
  const firstWeekId = Number(document.getElementById("recurring-first-week").value);
  const level1Number = Number(document.getElementById("new-project-number").value);
  const moduleId = document.getElementById("recurring-module").value || null;
  const owner = document.getElementById("recurring-owner-select").value.trim();
  if (!titleNoun || !firstWeekId || !moduleId || !owner) {
    throw new Error("名词部分(交付物)/模块/责任人/第一次的例会周都是必填项");
  }
  const title = titleVerb + titleNoun;
  const numberRow = await claimTaskNumber({
    task_type: "recurring",
    title_snapshot: title,
    owning_table: "projects",
    owning_id: 0,
    level1_number: level1Number,
  });
  const frequency = document.getElementById("recurring-frequency").value;
  const project = await createRecurringProject(
    { title, project_type: "recurring", level1_number: numberRow.level1_number },
    { title_verb: titleVerb, title_noun: titleNoun, frequency, module_id: moduleId, owner }
  );
  await setTaskNumberOwner(numberRow.level1_number, project.id);
  // 第一次的例会周只在这里用一次，直接生成第一个实例，不作为项目的持久字段保存
  // planned_completion_date默认用work_week_end(本周最后工作日，默认周五)而不是meeting_date
  // (本周工作开始日，默认周一)——"这周完成"应该默认对应周五，不是周一
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
  const targetWeek = nextUnusedWeek(p.tasks);
  if (!targetWeek) throw new Error("没有更多可用的例会周了，请先在例会日历里预生成更多周");
  const { level2, level3 } = computeNextNumber(p, p.tasks, targetWeek);
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

document.getElementById("create-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const resultEl = document.getElementById("create-result");
  const sel = parseOwnerValue();
  resultEl.textContent = "处理中...";
  resultEl.className = "status";
  try {
    if (sel.type === "recurring" && sel.isNew) {
      await createRecurringNew();
    } else if (sel.type === "recurring" && !sel.isNew) {
      await generateNextInstance(sel.id);
    } else {
      await createTaskListLeaf(sel);
    }
    resultEl.textContent = "成功";
    resultEl.className = "status ok";
    await reloadAll();
    document.getElementById("leaf-title").value = "";
    document.getElementById("leaf-deliverable").value = "";
    document.getElementById("leaf-completion-date").value = "";
    document.getElementById("leaf-start-date").value = "";
    document.getElementById("wbs-level2-title").value = "";
    document.getElementById("recurring-title-verb").value = "";
    document.getElementById("recurring-title-noun").value = "";
    await onOwnerChange();
  } catch (err) {
    resultEl.textContent = `失败：${err.message}`;
    resultEl.className = "status error";
  }
});

// ---------------- 合并任务表(按项目分组、项目下按二级分组) ----------------

// direct: level2为空的那一条(项目本身就是任务)，最多1条；level2Groups: 按二级编号分组、
// 组内按三级编号排好序——一个二级分组如果只有1条且没有三级编号，说明这个二级本身就是
// 叶子任务(没有再往下分)，不需要单独显示一个分组标题行，直接当普通任务行展示
function groupChildren(children) {
  const direct = children.find((c) => c.wbs_level2_number == null) || null;
  const rest = children.filter((c) => c.wbs_level2_number != null);
  const byLevel2 = new Map();
  for (const c of rest) {
    if (!byLevel2.has(c.wbs_level2_number)) byLevel2.set(c.wbs_level2_number, []);
    byLevel2.get(c.wbs_level2_number).push(c);
  }
  const level2Groups = [...byLevel2.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([level2, items]) => ({
      level2,
      items: items.sort((a, b) => (a.wbs_level3_number ?? 0) - (b.wbs_level3_number ?? 0)),
    }));
  return { direct, level2Groups };
}

function moduleNameFor(moduleId) {
  return allModules.find((m) => m.id === moduleId)?.name ?? "";
}

// 2026-07-14统一任务模型后，module_id/owner/planned_completion_date/actual_completion_date
// 在三种project_type下都是同一批列名，不再需要按类型分支特判
function makeLeafRow(project, item, number) {
  return {
    kind: "leaf",
    key: `task:${item.id}`,
    type: project.project_type,
    typeLabel: PROJECT_TYPE_LABEL[project.project_type],
    number,
    projectName: project.title,
    title: item.title,
    moduleName: moduleNameFor(item.module_id),
    owner: item.owner ?? "",
    deliverable: item.target_deliverable,
    completionDate: item.planned_completion_date,
    actualDate: item.actual_completion_date,
    status: SOURCE_STATUS_LABEL[item.status] ?? item.status,
    project,
    item,
  };
}

function buildDisplayRows() {
  const displayRows = [];

  for (const p of projects) {
    if (p.project_type === "recurring") continue;
    const { direct, level2Groups } = groupChildren(p.tasks);
    if (!direct && level2Groups.length === 0) continue; // 空项目(还没建任何任务)暂不展示
    displayRows.push({ kind: "project-header", label: `[${p.level1_number}] ${p.title}`, typeLabel: PROJECT_TYPE_LABEL[p.project_type] });
    if (direct) displayRows.push(makeLeafRow(p, direct, wbsLabel(p.level1_number, null, null)));
    for (const g of level2Groups) {
      if (g.items.length === 1 && g.items[0].wbs_level3_number == null) {
        displayRows.push(makeLeafRow(p, g.items[0], wbsLabel(p.level1_number, g.level2, null)));
      } else {
        const groupTitle = (p.task_groups || []).find((x) => x.wbs_level2_number === g.level2)?.title || "";
        displayRows.push({
          kind: "level2-header",
          label: `${p.level1_number}.${g.level2}`,
          editableTitle: true,
          project: p,
          level2: g.level2,
          groupTitle,
        });
        for (const t of g.items) {
          displayRows.push(makeLeafRow(p, t, wbsLabel(p.level1_number, g.level2, t.wbs_level3_number)));
        }
      }
    }
  }

  for (const p of projects) {
    if (p.project_type !== "recurring") continue;
    if (p.tasks.length === 0) continue;
    displayRows.push({ kind: "project-header", label: `[${p.level1_number}] ${p.title}`, typeLabel: "循环任务" });
    const byLevel2 = new Map();
    for (const inst of p.tasks) {
      if (!byLevel2.has(inst.wbs_level2_number)) byLevel2.set(inst.wbs_level2_number, []);
      byLevel2.get(inst.wbs_level2_number).push(inst);
    }
    const groups = [...byLevel2.entries()].sort((a, b) => a[0] - b[0]);
    const s = p.recurring_project_settings;
    for (const [level2, items] of groups) {
      const sortedItems = items.sort((a, b) => (a.wbs_level3_number ?? 0) - (b.wbs_level3_number ?? 0));
      if (sortedItems.length === 1 && sortedItems[0].wbs_level3_number == null) {
        displayRows.push(makeLeafRow(p, sortedItems[0], wbsLabel(p.level1_number, level2, null)));
      } else {
        // 2级分组标题也按月份现算(如"制作7月周例会PPT")，不只是干巴巴的编号——
        // 取组内第一个实例的planned_completion_date所在月份，同一个level2分组下的实例
        // 本来就都在同一个月
        const groupMonth = Number(sortedItems[0].planned_completion_date.slice(5, 7));
        const groupLabel = `${p.level1_number}.${level2} ${s.title_verb}${groupMonth}月${s.title_noun}`;
        displayRows.push({ kind: "level2-header", label: groupLabel });
        for (const inst of sortedItems) {
          displayRows.push(makeLeafRow(p, inst, wbsLabel(p.level1_number, level2, inst.wbs_level3_number)));
        }
      }
    }
  }

  return displayRows;
}

function buildDetailPanel(r, locked) {
  const wrap = document.createElement("div");
  const t = r.item;
  const p = r.project;
  const isRecurring = p.project_type === "recurring";

  wrap.innerHTML = `
    <div class="inline-form">
      <label>标题 <input type="text" class="d-title" value="${t.title}" style="min-width:200px" /></label>
      <label>模块 <select class="d-module">${moduleOptionsHtml(t.module_id)}</select></label>
      <label>责任人 <select class="d-owner">${peopleOptionsHtml(t.owner, { allowEmpty: true })}</select></label>
      <label>预计开始日期 <input type="date" class="d-planned-start" value="${t.planned_start_date ?? ""}" /></label>
      <span>实际开始日期：${t.actual_start_date ?? "(尚未进入任何一周计划)"}</span>
    </div>
    <div class="inline-form" style="margin-top:6px;">
      ${
        locked
          ? `<span class="d-locked-display">🔒 最终目标交付物：${t.target_deliverable ?? ""} ｜ 最终计划完成时间：${t.planned_completion_date ?? ""}${
              t.completion_date_amendment_note ? ` <span class="badge">订正：${t.completion_date_amendment_note}</span>` : ""
            } <button type="button" class="secondary d-amend-toggle">订正</button></span>
             <span class="d-amend-form" hidden>
               <label>新的最终目标交付物 <input type="text" class="d-amend-deliverable" value="${t.target_deliverable ?? ""}" style="min-width:200px" /></label>
               <label>新的最终计划完成时间 <input type="date" class="d-amend-date" value="${t.planned_completion_date ?? ""}" /></label>
               <label>订正说明(必填) <input type="text" class="d-amend-note" placeholder="为什么要修改" style="min-width:200px" /></label>
               <button type="button" class="d-amend-confirm">确认订正</button>
               <button type="button" class="secondary d-amend-cancel">取消</button>
             </span>`
          : `<label>最终目标交付物 <input type="text" class="d-deliverable" value="${t.target_deliverable ?? ""}" style="min-width:200px" /></label>
             ${
               isRecurring
                 ? `<span>应完成日期：${t.planned_completion_date}（按编号算法自动生成，不可手改，进入计划锁定后可走"订正"改）</span>`
                 : `<label>最终计划完成时间 <input type="date" class="d-completion" value="${t.planned_completion_date ?? ""}" /></label>`
             }`
      }
      <label>实际完成时间 <input type="date" class="d-actual" value="${t.actual_completion_date ?? ""}" /></label>
      <span>状态：${SOURCE_STATUS_LABEL[t.status] ?? t.status}</span>
      ${t.status !== "stopped" ? `<button type="button" class="secondary d-terminate">标记中止</button>` : ""}
      <button type="button" class="secondary d-delete">删除此任务</button>
    </div>
    <div class="inline-form" style="margin-top:6px;border-top:1px dashed #ccc;padding-top:6px;">
      ${
        isRecurring
          ? `<strong>所属循环任务设置（会影响这个项目下"生成下一个实例"时的默认命名，不会改已有实例）：</strong>
             <label>动词前缀 <input type="text" class="p-title-verb" value="${p.recurring_project_settings.title_verb ?? ""}" placeholder="如：制作" style="width:100px" /></label>
             <label>名词部分(交付物基础名) <input type="text" class="p-title-noun" value="${p.recurring_project_settings.title_noun ?? ""}" placeholder="如：周例会PPT" style="min-width:160px" /></label>
             <select class="p-module">${moduleOptionsHtml(p.recurring_project_settings.module_id)}</select>
             <input type="text" class="p-owner" value="${p.recurring_project_settings.owner ?? ""}" placeholder="责任人" />
             <select class="p-frequency">
               ${["weekly", "monthly", "custom"].map((f) => `<option value="${f}" ${f === p.recurring_project_settings.frequency ? "selected" : ""}>${f}</option>`).join("")}
             </select>
             <select class="p-status">
               ${["active", "completed", "paused"].map((s) => `<option value="${s}" ${s === p.status ? "selected" : ""}>${s}</option>`).join("")}
             </select>
             <button type="button" class="secondary d-delete-project">删除整个循环任务</button>`
          : `<strong>所属项目设置：</strong>
             <label>分类 <input type="text" class="p-category" value="${p.category ?? ""}" style="width:10em" /></label>
             <label>项目截止日期 <input type="date" class="p-deadline" value="${p.deadline_date ?? ""}" /></label>
             <label>项目状态
               <select class="p-status">
                 ${["active", "paused", "completed"].map((s) => `<option value="${s}" ${s === p.status ? "selected" : ""}>${s}</option>`).join("")}
               </select>
             </label>
             <label>项目最终交付物 <input type="text" class="p-deliverable" value="${p.target_deliverable ?? ""}" /></label>
             <button type="button" class="secondary d-delete-project">删除整个项目</button>`
      }
    </div>
  `;

  wrap.querySelector(".d-title").addEventListener("change", async (e) => {
    await updateTask(t.id, { title: e.target.value });
    await reloadAll();
  });
  wrap.querySelector(".d-module").addEventListener("change", async (e) => {
    await updateTask(t.id, { module_id: e.target.value || null });
    await reloadAll();
  });
  wrap.querySelector(".d-owner").addEventListener("change", async (e) => {
    await updateTask(t.id, { owner: e.target.value || null });
    await reloadAll();
  });
  wrap.querySelector(".d-planned-start").addEventListener("change", async (e) => {
    await updateTask(t.id, { planned_start_date: e.target.value || null });
    await reloadAll();
  });
  const deliverableInputLoose = wrap.querySelector(".d-deliverable");
  if (deliverableInputLoose) {
    deliverableInputLoose.addEventListener("change", async (e) => {
      await updateTask(t.id, { target_deliverable: e.target.value || null });
      await reloadAll();
    });
  }
  const completionInput = wrap.querySelector(".d-completion");
  if (completionInput) {
    completionInput.addEventListener("change", async (e) => {
      await updateTask(t.id, { planned_completion_date: e.target.value });
      await reloadAll();
    });
  }
  // 锁定后，最终目标交付物/最终计划完成时间要一起订正(页面内小表单，不用alert()弹窗)——
  // 一旦任务进了某一周的计划，这两项就跟"实际完成时间做效率对比"这个目的绑在一起，改动
  // 都要求写清楚订正说明。2026-07-14统一任务模型后循环任务也纳入这套机制(此前循环任务
  // 不受锁定约束)。
  const amendToggle = wrap.querySelector(".d-amend-toggle");
  if (amendToggle) {
    const amendForm = wrap.querySelector(".d-amend-form");
    const lockedDisplay = wrap.querySelector(".d-locked-display");
    amendToggle.addEventListener("click", () => {
      lockedDisplay.hidden = true;
      amendForm.hidden = false;
    });
    wrap.querySelector(".d-amend-cancel").addEventListener("click", () => {
      amendForm.hidden = true;
      lockedDisplay.hidden = false;
    });
    wrap.querySelector(".d-amend-confirm").addEventListener("click", async () => {
      const note = wrap.querySelector(".d-amend-note").value.trim();
      if (!note) {
        alert("请填写订正说明");
        return;
      }
      const newDeliverable = wrap.querySelector(".d-amend-deliverable").value.trim();
      const newDate = wrap.querySelector(".d-amend-date").value;
      await updateTask(t.id, {
        target_deliverable: newDeliverable || null,
        planned_completion_date: newDate,
        completion_date_amendment_note: note,
      });
      await reloadAll();
    });
  }
  wrap.querySelector(".d-actual").addEventListener("change", async (e) => {
    await updateTask(t.id, { actual_completion_date: e.target.value || null });
    await reloadAll();
  });
  const terminateBtn = wrap.querySelector(".d-terminate");
  if (terminateBtn) {
    terminateBtn.addEventListener("click", async () => {
      if (!confirm(`确定把"${t.title}"标记为中止？不用等总结周期，直接生效。`)) return;
      await updateTask(t.id, { status: "stopped" });
      await reloadAll();
    });
  }
  wrap.querySelector(".d-delete").addEventListener("click", async () => {
    const ok = await confirmAndCascadeDelete({
      label: `任务"${t.title}"`,
      taskIds: [t.id],
      deleteFn: () => deleteTask(t.id),
    });
    if (ok) {
      openDetailKeys.delete(r.key);
      await reloadAll();
    }
  });

  if (isRecurring) {
    const titleVerbInput = wrap.querySelector(".p-title-verb");
    const titleNounInput = wrap.querySelector(".p-title-noun");
    const moduleSelect = wrap.querySelector(".p-module");
    const ownerInput = wrap.querySelector(".p-owner");
    const frequencySelect = wrap.querySelector(".p-frequency");
    const statusSelect = wrap.querySelector(".p-status");
    const saveTemplate = async () => {
      const titleVerb = titleVerbInput.value.trim();
      const titleNoun = titleNounInput.value.trim();
      await updateProject(p.id, { title: titleVerb + titleNoun, status: statusSelect.value });
      await updateRecurringSettings(p.id, {
        title_verb: titleVerb,
        title_noun: titleNoun,
        module_id: moduleSelect.value || null,
        owner: ownerInput.value.trim() || null,
        frequency: frequencySelect.value,
      });
      await reloadAll();
    };
    [titleVerbInput, titleNounInput, moduleSelect, ownerInput, frequencySelect, statusSelect].forEach((el) =>
      el.addEventListener("change", saveTemplate)
    );
    wrap.querySelector(".d-delete-project").addEventListener("click", async () => {
      const ok = await confirmAndCascadeDelete({
        label: `循环任务"${p.title}"（含其下全部${p.tasks.length}个实例，编号${p.level1_number}会被释放可复用）`,
        taskIds: p.tasks.map((i) => i.id),
        deleteFn: async () => {
          await deleteProject(p.id);
          await deleteTaskNumber(p.level1_number);
        },
      });
      if (ok) {
        openDetailKeys.delete(r.key);
        await reloadAll();
      }
    });
  } else {
    const categoryInput = wrap.querySelector(".p-category");
    const deadlineInput = wrap.querySelector(".p-deadline");
    const deliverableInput = wrap.querySelector(".p-deliverable");
    const statusSelect = wrap.querySelector(".p-status");
    const saveProject = async () => {
      await updateProject(p.id, {
        category: categoryInput.value.trim() || null,
        deadline_date: deadlineInput.value || null,
        target_deliverable: deliverableInput.value.trim() || null,
        status: statusSelect.value,
      });
      await reloadAll();
    };
    [categoryInput, deadlineInput, deliverableInput, statusSelect].forEach((el) => el.addEventListener("change", saveProject));
    wrap.querySelector(".d-delete-project").addEventListener("click", async () => {
      const ok = await confirmAndCascadeDelete({
        label: `项目"${p.title}"（含其下全部${p.tasks.length}个任务，编号${p.level1_number}会被释放可复用）`,
        taskIds: p.tasks.map((c) => c.id),
        deleteFn: async () => {
          await deleteProject(p.id);
          await deleteTaskNumber(p.level1_number);
        },
      });
      if (ok) {
        openDetailKeys.delete(r.key);
        await reloadAll();
      }
    });
  }

  return wrap;
}

// "曾经进入过plan"的锁定状态缓存(2026-07-10性能修复)——只在reloadAll()真正重新拉取过
// 数据库数据时才通过computeLockMap()重新计算，renderTaskTable()本身不再发任何请求。
// 2026-07-14统一任务模型后lockMap不再需要排除recurring类型(此前循环任务不受锁定约束，
// 现在统一纳入)，也不再需要分两次查询(顺序队列/截止日期各查一次)，一次listPlannedTaskIds()够了。
let lockMap = new Map();

function computeLockMap(plannedTaskIds) {
  const leafRows = buildDisplayRows().filter((r) => r.kind === "leaf");
  lockMap = new Map(leafRows.map((r) => [r.key, plannedTaskIds.has(r.item.id)]));
}

function renderTaskTable() {
  const rows = buildDisplayRows();
  const tbody = document.getElementById("tasks-tbody");
  tbody.innerHTML = "";
  for (const r of rows) {
    if (r.kind === "project-header") {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td colspan="11" style="background:#f2f2f2;font-weight:600;">${r.label}（${r.typeLabel}）</td>`;
      tbody.appendChild(tr);
      continue;
    }
    if (r.kind === "level2-header") {
      const tr = document.createElement("tr");
      if (r.editableTitle) {
        // 二级本身没有title列(有三级子任务时二级不单独成一行)，标题存在task_groups里，
        // 直接在分组标题行内编辑——这样新建时漏填、或者历史遗留没有标题的二级分组，
        // 都能在这里直接补上
        tr.innerHTML = `<td colspan="11" style="padding-left:2em;color:#666;">${r.label}
          <input type="text" class="level2-title-input" value="${r.groupTitle}" placeholder="二级标题(必填)" style="width:220px" />
        </td>`;
        tr.querySelector(".level2-title-input").addEventListener("change", async (e) => {
          await upsertTaskGroup(r.project.id, r.level2, e.target.value.trim());
          await reloadAll();
        });
      } else {
        tr.innerHTML = `<td colspan="11" style="padding-left:2em;color:#666;">${r.label}</td>`;
      }
      tbody.appendChild(tr);
      continue;
    }

    const locked = lockMap.get(r.key) || false;
    const tr = document.createElement("tr");
    if (r.key === highlightKey) tr.className = "row-highlight";
    tr.innerHTML = `
      <td>${r.number}</td>
      <td>${r.typeLabel}</td>
      <td class="task-col">${r.projectName}</td>
      <td class="task-col">${r.title}</td>
      <td>${r.moduleName}</td>
      <td>${r.owner}</td>
      <td class="task-col">${locked ? `🔒 ${r.deliverable ?? ""}` : r.deliverable ?? ""}</td>
      <td>${locked ? `🔒 ${r.completionDate ?? ""}` : r.completionDate ?? ""}</td>
      <td>${r.actualDate ?? ""}</td>
      <td>${r.status}</td>
      <td><button type="button" class="secondary f-toggle-detail">${openDetailKeys.has(r.key) ? "收起" : "详情"}</button></td>
    `;
    tr.querySelector(".f-toggle-detail").addEventListener("click", () => {
      if (openDetailKeys.has(r.key)) openDetailKeys.delete(r.key);
      else openDetailKeys.add(r.key);
      renderTaskTable();
    });
    tbody.appendChild(tr);

    if (openDetailKeys.has(r.key)) {
      const detailTr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 11;
      td.appendChild(buildDetailPanel(r, locked));
      detailTr.appendChild(td);
      tbody.appendChild(detailTr);
    }
  }
  if (highlightKey) {
    const el = document.querySelector(".row-highlight");
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

// ---------------- 加载 ----------------

// projects表(嵌套tasks/task_groups/recurring_project_settings) + lockMap要用的锁定状态查询，
// 一波2个请求一起并发(2026-07-14统一任务模型后从"三张主表+两次锁定查询"收缩成这两个)
async function reloadAll() {
  const [ps, plannedTaskIds] = await Promise.all([listProjects(), listPlannedTaskIds()]);
  projects = ps;
  computeLockMap(plannedTaskIds);
  renderTaskTable();
  const ownerSelect = document.getElementById("owner-select");
  const prevValue = ownerSelect.value;
  ownerSelect.innerHTML = ownerOptionsHtml();
  if ([...ownerSelect.options].some((o) => o.value === prevValue)) ownerSelect.value = prevValue;
  await onOwnerChange();
}

async function init() {
  // modules/people/meeting_weeks是这个页面的"配套数据"(新建任务表单要用)，不是主数据，
  // 用cache-first减少等待感；有缓存就先同步赋值，跟下面projects的fresh请求一起并发跑。
  const modulesCache = cacheFirst("modules", listModules);
  const peopleCache = cacheFirst("people", listPeople);
  const weeksCache = cacheFirst("meeting_weeks", listMeetingWeeks);
  if (modulesCache.cached) allModules = modulesCache.cached;
  if (peopleCache.cached) allPeople = peopleCache.cached;
  if (weeksCache.cached) {
    allWeeksRaw = weeksCache.cached;
    allWeeks = allWeeksRaw.filter((w) => w.is_normal !== false);
  }

  const weekSelect = document.getElementById("recurring-first-week");
  weekSelect.innerHTML = weekOptionsHtml(null);
  document.getElementById("tasks-tbody").innerHTML = `<tr><td colspan="11">加载中...</td></tr>`;

  const [modules, people, weeks] = await Promise.all([
    modulesCache.freshPromise,
    peopleCache.freshPromise,
    weeksCache.freshPromise,
    reloadAll(),
  ]);
  allModules = modules;
  allPeople = people;
  allWeeksRaw = weeks;
  allWeeks = weeks.filter((w) => w.is_normal !== false);
  weekSelect.innerHTML = weekOptionsHtml(null); // 用最终的fresh数据重渲染一次，保证周下拉是准的
}

await init();
