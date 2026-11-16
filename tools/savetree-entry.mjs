// Save tree audit payload — walks the GAME SAVE's tree through a clone
// of the game's own mounted save (openMount("save") — F_FindMount
// against the live SDK mount table, the same primitive the donor stage
// and the /hole cleanup use). Needs NO promoted session and no prior
// acquisition on the boot: any CivSwitch Remote JS Loader eval has the
// primitives, and Civ7 keeps its save mounted once in-game.
// Reports every entry (file/dir + size), tags the chain's known
// artifacts (donor leftovers /main + /main.npdm, the /hole scratch),
// and sha256-hashes the donor leftovers so a torn or altered donor is
// visible at a glance.
//
// Tools-side driver: tools/savetree.mjs.
// Root override (set by the driver): globalThis.__SAVETREE_ROOT
// (default "/").

import coreRuntime from "../src/core/runtime.mjs";
import {cmifSend} from "../src/kaihen/wire.mjs";
import {u64Bytes} from "../src/kaihen/state.mjs";
import {sha256} from "../src/kaihen/sha256.mjs";

const {
  allocPage, closeHandle, ipcGetEntryTypeChecked, ipcReadFileChecked,
  openMount, read64, read8, writeStr
} = coreRuntime;

// Known artifacts and their expectation. /main is the donor RO image
// (copied from the release's ro/main); /main.npdm is the captured RO
// policy — size varies per capture, so only /main gets a hard digest.
const DONOR_MAIN_SHA =
    "2e577a4c680a3ba580bcda2f8d41ada443cb33cad79e06230ce4bcf6700661b7";
const DONOR_MAIN_SIZE = 23854;
const TAGS = {
    "/hole": "CivSwitchFS scratch (leftover!)",
    "/main": "kaiHEN donor RO image (leftover!)",
    "/main.npdm": "kaiHEN donor policy (leftover!)"
};
const HASH_LIMIT = 512 * 1024;
const DIR_BATCH = 64;
const WALK_DEPTH = 6;

function shortSha(digest) { return digest.slice(0, 12); }

// -- Directory IPC against an IFileSystem handle ---------------------------
// Built with the kaiHEN wire builder (proven X/B descriptor encoding and
// the automatic bare svc#0x22 fallback: the SDK dispatcher gadget rejects
// some shapes with the bogus non-Result word 0x25A0B — the hand-rolled
// packets hit exactly that). FsDirectoryEntry: name[0x301], type u8
// @0x304, size u64 @0x308, stride 0x310 (Atmosphere fs_directory.hpp).

function saveOpenDirectory(save, path, mode) {
    const pathBuf = allocPage(0x1000);
    writeStr(pathBuf, path);
    const pkt = allocPage(0x2000);
    const reply = cmifSend(save, {
        pkt, cmd: 9,
        x: [{addr: pathBuf, size: path.length + 1}],
        input: [mode & 0xff, 0, 0, 0]
    });
    if (reply.transport !== 0 || reply.result !== 0 ||
        !reply.moves || !reply.moves.length)
        throw Error("OpenDirectory " + path + " failed: transport=" +
            reply.transport + " result=" + reply.result);
    return reply.moves[0];
}

function saveReadDirectory(dirHandle, maxEntries) {
    const buf = allocPage(0x310 * maxEntries);
    const pkt = allocPage(0x2000);
    // Same shape as the proven IFile::Read (sdReadFileChunk): u64
    // input, one B map-alias buffer, static out = u64 count.
    const entryBytes = 0x310 * maxEntries;
    const reply = cmifSend(dirHandle, {
        pkt, cmd: 0,
        input: u64Bytes(BigInt(maxEntries)),
        b: [{addr: buf, size: entryBytes}]
    });
    if (reply.transport !== 0 || reply.result === undefined ||
        reply.result !== 0)
        throw Error("IDirectory::Read failed: transport=" + reply.transport +
            " result=" + reply.result);
    const count = Number(read64(pkt + BigInt(reply.dataAt)));
    if (!(count >= 0 && count <= maxEntries))
        throw Error("IDirectory::Read count " + count);
    const out = [];
    for (let i = 0; i < count; i++) {
        const base = buf + BigInt(i * 0x310);
        let name = "";
        for (let k = 0; k < 0x300; k++) {
            const c = Number(read8(base + BigInt(k))) & 0xff;
            if (c === 0) break;
            name += String.fromCharCode(c);
        }
        out.push({name,
            isDir: (Number(read8(base + 0x304n)) & 0xff) === 0,
            size: Number(read64(base + 0x308n))});
    }
    return out;
}

