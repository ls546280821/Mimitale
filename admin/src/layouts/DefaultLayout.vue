<script setup lang="ts">
/**
 * 后台外壳：左侧菜单 + 顶栏。
 *
 * 菜单**不再硬编码**，而是从 src/config/menu.ts 的数组渲染 ——
 * 加页面只改那个数组一处（路由表还是要单独加，那是 vue-router 的事）。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { SwitchButton, UserFilled } from '@element-plus/icons-vue'
import { useAuthStore } from '@/stores/auth'
import { useDictStore } from '@/stores/dict'
import { MENU } from '@/config/menu'
import { USE_MOCK } from '@/api/request'

const auth = useAuthStore()
const dict = useDictStore()
const route = useRoute()
const router = useRouter()

/**
 * ⚠️ `.main` 是 overflow:auto 的滚动容器，它**不会**在换页面时重置滚动位置 ——
 * 从一个长列表切到另一个页面，会停在半截。所以手动把滚动条拉回顶部。
 */
const mainRef = ref<{ $el?: HTMLElement } | null>(null)

watch(
  () => route.fullPath,
  () => {
    const el = mainRef.value?.$el
    if (el) el.scrollTop = 0
  }
)

/**
 * 高亮哪一项。
 * 详情页（/customers/3）要让它爸（/customers）亮起来，所以不能直接拿 route.path。
 */
const activeMenu = computed(() => {
  const parent = route.meta.parent as string | undefined
  return parent ?? route.path
})

/** 面包屑：只有二级页面才显示「父页 / 当前页」 */
const breadcrumb = computed(() => {
  const parentPath = route.meta.parent as string | undefined
  if (!parentPath) return null
  for (const group of MENU) {
    const hit = group.items.find((i) => i.path === parentPath)
    if (hit) return { title: hit.title, path: hit.path }
  }
  return null
})

const pageTitle = computed(() => (route.meta.title as string | undefined) ?? '')

onMounted(async () => {
  if (!auth.admin) {
    try {
      await auth.loadMe()
    } catch {
      // token 失效的话 request 层已经跳登录页了，这里不用管
    }
  }
  // 字典进后台拉一次就够 —— 封禁原因、额度预设这些下拉都靠它
  try {
    await dict.load()
  } catch {
    // 字典拉不到不阻塞使用，下拉会是空的
  }
})

async function handleLogout(): Promise<void> {
  try {
    await ElMessageBox.confirm('确定要退出登录吗？', '提示', {
      confirmButtonText: '退出',
      cancelButtonText: '再想想',
      type: 'warning'
    })
  } catch {
    return
  }
  await auth.logout()
  ElMessage.success('已退出登录')
  router.push({ name: 'login' })
}
</script>

<template>
  <el-container class="layout">
    <el-aside width="216px" class="aside">
      <div class="brand">
        <div class="brand-mark">M</div>
        <div>
          <div class="brand-name">Mimitale</div>
          <div class="brand-sub">客户管理后台</div>
        </div>
      </div>

      <el-menu :default-active="activeMenu" router class="menu">
        <el-menu-item-group v-for="group in MENU" :key="group.title" :title="group.title">
          <el-menu-item v-for="item in group.items" :key="item.path" :index="item.path">
            <el-icon><component :is="item.icon" /></el-icon>
            <span>{{ item.title }}</span>
          </el-menu-item>
        </el-menu-item-group>
      </el-menu>

      <div v-if="USE_MOCK" class="mock-badge">
        <span class="dot" />
        Mock 模式，数据是假的
      </div>
    </el-aside>

    <el-container>
      <el-header class="header" height="58px">
        <div class="crumbs">
          <template v-if="breadcrumb">
            <router-link class="crumb-link" :to="breadcrumb.path">{{ breadcrumb.title }}</router-link>
            <span class="crumb-sep">/</span>
          </template>
          <span class="page-title">{{ pageTitle }}</span>
        </div>
        <div class="header-right">
          <span class="who">
            <el-icon class="who-icon"><UserFilled /></el-icon>
            {{ auth.displayName }}
          </span>
          <el-button text :icon="SwitchButton" @click="handleLogout">退出</el-button>
        </div>
      </el-header>

      <el-main ref="mainRef" class="main">
        <router-view />
      </el-main>
    </el-container>
  </el-container>
</template>

<style scoped>
.layout {
  height: 100%;
}

.aside {
  display: flex;
  flex-direction: column;
  background: #ffffff;
  border-right: 1px solid var(--line);
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 18px 18px 14px;
}

.brand-mark {
  width: 34px;
  height: 34px;
  border-radius: 9px;
  background: #534ab7;
  color: #fff;
  font-weight: 500;
  font-size: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex: none;
}

.brand-name {
  font-weight: 500;
  line-height: 1.3;
}

.brand-sub {
  font-size: 12px;
  color: var(--text-sub);
  line-height: 1.3;
}

.menu {
  border-right: none;
  flex: 1;
  overflow-y: auto;
}

.menu :deep(.el-menu-item-group__title) {
  padding: 14px 18px 6px;
  font-size: 11px;
  letter-spacing: 0.4px;
  color: var(--text-sub);
}

.menu :deep(.el-menu-item) {
  height: 42px;
  line-height: 42px;
  margin: 0 8px 2px;
  border-radius: 8px;
}

/* Element Plus 默认只用文字变色表示选中，一眼看去不够清楚 —— 补个浅底 */
.menu :deep(.el-menu-item.is-active) {
  background: #eeedfe;
  color: #3c3489;
  font-weight: 500;
}

.menu :deep(.el-menu-item.is-active .el-icon) {
  color: #534ab7;
}

.mock-badge {
  margin: 12px;
  padding: 9px 11px;
  border-radius: 8px;
  background: #faeeda;
  color: #854f0b;
  font-size: 12px;
  display: flex;
  align-items: center;
  gap: 7px;
}

.mock-badge .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #ef9f27;
  flex: none;
}

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: #ffffff;
  border-bottom: 1px solid var(--line);
}

.crumbs {
  display: flex;
  align-items: center;
  gap: 8px;
}

.crumb-link {
  color: var(--text-sub);
  font-size: 13px;
  text-decoration: none;
}

.crumb-link:hover {
  color: #534ab7;
}

.crumb-sep {
  color: #d3d1c7;
  font-size: 13px;
}

.page-title {
  font-weight: 500;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 10px;
}

.who {
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--text-sub);
  font-size: 13px;
}

.who-icon {
  font-size: 14px;
}

.main {
  padding: 18px;
  overflow: auto;
}
</style>
