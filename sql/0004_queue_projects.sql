create table if not exists queue_projects (
  id bigint generated always as identity primary key,
  level1_number bigint not null unique references task_number_registry(level1_number),
  title text not null,
  category text,
  status text not null default 'active' check (status in ('active','paused','completed')),
  current_task_id bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists queue_project_tasks (
  id bigint generated always as identity primary key,
  project_id bigint not null references queue_projects(id) on delete cascade,
  wbs_level2_number int not null,
  wbs_level3_number int,
  execution_ordinal int not null,      -- 实际执行顺序，可插队调整，与固定编号无关
  title text not null,
  target_deliverable text,
  status text not null default 'pending' check (status in ('pending','in_progress','done','skipped')),
  created_at timestamptz not null default now(),
  unique (project_id, wbs_level2_number, wbs_level3_number)
);

alter table queue_projects
  add constraint queue_projects_current_task_fk
  foreign key (current_task_id) references queue_project_tasks(id) on delete set null;

alter table queue_projects enable row level security;
alter table queue_project_tasks enable row level security;
create policy "authenticated full access" on queue_projects for all to authenticated using (true) with check (true);
create policy "authenticated full access" on queue_project_tasks for all to authenticated using (true) with check (true);
