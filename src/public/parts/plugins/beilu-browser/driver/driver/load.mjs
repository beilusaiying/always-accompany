import { cdp, evaluate } from "../cdp.mjs";
import { state } from "../state.mjs";

export async function waitForDocumentLoad(options = {}) {
  const timeout = options.timeout ?? 15000;
  const ready =
    options.until === "domcontentloaded"
      ? ["interactive", "complete"]
      : ["complete"];
  const deadline = state.now() + timeout;
  while (state.now() < deadline) {
    let committed = true;
    try {
      const tree = await cdp("Page.getFrameTree");
      const url = tree.frameTree?.frame?.url || "";
      committed = url !== "" && url !== ":" && url !== "about:blank";
    } catch {
    }
    if (committed && ready.includes(await evaluate("document.readyState"))) {
      return true;
    }
    await state.sleep(300);
  }
  return false;
}
