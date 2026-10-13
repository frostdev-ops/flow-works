// node test.mjs — sanity check of the parser + planner against demo.json.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseAudit, columns, analyze, layers, prereqGroups, nextTerm, titleCase } from './model.js';

assert.deepEqual(prereqGroups([['', 'CS', '2300'], ['A', 'MATH', '1160'], ['O', 'MATH', '1350'], ['O', '', '']]), [['CS 2300'], ['MATH 1160', 'MATH 1350']]);
assert.equal(nextTerm('Fall 2026'), 'Spring 2027');
assert.equal(nextTerm('Spring 2027'), 'Fall 2027');
assert.equal(titleCase('OBJECT-ORIENTED PROG IN JAVA II'), 'Object-Oriented Prog in Java II');

const { audit, prereqs } = JSON.parse(readFileSync(new URL('./demo.json', import.meta.url)));
const m = parseAudit(audit, prereqs);
assert.equal(m.student, 'Alex');
assert.deepEqual(m.groups.map(g => g.title), ['General Education Core', 'Mathematics & Science', 'B.S. Computer Science', 'Free electives']);
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
assert.deepEqual(lay[0].map(x => x.code).sort(), ['CS 1100', 'MATH 1500'], 'roots');
console.log('ok');
