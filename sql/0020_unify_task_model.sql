-- 2026-07-14 任务数据模型统一重构。用户在tasks.html实际使用中发现queue_project_tasks/
-- deadline_milestones/recurring_task_instances三张叶子任务表几乎同构(标题/模块/责任人/
-- 最终交付物/最终完成时间/状态全部重复)，queue_projects/deadline_projects/
-- recurring_task_templates三张项目表也同理；顺序队列与截止日期两种类型经代码核实唯一
-- 真正的行为差异只在候选池生成逻辑(前者只交"当前任务"，后者交出所有到期未完成项)，
-- 项目级deadline_date/target_deliverable/category字段没有下游代码真正读取。
--
-- 本迁移：叶子任务统一进tasks表，项目/容器统一进projects表，循环任务专属信息
-- (动词前缀/名词/频率/默认模块责任人)进recurring_project_settings侧表；顺序队列与
-- 截止日期合并成一种项目类型，用project_type三态区分行为(sequential/nonsequential/
-- recurring)；weekly_task_entries的三个可空外键+source_type判别列收缩成一个task_id。
-- 新增planned_start_date(预计开始日期，可选)/actual_start_date(实际开始日期，任务第一次
-- 进入某周计划时由应用层自动写入)。循环任务实例的meeting_week_id(对应哪一周)/唯一性约束
-- 保留(不能丢，是"本周该出哪个循环任务实例"查询和防重复生成的依据)。
--
-- 涉及数据搬迁+删表，风险和体量都远超以往迁移文件，整体用显式事务包裹：任何一步失败
-- (包括最后not null约束因历史脏数据而失败)，整个迁移原子回滚，不会留下半迁移状态。
--
-- module_id/owner/planned_completion_date在tasks表里保持nullable（跟当前
-- queue_project_tasks/deadline_milestones的实际DB约束一致——"必填"只在应用层
-- (tasks.js表单校验)强制，DB从未加过NOT NULL；这里不收紧，避免历史上可能存在的
-- 未回填脏数据导致这次迁移直接失败）。
--
-- ⚠️依赖顺序：本迁移要求0019_normalize_not_started_status.sql已经执行完毕——下面第4步
-- 把queue_project_tasks.status原样搬进新tasks表(只处理'skipped'→'stopped'这一种映射)，
-- 如果0019还没跑、queue_project_tasks里还残留'pending'值，会在插入时撞新tasks表的status
-- CHECK约束(只允许not_started/in_progress/done/stopped，不含pending)直接报错——事务
-- 会整体回滚，不会留下脏数据，但需要先跑完0019再跑这个文件。

begin;

-- ---------- 1. 新建表 ----------

create table projects (
  id bigint generated always as identity primary key,
  level1_number bigint not null unique references task_number_registry(level1_number),
  title text not null,
  project_type text not null check (project_type in ('sequential','nonsequential','recurring')),
  status text not null default 'active' check (status in ('active','paused','completed')),
  category text,
  deadline_date date,
  target_deliverable text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  legacy_source_table text,
  legacy_source_id bigint
);

create table recurring_project_settings (
  project_id bigint primary key references projects(id) on delete cascade,
  title_verb text not null default '',
  title_noun text not null default '',
  frequency recurring_frequency not null default 'weekly',
  module_id bigint references modules(id),
  owner text
);

create table tasks (
  id bigint generated always as identity primary key,
  project_id bigint not null references projects(id) on delete cascade,
  meeting_week_id bigint references meeting_weeks(id),   -- 仅recurring类型使用：这个任务实例对应哪一周；task_list类型(sequential/nonsequential)留空
  wbs_level2_number int,
  wbs_level3_number int,
  title text not null,
  target_deliverable text,
  planned_completion_date date,
  planned_start_date date,
  actual_start_date date,
  completion_date_amendment_note text,
  actual_completion_date date,
  status text not null default 'not_started' check (status in ('not_started','in_progress','done','stopped')),
  module_id bigint references modules(id),
  owner text,
  created_at timestamptz not null default now(),
  legacy_source_table text,
  legacy_source_id bigint,
  unique (project_id, wbs_level2_number, wbs_level3_number)
);
create unique index tasks_level1_only_uniq on tasks(project_id) where wbs_level2_number is null;
create unique index tasks_recurring_week_uniq on tasks(project_id, meeting_week_id) where meeting_week_id is not null;

create table task_groups (
  id bigint generated always as identity primary key,
  project_id bigint not null references projects(id) on delete cascade,
  wbs_level2_number int not null,
  title text not null,
  unique (project_id, wbs_level2_number)
);

