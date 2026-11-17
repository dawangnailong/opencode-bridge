// Minimal SOCKS5 proxy for the browser tests.
//
// Chrome is launched with --proxy-server=socks5://127.0.0.1:<port>. Every
// target is redirected to the local HTTPS mock (default 127.0.0.1:9443), so
// the test never reaches the real OpenCode service. TLS is still end-to-end
// from Chrome to the mock; the test profile uses --ignore-certificate-errors.

import fs from "node:fs";
import net from "node:net";

const LISTEN_PORT = Number(process.env.SOCKS_PORT || 9470);
const TARGET_HOST = process.env.SOCKS_TARGET_HOST || "127.0.0.1";
const TARGET_PORT = Number(process.env.SOCKS_TARGET_PORT || 9443);
const LOG_FILE = process.env.SOCKS_LOG || "";

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  startSocksProxy({ listenPort: LISTEN_PORT, targetHost: TARGET_HOST, targetPort: TARGET_PORT, logFile: LOG_FILE })
    .then((server) => {
      console.log(`socks5 listening on 127.0.0.1:${server.address().port} -> ${TARGET_HOST}:${TARGET_PORT}`);
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}

export function startSocksProxy({ listenPort = 9470, targetHost = "127.0.0.1", targetPort = 9443, logFile = "" } = {}) {
  const server = net.createServer((client) => {
    handleClient(client, { targetHost, targetPort, logFile });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenPort, "127.0.0.1", () => resolve(server));
  });
}

function handleClient(client, { targetHost, targetPort, logFile }) {
  client.on("error", () => {});
  let buffer = Buffer.alloc(0);
  let state = "greeting";
  let target = null;

  client.on("data", (chunk) => {
    if (state === "connected") return;
    buffer = Buffer.concat([buffer, chunk]);
    if (state === "greeting") {
      if (buffer.length < 2) return;
      if (buffer[0] !== 0x05) {
        client.destroy();
        return;
      }
      const methodCount = buffer[1];
      if (buffer.length < 2 + methodCount) return;
      // We only support "no authentication".
      client.write(Buffer.from([0x05, 0x00]));
      buffer = buffer.subarray(2 + methodCount);
      state = "request";
    }

    if (state === "request") {
      const parsed = parseRequest(buffer);
      if (!parsed) return;
      buffer = parsed.rest;
      target = parsed.target;
      log(logFile, { ts: new Date().toISOString(), target });

      const upstream = net.connect(targetPort, targetHost, () => {
        // Success, bound address 0.0.0.0:0.
        client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        if (buffer.length) upstream.write(buffer);
        buffer = Buffer.alloc(0);
        client.pipe(upstream);
        upstream.pipe(client);
      });
      upstream.on("error", () => {
        try {
          client.write(Buffer.from([0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        } catch {
          // Ignore.
        }
        client.destroy();
      });
      state = "connected";
    }
  });

  client.on("close", () => {});
}

function parseRequest(buffer) {
  if (buffer.length < 4) return null;
  if (buffer[0] !== 0x05) return null;
  const command = buffer[1];
  if (command !== 0x01) {
    // CONNECT only.
    return { rest: buffer.subarray(4), target: "unsupported" };
  }
  const addressType = buffer[3];
  let offset = 4;
  let host = "";

  if (addressType === 0x01) {
    if (buffer.length < offset + 4 + 2) return null;
    host = `${buffer[offset]}.${buffer[offset + 1]}.${buffer[offset + 2]}.${buffer[offset + 3]}`;
    offset += 4;
  } else if (addressType === 0x03) {
    if (buffer.length < offset + 1) return null;
    const length = buffer[offset];
    offset += 1;
    if (buffer.length < offset + length + 2) return null;
    host = buffer.subarray(offset, offset + length).toString("utf8");
    offset += length;
  } else if (addressType === 0x04) {
    if (buffer.length < offset + 16 + 2) return null;
    host = "ipv6";
    offset += 16;
  } else {
    return { rest: buffer.subarray(offset), target: "bad-atyp" };
  }

  const port = buffer.readUInt16BE(offset);
  return {
    target: `${host}:${port}`,
    rest: buffer.subarray(offset + 2)
  };
}

function log(logFile, entry) {
  if (!logFile) return;
  try {
    fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
  } catch {
    // Ignore.
  }
}
