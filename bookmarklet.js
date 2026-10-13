// Flow-works bookmarklet. Click it on your Degree Works worksheet: it re-reads the audit you're viewing
// (same origin, your own session), looks up prerequisites, and opens Flow-works with the data in the URL #hash.
// The hash never leaves your browser; nothing is sent to any server. app.js swaps __APP__ for the site URL.
void (async () => {
  const APP = '__APP__';
  try {
    const hits = performance.getEntriesByType('resource').map(e => e.name).filter(n => /\/api\/audit\?/.test(n));
    if (!hits.length) throw Error('Open your Degree Works worksheet first (wait for it to load), then click Flow-works again.');
    const url = hits.at(-1), base = url.slice(0, url.indexOf('/api/'));
    const get = u => fetch(u, { credentials: 'include' }).then(r => {
      if (!r.ok) throw Error('Degree Works answered ' + r.status + '. Try reloading the worksheet.');
      return r.json();
    });
    const audit = await get(url);
    if (audit.auditHeader) {
      delete audit.auditHeader.studentId;
      delete audit.auditHeader.studentEmail;
    }

    const codes = new Set();
    (function walk(rules) {
      for (const r of rules || []) {
        const opts = r.advice?.courseArray || [];
        if (opts.length <= 4) for (const c of opts)
          if (!/@/.test(c.discipline + c.number) && c.prerequisiteExists !== 'N') codes.add(c.discipline + ' ' + c.number);
        walk(r.ruleArray);
      }
    })((audit.blockArray || []).flatMap(b => b.ruleArray || []));
    for (const c of audit.classInformation?.classArray || [])
      if (!/@/.test(c.discipline + c.number)) codes.add(c.discipline + ' ' + c.number);

    const prereqs = {}, queue = [...codes].slice(0, 120);
    await Promise.all(Array.from({ length: 6 }, async () => {
      for (let code; (code = queue.shift());) {
        const [d, n] = code.split(' ');
        try {
          const j = await get(`${base}/api/course-link?discipline=${encodeURIComponent(d)}&number=${encodeURIComponent(n)}&`);
          const p = j.courseInformation?.courses?.[0]?.prerequisites || [];
          if (p.length) prereqs[code] = p.map(x => [x.connector || '', x.subjectCodePrerequisite || '', x.courseNumberPrerequisite || '']);
        } catch {}
      }
    }));

    const packed = new Blob([JSON.stringify({ v: 1, audit, prereqs })]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    const bytes = new Uint8Array(await new Response(packed).arrayBuffer());
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    const dest = APP + '#d=' + btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    if (!window.open(dest, '_blank')) location.href = dest;
  } catch (e) {
    alert('Flow-works: ' + e.message);
  }
})();