-- ---------- 2. projects 数据搬迁 ----------

insert into projects (level1_number, title, project_type, status, category, legacy_source_table, legacy_source_id)
select level1_number, title, 'sequential', status, category, 'queue_projects', id
from queue_projects;

insert into projects (level1_number, title, project_type, status, deadline_date, target_deliverable, legacy_source_table, legacy_source_id)
select level1_number, title, 'nonsequential', status, deadline_date, target_deliverable, 'deadline_projects', id
from deadline_projects;

insert into projects (level1_number, title, project_type, status, legacy_source_table, legacy_source_id)
select level1_number, title, 'recurring', status, 'recurring_task_templates', id
from recurring_task_templates;

-- ---------- 3. recurring_project_settings ----------

insert into recurring_project_settings (project_id, title_verb, title_noun, frequency, module_id, owner)
select p.id, t.title_verb, t.title_noun, t.frequency, t.module_id, t.owner
from recurring_task_templates t
join projects p on p.legacy_source_table = 'recurring_task_templates' and p.legacy_source_id = t.id;

-- ---------- 4. tasks 数据搬迁 ----------

-- 顺序队列：status的'skipped'统一改成'stopped'(跟deadline/recurring对齐，不再有专属终止值)
insert into tasks (project_id, wbs_level2_number, wbs_level3_number, title, target_deliverable,
  planned_completion_date, completion_date_amendment_note, actual_completion_date, status, module_id, owner,
  legacy_source_table, legacy_source_id)
select p.id, qt.wbs_level2_number, qt.wbs_level3_number, qt.title, qt.target_deliverable,
  qt.planned_completion_date, qt.completion_date_amendment_note, qt.actual_completion_date,
  case qt.status when 'skipped' then 'stopped' else qt.status end,
  qt.module_id, qt.owner,
  'queue_project_tasks', qt.id
from queue_project_tasks qt
join projects p on p.legacy_source_table = 'queue_projects' and p.legacy_source_id = qt.project_id;

insert into tasks (project_id, wbs_level2_number, wbs_level3_number, title, target_deliverable,
  planned_completion_date, completion_date_amendment_note, actual_completion_date, status, module_id, owner,
  legacy_source_table, legacy_source_id)
select p.id, dm.wbs_level2_number, dm.wbs_level3_number, dm.title, dm.target_deliverable,
  dm.planned_date, dm.planned_date_amendment_note, dm.actual_date, dm.status,
  dm.module_id, dm.owner,
  'deadline_milestones', dm.id
from deadline_milestones dm
join projects p on p.legacy_source_table = 'deadline_projects' and p.legacy_source_id = dm.project_id;

-- 循环任务实例：module_id/owner原来是通过join模板动态读的，这里物化到每一行自己身上
-- (消除应用层"isRecurring ? project.module_id : item.module_id"这类特判)；
-- title/target_deliverable为空时兜底用模板标题(跟taskLabels.js现有的`r.title || 模板title`
-- 兜底逻辑一致)；full_number不迁移，前端统一用project.level1_number+wbs_level2_number+
-- wbs_level3_number现算(跟顺序队列/截止日期本来就是同一套算法)。
insert into tasks (project_id, meeting_week_id, wbs_level2_number, wbs_level3_number, title, target_deliverable,
  planned_completion_date, actual_completion_date, status, module_id, owner,
  legacy_source_table, legacy_source_id)
select p.id, ri.meeting_week_id, ri.level2_number, ri.level3_number, coalesce(ri.title, t.title), ri.target_deliverable,
  ri.due_date, ri.actual_completion_date, ri.status,
  t.module_id, t.owner,
  'recurring_task_instances', ri.id
from recurring_task_instances ri
join recurring_task_templates t on t.id = ri.template_id
join projects p on p.legacy_source_table = 'recurring_task_templates' and p.legacy_source_id = ri.template_id;

-- ---------- 5. task_groups ----------

insert into task_groups (project_id, wbs_level2_number, title)
select p.id, g.wbs_level2_number, g.title
from queue_project_task_groups g
join projects p on p.legacy_source_table = 'queue_projects' and p.legacy_source_id = g.project_id;

insert into task_groups (project_id, wbs_level2_number, title)
select p.id, g.wbs_level2_number, g.title
from deadline_milestone_groups g
join projects p on p.legacy_source_table = 'deadline_projects' and p.legacy_source_id = g.project_id;

-- ---------- 6. weekly_task_entries：三个可空外键+source_type 收缩成 task_id ----------

