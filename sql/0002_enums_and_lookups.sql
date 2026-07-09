create type task_completion_status as enum ('已完成', '未完成', '中止', '未启动');
create type risk_level as enum ('green', 'yellow', 'red');
create type priority_quadrant as enum (
  'urgent_important', 'important_not_urgent', 'urgent_not_important', 'neither'
);
create type recurring_frequency as enum ('weekly', 'monthly', 'custom');
create type wbs_source_type as enum ('queue_task', 'milestone', 'recurring_instance', 'ad_hoc');
create type task_number_type as enum ('queue', 'deadline', 'recurring', 'ad_hoc');

create table if not exists modules (
  id bigint generated always as identity primary key,
  name text not null unique,
  created_at timestamptz not null default now()
);
alter table modules enable row level security;
create policy "authenticated full access" on modules for all to authenticated using (true) with check (true);

-- 全局一级编号：所有任务类型共用同一序列，编号一旦分配永不复用
create sequence if not exists task_level1_seq;

create table if not exists task_number_registry (
  level1_number bigint primary key default nextval('task_level1_seq'),
  task_type task_number_type not null,
  title_snapshot text not null,
  owning_table text not null,
  owning_id bigint not null,
  claimed_at timestamptz not null default now(),
  retired_at timestamptz
);
alter table task_number_registry enable row level security;
create policy "authenticated full access" on task_number_registry for all to authenticated using (true) with check (true);

comment on sequence task_level1_seq is
  '历史导入完成后需 setval 到当时实际用到的最大编号，避免新分配编号与历史真实编号冲突';
