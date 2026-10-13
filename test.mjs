// node test.mjs — sanity check of the parser + planner against demo.json.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseAudit, columns, analyze, layers, route, web, roadmap, courseTree, prereqGroups, nextTerm, titleCase } from './model.js';

assert.deepEqual(prereqGroups([['', 'CS', '2300'], ['A', 'MATH', '1160'], ['O', 'MATH', '1350'], ['O', '', '']]), [['CS 2300'], ['MATH 1160', 'MATH 1350']]);
assert.equal(nextTerm('Fall 2026'), 'Spring 2027');
assert.equal(nextTerm('Spring 2027'), 'Fall 2027');
assert.equal(titleCase('OBJECT-ORIENTED PROG IN JAVA II'), 'Object-Oriented Prog in Java II');

const { audit, prereqs } = JSON.parse(readFileSync(new URL('./demo.json', import.meta.url)));
const m = parseAudit(audit, prereqs);
assert.equal(m.student, 'Alex');
assert.deepEqual(m.groups.map(g => g.title), ['General Education Core', 'World Language', 'Mathematics & Science', 'B.S. Computer Science', 'Free electives']);
// "1 group from (A) or (B)": a started option is planned concretely, the others are ignored...
assert.ok(m.remaining.some(x => x.code === 'BIO 1310') && !m.remaining.some(x => /^CHEM/.test(x.code)), 'started option wins');
// ...and with nothing started, choice slots stand in for the options instead of planning every language.
const lang = m.remaining.filter(x => x.group === 'OTHER:LANG');
assert.equal(lang.length, 2, 'two slots, not every language');
assert.ok(lang.every(x => !x.code && x.options.length === 4) && lang[1].after === lang[0].key, 'chained choice slots');
assert.equal(m.courses.find(c => c.code === 'PHIL 1100').group, 'OTHER:CORE', 'sub-block rolls up to its parent group');
assert.equal(m.courses.find(c => c.code === 'ART 1100').group, 'free');

for (const max of [12, 15, 18]) {
  const cols = columns(m, max);
  const planned = cols.filter(c => c.kind === 'future');
  assert.equal(planned.flatMap(c => c.items).length, m.remaining.length, 'every remaining requirement is scheduled once');
  assert.equal(m.applied + planned.reduce((n, c) => n + c.credits, 0), m.total, 'plan reaches the credit total');
  for (const c of planned) assert.ok(c.credits <= max, `${c.label} over ${max} credits`);
  const termOf = {};
  cols.forEach((c, i) => c.items.forEach(it => it.code && (termOf[it.code] = i)));
  const keyTerm = {};
  cols.forEach((c, i) => c.items.forEach(it => (keyTerm[it.key] = i)));
  for (const it of m.remaining) if (it.after) assert.ok(keyTerm[it.after] < keyTerm[it.key], 'chained slot after its predecessor');
  cols.forEach((c, i) => c.items.filter(it => it.status === 'planned').forEach(it =>
    it.prereqs.filter(g => g.some(code => code in termOf)).forEach(g =>
      assert.ok(g.some(code => termOf[code] < i), `${it.code} scheduled before ${g}`))));
}
const a = analyze(columns(m, 15));
const code = k => a.byKey[k].code;
assert.equal(code(a.necks[0].key), 'CS 3300', 'top bottleneck');
assert.equal(a.necks[0].unlocks, 3);
assert.deepEqual(a.critical.map(code).slice(1), ['CS 3500', 'CS 4900'], 'critical path ends at capstone');
assert.deepEqual(a.missing.map(x => [code(x.key), x.needs]), [['CS 3600', ['MATH 2400', 'MATH 2600']]]);
assert.ok(a.edges.every(e => a.byKey[e.from] && a.byKey[e.to]));
const lay = layers(a), level = {};
lay.forEach((c, i) => c.forEach(it => (level[it.key] = i)));
assert.ok(a.edges.every(e => level[e.from] < level[e.to]), 'every prereq sits in an earlier layer');
assert.deepEqual(lay[0].map(x => x.code || 'slot').sort(), ['BIO 1300', 'CS 1100', 'MATH 1500', 'slot'], 'roots');
for (const cols of [columns(m, 15).map(c => c.items), lay]) {
  const r = route(cols, a.edges.filter(e => cols.some(c => c.some(x => x.key === e.from)) && cols.some(c => c.some(x => x.key === e.to))));
  const colOf = {};
  r.cols.forEach((c, i) => c.forEach(x => (colOf[x.key] = i)));
  for (const p of r.paths) p.forEach((k, i) => i && assert.equal(colOf[k], colOf[p[i - 1]] + 1, 'paths step one column at a time'));
  assert.equal(r.cols.flat().filter(x => !x.via).length, cols.flat().length, 'routing keeps every card');
}
const rcols = columns(m, 15), RM = roadmap(rcols, a.edges, m.groups.map(g => g.id));
assert.equal(RM.rows[0].kind, 'done', 'completed work folds into the first row');
assert.equal(RM.rows[0].items.length, rcols.filter(c => c.kind === 'transfer' || c.kind === 'past').reduce((n, c) => n + c.items.length, 0));
assert.equal(RM.rows.length, 1 + rcols.filter(c => c.kind === 'current' || c.kind === 'future').length);
assert.ok(RM.routes.every(r => r.to === 'grad' || a.byKey[r.from].status !== 'done'), 'only prerequisites still ahead are drawn');
assert.ok(RM.routes.some(r => r.drop) && RM.routes.some(r => r.to === 'grad'));
const hop = roadmap([{ kind: 'current', label: 'T1', items: [{ key: 'a', group: 'g0' }] },
  { kind: 'future', label: 'T2', items: [{ key: 'b', group: 'g2' }, { key: 'c', group: 'g1' }] }], [{ from: 'a', to: 'b' }], ['g0', 'g1', 'g2']);
