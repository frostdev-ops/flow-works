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

// Place shared courses between their chains. Invisible slots keep room for long straight links.
export function degreeTree(a, width = 4, gap = 36) {
  return degreeDrawing(a, width, gap);
}

function degreeDrawing(a, width, gap, seed = 0, search = true) {
  width = Math.max(2, Math.min(16, Math.round(width) || 4));
  let state = seed;
  const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const up = {}, neighbors = {};
  for (const e of a.edges) {
    (up[e.to] ||= []).push(e.from);
    (neighbors[e.from] ||= []).push(e.to); (neighbors[e.to] ||= []).push(e.from);
  }
  const unseen = new Set(Object.keys(a.byKey)), parts = [];
  while (unseen.size) {
    const keys = [unseen.values().next().value]; unseen.delete(keys[0]);
    for (let i = 0; i < keys.length; i++) for (const key of neighbors[keys[i]] || [])
      if (unseen.delete(key)) keys.push(key);
    const members = new Set(keys), edges = a.edges.filter(e => members.has(e.from));
    const todo = new Set(keys), placed = new Map();
    for (let level = 0; todo.size; level++) {
      const latest = k => Math.max(-1, ...(up[k] || []).map(p => placed.get(p).level));
      const priority = new Map([...todo].map(k => [k, seed ? random() : 0]));
      const batch = seed ? 1 + Math.floor(random() * Math.min(width, 3)) : width;
      const ready = [...todo].filter(k => (up[k] || []).every(p => placed.has(p)))
        .sort((p, q) => seed ? priority.get(p) - priority.get(q) : latest(q) - latest(p)).slice(0, batch);
      if (!ready.length) throw new Error('Prerequisite links contain a cycle.');
      ready.forEach((key, x) => { placed.set(key, { key, kind: 'course', it: a.byKey[key], level, x, span: 1 }); todo.delete(key); });
    }
    const references = new Map();
    const fanOut = new Map(), fanIn = new Map();
    for (const edge of edges) {
      const out = (fanOut.get(edge.from) || 0) + 1, into = (fanIn.get(edge.to) || 0) + 1;
      fanOut.set(edge.from, out); fanIn.set(edge.to, into);
      if ((neighbors[edge.from]?.length || 0) - (up[edge.from]?.length || 0) > width * 2 && out > width) references.set(edge, 'from');
      else if ((up[edge.to]?.length || 0) > width * 2 && into > width) references.set(edge, 'to');
    }
    const attempted = new Set();
    let drawing, trial, moves = 0;
    for (;;) {
      const nodes = [...placed.values()], links = [], steps = [];
      edges.forEach((edge, id) => {
        let from = placed.get(edge.from), to = placed.get(edge.to);
        if (references.get(edge) === 'from') from = { key: `ref:${id}`, kind: 'reference', it: a.byKey[edge.from], level: to.level - 1, span: .75 };
        if (references.get(edge) === 'to') to = { key: `ref:${id}`, kind: 'reference', it: a.byKey[edge.to], level: from.level + 1, span: .75 };
        if (from.kind === 'reference') nodes.push(from);
        if (to.kind === 'reference') nodes.push(to);
        const guides = [];
        for (let level = from.level + 1; level < to.level; level++) {
          const n = { key: `guide:${id}:${level}`, kind: 'route', level, span: .12,
            x: from.x + (to.x - from.x) * (level - from.level) / (to.level - from.level) };
          nodes.push(n); guides.push(n);
        }
        const chain = [from, ...guides, to];
        for (let i = 1; i < chain.length; i++) steps.push({ from: chain[i - 1], to: chain[i], edge });
        links.push([from, to, edge, guides]);
      });
      const rows = Array.from({ length: Math.max(...nodes.map(n => n.level)) + 1 }, (_, level) => nodes.filter(n => n.level === level).sort((p, q) => (p.x || 0) - (q.x || 0)));
      const stepsByRow = rows.map(() => []);
      const incoming = new Map(nodes.map(n => [n, []])), outgoing = new Map(nodes.map(n => [n, []]));
      for (const step of steps) { incoming.get(step.to).push(step.from); outgoing.get(step.from).push(step.to); stepsByRow[step.from.level].push(step); }
      const positions = () => new Map(rows.flatMap(row => row.map((n, i) => [n, i])));
      const conflicts = () => {
        const at = positions(), result = [];
        for (const links of stepsByRow) {
          for (let i = 0; i < links.length; i++) for (const q of links.slice(i + 1)) {
            const p = links[i];
            if ((at.get(p.from) - at.get(q.from)) * (at.get(p.to) - at.get(q.to)) < 0) result.push([p.edge, q.edge]);
          }
        }
        return result;
      };
      // A forest has a crossing-free depth-first order, even when branches occupy different rows.
      if (nodes.every(n => incoming.get(n).length <= 1)) {
        const order = new Map();
        const visit = n => { order.set(n, order.size); outgoing.get(n).forEach(visit); };
        nodes.filter(n => !incoming.get(n).length).forEach(visit);
        rows.forEach(row => row.sort((p, q) => order.get(p) - order.get(q)));
      }
      let clashes = conflicts(), best = rows.map(row => [...row]), bestCount = clashes.length;
      for (let pass = 0; bestCount && pass < 12; pass++) {
        for (const down of [true, false]) {
          const order = down ? rows.slice(1) : rows.slice(0, -1).reverse();
          for (const row of order) {
            const at = positions(), before = new Map(row.map((n, i) => [n, i]));
            const connected = down ? incoming : outgoing;
            const middle = n => connected.get(n).length ? connected.get(n).reduce((sum, p) => sum + at.get(p), 0) / connected.get(n).length : before.get(n);
            row.sort((p, q) => middle(p) - middle(q) || before.get(p) - before.get(q));
          }
          for (let sweep = 0; sweep < 4; sweep++) {
            let changed = false;
            const at = positions();
            for (const row of rows) for (let i = 0; i < row.length - 1; i++) {
              const left = row[i], right = row[i + 1];
              let delta = 0;
              for (const connections of [incoming, outgoing]) for (const p of connections.get(left)) for (const q of connections.get(right))
                delta += Math.sign(at.get(q) - at.get(p));
              if (delta < 0) { [row[i], row[i + 1]] = [right, left]; at.set(right, i); at.set(left, i + 1); changed = true; }
            }
            if (!changed) break;
          }
          for (const row of rows.filter(r => r.length > 1 && r.length <= 10)) {
            const at = positions(), weights = row.map(p => row.map(q => {
              let count = 0;
              for (const links of [incoming, outgoing]) for (const a of links.get(p)) for (const b of links.get(q)) if (at.get(a) > at.get(b)) count++;
              return count;
            }));
            const size = 1 << row.length, cost = new Float64Array(size).fill(Infinity), choice = new Uint8Array(size); cost[0] = 0;
            for (let mask = 0; mask < size; mask++) for (let i = 0; i < row.length; i++) if (!(mask & (1 << i))) {
              let next = cost[mask];
              for (let j = 0; j < row.length; j++) if (mask & (1 << j)) next += weights[j][i];
              const target = mask | (1 << i);
              if (next < cost[target]) { cost[target] = next; choice[target] = i; }
            }
            const order = [];
            for (let mask = size - 1; mask;) { const i = choice[mask]; order.unshift(row[i]); mask ^= 1 << i; }
            row.splice(0, row.length, ...order);
          }
          clashes = conflicts();
          if (clashes.length < bestCount) { bestCount = clashes.length; best = rows.map(row => [...row]); }
          if (!bestCount) break;
        }
      }
      rows.forEach((row, i) => row.splice(0, row.length, ...best[i]));
      clashes = conflicts();
      const span = Math.max(...rows.map(row => row.reduce((sum, n) => sum + n.span, 0)));
      for (const row of rows) {
        let cursor = (span - row.reduce((sum, n) => sum + n.span, 0)) / 2;
        for (const n of row) { n.x = cursor + (n.span - 1) / 2; cursor += n.span; }
      }
      if (!clashes.length) {
        // Project each row onto its existing order while pulling guide slots onto the actual straight links.
        for (let pass = 0; pass < 60; pass++) {
          const desired = new Map(nodes.map(n => [n, n.x]));
          for (const [from, to, , guides] of links) for (const n of guides)
            desired.set(n, from.x + (to.x - from.x) * (n.level - from.level) / (to.level - from.level));
          for (const n of nodes.filter(n => n.kind !== 'route')) {
            const connected = [...incoming.get(n), ...outgoing.get(n)];
            if (connected.length) desired.set(n, .5 * n.x + .5 * connected.reduce((sum, p) => sum + p.x, 0) / connected.length);
          }
          for (const row of rows) {
            const blocks = []; let offset = 0, previous;
            for (const n of row) {
              if (previous) offset += (previous.span + n.span) / 2;
              const weight = n.kind === 'route' ? 8 : 1;
              const block = { nodes: [[n, offset]], weight, value: (desired.get(n) - offset) * weight };
              blocks.push(block); previous = n;
              while (blocks.length > 1 && blocks.at(-2).value / blocks.at(-2).weight > blocks.at(-1).value / blocks.at(-1).weight) {
                const right = blocks.pop(), left = blocks.at(-1);
                left.nodes.push(...right.nodes); left.weight += right.weight; left.value += right.value;
              }
            }
            for (const block of blocks) for (const [n, offset] of block.nodes) n.x = block.value / block.weight + offset;
          }
        }
        clashes = straightConflicts({ nodes, links }, gap);
      }
      if (clashes.length) {
        if (trial) {
          if (clashes.length >= trial.before) {
            for (const [n, level] of trial.levels) n.level = level;
            trial = null; continue;
          }
          trial = null;
        }
        if (edges.length <= 50 && moves < 16) {
          const state = [...placed.values()].map(n => n.level).join(',');
          const keys = [...new Set([...clashes.flat().flatMap(e => [e.to, e.from]), ...placed.keys()])];
          let proposal;
          for (const key of keys) for (const delta of [1, -1]) {
            const signature = state + ':' + key + ':' + delta;
            if (proposal || attempted.has(signature)) continue;
            attempted.add(signature);
            const levels = new Map(), occupied = [];
            for (const n of placed.values()) {
              let level = Math.max(n.level + (n.key === key ? delta : 0), 0, ...((up[n.key] || []).map(p => levels.get(placed.get(p)) + 1)));
              while ((occupied[level] || 0) >= width) level++;
              levels.set(n, level); occupied[level] = (occupied[level] || 0) + 1;
            }
            if ([...levels].some(([n, level]) => n.level !== level)) proposal = levels;
          }
          if (proposal) {
            trial = { before: clashes.length, levels: new Map([...placed.values()].map(n => [n, n.level])) };
            for (const [n, level] of proposal) n.level = level;
            moves++; continue;
          }
        }
        const counts = new Map();
        for (const pair of clashes) for (const e of pair) if (!references.has(e)) counts.set(e, (counts.get(e) || 0) + 1);
        const worst = [...counts].sort((p, q) => q[1] - p[1])[0]?.[0];
        if (!worst) {
          // Wide reference fans need more vertical room so the diagonals clear neighboring labels.
          const reach = Math.max(0, ...links.map(([p, c]) => Math.abs(c.x - p.x) * (164 + gap)));
          const factor = Math.max(2, Math.ceil((66 / 2 + 4) * reach / (164 / 2 + gap) / (66 + gap + 26)));
          nodes.forEach(n => n.level *= factor);
          if (straightConflicts({ nodes, links }, gap).length) throw new Error('Could not separate prerequisite branches.');
          const left = Math.min(...nodes.map(n => n.x + (1 - n.span) / 2));
          nodes.forEach(n => n.x -= left);
          drawing = { nodes, links, span: Math.ceil(Math.max(...nodes.map(n => n.x + (1 + n.span) / 2))), height: Math.max(...nodes.map(n => n.level)) + 1 }; break;
        }
        references.set(worst, (neighbors[worst.from]?.length || 0) > (neighbors[worst.to]?.length || 0) ? 'from' : 'to'); continue;
      }
      const left = Math.min(...nodes.map(n => n.x + (1 - n.span) / 2));
      nodes.forEach(n => n.x -= left);
      drawing = { nodes, links, span: Math.ceil(Math.max(...nodes.map(n => n.x + (1 + n.span) / 2))), height: rows.length }; break;
    }
    if (search && references.size && keys.length <= 70 && edges.length <= 50) {
      const graph = { byKey: Object.fromEntries(keys.map(k => [k, a.byKey[k]])), edges };
      for (let attempt = 0; attempt <= 8; attempt++) {
        const candidate = attempt ? degreeDrawing(graph, width, gap, attempt, false) : drawing;
        const unique = candidate.nodes.some(n => n.kind === 'reference') ? untangle(candidate, edges, width, gap, attempt + 1) : candidate;
        if (!unique) continue;
        const left = Math.min(...unique.nodes.map(n => n.x + (1 - n.span) / 2)), top = Math.min(...unique.nodes.map(n => n.level));
        unique.nodes.forEach(n => { n.x -= left; n.level -= top; });
        drawing = { ...unique, span: Math.ceil(Math.max(...unique.nodes.map(n => n.x + (1 + n.span) / 2))), height: Math.ceil(Math.max(...unique.nodes.map(n => n.level))) + 1 };
        break;
      }
    }
    parts.push(drawing);
  }
  const capacity = Math.max(width, ...parts.map(p => p.span)), bottom = Array(capacity).fill(0), rowCounts = [], nodes = [], links = [];
  for (const part of parts.sort((p, q) => q.nodes.filter(n => n.kind === 'course').length - p.nodes.filter(n => n.kind === 'course').length)) {
    let left = 0, top = Infinity;
    const counts = Array.from({ length: part.height }, (_, level) => part.nodes.filter(n => n.kind === 'course' && n.level === level).length);
    for (let x = 0; x <= capacity - part.span; x++) {
      let y = Math.max(...bottom.slice(x, x + part.span));
      while (counts.some((count, level) => (rowCounts[y + level] || 0) + count > width)) y++;
      if (y < top) { left = x; top = y; }
    }
    for (const n of part.nodes) { n.x += left; n.level += top; nodes.push(n); }
    counts.forEach((count, level) => { rowCounts[top + level] = (rowCounts[top + level] || 0) + count; });
    links.push(...part.links); bottom.fill(top + part.height, left, left + part.span);
  }
  const visible = nodes.filter(n => n.kind !== 'route'), origin = new Map(visible.map(n => [n, n.level]));
  // Small degrees can stagger cards within their bands to shorten links without changing the chain order.
  if (visible.length <= 70) for (let pass = 0; pass < 4; pass++) for (const n of visible) {
    if (n.kind !== 'course') continue;
    const connected = links.filter(([p, c]) => p === n || c === n);
    if (!connected.length) continue;
    const length = () => connected.reduce((sum, [p, c]) => sum + Math.hypot((p.x - c.x) * (164 + gap), (p.level - c.level) * (92 + gap)), 0);
    let best = length(), x = n.x, level = n.level;
    for (const [dx, dy] of [[-.125, 0], [.125, 0], [0, -.1], [0, .1]]) {
      n.x = x + dx; n.level = level + dy;
      if (n.x >= 0 && n.level >= 0 && Math.abs(n.level - origin.get(n)) <= .201 && connected.every(([p, c]) => p.level < c.level)
        && length() < best - .01 && !crowdedRows(visible, width, gap).length && !straightConflicts({ nodes: visible, links }, gap).length) { best = length(); x = n.x; level = n.level; }
    }
    n.x = x; n.level = level;
  }
  return { nodes, links };
}

