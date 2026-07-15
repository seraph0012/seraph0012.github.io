-- 2026-07-16：modules/people加"当前"标记。用户提出modules.html/people.html合并成一个
-- "设置(settings)"页面，里面标记"当前模块"/"当前责任人"——这个标记取代此前"只有一个候选
-- 值时自动选中"的启发式(数量变多后就失效)，成为任务创建表单/候选池默认预填的权威来源。
-- "计划/总结"表格里的模块/责任人不再是可编辑下拉框(改成只读文本，直接显示任务自己的
-- module_id/owner，本来就有的字段不变)，所以这次migration只加字段，不改weekly_task_entries。

alter table modules add column if not exists is_current boolean not null default false;
alter table people add column if not exists is_current boolean not null default false;

-- partial unique index：只对is_current=true的行生效，保证每张表最多同时有一行标记为"当前"，
-- 不需要额外的应用层加锁——app层setCurrentModule()/setCurrentPerson()按"先清空全部再设置
-- 目标行"两步更新，中间不会经过"两行同时为true"的状态，不会撞这个约束。
create unique index if not exists modules_current_uniq on modules (is_current) where is_current;
create unique index if not exists people_current_uniq on people (is_current) where is_current;
