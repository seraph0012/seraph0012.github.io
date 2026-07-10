-- 2026-07-10 用户反馈：删除项目(queue_projects/deadline_projects/recurring_task_templates)
-- 之前只删项目行本身，task_number_registry里对应的编号行从未被清掉(retireTaskNumber函数
-- 写了但从来没被调用过)，导致编号"名义上删了、实际上永久占用"——用户删掉2/3/4/6号项目后
-- 再想复用这几个编号建新项目，claimTaskNumber插入时对task_number_registry.level1_number
-- 的唯一约束直接冲突报duplicate key。
--
-- 这是对本项目早期"一级编号一旦分配永不复用"设计假设的明确覆盖(用户本轮直接要求"删除项目
-- 一定要确保真正完全删除，包括项目编号...也要变回可用状态")：以后删除整个项目/模板会同步
-- 硬删除registry行(见db.js的deleteTaskNumber + tasks.js的删除项目/模板处理)。这里先一次性
-- 清掉历史遗留的孤儿行。

delete from task_number_registry r
where (r.owning_table = 'queue_projects'
        and not exists (select 1 from queue_projects q where q.id = r.owning_id))
   or (r.owning_table = 'deadline_projects'
        and not exists (select 1 from deadline_projects d where d.id = r.owning_id))
   or (r.owning_table = 'recurring_task_templates'
        and not exists (select 1 from recurring_task_templates t where t.id = r.owning_id));
