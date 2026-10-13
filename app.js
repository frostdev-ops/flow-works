import { parseAudit, columns, analyze, layers, route } from './model.js';

const $ = s => document.querySelector(s);
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const EASE = 'cubic-bezier(.2,.8,.2,1)';
const KIND = { transfer: 'Transfer', past: 'Completed', current: 'In progress', future: 'Planned', layer: 'Prerequisite depth' };
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

let model, A, edges = [], drawn = '', maxCredits = +store.get('flowworks:credits') || 15;
let view = store.get('flowworks:view') === 'graph' ? 'graph' : 'timeline';
const color = g => {
  const i = model.groups.findIndex(x => x.id === g);
  return g === 'free' || i < 0 ? 'var(--gfree)' : `var(--g${i % 8})`;
};

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
  summary();
  board(true);
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

const TIP = {
  met: 'Taken earlier in this chart',
  miss: 'Not on your record or in the plan. Check with your advisor.',
  past: 'Not in this chart; may be met by placement, transfer or waiver',
};
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

function card(it, col, crit) {
  const choice = !!it.options, info = A.info[it.key], needs = A.needs[it.key] || [];
  const hot = info && (info.unlocks >= 2 || (crit.has(it.key) && info.unlocks > 0));
  const badge = it.status === 'done' && it.grade ? h('b', { class: 'badge grade' }, it.grade)
    : it.status === 'current' ? h('span', { class: 'badge live' }, h('i'), 'Now')
    : it.status === 'registered' ? h('span', { class: 'badge' }, 'Registered')
    : choice && it.options.length > 1 ? h('span', { class: 'badge' }, `${it.options.length} options`)
    : null;
  const el = h('button', {
    type: 'button', 'data-key': it.key, style: `--c:${color(it.group)}`,
    class: `card ${it.status}${choice ? ' choice' : ''}${hot ? ' neck' : ''}${crit.has(it.key) ? ' crit' : ''}`,
    onmouseenter: () => focusOn(it.key), onmouseleave: () => focusOn(null),
    onfocus: () => focusOn(it.key), onblur: () => focusOn(null), onclick: () => detail(it),
  },
  h('span', { class: 'top' }, h('span', { class: 'code' }, it.code || (choice ? 'Choose' : '')), badge),
  h('span', { class: 'title' }, it.title),
  h('span', { class: 'meta' }, `${it.credits} cr · ${it.block}`),
  needs.length > 0 && h('span', { class: 'needs' }, h('small', {}, 'Needs'),
    needs.map(n => h('span', { class: 'req ' + n.state, title: TIP[n.state] }, n.codes.join(' / ')))),
  info?.unlocks > 0 && h('span', { class: 'unlocks' + (hot ? ' hot' : '') }, h('i'), `Unlocks ${plural(info.unlocks, 'course')}`,
    crit.has(it.key) && h('em', {}, 'critical')));
  el.col = col;
  return el;
}

