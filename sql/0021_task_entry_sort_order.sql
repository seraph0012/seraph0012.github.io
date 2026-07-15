-- 2026-07-15：weekly_task_entries加一列手动排序字段。用户反馈手动做PPT时，同一张表格
-- 里的任务不是按WBS编号排的——比如"上周未完成"经常排在"本周新增"前面，纯粹按当时开会
-- 念到的顺序来，页面之前是按编号自动排序(pptGenerate.js的sortKey())，跟这个使用习惯不符。
-- 加这一列后由用户在网页上用上/下箭头手动调整，pptGenerate.js改成直接按这个顺序出表，
-- 不再自动按编号重排。

alter table weekly_task_entries add column if not exists sort_order integer;

-- 回填现有行：按原来的隐式顺序(id，即listWeeklyTaskEntries以前"order by id"的效果)
-- 得到一个初始sort_order，保证迁移后现有周的展示顺序不变。
update weekly_task_entries set sort_order = id where sort_order is null;

comment on column weekly_task_entries.sort_order is
  '同一周同一appears_in分组内的手动展示顺序，用户在网页上用上/下箭头调整。列本身允许为空——
  应用层每次新建条目都会显式赋值(追加到当前分组末尾)，但万一某个插入路径漏传，排序时
  nulls排最后，效果等同于"追加到末尾"，不会因为漏传这个字段报错或数据错位。';

create index if not exists idx_weekly_task_entries_order on weekly_task_entries (meeting_week_id, appears_in, sort_order);
