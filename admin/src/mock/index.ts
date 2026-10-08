/**
 * ============================================================================
 * 内置 mock 后端 —— 【只实现后台侧接口】
 * ============================================================================
 *
 * 这是一个真的 axios adapter —— 不是「拦截器里随便返回点东西」，
 * 而是把请求按 method + path 路由到 handler 上，走的是和真实后端一模一样的流程：
 * 校验参数 → 校验 token → 返回 ApiResult。
 *
 * 想真连后端：把 .env 里的 VITE_USE_MOCK 改成 false。
 *
 * ⚠️ 两个刻意的设计，真实后端要照抄：
 *
 *   ① 后台管理员账号是**预置**的，没有注册入口。
 *      客户能在客户端自助注册，管理员绝对不能自助注册（那是漏洞）。
 *
 *   ② **操作日志只由后端写入，前端没有写入接口。**
 *      封禁 / 改额度 / 生成卡密 / 作废卡密 / 改字典，都在同一个 handler 里
 *      顺手写一条日志。这不是「顺便加的功能」—— 日志如果靠前端上报，
 *      那它记录的就只是「前端愿意上报的部分」，出事时一文不值。
 *
 * 试玩账号：admin / admin123
 */

import type { AxiosAdapter, AxiosResponse, InternalAxiosRequestConfig } from 'axios'
import {
  ApiCode,
  type AdminAccount,
  type AdminLoginReq,
  type AdminRefreshReq,
  type CardListQuery,
  type CardStatus,
  type CreateCardsReq,
  type CreateDictItemReq,
  type CreateDictTypeReq,
  type Customer,
  type CustomerDetail,
  type CustomerStatus,
  type DictBundle,
  type DictItem,
  type DictType,
  type InviteCard,
  type LogAction,
  type LogListQuery,
  type OperationLog,
  type UpdateCardReq,
  type UpdateCustomerReq,
  type UpdateDictItemReq
} from '@/types'

/* ------------------------------------------------------------------ */
/* 管理员（预置，不可注册）                                              */
/* ------------------------------------------------------------------ */

interface MockAdmin extends AdminAccount {
  password: string
}

const admins: MockAdmin[] = [
  {
    id: 1,
    username: 'admin',
    password: 'admin123',
    nickname: '星宝',
    role: 'super',
    lastLoginAt: null
  }
]

/* ------------------------------------------------------------------ */
/* 伪随机工具（固定种子，保证每次刷新看到的都一样）                        */
/* ------------------------------------------------------------------ */

/** 线性同余伪随机 —— 种子一样，数据就一样 */
function makeRng(seed: number): () => number {
  let s = seed
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648
    return s / 2147483648
  }
}

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
function randCode(rng: () => number, len: number): string {
  let out = ''
  for (let i = 0; i < len; i++) out += CODE_CHARS[Math.floor(rng() * CODE_CHARS.length)]
  return out
}

const NOW = Date.parse('2026-10-08T09:00:00+08:00')
const DAY = 86_400_000

/* ------------------------------------------------------------------ */
/* 客户                                                                */
/* ------------------------------------------------------------------ */

const NICK_POOL = [
  '夜航船', '灰羽', '半糖去冰', '雾岛听风', '拾光', '南风',
  '三月初九', '过路人', '纸飞机', '旧巷', '星野', '沉舟',
  '听雪', '折枝', '青柠', '白露', '千叶', '林间',
  '夏至', '一苇', '阿柚', '不系舟', '小满', '故里', '长夜', '晚照'
]

function seedCustomers(): Customer[] {
  const rng = makeRng(20261008)
  const QUOTA_POOL = [-1, 500, 200, 100, 50, 0]
  // 和字典 ban_reason 的 value 对应（mock 里写死一份，真实后端直接查字典表）
  const BAN_REASON_POOL = ['spam', 'card_resale', 'api_abuse']
  const list: Customer[] = []

  for (let i = 0; i < 26; i++) {
    const daysAgo = Math.floor(rng() * 210) + 1
    const createdAt = NOW - daysAgo * DAY - Math.floor(rng() * DAY)
    const everLogged = rng() > 0.12
    const banned = rng() < 0.12

    list.push({
      id: i + 1,
      email: `user${String(i + 1).padStart(3, '0')}@example.com`,
      nickname: NICK_POOL[i % NICK_POOL.length],
      status: banned ? 'banned' : 'active',
      banReason: banned ? BAN_REASON_POOL[Math.floor(rng() * BAN_REASON_POOL.length)] : null,
      quota: QUOTA_POOL[Math.floor(rng() * QUOTA_POOL.length)],
      inviteCode: rng() > 0.55 ? `MIMI-${randCode(rng, 4)}-${randCode(rng, 4)}` : null,
      createdAt: new Date(createdAt).toISOString(),
      lastLoginAt: everLogged
        ? new Date(createdAt + Math.floor(rng() * (NOW - createdAt))).toISOString()
        : null
    })
  }

  // 放一个眼熟的客户在最前面，打开页面就有东西看
  list[1] = { ...list[1], nickname: '露西娅', quota: -1, inviteCode: 'MIMI-DEMO-8888' }
  return list
}

