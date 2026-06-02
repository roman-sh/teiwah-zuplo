import { ZuploContext, ZuploRequest } from "@zuplo/runtime";

type RouteWithK3sOptions = {
  "x-zuplo-route"?: {
    handler?: {
      options?: {
        k3sBaseUrl?: string;
      };
    };
  };
};

function k3sBaseUrlFromRoute(context: ZuploContext): string | null {
  const raw = context.route.raw<RouteWithK3sOptions>();
  const url = raw?.["x-zuplo-route"]?.handler?.options?.k3sBaseUrl?.trim();
  return url || null;
}

/**
 * POST /messages — forward to the session worker after API key auth.
 *
 * session-api-key-inbound sets request.user.sub = Zuplo consumer name (= sessionId).
 * Worker path: POST /sessions/:sessionId/messages (Traefik strips prefix → pod /messages).
 *
 * Custom request handlers only receive (request, context) — route handler.options
 * are read via context.route.raw(), not a third function argument.
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

  const k3sBaseUrl = k3sBaseUrlFromRoute(context);
  if (!k3sBaseUrl) {
    context.log.error("POST /messages: k3sBaseUrl missing in route handler.options");
    return new Response(
      JSON.stringify({ message: "Route misconfigured: k3sBaseUrl required" }),
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
