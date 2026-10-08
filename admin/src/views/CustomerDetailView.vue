<script setup lang="ts">
/**
 * 客户详情页 —— 路由 /customers/:id
 *
 * 列表只能看个大概，这一页回答三个问题：
 *   ① 这个人是谁（邮箱、来源、邀请码、额度、最后一次上线）
 *   ② 他的邀请码是哪张卡发出去的
 *   ③ 我们对他做过什么（操作记录，时间线形式，最近的在最上面）
 *
 * ③ 的数据不是这一页自己攒的 —— 是后端在封禁 / 改额度时**顺手写进日志表**的，
 * 所以哪怕是从列表页操作的，这里也看得到。
 */
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ArrowLeft, Refresh } from '@element-plus/icons-vue'
import { fetchCustomerDetail } from '@/api/customer'
import { useDictStore } from '@/stores/dict'
import CustomerDialogs from '@/components/CustomerDialogs.vue'
import {
  CARD_STATUS_LABEL,
  CARD_STATUS_TAG,
  CUSTOMER_STATUS_LABEL,
  CUSTOMER_STATUS_TAG,
  LOG_ACTION_LABEL,
  LOG_ACTION_TAG,
  deriveCustomerSource,
  formatQuota,
  formatTime
} from '@/config/labels'
import type { CustomerDetail } from '@/types'

const route = useRoute()
const router = useRouter()
const dict = useDictStore()
const dialogs = ref<InstanceType<typeof CustomerDialogs> | null>(null)

const loading = ref(false)
const detail = ref<CustomerDetail | null>(null)
const notFound = ref(false)

const customerId = computed(() => Number(route.params.id))

async function load(): Promise<void> {
  loading.value = true
  notFound.value = false
  try {
    detail.value = await fetchCustomerDetail(customerId.value)
  } catch {
    notFound.value = true
    detail.value = null
  } finally {
    loading.value = false
  }
}

function goBack(): void {
  router.push({ name: 'customers' })
}

onMounted(load)
</script>

