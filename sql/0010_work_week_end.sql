-- meeting_date 已经承担"本周实际工作开始日"的角色（默认周一，节假日可手动改）。
-- 但"本周实际工作结束日"此前完全没有字段承载——natural_week_end是固定的自然周六，
-- 不会因节假日调整，无法用来约束"执行期"这类字段不要填到假期上。
-- work_week_end：本周最后一个工作日，默认周五(natural_week_start+5)，节假日可手动改（比如周五请假则改成周四）。
alter table meeting_weeks add column if not exists work_week_end date;
update meeting_weeks set work_week_end = natural_week_start + 5 where work_week_end is null;
