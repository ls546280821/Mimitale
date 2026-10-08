/**
 * ============================================================================
 * 显示名 / 标签色 —— 写死在代码里的那些枚举
 * ============================================================================
 *
 * ⚠️ 为什么这些**不放字典**？判断标准只有一条：
 *
 *     加一个新的值，需不需要改代码？
 *
 *   需要 → 写在这里（下面这些全是）。因为后端有 `if (status === 'banned')`、
 *          前端有 `row.status === 'active' ? '封禁' : '解封'` —— 值本身参与逻辑。
 *          把它塞进字典，只能改显示名，加不出真正生效的选项，
 *          结果是界面上多出一个「选得动、但什么都不发生」的假旋钮。
 *
 *   不需要 → 放字典（封禁原因、客户来源、额度预设、卡密备注）。
 *           运营自己加一个「刷屏」不用重新部署，这才是字典该干的事。
 *
 * 这条边界是有意的，别为了「统一」把这些也搬进字典。
 */

import type { CardStatus, CustomerStatus, LogAction } from '@/types'

/** el-tag 支持的类型 */
export type TagType = 'success' | 'info' | 'warning' | 'danger'

/** 操作日志的动作 → 中文 */
export const LOG_ACTION_LABEL: Record<LogAction, string> = {
  'customer.ban': '封禁客户',
  'customer.unban': '解封客户',
  'customer.quota': '调整额度',
  'card.create': '生成卡密',
  'card.void': '作废卡密',
  'dict.create': '新建字典',
  'dict.update': '改字典项',
  'dict.delete': '删字典项'
}

/** 动作 → 标签色。破坏性的红、恢复性的绿、其它中性 */
export const LOG_ACTION_TAG: Record<LogAction, TagType> = {
  'customer.ban': 'danger',
  'customer.unban': 'success',
  'customer.quota': 'info',
  'card.create': 'info',
  'card.void': 'danger',
  'dict.create': 'info',
  'dict.update': 'warning',
  'dict.delete': 'danger'
}

/** 日志筛选项（顺序即下拉里的顺序） */
export const LOG_ACTION_OPTIONS: LogAction[] = [
  'customer.ban',
  'customer.unban',
  'customer.quota',
  'card.create',
  'card.void',
  'dict.create',
  'dict.update',
  'dict.delete'
]

/** 客户状态 */
export const CUSTOMER_STATUS_LABEL: Record<CustomerStatus, string> = {
  active: '正常',
  banned: '已封禁'
}

export const CUSTOMER_STATUS_TAG: Record<CustomerStatus, TagType> = {
  active: 'success',
  banned: 'danger'
}

/** 卡密状态 */
export const CARD_STATUS_LABEL: Record<CardStatus, string> = {
  unused: '未使用',
  used: '已使用',
  void: '已作废'
}

export const CARD_STATUS_TAG: Record<CardStatus, TagType> = {
  unused: 'success',
  used: 'info',
  void: 'danger'
}

/**
 * 客户来源 —— 由「有没有邀请码」推导，**数据库里不存这一列**。
 * 值本身是推导出来的，但显示名走字典 customer_source，所以运营改叫法不用动代码。
 */
export function deriveCustomerSource(customer: { inviteCode: string | null }): string {
  return customer.inviteCode ? 'invite' : 'email'
}

/** 统一的时间格式化：2026-10-08 14:30 */
export function formatTime(value: string | null): string {
  if (!value) return '—'
  const d = new Date(value)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 只到日：2026-10-08 */
export function formatDay(value: string | null): string {
  if (!value) return '—'
  return formatTime(value).slice(0, 10)
}

/** 额度显示：-1 → 不限量 */
export function formatQuota(quota: number): string {
  return quota === -1 ? '不限量' : String(quota)
}
