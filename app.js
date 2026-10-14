import { parseAudit, columns, analyze, degreeTree, courseTree, priorityColors } from './model.js';

const $ = s => document.querySelector(s);
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const EASE = 'cubic-bezier(.2,.8,.2,1)';
const STATUS = { done: 'Completed', current: 'In progress', registered: 'Registered', planned: 'Planned' };
const store = {
  get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs))
    if (v != null && v !== false) k.startsWith('on') ? el.addEventListener(k.slice(2), v) : el.setAttribute(k, v);
  el.append(...kids.flat().filter(k => k != null && k !== false));
  return el;
}
const svg = (tag, attrs = {}) => {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
};

let model, A, edges = [], most = 0, fit = true, maxCredits = +store.get('flowworks:credits') || 15;
const color = g => {
  const i = model.groups.findIndex(x => x.id === g);
  return g === 'free' || i < 0 ? 'var(--gfree)' : `var(--g${i % 8})`;
};
const priority = it => priorityColors(A.info[it?.key]?.unlocks || 0, most);
const cardStyle = it => { const p = priority(it); return `--c:${p.fill};--card-ink:${p.ink}`; };

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('on'), 5000);
}

// ---------- import ----------

async function unpack(b64) {
  const bin = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  return JSON.parse(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text());
}

async function boot() {
  let data = null;
  try {
    if (location.hash === '#demo') data = await fetch('demo.json').then(r => r.json());
    else if (location.hash.startsWith('#d=')) {
      data = await unpack(location.hash.slice(3));
      store.set('flowworks:data', JSON.stringify(data));
      history.replaceState(null, '', location.pathname);
    } else data = JSON.parse(store.get('flowworks:data') || 'null');
  } catch {
    history.replaceState(null, '', location.pathname);
    toast("Couldn't read that audit. Try the bookmarklet again.");
  }
  data ? show(data) : landing();
}

async function landing() {
  $('#chart').hidden = true;
  $('#landing').hidden = false;
  $('.tools').hidden = true;
  document.title = 'Flow-works: your degree as a flowchart';
  const src = await fetch('bookmarklet.js').then(r => r.text());
  $('#bm').href = 'javascript:' + encodeURIComponent(src.replace(/^\s*\/\/.*\n/gm, '').replace('__APP__', location.origin + location.pathname));
}

function show(data, save) {
  try {
    model = parseAudit(data.audit || data, data.audit ? data.prereqs : {});
  } catch (e) {
    toast(e.message);
    return landing();
  }
  if (save) store.set('flowworks:data', JSON.stringify(data));
  $('#landing').hidden = true;
  $('#chart').hidden = false;
  $('.tools').hidden = false;
  document.title = `${model.title} · Flow-works`;
  $('#chart-title').textContent = model.title;
  fit = true;
  summary();
  board();
}

async function importFile(file) {
  try { show(JSON.parse(await file.text()), true); }
  catch { toast("That file isn't valid JSON."); }
}

// ---------- summary ----------

