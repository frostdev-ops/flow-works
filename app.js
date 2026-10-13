import { parseAudit, columns, analyze, layers, route, web, roadmap, courseTree } from './model.js';

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
const VIEWS = ['roadmap', 'web', 'timeline', 'graph'];
let view = VIEWS.includes(store.get('flowworks:viewmode')) ? store.get('flowworks:viewmode') : 'roadmap';
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

// ---------- roadmap view ----------

let RM;
const place = (el, row, col) => {
  el.style.gridRow = row;
  el.style.gridColumn = col;
  return el;
};
const pill = it => h('button', {
  type: 'button', class: 'pill', 'data-key': it.key, style: `--c:${color(it.group)}`,
  title: [it.code, it.title, it.grade && `Grade ${it.grade}`].filter(Boolean).join(' · '),
  onmouseenter: () => focusOn(it.key), onmouseleave: () => focusOn(null),
  onfocus: () => focusOn(it.key), onblur: () => focusOn(null), onclick: () => detail(it),
}, h('span', {}, it.code || it.title), it.grade && h('b', {}, it.grade));

// Polyline → path with rounded corners.
const rounded = (pts, r = 9) => pts.map((p, i) => {
  if (!i) return `M${p}`;
  if (i === pts.length - 1) return `L${p}`;
  const toward = (q, k) => {
    const d = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
    return [p[0] + ((q[0] - p[0]) * k) / d, p[1] + ((q[1] - p[1]) * k) / d];
  };
  const [a, n] = [pts[i - 1], pts[i + 1]];
  return `L${toward(a, Math.min(r, Math.hypot(p[0] - a[0], p[1] - a[1]) / 2))} Q${p} ${toward(n, Math.min(r, Math.hypot(n[0] - p[0], n[1] - p[1]) / 2))}`;
}).join(' ');

