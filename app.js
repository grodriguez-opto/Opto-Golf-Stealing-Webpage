"use strict";

const engine = GolfReplay;
const $ = id => document.getElementById(id);
let states = [], thefts = [], current = 0, playing = false, timer;
let revision = 0;
let motionPaused = false;
let pendingMotion = false;
let progressAnimation;
let intervalStarted = null;
let intervalFraction = 0;
let intervalDuration = 0;
let elapsedFraction = 0;
// Only ready can advance the selected step; all other phases finish that step.
let phase = "ready";
let featuredTheft;
let deferredOrder = false;
let trackedTeamId = "";
const activeAnimations = new Set();
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const FLIP_DURATION = 500;
const REORDER_DURATION = 500;
const SCORE_DURATION = 1250;
const DWELL_DURATION = 1500;

function motionScale() {
  return Number($("speed").value) / 4800;
}
function phaseDuration() {
  if (phase === "scores") return SCORE_DURATION * motionScale();
  if (phase === "ranks") return REORDER_DURATION * motionScale();
  if (phase === "cards") return FLIP_DURATION * motionScale();
  return DWELL_DURATION;
}

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
  if (options.trackedTeamId === team.id) article.classList.add("tracked-team");
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
  const playerHeader = el("th", "", "Hole"); playerHeader.scope = "col"; header.append(playerHeader);
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
  clearTimeout(timer);
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
  animation.baseDuration = options.duration / motionScale();
  animation.startTime = startTime;
  activeAnimations.add(animation);
  animation.onfinish = () => {
    activeAnimations.delete(animation);
    finish();
    animation.cancel();
  };
  return animation;
}
function stopProgress() {
  const fill = getComputedStyle($("timeline")).getPropertyValue("--progress").trim() || "0%";
  $("timeline").style.setProperty("--progress", fill);
  if (progressAnimation) progressAnimation.cancel();
  progressAnimation = undefined;
  return fill;
}
function fillProgress(target, duration) {
  const from = stopProgress();
  const to = `${target}%`;
  $("timeline").style.setProperty("--progress", to);
  if (reducedMotion.matches || duration <= 0 || from === to) return;
  const animation = $("timeline").animate([{ "--progress": from }, { "--progress": to }],
    { duration, easing: "linear" });
  progressAnimation = animation;
  animation.onfinish = () => {
    if (progressAnimation !== animation) return;
    animation.cancel();
    progressAnimation = undefined;
  };
}
function captureInterval() {
  if (intervalStarted === null) return;
  elapsedFraction = Math.min(1, intervalFraction + (performance.now() - intervalStarted) / intervalDuration);
  intervalStarted = null;
}
function render(step, animate = false) {
  stopProgress();
  elapsedFraction = 0;
  intervalStarted = null;
  clearMotion();
  const token = revision, old = current;
  const oldOrder = [...$("scorecards").children].map(node => node.dataset.teamId);
  const oldPositions = new Map([...$("scorecards").children].map(node => [node.dataset.teamId, node.getBoundingClientRect()]));
  current = step;
  const state = states[step], rank = engine.ranks(state);
  const theft = thefts[step === 0 ? 0 : step - 1];
  const exchange = animate && step === old + 1 && !reducedMotion.matches;
  deferredOrder = exchange;
  $("timeline").value = String(step);
  $("timeline").setAttribute("aria-valuetext", step === 0 ? "Original scores, no steals applied" : `Steal ${step} of ${thefts.length}`);
  fillProgress(thefts.length ? step / thefts.length * 100 : 0, playing ? 0 : 240);
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
    return card(team, rank[team.id], { role, cell: role === "stealing" ? theft.stealer : role === "stolen" ? theft.victim : null, trackedTeamId });
  }));
  if (exchange) {
    const cards = new Map([...$("scorecards").children].map(node => [node.dataset.teamId, node]));
    $("scorecards").append(...oldOrder.map(id => cards.get(id)));
  }
  const stage = $("swap-stage");
  if (!theft) {
    $("event-title").textContent = "Original scores";
    $("event-description").textContent = "No steals in the log.";
    stage.replaceChildren(el("p", "empty-stage", "Add rows to the theft log to show swaps."));
    return;
  }
  showFeatured(theft, state, step, false);
  phase = exchange ? "scores" : "ready";
  if (!reducedMotion.matches) {
    pendingMotion = true;
    requestAnimationFrame(() => {
      if (token !== revision) return;
      pendingMotion = false;
      const start = document.timeline.currentTime;
      const movements = [...$("scorecards").children].flatMap(node => {
        const from = oldPositions.get(node.dataset.teamId);
        const to = node.getBoundingClientRect();
        if (!from) return [];
        const x = from.left - to.left, y = from.top - to.top;
        return Math.abs(x) > .5 || Math.abs(y) > .5 ? [{ node, x, y }] : [];
      });
      if (exchange) {
        animateSwap(theft, states[step - 1], start);
      }
      if (!exchange) movements.forEach(({ node, x, y }) => {
        motion(node, [{ transform: `translate(${x}px, ${y}px)` }, { transform: "translate(0, 0)" }],
          { duration: REORDER_DURATION * motionScale(), easing: "cubic-bezier(.2,.7,.25,1)", fill: "backwards" }, start);
      });
      if (motionPaused) {
        for (const animation of activeAnimations) animation.pause();
      } else {
        schedule();
      }
    });
  } else {
    schedule();
  }
}
function showFeatured(theft, state, step, flip, describe = true) {
  const stage = $("swap-stage");
  const oldCards = [...stage.querySelectorAll(".featured-slot > .scorecard:not(.departing-card)")];
  stage.replaceChildren();
  featuredTheft = theft;
  const rank = engine.ranks(state);
  const a = state.find(team => team.id === theft.stealer.teamId), b = state.find(team => team.id === theft.victim.teamId);
  const previous = states[Math.max(0, step - 1)];
  const playerA = a.players[theft.stealer.player].name, playerB = b.players[theft.victim.player].name;
  if (describe && step === 0) {
    $("event-title").textContent = "Original scores";
    $("event-description").replaceChildren("First steal: ", teamLabel(a), " swap with ", teamLabel(b), ".");
  } else if (describe) {
    $("event-title").replaceChildren(teamLabel(a), " steal from ", teamLabel(b));
    $("event-description").textContent = `${playerA}, hole ${theft.stealer.hole + 1} (${engine.getCell(previous, theft.stealer)}) ↔ ${playerB}, hole ${theft.victim.hole + 1} (${engine.getCell(previous, theft.victim)}). ${playerA} receives ${engine.getCell(state, theft.stealer)}; ${playerB} receives ${engine.getCell(state, theft.victim)}.`;
  }
  const before = step ? {
    a: engine.teamScore(previous.find(team => team.id === a.id)).total,
    b: engine.teamScore(previous.find(team => team.id === b.id)).total
  } : {};
  const flips = [];
  [card(a, rank[a.id], { role: "stealing", cell: theft.stealer, before: before.a, trackedTeamId }),
    card(b, rank[b.id], { role: "stolen", cell: theft.victim, before: before.b, trackedTeamId })].forEach((incoming, index) => {
    const slot = el("div", "featured-slot");
    slot.append(incoming);
    const outgoing = oldCards[index];
    if (flip && outgoing && outgoing.dataset.teamId !== incoming.dataset.teamId && !reducedMotion.matches) {
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
  animateFlips(flips, document.timeline.currentTime);
  return flips.length > 0;
}
function prepareNext() {
  if (current >= thefts.length || featuredTheft === thefts[current]) return false;
  const theft = thefts[current], state = states[current];
  const changed = showFeatured(theft, state, 0, true, false);
  const a = state.find(team => team.id === theft.stealer.teamId);
  const b = state.find(team => team.id === theft.victim.teamId);
  $("event-title").replaceChildren("Next steal: ", teamLabel(a), " from ", teamLabel(b));
  $("event-description").textContent = `${a.players[theft.stealer.player].name}, hole ${theft.stealer.hole + 1} (${engine.getCell(state, theft.stealer)}) ↔ ${b.players[theft.victim.player].name}, hole ${theft.victim.hole + 1} (${engine.getCell(state, theft.victim)}).`;
  return changed;
}
function reorderCards(animate = true) {
  if (!states.length) return;
  const grid = $("scorecards");
  const cards = new Map([...grid.children].map(node => [node.dataset.teamId, node]));
  const positions = new Map([...grid.children].map(node => [node.dataset.teamId, node.getBoundingClientRect()]));
  grid.append(...engine.standings(states[current]).map(team => cards.get(team.id)));
  deferredOrder = false;
  const start = document.timeline.currentTime;
  let moved = false;
  if (animate && !reducedMotion.matches) for (const node of grid.children) {
    const before = positions.get(node.dataset.teamId), after = node.getBoundingClientRect();
    const x = before.left - after.left, y = before.top - after.top;
    if (Math.abs(x) < .5 && Math.abs(y) < .5) continue;
    moved = true;
    motion(node, [{ transform: `translate(${x}px, ${y}px)` }, { transform: "translate(0, 0)" }],
      { duration: REORDER_DURATION * motionScale(), easing: "cubic-bezier(.2,.7,.25,1)", fill: "backwards" }, start);
  }
  return moved;
}
function populateTrackedTeams(teams) {
  const select = $("track-team");
  select.replaceChildren(new Option("None", ""));
  teams.forEach(team => {
    const option = new Option(`${teamName(team)} (${team.id})`, team.id);
    select.add(option);
  });
  select.disabled = teams.length === 0;
  select.value = "";
  trackedTeamId = "";
}
function updateTrackedTeam() {
  trackedTeamId = $("track-team").value;
  document.querySelectorAll(".scorecard").forEach(node => {
    node.classList.toggle("tracked-team", node.dataset.teamId === trackedTeamId);
  });
}
function animateFlips(flips, startTime) {
  flips.forEach(({ slot, incoming, outgoing }) => {
    motion(outgoing, [
      { transform: "rotateY(0deg)", visibility: "visible", easing: "ease-in" },
      { transform: "rotateY(90deg)", visibility: "visible", offset: .499999 },
      { transform: "rotateY(90deg)", visibility: "hidden", offset: .5 },
      { transform: "rotateY(90deg)", visibility: "hidden" }
    ], { duration: FLIP_DURATION * motionScale(), fill: "both" }, startTime, () => outgoing.remove());
    motion(incoming, [
      { transform: "rotateY(-90deg)", visibility: "hidden" },
      { transform: "rotateY(-90deg)", visibility: "hidden", offset: .5 },
      { transform: "rotateY(-90deg)", visibility: "visible", offset: .500001, easing: "ease-out" },
      { transform: "rotateY(0deg)", visibility: "visible" }
    ], { duration: FLIP_DURATION * motionScale(), fill: "both" }, startTime, () => {
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
      ], { duration: SCORE_DURATION * motionScale(), easing: "ease-in-out", fill: "both" }, startTime, () => chip.remove());
    });
    [a, b].forEach(cell => {
      motion(cell, [{ opacity: 0 }, { opacity: 0, offset: .9 }, { opacity: 1 }],
        { duration: SCORE_DURATION * motionScale(), fill: "backwards" }, startTime);
    });
  });
}
function pausePlayback() {
  motionPaused = true;
  for (const animation of activeAnimations) animation.pause();
  setPlaying(false);
}
function setPlaying(value) {
  if (!value) {
    captureInterval();
    if (playing) stopProgress();
  }
  playing = value;
  clearTimeout(timer);
  const complete = current === thefts.length && thefts.length && phase === "ready";
  const label = value ? "Pause" : complete ? "Replay" : "Play";
  $("play").replaceChildren(document.createTextNode(value ? "Ⅱ " : "▶ "), el("span", "", label));
  $("play").setAttribute("aria-label", label);
  $("play-state").textContent = value ? "PLAYING" : complete ? "COMPLETE" : "PAUSED";
  $("play-state").classList.toggle("is-playing", value);
  if (value) schedule();
}
function schedule() {
  clearTimeout(timer);
  captureInterval();
  if (motionPaused || pendingMotion || (!playing && phase === "ready")) return;
  intervalDuration = phaseDuration();
  intervalFraction = elapsedFraction;
  intervalStarted = performance.now();
  const remaining = intervalDuration * (1 - elapsedFraction);
  if (playing && current < thefts.length && !reducedMotion.matches) {
    const next = thefts[current];
    const needsFlip = featuredTheft &&
      (featuredTheft.stealer.teamId !== next.stealer.teamId || featuredTheft.victim.teamId !== next.victim.teamId);
    const ranks = deferredOrder ? REORDER_DURATION * motionScale() : 0;
    const flip = needsFlip ? FLIP_DURATION * motionScale() : 0;
    const after = phase === "scores" ? DWELL_DURATION + ranks + flip
      : phase === "dwell" ? ranks + flip : phase === "ranks" ? flip : 0;
    fillProgress((current + 1) / thefts.length * 100, remaining + after);
  }
  timer = setTimeout(() => {
    intervalStarted = null;
    elapsedFraction = 0;
    if (phase !== "ready") {
      // Finish effects before replacing their target nodes, including a throttled frame.
      for (const animation of [...activeAnimations]) animation.onfinish();
      if (phase === "scores") phase = "dwell";
      else if (phase === "dwell") {
        reorderCards();
        phase = "ranks";
      } else if (phase === "ranks") {
        phase = prepareNext() ? "cards" : "ready";
      } else phase = "ready";
      if (phase === "ready") {
        advance();
        return;
      }
      schedule();
      return;
    }
    advance();
  }, remaining);
}
function advance() {
  if (!playing) {
    setPlaying(false);
    return;
  }
  if (current === thefts.length) {
    setPlaying(false);
    return;
  }
  render(current + 1, true);
}
function jump(step, animate = false) {
  setPlaying(false);
  render(step, animate);
}
$("play").addEventListener("click", () => {
  if (playing) {
    pausePlayback();
    return;
  }
  const pausedMotion = (pendingMotion && motionPaused) || [...activeAnimations].some(animation => animation.playState === "paused");
  if (current === thefts.length && phase === "ready" && !pausedMotion) {
    render(0);
    fillProgress(0, 0);
  }
  motionPaused = false;
  for (const animation of activeAnimations) animation.play();
  setPlaying(true);
});
$("previous").addEventListener("click", () => jump(Math.max(0, current - 1)));
$("next").addEventListener("click", () => jump(Math.min(thefts.length, current + 1), true));
$("timeline").addEventListener("input", event => jump(Number(event.target.value)));
$("track-team").addEventListener("change", updateTrackedTeam);
$("speed").addEventListener("change", () => {
  captureInterval();
  for (const animation of activeAnimations) {
    const timing = animation.effect.getTiming();
    const fraction = animation.currentTime / timing.duration;
    const duration = animation.baseDuration * motionScale();
    animation.effect.updateTiming({ duration });
    animation.currentTime = fraction * duration;
  }
  schedule();
});
document.addEventListener("visibilitychange", () => { if (document.hidden && playing) pausePlayback(); });
window.addEventListener("resize", () => {
  captureInterval();
  clearMotion();
  reorderCards(false);
  phase = "ready";
  elapsedFraction = 0;
  if (playing) {
    prepareNext();
    clearMotion();
    schedule();
  }
  if (!playing) {
    stopProgress();
    fillProgress(thefts.length ? current / thefts.length * 100 : 0, 0);
  }
});
reducedMotion.addEventListener("change", () => {
  if (reducedMotion.matches) {
    clearMotion();
    reorderCards(false);
    phase = "ready";
    setPlaying(false);
    fillProgress(thefts.length ? current / thefts.length * 100 : 0, 0);
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
    populateTrackedTeams(teams);
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
