/**
 * Mock 自测 —— 把 src/mock 单独 bundle 出来后，直接调用它的 adapter，
 * 用真实数据把后台侧每个接口都跑一遍（含各种错误分支）。
 *
 * 跑法：npm run smoke
 *
 * 改动 src/mock 或 src/types 之后跑一下，几秒钟就能知道有没有把接口改坏。
 * 不需要后端、不需要浏览器。
 */

import { build } from 'esbuild'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { rm } from 'node:fs/promises'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const bundlePath = resolve(root, '.mock-bundle.mjs')

await build({
  entryPoints: [resolve(root, 'src/mock/index.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: bundlePath,
  logLevel: 'warning'
})

const { mockAdapter } = await import(pathToFileURL(bundlePath).href)

const call = (config) =>
  mockAdapter({
    baseURL: '/api',
    headers: {},
    ...config,
    data: config.body ? JSON.stringify(config.body) : undefined
  })

const auth = (token) => ({ authorization: `Bearer ${token}` })

let pass = 0
let fail = 0

function check(label, condition, detail = '') {
  if (condition) {
    pass += 1
    console.log(`  ok   ${label}`)
  } else {
    fail += 1
    console.log(`  FAIL ${label} ${detail}`)
  }
}

try {
  console.log('\n[管理员登录]')
  let token = ''
  {
    const bad = await call({ url: '/admin/auth/login', method: 'post', body: { username: 'admin', password: 'wrong' } })
    check('密码错 → code 1005', bad.data.code === 1005, JSON.stringify(bad.data))

    const ghost = await call({ url: '/admin/auth/login', method: 'post', body: { username: 'nobody', password: 'whatever' } })
    check('不存在的账号 → 1005，且不会自动建号', ghost.data.code === 1005, JSON.stringify(ghost.data))

    const empty = await call({ url: '/admin/auth/login', method: 'post', body: { username: '', password: '' } })
    check('空参数 → 1001', empty.data.code === 1001, JSON.stringify(empty.data))

    const ok = await call({ url: '/admin/auth/login', method: 'post', body: { username: 'admin', password: 'admin123' } })
    check('正确账号密码 → code 0', ok.data.code === 0, JSON.stringify(ok.data).slice(0, 120))
    check('返回 admin 对象', ok.data.data?.admin?.username === 'admin')
    check('不返回密码字段', ok.data.data?.admin?.password === undefined)
    token = ok.data.data?.token ?? ''
  }

  console.log('\n[token 校验]')
  {
    const me = await call({ url: '/admin/auth/me', method: 'get', headers: auth(token) })
    check('带 token → code 0', me.data.code === 0, JSON.stringify(me.data).slice(0, 120))

    const noToken = await call({ url: '/admin/auth/me', method: 'get' })
    check('没带 token → HTTP 401', noToken.status === 401, `got ${noToken.status}`)
    check('code = 40101', noToken.data.code === 40101, JSON.stringify(noToken.data))
  }

  console.log('\n[客户列表]')
  {
    const all = await call({ url: '/admin/customers', method: 'get', params: { page: 1, pageSize: 10 }, headers: auth(token) })
    check('code 0', all.data.code === 0, JSON.stringify(all.data).slice(0, 120))
    check('total = 26', all.data.data?.total === 26, `got ${all.data.data?.total}`)
    check('pageSize 生效', all.data.data?.list?.length === 10, `got ${all.data.data?.list?.length}`)

    const p2 = await call({ url: '/admin/customers', method: 'get', params: { page: 2, pageSize: 10 }, headers: auth(token) })
    check('第 2 页内容不同', p2.data.data?.list?.[0]?.id !== all.data.data?.list?.[0]?.id)

    const banned = await call({ url: '/admin/customers', method: 'get', params: { page: 1, pageSize: 100, status: 'banned' }, headers: auth(token) })
    check('status 筛选生效', banned.data.data?.total < all.data.data?.total, `${all.data.data?.total} → ${banned.data.data?.total}`)
    check('筛出来都是 banned', banned.data.data?.list?.every((c) => c.status === 'banned'))

    const emptyStatus = await call({ url: '/admin/customers', method: 'get', params: { page: 1, pageSize: 100, status: '' }, headers: auth(token) })
    check('空 status 不当筛选', emptyStatus.data.data?.total === 26, `got ${emptyStatus.data.data?.total}`)

    const byEmail = await call({ url: '/admin/customers', method: 'get', params: { page: 1, pageSize: 100, keyword: 'user00' }, headers: auth(token) })
    check('按邮箱搜', byEmail.data.data?.total >= 5, `got ${byEmail.data.data?.total}`)

    const byCode = await call({ url: '/admin/customers', method: 'get', params: { page: 1, pageSize: 100, keyword: 'demo' }, headers: auth(token) })
    check('按邀请码搜', byCode.data.data?.total >= 1, `got ${byCode.data.data?.total}`)

    const noAuth = await call({ url: '/admin/customers', method: 'get', params: { page: 1, pageSize: 10 } })
    check('列表也要鉴权 → 401', noAuth.status === 401, `got ${noAuth.status}`)
  }

  console.log('\n[改客户]')
  {
    const q = await call({ url: '/admin/customers', method: 'get', params: { page: 1, pageSize: 100 }, headers: auth(token) })
    const target = q.data.data.list.find((c) => c.status === 'active')

    const quota = await call({ url: `/admin/customers/${target.id}`, method: 'patch', body: { quota: 42 }, headers: auth(token) })
    check('改额度生效', quota.data.data?.quota === 42, JSON.stringify(quota.data).slice(0, 120))

    const ban = await call({ url: `/admin/customers/${target.id}`, method: 'patch', body: { status: 'banned' }, headers: auth(token) })
    check('封禁生效', ban.data.data?.status === 'banned')

    const missing = await call({ url: '/admin/customers/99999', method: 'patch', body: { quota: 1 }, headers: auth(token) })
    check('不存在的客户 → 40400', missing.data.code === 40400, JSON.stringify(missing.data))
  }

  console.log('\n[客户详情]')
  {
    const q = await call({ url: '/admin/customers', method: 'get', params: { page: 1, pageSize: 100 }, headers: auth(token) })
    const withCard = q.data.data.list.find((c) => c.inviteCode !== null)
    const withoutCard = q.data.data.list.find((c) => c.inviteCode === null)

    const d = await call({ url: `/admin/customers/${withCard.id}`, method: 'get', headers: auth(token) })
    check('code 0', d.data.code === 0, JSON.stringify(d.data).slice(0, 120))
    check('带回客户本体', d.data.data?.id === withCard.id)
    check('带回邀请码来源卡', d.data.data?.usedCard?.code === withCard.inviteCode, JSON.stringify(d.data.data?.usedCard))
    check('卡的 usedByCustomerId 对得上', d.data.data?.usedCard?.usedByCustomerId === withCard.id)
    check('带回日志数组', Array.isArray(d.data.data?.logs))
    check('日志只包含这个客户的', d.data.data?.logs?.every((l) => l.targetType === 'customer' && l.targetId === withCard.id))

    const noCard = await call({ url: `/admin/customers/${withoutCard.id}`, method: 'get', headers: auth(token) })
    check('邮箱直注的客户 usedCard = null', noCard.data.data?.usedCard === null, JSON.stringify(noCard.data.data?.usedCard))

    const ghost = await call({ url: '/admin/customers/99999', method: 'get', headers: auth(token) })
    check('不存在的客户 → 40400', ghost.data.code === 40400, JSON.stringify(ghost.data))
  }

  console.log('\n[操作日志]')
  let logTotal = 0
  {
    const all = await call({ url: '/admin/logs', method: 'get', params: { page: 1, pageSize: 20 }, headers: auth(token) })
    check('code 0', all.data.code === 0, JSON.stringify(all.data).slice(0, 120))
    check('有种子日志', all.data.data?.total > 0, `got ${all.data.data?.total}`)
    logTotal = all.data.data?.total ?? 0

    const first = all.data.data?.list?.[0]
    check('最近的排最前', first?.id === logTotal, `id=${first?.id} total=${logTotal}`)
    check('日志字段齐全', Boolean(first?.adminName && first?.action && first?.targetType && first?.createdAt && first?.ip))

    const bans = await call({ url: '/admin/logs', method: 'get', params: { page: 1, pageSize: 100, action: 'customer.ban' }, headers: auth(token) })
    check('按动作筛选生效', bans.data.data?.total > 0 && bans.data.data?.total < logTotal, `${logTotal} → ${bans.data.data?.total}`)
    check('筛出来都是封禁', bans.data.data?.list?.every((l) => l.action === 'customer.ban'))

    const kw = await call({ url: '/admin/logs', method: 'get', params: { page: 1, pageSize: 100, keyword: '封禁' }, headers: auth(token) })
    check('关键词能搜 detail', kw.data.data?.total > 0, `got ${kw.data.data?.total}`)

    const wide = await call({ url: '/admin/logs', method: 'get', params: { page: 1, pageSize: 1, from: '2000-01-01' }, headers: auth(token) })
    check('时间下界早于全部 → 不减', wide.data.data?.total === logTotal, `${logTotal} → ${wide.data.data?.total}`)

    const narrow = await call({ url: '/admin/logs', method: 'get', params: { page: 1, pageSize: 1, to: '2000-01-01' }, headers: auth(token) })
    check('时间上界早于全部 → 空', narrow.data.data?.total === 0, `got ${narrow.data.data?.total}`)

    const noAuth = await call({ url: '/admin/logs', method: 'get', params: { page: 1, pageSize: 10 } })
    check('日志也要鉴权 → 401', noAuth.status === 401, `got ${noAuth.status}`)
  }

  console.log('\n[⭐ 做动作要真的落日志]')
  {
    const q = await call({ url: '/admin/customers', method: 'get', params: { page: 1, pageSize: 100 }, headers: auth(token) })
    const target = q.data.data.list.find((c) => c.status === 'active')
    const beforeDetail = await call({ url: `/admin/customers/${target.id}`, method: 'get', headers: auth(token) })
    const beforeCount = beforeDetail.data.data.logs.length

    // 封禁：带上原因
    await call({ url: `/admin/customers/${target.id}`, method: 'patch', body: { status: 'banned', banReason: 'spam' }, headers: auth(token) })

    const after = await call({ url: '/admin/logs', method: 'get', params: { page: 1, pageSize: 5 }, headers: auth(token) })
    check('封禁后日志 total +1', after.data.data.total === logTotal + 1, `${logTotal} → ${after.data.data.total}`)
    const newest = after.data.data.list[0]
    check('最新一条是封禁', newest.action === 'customer.ban', newest.action)
    check('记到了正确的客户', newest.targetId === target.id && newest.targetName === target.nickname, JSON.stringify(newest))
    check('原因写进了 detail', String(newest.detail).includes('刷屏'), newest.detail)

    const midDetail = await call({ url: `/admin/customers/${target.id}`, method: 'get', headers: auth(token) })
    check('详情里的日志也 +1', midDetail.data.data.logs.length === beforeCount + 1, `${beforeCount} → ${midDetail.data.data.logs.length}`)
    check('封禁原因存到了客户身上', midDetail.data.data.banReason === 'spam', String(midDetail.data.data.banReason))

    // 改额度
    await call({ url: `/admin/customers/${target.id}`, method: 'patch', body: { quota: 777 }, headers: auth(token) })
    const afterQuota = await call({ url: '/admin/logs', method: 'get', params: { page: 1, pageSize: 5 }, headers: auth(token) })
    check('改额度后日志 total +1', afterQuota.data.data.total === logTotal + 2, `got ${afterQuota.data.data.total}`)
    check('额度日志带前后值', afterQuota.data.data.list[0].action === 'customer.quota' && String(afterQuota.data.data.list[0].detail).includes('777'), afterQuota.data.data.list[0].detail)

    // 值没变 → 不该产生日志（避免刷屏式日志）
    await call({ url: `/admin/customers/${target.id}`, method: 'patch', body: { quota: 777 }, headers: auth(token) })
    const same = await call({ url: '/admin/logs', method: 'get', params: { page: 1, pageSize: 5 }, headers: auth(token) })
    check('值没变就不写日志', same.data.data.total === logTotal + 2, `got ${same.data.data.total}`)

    // 解封
    await call({ url: `/admin/customers/${target.id}`, method: 'patch', body: { status: 'active' }, headers: auth(token) })
    const finalLogs = await call({ url: '/admin/logs', method: 'get', params: { page: 1, pageSize: 5 }, headers: auth(token) })
    check('解封也有日志', finalLogs.data.data.list[0].action === 'customer.unban', finalLogs.data.data.list[0].action)
    const cleared = await call({ url: `/admin/customers/${target.id}`, method: 'get', headers: auth(token) })
    check('解封后原因清空', cleared.data.data.banReason === null, String(cleared.data.data.banReason))
    logTotal = finalLogs.data.data.total
  }

  console.log('\n[卡密]')
  {
    const all = await call({ url: '/admin/cards', method: 'get', params: { page: 1, pageSize: 10 }, headers: auth(token) })
    check('code 0', all.data.code === 0, JSON.stringify(all.data).slice(0, 120))
    const cardTotal = all.data.data?.total ?? 0
    check('有种子卡密', cardTotal > 0, `got ${cardTotal}`)

    const used = await call({ url: '/admin/cards', method: 'get', params: { page: 1, pageSize: 100, status: 'used' }, headers: auth(token) })
    check('状态筛选生效', used.data.data?.total > 0 && used.data.data?.total < cardTotal, `got ${used.data.data?.total}`)
    check('已使用的都有使用者', used.data.data?.list?.every((c) => c.status === 'used' && c.usedByEmail && c.usedAt))

    const byMail = await call({ url: '/admin/cards', method: 'get', params: { page: 1, pageSize: 100, keyword: 'user01' }, headers: auth(token) })
    check('按使用者邮箱搜', byMail.data.data?.total >= 1, `got ${byMail.data.data?.total}`)

    const byNote = await call({ url: '/admin/cards', method: 'get', params: { page: 1, pageSize: 100, keyword: '内部测试' }, headers: auth(token) })
    check('按备注搜', byNote.data.data?.total >= 1, `got ${byNote.data.data?.total}`)

    const noAuth = await call({ url: '/admin/cards', method: 'get', params: { page: 1, pageSize: 10 } })
    check('卡密也要鉴权 → 401', noAuth.status === 401, `got ${noAuth.status}`)

    // 批量生成
    const gen = await call({ url: '/admin/cards', method: 'post', body: { count: 3, expireDays: 90, note: '付费购买' }, headers: auth(token) })
    check('生成 3 张 → code 0', gen.data.code === 0, JSON.stringify(gen.data).slice(0, 120))
    check('返回 3 张卡密', gen.data.data?.created?.length === 3, `got ${gen.data.data?.created?.length}`)
    const codes = gen.data.data?.created?.map((c) => c.code) ?? []
    check('卡密不重复', new Set(codes).size === 3)
    check('卡密格式 MIMI-XXXX-XXXX', codes.every((c) => /^MIMI-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(c)), codes[0])
    check('新卡都是未使用', gen.data.data?.created?.every((c) => c.status === 'unused' && c.usedByEmail === null))
    check('有效期按天数算出来了', Boolean(gen.data.data?.created?.[0]?.expireAt))

    const afterGen = await call({ url: '/admin/cards', method: 'get', params: { page: 1, pageSize: 10 }, headers: auth(token) })
    check('列表 total +3', afterGen.data.data?.total === cardTotal + 3, `${cardTotal} → ${afterGen.data.data?.total}`)

    const genLog = await call({ url: '/admin/logs', method: 'get', params: { page: 1, pageSize: 5 }, headers: auth(token) })
    check('生成卡密也落日志', genLog.data.data.list[0].action === 'card.create' && String(genLog.data.data.list[0].detail).includes('3 张'), genLog.data.data.list[0].detail)

    const tooMany = await call({ url: '/admin/cards', method: 'post', body: { count: 101, expireDays: null, note: '测试' }, headers: auth(token) })
    check('超过 100 张 → 1001', tooMany.data.code === 1001, JSON.stringify(tooMany.data))

    const zero = await call({ url: '/admin/cards', method: 'post', body: { count: 0, expireDays: null }, headers: auth(token) })
    check('0 张 → 1001', zero.data.code === 1001, JSON.stringify(zero.data))

    // 作废
    const fresh = gen.data.data.created[0]
    const voided = await call({ url: `/admin/cards/${fresh.id}`, method: 'patch', body: { status: 'void' }, headers: auth(token) })
    check('作废未使用的卡 → 0', voided.data.code === 0 && voided.data.data?.status === 'void', JSON.stringify(voided.data).slice(0, 120))

    const again = await call({ url: `/admin/cards/${fresh.id}`, method: 'patch', body: { status: 'void' }, headers: auth(token) })
    check('重复作废 → 1001', again.data.code === 1001, JSON.stringify(again.data))

    const usedCard = used.data.data.list[0]
    const voidUsed = await call({ url: `/admin/cards/${usedCard.id}`, method: 'patch', body: { status: 'void' }, headers: auth(token) })
    check('已使用的卡不能作废 → 1001', voidUsed.data.code === 1001, JSON.stringify(voidUsed.data))

    const ghostCard = await call({ url: '/admin/cards/999999', method: 'patch', body: { status: 'void' }, headers: auth(token) })
    check('不存在的卡 → 40400', ghostCard.data.code === 40400, JSON.stringify(ghostCard.data))
  }

  console.log('\n[字典]')
  let banReasonId = 0
  {
    const all = await call({ url: '/admin/dicts', method: 'get', headers: auth(token) })
    check('code 0', all.data.code === 0, JSON.stringify(all.data).slice(0, 120))
    const list = all.data.data ?? []
    check('有 4 个字典类型', list.length === 4, `got ${list.length}`)
    check('每个类型都有数据项', list.every((b) => b.items.length > 0))

    const ban = list.find((b) => b.type.code === 'ban_reason')
    check('有 ban_reason', Boolean(ban))
    check('ban_reason 有 5 项', ban?.items.length === 5, `got ${ban?.items.length}`)
    check('数据项字段齐全', Boolean(ban?.items[0]?.label && ban?.items[0]?.value && ban?.items[0]?.typeCode === 'ban_reason'))

    const noAuth = await call({ url: '/admin/dicts', method: 'get' })
    check('字典也要鉴权 → 401', noAuth.status === 401, `got ${noAuth.status}`)

    // 新增数据项
    const added = await call({ url: '/admin/dicts/ban_reason/items', method: 'post', body: { label: '恶意退款', value: 'refund_abuse', sort: 60, remark: '反复刷退款' }, headers: auth(token) })
    check('新增字典项 → 0', added.data.code === 0, JSON.stringify(added.data).slice(0, 120))
    banReasonId = added.data.data?.id ?? 0
    check('默认是启用状态', added.data.data?.enabled === true)

    const dup = await call({ url: '/admin/dicts/ban_reason/items', method: 'post', body: { label: '重复', value: 'spam' }, headers: auth(token) })
    check('值重复 → 1001', dup.data.code === 1001, JSON.stringify(dup.data))

    const blank = await call({ url: '/admin/dicts/ban_reason/items', method: 'post', body: { label: '', value: '' }, headers: auth(token) })
    check('标签值为空 → 1001', blank.data.code === 1001, JSON.stringify(blank.data))

    const ghostType = await call({ url: '/admin/dicts/nope/items', method: 'post', body: { label: 'x', value: 'y' }, headers: auth(token) })
    check('类型不存在 → 40400', ghostType.data.code === 40400, JSON.stringify(ghostType.data))

    // 改动
    const renamed = await call({ url: `/admin/dicts/items/${banReasonId}`, method: 'patch', body: { label: '恶意退款刷单' }, headers: auth(token) })
    check('改标签 → 0', renamed.data.code === 0 && renamed.data.data?.label === '恶意退款刷单', JSON.stringify(renamed.data).slice(0, 120))

    const off = await call({ url: `/admin/dicts/items/${banReasonId}`, method: 'patch', body: { enabled: false }, headers: auth(token) })
    check('停用 → enabled false', off.data.data?.enabled === false)

    const dictLog = await call({ url: '/admin/logs', method: 'get', params: { page: 1, pageSize: 5 }, headers: auth(token) })
    check('改字典也落日志', dictLog.data.data.list[0].action === 'dict.update', dictLog.data.data.list[0].action)

    const ghostItem = await call({ url: '/admin/dicts/items/999999', method: 'patch', body: { label: 'x' }, headers: auth(token) })
    check('字典项不存在 → 40400', ghostItem.data.code === 40400, JSON.stringify(ghostItem.data))

    // 新建类型
    const newType = await call({ url: '/admin/dicts', method: 'post', body: { code: 'refund_reason', name: '退款原因', remark: '测试' }, headers: auth(token) })
    check('新建字典类型 → 0', newType.data.code === 0, JSON.stringify(newType.data).slice(0, 120))

    const dupType = await call({ url: '/admin/dicts', method: 'post', body: { code: 'ban_reason', name: '重复' }, headers: auth(token) })
    check('编码重复 → 1001', dupType.data.code === 1001, JSON.stringify(dupType.data))

    const badCode = await call({ url: '/admin/dicts', method: 'post', body: { code: 'Bad Code!', name: 'x' }, headers: auth(token) })
    check('编码格式非法 → 1001', badCode.data.code === 1001, JSON.stringify(badCode.data))

    // 删除
    const del = await call({ url: `/admin/dicts/items/${banReasonId}`, method: 'delete', headers: auth(token) })
    check('删除字典项 → 0', del.data.code === 0, JSON.stringify(del.data).slice(0, 120))

    const delAgain = await call({ url: `/admin/dicts/items/${banReasonId}`, method: 'delete', headers: auth(token) })
    check('删不存在的 → 40400', delAgain.data.code === 40400, JSON.stringify(delAgain.data))

    const after = await call({ url: '/admin/dicts', method: 'get', headers: auth(token) })
    const back = after.data.data.find((b) => b.type.code === 'ban_reason')
    check('删完回到 5 项', back?.items.length === 5, `got ${back?.items.length}`)
  }

  console.log('\n[refresh / logout]')
  {
    const login = await call({ url: '/admin/auth/login', method: 'post', body: { username: 'admin', password: 'admin123' } })
    const rt = login.data.data?.refreshToken ?? ''
    const refreshed = await call({ url: '/admin/auth/refresh', method: 'post', body: { refreshToken: rt } })
    check('refresh 换到新 token', refreshed.data.code === 0 && typeof refreshed.data.data?.token === 'string', JSON.stringify(refreshed.data).slice(0, 120))

    const fake = await call({ url: '/admin/auth/refresh', method: 'post', body: { refreshToken: 'garbage' } })
    check('假 refreshToken → 401', fake.status === 401, `got ${fake.status}`)

    const t = login.data.data?.token ?? ''
    await call({ url: '/admin/auth/logout', method: 'post', headers: auth(t) })
    const after = await call({ url: '/admin/auth/me', method: 'get', headers: auth(t) })
    check('登出后 token 失效', after.status === 401, `got ${after.status}`)
  }

  console.log('\n[未实现的路径]')
  {
    const r = await call({ url: '/nope/whatever', method: 'get' })
    check('明确点名路径', r.data.code === 40400 && String(r.data.message).includes('/nope/whatever'), r.data.message)
  }
} finally {
  await rm(bundlePath, { force: true })
}

console.log(`\n===== ${pass} 通过 / ${fail} 失败 =====\n`)
process.exit(fail === 0 ? 0 : 1)
