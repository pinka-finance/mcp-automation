// Smoke test — spawnaj MCP preko stdio, initialize + tools/list, ispiši toolove.
// Ne treba bazu (samo lista toolova). Pokreni: npm run smoke

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const entry = path.join(root, "src", "index.ts");

const child = spawn("npx", ["tsx", entry], {
  cwd: root,
  env: { ...process.env, SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "dummy" },
  stdio: ["pipe", "pipe", "inherit"],
});

let buf = "";
child.stdout.on("data", (d: Buffer) => {
  buf += d.toString();
  let nl: number;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg: { id?: number; result?: { tools?: { name: string }[] } };
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id === 2 && msg.result?.tools) {
      const names = msg.result.tools.map((t) => t.name);
      console.log(`\n✅ ${names.length} toolova:\n  - ${names.join("\n  - ")}`);
      child.kill();
      process.exit(0);
    }
  }
});

const send = (o: unknown) => child.stdin.write(JSON.stringify(o) + "\n");
send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "1" } },
});
setTimeout(
  () => send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  800,
);
setTimeout(() => {
  console.error("❌ TIMEOUT — nema tools/list odgovora");
  child.kill();
  process.exit(1);
}, 12000);
