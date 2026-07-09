-- 一个自然周 = 周日到周六（编制指南5.1第4条口径），meeting_date为该周实际召开例会的日期
create table if not exists meeting_weeks (
  id bigint generated always as identity primary key,
  natural_week_start date not null unique,
  natural_week_end date generated always as (natural_week_start + 6) stored,
  meeting_date date not null,
  calendar_month date not null,        -- 该周归属自然月，统一用当月1号表示
  week_index_in_month int not null,
  is_normal boolean not null default true,
  notes text,
  created_at timestamptz not null default now()
);
alter table meeting_weeks enable row level security;
create policy "authenticated full access" on meeting_weeks for all to authenticated using (true) with check (true);

comment on table meeting_weeks is
  '循环任务月/周编号计算、下周计划候选池生成都查这张表，不在别处重复实现日期判定逻辑';
