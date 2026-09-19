export const SHARE_RETURN_KEY = "vayam-share-return";

export function safeShareReturn(value: string | null): string | null {
  return value && /^\/share\/[a-f0-9-]{36}(\?album=[a-f0-9-]{36})?$/.test(value) ? value : null;
}
