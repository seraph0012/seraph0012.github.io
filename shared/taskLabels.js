// weekly_task_entries 不存任务标题文字，只存 source_type + source_*_id 指回四类任务的原表。
// 这里统一处理"给一批 entries/candidates 反查可读标题"，plan和summary页面共用。
import {
  listQueueProjectTasksByIds,
  listMilestonesByIds,
  listRecurringInstancesByIds,
  listAdHocTasksByIds,
} from "./db.js";

export const SOURCE_LABEL = {
  queue_task: "顺序队列",
  milestone: "截止日期",
  recurring_instance: "循环任务",
  ad_hoc: "计划外",
};

export function sourceIdOf(entry) {
  return (
    entry.source_queue_task_id ??
    entry.source_milestone_id ??
    entry.source_recurring_instance_id ??
    entry.source_ad_hoc_id
  );
}

export function sourceColumnFor(sourceType) {
  return {
    queue_task: "source_queue_task_id",
    milestone: "source_milestone_id",
    recurring_instance: "source_recurring_instance_id",
    ad_hoc: "source_ad_hoc_id",
  }[sourceType];
}

// items: [{source_type, source_id}] -> Map<"type:id", "[编号] 项目名 / 任务名">
export async function buildLabelMap(items) {
  const byType = { queue_task: [], milestone: [], recurring_instance: [], ad_hoc: [] };
  for (const item of items) {
    byType[item.source_type]?.push(item.source_id);
  }
  const map = new Map();

  for (const r of await listQueueProjectTasksByIds(byType.queue_task)) {
    const num =
      r.wbs_level3_number != null
        ? `${r.queue_projects.level1_number}.${r.wbs_level2_number}.${r.wbs_level3_number}`
        : `${r.queue_projects.level1_number}.${r.wbs_level2_number}`;
    map.set(`queue_task:${r.id}`, `[${num}] ${r.queue_projects.title} / ${r.title}`);
  }
  for (const r of await listMilestonesByIds(byType.milestone)) {
    const num =
      r.wbs_level3_number != null
        ? `${r.deadline_projects.level1_number}.${r.wbs_level2_number}.${r.wbs_level3_number}`
        : `${r.deadline_projects.level1_number}.${r.wbs_level2_number}`;
    map.set(`milestone:${r.id}`, `[${num}] ${r.deadline_projects.title} / ${r.title}`);
  }
  for (const r of await listRecurringInstancesByIds(byType.recurring_instance)) {
    map.set(`recurring_instance:${r.id}`, `[${r.full_number}] ${r.recurring_task_templates.title}`);
  }
  for (const r of await listAdHocTasksByIds(byType.ad_hoc)) {
    map.set(`ad_hoc:${r.id}`, `[计划外] ${r.title}`);
  }
  return map;
}
