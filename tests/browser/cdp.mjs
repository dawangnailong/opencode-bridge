// Minimal Chrome DevTools Protocol client for the browser test harness.
// No external dependencies; Node 22+ provides a global WebSocket.

export async function listTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!response.ok) {
    throw new Error(`CDP /json/list returned HTTP ${response.status}`);
  }
  return response.json();
}

export async function createTarget(port, url) {
  const response = await fetch(
    `http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`,
    { method: "PUT" }
  );
  if (!response.ok) {
    throw new Error(`CDP /json/new returned HTTP ${response.status}`);
  }
  return response.json();
}

export async function waitForTarget(port, predicate, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const targets = await listTargets(port);
    const found = targets.find(predicate);
    if (found) return found;
    await sleep(200);
  }
  throw new Error("Timed out waiting for a CDP target.");
}

export class CDP {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.events = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    this.ws.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) {
          reject(new Error(`${message.error.message} (${message.error.code})`));
        } else {
          resolve(message.result);
        }
        return;
      }
      const handlers = this.events.get(message.method);
      if (handlers) {
        for (const handler of handlers) handler(message.params);
      }
    });

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP WebSocket open timeout")), 5000);
      this.ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      });
      this.ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("CDP WebSocket error"));
      });
    });
  }

  send(method, params = {}) {
    if (!this.ws) {
      return Promise.reject(new Error("CDP socket is not connected."));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, handler) {
    if (!this.events.has(method)) this.events.set(method, new Set());
    this.events.get(method).add(handler);
  }

  async evaluate(expression, options = {}) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: options.awaitPromise !== false,
      returnByValue: options.returnByValue !== false,
      userGesture: options.userGesture !== false
    });
    if (result.exceptionDetails) {
      const details = result.exceptionDetails;
      const text = details.exception?.description
        || details.exception?.value
        || details.text
        || "Runtime.evaluate exception";
      throw new Error(text);
    }
    return result.result?.value;
  }

  async navigate(url) {
    await this.send("Page.enable");
    await this.send("Page.navigate", { url });
    await this.waitFor(
      () => this.evaluate("document.readyState === 'complete'"),
      15000
    );
  }

  async waitFor(fn, timeoutMs = 10000, intervalMs = 200) {
    const start = Date.now();
    let lastError = null;
    while (Date.now() - start < timeoutMs) {
      try {
        if (await fn()) return true;
      } catch (error) {
        lastError = error;
      }
      await sleep(intervalMs);
    }
    throw new Error(`Timed out waiting for condition${lastError ? `: ${lastError.message}` : ""}`);
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      // Ignore.
    }
    this.ws = null;
  }
}

export async function connectTarget(target) {
  const cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.connect();
  return cdp;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
