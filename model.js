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
  const sketch = {
    'MATH 1170': [['MATH 1060']], 'ECON 2020': [['MATH 1060']],
    'ACCT 2110': [['MATH 1170']], 'ECON 2100': [['MATH 1170']],
    'FIN 3200': [['ECON 2020'], ['ACCT 2110']],
    'ACCT 2120': [['ACCT 2110']], 'ECON 2110': [['ECON 2100']],
  };
  // This correction belongs to the supplied Foundations of Math course map, not other schools' MATH 1060.
  let foundations = (audit.classInformation?.classArray || []).some(c =>
    c.discipline === 'MATH' && c.number === '1060' && /foundations? (of )?math/i.test(c.courseTitle || ''));
  for (const b of blocks) walk(b.ruleArray, r => {
    if (r.advice?.courseArray?.some(c => c.discipline === 'MATH' && c.number === '1060' && /foundations? (of )?math/i.test(c.title || r.label || ''))) foundations = true;
  });
  const pre = code => {
    const groups = prereqGroups(prereqRows[code]);
    return groups.length ? groups : foundations && sketch[code] ? sketch[code].map(g => [...g]) : [];
  };

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
    prereqs: Object.fromEntries([...new Set([...Object.keys(prereqRows), ...(foundations ? Object.keys(sketch) : [])])].map(k => [k, pre(k)])),
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
  const info = Object.fromEntries(placed.map(({ it }) => [it.key, { unlocks: r(it.key).size, depth: d(it.key) }]));
  const necks = open.filter(it => info[it.key].unlocks).map(it => ({ key: it.key, ...info[it.key] }))
    .sort((a, b) => b.unlocks - a.unlocks || b.depth - a.depth);
  const critical = [], deepest = keys => keys.reduce((a, k) => (!a || d(k) > d(a) ? k : a), null);
  for (let k = deepest(open.map(it => it.key)); k; k = deepest(down[k] || [])) critical.push(k);
  return { edges, needs, missing, info, necks, critical: critical.length > 1 ? critical : [], byKey };
}

// Higher dependency counts get darker cards; text keeps at least 4.5:1 contrast.
export function priorityColors(count, most) {
  const t = most > 0 ? Math.max(0, Math.min(1, count / most)) : 0;
  const stops = [[219, 238, 205], [229, 185, 88], [150, 66, 14]];
  const i = t < .5 ? 0 : 1, f = t < .5 ? t * 2 : (t - .5) * 2;
  const rgb = stops[i].map((v, c) => Math.round(v + (stops[i + 1][c] - v) * f));
  const linear = rgb.map(v => v / 255 <= .04045 ? v / 255 / 12.92 : ((v / 255 + .055) / 1.055) ** 2.4);
  const luminance = linear.reduce((n, v, c) => n + v * [.2126, .7152, .0722][c], 0);
  return { fill: `rgb(${rgb.join(' ')})`, ink: luminance > .179 ? '#000' : '#fff' };
}

// Continue ready branches in nearby columns; capacity can stagger courses with the same prerequisite depth.
export function degreeTree(a, width = 4) {
  width = Math.max(2, Math.min(16, Math.round(width) || 4));
  const up = {}, neighbors = {};
  for (const e of a.edges) {
    (up[e.to] ||= []).push(e.from);
    (neighbors[e.from] ||= []).push(e.to); (neighbors[e.to] ||= []).push(e.from);
  }
  const unseen = new Set(Object.keys(a.byKey)), parts = [];
  while (unseen.size) {
    const part = [unseen.values().next().value]; unseen.delete(part[0]);
    for (let i = 0; i < part.length; i++) for (const key of neighbors[part[i]] || [])
      if (unseen.delete(key)) part.push(key);
    parts.push(part);
  }
  const nodes = [], byKey = {}, bottom = Array(width).fill(0);
  for (const keys of parts.sort((p, q) => q.length - p.length)) {
    const todo = new Set(keys), part = [];
    for (let level = 0; todo.size; level++) {
      const latestParent = k => Math.max(-1, ...(up[k] || []).map(p => byKey[p].level));
      const ready = [...todo].filter(k => (up[k] || []).every(p => byKey[p]))
        .sort((p, q) => latestParent(q) - latestParent(p)).slice(0, width);
      if (!ready.length) throw new Error('Prerequisite links contain a cycle.');
      const free = Array.from({ length: width }, (_, i) => i);
      for (const key of ready) {
        const parents = (up[key] || []).map(k => byKey[k]);
        const target = parents.length ? parents.reduce((sum, n) => sum + n.x, 0) / parents.length : free[0];
        const x = free.reduce((best, col) => Math.abs(col - target) < Math.abs(best - target)
          || (parents.length === 1 && Math.abs(col - target) === Math.abs(best - target) && col > best) ? col : best);
        free.splice(free.indexOf(x), 1);
        const n = { key, kind: 'course', it: a.byKey[key], level, x };
        part.push(n); byKey[key] = n; todo.delete(key);
      }
    }
    const roots = part.filter(n => n.level === 0).map(n => {
      const children = part.filter(c => up[c.key]?.includes(n.key));
      return { n, target: children.length ? (Math.min(...children.map(c => c.x)) + Math.max(...children.map(c => c.x))) / 2 : n.x };
    }).sort((p, q) => p.target - q.target);
    let previous = -1;
    roots.forEach(({ n, target }, i) => { n.x = previous = Math.max(previous + 1, Math.min(target, width - roots.length + i)); });
    // Pack independent chains as blocks instead of stretching them to match unrelated branches.
    const span = Math.max(...part.map(n => n.x)) + 1, height = Math.max(...part.map(n => n.level)) + 1;
    let left = 0, top = Infinity;
    for (let x = 0; x <= width - span; x++) {
      const y = Math.max(...bottom.slice(x, x + span));
      if (y < top) { left = x; top = y; }
    }
    for (const n of part) { n.x += left; n.level += top; nodes.push(n); }
    bottom.fill(top + height, left, left + span);
  }
  return { nodes, links: a.edges.map(e => [byKey[e.from], byKey[e.to], e]) };
}

