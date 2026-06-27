import { AwsClient } from "aws4fetch";
import { Base64 } from "js-base64";
import { environment, ZuploContext, ZuploRequest } from "@zuplo/runtime";

/**
 * POST /messages — convert outbound `media.base64` to `media.url` (API.md §6.2).
 *
 * The worker contract is URL-only: it never accepts base64. A customer may send
 * media as base64 (convenient for AI/automation), so this policy intercepts the
 * request, uploads the decoded bytes to R2 under a random key, and rewrites the
 * body to `media.url` before patch-session-from-bearer forwards to the worker.
 *
 * Runs AFTER session-api-key-inbound (so unauthenticated requests never trigger
 * an upload). Pass-through for text messages and url-only media.
 *
 * Cleanup is handled by the bucket's 1-day lifecycle rule (R2's minimum
 * granularity; deletion is approximate, typically within ~24h of expiry). The
 * object only needs to outlive a single synchronous send — Baileys fetches the
 * url and re-uploads the bytes to WhatsApp's own CDN before the send resolves,
 * so the recipient never touches R2. Active delete-after-send is deliberately
 * deferred (it risks deleting bytes a media re-upload/retry would still need).
 */

/** Hard cap on decoded media, per API.md §6.2. Larger → 413 (use media.url). */
const MAX_DECODED_BYTES = 16 * 1024 * 1024;

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Return a forwardable request carrying `body`. The original body stream is
 * consumed by request.text(), so the handler must receive a fresh one; we also
 * drop content-length so it is recomputed from the (possibly rewritten) body.
 */
function rebuild(request: ZuploRequest, body: string): ZuploRequest {
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  return new ZuploRequest(request, { body, headers });
}

export default async function (
  request: ZuploRequest,
  context: ZuploContext,
): Promise<ZuploRequest | Response> {
  // Only a JSON POST body can carry media; anything else passes straight through.
  if (!request.headers.get("content-type")?.includes("application/json")) {
    return request;
  }

  const raw = await request.text();
  if (!raw) return rebuild(request, raw);

  let body: { media?: { base64?: unknown; url?: unknown; type?: unknown; mimeType?: unknown } };
  try {
    body = JSON.parse(raw);
  } catch {
    // Malformed JSON: forward unchanged and let the worker's validation answer.
    return rebuild(request, raw);
  }

  const media = body?.media;
  const base64 = media?.base64;
  // Nothing to convert: text message, or media already given as a url.
  if (!media || typeof base64 !== "string" || base64.length === 0) {
    return rebuild(request, raw);
  }

  // The contract is plain base64 (API.md §4/§6.2), not a data: URI — no prefix
  // handling. Pre-check decoded size from the encoded length (decoded ≈ 3/4 of
  // encoded) to reject oversized payloads before allocating/decoding them.
  if (Math.floor((base64.length * 3) / 4) > MAX_DECODED_BYTES) {
    return jsonError(
      "media.base64 exceeds the 16 MB decoded limit; use media.url instead",
      413,
    );
  }

  // js-base64's toUint8Array decodes straight to bytes and is tolerant of the
  // sloppy inputs a public base64 field attracts: embedded whitespace/newlines,
  // missing `=` padding, and the URL-safe alphabet (-/_). NOTE: must be
  // toUint8Array, not Base64.decode (decode is UTF-8 and corrupts binary).
  let bytes: Uint8Array;
  try {
    bytes = Base64.toUint8Array(base64);
  } catch {
    return jsonError("media.base64 is not valid base64", 400);
  }
  if (bytes.byteLength > MAX_DECODED_BYTES) {
    return jsonError(
      "media.base64 exceeds the 16 MB decoded limit; use media.url instead",
      413,
    );
  }

  const endpoint = environment.R2_S3_ENDPOINT?.trim();
  const publicBase = environment.R2_PUBLIC_BASE_URL?.trim();
  const accessKeyId = environment.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = environment.R2_SECRET_ACCESS_KEY?.trim();
  if (!endpoint || !publicBase || !accessKeyId || !secretAccessKey) {
    context.log.error("outbound-media-base2url: R2_* env vars are not fully set");
    return jsonError("Route misconfigured: R2 storage not configured", 500);
  }

  // Bare random key — the object is internal and temporary. The worker derives
  // mimeType/filename itself (caller value → URL extension → content sniff; see
  // media-content.util.ts), and builds the Baileys payload from media.type, so
  // a guessed key extension would be redundant and potentially misleading.
  const key = crypto.randomUUID();
  // Stored Content-Type is best-effort metadata only (the worker re-derives);
  // set it when the caller told us, else a neutral default.
  const objectContentType =
    typeof media.mimeType === "string" && media.mimeType
      ? media.mimeType
      : "application/octet-stream";

  const aws = new AwsClient({
    accessKeyId,
    secretAccessKey,
    service: "s3",
    region: "auto",
  });
  const uploadUrl = `${endpoint}/${key}`;

  let uploaded: Response;
  try {
    uploaded = await aws.fetch(uploadUrl, {
      method: "PUT",
      // Uint8Array is a valid fetch body; cast past the lib's typed-array
      // generic that no longer matches BodyInit directly.
      body: bytes as unknown as BodyInit,
      headers: { "Content-Type": objectContentType },
    });
  } catch (error) {
    context.log.error(error, "outbound-media-base2url: R2 upload threw");
    return jsonError("Failed to store media", 502);
  }
  if (!uploaded.ok) {
    context.log.error(
      { status: uploaded.status },
      "outbound-media-base2url: R2 upload returned non-2xx",
    );
    return jsonError("Failed to store media", 502);
  }

  // Rewrite to the worker's url-only contract; preserve type/caption/mimeType/filename.
  delete (media as { base64?: unknown }).base64;
  (media as { url?: string }).url = `${publicBase}/${key}`;

  context.log.info(
    { key, mediaType: media.type, bytes: bytes.byteLength },
    "Converted outbound base64 media to R2 url",
  );

  return rebuild(request, JSON.stringify(body));
}
