const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const { spawn } = require("node:child_process");
const engine = require("../engine.js");

const root = path.resolve(__dirname, "..");
const chrome = process.env.CHROME_PATH || [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
].find(file => fs.existsSync(file));
const teams = engine.parseScorecards(fs.readFileSync(path.join(root, "data", "scorecards.csv"), "utf8"));
const thefts = engine.parseThefts(fs.readFileSync(path.join(root, "data", "thefts.csv"), "utf8"), teams);
const states = engine.snapshots(teams, thefts);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test("browser replay and animation lifecycle", { skip: !chrome && "Set CHROME_PATH to a Chromium browser", timeout: 60000 }, async t => {
  const server = http.createServer((request, response) => {
    const relative = decodeURIComponent(new URL(request.url, "http://localhost").pathname)
      .replace(/^\/Opto-Golf-Stealing-Webpage\//, "");
    const file = path.resolve(root, relative || "index.html");
    if (!file.startsWith(root + path.sep)) {
      response.writeHead(403).end();
      return;
    }
    fs.readFile(file, (error, contents) => {
      if (error) { response.writeHead(404).end(); return; }
      const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".csv": "text/csv" };
      response.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream" }).end(contents);
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "golf-browser-"));
  const child = spawn(chrome, ["--headless", "--disable-gpu", "--no-first-run",
    "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  let socket, send;
  const pending = new Map(), exceptions = [];
  try {
    const endpoint = await new Promise((resolve, reject) => {
      let output = "";
      const timeout = setTimeout(() => reject(new Error("Browser did not start")), 10000);
      child.once("error", error => { clearTimeout(timeout); reject(error); });
      child.stderr.on("data", data => {
        output += data;
        const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(output);
        if (match) { clearTimeout(timeout); resolve(new URL(match[1])); }
      });
    });
    const targets = await (await fetch(`http://${endpoint.host}/json/list`)).json();
    socket = new WebSocket(targets.find(target => target.type === "page").webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    let id = 0;
    socket.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.method === "Runtime.exceptionThrown") exceptions.push(message.params.exceptionDetails.text);
      if (!message.id) return;
      const command = pending.get(message.id);
      if (!command) return;
      pending.delete(message.id);
      clearTimeout(command.timeout);
      if (message.error) command.reject(new Error(JSON.stringify(message.error)));
      else command.resolve(message.result);
    };
    send = (method, params = {}) => new Promise((resolve, reject) => {
      const commandId = ++id;
      const timeout = setTimeout(() => {
        pending.delete(commandId);
        reject(new Error(`Browser command timed out: ${method}`));
      }, 10000);
      pending.set(commandId, { resolve, reject, timeout });
      socket.send(JSON.stringify({ id: commandId, method, params }));
    });
    const evaluate = async expression => {
      const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const frames = () => evaluate("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))");
    const scrub = step => evaluate(`document.getElementById("timeline").value="${step}";document.getElementById("timeline").dispatchEvent(new Event("input",{bubbles:true}));true`);
    const viewport = async (width, height = 1200) => {
      await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 701 });
      await frames();
    };
    const screenshot = async name => {
      if (!process.env.SCREENSHOT_DIR) return;
      const image = await send("Page.captureScreenshot", { format: "png" });
      fs.mkdirSync(process.env.SCREENSHOT_DIR, { recursive: true });
      fs.writeFileSync(path.join(process.env.SCREENSHOT_DIR, name), Buffer.from(image.data, "base64"));
    };
    const verifyState = async step => {
      const actual = await evaluate(`[...document.querySelectorAll("#scorecards > article")].map(card=>({id:card.dataset.teamId,scores:[...card.querySelectorAll("[data-cell]")].map(cell=>Number(cell.textContent)),total:Number(card.querySelector(".total-number strong").textContent)}))`);
      assert.deepEqual(actual, states[step].map(team => ({
        id: team.id, scores: team.players.flatMap(player => player.scores), total: engine.teamScore(team).total
      })));
    };
    const flightValues = step => {
      const event = thefts[step - 1];
      const values = [engine.getCell(states[step - 1], event.stealer), engine.getCell(states[step - 1], event.victim)].map(String);
      return [...values, ...values];
    };
    await send("Runtime.enable");
    await viewport(1440);
    await send("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/Opto-Golf-Stealing-Webpage/` });
    for (let i = 0; i < 50; i++) {
      if (await evaluate(`document.querySelectorAll("#scorecards > article").length === ${teams.length}`)) break;
      await sleep(50);
    }
    await evaluate('document.fonts.ready.then(()=>{document.getElementById("play").click();return true;})');

    await t.test("featured cards match grid dimensions on desktop, tablet and mobile", async () => {
      for (const width of [1440, 900, 390, 320]) {
        await viewport(width);
        await scrub(1);
        await sleep(450);
        const sizes = await evaluate(`({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,cards:[...document.querySelectorAll(".featured-slot > .scorecard:not(.departing-card)")].map(card=>{const a=card.getBoundingClientRect(),b=document.querySelector('#scorecards > [data-team-id="'+card.dataset.teamId+'"]').getBoundingClientRect();return [a.width,a.height,b.width,b.height];})})`);
        assert.ok(sizes.scrollWidth <= width, JSON.stringify(sizes));
        sizes.cards.forEach(([w, h, gridW, gridH]) => {
          assert.ok(Math.abs(w - gridW) < .5, `${width}: widths ${w} / ${gridW}`);
          assert.ok(Math.abs(h - gridH) < .5, `${width}: heights ${h} / ${gridH}`);
        });
      }
    });

    await t.test("deck changes precede four synchronized score flights", async () => {
      await viewport(1440, 1500);
      await scrub(1);
      await sleep(450);
      await evaluate('document.getElementById("next").click();true');
      await frames();
      const timing = await evaluate(`({flights:[...document.querySelectorAll(".flying-score")].map(node=>{const a=node.getAnimations()[0];return {section:node.dataset.section,value:node.textContent,start:a.startTime,duration:a.effect.getTiming().duration};}),departing:document.querySelectorAll(".departing-card").length,deckStart:document.querySelector(".departing-card").getAnimations()[0].startTime})`);
      assert.equal(timing.departing, 1);
      assert.deepEqual(timing.flights.map(f => f.section), ["swap-stage", "swap-stage", "scorecards", "scorecards"]);
      assert.deepEqual(timing.flights.map(f => f.value), flightValues(2));
      assert.equal(new Set(timing.flights.map(f => f.start)).size, 1);
      timing.flights.forEach(f => {
        assert.equal(f.duration, 1250);
        assert.ok(Math.abs(f.start - timing.deckStart - 380) < .001);
      });
      await verifyState(2);
      await screenshot("turkey-putt-shuffle.png");
      await sleep(700);
      await evaluate(`window.scrollTo(0,document.querySelector('#scorecards > [data-team-id="${thefts[1].stealer.teamId}"]').offsetTop-100);true`);
      await frames();
      await screenshot("turkey-putt-score-swap.png");
      await evaluate("window.scrollTo(0,0);true");
      await sleep(1000);
      assert.equal(await evaluate('document.getAnimations().length'), 0);
      await screenshot("turkey-putt-desktop.png");
      await viewport(390, 1700);
      await screenshot("turkey-putt-mobile.png");
    });

    await t.test("pause freezes motions and play resumes without changing scores", async () => {
      await viewport(1440);
      await scrub(1);
      await sleep(450);
      await evaluate('document.getElementById("next").click();document.getElementById("play").click();document.getElementById("play").click();true');
      await frames();
      const times = await evaluate("document.getAnimations().map(a=>({time:a.currentTime,state:a.playState}))");
      assert.ok(times.length >= 8);
      assert.ok(times.every(a => a.state === "paused"));
      await sleep(180);
      assert.deepEqual(await evaluate("document.getAnimations().map(a=>({time:a.currentTime,state:a.playState}))"), times);
      await evaluate('document.getElementById("play").click();document.getElementById("speed").value="1900";document.getElementById("speed").dispatchEvent(new Event("change"));true');
      await frames();
      assert.ok(await evaluate('document.getAnimations().every(a=>a.playState==="running")'));
      assert.equal(await evaluate('new Set([...document.querySelectorAll(".flying-score")].map(node=>node.getAnimations()[0].startTime)).size'), 1);
      await verifyState(2);
      await scrub(2);
    });

    await t.test("rapid next and scrub cancel stale transitions and preserve every state", async () => {
      await scrub(1);
      await evaluate('document.getElementById("next").click();document.getElementById("next").click();true');
      await frames();
      await verifyState(3);
      assert.deepEqual(await evaluate('[...document.querySelectorAll(".flying-score")].map(n=>n.textContent)'), flightValues(3));
      for (const step of [...states.keys(), ...[...states.keys()].reverse()]) {
        await scrub(step);
        await verifyState(step);
      }
      await sleep(500);
      assert.equal(await evaluate('document.querySelectorAll(".flying-score,.departing-card").length'), 0);
    });

    await t.test("repeated cells, scroll, and resize never duplicate a swap", async () => {
      await scrub(7);
      await sleep(450);
      await evaluate('document.getElementById("next").click();true');
      await frames();
      assert.deepEqual(await evaluate('[...document.querySelectorAll(".flying-score")].map(n=>n.textContent)'), flightValues(8));
      await verifyState(8);
      await evaluate('window.scrollTo(0,document.querySelector("#scorecards > [data-team-id=\\"12\\"]").offsetTop-100);true');
      await frames();
      assert.equal(await evaluate('document.querySelectorAll(".flying-score").length'), 4);
      await evaluate('window.dispatchEvent(new Event("resize"));true');
      await frames();
      assert.equal(await evaluate('document.getAnimations().length'), 0);
      await verifyState(8);
      await scrub(1);
      await evaluate('document.getElementById("next").click();window.dispatchEvent(new Event("resize"));true');
      await frames();
      assert.equal(await evaluate('document.getAnimations().length'), 0);
      await verifyState(2);
    });

    await t.test("changing the stealing team updates both featured cards, and the final steal finishes once", async () => {
      const changed = thefts.findIndex((event, index) => index > 0 && event.stealer.teamId !== thefts[index - 1].stealer.teamId);
      if (changed >= 0) {
        await scrub(changed);
        await sleep(450);
        await evaluate('document.getElementById("next").click();true');
        await frames();
        await verifyState(changed + 1);
        assert.deepEqual(await evaluate('[...document.querySelectorAll(".featured-slot > .scorecard:not(.departing-card)")].map(card=>card.dataset.teamId)'),
          [thefts[changed].stealer.teamId, thefts[changed].victim.teamId]);
        assert.deepEqual(await evaluate('[...document.querySelectorAll(".flying-score")].map(n=>n.textContent)'), flightValues(changed + 1));
      }
      await scrub(thefts.length - 1);
      await evaluate('document.getElementById("speed").value="1900";document.getElementById("play").click();true');
      await sleep(4000);
      await verifyState(thefts.length);
      assert.equal(await evaluate('document.getElementById("play-state").textContent'), "COMPLETE");
      assert.equal(await evaluate('document.getAnimations().length'), 0);
      await evaluate('document.getElementById("play").click();true');
      await verifyState(0);
      await evaluate('document.getElementById("play").click();true');
    });

    await t.test("reduced motion cancels active animation and disables new motion", async () => {
      await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
      await frames();
      await scrub(0);
      await evaluate('document.getElementById("next").click();document.getElementById("next").click();true');
      await frames();
      assert.equal(await evaluate('document.getAnimations().length'), 0);
      assert.equal(await evaluate('document.querySelectorAll(".flying-score,.departing-card").length'), 0);
      await verifyState(2);
    });
    assert.deepEqual(exceptions, []);
  } finally {
    if (send && socket?.readyState === WebSocket.OPEN) await send("Browser.close");
    socket?.close();
    child.kill();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    for (const command of pending.values()) clearTimeout(command.timeout);
    await fs.promises.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
