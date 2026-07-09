import { requireAuth } from "./shared/authGuard.js";
import { renderNav } from "./shared/nav.js";
import {
  listMeetingWeeks,
  bulkUpsertMeetingWeeks,
  upsertMeetingWeek,
  updateMeetingWeekFields,
  deleteMeetingWeek,
} from "./shared/db.js";
import { weekdayLabel } from "./shared/dateUtils.js";

const session = await requireAuth();
if (!session) {
  throw new Error("not authenticated");
}
renderNav();

function toISODate(d) {
  return d.toISOString().slice(0, 10);
}

// 默认规则：自然周=周日到周六；例会日=该周的周一；月份/月内第几周按例会日所在自然月计算
function generateYearRows(year) {
  const dec31 = new Date(Date.UTC(year, 11, 31));
  const jan1Dow = new Date(Date.UTC(year, 0, 1)).getUTCDay();
  let weekStart = new Date(Date.UTC(year, 0, 1 - jan1Dow));

  const rows = [];
  const monthCounters = {};

  while (weekStart <= dec31) {
    const meetingDate = new Date(
      Date.UTC(weekStart.getUTCFullYear(), weekStart.getUTCMonth(), weekStart.getUTCDate() + 1)
    );
    // 默认本周最后一个工作日=周五(自然周日起+5)，节假日可在下表手动改
    const workWeekEnd = new Date(
      Date.UTC(weekStart.getUTCFullYear(), weekStart.getUTCMonth(), weekStart.getUTCDate() + 5)
    );

    if (meetingDate.getUTCFullYear() === year) {
      const monthKey = meetingDate.getUTCMonth();
      monthCounters[monthKey] = (monthCounters[monthKey] || 0) + 1;
      rows.push({
        natural_week_start: toISODate(weekStart),
        meeting_date: toISODate(meetingDate),
        work_week_end: toISODate(workWeekEnd),
        calendar_month: toISODate(new Date(Date.UTC(year, monthKey, 1))),
        week_index_in_month: monthCounters[monthKey],
        is_normal: true,
      });
    }

    weekStart = new Date(
      Date.UTC(weekStart.getUTCFullYear(), weekStart.getUTCMonth(), weekStart.getUTCDate() + 7)
    );
  }

  return rows;
}

// calendar_month/week_index_in_month完全由meeting_date+is_normal推出来，不应该手动填：
// 按meeting_date所在自然月分组，月内按natural_week_start顺序编号，跳过(is_normal=false)的周
// 不占号、不计入计数（顺延递补，不留空号——跟循环任务的编号规则是同一套逻辑）。
function recomputeMonthIndices(rows) {
  const sorted = [...rows].sort((a, b) => new Date(a.natural_week_start) - new Date(b.natural_week_start));
  const counters = {};
  return sorted.map((row) => {
    const monthKey = row.meeting_date.slice(0, 7);
    const calendar_month = `${monthKey}-01`;
    let week_index_in_month = 0;
    if (row.is_normal !== false) {
      counters[monthKey] = (counters[monthKey] || 0) + 1;
      week_index_in_month = counters[monthKey];
    }
    return { ...row, calendar_month, week_index_in_month };
  });
}

async function loadTable() {
  const rows = await listMeetingWeeks();
  const recomputed = recomputeMonthIndices(rows);

  // 跟数据库里存的值不一致就同步回去（比如刚改了meeting_date/is_normal，导致后面几周顺延）
  const toSync = recomputed.filter((row) => {
    const original = rows.find((r) => r.id === row.id);
    return original.calendar_month !== row.calendar_month || original.week_index_in_month !== row.week_index_in_month;
  });
  if (toSync.length > 0) {
    await Promise.all(
      toSync.map((row) =>
        updateMeetingWeekFields(row.id, {
          calendar_month: row.calendar_month,
          week_index_in_month: row.week_index_in_month,
        })
      )
    );
  }

  const tbody = document.getElementById("weeks-tbody");
  tbody.innerHTML = "";
  for (const row of recomputed) {
    tbody.appendChild(renderRow(row));
  }
}

function renderRow(row) {
  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td>${row.natural_week_start}</td>
    <td>
      <input type="date" class="f-meeting-date" value="${row.meeting_date}" />
      <span class="f-meeting-date-weekday badge">${weekdayLabel(row.meeting_date)}</span>
    </td>
    <td>
      <input type="date" class="f-work-week-end" value="${row.work_week_end ?? ""}" />
      <span class="f-work-week-end-weekday badge">${weekdayLabel(row.work_week_end)}</span>
    </td>
    <td>${row.calendar_month.slice(0, 7)}</td>
    <td>${row.is_normal === false ? "—" : `第${row.week_index_in_month}周`}</td>
    <td><input type="checkbox" class="f-is-normal" ${row.is_normal ? "checked" : ""} /></td>
    <td><input type="text" class="f-notes" value="${row.notes ?? ""}" placeholder="节假日调休说明等" /></td>
    <td><button type="button" class="secondary f-save">保存</button></td>
    <td><button type="button" class="secondary f-delete">删除</button></td>
  `;
  tr.querySelector(".f-meeting-date").addEventListener("input", (e) => {
    tr.querySelector(".f-meeting-date-weekday").textContent = weekdayLabel(e.target.value);
  });
  tr.querySelector(".f-work-week-end").addEventListener("input", (e) => {
    tr.querySelector(".f-work-week-end-weekday").textContent = weekdayLabel(e.target.value);
  });
  tr.querySelector(".f-save").addEventListener("click", async () => {
    const patch = {
      natural_week_start: row.natural_week_start,
      meeting_date: tr.querySelector(".f-meeting-date").value,
      work_week_end: tr.querySelector(".f-work-week-end").value || null,
      is_normal: tr.querySelector(".f-is-normal").checked,
      notes: tr.querySelector(".f-notes").value || null,
    };
    await upsertMeetingWeek(patch);
    // meeting_date/is_normal可能变了，归属月份/月内第几周要跟着重算，顺便可能影响本月后面几周
    await loadTable();
  });
  tr.querySelector(".f-delete").addEventListener("click", async () => {
    if (!confirm(`确定删除 ${row.natural_week_start} 这一整周？如果已经有循环任务实例/周计划引用了这一周会删除失败。`)) return;
    try {
      await deleteMeetingWeek(row.id);
      await loadTable();
    } catch (err) {
      alert(`删除失败：${err.message}\n\n如果只是整周没开例会（比如春节假期），更推荐取消勾选"正常"而不是删除——取消勾选后，下周计划/循环任务实例生成会自动跳过这一周，同时还保留这周在日历里方便查看，删除则会把这一整周从日历里抹掉。`);
    }
  });
  return tr;
}

document.getElementById("generate-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const year = Number(new FormData(e.target).get("year"));
  const resultEl = document.getElementById("generate-result");
  resultEl.textContent = "生成中...";
  resultEl.className = "status";
  try {
    const rows = generateYearRows(year);
    await bulkUpsertMeetingWeeks(rows);
    resultEl.textContent = `完成，${year}年共 ${rows.length} 个自然周（已存在的记录不会被覆盖）`;
    resultEl.className = "status ok";
    await loadTable();
  } catch (err) {
    resultEl.textContent = `失败：${err.message}`;
    resultEl.className = "status error";
  }
});

loadTable();
