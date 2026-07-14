import { requireAuth } from "./shared/authGuard.js";
import { renderNav } from "./shared/nav.js";
import {
  listModules,
  listPeople,
  listMeetingWeeks,
  listProjects,
  listProjectHeaders,
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
  // project.tasks为null代表这个项目目前只有缓存的"轻量表头"数据(见init()的project_headers
  // cache-first)、真实任务列表还没从listProjects()拉回来——不能当成"这个项目还没有任何任务"
  // (那样会导致建议出错误的二级编号)，先显示加载中占位，等reloadAll()真正拉到数据后
  // 会自动重新调这个函数(reloadAll()末尾会重新走一次onOwnerChange())。
  if (project.tasks == null) {
    level2Select.innerHTML = `<option value="__loading__">(该项目详情加载中，请稍候再选...)</option>`;
    document.getElementById("wbs-level2-new-wrap").hidden = true;
    document.getElementById("wbs-level2-title-wrap").hidden = true;
    document.getElementById("wbs-level3").closest("label").hidden = true;
    return;
  }
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
  if (val === "__loading__") return; // 加载占位选项，没有真实数据可算，等数据到达后会重新走一遍
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
  if (project.tasks == null) return; // 同上，数据还没到
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

// "编号"输入框的默认值是页面/表单加载那一刻suggestNextTaskNumber()算出来的建议值，用户可以
// 手动改（保留补历史数据时跳号的能力，见createTaskListLeaf/createRecurringNew的调用处）。
// 但如果这段时间里这个号被别的插入抢注了（比如页面加载慢、这段时间又新建了别的项目），
// 提交时就会撞task_number_registry的主键唯一约束——这是个check-then-act竞态，不是提交
// 校验能防住的。2026-07-14用户反馈实测遇到过报错，这里改成撞了主键冲突就自动重新取一个
// 建议值重试（最多5次），并把"编号"框同步更新成实际用上的号，而不是直接把原始报错甩给用户。
async function claimTaskNumberSafe(params) {
  let level1Number = params.level1_number;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await claimTaskNumber({ ...params, level1_number: level1Number });
    } catch (err) {
      const isConflict = /task_number_registry_pkey/.test(err.message || "") || err.code === "23505";
      if (!isConflict || attempt === 4) throw err;
      level1Number = await suggestNextTaskNumber();
      document.getElementById("new-project-number").value = level1Number;
    }
  }
}

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
  const previewEl = document.getElementById("recurring-instance-preview");
  // 同refreshLevel2Options：project_headers缓存没有tasks/recurring_project_settings，
  // 数据没到位前不能瞎算，显示加载中，等reloadAll()拿到真实数据后会自动重新调这个函数
  if (p.tasks == null || p.recurring_project_settings == null) {
    previewEl.textContent = "该循环任务详情加载中，请稍候...";
    previewEl.className = "status";
    return;
  }
  const s = p.recurring_project_settings;
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
  if (level2Select.value === "__loading__") {
    throw new Error("该项目详情还在加载，请稍等片刻再提交");
  }
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
    const numberRow = await claimTaskNumberSafe({
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
  const numberRow = await claimTaskNumberSafe({
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
  if (p.tasks == null || p.recurring_project_settings == null) {
    throw new Error("该循环任务详情还在加载，请稍等片刻再提交");
  }
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

// ---------------- 任务树(1级项目 -> 2级分组 -> 3级任务，默认全部折叠) ----------------
//
// 2026-07-14用户反馈重新设计：原来的"合并表格"把每一行都拍平成完整WBS编号("5.1.1")展示，
// 且二级分组标题是表格里唯一一个不用"详情"就能直接编辑的输入框(不统一、也没有确认动作，
// 容易让人以为它没作用)。改成真正的树状结构——默认全部折叠只显示1级项目，逐级点开才看到
// 下一层，每一级只显示"这一级自己的编号"(不是完整路径)；完整WBS编号只在weekly-report/PPT
// 里用得到，那边走的是taskLabels.js自己的一套编号拼接逻辑，跟这里无关，不受影响。
// 标题编辑统一成"点详情展开后编辑"，1/2/3级用同一套模式——这也顺带补上了一个真实缺口：
// 项目(1级)自己的标题此前完全没有编辑入口，现在跟其他字段一起在项目的"详情"里能改了。

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

const EMPTY_LEAF_FIELDS = { moduleName: "", owner: "", deliverable: "", completionDate: "", actualDate: "", status: "" };

// 叶子节点(kind:"leaf")不管处在树的哪一层(项目本身就是任务/二级本身是叶子/三级/循环实例)，
// 内容形状完全一样——module_id/owner/planned_completion_date/actual_completion_date在
// 三种project_type下都是同一批列名，不再需要按类型或按层级特判
function makeLeafNode(project, item, localNumber, typeLabel = "") {
  return {
    kind: "leaf",
    key: `task:${item.id}`,
    localNumber,
    title: item.title,
    typeLabel,
    moduleName: moduleNameFor(item.module_id),
    owner: item.owner ?? "",
    deliverable: item.target_deliverable,
    completionDate: item.planned_completion_date,
    actualDate: item.actual_completion_date,
    status: SOURCE_STATUS_LABEL[item.status] ?? item.status,
    project,
    item,
    children: [],
  };
}

function makeContainerNode(kind, key, localNumber, title, typeLabel, project, children, extra = {}) {
  return { kind, key, localNumber, title, typeLabel, ...EMPTY_LEAF_FIELDS, project, children, ...extra };
}

function level2NodeForTaskList(p, g) {
  if (g.items.length === 1 && g.items[0].wbs_level3_number == null) {
    return makeLeafNode(p, g.items[0], `${g.level2}`);
  }
  const groupTitle = (p.task_groups || []).find((x) => x.wbs_level2_number === g.level2)?.title || "";
  const children = g.items.map((item) => makeLeafNode(p, item, `${item.wbs_level3_number}`));
  return makeContainerNode("group", `group:${p.id}:${g.level2}`, `${g.level2}`, groupTitle || "(未命名，点详情补充)", "", p, children, {
    level2: g.level2,
    groupTitle,
  });
}

function level2NodeForRecurring(p, g) {
  if (g.items.length === 1 && g.items[0].wbs_level3_number == null) {
    return makeLeafNode(p, g.items[0], `${g.level2}`);
  }
  const s = p.recurring_project_settings;
  const groupMonth = Number(g.items[0].planned_completion_date.slice(5, 7));
  const children = g.items.map((item) => makeLeafNode(p, item, `${item.wbs_level3_number}`));
  return makeContainerNode(
    "group",
    `group:${p.id}:${g.level2}`,
    `${g.level2}`,
    `${s.title_verb}${groupMonth}月${s.title_noun}`,
    "",
    p,
    children,
    { level2: g.level2 }
  );
}

// 只有project_headers缓存(id/level1_number/title/project_type/status，没有嵌套tasks)时，
// 1级项目行本身其实已经够画出来了——树默认全折叠，首屏本来就只需要显示到1级。做成一个
// 禁用交互的占位节点(没有可点的展开箭头/详情按钮，只显示"…"/"加载中")，等listProjects()
// 真实数据到达后buildTree()会用完整数据重新渲染，占位状态自动被替换掉。
function makeLoadingProjectNode(p) {
  return {
    kind: "project",
    key: `project:${p.id}`,
    localNumber: `${p.level1_number}`,
    title: p.title,
    typeLabel: p.project_type === "recurring" ? "循环任务" : PROJECT_TYPE_LABEL[p.project_type],
    ...EMPTY_LEAF_FIELDS,
    project: p,
    children: [],
    loading: true,
  };
}

function buildTree() {
  const roots = [];

  for (const p of projects) {
    if (p.project_type === "recurring") continue;
    if (p.tasks == null) {
      roots.push(makeLoadingProjectNode(p));
      continue;
    }
    const { direct, level2Groups } = groupChildren(p.tasks);
    if (!direct && level2Groups.length === 0) continue; // 空项目(还没建任何任务)暂不展示
    if (direct && level2Groups.length === 0) {
      // 项目本身就是任务：1级节点自己就是叶子，没有下一层可展开
      roots.push(makeLeafNode(p, direct, `${p.level1_number}`, PROJECT_TYPE_LABEL[p.project_type]));
    } else {
      const children = level2Groups.map((g) => level2NodeForTaskList(p, g));
      roots.push(makeContainerNode("project", `project:${p.id}`, `${p.level1_number}`, p.title, PROJECT_TYPE_LABEL[p.project_type], p, children));
    }
  }

  for (const p of projects) {
    if (p.project_type !== "recurring") continue;
    if (p.tasks == null) {
      roots.push(makeLoadingProjectNode(p));
      continue;
    }
    if (p.tasks.length === 0) continue;
    const { level2Groups } = groupChildren(p.tasks); // 循环任务实例的wbs_level2_number恒非空，不会有direct
    const children = level2Groups.map((g) => level2NodeForRecurring(p, g));
    roots.push(makeContainerNode("project", `project:${p.id}`, `${p.level1_number}`, p.title, "循环任务", p, children));
  }

  return roots;
}

// highlightKey(来自weekly-report.js"编辑任务信息"跳转链接)指向的可能是被折叠祖先节点
// 挡住的深层叶子——渲染前先把它的整条祖先路径展开，否则默认全折叠状态下这一行根本不会
// 出现在DOM里，scrollIntoView也无从谈起
function expandAncestorsFor(tree, targetKey, openSet, ancestors = []) {
  for (const node of tree) {
    if (node.key === targetKey) {
      ancestors.forEach((k) => openSet.add(k));
      return true;
    }
    if (node.children.length > 0 && expandAncestorsFor(node.children, targetKey, openSet, [...ancestors, node.key])) {
      return true;
    }
  }
  return false;
}

// 叶子节点的"详情"：标题/模块/责任人/预计开始日期/最终目标交付物/最终计划完成时间(含锁定
// 订正)/实际完成时间/状态/中止/删除——不再包含"所属项目/循环任务设置"，那部分现在是
// 项目自己这个节点的详情内容(buildProjectDetailPanel)，不再嵌在每个叶子的详情里重复。
function buildLeafDetailPanel(node) {
  const wrap = document.createElement("div");
  const t = node.item;

  wrap.innerHTML = `
    <div class="inline-form">
      <label>标题 <input type="text" class="d-title" value="${t.title}" style="min-width:200px" /></label>
      <label>模块 <select class="d-module">${moduleOptionsHtml(t.module_id)}</select></label>
      <label>责任人 <select class="d-owner">${peopleOptionsHtml(t.owner, { allowEmpty: true })}</select></label>
      <label>预计开始日期 <input type="date" class="d-planned-start" value="${t.planned_start_date ?? ""}" /></label>
      <span>实际开始日期：${t.actual_start_date ?? "(尚未进入任何一周计划)"}</span>
    </div>
    <div class="inline-form" style="margin-top:6px;">
      <span class="d-locked-display">🔒 最终目标交付物：${t.target_deliverable ?? ""} ｜ 最终计划完成时间：${t.planned_completion_date ?? ""}${
        t.completion_date_amendment_note ? ` <span class="badge">订正：${t.completion_date_amendment_note}</span>` : ""
      } <button type="button" class="secondary d-amend-toggle">订正</button></span>
      <span class="d-amend-form" hidden>
        <label>新的最终目标交付物 <input type="text" class="d-amend-deliverable" value="${t.target_deliverable ?? ""}" style="min-width:200px" /></label>
        <label>新的最终计划完成时间 <input type="date" class="d-amend-date" value="${t.planned_completion_date ?? ""}" /></label>
        <label>订正说明(必填) <input type="text" class="d-amend-note" placeholder="为什么要修改" style="min-width:200px" /></label>
        <button type="button" class="d-amend-confirm">确认订正</button>
        <button type="button" class="secondary d-amend-cancel">取消</button>
      </span>
      <label>实际完成时间 <input type="date" class="d-actual" value="${t.actual_completion_date ?? ""}" /></label>
      <span>状态：${SOURCE_STATUS_LABEL[t.status] ?? t.status}</span>
      ${t.status !== "stopped" ? `<button type="button" class="secondary d-terminate">标记中止</button>` : ""}
      <button type="button" class="d-save">保存</button>
      <button type="button" class="secondary d-delete">删除此任务</button>
      <span class="d-save-result status"></span>
    </div>
  `;

  // 2026-07-14用户明确要求：不管几级任务，字段改动都不该随change事件即时落库，统一改成
  // 点"保存"按钮一次性批量提交这个面板里的所有字段——标题/模块/责任人/预计开始日期/
  // 实际完成时间，一个updateTask()调用搞定。最终目标交付物/最终计划完成时间不在这个
  // "保存"按钮管辖范围内，见下面的"订正"表单。
  wrap.querySelector(".d-save").addEventListener("click", async () => {
    const resultEl = wrap.querySelector(".d-save-result");
    resultEl.textContent = "保存中...";
    resultEl.className = "d-save-result status";
    try {
      const patch = {
        title: wrap.querySelector(".d-title").value,
        module_id: wrap.querySelector(".d-module").value || null,
        owner: wrap.querySelector(".d-owner").value || null,
        planned_start_date: wrap.querySelector(".d-planned-start").value || null,
        actual_completion_date: wrap.querySelector(".d-actual").value || null,
      };
      await updateTask(t.id, patch);
      resultEl.textContent = "已保存";
      resultEl.className = "d-save-result status ok";
      await reloadAll();
    } catch (err) {
      resultEl.textContent = `保存失败：${err.message}`;
      resultEl.className = "d-save-result status error";
    }
  });

  // 2026-07-14用户明确要求取消"进入过计划才锁定"这个条件判断——之前只有已经排进过某一周
  // 计划的任务，改最终目标交付物/最终计划完成时间才需要走"订正"说明，没排进过计划的可以
  // 自由改；用户指出这个区分没有意义(比如"计划外"直接标完成的任务永远不会进plan，却也
  // 已经是历史事实，同样不该被随便改掉不留痕迹)，改成**不管什么情况**，这两个字段的改动
  // 都必须走订正说明，没有"自由编辑"这个状态了——原来分plan/summary判断"是否锁定"的
  // lockMap/computeLockMap/listPlannedTaskIds整套逻辑也一并删除(见reloadAll()/renderNode()
  // 的对应改动)，任务列表里也不再需要🔒图标区分"这条锁了/那条没锁"，因为现在所有任务的
  // 这两个字段都是同一种编辑方式。
  const amendForm = wrap.querySelector(".d-amend-form");
  const lockedDisplay = wrap.querySelector(".d-locked-display");
  wrap.querySelector(".d-amend-toggle").addEventListener("click", () => {
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
      openDetailKeys.delete(node.key);
      await reloadAll();
    }
  });

  return wrap;
}

// 项目(1级)节点的"详情"：task_list类型现在补上了标题编辑(此前完全没有入口)+分类/截止
// 日期/状态/项目最终交付物；recurring类型是动词前缀/名词部分/默认模块责任人/频率/状态。
// 两种类型都带"删除整个项目/循环任务"。
function buildProjectDetailPanel(node) {
  const wrap = document.createElement("div");
  const p = node.project;
  const isRecurring = p.project_type === "recurring";

  wrap.innerHTML = isRecurring
    ? `<div class="inline-form">
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
         <button type="button" class="p-save">保存</button>
         <button type="button" class="secondary d-delete-project">删除整个循环任务</button>
         <span class="p-save-result status"></span>
       </div>`
    : `<div class="inline-form">
         <label>标题 <input type="text" class="p-title" value="${p.title}" style="min-width:200px" /></label>
         <label>分类 <input type="text" class="p-category" value="${p.category ?? ""}" style="width:10em" /></label>
         <label>项目截止日期 <input type="date" class="p-deadline" value="${p.deadline_date ?? ""}" /></label>
         <label>项目状态
           <select class="p-status">
             ${["active", "paused", "completed"].map((s) => `<option value="${s}" ${s === p.status ? "selected" : ""}>${s}</option>`).join("")}
           </select>
         </label>
         <label>项目最终交付物 <input type="text" class="p-deliverable" value="${p.target_deliverable ?? ""}" /></label>
         <button type="button" class="p-save">保存</button>
         <button type="button" class="secondary d-delete-project">删除整个项目</button>
         <span class="p-save-result status"></span>
       </div>`;

  // 2026-07-14用户明确要求：项目级字段同样不再随change事件即时落库，改成一个"保存"按钮
  // 一次性批量提交这个面板里的所有字段。
  if (isRecurring) {
    const titleVerbInput = wrap.querySelector(".p-title-verb");
    const titleNounInput = wrap.querySelector(".p-title-noun");
    const moduleSelect = wrap.querySelector(".p-module");
    const ownerInput = wrap.querySelector(".p-owner");
    const frequencySelect = wrap.querySelector(".p-frequency");
    const statusSelect = wrap.querySelector(".p-status");
    wrap.querySelector(".p-save").addEventListener("click", async () => {
      const resultEl = wrap.querySelector(".p-save-result");
      resultEl.textContent = "保存中...";
      resultEl.className = "p-save-result status";
      try {
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
        resultEl.textContent = "已保存";
        resultEl.className = "p-save-result status ok";
        await reloadAll();
      } catch (err) {
        resultEl.textContent = `保存失败：${err.message}`;
        resultEl.className = "p-save-result status error";
      }
    });
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
        openDetailKeys.delete(node.key);
        openChildrenKeys.delete(node.key);
        await reloadAll();
      }
    });
  } else {
    const titleInput = wrap.querySelector(".p-title");
    const categoryInput = wrap.querySelector(".p-category");
    const deadlineInput = wrap.querySelector(".p-deadline");
    const deliverableInput = wrap.querySelector(".p-deliverable");
    const statusSelect = wrap.querySelector(".p-status");
    wrap.querySelector(".p-save").addEventListener("click", async () => {
      const resultEl = wrap.querySelector(".p-save-result");
      resultEl.textContent = "保存中...";
      resultEl.className = "p-save-result status";
      try {
        await updateProject(p.id, {
          title: titleInput.value.trim() || p.title,
          category: categoryInput.value.trim() || null,
          deadline_date: deadlineInput.value || null,
          target_deliverable: deliverableInput.value.trim() || null,
          status: statusSelect.value,
        });
        resultEl.textContent = "已保存";
        resultEl.className = "p-save-result status ok";
        await reloadAll();
      } catch (err) {
        resultEl.textContent = `保存失败：${err.message}`;
        resultEl.className = "p-save-result status error";
      }
    });
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
        openDetailKeys.delete(node.key);
        openChildrenKeys.delete(node.key);
        await reloadAll();
      }
    });
  }

  return wrap;
}

