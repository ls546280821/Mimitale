<script setup lang="ts">
/**
 * 操作日志 —— 只读页。
 *
 * 用途就一个：**出事能查**。
 * 「这号是谁封的？什么时候？为什么？」—— 这里能回答。
 *
 * ⚠️ 日志由后端在动作发生时写入，前端只有"查"的权限。
 *    如果日志靠前端上报，那它记录的就只是前端愿意上报的部分，出事时一文不值。
 */
import { onMounted, reactive, ref } from 'vue'
import { Refresh, Search } from '@element-plus/icons-vue'
import { fetchLogs } from '@/api/log'
import { LOG_ACTION_LABEL, LOG_ACTION_OPTIONS, LOG_ACTION_TAG, formatTime } from '@/config/labels'
import type { LogAction, OperationLog } from '@/types'

const loading = ref(false)
const rows = ref<OperationLog[]>([])
const total = ref(0)

/** el-date-picker 的 daterange 给的是 ['YYYY-MM-DD','YYYY-MM-DD'] | null */
const range = ref<[string, string] | null>(null)

const query = reactive({
  page: 1,
  pageSize: 20,
  action: '' as LogAction | '',
  keyword: ''
})

async function load(): Promise<void> {
  loading.value = true
  try {
    const res = await fetchLogs({
      page: query.page,
      pageSize: query.pageSize,
      action: query.action,
      keyword: query.keyword,
      from: range.value?.[0] ?? '',
      to: range.value?.[1] ?? ''
    })
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
  query.action = ''
  range.value = null
  query.page = 1
  load()
}

onMounted(load)
</script>

<template>
  <div class="page">
    <el-alert type="info" :closable="false" class="tip">
      <template #title>
        日志由后端在动作发生时自动写入，只有「查」没有「改」——
        封禁、改额度、生成或作废卡密、改动字典，都会在这里留下一条。
      </template>
    </el-alert>

    <el-card shadow="never" class="panel">
      <div class="toolbar">
        <el-select v-model="query.action" class="action" placeholder="全部动作" clearable @change="search">
          <el-option v-for="a in LOG_ACTION_OPTIONS" :key="a" :label="LOG_ACTION_LABEL[a]" :value="a" />
        </el-select>
        <el-input
          v-model="query.keyword"
          class="search"
          placeholder="搜对象或详情"
          :prefix-icon="Search"
          clearable
          @keyup.enter="search"
          @clear="search"
        />
        <el-date-picker
          v-model="range"
          class="range"
          type="daterange"
          value-format="YYYY-MM-DD"
          range-separator="至"
          start-placeholder="开始日期"
          end-placeholder="结束日期"
          unlink-panels
          @change="search"
        />
        <el-button type="primary" @click="search">查询</el-button>
        <el-button @click="reset">重置</el-button>
        <div class="spacer" />
        <el-button :icon="Refresh" @click="load">刷新</el-button>
      </div>
    </el-card>

    <el-card shadow="never" class="panel">
      <el-table v-loading="loading" :data="rows" stripe>
        <el-table-column label="时间" width="150">
          <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="操作人" width="96">
          <template #default="{ row }">{{ row.adminName }}</template>
        </el-table-column>
        <el-table-column label="动作" width="112">
          <template #default="{ row }">
            <el-tag :type="LOG_ACTION_TAG[row.action as LogAction]" size="small" disable-transitions>
              {{ LOG_ACTION_LABEL[row.action as LogAction] }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="对象" min-width="160" show-overflow-tooltip>
          <template #default="{ row }">
            <span class="target">{{ row.targetName }}</span>
            <span class="kind">{{ row.targetType }}</span>
          </template>
        </el-table-column>
        <el-table-column label="详情" min-width="220" show-overflow-tooltip>
          <template #default="{ row }">{{ row.detail }}</template>
        </el-table-column>
        <el-table-column prop="ip" label="IP" width="126">
          <template #default="{ row }">
            <span class="mono">{{ row.ip }}</span>
          </template>
        </el-table-column>
      </el-table>

      <div class="pager">
        <el-pagination
          v-model:current-page="query.page"
          v-model:page-size="query.pageSize"
          :total="total"
          :page-sizes="[20, 50, 100]"
          layout="total, sizes, prev, pager, next"
          @current-change="load"
          @size-change="search"
        />
      </div>
    </el-card>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.tip :deep(.el-alert__title) {
  font-size: 12.5px;
  line-height: 1.6;
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

.action {
  width: 148px;
}

.search {
  width: 208px;
}

.range {
  width: 250px;
}

.spacer {
  flex: 1;
}

.target {
  font-size: 13px;
}

.kind {
  margin-left: 7px;
  font-size: 11px;
  color: var(--text-sub);
  background: #f1efe8;
  border-radius: 4px;
  padding: 1px 5px;
}

.mono {
  font-family: var(--font-mono);
  font-size: 12px;
}

.pager {
  display: flex;
  justify-content: flex-end;
  margin-top: 14px;
}
</style>
