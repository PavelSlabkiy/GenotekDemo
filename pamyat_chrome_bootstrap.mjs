#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const DEFAULT_CHROME_BIN = process.env.PAMYAT_CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DEFAULT_ACCEPT_LANGUAGE = "ru,en-US;q=0.9,en;q=0.8";
const DEFAULT_TIMEOUT_MS = 45000;
const PAMYAT_URL = "https://pamyat-naroda.ru/heroes/?adv_search=y";
const PAMYAT_COOKIE_URLS = [PAMYAT_URL, "https://pamyat-naroda.ru/"];

function parseArgs(argv) {
  const options = {
    chromeBin: DEFAULT_CHROME_BIN,
    acceptLanguage: DEFAULT_ACCEPT_LANGUAGE,
    headless: process.env.PAMYAT_CHROME_HEADLESS !== "false",
    searchPayloadBase64: "",
    timeoutMs: DEFAULT_TIMEOUT_MS,
    url: PAMYAT_URL,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--chrome-bin") options.chromeBin = argv[++index];
    else if (arg === "--accept-language") options.acceptLanguage = argv[++index];
    else if (arg === "--search-payload-base64") options.searchPayloadBase64 = argv[++index] || "";
    else if (arg === "--timeout-ms") options.timeoutMs = Number(argv[++index] || DEFAULT_TIMEOUT_MS);
    else if (arg === "--url") options.url = argv[++index] || PAMYAT_URL;
    else if (arg === "--user-data-dir") options.userDataDir = argv[++index];
    else if (arg === "--chrome-visible") options.headless = false;
    else if (arg === "--headless") options.headless = true;
    else if (arg === "--headless=false") options.headless = false;
  }
  return options;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensure(value, message) {
  if (!value) throw new Error(message);
  return value;
}

async function chooseFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((closeError) => {
        if (closeError) reject(closeError);
        else resolve(port);
      });
    });
  });
}

