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

test("browser replay and animation lifecycle", { skip: !chrome && "Set CHROME_PATH to a Chromium browser", timeout: 90000 }, async t => {
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
    const waitFor = async expression => {
      for (let i = 0; i < 200; i++) {
        if (await evaluate(expression)) return;
        await sleep(25);
      }
      assert.fail(`Timed out waiting for ${expression}`);
    };
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
      assert.deepEqual(actual.toSorted((a,b)=>Number(a.id)-Number(b.id)), states[step].map(team => ({
        id: team.id, scores: team.players.flatMap(player => player.scores), total: engine.teamScore(team).total
      })).toSorted((a,b)=>Number(a.id)-Number(b.id)));
      if (!await evaluate("deferredOrder")) {
        assert.deepEqual(actual.map(team=>team.id), engine.standings(states[step]).map(team=>team.id));
      }
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
      if (await evaluate(`document.querySelectorAll("#scorecards > article").length === ${teams.length} || !document.getElementById("error").hidden`)) break;
      await sleep(50);
    }
    const loadError = await evaluate('document.getElementById("error").hidden?"":document.getElementById("error").textContent');
    const startup = await evaluate(`({cards:document.querySelectorAll("#scorecards > article").length,
      teamCount:document.getElementById("team-count").textContent,disabled:document.getElementById("track-team").disabled,
      error:document.getElementById("error").textContent,hidden:document.getElementById("error").hidden})`);
    assert.equal(startup.cards, teams.length, JSON.stringify(startup));
    assert.equal(loadError, "", loadError);
    await evaluate('document.fonts.ready.then(()=>{document.getElementById("play").click();return true;})');

    await t.test("small accessible team IDs follow names on cards, leaders and events", async () => {
      await scrub(0);
      await sleep(600);
      const labels = await evaluate(`({
        cards:[...document.querySelectorAll(".scorecard:not(.departing-card)")].map(card=>{
          const label=card.querySelector("h3 .team-label"),id=label.querySelector(".team-id");
          return {id:card.dataset.teamId,number:id.lastChild.textContent,context:id.querySelector(".sr-only").textContent,
            smaller:parseFloat(getComputedStyle(id).fontSize)<parseFloat(getComputedStyle(label).fontSize),
            accessible:card.getAttribute("aria-label").includes("team "+card.dataset.teamId)};
        }),
        leader:document.querySelectorAll("#leader .team-id").length,
        first:document.querySelectorAll("#event-description .team-id").length
      })`);
      labels.cards.forEach(label => {
        assert.equal(label.number, label.id);
        assert.equal(label.context, "Team ");
        assert.equal(label.smaller, true);
        assert.equal(label.accessible, true);
      });
      assert.ok(labels.leader > 0);
      assert.equal(labels.first, 2);
      await scrub(1);
      assert.equal(await evaluate('document.querySelectorAll("#event-title .team-id").length'), 2);
      await verifyState(1);
    });

    await t.test("Track Team defaults to None and highlights the selected ID through re-renders", async () => {
      await scrub(0);
      const repeated = teams.filter(team => team.players.some(player => player.name === "Vieng"));
      assert.deepEqual(repeated.map(team => team.id), ["5", "10"]);
      const options = await evaluate(`(()=>{const s=document.getElementById("track-team");return {
        disabled:s.disabled,value:s.value,
        labels:[...s.options].map(o=>o.textContent),
        expected:${JSON.stringify(teams.map(team => `${team.players.map(player => player.name).join(" & ")} (${team.id})`))}
      }})()`);
      assert.equal(options.disabled, false);
      assert.equal(options.value, "");
      assert.equal(options.labels[0], "None");
      assert.deepEqual(options.labels.slice(1), options.expected);
      assert.equal(await evaluate('document.querySelector(\'label[for="track-team"]\').textContent'), "Track Team");
      assert.notEqual(options.labels.find(label=>label.endsWith("(5)")), options.labels.find(label=>label.endsWith("(10)")));

      const trackedId = thefts[0].stealer.teamId;
      const dimensions = await evaluate(`(()=>{const n=document.querySelector('#scorecards > [data-team-id="${trackedId}"]'),r=n.getBoundingClientRect();return [r.width,r.height]})()`);
      await evaluate(`(()=>{const s=document.getElementById("track-team");s.value="${trackedId}";s.dispatchEvent(new Event("change",{bubbles:true}));return true})()`);
      const selected = await evaluate(`({
        selected:document.querySelectorAll('.scorecard.tracked-team').length,
        grid:document.querySelector('#scorecards > [data-team-id="${trackedId}"]').classList.contains("tracked-team"),
        bounds:(()=>{const r=document.querySelector('#scorecards > [data-team-id="${trackedId}"]').getBoundingClientRect();return [r.width,r.height]})()
      })`);
      assert.equal(selected.selected, 2);
      assert.equal(selected.grid, true);
      assert.deepEqual(selected.bounds, dimensions);
      await scrub(1);
      await sleep(600);
      assert.equal(await evaluate(`document.querySelectorAll('.scorecard[data-team-id="${trackedId}"].tracked-team').length`), 2);
      await evaluate("window.scrollTo(0,0);true");
      await screenshot("turkey-putt-track-team.png");
      await scrub(2);
      await sleep(600);
      assert.equal(await evaluate(`document.querySelectorAll('.scorecard[data-team-id="${trackedId}"].tracked-team').length`), 2);
      assert.equal(await evaluate(`getComputedStyle(document.querySelector('#scorecards > [data-team-id="${trackedId}"]')).outlineColor`), "rgb(242, 196, 0)");
      await evaluate('document.getElementById("track-team").value="";document.getElementById("track-team").dispatchEvent(new Event("change",{bubbles:true}));true');
      assert.equal(await evaluate('document.querySelectorAll(".scorecard.tracked-team").length'), 0);
      const secondDuplicate = repeated.find(team => team.id !== trackedId).id;
      await evaluate(`(()=>{const s=document.getElementById("track-team");s.value="${secondDuplicate}";s.dispatchEvent(new Event("change",{bubbles:true}));return true})()`);
      await scrub(0);
      await scrub(1);
      await sleep(600);
      assert.equal(await evaluate(`document.querySelectorAll('.scorecard.tracked-team[data-team-id="${secondDuplicate}"]').length`), 1);
      assert.equal(await evaluate(`document.querySelectorAll('.scorecard.tracked-team[data-team-id="${trackedId}"]').length`), 0);
      await evaluate('document.getElementById("track-team").value="";document.getElementById("track-team").dispatchEvent(new Event("change",{bubbles:true}));true');
      await evaluate('document.getElementById("track-team").focus();true');
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 });
      assert.equal(await evaluate('document.getElementById("track-team").value'), teams[0].id);
      assert.equal(await evaluate('document.activeElement.id'), "track-team");
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 });
      assert.equal(await evaluate('document.getElementById("track-team").value'), "");
      assert.equal(await evaluate('document.querySelectorAll(".scorecard.tracked-team").length'), 0);
      await evaluate(`(()=>{const s=document.getElementById("track-team");s.value="${trackedId}";s.dispatchEvent(new Event("change",{bubbles:true}));s.blur();document.getElementById("speed").value="1900";document.getElementById("play").click();return true})()`);
      await waitFor('current === 2 && phase === "scores"');
      assert.equal(await evaluate(`document.querySelectorAll('.scorecard.tracked-team[data-team-id="${trackedId}"]').length`), 2);
      await evaluate('pausePlayback();document.getElementById("speed").value="4800";true');
      await scrub(0);
    });

    await t.test("featured cards match grid dimensions on desktop, tablet and mobile", async () => {
      for (const width of [1440, 900, 390, 320]) {
        await viewport(width);
        await scrub(1);
        await sleep(600);
        const sizes = await evaluate(`({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,tracker:document.getElementById("track-team").getBoundingClientRect().width,cards:[...document.querySelectorAll(".featured-slot > .scorecard:not(.departing-card)")].map(card=>{const a=card.getBoundingClientRect(),b=document.querySelector('#scorecards > [data-team-id="'+card.dataset.teamId+'"]').getBoundingClientRect();return [a.width,a.height,b.width,b.height];})})`);
        assert.ok(sizes.scrollWidth <= width, JSON.stringify(sizes));
        assert.ok(sizes.tracker > 0);
        sizes.cards.forEach(([w, h, gridW, gridH]) => {
          assert.ok(Math.abs(w - gridW) < .5, `${width}: widths ${w} / ${gridW}`);
          assert.ok(Math.abs(h - gridH) < .5, `${width}: heights ${h} / ${gridH}`);
        });
      }
    });

    await t.test("horizontal flip hides new content until midpoint and never mirrors text", async () => {
      await viewport(1440);
      await scrub(1);
      await sleep(600);
      await evaluate('document.getElementById("next").click();true');
      await waitFor('phase === "cards"');
      await evaluate("pausePlayback();true");
      const sample = async time => evaluate(`(()=>{
        const slot=document.querySelector(".is-flipping");
        const incoming=slot.querySelector(".flip-incoming"),outgoing=slot.querySelector(".departing-card");
        [incoming,outgoing].forEach(n=>{const a=n.getAnimations()[0];a.pause();a.currentTime=${time};});
        const info=n=>({visibility:getComputedStyle(n).visibility,scale:new DOMMatrix(getComputedStyle(n).transform).m11,text:n.querySelector("h3").textContent});
        return {incoming:info(incoming),outgoing:info(outgoing),stable:document.querySelector(".featured-slot").classList.contains("is-flipping")};
      })()`);
      const first = await sample(125);
      assert.equal(first.incoming.visibility, "hidden");
      assert.equal(first.outgoing.visibility, "visible");
      assert.ok(first.outgoing.scale > 0 && first.outgoing.scale < 1);
      assert.equal(first.stable, false);
      await screenshot("turkey-putt-flip-old.png");
      const midpoint = await sample(250);
      assert.equal(midpoint.outgoing.visibility, "hidden");
      assert.equal(midpoint.incoming.visibility, "hidden");
      assert.ok(Math.abs(midpoint.incoming.scale) < .001);
      const second = await sample(375);
      assert.equal(second.outgoing.visibility, "hidden");
      assert.equal(second.incoming.visibility, "visible");
      assert.ok(second.incoming.scale > 0 && second.incoming.scale < 1);
      assert.notEqual(first.outgoing.text, second.incoming.text);
      await screenshot("turkey-putt-flip.png");
      await scrub(2);
    });

    await t.test("rank changes animate actual cards from old positions to sorted grid positions", async () => {
      const step = states.findIndex((state, index) => index > 0 &&
        engine.standings(state).map(t => t.id).join() !== engine.standings(states[index - 1]).map(t => t.id).join());
      assert.ok(step > 0, "The round needs a standings change to exercise position animation");
      await scrub(step - 1);
      await sleep(600);
      await evaluate('window.oldGridPositions=Object.fromEntries([...document.querySelectorAll("#scorecards > article")].map(n=>[n.dataset.teamId,{x:n.getBoundingClientRect().x,y:n.getBoundingClientRect().y}]));document.getElementById("next").click();true');
      await waitFor('phase === "ranks"');
      await evaluate("pausePlayback();true");
      const moving = await evaluate(`(()=>{
        const cards=[...document.querySelectorAll("#scorecards > article")];
        return cards.filter(n=>n.getAnimations().length).map(n=>{
          const a=n.getAnimations()[0];a.pause();a.currentTime=0;
          const from=n.getBoundingClientRect(),original=window.oldGridPositions[n.dataset.teamId];
          a.currentTime=250;const half=n.getBoundingClientRect();
          a.currentTime=500;const to=n.getBoundingClientRect();
          return {id:n.dataset.teamId,from:{x:from.x,y:from.y},half:{x:half.x,y:half.y},to:{x:to.x,y:to.y},original};
        });
      })()`);
      assert.ok(moving.length > 1);
      moving.forEach(({ from, half, to, original }) => {
        assert.ok(Math.abs(from.x - original.x) < 1 && Math.abs(from.y - original.y) < 1);
        assert.ok(Math.hypot(to.x - from.x, to.y - from.y) > 1);
        assert.ok(Math.hypot(half.x - from.x, half.y - from.y) > .5);
        assert.ok(Math.hypot(half.x - to.x, half.y - to.y) > .5);
      });
      await verifyState(step);
      await evaluate('document.querySelectorAll("#scorecards > article").forEach(n=>n.getAnimations().forEach(a=>a.currentTime=250));window.scrollTo(0,document.getElementById("scorecards").offsetTop-80);true');
      await screenshot("turkey-putt-standings.png");
      await scrub(step);
      await sleep(600);
      await evaluate('document.getElementById("previous").click();true');
      await frames();
      await verifyState(step - 1);
      assert.ok(await evaluate('document.querySelectorAll("#scorecards > article").length>0 && [...document.querySelectorAll("#scorecards > article")].some(n=>n.getAnimations().length>0)'));
      await sleep(600);
      const positions = await evaluate('[...document.querySelectorAll("#scorecards > article")].map(n=>({x:n.getBoundingClientRect().x,y:n.getBoundingClientRect().y}))');
      positions.slice(1).forEach((position, index) => {
        const previous = positions[index];
        assert.ok(position.y > previous.y + 1 || (Math.abs(position.y - previous.y) < 1 && position.x > previous.x));
      });
      await evaluate("window.scrollTo(0,0);true");
    });

    await t.test("bottom controls stay fixed, reserve space, and remain keyboard accessible", async () => {
      for (const width of [1440, 900, 390, 320]) {
        await viewport(width, 900);
        const measure = () => evaluate(`(()=>{
          const controls=document.querySelector(".timeline-controls"),box=controls.getBoundingClientRect();
          return {top:box.top,bottom:box.bottom,height:box.height,innerHeight,padding:parseFloat(getComputedStyle(document.body).paddingBottom),overflow:document.documentElement.scrollWidth>innerWidth};
        })()`);
        await evaluate("window.scrollTo(0,0);true");
        const top = await measure();
        await evaluate("window.scrollTo(0,document.documentElement.scrollHeight);true");
        await frames();
        const bottom = await measure();
        assert.ok(Math.abs(top.bottom - 900) < 1 && Math.abs(bottom.bottom - 900) < 1);
        assert.ok(top.padding >= top.height && bottom.padding >= bottom.height);
        assert.equal(bottom.overflow, false);
        assert.ok(await evaluate('document.querySelector("footer").getBoundingClientRect().bottom <= document.querySelector(".timeline-controls").getBoundingClientRect().top'));
      }
      await evaluate('document.getElementById("timeline").focus();true');
      const before = await evaluate('Number(document.getElementById("timeline").value)');
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 });
      await verifyState(before + 1);
      assert.equal(await evaluate('document.activeElement.id'), "timeline");
      await evaluate("document.activeElement.blur();window.scrollTo(0,0);true");
    });

    await t.test("score flights precede the dwell, standings movement and next pair flip", async () => {
      await viewport(1440, 1500);
      await scrub(1);
      await sleep(600);
      await evaluate('document.getElementById("next").click();true');
      await frames();
      const timing = await evaluate(`({flights:[...document.querySelectorAll(".flying-score")].map(node=>{const a=node.getAnimations()[0];return {section:node.dataset.section,value:node.textContent,start:a.startTime,duration:a.effect.getTiming().duration};}),departing:document.querySelectorAll(".departing-card").length,moving:document.querySelectorAll("#scorecards > article").length && [...document.querySelectorAll("#scorecards > article")].some(n=>n.getAnimations().length)})`);
      assert.equal(timing.departing, 0);
      assert.deepEqual(timing.flights.map(f => f.section), ["swap-stage", "swap-stage", "scorecards", "scorecards"]);
      assert.deepEqual(timing.flights.map(f => f.value), flightValues(2));
      assert.equal(new Set(timing.flights.map(f => f.start)).size, 1);
      assert.equal(timing.moving, false);
      timing.flights.forEach(f => {
        assert.equal(f.duration, 1250);
      });
      await verifyState(2);
      await sleep(700);
      await evaluate(`window.scrollTo(0,document.querySelector('#scorecards > [data-team-id="${thefts[1].stealer.teamId}"]').offsetTop-100);true`);
      await frames();
      await screenshot("turkey-putt-score-swap.png");
      await evaluate("window.scrollTo(0,0);true");
      await waitFor('phase === "dwell"');
      assert.equal(await evaluate('document.querySelectorAll(".flying-score").length'), 0);
      await waitFor('phase === "cards"');
      await waitFor('phase === "ready"');
      assert.equal(await evaluate('document.getAnimations().length'), 0);
      await screenshot("turkey-putt-desktop.png");
      await viewport(390, 1700);
      await screenshot("turkey-putt-mobile.png");
    });

    await t.test("autoplay runs scores, fixed dwell, ranks, then cards before the next scores", async () => {
      await viewport(1440);
      await scrub(0);
      await evaluate(`document.getElementById("speed").value="1900";
        document.getElementById("next").click();document.getElementById("play").click();
        window.sequence=[];window.sequenceTimer=setInterval(()=>{
          const sample={phase,current,time:performance.now(),flights:document.querySelectorAll(".flying-score").length,
            flips:document.querySelectorAll(".departing-card").length};
          if(!window.sequence.length || sample.phase!==window.sequence.at(-1).phase || sample.current!==window.sequence.at(-1).current)
            window.sequence.push(sample);
        },10);true`);
      await waitFor('phase === "dwell"');
      assert.equal(await evaluate('document.querySelectorAll(".departing-card,.flying-score").length'), 0);
      await screenshot("turkey-putt-dwell.png");
      await sleep(250);
      await evaluate('document.getElementById("play").click();true');
      const paused = await evaluate("({current,elapsedFraction})");
      await sleep(250);
      assert.deepEqual(await evaluate("({current,elapsedFraction})"), paused);
      await evaluate('document.getElementById("speed").value="4800";document.getElementById("speed").dispatchEvent(new Event("change"));document.getElementById("play").click();true');
      assert.equal(await evaluate("phaseDuration()"), 1500);
      await sleep(1000);
      await verifyState(1);
      await waitFor("window.sequence.at(-1)?.current === 2");
      const sequence = await evaluate("clearInterval(window.sequenceTimer);window.sequence");
      const cards = sequence.find(sample => sample.phase === "cards");
      const dwell = sequence.find(sample => sample.phase === "dwell");
      const ranks = sequence.find(sample => sample.phase === "ranks");
      const next = sequence.find(sample => sample.current === 2);
      assert.ok(cards && dwell && next, JSON.stringify(sequence));
      assert.equal(cards.flights, 0);
      assert.ok(cards.flips > 0);
      assert.ok(ranks.time - dwell.time >= 1720, JSON.stringify(sequence));
      assert.ok(cards.time >= ranks.time + 470, JSON.stringify(sequence));
      assert.ok(next.time >= cards.time + 470, JSON.stringify(sequence));
      assert.deepEqual(sequence.slice(0,5).map(sample=>sample.phase), ["scores","dwell","ranks","cards","scores"]);
      await scrub(2);
    });

    await t.test("unchanged featured teams skip the flip but retain the full dwell", async () => {
      const index = thefts.findIndex((event, i) => i + 1 < thefts.length &&
        event.stealer.teamId === thefts[i + 1].stealer.teamId && event.victim.teamId === thefts[i + 1].victim.teamId);
      if (index < 0) return;
      await scrub(index);
      await evaluate('document.getElementById("speed").value="1900";document.getElementById("next").click();document.getElementById("play").click();true');
      await waitFor('phase === "dwell"');
      const start = Date.now();
      assert.equal(await evaluate('document.querySelectorAll(".departing-card,.flying-score").length'), 0);
      await sleep(1250);
      await verifyState(index + 1);
      await waitFor(`current === ${index + 2}`);
      assert.ok(Date.now() - start >= 1470);
      await scrub(index + 2);
      await evaluate('document.getElementById("speed").value="4800";true');
    });

    await t.test("pause freezes motions and play resumes without changing scores", async () => {
      await viewport(1440);
      await scrub(1);
      await sleep(600);
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

    await t.test("speed changes and pause preserve a flip, while scrubbing cancels the entire sequence", async () => {
      await scrub(1);
      await evaluate('document.getElementById("speed").value="1900";document.getElementById("next").click();true');
      await waitFor('phase === "cards"');
      await evaluate('pausePlayback();true');
      await frames();
      const time = await evaluate('[...activeAnimations].map(a=>a.currentTime)');
      await sleep(100);
      assert.deepEqual(await evaluate('[...activeAnimations].map(a=>a.currentTime)'), time);
      await evaluate('document.getElementById("speed").value="4800";document.getElementById("speed").dispatchEvent(new Event("change"));true');
      assert.equal(await evaluate('[...activeAnimations].every(a=>a.playState==="paused" && a.effect.getTiming().duration===500)'), true);
      await evaluate('document.getElementById("play").click();true');
      await waitFor('current === 3');
      await scrub(0);
      await sleep(2200);
      await verifyState(0);
      assert.equal(await evaluate('document.querySelectorAll(".flying-score,.departing-card").length'), 0);
      assert.equal(await evaluate('document.getElementById("event-title").textContent'), "Original scores");
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
      await sleep(600);
      assert.equal(await evaluate('document.querySelectorAll(".flying-score,.departing-card").length'), 0);
    });

    await t.test("repeated cells, scroll, and resize never duplicate a swap", async () => {
      await scrub(7);
      await sleep(600);
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
        await sleep(600);
        await evaluate('document.getElementById("next").click();true');
        await frames();
        await verifyState(changed + 1);
        assert.deepEqual(await evaluate('[...document.querySelectorAll(".featured-slot > .scorecard:not(.departing-card)")].map(card=>card.dataset.teamId)'),
          [thefts[changed].stealer.teamId, thefts[changed].victim.teamId]);
        assert.deepEqual(await evaluate('[...document.querySelectorAll(".flying-score")].map(n=>n.textContent)'), flightValues(changed + 1));
      }
      await scrub(thefts.length - 1);
      await evaluate('document.getElementById("speed").value="1900";document.getElementById("play").click();true');
      await waitFor('document.getElementById("play-state").textContent === "COMPLETE"');
      await verifyState(thefts.length);
      assert.equal(await evaluate('document.getElementById("play-state").textContent'), "COMPLETE");
      assert.equal(await evaluate('document.getAnimations().length'), 0);
      await evaluate('document.getElementById("play").click();true');
      await verifyState(0);
      await evaluate('document.getElementById("play").click();true');
    });

    await t.test("track fills between steps while thumb stays discrete, with pause and speed continuity", async () => {
      await scrub(0);
      await sleep(600);
      await evaluate('document.getElementById("speed").value="4800";document.getElementById("play").click();true');
      await sleep(350);
      const progress = () => evaluate('({fill:parseFloat(getComputedStyle(document.getElementById("timeline")).getPropertyValue("--progress")),value:document.getElementById("timeline").value,count:document.getElementById("timeline").getAnimations().length})');
      const early = await progress();
      await sleep(350);
      const later = await progress();
      assert.equal(early.value, "0");
      assert.equal(later.value, "0");
      assert.ok(early.fill > 0 && later.fill > early.fill && later.fill < 100 / thefts.length);
      await evaluate("window.scrollTo(0,0);true");
      await screenshot("turkey-putt-timeline.png");
      await evaluate('document.getElementById("play").click();true');
      const paused = await progress();
      await sleep(180);
      assert.ok(Math.abs((await progress()).fill - paused.fill) < .001);
      await evaluate('document.getElementById("speed").value="1900";document.getElementById("play").click();true');
      await frames();
      const resumed = await progress();
      assert.ok(resumed.fill >= paused.fill && resumed.fill < paused.fill + 1);
      await evaluate('document.getElementById("speed").value="3000";document.getElementById("speed").dispatchEvent(new Event("change"));true');
      const changed = await progress();
      assert.ok(Math.abs(changed.fill - resumed.fill) < .2);
      assert.equal(changed.count, 1);
      await evaluate('document.getElementById("play").click();true');
      await scrub(5);
      await sleep(80);
      const manual = await progress();
      assert.equal(manual.value, "5");
      assert.ok(manual.fill > changed.fill && manual.fill < 500 / thefts.length);
      await scrub(2);
      await scrub(7);
      await scrub(1);
      await sleep(300);
      const settled = await progress();
      assert.ok(Math.abs(settled.fill - 100 / thefts.length) < .001);
      assert.equal(settled.value, "1");
      assert.equal(settled.count, 0);
      await evaluate("window.scrollTo(0,0);true");
      await verifyState(1);
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
