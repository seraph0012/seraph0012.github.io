// "保存表格时"的规则审核——PLAN(本周计划)/SUMMARY(上周总结)两张表格的saveAllPlanRows()/
// saveAllSummaryRows()共用。完整规则目录+每条的取舍依据见
// tools/.claude/plans/plan-audit-rules-v1.md。
//
// 能靠HTML5原生约束(required/min/max，配合两个日期框互相联动min/max)在填写阶段就防住的
// 错误(必填/用时非负/日期先后顺序/日期落在本周工作日范围内)，都已经在buildPlanRowElement()/
// buildSummaryRowElement()里加了对应属性——这里不重复手写"是否为空"这类判断，只用
// checkValidity()读取原生校验结果、配一句中文提示(不依赖浏览器自带的validationMessage，
// 那个受浏览器语言/系统locale影响，没法保证文案一致)。
// 这个文件剩下要写的都是HTML属性表达不了的业务逻辑规则：跨字段(用时/交付物是否匹配)、
// 跨表(总结交付物是否匹配计划里写的交付物)、跨页面(任务标题/最终目标交付物/最终计划
// 完成时间在"任务管理"页面维护，不在这两张表单里)。
//
// 2026-07-20用户反馈：消息文案要尽量简短，只点出最可能的核心原因(调用方拼错误列表时
// 会自己加上"任务编号："前缀定位是哪一行，这里不用再重复任务信息)。

function nativeFieldError(el, label) {
  if (!el || el.checkValidity()) return null;
  const v = el.validity;
  if (v.valueMissing) return `${label}不能为空`;
  if (v.rangeUnderflow) {
    return el.type === "date" ? `${label}过早（早于计划开始/本周范围）` : `${label}不能为负数`;
  }
  if (v.rangeOverflow) {
    return el.type === "date" ? `${label}过晚（晚于执行期/本周范围）` : `${label}超出上限`;
  }
  return `${label}格式不对`;
}

// specs: [[field(class名，不带.), 中文label], ...]
function checkNativeFields(tr, specs) {
  const errors = [];
  for (const [field, label] of specs) {
    const msg = nativeFieldError(tr.querySelector(`.${field}`), label);
    if (msg) errors.push({ field, message: msg });
  }
  return errors;
}

// D1~D3：任务标题/最终目标交付物/最终计划完成时间缺失——这三个字段在"任务管理"页面维护，
// PLAN/SUMMARY表单里都是只读展示列，没法在这两张表里直接改，标红对应列。
function crossPageErrors(detail) {
  if (!detail || !detail.level1Text) {
    return [{ field: "task-col", message: "任务标题缺失" }];
  }
  const errors = [];
  if (!detail.targetDeliverable) {
    errors.push({ field: "target-deliverable-col", message: "缺最终目标交付物" });
  }
  if (!detail.completionDate) {
    errors.push({ field: "completion-date-col", message: "缺最终计划完成时间" });
  }
  return errors;
}

const PLAN_NATIVE_FIELDS = [
  ["f-deliverable", "本周交付物"],
  ["f-hours", "计划用时"],
  ["f-start", "计划开始时间"],
  ["f-deadline", "执行期"],
  ["f-priority", "工作优先级"],
];

// tr: "本周计划"表格的一行<tr>；detail: buildSourceDetailMap()查出来的这个任务的详情
export function validatePlanEntry(tr, detail) {
  const errors = [...checkNativeFields(tr, PLAN_NATIVE_FIELDS), ...crossPageErrors(detail)];
  // A11：任务本身状态已经是"已完成"/"中止"，却还留在本周计划里——任务状态可以在"任务
  // 管理"页面被单独改动，这张表不会自动感知到，不是靠输入框限制能防住的错误。
  if (detail && (detail.sourceStatus === "已完成" || detail.sourceStatus === "中止")) {
    errors.push({ field: "task-col", message: `任务${detail.sourceStatus}，不应再排入计划` });
  }
  return errors;
}