// 二级分组节点的"详情"：task_list类型是唯一能编辑这个分组标题的地方(task_groups表)；
// recurring类型的分组标题是按月份自动算出来的，没有可编辑内容，只做说明。
function buildGroupDetailPanel(node) {
  const wrap = document.createElement("div");
  const p = node.project;
  if (p.project_type === "recurring") {
    wrap.innerHTML = `<span>该分组标题按"动词前缀+月份+名词部分"自动生成，不能手改——要改就去上一级"循环任务"项目的详情里改动词前缀/名词部分。</span>`;
    return wrap;
  }
  wrap.innerHTML = `
    <label>二级标题(必填) <input type="text" class="g-title" value="${node.groupTitle}" placeholder="如：制作方案" style="min-width:220px" /></label>
    <button type="button" class="g-save">保存</button>
    <span class="g-save-result status"></span>
  `;
  wrap.querySelector(".g-save").addEventListener("click", async () => {
    const resultEl = wrap.querySelector(".g-save-result");
    resultEl.textContent = "保存中...";
    resultEl.className = "g-save-result status";
    try {
      await upsertTaskGroup(p.id, node.level2, wrap.querySelector(".g-title").value.trim());
      resultEl.textContent = "已保存";
      resultEl.className = "g-save-result status ok";
      await reloadAll();
    } catch (err) {
      resultEl.textContent = `保存失败：${err.message}`;
      resultEl.className = "g-save-result status error";
    }
  });
  return wrap;
}

