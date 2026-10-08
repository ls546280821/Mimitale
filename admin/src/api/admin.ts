/**
 * 后台管理员认证 —— 对应 src/types/admin.ts 的 1~4 号契约
 *
 * 注意：**没有注册接口**。管理员账号是预置的，只能登录。
 */

import { request } from './request'
import type {
  AdminAccount,
  AdminLoginReq,
  AdminLoginRes,
  AdminRefreshReq,
  AdminRefreshRes
} from '@/types'

/** 1. 管理员登录（账号 + 密码） */
export function adminLogin(payload: AdminLoginReq): Promise<AdminLoginRes> {
  return request<AdminLoginRes>({
    url: '/admin/auth/login',
    method: 'post',
    data: payload
  })
}

/** 2. 刷新 token */
export function adminRefresh(payload: AdminRefreshReq): Promise<AdminRefreshRes> {
  return request<AdminRefreshRes>({
    url: '/admin/auth/refresh',
    method: 'post',
    data: payload
  })
}

/** 3. 我的信息 */
export function adminMe(): Promise<AdminAccount> {
  return request<AdminAccount>({
    url: '/admin/auth/me',
    method: 'get'
  })
}

/** 4. 登出 */
export function adminLogout(): Promise<null> {
  return request<null>({
    url: '/admin/auth/logout',
    method: 'post'
  })
}
