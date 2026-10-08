import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router'
import { TOKEN_KEY } from '@/api/request'

/**
 * 用 hash 模式（URL 长这样：/admin/#/customers）。
 * 好处是部署时不用给 nginx 配 try_files —— 对后端不熟的情况能少踩一个坑。
 * 哪天想换成 history 模式，把 createWebHashHistory 换成 createWebHistory 即可，
 * 但记得让服务器把找不到的路径都回退到 index.html。
 *
 * ⚠️ 加页面要改两个地方：这里加一条路由 + src/config/menu.ts 加一个菜单项。
 *    菜单是配置数组驱动的（不再是硬编码模板），漏了第二处的话页面进不去。
 */
const routes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'login',
    component: () => import('@/views/LoginView.vue'),
    meta: { public: true, title: '登录' }
  },
  {
    path: '/',
    component: () => import('@/layouts/DefaultLayout.vue'),
    redirect: '/customers',
    children: [
      {
        path: 'customers',
        name: 'customers',
        component: () => import('@/views/CustomerListView.vue'),
        meta: { title: '客户管理' }
      },
      {
        // 详情页挂在列表下面，面包屑才好做
        path: 'customers/:id',
        name: 'customer-detail',
        component: () => import('@/views/CustomerDetailView.vue'),
        meta: { title: '客户详情', parent: '/customers' }
      },
      {
        path: 'cards',
        name: 'cards',
        component: () => import('@/views/CardListView.vue'),
        meta: { title: '卡密 / 激活码' }
      },
      {
        path: 'logs',
        name: 'logs',
        component: () => import('@/views/LogListView.vue'),
        meta: { title: '操作日志' }
      },
      {
        path: 'dicts',
        name: 'dicts',
        component: () => import('@/views/DictView.vue'),
        meta: { title: '字典管理' }
      }
    ]
  },
  { path: '/:pathMatch(.*)*', redirect: '/customers' }
]

const router = createRouter({
  history: createWebHashHistory(),
  routes
})

router.beforeEach((to) => {
  const hasToken = Boolean(localStorage.getItem(TOKEN_KEY))
  if (to.meta.public !== true && !hasToken) return { name: 'login' }
  if (to.name === 'login' && hasToken) return { name: 'customers' }
  return true
})

export default router
