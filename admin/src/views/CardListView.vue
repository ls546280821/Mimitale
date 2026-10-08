<script setup lang="ts">
/**
 * 卡密 / 激活码管理
 *
 * 卡密就是客户注册时填的那个邀请码。这一页管三件事：
 *   ① 看：谁发的、谁用的、过期没
 *   ② 发：批量生成（一次最多 100 张，别手点 1000 次）
 *   ③ 收：把没用的作废掉
 *
 * 备注分类走字典 card_note —— 运营想加一个「双十一活动」不用改代码。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus, Refresh, Search } from '@element-plus/icons-vue'
import { createCards, fetchCards, voidCard } from '@/api/card'
import { useDictStore } from '@/stores/dict'
import { CARD_STATUS_LABEL, CARD_STATUS_TAG, formatTime } from '@/config/labels'
import type { CardStatus, InviteCard } from '@/types'

const dict = useDictStore()

const loading = ref(false)
const rows = ref<InviteCard[]>([])
const total = ref(0)

const query = reactive({
  page: 1,
  pageSize: 10,
  keyword: '',
  status: '' as CardStatus | ''
})

async function load(): Promise<void> {
  loading.value = true
  try {
    const res = await fetchCards({ ...query })
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

/* ---------------- 生成 ---------------- */

const genVisible = ref(false)
const generating = ref(false)
const genForm = reactive({
  count: 10,
  /** null = 永久有效 */
  expireDays: null as number | null,
  note: ''
})

/** 字典 card_note —— 备注分类的快捷选项 */
const noteOptions = computed(() => dict.optionsOf('card_note'))

const genHint = computed(() => {
  const n = Number(genForm.count)
  if (!Number.isFinite(n) || n < 1) return '至少 1 张'
  if (n > 100) return '一次最多 100 张'
  return `将生成 ${n} 张${
    genForm.expireDays === null ? '永久有效的' : `${genForm.expireDays} 天有效的`
  }卡密`
})

function openGenerate(): void {
  genForm.count = 10
  genForm.expireDays = null
  genForm.note = noteOptions.value[0]?.value ?? ''
  genVisible.value = true
}

/* 生成结果 */
const resultVisible = ref(false)
const createdCodes = ref<string[]>([])

async function submitGenerate(): Promise<void> {
  const count = Number(genForm.count)
  if (!Number.isFinite(count) || count < 1 || count > 100) {
    ElMessage.warning('数量要在 1 ~ 100 之间')
    return
  }
  generating.value = true
  try {
    const res = await createCards({
      count: Math.floor(count),
      expireDays: genForm.expireDays === null ? null : Number(genForm.expireDays),
      note: genForm.note
    })
    createdCodes.value = res.created.map((c) => c.code)
    genVisible.value = false
    resultVisible.value = true
    load()
  } catch {
    // 错误提示已在 request 层统一处理
  } finally {
    generating.value = false
  }
}

/* ---------------- 复制 ---------------- */

async function copy(text: string, tip = '已复制'): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    ElMessage.success(tip)
  } catch {
    ElMessage.warning('浏览器不让自动复制，手动选中吧')
  }
}

/* ---------------- 作废 ---------------- */

async function doVoid(row: InviteCard): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `确定作废卡密「${row.code}」吗？作废后不能再用，也不能恢复。`,
      '提示',
      { confirmButtonText: '作废', cancelButtonText: '取消', type: 'warning' }
    )
  } catch {
    return
  }
  try {
    await voidCard(row.id)
    ElMessage.success('已作废')
    load()
  } catch {
    // 错误提示已在 request 层统一处理
  }
}

