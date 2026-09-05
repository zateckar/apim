import { ApiError } from "../api";
const pendingKeys = new Map<string, string>();
export async function command<T = any>(
  path: string,
  body: unknown,
  etag?: string,
): Promise<T> {
  const fingerprint = JSON.stringify([path, body, etag]);
  const id = pendingKeys.get(fingerprint) ?? crypto.randomUUID();
  pendingKeys.set(fingerprint, id);
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
      "idempotency-key": id,
      ...(etag ? { "if-match": etag } : {}),
    },
    body: JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok)
    throw new ApiError(
      response.status,
      value.title ?? "Request failed",
      value.detail ?? "Request failed",
      value,
    );
  pendingKeys.delete(fingerprint);
  return value;
}
export async function listAll<T = any>(path: string): Promise<{ items: T[] }> {
  const items: T[] = [];
  let cursor: string | null = null;
  do {
    const url = new URL(path, window.location.origin);
    url.searchParams.set("limit", "100");
    if (cursor) url.searchParams.set("cursor", cursor);
    const response = await fetch(url, { credentials: "same-origin" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail ?? "Could not load list");
    items.push(...data.items);
    cursor = data.nextCursor ?? null;
  } while (cursor);
  return { items };
}
