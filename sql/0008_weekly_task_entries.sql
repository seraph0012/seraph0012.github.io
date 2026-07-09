create table if not exists weekly_task_entries (
  id bigint generated always as identity primary key,
  meeting_week_id bigint not null references meeting_weeks(id),
  appears_in text not null check (appears_in in ('summary','plan','stopped')),

  source_type wbs_source_type not null,
  source_queue_task_id bigint references queue_project_tasks(id),
  source_milestone_id bigint references deadline_milestones(id),
  source_recurring_instance_id bigint references recurring_task_instances(id),
  source_ad_hoc_id bigint references ad_hoc_tasks(id),
  check (
    (source_type = 'queue_task'         and source_queue_task_id is not null and source_milestone_id is null and source_recurring_instance_id is null and source_ad_hoc_id is null) or
    (source_type = 'milestone'          and source_milestone_id is not null and source_queue_task_id is null and source_recurring_instance_id is null and source_ad_hoc_id is null) or
    (source_type = 'recurring_instance' and source_recurring_instance_id is not null and source_queue_task_id is null and source_milestone_id is null and source_ad_hoc_id is null) or
    (source_type = 'ad_hoc'             and source_ad_hoc_id is not null and source_queue_task_id is null and source_milestone_id is null and source_recurring_instance_id is null)
  ),

  module_id bigint references modules(id),
  plan_category text check (plan_category in ('上周未完成','本周新增')),   -- 仅appears_in='plan'
  summary_category text check (summary_category in ('计划内','计划外')),   -- 仅appears_in='summary'

  owner text not null default '刘璇',
  status task_completion_status,
  is_hidden boolean not null default false,   -- true=进"未启动/中止"附表
  highlight boolean not null default false,   -- 重点工作标记(对应PPT高亮色ACCENT_6)

  deliverable_this_week text,
  planned_hours numeric(5,1),
  actual_hours numeric(5,1),

  plan_start_date date,
  execution_deadline date,
  priority_quadrant priority_quadrant,
  resources_needed text,

  incomplete_reason text,
  rectification_measures text,
  risk_level risk_level,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index on weekly_task_entries (meeting_week_id, appears_in);
create index on weekly_task_entries (source_type, source_queue_task_id, source_milestone_id, source_recurring_instance_id, source_ad_hoc_id);

alter table weekly_task_entries enable row level security;
create policy "authenticated full access" on weekly_task_entries for all to authenticated using (true) with check (true);
