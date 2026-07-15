import { supabase } from "./supabaseClient.js";

function unwrap({ data, error }) {
  if (error) throw error;
  return data;
}

// ---- modules ----
export const listModules = () =>
  supabase.from("modules").select("*").order("name").then(unwrap);
export const createModule = (name) =>
  supabase.from("modules").insert({ name }).select().single().then(unwrap);
export const deleteModule = (id) =>
  supabase.from("modules").delete().eq("id", id).then(unwrap);
// "当前模块"标记(2026-07-16新增，见sql/0022)：先把其它行清空，再把目标行设true——
// is_current上有partial unique index(最多一行为true)，这个顺序保证中间不会经过
// "两行同时为true"的状态，不会撞约束。
export const setCurrentModule = async (id) => {
  await supabase.from("modules").update({ is_current: false }).neq("id", id).then(unwrap);
  await supabase.from("modules").update({ is_current: true }).eq("id", id).then(unwrap);
};

// ---- people (责任人配置列表，跟modules同构，供任务创建表单默认预填用) ----
export const listPeople = () =>
  supabase.from("people").select("*").order("name").then(unwrap);
export const createPerson = (name) =>
  supabase.from("people").insert({ name }).select().single().then(unwrap);
export const deletePerson = (id) =>
  supabase.from("people").delete().eq("id", id).then(unwrap);
export const setCurrentPerson = async (id) => {
  await supabase.from("people").update({ is_current: false }).neq("id", id).then(unwrap);
  await supabase.from("people").update({ is_current: true }).eq("id", id).then(unwrap);
};

// ---- meeting_weeks ----
export const listMeetingWeeks = () =>
  supabase.from("meeting_weeks").select("*").order("natural_week_start").then(unwrap);
export const bulkUpsertMeetingWeeks = (rows) =>
  supabase
    .from("meeting_weeks")
    .upsert(rows, { onConflict: "natural_week_start", ignoreDuplicates: true })
    .select()
    .then(unwrap);
export const updateMeetingWeekFields = (id, patch) =>
  supabase.from("meeting_weeks").update(patch).eq("id", id).select().single().then(unwrap);
export const deleteMeetingWeek = (id) =>
  supabase.from("meeting_weeks").delete().eq("id", id).then(unwrap);

// ---- task_number_registry ----
// 分配一个新的一级编号，返回整条 registry 记录（.level1_number 就是拿到的编号）。
// level1_number 可选传入显式值（创建表单里用户手动订正过默认预填的编号时）——不传则用
// 数据库 nextval 默认值。
export const claimTaskNumber = ({ task_type, title_snapshot, owning_table, owning_id, level1_number }) =>
  supabase
    .from("task_number_registry")
    .insert({
      task_type,
      title_snapshot,
      owning_table,
      owning_id,
      ...(level1_number != null ? { level1_number } : {}),
    })
    .select()
    .single()
    .then(unwrap);
// 新建项目/任务表单预填"默认下一个编号"用：当前已分配过的最大一级编号+1（没有任何记录则从1开始）。
// 只是UI默认值，用户可以手动改成任意未占用的编号（补历史数据时可能不按顺序）。
export const suggestNextTaskNumber = () =>
  supabase
    .from("task_number_registry")
    .select("level1_number")
    .order("level1_number", { ascending: false })
    .limit(1)
    .then(unwrap)
    .then((rows) => (rows[0]?.level1_number ?? 0) + 1);
export const setTaskNumberOwner = (level1Number, owningId) =>
  supabase
    .from("task_number_registry")
    .update({ owning_id: owningId })
    .eq("level1_number", level1Number)
    .then(unwrap);
