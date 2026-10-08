/**
 * 卡密 / 激活码 —— 对应 src/types/admin.ts 的 9~11 号契约
 *
 * 卡密就是客户注册时填的那个邀请码。客户填了码注册 → 这张卡变成「已使用」，
 * 并记下是被谁用的。
 */

import { request } from './request'
import type {
  CardListQuery,
  CardListRes,
  CreateCardsReq,
  CreateCardsRes,
  InviteCard
} from '@/types'

/** 9. 卡密列表（分页 + 状态 + 关键词） */
export function fetchCards(query: CardListQuery): Promise<CardListRes> {
  return request<CardListRes>({
    url: '/admin/cards',
    method: 'get',
    params: query
  })
}

/** 10. 批量生成。返回本次生成的卡密，前端直接给用户复制 */
export function createCards(payload: CreateCardsReq): Promise<CreateCardsRes> {
  return request<CreateCardsRes>({
    url: '/admin/cards',
    method: 'post',
    data: payload
  })
}

/** 11. 作废。已被使用的卡密后端会拒绝 */
export function voidCard(id: number): Promise<InviteCard> {
  return request<InviteCard>({
    url: `/admin/cards/${id}`,
    method: 'patch',
    data: { status: 'void' }
  })
}
