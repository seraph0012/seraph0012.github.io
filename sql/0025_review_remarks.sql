-- 2026-07-20：meeting_weeks加review_remarks(备注，自由文本)。PPT"周工作计划复核情况"
-- 表格里有一格"备注"，专门写"对之前计划有改动之类，需要说明的情况"（用户原话）——不是每次
-- 都要填，之前app里完全没有录入入口，生成PPT时这一格靠pptxTable.js的clearReviewSlide()
-- 直接清空。现在有了这个字段，用户可以在"上周总结"区块手动填写，生成PPT时直接填进这一格。
--
-- 跟review_key_points同一类"单字段附加信息"，挂在meeting_weeks不挂在weekly_task_entries
-- （不对应某条具体任务），存的是"被复核的那一周"（即previousWeek）。
--
-- 跟已有的plan_amendment_note/summary_amendment_note是两回事：那两个字段是"解锁编辑已锁定
-- 数据时被迫填的订正说明"，这个是"每周都可以自由填、不是每次都要填"的备注，语义更宽松，
-- 跟用户确认过不要合并成同一个字段。

alter table meeting_weeks add column if not exists review_remarks text;