<template>
  <div v-loading="loading" class="page">
    <div class="head">
      <el-button :icon="ArrowLeft" text @click="goBack">返回客户列表</el-button>
      <div class="spacer" />
      <el-button :icon="Refresh" @click="load">刷新</el-button>
    </div>

    <el-empty v-if="notFound" description="客户不存在（可能已被删除）">
      <el-button type="primary" @click="goBack">回列表</el-button>
    </el-empty>

    <template v-else-if="detail">
      <el-card shadow="never" class="panel">
        <div class="top">
          <div class="who">
            <div class="avatar">{{ detail.nickname.slice(0, 1) }}</div>
            <div>
              <div class="name">
                {{ detail.nickname }}
                <el-tag
                  :type="CUSTOMER_STATUS_TAG[detail.status]"
                  size="small"
                  disable-transitions
                  class="status-tag"
                >
                  {{ CUSTOMER_STATUS_LABEL[detail.status] }}
                </el-tag>
              </div>
              <div class="mail">{{ detail.email }}</div>
            </div>
          </div>
          <div class="actions">
            <el-button @click="dialogs?.openQuota(detail)">改额度</el-button>
            <el-button v-if="detail.status === 'active'" type="danger" @click="dialogs?.openBan(detail)">
              封禁
            </el-button>
            <el-button v-else type="success" @click="dialogs?.submitUnban(detail)">解封</el-button>
          </div>
        </div>

        <el-descriptions :column="3" border class="desc">
          <el-descriptions-item label="客户 ID">{{ detail.id }}</el-descriptions-item>
          <el-descriptions-item label="来源">
            {{ dict.labelOf('customer_source', deriveCustomerSource(detail)) }}
          </el-descriptions-item>
          <el-descriptions-item label="剩余额度">
            <span :class="{ exhausted: detail.quota === 0 }">{{ formatQuota(detail.quota) }}</span>
          </el-descriptions-item>
          <el-descriptions-item label="注册时间">{{ formatTime(detail.createdAt) }}</el-descriptions-item>
          <el-descriptions-item label="最后登录">{{ formatTime(detail.lastLoginAt) }}</el-descriptions-item>
          <el-descriptions-item label="邀请码">
            <span v-if="detail.inviteCode" class="mono">{{ detail.inviteCode }}</span>
            <span v-else class="muted">没用（邮箱直注）</span>
          </el-descriptions-item>
          <el-descriptions-item v-if="detail.status === 'banned'" label="封禁原因" :span="3">
            <el-tag type="warning" size="small" disable-transitions>
              {{ dict.labelOf('ban_reason', detail.banReason) }}
            </el-tag>
          </el-descriptions-item>
        </el-descriptions>
      </el-card>

      <el-card shadow="never" class="panel">
        <template #header>
          <div class="card-head">
            <span>注册用的卡密</span>
          </div>
        </template>
        <el-descriptions v-if="detail.usedCard" :column="4" border>
          <el-descriptions-item label="卡密">
            <span class="mono">{{ detail.usedCard.code }}</span>
          </el-descriptions-item>
          <el-descriptions-item label="备注">{{ detail.usedCard.note }}</el-descriptions-item>
          <el-descriptions-item label="状态">
            <el-tag :type="CARD_STATUS_TAG[detail.usedCard.status]" size="small" disable-transitions>
              {{ CARD_STATUS_LABEL[detail.usedCard.status] }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="使用时间">
            {{ formatTime(detail.usedCard.usedAt) }}
          </el-descriptions-item>
        </el-descriptions>
        <el-empty v-else :image-size="60" description="这个客户是直接邮箱注册的，没用卡密" />
      </el-card>

      <el-card shadow="never" class="panel">
        <template #header>
          <div class="card-head">
            <span>操作记录</span>
            <span class="sub">共 {{ detail.logs.length }} 条 · 日志由后端写入，不可编辑</span>
          </div>
        </template>
        <el-timeline v-if="detail.logs.length" class="timeline">
          <el-timeline-item
            v-for="log in detail.logs"
            :key="log.id"
            :timestamp="formatTime(log.createdAt)"
            placement="top"
          >
            <div class="log-line">
              <el-tag :type="LOG_ACTION_TAG[log.action]" size="small" disable-transitions>
                {{ LOG_ACTION_LABEL[log.action] }}
              </el-tag>
              <span class="log-detail">{{ log.detail }}</span>
            </div>
            <div class="log-meta">操作人：{{ log.adminName }} · IP {{ log.ip }}</div>
          </el-timeline-item>
        </el-timeline>
        <el-empty v-else :image-size="60" description="还没有针对这个客户的操作" />
      </el-card>
    </template>

    <CustomerDialogs ref="dialogs" @done="load" />
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.head {
  display: flex;
  align-items: center;
}

.spacer {
  flex: 1;
}

.panel :deep(.el-card__body) {
  padding: 16px 18px;
}

.panel :deep(.el-card__header) {
  padding: 12px 18px;
}

.top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 18px;
}

.who {
  display: flex;
  align-items: center;
  gap: 12px;
}

.avatar {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: #eeedfe;
  color: #534ab7;
  font-size: 17px;
  font-weight: 500;
  display: flex;
  align-items: center;
  justify-content: center;
  flex: none;
}

.name {
  font-size: 15px;
  font-weight: 500;
  display: flex;
  align-items: center;
  gap: 8px;
}

.status-tag {
  font-weight: 400;
}

.mail {
  font-size: 12px;
  color: var(--text-sub);
  margin-top: 2px;
}

.actions {
  display: flex;
  gap: 8px;
}

.actions :deep(.el-button + .el-button) {
  margin-left: 0;
}

.desc :deep(.el-descriptions__label) {
  width: 92px;
  color: var(--text-sub);
}

.card-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  font-weight: 500;
}

.card-head .sub {
  font-size: 12px;
  font-weight: 400;
  color: var(--text-sub);
}

.timeline {
  padding-left: 2px;
}

.timeline :deep(.el-timeline-item__timestamp) {
  font-size: 12px;
  color: var(--text-sub);
}

.log-line {
  display: flex;
  align-items: center;
  gap: 9px;
}

.log-detail {
  font-size: 13px;
}

.log-meta {
  font-size: 12px;
  color: var(--text-sub);
  margin-top: 3px;
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
</style>
