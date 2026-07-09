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

// ---- meeting_weeks ----
export const listMeetingWeeks = () =>
  supabase.from("meeting_weeks").select("*").order("natural_week_start").then(unwrap);
export const upsertMeetingWeek = (row) =>
  supabase.from("meeting_weeks").upsert(row).select().single().then(unwrap);

// ---- task_number_registry ----
// 分配一个新的一级编号，返回整条 registry 记录（.level1_number 就是拿到的编号）
export const claimTaskNumber = ({ task_type, title_snapshot, owning_table, owning_id }) =>
  supabase
    .from("task_number_registry")
    .insert({ task_type, title_snapshot, owning_table, owning_id })
    .select()
    .single()
    .then(unwrap);

// ---- queue_projects (类型A) ----
export const listQueueProjects = () =>
  supabase
    .from("queue_projects")
    .select("*, queue_project_tasks(*)")
    .order("level1_number")
    .then(unwrap);
export const getQueueProject = (id) =>
  supabase
    .from("queue_projects")
    .select("*, queue_project_tasks(*)")
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
export const addQueueProjectTask = (projectId, task) =>
  supabase
    .from("queue_project_tasks")
    .insert({ project_id: projectId, ...task })
    .select()
    .single()
    .then(unwrap);
export const updateQueueProjectTask = (id, patch) =>
  supabase.from("queue_project_tasks").update(patch).eq("id", id).select().single().then(unwrap);

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
export const addMilestone = (projectId, milestone) =>
  supabase
    .from("deadline_milestones")
    .insert({ project_id: projectId, ...milestone })
    .select()
    .single()
    .then(unwrap);
export const updateMilestone = (id, patch) =>
  supabase.from("deadline_milestones").update(patch).eq("id", id).select().single().then(unwrap);

// ---- recurring_task_templates / instances (类型C) ----
export const listRecurringTemplates = () =>
  supabase.from("recurring_task_templates").select("*").order("level1_number").then(unwrap);
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
export const addRecurringInstance = (templateId, instance) =>
  supabase
    .from("recurring_task_instances")
    .insert({ template_id: templateId, ...instance })
    .select()
    .single()
    .then(unwrap);
export const updateRecurringInstance = (id, patch) =>
  supabase.from("recurring_task_instances").update(patch).eq("id", id).select().single().then(unwrap);

// ---- ad_hoc_tasks (类型D) ----
export const listAdHocTasks = () =>
  supabase.from("ad_hoc_tasks").select("*").order("actual_start", { ascending: false }).then(unwrap);
export const createAdHocTask = (row) =>
  supabase.from("ad_hoc_tasks").insert(row).select().single().then(unwrap);
export const updateAdHocTask = (id, patch) =>
  supabase.from("ad_hoc_tasks").update(patch).eq("id", id).select().single().then(unwrap);
