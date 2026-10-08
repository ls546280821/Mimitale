<script setup lang="ts">
/**
 * 客户的两个操作弹层：改额度 / 封禁。
 *
 * 抽成组件是因为**列表页和详情页都要用** —— 抄两遍必然会走样
 * （改了一处忘另一处，是后台项目最常见的烂法）。
 *
 * 用法：父组件放 `<CustomerDialogs ref="dialogs" @done="load" />`，
 *      然后在按钮里调 `dialogs.value?.openQuota(row)`。
 *
 * 封禁原因和额度预设都来自**字典**，所以运营在字典页加一条，
 * 这里的下拉立刻多一个选项。
 */
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { updateCustomer } from '@/api/customer'
import { useDictStore } from '@/stores/dict'
import { formatQuota } from '@/config/labels'
import type { Customer } from '@/types'

const emit = defineEmits<{ done: [] }>()
const dict = useDictStore()

/* ---------------- 改额度 ---------------- */

const quotaVisible = ref(false)
const quotaTarget = ref<Customer | null>(null)
const quotaValue = ref(0)

/** 字典 quota_preset —— 快捷按钮，省得每次手打数字 */
const quotaPresets = computed(() => dict.optionsOf('quota_preset'))

const quotaHint = computed(() => {
  const n = Number(quotaValue.value)
  if (!Number.isFinite(n)) return '请填整数'
  if (n === -1) return '不限量'
  if (n === 0) return '能登录，但一次也用不了'
  if (n < 0) return '只有 -1 表示不限量，其它负数没有意义'
  return `还能用 ${n} 次`
})

function openQuota(row: Customer): void {
  quotaTarget.value = row
  quotaValue.value = row.quota
  quotaVisible.value = true
}

async function submitQuota(): Promise<void> {
  const target = quotaTarget.value
  if (!target) return
  const n = Number(quotaValue.value)
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    ElMessage.warning('额度要填整数')
    return
  }
  try {
    await updateCustomer(target.id, { quota: n })
    ElMessage.success(`「${target.nickname}」额度已改为 ${formatQuota(n)}`)
    quotaVisible.value = false
    emit('done')
  } catch {
    // 错误提示已在 request 层统一处理
  }
}

/* ---------------- 封禁 ---------------- */

const banVisible = ref(false)
const banTarget = ref<Customer | null>(null)
/** 从字典 ban_reason 里选的值 */
const banReason = ref('')
/** 选了「其他」时手填的内容 —— 它会直接作为原因存下来 */
const banCustom = ref('')

/** 字典 ban_reason —— 只有启用的会出现在这里 */
const banReasonOptions = computed(() => dict.optionsOf('ban_reason'))
const isOther = computed(() => banReason.value === 'other')

function openBan(row: Customer): void {
  banTarget.value = row
  banReason.value = ''
  banCustom.value = ''
  banVisible.value = true
}

async function submitBan(): Promise<void> {
  const target = banTarget.value
  if (!target) return

  let reason = banReason.value
  if (!reason) {
    ElMessage.warning('选一个封禁原因')
    return
  }
  if (isOther.value) {
    reason = banCustom.value.trim()
    if (!reason) {
      ElMessage.warning('选「其他」的话，请把原因写一下')
      return
    }
  }

  try {
    await updateCustomer(target.id, { status: 'banned', banReason: reason })
    ElMessage.success(`已封禁「${target.nickname}」`)
    banVisible.value = false
    emit('done')
  } catch {
    // 错误提示已在 request 层统一处理
  }
}

async function submitUnban(row: Customer): Promise<void> {
  try {
    await updateCustomer(row.id, { status: 'active' })
    ElMessage.success(`已解封「${row.nickname}」`)
    emit('done')
  } catch {
    // 错误提示已在 request 层统一处理
  }
}

defineExpose({ openQuota, openBan, submitUnban })
</script>

<template>
  <!-- 改额度 -->
  <el-dialog v-model="quotaVisible" title="修改额度" width="440px">
    <div v-if="quotaTarget" class="dlg-body">
      <div class="dlg-target">
        {{ quotaTarget.nickname }}
        <span class="dlg-mail">{{ quotaTarget.email }}</span>
      </div>
      <div class="dlg-label">快捷选择</div>
      <div class="presets">
        <el-button
          v-for="p in quotaPresets"
          :key="p.value"
          size="small"
          :type="Number(quotaValue) === Number(p.value) ? 'primary' : 'default'"
          @click="quotaValue = Number(p.value)"
        >
          {{ p.label }}
        </el-button>
      </div>
      <div class="dlg-label">或者手填</div>
      <el-input v-model.number="quotaValue" placeholder="整数，-1 表示不限量" />
      <div class="hint">{{ quotaHint }}</div>
    </div>
    <template #footer>
      <el-button @click="quotaVisible = false">取消</el-button>
      <el-button type="primary" @click="submitQuota">保存</el-button>
    </template>
  </el-dialog>

  <!-- 封禁 -->
  <el-dialog v-model="banVisible" title="封禁客户" width="440px">
    <div v-if="banTarget" class="dlg-body">
      <div class="dlg-target">
        {{ banTarget.nickname }}
        <span class="dlg-mail">{{ banTarget.email }}</span>
      </div>
      <div class="dlg-label">封禁原因</div>
      <el-select v-model="banReason" placeholder="选一个原因" style="width: 100%">
        <el-option v-for="o in banReasonOptions" :key="o.value" :label="o.label" :value="o.value" />
      </el-select>
      <template v-if="isOther">
        <div class="dlg-label">具体原因</div>
        <el-input v-model="banCustom" placeholder="写清楚，会记进操作日志" />
      </template>
      <div class="hint warn">
        封禁后客户无法使用客户端。这个动作会记进操作日志，原因也会留在客户详情里。
      </div>
    </div>
    <template #footer>
      <el-button @click="banVisible = false">取消</el-button>
      <el-button type="danger" @click="submitBan">确定封禁</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.dlg-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.dlg-target {
  font-size: 14px;
  font-weight: 500;
  margin-bottom: 4px;
}

.dlg-mail {
  font-weight: 400;
  font-size: 12px;
  color: var(--text-sub);
  margin-left: 8px;
}

.dlg-label {
  font-size: 12px;
  color: var(--text-sub);
  margin-top: 4px;
}

.presets {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.presets :deep(.el-button + .el-button) {
  margin-left: 0;
}

.hint {
  font-size: 12px;
  color: var(--text-sub);
  line-height: 1.6;
}

.hint.warn {
  color: #854f0b;
  background: #faeeda;
  border-radius: 8px;
  padding: 9px 11px;
  margin-top: 6px;
}
</style>
