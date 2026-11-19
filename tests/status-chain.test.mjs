import test from "node:test";
import assert from "node:assert/strict";

import {classifyChainStatus, createChainStatus} from
    "../src/core/status-chain.mjs";
import {installVisualLogPatch} from "../src/core/visuals.mjs";

const OBSERVER = "__CIVSWITCHFS_STATUS_OBSERVER_V1__";
const LOG_STATE = "__CIVSWITCHFS_VISUAL_LOG_STATE_V2__";

class Element {
    constructor(tagName) {
        this.tagName = tagName;
        this.children = [];
        this.attributes = {};
        this.style = {};
        this.className = "";
        this.textContent = "";
        this.isConnected = false;
        this.scrollTop = 0;
        this.clientHeight = 0;
        this.scrollHeight = 0;
        this.listeners = new Map();
    }

    appendChild(child) {
        this.children.push(child);
        child.isConnected = this.isConnected;
        child.parentNode = this;
        return child;
    }

    removeChild(child) {
        this.children.splice(this.children.indexOf(child), 1);
        child.parentNode = null;
    }

    addEventListener(name, listener) {
        const group = this.listeners.get(name) || [];
        group.push(listener);
        this.listeners.set(name, group);
    }

    get childElementCount() { return this.children.length; }
    get firstElementChild() { return this.children[0]; }
    setAttribute(name, value) { this.attributes[name] = value; }
    getAttribute(name) { return this.attributes[name]; }
    removeAttribute(name) { delete this.attributes[name]; }
}

/** Isolate the UI and logger globals used by the existing status bridge. */
async function withDocument(run) {
    const names = ["document", "window", "innerWidth", "innerHeight",
        "engine", "addEventListener", "fsKaihen", "__KH", "__KH_TRACKED",
        "__CIVSWITCH_CORE_API__", "log", OBSERVER, LOG_STATE,
        "__CIVSWITCHFS_VISUAL_LOGGER_V2__", "__CIVSWITCHFS_STATUS_ERROR__"];
    const saved = names.map(name => [name,
        Object.getOwnPropertyDescriptor(globalThis, name)]);
    const body = new Element("body");
    body.isConnected = true;
    const document = {
        body,
        documentElement: {clientWidth: 1280},
        createElement: tagName => new Element(tagName),
        querySelector: () => null
    };
    let inputAction;
    Object.assign(globalThis, {
        document,
        window: {requestAnimationFrame: callback => callback()},
        innerWidth: 1280,
        innerHeight: 720,
        addEventListener() {},
        engine: {on(_name, listener) { inputAction = listener; }},
        fsKaihen: undefined,
        __KH: undefined,
        __KH_TRACKED: undefined,
        __CIVSWITCH_CORE_API__: {log: async () => {}},
        log: async () => {}
    });
    for (const name of [OBSERVER, LOG_STATE,
        "__CIVSWITCHFS_VISUAL_LOGGER_V2__", "__CIVSWITCHFS_STATUS_ERROR__"])
        delete globalThis[name];
    try {
        return await run({document, inputAction: (...args) => inputAction(...args)});
    } finally {
        for (const [name, descriptor] of saved) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else delete globalThis[name];
        }
    }
}

function find(root, className) {
    if (root.className === className) return root;
    for (const child of root.children) {
        const match = find(child, className);
        if (match) return match;
    }
    return null;
}

test("classification separates completed HEN, exhausted FS, and unknown", () => {
    assert.deepEqual(classifyChainStatus({session: true, exhausted: false,
        complete: true}), {kind: "success"});
    assert.deepEqual(classifyChainStatus({session: false, exhausted: true,
        complete: false}), {kind: "failure", code: "access-not-established"});
    assert.deepEqual(classifyChainStatus({session: false, exhausted: false,
        complete: false}), {kind: "unconfirmed"});
    assert.deepEqual(classifyChainStatus({session: true, exhausted: true,
        complete: false}), {kind: "unconfirmed"});
});

