-- 2026-07-14 用户发现queue_project_tasks/deadline_milestones/recurring_task_instances
-- 三张源表各自的status check约束里"未开始"这个状态值不统一：queue_project_tasks建表
-- (0004)时只设计了pending一个值；deadline_milestones/recurring_task_instances建表
-- (0005/0006)时CHECK约束同时留了pending(列default，行刚insert时的值)和not_started
-- (taskLabels.js的syncSourceStatus()真正会写入的值，对应周总结里标"未启动")两个值。
-- 界面上两者都被SOURCE_STATUS_LABEL翻译成同一个中文"未启动"，所以不是功能性bug，
-- 但DB层面存在同义不同值的历史遗留，统一收敛到only not_started，不再保留pending。

-- queue_project_tasks: 原CHECK不含not_started，先放宽让下面的UPDATE能写入，再收紧去掉pending
alter table queue_project_tasks drop constraint queue_project_tasks_status_check;
alter table queue_project_tasks add constraint queue_project_tasks_status_check
  check (status in ('pending','not_started','in_progress','done','skipped'));
update queue_project_tasks set status = 'not_started' where status = 'pending';
alter table queue_project_tasks drop constraint queue_project_tasks_status_check;
alter table queue_project_tasks add constraint queue_project_tasks_status_check
  check (status in ('not_started','in_progress','done','skipped'));
alter table queue_project_tasks alter column status set default 'not_started';

-- deadline_milestones: 原CHECK已含not_started，直接回填+收紧去掉pending
update deadline_milestones set status = 'not_started' where status = 'pending';
alter table deadline_milestones drop constraint deadline_milestones_status_check;
alter table deadline_milestones add constraint deadline_milestones_status_check
  check (status in ('not_started','in_progress','done','stopped'));
alter table deadline_milestones alter column status set default 'not_started';

-- recurring_task_instances: 原CHECK已含not_started，default本来就是not_started，
-- 只回填历史脏数据(理论上不会有，因为没有代码路径写过pending)+收紧约束
update recurring_task_instances set status = 'not_started' where status = 'pending';
alter table recurring_task_instances drop constraint recurring_task_instances_status_check;
alter table recurring_task_instances add constraint recurring_task_instances_status_check
  check (status in ('not_started','in_progress','done','stopped'));
