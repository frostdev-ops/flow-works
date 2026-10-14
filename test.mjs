// node test.mjs — sanity check of the parser + planner against demo.json.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parseAudit, columns, analyze, degreeTree, courseTree, prereqGroups, nextTerm, titleCase, priorityColors, treeRoutes } from './model.js';

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
  const cards = D.nodes.filter(n => n.kind === 'course');
  assert.deepEqual(new Set(cards.map(n => n.key)), keys, 'every full course card is shown once, including unlinked requirements');
  assert.equal(cards.length, keys.size, 'reference labels do not duplicate full cards');
  assert.ok(D.nodes.filter(n => n.kind === 'route').every(n => n.span <= .2), 'routing slots remain much narrower than cards');
  for (const level of new Set(cards.map(n => n.level))) assert.ok(cards.filter(n => n.level === level).length <= width, 'column setting limits the full cards in each row');
  for (const n of cards) assert.ok(cards.every(other => other === n || other.level !== n.level || Math.abs(other.x - n.x) >= 1 - 1e-8), 'rearranged cards never overlap');
  assert.equal(D.links.length, graph.edges.length, 'every prerequisite link is preserved');
  assert.deepEqual(new Set(D.links.map(link => link[2])), new Set(graph.edges));
  D.links.forEach(([from, to, edge]) => {
    assert.equal(from.it.key, edge.from); assert.equal(to.it.key, edge.to);
    assert.ok(from.level < to.level, 'prerequisites always appear above dependents');
  });
}
const narrow = degreeTree(wide, 4), broad = degreeTree(wide, 10);
assert.ok(new Set(narrow.nodes.filter(n => n.key.startsWith('a')).map(n => n.level)).size > 1, 'siblings can stagger onto different rows');
assert.ok(Math.max(...narrow.nodes.map(n => n.level)) > Math.max(...broad.nodes.map(n => n.level)), 'narrower layouts use more rows');
assert.ok(narrow.links.filter(([, , e]) => e.from.startsWith('a')).every(([p, c]) => c.level === p.level + 1), 'simple branches remain adjacent while cards move to clear paths');
const slotFirstKey = m.remaining.find(x => x.after).after;
const compact = degreeTree(a, 4);
assert.ok(compact.links.filter(([p]) => p.it.code === 'BIO 1300' || p.it.key === slotFirstKey).every(([p, c]) => c.level > p.level && c.level <= p.level + 1.01), 'independent short chains stay together');
const independent = { byKey: {}, edges: [] };
for (let i = 0; i < 24; i++) {
  independent.byKey[`p${i}`] = { key: `p${i}` }; independent.byKey[`q${i}`] = { key: `q${i}` };
  independent.edges.push({ from: `p${i}`, to: `q${i}` });
}
const packed = degreeTree(independent, 4);
assert.equal(new Set(packed.nodes.map(n => `${n.x}:${n.level}`)).size, 48, 'packed chains do not overlap');
assert.ok(packed.links.every(([p, c]) => p.x === c.x && c.level > p.level && c.level <= p.level + 1.01), 'every independent chain stays adjacent');
assert.ok(Math.max(...packed.nodes.map(n => n.level)) <= 11, 'short chains fill four columns compactly');
assert.deepEqual(degreeTree({ edges: [], byKey: {} }), { nodes: [], links: [] }, 'empty audit has no graph');
assert.equal(degreeTree({ edges: [], byKey: { only: { key: 'only' } } }).nodes[0].key, 'only', 'unlinked courses remain on the canvas');
assert.deepEqual(degreeTree(a, NaN), degreeTree(a, 4), 'invalid width falls back to four columns');
assert.throws(() => degreeTree({ byKey: { a: { key: 'a' }, b: { key: 'b' } }, edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }] }), /cycle/);
const sketch = { byKey: {}, edges: [['math', 'econ'], ['math', 'business'], ['econ', 'finance'], ['business', 'accounting'], ['business', 'stats'], ['accounting', 'finance'], ['accounting', 'managerial'], ['stats', 'stats2']].map(([from, to]) => ({ from, to })) };
for (const key of new Set(sketch.edges.flatMap(e => [e.from, e.to]))) sketch.byKey[key] = { key };
sketch.byKey.strategy = { key: 'strategy' };
const drawing = degreeTree(sketch, 4), node = key => drawing.nodes.find(n => n.key === key);
assert.ok(Math.abs(node('math').x - (node('econ').x + node('business').x) / 2) < .1, 'foundation sits between its two branches');
assert.equal(drawing.nodes.filter(n => n.kind === 'course').length, 9, 'the disconnected strategy requirement stays visible');
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

const nonplanar = { byKey: {}, edges: [] };
for (let i = 0; i < 3; i++) { nonplanar.byKey[`s${i}`] = { key: `s${i}` }; nonplanar.byKey[`t${i}`] = { key: `t${i}` }; }
for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) nonplanar.edges.push({ from: `s${i}`, to: `t${j}` });
const referenced = degreeTree(nonplanar, 4);
assert.ok(referenced.nodes.some(n => n.kind === 'reference'), 'a nonplanar graph uses the approved reference fallback');
assert.equal(referenced.nodes.filter(n => n.kind === 'course').length, 6, 'all six full cards remain unique');
assert.equal(referenced.links.length, 9, 'references preserve all nine prerequisite relationships');
assert.ok(degreeTree(wide, 10).nodes.some(n => n.kind === 'reference'), 'dense staggered fans use references instead of unreadable long crossings');
assert.ok(!degreeTree(a, 4).nodes.some(n => n.kind === 'reference'), 'staggering demo cards can clear all conflicts without references');

