-- recurring_task_instances.planned_hours/actual_hours 跟 weekly_task_entries 自己的
-- planned_hours/actual_hours完全重复(一个循环任务实例本来就对应且只对应一周)，
-- 现有代码里也没有任何地方真正读写这两个字段来做别的用途，直接删掉，用时统一只在
-- weekly_task_entries里记录(跟顺序队列/截止日期两类任务保持一致，它们也没有自己的用时字段)。
alter table recurring_task_instances drop column if exists planned_hours;
alter table recurring_task_instances drop column if exists actual_hours;