function crowdedRows(nodes, width, gap) {
  const cards = nodes.filter(n => n.kind === 'course'), band = 66 / (92 + gap);
  return cards.map(n => cards.filter(p => p.level <= n.level + 1e-8 && p.level + band > n.level + 1e-8)).filter(row => row.length > width);
}

// Search whole branches as well as single cards; a local rank change cannot untangle every shared join.
function untangle(drawing, edges, width, gap, seed) {
  const nodes = drawing.nodes.filter(n => n.kind === 'course').map(n => ({ ...n })), byKey = new Map(nodes.map(n => [n.key, n]));
  const links = edges.map(e => [byKey.get(e.from), byKey.get(e.to), e]), T = { nodes, links };
  const groups = new Map(nodes.map(n => {
    const descendants = new Set([n]);
    for (const p of descendants) for (const [from, to] of links) if (from === p) descendants.add(to);
    return [n, [...descendants]];
  }));
  const bounds = { left: Math.min(...nodes.map(n => n.x)) - 4, right: Math.max(...nodes.map(n => n.x)) + 4,
    top: Math.min(...nodes.map(n => n.level)) - 2, bottom: Math.max(...nodes.map(n => n.level)) + 4 };
  let state = seed;
  const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const coords = () => nodes.map(n => [n.x, n.level]), restore = points => nodes.forEach((n, i) => { [n.x, n.level] = points[i]; });
  const forward = () => links.every(([p, c]) => p.level < c.level);
  const score = () => {
    const clashes = straightConflicts(T, gap);
    for (const row of crowdedRows(nodes, width, gap)) clashes.push(links.filter(([p, c]) => row.includes(p) || row.includes(c)).map(link => link[2]));
    const length = links.reduce((sum, [p, c]) => sum + Math.hypot((p.x - c.x) * (164 + gap), (p.level - c.level) * (92 + gap)) / (164 + gap), 0);
    const extent = Math.max(...nodes.map(n => n.x)) - Math.min(...nodes.map(n => n.x)) + Math.max(...nodes.map(n => n.level)) - Math.min(...nodes.map(n => n.level));
    return { clashes, cost: clashes.length * 100 + length * .2 + extent * 2 };
  };
  let current = score(), best = current.cost, saved = coords();
  // shortcut: bounded search keeps imports responsive; use a planar embedding engine if larger connected graphs need it.
  for (let i = 0; current.clashes.length && i < 1600; i++) {
    const clash = current.clashes[Math.floor(random() * current.clashes.length)], pool = clash.flatMap(e => [byKey.get(e.from), byKey.get(e.to)]);
    const n = random() < .25 || !pool.length ? nodes[Math.floor(random() * nodes.length)] : pool[Math.floor(random() * pool.length)];
    const before = coords(), step = [.25, .5, 1, 2][Math.floor(random() * 4)] * (random() < .5 ? -1 : 1), action = random();
    if (action < .5) n.x += step;
    else for (const p of action < .8 ? [n] : groups.get(n)) p.level += step;
    if (!forward() || nodes.some(n => n.x < bounds.left || n.x > bounds.right || n.level < bounds.top || n.level > bounds.bottom)) { restore(before); continue; }
    const candidate = score(), temperature = 30 * (1 - i % 800 / 800) + 1;
    if (candidate.cost < current.cost || random() < Math.exp((current.cost - candidate.cost) / temperature)) {
      current = candidate;
      if (current.cost < best) { best = current.cost; saved = coords(); }
    } else restore(before);
    if (i % 800 === 799) { restore(saved); current = score(); }
  }
  if (current.clashes.length) return null;
  for (let pass = 0; pass < 12; pass++) for (const n of nodes) for (const step of [1, .5, .25, .125])
    for (const [dx, dy] of [[-step, 0], [step, 0], [0, -step], [0, step]]) for (const branch of [false, true]) {
      if (branch && dx) continue;
      const before = coords(), old = current.cost;
      for (const p of branch ? groups.get(n) : [n]) { p.x += dx; p.level += dy; }
      const candidate = score();
      if (forward() && !candidate.clashes.length && candidate.cost < old - .001) current = candidate;
      else restore(before);
    }
  return T;
}

