-- 一次性验证用表，确认前端能连上 Supabase 并读到数据。
-- 后续正式建表（queue_projects / deadline_projects / ... ）会作为独立 migration 文件加入这个目录。

create table if not exists connection_test (
  id bigint generated always as identity primary key,
  message text not null default 'ok',
  created_at timestamptz not null default now()
);

alter table connection_test enable row level security;

-- 仅测试阶段用：允许匿名读取。真正业务表上线后会换成要求登录态的策略。
create policy "anyone can read connection_test"
  on connection_test
  for select
  using (true);

insert into connection_test (message) values ('hello from supabase');
