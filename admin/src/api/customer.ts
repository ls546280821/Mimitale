/**
 * 客户管理 —— 对应 src/types/admin.ts 的 5、6 号契约
 *
 * 「客户」= 在 Mimitale 客户端里注册使用的人。这个后台存在的意义就是管他们。
 */

import { request } from './request'
import type {
  Customer,
  CustomerDetail,
  CustomerListQuery,
  CustomerListRes,
  UpdateCustomerReq
} from '@/types'

/** 5. 客户列表（分页 + 关键词 + 状态筛选） */
export function fetchCustomers(query: CustomerListQuery): Promise<CustomerListRes> {
  return request<CustomerListRes>({
    url: '/admin/customers',
    method: 'get',
    params: query
  })
}

/** 6. 改客户状态（封禁 / 解封）/ 改额度。每次变更后端都会落一条操作日志 */
export function updateCustomer(id: number, payload: UpdateCustomerReq): Promise<Customer> {
  return request<Customer>({
    url: `/admin/customers/${id}`,
    method: 'patch',
    data: payload
  })
}

/** 7. 客户详情：客户本身 + 他的邀请码来自哪张卡 + 他身上的操作记录 */
export function fetchCustomerDetail(id: number): Promise<CustomerDetail> {
  return request<CustomerDetail>({
    url: `/admin/customers/${id}`,
    method: 'get'
  })
}
