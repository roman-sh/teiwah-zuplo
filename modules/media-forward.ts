import { environment, ZuploContext, ZuploRequest } from "@zuplo/runtime";

/**
 * GET /media/:id — forward to the session worker after API key auth.
 *
 * session-api-key-inbound sets request.user.sub = Zuplo consumer name (= sessionId).
 * Worker path: GET /sessions/:sessionId/media/:id (Traefik strips prefix → pod /media/:id).
 * The worker streams the bytes back with the original Content-Type / Content-Disposition,
 * so we pass the upstream body and headers straight through.
 *
 * INGRESS_URL from teiwah-zuplo/.env (local) or Zuplo portal (prod) — k3s Traefik base.
 */
export default async function (
  request: ZuploRequest,
  context: ZuploContext,
): Promise<Response> {
  const sessionId = request.user?.sub;
  if (!sessionId) {
    context.log.warn("GET /media without authenticated consumer");
    return new Response(JSON.stringify({ message: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const messageId = request.params.id;
  if (!messageId) {
    return new Response(JSON.stringify({ message: "Missing media id" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const k3sBaseUrl = environment.INGRESS_URL?.trim();
  if (!k3sBaseUrl) {
    context.log.error("GET /media: INGRESS_URL env var is not set");
    return new Response(
      JSON.stringify({ message: "Route misconfigured: INGRESS_URL required" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  const targetUrl = `${k3sBaseUrl}/sessions/${encodeURIComponent(
    sessionId,
  )}/media/${encodeURIComponent(messageId)}`;

  const headers = new Headers(request.headers);
  headers.delete("authorization");
  headers.delete("host");

  const upstream = await fetch(targetUrl, { method: "GET", headers });

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers,
  });
}
