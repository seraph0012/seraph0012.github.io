const WEEKDAY_LABELS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

// dateStr: "YYYY-MM-DD" -> "周X"，用于在填执行期/计划开始时间时能看清当前选的是周几，
// 避免在编制/审核计划时选到节假日（meeting_weeks.meeting_date/work_week_end 会因节假日手动调整，
// 跟自然日历的周一/周五脱节，所以不能靠肉眼数日期猜星期几）。
export function weekdayLabel(dateStr) {
  if (!dateStr) return "";
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return "";
  return WEEKDAY_LABELS[d.getUTCDay()];
}

export function dateWithWeekday(dateStr) {
  if (!dateStr) return "";
  const w = weekdayLabel(dateStr);
  return w ? `${dateStr}（${w}）` : dateStr;
}
