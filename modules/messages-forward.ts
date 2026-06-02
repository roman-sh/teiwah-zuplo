import { ZuploContext, ZuploRequest } from "@zuplo/runtime";

type MessagesForwardOptions = {
  /** Origin for worker traffic (Traefik on k3s). */
  k3sBaseUrl: string;
};

/**
 * POST /messages — forward to the session worker after API key auth.
 *
 * session-api-key-inbound sets request.user.sub = Zuplo consumer name (= sessionId).
 * Worker path: POST /sessions/:sessionId/messages (Traefik strips prefix → pod /messages).
 */
export default async function (
  request: ZuploRequest,
  context: ZuploContext,
  options: MessagesForwardOptions,
): Promise<Response> {
  const sessionId = request.user?.sub;
  if (!sessionId) {
    context.log.warn("POST /messages without authenticated consumer");
    return new Response(JSON.stringify({ message: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const base = options.k3sBaseUrl.replace(/\/$/, "");
  const targetUrl = `${base}/sessions/${encodeURIComponent(sessionId)}/messages`;

  const headers = new Headers(request.headers);
  headers.delete("authorization");
  headers.delete("host");

  const hasBody =
    request.method !== "GET" &&
    request.method !== "HEAD" &&
    request.method !== "OPTIONS";

  const upstream = await fetch(targetUrl, {
    method: request.method,
    headers,
    body: hasBody ? request.body : undefined,
  });

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers,
  });
}
