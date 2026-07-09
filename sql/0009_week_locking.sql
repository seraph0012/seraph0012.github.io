-- 周级"锁定/订正"机制：plan(N)在本周内自由编辑，锁定后（对应PPT已生成/已提交）默认禁止再改；
-- 需要修改已锁定周的数据时，前端要求先解锁并填写订正说明，写入*_amendment_note，
-- 不逐条记录每次编辑，只保留最近一次订正说明（与用户实际PPT里"周工作计划复核情况"表格的
-- 备注列做法一致：只在发生订正时留一条说明，不是逐次编辑的审计日志）。
-- plan和summary各自独立锁定，因为PLAN通常在本周开始时就定稿，SUMMARY要到本周结束/下次例会才定稿。
alter table meeting_weeks add column if not exists plan_locked_at timestamptz;
alter table meeting_weeks add column if not exists plan_amendment_note text;
alter table meeting_weeks add column if not exists summary_locked_at timestamptz;
alter table meeting_weeks add column if not exists summary_amendment_note text;
