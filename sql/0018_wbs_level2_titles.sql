-- 2026-07-10 用户反馈：有1、2、3级的任务，每一级都必须有任务标题。但当前schema里，
-- 二级只有在"自己就是叶子"(没有三级子任务)时才单独成一行、借用leaf自己的title列；一旦
-- 有三级子任务，二级从来不会单独存一行(设计上就是纯分组容器)，所以完全没有地方存二级
-- 自己的标题——新建一个从没出现过的二级、同时又要挂三级子任务时，压根没有输入框能填。
--
-- 做法：加两张跟leaf表平行的小表，只存"项目+二级编号 -> 标题"这一条映射，只在
-- "这个二级下有三级子任务"时才需要一行；二级本身是叶子的情况继续用leaf自己的title，
-- 不重复存。

create table if not exists queue_project_task_groups (
  id bigint generated always as identity primary key,
  project_id bigint not null references queue_projects(id) on delete cascade,
  wbs_level2_number int not null,
  title text not null,
  created_at timestamptz not null default now(),
  unique (project_id, wbs_level2_number)
);
alter table queue_project_task_groups enable row level security;
create policy "authenticated full access" on queue_project_task_groups for all to authenticated using (true) with check (true);

create table if not exists deadline_milestone_groups (
  id bigint generated always as identity primary key,
  project_id bigint not null references deadline_projects(id) on delete cascade,
  wbs_level2_number int not null,
  title text not null,
  created_at timestamptz not null default now(),
  unique (project_id, wbs_level2_number)
);
alter table deadline_milestone_groups enable row level security;
create policy "authenticated full access" on deadline_milestone_groups for all to authenticated using (true) with check (true);
