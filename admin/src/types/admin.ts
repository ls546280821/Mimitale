/**
 * ============================================================================
 * 后台侧契约 —— 【本 admin 项目实际调用的全部接口】
 * ============================================================================
 *
 * 认证：Authorization: Bearer <adminToken>
 * baseURL 通常是 /api，所以下面路径都从 /admin 开头。
 *
 * 全部是本后台用的接口，共 16 个，分五组：
 *   1~4   管理员认证（账号密码，**没有注册**）
 *   5~7   客户：列表 / 改 / 详情
 *   8     操作日志（只读）
 *   9~11  卡密：列表 / 批量生成 / 作废
 *   12~16 字典：读全量 / 新建类型 / 增 / 改 / 删
 *
 * 客户自己在客户端怎么登录不在这里 —— 那在 ./client.ts。
 */

/* ------------------------------------------------------------------ */
/* 管理员（登录本后台的人 = 你自己）                                     */
/* ------------------------------------------------------------------ */

export interface AdminAccount {
  id: number
  username: string
  nickname: string
  /** super = 还能管管理员；normal = 只能管客户 */
  role: 'super' | 'normal'
  lastLoginAt: string | null
}

/**
 * 1. POST /api/admin/auth/login
 *    账号 + 密码。**没有注册** —— 管理员账号由部署时初始化写入（或由 super 创建），
 *    绝不允许通过这个接口自助注册。
 */
export interface AdminLoginReq {
  username: string
  password: string
}
export interface AdminLoginRes {
  token: string
  refreshToken: string
  /** token 有效期（秒） */
  expiresIn: number
  admin: AdminAccount
}

/**
 * 2. POST /api/admin/auth/refresh
 *    body: { refreshToken } → { token, expiresIn }
 */
export interface AdminRefreshReq {
  refreshToken: string
}
export interface AdminRefreshRes {
  token: string
  expiresIn: number
}

/* 3. GET  /api/admin/auth/me      → ApiResult<AdminAccount>  启动时校验 token */
/* 4. POST /api/admin/auth/logout  → ApiResult<null>          前端清本地 token  */

/* ------------------------------------------------------------------ */
/* 客户（在 Mimitale 客户端里注册的那些人）                              */
/* ------------------------------------------------------------------ */

/** 客户状态：正常 / 封禁 */
export type CustomerStatus = 'active' | 'banned'

export interface Customer {
  id: number
  /** 客户在 Mimitale 客户端里注册用的邮箱 */
  email: string
  nickname: string
  status: CustomerStatus
  /** 最近一次被封的原因，值来自字典 ban_reason。解封后清空 */
  banReason: string | null
  /** 剩余额度（次）。-1 表示不限量 */
  quota: number
  /** 注册时用的邀请码；直接邮箱注册则为 null */
  inviteCode: string | null
  /** 注册时间 */
  createdAt: string
  /** 最后一次登录客户端的时间；从未登录过为 null */
  lastLoginAt: string | null
}

/**
 * 5. GET /api/admin/customers
 *    分页 + 关键词（邮箱 / 昵称 / 邀请码）+ 状态筛选
 */
export interface CustomerListQuery {
  page: number
  pageSize: number
  /** 模糊匹配邮箱、昵称、邀请码 */
  keyword?: string
  /** 空字符串或不传 = 全部 */
  status?: CustomerStatus | ''
}
export interface CustomerListRes {
  total: number
  list: Customer[]
}

/**
 * 6. PATCH /api/admin/customers/{id}
 *    只传要改的字段
 */
export interface UpdateCustomerReq {
  status?: CustomerStatus
  quota?: number
  /** 封禁原因 —— 值来自字典 ban_reason（只有 status 改成 banned 时才有意义） */
  banReason?: string
}

/**
 * 7. GET /api/admin/customers/{id}
 *    客户详情 = 客户本身 + 他的邀请码来自哪张卡 + 他身上的操作记录
 */
export interface CustomerDetail extends Customer {
  /** 注册时用的那张卡；直接邮箱注册则为 null */
  usedCard: InviteCard | null
  /** 针对这个客户发生过的操作，最近的在前 */
  logs: OperationLog[]
}

/* ------------------------------------------------------------------ */
/* 操作日志                                                            */
/* ------------------------------------------------------------------ */

/**
 * 动作类型。
 *
 * ⚠️ 这是**由代码产生的**枚举，不是「真字典」—— 后端每加一种动作就要加一段代码，
 *    所以它**不进字典表**（放进去了也加不出新动作，只会造出一个假旋钮）。
 *    字典只管它的**显示名**，见 src/config/labels.ts 的 LOG_ACTION_LABEL。
 */
export type LogAction =
  | 'customer.ban'
  | 'customer.unban'
  | 'customer.quota'
  | 'card.create'
  | 'card.void'
  | 'dict.create'
  | 'dict.update'
  | 'dict.delete'

