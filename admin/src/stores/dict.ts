/**
 * 字典缓存 —— 让字典**真的被用上**，而不是一个只读的管理页面。
 *
 * 界面里凡是「选一个业务原因 / 分类」的地方，选项都从这里取：
 *   - 封禁客户时的「封禁原因」→ ban_reason
 *   - 客户详情里的「来源」     → customer_source
 *   - 改额度时的快捷按钮       → quota_preset
 *   - 生成卡密时的「备注分类」 → card_note
 *
 * 这样在字典页加一条，界面上的下拉立刻多一个选项 —— 不用改代码、不用发版。
 * 这就是「真字典」跟「假旋钮」的区别。
 */

import { ref } from 'vue'
import { defineStore } from 'pinia'
import { fetchDicts } from '@/api/dict'
import type { DictBundle, DictItem } from '@/types'

export const useDictStore = defineStore('dict', () => {
  const bundles = ref<DictBundle[]>([])
  const loaded = ref(false)

  /** 进后台后拉一次就够；传 true 可强制重拉（字典页改完东西靠它刷新） */
  async function load(force = false): Promise<void> {
    if (loaded.value && !force) return
    bundles.value = await fetchDicts()
    loaded.value = true
  }

  function bundleOf(typeCode: string): DictBundle | undefined {
    return bundles.value.find((b) => b.type.code === typeCode)
  }

  /** 可选项 —— 只给「启用」的，按 sort 排。下拉框用这个 */
  function optionsOf(typeCode: string): DictItem[] {
    const b = bundleOf(typeCode)
    if (!b) return []
    return b.items.filter((i) => i.enabled).sort((a, b2) => a.sort - b2.sort)
  }

  /** 全部数据项（含停用）—— 字典管理页用这个，好让人看到并重新启用 */
  function allItemsOf(typeCode: string): DictItem[] {
    const b = bundleOf(typeCode)
    return b ? [...b.items].sort((a, b2) => a.sort - b2.sort) : []
  }

  /**
   * 值 → 显示名。
   * 查不到就把原值原样返回 —— 这样即使字典项被删了，历史数据也不会变成空白。
   */
  function labelOf(typeCode: string, value: string | null | undefined): string {
    if (value === null || value === undefined || value === '') return '—'
    const hit = bundleOf(typeCode)?.items.find((i) => i.value === value)
    return hit?.label ?? value
  }

  return { bundles, loaded, load, optionsOf, allItemsOf, labelOf }
})
