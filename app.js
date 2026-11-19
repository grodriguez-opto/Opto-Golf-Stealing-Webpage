"use strict";

const engine = GolfReplay;
const $ = id => document.getElementById(id);
let states = [], thefts = [], current = 0, playing = false, timer;
let revision = 0;
const activeAnimations = new Set();
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function teamName(team) {
  return team.players.map(player => player.name).join(" & ");
}
function card(team, rank, options = {}) {
  const score = engine.teamScore(team);
  const article = el("article", `scorecard ${options.role || ""}`);
  article.dataset.teamId = team.id;
  article.setAttribute("aria-label", `${teamName(team)}, total ${score.total}, rank ${rank}`);
  const head = el("div", "card-heading"), identity = el("div", "team-identity");
  identity.append(el("h3", "", teamName(team)));
  const rankLabel = el("span", "rank", `Rank ${rank}`);
  rankLabel.setAttribute("aria-label", `Rank ${rank}`);
  head.append(identity, rankLabel);
  article.append(head);
  const table = el("table"), caption = el("caption", "sr-only", `${teamName(team)} scorecard`);
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
      td.setAttribute("aria-label", `${teamName(team)}: ${player.name}, player ${p + 1}, hole ${hole + 1}, ${value} strokes${involved ? ", selected for swap" : ""}`);
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
  for (const animation of activeAnimations) animation.cancel();
  activeAnimations.clear();
  document.querySelectorAll(".flying-score").forEach(node => node.remove());
}
function render(step, animate = false) {
  revision++;
  clearMotion();
  const token = revision, old = current;
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
  $("leader").textContent = `${leaders.map(teamName).join(" / ")} · ${engine.teamScore(leaders[0]).total} strokes`;
  $("scorecards").replaceChildren(...state.map(team => {
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
    $("event-description").textContent = `First steal: ${teamName(a)} swap with ${teamName(b)}.`;
  } else {
    $("event-title").textContent = `${teamName(a)} steal from ${teamName(b)}`;
    $("event-description").textContent = `${playerA}, hole ${theft.stealer.hole + 1} (${engine.getCell(previous, theft.stealer)}) ↔ ${playerB}, hole ${theft.victim.hole + 1} (${engine.getCell(previous, theft.victim)}). ${playerA} receives ${engine.getCell(state, theft.stealer)}; ${playerB} receives ${engine.getCell(state, theft.victim)}.`;
  }
  const before = step ? {
    a: engine.teamScore(previous.find(team => team.id === a.id)).total,
    b: engine.teamScore(previous.find(team => team.id === b.id)).total
  } : {};
  stage.append(card(a, rank[a.id], { role: "stealing", cell: theft.stealer, before: before.a }));
  const connector = el("div", "swap-connector");
  connector.append(el("span", "", "⇄"), el("small", "", step ? "Swapped" : "Next"));
  stage.append(connector, card(b, rank[b.id], { role: "stolen", cell: theft.victim, before: before.b }));
  if (animate && step === old + 1 && !reducedMotion.matches) {
    // Measure after the replacement cards have settled into the layout.
    requestAnimationFrame(() => { if (token === revision) animateSwap(theft, previous); });
  }
}
function animateSwap(theft, before) {
  const stage = $("swap-stage");
  const locate = cell => stage.querySelector(`[data-cell="${cell.teamId}-${cell.player}-${cell.hole}"]`);
  const a = locate(theft.stealer), b = locate(theft.victim);
  if (!a || !b) return;
  const boxA = a.getBoundingClientRect(), boxB = b.getBoundingClientRect();
  [[boxA, boxB, engine.getCell(before, theft.stealer), "outbound"], [boxB, boxA, engine.getCell(before, theft.victim), "inbound"]].forEach(([from, to, value, direction], index) => {
    const chip = el("div", `flying-score ${direction}`, String(value));
    chip.setAttribute("aria-hidden", "true");
    chip.style.left = `${from.left + from.width / 2 - 20}px`;
    chip.style.top = `${from.top + from.height / 2 - 20}px`;
    document.body.append(chip);
    const x = to.left - from.left + (to.width - from.width) / 2;
    const y = to.top - from.top + (to.height - from.height) / 2;
    const animation = chip.animate([
      { transform: "translate(0, 0) scale(.8)", opacity: 0 },
      { transform: "translate(0, 0) scale(1.1)", opacity: 1, offset: .12 },
      { transform: `translate(${x / 2}px, ${y / 2 + (index ? 75 : -75)}px) scale(1.2)`, opacity: 1, offset: .5 },
      { transform: `translate(${x}px, ${y}px) scale(1)`, opacity: 1, offset: .9 },
      { transform: `translate(${x}px, ${y}px) scale(.8)`, opacity: 0 }
    ], { duration: 1250, easing: "ease-in-out" });
    activeAnimations.add(animation);
    animation.onfinish = () => { chip.remove(); activeAnimations.delete(animation); };
  });
  [a, b].forEach(cell => {
    const animation = cell.animate([{ opacity: .15 }, { opacity: .15, offset: .8 }, { opacity: 1 }], { duration: 1300 });
    activeAnimations.add(animation);
    animation.onfinish = () => activeAnimations.delete(animation);
  });
}
function setPlaying(value) {
  playing = value;
  clearTimeout(timer);
  const label = value ? "Pause" : current === thefts.length && thefts.length ? "Replay" : "Play";
  $("play").replaceChildren(document.createTextNode(value ? "Ⅱ " : "▶ "), el("span", "", label));
  $("play").setAttribute("aria-label", label);
  $("play-state").textContent = value ? "PLAYING" : current === thefts.length ? "COMPLETE" : "PAUSED";
  $("play-state").classList.toggle("is-playing", value);
  if (value) schedule();
}
function schedule() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    if (!playing) return;
    if (current < thefts.length) render(current + 1, true);
    if (current === thefts.length) setPlaying(false);
    else schedule();
  }, Number($("speed").value));
}
function jump(step, animate = false) {
  setPlaying(false);
  render(step, animate);
  setPlaying(false);
}
$("play").addEventListener("click", () => {
  if (!playing && current === thefts.length) render(0);
  setPlaying(!playing);
});
$("previous").addEventListener("click", () => jump(Math.max(0, current - 1)));
$("next").addEventListener("click", () => jump(Math.min(thefts.length, current + 1), true));
$("timeline").addEventListener("input", event => jump(Number(event.target.value)));
$("speed").addEventListener("change", () => { if (playing) schedule(); });
document.addEventListener("visibilitychange", () => { if (document.hidden && playing) setPlaying(false); });
window.addEventListener("resize", clearMotion);
window.addEventListener("scroll", clearMotion, { passive: true });

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
