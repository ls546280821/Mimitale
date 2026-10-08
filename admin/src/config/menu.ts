/**
 * 侧边菜单 —— 配置数组驱动。
 *
 * 为什么抽出来：在此之前菜单是**硬编码在 DefaultLayout.vue 模板里**的，
 * 加一个页面要改两个地方（router 加路由 + 模板加一段标签），还容易忘一个。
 * 现在加页面只改这里一行。
 *
 * 将来如果要做「菜单管理」（后端下发菜单树、按角色显示不同菜单），
 * 只需要把这个数组的**数据源**换成 store / 接口，渲染部分一行都不用动。
 * 但注意：那意味着把前端路由表搬进数据库，是个框架级的改造，见决策记录。
 */

import type { Component } from 'vue'
import { Collection, Document, Ticket, UserFilled } from '@element-plus/icons-vue'

export interface MenuNode {
  /** 对应 router 里的 path */
  path: string
  title: string
  icon: Component
}

export interface MenuGroup {
  title: string
  items: MenuNode[]
}

export const MENU: MenuGroup[] = [
  {
    title: '客户运营',
    items: [
      { path: '/customers', title: '客户管理', icon: UserFilled },
      { path: '/cards', title: '卡密 / 激活码', icon: Ticket }
    ]
  },
  {
    title: '系统',
    items: [
      { path: '/logs', title: '操作日志', icon: Document },
      { path: '/dicts', title: '字典管理', icon: Collection }
    ]
  }
]
