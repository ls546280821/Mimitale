/**
 * ============================================================================
 * Mimitale 账号体系 —— 类型总入口
 * ============================================================================
 *
 * ⚠️ 先搞清楚：这里有两个**完全不同的「用户」**，千万不要混：
 *
 *   ① 客户（customer）
 *      在 Mimitale 客户端里注册、使用软件的人。他们才是你要管理的对象。
 *      他们怎么登录、怎么注册 → 见 ./client.ts
 *      那套接口是 **Mimitale 客户端**去调的，**本后台不调**。
 *
 *   ② 管理员（admin）
 *      也就是你自己。登录本后台来管理客户。
 *      → 见 ./admin.ts
 *      本后台只调这一组接口。
 *
 * 两套独立的账号、两套独立的接口、两套独立的 token。
 * 客户登不进后台；管理员也不是客户。
 *
 * ----------------------------------------------------------------------------
 * 全项目统一的约定：
 *   1. 所有接口统一响应外壳 ApiResult<T>，业务结果看 code（0 = 成功）
 *   2. 时间字段一律 ISO 8601 字符串（例：2026-10-08T10:30:00+08:00）
 *   3. 认证走 HTTP Header：Authorization: Bearer <token>
 *   4. 认证失败返回 HTTP 401（前端据此清 token 跳登录）；
 *      其余业务错误返回 HTTP 200 + code ≠ 0（前端弹 message 即可）
 */

/** 统一响应外壳。data 在失败时通常为 null */
export interface ApiResult<T> {
  code: number
  message: string
  data: T
}

/**
 * 业务错误码。
 * 0 = 成功；1xxx = 参数/凭证类；401xx = 认证类；403xx = 权限/状态类；5xxxx = 服务端
 */
export const ApiCode = {
  OK: 0,

  INVALID_PARAM: 1001,
  /** 验证码错误或已过期（客户侧） */
  CODE_INVALID: 1002,
  /** 发送太频繁（客户侧，同一邮箱 60 秒一次） */
  TOO_FREQUENT: 1003,
  /** 邮件发不出去（客户侧，后端接了邮件服务才会有） */
  EMAIL_SEND_FAILED: 1004,
  /** 管理员账号或密码不对 */
  BAD_CREDENTIALS: 1005,

  /** 未登录 / 没带 token */
  UNAUTHORIZED: 40100,
  /** token 已过期，需要刷新或重新登录 */
  TOKEN_EXPIRED: 40101,

  /** 该客户已被封禁 */
  ACCOUNT_BANNED: 40300,
  /** 不是管理员，无权访问管理接口 */
  NOT_ADMIN: 40301,

  NOT_FOUND: 40400,
  SERVER_ERROR: 50000
} as const

export type ApiCodeValue = (typeof ApiCode)[keyof typeof ApiCode]

export * from './admin'
export * from './client'
