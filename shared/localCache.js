// cache-first + 后台revalidate的通用工具。整个项目目前没有任何本地缓存层，每次打开页面都会对
// Supabase发全新请求（哪怕是modules/people/meeting_weeks这种数据量小、改动很少的参考表），
// 是页面"每次打开都要卡几秒"的主因之一（2026-07-13用户实测反馈，见
// tools/.claude/plans/plan-local-cache-loading-states.md）。
//
// 只覆盖低频变动的小表（modules/people/meeting_weeks）——不缓存weekly_task_entries这类每周
// 都在变的数据，避免陈旧缓存影响这个工具本来要保证的"准确反映当前状态"。
const PREFIX = "wra_cache_v1:"; // 版本号前缀：以后改缓存数据结构时旧缓存自然当成不同key，不用手动清理迁移

export function readCache(key) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function writeCache(key, data) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(data));
  } catch {
    // 隐私模式/存储配额满时localStorage可能不可用，静默忽略——缓存只是优化，不是功能依赖
  }
}

// 立刻返回本地缓存(可能是null)，同时真的发起fetchFn()请求；请求成功后写回缓存。
// 调用方自己决定cached要不要拿去渲染——首次加载想cache-first(减少闪烁)，写操作后的重新加载
// 想跳过陈旧缓存直接等fresh数据(避免"删除的行先闪回来")，同一个函数覆盖两种场景。
export function cacheFirst(key, fetchFn) {
  const cached = readCache(key);
  const freshPromise = fetchFn().then((data) => {
    writeCache(key, data);
    return data;
  });
  return { cached, freshPromise };
}