function roadmapView(intro, terms, grad, old) {
  const track = $('#track');
  RM = roadmap(terms, A.edges, model.groups.map(g => g.id));
  const { rows, lanes, cells } = RM, L = lanes.length, crit = new Set(A.critical);
  RM.chW = RM.tracksV.map(n => 22 + n * 7);
  const busy = l => rows.some((r, ri) => r.kind !== 'done' && cells[ri][l].length);
  const cur = rows.findIndex(r => r.kind === 'current'), mark = cur >= 0 ? cur : rows.findIndex(r => r.kind === 'future');
  $('#viewnote').textContent = 'Read top to bottom: what’s done, where you are, each term ahead, then graduation. Columns are requirement areas; lines are prerequisites still ahead.';
  track.classList.add('roadmap');
  track.style.gridTemplateColumns = ['minmax(92px, 124px)', ...lanes.flatMap((g, l) => [RM.chW[l] + 'px', busy(l) ? 'minmax(150px, 1fr)' : 'minmax(116px, .6fr)']), RM.chW[L] + 'px'].join(' ');
  track.style.gridTemplateRows = ['auto 6px', ...rows.map((r, i) => `auto ${i === rows.length - 1 ? 46 : 26 + RM.tracksH[i] * 7}px`), 'auto'].join(' ');

  const kids = [svg('svg', { class: 'edges', 'aria-hidden': 'true' })];
  lanes.forEach((id, l) => {
    const g = model.groups.find(x => x.id === id);
    kids.push(place(h('div', { class: 'lanehead', style: `--c:${color(id)}` }, h('span', { class: 'name', title: g.title }, g.title),
      h('span', { class: 'pc' }, g.pct == null ? '' : g.pct + '%'), g.pct != null && h('span', { class: 'meter' }, h('i', { style: `--w:${g.pct}%` }))), 1, 3 + 2 * l));
  });
  let cum = 0;
  rows.forEach((r, ri) => {
    const line = 3 + 2 * ri, cr = Math.round(r.items.reduce((n, it) => n + it.credits, 0) * 10) / 10;
    const transfer = r.terms?.[0] === 'Transfer credit', terms = (r.terms?.length || 0) - transfer;
    cum += cr;
    kids.push(place(h('div', { class: `rowband ${r.kind}` }), line, '1 / -1'));
    kids.push(place(h('div', { class: `rail ${r.kind}` },
      ri === mark && h('span', { class: 'you' }, h('i'), cur >= 0 ? 'You are here' : 'Next up'),
      h('span', { class: 'kind' }, r.kind === 'done' ? [transfer && 'Transfer', terms && plural(terms, 'term')].filter(Boolean).join(' + ') : KIND[r.kind]),
      h('strong', {}, r.label),
      h('span', { class: 'cr' }, `${cr} cr`),
      r.kind !== 'done' && h('span', { class: 'cum' }, `Total ${Math.round(cum)} / ${model.total}`)), line, 1));
    lanes.forEach((id, l) => kids.push(place(h('div', { class: 'cell' + (r.kind === 'done' ? ' pills' : '') }, cells[ri][l].map(it => {
      const el = r.kind === 'done' ? pill(it) : card(it, ri, crit);
      el.col = ri;
      return el;
    })), line, 3 + 2 * l)));
  });
  const end = 3 + 2 * rows.length;
  const cap = h('div', { class: 'cap', 'data-key': 'grad' }, h('div', { class: 'medal', 'aria-hidden': 'true' }), h('strong', {}, 'Graduate'), h('span', {}, `${grad} · ${model.total} credits`));
  cap.querySelector('.medal').append($('#cap-icon').content.cloneNode(true));
  kids.push(place(h('div', { class: 'rail grad' }, h('span', { class: 'kind' }, 'Goal'), h('strong', {}, 'Graduation')), end, 1));
  kids.push(place(h('div', { class: 'gradcell' }, cap), end, `3 / ${2 * L + 2}`));
  track.replaceChildren(...kids);

  // Hover tracing walks every prerequisite link, including the completed ones that aren't drawn.
  edges = [...A.edges, ...RM.routes.filter(r => r.to === 'grad')];
  let last = 0;
  if (!reduce) {
    for (const el of track.querySelectorAll('[data-key]')) {
      const o = old.get(el.dataset.key);
      if (o && !intro) {
        const n = el.getBoundingClientRect();
        if (o.left !== n.left || o.top !== n.top)
          el.animate([{ transform: `translate(${o.left - n.left}px,${o.top - n.top}px)` }, { transform: 'none' }], { duration: 700, easing: EASE });
      } else {
        const delay = intro ? (el.col ?? rows.length) * 130 + [...el.parentNode.children].indexOf(el) * 30 : 250;
        last = Math.max(last, delay);
        el.animate([{ opacity: 0, transform: 'translateY(-14px) scale(.97)' }, { opacity: 1, transform: 'none' }],
          { duration: el.dataset.key === 'grad' ? 900 : 520, delay, easing: el.dataset.key === 'grad' ? 'cubic-bezier(.3,1.6,.5,1)' : EASE, fill: 'backwards' });
      }
    }
    if (intro) track.querySelectorAll('.lanehead, .rail, .rowband').forEach(el =>
      el.animate([{ opacity: 0, transform: 'translateY(-8px)' }, { opacity: 1, transform: 'none' }],
        { duration: 500, delay: Math.max(0, (parseInt(el.style.gridRow) - 3) / 2) * 130, easing: EASE, fill: 'backwards' }));
  }
  drawn = '';
  requestAnimationFrame(() => roadmapEdges(intro ? last * 0.6 + 350 : 550));
}