// One straight segment per relationship, clipped to the facing card edges.
export function treeRoutes(T, { cw, ch, gx, gy, pad, py, minX, minL }) {
  const box = n => {
    const w = n.kind === 'reference' ? n.span * (cw + gx) - gx : cw, h = n.kind === 'reference' ? 30 : ch;
    return { x: (n.x - minX) * (cw + gx) + pad + (cw - w) / 2, y: (n.level - minL) * (ch + gy) + py + (ch - h) / 2, w, h };
  };
  return T.links.map(([from, to]) => {
    const a = box(from), b = box(to), dx = b.x + b.w / 2 - a.x - a.w / 2, dy = b.y + b.h / 2 - a.y - a.h / 2;
    const port = (node, rect, direction) => {
      const horizontal = dx ? rect.w / Math.abs(dx) : Infinity, vertical = dy ? rect.h / Math.abs(dy) : Infinity;
      const scale = Math.min(horizontal, vertical) / 2;
      return { node, side: horizontal < vertical && dx ? (dx * direction > 0 ? 'right' : 'left') : (dy * direction > 0 ? 'bottom' : 'top'),
        point: [rect.x + rect.w / 2 + dx * scale * direction, rect.y + rect.h / 2 + dy * scale * direction] };
    };
    const source = port(from, a, 1), target = port(to, b, -1);
    return { source, target, segments: [{ from: source.point, to: target.point }], d: `M${source.point.join(',')} L${target.point.join(',')}` };
  });
}