export function routePadding(T, gap) {
  const events = T.links.filter(([p, c]) => c.level - p.level > 1)
    .flatMap(([p, c]) => [[p.level + .5, 1], [c.level - .5, -1]])
    .sort((p, q) => p[0] - q[0] || q[1] - p[1]);
  let active = 0, peak = 0;
  for (const [, delta] of events) peak = Math.max(peak, active += delta);
  return Math.max(gap / 2 + 4, 12 + Math.ceil(peak / 2) * 6);
}

// Distinct perimeter ports and interval-reserved lanes prevent connections from sharing a stem.
export function treeRoutes(T, { cw, ch, gx, gy, pad, py, minX, minL, width }) {
  const boxes = new Map(T.nodes.map(n => [n, { x: (n.x - minX) * (cw + gx) + pad, y: (n.level - minL) * (ch + gy) + py }]));
  const groups = new Map(T.nodes.map(n => [n, { top: [], bottom: [], left: [], right: [] }]));
  const sides = new Map(T.nodes.map(n => [n, new Set()]));
  const paths = T.links.map(([from, to], i) => {
    const dx = to.x - from.x;
    const pick = (node, role, side, fallback) => {
      const key = role + side;
      if (Math.abs(dx) < .8 || sides.get(node).has(key)) return fallback;
      sides.get(node).add(key); return side;
    };
    const source = { node: from, other: to, side: pick(from, 'out', dx < 0 ? 'left' : 'right', 'bottom'), i };
    const target = { node: to, other: from, side: pick(to, 'in', dx < 0 ? 'right' : 'left', 'top'), i };
    groups.get(from)[source.side].push(source); groups.get(to)[target.side].push(target);
    return { source, target, segments: [], long: to.level - from.level > 1 };
  });
  for (const [node, ports] of groups) for (const [side, ends] of Object.entries(ports)) {
    const horizontal = side === 'top' || side === 'bottom', box = boxes.get(node);
    ends.sort((a, b) => (horizontal ? a.other.x - b.other.x : a.other.level - b.other.level) || a.i - b.i);
    ends.forEach((end, i) => {
      const along = 12 + ((horizontal ? cw : ch) - 24) * (i + 1) / (ends.length + 1);
      end.point = horizontal ? [box.x + along, box.y + (side === 'bottom' ? ch : 0)]
        : [box.x + (side === 'right' ? cw : 0), box.y + along];
    });
  }
  const maxRight = Math.max(...[...boxes.values()].map(b => b.x + cw));
  const candidates = [];
  for (let x = pad - 6; x >= 4; x -= 6) candidates.push(x);
  for (let x = maxRight + 6; x <= width - 4; x += 6) candidates.push(x);
  const columns = Math.ceil(Math.max(...T.nodes.map(n => n.x)) - minX);
  for (let column = 0; column < columns; column++) {
    const middle = pad + cw + column * (cw + gx) + gx / 2;
    for (let offset = -Math.floor((gx / 2 - 5) / 6); offset <= Math.floor((gx / 2 - 5) / 6); offset++)
      candidates.push(middle + offset * 6);
  }
  const reserved = new Map(candidates.map(x => [x, []]));
  for (const path of paths.filter(p => p.long).sort((p, q) =>
    (q.target.node.level - q.source.node.level) - (p.target.node.level - p.source.node.level))) {
    const from = boxes.get(path.source.node), to = boxes.get(path.target.node);
    const low = from.y + ch + gy / 4, high = to.y - gy / 4;
    const ideal = (path.source.point[0] + path.target.point[0]) / 2;
    const free = candidates.filter(x => !reserved.get(x).some(([a, b]) => a <= high && b >= low)
      && ![...boxes.values()].some(b => b.y < high && b.y + ch > low && x > b.x - 4 && x < b.x + cw + 4));
    if (!free.length) throw new Error('Not enough room to keep prerequisite connections separate.');
    path.lane = free.reduce((best, x) => Math.abs(x - ideal) < Math.abs(best - ideal) ? x : best);
    reserved.get(path.lane).push([low, high]);
  }
  for (const path of paths) {
    const { source, target, segments } = path, a = source.point, b = target.point;
    const sourceBox = boxes.get(source.node), targetBox = boxes.get(target.node);
    const clear = Math.min(12, gx * .3);
    const sourceSide = source.side === 'left' ? -1 : source.side === 'right' ? 1 : 0;
    const targetSide = target.side === 'left' ? -1 : target.side === 'right' ? 1 : 0;
    const out = [a[0] + sourceSide * clear, sourceBox.y + ch + gy / 4];
    const into = [b[0] + targetSide * clear, targetBox.y - gy / 4];
    const curve = (from, c1, c2, to) => segments.push({ from, c1, c2, to });
    curve(a, sourceSide ? [out[0], a[1]] : [a[0], out[1]], [out[0], out[1] - gy / 8], out);
    if (path.long) {
      const start = [path.lane, sourceBox.y + ch + gy * .75], end = [path.lane, targetBox.y - gy * .75];
      curve(out, [out[0], out[1] + gy / 4], [start[0], start[1] - gy / 4], start);
      const dy = end[1] - start[1];
      curve(start, [start[0] + .7, start[1] + dy / 3], [end[0] - .7, end[1] - dy / 3], end);
      curve(end, [end[0], end[1] + gy / 4], [into[0], into[1] - gy / 4], into);
    } else {
      const dy = into[1] - out[1];
      curve(out, [out[0], out[1] + dy / 3], [into[0], into[1] - dy / 3], into);
    }
    curve(into, [into[0], into[1] + gy / 8], targetSide ? [into[0], b[1]] : [b[0], b[1] - gy / 8], b);
    path.d = `M${a.join(',')} ` + segments.map(s => `C${s.c1.join(',')} ${s.c2.join(',')} ${s.to.join(',')}`).join(' ');
  }
  return paths;
}

