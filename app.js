"use strict";

const engine = GolfReplay;
const $ = id => document.getElementById(id);
let states = [], thefts = [], current = 0, playing = false, timer;
let revision = 0;
let motionPaused = false;
let pendingMotion = false;
const activeAnimations = new Set();
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const FLIP_DURATION = 500;
const REORDER_DURATION = 500;
const SCORE_DURATION = 1250;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function teamName(team) {
  return team.players.map(player => player.name).join(" & ");
}
function teamLabel(team) {
  const label = el("span", "team-label", teamName(team));
  const id = el("small", "team-id");
  id.append(el("span", "sr-only", "Team "), document.createTextNode(team.id));
  label.append(document.createTextNode(" "), id);
  return label;
}
function accessibleTeamName(team) {
  return `${teamName(team)}, team ${team.id}`;
}
function card(team, rank, options = {}) {
  const score = engine.teamScore(team);
  const article = el("article", `scorecard ${options.role || ""}`);
  article.dataset.teamId = team.id;
  article.setAttribute("aria-label", `${accessibleTeamName(team)}, total ${score.total}, rank ${rank}`);
  const head = el("div", "card-heading"), identity = el("div", "team-identity");
  const heading = el("h3");
  heading.append(teamLabel(team));
  identity.append(heading);
  const rankLabel = el("span", "rank", `Rank ${rank}`);
  rankLabel.setAttribute("aria-label", `Rank ${rank}`);
  head.append(identity, rankLabel);
  article.append(head);
  const table = el("table"), caption = el("caption", "sr-only", `${accessibleTeamName(team)} scorecard`);
  const thead = el("thead"), header = el("tr");
  const playerHeader = el("th", "", "PLAYER"); playerHeader.scope = "col"; header.append(playerHeader);
  for (let i = 1; i <= 9; i++) {
    const th = el("th", "", String(i)); th.scope = "col"; header.append(th);
  }
  thead.append(header); table.append(caption, thead);
  const body = el("tbody");
  team.players.forEach((player, p) => {
    const row = el("tr"), name = el("th", "player-name", player.name);
    name.scope = "row"; name.title = `Player ${p + 1}: ${player.name}`; row.append(name);
    player.scores.forEach((value, hole) => {
      const td = el("td", "", String(value));
      td.dataset.cell = `${team.id}-${p}-${hole}`;
      const involved = options.cell && options.cell.player === p && options.cell.hole === hole;
      if (involved) td.classList.add("target-cell");
      td.setAttribute("aria-label", `${accessibleTeamName(team)}: ${player.name}, player ${p + 1}, hole ${hole + 1}, ${value} strokes${involved ? ", selected for swap" : ""}`);
      row.append(td);
    });
    body.append(row);
  });
  const totalRow = el("tr", "team-hole-row"), totalLabel = el("th", "", "TEAM");
  totalLabel.scope = "row"; totalRow.append(totalLabel);
  score.holes.forEach(value => totalRow.append(el("td", "", String(value))));
  body.append(totalRow); table.append(body); article.append(table);
  const footer = el("div", "card-footer");
  const label = el("span", "", options.role === "stealing" ? "Stealing team" : options.role === "stolen" ? "Stolen from" : "Total");
  const number = el("div", "total-number");
  if (options.before !== undefined) {
    const delta = score.total - options.before;
    number.append(el("span", `delta ${delta < 0 ? "improved" : delta > 0 ? "increased" : ""}`, delta === 0 ? "no change" : `${delta > 0 ? "+" : ""}${delta}`));
  }
  number.append(el("strong", "", String(score.total)), el("span", "strokes", "strokes"));
  footer.append(label, number); article.append(footer);
  return article;
}
function clearMotion() {
  revision++;
  motionPaused = false;
  pendingMotion = false;
  for (const animation of activeAnimations) animation.cancel();
  activeAnimations.clear();
  document.querySelectorAll(".flying-score, .departing-card").forEach(node => node.remove());
  document.querySelectorAll(".flip-incoming").forEach(node => node.classList.remove("flip-incoming"));
  document.querySelectorAll(".is-flipping").forEach(node => node.classList.remove("is-flipping"));
}
function motion(node, frames, options, startTime, finish = () => {}) {
  const animation = node.animate(frames, options);
  animation.startTime = startTime;
  activeAnimations.add(animation);
  animation.onfinish = () => {
    activeAnimations.delete(animation);
    finish();
    animation.cancel();
  };
  return animation;
}
function render(step, animate = false) {
  clearMotion();
  const token = revision, old = current;
  const oldCards = [...$("swap-stage").querySelectorAll(".featured-slot > .scorecard")];
  const oldPositions = new Map([...$("scorecards").children].map(node => [node.dataset.teamId, node.getBoundingClientRect()]));
  current = step;
  const state = states[step], rank = engine.ranks(state);
  const theft = thefts[step === 0 ? 0 : step - 1];
  $("timeline").value = String(step);
  $("timeline").setAttribute("aria-valuetext", step === 0 ? "Original scores, no steals applied" : `Steal ${step} of ${thefts.length}`);
  $("timeline").style.setProperty("--progress", `${thefts.length ? step / thefts.length * 100 : 0}%`);
  $("step-counter").textContent = step === 0 ? "Original scores" : `Steal ${step} of ${thefts.length}`;
  $("previous").disabled = step === 0;
  $("next").disabled = step === thefts.length;
  const leaders = state.filter(team => rank[team.id] === 1);
  $("leader").replaceChildren();
  leaders.forEach((team, index) => {
    if (index) $("leader").append(document.createTextNode(" / "));
    $("leader").append(teamLabel(team));
  });
  $("leader").append(document.createTextNode(` · ${engine.teamScore(leaders[0]).total} strokes`));
  $("scorecards").replaceChildren(...engine.standings(state).map(team => {
    const role = step && theft ? team.id === theft.stealer.teamId ? "stealing" : team.id === theft.victim.teamId ? "stolen" : "" : "";
    return card(team, rank[team.id], { role, cell: role === "stealing" ? theft.stealer : role === "stolen" ? theft.victim : null });
  }));
  const stage = $("swap-stage");
  stage.replaceChildren();
  if (!theft) {
    $("event-title").textContent = "Original scores";
    $("event-description").textContent = "No steals in the log.";
    stage.append(el("p", "empty-stage", "Add rows to the theft log to show swaps."));
    return;
  }
  const a = state.find(team => team.id === theft.stealer.teamId), b = state.find(team => team.id === theft.victim.teamId);
  const previous = states[Math.max(0, step - 1)];
  const playerA = a.players[theft.stealer.player].name, playerB = b.players[theft.victim.player].name;
  if (step === 0) {
    $("event-title").textContent = "Original scores";
    $("event-description").replaceChildren("First steal: ", teamLabel(a), " swap with ", teamLabel(b), ".");
  } else {
    $("event-title").replaceChildren(teamLabel(a), " steal from ", teamLabel(b));
    $("event-description").textContent = `${playerA}, hole ${theft.stealer.hole + 1} (${engine.getCell(previous, theft.stealer)}) ↔ ${playerB}, hole ${theft.victim.hole + 1} (${engine.getCell(previous, theft.victim)}). ${playerA} receives ${engine.getCell(state, theft.stealer)}; ${playerB} receives ${engine.getCell(state, theft.victim)}.`;
  }
  const before = step ? {
    a: engine.teamScore(previous.find(team => team.id === a.id)).total,
    b: engine.teamScore(previous.find(team => team.id === b.id)).total
  } : {};
  const flips = [];
  [card(a, rank[a.id], { role: "stealing", cell: theft.stealer, before: before.a }),
    card(b, rank[b.id], { role: "stolen", cell: theft.victim, before: before.b })].forEach((incoming, index) => {
    const slot = el("div", "featured-slot");
    slot.append(incoming);
    const outgoing = oldCards[index];
    if (outgoing && outgoing.dataset.teamId !== incoming.dataset.teamId && !reducedMotion.matches) {
      outgoing.classList.add("departing-card");
      outgoing.setAttribute("aria-hidden", "true");
      outgoing.inert = true;
      outgoing.querySelectorAll("[data-cell]").forEach(cell => cell.removeAttribute("data-cell"));
      incoming.classList.add("flip-incoming");
      slot.classList.add("is-flipping");
      slot.append(outgoing);
      flips.push({ slot, incoming, outgoing });
    }
    stage.append(slot);
  });
  if (!reducedMotion.matches) {
    pendingMotion = true;
    requestAnimationFrame(() => {
      if (token !== revision) return;
      pendingMotion = false;
      const start = document.timeline.currentTime;
      // Measure final cell routes before flip and grid transforms are applied.
      const movements = [...$("scorecards").children].flatMap(node => {
        const from = oldPositions.get(node.dataset.teamId);
        const to = node.getBoundingClientRect();
        if (!from) return [];
        const x = from.left - to.left, y = from.top - to.top;
        return Math.abs(x) > .5 || Math.abs(y) > .5 ? [{ node, x, y }] : [];
      });
      const settleTime = Math.max(flips.length ? FLIP_DURATION : 0, movements.length ? REORDER_DURATION : 0);
      if (animate && step === old + 1) {
        animateSwap(theft, previous, start + settleTime);
      }
      animateFlips(flips, start);
      movements.forEach(({ node, x, y }) => {
        motion(node, [{ transform: `translate(${x}px, ${y}px)` }, { transform: "translate(0, 0)" }],
          { duration: REORDER_DURATION, easing: "cubic-bezier(.2,.7,.25,1)", fill: "backwards" }, start);
      });
      if (motionPaused) {
        for (const animation of activeAnimations) animation.pause();
      }
    });
  }
}
function animateFlips(flips, startTime) {
  flips.forEach(({ slot, incoming, outgoing }) => {
    motion(outgoing, [
      { transform: "rotateY(0deg)", visibility: "visible", easing: "ease-in" },
      { transform: "rotateY(90deg)", visibility: "visible", offset: .499999 },
      { transform: "rotateY(90deg)", visibility: "hidden", offset: .5 },
      { transform: "rotateY(90deg)", visibility: "hidden" }
    ], { duration: FLIP_DURATION, fill: "both" }, startTime, () => outgoing.remove());
    motion(incoming, [
      { transform: "rotateY(-90deg)", visibility: "hidden" },
      { transform: "rotateY(-90deg)", visibility: "hidden", offset: .5 },
      { transform: "rotateY(-90deg)", visibility: "visible", offset: .500001, easing: "ease-out" },
      { transform: "rotateY(0deg)", visibility: "visible" }
    ], { duration: FLIP_DURATION, fill: "both" }, startTime, () => {
      incoming.classList.remove("flip-incoming");
      slot.classList.remove("is-flipping");
    });
  });
}
function animateSwap(theft, before, startTime) {
  [$("swap-stage"), $("scorecards")].forEach(container => {
    const locate = cell => container.querySelector(`[data-cell="${cell.teamId}-${cell.player}-${cell.hole}"]`);
    const a = locate(theft.stealer), b = locate(theft.victim);
    const boxA = a.getBoundingClientRect(), boxB = b.getBoundingClientRect();
    [[boxA, boxB, engine.getCell(before, theft.stealer), "outbound"],
      [boxB, boxA, engine.getCell(before, theft.victim), "inbound"]].forEach(([from, to, value, direction], index) => {
      const chip = el("div", `flying-score ${direction}`, String(value));
      chip.dataset.section = container.id;
      chip.setAttribute("aria-hidden", "true");
      chip.style.left = `${from.left + window.scrollX + from.width / 2 - 20}px`;
      chip.style.top = `${from.top + window.scrollY + from.height / 2 - 20}px`;
      document.body.append(chip);
      const x = to.left - from.left + (to.width - from.width) / 2;
      const y = to.top - from.top + (to.height - from.height) / 2;
      motion(chip, [
        { transform: "translate(0, 0) scale(.8)", opacity: 0 },
        { transform: "translate(0, 0) scale(1.1)", opacity: 1, offset: .12 },
        { transform: `translate(${x / 2}px, ${y / 2 + (index ? 60 : -60)}px) scale(1.2)`, opacity: 1, offset: .5 },
        { transform: `translate(${x}px, ${y}px) scale(1)`, opacity: 1, offset: .9 },
        { transform: `translate(${x}px, ${y}px) scale(.8)`, opacity: 0 }
      ], { duration: SCORE_DURATION, easing: "ease-in-out", fill: "both" }, startTime, () => chip.remove());
    });
    [a, b].forEach(cell => {
      motion(cell, [{ opacity: 0 }, { opacity: 0, offset: .9 }, { opacity: 1 }],
        { duration: SCORE_DURATION, fill: "backwards" }, startTime);
    });
  });
}
function pausePlayback() {
  motionPaused = true;
  for (const animation of activeAnimations) animation.pause();
  setPlaying(false);
}
function setPlaying(value) {
  playing = value;
  clearTimeout(timer);
  const label = value ? "Pause" : current === thefts.length && thefts.length ? "Replay" : "Play";
  $("play").replaceChildren(document.createTextNode(value ? "Ⅱ " : "▶ "), el("span", "", label));
  $("play").setAttribute("aria-label", label);
  $("play-state").textContent = value ? "PLAYING" : current === thefts.length && !activeAnimations.size ? "COMPLETE" : "PAUSED";
  $("play-state").classList.toggle("is-playing", value);
  if (value) schedule();
}
function schedule() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    if (!playing) return;
    if (current === thefts.length) {
      setPlaying(false);
      return;
    }
    render(current + 1, true);
    schedule();
  }, current === thefts.length ? Math.max(FLIP_DURATION, REORDER_DURATION) + SCORE_DURATION + 50 : Number($("speed").value));
}
function jump(step, animate = false) {
  setPlaying(false);
  render(step, animate);
  setPlaying(false);
}
$("play").addEventListener("click", () => {
  if (playing) {
    pausePlayback();
    return;
  }
  const pausedMotion = (pendingMotion && motionPaused) || [...activeAnimations].some(animation => animation.playState === "paused");
  if (current === thefts.length && !pausedMotion) render(0);
  motionPaused = false;
  for (const animation of activeAnimations) animation.play();
  setPlaying(true);
});
$("previous").addEventListener("click", () => jump(Math.max(0, current - 1)));
$("next").addEventListener("click", () => jump(Math.min(thefts.length, current + 1), true));
$("timeline").addEventListener("input", event => jump(Number(event.target.value)));
$("speed").addEventListener("change", () => { if (playing) schedule(); });
document.addEventListener("visibilitychange", () => { if (document.hidden && playing) pausePlayback(); });
window.addEventListener("resize", clearMotion);
reducedMotion.addEventListener("change", () => {
  if (reducedMotion.matches) {
    clearMotion();
    setPlaying(false);
  }
});
const controls = document.querySelector(".timeline-controls");
new ResizeObserver(() => {
  document.documentElement.style.setProperty("--controls-height", `${controls.getBoundingClientRect().height}px`);
}).observe(controls);

