import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { busyPrice, busyThreshold, sell, sellerPrice, sellerWallet } from "./catalog.js";
import { settle, supported, verify, verifyResponse } from "./facilitator.js";
import { PAY_CHAIN, USDC_ASSET } from "./chain.js";
import { HEADER_SIGNATURE, decodeHeader, sameVersion, type PaymentPayload } from "./x402wire.js";

/**
 * The paid index as its own process, with its own wallet, its own ledger and no key.
 *
 * It used to live on the same port as the agent that pays it, which made the whole
 * handshake a function call dressed up as HTTP. This process only knows the buyer
 * through a standard PAYMENT-SIGNATURE header, and the facilitator that settles it
 * broadcasts the buyer's signed bytes without ever holding a key of its own.
 */

const PORT = Number(process.env.SELLER_PORT ?? 8788);
const HOST = process.env.SELLER_HOST ?? "127.0.0.1";
const MAX_BODY = 64 * 1024;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY) {
        reject(new Error("request too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
    ...headers,
  });
  res.end(text);
}

function parsed(body: string): Record<string, unknown> {
  try {
    return JSON.parse(body || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** The resources this process sells, and what it charges, with no key in the reply. */
function health() {
  return {
    ok: true,
    seller: sellerWallet(),
    network: PAY_CHAIN,
    asset: USDC_ASSET,
    price_usdc: sellerPrice(),
    busy_price_usdc: busyPrice(),
    busy_after: busyThreshold(),
    kind: "x402 resource server, exact scheme, no signing key",
  };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  try {
    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, health());
    }

    // The facilitator API this resource server ships with. A buyer can point at any
    // facilitator that implements the same three routes.
    if (req.method === "GET" && url.pathname === "/facilitator/supported") {
      return json(res, 200, supported());
    }
    if (req.method === "POST" && url.pathname === "/facilitator/verify") {
      const body = parsed(await readBody(req));
      const checked = await verify(body as any);
      return json(res, 200, verifyResponse(checked));
    }
    if (req.method === "POST" && url.pathname === "/facilitator/settle") {
      const body = parsed(await readBody(req));
      return json(res, 200, await settle(body as any));
    }

    if (url.pathname === "/paid" && req.method === "GET") {
      const answer = await sell({ resource: url.searchParams.get("resource") ?? "", payer: url.searchParams.get("payer") ?? "" });
      return json(res, answer.http, answer.body, answer.headers);
    }

    if (url.pathname === "/paid" && req.method === "POST") {
      const header = req.headers[HEADER_SIGNATURE] ?? req.headers["x-payment"];
      const raw = Array.isArray(header) ? header[0] : header;
      if (!raw) {
        const body = parsed(await readBody(req));
        const answer = await sell({ resource: String(body.resource ?? url.searchParams.get("resource") ?? ""), payer: String(body.payer ?? "") });
        return json(res, answer.http, answer.body, answer.headers);
      }

      let envelope = "";
      try {
        const payload = decodeHeader<PaymentPayload>(raw);
        if (!sameVersion(payload?.x402Version)) return json(res, 400, { error: "this resource server speaks x402 version 2" });
        if (payload?.scheme !== "exact") return json(res, 400, { error: `this resource server settles the exact scheme, not ${payload?.scheme}` });
        if (payload?.network !== PAY_CHAIN) return json(res, 400, { error: `this resource server settles ${PAY_CHAIN}, not ${payload?.network}` });
        envelope = String(payload?.payload?.transaction ?? "");
        if (!envelope) return json(res, 400, { error: "the payment header carries no signed transaction" });
      } catch {
        return json(res, 400, { error: "the payment header is not base64 JSON this server can read" });
      }

      const resource = url.searchParams.get("resource") ?? String(parsed(await readBody(req)).resource ?? "");
      const answer = await sell({ resource, envelope }, { settle });
      return json(res, answer.http, answer.body, answer.headers);
    }

    return json(res, 404, { error: `this index does not serve ${url.pathname}` });
  } catch (err) {
    return json(res, 500, { error: String((err as Error)?.message ?? err).slice(0, 240) });
  }
});

const directly = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (directly) {
  server.listen(PORT, HOST, () => {
    console.log(`paid index on http://${HOST}:${PORT} · wallet ${sellerWallet()}`);
    console.log(`profiles and receipts at ${sellerPrice()} USDC, ${busyPrice()} after ${busyThreshold()} transactions · x402 exact on ${PAY_CHAIN}`);
    console.log("this process holds no signing key");
  });
}

export { server };
