// Save tree audit — build the savetree payload, send it to a console
// running the CivSwitch Remote JS Loader, and stream the save-tree walk
// back. Needs NO promoted session and no prior acquisition: the save is
// read through a clone of the game's own mounted save (SDK mount-table
// lookup, live while Civ7 runs).
// Exits 0 only when the walk ends with "SAVETREE VERDICT: clean"
// (leftover donor artifacts / leftover /hole change that verdict).
//
// Usage:
//   node tools/savetree.mjs <console-ip> [root] [--port 9026]
//   npm run savetree -- <console-ip>

import net from "node:net";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {buildPayload} from "./bundle.mjs";

const TOOLS_DIR = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(TOOLS_DIR, "savetree-entry.mjs");
const TIMEOUT_MS = 180_000;

function pad(value, width) {
    const text = String(value);
    return text.length >= width ? text : "0".repeat(width - text.length) + text;
}

function timestamp() {
    const date = new Date();
    return "[" + pad(date.getHours(), 2) + ":" + pad(date.getMinutes(), 2) +
        ":" + pad(date.getSeconds(), 2) + "." +
        pad(date.getMilliseconds(), 3) + "] ";
}

function send(host, port, code) {
    return new Promise(resolve => {
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            resolve();
        };
        const socket = net.createConnection({host, port}, () => {
            socket.write(code, () => socket.end());
        });
        socket.setTimeout(TIMEOUT_MS);
        socket.on("data", chunk => process.stdout.write(timestamp() + chunk));
        socket.on("end", finish);
        socket.on("timeout", () => {
            console.error("\n[savetree] receive timeout");
            socket.destroy();
            finish();
        });
        socket.on("error", error => {
            console.error("\n[savetree] connection error: " + error.message);
            finish();
        });
    });
}

const args = process.argv.slice(2);
const ipArg = args.find(arg => /^\d+\.\d+\.\d+\.\d+$/.test(arg));
if (!ipArg) {
    console.log("Usage: node tools/savetree.mjs <console-ip> [root] " +
        "[--port 9026]");
    process.exit(1);
}
const positional = args.filter(arg => arg !== ipArg && !arg.startsWith("--"));
const root = positional[0] || "/";
let port = 9026;
const portIndex = args.indexOf("--port");
if (portIndex >= 0 && /^\d+$/.test(args[portIndex + 1] || ""))
    port = Number(args[portIndex + 1]);

const built = await buildPayload({entry: ENTRY});
console.log("-- savetree payload: " + built.bytes + " bytes -> " +
    ipArg + ":" + port + " (save root " + root + ") --");

if (root !== "/")
    await send(ipArg, port,
        "globalThis.__SAVETREE_ROOT = " + JSON.stringify(root) + ";");
const full = await send(ipArg, port, built.payload);

if (/NO SAVE/.test(full)) {
    console.error("\n-- save mount not found: Civ7 must be in-game with " +
        "its save mounted --");
    process.exitCode = 1;
} else if (!/SAVETREE VERDICT: clean/.test(full)) {
    process.exitCode = 1;
}