async function load() {
  try {
    const responses = await Promise.all(["./data/scorecards.csv", "./data/thefts.csv"].map(async path => {
      const response = await fetch(path, { cache: "no-cache" });
      if (!response.ok) throw new Error(`Could not load ${path} (HTTP ${response.status}).`);
      return response.text();
    }));
    const teams = engine.parseScorecards(responses[0]);
    thefts = engine.parseThefts(responses[1], teams);
    states = engine.snapshots(teams, thefts);
    $("team-count").textContent = String(teams.length);
    $("steal-count").textContent = String(thefts.length);
    $("timeline").max = String(thefts.length);
    $("timeline-end").textContent = "Final scores";
    $("play").disabled = !thefts.length;
    $("timeline").disabled = !thefts.length;
    $("scorecards").setAttribute("aria-busy", "false");
    render(0);
    setPlaying(thefts.length > 0 && !reducedMotion.matches);
  } catch (error) {
    $("error").hidden = false;
    $("error").textContent = `Could not load scores. ${error.message} Check the CSV files and serve this folder over HTTP or GitHub Pages, then reload.`;
    $("event-title").textContent = "Scores unavailable";
    $("event-description").textContent = "See the error above.";
    $("play-state").textContent = "UNAVAILABLE";
    $("leader").textContent = "Score data unavailable";
    $("scorecards").setAttribute("aria-busy", "false");
    console.error("Could not load golf replay:", error);
  }
}
load();
