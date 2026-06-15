import { environment, ZuploContext, ZuploRequest } from "@zuplo/runtime";

/**
 * POST /messages — forward to the session worker after API key auth.
 *
 * session-api-key-inbound sets request.user.sub = Zuplo consumer name (= sessionId).
 * Worker path: POST /sessions/:sessionId/messages (Traefik strips prefix → pod /messages).
 *
 * INGRESS_URL from teiwah-zuplo/.env (local) or Zuplo portal (prod) — k3s Traefik base.
 */
export default async function (
  request: ZuploRequest,
  context: ZuploContext,
): Promise<Response> {
  const sessionId = request.user?.sub;
  if (!sessionId) {
    context.log.warn("POST /messages without authenticated consumer");
    return new Response(JSON.stringify({ message: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const k3sBaseUrl = environment.INGRESS_URL?.trim();
  if (!k3sBaseUrl) {
    context.log.error("POST /messages: INGRESS_URL env var is not set");
    return new Response(
      JSON.stringify({ message: "Route misconfigured: INGRESS_URL required" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  const targetUrl = `${k3sBaseUrl}/sessions/${encodeURIComponent(sessionId)}/messages`;

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