/* ------------------------------------------------------------------ */
/* 卡密                                                                */
/* ------------------------------------------------------------------ */

function seedCards(list: Customer[]): InviteCard[] {
  const rng = makeRng(20261009)
  const cards: InviteCard[] = []
  const used = new Set<string>()
  let id = 1

  const freshCode = (): string => {
    let code = ''
    do {
      code = `MIMI-${randCode(rng, 4)}-${randCode(rng, 4)}`
    } while (used.has(code))
    used.add(code)
    return code
  }

  // ① 每个「有邀请码」的客户，对应一张已使用的卡 —— 数据要能对得上
  for (const c of list) {
    if (!c.inviteCode) continue
    used.add(c.inviteCode)
    cards.push({
      id: id++,
      code: c.inviteCode,
      note: rng() > 0.5 ? '种子用户' : '活动赠送',
      status: 'used',
      usedByCustomerId: c.id,
      usedByEmail: c.email,
      createdAt: new Date(Date.parse(c.createdAt) - (Math.floor(rng() * 3) + 1) * DAY).toISOString(),
      usedAt: c.createdAt,
      expireAt: null
    })
  }

  // ② 一批还没被用掉的
  for (let i = 0; i < 14; i++) {
    const daysAgo = Math.floor(rng() * 60) + 1
    const expireDays = rng() > 0.4 ? 90 + Math.floor(rng() * 180) : null
    const createdAt = NOW - daysAgo * DAY
    cards.push({
      id: id++,
      code: freshCode(),
      note: rng() > 0.6 ? '付费购买' : '内部测试',
      status: 'unused',
      usedByCustomerId: null,
      usedByEmail: null,
      createdAt: new Date(createdAt).toISOString(),
      usedAt: null,
      expireAt: expireDays ? new Date(createdAt + expireDays * DAY).toISOString() : null
    })
  }

  // ③ 几张作废的
  for (let i = 0; i < 3; i++) {
    cards.push({
      id: id++,
      code: freshCode(),
      note: '内部测试',
      status: 'void',
      usedByCustomerId: null,
      usedByEmail: null,
      createdAt: new Date(NOW - (Math.floor(rng() * 40) + 5) * DAY).toISOString(),
      usedAt: null,
      expireAt: null
    })
  }

  return cards
}

/* ------------------------------------------------------------------ */
/* 字典                                                                */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ 只放「真字典」。判断标准就一条：
 *    **加一条新数据，需不需要改代码？**
 *
 *    不需要 → 该进字典（封禁原因、客户来源、额度预设、卡密备注）
 *    需要   → 别放进来（客户状态、卡密状态、管理员角色、日志动作类型）
 *             因为后端有 `if (status === 'banned')`，字典里加个第三态
 *             只会让界面多出一个选得动、但什么都不发生的选项。
 */
interface SeedDict {
  type: DictType
  items: Array<[label: string, value: string, remark: string]>
}

const DICT_SEEDS: SeedDict[] = [
  {
    type: { code: 'ban_reason', name: '封禁原因', remark: '封禁客户时选的原因，用于事后追溯', createdAt: '' },
    items: [
      ['刷屏广告', 'spam', '在角色卡/世界书里夹带广告'],
      ['盗卖卡密', 'card_resale', '把卡密拿到外面倒卖'],
      ['违规调用接口', 'api_abuse', '用脚本高频刷接口'],
      ['冒充他人', 'impersonation', ''],
      ['其他', 'other', '']
    ]
  },
  {
    type: { code: 'customer_source', name: '客户来源', remark: '由「有没有邀请码」推导出来，字典只负责它的显示名', createdAt: '' },
    items: [
      ['邮箱直注', 'email', '没填邀请码，直接邮箱注册'],
      ['邀请码', 'invite', '注册时填了卡密'],
      ['后台导入', 'import', '预留给批量导入，目前没有产生途径']
    ]
  },
  {
    type: { code: 'quota_preset', name: '额度预设', remark: '改额度时的快捷选项，省得每次手打数字', createdAt: '' },
    items: [
      ['不限量', '-1', '永久不限次数'],
      ['500 次', '500', ''],
      ['200 次', '200', ''],
      ['100 次', '100', '试用装常用'],
      ['50 次', '50', ''],
      ['停用', '0', '能登录但用不了']
    ]
  },
  {
    type: { code: 'card_note', name: '卡密备注分类', remark: '生成卡密时选，方便日后按来源统计', createdAt: '' },
    items: [
      ['种子用户', 'seed', '早期免费发的'],
      ['活动赠送', 'promo', ''],
      ['付费购买', 'paid', '第三方平台卖出去的'],
      ['内部测试', 'test', '']
    ]
  }
]

