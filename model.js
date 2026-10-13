// Degree Works audit JSON → flowchart model. Pure functions; runs in the browser and in Node (test.mjs).

const SMALL = new Set(['an', 'and', 'at', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'with']);
export const titleCase = (s = '') =>
  s.trim().toLowerCase().replace(/[a-z0-9']+/g, (w, i) =>
    i && SMALL.has(w) ? w : /^(i|ii|iii|iv|v|vi)$/.test(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1));

const sum = (xs, f) => xs.reduce((n, x) => n + f(x), 0);
const wild = c => /@/.test(c.discipline + c.number) || !!c.numberEnd;
const bkey = b => b.requirementType + ':' + b.requirementValue;
const walk = (rules, fn, parent) => { for (const r of rules || []) { fn(r, parent); walk(r.ruleArray, fn, r); } };

// Banner prereq rows [connector, subject, number] → AND-of-ORs: [["CS 2300"], ["MATH 1160", "MATH 1350"]].
// ponytail: ignores parenthesis nesting and test-score rows; good enough to order courses, not to grant registration.
export function prereqGroups(rows = []) {
  const groups = [];
  for (const [conn, subj, num] of rows) {
    if (!subj || !num) continue;
    if (conn === 'O' && groups.length) groups.at(-1).push(subj + ' ' + num);
    else groups.push([subj + ' ' + num]);
  }
  return groups;
}

const describe = c => [
  c.discipline === '@' ? 'Any' : c.discipline,
  c.number === '@' ? 'course' : c.number.replace(/@/g, 'x') + (c.numberEnd ? '–' + c.numberEnd : ''),
  c.title && '· ' + titleCase(c.title),
  c.withAdvice && `(${c.withAdvice.toLowerCase()})`,
].filter(Boolean).join(' ');

const level = n => +String(n)[0] || 1;

export function parseAudit(audit, prereqRows = {}) {
  if (!Array.isArray(audit?.blockArray)) throw new Error("That doesn't look like a Degree Works audit.");
  const blocks = audit.blockArray;
  const degree = blocks.find(b => b.requirementType === 'DEGREE') || blocks[0];
  const pre = code => prereqGroups(prereqRows[code]);

  // A block hangs under whichever block's Block/Blocktype rule pulls it in; groups are the degree's direct children.
  const parent = {};
  for (const b of blocks) walk(b.ruleArray, r => {
    const q = r.requirement || {};
    if (r.ruleType === 'Block') parent[q.type + ':' + q.value] ??= bkey(b);
    if (r.ruleType === 'Blocktype') for (const x of blocks) if (x.requirementType === q.type) parent[bkey(x)] ??= bkey(b);
  });
  const top = k => { for (let i = 0; parent[k] && parent[k] !== bkey(degree) && i < 20; i++) k = parent[k]; return k; };

  const groups = [], groupOf = {};
  for (const b of blocks) {
    if (b === degree) continue;
    const g = groupOf[bkey(b)] = top(bkey(b));
    if (!groups.some(x => x.id === g)) {
      const gb = blocks.find(x => bkey(x) === g) || b;
      groups.push({ id: g, title: gb.title, pct: Math.round(+gb.percentComplete || 0) });
    }
  }

  const classBlock = {};
  for (const b of blocks) if (b !== degree) walk(b.ruleArray, r => {
    for (const c of r.classesAppliedToRule?.classArray || []) classBlock[c.id] ??= b;
  });

  const bad = new Set((audit.insufficient?.classArray || []).map(c => c.id));
  const courses = (audit.classInformation?.classArray || []).filter(c => !bad.has(c.id)).map(c => {
    const b = classBlock[c.id], code = c.discipline + ' ' + c.number, transfer = c.transfer === 'T';
    return {
      key: 'c' + c.id + code, code, title: titleCase(c.courseTitle) || code, credits: +c.credits || 0,
      grade: transfer ? c.letterGrade?.replace(/^T(?=[A-F])/, '') : c.letterGrade,
      status: c.inProgress === 'Y' ? 'current' : c.preregistered === 'Y' ? 'registered' : 'done',
      transfer, term: c.term || '', termLabel: c.termLiteral || c.term || '',
      group: b ? groupOf[bkey(b)] : 'free', block: b?.title || 'Free electives', prereqs: pre(code),
    };
  });

  const remaining = [], have = new Set(courses.map(c => c.code));
  const generic = l => !l || /^(select|choose)\b/i.test(l);
  const code = c => c.discipline + ' ' + c.number;
  const adviceOf = r => [...(r.advice?.courseArray || []), ...(r.ruleArray || []).flatMap(adviceOf)];

  function course(r, up, b) {
    const opts = r.advice?.courseArray;
    if (r.ruleType !== 'Course' || !opts?.length) return;
    const classes = +r.advice.classes || 0, credits = +r.advice.credits || 0;
    const base = { group: groupOf[bkey(b)], block: b.title, status: 'planned' };
    if (!credits && opts.length <= Math.max(classes, 1) && !opts.some(wild)) {
      for (const c of opts) {
        if (have.has(code(c))) continue;
        have.add(code(c));
        remaining.push({ ...base, key: 'p' + code(c), code: code(c), title: opts.length === 1 && r.label ? r.label : titleCase(c.title) || code(c),
          credits: +c.credits || 3, prereqs: pre(code(c)), level: level(c.number) });
      }
      return;
    }
    const n = classes || Math.max(1, Math.round(credits / 3));
    const known = opts.filter(c => +c.credits);
    const each = credits ? Math.round(credits / n * 10) / 10 : known.length ? Math.round(sum(known, c => +c.credits) / known.length) : 3;
    const lv = Math.min(...opts.map(c => c.number === '@' ? 1 : level(c.number)));
    const title = generic(r.label) ? (up?.label && titleCase(up.label)) || b.title : r.label;
    for (let i = 0; i < n; i++)
      remaining.push({ ...base, key: `r${bkey(b)}:${r.ruleId ?? r.label}:${i}`, title, credits: each, options: opts.map(describe), prereqs: [], level: lv });
  }

  // "N groups from (A) or (B) or ...": plan an option the student already started; otherwise hold the place
  // with choice slots listing every option, instead of planning all of them (e.g. every world language).
  function group(r, up, b) {
    const q = r.requirement || {};
    const subs = (r.ruleArray || []).map((x, i) => ({ x, i, p: +x.percentComplete || 0, adv: adviceOf(x) }));
    let need = +(q.numberOfGroups ?? q.numGroups ?? 1) - subs.filter(s => s.p >= 100).length;
    const open = subs.filter(s => s.p < 100 && s.adv.length).sort((m, n) => n.p - m.p || m.i - n.i);
    for (const s of open.filter(s => s.p > 0)) if (need > 0) { visit([s.x], r, b); need--; }
    const fresh = open.filter(s => !s.p).map(s => ({ ...s, adv: [...s.adv].sort((c, d) => c.number.localeCompare(d.number)) }));
    if (need <= 0 || !fresh.length) return;
    const n = Math.min(...fresh.map(s => s.adv.length)), all = fresh.flatMap(s => s.adv);
    const credits = Math.round(sum(all, c => +c.credits || 3) / all.length);
    const chained = fresh.some(s => s.adv.slice(1).some((c, k) => pre(code(c)).some(g => g.includes(code(s.adv[k])))));
    const title = generic(r.label) ? (up?.label && titleCase(up.label)) || b.title : r.label;
    const options = fresh.map(s => (s.x.label ? titleCase(s.x.label) + ': ' : '') + s.adv.map(c => (wild(c) ? describe(c) : code(c))).join(' + '));
    for (let g = 0; g < need; g++) for (let k = 0; k < n; k++) {
      const key = i => `g${bkey(b)}:${r.ruleId ?? r.label}:${g}:${i}`;
      remaining.push({ group: groupOf[bkey(b)], block: b.title, status: 'planned', key: key(k), title: n > 1 ? `${title} (${k + 1} of ${n})` : title,
        credits, options, prereqs: [], level: Math.min(...fresh.map(s => level(s.adv[k].number))), after: chained && k ? key(k - 1) : undefined });
    }
  }

  function visit(rules, up, b) {
    for (const r of rules || []) {
      if (r.ruleType === 'Group') group(r, up, b);
      else { course(r, up, b); visit(r.ruleArray, r, b); }
    }
  }
  for (const b of blocks) if (b !== degree) visit(b.ruleArray, undefined, b);

  const q = (degree.header?.qualifierArray || []).find(x => x.name === 'CLASSESCREDITS');
  const total = +q?.credits || 120, applied = +q?.applied || sum(courses, c => c.credits);
  for (let gap = total - applied - sum(remaining, x => x.credits), i = 0; gap > 0; gap -= 3, i++)
    remaining.push({ key: 'e' + i, title: 'Free elective', credits: Math.min(3, gap), group: 'free', block: 'Free electives',
      status: 'planned', prereqs: [], level: 5, options: ['Any course that counts toward your degree'] });
  if (courses.some(c => c.group === 'free') || remaining.some(c => c.group === 'free'))
    groups.push({ id: 'free', title: 'Free electives', pct: null });

  const latest = courses.reduce((a, c) => (c.term > (a?.term || '') ? c : a), null);
  const [last, first] = (audit.auditHeader?.studentName || '').split(',');
  const major = blocks.find(b => /MAJOR|PROGRAM/.test(b.requirementType));
  return {
    student: (first || last || '').trim().split(' ')[0],
    title: major?.title || degree.title, degree: degree.title, catalog: degree.catalogYearLit || degree.catalogYear || '',
    pct: Math.round(+audit.auditHeader?.percentComplete || +degree.percentComplete || 0),
    total, applied, groups, courses, remaining, lastTerm: latest?.termLabel,
  };
}

const SEASONS = { winter: 'Spring', spring: 'Fall', summer: 'Fall', fall: 'Spring' };
export function nextTerm(label, today = new Date()) {
  const m = /(winter|spring|summer|fall)\s+(\d{4})/i.exec(label || '');
  if (!m) return today.getMonth() < 6 ? `Fall ${today.getFullYear()}` : `Spring ${today.getFullYear() + 1}`;
  const s = m[1].toLowerCase(), y = +m[2];
  return `${SEASONS[s]} ${s === 'fall' ? y + 1 : y}`;
}

// Greedy semester planner (critical-path first): courses heading the longest remaining prereq chains go first,
// then lower levels; prereqs must land in an earlier term; credit cap per term.
// ponytail: knows nothing about which terms a course is offered; add offering data when a school exposes it.
export function plan(model, maxCredits = 15) {
  const done = new Set(model.courses.map(c => c.code));
  const kids = {}, depth = new Map();
  for (const it of model.remaining) {
    for (const g of it.prereqs) for (const c of g) (kids[c] ||= []).push(it);
    if (it.after) (kids[it.after] ||= []).push(it);
  }
  const d = it => {
    if (!depth.has(it)) { depth.set(it, 0); depth.set(it, 1 + Math.max(0, ...[...(kids[it.code] || []), ...(kids[it.key] || [])].map(d))); }
    return depth.get(it);
  };
  const todo = [...model.remaining].sort((a, b) => d(b) - d(a) || a.level - b.level || !!a.options - !!b.options || (a.code || '').localeCompare(b.code || ''));
  const pending = new Set(todo.map(x => x.code).filter(Boolean));
  const terms = [];
  for (let label = model.lastTerm; todo.length && terms.length < 20;) {
    label = nextTerm(label);
    const term = { label, items: [], credits: 0 };
    for (const it of [...todo]) {
      const ready = it.prereqs.every(g => g.some(c => done.has(c)) || !g.some(c => pending.has(c))) && (!it.after || done.has(it.after));
      if (!ready || term.credits + it.credits > maxCredits) continue;
      term.items.push(it); term.credits += it.credits; todo.splice(todo.indexOf(it), 1);
    }
    if (!term.items.length) { const it = todo.shift(); term.items.push(it); term.credits += it.credits; } // prereq cycle or oversized course
    for (const it of term.items) { done.add(it.key); if (it.code) { done.add(it.code); pending.delete(it.code); } }
    terms.push(term);
  }
  return terms;
}

export function columns(model, maxCredits = 15) {
  const cols = [], tr = model.courses.filter(c => c.transfer), byTerm = {};
  if (tr.length) cols.push({ label: 'Transfer credit', kind: 'transfer', items: tr });
  for (const c of model.courses) if (!c.transfer) (byTerm[c.term] ||= []).push(c);
  for (const t of Object.keys(byTerm).sort())
    cols.push({ label: byTerm[t][0].termLabel, kind: byTerm[t].some(c => c.status !== 'done') ? 'current' : 'past', items: byTerm[t] });
  for (const t of plan(model, maxCredits)) cols.push({ label: t.label, kind: 'future', items: t.items });
  for (const c of cols) c.credits = sum(c.items, x => x.credits);
  return cols;
}

// Prerequisite graph over the placed columns: links, per-course prereq status, bottlenecks and the critical path.
export function analyze(cols) {
  const at = {}, edges = [], needs = {}, missing = [], down = {}, byKey = {};
  const placed = cols.flatMap((c, ci) => c.items.map(it => ({ it, ci })));
  const ciOf = {};
  for (const { it, ci } of placed) { byKey[it.key] = it; ciOf[it.key] = ci; if (it.code) (at[it.code] ||= []).push({ key: it.key, ci }); }
  for (const { it, ci } of placed) if (it.after && ciOf[it.after] < ci) { edges.push({ from: it.after, to: it.key }); (down[it.after] ||= []).push(it.key); }
  for (const { it, ci } of placed) needs[it.key] = (it.prereqs || []).map(g => {
    const from = g.flatMap(code => at[code] || []).filter(x => x.ci < ci).sort((a, b) => b.ci - a.ci)[0];
    if (from) { edges.push({ from: from.key, to: it.key }); (down[from.key] ||= []).push(it.key); return { codes: g, state: 'met' }; }
    if (it.status === 'planned' && !g.some(code => at[code])) { missing.push({ key: it.key, needs: g }); return { codes: g, state: 'miss' }; }
    return { codes: g, state: 'past' };
  });
  // Edges only point to later columns, so the graph is a DAG and these memoized walks terminate.
  const depth = {}, reach = {};
  const d = k => (depth[k] ??= 1 + Math.max(0, ...(down[k] || []).map(d)));
  const r = k => (reach[k] ??= new Set((down[k] || []).flatMap(t => [t, ...r(t)])));
  const open = placed.map(x => x.it).filter(it => it.status !== 'done');
  const info = Object.fromEntries(open.map(it => [it.key, { unlocks: r(it.key).size, depth: d(it.key) }]));
  const necks = open.filter(it => info[it.key].unlocks).map(it => ({ key: it.key, ...info[it.key] }))
    .sort((a, b) => b.unlocks - a.unlocks || b.depth - a.depth);
  const critical = [], deepest = keys => keys.reduce((a, k) => (!a || d(k) > d(a) ? k : a), null);
  for (let k = deepest(open.map(it => it.key)); k; k = deepest(down[k] || [])) critical.push(k);
  return { edges, needs, missing, info, necks, critical: critical.length > 1 ? critical : [], byKey };
}

// Prerequisite view columns: column = longest prereq chain above a course. Courses with no links are left out.
export function layers(a) {
  const up = {}, lv = {}, cols = [], linked = new Set();
  for (const e of a.edges) { (up[e.to] ||= []).push(e.from); linked.add(e.from).add(e.to); }
  const L = k => (lv[k] ??= up[k] ? 1 + Math.max(...up[k].map(L)) : 0);
  for (const k of Object.keys(a.byKey)) if (linked.has(k)) (cols[L(k)] ||= []).push(a.byKey[k]);
  return cols;
}

// Edge routing: a link that spans several columns gets a "via" slot in every column it crosses, so lines
// run through gaps between cards instead of under them. Cards and slots are then ordered by barycenter
// sweeps to cut crossings. Returns per-column entries (items or { key, via: true }) and each edge's key path.
export function route(cols, edges) {
  const at = {}, out = cols.map(c => [...c]), up = {}, down = {}, pos = {};
  cols.forEach((c, ci) => c.forEach(it => (at[it.key] = ci)));
  const paths = edges.map((e, ei) => {
    const path = [e.from];
    for (let ci = at[e.from] + 1; ci < at[e.to]; ci++) {
      const key = `via${ei}:${ci}`;
      out[ci].push({ key, via: true });
      path.push(key);
    }
    path.push(e.to);
    for (let i = 1; i < path.length; i++) { (up[path[i]] ||= []).push(path[i - 1]); (down[path[i - 1]] ||= []).push(path[i]); }
    return path;
  });
  const place = c => c.forEach((x, i) => (pos[x.key] = i));
  const bary = (k, nb) => (nb[k] ? nb[k].reduce((s, n) => s + pos[n], 0) / nb[k].length : pos[k]);
  out.forEach(place);
  for (let pass = 0; pass < 6; pass++) {
    const nb = pass % 2 ? down : up;
    for (const c of pass % 2 ? [...out].reverse() : out) { c.sort((x, y) => bary(x.key, nb) - bary(y.key, nb)); place(c); }
  }
  return { cols: out, paths };
}

// Roadmap (vertical) layout: rows run top → bottom (everything completed folded into one compact row, then the current
// term and each planned term) and columns are requirement-group lanes. Prerequisite lines still ahead run orthogonally
// through the channels between lanes and the gutters between rows, each on its own track, so they never cross a card;
// a link straight down a lane into the next row becomes a plain drop. Channel c sits left of lane c (L+1 channels).
export function roadmap(cols, edges, groups) {
  const past = cols.filter(c => c.kind === 'transfer' || c.kind === 'past');
  const rows = past.length ? [{ kind: 'done', label: 'Completed', terms: past.map(c => c.label), items: past.flatMap(c => c.items) }] : [];
  for (const c of cols) if (c.kind === 'current' || c.kind === 'future') rows.push({ kind: c.kind, label: c.label, items: c.items });
  const lanes = groups.filter(g => rows.some(r => r.items.some(it => it.group === g)));
  const laneOf = Object.fromEntries(lanes.map((g, i) => [g, i])), rowOf = {}, group = {}, last = rows.length - 1;
  rows.forEach((r, ri) => r.items.forEach(it => { rowOf[it.key] = ri; group[it.key] = it.group; }));
  const live = edges.filter(e => rowOf[e.from] != null && rowOf[e.to] != null && rows[rowOf[e.from]].kind !== 'done');
  if (rows[last] && rows[last].kind !== 'done') for (const it of rows[last].items) live.push({ from: it.key, to: 'grad' });

  // Inside a cell, courses fed from straight above go first and courses feeding straight below go last.
  const down = e => e.to !== 'grad' && group[e.from] === group[e.to] && rowOf[e.to] === rowOf[e.from] + 1;
  const gets = new Set(live.filter(down).map(e => e.to)), sends = new Set(live.filter(down).map(e => e.from));
  const cells = rows.map(r => lanes.map(g => r.items.filter(it => it.group === g)
    .sort((a, b) => gets.has(b.key) - gets.has(a.key) || sends.has(a.key) - sends.has(b.key))));
  const at = {};
  cells.forEach((row, r) => row.forEach((cell, l) => cell.forEach((it, s) => (at[it.key] = { r, l, s, n: cell.length }))));

  // Vertical position in "row units": a course sits inside its row, a gutter sits just below it.
  const y = p => p.r + 0.1 + (0.7 * (p.s + 0.5)) / p.n;
  const vseg = Array.from({ length: lanes.length + 1 }, () => []), hseg = rows.map(() => []);
  const fit = (list, lo, hi) => {
    let t = 0;
    while (list.some(o => o.t === t && lo < o.hi + 0.02 && o.lo < hi + 0.02)) t++;
    list.push({ lo, hi, t });
    return t;
  };
  const span = e => (e.to === 'grad' ? last + 1 : rowOf[e.to]) - rowOf[e.from] + Math.abs((laneOf[group[e.to]] ?? 0) - laneOf[group[e.from]]) / 10;
  const routes = [...live].sort((p, q) => span(p) - span(q)).map(e => {
    const a = at[e.from];
    if (e.to === 'grad') {
      const c = a.l + (a.l + 0.5 < lanes.length / 2 ? 1 : 0);
      return { ...e, x1: c, t1: fit(vseg[c], y(a), last + 0.95) };
    }
    const b = at[e.to];
    if (a.l === b.l && b.r === a.r + 1 && a.s === a.n - 1 && b.s === 0) return { ...e, drop: true };
    const x1 = b.l < a.l ? a.l : a.l + 1, x2 = b.l > a.l ? b.l : b.l + 1;
    if (x1 === x2) return { ...e, x1, x2, t1: fit(vseg[x1], y(a), y(b)) };
    const g = a.r + 0.9;
    return { ...e, x1, x2, hop: a.r, t1: fit(vseg[x1], y(a), g), th: fit(hseg[a.r], Math.min(x1, x2), Math.max(x1, x2)), t2: fit(vseg[x2], g, y(b)) };
  });
  const count = list => (list.length ? Math.max(...list.map(o => o.t)) + 1 : 0);
  return { rows, lanes, cells, at, routes, tracksV: vseg.map(count), tracksH: hseg.map(count), segs: { vseg, hseg } };
}

// Spider-web layout: courses sit on one ring with terms running clockwise from 12 o'clock; graduation is the hub.
// Each prereq link drops from its course toward the hub, runs clockwise on its own concentric lane, then climbs back
// out to the course it unlocks, so lines never pass under a course. Shorter links take the outer lanes.
export function web(cols, edges, { slot = 34, hub = 86 } = {}) {
  const angle = {}, terms = [];
  let s = 0;
  for (const c of cols) {
    const w = c.kind === 'transfer' ? 0.7 : 1, start = s;
    for (const it of c.items) { angle[it.key] = s + w / 2; s += w; }
    terms.push({ label: c.label, kind: c.kind, start, end: s });
    s += 1;
  }
  const total = Math.max(s, 1), toA = x => -Math.PI / 2 + (x / total) * 2 * Math.PI;
  for (const k in angle) angle[k] = toA(angle[k]);
  for (const t of terms) Object.assign(t, { a0: toA(t.start), a1: toA(t.end), spoke: toA(t.start - 0.5) });
  const R = Math.max(230, (total * slot) / (2 * Math.PI)), outer = R - 32, rows = [], lane = [];
  edges.map((e, i) => ({ i, a: angle[e.from], b: angle[e.to] })).filter(x => x.a != null && x.b != null)
    .sort((x, y) => x.b - x.a - (y.b - y.a))
    .forEach(x => {
      let k = 0;
      while ((rows[k] ||= []).some(([a, b]) => x.a < b + 0.03 && a < x.b + 0.03)) k++;
      rows[k].push([x.a, x.b]);
      lane[x.i] = k;
    });
  const step = Math.min(8, (outer - hub - 12) / Math.max(1, rows.length));
  return { R, hub, angle, terms, lane: edges.map((_, i) => (lane[i] == null ? null : outer - lane[i] * step)) };
}
