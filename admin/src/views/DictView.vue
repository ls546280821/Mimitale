<script setup lang="ts">
/**
 * 字典管理
 *
 * ============================================================
 * ⚠️ 这一页有一条**明确的边界**，先说清楚，别日后自己推翻：
 *
 *     只有「加一个新值不需要改代码」的枚举，才放字典。
 *
 *   放（真字典）        不放（假旋钮）
 *   ─────────────       ──────────────
 *   封禁原因            客户状态 active/banned
 *   客户来源            卡密状态 unused/used/void
 *   额度预设            管理员角色 super/normal
 *   卡密备注分类        操作日志的动作类型
 *
 *   为什么？因为**放进去的那些不会让程序变灵活**：
 *   后端写着 `if (status === 'banned')`，你在字典里加个第三态，
 *   界面上多出一个选得动、但点了什么都不会发生的选项 —— 假旋钮比没旋钮更糟。
 *
 *   而封禁原因不一样：运营明天想加一个「刷屏广告」，在这里加一条就完事，
 *   封禁弹层的下拉立刻会多出来，不用重新部署。
 * ============================================================
 *
 * 判断标准始终是那一条：**加一个新值，需不需要改代码？**
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus, Refresh } from '@element-plus/icons-vue'
import { createDictItem, createDictType, deleteDictItem, updateDictItem } from '@/api/dict'
import { useDictStore } from '@/stores/dict'
import { formatDay } from '@/config/labels'
import type { DictBundle, DictItem } from '@/types'

const dict = useDictStore()

const loading = ref(false)
const activeCode = ref('')

const bundles = computed(() => dict.bundles)
const active = computed<DictBundle | undefined>(() =>
  bundles.value.find((b) => b.type.code === activeCode.value)
)
const items = computed(() => (active.value ? dict.allItemsOf(active.value.type.code) : []))

async function reload(): Promise<void> {
  loading.value = true
  try {
    await dict.load(true)
    if (!activeCode.value && bundles.value.length) activeCode.value = bundles.value[0].type.code
    if (activeCode.value && !bundles.value.some((b) => b.type.code === activeCode.value)) {
      activeCode.value = bundles.value[0]?.type.code ?? ''
    }
  } catch {
    // 错误提示已在 request 层统一处理
  } finally {
    loading.value = false
  }
}

onMounted(reload)

/* ---------------- 数据项：新增 / 编辑 ---------------- */

const itemVisible = ref(false)
const editing = ref<DictItem | null>(null)
const itemForm = reactive({ label: '', value: '', sort: 100, remark: '' })

function openCreateItem(): void {
  editing.value = null
  itemForm.label = ''
  itemForm.value = ''
  itemForm.sort = (items.value.at(-1)?.sort ?? 0) + 10
  itemForm.remark = ''
  itemVisible.value = true
}

function openEditItem(row: DictItem): void {
  editing.value = row
  itemForm.label = row.label
  itemForm.value = row.value
  itemForm.sort = row.sort
  itemForm.remark = row.remark
  itemVisible.value = true
}

async function submitItem(): Promise<void> {
  const typeCode = active.value?.type.code
  if (!typeCode) return
  if (!itemForm.label.trim() || !itemForm.value.trim()) {
    ElMessage.warning('标签和值都要填')
    return
  }
  try {
    if (editing.value) {
      await updateDictItem(editing.value.id, {
        label: itemForm.label,
        value: itemForm.value,
        sort: Number(itemForm.sort),
        remark: itemForm.remark
      })
      ElMessage.success('已保存')
    } else {
      await createDictItem(typeCode, {
        label: itemForm.label,
        value: itemForm.value,
        sort: Number(itemForm.sort),
        remark: itemForm.remark
      })
      ElMessage.success('已新增')
    }
    itemVisible.value = false
    await reload()
  } catch {
    // 错误提示已在 request 层统一处理
  }
}

async function toggleEnabled(row: DictItem): Promise<void> {
  try {
    await updateDictItem(row.id, { enabled: !row.enabled })
    ElMessage.success(row.enabled ? '已停用' : '已启用')
    await reload()
  } catch {
    // 错误提示已在 request 层统一处理
  }
}

async function removeItem(row: DictItem): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `确定删除「${row.label}」吗？已经用了这个值的历史数据不会变，但以后选不到了。`,
      '提示',
      { confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning' }
    )
  } catch {
    return
  }
  try {
    await deleteDictItem(row.id)
    ElMessage.success('已删除')
    await reload()
  } catch {
    // 错误提示已在 request 层统一处理
  }
}