// "编号"如果被显式传入(level1_number)，通常是调用方刚用suggestNextTaskNumber()算出来的
// 建议值——但这中间存在check-then-act竞态：建议值算出到真正insert之间，这个号可能已经被
// 别的插入抢注了，届时会撞task_number_registry的主键唯一约束。这里包一层重试：撞到这个
// 特定冲突就自动重新取一次suggestNextTaskNumber()再插入(最多5次)。onRetry(newNumber)可选，
// 每次重试成功拿到新建议号时调用，供调用方同步UI(比如tasks.js的"编号"输入框)——2026-07-14
// 从tasks.js内部私有函数挪到这里导出，供bulk-import.js批量导入时复用同一套重试逻辑，不用
// 各自实现一份。
export async function claimTaskNumberSafe(params, onRetry) {
  let level1Number = params.level1_number;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await claimTaskNumber({ ...params, level1_number: level1Number });
    } catch (err) {
      const isConflict = /task_number_registry_pkey/.test(err.message || "") || err.code === "23505";
      if (!isConflict || attempt === 4) throw err;
      level1Number = await suggestNextTaskNumber();
      if (onRetry) onRetry(level1Number);
    }
  }
}
// 2026-07-10用户明确要求：删除整个项目/模板时编号要真正释放、可以复用，不是"永久占用"。
// 硬删除registry行(而不是只标记retired_at)——调用方必须先删掉引用这个level1_number的
// 项目行(projects.level1_number 列是FK，项目行还在的话这里会被约束挡住，顺序不能反)。
export const deleteTaskNumber = (level1Number) =>
  supabase.from("task_number_registry").delete().eq("level1_number", level1Number).then(unwrap);

// ---- projects (2026-07-14统一重构：替代queue_projects/deadline_projects/
// recurring_task_templates三张几乎同构的项目表，project_type='sequential'|'nonsequential'|
// 'recurring'区分行为，recurring类型的专属信息在recurring_project_settings侧表) ----
export const listProjects = () =>
  supabase
    .from("projects")
    .select("*, tasks(*), task_groups(*), recurring_project_settings(*)")
    .order("level1_number")
    .then(unwrap);
// 轻量版：不带嵌套tasks/task_groups/recurring_project_settings，只查projects表自己的列。
// 一级任务(项目)一年最多几十个、改动很低频，跟modules/people属于同一类适合cache-first的
// 小表(2026-07-14用户建议)——供tasks.js"归属"下拉在listProjects()完整数据还没到达前就能
// 立刻显示真实项目名称/编号。留意：这个查询不含tasks，不能用来做级联编号/候选池这类需要
// 任务级数据的逻辑，那些必须等listProjects()。
export const listProjectHeaders = () =>
  supabase.from("projects").select("id, level1_number, title, project_type, status").order("level1_number").then(unwrap);
export const getProject = (id) =>
  supabase
    .from("projects")
    .select("*, tasks(*), task_groups(*), recurring_project_settings(*)")
    .eq("id", id)
    .single()
    .then(unwrap);
export const createProject = (row) =>
  supabase.from("projects").insert(row).select().single().then(unwrap);
// recurring类型项目创建时连带插入recurring_project_settings一行(1:1侧表)
export const createRecurringProject = async (row, settings) => {
  const project = await createProject(row);
  await supabase.from("recurring_project_settings").insert({ project_id: project.id, ...settings }).then(unwrap);
  return project;
};
export const updateProject = (id, patch) =>
  supabase
    .from("projects")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single()
    .then(unwrap);
export const updateRecurringSettings = (projectId, patch) =>
  supabase.from("recurring_project_settings").update(patch).eq("project_id", projectId).select().single().then(unwrap);
export const deleteProject = (id) =>
  supabase.from("projects").delete().eq("id", id).then(unwrap);

// ---- tasks (替代queue_project_tasks/deadline_milestones/recurring_task_instances) ----
export const addTask = (projectId, task) =>
  supabase
    .from("tasks")
    .insert({ project_id: projectId, ...task })
    .select()
    .single()
    .then(unwrap);
export const updateTask = (id, patch) =>
  supabase.from("tasks").update(patch).eq("id", id).select().single().then(unwrap);
