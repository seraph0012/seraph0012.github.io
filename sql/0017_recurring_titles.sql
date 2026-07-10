-- 2026-07-10 用户反馈：循环任务的标题/最终交付物应该按当前生成的月/周动态变化，不能整个
-- 模板生命周期共用同一个固定字符串。举例：模板(1级)标题"制作周例会PPT"是一个动词+名词短语，
-- 2级(月份分组)标题应该是"制作7月周例会PPT"，3级(具体某周)标题应该是"制作7月4周周例会PPT"，
-- 且这个3级任务的"最终交付物"必须精确到"7月4周周例会PPT"——因为"任务是否最终完成"是拿
-- weekly_task_entries里填的"本周交付物"去跟这个"最终目标交付物"做匹配，固定不变的交付物
-- 名字没法区分是哪一周的产出。
--
-- 做法：模板把原来一整块"title"拆成title_verb(动词前缀，如"制作"，可留空)+title_noun(名词
-- 部分，同时也是交付物基础名，如"周例会PPT")；title列继续保留(=title_verb||title_noun，
-- 用于1级展示，跟其他地方读template.title的代码保持兼容)。deliverable_template列废弃删除——
-- 它原来试图存"这个循环任务的交付物"，但语义上就是title_noun，没必要重复一份。
-- 每个实例(recurring_task_instances)新增自己的title/target_deliverable，在生成实例时按
-- targetWeek的calendar_month(月份)+week_index_in_month(月内第几周)现算并存下来
-- (weekly/custom频率用"X月Y周"，monthly频率没有level3、只用"X月")。

alter table recurring_task_templates
  add column if not exists title_verb text not null default '',
  add column if not exists title_noun text not null default '';

-- 历史数据兜底：还没手动拆分的模板，整段旧title先塞进title_noun(前缀留空)，
-- 保证title=title_verb||title_noun这个不变式从一开始就成立。
update recurring_task_templates set title_noun = title where title_noun = '';

alter table recurring_task_templates drop column if exists deliverable_template;

alter table recurring_task_instances
  add column if not exists title text,
  add column if not exists target_deliverable text;
