import type * as lark from '@larksuiteoapi/node-sdk';

/**
 * Lark's bot-info response shape. `/open-apis/bot/v3/info` returns
 * `{ code, msg, bot: { open_id, ... } }` with `bot` at the root, NOT nested
 * under `data` (unlike newer v6 API endpoints). Verified against the SDK
 * v1.61 source.
 */
interface BotInfoResponse {
  code?: number;
  msg?: string;
  bot?: {
    open_id?: string;
    app_name?: string;
    avatar_url?: string;
    activate_status?: number;
    ip_white_list?: string[];
  };
}

/**
 * Resolve the bot's `open_id` via the Lark SDK. The official SDK does not
 * expose `/open-apis/bot/v3/info` as a typed method — the closest typed
 * surface, `client.application.v6.application.get`, returns app metadata
 * without the bot user's `open_id`. So we use the untyped
 * `client.request(...)` escape hatch with the verified path.
 *
 * This file is the ONLY place the raw Lark endpoint path is encoded — if the
 * Lark API changes, only this file needs editing. Consumers
 * (`src/bot-identity.ts`, `src/adapter.ts`) import `fetchBotInfo` and never
 * see SDK specifics.
 */
export async function fetchBotInfo(client: lark.Client): Promise<{ open_id?: string }> {
  const result = await client.request<BotInfoResponse>({
    method: 'POST',
    url: '/open-apis/bot/v3/info',
  });
  return { open_id: result?.bot?.open_id };
}
