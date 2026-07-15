// weekly_task_entries 不存任务标题文字，只存 task_id 指回统一的 tasks 表。
// 这里统一处理"给一批 task_id 反查可读标题/结构化详情"，plan和summary页面共用。
// 2026-07-14任务数据模型统一重构：原来queue_task/milestone/recurring_instance三种来源类型
// 分散在三张表，这里对应有三套几乎重复的查询+拼接逻辑；统一成一张tasks表后收缩成单查询，
// 不再需要sourceIdOf/sourceColumnFor/SOURCE_LABEL这类按source_type分发的工具函数。
import { listTasksByIds, listProjects, updateTask } from "./db.js";

export const PROJECT_TYPE_LABEL = {
  sequential: "顺序队列",
  nonsequential: "截止日期",
  recurring: "循环任务",
};

// 来源表自身的英文status值 -> PPT里用的中文文案（跟weekly_task_entries.status用的
// task_completion_status枚举本来就是中文不一样，tasks.status是英文check约束）。
// PPT"完成情况"列只认task_completion_status枚举那4种(已完成/未完成/中止/未启动)，没有
// "进行中"这个来源表内部状态词——2026-07-10用户指出总体完成情况列不该出现"进行中"，
// 是"进行中"就该按"未完成"处理。2026-07-14统一任务模型后status的terminal值统一收敛成
// stopped(不再有顺序队列专属的skipped)。
export const SOURCE_STATUS_LABEL = {
  not_started: "未启动",
  in_progress: "未完成",
  done: "已完成",
  stopped: "中止",
};

// 为空=项目本身就是任务，没有再往下分解；跟tasks.js的wbsLabel()是同一套规则，这里单独
// 实现一份是因为输入形状不同(这里要顺带拼标题文本)，保持两处逻辑一致即可。
function wbsNumber(level1, level2, level3) {
  if (level2 == null) return `${level1}`;
  return level3 != null ? `${level1}.${level2}.${level3}` : `${level1}.${level2}`;
}

// items: taskIds -> Map<id, "[编号] 项目名 / 任务名">
export async function buildLabelMap(taskIds) {
  const map = new Map();
  for (const t of await listTasksByIds(taskIds)) {
    const num = wbsNumber(t.projects.level1_number, t.wbs_level2_number, t.wbs_level3_number);
    map.set(t.id, `[${num}] ${t.projects.title} / ${t.title}`);
  }
  return map;
}

// queue_task/milestone/recurring_instance共用同一套WBS编号+标题拼接逻辑（统一之前这三类
// 分别有自己的拼接代码，recurring还额外用full_number列；现在wbs_level2/3_number字段名和
// 语义完全统一，可以共用一份）。level2为空(项目本身就是任务)时，标题放进level2Text，
// 编号只用level1(此前这个分支在旧代码里被漏掉过，会拼出"10.null"，这次一并修正)。
// 2026-07-16修复：level3!=null(这个二级下有三级子任务)时，level2Text原来只有裸编号
// "5.1"、没有标题文字——task_groups里存的二级标题从来没被这个函数用上，是跟tasks.js
// 树状展示完全独立的另一处bug(tasks.js自己另外查task_groups，那边一直是对的)。现在
// groupTitle参数就是从task_groups反查到的这个二级分组的标题，跟tasks.js的
// level2NodeForTaskList()保持一致的占位文案。
function wbsTexts(level1, level2, level3, projectTitle, rowTitle, groupTitle) {
  const level1Text = `${level1}.${projectTitle}`;
  if (level2 == null) {
    return { level1Text, level2Text: `${level1} ${rowTitle}`, level3Text: "" };
  }
  if (level3 != null) {
    return {
      level1Text,
      level2Text: `${level1}.${level2} ${groupTitle || "(未命名，点详情补充)"}`,
      level3Text: `${level1}.${level2}.${level3} ${rowTitle}`,
    };
  }
  return { level1Text, level2Text: `${level1}.${level2} ${rowTitle}`, level3Text: "" };
}

// ppt-export专用：反查PPT里"任务1/2/3级"（编号+标题拼接文本）+"最终目标交付物"+
// "来源任务自身完成状态"+"来源任务自身的计划完成时间"这几列（这些字段taskLabels/
// buildLabelMap不需要，只有导出PPT/校验要）。
// items: taskIds -> Map<id, {level1,level2,level3(数字，供排序用),
//   level1Text,level2Text,level3Text(拼好的显示文本), targetDeliverable, sourceStatus, completionDate,
//   completionDateAmendmentNote, actualStartDate, detailUrl}>
export async function buildSourceDetailMap(taskIds) {
  const map = new Map();
  for (const t of await listTasksByIds(taskIds)) {
    const level1 = t.projects.level1_number;
    const groupTitle =
      t.wbs_level3_number != null
        ? (t.projects.task_groups || []).find((g) => g.wbs_level2_number === t.wbs_level2_number)?.title
        : undefined;
    map.set(t.id, {
      level1,
      level2: t.wbs_level2_number,
      level3: t.wbs_level3_number,
      ...wbsTexts(level1, t.wbs_level2_number, t.wbs_level3_number, t.projects.title, t.title, groupTitle),
      targetDeliverable: t.target_deliverable,
      sourceStatus: SOURCE_STATUS_LABEL[t.status] ?? t.status ?? "",
      completionDate: t.planned_completion_date,
      completionDateAmendmentNote: t.completion_date_amendment_note,
      actualStartDate: t.actual_start_date,
      detailUrl: `tasks.html?highlight=task:${t.id}`,
    });
  }
  return map;
}

