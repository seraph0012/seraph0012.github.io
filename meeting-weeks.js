import { requireAuth } from "./shared/authGuard.js";
import { renderNav } from "./shared/nav.js";
import { listMeetingWeeks, bulkUpsertMeetingWeeks, upsertMeetingWeek, deleteMeetingWeek } from "./shared/db.js";

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

    if (meetingDate.getUTCFullYear() === year) {
      const monthKey = meetingDate.getUTCMonth();
      monthCounters[monthKey] = (monthCounters[monthKey] || 0) + 1;
      rows.push({
        natural_week_start: toISODate(weekStart),
        meeting_date: toISODate(meetingDate),
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

async function loadTable() {
  const rows = await listMeetingWeeks();
  const tbody = document.getElementById("weeks-tbody");
  tbody.innerHTML = "";
  for (const row of rows) {
    tbody.appendChild(renderRow(row));
  }
}

function renderRow(row) {
  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td>${row.natural_week_start}</td>
    <td><input type="date" class="f-meeting-date" value="${row.meeting_date}" /></td>
    <td>${row.calendar_month.slice(0, 7)}</td>
    <td><input type="number" class="f-week-index" value="${row.week_index_in_month}" min="1" style="width:4em" /></td>
    <td><input type="checkbox" class="f-is-normal" ${row.is_normal ? "checked" : ""} /></td>
    <td><input type="text" class="f-notes" value="${row.notes ?? ""}" placeholder="节假日调休说明等" /></td>
    <td><button type="button" class="secondary f-save">保存</button></td>
    <td><button type="button" class="secondary f-delete">删除</button></td>
  `;
  tr.querySelector(".f-save").addEventListener("click", async () => {
    const patch = {
      natural_week_start: row.natural_week_start,
      meeting_date: tr.querySelector(".f-meeting-date").value,
      calendar_month: row.calendar_month,
      week_index_in_month: Number(tr.querySelector(".f-week-index").value),
      is_normal: tr.querySelector(".f-is-normal").checked,
      notes: tr.querySelector(".f-notes").value || null,
    };
    await upsertMeetingWeek(patch);
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