function seedDicts(): DictBundle[] {
  let itemId = 1
  return DICT_SEEDS.map((s) => ({
    type: { ...s.type, createdAt: new Date(NOW - 120 * DAY).toISOString() },
    items: s.items.map(([label, value, remark], idx) => ({
      id: itemId++,
      typeCode: s.type.code,
      label,
      value,
      sort: (idx + 1) * 10,
      enabled: true,
      remark
    }))
  }))
}

/* ------------------------------------------------------------------ */
/* 内存状态                                                            */
/* ------------------------------------------------------------------ */

let customers: Customer[] = seedCustomers()
let cards: InviteCard[] = seedCards(customers)
let dicts: DictBundle[] = seedDicts()

let logSeq = 0
const logs: OperationLog[] = []

/** 新日志插到最前面（最近的在上） */
function pushLog(e: {
  adminId: number
  adminName: string
  action: LogAction
  targetType: string
  targetId: number | null
  targetName: string
  detail: string
  createdAt?: string
}): OperationLog {
  logSeq += 1
  const log: OperationLog = {
    id: logSeq,
    adminId: e.adminId,
    adminName: e.adminName,
    action: e.action,
    targetType: e.targetType,
    targetId: e.targetId,
    targetName: e.targetName,
    detail: e.detail,
    ip: '127.0.0.1',
    createdAt: e.createdAt ?? new Date().toISOString()
  }
  logs.unshift(log)
  return log
}

/** 造一批历史日志，让日志页打开就有东西看 */
function seedLogs(): void {
  const rng = makeRng(20261010)
  const me = admins[0]

  type Entry = { at: number; log: Parameters<typeof pushLog>[0] }
  const entries: Entry[] = []
  const add = (at: number, log: Parameters<typeof pushLog>[0]): void => {
    if (at <= NOW) entries.push({ at, log })
  }

  const base = {
    adminId: me.id,
    adminName: me.nickname,
    targetType: 'customer',
    targetId: null as number | null
  }

  // ① 已经存在的封禁客户，补上「当初是谁、为什么封的」
  for (const c of customers) {
    if (c.status !== 'banned' || !c.banReason) continue
    add(Date.parse(c.createdAt) + Math.floor(rng() * 30 + 2) * DAY, {
      ...base,
      action: 'customer.ban',
      targetId: c.id,
      targetName: c.nickname,
      detail: `封禁（${labelOfSeed('ban_reason', c.banReason)}）`
    })
  }

  // ② 一些改额度
  for (let i = 0; i < 9; i++) {
    const c = customers[Math.floor(rng() * customers.length)]
    const before = [0, 50, 100, 200][Math.floor(rng() * 4)]
    const after = [100, 200, 500, -1][Math.floor(rng() * 4)]
    add(Date.parse(c.createdAt) + Math.floor(rng() * 60 + 3) * DAY, {
      ...base,
      action: 'customer.quota',
      targetId: c.id,
      targetName: c.nickname,
      detail: `额度 ${before} → ${after === -1 ? '不限量' : after}`
    })
  }

  // ③ 生成卡密
  for (const card of cards.filter((c) => c.status === 'unused').slice(0, 6)) {
    add(Date.parse(card.createdAt), {
      adminId: me.id,
      adminName: me.nickname,
      action: 'card.create',
      targetType: 'card',
      targetId: card.id,
      targetName: card.code,
      detail: `生成 1 张卡密（${card.note}）`
    })
  }

  // ④ 作废卡密
  for (const card of cards.filter((c) => c.status === 'void')) {
    add(Date.parse(card.createdAt) + 3 * DAY, {
      adminId: me.id,
      adminName: me.nickname,
      action: 'card.void',
      targetType: 'card',
      targetId: card.id,
      targetName: card.code,
      detail: '作废（长期未被使用）'
    })
  }

  // ⑤ 给最前面那个「眼熟的客户」补两条，详情页打开就有东西看
  const demo = customers[1]
  if (demo) {
    add(Date.parse(demo.createdAt) + 2 * DAY, {
      ...base,
      action: 'customer.quota',
      targetId: demo.id,
      targetName: demo.nickname,
      detail: '额度 50 → 100'
    })
    add(Date.parse(demo.createdAt) + 20 * DAY, {
      ...base,
      action: 'customer.quota',
      targetId: demo.id,
      targetName: demo.nickname,
      detail: '额度 100 → 不限量'
    })
  }

  // 按时间正序 push —— pushLog 是 unshift，最终正好是「最近的在上」
  entries
    .sort((a, b) => a.at - b.at)
    .forEach((e) => pushLog({ ...e.log, createdAt: new Date(e.at).toISOString() }))
}

