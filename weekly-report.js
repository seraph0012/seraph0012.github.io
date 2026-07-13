import { requireAuth } from "./shared/authGuard.js";
import { renderNav } from "./shared/nav.js";
import { listModules, listPeople, listMeetingWeeks } from "./shared/db.js";
import { mountSummarySection } from "./shared/summarySection.js";
import { mountPlanSection } from "./shared/planSection.js";
import { generatePptForWeek } from "./shared/pptGenerate.js";

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

async function applyWeek(week) {
  targetWeek = week;
  previousWeek = week ? findPreviousWeek(week) : null;
  renderWeekInfo();
  await summaryCtrl.setWeek(previousWeek);
  await planCtrl.setWeek(targetWeek, previousWeek);
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
  const [modules, people, weeks] = await Promise.all([listModules(), listPeople(), listMeetingWeeks()]);
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
