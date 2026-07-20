-- 2026-07-20：meeting_weeks加review_key_points(重点工作完成情况，自由文本)。PPT"周工作
-- 计划复核情况"表格里有一格"重点工作完成情况"，要求文字必须跟工作群里每周例会后发的纪要
-- 一模一样，无法自动生成/预先导入，此前app里完全没有录入入口，生成PPT时这一格靠pptxTable.js
-- 的clearReviewSlide()清空+涂灰(旧脚本"提醒手动填写"的遗留约定)。现在有了这个字段，用户
-- 可以在"上周总结"区块粘贴这段文字，生成PPT时直接填进这一格，不再需要手动补。
--
-- 挂在meeting_weeks而不是weekly_task_entries：这段文字不对应某一条具体任务，是整份PPT
-- 复核区块的单一说明文字，跟plan_amendment_note/summary_amendment_note是同一类"单字段
-- 附加信息"。存的是"被复核的那一周"（即previousWeek，跟SUMMARY表复核的是同一周），不是
-- 生成PPT时选中的targetWeek。

alter table meeting_weeks add column if not exists review_key_points text;