export interface OperationLog {
  id: number
  adminId: number
  adminName: string
  action: LogAction
  /** 被操作对象的类型：customer / card / dict */
  targetType: string
  targetId: number | null
  /** 被操作对象的名字，用于直接阅读（客户昵称 / 卡密 / 字典项） */
  targetName: string
  /** 一句话说清改了什么，例：「额度 100 → 500」 */
  detail: string
  ip: string
  createdAt: string
}

/**
 * 8. GET /api/admin/logs
 *    只读。日志**只由后端写入**，前端没有新增/修改/删除日志的接口 —— 这是刻意的。
 */
export interface LogListQuery {
  page: number
  pageSize: number
  /** 空 = 全部动作 */
  action?: LogAction | ''
  /** 模糊匹配 targetName 与 detail */
  keyword?: string
  /** ISO 日期（含当天）。前端传 'YYYY-MM-DD' */
  from?: string
  to?: string
}
export interface LogListRes {
  total: number
  list: OperationLog[]
}

/* ------------------------------------------------------------------ */
/* 卡密 / 激活码                                                        */
/* ------------------------------------------------------------------ */

/** 卡密状态。同样是**代码枚举**，不进字典：后端要靠它判断能不能用 */
export type CardStatus = 'unused' | 'used' | 'void'

export interface InviteCard {
  id: number
  /** 卡密本体，例：MIMI-7K2M-9QXA */
  code: string
  /** 备注，值来自字典 card_note（例：种子用户 / 活动赠送） */
  note: string
  status: CardStatus
  /** 被哪个客户用了。unused / void 时为 null */
  usedByCustomerId: number | null
  usedByEmail: string | null
  createdAt: string
  usedAt: string | null
  /** 过期时间；null = 永久有效 */
  expireAt: string | null
}

/**
 * 9. GET /api/admin/cards —— 分页 + 状态筛选 + 关键词（卡密 / 邮箱 / 备注）
 */
export interface CardListQuery {
  page: number
  pageSize: number
  keyword?: string
  status?: CardStatus | ''
}
export interface CardListRes {
  total: number
  list: InviteCard[]
}

/**
 * 10. POST /api/admin/cards —— 批量生成
 *     一次最多 100 张，别在后台手点 1000 次
 */
export interface CreateCardsReq {
  count: number
  /** 有效天数；null = 永久有效 */
  expireDays: number | null
  note?: string
}
export interface CreateCardsRes {
  /** 本次生成的卡密，直接回给前端让用户可以复制 */
  created: InviteCard[]
}

/** 11. PATCH /api/admin/cards/{id} —— 目前只用于作废 */
export interface UpdateCardReq {
  status: 'void'
}

/* ------------------------------------------------------------------ */
/* 字典                                                                */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ 字典只收「真字典」—— 加了新值**不需要改代码**的那些。
 *
 * 该进字典：封禁原因、客户来源、额度预设、卡密备注分类
 *           （这些是纯业务数据，运营自己加一个「刷屏」不需要重新部署）
 *
 * 不该进字典：客户状态、卡密状态、管理员角色
 *           （这些值被后端 if 判断引用。塞进字典只会让界面多出一个
 *             "新状态"，看着能加，加了却什么都不生效 —— 假旋钮比没旋钮更糟）
 */
export interface DictType {
  /** 类型编码，建表后不可改。例：ban_reason */
  code: string
  name: string
  remark: string
  createdAt: string
}

export interface DictItem {
  id: number
  typeCode: string
  /** 显示给人看的，例：刷屏 */
  label: string
  /** 存进数据库的，例：spam */
  value: string
  /** 小的排前面 */
  sort: number
  /** 停用后新建的地方选不到，但历史数据照旧显示 */
  enabled: boolean
  remark: string
}

/** 一次把类型和数据项都拿回来 —— 数据量小，没必要拆两个请求 */
export interface DictBundle {
  type: DictType
  items: DictItem[]
}

/** 12. GET /api/admin/dicts → ApiResult<DictBundle[]> */
/** 13. POST /api/admin/dicts —— 新建一个字典类型 */
export interface CreateDictTypeReq {
  code: string
  name: string
  remark?: string
}

/** 14. POST /api/admin/dicts/{code}/items —— 新增数据项 */
export interface CreateDictItemReq {
  label: string
  value: string
  sort?: number
  remark?: string
}

/** 15. PATCH /api/admin/dicts/items/{id} —— 改标签 / 排序 / 启用停用 */
export interface UpdateDictItemReq {
  label?: string
  value?: string
  sort?: number
  enabled?: boolean
  remark?: string
}

/* 16. DELETE /api/admin/dicts/items/{id} → ApiResult<null> */
