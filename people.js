import { requireAuth } from "./shared/authGuard.js";
import { renderNav } from "./shared/nav.js";
import { listPeople, createPerson, deletePerson } from "./shared/db.js";
import { cacheFirst } from "./shared/localCache.js";

const session = await requireAuth();
if (!session) {
  throw new Error("not authenticated");
}
renderNav();

function renderTable(rows) {
  const tbody = document.getElementById("people-tbody");
  tbody.innerHTML = "";
  for (const row of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${row.name}</td><td><button type="button" class="secondary f-delete">删除</button></td>`;
    tr.querySelector(".f-delete").addEventListener("click", async () => {
      if (!confirm(`确认删除责任人"${row.name}"？`)) return;
      await deletePerson(row.id);
      await loadTable(false);
    });
    tbody.appendChild(tr);
  }
}

// 同modules.js的cache-first模式，见那边的注释
async function loadTable(useCache = true) {
  const { cached, freshPromise } = cacheFirst("people", listPeople);
  if (useCache && cached) {
    renderTable(cached);
  } else {
    document.getElementById("people-tbody").innerHTML = `<tr><td colspan="2">加载中...</td></tr>`;
  }
  renderTable(await freshPromise);
}

document.getElementById("create-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const resultEl = document.getElementById("create-result");
  const name = new FormData(e.target).get("name");
  try {
    await createPerson(name);
    e.target.reset();
    resultEl.textContent = "";
    await loadTable(false);
  } catch (err) {
    resultEl.textContent = `失败：${err.message}`;
    resultEl.className = "status error";
  }
});

loadTable();
