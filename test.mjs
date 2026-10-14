// node test.mjs — sanity check of the parser + planner against demo.json.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parseAudit, columns, analyze, degreeTree, courseTree, prereqGroups, nextTerm, titleCase, priorityColors, routePadding, treeRoutes } from './model.js';

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
// A large degree with many parallel branches, long links and a shared capstone.
const wide = { byKey: { root: { key: 'root' }, end: { key: 'end' } }, edges: [] };
for (let i = 0; i < 60; i++) {
  const first = `a${i}`, second = `b${i}`;
  wide.byKey[first] = { key: first }; wide.byKey[second] = { key: second };
  wide.edges.push({ from: 'root', to: first }, { from: first, to: second }, { from: second, to: 'end' });
}
wide.edges.push({ from: 'root', to: 'end' });
wide.byKey = Object.fromEntries(Object.entries(wide.byKey).sort(([p], [q]) => p.localeCompare(q)));
for (const graph of [a, wide]) for (const width of [2, 4, 6, 10, 16]) {
  const D = degreeTree(graph, width), keys = new Set(Object.keys(graph.byKey));
  assert.deepEqual(new Set(D.nodes.map(n => n.key)), keys, 'every course is shown once, including unlinked requirements');
  assert.equal(D.nodes.length, keys.size, 'no duplicate courses or card-sized routing slots');
  assert.ok(D.nodes.every(n => n.x >= 0 && n.x < width), 'layout respects the column limit');
  assert.equal(new Set(D.nodes.map(n => `${n.x}:${n.level}`)).size, keys.size, 'cards never overlap');
  for (const n of D.nodes) assert.ok(D.nodes.every(other => other === n || other.level !== n.level || Math.abs(other.x - n.x) >= 1), 'centered branches do not overlap');
  assert.equal(D.links.length, graph.edges.length, 'every prerequisite link is preserved');
  D.links.forEach(([from, to, edge], i) => {
    assert.equal(edge, graph.edges[i]);
    assert.equal(from.key, edge.from); assert.equal(to.key, edge.to);
    assert.ok(from.level < to.level, 'prerequisites always appear above dependents');
  });
}
const narrow = degreeTree(wide, 4), broad = degreeTree(wide, 10);
assert.ok(new Set(narrow.nodes.filter(n => n.key.startsWith('a')).map(n => n.level)).size > 1, 'siblings can stagger onto different rows');
assert.ok(Math.max(...narrow.nodes.map(n => n.level)) > Math.max(...broad.nodes.map(n => n.level)), 'narrower layouts use more rows');
assert.ok(narrow.links.filter(([, , e]) => e.from.startsWith('a')).every(([p, c]) => p.x === c.x), 'simple branches stay in the same column');
const slotFirstKey = m.remaining.find(x => x.after).after;
const compact = degreeTree(a, 4);
assert.ok(compact.links.filter(([p]) => p.it.code === 'BIO 1300' || p.it.key === slotFirstKey).every(([p, c]) => c.level === p.level + 1), 'independent short chains stay together');
const independent = { byKey: {}, edges: [] };
for (let i = 0; i < 24; i++) {
  independent.byKey[`p${i}`] = { key: `p${i}` }; independent.byKey[`q${i}`] = { key: `q${i}` };
  independent.edges.push({ from: `p${i}`, to: `q${i}` });
}
const packed = degreeTree(independent, 4);
assert.equal(new Set(packed.nodes.map(n => `${n.x}:${n.level}`)).size, 48, 'packed chains do not overlap');
assert.ok(packed.links.every(([p, c]) => p.x === c.x && c.level === p.level + 1), 'every independent chain stays adjacent');
assert.equal(Math.max(...packed.nodes.map(n => n.level)), 11, 'short chains fill four columns compactly');
assert.deepEqual(degreeTree({ edges: [], byKey: {} }), { nodes: [], links: [] }, 'empty audit has no graph');
assert.equal(degreeTree({ edges: [], byKey: { only: { key: 'only' } } }).nodes[0].key, 'only', 'unlinked courses remain on the canvas');
assert.ok(degreeTree(a, NaN).nodes.every(n => n.x < 4), 'invalid width falls back to four columns');
assert.throws(() => degreeTree({ byKey: { a: { key: 'a' }, b: { key: 'b' } }, edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }] }), /cycle/);
const sketch = { byKey: {}, edges: [['math', 'econ'], ['math', 'business'], ['econ', 'finance'], ['business', 'accounting'], ['business', 'stats'], ['accounting', 'finance'], ['accounting', 'managerial'], ['stats', 'stats2']].map(([from, to]) => ({ from, to })) };
for (const key of new Set(sketch.edges.flatMap(e => [e.from, e.to]))) sketch.byKey[key] = { key };
sketch.byKey.strategy = { key: 'strategy' };
const drawing = degreeTree(sketch, 4), node = key => drawing.nodes.find(n => n.key === key);
assert.equal(node('math').x, (node('econ').x + node('business').x) / 2, 'foundation sits over its two branches');
assert.equal(drawing.nodes.length, 9, 'the disconnected strategy requirement stays visible');
const sketchClasses = [
  ['MATH', '1060', 'Foundations of Math', 0], ['MATH', '1170', 'Business Math', 1], ['ECON', '2020', 'Microeconomic Principles', 1],
  ['ACCT', '2110', 'Financial Accounting', 2], ['ECON', '2100', 'Business Statistics I', 2],
  ['FIN', '3200', 'Corporate Finance', 3], ['ACCT', '2120', 'Managerial Accounting', 3], ['ECON', '2110', 'Business Statistics II', 3],
].map(([discipline, number, courseTitle, year]) => ({ id: discipline + number, discipline, number, courseTitle,
  credits: '3', term: String(202000 + year * 100), termLiteral: `Fall ${2020 + year}` }));
