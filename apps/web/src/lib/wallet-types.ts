export type WalletTransactionKind =
  | 'welcome_grant'
  | 'p2p_transfer'
  | 'staff_credit'
  | 'staff_debit'
  | 'artifact_reward'
  | 'leader_id_subscription_reward'
  | 'store_purchase'
  | 'admin_adjustment'
  | 'season_opening'
  | 'reversal';

export type WalletTransactionStatus = 'pending' | 'completed' | 'reversed' | 'failed';

export interface WalletSummary {
  program: {
    id: string;
    code: string;
    walletTitle: string;
    unitOne: string;
    unitFew: string;
    unitMany: string;
    symbol: string | null;
    iconUrl: string | null;
    p2pEnabled: boolean;
    storeEnabled: boolean;
    maxTransactionAmount: string;
  };
  season: { id: string; code: string; title: string } | null;
  account: { id: string; balance: string; status: 'active' | 'frozen' | 'closed' };
}

export interface WalletTransaction {
  entryId: string;
  transactionId: string;
  kind: WalletTransactionKind;
  delta: string;
  balanceAfter: string;
  reason: string | null;
  createdAt: string;
  counterpart?: {
    id?: string | null;
    displayName: string;
    username?: string | null;
    avatarUrl?: string | null;
  } | null;
  actor?: {
    id: string;
    displayName: string;
    username?: string | null;
    avatarUrl?: string | null;
  } | null;
  eventId?: string | null;
  orderId?: string | null;
}

export interface WalletFeedItem {
  id: string;
  source?: 'post' | 'event' | 'product' | 'personal';
  kind: 'news' | 'event' | 'product' | 'system';
  title: string;
  summary: string | null;
  body?: string;
  bodyFormat?: 'text' | 'html';
  cardHtml?: string | null;
  cardPackageId?: string | null;
  publishedAt: string;
  imageUrl?: string | null;
  actionLabel?: string | null;
  actionUrl?: string | null;
  eventId?: string | null;
  productId?: string | null;
  pinned?: boolean;
}

export interface WalletProduct {
  id: string;
  categoryId?: string | null;
  slug?: string;
  title: string;
  description: string | null;
  descriptionFormat?: 'text' | 'html';
  cardHtml?: string | null;
  cardPackageId?: string | null;
  category?: { id: string; slug: string; title: string } | null;
  kind?: 'physical' | 'digital';
  price: string;
  stock?: number | null;
  available?: number | null;
  stockMode?: 'limited' | 'unlimited';
  perUserLimit?: number | null;
  availableFrom?: string | null;
  availableUntil?: string | null;
  pickupInstructions?: string | null;
  coverUrl?: string | null;
  imageUrl?: string | null;
  media?: Array<{
    id: string;
    productId: string;
    url: string;
    objectKey?: string | null;
    altText: string | null;
    sortOrder: number;
  }>;
  status: 'draft' | 'published' | 'paused' | 'archived';
}

export interface WalletOrder {
  id: string;
  productId: string;
  productTitle: string;
  amount: string;
  totalPoints?: string;
  status: 'paid' | 'pickup_requested' | 'ready_for_pickup' | 'fulfilled';
  createdAt: string;
  comment?: string | null;
  pickupCode?: string | null;
  items?: Array<{ productId: string; productTitle: string; quantity: number; amount: string }>;
}

export interface WalletQrSession {
  id: string;
  token: string;
  expiresAt: string;
  capabilities: Array<'p2p_transfer' | 'staff_credit' | 'staff_debit'>;
}

export interface WalletResolvedQr {
  sessionId: string;
  owner: { id: string; displayName: string; username?: string | null; avatarUrl?: string | null };
  capabilities: Array<'p2p_transfer' | 'staff_credit' | 'staff_debit'>;
  expiresAt: string;
}

export interface WalletIntent {
  id: string;
  kind: 'p2p_transfer' | 'staff_credit' | 'staff_debit';
  amount: string;
  status:
    | 'created'
    | 'awaiting_initiator_confirmation'
    | 'awaiting_owner_confirmation'
    | 'completed'
    | 'rejected'
    | 'cancelled'
    | 'expired';
  counterparty?: { displayName: string; avatarUrl?: string | null };
  initiator?: {
    id: string;
    displayName: string;
    username?: string | null;
    avatarUrl?: string | null;
  } | null;
  owner?: {
    id: string;
    displayName: string;
    username?: string | null;
    avatarUrl?: string | null;
  } | null;
  reason?: string | null;
  expiresAt: string;
}

export interface PaginatedWalletResponse<T> {
  items: T[];
  nextCursor?: string | null;
}

export interface WalletHistoryResponse {
  items: WalletTransaction[];
  nextBeforeId?: string | null;
}
