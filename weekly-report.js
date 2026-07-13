import { requireAuth } from "./shared/authGuard.js";
import { renderNav } from "./shared/nav.js";
import { listModules, listPeople, listMeetingWeeks } from "./shared/db.js";
import { mountSummarySection } from "./shared/summarySection.js";
import { mountPlanSection } from "./shared/planSection.js";
import { generatePptForWeek } from "./shared/pptGenerate.js";
import { cacheFirst } from "./shared/localCache.js";

const session = await requireAuth();
if (!session) {
  throw new Error("not authenticated");
}
renderNav();

let allModules = [];
let allWeeks = [];
let targetWeek = null;
let previousWeek = null;

function findPreviousWeek(week) {
  const earlier = allWeeks.filter((w) => w.natural_week_start < week.natural_week_start);
  if (earlier.length === 0) return null;
  return earlier.reduce((a, b) => (a.natural_week_start > b.natural_week_start ? a : b));
}

function renderWeekInfo() {
  const el = document.getElementById("week-info");
  if (!targetWeek) {
    el.textContent = "";
    return;
  }
  const monthLabel = targetWeek.calendar_month ? targetWeek.calendar_month.slice(5, 7) : "?";
  el.textContent =
    `本周计划：${monthLabel}月份第${targetWeek.week_index_in_month}周（例会${targetWeek.meeting_date}）｜` +
    `上周总结来源：${previousWeek ? previousWeek.natural_week_start + " ~ " + previousWeek.natural_week_end : "（没有更早的例会周，本次不生成上周总结部分）"}`;
}

let summaryCtrl = null;
let planCtrl = null;

// 切周期间把选择器disabled掉，防止用户在上一次切换的异步查询(loadSummary/loadSavedPlan等)
// 还没返回时又快速切到另一个周——两次setWeek()的DOM写入会交错，后完成的那次(不一定是
// 用户最后选的那个周)会把表格覆盖成它自己的数据，表现为"切换后不显示对应周的数据"/
// "看起来好像切换无效"。
//
// try/catch必须包在这里(而不是让异常往外抛)：init()里第一次调用applyWeek(defaultWeek)
// 是在"weekSelect.addEventListener('change',...)"注册之前await的，如果这次调用抛出未捕获
// 异常，init()会直接在这一行中断，后面注册change监听器的代码根本不会执行——这样往后不管
// 怎么切换选择器都不会有任何反应(2026-07-13用户实测到的真实现象："只有刚刚打开页面的时候
// 是禁用选择器的，后续切换周就没有任何效果了")。这里兜住异常，保证init()一定能往下走到
// addEventListener，并把错误信息显示出来方便定位，而不是静默吞掉。
async function applyWeek(week) {
  const weekSelect = document.getElementById("week-select");
  const infoEl = document.getElementById("week-info");
  weekSelect.disabled = true;
  try {
    targetWeek = week;
    previousWeek = week ? findPreviousWeek(week) : null;
    renderWeekInfo();
    await summaryCtrl.setWeek(previousWeek);
    await planCtrl.setWeek(targetWeek, previousWeek);
  } catch (err) {
    console.error("[weekly-report] 切换目标周失败", err);
    infoEl.textContent = `切换周失败：${err.message}（详情见浏览器控制台F12）`;
    infoEl.className = "status error";
  } finally {
    weekSelect.disabled = false;
  }
}

document.getElementById("generate-ppt-btn").addEventListener("click", async () => {
  const resultEl = document.getElementById("generate-result");
  if (!targetWeek) return;
  resultEl.textContent = "生成中...";
  resultEl.className = "status";
  try {
    const r = await generatePptForWeek(targetWeek, previousWeek, allModules);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(r.blob);
    a.download = r.filename;
    a.click();
    URL.revokeObjectURL(a.href);
    resultEl.textContent =
      `已生成并下载 ${r.filename}（上周总结 ${r.summaryCount} 条，本周计划 ${r.planCount} 条，` +
      `未启动/中止 ${r.stoppedCount} 条）——请打开核对合并单元格/颜色/文字是否正确`;
    resultEl.className = "status ok";
  } catch (err) {
    resultEl.textContent = `失败：${err.message}`;
    resultEl.className = "status error";
  }
});

async function init() {
  // modules/people/meeting_weeks用cache-first减少首屏等待——但summarySection/planSection
  // 挂载时会把allModules/allPeople以值的形式传进去，挂载后没有"数据到了再更新"的接口，所以
  // 跟tasks.js/modules.js那种"先用缓存渲染、fresh数据到了再重渲染"不一样：这里必须先拿到
  // 一份可用数据(缓存或首次网络请求)才能挂载。有缓存就是瞬间完成，没缓存(第一次访问这个
  // 浏览器)才会显示"加载中"占位(2026-07-13整体改动的一部分，
  // 见tools/.claude/plans/plan-local-cache-loading-states.md)
  const modulesCache = cacheFirst("modules", listModules);
  const peopleCache = cacheFirst("people", listPeople);
  const weeksCache = cacheFirst("meeting_weeks", listMeetingWeeks);
  // 有缓存时不等待这三个后台revalidate请求就直接往下走，但仍要接一个catch，避免它们万一
  // 失败时在控制台报"未处理的Promise rejection"噪音(反正只是优化用途，失败了下次访问再试)
  modulesCache.freshPromise.catch(() => {});
  peopleCache.freshPromise.catch(() => {});
  weeksCache.freshPromise.catch(() => {});

  let modules, people, weeks;
  if (modulesCache.cached && peopleCache.cached && weeksCache.cached) {
    modules = modulesCache.cached;
    people = peopleCache.cached;
    weeks = weeksCache.cached;
  } else {
    document.getElementById("summary-root").innerHTML = `<p class="status">加载中...</p>`;
    document.getElementById("plan-root").innerHTML = `<p class="status">加载中...</p>`;
    [modules, people, weeks] = await Promise.all([
      modulesCache.freshPromise,
      peopleCache.freshPromise,
      weeksCache.freshPromise,
    ]);
  }
  allModules = modules;
  allWeeks = weeks.filter((w) => w.is_normal !== false);

  summaryCtrl = mountSummarySection(document.getElementById("summary-root"), { allModules });
  planCtrl = mountPlanSection(document.getElementById("plan-root"), { allModules, allPeople: people });

  const weekSelect = document.getElementById("week-select");
  const sorted = [...allWeeks].sort((a, b) => new Date(a.natural_week_start) - new Date(b.natural_week_start));
  for (const w of sorted) {
    const opt = document.createElement("option");
    opt.value = w.id;
    opt.textContent = `${w.natural_week_start} ~ ${w.natural_week_end}（例会${w.meeting_date}）`;
    weekSelect.appendChild(opt);
  }
  const today = new Date();
  const defaultWeek = sorted.find((w) => new Date(w.natural_week_start) > today) || sorted[sorted.length - 1];
  if (defaultWeek) {
    weekSelect.value = defaultWeek.id;
    await applyWeek(defaultWeek);
  }

  weekSelect.addEventListener("change", async () => {
    const week = allWeeks.find((w) => w.id === Number(weekSelect.value));
    await applyWeek(week);
  });
}

await init();