function buildDetailPanelForNode(node) {
  if (node.kind === "leaf") return buildLeafDetailPanel(node);
  if (node.kind === "group") return buildGroupDetailPanel(node);
  return buildProjectDetailPanel(node);
}

// 哪些非叶子节点(项目/二级分组)当前展开显示子节点——默认全部折叠，用户逐级点开
// (2026-07-14用户反馈重新设计：原来是一次性拍平显示全部层级，现在改成文件树式逐级展开)
let openChildrenKeys = new Set();

const TABLE_COLSPAN = 10;

function renderTaskTable() {
  const tree = buildTree();
  if (highlightKey) expandAncestorsFor(tree, highlightKey, openChildrenKeys);
  const tbody = document.getElementById("tasks-tbody");
  tbody.innerHTML = "";
  for (const node of tree) {
    renderNode(node, 0, tbody);
  }
  if (highlightKey) {
    const el = document.querySelector(".row-highlight");
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

function renderNode(node, depth, tbody) {
  const hasChildren = node.children.length > 0;
  const expanded = openChildrenKeys.has(node.key);
  const detailOpen = openDetailKeys.has(node.key);

  const tr = document.createElement("tr");
  if (node.key === highlightKey) tr.className = "row-highlight";
  // loading节点(只有project_headers缓存、真实tasks还没到)不给可点的展开/详情按钮——
  // 这时候还不知道它有没有子节点/是不是叶子，点了也没有真实数据可展开，干脆禁用掉，
  // 等真实数据到达触发下一次renderTaskTable()自动换成可交互状态
  const toggleCell = node.loading
    ? `<span class="status">…</span> `
    : hasChildren
    ? `<button type="button" class="secondary tree-toggle">${expanded ? "▾" : "▸"}</button> `
    : "";
  const detailCell = node.loading
    ? `<span class="status">加载中</span>`
    : `<button type="button" class="secondary node-detail-toggle">${detailOpen ? "收起" : "详情"}</button>`;
  tr.innerHTML = `
    <td style="padding-left:${depth * 1.5}em">${toggleCell}${node.localNumber}</td>
    <td>${node.typeLabel}</td>
    <td class="task-col">${node.title}</td>
    <td>${node.moduleName}</td>
    <td>${node.owner}</td>
    <td class="task-col">${node.deliverable ?? ""}</td>
    <td>${node.completionDate ?? ""}</td>
    <td>${node.actualDate ?? ""}</td>
    <td>${node.status}</td>
    <td>${detailCell}</td>
  `;
  if (hasChildren && !node.loading) {
    tr.querySelector(".tree-toggle").addEventListener("click", () => {
      if (expanded) openChildrenKeys.delete(node.key);
      else openChildrenKeys.add(node.key);
      renderTaskTable();
    });
  }
  if (!node.loading) {
    tr.querySelector(".node-detail-toggle").addEventListener("click", () => {
      if (detailOpen) openDetailKeys.delete(node.key);
      else openDetailKeys.add(node.key);
      renderTaskTable();
    });
  }
  tbody.appendChild(tr);

  if (detailOpen) {
    const detailTr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = TABLE_COLSPAN;
    td.appendChild(buildDetailPanelForNode(node));
    detailTr.appendChild(td);
    tbody.appendChild(detailTr);
  }

  if (hasChildren && expanded) {
    for (const child of node.children) {
      renderNode(child, depth + 1, tbody);
    }
  }
}

// ---------------- 加载 ----------------

// 2026-07-14用户明确要求取消"进入过计划才锁定"逻辑后，不再需要listPlannedTaskIds()这次
// 额外查询，只用listProjects()一个请求就够了。
async function reloadAll() {
  projects = await listProjects();
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
  // project_headers(一级项目的id/编号/标题/类型，不含嵌套任务)同理——项目本身一年最多
  // 几十个、改动很低频，跟modules/people是同一类适合缓存的小表(2026-07-14用户建议)，
  // 用来让"归属"下拉能立刻显示真实项目名而不是空等listProjects()那个带嵌套任务的重查询。
  // 缓存条目里tasks/task_groups/recurring_project_settings显式设成null(不是[])作为
  // "还没真正加载"的标记——如果当成空数组，级联编号/循环任务候选周这些逻辑会误以为
  // 这个项目真的还没有任何任务，算出错误的建议编号；下面的refreshLevel2Options()/
  // refreshRecurringPreview()/generateNextInstance()都专门检查了这个null标记，
  // 命中时显示"加载中"而不是瞎算，等listProjects()真正返回后(reloadAll()内)会自动刷新。
  const modulesCache = cacheFirst("modules", listModules);
  const peopleCache = cacheFirst("people", listPeople);
  const weeksCache = cacheFirst("meeting_weeks", listMeetingWeeks);
  const projectHeadersCache = cacheFirst("project_headers", listProjectHeaders);
  if (modulesCache.cached) allModules = modulesCache.cached;
  if (peopleCache.cached) allPeople = peopleCache.cached;
  if (weeksCache.cached) {
    allWeeksRaw = weeksCache.cached;
    allWeeks = allWeeksRaw.filter((w) => w.is_normal !== false);
  }
  if (projectHeadersCache.cached) {
    projects = projectHeadersCache.cached.map((p) => ({ ...p, tasks: null, task_groups: null, recurring_project_settings: null }));
  }

  const weekSelect = document.getElementById("recurring-first-week");
  weekSelect.innerHTML = weekOptionsHtml(null);
  // 树默认全折叠，首屏本来就只需要显示到1级——如果project_headers缓存有数据，直接用它
  // 渲染出1级项目行(展开箭头/详情按钮先禁用，见makeLoadingProjectNode)，不用干等
  // listProjects()那个带嵌套tasks的重查询；完全没缓存(比如第一次打开这个页面)才退回
  // "加载中..."占位。
  if (projects.length > 0) {
    renderTaskTable();
  } else {
    document.getElementById("tasks-tbody").innerHTML = `<tr><td colspan="10">加载中...</td></tr>`;
  }

  // "新建任务"表单本身不依赖"全部任务"列表数据——归属下拉先用ownerOptionsHtml()在projects
  // 还是空数组/缓存表头的状态下渲染，让创建新项目这条路径立刻可用，不用等listProjects()
  // 这个网络请求跑完。等真实项目列表到达后，reloadAll()末尾会用真实数据重新渲染一次这个
  // 下拉(2026-07-14用户反馈修复——之前owner-select完全靠reloadAll()才有选项，新建表单在
  // 数据没读完前形同虚设，即使"新建"操作本身根本不需要读现有任务)。
  document.getElementById("owner-select").innerHTML = ownerOptionsHtml();
  await onOwnerChange();

  const [modules, people, weeks] = await Promise.all([
    modulesCache.freshPromise,
    peopleCache.freshPromise,
    weeksCache.freshPromise,
    projectHeadersCache.freshPromise, // 只用来刷新缓存本身供下次打开页面用；真正驱动UI的
    // 是reloadAll()里listProjects()带回来的完整数据，这里不把结果写回projects，避免跟
    // reloadAll()的写入互相覆盖(listProjects()先/后到达都不该被这个轻量查询的结果打回原形)
    reloadAll(),
  ]);
  allModules = modules;
  allPeople = people;
  allWeeksRaw = weeks;
  allWeeks = weeks.filter((w) => w.is_normal !== false);
  weekSelect.innerHTML = weekOptionsHtml(null); // 用最终的fresh数据重渲染一次，保证周下拉是准的
}

await init();
