/**
 * 字典 —— 对应 src/types/admin.ts 的 12~16 号契约
 *
 * 只收「真字典」：加了新值不需要改代码的那些枚举。
 * 详见 src/config/labels.ts 顶部那段说明。
 */

import { request } from './request'
import type {
  CreateDictItemReq,
  CreateDictTypeReq,
  DictBundle,
  DictItem,
  UpdateDictItemReq
} from '@/types'

/** 12. 一次拿全部字典（类型 + 数据项）。数据量小，没必要拆两个请求 */
export function fetchDicts(): Promise<DictBundle[]> {
  return request<DictBundle[]>({
    url: '/admin/dicts',
    method: 'get'
  })
}

/** 13. 新建字典类型 */
export function createDictType(payload: CreateDictTypeReq): Promise<DictBundle> {
  return request<DictBundle>({
    url: '/admin/dicts',
    method: 'post',
    data: payload
  })
}

/** 14. 新增数据项 */
export function createDictItem(typeCode: string, payload: CreateDictItemReq): Promise<DictItem> {
  return request<DictItem>({
    url: `/admin/dicts/${typeCode}/items`,
    method: 'post',
    data: payload
  })
}

/** 15. 改标签 / 排序 / 启用停用 */
export function updateDictItem(id: number, payload: UpdateDictItemReq): Promise<DictItem> {
  return request<DictItem>({
    url: `/admin/dicts/items/${id}`,
    method: 'patch',
    data: payload
  })
}

/** 16. 删除数据项 */
export function deleteDictItem(id: number): Promise<null> {
  return request<null>({
    url: `/admin/dicts/items/${id}`,
    method: 'delete'
  })
}
