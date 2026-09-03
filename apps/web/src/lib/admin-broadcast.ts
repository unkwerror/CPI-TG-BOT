'use client';

import { api } from './api';

export type AdminBroadcastEntityType = 'event' | 'feed_post' | 'product';

export interface AdminBroadcastResult {
  broadcastId: string;
  type: string;
  status: 'queued';
  recipientCount: number;
}

function newIdempotencyKey(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `broadcast-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export async function enqueueAdminBroadcast(
  entityType: AdminBroadcastEntityType,
  entityId: string,
): Promise<AdminBroadcastResult> {
  return api<AdminBroadcastResult>('/admin/broadcasts', {
    method: 'POST',
    headers: { 'Idempotency-Key': newIdempotencyKey() },
    body: JSON.stringify({ entityType, entityId }),
  });
}

export function adminBroadcastQueuedMessage(title: string, result: AdminBroadcastResult): string {
  return `Рассылка «${title}» поставлена в очередь. Получателей: ${result.recipientCount}.`;
}
