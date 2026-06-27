import { ZuploContext, ZuploRequest } from "@zuplo/runtime";

/**
 * Inbound policy for session-API-key routes (/messages, /media, /typing, /read).
 *
 * Runs after session-api-key-inbound, which sets request.user.sub to the Zuplo
 * consumer name (= sessionId). Rewrites the public path:
 *
 *   /messages     → /sessions/{sessionId}/messages
 *   /media/:id      → /sessions/{sessionId}/media/:id
 *   /typing, /read  → /sessions/{sessionId}/typing|read
 *
 * so the route handler can be plain urlForwardHandler → INGRESS_URL. Strips
 * Authorization — the worker trusts ingress routing, not the customer's key.
 */
export default async function (
  request: ZuploRequest,
  context: ZuploContext,
): Promise<ZuploRequest | Response> {
  const sessionId = request.user?.sub;
  if (!sessionId) {
    context.log.warn("patch-session-from-bearer: no authenticated consumer");
    return new Response(JSON.stringify({ message: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const url = new URL(request.url);
  url.pathname = `/sessions/${encodeURIComponent(sessionId)}${url.pathname}`;

  // Clone method/body from the incoming request (GET /media already has body null).
  const patched = new ZuploRequest(url, request);
  patched.headers.delete("authorization");
  patched.headers.delete("host");
  return patched;
}