function roadmapEdges(delay) {
  const track = $('#track'), lines = track.querySelector('.edges');
  if (!lines || !RM) return;
  drawn = track.scrollWidth + 'x' + track.scrollHeight;
  lines.setAttribute('width', track.scrollWidth);
  lines.setAttribute('height', track.scrollHeight);
  const box = el => {
    let x = 0, y = 0;
    for (let e = el; e && e !== track; e = e.offsetParent) { x += e.offsetLeft; y += e.offsetTop; }
    return { x, y, w: el.offsetWidth, h: el.offsetHeight };
  };
  const at = k => box(track.querySelector(`[data-key="${CSS.escape(k)}"]`));
  const heads = [...track.querySelectorAll('.lanehead')].map(box), rails = [...track.querySelectorAll('.rail')].map(box);
  const X = (c, t) => (c ? heads[c - 1].x + heads[c - 1].w : heads[0].x - RM.chW[0]) + RM.chW[c] / 2 + (t - (RM.tracksV[c] - 1) / 2) * 7;
  const gutter = r => (rails[r].y + rails[r].h + rails[r + 1].y) / 2;
  const Y = (r, t) => gutter(r) + (t - (RM.tracksH[r] - 1) / 2) * 7;
  const critLinks = new Set(A.critical.slice(1).map((k, i) => A.critical[i] + '>' + k));

  // Which side of each card a line leaves or enters; lines sharing a side fan out along it.
  const routes = RM.routes.map(r => {
    const a = RM.at[r.from], b = RM.at[r.to];
    return { ...r, sa: r.drop ? 'B' : r.x1 === a.l + 1 ? 'R' : 'L', sb: r.drop ? 'T' : b && ((r.x2 ?? r.x1) === b.l ? 'L' : 'R') };
  });
  const fan = {};
  for (const r of routes) {
    (fan[r.from + '|' + r.sa] ||= []).push(r);
    if (r.sb) (fan[r.to + '|' + r.sb] ||= []).push(r);
  }
  const spread = (key, side, r, b) => {
    const list = fan[key + '|' + side], o = (list.indexOf(r) - (list.length - 1) / 2) * 6;
    return Math.max(-(b.h / 2 - 8), Math.min(b.h / 2 - 8, o));
  };

  lines.replaceChildren(...routes.map((r, i) => {
    const A1 = at(r.from), to = r.to === 'grad' ? null : A.byKey[r.to];
    let pts;
    if (r.drop) {
      const B1 = at(r.to);
      pts = [[A1.x + A1.w / 2, A1.y + A1.h], [B1.x + B1.w / 2, B1.y]];
    } else {
      const ay = A1.y + A1.h / 2 + spread(r.from, r.sa, r, A1), x1 = X(r.x1, r.t1);
      pts = [[r.sa === 'R' ? A1.x + A1.w : A1.x, ay], [x1, ay]];
      if (!to) {
        const cap = at('grad'), gy = gutter(RM.rows.length - 1), mx = cap.x + cap.w / 2;
        pts.push([x1, gy], [mx, gy], [mx, cap.y]);
      } else {
        const B1 = at(r.to), by = B1.y + B1.h / 2 + spread(r.to, r.sb, r, B1);
        if (r.hop != null) {
          const y = Y(r.hop, r.th), x2 = X(r.x2, r.t2);
          pts.push([x1, y], [x2, y], [x2, by]);
        } else pts.push([x1, by]);
        pts.push([r.sb === 'L' ? B1.x : B1.x + B1.w, by]);
      }
    }
    const cls = !to ? 'tograd' : [to.status === 'planned' && 'planned', critLinks.has(r.from + '>' + r.to) && 'crit'].filter(Boolean).join(' ');
    const p = svg('path', { d: rounded(pts.map(q => q.map(v => Math.round(v * 10) / 10))), class: cls, style: `--c:${color((to || A.byKey[r.from]).group)}` });
    p.dataset.from = r.from;
    p.dataset.to = r.to;
    if (delay != null && !reduce) requestAnimationFrame(() => {
      const len = p.getTotalLength();
      p.animate([{ strokeDasharray: len, strokeDashoffset: len }, { strokeDasharray: len, strokeDashoffset: 0 }],
        { duration: 800, delay: delay + i * 14, easing: 'ease-out', fill: 'backwards' });
    });
    return p;
  }));
}