function countUp(el, to, fmt = n => n) {
  if (reduce) return (el.textContent = fmt(to));
  const t0 = performance.now();
  const step = t => {
    const k = Math.min(1, (t - t0) / 1400);
    el.textContent = fmt(Math.round(to * (1 - (1 - k) ** 3)));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function summary() {
  const m = model;
  $('#who').textContent = m.student ? `${m.student}'s path to` : 'Your path to';
  $('#title').textContent = m.title;
  $('#sub').textContent = [m.degree, m.catalog && `Catalog ${m.catalog}`].filter(Boolean).join(' · ');
  const arc = $('#arc'), len = 2 * Math.PI * 52;
  arc.style.strokeDasharray = len;
  arc.style.strokeDashoffset = len;
  requestAnimationFrame(() => requestAnimationFrame(() => (arc.style.strokeDashoffset = len * (1 - m.pct / 100))));
  countUp($('#pct'), m.pct, n => n + '%');
  $('#legend').replaceChildren(...m.groups.map(g => h('li', {
    style: `--c:${color(g.id)}`, tabindex: 0,
    onmouseenter: () => focusGroup(g.id), onmouseleave: () => focusOn(null),
    onfocus: () => focusGroup(g.id), onblur: () => focusOn(null),
  }, h('span', { class: 'name' }, g.title),
    h('span', { class: 'pc' }, g.pct == null ? m.courses.filter(c => c.group === g.id).reduce((n, c) => n + c.credits, 0) + ' cr' : g.pct + '%'),
    g.pct != null && h('span', { class: 'meter' }, h('i', { style: `--w:${g.pct}%` })))));
}

function stats(cols) {
  const future = cols.filter(c => c.kind === 'future');
  const grad = future.at(-1)?.label || cols.at(-1)?.label || 'Now';
  const need = Math.max(0, model.total - model.applied);
  $('#stats').replaceChildren(...[
    ['Credits', `${model.applied}`, `/ ${model.total}`],
    ['Still needed', `${need}`, 'credits'],
    ['Terms to go', `${future.length}`, `at ≤${maxCredits} cr`],
    ['Graduation', grad, 'estimated'],
  ].map(([k, v, u]) => h('div', {}, h('dt', {}, k), h('dd', {}, h('b', {}, v), ' ', h('small', {}, u)))));
  return grad;
}

// ---------- board ----------

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const short = (s, n = 18) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

function board() {
  const terms = columns(model, maxCredits).map(c => ({ ...c, items: c.items.map(it => ({ ...it, termLabel: c.label })) }));
  A = analyze(terms);
  edges = A.edges;
  most = Math.max(0, ...Object.values(A.info).map(n => n.unlocks));
  stats(terms);
  const count = Object.keys(A.byKey).length;
  $('#viewnote').textContent = count
    ? `${plural(count, 'course')} · Prerequisites flow down. Select a course for details.`
    : 'No courses were included in this audit.';
  const pane = $('#board');
  pane.hidden = $('#chart-controls').hidden = !count;
  if (!count) { $('#track').replaceChildren(); insights(); return; }
  pane.style.height = Math.max(240, innerHeight - (pane.getBoundingClientRect().top + scrollY) - 16) + 'px';
  const size = chartSpace();
  let T;
  if ($('#layout-width').value === 'auto') {
    let best = -1;
    for (let width = 2; width <= 16; width++) {
      const candidate = degreeTree(A, width), { width: w, height: ht } = treeSize(candidate);
      const score = Math.min(size.width / w, size.height / ht);
      if (score > best) { T = candidate; best = score; }
    }
  } else T = degreeTree(A, +$('#layout-width').value);
  insights();
  $('#track').replaceChildren(tree(T));
  fit ? fitChart() : zoomChart();
  focusOn(null);
}

// ---------- insights: critical path, bottlenecks, missing prereqs ----------

function jump(key) {
  const el = $(`#chart [data-key="${CSS.escape(key)}"]`);
  if (!el) return toast('That course is hidden in this view.');
  el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center', inline: 'center' });
  el.focus({ preventScroll: true });
}
const chip = (it, extra) => h('button', { type: 'button', class: 'chip', style: cardStyle(it), onclick: () => jump(it.key) }, it.code || it.title, extra);

function insights() {
  const parts = [], by = A.byKey;
  const crit = A.critical.map(k => by[k]), ahead = crit.filter(x => x.status === 'planned').length;
  if (crit.length) parts.push(h('div', {
    class: 'ins crit', onmouseenter: () => light(new Set(A.critical)), onmouseleave: () => focusOn(null),
  }, h('h3', {}, 'Critical path'),
    h('p', {}, `Your longest prerequisite chain still ahead: at least ${plural(ahead, 'more term')}. A delay anywhere on it pushes back graduation.`),
    h('ol', { class: 'chain' }, crit.map(x => h('li', {}, chip(x))))));
  if (A.necks.length) {
    const top = A.necks[0].unlocks;
    parts.push(h('div', { class: 'ins necks' }, h('h3', {}, 'Bottlenecks'),
      h('p', {}, 'Unfinished courses that later courses wait on, by how many they unlock.'),
      h('ul', {}, A.necks.slice(0, 5).map(n => h('li', {
        onmouseenter: () => focusOn(n.key), onmouseleave: () => focusOn(null), style: `--w:${(n.unlocks / top) * 100}%`,
      }, chip(by[n.key]), h('span', { class: 'what' }, by[n.key].title), h('span', { class: 'n' }, `+${n.unlocks}`), h('span', { class: 'meter' }, h('i')))))));
  }
  if (A.missing.length) parts.push(h('div', { class: 'ins warn' }, h('h3', {}, 'Check with your advisor'),
    h('p', {}, "These prerequisites aren't on your record or in the plan."),
    h('ul', {}, A.missing.slice(0, 6).map(m => h('li', {}, chip(by[m.key]), ` needs ${m.needs.join(' or ')}`)))));
  $('#insights').replaceChildren(...parts);
  $('#insights').hidden = !parts.length;
}

// ---------- focus & detail ----------

function light(keys) {
  const track = $('#chart');
  track.classList.toggle('focus', !!keys);
  track.querySelectorAll('[data-key]').forEach(el => el.classList.toggle('lit', !!keys?.has(el.dataset.key)));
  track.querySelectorAll('path').forEach(p => p.classList.toggle('lit', !!keys?.has(p.dataset.from) && keys.has(p.dataset.to)));
}

function reach(key, fwd, seen = new Set()) {
  for (const e of edges) {
    const [s, t] = fwd ? [e.from, e.to] : [e.to, e.from];
    if (s === key && t !== 'grad' && !seen.has(t)) { seen.add(t); reach(t, fwd, seen); }
  }
  return seen;
}
const focusOn = key => light(key && new Set([key, ...reach(key, true), ...reach(key, false)]));
const focusGroup = id => light(new Set(Object.values(A.byKey).filter(x => x.group === id).map(x => x.key)));

// ---------- course modal: prerequisite flowchart ----------

const TW = 200, TH = 92, TGX = 20, TGY = 56; // tree card size and gaps
let trail = [];

// Courses outside the chart (e.g. a prerequisite you never took) still open, from the prerequisite data alone.
const stub = code => ({ code, title: code, status: 'missing', block: 'Not on your record or plan', prereqs: model.prereqs[code] || [], credits: 0 });

function detail(it, keep) {
  const d = $('#detail');
  if (!keep) trail = [];
  trail.push(it);
  const info = A.info[it.key], crit = A.critical.includes(it.key), T = courseTree(it, A, model.prereqs);
  const ups = T.nodes.filter(n => n.level < 0).length, downs = T.nodes.filter(n => n.level > 0).length;
  const back = (t, i) => h('button', { type: 'button', onclick: () => { trail = trail.slice(0, i); detail(t, true); } }, t.code || short(t.title, 24));
  const scroller = h('div', { class: 'tree-scroll' }, tree(T, it));
  d.replaceChildren(h('form', { method: 'dialog', class: 'course', style: cardStyle(it) },
    h('button', { class: 'x', 'aria-label': 'Close' }, '×'),
    trail.length > 1 && h('nav', { class: 'trail', 'aria-label': 'Courses you opened' },
      trail.slice(0, -1).flatMap((t, i) => [back(t, i), h('span', { 'aria-hidden': 'true' }, '›')]), h('b', {}, it.code || short(it.title, 24))),
    h('p', { class: 'eyebrow' }, it.block),
    h('h3', { id: 'course-title' }, it.title),
    h('p', { class: 'meta' }, [it.code, it.credits && `${it.credits} credits`, STATUS[it.status] || 'Not on your record or plan',
      it.status === 'done' && it.grade && `Grade ${it.grade}`, it.transfer ? 'Transfer' : it.termLabel,
      info?.unlocks && `unlocks ${plural(info.unlocks, 'later course')}`].filter(Boolean).join(' · ')),
    crit && h('p', { class: 'flag' }, 'On your critical path: delaying this delays graduation.'),
    it.status === 'missing' && h('p', { class: 'flag warn' }, "This prerequisite isn't on your record or in the plan. Check with your advisor; placement or a waiver may cover it."),
    h('section', {}, h('h4', {}, ups || downs
      ? [ups ? 'Prerequisites flow down into it' : 'No prerequisites', downs ? '; underneath is what it unlocks' : '', '. Click any course to follow the chain.'].join('')
      : 'No prerequisite links for this course.'), scroller),
    it.options && h('section', {}, h('h4', {}, it.options.length > 1 ? `Pick from ${it.options.length} options` : 'Requirement'),
      h('ul', { class: 'opts' }, it.options.slice(0, 80).map(o => h('li', {}, o)))),
    it.status === 'planned' && h('p', { class: 'note' }, 'Planned term is a suggestion. Confirm with your advisor before registering.')));
  if (!d.open) d.showModal();
  d.scrollTop = 0;
  const r = scroller.querySelector('.tcard.root').getBoundingClientRect(), v = scroller.getBoundingClientRect();
  scroller.scrollLeft += r.left + r.width / 2 - (v.left + v.width / 2);
  scroller.scrollTop += r.top + r.height / 2 - (v.top + v.height / 2);
}

function treeSize(T, rootIt) {
  const xs = T.nodes.map(n => n.x), lv = T.nodes.map(n => n.level);
  const minX = Math.min(0, ...xs), minL = Math.min(0, ...lv);
  const cw = rootIt ? TW : 176, ch = rootIt ? TH : 76;
  const gx = rootIt ? TGX : +$('#layout-spacing').value, gy = rootIt ? TGY : gx + 12, pad = rootIt ? 0 : gx / 2 + 4;
  const py = rootIt ? 0 : 4;
  return { cw, ch, gx, gy, pad, py, minX, minL,
    width: (Math.max(0, ...xs) - minX + 1) * (cw + gx) - gx + pad * 2,
    height: (Math.max(0, ...lv) - minL + 1) * (ch + gy) - gy + py * 2 };
}

function tree(T, rootIt) {
  const { cw, ch, gx, gy, pad, py, minX, minL, width: Wd, height: Ht } = treeSize(T, rootIt);
  const at = n => [(n.x - minX) * (cw + gx) + pad, (n.level - minL) * (ch + gy) + py];
  const box = h('div', { class: `tree${rootIt ? '' : ' overview'}`, style: `width:${Wd}px;height:${Ht}px` });
  const lines = svg('svg', { class: 'tree-lines', width: Wd, height: Ht, 'aria-hidden': 'true' });
  const state = n => n.kind === 'or' ? (n.options.find(o => o.code === n.pick)?.it?.status || 'missing') : n.it?.status || 'missing';
  const ring = n => Math.abs(n.level);
  const critLinks = new Set(A.critical.slice(1).map((k, i) => A.critical[i] + '>' + k));
  T.links.forEach(([up, down, edge]) => {
    const [x1, y1] = at(up), [x2, y2] = at(down), ax = x1 + cw / 2, ay = y1 + ch, bx = x2 + cw / 2, m = (ay + y2) / 2;
    let path = `M${ax},${ay} C${ax},${m} ${bx},${m} ${bx},${y2}`;
    if (down.level - up.level > 1) {
      // Long connections travel in the gutters between fixed columns, without reserving card-sized gaps.
      const column = bx < ax ? Math.ceil(up.x - minX) - .5 : Math.floor(up.x - minX) + .5;
      const lane = column * (cw + gx) + pad + cw / 2, out = ay + gy / 2, into = y2 - gy / 2;
      path = `M${ax},${ay} C${ax},${out} ${lane},${ay} ${lane},${out} L${lane},${into} C${lane},${y2} ${bx},${into} ${bx},${y2}`;
    }
    const from = edge?.from || up.it?.key, to = edge?.to || down.it?.key;
    const cls = edge
      ? [A.byKey[to].status === 'planned' && 'planned', critLinks.has(from + '>' + to) && 'crit'].filter(Boolean).join(' ')
      : state(up) === 'missing' ? 'miss' : state(down) === 'planned' ? 'planned' : '';
    const p = svg('path', { d: path, class: cls,
      'data-from': from || '', 'data-to': to || '',
      style: '--c:var(--muted)' });
    lines.append(p);
    if (!reduce) requestAnimationFrame(() => {
      const len = p.getTotalLength();
      const k = up.level < 0 ? ring(up) : ring(down);
      p.animate([{ strokeDasharray: len, strokeDashoffset: len }, { strokeDasharray: len, strokeDashoffset: 0 }],
        { duration: 500, delay: 80 + Math.min(k, 4) * 100, easing: 'ease-out', fill: 'backwards' });
    });
  });
  box.append(lines);
  for (const n of T.nodes) {
    const [x, y] = at(n), el = n.kind === 'or' ? orCard(n) : courseCard(n, n.it === rootIt);
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    if (n.more) el.append(h('span', { class: 'more ' + (n.level < 0 ? 'up' : 'down') }, `+${n.more} more`));
    box.append(el);
    if (!reduce) el.animate(n.level === 0
      ? [{ opacity: 0, transform: 'scale(.92)' }, { opacity: 1, transform: 'none' }]
      : [{ opacity: 0, transform: `translateY(${n.level < 0 ? 14 : -14}px)` }, { opacity: 1, transform: 'none' }],
    { duration: 450, delay: Math.min(ring(n), 4) * 100, easing: EASE, fill: 'backwards' });
  }
  return box;
}

const CHIP = { done: '✓ Done', current: 'Now', registered: 'Registered', planned: 'Planned', missing: 'Missing' };
function courseCard(n, isRoot) {
  const it = n.it || stub(n.code), s = it.status;
  const missing = A.needs[it.key]?.some(n => n.state === 'miss');
  const unlocks = A.info[it.key]?.unlocks || 0;
  const label = [it.code, it.title, CHIP[s], it.credits && `${it.credits} credits`, it.termLabel,
    `${plural(unlocks, 'later course')} depend on this`, missing && 'Prerequisite missing from your record or plan'].filter(Boolean).join(' · ');
  return h('button', {
    type: 'button', 'data-key': it.key, class: `tcard ${s}${isRoot ? ' root' : ''}${A.critical.includes(it.key) ? ' crit' : ''}`, style: cardStyle(it),
    onclick: isRoot ? null : () => detail(it, $('#detail').open), 'aria-label': label, title: label,
    onmouseenter: () => focusOn(it.key), onmouseleave: () => focusOn(null),
    onfocus: () => focusOn(it.key), onblur: () => focusOn(null),
  }, h('span', { class: 'top' }, h('span', { class: 'code' }, it.code || 'Choose'), h('span', { class: 'chip ' + s }, CHIP[s] || s)),
  h('span', { class: 'title' }, s === 'missing' ? 'Not on your record or plan' : it.title),
  h('span', { class: 'meta' }, missing && h('span', { class: 'missing-note', title: 'Prerequisite missing from your record or plan' }, '! '),
    s === 'missing' ? 'Check with your advisor' : [unlocks ? `${unlocks} later` : '', it.transfer ? 'Transfer' : it.termLabel].filter(Boolean).join(' · ')));
}
function orCard(n) {
  return h('div', { class: 'tcard or' }, h('span', { class: 'top' }, h('span', { class: 'code' }, 'One of')),
    h('span', { class: 'alts' }, n.options.slice(0, 6).map(o => {
      const it = o.it || stub(o.code);
      return h('button', { type: 'button', class: `alt ${it.status}${o.code === n.pick ? ' pick' : ''}`, style: cardStyle(it), title: `${o.code} · ${CHIP[it.status]}`, onclick: () => detail(it, true) }, o.code);
    }), n.options.length > 6 && h('small', {}, `+${n.options.length - 6}`)));
}

// ---------- wiring ----------

function zoomChart() {
  const percent = +$('#chart-zoom').value, chart = $('#track .tree'), track = $('#track');
  if (chart) {
    const width = chart.offsetWidth * percent / 100, height = chart.offsetHeight * percent / 100;
    track.style.width = Math.ceil(width) + 'px';
    track.style.height = Math.ceil(height) + 'px';
    chart.style.transform = `scale(${percent / 100})`;
    chart.style.left = `calc(50% - ${width / 2}px)`;
    chart.style.top = `calc(50% - ${height / 2}px)`;
  }
  $('#chart-zoom-out').value = percent + '%';
}

function chartSpace() {
  const pane = $('#board'), css = getComputedStyle(pane);
  return { width: pane.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight),
    height: pane.clientHeight - parseFloat(css.paddingTop) - parseFloat(css.paddingBottom) };
}

function fitChart() {
  const chart = $('#track .tree');
  if (!chart) return;
  const size = chartSpace();
  $('#chart-zoom').value = Math.max(1, Math.floor(Math.min(1, size.width / chart.offsetWidth, size.height / chart.offsetHeight) * 100));
  zoomChart();
  $('#board').scrollLeft = $('#board').scrollTop = 0;
}

for (const id of ['layout-spacing', 'chart-zoom']) {
  const input = $('#' + id);
  input.value = store.get('flowworks:' + id) ?? input.defaultValue;
  const update = () => {
    $('#' + id + '-out').value = input.value + (id === 'chart-zoom' ? '%' : id === 'layout-spacing' ? ' px' : '');
    store.set('flowworks:' + id, input.value);
  };
  update();
  input.addEventListener('input', () => {
    update();
    if (id === 'chart-zoom') { fit = false; zoomChart(); }
    else board();
  });
}
// Auto is the default for existing users too; a manually chosen column count is remembered separately.
$('#layout-width').value = store.get('flowworks:columns') || 'auto';
if (!$('#layout-width').value) $('#layout-width').value = 'auto';
$('#layout-width').addEventListener('change', () => { store.set('flowworks:columns', $('#layout-width').value); board(); });
$('#fit-chart').addEventListener('click', () => {
  fit = true;
  board();
});
addEventListener('resize', () => model && !$('#chart').hidden && board());
document.fonts.ready.then(() => model && !$('#chart').hidden && board());

$('#detail').addEventListener('click', e => e.target === e.currentTarget && e.currentTarget.close());
$('#bm').addEventListener('click', e => { e.preventDefault(); toast('Drag this button to your bookmarks bar, then click it on your Degree Works page.'); });
$('#file').addEventListener('change', e => e.target.files[0] && importFile(e.target.files[0]));
addEventListener('dragover', e => e.preventDefault());
addEventListener('drop', e => { e.preventDefault(); e.dataTransfer.files[0] && importFile(e.dataTransfer.files[0]); });
addEventListener('hashchange', boot);

const range = $('#credits');
range.value = maxCredits;
$('#credits-out').value = maxCredits;
range.addEventListener('input', () => {
  maxCredits = +range.value;
  $('#credits-out').value = maxCredits;
  store.set('flowworks:credits', maxCredits);
  board();
});
$('#reset').addEventListener('click', () => {
  store.set('flowworks:data', null);
  history.replaceState(null, '', location.pathname);
  landing();
});

const pane = $('#board');
pane.addEventListener('pointerdown', e => {
  if (e.pointerType !== 'mouse' || e.button || e.target.closest('button, a, input, label, [role=button]')) return;
  const x = e.clientX, y = e.clientY, left = pane.scrollLeft, top = pane.scrollTop;
  pane.setPointerCapture(e.pointerId);
  pane.classList.add('grabbing');
  const move = ev => { pane.scrollLeft = left - (ev.clientX - x); pane.scrollTop = top - (ev.clientY - y); };
  pane.addEventListener('pointermove', move);
  pane.addEventListener('pointerup', () => { pane.removeEventListener('pointermove', move); pane.classList.remove('grabbing'); }, { once: true });
});

boot();
