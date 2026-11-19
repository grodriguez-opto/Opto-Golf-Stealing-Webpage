# Opto 22 mini golf scores

A pure HTML/CSS/JavaScript mini golf score replay. No build, packages, accounts, or backend required. All resources use relative paths, including on a GitHub Pages project site.

## Publish on GitHub Pages

1. Push these files to the repository's `main` branch.
2. Open **Settings > Pages**, choose **Deploy from a branch**, select **main** and **/ (root)**, and save.
3. Open the published Pages URL after deployment finishes.

## Update the round

Edit or replace the CSVs in `data/`, keeping their filenames and headers:

- `scorecards.csv`: `Team Id,Player Names,1,2,3,4,5,6,7,8,9`. Include exactly two rows per team, with player 1 first and player 2 second. Blank separator rows are optional. Scores must be nonnegative whole numbers.
- `thefts.csv`: `Team Stealing,Stealing Hole (player-hole#),Team Stolen From,Stolen Hole (player-hole#)`. A row such as `12,1-1,21,1-6` swaps team 12's player 1 / hole 1 with team 21's player 1 / hole 6.

Names may repeat, including on different teams. Identity is team ID plus player order, never name. CSV quoted fields, escaped quotes, CRLF/LF, and blank rows are supported. Invalid data displays a visible error instead of partial scores.

The page displays each team's two player names followed by its numeric ID in smaller text. The ID is announced as a team number for screen readers. IDs remain in the CSVs and internal references so duplicate names do not affect scoring.

The team score for each hole is the **higher** of the two players' scores. The team total is the sum of those nine values; lower totals rank first and tied totals share a rank. Scores cards are ordered from first place at the top left to last place at the bottom right, using numeric team ID as the stable tie-break order. Cards animate to their new grid positions after a standings change. Thefts are two-way swaps applied sequentially, including when a cell is swapped repeatedly.

## Replay controls

Playback controls stay fixed at the bottom of the viewport, with reserved page space and mobile safe-area padding so they do not obscure the last cards or footer.

During playback, the timeline track fills continuously toward the next step while the slider thumb stays on the selected step. Pause freezes the fill; resuming or changing speed preserves its progress through the interval. Manual stepping and scrubbing ease the fill to the selected step. Reduced motion uses immediate updates instead.

The replay autoplays once, stopping after the final steal. Use play/pause, previous/next, the speed selector, or the timeline slider to inspect any state. Scrubbing pauses playback. Featured cards match the Scores grid's card sizes. When a featured team changes, its old card flips horizontally to the edge-on midpoint before the new card appears. The unchanged team's card stays in place. After the flip and standings movement settle, the score exchange plays in both sections with the same values and timing; the theft is applied only once. Equal-valued scores still swap, with no change to cell values.

Pause freezes active card, standings, and score animations as well as playback; Play resumes them. Scrubbing cancels stale motions before animating to the selected standings. Resizing cancels motion and shows the current state in the new layout. Scrolling does not interrupt the synchronized score exchanges. Reduced-motion preferences disable autoplay and all animation types; manual timeline controls still work. Playback also pauses when the tab is hidden.

## Styling

The red (`#c52f2e`), blue (`#0e72b0`), white/light-gray panels, and Rubik typeface follow the styling inspected at [opto22.com](https://www.opto22.com/) and its `assets/css/opto.css` stylesheet. The fonts are served locally with their SIL Open Font License in `assets/fonts/`. No external requests are needed to display the page.

## Local preview and tests

Serve this folder over HTTP rather than opening `index.html` directly, since browsers restrict CSV fetching from local files. For example, with Python installed:

```powershell
python -m http.server 8000
```

Open `http://localhost:8000`. To check a nested deployment, open the repository subdirectory when serving its parent directory.

The scoring engine tests use only Node's built-in test runner (no installation):

```powershell
node --test tests\engine.test.cjs
```

Engine regression tests keep the original round in `tests/fixtures/`, separate from the editable CSVs. They also validate the current round.

Browser regression tests require Node 22+ and Chrome or Edge on Windows (or set `CHROME_PATH` to a Chromium executable). They start their own local server and check card sizes, flip midpoint visibility, standings order and motion, fixed controls, synchronized animations, cancellation, pause/resume, and reduced motion against the current round:

```powershell
node --test tests\browser.test.cjs
```

Set `SCREENSHOT_DIR` to save desktop, mobile, flip-transition, standings, and score-swap screenshots during the browser run.