async function waitForDevtools(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
    } catch {
      // Chrome is still starting.
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for Chrome DevTools on port ${port}.`);
}

async function openWebSocket(url) {
  const ws = new WebSocket(url);
  ws._id = 0;
  ws._pending = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (!message.id) return;
    const pending = ws._pending.get(message.id);
    if (!pending) return;
    ws._pending.delete(message.id);
    if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
    else pending.resolve(message.result);
  };
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  return ws;
}

async function cdpCall(ws, method, params = {}) {
  const id = ++ws._id;
  const result = new Promise((resolve, reject) => ws._pending.set(id, { resolve, reject }));
  ws.send(JSON.stringify({ id, method, params }));
  return result;
}

function extractCookieHeader(cookies) {
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

async function evaluateText(ws, expression) {
  const result = await cdpCall(ws, "Runtime.evaluate", { expression, returnByValue: true });
  return result.result?.value ?? "";
}

async function collectConfig(ws, acceptLanguage, timeoutMs) {
  await cdpCall(ws, "Page.enable");
  await cdpCall(ws, "Runtime.enable");
  await cdpCall(ws, "Network.enable");

  const csrfExpression = `(() => {
    const direct = [
      document.querySelector('input[name="csrf"]')?.value,
      document.querySelector('meta[name="csrf-token"]')?.content,
      document.querySelector('meta[name="csrf"]')?.content,
      window.__INITIAL_STATE__?.csrf,
      window.APP_INITIAL_STATE?.csrf,
    ].find(Boolean);
    if (direct) return direct;
    const html = document.documentElement.outerHTML;
    const patterns = [
      /name=["']csrf["'][^>]*value=["']([^"']+)["']/i,
      /value=["']([^"']+)["'][^>]*name=["']csrf["']/i,
      /csrf[_-]?token["']?\\s*[:=]\\s*["']([^"']+)["']/i,
      /\\"csrf\\"\\s*:\\s*\\"([^\\"]+)\\"/i,
    ];
    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match) return match[1];
    }
    return "";
  })()`;

  const deadline = Date.now() + timeoutMs;
  let csrfToken = "";
  let lastTitle = "";
  let lastPreview = "";
  while (Date.now() < deadline) {
    lastTitle = await evaluateText(ws, "document.title");
    csrfToken = await evaluateText(ws, csrfExpression);
    if (csrfToken) break;
    lastPreview = await evaluateText(ws, "document.documentElement.outerHTML.slice(0, 800)");
    await sleep(1000);
  }

  if (!csrfToken) {
    throw new Error(
      `Chrome opened Pamyat Naroda but did not expose a CSRF token in time. ` +
        `Title: ${lastTitle || "(empty)"}. HTML preview: ${String(lastPreview).replace(/\\s+/g, " ").trim()}`,
    );
  }

  const cookiesResult = await cdpCall(ws, "Network.getCookies", { urls: PAMYAT_COOKIE_URLS });
  const cookies = cookiesResult.cookies.filter((cookie) => cookie.domain.endsWith("pamyat-naroda.ru"));
  const userAgent = await evaluateText(ws, "navigator.userAgent");
  ensure(cookies.length, "Chrome DevTools did not return any Pamyat Naroda cookies.");
  ensure(cookies.some((cookie) => cookie.name === "PN_DESKTOP_SESSIONID"), "PN_DESKTOP_SESSIONID cookie not found in Chrome session.");

  return {
    cookie: extractCookieHeader(cookies),
    csrf_token: csrfToken,
    user_agent: userAgent || undefined,
    accept_language: acceptLanguage,
    source: "chrome_devtools",
  };
}

async function runSearchInPage(ws, csrfToken, payload) {
  const payloadLiteral = JSON.stringify(payload);
  const csrfLiteral = JSON.stringify(csrfToken);
  const expression = `
  (async () => {
    const response = await fetch('/entrypoint/api/', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'X-Csrf-Token': ${csrfLiteral}
      },
      body: JSON.stringify(${payloadLiteral})
    });
    const body = await response.text();
    return {
      status_code: response.status,
      content_type: response.headers.get('content-type') || '',
      body
    };
  })()`;
  const result = await cdpCall(ws, "Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  return result.result?.value || { status_code: 0, content_type: "", body: "" };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const port = await chooseFreePort();
  const userDataDir = options.userDataDir || mkdtempSync(path.join(os.tmpdir(), "pamyat-chrome-"));
  let createdTempDir = !options.userDataDir;
  let chrome;

  try {
    chrome = spawn(
      options.chromeBin,
      [
        ...(options.headless ? ["--headless=new"] : []),
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${userDataDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-sync",
        "--disable-background-networking",
        "--disable-default-apps",
        "about:blank",
      ],
      {
        stdio: ["ignore", "ignore", "pipe"],
      },
    );

    let chromeError = "";
    chrome.stderr?.on("data", (chunk) => {
      chromeError += chunk.toString();
    });

    await waitForDevtools(port, 15000);
    const targetUrl = encodeURIComponent(options.url);
    const created = await fetch(`http://127.0.0.1:${port}/json/new?${targetUrl}`, { method: "PUT" }).then((response) =>
      response.json(),
    );
    const ws = await openWebSocket(created.webSocketDebuggerUrl);
    try {
      const config = await collectConfig(ws, options.acceptLanguage, options.timeoutMs);
      if (!options.searchPayloadBase64) {
        process.stdout.write(`${JSON.stringify(config)}\n`);
        return;
      }
      const payload = JSON.parse(Buffer.from(options.searchPayloadBase64, "base64").toString("utf-8"));
      const searchResult = await runSearchInPage(ws, config.csrf_token, payload);
      process.stdout.write(`${JSON.stringify({ ...config, ...searchResult })}\n`);
    } finally {
      ws.close();
    }
  } finally {
    if (chrome && !chrome.killed) {
      chrome.kill("SIGTERM");
      await sleep(1000);
      if (!chrome.killed) chrome.kill("SIGKILL");
    }
    if (createdTempDir) {
      rmSync(userDataDir, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
