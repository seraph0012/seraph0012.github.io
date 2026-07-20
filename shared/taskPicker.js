// 通用"任务选择"组件：1/2/3级编号级联下拉(仿tasks.js新建任务表单的选择逻辑) + 按编号/
// 标题文字搜索兜底，两种方式选出同一类候选(candidates)里的一条。summarySection.js
// ("记录计划外完成的任务")、planSection.js("手动搜索添加任务")共用。
// 2026-07-14用户反馈重新设计：原来只有文字搜索，"编号应该可以像新建任务表单那样从下拉列表
// 逐级选择，而不是所有信息都靠打字筛选"——搜索框继续保留作为补充，两种方式都能触发onPick。
//
// candidates: [{task_id, project_id, project_level1_number, project_title, project_type,
//   wbs_level2_number, wbs_level3_number, label, ...}]，来自taskLabels.js的
// taskCandidateFields()/listAllActiveCandidates()，label需已包含编号+标题供搜索匹配。
// onPick(candidate): 选中/点击某条候选时触发，选完由调用方决定是否需要清空/重渲染。
const MAX_SEARCH_RESULTS = 20;

// 按project_id分组，组内附带level1_number/title供下拉显示，按编号排序
function groupByProject(candidates) {
  const byProject = new Map();
  for (const c of candidates) {
    if (!byProject.has(c.project_id)) {
      byProject.set(c.project_id, { level1_number: c.project_level1_number, title: c.project_title, items: [] });
    }
    byProject.get(c.project_id).items.push(c);
  }
  return [...byProject.entries()].sort((a, b) => a[1].level1_number - b[1].level1_number);
}

export function renderTaskPicker(container, candidates, onPick) {
  container.innerHTML = `
    <div class="cascade-picker inline-form">
      <label>1级 <select class="picker-level1"><option value="">(选择项目)</option></select></label>
      <label class="picker-level2-wrap" hidden>2级 <select class="picker-level2"></select></label>
      <label class="picker-level3-wrap" hidden>3级 <select class="picker-level3"></select></label>
      <button type="button" class="picker-cascade-add" disabled>添加此任务</button>
    </div>
    <p class="picker-preview status"></p>
    <div class="picker-search-wrap" style="margin-top:6px;">
      <input type="text" class="picker-search" placeholder="或者按编号/标题搜索..." style="min-width:320px" />
      <div class="picker-results"></div>
    </div>
  `;

  const grouped = groupByProject(candidates);
  const level1Select = container.querySelector(".picker-level1");
  const level2Select = container.querySelector(".picker-level2");
  const level3Select = container.querySelector(".picker-level3");
  const level2Wrap = container.querySelector(".picker-level2-wrap");
  const level3Wrap = container.querySelector(".picker-level3-wrap");
  const addBtn = container.querySelector(".picker-cascade-add");
  const previewEl = container.querySelector(".picker-preview");

  level1Select.innerHTML += grouped
    .map(([pid, p]) => `<option value="${pid}">[${p.level1_number}] ${p.title}</option>`)
    .join("");

  let selectedCandidate = null;

  // 2026-07-20用户反馈：级联选到只剩编号，看不出具体选中的是哪个任务——用candidates已经
  // 算好的label(可读的"来源类型 [编号] 项目名 / 任务名")直接展示，不用再查一次。
  function setSelected(c) {
    selectedCandidate = c || null;
    addBtn.disabled = !selectedCandidate;
    previewEl.textContent = selectedCandidate ? `将添加：${selectedCandidate.label}` : "";
  }

  // 二级下拉：如果这个项目下有一条"项目本身就是候选"(level2为空)，加一个"(项目本身)"选项；
  // 其余按level2编号列出。如果这个项目压根没有level2细分，直接确定候选，不用弹出二级选择。
  function refreshLevel2() {
    const pid = Number(level1Select.value);
    level2Wrap.hidden = true;
    level3Wrap.hidden = true;
    setSelected(null);
    if (!pid) return;
    const project = grouped.find(([id]) => id === pid)?.[1];
    if (!project) return;
    const direct = project.items.find((c) => c.wbs_level2_number == null);
    const level2Values = [...new Set(project.items.filter((c) => c.wbs_level2_number != null).map((c) => c.wbs_level2_number))].sort(
      (a, b) => a - b
    );
    if (level2Values.length === 0) {
      setSelected(direct || project.items[0] || null);
      return;
    }
    level2Wrap.hidden = false;
    level2Select.innerHTML =
      (direct ? `<option value="__direct__">(项目本身)</option>` : "") +
      level2Values.map((v) => `<option value="${v}">${v}</option>`).join("");
    refreshLevel3();
  }

  // 三级下拉：同样的逻辑，如果这个二级分组下没有再细分的三级候选，直接确定候选。
  function refreshLevel3() {
    const pid = Number(level1Select.value);
    const project = grouped.find(([id]) => id === pid)?.[1];
    level3Wrap.hidden = true;
    setSelected(null);
    if (!project) return;
    const val = level2Select.value;
    if (val === "__direct__") {
      setSelected(project.items.find((c) => c.wbs_level2_number == null) || null);
      return;
    }
    const level2Value = Number(val);
    const siblings = project.items.filter((c) => c.wbs_level2_number === level2Value);
    const level3Items = siblings.filter((c) => c.wbs_level3_number != null);
    if (level3Items.length === 0) {
      setSelected(siblings[0] || null);
      return;
    }
    level3Wrap.hidden = false;
    level3Items.sort((a, b) => a.wbs_level3_number - b.wbs_level3_number);
    level3Select.innerHTML = level3Items.map((c) => `<option value="${c.task_id}">${c.wbs_level3_number}</option>`).join("");
    setSelected(level3Items.find((c) => c.task_id === Number(level3Select.value)) || level3Items[0]);
  }

  level1Select.addEventListener("change", refreshLevel2);
  level2Select.addEventListener("change", refreshLevel3);
  level3Select.addEventListener("change", () => {
    setSelected(candidates.find((c) => c.task_id === Number(level3Select.value)) || null);
  });
  addBtn.addEventListener("click", () => {
    if (selectedCandidate) onPick(selectedCandidate);
  });

  // 文字搜索：保留作为级联选择之外的补充入口(2026-07-14用户明确要求两者都要有)
  const searchInput = container.querySelector(".picker-search");
  const resultsEl = container.querySelector(".picker-results");
  function renderSearch() {
    const q = searchInput.value.trim().toLowerCase();
    if (!q) {
      resultsEl.innerHTML = "";
      return;
    }
    const matches = candidates.filter((c) => c.label.toLowerCase().includes(q)).slice(0, MAX_SEARCH_RESULTS);
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
    if (matches.length === MAX_SEARCH_RESULTS) {
      const hint = document.createElement("p");
      hint.className = "status";
      hint.textContent = `只显示前${MAX_SEARCH_RESULTS}条匹配结果，输入更精确的关键词可以缩小范围`;
      resultsEl.appendChild(hint);
    }
  }
  searchInput.addEventListener("input", renderSearch);
}
