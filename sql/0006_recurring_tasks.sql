create table if not exists recurring_task_templates (
  id bigint generated always as identity primary key,
  level1_number bigint not null unique references task_number_registry(level1_number),
  title text not null,
  module_id bigint references modules(id),
  owner text,
  frequency recurring_frequency not null default 'weekly',
  start_date date not null,
  start_meeting_week_id bigint not null references meeting_weeks(id),
  end_date date,
  status text not null default 'active' check (status in ('active','completed','paused')),
  deliverable_template text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists recurring_task_instances (
  id bigint generated always as identity primary key,
  template_id bigint not null references recurring_task_templates(id) on delete cascade,
  meeting_week_id bigint not null references meeting_weeks(id),
  level2_number int not null,   -- 月数：顺延式计数，跳过整月恢复后只+1，不按实际跨月数跳跃
  level3_number int,            -- 月内第几次执行：跳过的周顺延递补，不留空号；monthly频率省略(NULL)
  full_number text not null,
  due_date date not null,
  actual_completion_date date,
  status text not null default 'not_started' check (status in ('pending','in_progress','done','stopped','not_started')),
  planned_hours numeric(5,1),
  actual_hours numeric(5,1),
  deliverable_note text,
  created_at timestamptz not null default now(),
  unique (template_id, meeting_week_id)
);

alter table recurring_task_templates enable row level security;
alter table recurring_task_instances enable row level security;
create policy "authenticated full access" on recurring_task_templates for all to authenticated using (true) with check (true);
create policy "authenticated full access" on recurring_task_instances for all to authenticated using (true) with check (true);

comment on column recurring_task_instances.level2_number is
  '顺延式：按该模板已生成实例数对应的"第几个有实例的月"递增，无论中间跳过几个自然月都只+1（已与用户确认）';
comment on column recurring_task_instances.level3_number is
  '顺延递补：同一level2月份内，跳过的周不留空号，按实际生成顺序连续编号（已与用户确认）';