const geometry = (T, gap = 20) => {
  const cw = 164, ch = 66, gx = gap, gy = gap + 26;
  const minX = Math.min(0, ...T.nodes.map(n => n.x + (1 - (n.span || 1)) / 2)), minL = Math.min(0, ...T.nodes.map(n => n.level));
  return { cw, ch, gx, gy, pad: 16, py: 4, minX, minL };
};
const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
const minus = (a, b) => a.map((v, i) => v - b[i]);
function intersects(a, b, c, d) {
  const r = minus(b, a), s = minus(d, c), q = minus(c, a), den = cross(r, s);
  if (Math.abs(den) < 1e-8) {
    if (Math.abs(cross(q, r)) > 1e-8) return false;
    const axis = Math.abs(r[0]) > Math.abs(r[1]) ? 0 : 1;
    return Math.min(Math.max(a[axis], b[axis]), Math.max(c[axis], d[axis])) - Math.max(Math.min(a[axis], b[axis]), Math.min(c[axis], d[axis])) > 1e-6;
  }
  const t = cross(q, s) / den, u = cross(q, r) / den;
  return t >= -1e-8 && t <= 1 + 1e-8 && u >= -1e-8 && u <= 1 + 1e-8;
}
assert.ok(intersects([0, 0], [10, 10], [0, 10], [10, 0]), 'the crossing detector rejects an X');
assert.ok(intersects([0, 0], [0, 10], [0, 5], [0, 15]), 'the crossing detector rejects a shared stem');
assert.ok(!intersects([0, 0], [0, 10], [6, 0], [6, 10]), 'separate lanes are accepted');
function checkCrossings(routes) {
  const grid = new Map();
  routes.forEach((route, path) => {
    assert.equal(route.segments.length, 1, 'every relationship is one straight link');
    assert.ok(route.d.includes(' L') && !/[CQ]/.test(route.d), 'SVG contains only a move and a straight line');
    const { from: a, to: b } = route.segments[0], tested = new Set(), cells = [];
    assert.ok([...a, ...b].every(Number.isFinite), 'all attachment points have finite coordinates');
    for (let x = Math.floor(Math.min(a[0], b[0]) / 32); x <= Math.floor(Math.max(a[0], b[0]) / 32); x++)
      for (let y = Math.floor(Math.min(a[1], b[1]) / 32); y <= Math.floor(Math.max(a[1], b[1]) / 32); y++) {
        const key = `${x}:${y}`; cells.push(key);
        for (const other of grid.get(key) || []) if (!tested.has(other)) {
          tested.add(other);
          assert.ok(!intersects(a, b, other.a, other.b), `prerequisite paths ${path} and ${other.path} must not cross or overlap`);
        }
      }
    const segment = { a, b, path };
    for (const key of cells) { if (!grid.has(key)) grid.set(key, []); grid.get(key).push(segment); }
  });
}
function checkCards(layout, routes, g) {
  const boxes = layout.nodes.filter(n => n.kind !== 'route').map(n => {
    const w = (n.span || 1) * (g.cw + g.gx) - g.gx, h = n.kind === 'reference' ? 30 : g.ch;
    return { n, x: (n.x - g.minX) * (g.cw + g.gx) + g.pad + (g.cw - w) / 2, y: (n.level - g.minL) * (g.ch + g.gy) + g.py + (g.ch - h) / 2, w, h };
  });
  boxes.forEach((b, i) => {
    for (const other of boxes.slice(i + 1)) assert.ok(b.x + b.w <= other.x + .01 || other.x + other.w <= b.x + .01 || b.y + b.h <= other.y + .01 || other.y + other.h <= b.y + .01, 'full cards and references never overlap');
  });
  for (const route of routes) for (const b of boxes) {
    if (b.n === route.source.node || b.n === route.target.node) continue;
    const x = b.x + .01, y = b.y + .01, right = b.x + b.w - .01, bottom = b.y + b.h - .01;
    const corners = [[x, y], [right, y], [right, bottom], [x, bottom]], { from, to } = route.segments[0];
    assert.ok(!corners.some((p, i) => intersects(from, to, p, corners[(i + 1) % 4])), 'straight links never enter another card or reference');
  }
}
for (const graph of [a, sketch, wide, nonplanar]) for (const width of [2, 4, 10, 16]) for (const gap of [20, 80]) {
  const layout = degreeTree(graph, width, gap), g = geometry(layout, gap), routes = treeRoutes(layout, g);
  const ports = new Map(layout.nodes.map(n => [n, new Set()]));
  for (const r of routes) {
    for (const end of [r.source, r.target]) {
      const key = end.point.join(':');
      assert.ok(!ports.get(end.node).has(key), 'every connection has its own perimeter attachment');
      ports.get(end.node).add(key);
    }
  }
  checkCards(layout, routes, g);
  checkCrossings(routes);
}
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
const focusGeometry = T => {
  const cw = 200, ch = 92, gx = 20, reach = Math.max(0, ...T.links.map(([p, c]) => Math.abs(c.x - p.x) * (cw + gx)));
  return { ...geometry(T), cw, ch, gx, gy: Math.max(56, (ch / 2 + 4) * reach / (cw / 2 + gx) - ch), py: 0 };
};
for (const it of Object.values(a.byKey)) {
  const focused = courseTree(it, a, m.prereqs);
  const g = focusGeometry(focused), routes = treeRoutes(focused, g);
  checkCrossings(routes); checkCards(focused, routes, g);
}
console.log('ok: parser, planner, unique cards, reference fallback, and zero line crossings or shared stems');
