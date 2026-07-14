// weekly_task_entries 不存任务标题文字，只存 source_type + source_*_id 指回四类任务的原表。
// 这里统一处理"给一批 entries/candidates 反查可读标题"，plan和summary页面共用。
import {
  listQueueProjectTasksByIds,
  listMilestonesByIds,
  listRecurringInstancesByIds,
  listQueueProjects,
  listDeadlineProjects,
  listRecurringInstancesForWeek,
  updateQueueProjectTask,
  updateMilestone,
  updateRecurringInstance,
} from "./db.js";

export const SOURCE_LABEL = {
  queue_task: "顺序队列",
  milestone: "截止日期",
  recurring_instance: "循环任务",
};

export function sourceIdOf(entry) {
  return entry.source_queue_task_id ?? entry.source_milestone_id ?? entry.source_recurring_instance_id;
}

export function sourceColumnFor(sourceType) {
  return {
    queue_task: "source_queue_task_id",
    milestone: "source_milestone_id",
    recurring_instance: "source_recurring_instance_id",
  }[sourceType];
}

// items: [{source_type, source_id}] -> Map<"type:id", "[编号] 项目名 / 任务名">
export async function buildLabelMap(items) {
  const byType = { queue_task: [], milestone: [], recurring_instance: [] };
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
    map.set(`recurring_instance:${r.id}`, `[${r.full_number}] ${r.title || r.recurring_task_templates.title}`);
  }
  return map;
}

// 来源表自身的英文status值 -> PPT里用的中文文案（跟weekly_task_entries.status用的
// task_completion_status枚举本来就是中文不一样，这几张来源表的status是各自表定义的英文check约束）。
// PPT"完成情况"列只认task_completion_status枚举那4种(已完成/未完成/中止/未启动)，没有
// "进行中"/"跳过"这两个来源表内部状态词——2026-07-10用户指出总体完成情况列不该出现"进行中"，
// 是"进行中"就该按"未完成"处理；"跳过"同理归入"中止"。
export const SOURCE_STATUS_LABEL = {
  pending: "未启动",
  in_progress: "未完成",
  done: "已完成",
  skipped: "中止",
  stopped: "中止",
  not_started: "未启动",
  open: "未完成",
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
// items: [{source_type, source_id}] -> Map<"type:id", {level1,level2,level3(数字，供排序用),
//   level1Text,level2Text,level3Text(拼好的显示文本), targetDeliverable, sourceStatus, completionDate,
//   completionDateAmendmentNote, detailUrl}>
export async function buildSourceDetailMap(items) {
  const byType = { queue_task: [], milestone: [], recurring_instance: [] };
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
      completionDate: r.planned_completion_date,
      completionDateAmendmentNote: r.completion_date_amendment_note,
      detailUrl: `tasks.html?highlight=queue_task:${r.id}`,
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
      completionDateAmendmentNote: r.planned_date_amendment_note,
      detailUrl: `tasks.html?highlight=milestone:${r.id}`,
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
      level2Text: `${r.full_number} ${r.title || templateTitle}`,
      level3Text: "",
      targetDeliverable: r.target_deliverable,
      sourceStatus: SOURCE_STATUS_LABEL[r.status] ?? r.status ?? "",
      completionDate: r.due_date,
      completionDateAmendmentNote: null,
      detailUrl: `tasks.html?highlight=recurring_instance:${r.id}`,
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
};

// 拉出所有"活跃"（非done/skipped/stopped）的顺序队列任务/截止日期里程碑 + 目标周的循环任务实例，
// 附上可搜索的label（"来源类型 [编号] 项目名 / 任务名"）——summarySection"记录计划外完成的任务"、
// planSection"手动搜索添加任务"都基于这份全量列表，配合shared/taskPicker.js做本地按编号/标题
// 过滤，取代旧的"把所有候选塞进一个<select>"写法（2026-07-14，任务多了下拉会长到没法用）。
// 不按日期过滤：milestone提前完成也应该能被记成"计划外完成"，date-aware的筛选只用在
// planSection自动候选池那条独立逻辑里（那是"这周该不该主动建议"，语义不同）。
export async function listAllActiveCandidates(weekId) {
  const [queueProjects, deadlineProjects, recurringInstances] = await Promise.all([
    listQueueProjects(),
    listDeadlineProjects(),
    listRecurringInstancesForWeek(weekId),
  ]);
  const candidates = [];
  for (const p of queueProjects) {
    for (const t of p.queue_project_tasks) {
      if (t.status === "done" || t.status === "skipped") continue;
      candidates.push({
        source_type: "queue_task",
        source_id: t.id,
        module_id: t.module_id,
        owner: t.owner,
        deliverable_this_week: t.target_deliverable || "",
        execution_deadline: null,
      });
    }
  }
  for (const p of deadlineProjects) {
    for (const m of p.deadline_milestones) {
      if (m.status === "done" || m.status === "stopped") continue;
      candidates.push({
        source_type: "milestone",
        source_id: m.id,
        module_id: m.module_id,
        owner: m.owner,
        deliverable_this_week: m.target_deliverable || "",
        execution_deadline: m.planned_date,
      });
    }
  }
  for (const inst of recurringInstances) {
    candidates.push({
      source_type: "recurring_instance",
      source_id: inst.id,
      module_id: inst.recurring_task_templates.module_id,
      owner: inst.recurring_task_templates.owner,
      deliverable_this_week: inst.target_deliverable || "",
      execution_deadline: inst.due_date,
    });
  }
  const labelMap = await buildLabelMap(candidates.map((c) => ({ source_type: c.source_type, source_id: c.source_id })));
  for (const c of candidates) {
    c.label = `${SOURCE_LABEL[c.source_type]} ${labelMap.get(`${c.source_type}:${c.source_id}`) || "(未知任务)"}`;
  }
  return candidates;
}

// isFinal：只有"这周实际交付的东西"文字上严格等于"这个任务的最终目标交付物"，才代表任务
// 本身真正完成——复杂的3级任务允许跨周分批交付（本周先交一部分，下周继续，最终目标交付物
// 不变），中途每周都可能标"已完成"（指这周那部分），但源表status要留在"进行中"，不能提前
// 置done，否则currentQueueTask()/候选池会把它当成已完成过滤掉，下一周就选不出来续填了
// （2026-07-14发现的真实设计缺口，"周完成"和"任务最终完成"此前被当成同一件事在同步）。
// 调用方(summarySection.js的save())按当前"本周交付材料"跟"最终目标交付物"是否严格文字相等
// （去首尾空格，大小写敏感）算出isFinal——跟用户确认过，不加"手动强制标最终完成"的兜底，
// 对不上就是要求这周的交付物文字必须原样等于最终目标交付物。
export async function syncSourceStatus(sourceType, sourceId, completionStatus, { isFinal = true } = {}) {
  let target = SOURCE_STATUS_FOR_COMPLETION[sourceType]?.[completionStatus];
  if (!target || sourceId == null) return;
  if (completionStatus === "已完成" && !isFinal) {
    target = "in_progress";
  }
  const today = new Date().toISOString().slice(0, 10);
  const done = target === "done";
  if (sourceType === "queue_task") {
    await updateQueueProjectTask(sourceId, { status: target, actual_completion_date: done ? today : null });
  } else if (sourceType === "milestone") {
    await updateMilestone(sourceId, { status: target, actual_date: done ? today : null });
  } else if (sourceType === "recurring_instance") {
    await updateRecurringInstance(sourceId, { status: target, actual_completion_date: done ? today : null });
  }
}