alter table weekly_task_entries add column task_id bigint;

update weekly_task_entries e
set task_id = tk.id
from tasks tk
where e.source_type = 'queue_task'
  and tk.legacy_source_table = 'queue_project_tasks'
  and tk.legacy_source_id = e.source_queue_task_id;

update weekly_task_entries e
set task_id = tk.id
from tasks tk
where e.source_type = 'milestone'
  and tk.legacy_source_table = 'deadline_milestones'
  and tk.legacy_source_id = e.source_milestone_id;

update weekly_task_entries e
set task_id = tk.id
from tasks tk
where e.source_type = 'recurring_instance'
  and tk.legacy_source_table = 'recurring_task_instances'
  and tk.legacy_source_id = e.source_recurring_instance_id;

-- 下面这行set not null如果报错("存在NULL值")，说明上面三步update没有覆盖到所有行——
-- 整个事务会连同前面所有步骤一起自动回滚，不会留下半迁移状态，需要排查是不是有
-- weekly_task_entries引用了一个从未被正确搬迁的source id
alter table weekly_task_entries alter column task_id set not null;
alter table weekly_task_entries add constraint weekly_task_entries_task_fk foreign key (task_id) references tasks(id);

alter table weekly_task_entries drop constraint if exists weekly_task_entries_check;
alter table weekly_task_entries drop column if exists source_type;
alter table weekly_task_entries drop column if exists source_queue_task_id;
alter table weekly_task_entries drop column if exists source_milestone_id;
alter table weekly_task_entries drop column if exists source_recurring_instance_id;

-- ---------- 7. task_number_registry：owning_table统一指向projects，task_type改名 ----------

update task_number_registry r
set owning_id = p.id, owning_table = 'projects'
from projects p
where r.owning_table = 'queue_projects' and p.legacy_source_table = 'queue_projects' and p.legacy_source_id = r.owning_id;

update task_number_registry r
set owning_id = p.id, owning_table = 'projects'
from projects p
where r.owning_table = 'deadline_projects' and p.legacy_source_table = 'deadline_projects' and p.legacy_source_id = r.owning_id;

update task_number_registry r
set owning_id = p.id, owning_table = 'projects'
from projects p
where r.owning_table = 'recurring_task_templates' and p.legacy_source_table = 'recurring_task_templates' and p.legacy_source_id = r.owning_id;

-- 0011删ad_hoc_tasks表时，0016清理孤儿registry行的脚本没有覆盖owning_table='ad_hoc_tasks'
-- 这个分支，如果当时有残留，这里一并清掉(task_type枚举里的'ad_hoc'值这次也要废弃)
delete from task_number_registry where task_type = 'ad_hoc';

-- task_type列原来是task_number_type枚举类型，这里改成text+check约束(枚举类型改值域在同一
-- 事务里操作麻烦——ALTER TYPE ADD VALUE不能在同一事务里立即使用新值，直接换成text更简单)
alter table task_number_registry alter column task_type type text using task_type::text;
update task_number_registry set task_type = 'sequential' where task_type = 'queue';
update task_number_registry set task_type = 'nonsequential' where task_type = 'deadline';
alter table task_number_registry add constraint task_number_registry_task_type_check
  check (task_type in ('sequential','nonsequential','recurring'));

-- ---------- 8. 收尾：drop旧表、drop临时列、drop不再使用的枚举类型 ----------

alter table projects drop column legacy_source_table, drop column legacy_source_id;
alter table tasks drop column legacy_source_table, drop column legacy_source_id;

drop table queue_project_tasks;
drop table queue_project_task_groups;
drop table deadline_milestones;
drop table deadline_milestone_groups;
drop table recurring_task_instances;
drop table queue_projects;
drop table deadline_projects;
drop table recurring_task_templates;

drop type if exists wbs_source_type;   -- 原本给weekly_task_entries.source_type用，该列已删除
drop type if exists task_number_type;  -- 原本给task_number_registry.task_type用，该列已改成text+check

-- ---------- 9. RLS ----------

alter table projects enable row level security;
alter table recurring_project_settings enable row level security;
alter table tasks enable row level security;
alter table task_groups enable row level security;
create policy "authenticated full access" on projects for all to authenticated using (true) with check (true);
create policy "authenticated full access" on recurring_project_settings for all to authenticated using (true) with check (true);
create policy "authenticated full access" on tasks for all to authenticated using (true) with check (true);
create policy "authenticated full access" on task_groups for all to authenticated using (true) with check (true);

commit;