function board(first) {
  const track = $('#track'), switched = track.dataset.view !== view;
  track.dataset.view = view;
  const old = new Map([...track.querySelectorAll('[data-key]')].map(el => [el.dataset.key, el.getBoundingClientRect()]));
  const terms = columns(model, maxCredits);
  A = analyze(terms);
  const grad = stats(terms);
  insights();
  track.className = 'track';
  track.removeAttribute('style');
  if (view === 'roadmap') return roadmapView(first || switched, terms, grad, old);
  if (view === 'web') return webView(first || switched, terms, grad);
  track.classList.remove('web');

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

// ---------- web view ----------

const CAP = ['M12 3 1 8.5 12 14l9-4.5V16h2V8.5L12 3Z', 'M5.5 11.8V16c0 1.9 2.9 3.5 6.5 3.5s6.5-1.6 6.5-3.5v-4.2L12 15.1l-6.5-3.3Z'];
const short = (s, n = 18) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
const P = (r, t) => [+(r * Math.cos(t)).toFixed(1), +(r * Math.sin(t)).toFixed(1)];
const DEG = 180 / Math.PI, READ = -0.18; // READ: just above 3 o'clock, where labels read straight across
let webRot = null, spinToKey = () => {};

function webView(intro, terms, grad) {
  const track = $('#track');
  const gi = Object.fromEntries(model.groups.map((g, i) => [g.id, i]));
  const cols = terms.map(c => ({ ...c, items: [...c.items].sort((a, b) => gi[a.group] - gi[b.group] || (a.code || a.title).localeCompare(b.code || b.title)) }));
  const W = web(cols, A.edges), { R, hub } = W, RB = R + 182, S = R + 228;
  const crit = new Set(A.critical), critLinks = new Set(A.critical.slice(1).map((k, i) => A.critical[i] + '>' + k));
  const size = it => (it.status === 'done' ? 6 : 6.5 + Math.min(A.info[it.key]?.unlocks || 0, 6) * 1.3);
  const old = new Map([...track.querySelectorAll('.wnode')].map(g => [g.dataset.key, g.pos]));
  $('#viewnote').textContent = 'Drag to spin the wheel · click a course for its prerequisite chart · ← → step through courses · graduation is the hub';

  const root = svg('svg', { class: 'web', viewBox: `${-S - 80} ${-S} ${2 * S + 160} ${2 * S}`, role: 'group', 'aria-label': 'Degree web' });
  const defs = svg('defs'), lg = svg('linearGradient', { id: 'wg', x1: 0, y1: 0, x2: 1, y2: 1 });
  [['0', 'g0'], ['.55', 'g3'], ['1', 'g2']].forEach(([offset, g]) => lg.append(svg('stop', { offset, style: `stop-color:var(--${g})` })));
  defs.append(lg);

  // Everything on the wheel turns together inside `spin`; term labels and the hub stay upright outside it.
  const spin = svg('g', { class: 'spin' });
  const threads = svg('g', { class: 'threads' });
  for (let k = 0; k <= 4; k++) threads.append(svg('circle', { r: hub + ((R - hub) * k) / 4, pathLength: 100 }));
  for (const t of W.terms) {
    const [x1, y1] = P(hub, t.spoke), [x2, y2] = P(RB, t.spoke);
    threads.append(svg('line', { x1, y1, x2, y2, pathLength: 100 }));
  }
  const band = svg('g', { class: 'band' }), tlabels = svg('g', { class: 'tlabels' }), tl = [];
  for (const t of W.terms) {
    const mid = (t.a0 + t.a1) / 2;
    band.append(svg('path', { class: t.kind, pathLength: 100, d: `M${P(RB, t.a0)} A${RB},${RB} 0 ${t.a1 - t.a0 > Math.PI ? 1 : 0} 1 ${P(RB, t.a1)}` }));
    const label = svg('text', { class: 'tlabel ' + t.kind, tabindex: 0, role: 'button', 'aria-label': `Spin ${t.label || 'term'} into view` });
    label.textContent = t.label || '—';
    label.addEventListener('click', () => spinTo(READ - mid));
    label.addEventListener('keydown', e => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), spinTo(READ - mid)));
    tlabels.append(label);
    tl.push({ label, mid });
  }

  edges = A.edges.map((e, i) => ({
    ...e, lane: W.lane[i], group: A.byKey[e.to].group,
    cls: [A.byKey[e.to].status === 'planned' && 'planned', critLinks.has(e.from + '>' + e.to) && 'crit'].filter(Boolean).join(' '),
  }));
  for (const it of cols.at(-1)?.items || []) edges.push({ from: it.key, to: 'grad', group: it.group, cls: 'tograd' });
  const lines = svg('g', { class: 'wlines' });
  for (const e of edges) {
    const a = W.angle[e.from], ra = R - size(A.byKey[e.from]) - 3;
    let d;
    if (e.to === 'grad') d = `M${P(ra, a)} L${P(hub, a)}`;
    else {
      // Drop toward the hub on the course's own spoke, run clockwise on this link's lane, climb out to the target.
      const b = W.angle[e.to], rb = R - size(A.byKey[e.to]) - 3, r = e.lane;
      const f = Math.max(0, Math.min(12, (r * (b - a)) / 3, ra - r));
      d = `M${P(ra, a)} L${P(r + f, a)} Q${P(r, a)} ${P(r, a + f / r)} A${r},${r} 0 ${b - a - (2 * f) / r > Math.PI ? 1 : 0} 1 ${P(r, b - f / r)} Q${P(r, b)} ${P(r + f, b)} L${P(rb, b)}`;
    }
    const p = svg('path', { d, class: e.cls, style: `--c:${color(e.group)}` });
    p.dataset.from = e.from;
    p.dataset.to = e.to;
    lines.append(p);
  }

  // Each course owns a "pizza slice" from just outside the lanes to the term band: a big, visible click target.
  const wedge = {};
  cols.forEach((c, ci) => {
    const t = W.terms[ci], w = (t.a1 - t.a0) / Math.max(1, c.items.length);
    c.items.forEach((it, i) => (wedge[it.key] = [t.a0 + i * w, t.a0 + (i + 1) * w]));
  });
  const nodes = svg('g', { class: 'wnodes' }), placed = [];
  let pointerDown = false;
  for (const c of cols) for (const it of c.items) {
    const t = W.angle[it.key], [x, y] = P(R, t), r = size(it), info = A.info[it.key];
    const hot = info && (info.unlocks >= 2 || (crit.has(it.key) && info.unlocks > 0));
    const g = svg('g', {
      class: `wnode ${it.status}${it.options ? ' choice' : ''}${hot ? ' neck' : ''}${crit.has(it.key) ? ' crit' : ''}`,
      'data-key': it.key, transform: `translate(${x},${y})`, tabindex: 0, role: 'button', style: `--c:${color(it.group)}`,
      'aria-label': [it.code, it.title, STATUS[it.status], info?.unlocks && `unlocks ${info.unlocks}`].filter(Boolean).join(', '),
    });
    g.pos = [x, y];
    const inner = svg('g', { class: 'pop' }), tip = svg('title'), label = svg('text', { class: 'lbl', 'dominant-baseline': 'central' });
    const code = svg('tspan', { class: 'c' }), name = svg('tspan', { class: 't', dx: 5 });
    code.textContent = it.code || 'Choose';
    name.textContent = short(it.title);
    tip.textContent = [it.code, it.title, `${it.credits} cr`, STATUS[it.status]].filter(Boolean).join(' · ');
    label.append(code, name);
    const [w0, w1] = wedge[it.key], ri = R - 22, ro = RB - 10, off = ([px, py]) => `${(px - x).toFixed(1)},${(py - y).toFixed(1)}`;
    const slice = svg('path', { class: 'slice', d: `M${off(P(ro, w0))} A${ro},${ro} 0 0 1 ${off(P(ro, w1))} L${off(P(ri, w1))} A${ri},${ri} 0 0 0 ${off(P(ri, w0))}Z` });
    inner.append(tip, slice, svg('circle', { class: 'halo', r: r + 5 }), svg('circle', { class: 'dot', r }), label);
    g.append(inner);
    const i = placed.length;
    g.addEventListener('mouseenter', () => focusOn(it.key));
    g.addEventListener('mouseleave', () => focusOn(null));
    g.addEventListener('focus', () => { focusOn(it.key); if (!pointerDown) spinToKey(it.key); });
    g.addEventListener('blur', () => focusOn(null));
    g.addEventListener('click', () => { spinToKey(it.key); detail(it); });
    g.addEventListener('keydown', e => {
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (step) { e.preventDefault(); placed[(i + step + placed.length) % placed.length].g.focus(); }
      else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); detail(it); }
    });
    nodes.append(g);
    placed.push({ g, inner, label, t, x, y, r, right: null });
  }

  const medal = svg('g', { class: 'hubmedal', 'data-key': 'grad' }), cap = svg('g', { class: 'capicon', transform: 'translate(-17.4 -42) scale(1.45)' });
  CAP.forEach(d => cap.append(svg('path', { d })));
  const t1 = svg('text', { y: 12, class: 'm1' }), t2 = svg('text', { y: 31, class: 'm2' });
  t1.textContent = 'Graduate';
  t2.textContent = grad;
  medal.append(svg('circle', { class: 'halo', r: hub - 4 }), svg('circle', { class: 'disc', r: hub - 14 }), cap, t1, t2);

  // Turning: labels flip as they cross sides so text never reads upside down; term labels orbit upright.
  const applyRot = () => {
    spin.setAttribute('transform', `rotate(${(webRot * DEG).toFixed(2)})`);
    for (const n of placed) {
      const right = Math.cos(n.t + webRot) >= 0;
      if (right === n.right) continue;
      n.right = right;
      n.label.setAttribute('transform', `rotate(${(n.t * DEG + (right ? 0 : 180)).toFixed(2)})`);
      n.label.setAttribute('x', right ? n.r + 7 : -(n.r + 7));
      n.label.setAttribute('text-anchor', right ? 'start' : 'end');
    }
    for (const { label, mid } of tl) {
      const a = mid + webRot, c = Math.cos(a), s = Math.sin(a), [x, y] = P(RB + 16, a);
      label.setAttribute('x', x);
      label.setAttribute('y', y);
      label.setAttribute('text-anchor', c > 0.25 ? 'start' : c < -0.25 ? 'end' : 'middle');
      label.setAttribute('dominant-baseline', s > 0.25 ? 'hanging' : s < -0.25 ? 'auto' : 'central');
    }
  };
  let raf = 0;
  const halt = () => cancelAnimationFrame(raf);
  const spinTo = (target, dur = 900) => {
    halt();
    const from = webRot, delta = Math.atan2(Math.sin(target - from), Math.cos(target - from));
    if (reduce || Math.abs(delta) < 0.002) { webRot = from + delta; return applyRot(); }
    const t0 = performance.now();
    const step = now => {
      const k = Math.min(1, (now - t0) / dur), e = k < 0.5 ? 4 * k ** 3 : 1 - (-2 * k + 2) ** 3 / 2;
      webRot = from + delta * e;
      applyRot();
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  };
  spinToKey = key => W.angle[key] != null && spinTo(READ - W.angle[key]);
  const now = W.terms.find(t => t.kind === 'current') || W.terms.find(t => t.kind === 'future');
  const home = now ? -Math.PI / 3 - (now.a0 + now.a1) / 2 : 0; // current term at 2 o'clock, what's next sweeps down the right

  // Drag to spin, with momentum on release.
  let drag = null;
  root.addEventListener('pointerdown', e => {
    if (e.button) return;
    halt();
    pointerDown = true;
    const b = root.getBoundingClientRect(), cx = b.left + b.width / 2, cy = b.top + b.height / 2;
    drag = { cx, cy, x: e.clientX, y: e.clientY, a: Math.atan2(e.clientY - cy, e.clientX - cx), t: e.timeStamp, v: 0, moved: false, id: e.pointerId };
  });
  root.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return;
    if (!(e.buttons & 1)) return release(e); // button came up somewhere we didn't hear about: never stay stuck to the cursor
    if (!drag.moved) {
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 5) return;
      drag.moved = true;
      root.setPointerCapture(e.pointerId);
      root.classList.add('spinning');
    }
    const a = Math.atan2(e.clientY - drag.cy, e.clientX - drag.cx), da = Math.atan2(Math.sin(a - drag.a), Math.cos(a - drag.a));
    drag.v = 0.7 * (da / Math.max(1, e.timeStamp - drag.t)) + 0.3 * drag.v;
    drag.a = a;
    drag.t = e.timeStamp;
    webRot += da;
    applyRot();
  });
  const release = e => {
    if (!drag || e.pointerId !== drag.id) return;
    let { moved, v } = drag;
    drag = null;
    pointerDown = false;
    root.classList.remove('spinning');
    if (!moved || reduce || Math.abs(v) < 0.0002) return;
    let last = performance.now();
    const coast = t => {
      const dt = t - last;
      last = t;
      webRot += v * dt;
      v *= 0.995 ** dt;
      applyRot();
      if (Math.abs(v) > 0.00004) raf = requestAnimationFrame(coast);
    };
    raf = requestAnimationFrame(coast);
  };
  root.addEventListener('pointerup', release);
  root.addEventListener('pointercancel', release);
  root.addEventListener('lostpointercapture', release);

  spin.append(threads, band, lines, nodes);
  root.append(defs, spin, tlabels, medal);
  const ctl = h('div', { class: 'webctl' },
    h('button', { type: 'button', class: 'btn ghost', onclick: () => spinTo(home, 1100) }, 'Spin to now'),
    h('button', { type: 'button', class: 'btn ghost', onclick: () => spinTo(0, 1100) }, 'Reset'));
  track.classList.add('web');
  track.replaceChildren(ctl, root);
  drawn = '';
  const first = webRot == null;
  if (first) webRot = reduce ? home : 0;
  applyRot();
  if (reduce) return;

  const n = placed.length, wave = 300 + n * 22;
  if (intro) {
    threads.querySelectorAll('circle, line').forEach((el, i) => el.animate([{ strokeDasharray: 100, strokeDashoffset: 100 }, { strokeDasharray: 100, strokeDashoffset: 0 }], { duration: 1200, delay: i * 35, easing: 'ease-out', fill: 'backwards' }));
    band.querySelectorAll('path').forEach((el, i) => el.animate([{ strokeDasharray: 100, strokeDashoffset: 100 }, { strokeDasharray: 100, strokeDashoffset: 0 }], { duration: 700, delay: 300 + (wave - 300) * (i / W.terms.length), easing: EASE, fill: 'backwards' }));
    tlabels.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 800, delay: 300, fill: 'backwards' });
    placed.forEach(({ inner, t }, i) => inner.animate([{ opacity: 0, transform: `translate(${-Math.cos(t) * 30}px,${-Math.sin(t) * 30}px)` }, { opacity: 1, transform: 'none' }], { duration: 650, delay: 300 + i * 22, easing: EASE, fill: 'backwards' }));
    lines.querySelectorAll('path').forEach((p, i) => {
      const len = p.getTotalLength();
      p.animate([{ strokeDasharray: len, strokeDashoffset: len }, { strokeDasharray: len, strokeDashoffset: 0 }], { duration: 1000, delay: wave + i * 16, easing: 'ease-out', fill: 'backwards' });
    });
    medal.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 600, delay: wave + 200, fill: 'backwards' });
    medal.querySelector('.disc').animate([{ transform: 'scale(.3)' }, { transform: 'none' }], { duration: 1000, delay: wave + 200, easing: 'cubic-bezier(.3,1.6,.5,1)', fill: 'backwards' });
    if (first) setTimeout(() => spinTo(home, 1800), wave + 500); // the wheel turns your current term into reading position
  } else {
    for (const { g, inner, x, y } of placed) {
      const o = old.get(g.dataset.key);
      inner.animate(o ? [{ transform: `translate(${o[0] - x}px,${o[1] - y}px)` }, { transform: 'none' }] : [{ opacity: 0 }, { opacity: 1 }], { duration: 750, easing: EASE, fill: 'backwards' });
    }
    lines.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 400, delay: 550, fill: 'backwards' });
  }
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