function board(first) {
  const track = $('#track');
  const old = new Map([...track.querySelectorAll('[data-key]')].map(el => [el.dataset.key, el.getBoundingClientRect()]));
  const terms = columns(model, maxCredits);
  A = analyze(terms);
  const grad = stats(terms);
  insights();

  const graph = view === 'graph';
  const cols = graph
    ? layers(A).map((items, i) => ({ label: `Level ${i + 1}`, kind: 'layer', items, note: plural(items.length, 'course') }))
    : terms.map(c => ({ ...c, note: `${c.credits} cr` }));
  const R = route(cols.map(c => c.items), A.edges), feeds = new Set(A.edges.map(e => e.from));
  const crit = new Set(A.critical), critLinks = new Set(A.critical.slice(1).map((k, i) => A.critical[i] + '>' + k));
  const shown = cols.reduce((n, c) => n + c.items.length, 0), all = terms.reduce((n, c) => n + c.items.length, 0);
  $('#viewnote').textContent = graph
    ? `Each column needs something to its left. ${all - shown ? plural(all - shown, 'course') + ' with no prerequisite links hidden.' : ''}`
    : 'Hover a course to trace its prerequisites · click for details · drag to pan';

  const node = ci => x => (x.via ? h('i', { class: 'via', 'data-via': x.key }) : card(x, ci, crit));
  const colEls = cols.map((c, ci) => {
    const head = h('header', {}, h('span', { class: 'kind' }, KIND[c.kind]), h('h2', {}, c.label || '—'), h('span', { class: 'cr' }, c.note));
    const entries = R.cols[ci];
    // A long first column splits in two; courses that feed later ones go on the right so their lines cross no card.
    if (ci === 0 && entries.length > 8) return h('section', { class: `col ${c.kind} wide` }, head,
      h('div', { class: 'stack' }, entries.filter(x => !feeds.has(x.key)).map(node(ci))),
      h('div', { class: 'stack' }, entries.filter(x => feeds.has(x.key)).map(node(ci))));
    return h('section', { class: `col ${c.kind}` }, head, ...entries.map(node(ci)));
  });
  const tail = [];
  if (!graph) {
    const cap = h('div', { class: 'cap', 'data-key': 'grad' }, h('div', { class: 'medal', 'aria-hidden': 'true' }), h('strong', {}, 'Graduate'), h('span', {}, grad));
    cap.querySelector('.medal').append($('#cap-icon').content.cloneNode(true));
    tail.push(h('section', { class: 'col grad' }, cap));
  } else if (!cols.length) tail.push(h('p', { class: 'empty' }, 'This audit came without prerequisite data, so there are no links to draw. Use the bookmarklet to include them.'));
  track.replaceChildren(svg('svg', { class: 'edges', 'aria-hidden': 'true' }), ...colEls, ...tail);

  edges = A.edges.map((e, i) => ({
    ...e, path: R.paths[i], group: A.byKey[e.to].group,
    cls: [A.byKey[e.to].status === 'planned' && 'planned', critLinks.has(e.from + '>' + e.to) && 'crit'].filter(Boolean).join(' '),
  }));
  if (!graph) for (const it of terms.at(-1)?.items || []) edges.push({ from: it.key, to: 'grad', path: [it.key, 'grad'], group: it.group, cls: 'tograd' });

  let last = 0;
  if (!reduce) for (const el of track.querySelectorAll('[data-key]')) {
    const o = old.get(el.dataset.key);
    if (o && !first) {
      const n = el.getBoundingClientRect();
      if (o.left !== n.left || o.top !== n.top)
        el.animate([{ transform: `translate(${o.left - n.left}px,${o.top - n.top}px)` }, { transform: 'none' }], { duration: 700, easing: EASE });
    } else {
      const i = [...el.parentNode.children].indexOf(el);
      const delay = first ? (el.col ?? cols.length) * 110 + i * 35 : 250;
      last = Math.max(last, delay);
      el.animate([{ opacity: 0, transform: 'translateY(16px) scale(.97)' }, { opacity: 1, transform: 'none' }],
        { duration: el.dataset.key === 'grad' ? 900 : 520, delay, easing: el.dataset.key === 'grad' ? 'cubic-bezier(.3,1.6,.5,1)' : EASE, fill: 'backwards' });
    }
  }
  if (first && !reduce) track.querySelectorAll('.col > header').forEach((el, i) =>
    el.animate([{ opacity: 0, transform: 'translateX(-10px)' }], { duration: 500, delay: i * 110, easing: EASE, fill: 'backwards' }));
  drawn = '';
  requestAnimationFrame(() => drawEdges(first ? last * 0.6 + 300 : 500));
}

function drawEdges(delay) {
  const track = $('#track'), lines = track.querySelector('.edges');
  if (!lines) return;
  drawn = track.scrollWidth + 'x' + track.scrollHeight;
  lines.setAttribute('width', track.scrollWidth);
  lines.setAttribute('height', track.scrollHeight);
  const el = k => track.querySelector(`[data-key="${CSS.escape(k)}"], [data-via="${CSS.escape(k)}"]`);
  lines.replaceChildren(...edges.map((e, i) => {
    const nodes = e.path.map(el);
    if (nodes.some(n => !n)) return '';
    // Curves bend only in the gutters between columns; inside a column the line runs straight through its via gap.
    const [a, ...rest] = nodes, b = rest.pop();
    let x = a.offsetLeft + a.offsetWidth, y = a.offsetTop + a.offsetHeight / 2, d = `M${x},${y}`;
    const to = (x2, y2) => { const dx = (x2 - x) / 2; d += ` C${x + dx},${y} ${x2 - dx},${y2} ${x2},${y2}`; };
    for (const v of rest) {
      const vy = v.offsetTop + v.offsetHeight / 2;
      to(v.offsetLeft, vy);
      x = v.offsetLeft + v.offsetWidth;
      y = vy;
      d += ` L${x},${y}`;
    }
    to(b.offsetLeft, b.offsetTop + (e.to === 'grad' ? 60 : b.offsetHeight / 2));
    const p = svg('path', { d, class: e.cls, style: `--c:${color(e.group)}` });
    p.dataset.from = e.from;
    p.dataset.to = e.to;
    if (delay != null && !reduce) {
      requestAnimationFrame(() => {
        const len = p.getTotalLength();
        p.animate([{ strokeDasharray: len, strokeDashoffset: len }, { strokeDasharray: len, strokeDashoffset: 0 }],
          { duration: 800, delay: delay + i * 14, easing: 'ease-out', fill: 'backwards' });
      });
    }
    return p;
  }));
}

