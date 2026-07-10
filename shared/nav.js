import { supabase } from "./supabaseClient.js";

const LINKS = [
  { href: "index.html", label: "首页" },
  { href: "weekly-plan.html", label: "下周计划" },
  { href: "weekly-summary.html", label: "本周总结" },
  { href: "ppt-export.html", label: "生成本周PPT" },
  { href: "tasks.html", label: "任务管理" },
  { href: "meeting-weeks.html", label: "例会日历" },
  { href: "modules.html", label: "模块管理" },
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
