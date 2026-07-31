-- 已锁定的周，PPT内容要冻结不变——weekly_task_entries每一行"锁定那一刻"从
-- tasks/projects/task_groups现算出来的任务标题/最终目标交付物/最终计划完成时间/任务当前
-- 状态，快照进这7个snapshot_*列。PPT生成时(shared/pptGenerate.js)已锁定的周读快照、没锁定
-- 的周继续读实时数据。不加CHECK约束，锁定前的行本来就是空——写入时机见
-- shared/taskLabels.js的snapshotWeekDetail()。详细设计见
-- tools/.claude/plans/plan-locked-week-ppt-snapshot.md。
alter table weekly_task_entries
  add column if not exists snapshot_level1_text text,
  add column if not exists snapshot_level2_text text,
  add column if not exists snapshot_level3_text text,
  add column if not exists snapshot_target_deliverable text,
  add column if not exists snapshot_source_status text,
  add column if not exists snapshot_completion_date date,
  add column if not exists snapshot_captured_at timestamptz;
