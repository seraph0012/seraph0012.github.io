create table if not exists ad_hoc_tasks (
  id bigint generated always as identity primary key,
  level1_number bigint unique references task_number_registry(level1_number),
  title text not null,
  actual_start date not null,
  actual_end date,
  status text not null default 'open' check (status in ('open','closed')),
  description text,
  promoted_to_type text check (promoted_to_type in ('queue','deadline','recurring')),
  promoted_to_queue_project_id bigint references queue_projects(id),
  promoted_to_deadline_project_id bigint references deadline_projects(id),
  promoted_to_recurring_template_id bigint references recurring_task_templates(id),
  created_at timestamptz not null default now(),
  check (
    (promoted_to_type is null and promoted_to_queue_project_id is null and promoted_to_deadline_project_id is null and promoted_to_recurring_template_id is null)
    or (promoted_to_type = 'queue' and promoted_to_queue_project_id is not null and promoted_to_deadline_project_id is null and promoted_to_recurring_template_id is null)
    or (promoted_to_type = 'deadline' and promoted_to_deadline_project_id is not null and promoted_to_queue_project_id is null and promoted_to_recurring_template_id is null)
    or (promoted_to_type = 'recurring' and promoted_to_recurring_template_id is not null and promoted_to_queue_project_id is null and promoted_to_deadline_project_id is null)
  )
);
alter table ad_hoc_tasks enable row level security;
create policy "authenticated full access" on ad_hoc_tasks for all to authenticated using (true) with check (true);
