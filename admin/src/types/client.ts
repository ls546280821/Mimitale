/**
 * ============================================================================
 * 客户侧契约 —— 【Mimitale 客户端调的，本后台一行都不用】
 * ============================================================================
 *
 * 放在这里只有一个目的：**给后端当参考**。
 * 后端要同时实现两套东西：
 *   - 客户侧（本文件）—— Mimitale 客户端调
 *   - 后台侧（./admin.ts）—— 管理后台调
 *
 * ----------------------------------------------------------------------------
 * 设计要点 —— 「登录即注册」：
 *   没有独立的注册接口。POST /api/client/auth/login 校验验证码通过后，
 *   邮箱存在就登录、不存在就自动建号，用 isNewUser 标记区分。
 *   客户全程看不到「注册」这一步。
 *
 * 和后台的关键区别：
 *   客户能自助注册（这是设计），管理员不能（那是漏洞）。
 */

import type { Customer } from './admin'

/* ------------------------------------------------------------------ */
/* 1. POST /api/client/auth/code                                       */
/*    同一邮箱 60 秒内只允许一次；验证码 5 分钟过期                       */
/*    注意：真上短信时这个接口形状不变，只是后端多接一个发送通道            */
/* ------------------------------------------------------------------ */
export interface SendCodeReq {
  email: string
}
export interface SendCodeRes {
  /** 验证码有效期（秒） */
  expiresIn: number
}

/* ------------------------------------------------------------------ */
/* 2. POST /api/client/auth/login —— 登录即注册                         */
/* ------------------------------------------------------------------ */
export interface ClientLoginReq {
  email: string
  code: string
  /** 可选：邀请码制下由客户端传入 */
  inviteCode?: string
}
export interface ClientLoginRes {
  token: string
  refreshToken: string
  expiresIn: number
  /** 本次是否顺手建了新号 */
  isNewUser: boolean
  customer: Customer
}

/* ------------------------------------------------------------------ */
/* 3. POST /api/client/auth/refresh                                    */
/* ------------------------------------------------------------------ */
export interface ClientRefreshReq {
  refreshToken: string
}
export interface ClientRefreshRes {
  token: string
  expiresIn: number
}

/* 4. GET  /api/client/auth/me      → ApiResult<Customer> */
/* 5. POST /api/client/auth/logout  → ApiResult<null>     */