export async function run() {
    const root = globalThis.__SAVETREE_ROOT || "/";
    await log("SAVETREE root " + root + " depth " + WALK_DEPTH +
        " (type+size per entry via the game's mounted save; donor files" +
        " hashed when <= " + HASH_LIMIT + " bytes)");

    const mount = openMount("save");
    if (!mount || !mount.handle) {
        await log("NO SAVE: the save mount was not found in the SDK " +
            "mount table — only Civ7 with its save mounted has one");
        return;
    }
    const save = mount.handle;
    try {
        if (root !== "/") {
            const entry = ipcGetEntryTypeChecked(save, root);
            if (entry.result !== 0) {
                await log("SAVETREE root " + root + " missing (transport=" +
                    entry.transport + " result=" + entry.result + ")");
                return;
            }
        }

        const aware = new Set(Object.keys(TAGS));
        const dirs = [];
        const files = [];
        let totalBytes = 0;
        let hashOk = 0, hashBad = 0;
        const leftovers = [];

        async function walk(path, depth) {
            const dirHandle = saveOpenDirectory(save, path, 3);
            let entries;
            try {
                // IDirectory::Read keeps a server-side cursor: loop until
                // a short batch so directories with more than DIR_BATCH
                // entries are not silently truncated.
                entries = [];
                for (;;) {
                    const batch = saveReadDirectory(dirHandle, DIR_BATCH);
                    entries = entries.concat(batch);
                    if (batch.length < DIR_BATCH) break;
                }
            } finally {
                closeHandle(dirHandle);
            }
            entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
            for (const e of entries) {
                const child = (path === "/" ? "" : path) + "/" + e.name;
                if (e.isDir) {
                    dirs.push(child);
                    await log("D " + child + (TAGS[child] ?
                        " [" + TAGS[child] + "]" : "") +
                        (depth > 1 ? "" : " (depth cap)"));
                    if (depth > 1) await walk(child, depth - 1);
                } else {
                    files.push(child);
                    totalBytes += e.size;
                    let verdict = "";
                    if (child === "/main" && e.size <= HASH_LIMIT) {
                        const read = ipcReadFileChecked(save, child,
                            HASH_LIMIT);
                        if (read.ok) {
                            const digest = sha256(read.bytes);
                            const sizeOk = e.size === DONOR_MAIN_SIZE;
                            const hashOkThis = digest === DONOR_MAIN_SHA;
                            if (hashOkThis) hashOk++; else hashBad++;
                            verdict = " [donor " +
                                (sizeOk ? "size ok" : "SIZE " + e.size +
                                    " != " + DONOR_MAIN_SIZE) + " sha " +
                                (hashOkThis ? "ok " + shortSha(digest) :
                                    "MISMATCH got " + shortSha(digest) +
                                    " want " + shortSha(DONOR_MAIN_SHA)) + "]";
                        } else {
                            verdict = " [donor read failed: " + read.stage + "]";
                        }
                    } else if (child === "/main.npdm" && e.size <= HASH_LIMIT) {
                        const read = ipcReadFileChecked(save, child, HASH_LIMIT);
                        verdict = read.ok ?
                            " [donor sha " + shortSha(sha256(read.bytes)) + "]" :
                            " [donor read failed: " + read.stage + "]";
                    }
                    if (aware.has(child)) leftovers.push(child);
                    await log("F " + child + " " + e.size + verdict);
                }
            }
        }

        await walk(root, WALK_DEPTH);

        await log("SAVETREE totals: " + files.length + " files, " +
            dirs.length + " dirs, " + totalBytes + " bytes under " + root);
        if (leftovers.length) {
            for (const path of leftovers)
                await log("SAVETREE LEFTOVER " + TAGS[path] + " " + path +
                    " — the next cleanup wipes it");
            await log("SAVETREE VERDICT: " + (hashBad ?
                hashBad + " donor file MISMATCHED" : "leftovers present") +
                " (recovered or wiped next attempt)");
        } else {
            await log("SAVETREE VERDICT: clean");
        }
    } finally {
        closeHandle(save);
    }
}