const sketchAudit = { blockArray: [{ requirementType: 'DEGREE', requirementValue: 'BS', title: 'Business degree', ruleArray: [],
  header: { qualifierArray: [{ name: 'CLASSESCREDITS', credits: 24, applied: 24 }] } }], classInformation: { classArray: sketchClasses } };
const repaired = parseAudit(sketchAudit);
assert.deepEqual(repaired.courses.find(c => c.code === 'MATH 1170').prereqs, [['MATH 1060']], 'blank business math prereq is recovered');
assert.deepEqual(repaired.courses.find(c => c.code === 'ECON 2020').prereqs, [['MATH 1060']], 'blank microeconomics prereq is recovered');
assert.deepEqual(repaired.courses.find(c => c.code === 'ACCT 2110').prereqs, [['MATH 1170']], 'accounting follows the sketch, not an invented direct foundation link');
assert.deepEqual(repaired.prereqs['FIN 3200'], [['ECON 2020'], ['ACCT 2110']], 'course modal sees the repaired finance prerequisites');
const repairedGraph = analyze(columns(repaired));
assert.equal(repairedGraph.info[repaired.courses[0].key].unlocks, 7, 'foundation bottleneck includes all seven downstream courses');
assert.equal(repairedGraph.edges.length, 8, 'all eight sketch connections are present');
const explicit = { 'MATH 1170': [['', 'MATH', '1150']] };
assert.deepEqual(parseAudit(sketchAudit, explicit).prereqs['MATH 1170'], [['MATH 1150']], 'reported prerequisites stay intact');
assert.deepEqual(explicit, { 'MATH 1170': [['', 'MATH', '1150']] }, 'correction does not mutate imported data');
const otherSchool = structuredClone(sketchAudit); otherSchool.classInformation.classArray[0].courseTitle = 'Trigonometry';
assert.deepEqual(parseAudit(otherSchool).prereqs, {}, 'same course code at another school gets no invented prerequisites');
const unscheduled = structuredClone(sketchAudit);
unscheduled.classInformation.classArray = [];
unscheduled.blockArray[0].header.qualifierArray[0].applied = 0;
unscheduled.blockArray.push({ requirementType: 'MAJOR', requirementValue: 'BIZ', title: 'Business', ruleArray: sketchClasses.map(c => ({
  ruleType: 'Course', label: c.courseTitle, advice: { classes: 1, courseArray: [{ discipline: c.discipline, number: c.number, credits: 3, prerequisiteExists: 'N' }] },
})) });
const futureSketch = parseAudit(unscheduled), futureTerms = columns(futureSketch);
const scheduled = code => futureTerms.findIndex(t => t.items.some(c => c.code === code));
assert.ok(scheduled('MATH 1060') < scheduled('MATH 1170') && scheduled('MATH 1170') < scheduled('ACCT 2110'), 'recovered source links order the suggested terms too');
const lookups = [];
const bookmarkAudit = { blockArray: [{ ruleArray: [{ advice: { courseArray: [{ discipline: 'MATH', number: '1170', prerequisiteExists: 'N' }] } }] }], classInformation: { classArray: [] } };
await new Promise((resolve, reject) => runInNewContext(readFileSync(new URL('./bookmarklet.js', import.meta.url), 'utf8'), {
  performance: { getEntriesByType: () => [{ name: 'https://school.example/responsive/api/audit?id=1' }] },
  fetch: async url => { lookups.push(url); return { ok: true, json: async () => url.includes('/api/audit?') ? bookmarkAudit
    : { courseInformation: { courses: [{ prerequisites: [{ subjectCodePrerequisite: 'MATH', courseNumberPrerequisite: '1060' }] }] } } }; },
  Blob, CompressionStream, Response, Uint8Array, btoa,
  window: { open: () => { resolve(); return true; } }, location: {}, alert: message => reject(new Error(message)),
}));
assert.ok(lookups.some(url => url.includes('/api/course-link?discipline=MATH&number=1170&')), 'bookmarklet requests prerequisites despite an incorrect no-prerequisites flag');

