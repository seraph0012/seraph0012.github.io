import { supabase } from "./supabaseClient.js";

const LINKS = [
  { href: "index.html", label: "首页" },
  { href: "weekly-report.html", label: "制作周报" },
  { href: "tasks.html", label: "任务管理" },
  { href: "bulk-import.html", label: "批量导入" },
  { href: "meeting-weeks.html", label: "例会日历" },
  { href: "modules.html", label: "模块管理" },
  { href: "people.html", label: "责任人管理" },
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
