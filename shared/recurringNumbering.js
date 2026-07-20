// 循环任务编号/候选周算法——原本是tasks.js内部的私有函数，2026-07-20"制作周报"页面新增
// 完整版"新建任务"功能(shared/taskCreateSection.js)后需要复用同一套算法，抽成共享纯函数
// 避免两处实现逐渐分叉(这个项目已经用过好几次这个模式，比如taskLabels.js的
// computeSyncedTaskStatus)。computeNextNumber/nextUnusedWeek原来直接闭包引用tasks.js
// 模块级的allWeeks变量，抽出来后改成显式参数传入。

// weekly频率 - 同月内下一次实例level3=上一实例level3+1(跳过的周顺延递补，不留空号)；
// 跨自然月则level2+1、level3重置为1，且无论中间跳过几个月都只+1(顺延式)。
// monthly频率则level2=上一实例level2+1，不使用level3。
export function computeNextNumber(project, instances, targetWeek, allWeeks) {
  const frequency = project.recurring_project_settings.frequency;
  if (instances.length === 0) {
    return { level2: 1, level3: frequency === "monthly" ? null : 1 };
  }
  const sorted = [...instances].sort((a, b) => {
    const wa = allWeeks.find((w) => w.id === a.meeting_week_id);
    const wb = allWeeks.find((w) => w.id === b.meeting_week_id);
    return new Date((wa ?? {}).natural_week_start || 0) - new Date((wb ?? {}).natural_week_start || 0);
  });
  const last = sorted[sorted.length - 1];
  const lastWeek = allWeeks.find((w) => w.id === last.meeting_week_id);

  if (frequency === "monthly") {
    return { level2: last.wbs_level2_number + 1, level3: null };
  }
  const sameMonth = lastWeek.calendar_month === targetWeek.calendar_month;
  if (sameMonth) {
    return { level2: last.wbs_level2_number, level3: last.wbs_level3_number + 1 };
  }
  return { level2: last.wbs_level2_number + 1, level3: 1 };
}

// 循环任务项目不存"起始例会周"这个字段(创建时就直接生成第一个实例，之后"下一个实例"永远
// 只看"已有实例里最早的那一个"往后找，不需要项目额外记一个开始日期)。
export function nextUnusedWeek(instances, allWeeks) {
  if (instances.length === 0) return allWeeks[0] ?? null;
  const usedWeekIds = new Set(instances.map((i) => i.meeting_week_id));
  const usedWeeksSorted = instances
    .map((i) => allWeeks.find((w) => w.id === i.meeting_week_id))
    .filter(Boolean)
    .sort((a, b) => new Date(a.natural_week_start) - new Date(b.natural_week_start));
  const firstWeek = usedWeeksSorted[0];
  if (!firstWeek) return null;
  const sorted = [...allWeeks]
    .filter((w) => new Date(w.natural_week_start) >= new Date(firstWeek.natural_week_start))
    .sort((a, b) => new Date(a.natural_week_start) - new Date(b.natural_week_start));
  return sorted.find((w) => !usedWeekIds.has(w.id));
}

// 循环任务标题/最终交付物按当次生成的月/周动态拼出来——项目只存"动词前缀(title_verb)+
// 名词部分(title_noun)"，比如"制作"+"周例会PPT"，每次生成实例时现算出"7月第4周"这种限定语
// 插进去。monthly频率没有level3(月内不再细分)，限定语只用月份。交付物不带动词前缀。
// "第几周"用的是level3(这个循环任务在本月内的第几次执行，顺延递补算法算出来的)，不是
// 自然日历的week_index_in_month。
export function monthWeekLabel(targetWeek, frequency, level3) {
  const month = Number(targetWeek.calendar_month.slice(5, 7));
  return frequency === "monthly" ? `${month}月` : `${month}月第${level3}周`;
}
export function generateInstanceTitle(titleVerb, titleNoun, frequency, targetWeek, level3) {
  return `${titleVerb}${monthWeekLabel(targetWeek, frequency, level3)}${titleNoun}`;
}
export function generateInstanceDeliverable(titleVerb, titleNoun, frequency, targetWeek, level3) {
  return `${monthWeekLabel(targetWeek, frequency, level3)}${titleNoun}`;
}

// level2为空代表"项目本身就是任务，没有再往下分解"(比如临时的一次性计划外工作)，
// 这时候编号就是纯"5"而不是"5.2"
export function wbsLabel(level1, level2, level3) {
  if (level2 == null) return `${level1}`;
  return level3 != null ? `${level1}.${level2}.${level3}` : `${level1}.${level2}`;
}