/* ---------------- 新建类型 ---------------- */

const typeVisible = ref(false)
const typeForm = reactive({ code: '', name: '', remark: '' })

function openCreateType(): void {
  typeForm.code = ''
  typeForm.name = ''
  typeForm.remark = ''
  typeVisible.value = true
}

async function submitType(): Promise<void> {
  if (!typeForm.code.trim() || !typeForm.name.trim()) {
    ElMessage.warning('编码和名称都要填')
    return
  }
  try {
    const created = await createDictType({
      code: typeForm.code.trim(),
      name: typeForm.name.trim(),
      remark: typeForm.remark
    })
    ElMessage.success('已新建')
    typeVisible.value = false
    await reload()
    activeCode.value = created.type.code
  } catch {
    // 错误提示已在 request 层统一处理
  }
}

/**
 * 界面上这些字典被谁用着 —— 写在页面上，是为了让人一眼明白
 * 「改这里不是改一个表格，是在改别人界面上的下拉框」。
 */
const USED_BY: Record<string, string> = {
  ban_reason: '封禁弹层的「封禁原因」下拉；客户详情里的封禁原因',
  customer_source: '客户列表的「来源」列；客户详情的「来源」',
  quota_preset: '改额度弹层里的快捷按钮',
  card_note: '生成卡密弹层里的「备注分类」下拉'
}
</script>

<template>
  <div class="page">
    <el-alert type="info" :closable="false" class="tip">
      <template #title>
        字典只用来放「加一条新值不需要改代码」的枚举（封禁原因、来源、额度预设、卡密备注）。
        客户状态、卡密状态、管理员角色这类**参与代码判断**的枚举不放这里 ——
        放进来了也加不出真正生效的值，只会变出一个「选得动但不发生什么」的假选项。
      </template>
    </el-alert>

    <div class="cols">
      <!-- 左：类型 -->
      <el-card shadow="never" class="panel side">
        <template #header>
          <div class="card-head">
            <span>字典类型</span>
            <el-button link type="primary" :icon="Plus" @click="openCreateType">新建</el-button>
          </div>
        </template>
        <div class="types">
          <div
            v-for="b in bundles"
            :key="b.type.code"
            class="type-row"
            :class="{ active: b.type.code === activeCode }"
            @click="activeCode = b.type.code"
          >
            <div class="type-main">
              <div class="type-name">{{ b.type.name }}</div>
              <div class="type-code">{{ b.type.code }}</div>
            </div>
            <span class="type-count">{{ b.items.length }}</span>
          </div>
          <el-empty v-if="!bundles.length" :image-size="60" description="还没有字典" />
        </div>
      </el-card>

      <!-- 右：数据项 -->
      <el-card shadow="never" class="panel main">
        <template #header>
          <div class="card-head">
            <div class="head-left">
              <span>{{ active ? active.type.name : '字典项' }}</span>
              <span v-if="active" class="head-code">{{ active.type.code }}</span>
            </div>
            <div class="head-right">
              <el-button :icon="Refresh" text @click="reload">刷新</el-button>
              <el-button type="primary" :icon="Plus" :disabled="!active" @click="openCreateItem">
                新增
              </el-button>
            </div>
          </div>
        </template>

        <template v-if="active">
          <div class="remark">{{ active.type.remark || '（没有说明）' }}</div>
          <div v-if="USED_BY[active.type.code]" class="used-by">
            用在：{{ USED_BY[active.type.code] }}
          </div>

          <el-table v-loading="loading" :data="items" stripe class="tbl">
            <el-table-column prop="label" label="标签" width="132" show-overflow-tooltip />
            <el-table-column label="值" width="128">
              <template #default="{ row }">
                <span class="mono">{{ row.value }}</span>
              </template>
            </el-table-column>
            <el-table-column prop="sort" label="排序" width="70" />
            <el-table-column label="启用" width="86">
              <template #default="{ row }">
                <el-switch
                  :model-value="row.enabled"
                  size="small"
                  @change="toggleEnabled(row)"
                />
              </template>
            </el-table-column>
            <el-table-column prop="remark" label="备注" min-width="180" show-overflow-tooltip>
              <template #default="{ row }">
                <span :class="{ muted: !row.remark }">{{ row.remark || '—' }}</span>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="112" fixed="right">
              <template #default="{ row }">
                <el-button link type="primary" @click="openEditItem(row)">编辑</el-button>
                <el-button link type="danger" @click="removeItem(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
        </template>
        <el-empty v-else :image-size="80" description="左边选一个字典类型" />

        <div v-if="active" class="foot">
          类型建于 {{ formatDay(active.type.createdAt) }} · 停用的项不会出现在下拉里，但历史数据照旧显示
        </div>
      </el-card>
    </div>

    <!-- 新增 / 编辑字典项 -->
    <el-dialog
      v-model="itemVisible"
      :title="editing ? '编辑字典项' : '新增字典项'"
      width="440px"
    >
      <div class="dlg-body">
        <div class="dlg-label">标签（显示给人看的）</div>
        <el-input v-model="itemForm.label" placeholder="例：刷屏广告" />
        <div class="dlg-label">值（存进数据库的）</div>
        <el-input v-model="itemForm.value" placeholder="例：spam" />
        <div class="dlg-label">排序（小的在前）</div>
        <el-input v-model.number="itemForm.sort" placeholder="100" />
        <div class="dlg-label">备注</div>
        <el-input v-model="itemForm.remark" placeholder="可留空" />
        <div v-if="editing" class="hint warn">
          改「值」要小心：已经用了旧值的历史数据不会跟着变。
        </div>
      </div>
      <template #footer>
        <el-button @click="itemVisible = false">取消</el-button>
        <el-button type="primary" @click="submitItem">保存</el-button>
      </template>
    </el-dialog>

    <!-- 新建类型 -->
    <el-dialog v-model="typeVisible" title="新建字典类型" width="440px">
      <div class="dlg-body">
        <div class="dlg-label">编码（表意，建后不建议改）</div>
        <el-input v-model="typeForm.code" placeholder="小写字母 / 数字 / 下划线，例：refund_reason" />
        <div class="dlg-label">名称</div>
        <el-input v-model="typeForm.name" placeholder="例：退款原因" />
        <div class="dlg-label">说明</div>
        <el-input v-model="typeForm.remark" placeholder="这个字典是给哪儿用的" />
        <div class="hint">
          新建只多了个容器。真要在界面上用起来，还得有代码去读它 ——
          如果你要加的是「客户状态」这种参与逻辑判断的枚举，别放这儿。
        </div>
      </div>
      <template #footer>
        <el-button @click="typeVisible = false">取消</el-button>
        <el-button type="primary" @click="submitType">创建</el-button>
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

