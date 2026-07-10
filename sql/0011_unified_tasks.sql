-- 顺序队列任务补齐"最终完成时间"概念：原设计里type A没有日期字段(无硬性日期)，
-- 现在要求跟B/C一样每个任务都有一个"最终计划完成时间"——语义是：任务进入某一周的计划
-- (weekly_task_entries.appears_in='plan')之前可以随意调整，一旦进入计划就要锁定，
-- 哪怕实际超期也不能随便改，目的是跟实际完成时间做效率对比。锁定判断由app层
-- hasBeenPlanned()查询决定，不在DB加约束；这里只加字段本身+订正时必填的说明字段。
alter table queue_project_tasks
  add column if not exists planned_completion_date date,
  add column if not exists actual_completion_date date,
  add column if not exists completion_date_amendment_note text;

-- deadline_milestones.planned_date已经是NOT NULL，只补一个订正说明字段，跟顺序队列任务
-- 用同一套"锁定后必须写订正说明才能改"的模式
alter table deadline_milestones
  add column if not exists planned_date_amendment_note text;

-- 取消类型D(计划外任务)：不再有"预登记+转正"的独立类型，任务创建时就要选定A/B/C之一，
-- "是否计划外"改成总结页面根据"是否出现在本周计划里"自动判定。
-- 当前ad_hoc_tasks和引用它的weekly_task_entries都是本周验证流程的测试数据，非正式历史，直接清理。
delete from weekly_task_entries where source_type = 'ad_hoc';
alter table weekly_task_entries drop constraint if exists weekly_task_entries_check;
alter table weekly_task_entries drop column if exists source_ad_hoc_id;
alter table weekly_task_entries add constraint weekly_task_entries_check check (
  (source_type = 'queue_task'         and source_queue_task_id is not null and source_milestone_id is null and source_recurring_instance_id is null) or
  (source_type = 'milestone'          and source_milestone_id is not null and source_queue_task_id is null and source_recurring_instance_id is null) or
  (source_type = 'recurring_instance' and source_recurring_instance_id is not null and source_queue_task_id is null and source_milestone_id is null)
);
drop table if exists ad_hoc_tasks;

comment on column queue_project_tasks.planned_completion_date is
  '一旦该任务被写进某一周的plan条目，此字段锁定(app层hasBeenPlanned()判断)，改动需走订正说明(completion_date_amendment_note)';
comment on column deadline_milestones.planned_date is
  '一旦该里程碑被写进某一周的plan条目，此字段锁定(app层hasBeenPlanned()判断)，改动需走订正说明(planned_date_amendment_note)';
