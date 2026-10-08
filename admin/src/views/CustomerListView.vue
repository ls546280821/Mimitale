<script setup lang="ts">
/**
 * 客户管理 —— 后台的核心页面。
 * 这里列出的是在 Mimitale 客户端里注册使用的人（客户），不是本后台的登录账号。
 */
import { onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { Refresh, Search } from '@element-plus/icons-vue'
import { fetchCustomers } from '@/api/customer'
import { useDictStore } from '@/stores/dict'
import CustomerDialogs from '@/components/CustomerDialogs.vue'
import {
  CUSTOMER_STATUS_LABEL,
  CUSTOMER_STATUS_TAG,
  formatQuota,
  formatTime
} from '@/config/labels'
import type { Customer, CustomerStatus } from '@/types'

const router = useRouter()
const dict = useDictStore()
const dialogs = ref<InstanceType<typeof CustomerDialogs> | null>(null)

const loading = ref(false)
const rows = ref<Customer[]>([])
const total = ref(0)

const query = reactive({
  page: 1,
  pageSize: 10,
  keyword: '',
  status: '' as CustomerStatus | ''
})

async function load(): Promise<void> {
  loading.value = true
  try {
    const res = await fetchCustomers({ ...query })
    rows.value = res.list
    total.value = res.total
  } catch {
    // 错误提示已在 request 层统一处理
  } finally {
    loading.value = false
  }
}

function search(): void {
  query.page = 1
  load()
}

function reset(): void {
  query.keyword = ''
  query.status = ''
  query.page = 1
  load()
}

function openDetail(row: Customer): void {
  router.push({ name: 'customer-detail', params: { id: row.id } })
}

onMounted(load)
</script>

<template>
  <div class="page">
    <el-card shadow="never" class="panel">
      <div class="toolbar">
        <el-input
          v-model="query.keyword"
          class="search"
          placeholder="搜邮箱、昵称或邀请码"
          :prefix-icon="Search"
          clearable
          @keyup.enter="search"
          @clear="search"
        />
        <el-select v-model="query.status" class="status" @change="search">
          <el-option label="全部状态" value="" />
          <el-option :label="CUSTOMER_STATUS_LABEL.active" value="active" />
          <el-option :label="CUSTOMER_STATUS_LABEL.banned" value="banned" />
        </el-select>
        <el-button type="primary" @click="search">查询</el-button>
        <el-button @click="reset">重置</el-button>
        <div class="spacer" />
        <el-button :icon="Refresh" @click="load">刷新</el-button>
      </div>
    </el-card>

    <el-card shadow="never" class="panel">
      <el-table v-loading="loading" :data="rows" stripe @row-dblclick="openDetail">
        <el-table-column prop="id" label="ID" width="56" />
        <el-table-column prop="nickname" label="昵称" width="112" show-overflow-tooltip />
        <el-table-column prop="email" label="邮箱" min-width="180" show-overflow-tooltip />
        <el-table-column label="邀请码" width="150">
          <template #default="{ row }">
            <span v-if="row.inviteCode" class="mono">{{ row.inviteCode }}</span>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="120">
          <template #default="{ row }">
            <el-tag :type="CUSTOMER_STATUS_TAG[row.status as CustomerStatus]" size="small" disable-transitions>
              {{ CUSTOMER_STATUS_LABEL[row.status as CustomerStatus] }}
            </el-tag>
            <el-tooltip v-if="row.banReason" :content="dict.labelOf('ban_reason', row.banReason)" placement="top">
              <span class="reason">原因</span>
            </el-tooltip>
          </template>
        </el-table-column>
        <el-table-column label="额度" width="78">
          <template #default="{ row }">
            <span :class="{ exhausted: row.quota === 0 }">{{ formatQuota(row.quota) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="注册时间" width="138">
          <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="最后登录" width="138">
          <template #default="{ row }">{{ formatTime(row.lastLoginAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="178" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openDetail(row)">详情</el-button>
            <el-button link type="primary" @click="dialogs?.openQuota(row)">改额度</el-button>
            <el-button
              v-if="row.status === 'active'"
              link
              type="danger"
              @click="dialogs?.openBan(row)"
            >
              封禁
            </el-button>
            <el-button v-else link type="success" @click="dialogs?.submitUnban(row)">解封</el-button>
          </template>
        </el-table-column>
      </el-table>

      <div class="pager">
        <el-pagination
          v-model:current-page="query.page"
          v-model:page-size="query.pageSize"
          :total="total"
          :page-sizes="[10, 20, 50]"
          layout="total, sizes, prev, pager, next"
          @current-change="load"
          @size-change="search"
        />
      </div>
    </el-card>

    <CustomerDialogs ref="dialogs" @done="load" />
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.panel :deep(.el-card__body) {
  padding: 14px 16px;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.search {
  width: 258px;
}

.status {
  width: 130px;
}

.spacer {
  flex: 1;
}

.mono {
  font-family: var(--font-mono);
  font-size: 12px;
}

.muted {
  color: #b4b2a9;
}

.exhausted {
  color: #a32d2d;
}

.reason {
  margin-left: 6px;
  font-size: 11px;
  color: #854f0b;
  border-bottom: 1px dashed #ef9f27;
  cursor: help;
}

.pager {
  display: flex;
  justify-content: flex-end;
  margin-top: 14px;
}
</style>
