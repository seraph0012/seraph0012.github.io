-- milestones用独立表不用JSONB：候选池查询需跨行WHERE+索引、编号不可变要求行级审计、
-- 与其他类型保持同一建模风格便于前端复用组件
create table if not exists deadline_projects (
  id bigint generated always as identity primary key,
  level1_number bigint not null unique references task_number_registry(level1_number),
  title text not null,
  deadline_date date not null,
  target_deliverable text,
  status text not null default 'active' check (status in ('active','completed')),
  delay_alert_active boolean not null default false,
  delay_alert_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists deadline_milestones (
  id bigint generated always as identity primary key,
  project_id bigint not null references deadline_projects(id) on delete cascade,
  wbs_level2_number int not null,
  wbs_level3_number int,
  ordinal int not null,
  title text not null,
  target_deliverable text,
  planned_date date not null,
  actual_date date,
  status text not null default 'pending'
    check (status in ('pending','in_progress','done','stopped','not_started')),
  created_at timestamptz not null default now(),
  unique (project_id, wbs_level2_number, wbs_level3_number)
);

alter table deadline_projects enable row level security;
alter table deadline_milestones enable row level security;
create policy "authenticated full access" on deadline_projects for all to authenticated using (true) with check (true);
create policy "authenticated full access" on deadline_milestones for all to authenticated using (true) with check (true);