assert.deepEqual(['x1', 'x2', 'hop'].map(k => hop.routes.find(r => r.to === 'b')[k]), [1, 2, 0], 'far lanes hop across the gutter below the source row');
for (const r of RM.routes.filter(r => r.drop)) {
  const p = RM.at[r.from], q = RM.at[r.to];
  assert.ok(p.l === q.l && q.r === p.r + 1 && p.s === p.n - 1 && q.s === 0, 'drops only straight down a lane into the next row');
}
for (const list of [...RM.segs.vseg, ...RM.segs.hseg])
  list.forEach((p, i) => list.slice(i + 1).forEach(q => assert.ok(p.t !== q.t || p.hi + 0.02 <= q.lo || q.hi + 0.02 <= p.lo, 'segments sharing a track never overlap')));
const W = web(columns(m, 15), a.edges);
const angles = columns(m, 15).flatMap(c => c.items).map(it => W.angle[it.key]);
assert.ok(angles.every((t, i) => !i || t > angles[i - 1]), 'terms run clockwise');
a.edges.forEach((e, i) => {
  assert.ok(W.angle[e.to] > W.angle[e.from], 'links run clockwise');
  assert.ok(W.lane[i] > W.hub && W.lane[i] < W.R, 'lane between hub and ring');
  a.edges.forEach((f, j) => {
    if (j <= i || W.lane[j] !== W.lane[i]) return;
    const [p, q] = [[W.angle[e.from], W.angle[e.to]], [W.angle[f.from], W.angle[f.to]]];
    assert.ok(p[1] < q[0] || q[1] < p[0], 'links sharing a lane never overlap');
  });
});
const cs4900 = Object.values(a.byKey).find(x => x.code === 'CS 4900');
const T = courseTree(cs4900, a, m.prereqs);
assert.ok(T.links.every(([p, c]) => c.level - p.level === 1), 'tree links join adjacent rows');
for (const lv of new Set(T.nodes.map(n => n.level))) {
  const xs = T.nodes.filter(n => n.level === lv).map(n => n.x).sort((p, q) => p - q);
  assert.ok(xs.every((x, i) => !i || x - xs[i - 1] >= 1), 'cards in a row never overlap');
}
assert.deepEqual(T.nodes.filter(n => n.level === -1).map(n => n.it.code).sort(), ['CS 3400', 'CS 3500']);
assert.ok(T.nodes.some(n => n.it?.code === 'CS 1100' && n.level === -5) || T.nodes.some(n => n.more), 'chain reaches back or marks more');
const cs3600 = Object.values(a.byKey).find(x => x.code === 'CS 3600');
const or = courseTree(cs3600, a, m.prereqs).nodes.find(n => n.kind === 'or');
assert.deepEqual(or.options.map(o => o.code), ['MATH 2400', 'MATH 2600'], 'OR group becomes one box');
const slot2 = m.remaining.find(x => x.after);
assert.equal(courseTree(slot2, a, m.prereqs).nodes.find(n => n.level === -1).it.key, slot2.after, 'chained slot shows its predecessor');
console.log('ok');
