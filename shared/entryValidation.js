// weekly-plan.js/weekly-summary.js共用的"锁定前完整性校验"。用户要求：完成情况没选/
// 未完成时没填未完成原因整改措施风险、其他非条件字段留空——都不能锁定，要报错列出缺哪些。
// 校验范围不能只看这两个页面自己的表单字段——任务1/2/3级标题、最终目标交付物、最终计划
// 完成时间这些是在tasks.html里填的，PPT里一样会用到，所以也要查。

// 按来源类型，哪些"源表字段"是这个类型结构上应该有的——三种类型(顺序队列/截止日期/循环任务)
// 现在都要求有最终目标交付物+最终计划完成时间(2026-07-10用户明确要求统一，顺序队列
// 原来没有完成时间概念，现在补上了planned_completion_date字段)
const REQUIRED_DETAIL_BY_TYPE = {
  queue_task: ["targetDeliverable", "completionDate"],
  milestone: ["targetDeliverable", "completionDate"],
  recurring_instance: ["targetDeliverable", "completionDate"],
};
const DETAIL_FIELD_LABEL = { targetDeliverable: "最终目标交付物", completionDate: "计划完成时间" };

// 检查跨页面的源表字段（标题/目标交付物/计划完成时间），不检查weekly_task_entries自己的字段
export function validateSourceDetail(entry, detail) {
  if (!detail || !detail.level1Text) {
    return ["任务标题缺失（去对应项目/任务详情页补充标题）"];
  }
  const errors = [];
  for (const field of REQUIRED_DETAIL_BY_TYPE[entry.source_type] || []) {
    if (!detail[field]) {
      errors.push(`缺少${DETAIL_FIELD_LABEL[field]}（去对应项目/任务详情页补充）`);
    }
  }
  return errors;
}

// fields: [[dbFieldName, 中文label], ...]，检查weekly_task_entries自己的字段是否都填了
export function validateOwnFields(entry, fields) {
  return fields.filter(([f]) => entry[f] == null || entry[f] === "").map(([, label]) => `未填${label}`);
}