function straightConflicts(T, gap) {
  const cw = 164, ch = 66, gx = gap, gy = gap + 26;
  const routes = treeRoutes(T, { cw, ch, gx, gy, pad: 0, py: 0, minX: 0, minL: 0 });
  const cross = (a, b) => a[0] * b[1] - a[1] * b[0], minus = (a, b) => a.map((v, i) => v - b[i]);
  const intersects = (a, b, c, d) => {
    const r = minus(b, a), s = minus(d, c), q = minus(c, a), den = cross(r, s);
    if (Math.abs(den) < 1e-8) {
      if (Math.abs(cross(q, r)) > 1e-8) return false;
      const axis = Math.abs(r[0]) > Math.abs(r[1]) ? 0 : 1;
      return Math.min(Math.max(a[axis], b[axis]), Math.max(c[axis], d[axis])) - Math.max(Math.min(a[axis], b[axis]), Math.min(c[axis], d[axis])) > 1e-6;
    }
    const t = cross(q, s) / den, u = cross(q, r) / den;
    return t >= -1e-8 && t <= 1 + 1e-8 && u >= -1e-8 && u <= 1 + 1e-8;
  };
  const boxes = T.nodes.filter(n => n.kind !== 'route').map(n => {
    const w = n.kind === 'reference' ? n.span * (cw + gx) - gx : cw, h = n.kind === 'reference' ? 30 : ch;
    return { n, x: n.x * (cw + gx) + (cw - w) / 2, y: n.level * (ch + gy) + (ch - h) / 2, w, h };
  });
  const result = [];
  for (let i = 0; i < boxes.length; i++) for (const b of boxes.slice(i + 1)) {
    const a = boxes[i];
    if (a.x < b.x + b.w + gap - 1e-6 && a.x + a.w + gap > b.x + 1e-6 && a.y < b.y + b.h + gap - 1e-6 && a.y + a.h + gap > b.y + 1e-6)
      result.push(T.links.filter(([p, c]) => p === a.n || c === a.n || p === b.n || c === b.n).map(link => link[2]));
  }
  routes.forEach((route, i) => {
    const { from, to } = route.segments[0];
    for (let j = 0; j < i; j++) if (intersects(from, to, routes[j].source.point, routes[j].target.point)) result.push([T.links[i][2], T.links[j][2]]);
    for (const b of boxes) if (b.n !== route.source.node && b.n !== route.target.node) {
      const corners = [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]];
      if (corners.some((p, k) => intersects(from, to, p, corners[(k + 1) % 4]))) { result.push([T.links[i][2]]); break; }
    }
  });
  return result;
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
