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

// ---- people (责任人配置列表，跟modules同构，供任务创建表单默认预填用) ----
export const listPeople = () =>
  supabase.from("people").select("*").order("name").then(unwrap);
export const createPerson = (name) =>
  supabase.from("people").insert({ name }).select().single().then(unwrap);
export const deletePerson = (id) =>
  supabase.from("people").delete().eq("id", id).then(unwrap);

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
// 2026-07-10用户明确要求：删除整个项目/模板时编号要真正释放、可以复用，不是"永久占用"。
// 硬删除registry行(而不是只标记retired_at)——调用方必须先删掉引用这个level1_number的
// 项目/模板行(queue_projects/deadline_projects/recurring_task_templates的level1_number
// 列是FK，项目行还在的话这里会被约束挡住，顺序不能反)。
export const deleteTaskNumber = (level1Number) =>
  supabase.from("task_number_registry").delete().eq("level1_number", level1Number).then(unwrap);

// ---- queue_projects (类型A) ----
export const listQueueProjects = () =>
  supabase
    .from("queue_projects")
    .select("*, queue_project_tasks!queue_project_tasks_project_id_fkey(*)")
    .order("level1_number")
    .then(unwrap);
export const getQueueProject = (id) =>
  supabase
    .from("queue_projects")
    .select("*, queue_project_tasks!queue_project_tasks_project_id_fkey(*)")
    .eq("id", id)
    .single()
    .then(unwrap);
export const createQueueProject = (row) =>
  supabase.from("queue_projects").insert(row).select().single().then(unwrap);
export const updateQueueProject = (id, patch) =>
  supabase
    .from("queue_projects")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single()
    .then(unwrap);
export const deleteQueueProject = (id) =>
  supabase.from("queue_projects").delete().eq("id", id).then(unwrap);
export const addQueueProjectTask = (projectId, task) =>
  supabase
    .from("queue_project_tasks")
    .insert({ project_id: projectId, ...task })
    .select()
    .single()
    .then(unwrap);
export const updateQueueProjectTask = (id, patch) =>
  supabase.from("queue_project_tasks").update(patch).eq("id", id).select().single().then(unwrap);
export const deleteQueueProjectTask = (id) =>
  supabase.from("queue_project_tasks").delete().eq("id", id).then(unwrap);

// ---- deadline_projects (类型B) ----
export const listDeadlineProjects = () =>
  supabase
    .from("deadline_projects")
    .select("*, deadline_milestones(*)")
    .order("deadline_date")
    .then(unwrap);
export const getDeadlineProject = (id) =>
  supabase
    .from("deadline_projects")
    .select("*, deadline_milestones(*)")
    .eq("id", id)
    .single()
    .then(unwrap);
export const createDeadlineProject = (row) =>
  supabase.from("deadline_projects").insert(row).select().single().then(unwrap);
export const updateDeadlineProject = (id, patch) =>
  supabase
    .from("deadline_projects")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single()
    .then(unwrap);
export const deleteDeadlineProject = (id) =>
  supabase.from("deadline_projects").delete().eq("id", id).then(unwrap);
export const addMilestone = (projectId, milestone) =>
  supabase
    .from("deadline_milestones")
    .insert({ project_id: projectId, ...milestone })
    .select()
    .single()
    .then(unwrap);
export const updateMilestone = (id, patch) =>
  supabase.from("deadline_milestones").update(patch).eq("id", id).select().single().then(unwrap);
export const deleteMilestone = (id) =>
  supabase.from("deadline_milestones").delete().eq("id", id).then(unwrap);

// ---- recurring_task_templates / instances (类型C) ----
export const listRecurringTemplates = () =>
  supabase
    .from("recurring_task_templates")
    .select("*, recurring_task_instances(*)")
    .order("level1_number")
    .then(unwrap);
export const getRecurringTemplate = (id) =>
  supabase
    .from("recurring_task_templates")
    .select("*, recurring_task_instances(*)")
    .eq("id", id)
    .single()
    .then(unwrap);
export const createRecurringTemplate = (row) =>
  supabase.from("recurring_task_templates").insert(row).select().single().then(unwrap);
export const updateRecurringTemplate = (id, patch) =>
  supabase
    .from("recurring_task_templates")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single()
    .then(unwrap);
export const deleteRecurringTemplate = (id) =>
  supabase.from("recurring_task_templates").delete().eq("id", id).then(unwrap);
