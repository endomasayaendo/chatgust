/**
 * 通知対象の絞り込み（許可リスト）に関する純粋関数。
 */

/** カンマ区切り文字列を、トリム・小文字化・空要素除去したチャンネル login 集合に変換する。 */
export function parseAllowlist(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

/**
 * allowlist に従ってチャンネル login を絞り込む。
 * allowlist が空なら全件をそのまま返す（＝絞り込みなし）。
 */
export function filterChannels(logins: string[], allowlist: Set<string>): string[] {
  if (allowlist.size === 0) return logins;
  return logins.filter((login) => allowlist.has(login.toLowerCase()));
}
