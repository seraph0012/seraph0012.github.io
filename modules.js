import { requireAuth } from "./shared/authGuard.js";
import { renderNav } from "./shared/nav.js";
import { listModules, createModule, deleteModule } from "./shared/db.js";
import { cacheFirst } from "./shared/localCache.js";

const session = await requireAuth();
if (!session) {
  throw new Error("not authenticated");
}
renderNav();

function renderTable(rows) {
  const tbody = document.getElementById("modules-tbody");
  tbody.innerHTML = "";
  for (const row of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${row.name}</td><td><button type="button" class="secondary f-delete">删除</button></td>`;
    tr.querySelector(".f-delete").addEventListener("click", async () => {
      if (!confirm(`确认删除模块"${row.name}"？`)) return;
      await deleteModule(row.id);
      await loadTable(false);
    });
    tbody.appendChild(tr);
  }
}

// useCache=true(默认，首次加载)：有本地缓存就立刻渲染，不用等网络，缓存来自上次访问时写入的
// wra_cache_v1:modules；useCache=false(增删改之后)：跳过陈旧缓存直接等这次请求的新数据，
// 避免"刚删除的模块又从缓存里闪回来"这种视觉跳变(2026-07-13减少页面卡顿感的整体改动一部分，
// 见tools/.claude/plans/plan-local-cache-loading-states.md)
async function loadTable(useCache = true) {
  const { cached, freshPromise } = cacheFirst("modules", listModules);
  if (useCache && cached) {
    renderTable(cached);
  } else {
    document.getElementById("modules-tbody").innerHTML = `<tr><td colspan="2">加载中...</td></tr>`;
  }
  renderTable(await freshPromise);
}

document.getElementById("create-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const resultEl = document.getElementById("create-result");
  const name = new FormData(e.target).get("name");
  try {
    await createModule(name);
    e.target.reset();
    resultEl.textContent = "";
    await loadTable(false);
  } catch (err) {
    resultEl.textContent = `失败：${err.message}`;
    resultEl.className = "status error";
  }
});

loadTable();
