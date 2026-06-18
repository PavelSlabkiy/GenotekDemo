#!/usr/bin/env node

// Долгоживущий Chrome-воркер держит сессию «Памяти народа» между запросами.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

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
    timeoutMs: DEFAULT_TIMEOUT_MS,
    userDataDir: process.env.PAMYAT_CHROME_USER_DATA_DIR || "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--chrome-bin") options.chromeBin = argv[++index];
    else if (arg === "--accept-language") options.acceptLanguage = argv[++index];
    else if (arg === "--timeout-ms") options.timeoutMs = Number(argv[++index] || DEFAULT_TIMEOUT_MS);
    else if (arg === "--user-data-dir") options.userDataDir = argv[++index] || "";
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
      // Chrome ещё поднимает DevTools, ждём следующий короткий интервал.
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
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
    else pending.resolve(message.result);
  };
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  return ws;
}

async function cdpCall(ws, method, params = {}, timeoutMs = 30000) {
  const id = ++ws._id;
  const result = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws._pending.delete(id);
      reject(new Error(`CDP call timed out: ${method}`));
    }, timeoutMs);
    ws._pending.set(id, { resolve, reject, timer });
  });
  ws.send(JSON.stringify({ id, method, params }));
  return result;
}

function extractCookieHeader(cookies) {
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

async function evaluateText(ws, expression, timeoutMs = 30000) {
  const result = await cdpCall(ws, "Runtime.evaluate", { expression, returnByValue: true }, timeoutMs);
  return result.result?.value ?? "";
}

async function waitForPageReady(ws, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const readyState = await evaluateText(ws, "document.readyState", 5000).catch(() => "");
    if (readyState === "interactive" || readyState === "complete") return;
    await sleep(250);
  }
}

async function navigateTo(ws, url, timeoutMs) {
  await cdpCall(ws, "Page.navigate", { url }, timeoutMs);
  await waitForPageReady(ws, Math.min(timeoutMs, 15000));
}

