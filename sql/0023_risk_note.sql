-- 2026-07-16：weekly_task_entries加risk_note(风险说明，自由文本)。用户实测PPT后指出
-- 一个真实的功能缺口——PPT里"风险说明"这一列本来应该是文字描述具体的风险(比如"外部依赖
-- 迟迟没反馈，可能导致进度延误")，颜色(绿/黄/红)只是辅助标注严重程度；但app界面一直只有
-- risk_level(低/中/高)这一个下拉选择，从来没有承载"具体风险是什么"这段文字的字段，
-- PPT里这一列此前只能显示"低/中/高"三个字，不是真正的风险说明。
-- risk_level(green/yellow/red)保留不变，继续只负责决定颜色；risk_note是新增的说明文字，
-- 是PPT里这一列真正显示的内容。

alter table weekly_task_entries add column if not exists risk_note text;