/** 过期了但还没人用 —— 列表里标一下，方便批量作废 */
function isExpired(row: InviteCard): boolean {
  if (!row.expireAt || row.status !== 'unused') return false
  return Date.parse(row.expireAt) < Date.now()
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
          placeholder="搜卡密、使用者邮箱或备注"
          :prefix-icon="Search"
          clearable
          @keyup.enter="search"
          @clear="search"
        />
        <el-select v-model="query.status" class="status" @change="search">
          <el-option label="全部状态" value="" />
          <el-option :label="CARD_STATUS_LABEL.unused" value="unused" />
          <el-option :label="CARD_STATUS_LABEL.used" value="used" />
          <el-option :label="CARD_STATUS_LABEL.void" value="void" />
        </el-select>
        <el-button type="primary" @click="search">查询</el-button>
        <el-button @click="reset">重置</el-button>
        <div class="spacer" />
        <el-button :icon="Refresh" @click="load">刷新</el-button>
        <el-button type="primary" :icon="Plus" @click="openGenerate">生成卡密</el-button>
      </div>
    </el-card>

    <el-card shadow="never" class="panel">
      <el-table v-loading="loading" :data="rows" stripe>
        <el-table-column prop="id" label="ID" width="64" />
        <el-table-column label="卡密" width="188">
          <template #default="{ row }">
            <span class="mono">{{ row.code }}</span>
            <el-button link type="primary" class="copy" @click="copy(row.code)">复制</el-button>
          </template>
        </el-table-column>
        <el-table-column label="备注" width="110">
          <template #default="{ row }">{{ row.note }}</template>
        </el-table-column>
        <el-table-column label="状态" width="106">
          <template #default="{ row }">
            <el-tag :type="CARD_STATUS_TAG[row.status as CardStatus]" size="small" disable-transitions>
              {{ CARD_STATUS_LABEL[row.status as CardStatus] }}
            </el-tag>
            <el-tooltip v-if="isExpired(row)" content="已过有效期，但还没被使用" placement="top">
              <span class="expired">过期</span>
            </el-tooltip>
          </template>
        </el-table-column>
        <el-table-column label="使用者" min-width="186" show-overflow-tooltip>
          <template #default="{ row }">
            <span v-if="row.usedByEmail">{{ row.usedByEmail }}</span>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column label="生成时间" width="146">
          <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="有效期" width="146">
          <template #default="{ row }">
            <span v-if="row.expireAt" :class="{ expired: isExpired(row) }">{{ formatTime(row.expireAt) }}</span>
            <span v-else class="muted">永久</span>
          </template>
        </el-table-column>
        <el-table-column label="使用时间" width="146">
          <template #default="{ row }">{{ formatTime(row.usedAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="82" fixed="right">
          <template #default="{ row }">
            <el-button v-if="row.status === 'unused'" link type="danger" @click="doVoid(row)">作废</el-button>
            <span v-else class="muted">—</span>
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

    <!-- 批量生成 -->
    <el-dialog v-model="genVisible" title="生成卡密" width="460px">
      <div class="dlg-body">
        <div class="dlg-label">生成数量</div>
        <el-input v-model.number="genForm.count" placeholder="1 ~ 100" />
        <div class="dlg-label">有效期</div>
        <el-select v-model="genForm.expireDays" style="width: 100%">
          <el-option label="永久有效" :value="null" />
          <el-option label="30 天" :value="30" />
          <el-option label="90 天" :value="90" />
          <el-option label="180 天" :value="180" />
          <el-option label="365 天" :value="365" />
        </el-select>
        <div class="dlg-label">备注分类</div>
        <el-select v-model="genForm.note" placeholder="选一个分类" style="width: 100%">
          <el-option v-for="o in noteOptions" :key="o.value" :label="o.label" :value="o.label" />
        </el-select>
        <div class="hint">{{ genHint }}</div>
      </div>
      <template #footer>
        <el-button @click="genVisible = false">取消</el-button>
        <el-button type="primary" :loading="generating" @click="submitGenerate">生成</el-button>
      </template>
    </el-dialog>

    <!-- 生成结果 -->
    <el-dialog v-model="resultVisible" title="生成好了" width="460px">
      <div class="dlg-body">
        <div class="hint ok">
          共 {{ createdCodes.length }} 张，状态是「未使用」。发给客户让他们注册时填。
        </div>
        <div class="codes">
          <div v-for="code in createdCodes" :key="code" class="code-row">
            <span class="mono">{{ code }}</span>
            <el-button link type="primary" @click="copy(code)">复制</el-button>
          </div>
        </div>
      </div>
      <template #footer>
        <el-button @click="copy(createdCodes.join('\n'), `已复制 ${createdCodes.length} 张`)">
          复制全部
        </el-button>
        <el-button type="primary" @click="resultVisible = false">知道了</el-button>
      </template>
    </el-dialog>
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
  width: 248px;
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

.copy {
  margin-left: 7px;
  font-size: 11px;
}

.muted {
  color: #b4b2a9;
}

.expired {
  color: #a32d2d;
}

.expired::before {
  content: '';
}

.dlg-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.dlg-label {
  font-size: 12px;
  color: var(--text-sub);
  margin-top: 4px;
}

.hint {
  font-size: 12px;
  color: var(--text-sub);
  line-height: 1.6;
  margin-top: 4px;
}

.hint.ok {
  color: #0f6e56;
  background: #e1f5ee;
  border-radius: 8px;
  padding: 9px 11px;
  margin-top: 0;
}

.codes {
  max-height: 260px;
  overflow-y: auto;
  border: 1px solid var(--line);
  border-radius: 8px;
  margin-top: 6px;
}

.code-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 7px 11px;
  border-bottom: 1px solid var(--line);
}

.code-row:last-child {
  border-bottom: none;
}

.pager {
  display: flex;
  justify-content: flex-end;
  margin-top: 14px;
}
</style>