test("success appears only after finish sees the exact completion proof", async () => {
    await withDocument(async ({document}) => {
        const status = createChainStatus();
        status.beginRun(1);
        const root = document.body.children[0];
        status.phase("fs");
        globalThis.fsKaihen = {domainSession: {}};
        globalThis.__KH = {stages: {complete: {proof: {ok: true}}}};
        assert.equal(root.getAttribute("data-result"), "running");
        assert.deepEqual(status.finish(), {kind: "success"});
        assert.equal(root.getAttribute("data-result"), "success");
        assert.equal(find(root, "kh-title").textContent, "kaiHEN is active");
    });
    await withDocument(async ({document}) => {
        const status = createChainStatus();
        status.beginRun(1);
        globalThis.fsKaihen = {domainSession: {}};
        globalThis.__KH = {stages: {complete: {proof: {ok: 1}}}};
        assert.deepEqual(status.finish(), {kind: "unconfirmed"});
        assert.equal(document.body.children[0].getAttribute("data-result"),
            "unconfirmed");
    });
    await withDocument(async ({document}) => {
        globalThis.__KH = {stages: {complete: {proof: {ok: true}}}};
        const status = createChainStatus();
        status.beginRun(1);
        globalThis.fsKaihen = {domainSession: {}};
        assert.deepEqual(status.finish(), {kind: "unconfirmed"});
        assert.equal(document.body.children[0].getAttribute("data-result"),
            "unconfirmed");
    });
});

test("a cleanly exhausted FS stage is failure; missing evidence is unknown", async () => {
    await withDocument(async ({document}) => {
        const status = createChainStatus();
        status.beginRun(1);
        status.phase("fs");
        globalThis[OBSERVER]("Stopped after 10 attempts; user storage access was not verified.");
        assert.deepEqual(status.finish(), {
            kind: "failure", code: "access-not-established"
        });
        assert.equal(document.body.children[0].getAttribute("data-result"),
            "failure");
    });
    await withDocument(async ({document}) => {
        const status = createChainStatus();
        status.beginRun(1);
        status.phase("fs");
        assert.deepEqual(status.finish(), {kind: "unconfirmed"});
        assert.equal(document.body.children[0].getAttribute("data-result"),
            "unconfirmed");
    });
});

test("a DOM error cannot change the payload verdict", async () => {
    await withDocument(async ({document}) => {
        const status = createChainStatus();
        status.beginRun(1);
        const root = document.body.children[0];
        root.setAttribute = () => { throw Error("DOM replaced"); };
        assert.doesNotThrow(() => status.phase("fs"));
        globalThis.fsKaihen = {domainSession: {}};
        globalThis.__KH = {stages: {complete: {proof: {ok: true}}}};
        assert.deepEqual(status.finish(), {kind: "success"});
        assert.equal(globalThis.__CIVSWITCHFS_STATUS_ERROR__, "DOM replaced");
    });
});

test("existing logger drives attempts and HEN milestones without raw-log repaints", async () => {
    await withDocument(async ({document, inputAction}) => {
        const status = createChainStatus();
        status.beginRun(1);
        status.phase("fs");
        installVisualLogPatch();
        const root = document.body.children[0];

        await globalThis.log("======== ATTEMPT 1 ========");
        assert.equal(find(root, "kh-count").textContent, "01");
        const titleBefore = find(root, "kh-title").textContent;
        await globalThis.log("Worker detail inside the current attempt");
        assert.equal(find(root, "kh-title").textContent, titleBefore);

        status.phase("files");
        await globalThis.log("CHAIN: promotion retained a session — starting kaiHEN");
        assert.equal(root.getAttribute("data-milestone"), "hen-prep");
        await globalThis.log("KH: SD manifest present: bootstrap, ro, hen, game");
        assert.equal(root.getAttribute("data-milestone"), "files-verified");
        assert.equal(root.getAttribute("data-reached"), "files");
        await globalThis.log("KH: --- stage: endpoint");
        assert.equal(root.getAttribute("data-reached"), "hen");
        await globalThis.log("KH: handoff verified: loader session idle");
        assert.equal(root.getAttribute("data-milestone"), "handoff");
        assert.equal(globalThis[LOG_STATE].output.style.display, "none");

        inputAction("minus", 0);
        assert.equal(root.getAttribute("data-view"), "logs");
        assert.match(find(root, "kh-log-content").textContent,
            /handoff verified: loader session idle/);
        assert.equal(globalThis.__CIVSWITCHFS_STATUS_ERROR__, undefined);
    });
});

test("the chain waits for A only when the status UI is available", async () => {
    await withDocument(async ({inputAction}) => {
        const status = createChainStatus();
        let started = false;
        const start = status.waitForStart().then(() => { started = true; });
        await Promise.resolve();
        assert.equal(started, false);
        inputAction("a", 0);
        await start;
        assert.equal(started, true);
    });
    await withDocument(async () => {
        globalThis.document = undefined;
        const status = createChainStatus();
        assert.equal(status.available, false);
        await status.waitForStart();
        assert.deepEqual(status.finish(), {kind: "unconfirmed"});
        assert.equal(await status.waitForRetry(), false);
    });
});