.tip :deep(.el-alert__title) {
  font-size: 12.5px;
  line-height: 1.7;
}

.cols {
  display: grid;
  grid-template-columns: 268px minmax(0, 1fr);
  gap: 14px;
  align-items: start;
}

.panel :deep(.el-card__header) {
  padding: 12px 16px;
}

.panel :deep(.el-card__body) {
  padding: 12px 16px;
}

.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-weight: 500;
}

.head-left {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.head-code {
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 400;
  color: var(--text-sub);
}

.head-right {
  display: flex;
  align-items: center;
  gap: 6px;
}

.types {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.type-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 9px 11px;
  border-radius: 8px;
  cursor: pointer;
}

.type-row:hover {
  background: #f6f5f0;
}

.type-row.active {
  background: #eeedfe;
}

.type-name {
  font-size: 13px;
  line-height: 1.4;
}

.type-row.active .type-name {
  color: #3c3489;
  font-weight: 500;
}

.type-code {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-sub);
  line-height: 1.4;
}

.type-count {
  font-size: 11px;
  color: var(--text-sub);
  background: #ffffff;
  border-radius: 9px;
  padding: 1px 7px;
  flex: none;
}

.remark {
  font-size: 12.5px;
  color: var(--text-sub);
  line-height: 1.6;
}

.used-by {
  margin-top: 6px;
  font-size: 12px;
  color: #0f6e56;
  background: #e1f5ee;
  border-radius: 8px;
  padding: 7px 11px;
  line-height: 1.6;
}

.tbl {
  margin-top: 12px;
}

.foot {
  margin-top: 12px;
  font-size: 12px;
  color: var(--text-sub);
}

.mono {
  font-family: var(--font-mono);
  font-size: 12px;
}

.muted {
  color: #b4b2a9;
}

.dlg-body {
  display: flex;
  flex-direction: column;
  gap: 7px;
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
  margin-top: 6px;
}

.hint.warn {
  color: #854f0b;
  background: #faeeda;
  border-radius: 8px;
  padding: 9px 11px;
}
</style>
