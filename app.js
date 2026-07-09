import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const configStatusEl = document.getElementById("config-status");
const dbResultEl = document.getElementById("db-result");
const dbTestBtn = document.getElementById("db-test-btn");
const authStatusEl = document.getElementById("auth-status");
const magicLinkForm = document.getElementById("magic-link-form");
const magicLinkResultEl = document.getElementById("magic-link-result");
const signOutBtn = document.getElementById("sign-out-btn");

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
