// Minimal HTTP CONNECT proxy for browser tests.
//
// Chrome is launched with --proxy-server=http://127.0.0.1:<port>. HTTPS
// requests use CONNECT; every CONNECT target is redirected to the local HTTPS
// mock. Plain HTTP is rejected (the test pages use HTTPS).

import fs from "node:fs";
import net from "node:net";

const LISTEN_PORT = Number(process.env.PROXY_PORT || 9471);
const TARGET_HOST = process.env.PROXY_TARGET_HOST || "127.0.0.1";
const TARGET_PORT = Number(process.env.PROXY_TARGET_PORT || 9443);
const LOG_FILE = process.env.PROXY_LOG || "";

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  startHttpProxy({ listenPort: LISTEN_PORT, targetHost: TARGET_HOST, targetPort: TARGET_PORT, logFile: LOG_FILE })
    .then((server) => {
      console.log(`http proxy listening on 127.0.0.1:${server.address().port} -> ${TARGET_HOST}:${TARGET_PORT}`);
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}

export function startHttpProxy({ listenPort = 9471, targetHost = "127.0.0.1", targetPort = 9443, logFile = "" } = {}) {
  const server = net.createServer((client) => {
    client.on("error", () => {});
    let buffer = Buffer.alloc(0);
    let connected = false;

    const onData = (chunk) => {
      if (connected) return;
      buffer = Buffer.concat([buffer, chunk]);
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;

      const header = buffer.subarray(0, headerEnd).toString("latin1");
      const rest = buffer.subarray(headerEnd + 4);
      const firstLine = header.split("\r\n")[0] || "";
      const match = firstLine.match(/^CONNECT\s+([^\s:]+):(\d+)\s+HTTP\/1\.[01]$/i);
      if (!match) {
        try {
          client.end("HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\n\r\n");
        } catch {
          // Ignore.
        }
        return;
      }

      log(logFile, { ts: new Date().toISOString(), target: `${match[1]}:${match[2]}` });

      const upstream = net.connect(targetPort, targetHost, () => {
        buffer = Buffer.alloc(0);
        try {
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        } catch {
          upstream.destroy();
          return;
        }
        if (rest.length) upstream.write(rest);
        connected = true;
        client.pipe(upstream);
        upstream.pipe(client);
      });
      upstream.on("error", () => {
        try {
          client.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
        } catch {
          // Ignore.
        }
        client.destroy();
      });
    };

    client.on("data", onData);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenPort, "127.0.0.1", () => resolve(server));
  });
}

function log(logFile, entry) {
  if (!logFile) return;
  try {
    fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
  } catch {
    // Ignore.
  }
}
