-- 顺序队列的"当前任务指针"和"执行顺序"都不需要手动维护：项目内任务本来就是按WBS编号
-- (二级.三级)顺序推进，"当前任务"可以随时从"第一个还没done/skipped的任务"自动算出来，
-- 不需要一个单独存的指针字段；顺序调整("上移/下移")也没有实际使用场景——真要变更顺序，
-- 改的应该是任务的完成时间，不是这里的执行序号。两个字段直接删掉，简化模型。
alter table queue_projects drop constraint if exists queue_projects_current_task_fk;
alter table queue_projects drop column if exists current_task_id;
alter table queue_project_tasks drop column if exists execution_ordinal;

-- deadline_milestones.ordinal是同一类问题：只在创建时记了插入顺序，实际展示/排序一直是按
-- planned_date来的，没有任何代码真正读它，直接删掉
alter table deadline_milestones drop column if exists ordinal;

-- 循环任务的"起始例会周"不需要作为模板的持久字段：这个信息只在创建模板的那一刻用一次
-- (用来生成第一个实例)，之后"生成下一个实例"永远只看"上一个已有实例"，不需要回头看模板
-- 记的起始周。创建模板时改成直接连带生成第一个实例，模板本身不再存开始日期。
alter table recurring_task_templates drop column if exists start_date;
alter table recurring_task_templates drop column if exists start_meeting_week_id;
