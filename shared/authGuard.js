import { supabase } from "./supabaseClient.js";

// 每个受保护页面在自己的初始化逻辑最前面 await requireAuth()；
// 返回 null 时页面已经被替换成登录表单，调用方应直接 return，不再渲染业务内容。
export async function requireAuth() {
  const { data: { session } } = await supabase.auth.getSession();
  if (session) return session;
  renderLoginGate();
  return null;
}

function renderLoginGate() {
  document.body.innerHTML = `
    <main class="login-gate">
      <h1>需要登录</h1>
      <form id="login-gate-form">
        <input type="email" name="email" placeholder="你的邮箱" required />
        <button type="submit">发送登录链接</button>
      </form>
      <p id="login-gate-result" class="status"></p>
    </main>
  `;
  const form = document.getElementById("login-gate-form");
  const result = document.getElementById("login-gate-result");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = new FormData(form).get("email");
    result.textContent = "发送中...";
    result.className = "status";
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.href },
    });
    if (error) {
      result.textContent = `失败：${error.message}`;
      result.className = "status error";
      return;
    }
    result.textContent = "登录链接已发送，请查收邮箱并点击链接";
    result.className = "status ok";
  });
}
