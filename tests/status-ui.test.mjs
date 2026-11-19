import test from "node:test";
import assert from "node:assert/strict";

import {createLocalHackUI} from "../src/core/status-ui.mjs";

class Element {
    constructor(tagName) {
        this.tagName = tagName;
        this.children = [];
        this.attributes = {};
        this.style = {};
        this.className = "";
        this.textContent = "";
        this.listeners = new Map();
    }

    appendChild(child) {
        this.children.push(child);
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

    click() {
        for (const listener of this.listeners.get("click") || []) listener({});
    }

    dispatch(name) {
        for (const listener of this.listeners.get(name) || []) listener({});
    }

    setAttribute(name, value) {
        this.attributes[name] = value;
    }

    getAttribute(name) {
        return this.attributes[name];
    }

    removeAttribute(name) {
        delete this.attributes[name];
    }
}

/** Run one UI scenario with a minimal DOM and restore the process globals. */
function withDocument(run) {
    const names = ["document", "innerWidth", "innerHeight", "engine",
        "addEventListener", "removeEventListener"];
    const saved = names.map(name => [name,
        Object.getOwnPropertyDescriptor(globalThis, name)]);
    const document = {
        body: new Element("body"),
        createElement: tagName => new Element(tagName)
    };
    const listeners = new Map();
    let nativeInput;
    Object.assign(globalThis, {
        document,
        innerWidth: 1280,
        innerHeight: 720,
        addEventListener(name, listener) {
            const group = listeners.get(name) || [];
            group.push(listener);
            listeners.set(name, group);
        },
        removeEventListener(name, listener) {
            const group = listeners.get(name) || [];
            listeners.set(name, group.filter(candidate => candidate !== listener));
        },
        engine: {
            on(name, listener) {
                assert.equal(name, "InputAction");
                nativeInput = listener;
            }
        }
    });
    try {
        return run({
            document,
            emit(name, detail) {
                for (const listener of listeners.get(name) || []) {
                    listener({detail, key: detail.key, repeat: detail.repeat,
                        preventDefault() {}, stopImmediatePropagation() {}});
                }
            },
            nativeInput: (...args) => nativeInput(...args)
        });
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

function visibleText(root) {
    if (root.tagName === "style") return "";
    return [root.textContent, ...root.children.map(visibleText)].join(" ");
}

function allElements(root) {
    return [root, ...root.children.flatMap(allElements)];
}

test("the seven English states render and terminal results stay visible", () => {
    withDocument(({document}) => {
        const ui = createLocalHackUI();
        const root = document.body.children[0];
        assert.equal(ui.available, true);
        assert.match(visibleText(root), /Start kaiHEN/);
        assert.equal(find(root, "kh-wordmark").textContent, "CivSwitchFS-kaiHEN");
        assert.equal(find(root, "kh-build").textContent, "UI build v0.0.2");
        assert.match(find(root, "kh-guide").textContent,
            /Frequent view switching may affect timing; this has not been confirmed\./);
        assert.equal(root.getAttribute("data-mode"), "intro");
        assert.equal(root.getAttribute("data-result"), "idle");
        assert.deepEqual(find(root, "kh-rail").children.map(child => child.textContent),
            ["FILESYSTEM", "SD FILES", "KAIHEN"]);
        assert.deepEqual(allElements(root).filter(element =>
            element.tagName.toLowerCase() === "button")
            .map(element => element.children.map(child => child.textContent)),
        [["A", "Start"], ["X", "Try again"]]);
        assert.deepEqual(allElements(root).filter(element =>
            element.className.split(" ").includes("kh-keycap"))
            .map(element => element.textContent), ["−", "A", "X", "A", "−"]);
        assert.match(find(root, "kh-view-hint").children[0].className,
            /kh-keycap-minus/);
        assert.match(find(root, "kh-start").getAttribute("aria-label"),
            /^A: Start/);
        assert.match(find(root, "kh-retry").getAttribute("aria-label"),
            /^X: Try again/);
        for (const name of ["fs", "files", "hen"])
            assert.equal(root.getAttribute("data-step-" + name), "pending");

        ui.beginRun(1);
        assert.match(visibleText(root), /Loading kaiHEN/);
        for (const [phase, title] of [
            ["fs", "Establishing access"],
            ["files", "Checking startup files"],
            ["hen", "Starting kaiHEN"]
        ]) {
            ui.phase(phase);
            assert.match(visibleText(root), new RegExp(title));
            assert.equal(root.getAttribute("data-step-" + phase), "running");
        }
        assert.equal(root.getAttribute("data-step-fs"), "verified");
        assert.equal(root.getAttribute("data-step-files"), "verified");
        ui.finish("success");
        assert.equal(root.getAttribute("data-result"), "success");
        for (const name of ["fs", "files", "hen"])
            assert.equal(root.getAttribute("data-step-" + name), "verified");
        assert.match(visibleText(root), /kaiHEN is active/);
        assert.match(visibleText(root), /Fully close Civilization VII now\./);
        ui.phase("fs");
        assert.equal(root.getAttribute("data-result"), "success");

        const failed = createLocalHackUI();
        failed.beginRun(1);
        failed.phase("fs");
        failed.finish("failure", "access-not-established");
        const failureRoot = document.body.children.at(-1);
        assert.equal(failureRoot.getAttribute("data-step-fs"), "failure");
        assert.match(visibleText(failureRoot), /Fully restart the console/);
        assert.match(visibleText(failureRoot), /Filesystem access was not established/);

        const unknown = createLocalHackUI();
        unknown.beginRun(1);
        unknown.phase("fs");
        unknown.phase("files");
        unknown.finish("unconfirmed");
        const unknownRoot = document.body.children.at(-1);
        assert.equal(unknownRoot.getAttribute("data-result"), "unconfirmed");
        assert.equal(unknownRoot.getAttribute("data-step-files"), "unconfirmed");
        assert.match(visibleText(unknownRoot), /No clear completion record/);
    });
});

test("attempts and milestones advance only when new evidence arrives", () => {
    withDocument(({document}) => {
        const ui = createLocalHackUI();
        const root = document.body.children[0];
        const count = find(root, "kh-count");
        ui.attempt(1);
        assert.equal(count.textContent, "00");
        ui.beginRun(1);
        ui.phase("fs");
        ui.attempt(2);
        assert.equal(count.textContent, "02");
        assert.equal(root.getAttribute("data-fs-attempt"), "2");
        ui.attempt(2);
        ui.attempt(1);
        assert.equal(count.textContent, "02");
        ui.milestone("hen-prep");
        assert.match(visibleText(root), /Preparing kaiHEN/);
        ui.milestone("files-verified");
        assert.match(visibleText(root), /Startup files verified/);
        ui.milestone("hen-prep");
        assert.match(visibleText(root), /Startup files verified/);
    });
});

test("beginRun clears the previous terminal result, rail and attempt counter", () => {
    withDocument(({document}) => {
        const ui = createLocalHackUI();
        const root = document.body.children[0];
        ui.beginRun(1);
        ui.phase("fs");
        ui.attempt(9);
        ui.finish("failure");
        ui.beginRun(2);
        assert.equal(root.getAttribute("data-mode"), "running");
        assert.equal(root.getAttribute("data-run"), "2");
        assert.equal(find(root, "kh-count").textContent, "00");
        assert.equal(root.getAttribute("data-fs-attempt"), undefined);
        for (const name of ["fs", "files", "hen"])
            assert.equal(root.getAttribute("data-step-" + name), "pending");
    });
});

test("a later filesystem attempt resets downstream progress and milestones", () => {
    withDocument(({document}) => {
        const ui = createLocalHackUI();
        const root = document.body.children[0];
        ui.beginRun(1);
        ui.phase("fs");
        ui.attempt(1);
        ui.phase("files");
        ui.phase("hen");
        ui.milestone("handoff");
        ui.attempt(1);
        assert.equal(root.getAttribute("data-reached"), "hen");

        ui.attempt(2);
        assert.equal(root.getAttribute("data-reached"), "fs");
        assert.equal(root.getAttribute("data-step-fs"), "running");
        assert.equal(root.getAttribute("data-step-files"), "pending");
        assert.equal(root.getAttribute("data-step-hen"), "pending");
        assert.equal(root.getAttribute("data-milestone"), undefined);
        assert.equal(find(root, "kh-count").textContent, "02");
        assert.equal(find(root, "kh-title").textContent, "Establishing access");
        assert.equal(find(root, "kh-detail").textContent,
            "Filesystem attempt 2 is running.");

        ui.phase("files");
        ui.milestone("hen-prep");
        assert.equal(root.getAttribute("data-step-files"), "running");
        assert.equal(root.getAttribute("data-milestone"), "hen-prep");
    });
});

test("A starts once and X retries only a completed failure", async () => {
    let start;
    withDocument(({document, nativeInput, emit}) => {
        const ui = createLocalHackUI();
        const root = document.body.children[0];
        ui.enableLogToggle(() => []);
        start = ui.waitForStart();
        nativeInput("x", 0);
        assert.equal(root.getAttribute("data-mode"), "intro");
        emit("keydown", {key: "a", repeat: false});
        assert.equal(root.getAttribute("data-mode"), "running");
        nativeInput("a", 0);
        ui.beginRun(1);
        ui.phase("fs");
        assert.equal(ui.offerRetry(() => {}), false);
        ui.finish("failure");
        let retries = 0;
        assert.equal(ui.offerRetry(() => { retries++; }), true);
        assert.equal(ui.offerRetry(() => { retries++; }), false);
        nativeInput("minus", 0);
        nativeInput("x", 1);
        nativeInput("x", 0);
        assert.equal(retries, 0);
        nativeInput("minus", 1);
        nativeInput("minus", 0);
        nativeInput("x", 1);
        nativeInput("x", 0);
        assert.equal(retries, 0);
        assert.equal(root.getAttribute("data-retry"), "armed");
        find(root, "kh-retry").dispatch("pointerup");
        assert.equal(retries, 0);
        nativeInput("x", 1);
        assert.equal(retries, 1);
        assert.equal(root.getAttribute("data-retry"), "requested");
    });
    await start;
});

test("retry guidance appears only when a failed run can be retried", () => {
    withDocument(({document}) => {
        const ui = createLocalHackUI();
        const root = document.body.children[0];
        const instruction = find(root, "kh-instruction");
        ui.beginRun(1);
        ui.phase("fs");
        ui.finish("failure");
        assert.match(instruction.textContent, /Fully restart the console/);
        assert.equal(ui.offerRetry(() => {}), true);
        assert.match(instruction.textContent, /Try again is available below/);
        assert.doesNotMatch(instruction.textContent, /restart the console/i);

        ui.beginRun(2);
        ui.phase("fs");
        ui.finish("unconfirmed");
        assert.equal(ui.offerRetry(() => {}), false);
        assert.match(instruction.textContent, /Fully restart the console/);
    });
});

test("button clicks work and the UI has no power controls", async () => {
    let start;
    withDocument(({document}) => {
        const ui = createLocalHackUI("0.0.19", "preview");
        const root = document.body.children[0];
        assert.equal(find(root, "kh-build").textContent,
            "UI build v0.0.19 / preview");
        assert.equal(allElements(root).some(element =>
            /reboot|shutdown/i.test(element.className)), false);
        start = ui.waitForStart();
        find(root, "kh-start").click();
        ui.beginRun(1);
        ui.phase("fs");
        ui.finish("failure");
        let retries = 0;
        assert.equal(ui.offerRetry(() => { retries++; }), true);
        find(root, "kh-retry").dispatch("pointerdown");
        assert.equal(retries, 0);
        find(root, "kh-retry").dispatch("pointerup");
        find(root, "kh-retry").click();
        assert.equal(retries, 1);
    });
    await start;
});

test("Gamepad X waits for release, including after an engine release event", async () => {
    const savedNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    const savedSetInterval = globalThis.setInterval;
    const savedClearInterval = globalThis.clearInterval;
    const pad = {connected: true, mapping: "standard",
        buttons: Array.from({length: 10}, () => ({pressed: false}))};
    let tick = null;
    let polling = false;
    Object.defineProperty(globalThis, "navigator", {configurable: true,
        value: {getGamepads: () => [pad]}});
    globalThis.setInterval = callback => {
        tick = callback;
        polling = true;
        return 71;
    };
    globalThis.clearInterval = id => {
        assert.equal(id, 71);
        polling = false;
    };
    let start;
    try {
        withDocument(({document, nativeInput}) => {
            const ui = createLocalHackUI();
            const root = document.body.children[0];
            ui.enableLogToggle(() => []);
            start = ui.waitForStart();
            assert.equal(polling, true);
            tick(); // First sample arms only released buttons.
            pad.buttons[1].pressed = true;
            tick();
            assert.equal(root.getAttribute("data-mode"), "running");
            assert.equal(polling, false);

            pad.buttons[1].pressed = false;
            ui.beginRun(1);
            ui.phase("fs");
            ui.attempt(1);
            ui.phase("files");
            ui.phase("hen");
            assert.equal(polling, false);
            ui.finish("failure");
            assert.equal(polling, true);
            let retries = 0;
            assert.equal(ui.offerRetry(() => {
                retries++;
                ui.beginRun(2);
            }), true);
            tick();
            pad.buttons[3].pressed = true;
            tick();
            assert.equal(root.getAttribute("data-retry"), "armed");
            assert.equal(retries, 0);
            assert.equal(polling, true);
            pad.buttons[3].pressed = false;
            tick();
            assert.equal(retries, 1);
            assert.equal(root.getAttribute("data-run"), "2");
            assert.equal(polling, false);

            ui.phase("fs");
            ui.finish("failure");
            assert.equal(ui.offerRetry(() => {
                retries++;
                ui.beginRun(3);
            }), true);
            pad.buttons[3].pressed = true;
            nativeInput("x", 0);
            nativeInput("x", 1);
            assert.equal(retries, 1);
            pad.buttons[3].pressed = false;
            tick();
            assert.equal(retries, 2);
            assert.equal(root.getAttribute("data-run"), "3");
            assert.equal(polling, false);
        });
        await start;
    } finally {
        if (savedNavigator)
            Object.defineProperty(globalThis, "navigator", savedNavigator);
        else delete globalThis.navigator;
        globalThis.setInterval = savedSetInterval;
        globalThis.clearInterval = savedClearInterval;
    }
});

test("Minus switches between status and saved log text once per press", () => {
    withDocument(({document, emit, nativeInput}) => {
        const ui = createLocalHackUI();
        const root = document.body.children[0];
        ui.enableLogToggle(() => ["first line", "second line"]);
        nativeInput("minus", 0);
        assert.equal(root.getAttribute("data-view"), "logs");
        assert.match(find(root, "kh-log-content").textContent, /second line/);
        nativeInput("minus", 0);
        assert.equal(root.getAttribute("data-view"), "logs");
        nativeInput("minus", 1);
        emit("engine-input", {name: "minus", status: 0});
        assert.equal(root.getAttribute("data-view"), "status");
    });
});

test("native HID drives A, Minus, and X release throughout the run", async () => {
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    let tick;
    let active = false;
    let buttons = 0n;
    let closes = 0;
    globalThis.setInterval = (callback, delay) => {
        assert.equal(delay, 40);
        tick = callback;
        active = true;
        return 73;
    };
    globalThis.clearInterval = id => {
        assert.equal(id, 73);
        active = false;
    };
    let start;
    try {
        withDocument(({document, nativeInput}) => {
            const ui = createLocalHackUI();
            const root = document.body.children[0];
            ui.enableLogToggle(() => ["saved log"], () => ({
                poll: () => buttons,
                close: () => { closes++; }
            }));
            start = ui.waitForStart();
            assert.equal(active, true);
            tick(); // Released sample arms A and X.
            assert.equal(nativeInput("a", 0), false); // HID owns input.
            assert.equal(root.getAttribute("data-mode"), "intro");

            buttons = 0x800n;
            tick();
            tick();
            assert.equal(root.getAttribute("data-view"), "logs");
            buttons = 0n;
            tick();
            buttons = 0x1n;
            tick();
            assert.equal(root.getAttribute("data-mode"), "running");
            ui.beginRun(1);
            ui.phase("fs");
            assert.equal(active, true); // Minus remains available during FS.

            buttons = 0n;
            tick();
            buttons = 0x800n;
            tick();
            assert.equal(root.getAttribute("data-view"), "status");
            buttons = 0n;
            tick();
            ui.finish("failure");
            let retries = 0;
            assert.equal(ui.offerRetry(() => {
                retries++;
                ui.beginRun(2);
            }), true);
            tick(); // X must be released after the offer.
            buttons = 0x4n;
            tick();
            assert.equal(root.getAttribute("data-retry"), "armed");
            assert.equal(retries, 0);
            buttons = 0n;
            tick();
            assert.equal(retries, 1);
            assert.equal(root.getAttribute("data-run"), "2");
            assert.equal(active, true);

            ui.dispose();
            assert.equal(active, false);
            assert.equal(closes, 1);
        });
        await start;
    } finally {
        globalThis.setInterval = originalSetInterval;
        globalThis.clearInterval = originalClearInterval;
    }
});

test("native HID initialization errors leave the engine input fallback usable", async () => {
    let start;
    withDocument(({document, nativeInput}) => {
        const ui = createLocalHackUI();
        ui.enableLogToggle(() => [], () => {
            throw Error("HID unavailable");
        });
        assert.match(ui.inputError(), /HID unavailable/);
        start = ui.waitForStart();
        assert.equal(nativeInput("a", 0), true);
        assert.equal(document.body.children[0].getAttribute("data-mode"), "running");
    });
    await start;
});

test("rendering uses no timers or animation loop", () => {
    withDocument(({document}) => {
        const originalTimeout = globalThis.setTimeout;
        const originalInterval = globalThis.setInterval;
        const originalFrame = globalThis.requestAnimationFrame;
        const unexpected = () => { throw new Error("UI scheduled a repaint"); };
        globalThis.setTimeout = unexpected;
        globalThis.setInterval = unexpected;
        globalThis.requestAnimationFrame = unexpected;
        try {
            const ui = createLocalHackUI();
            ui.phase("fs");
            ui.attempt(1);
            ui.phase("hen");
            ui.finish("success");
            const root = document.body.children[0];
            const style = root.children.find(child => child.tagName === "style");
            assert.doesNotMatch(style.textContent, /\b(?:animation|transition)\s*:/i);
        } finally {
            globalThis.setTimeout = originalTimeout;
            globalThis.setInterval = originalInterval;
            if (originalFrame) globalThis.requestAnimationFrame = originalFrame;
            else delete globalThis.requestAnimationFrame;
        }
    });
});
