export type MaxUpdate =
  | {
      update_type: 'bot_started';
      timestamp: number;
      chat_id: number;
      payload?: string | null;
      user: MaxUser;
    }
  | {
      update_type: 'message_created';
      timestamp: number;
      message: MaxMessage;
    }
  | {
      update_type: 'message_callback';
      timestamp: number;
      callback: {
        timestamp: number;
        callback_id: string;
        payload?: string;
        user: MaxUser;
      };
      message?: MaxMessage | null;
    }
  | {
      update_type: 'bot_stopped';
      timestamp: number;
      user: MaxUser;
      chat_id?: number;
    };

export interface MaxUser {
  user_id: number;
  first_name: string;
  last_name?: string | null;
  /** @deprecated Kept only for compatibility with older MAX webhook payloads. */
  name?: string | null;
  username?: string | null;
  is_bot: boolean;
  last_activity_time?: number;
}

export interface MaxMessage {
  sender?: MaxUser | null;
  recipient: { chat_id: number | null; chat_type: string };
  timestamp: number;
  body: {
    mid: string;
    seq: number;
    text: string | null;
    attachments: Array<{
      type: string;
      payload?: Record<string, unknown>;
    }> | null;
  };
}

export class MaxApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'MaxApiError';
  }
}

type MaxButton =
  | { type: 'open_app'; text: string; web_app?: string; payload?: string }
  | { type: 'link'; text: string; url: string }
  | { type: 'callback'; text: string; payload: string; intent?: string }
  | { type: 'request_contact'; text: string };

interface MaxMessageResponse {
  message: MaxMessage;
}

export class MaxClient {
  constructor(
    private readonly token: string,
    private readonly baseUrl: string,
  ) {}

  private async request<T>(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    const response = await fetch(new URL(path, `${this.baseUrl.replace(/\/+$/u, '')}/`), {
      method: init.method ?? 'GET',
      headers: {
        authorization: this.token,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(20_000),
    });
    const payload = (await response.json().catch(() => null)) as T | { message?: string } | null;
    if (!response.ok) {
      const message =
        payload && typeof payload === 'object' && 'message' in payload ? payload.message : null;
      throw new MaxApiError(
        response.status,
        message || `MAX API responded ${String(response.status)}`,
      );
    }
    return payload as T;
  }

  getMe(): Promise<MaxUser & { description?: string; commands?: unknown[] }> {
    return this.request('me');
  }

  async setCommands(commands: Array<{ name: string; description: string }>): Promise<void> {
    await this.request('me/commands', {
      method: 'PATCH',
      body: { commands },
    });
  }

  async subscribe(input: { url: string; secret: string; updateTypes: string[] }): Promise<void> {
    const result = await this.request<{ success: boolean; message?: string }>('subscriptions', {
      method: 'POST',
      body: {
        url: input.url,
        secret: input.secret,
        update_types: input.updateTypes,
      },
    });
    if (!result.success) {
      throw new MaxApiError(200, result.message ?? 'MAX webhook subscription failed');
    }
  }

  async sendMessage(userId: string, text: string, button?: MaxButton): Promise<MaxMessage> {
    const query = new URLSearchParams({ user_id: userId });
    const result = await this.request<MaxMessageResponse>(`messages?${query}`, {
      method: 'POST',
      body: {
        text,
        ...(button
          ? {
              attachments: [
                {
                  type: 'inline_keyboard',
                  payload: { buttons: [[button]] },
                },
              ],
            }
          : {}),
      },
    });
    return result.message;
  }

  async answerCallback(callbackId: string, notification: string): Promise<void> {
    const query = new URLSearchParams({ callback_id: callbackId });
    const result = await this.request<{ success: boolean; message?: string }>(`answers?${query}`, {
      method: 'POST',
      body: { notification },
    });
    if (!result.success) {
      throw new MaxApiError(200, result.message ?? 'MAX callback answer failed');
    }
  }
}

export function maxOpenAppButton(input: {
  text: string;
  botUsername?: string;
  payload?: string;
  fallbackUrl: string;
}): MaxButton {
  if (input.botUsername) {
    return {
      type: 'open_app',
      text: input.text,
      web_app: input.botUsername.replace(/^@/u, ''),
      ...(input.payload ? { payload: input.payload } : {}),
    };
  }
  return { type: 'link', text: input.text, url: input.fallbackUrl };
}

export function isPermanentMaxRecipientError(error: unknown): boolean {
  return error instanceof MaxApiError && [400, 403, 404, 405].includes(error.status);
}
