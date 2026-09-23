'use strict';

// ============================================================================
//  views/refresh.js —— 刷新总线
//
//  为什么要它：以前每个功能改完数据都要喊一声 renderAll()，而 renderAll
//  挨个点名所有视图 —— 于是「记忆管理」和「聊天」、「角色列表」和「世界书」
//  互相依赖（体检出 19 对循环调用，其中 7 对源自这里）。
//
//  换成总线之后：谁想被重绘，就在自己模块里登记一次；要重绘的人只认识总线，
//  不认识任何视图。拆 views/ 的时候，循环 import 就不存在了。
//
//  调用顺序 = 登记顺序（Set 保序），所以「先会话列表、后消息」这种既有顺序
//  由登记的先后决定，改顺序就是改登记顺序。
// ============================================================================

const listeners = new Set();

/**
 * 登记一个「需要被重绘」的函数。opts 会原样传给它（比如 { forceScroll: true }）。
 * 返回注销函数 —— 拆模块、或者做局部替换时会用得上。
 */
export function onRefresh(fn) {
  if (typeof fn !== 'function') throw new TypeError('onRefresh 需要一个函数');
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 广播一次重绘 */
export function refreshAll(opts) {
  for (const fn of listeners) {
    try {
      fn(opts);
    } catch (err) {
      // 一个视图画挂了不该连累别的视图 —— 否则一处笔误整个界面就不刷新了
      console.error('刷新失败：', err);
    }
  }
}
