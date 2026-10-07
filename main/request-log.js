'use strict';

// ============================================================================
//  main/request-log.js —— 「这一轮到底发出去了什么」
//
//  为什么要有它：同一个模型，官方网页版和本应用的回复常常不一样。
//  原因几乎总在**请求不同**（那边有官方预置的系统提示词、我们只发最近 N 轮、
//  采样参数也是自己设的），而请求以前是看不见的 —— 只能靠猜。
//  这里把它原样留下来，界面上摊开一看就明白。
//
//  ⚠️ **只存内存**，最多 MAX_ENTRIES 条，进程退出就没了。刻意不落盘：
//   · 一次请求带着整段 system 提示词 + 最近几十条历史，几十 KB 起步。
//     落盘会让 userData 里多出一个越滚越大的文件，还要牵扯「读失败要不要守卫」。
//   · 它的用途是「刚才那条为什么这么答」的即时排查，不是长期档案。
//
//  记进来的是**最终 body**（由 main/http.js 在拼好之后回调过来），
//  所以看到的就是服务端实际收到的 JSON，而不是「大概是这么发的」。
// ============================================================================

/** 留最近多少次。20 条 × 几十 KB，内存占用可以忽略。 */
const MAX_ENTRIES = 20;

/** 新的排在前面（界面也是从新往旧看） */
const entries = [];

/**
 * 记一次请求。参数都由 http.js / ipc.js 给全，这里不做任何加工 ——
 * 加工的每一步都会让它离「服务端真正收到的」更远一点。
 */
function recordRequest({ requestId, providerName, url, body }) {
  entries.unshift({
    id: String(requestId || ''),
    at: Date.now(),
    providerName: String(providerName || ''),
    url: String(url || ''),
    body: body || null
  });
  if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;
  return entries[0];
}

/** 看一眼列表（从新到旧）。返回的是浅拷贝，调用方改不到里面的数组。 */
function listRequests() {
  return entries.slice();
}

function clearRequests() {
  entries.length = 0;
}

module.exports = { recordRequest, listRequests, clearRequests, MAX_ENTRIES };