// weekly-report.js填"完成情况"时，要把结果同步回任务自身的status字段——否则任务状态永远
// 不变，候选池的过滤逻辑（按任务status判断是否已完成）永远看不出这个任务已经做完，
// 已完成的任务会一直出现在下一周的候选池里（这是个真实bug，2026-07-10发现并修复）。
// weekly_task_entries.status用的是task_completion_status枚举(已完成/未完成/中止/未启动)，
// tasks.status用的是英文check约束，这里做映射。
//
// isFinal：只有"这周实际交付的东西"文字上严格等于"这个任务的最终目标交付物"，才代表任务
// 本身真正完成——复杂的3级任务允许跨周分批交付（本周先交一部分，下周继续，最终目标交付物
// 不变），中途每周都可能标"已完成"（指这周那部分），但任务status要留在"进行中"，不能提前
// 置done，否则候选池会把它当成已完成过滤掉，下一周就选不出来续填了（2026-07-14发现的真实
// 设计缺口，"周完成"和"任务最终完成"此前被当成同一件事在同步）。调用方按"本周交付材料"
// 跟"最终目标交付物"是否严格文字相等（去首尾空格，大小写敏感）算出isFinal——跟用户确认过，
// 不加"手动强制标最终完成"的兜底，对不上就是要求这周的交付物文字必须原样等于最终目标交付物。
const STATUS_FOR_COMPLETION = { 已完成: "done", 未完成: "in_progress", 中止: "stopped", 未启动: "not_started" };

// 纯函数版本，抽出来单独导出——2026-07-16用户反馈"总体完成情况"这一列保存后不会在页面上
// 刷新(逻辑其实一直在正确执行，只是DOM没跟着更新，看起来像"没有自动判断")。summarySection.js
// 保存成功后要在本地立刻把这一列的显示值算出来刷新(不想为了刷新这一个字段专门重新查一次
// 数据库)，必须跟syncTaskStatus()写库时用的是同一套判断逻辑，不能自己另外抄一份、以后两边
// 改一边忘了改另一边——所以把"给定完成情况+isFinal，算出最终应该同步成什么status"这部分
// 抽成独立的纯函数，syncTaskStatus()和summarySection.js都调用它。
export function computeSyncedTaskStatus(completionStatus, { isFinal = true } = {}) {
  let target = STATUS_FOR_COMPLETION[completionStatus];
  if (!target) return null;
  if (completionStatus === "已完成" && !isFinal) {
    target = "in_progress";
  }
  return target;
}

export async function syncTaskStatus(taskId, completionStatus, opts = {}) {
  const target = computeSyncedTaskStatus(completionStatus, opts);
  if (!target || taskId == null) return;
  const today = new Date().toISOString().slice(0, 10);
  await updateTask(taskId, { status: target, actual_completion_date: target === "done" ? today : null });
}

// 顺序队列(sequential)任务的"执行期"不预填(队列进度本来就没有固定到期日概念)，
// 截止日期(nonsequential)/循环任务(recurring)用自己的最终计划完成时间做默认值，
// 跟统一之前的行为一致(queue_task始终execution_deadline:null，milestone/recurring
// 用各自的日期字段)。listAllActiveCandidates(本文件)、planSection.js的候选池生成
// 都用这个，避免两处各写一份。project_id/project_level1_number/project_title/
// wbs_level2_number/wbs_level3_number(2026-07-14新增)供taskPicker.js的级联选择器
// 按1/2/3级编号分组用，不是每个调用方都需要，但挂在这里比另开一个函数简单。
export function taskCandidateFields(project, task) {
  return {
    task_id: task.id,
    project_id: project.id,
    project_level1_number: project.level1_number,
    project_title: project.title,
    project_type: project.project_type,
    wbs_level2_number: task.wbs_level2_number,
    wbs_level3_number: task.wbs_level3_number,
    module_id: task.module_id,
    owner: task.owner,
    deliverable_this_week: task.target_deliverable || "",
    execution_deadline: project.project_type === "sequential" ? null : task.planned_completion_date,
    actualStartDate: task.actual_start_date,
  };
}

// 拉出所有"活跃"（非done/stopped）的顺序队列/截止日期任务 + 目标周的循环任务实例，
// 附上可搜索的label（"来源类型 [编号] 项目名 / 任务名"）和结构化详情(detail，跟
// buildSourceDetailMap单条查询返回的形状一致)——summarySection"记录计划外完成的任务"、
// planSection"手动搜索添加任务"都基于这份全量列表：label配合shared/taskPicker.js做本地
// 按编号/标题过滤(取代旧的"把所有候选塞进一个<select>"写法)，detail则是2026-07-14新增，
// 供选中后直接在本地拼出"本周计划/总结"表格新增行用，不用为了显示这一行再单独查一次
// buildSourceDetailMap([taskId])。
// 不按日期过滤：milestone提前完成也应该能被记成"计划外完成"，date-aware的筛选只用在
// planSection自动候选池那条独立逻辑里（那是"这周该不该主动建议"，语义不同）。
export async function listAllActiveCandidates(weekId) {
  const projects = await listProjects();
  const candidates = [];
  for (const p of projects) {
    for (const t of p.tasks) {
      if (t.status === "done" || t.status === "stopped") continue;
      if (p.project_type === "recurring" && t.meeting_week_id !== weekId) continue;
      candidates.push(taskCandidateFields(p, t));
    }
  }
  const taskIds = candidates.map((c) => c.task_id);
  const [labelMap, detailMap] = await Promise.all([buildLabelMap(taskIds), buildSourceDetailMap(taskIds)]);
  for (const c of candidates) {
    c.label = `${PROJECT_TYPE_LABEL[c.project_type]} ${labelMap.get(c.task_id) || "(未知任务)"}`;
    c.detail = detailMap.get(c.task_id) || {};
  }
  return candidates;
}
