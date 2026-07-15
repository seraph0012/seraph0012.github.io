// 合并原modules.js+people.js(2026-07-16)，新增"设为当前"操作——is_current标记(见
// sql/0022_current_module_person.sql)取代此前"候选值只有一个时自动选中"的启发式，
// 是tasks.js新建任务表单/planSection.js候选池默认预填的权威来源。
import { requireAuth } from "./shared/authGuard.js";
import { renderNav } from "./shared/nav.js";
import {
  listModules,
  createModule,
  deleteModule,
  setCurrentModule,
  listPeople,
  createPerson,
  deletePerson,
  setCurrentPerson,
} from "./shared/db.js";
import { cacheFirst } from "./shared/localCache.js";

const session = await requireAuth();
if (!session) {
  throw new Error("not authenticated");
}
renderNav();

// modules/people结构完全一致(id/name/is_current)，用同一套渲染/加载逻辑跑两遍，
// 只是各自的CRUD函数+DOM id不同——用一个小工厂函数避免复制两份几乎一样的代码。
function setupSection({ cacheKey, listFn, createFn, deleteFn, setCurrentFn, tbodyId, formId, resultId, labelNoun }) {
  function renderTable(rows) {
    const tbody = document.getElementById(tbodyId);
    tbody.innerHTML = "";
    for (const row of rows) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${row.name}</td>
        <td>${row.is_current ? "★ 当前" : `<button type="button" class="secondary f-set-current">设为当前</button>`}</td>
        <td><button type="button" class="secondary f-delete">删除</button></td>
      `;
      if (!row.is_current) {
        tr.querySelector(".f-set-current").addEventListener("click", async () => {
          await setCurrentFn(row.id);
          await loadTable(false);
        });
      }
      tr.querySelector(".f-delete").addEventListener("click", async () => {
        if (!confirm(`确认删除${labelNoun}"${row.name}"？`)) return;
        await deleteFn(row.id);
        await loadTable(false);
      });
      tbody.appendChild(tr);
    }
  }

  // cache-first模式，同modules.js/people.js原来的写法：useCache=true(默认，首次加载)
  // 有本地缓存就立刻渲染；useCache=false(增删改之后)跳过陈旧缓存直接等新数据，避免
  // "刚删除/刚设为当前的行又从缓存里闪回来"。
  async function loadTable(useCache = true) {
    const { cached, freshPromise } = cacheFirst(cacheKey, listFn);
    if (useCache && cached) {
      renderTable(cached);
    } else {
      document.getElementById(tbodyId).innerHTML = `<tr><td colspan="3">加载中...</td></tr>`;
    }
    renderTable(await freshPromise);
  }

  document.getElementById(formId).addEventListener("submit", async (e) => {
    e.preventDefault();
    const resultEl = document.getElementById(resultId);
    const name = new FormData(e.target).get("name");
    try {
      await createFn(name);
      e.target.reset();
      resultEl.textContent = "";
      await loadTable(false);
    } catch (err) {
      resultEl.textContent = `失败：${err.message}`;
      resultEl.className = "status error";
    }
  });

  loadTable();
}

setupSection({
  cacheKey: "modules",
  listFn: listModules,
  createFn: createModule,
  deleteFn: deleteModule,
  setCurrentFn: setCurrentModule,
  tbodyId: "modules-tbody",
  formId: "module-create-form",
  resultId: "module-create-result",
  labelNoun: "模块",
});

setupSection({
  cacheKey: "people",
  listFn: listPeople,
  createFn: createPerson,
  deleteFn: deletePerson,
  setCurrentFn: setCurrentPerson,
  tbodyId: "people-tbody",
  formId: "person-create-form",
  resultId: "person-create-result",
  labelNoun: "责任人",
});
