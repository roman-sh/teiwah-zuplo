import { ZuploContext, ZuploRequest } from "@zuplo/runtime";

export default async function (
  request: ZuploRequest,
  context: ZuploContext,
): Promise<ZuploRequest | Response> {
  if (!request.user) {
    return request;
  }

  const newRequest = new ZuploRequest(request);
  newRequest.headers.set("x-user-id", request.user.sub);
  return newRequest;
}