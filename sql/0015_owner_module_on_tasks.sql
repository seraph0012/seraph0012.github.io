-- 责任人跟模块一样，需要一个"配置好的列表"来做默认预填，不能写死在代码里(比如"刘璇")。
create table if not exists people (
  id bigint generated always as identity primary key,
  name text not null unique,
  created_at timestamptz not null default now()
);
alter table people enable row level security;
create policy "authenticated full access" on people for all to authenticated using (true) with check (true);

-- 顺序队列/截止日期任务现在也要求模块+责任人在任务创建时就填好(不再是每周计划/总结才临时
-- 填一次)，跟循环任务模板(本来就有module_id/owner，用来给每周候选池提供默认值)看齐。
alter table queue_project_tasks add column if not exists module_id bigint references modules(id);
alter table queue_project_tasks add column if not exists owner text;
alter table deadline_milestones add column if not exists module_id bigint references modules(id);
alter table deadline_milestones add column if not exists owner text;
