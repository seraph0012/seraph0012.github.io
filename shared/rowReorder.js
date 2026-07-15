// 通用的"上移/下移"一行：给定tbody里的<tr data-entry-id data-sort-order>，跟相邻行交换
// sort_order(写库)+DOM位置(本地立即生效，不用整表reload)。planSection.js的"本周计划"表格
// 和summarySection.js的"总结条目"表格共用同一套swap逻辑，两边行内字段/锁定状态各不相同，
// 跟这个函数完全无关(2026-07-15新增，见sql/0021_task_entry_sort_order.sql)。
import { updateWeeklyTaskEntry } from "./db.js";

export async function moveRow(tr, direction) {
  const sibling = direction === "up" ? tr.previousElementSibling : tr.nextElementSibling;
  if (!sibling || !sibling.dataset.entryId) return;

  const entryId = Number(tr.dataset.entryId);
  const siblingId = Number(sibling.dataset.entryId);
  const order = Number(tr.dataset.sortOrder);
  const siblingOrder = Number(sibling.dataset.sortOrder);

  await Promise.all([
    updateWeeklyTaskEntry(entryId, { sort_order: siblingOrder }),
    updateWeeklyTaskEntry(siblingId, { sort_order: order }),
  ]);
  tr.dataset.sortOrder = String(siblingOrder);
  sibling.dataset.sortOrder = String(order);

  if (direction === "up") {
    tr.parentElement.insertBefore(tr, sibling);
  } else {
    tr.parentElement.insertBefore(sibling, tr);
  }
}
