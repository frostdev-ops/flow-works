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
  for (const b of blocks) if (b !== degree) walk(b.ruleArray, (r, up) => {
    const opts = r.advice?.courseArray;
    if (r.ruleType !== 'Course' || !opts?.length) return;
    const classes = +r.advice.classes || 0, credits = +r.advice.credits || 0;
    const base = { group: groupOf[bkey(b)], block: b.title, status: 'planned' };
    if (!credits && opts.length <= Math.max(classes, 1) && !opts.some(wild)) {
      for (const c of opts) {
        const code = c.discipline + ' ' + c.number;
        if (have.has(code)) continue;
        have.add(code);
        remaining.push({ ...base, key: 'p' + code, code, title: opts.length === 1 && r.label ? r.label : titleCase(c.title) || code,
          credits: +c.credits || 3, prereqs: pre(code), level: level(c.number) });
      }
      return;
    }
    const n = classes || Math.max(1, Math.round(credits / 3));
    const known = opts.filter(c => +c.credits);
    const each = credits ? Math.round(credits / n * 10) / 10 : known.length ? Math.round(sum(known, c => +c.credits) / known.length) : 3;
    const lv = Math.min(...opts.map(c => c.number === '@' ? 1 : level(c.number)));
    const title = !r.label || /^(select|choose)\b/i.test(r.label) ? (up?.label && titleCase(up.label)) || b.title : r.label;
    for (let i = 0; i < n; i++)
      remaining.push({ ...base, key: `r${bkey(b)}:${r.ruleId}:${i}`, title, credits: each, options: opts.map(describe), prereqs: [], level: lv });
  });

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
  for (const it of model.remaining) for (const g of it.prereqs) for (const c of g) (kids[c] ||= []).push(it);
  const d = it => {
    if (!depth.has(it)) { depth.set(it, 0); depth.set(it, 1 + Math.max(0, ...(kids[it.code] || []).map(d))); }
    return depth.get(it);
  };
  const todo = [...model.remaining].sort((a, b) => d(b) - d(a) || a.level - b.level || !!a.options - !!b.options || (a.code || '').localeCompare(b.code || ''));
  const pending = new Set(todo.map(x => x.code).filter(Boolean));
  const terms = [];
  for (let label = model.lastTerm; todo.length && terms.length < 20;) {
    label = nextTerm(label);
    const term = { label, items: [], credits: 0 };
    for (const it of [...todo]) {
      const ready = it.prereqs.every(g => g.some(c => done.has(c)) || !g.some(c => pending.has(c)));
      if (!ready || term.credits + it.credits > maxCredits) continue;
      term.items.push(it); term.credits += it.credits; todo.splice(todo.indexOf(it), 1);
    }
    if (!term.items.length) { const it = todo.shift(); term.items.push(it); term.credits += it.credits; } // prereq cycle or oversized course
    for (const it of term.items) if (it.code) { done.add(it.code); pending.delete(it.code); }
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
  for (const { it, ci } of placed) { byKey[it.key] = it; if (it.code) (at[it.code] ||= []).push({ key: it.key, ci }); }
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

// Layered layout for the prerequisite view: column = longest prereq chain above a course,
// rows ordered by a few barycenter sweeps to cut line crossings. Courses with no links are left out.
// ponytail: long edges aren't routed around cards (no dummy nodes); add them if crossings get unreadable.
export function layers(a) {
  const up = {}, down = {}, lv = {}, pos = {}, cols = [];
  for (const e of a.edges) { (up[e.to] ||= []).push(e.from); (down[e.from] ||= []).push(e.to); }
  const L = k => (lv[k] ??= up[k] ? 1 + Math.max(...up[k].map(L)) : 0);
  for (const k of Object.keys(a.byKey)) if (up[k] || down[k]) (cols[L(k)] ||= []).push(k);
  const place = c => c.forEach((k, i) => (pos[k] = i));
  const bary = (k, nb) => (nb[k] ? nb[k].reduce((s, n) => s + pos[n], 0) / nb[k].length : pos[k]);
  cols.forEach(place);
  for (let pass = 0; pass < 6; pass++) {
    const nb = pass % 2 ? down : up;
    for (const c of pass % 2 ? [...cols].reverse() : cols) { c.sort((x, y) => bary(x, nb) - bary(y, nb)); place(c); }
  }
  return cols.map(c => c.map(k => a.byKey[k]));
}
