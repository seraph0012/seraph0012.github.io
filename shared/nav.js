import { supabase } from "./supabaseClient.js";

// 2026-07-16：index.html不再是单独的导航landing page，改成weekly-report.html重命名后的
// 内容(制作周报直接是默认首页)，"首页"/"制作周报"合并成一条。
const LINKS = [
  { href: "index.html", label: "制作周报" },
  { href: "tasks.html", label: "任务管理" },
  { href: "bulk-import.html", label: "批量导入" },
  { href: "meeting-weeks.html", label: "例会日历" },
  { href: "settings.html", label: "设置" },
];

export function renderNav() {
  const container = document.getElementById("app-nav");
  if (!container) return;
  const current = window.location.pathname.split("/").pop() || "index.html";
  container.innerHTML =
    LINKS.map(
      (l) => `<a href="${l.href}" class="${l.href === current ? "active" : ""}">${l.label}</a>`
    ).join("") + `<button id="nav-sign-out" class="nav-sign-out">退出登录</button>`;

  document.getElementById("nav-sign-out").addEventListener("click", async () => {
    await supabase.auth.signOut();
    window.location.href = "index.html";
  });
}