test("status bridge offers the native reader and keeps input fallback", async () => {
    await withDocument(async ({inputAction}) => {
        let factoryCalls = 0;
        const status = createChainStatus(() => {
            factoryCalls++;
            throw Error("native reader unavailable in this test");
        });
        assert.equal(factoryCalls, 1);
        assert.equal(status.available, true);
        const started = status.waitForStart();
        inputAction("a", 0);
        await started;
    });
});

test("X retries a clean FS exhaustion only after release", async () => {
    await withDocument(async ({inputAction}) => {
        const status = createChainStatus();
        status.beginRun(1);
        status.phase("fs");
        globalThis[OBSERVER]("======== ATTEMPT 10 ========");
        globalThis[OBSERVER]("Cleanup is sufficient for another attempt.");
        globalThis[OBSERVER](
            "Stopped after 10 attempts; user storage access was not verified. " +
            "Qualified windows: 2/40 (5%).");
        globalThis[OBSERVER](
            "CHAIN: promotion did not retain a session — stopping here");
        assert.deepEqual(status.finish(), {
            kind: "failure", code: "access-not-established"
        });
        let resolved = false;
        const retry = status.waitForRetry().then(value => {
            resolved = true;
            return value;
        });
        assert.equal(status.waitForRetry(), status.waitForRetry());
        inputAction("x", 0);
        await Promise.resolve();
        assert.equal(resolved, false);
        inputAction("x", 1);
        assert.equal(await retry, true);

        status.beginRun(2);
        status.phase("fs");
        assert.deepEqual(status.finish(), {kind: "unconfirmed"});
        assert.equal(await status.waitForRetry(), false);
    });
});

test("restart advice, FS errors and HEN state prevent an X retry", async () => {
    const cases = [
        {name: "restart advice", log:
            "Stopped after 10 attempts; user storage access was not verified. " +
            "Qualified windows: 38/40 (95%). Restart the game before another run."},
        {name: "FS error", setup: () => globalThis[OBSERVER](
            "Unexpected error. Checking cleanup status.")},
        {name: "HEN phase", afterEvidence: status => status.phase("files")},
        {name: "HEN ledger", setup: () => {
            globalThis.__KH = {stages: {launch: {proof: {ok: true}}}};
        }},
        {name: "tracked HEN state", setup: () => {
            globalThis.__KH_TRACKED = {handles: []};
        }}
    ];
    for (const scenario of cases) {
        await withDocument(async () => {
            const status = createChainStatus();
            status.beginRun(1);
            status.phase("fs");
            scenario.setup?.(status);
            globalThis[OBSERVER]("Cleanup complete.");
            globalThis[OBSERVER](scenario.log ||
                "Stopped after 10 attempts; user storage access was not verified.");
            globalThis[OBSERVER](
                "CHAIN: promotion did not retain a session — stopping here");
            scenario.afterEvidence?.(status);
            assert.deepEqual(status.finish(), {
                kind: "failure", code: "access-not-established"
            }, scenario.name);
            assert.equal(await status.waitForRetry(), false, scenario.name);
        });
    }
});

test("X retry needs cleanup and a returned no-session chain in this run", async () => {
    const cases = [
        {name: "missing cleanup", logs: [
            "Stopped after 10 attempts; user storage access was not verified.",
            "CHAIN: promotion did not retain a session — stopping here"
        ]},
        {name: "missing chain end", logs: [
            "Cleanup complete.",
            "Stopped after 10 attempts; user storage access was not verified."
        ]},
        {name: "cleanup belonged to an earlier attempt", logs: [
            "======== ATTEMPT 1 ========",
            "Cleanup is sufficient for another attempt.",
            "======== ATTEMPT 2 ========",
            "Stopped after 2 attempts; user storage access was not verified.",
            "CHAIN: promotion did not retain a session — stopping here"
        ]}
    ];
    for (const scenario of cases) {
        await withDocument(async () => {
            const status = createChainStatus();
            status.beginRun(1);
            status.phase("fs");
            for (const log of scenario.logs) globalThis[OBSERVER](log);
            assert.deepEqual(status.finish(), {
                kind: "failure", code: "access-not-established"
            }, scenario.name);
            assert.equal(await status.waitForRetry(), false, scenario.name);
        });
    }
});