// ---------- course modal: prerequisite flowchart ----------

const TW = 200, TH = 86, TGX = 20, TGY = 56; // tree card size and gaps
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
  d.replaceChildren(h('form', { method: 'dialog', class: 'course', style: `--c:${color(it.group)}` },
    h('button', { class: 'x', 'aria-label': 'Close' }, '×'),
    trail.length > 1 && h('nav', { class: 'trail', 'aria-label': 'Courses you opened' },
      trail.slice(0, -1).map((t, i) => [back(t, i), h('span', { 'aria-hidden': 'true' }, '›')]), h('b', {}, it.code || short(it.title, 24))),
    h('p', { class: 'eyebrow' }, it.block),
    h('h3', {}, it.title),
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

function tree(T, rootIt) {
  const xs = T.nodes.map(n => n.x), lv = T.nodes.map(n => n.level);
  const minX = Math.min(...xs), minL = Math.min(...lv);
  const Wd = (Math.max(...xs) - minX + 1) * (TW + TGX) - TGX, Ht = (Math.max(...lv) - minL + 1) * (TH + TGY) - TGY;
  const at = n => [(n.x - minX) * (TW + TGX), (n.level - minL) * (TH + TGY)];
  const box = h('div', { class: 'tree', style: `width:${Wd}px;height:${Ht}px` });
  const lines = svg('svg', { class: 'tree-lines', width: Wd, height: Ht, 'aria-hidden': 'true' });
  const state = n => n.kind === 'or' ? (n.options.find(o => o.code === n.pick)?.it?.status || 'missing') : n.it?.status || 'missing';
  const ring = n => Math.abs(n.level);
  T.links.forEach(([up, down]) => {
    // Links only join adjacent rows, so each curve lives in the gap between two rows and never crosses a card.
    const [x1, y1] = at(up), [x2, y2] = at(down), ax = x1 + TW / 2, ay = y1 + TH, bx = x2 + TW / 2, m = (ay + y2) / 2;
    const p = svg('path', { d: `M${ax},${ay} C${ax},${m} ${bx},${m} ${bx},${y2}`, class: state(up) === 'missing' ? 'miss' : state(down) === 'planned' ? 'planned' : '',
      style: `--c:${color((up.it || up.options?.find(o => o.code === up.pick)?.it || {}).group)}` });
    lines.append(p);
    if (!reduce) requestAnimationFrame(() => {
      const len = p.getTotalLength();
      const k = up.level < 0 ? ring(up) : ring(down);
      p.animate([{ strokeDasharray: len, strokeDashoffset: len }, { strokeDasharray: len, strokeDashoffset: 0 }],
        { duration: 500, delay: 80 + k * 140, easing: 'ease-out', fill: 'backwards' });
    });
  });
  box.append(lines);
  for (const n of T.nodes) {
    const [x, y] = at(n), el = n.kind === 'or' ? orCard(n) : courseCard(n, n.level === 0);
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    if (n.more) el.append(h('span', { class: 'more ' + (n.level < 0 ? 'up' : 'down') }, `+${n.more} more`));
    box.append(el);
    if (!reduce) el.animate(n.level === 0
      ? [{ opacity: 0, transform: 'scale(.92)' }, { opacity: 1, transform: 'none' }]
      : [{ opacity: 0, transform: `translateY(${n.level < 0 ? 14 : -14}px)` }, { opacity: 1, transform: 'none' }],
    { duration: 450, delay: ring(n) * 140, easing: EASE, fill: 'backwards' });
  }
  return box;
}

const CHIP = { done: '✓ Done', current: 'Now', registered: 'Registered', planned: 'Planned', missing: 'Missing' };
function courseCard(n, isRoot) {
  const it = n.it || stub(n.code), s = it.status;
  return h('button', {
    type: 'button', class: `tcard ${s}${isRoot ? ' root' : ''}${A.critical.includes(it.key) ? ' crit' : ''}`, style: `--c:${color(it.group)}`,
    onclick: isRoot ? null : () => detail(it, true), 'aria-label': `${it.code || ''} ${it.title}`,
  }, h('span', { class: 'top' }, h('span', { class: 'code' }, it.code || 'Choose'), h('span', { class: 'chip ' + s }, CHIP[s] || s)),
  h('span', { class: 'title' }, s === 'missing' ? 'Not on your record or plan' : it.title),
  h('span', { class: 'meta' }, s === 'missing' ? 'Check with your advisor' : [it.credits && `${it.credits} cr`, it.transfer ? 'Transfer' : it.termLabel].filter(Boolean).join(' · ')));
}
function orCard(n) {
  return h('div', { class: 'tcard or' }, h('span', { class: 'top' }, h('span', { class: 'code' }, 'One of')),
    h('span', { class: 'alts' }, n.options.slice(0, 6).map(o => {
      const it = o.it || stub(o.code);
      return h('button', { type: 'button', class: `alt ${it.status}${o.code === n.pick ? ' pick' : ''}`, style: `--c:${color(it.group)}`, title: `${o.code} · ${CHIP[it.status]}`, onclick: () => detail(it, true) }, o.code);
    }), n.options.length > 6 && h('small', {}, `+${n.options.length - 6}`)));
}

// ---------- wiring ----------

$('#detail').addEventListener('click', e => e.target === e.currentTarget && e.currentTarget.close());
$('#detail').addEventListener('close', () => view === 'web' && trail.at(-1)?.key && spinToKey(trail.at(-1).key));
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
    store.set('flowworks:viewmode', view);
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
  if (e.pointerType !== 'mouse' || e.button || e.target.closest('button, a, input, label, [role=button], .cap, .web, .webctl')) return;
  const x = e.clientX, left = pane.scrollLeft;
  pane.setPointerCapture(e.pointerId);
  pane.classList.add('grabbing');
  const move = ev => (pane.scrollLeft = left - (ev.clientX - x));
  pane.addEventListener('pointermove', move);
  pane.addEventListener('pointerup', () => { pane.removeEventListener('pointermove', move); pane.classList.remove('grabbing'); }, { once: true });
});
new ResizeObserver(() => {
  const t = $('#track');
  if (drawn && drawn !== t.scrollWidth + 'x' + t.scrollHeight) (view === 'roadmap' ? roadmapEdges : drawEdges)();
}).observe($('#track'));

boot();
