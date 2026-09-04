/**
 * Every gateway-generated response is `application/problem+json` (design section 5's
 * `errorFormat`, whose other value, `soap-fault`, arrives with the `soap` variant).
 */
export function problem(
  status: number,
  title: string,
  detail: string,
  requestId: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Response {
  return new Response(
    JSON.stringify({ type: "about:blank", title, status, detail, requestId, ...extra }),
    {
      status,
      headers: {
        "content-type": "application/problem+json; charset=utf-8",
        "x-request-id": requestId,
        ...headers,
      },
    },
  );
}
