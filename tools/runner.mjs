import { spawn } from "node:child_process";
import { resolve } from "node:path";

const cwd = resolve(import.meta.dirname, "..");

process.env.SELLER_HOST = process.env.SELLER_HOST || "127.0.0.1";
process.env.SELLER_PORT = process.env.SELLER_PORT || "8788";
if (!process.env.PAID_SOURCE_URL) {
  process.env.PAID_SOURCE_URL = `http://${process.env.SELLER_HOST}:${process.env.SELLER_PORT}/paid`;
}

console.log("[runner] Starting Ken seller service on port " + process.env.SELLER_PORT + "...");
const seller = spawn(process.execPath, ["--import", "tsx", "src/seller.ts"], {
  cwd,
  stdio: "inherit",
  env: process.env,
});

let server = null;
let shuttingDown = false;

const cleanup = (exitCode = 0) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("[runner] Shutting down child services...");
  try { seller.kill("SIGTERM"); } catch {}
  try { if (server) server.kill("SIGTERM"); } catch {}
  setTimeout(() => {
    try { seller.kill("SIGKILL"); } catch {}
    try { if (server) server.kill("SIGKILL"); } catch {}
    process.exit(exitCode);
  }, 1500).unref();
};

seller.on("error", (err) => {
  console.error("[runner] Failed to spawn seller:", err);
  cleanup(1);
});

seller.on("exit", (code, signal) => {
  if (shuttingDown) return;
  console.warn(`[runner] seller process stopped (code=${code}, signal=${signal})`);
  cleanup(code ?? 1);
});

// Give seller service 400ms to open port 8788 before starting the agent server
setTimeout(() => {
  if (shuttingDown) return;
  console.log("[runner] Starting Ken main agent server on port " + (process.env.PORT || 8787) + "...");
  server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd,
    stdio: "inherit",
    env: process.env,
  });

  server.on("error", (err) => {
    console.error("[runner] Failed to spawn main server:", err);
    cleanup(1);
  });

  server.on("exit", (code, signal) => {
    if (shuttingDown) return;
    console.warn(`[runner] main server process stopped (code=${code}, signal=${signal})`);
    cleanup(code ?? 1);
  });
}, 400);

process.on("SIGINT", () => {
  console.log("[runner] Received SIGINT");
  cleanup(0);
});

process.on("SIGTERM", () => {
  console.log("[runner] Received SIGTERM");
  cleanup(0);
});

