import { requireAuth } from "./shared/authGuard.js";
import { renderNav } from "./shared/nav.js";
import { listPeople, createPerson, deletePerson } from "./shared/db.js";

const session = await requireAuth();
if (!session) {
  throw new Error("not authenticated");
}
renderNav();

async function loadTable() {
  const rows = await listPeople();
  const tbody = document.getElementById("people-tbody");
  tbody.innerHTML = "";
  for (const row of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${row.name}</td><td><button type="button" class="secondary f-delete">删除</button></td>`;
    tr.querySelector(".f-delete").addEventListener("click", async () => {
      if (!confirm(`确认删除责任人"${row.name}"？`)) return;
      await deletePerson(row.id);
      await loadTable();
    });
    tbody.appendChild(tr);
  }
}

document.getElementById("create-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const resultEl = document.getElementById("create-result");
  const name = new FormData(e.target).get("name");
  try {
    await createPerson(name);
    e.target.reset();
    resultEl.textContent = "";
    await loadTable();
  } catch (err) {
    resultEl.textContent = `失败：${err.message}`;
    resultEl.className = "status error";
  }
});

loadTable();
