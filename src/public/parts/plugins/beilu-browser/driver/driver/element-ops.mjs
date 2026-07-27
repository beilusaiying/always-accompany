import { cdp, runtimeValue } from "../cdp.mjs";
import { browserRefMap, ensureRefMapForRef } from "../ref-state.mjs";
import { resolveElementObjectId } from "../element-resolver.mjs";

export async function resolveHandle(selectorOrRef) {
  await ensureRefMapForRef(selectorOrRef);
  return resolveElementObjectId(
    { sendRaw: cdp },
    undefined,
    browserRefMap,
    selectorOrRef,
  );
}

export async function releaseHandle(objectId, sessionId) {
  if (!objectId) return;
  try {
    await cdp("Runtime.releaseObject", { objectId }, sessionId);
  } catch {
  }
}

export async function withHandle(selectorOrRef, fn) {
  const handle = await resolveHandle(selectorOrRef);
  try {
    return await fn(handle);
  } finally {
    await releaseHandle(handle.objectId, handle.sessionId);
  }
}

export async function resolveAndCall(
  selectorOrRef,
  functionDeclaration,
  args = [],
) {
  return withHandle(selectorOrRef, async ({ objectId, sessionId }) => {
    const result = await cdp(
      "Runtime.callFunctionOn",
      {
        functionDeclaration,
        objectId,
        arguments: args.map((value) => ({ value })),
        returnByValue: true,
        awaitPromise: false,
      },
      sessionId,
    );
    if (result.exceptionDetails || result.result?.subtype === "error") {
      runtimeValue(result, functionDeclaration);
    }
    return { result, objectId, sessionId };
  });
}