async function collectConfig(ws, acceptLanguage, timeoutMs) {
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
    lastTitle = await evaluateText(ws, "document.title", 5000).catch(() => "");
    csrfToken = await evaluateText(ws, csrfExpression, 5000).catch(() => "");
    if (csrfToken) break;
    lastPreview = await evaluateText(ws, "document.documentElement.outerHTML.slice(0, 800)", 5000).catch(() => "");
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

async function runSearchInPage(ws, csrfToken, payload, timeoutMs) {
  const payloadLiteral = JSON.stringify(payload);
  const csrfLiteral = JSON.stringify(csrfToken);
  const timeoutLiteral = Number(timeoutMs || DEFAULT_TIMEOUT_MS);
  const expression = `
  (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ${timeoutLiteral});
    try {
      const response = await fetch('/entrypoint/api/', {
        method: 'POST',
        credentials: 'same-origin',
        signal: controller.signal,
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
        response_headers: Object.fromEntries(response.headers.entries()),
        body
      };
    } catch (error) {
      return {
        status_code: 0,
        content_type: '',
        response_headers: {},
        body: '',
        error: String(error?.message || error)
      };
    } finally {
      clearTimeout(timeout);
    }
  })()`;
  const result = await cdpCall(
    ws,
    "Runtime.evaluate",
    {
      expression,
      awaitPromise: true,
      returnByValue: true,
    },
    timeoutLiteral + 5000,
  );
  return result.result?.value || { status_code: 0, content_type: "", response_headers: {}, body: "" };
}

class PamyatChromeWorker {
  constructor(options) {
    this.options = options;
    this.chrome = null;
    this.chromeError = "";
    this.port = 0;
    this.userDataDir = options.userDataDir || "";
    this.createdTempDir = false;
    this.ws = null;
    this.config = null;
  }

  async ensureBrowser() {
    if (this.chrome && this.ws) return;
    this.port = await chooseFreePort();
    if (!this.userDataDir) {
      this.userDataDir = mkdtempSync(path.join(os.tmpdir(), "pamyat-chrome-"));
      this.createdTempDir = true;
    }
    const chromeArgs = [
      `--remote-debugging-port=${this.port}`,
      `--user-data-dir=${this.userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      "--disable-background-networking",
      "--disable-default-apps",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "about:blank",
    ];
    if (this.options.headless) {
      chromeArgs.unshift("--headless=new");
    }

    this.chrome = spawn(this.options.chromeBin, chromeArgs, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    this.chrome.stderr?.on("data", (chunk) => {
      this.chromeError += chunk.toString();
    });
    this.chrome.on("exit", () => {
      this.chrome = null;
      this.ws = null;
      this.config = null;
    });

    await waitForDevtools(this.port, 15000);
    const created = await fetch(`http://127.0.0.1:${this.port}/json/new?about%3Ablank`, { method: "PUT" }).then((response) =>
      response.json(),
    );
    this.ws = await openWebSocket(created.webSocketDebuggerUrl);
    await cdpCall(this.ws, "Page.enable");
    await cdpCall(this.ws, "Runtime.enable");
    await cdpCall(this.ws, "Network.enable");
    await cdpCall(this.ws, "Network.setExtraHTTPHeaders", {
      headers: { "Accept-Language": this.options.acceptLanguage },
    });
  }

  async bootstrap(params = {}) {
    await this.ensureBrowser();
    const url = params.url || PAMYAT_URL;
    const timeoutMs = Number(params.timeoutMs || this.options.timeoutMs || DEFAULT_TIMEOUT_MS);
    await navigateTo(this.ws, url, timeoutMs);
    this.config = await collectConfig(this.ws, this.options.acceptLanguage, timeoutMs);
    return this.publicConfig();
  }

  async refresh(params = {}) {
    this.config = null;
    return await this.bootstrap(params);
  }

  async search(params = {}) {
    const url = params.url || PAMYAT_URL;
    const timeoutMs = Number(params.timeoutMs || this.options.timeoutMs || DEFAULT_TIMEOUT_MS);
    if (!this.config) {
      await this.bootstrap({ url, timeoutMs });
    }
    const payload = params.payload || (params.payloadBase64 ? JSON.parse(Buffer.from(params.payloadBase64, "base64").toString("utf-8")) : null);
    ensure(payload, "search command requires payload or payloadBase64.");
    const searchResult = await runSearchInPage(this.ws, this.config.csrf_token, payload, timeoutMs);
    return { ...this.publicConfig(), ...searchResult };
  }

  publicConfig() {
    ensure(this.config, "Chrome session is not bootstrapped.");
    return {
      cookie: this.config.cookie,
      csrf_token: this.config.csrf_token,
      user_agent: this.config.user_agent,
      accept_language: this.config.accept_language,
      source: this.config.source,
      headless: this.options.headless,
    };
  }

  async close() {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // Вкладку уже закрыли на стороне Chrome, для воркера это не ошибка.
      }
      this.ws = null;
    }
    if (this.chrome && !this.chrome.killed) {
      this.chrome.kill("SIGTERM");
      await sleep(1000);
      if (this.chrome && !this.chrome.killed) this.chrome.kill("SIGKILL");
    }
    this.chrome = null;
    if (this.createdTempDir && this.userDataDir) {
      rmSync(this.userDataDir, { recursive: true, force: true });
      this.userDataDir = "";
      this.createdTempDir = false;
    }
  }
}

function writeResponse(id, payload) {
  process.stdout.write(`${JSON.stringify({ id, ok: true, result: payload })}\n`);
}

function writeError(id, error) {
  process.stdout.write(`${JSON.stringify({ id, ok: false, error: error.message || String(error) })}\n`);
}

async function main() {
  const worker = new PamyatChromeWorker(parseArgs(process.argv.slice(2)));
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let chain = Promise.resolve();

  async function handleLine(line) {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      writeError(null, new Error(`Invalid JSON command: ${error.message}`));
      return;
    }

    const id = message.id ?? null;
    const command = message.command || message.method;
    const params = message.params || {};
    try {
      if (command === "ping") writeResponse(id, { status: "ok" });
      else if (command === "bootstrap") writeResponse(id, await worker.bootstrap(params));
      else if (command === "refresh") writeResponse(id, await worker.refresh(params));
      else if (command === "search") writeResponse(id, await worker.search(params));
      else if (command === "close") {
        await worker.close();
        writeResponse(id, { status: "closed" });
        process.exit(0);
      } else {
        throw new Error(`Unknown command: ${command}`);
      }
    } catch (error) {
      writeError(id, error);
    }
  }

  rl.on("line", (line) => {
    chain = chain.then(() => handleLine(line)).catch((error) => {
      writeError(null, error);
    });
  });

  rl.on("close", async () => {
    await chain.catch(() => {});
    await worker.close();
  });
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