/** 种子阶段用的 label 查找（只在 mock 内部用） */
function labelOfSeed(typeCode: string, value: string): string {
  const t = DICT_SEEDS.find((d) => d.type.code === typeCode)
  return t?.items.find(([, v]) => v === value)?.[0] ?? value
}

seedLogs()

/** adminToken → adminId */
const sessions = new Map<string, number>()
/** adminRefreshToken → adminId */
const refreshSessions = new Map<string, number>()

let tokenSeq = 0

function issueToken(adminId: number): { token: string; refreshToken: string; expiresIn: number } {
  tokenSeq += 1
  const token = `mock-admin-token-${tokenSeq}-${adminId}`
  const refreshToken = `mock-admin-refresh-${tokenSeq}-${adminId}`
  sessions.set(token, adminId)
  refreshSessions.set(refreshToken, adminId)
  return { token, refreshToken, expiresIn: 7200 }
}

/* ------------------------------------------------------------------ */
/* 路由骨架                                                            */
/* ------------------------------------------------------------------ */

interface MockCtx {
  params: Record<string, string>
  query: Record<string, string>
  body: Record<string, unknown>
  headers: Record<string, string>
}

interface MockOutcome {
  code: number
  message?: string
  data?: unknown
  /** 不填 = 200 */
  httpStatus?: number
}

type MockHandler = (ctx: MockCtx) => MockOutcome

function ok(data: unknown): MockOutcome {
  return { code: ApiCode.OK, message: 'ok', data }
}

function fail(code: number, message: string): MockOutcome {
  return { code, message, data: null }
}

function expired(): MockOutcome {
  return {
    code: ApiCode.TOKEN_EXPIRED,
    message: '登录已过期，请重新登录',
    data: null,
    httpStatus: 401
  }
}

function bearerToken(headers: Record<string, string>): string {
  return (headers['authorization'] ?? '').replace(/^Bearer\s+/i, '').trim()
}

function requireAdmin(headers: Record<string, string>): MockAdmin | null {
  const adminId = sessions.get(bearerToken(headers))
  if (!adminId) return null
  return admins.find((a) => a.id === adminId) ?? null
}

/** 去掉密码再往外给 */
function toAdminAccount(admin: MockAdmin): AdminAccount {
  const { id, username, nickname, role, lastLoginAt } = admin
  return { id, username, nickname, role, lastLoginAt }
}

/** 翻页 + 关键词的统一收尾 */
function paginate<T>(list: T[], query: Record<string, string>): { total: number; list: T[] } {
  const page = Math.max(1, Number(query.page) || 1)
  const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 10))
  const start = (page - 1) * pageSize
  return { total: list.length, list: list.slice(start, start + pageSize) }
}

