// weekly_task_entries 不存任务标题文字，只存 source_type + source_*_id 指回四类任务的原表。
// 这里统一处理"给一批 entries/candidates 反查可读标题"，plan和summary页面共用。
import {
  listQueueProjectTasksByIds,
  listMilestonesByIds,
  listRecurringInstancesByIds,
  listAdHocTasksByIds,
  updateQueueProjectTask,
  updateMilestone,
  updateRecurringInstance,
  updateAdHocTask,
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

// 来源表自身的英文status值 -> PPT里用的中文文案（跟weekly_task_entries.status用的
// task_completion_status枚举本来就是中文不一样，这几张来源表的status是各自表定义的英文check约束）
export const SOURCE_STATUS_LABEL = {
  pending: "未启动",
  in_progress: "进行中",
  done: "已完成",
  skipped: "跳过",
  stopped: "中止",
  not_started: "未启动",
  open: "进行中",
  closed: "已完成",
};

// ppt-export专用：反查PPT里"任务1/2/3级"（编号+标题拼接文本，实测sample_ppt.pptx历史数据
// 证实这三列不是纯数字，而是"编号.标题"，比如"10.参与科研专题工作会"/"10.3 参与科研专题工作会(第五次）"）+
// "最终目标交付物"+"来源表自身完成状态"+"来源表自身的计划完成时间"这几列
// （这些字段taskLabels/buildLabelMap不需要，只有导出PPT要）。
//
// 编号+标题拼接规则（跟用户核实过）：
// - queue_task/milestone：WBS结构一样，各级有独立title。level3有值时该行title归level3
//   （level2列只显示编号，不带title）；level3为空时title归level2。
//   "第几次"这种区分同名任务的后缀是用户手动打在title里的，不是代码生成的。
// - recurring_instance：只有模板标题+full_number，没有"第几次"概念，2级列固定用
//   "full_number+模板标题"（历史数据证实这两级标题原本就是重复的，不是bug）。
// - ad_hoc：多数未转正没有level1_number，此时只显示标题，不加编号前缀；没有2/3级。
// items: [{source_type, source_id}] -> Map<"type:id", {level1,level2,level3(数字，供排序用),
//   level1Text,level2Text,level3Text(拼好的显示文本), targetDeliverable, sourceStatus, completionDate}>
export async function buildSourceDetailMap(items) {
  const byType = { queue_task: [], milestone: [], recurring_instance: [], ad_hoc: [] };
  for (const item of items) {
    byType[item.source_type]?.push(item.source_id);
  }
  const map = new Map();

  // queue_task/milestone共用同一套WBS编号+标题拼接逻辑
  function wbsTexts(level1, level2, level3, projectTitle, rowTitle) {
    const level1Text = `${level1}.${projectTitle}`;
    if (level3 != null) {
      return { level1Text, level2Text: `${level1}.${level2}`, level3Text: `${level1}.${level2}.${level3} ${rowTitle}` };
    }
    return { level1Text, level2Text: `${level1}.${level2} ${rowTitle}`, level3Text: "" };
  }

  for (const r of await listQueueProjectTasksByIds(byType.queue_task)) {
    const level1 = r.queue_projects.level1_number;
    map.set(`queue_task:${r.id}`, {
      level1,
      level2: r.wbs_level2_number,
      level3: r.wbs_level3_number,
      ...wbsTexts(level1, r.wbs_level2_number, r.wbs_level3_number, r.queue_projects.title, r.title),
      targetDeliverable: r.target_deliverable,
      sourceStatus: SOURCE_STATUS_LABEL[r.status] ?? r.status ?? "",
      completionDate: null, // 顺序队列项目没有截止日期概念
      detailUrl: `queue-project-detail.html?id=${r.project_id}`,
    });
  }
  for (const r of await listMilestonesByIds(byType.milestone)) {
    const level1 = r.deadline_projects.level1_number;
    map.set(`milestone:${r.id}`, {
      level1,
      level2: r.wbs_level2_number,
      level3: r.wbs_level3_number,
      ...wbsTexts(level1, r.wbs_level2_number, r.wbs_level3_number, r.deadline_projects.title, r.title),
      targetDeliverable: r.target_deliverable,
      sourceStatus: SOURCE_STATUS_LABEL[r.status] ?? r.status ?? "",
      completionDate: r.planned_date,
      detailUrl: `deadline-project-detail.html?id=${r.project_id}`,
    });
  }
  for (const r of await listRecurringInstancesByIds(byType.recurring_instance)) {
    const level1 = r.recurring_task_templates.level1_number;
    const templateTitle = r.recurring_task_templates.title;
    map.set(`recurring_instance:${r.id}`, {
      level1,
      level2: r.level2_number,
      level3: r.level3_number,
      level1Text: `${level1}.${templateTitle}`,
      level2Text: `${r.full_number} ${templateTitle}`,
      level3Text: "",
      targetDeliverable: r.recurring_task_templates.deliverable_template,
      sourceStatus: SOURCE_STATUS_LABEL[r.status] ?? r.status ?? "",
      completionDate: r.due_date,
      detailUrl: `recurring-tasks.html?template=${r.template_id}`,
    });
  }
  for (const r of await listAdHocTasksByIds(byType.ad_hoc)) {
    map.set(`ad_hoc:${r.id}`, {
      level1: r.level1_number,
      level2: null,
      level3: null,
      level1Text: r.level1_number != null ? `${r.level1_number}.${r.title}` : r.title,
      level2Text: "",
      level3Text: "",
      targetDeliverable: null, // 计划外任务没有"最终目标交付物"概念
      sourceStatus: SOURCE_STATUS_LABEL[r.status] ?? r.status ?? "",
      completionDate: null,
      detailUrl: `ad-hoc-tasks.html`,
    });
  }
  return map;
}

// weekly-summary.js填"完成情况"时，要把结果同步回源表自身的status字段——否则源表状态永远
// 不变，候选池的过滤逻辑（按源表status判断是否已完成）永远看不出这个任务已经做完，
// 已完成的任务会一直出现在下一周的候选池里（这是个真实bug，2026-07-10发现并修复）。
// weekly_task_entries.status用的是task_completion_status枚举(已完成/未完成/中止/未启动)，
// 四张源表各自的status用的是不同的英文check约束，这里做映射。
const SOURCE_STATUS_FOR_COMPLETION = {
  queue_task: { 已完成: "done", 未完成: "in_progress", 中止: "skipped", 未启动: "pending" },
  milestone: { 已完成: "done", 未完成: "in_progress", 中止: "stopped", 未启动: "not_started" },
  recurring_instance: { 已完成: "done", 未完成: "in_progress", 中止: "stopped", 未启动: "not_started" },
  ad_hoc: { 已完成: "closed", 未完成: "open", 中止: "closed", 未启动: "open" },
};

export async function syncSourceStatus(sourceType, sourceId, completionStatus) {
  const target = SOURCE_STATUS_FOR_COMPLETION[sourceType]?.[completionStatus];
  if (!target || sourceId == null) return;
  const today = new Date().toISOString().slice(0, 10);
  if (sourceType === "queue_task") {
    await updateQueueProjectTask(sourceId, { status: target });
  } else if (sourceType === "milestone") {
    await updateMilestone(sourceId, { status: target, ...(target === "done" ? { actual_date: today } : {}) });
  } else if (sourceType === "recurring_instance") {
    await updateRecurringInstance(sourceId, {
      status: target,
      ...(target === "done" ? { actual_completion_date: today } : {}),
    });
  } else if (sourceType === "ad_hoc") {
    await updateAdHocTask(sourceId, { status: target, ...(target === "closed" ? { actual_end: today } : {}) });
  }
}