const SUMMARY_NATIVE_FIELDS = [
  ["f-deliverable", "上周交付材料"],
  ["f-status", "完成情况"],
  ["f-hours", "实际用时"],
];
const SUMMARY_CONDITIONAL_FIELDS = [
  ["f-reason", "未完成原因"],
  ["f-rectify", "整改措施"],
  ["f-risk", "风险等级"],
  ["f-risk-note", "风险说明"],
];

// tr: "上周总结"表格的一行<tr>；detail: 这个任务的详情；matchingPlanEntry: 同一任务在
// 同一周PLAN表里的条目（可能不存在，比如"记录计划外完成的任务"这条路径加进来的）。
//
// 下面几条业务规则是用户根据实际开周例会的经验总结的（plan-audit-rules-v1.md第三部分），
// 核心原则："交付物就是用来判断任务完成情况的，交付物和计划一致就代表任务完成，否则未完成"。
export function validateSummaryEntry(tr, detail, matchingPlanEntry) {
  const errors = [...checkNativeFields(tr, SUMMARY_NATIVE_FIELDS), ...crossPageErrors(detail)];

  const status = tr.querySelector(".f-status").value;
  if (status === "未完成") {
    errors.push(...checkNativeFields(tr, SUMMARY_CONDITIONAL_FIELDS));
  }

  const deliverable = (tr.querySelector(".f-deliverable").value || "").trim();
  const targetDeliverable = (detail?.targetDeliverable || "").trim();
  const hoursRaw = tr.querySelector(".f-hours").value;
  const hours = hoursRaw === "" ? null : Number(hoursRaw);

  // E1：交付材料已经跟最终目标交付物一字不差，但完成情况没选"已完成"——这是
  // computeSyncedTaskStatus()目前唯一没处理的方向（它只处理"选了已完成但交付物对不上
  // 目标→自动降级成未完成"这一个方向，是分阶段交付的设计），没选已完成但交付物已经严格
  // 等于目标时不会被自动纠正。这条错误有两种可能的修法(交付材料填错了/完成情况选错了)，
  // 检查未完成原因/整改措施/风险说明这三个自由文本字段实际有没有内容作判断依据——真的
  // 认真填过，大概率是交付材料填错了；一个字都没填，大概率是漏选了"已完成"。
  if (status && status !== "已完成" && targetDeliverable && deliverable === targetDeliverable) {
    const hasNotes = ["f-reason", "f-rectify", "f-risk-note"].some(
      (cls) => (tr.querySelector(`.${cls}`)?.value || "").trim() !== ""
    );
    errors.push({
      field: "f-status",
      message: hasNotes ? "交付物疑似误填成最终版" : "疑似漏选'已完成'",
    });
  }

  // E3/E4：交付材料是否跟这一周计划里写的交付物一致，是判断"这周该做的做完了没有"的另一个
  // 独立基准（不是跟最终目标比，是跟这一周计划比）——现有的自动同步逻辑完全不看PLAN条目，
  // 这块是真空，不是重复劳动。
  if (matchingPlanEntry) {
    const planDeliverable = (matchingPlanEntry.deliverable_this_week || "").trim();
    if (planDeliverable) {
      if (status === "已完成" && deliverable !== planDeliverable) {
        errors.push({ field: "f-status", message: "已完成但交付物与本周计划不符" });
        errors.push({ field: "f-deliverable", message: "与本周计划交付物不符" });
      } else if (status && status !== "已完成" && deliverable && deliverable === planDeliverable) {
        errors.push({ field: "f-status", message: "交付物与计划一致，应选已完成" });
      }
    }
  }

  // E5/E6：用时和交付物应该同步——花了时间就该有对应产出证明，用时为0就不该写实质性的
  // 交付内容。
  if (hours === 0 && deliverable && deliverable !== "无") {
    errors.push({ field: "f-hours", message: "用时为0但填了交付物" });
    errors.push({ field: "f-deliverable", message: "用时为0，交付物应填'无'" });
  } else if (hours != null && hours > 0 && (!deliverable || deliverable === "无")) {
    errors.push({ field: "f-hours", message: "有用时但无交付物" });
    errors.push({ field: "f-deliverable", message: "用时不为0，需填写交付物" });
  }

  return errors;
}