/** 本地时区的 YYYY-MM-DD，用来跟 query.from / to 比 */
function localDay(iso: string): string {
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/* ------------------------------------------------------------------ */
/* 1~4 · 管理员认证                                                     */
/* ------------------------------------------------------------------ */

/**
 * POST /api/admin/auth/login
 * 账号 + 密码。**没有注册分支** —— 对不上就是错，不会顺手建号。
 */
function handleAdminLogin({ body }: MockCtx): MockOutcome {
  const req = body as unknown as AdminLoginReq
  const username = String(req.username ?? '').trim()
  const password = String(req.password ?? '')

  if (!username || !password) return fail(ApiCode.INVALID_PARAM, '账号和密码都要填')

  const admin = admins.find((a) => a.username === username && a.password === password)
  if (!admin) return fail(ApiCode.BAD_CREDENTIALS, '账号或密码不对')

  admin.lastLoginAt = new Date().toISOString()
  const { token, refreshToken, expiresIn } = issueToken(admin.id)
  return ok({ token, refreshToken, expiresIn, admin: toAdminAccount(admin) })
}

/** POST /api/admin/auth/refresh */
function handleAdminRefresh({ body }: MockCtx): MockOutcome {
  const rt = String((body as unknown as AdminRefreshReq).refreshToken ?? '')
  const adminId = refreshSessions.get(rt)
  if (!adminId) return expired()
  const { token, expiresIn } = issueToken(adminId)
  return ok({ token, expiresIn })
}

/** GET /api/admin/auth/me —— 校验 token 并拿到当前管理员 */
function handleAdminMe({ headers }: MockCtx): MockOutcome {
  const admin = requireAdmin(headers)
  if (!admin) return expired()
  return ok(toAdminAccount(admin))
}

/** POST /api/admin/auth/logout */
function handleAdminLogout({ headers }: MockCtx): MockOutcome {
  sessions.delete(bearerToken(headers))
  return ok(null)
}

/* ------------------------------------------------------------------ */
/* 5~7 · 客户                                                          */
/* ------------------------------------------------------------------ */

/** GET /api/admin/customers —— 分页 + 关键词 + 状态筛选 */
function handleListCustomers({ query, headers }: MockCtx): MockOutcome {
  const admin = requireAdmin(headers)
  if (!admin) return expired()

  const keyword = (query.keyword ?? '').trim().toLowerCase()
  const status = (query.status ?? '') as CustomerStatus | ''

  let filtered = customers
  if (keyword) {
    // 邀请码也一起搜 —— 后台常要查「这个码被谁用了」
    filtered = filtered.filter(
      (c) =>
        c.email.toLowerCase().includes(keyword) ||
        c.nickname.toLowerCase().includes(keyword) ||
        (c.inviteCode ?? '').toLowerCase().includes(keyword)
    )
  }
  if (status) filtered = filtered.filter((c) => c.status === status)

  return ok(paginate(filtered, query))
}

/** GET /api/admin/customers/{id} —— 详情：客户 + 他的卡 + 他身上的日志 */
function handleGetCustomer({ params, headers }: MockCtx): MockOutcome {
  const admin = requireAdmin(headers)
  if (!admin) return expired()

  const c = customers.find((x) => x.id === Number(params.id))
  if (!c) return fail(ApiCode.NOT_FOUND, '客户不存在')

  const detail: CustomerDetail = {
    ...c,
    usedCard: cards.find((card) => card.usedByCustomerId === c.id) ?? null,
    logs: logs.filter((l) => l.targetType === 'customer' && l.targetId === c.id)
  }
  return ok(detail)
}

/** PATCH /api/admin/customers/{id} —— 封禁 / 解封 / 改额度（每个动作都落一条日志） */
function handleUpdateCustomer({ params, body, headers }: MockCtx): MockOutcome {
  const admin = requireAdmin(headers)
  if (!admin) return expired()

  const target = customers.find((c) => c.id === Number(params.id))
  if (!target) return fail(ApiCode.NOT_FOUND, '客户不存在')

  const req = body as unknown as UpdateCustomerReq
  let changed = false

  if (req.status === 'active' || req.status === 'banned') {
    const next = req.status
    if (next !== target.status) {
      target.status = next
      changed = true
      if (next === 'banned') {
        const reason = String(req.banReason ?? '').trim()
        target.banReason = reason || null
        pushLog({
          adminId: admin.id,
          adminName: admin.nickname,
          action: 'customer.ban',
          targetType: 'customer',
          targetId: target.id,
          targetName: target.nickname,
          detail: reason ? `封禁（${dictLabel('ban_reason', reason)}）` : '封禁'
        })
      } else {
        const had = target.banReason
        target.banReason = null
        pushLog({
          adminId: admin.id,
          adminName: admin.nickname,
          action: 'customer.unban',
          targetType: 'customer',
          targetId: target.id,
          targetName: target.nickname,
          detail: had ? `解封（原因为 ${dictLabel('ban_reason', had)}）` : '解封'
        })
      }
    }
  }

  if (typeof req.quota === 'number') {
    const next = Math.floor(req.quota)
    if (next !== target.quota) {
      const before = target.quota
      target.quota = next
      changed = true
      pushLog({
        adminId: admin.id,
        adminName: admin.nickname,
        action: 'customer.quota',
        targetType: 'customer',
        targetId: target.id,
        targetName: target.nickname,
        detail: `额度 ${before === -1 ? '不限量' : before} → ${next === -1 ? '不限量' : next}`
      })
    }
  }

  if (!changed) return ok(target)
  return ok(target)
}

/* ------------------------------------------------------------------ */
/* 8 · 操作日志（只读）                                                 */
/* ------------------------------------------------------------------ */

/** GET /api/admin/logs */
function handleListLogs({ query, headers }: MockCtx): MockOutcome {
  const admin = requireAdmin(headers)
  if (!admin) return expired()

  const q = query as unknown as LogListQuery
  const action = (q.action ?? '') as LogAction | ''
  const keyword = String(q.keyword ?? '').trim().toLowerCase()
  const from = String(q.from ?? '').trim()
  const to = String(q.to ?? '').trim()

  let filtered = logs
  if (action) filtered = filtered.filter((l) => l.action === action)
  if (keyword) {
    filtered = filtered.filter(
      (l) =>
        l.targetName.toLowerCase().includes(keyword) ||
        l.detail.toLowerCase().includes(keyword) ||
        l.adminName.toLowerCase().includes(keyword)
    )
  }
  if (from) filtered = filtered.filter((l) => localDay(l.createdAt) >= from)
  if (to) filtered = filtered.filter((l) => localDay(l.createdAt) <= to)

  return ok(paginate(filtered, query))
}

/* ------------------------------------------------------------------ */
/* 9~11 · 卡密                                                         */
/* ------------------------------------------------------------------ */

/** GET /api/admin/cards */
function handleListCards({ query, headers }: MockCtx): MockOutcome {
  const admin = requireAdmin(headers)
  if (!admin) return expired()

  const q = query as unknown as CardListQuery
  const keyword = String(q.keyword ?? '').trim().toLowerCase()
  const status = (q.status ?? '') as CardStatus | ''

  let filtered = cards
  if (keyword) {
    filtered = filtered.filter(
      (c) =>
        c.code.toLowerCase().includes(keyword) ||
        (c.usedByEmail ?? '').toLowerCase().includes(keyword) ||
        c.note.toLowerCase().includes(keyword)
    )
  }
  if (status) filtered = filtered.filter((c) => c.status === status)

  // 新的在前面
  filtered = [...filtered].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
  return ok(paginate(filtered, query))
}

/** POST /api/admin/cards —— 批量生成 */
function handleCreateCards({ body, headers }: MockCtx): MockOutcome {
  const admin = requireAdmin(headers)
  if (!admin) return expired()

  const req = body as unknown as CreateCardsReq
  const count = Math.floor(Number(req.count))
  if (!Number.isFinite(count) || count < 1) return fail(ApiCode.INVALID_PARAM, '生成数量至少 1 张')
  if (count > 100) return fail(ApiCode.INVALID_PARAM, '一次最多生成 100 张')

  const exists = new Set(cards.map((c) => c.code))
  const rng = makeRng(Date.now() % 2147483647)
  const now = Date.now()
  const created: InviteCard[] = []

  for (let i = 0; i < count; i++) {
    let code = ''
    do {
      code = `MIMI-${randCode(rng, 4)}-${randCode(rng, 4)}`
    } while (exists.has(code))
    exists.add(code)

    const card: InviteCard = {
      id: cards.reduce((max, c) => Math.max(max, c.id), 0) + i + 1,
      code,
      note: String(req.note ?? '').trim() || '未分类',
      status: 'unused',
      usedByCustomerId: null,
      usedByEmail: null,
      createdAt: new Date(now).toISOString(),
      usedAt: null,
      expireAt:
        req.expireDays === null || req.expireDays === undefined
          ? null
          : new Date(now + Math.floor(Number(req.expireDays)) * DAY).toISOString()
    }
    cards.push(card)
    created.push(card)
  }

  pushLog({
    adminId: admin.id,
    adminName: admin.nickname,
    action: 'card.create',
    targetType: 'card',
    targetId: created[0]?.id ?? null,
    targetName: count === 1 ? created[0].code : `${count} 张`,
    detail: `生成 ${count} 张卡密（${created[0].note}）${
      req.expireDays ? `，${req.expireDays} 天后过期` : '，永久有效'
    }`
  })

  return ok({ created })
}

/** PATCH /api/admin/cards/{id} —— 目前只用于作废 */
function handleUpdateCard({ params, body, headers }: MockCtx): MockOutcome {
  const admin = requireAdmin(headers)
  if (!admin) return expired()

  const card = cards.find((c) => c.id === Number(params.id))
  if (!card) return fail(ApiCode.NOT_FOUND, '卡密不存在')

  const req = body as unknown as UpdateCardReq
  if (req.status !== 'void') return fail(ApiCode.INVALID_PARAM, '目前只能改成作废')
  if (card.status === 'used') return fail(ApiCode.INVALID_PARAM, '已被使用的卡密不能作废')
  if (card.status === 'void') return fail(ApiCode.INVALID_PARAM, '这张卡密已经是作废状态')

  card.status = 'void'
  pushLog({
    adminId: admin.id,
    adminName: admin.nickname,
    action: 'card.void',
    targetType: 'card',
    targetId: card.id,
    targetName: card.code,
    detail: '手动作废'
  })
  return ok(card)
}

/* ------------------------------------------------------------------ */
/* 12~16 · 字典                                                        */
/* ------------------------------------------------------------------ */

/** 查一个值对应的显示名；查不到就把原值原样返回 */
function dictLabel(typeCode: string, value: string): string {
  const t = dicts.find((d) => d.type.code === typeCode)
  return t?.items.find((i) => i.value === value)?.label ?? value
}

/** GET /api/admin/dicts —— 一次把类型和数据项都拿回来 */
function handleListDicts({ headers }: MockCtx): MockOutcome {
  const admin = requireAdmin(headers)
  if (!admin) return expired()
  return ok(
    dicts.map((d) => ({
      type: d.type,
      items: [...d.items].sort((a, b) => a.sort - b.sort)
    }))
  )
}

/** POST /api/admin/dicts —— 新建一个字典类型 */
function handleCreateDictType({ body, headers }: MockCtx): MockOutcome {
  const admin = requireAdmin(headers)
  if (!admin) return expired()

  const req = body as unknown as CreateDictTypeReq
  const code = String(req.code ?? '').trim()
  const name = String(req.name ?? '').trim()
  if (!code || !name) return fail(ApiCode.INVALID_PARAM, '编码和名称都要填')
  if (!/^[a-z][a-z0-9_]{1,30}$/.test(code)) {
    return fail(ApiCode.INVALID_PARAM, '编码只能用小写字母、数字和下划线，且以字母开头')
  }
  if (dicts.some((d) => d.type.code === code)) return fail(ApiCode.INVALID_PARAM, '这个编码已经存在')

  const type: DictType = {
    code,
    name,
    remark: String(req.remark ?? '').trim(),
    createdAt: new Date().toISOString()
  }
  dicts.push({ type, items: [] })
  pushLog({
    adminId: admin.id,
    adminName: admin.nickname,
    action: 'dict.create',
    targetType: 'dict',
    targetId: null,
    targetName: `${name}（${code}）`,
    detail: '新建字典类型'
  })
  return ok({ type, items: [] })
}

/** POST /api/admin/dicts/{code}/items —— 新增数据项 */
function handleCreateDictItem({ params, body, headers }: MockCtx): MockOutcome {
  const admin = requireAdmin(headers)
  if (!admin) return expired()

  const bundle = dicts.find((d) => d.type.code === params.code)
  if (!bundle) return fail(ApiCode.NOT_FOUND, '字典类型不存在')

  const req = body as unknown as CreateDictItemReq
  const label = String(req.label ?? '').trim()
  const value = String(req.value ?? '').trim()
  if (!label || !value) return fail(ApiCode.INVALID_PARAM, '标签和值都要填')
  if (bundle.items.some((i) => i.value === value)) return fail(ApiCode.INVALID_PARAM, '这个值已经存在')

  const item: DictItem = {
    id: dicts.reduce((max, d) => Math.max(max, ...d.items.map((i) => i.id), 0), 0) + 1,
    typeCode: bundle.type.code,
    label,
    value,
    sort: Number.isFinite(Number(req.sort)) && req.sort !== undefined ? Math.floor(Number(req.sort)) : 100,
    enabled: true,
    remark: String(req.remark ?? '').trim()
  }
  bundle.items.push(item)
  pushLog({
    adminId: admin.id,
    adminName: admin.nickname,
    action: 'dict.update',
    targetType: 'dict',
    targetId: item.id,
    targetName: `${bundle.type.name} / ${label}`,
    detail: `新增数据项 ${label}（${value}）`
  })
  return ok(item)
}

/** PATCH /api/admin/dicts/items/{id} */
function handleUpdateDictItem({ params, body, headers }: MockCtx): MockOutcome {
  const admin = requireAdmin(headers)
  if (!admin) return expired()

  const id = Number(params.id)
  let bundle: DictBundle | undefined
  let item: DictItem | undefined
  for (const d of dicts) {
    const found = d.items.find((i) => i.id === id)
    if (found) {
      bundle = d
      item = found
      break
    }
  }
  if (!bundle || !item) return fail(ApiCode.NOT_FOUND, '字典项不存在')

  const req = body as unknown as UpdateDictItemReq
  const changes: string[] = []

  if (typeof req.label === 'string' && req.label.trim() && req.label.trim() !== item.label) {
    changes.push(`标签 ${item.label} → ${req.label.trim()}`)
    item.label = req.label.trim()
  }
  if (typeof req.value === 'string' && req.value.trim() && req.value.trim() !== item.value) {
    if (bundle.items.some((i) => i.id !== item!.id && i.value === req.value!.trim())) {
      return fail(ApiCode.INVALID_PARAM, '这个值已经存在')
    }
    changes.push(`值 ${item.value} → ${req.value.trim()}`)
    item.value = req.value.trim()
  }
  if (typeof req.sort === 'number' && req.sort !== item.sort) {
    changes.push(`排序 ${item.sort} → ${req.sort}`)
    item.sort = req.sort
  }
  if (typeof req.enabled === 'boolean' && req.enabled !== item.enabled) {
    changes.push(req.enabled ? '启用' : '停用')
    item.enabled = req.enabled
  }
  if (typeof req.remark === 'string' && req.remark !== item.remark) {
    item.remark = req.remark
    changes.push('改了备注')
  }

  if (changes.length === 0) return ok(item)

  pushLog({
    adminId: admin.id,
    adminName: admin.nickname,
    action: 'dict.update',
    targetType: 'dict',
    targetId: item.id,
    targetName: `${bundle.type.name} / ${item.label}`,
    detail: changes.join('；')
  })
  return ok(item)
}

/** DELETE /api/admin/dicts/items/{id} */
function handleDeleteDictItem({ params, headers }: MockCtx): MockOutcome {
  const admin = requireAdmin(headers)
  if (!admin) return expired()

  const id = Number(params.id)
  for (const d of dicts) {
    const idx = d.items.findIndex((i) => i.id === id)
    if (idx < 0) continue

    const [removed] = d.items.splice(idx, 1)
    pushLog({
      adminId: admin.id,
      adminName: admin.nickname,
      action: 'dict.delete',
      targetType: 'dict',
      targetId: removed.id,
      targetName: `${d.type.name} / ${removed.label}`,
      detail: `删除数据项 ${removed.label}（${removed.value}）`
    })
    return ok(null)
  }
  return fail(ApiCode.NOT_FOUND, '字典项不存在')
}

/* ------------------------------------------------------------------ */
/* 路由表                                                              */
/* ------------------------------------------------------------------ */

const routes: Array<{ method: string; pattern: string; handler: MockHandler }> = [
  { method: 'POST', pattern: '/admin/auth/login', handler: handleAdminLogin },
  { method: 'POST', pattern: '/admin/auth/refresh', handler: handleAdminRefresh },
  { method: 'GET', pattern: '/admin/auth/me', handler: handleAdminMe },
  { method: 'POST', pattern: '/admin/auth/logout', handler: handleAdminLogout },

  { method: 'GET', pattern: '/admin/customers', handler: handleListCustomers },
  { method: 'GET', pattern: '/admin/customers/:id', handler: handleGetCustomer },
  { method: 'PATCH', pattern: '/admin/customers/:id', handler: handleUpdateCustomer },

  { method: 'GET', pattern: '/admin/logs', handler: handleListLogs },

  { method: 'GET', pattern: '/admin/cards', handler: handleListCards },
  { method: 'POST', pattern: '/admin/cards', handler: handleCreateCards },
  { method: 'PATCH', pattern: '/admin/cards/:id', handler: handleUpdateCard },

  { method: 'GET', pattern: '/admin/dicts', handler: handleListDicts },
  { method: 'POST', pattern: '/admin/dicts', handler: handleCreateDictType },
  // 注意：这两条靠段位区分，`items` 是字面量、`:code` 是通配，不会互相吃掉
  { method: 'PATCH', pattern: '/admin/dicts/items/:id', handler: handleUpdateDictItem },
  { method: 'DELETE', pattern: '/admin/dicts/items/:id', handler: handleDeleteDictItem },
  { method: 'POST', pattern: '/admin/dicts/:code/items', handler: handleCreateDictItem }
]

function matchPath(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split('/').filter(Boolean)
  const a = path.split('/').filter(Boolean)
  if (p.length !== a.length) return null

  const params: Record<string, string> = {}
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(':')) params[p[i].slice(1)] = decodeURIComponent(a[i])
    else if (p[i] !== a[i]) return null
  }
  return params
}

