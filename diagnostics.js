import { supabase } from "./shared/supabaseClient.js";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";
import { listMeetingWeeks } from "./shared/db.js";
import { snapshotWeekDetail } from "./shared/taskLabels.js";
import { renderNav } from "./shared/nav.js";

renderNav();

const configStatusEl = document.getElementById("config-status");
const dbResultEl = document.getElementById("db-result");
const dbTestBtn = document.getElementById("db-test-btn");
const authStatusEl = document.getElementById("auth-status");
const magicLinkForm = document.getElementById("magic-link-form");
const magicLinkResultEl = document.getElementById("magic-link-result");
const signOutBtn = document.getElementById("sign-out-btn");
const backfillBtn = document.getElementById("backfill-snapshot-btn");
const backfillResultEl = document.getElementById("backfill-result");

function reportConfigStatus() {
  if (SUPABASE_URL.includes("YOUR_PROJECT_REF") || SUPABASE_ANON_KEY.includes("YOUR_ANON_PUBLIC_KEY")) {
    configStatusEl.textContent = "config.js 还是占位符，请先填入你的 Supabase Project URL 和 anon key";
    configStatusEl.className = "status warn";
    return false;
  }
  configStatusEl.textContent = `已读取配置：${SUPABASE_URL}`;
  configStatusEl.className = "status ok";
  return true;
}

async function testDbConnection() {
  dbResultEl.textContent = "查询中...";
  const { data, error } = await supabase.from("connection_test").select("*").limit(5);
  if (error) {
    dbResultEl.textContent = `失败：${error.message}`;
    dbResultEl.className = "status error";
    return;
  }
  dbResultEl.textContent = `成功，读到 ${data.length} 行：${JSON.stringify(data)}`;
  dbResultEl.className = "status ok";
}

async function refreshAuthStatus() {
  const { data: { session } } = await supabase.auth.getSession();
  if (session) {
    authStatusEl.textContent = `已登录：${session.user.email}`;
    authStatusEl.className = "status ok";
    signOutBtn.hidden = false;
  } else {
    authStatusEl.textContent = "未登录";
    authStatusEl.className = "status warn";
    signOutBtn.hidden = true;
  }
}

async function sendMagicLink(email) {
  magicLinkResultEl.textContent = "发送中...";
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.href },
  });
  if (error) {
    magicLinkResultEl.textContent = `失败：${error.message}`;
    magicLinkResultEl.className = "status error";
    return;
  }
  magicLinkResultEl.textContent = "登录链接已发送，请查收邮箱并点击链接（会跳转回本页面）";
  magicLinkResultEl.className = "status ok";
}

// 一次性维护操作：用当前任务的live状态回填已锁定历史周的快照字段(2026-07-31新增，
// 见tools/.claude/plans/plan-locked-week-ppt-snapshot.md)——复用跟正常"锁定"时完全同一份
// snapshotWeekDetail实现，不写第二份逻辑。幂等，可以放心重复点。
async function backfillSnapshots() {
  if (!confirm("将对所有已锁定的历史周，用当前任务状态回填快照字段。确定继续？")) return;
  backfillResultEl.textContent = "处理中...";
  backfillResultEl.className = "status";
  try {
    const weeks = await listMeetingWeeks();
    let planWeeks = 0;
    let summaryWeeks = 0;
    for (const w of weeks) {
      if (w.plan_locked_at) {
        await snapshotWeekDetail(w.id, "plan");
        await snapshotWeekDetail(w.id, "stopped");
        planWeeks++;
      }
      if (w.summary_locked_at) {
        await snapshotWeekDetail(w.id, "summary");
        summaryWeeks++;
      }
    }
    backfillResultEl.textContent = `完成：已回填 ${planWeeks} 个已锁定计划周（含未启动/中止）、${summaryWeeks} 个已锁定总结周`;
    backfillResultEl.className = "status ok";
  } catch (err) {
    backfillResultEl.textContent = `失败：${err.message}`;
    backfillResultEl.className = "status error";
  }
}
backfillBtn.addEventListener("click", backfillSnapshots);

dbTestBtn.addEventListener("click", testDbConnection);

magicLinkForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const email = new FormData(magicLinkForm).get("email");
  sendMagicLink(email);
});

signOutBtn.addEventListener("click", async () => {
  await supabase.auth.signOut();
  refreshAuthStatus();
});

supabase.auth.onAuthStateChange(() => refreshAuthStatus());

reportConfigStatus();
refreshAuthStatus();
