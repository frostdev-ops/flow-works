# Flow-works

**Your Degree Works audit, as a readable flowchart.**

Flow-works turns an Ellucian Degree Works audit into a top-to-bottom prerequisite map: what you've finished, what you're taking now, and a suggested term for everything left. Select any course to focus on its prerequisites and the courses it unlocks.

**[Try the live demo →](https://frostdev-ops.github.io/flow-works/#demo)**

![Whole-degree prerequisite flowchart](docs/overview.jpg)

## The flowchart

The whole degree fits into one canvas on load, including courses without prerequisite links. Branches stay close together, their starting courses sit above the fork, and shared prerequisites appear once. Courses can stagger instead of stretching every branch to the same row. Rows are not terms.

Connections fan out as separate curves from individual attachment points on the top, bottom, and sides of a card. Long connections reserve their own lanes while they overlap in height. Lines can cross, but never merge into a shared stem or run through a card.

Card color shows how many later courses depend on a course, directly or through another prerequisite: **dark orange for the biggest bottlenecks, through amber to green for fewer dependents**. Each downstream course counts once, even when several paths lead to it. Completed courses retain their dependency color and have a Done badge. Status, term, and dependency count are also available as text.

**Columns: Auto** balances the chart for your screen. Choose a column count or change **Spacing** to arrange it yourself. **Fit all** fits both width and height; **Zoom** lets you inspect more closely. Column and spacing preferences stay in your browser. Very large degrees fit at a smaller scale; select any course to read its details at full size.

Hover or keyboard-focus a course to trace its prerequisites and what it unlocks. Click it to open its prerequisite tree and the courses that follow it, with breadcrumbs back. Degree progress and requirement groups are available just below the canvas.

**Plan insights & prerequisites to check**, below the chart, contains the critical path, bottlenecks, and missing prerequisites. Drag the max-credits slider to update the suggested terms throughout the chart and the course modals.

## Use it

1. Open **[frostdev-ops.github.io/flow-works](https://frostdev-ops.github.io/flow-works/)** and drag the **Flow-works** button to your bookmarks bar.
2. Sign in to Degree Works and open your worksheet.
3. Click the bookmark.

The bookmarklet reads the audit you're already viewing (same site, your own session), looks up each course's prerequisites, and opens Flow-works with the data packed into the URL fragment.

### Privacy

- Nothing is uploaded. The data travels in the `#fragment`, which browsers never send to servers, and the page itself is static files on GitHub Pages.
- Your student ID and email are removed before the data leaves the Degree Works tab.
- The audit stays in your browser's `localStorage` until you click **Load another audit**.
- It's plain JavaScript with no dependencies, so you can read all of it.

## Does it work with my school?

Flow-works reads the Degree Works **Responsive Dashboard** API (`/responsiveDashboard/api/audit`, plus `api/course-link` for prerequisites). If your worksheet URL contains `/responsivedash/` or `/responsiveDashboard/`, it should work. It was developed against a live Responsive Dashboard install. Schools configure their audits differently, so if yours looks wrong, please [open an issue](https://github.com/frostdev-ops/flow-works/issues) with the shape that broke. Never post your real audit; the field names are enough.

## How the plan is made

Remaining requirements come from each rule's *still needed* advice. Choice rules ("choose 9 credits from…") become one card per course slot, and any remaining credit gap is filled with free electives. Courses are scheduled into upcoming Fall/Spring terms greedily:

1. Courses that head the longest remaining prerequisite chains go first, then lower course levels.
2. A course never lands in the same term as, or before, its prerequisites.
3. Each term stays under the max-credits limit.

Prerequisites are read as an AND of OR-groups. Test-score alternatives and parenthesis nesting are ignored. The planner doesn't know which terms a course is offered in, so treat the plan as a starting point for a conversation with your advisor. It isn't a registration plan.

For audits identifying **MATH 1060 as Foundations of Math**, blank prerequisite rows use the supplied business course map: MATH 1060 → MATH 1170 and ECON 2020; MATH 1170 → ACCT 2110 and ECON 2100; ACCT 2110 plus ECON 2020 → FIN 3200; ACCT 2110 → ACCT 2120; ECON 2100 → ECON 2110. Existing prerequisite rows are preserved. This correction applies to saved audits and JSON imports as well as the bookmarklet. The bookmarklet also checks named courses even when the source's prerequisite flag says No.

## Development

No build step and no dependencies.

```sh
python3 -m http.server 8000   # then open http://localhost:8000/#demo
node test.mjs                 # parser, planner and flowchart layout checks
```

| File | What it does |
| --- | --- |
| `model.js` | Pure functions: audit JSON → model, the planner, prerequisite analysis, graph layout, edge routing |
| `app.js` | Shared degree/course rendering, SVG connections, interactions |
| `bookmarklet.js` | Runs on Degree Works; `app.js` turns it into the drag-to-bookmarks link |
| `demo.json` | A fictional student in the real API shape |
| `index.html`, `style.css` | The page |

You can also load a saved audit JSON file (the raw `api/audit` response) with **Load audit JSON** or by dropping it on the page.

## License

MIT