// A course's prerequisite tree (rows above) and what it unlocks (rows below), for the course modal. Shared courses
// repeat instead of merging, so every link joins adjacent rows and never crosses a card. OR groups become one box.
export function courseTree(root, a, known = {}, { up = 4, down = 3 } = {}) {
  const byCode = {}, kids = {};
  for (const it of Object.values(a.byKey)) if (it.code && (!byCode[it.code] || it.status === 'done')) byCode[it.code] = it;
  for (const e of a.edges) (kids[e.from] ||= []).push(e.to);
  const top = { kind: 'course', it: root, level: 0 };
  const grow = (node, it, code, lvl, seen) => {
    const groups = it?.prereqs?.length ? it.prereqs : (code && known[code]) || [];
    const before = it?.after && a.byKey[it.after];
    if (lvl > up) return void (node.more = groups.length + !!before);
    node.up = groups.map(g => {
      const opts = g.map(c => ({ code: c, it: byCode[c] }));
      const pick = opts.find(o => o.it && o.it.status !== 'planned') || opts.find(o => o.it) || (g.length === 1 ? opts[0] : null);
      const n = g.length === 1 ? { kind: 'course', it: opts[0].it, code: g[0], level: -lvl } : { kind: 'or', options: opts, pick: pick?.code, level: -lvl };
      if (pick && !seen.has(pick.code)) grow(n, pick.it, pick.code, lvl + 1, new Set([...seen, pick.code]));
      return n;
    });
    if (before) {
      const n = { kind: 'course', it: before, level: -lvl };
      grow(n, before, before.code, lvl + 1, seen);
      node.up.push(n);
    }
  };
  const sink = (node, key, lvl, seen) => {
    const next = (kids[key] || []).filter(t => !seen.has(t));
    if (lvl > down) return void (node.more = next.length);
    node.down = next.map(t => {
      const n = { kind: 'course', it: a.byKey[t], level: lvl };
      sink(n, t, lvl + 1, new Set([...seen, t]));
      return n;
    });
  };
  grow(top, root, root.code, 1, new Set([root.code || root.key]));
  if (root.key) sink(top, root.key, 1, new Set([root.key]));

  // Tidy layout: every subtree owns its own horizontal span, centred over (or under) its parent.
  const nodes = [top], links = [];
  const span = (n, dir) => (n[dir]?.length ? n[dir].reduce((s, c) => s + span(c, dir), 0) : 1);
  const place = (n, dir, x0) => {
    let x = x0;
    for (const c of n[dir] || []) {
      c.x = x + (span(c, dir) - 1) / 2;
      nodes.push(c);
      links.push(dir === 'up' ? [c, n] : [n, c]);
      place(c, dir, x);
      x += span(c, dir);
    }
  };
  top.x = 0;
  place(top, 'up', -(span(top, 'up') - 1) / 2);
  place(top, 'down', -(span(top, 'down') - 1) / 2);
  return { nodes, links };
}
