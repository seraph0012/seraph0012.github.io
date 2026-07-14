// 通用"按编号/标题搜索任务并点击选中"组件。取代"把所有候选塞进一个<select>"的旧写法——
// 任务数据一多，下拉列表会长到没法用；这里改成搜索框实时过滤，永远只渲染匹配的前N条。
// summarySection.js("记录计划外完成的任务")、planSection.js("手动搜索添加任务")共用。
//
// candidates: [{..., label}]，label需已包含编号+标题(如"[1.2.3] 项目名 / 任务名")供搜索匹配。
// onPick(candidate): 点击某条结果时触发，选完由调用方决定是否需要清空/重渲染。
const MAX_RESULTS = 20;

export function renderTaskPicker(container, candidates, onPick) {
  container.innerHTML = `
    <input type="text" class="picker-search" placeholder="按编号/标题搜索任务..." style="min-width:320px" />
    <div class="picker-results"></div>
  `;
  const input = container.querySelector(".picker-search");
  const resultsEl = container.querySelector(".picker-results");

  function render() {
    const q = input.value.trim().toLowerCase();
    if (!q) {
      resultsEl.innerHTML = `<p class="status">输入编号或标题关键词开始搜索（当前共 ${candidates.length} 个可选任务）</p>`;
      return;
    }
    const matches = candidates.filter((c) => c.label.toLowerCase().includes(q)).slice(0, MAX_RESULTS);
    if (matches.length === 0) {
      resultsEl.innerHTML = `<p class="status">没有匹配的任务</p>`;
      return;
    }
    resultsEl.innerHTML = "";
    const ul = document.createElement("ul");
    for (const c of matches) {
      const li = document.createElement("li");
      li.textContent = c.label;
      li.addEventListener("click", () => onPick(c));
      ul.appendChild(li);
    }
    resultsEl.appendChild(ul);
    if (matches.length === MAX_RESULTS) {
      const hint = document.createElement("p");
      hint.className = "status";
      hint.textContent = `只显示前${MAX_RESULTS}条匹配结果，输入更精确的关键词可以缩小范围`;
      resultsEl.appendChild(hint);
    }
  }
  input.addEventListener("input", render);
  render();
}
