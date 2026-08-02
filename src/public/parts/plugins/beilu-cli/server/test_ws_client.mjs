import { WebSocket } from "ws";
import * as fs from "node:fs";
import * as os from "node:os";

const token = fs.readFileSync(os.homedir() + "/.beilu/ide_ws_token", "utf-8").trim();
const c = new WebSocket("ws://127.0.0.1:8931/ide?token=" + token);

c.on("open", () => {
  console.log("WS connected");
  c.send(JSON.stringify({ type: "tool_call", id: "t1", payload: { id: "t1", tool: "read_file", params: { path: "package.json" } } }));
});

c.on("message", (d) => {
  const m = JSON.parse(d);
  if (m.type === "hello") console.log("hello from " + m.payload?.appName);
  if (m.type === "tool_result") {
    console.log("tool_result: success=" + m.payload?.success);
    const content = m.payload?.result?.result?.content;
    if (content) console.log("content preview: " + content.slice(0, 200));
    c.close();
    setTimeout(() => process.exit(0), 500);
  }
});

c.on("error", (e) => { console.log("WS error: " + e.message); process.exit(1); });
setTimeout(() => { console.log("timeout"); process.exit(1); }, 10000);
