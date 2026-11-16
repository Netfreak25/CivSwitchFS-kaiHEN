// Scratch generator: bakes the current chain payload into a parse-probe
// entry (wrap-probe.mjs) for on-console syntax testing. Safe: parse-only
// via new Function, never executes the payload.
import fs from "node:fs";
import {buildPayload} from "./bundle.mjs";

const r = await buildPayload({entry: "src/chain.mjs"});
const mod =
    'import coreRuntime from "./core/runtime.mjs";\n' +
    "const T = " + JSON.stringify(r.payload) + ";\n" +
    "export async function run() {\n" +
    "  const {log} = coreRuntime;\n" +
    '  try { new Function("return (function(){\\n" + T + "\\n})"); await log("WRAP-plain OK"); } catch (e) { await log("WRAP-plain FAIL: " + e.message); }\n' +
    '  try { new Function("return (async function(){\\n" + T + "\\n})"); await log("WRAP-async OK"); } catch (e) { await log("WRAP-async FAIL: " + e.message); }\n' +
    '  await log("WRAP done");\n' +
    "}\n";
fs.writeFileSync("src/wrap-probe.mjs", mod);
const p = await buildPayload({entry: "src/wrap-probe.mjs"});
console.log("probe builds OK: " + p.bytes + " bytes");