export const addRecurringInstance = (templateId, instance) =>
  supabase
    .from("recurring_task_instances")
    .insert({ template_id: templateId, ...instance })
    .select()
    .single()
    .then(unwrap);
export const updateRecurringInstance = (id, patch) =>
  supabase.from("recurring_task_instances").update(patch).eq("id", id).select().single().then(unwrap);
export const deleteRecurringInstance = (id) =>
  supabase.from("recurring_task_instances").delete().eq("id", id).then(unwrap);

// ---- weekly_task_entries ----
export const listWeeklyTaskEntries = (meetingWeekId, appearsIn) =>
  supabase
    .from("weekly_task_entries")
    .select("*")
    .eq("meeting_week_id", meetingWeekId)
    .eq("appears_in", appearsIn)
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
// weekly_task_entries的source_*_id外键没有加ON DELETE CASCADE（历史周记录不该被源任务删除
// 静默带走），所以删除一个源任务(queue_task/milestone/recurring_instance)前，
// 如果还有weekly_task_entries引用着它，数据库会用FK约束挡住删除。这个函数供"确实要删掉这个
// 任务连带清掉引用它的计划/总结条目"的场景使用（调用前应先让用户确认，因为这些条目可能是
// 已经生成过PPT的历史记录）。
export const deleteWeeklyTaskEntriesForSource = (sourceColumn, sourceId) =>
  supabase.from("weekly_task_entries").delete().eq(sourceColumn, sourceId).then(unwrap);
export const countWeeklyTaskEntriesForSource = (sourceColumn, sourceId) =>
  supabase
    .from("weekly_task_entries")
    .select("id", { count: "exact", head: true })
    .eq(sourceColumn, sourceId)
    .then(({ count, error }) => {
      if (error) throw error;
      return count ?? 0;
    });
// "最终计划完成时间"锁定判断：一旦这个任务被写进过任意一周的计划(appears_in='plan')，
// 这个日期就要锁定，改动必须走订正说明——即使那一周已经过去/已经解锁编辑过其他字段，
// 这个锁定也不解除(判断的是"有没有进入过计划"，不是"当前是否在锁定的周里")。
// 批量版本(2026-07-10性能修复)：原来tasks.js对每个可能锁定的任务单独发一次count请求
// (N个任务=N次HTTP往返)，render一次表格(哪怕只是纯本地的展开详情，不涉及任何数据变化)
// 都要重新打一遍，是页面"点什么都卡"的主因。改成两次bulk查询(source_queue_task_id一次、
// source_milestone_id一次)取出"曾经进入过plan"的全部source_id集合，前端用Set.has()判断。
export const listPlannedSourceIds = (sourceColumn) =>
  supabase
    .from("weekly_task_entries")
    .select(sourceColumn)
    .eq("appears_in", "plan")
    .not(sourceColumn, "is", null)
    .then(unwrap)
    .then((rows) => new Set(rows.map((r) => r[sourceColumn])));

export const listRecurringInstancesForWeek = (weekId) =>
  supabase
    .from("recurring_task_instances")
    .select("*, recurring_task_templates(*)")
    .eq("meeting_week_id", weekId)
    .then(unwrap);

// ---- 按id批量反查任务标题，供weekly-plan/weekly-summary渲染候选池和已保存条目的任务名 ----
export const listQueueProjectTasksByIds = (ids) =>
  ids.length === 0
    ? Promise.resolve([])
    : supabase
        .from("queue_project_tasks")
        .select(
          "id, project_id, title, wbs_level2_number, wbs_level3_number, target_deliverable, planned_completion_date, actual_completion_date, completion_date_amendment_note, status, queue_projects!queue_project_tasks_project_id_fkey(title, level1_number)"
        )
        .in("id", ids)
        .then(unwrap);
export const listMilestonesByIds = (ids) =>
  ids.length === 0
    ? Promise.resolve([])
    : supabase
        .from("deadline_milestones")
        .select(
          "id, project_id, title, wbs_level2_number, wbs_level3_number, target_deliverable, planned_date, planned_date_amendment_note, actual_date, status, deadline_projects(title, level1_number)"
        )
        .in("id", ids)
        .then(unwrap);
export const listRecurringInstancesByIds = (ids) =>
  ids.length === 0
    ? Promise.resolve([])
    : supabase
        .from("recurring_task_instances")
        .select(
          "id, template_id, full_number, level2_number, level3_number, due_date, status, title, target_deliverable, recurring_task_templates(title, level1_number, module_id, owner)"
        )
        .in("id", ids)
        .then(unwrap);