export const deleteTask = (id) =>
  supabase.from("tasks").delete().eq("id", id).then(unwrap);
// 二级任务标题——只有"这个二级下还有三级子任务"时才需要(二级本身不再单独成一行，没地方
// 存自己的title)，2026-07-10用户明确要求有1/2/3级的任务每一级都要有标题
export const upsertTaskGroup = (projectId, level2Number, title) =>
  supabase
    .from("task_groups")
    .upsert({ project_id: projectId, wbs_level2_number: level2Number, title }, { onConflict: "project_id,wbs_level2_number" })
    .select()
    .single()
    .then(unwrap);
// 循环任务"这周该生成/显示哪个实例"——task_list类型的任务meeting_week_id恒为null，
// 这个查询天然只会命中recurring类型的任务
export const listTasksForWeek = (weekId) =>
  supabase.from("tasks").select("*, projects(*, recurring_project_settings(*))").eq("meeting_week_id", weekId).then(unwrap);

// ---- weekly_task_entries ----
// sort_order是用户在网页上用上/下箭头手动调整的展示顺序(2026-07-15新增，见sql/0021)，
// 不再是按WBS编号自动排——手动做PPT时"上周未完成"经常排在"本周新增"前面，不一定按编号。
// nullsFirst:false配合id兜底：万一某条记录漏赋sort_order，排序时自然落到同组末尾，不会
// 报错或错位到最前面。
export const listWeeklyTaskEntries = (meetingWeekId, appearsIn) =>
  supabase
    .from("weekly_task_entries")
    .select("*")
    .eq("meeting_week_id", meetingWeekId)
    .eq("appears_in", appearsIn)
    .order("sort_order", { ascending: true, nullsFirst: false })
    .order("id")
    .then(unwrap);
export const createWeeklyTaskEntry = (row) =>
  supabase.from("weekly_task_entries").insert(row).select().single().then(unwrap);
export const updateWeeklyTaskEntry = (id, patch) =>
  supabase
    .from("weekly_task_entries")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single()
    .then(unwrap);
export const deleteWeeklyTaskEntry = (id) =>
  supabase.from("weekly_task_entries").delete().eq("id", id).then(unwrap);
// weekly_task_entries.task_id没有加ON DELETE CASCADE（历史周记录不该被源任务删除静默带走），
// 所以删除一个任务前，如果还有weekly_task_entries引用着它，数据库会用FK约束挡住删除。
// 这个函数供"确实要删掉这个任务连带清掉引用它的计划/总结条目"的场景使用（调用前应先让用户
// 确认，因为这些条目可能是已经生成过PPT的历史记录）。
export const deleteWeeklyTaskEntriesForTask = (taskId) =>
  supabase.from("weekly_task_entries").delete().eq("task_id", taskId).then(unwrap);
export const countWeeklyTaskEntriesForTask = (taskId) =>
  supabase
    .from("weekly_task_entries")
    .select("id", { count: "exact", head: true })
    .eq("task_id", taskId)
    .then(({ count, error }) => {
      if (error) throw error;
      return count ?? 0;
    });

// ---- 按id批量反查任务标题，供weekly-report渲染候选池和已保存条目的任务名 ----
// 带上task_groups(供taskLabels.js的wbsTexts()拼"任务2级"列文本时查这个任务所在二级
// 分组的标题——2026-07-16修复：这里原来没select task_groups，导致有三级子任务的场景下
// "任务2级"列只显示"5.1"这样的裸编号，没有分组标题，是独立于tasks.js树状展示的另一个
// bug，tasks.js自己另有一套从listProjects()查task_groups的逻辑，不受这次改动影响)。
export const listTasksByIds = (ids) =>
  ids.length === 0
    ? Promise.resolve([])
    : supabase
        .from("tasks")
        .select(
          "*, projects(title, level1_number, project_type, recurring_project_settings(title_verb, title_noun), task_groups(wbs_level2_number, title))"
        )
        .in("id", ids)
        .then(unwrap);
