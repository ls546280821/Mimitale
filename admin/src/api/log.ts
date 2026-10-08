/**
 * 操作日志 —— 对应 src/types/admin.ts 的 8 号契约
 *
 * ⚠️ 只有「查」。日志由后端在做事的时候顺手写入，
 *    前端**没有**新增 / 修改 / 删除日志的接口 —— 这是刻意的。
 */

import { request } from './request'
import type { LogListQuery, LogListRes } from '@/types'

/** 8. 操作日志列表（分页 + 动作 / 关键词 / 时间范围） */
export function fetchLogs(query: LogListQuery): Promise<LogListRes> {
  return request<LogListRes>({
    url: '/admin/logs',
    method: 'get',
    params: query
  })
}
