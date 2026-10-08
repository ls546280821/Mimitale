/**
 * axios 封装：统一拆包、统一错误提示、自动带 token、401 自动回登录页。
 * 页面里只用 request<T>()，不用直接碰 axios。
 */

import axios, { type AxiosError, type AxiosRequestConfig } from 'axios'
import { ElMessage } from 'element-plus'
import { ApiCode, type ApiResult } from '@/types'
import { mockAdapter } from '@/mock'

/** 不设或设成 'false' 以外的值都算开 mock */
export const USE_MOCK = import.meta.env.VITE_USE_MOCK !== 'false'

export const TOKEN_KEY = 'mimitale_admin_token'
export const REFRESH_TOKEN_KEY = 'mimitale_admin_refresh'

/** 业务错误（HTTP 200 但 code ≠ 0）抛这个，页面可以按 code 分支处理 */
export class ApiError extends Error {
  code: number
  constructor(code: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.code = code
  }
}

const http = axios.create({
  baseURL: import.meta.env.VITE_API_BASE || '/api',
  timeout: 15_000
})

if (USE_MOCK) {
  http.defaults.adapter = mockAdapter
}

http.interceptors.request.use((config) => {
  const token = localStorage.getItem(TOKEN_KEY)
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

function clearSession(): void {
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(REFRESH_TOKEN_KEY)
}

function backToLogin(message: string): void {
  clearSession()
  ElMessage.warning(message)
  // 整页重载最省心：内存里的 pinia 状态也跟着一起重置了
  window.location.hash = '#/login'
  window.location.reload()
}

http.interceptors.response.use(
  (response) => response,
  (error: AxiosError<ApiResult<unknown>>) => {
    const status = error.response?.status
    const body = error.response?.data

    if (status === 401) {
      if (!window.location.hash.startsWith('#/login')) {
        backToLogin(body?.message || '登录已过期，请重新登录')
      }
    } else if (!body) {
      ElMessage.error(USE_MOCK ? 'mock 出错了，看下控制台' : '连不上后端，确认服务启动了吗')
    }
    return Promise.reject(error)
  }
)

export async function request<T>(config: AxiosRequestConfig): Promise<T> {
  try {
    const response = await http.request<ApiResult<T>>(config)
    const body = response.data
    if (body.code !== ApiCode.OK) {
      ElMessage.error(body.message || '请求失败')
      throw new ApiError(body.code, body.message)
    }
    return body.data
  } catch (error) {
    if (error instanceof ApiError) throw error
    // 401 已经在拦截器里提示过并跳转了，这里不再重复弹
    const body = (error as AxiosError<ApiResult<unknown>>)?.response?.data
    throw new ApiError(body?.code ?? ApiCode.SERVER_ERROR, body?.message ?? '请求失败')
  }
}