/* ------------------------------------------------------------------ */
/* adapter                                                             */
/* ------------------------------------------------------------------ */

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export const mockAdapter: AxiosAdapter = async (config) => {
  await sleep(160 + Math.random() * 240)

  const method = (config.method ?? 'get').toUpperCase()

  // ⚠️ 自定义 adapter 得自己把 params 拼成 query string ——
  // 平时这件事是 axios 内置 adapter 做的，绕开它就得自己来，否则筛选条件会全部丢失
  const params = (config.params ?? {}) as Record<string, unknown>
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    search.set(key, String(value))
  }
  const queryString = search.toString()

  const url = new URL(
    `${config.baseURL ?? ''}${config.url ?? ''}${queryString ? `?${queryString}` : ''}`,
    'http://mock.local'
  )
  const path = url.pathname.replace(/^\/api/, '') || '/'

  const query: Record<string, string> = {}
  url.searchParams.forEach((value, key) => {
    query[key] = value
  })

  const headers: Record<string, string> = {}
  const rawHeaders = config.headers as unknown as Record<string, unknown> | undefined
  if (rawHeaders) {
    for (const key of Object.keys(rawHeaders)) {
      const value = rawHeaders[key]
      if (typeof value === 'string') headers[key.toLowerCase()] = value
    }
  }

  let body: Record<string, unknown> = {}
  if (typeof config.data === 'string' && config.data) {
    try {
      body = JSON.parse(config.data) as Record<string, unknown>
    } catch {
      body = {}
    }
  } else if (config.data && typeof config.data === 'object') {
    body = config.data as Record<string, unknown>
  }

  const requestConfig = config as InternalAxiosRequestConfig

  for (const route of routes) {
    if (route.method !== method) continue
    const paramsMatched = matchPath(route.pattern, path)
    if (!paramsMatched) continue

    const outcome = route.handler({ params: paramsMatched, query, body, headers })
    const status = outcome.httpStatus ?? 200
    return {
      data: { code: outcome.code, message: outcome.message ?? 'ok', data: outcome.data ?? null },
      status,
      statusText: status === 200 ? 'OK' : 'Error',
      headers: {},
      config: requestConfig
    } as AxiosResponse
  }

  return {
    data: {
      code: ApiCode.NOT_FOUND,
      message: `mock 还没实现这个接口：${method} ${path}`,
      data: null
    },
    status: 200,
    statusText: 'OK',
    headers: {},
    config: requestConfig
  } as AxiosResponse
}