// ---------- insights: critical path, bottlenecks, missing prereqs ----------

function jump(key) {
  const el = $(`#track [data-key="${CSS.escape(key)}"]`);
  if (!el) return toast('That course is hidden in this view.');
  el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center', inline: 'center' });
  el.focus({ preventScroll: true });
}
const chip = (it, extra) => h('button', { type: 'button', class: 'chip', style: `--c:${color(it.group)}`, onclick: () => jump(it.key) }, it.code || it.title, extra);

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
  const track = $('#track');
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

function detail(it) {
  const d = $('#detail'), info = A.info[it.key], needs = A.needs[it.key] || [];
  const kids = A.edges.filter(e => e.from === it.key).map(e => A.byKey[e.to]);
  const crit = A.critical.includes(it.key);
  d.replaceChildren(h('form', { method: 'dialog', style: `--c:${color(it.group)}` },
    h('button', { class: 'x', 'aria-label': 'Close' }, '×'),
    h('p', { class: 'eyebrow' }, it.block),
    h('h3', {}, it.title),
    h('p', { class: 'meta' }, [it.code, `${it.credits} credits`, STATUS[it.status], it.status === 'done' && it.grade && `Grade ${it.grade}`,
      it.transfer ? 'Transfer' : it.termLabel].filter(Boolean).join(' · ')),
    crit && h('p', { class: 'flag' }, 'On your critical path: delaying this delays graduation.'),
    needs.length > 0 && h('section', {}, h('h4', {}, 'Prerequisites'),
      h('ul', { class: 'pre' }, needs.map(n => h('li', { class: n.state, title: TIP[n.state] }, n.codes.join(' or '), n.state === 'miss' && h('small', {}, ' · not on your record or plan'))))),
    kids.length > 0 && h('section', {}, h('h4', {}, `Required by ${plural(kids.length, 'course')}${info?.unlocks > kids.length ? ` · unlocks ${info.unlocks} in total` : ''}`),
      h('ul', { class: 'pre' }, kids.map(k => h('li', {}, [k.code, k.title].filter(Boolean).join(' · '))))),
    it.options && h('section', {}, h('h4', {}, it.options.length > 1 ? `Pick from ${it.options.length} options` : 'Requirement'),
      h('ul', { class: 'opts' }, it.options.slice(0, 80).map(o => h('li', {}, o)))),
    it.status === 'planned' && h('p', { class: 'note' }, 'Planned term is a suggestion. Confirm with your advisor before registering.')));
  d.showModal();
}

// ---------- wiring ----------

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
  board(false);
});
document.querySelectorAll('[name=view]').forEach(r => {
  r.checked = r.value === view;
  r.addEventListener('change', () => {
    view = r.value;
    store.set('flowworks:view', view);
    board(false);
  });
});
$('#reset').addEventListener('click', () => {
  store.set('flowworks:data', null);
  history.replaceState(null, '', location.pathname);
  landing();
});

const pane = $('#board');
pane.addEventListener('pointerdown', e => {
  if (e.pointerType !== 'mouse' || e.button || e.target.closest('.card, .cap')) return;
  const x = e.clientX, left = pane.scrollLeft;
  pane.setPointerCapture(e.pointerId);
  pane.classList.add('grabbing');
  const move = ev => (pane.scrollLeft = left - (ev.clientX - x));
  pane.addEventListener('pointermove', move);
  pane.addEventListener('pointerup', () => { pane.removeEventListener('pointermove', move); pane.classList.remove('grabbing'); }, { once: true });
});
new ResizeObserver(() => {
  const t = $('#track');
  if (drawn && drawn !== t.scrollWidth + 'x' + t.scrollHeight) drawEdges();
}).observe($('#track'));

boot();