const geometry = (T, gap = 20) => {
  const cw = 176, ch = 76, gx = gap, gy = gap + 12, minX = Math.min(0, ...T.nodes.map(n => n.x)), minL = Math.min(0, ...T.nodes.map(n => n.level));
  const pad = routePadding(T, gx), py = 4;
  return { cw, ch, gx, gy, pad, py, minX, minL, width: (Math.max(...T.nodes.map(n => n.x)) - minX + 1) * (cw + gx) - gx + pad * 2 };
};
const pointOn = (s, t) => s.from.map((v, i) => (1 - t) ** 3 * v + 3 * (1 - t) ** 2 * t * s.c1[i] + 3 * (1 - t) * t ** 2 * s.c2[i] + t ** 3 * s.to[i]);
for (const graph of [a, sketch, wide]) for (const width of [2, 4, 10, 16]) for (const gap of [20, 80]) {
  const layout = degreeTree(graph, width), g = geometry(layout, gap), routes = treeRoutes(layout, g);
  const ports = new Map(layout.nodes.map(n => [n, new Set()]));
  const boxes = layout.nodes.map(n => ({ x: (n.x - g.minX) * (g.cw + g.gx) + g.pad, y: (n.level - g.minL) * (g.ch + g.gy) + g.py }));
  for (const r of routes) {
    for (const end of [r.source, r.target]) {
      const key = end.point.join(':');
      assert.ok(!ports.get(end.node).has(key), 'every connection has its own perimeter attachment');
      ports.get(end.node).add(key);
    }
    for (const s of r.segments) for (let t = .02; t < 1; t += .04) {
      const [x, y] = pointOn(s, t);
      assert.ok(boxes.every(b => x <= b.x + .01 || x >= b.x + g.cw - .01 || y <= b.y + .01 || y >= b.y + g.ch - .01), 'curved connections stay outside cards');
    }
  }
  for (let i = 0; i < routes.length; i++) for (const other of routes.slice(i + 1)) {
    const r = routes[i];
    if (r.long && other.long && r.source.node.level < other.target.node.level && other.source.node.level < r.target.node.level)
      assert.ok(Math.abs(r.lane - other.lane) >= 6 || r.target.node.level <= other.source.node.level || other.target.node.level <= r.source.node.level, 'simultaneous long paths have separate lanes');
  }
  const segments = routes.flatMap(r => r.segments.map(s => [s.from, s.c1, s.c2, s.to].flat().join(':')));
  assert.equal(new Set(segments).size, segments.length, 'connections never share an identical curve segment');
}
assert.ok(treeRoutes(drawing, geometry(drawing)).some(r => ['left', 'right'].includes(r.source.side)), 'tentacles can leave the sides of cards');
const diamond = analyze([
  { items: [{ key: 'root', code: 'ROOT', status: 'done' }] },
  { items: [{ key: 'left', code: 'LEFT', status: 'planned', prereqs: [['ROOT']] }, { key: 'right', code: 'RIGHT', status: 'planned', prereqs: [['ROOT']] }] },
  { items: [{ key: 'end', code: 'END', status: 'planned', prereqs: [['LEFT'], ['RIGHT']] }] },
]);
assert.equal(diamond.info.root.unlocks, 3, 'completed foundations count all unique descendants, not paths');
assert.equal(diamond.info.end.unlocks, 0, 'terminal course has no dependents');
let previous = 1;
for (let count = 0; count <= 100; count++) {
  const { fill, ink } = priorityColors(count, 100);
  const rgb = fill.match(/\d+/g).map(Number).map(v => v / 255 <= .04045 ? v / 255 / 12.92 : ((v / 255 + .055) / 1.055) ** 2.4);
  const light = rgb.reduce((n, v, i) => n + v * [.2126, .7152, .0722][i], 0);
  assert.ok(light <= previous, 'more dependents always gives a darker card');
  assert.ok((ink === '#fff' ? 1.05 / (light + .05) : (light + .05) / .05) >= 4.5, 'card text keeps accessible contrast');
  previous = light;
}
assert.equal(priorityColors(0, 0).fill, 'rgb(219 238 205)', 'no dependencies is green');
assert.equal(priorityColors(3, 3).fill, 'rgb(150 66 14)', 'largest bottleneck is dark orange');
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
