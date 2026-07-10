-- 支持"这个项目本身就是任务，不需要往下分解"的场景(比如临时的一次性计划外工作，
-- 直接在项目上写清楚最终交付物/最终完成时间就够了，不用强制建一个二级子任务)。
-- wbs_level2_number改成可为空——为空时代表这条记录本身就是项目(level1)的任务实体，
-- 编号显示上就是纯"5"而不是"5.2"。
alter table queue_project_tasks alter column wbs_level2_number drop not null;
alter table deadline_milestones alter column wbs_level2_number drop not null;

-- 一个项目最多只能有一条"项目本身就是任务"的记录(level2为空)，不能既是"项目本身就是任务"
-- 又同时拆出二级/三级子任务——用partial unique index强制这个互斥关系。
create unique index if not exists queue_project_tasks_level1_only_uniq
  on queue_project_tasks(project_id) where wbs_level2_number is null;
create unique index if not exists deadline_milestones_level1_only_uniq
  on deadline_milestones(project_id) where wbs_level2_number is null;
