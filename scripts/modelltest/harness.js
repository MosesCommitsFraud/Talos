// Model test harness: runs the questions of plan.json against one model, in a
// Talos browser tab where an admin is logged in. Paste this file into the
// page's console (or run it through a browser automation tool), then:
//
//   MT.loadPlan(<contents of plan.json>)
//   MT.start({ ep: '<endpoint id>', model: '<served model name>', tag: 'K2' })
//
// It creates one chat per question and run, named "Modelltest <tag> <id> L<run>",
// sends the question and its follow-ups with the switches from the plan, and
// keeps the session id, the metrics row and each turn's stop reason in
// localStorage (mt_results), so a reload loses nothing: load the file again and
// call MT.start with the same arguments, finished runs are skipped.
//
//   MT.status()         progress and the last log lines
//   MT.batch(max)       questions, tool calls and answers of ungraded runs
//   MT.graded([keys])   mark runs as graded, MT.batch leaves them out
//   MT.exportLines()    one line per finished run for write_results.py
//
// It sends no login data and stores none. The test chats stay in Talos.

window.MT = {
  cfg: { ep: '', model: '', tag: 'test', runs: [1, 2, 3], effort: 'low' },
  stop: false,
  running: false,
  passes: 0,

  get(key, fallback) {
    return JSON.parse(localStorage.getItem(key) || fallback);
  },
  log(text) {
    const lines = this.get('mt_log', '[]');
    lines.push(new Date().toISOString().slice(5, 19) + ' ' + text);
    localStorage.setItem('mt_log', JSON.stringify(lines.slice(-300)));
  },
  results() {
    return this.get('mt_results', '{}');
  },
  save(key, value) {
    const all = this.results();
    all[key] = value;
    localStorage.setItem('mt_results', JSON.stringify(all));
  },
  loadPlan(plan) {
    localStorage.setItem('mt_plan', JSON.stringify(plan));
    return plan.length;
  },
  // Empties results, grading marks and the log. The plan stays.
  reset() {
    for (const key of ['mt_results', 'mt_graded', 'mt_log']) localStorage.removeItem(key);
  },

  async createSession(name) {
    const form = new FormData();
    form.set('name', name);
    form.set('endpoint_id', this.cfg.ep);
    form.set('model', this.cfg.model);
    const res = await fetch('/api/session', { method: 'POST', body: form });
    if (!res.ok) throw new Error('createSession ' + res.status);
    const session = await res.json();
    return session.id || session.session_id;
  },
  // The attachment of the questions flagged "attach": three months, two products.
  async upload() {
    const csv =
      'month,product,units,revenue\n2026-01,Widget,120,2400\n2026-01,Gadget,80,3200\n' +
      '2026-02,Widget,150,3000\n2026-02,Gadget,95,3800\n2026-03,Widget,90,1800\n2026-03,Gadget,140,5600\n';
    const form = new FormData();
    form.append('files', new File([csv], 'sales.csv', { type: 'text/csv' }), 'sales.csv');
    const out = await (await fetch('/api/upload', { method: 'POST', body: form })).json();
    return (out.files || []).map((f) => f.id);
  },
  // A turn runs detached on the server; 404 means it is over. Gives up after an hour.
  async waitIdle(sid) {
    for (let i = 0; i < 720; i++) {
      const res = await fetch('/api/chat/stream_status/' + sid);
      if (res.status === 404) return true;
      await new Promise((done) => setTimeout(done, 5000));
    }
    return false;
  },
  async turn(sid, message, flags, attachments) {
    const form = new FormData();
    form.set('message', message);
    form.set('session', sid);
    form.set('use_rag', flags.rag ? 'true' : 'false');
    form.set('use_db', flags.db ? 'true' : 'false');
    if (!flags.web) form.set('use_web', 'false');
    form.set('reasoning_effort', this.cfg.effort);
    if (flags.deep) form.set('deep_research', 'true');
    form.set('lang', 'de');
    if (attachments && attachments.length) form.set('attachments', JSON.stringify(attachments));
    const res = await fetch('/api/chat_stream', {
      method: 'POST',
      body: form,
      headers: {
        'X-Tz-Offset': String(-new Date().getTimezoneOffset()),
        'X-Tz-Name': Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
    });
    if (!res.ok) throw new Error('chat ' + res.status);
    const reader = res.body.getReader();
    while (!(await reader.read()).done);
    await this.waitIdle(sid);
  },
  // Why each turn ended, in order: "" for a normal end, otherwise the stop
  // reason Talos saved (rounds_exhausted = the configured step limit, ...).
  async stops(sid) {
    const history = (await (await fetch('/api/history/' + sid)).json()).history;
    return history
      .filter((m) => m.role === 'assistant')
      .map((m) => (m.metadata || {}).stop_reason || '');
  },
  totalRow(csv) {
    return (csv.split('\r\n').filter((line) => line.startsWith('Gesamt'))[0] || '').split(',');
  },

  async runOne(item, run) {
    // After a server restart the login can be gone: wait for it instead of failing every run.
    for (let i = 0; i < 360; i++) {
      try {
        const res = await fetch('/api/auth/status');
        if (res.ok && (await res.json()).authenticated) break;
      } catch (e) {
        /* server down, keep waiting */
      }
      if (i === 0) this.log('waiting for server');
      await new Promise((done) => setTimeout(done, 10000));
    }
    const key = item.id + '|' + run;
    const sid = await this.createSession('Modelltest ' + this.cfg.tag + ' ' + item.id + ' L' + run);
    const start = new Date().toISOString();
    this.save(key, { sid, status: 'running', start });
    this.log('start ' + key + ' ' + sid);
    const attachments = item.flags.attach ? await this.upload() : [];
    const messages = [item.q, ...item.follow];
    for (let i = 0; i < messages.length; i++) {
      await this.turn(sid, messages[i], item.flags, i === 0 ? attachments : []);
      await new Promise((done) => setTimeout(done, 2000));
    }
    const csv = await (await fetch('/api/session/' + sid + '/metrics-export?format=csv')).text();
    const stops = await this.stops(sid);
    this.save(key, { sid, status: 'done', start, end: new Date().toISOString(), csv, stops });
    this.log('done ' + key + (stops.some(Boolean) ? ' [' + stops.filter(Boolean).join(',') + ']' : ''));
  },
  async runAll() {
    if (this.running) return;
    this.running = true;
    const plan = this.get('mt_plan', '[]');
    try {
      for (const run of this.cfg.runs) {
        for (const item of plan) {
          if (this.stop) return;
          const key = item.id + '|' + run;
          if ((this.results()[key] || {}).status === 'done') continue;
          try {
            await this.runOne(item, run);
          } catch (e) {
            this.log('ERR ' + key + ' ' + e);
            this.save(key, { status: 'error', err: String(e) });
          }
        }
      }
    } finally {
      this.running = false;
      this.log('runAll finished');
    }
  },
  pending() {
    const done = this.results();
    return this.get('mt_plan', '[]').flatMap((item) =>
      this.cfg.runs.map((run) => item.id + '|' + run).filter((key) => (done[key] || {}).status !== 'done'),
    );
  },
  // Starts the runs and, for up to four passes, picks up what an outage left behind.
  start(cfg) {
    Object.assign(this.cfg, cfg || {});
    if (!this.cfg.ep || !this.cfg.model) throw new Error('ep and model are required');
    if (!this.get('mt_plan', '[]').length) throw new Error('no plan: call MT.loadPlan first');
    if (!localStorage.getItem('mt_graded')) localStorage.setItem('mt_graded', '[]');
    this.stop = false;
    this.passes = 0;
    clearInterval(this.watcher);
    this.watcher = setInterval(() => {
      if (this.running || this.stop || this.passes >= 4 || !this.pending().length) return;
      this.passes++;
      this.log('pass ' + this.passes);
      this.runAll();
    }, 20000);
    this.runAll();
    return this.pending().length + ' runs to go';
  },
  halt() {
    this.stop = true;
    clearInterval(this.watcher);
  },
  status() {
    const all = Object.values(this.results());
    return {
      running: this.running,
      done: all.filter((r) => r.status === 'done').length,
      errors: all.filter((r) => r.status === 'error').length,
      pending: this.pending().length,
      log: this.get('mt_log', '[]').slice(-4),
    };
  },

  // One run as text for grading: each question, its tool calls and the answer.
  async summary(sid, answerChars) {
    const history = (await (await fetch('/api/history/' + sid)).json()).history;
    const flat = (text) => String(text || '').replace(/\s+/g, ' ');
    const out = [];
    for (const m of history) {
      if (m.role === 'user') {
        out.push('U: ' + flat(m.content).slice(0, 80));
        continue;
      }
      for (const t of (m.metadata || {}).tool_events || []) {
        const args = typeof t.command === 'string' ? t.command : JSON.stringify(t.command || '');
        out.push(
          '  T[' + t.tool + (t.exit_code ? ' exit=' + t.exit_code : '') + (t.screenshot ? ' IMG' : '') + ']: ' +
            flat(args).slice(0, 120) + ' => ' + flat(t.output).slice(0, 120),
        );
      }
      const stop = (m.metadata || {}).stop_reason;
      out.push('A' + (stop ? '[' + stop + ']' : '') + ': ' + flat(m.content).slice(0, answerChars || 500));
    }
    return out.join('\n');
  },
  async batch(max, answerChars) {
    const skip = this.get('mt_graded', '[]');
    const all = this.results();
    const keys = Object.keys(all).filter((k) => all[k].status === 'done' && !skip.includes(k));
    let text = '';
    for (const key of keys.slice(0, max || keys.length)) {
      text += '### ' + key + '\n' + (await this.summary(all[key].sid, answerChars)) + '\nCSV:' +
        this.totalRow(all[key].csv).slice(5, 16).join(',') + '\n';
    }
    return text + '\n' + keys.length + ' ungraded';
  },
  graded(keys) {
    const all = this.get('mt_graded', '[]');
    all.push(...keys);
    localStorage.setItem('mt_graded', JSON.stringify(all));
    return all.length;
  },

  // key;date;chat id;the eleven figures of the "Gesamt" row;stop reasons
  exportLines() {
    return Object.entries(this.results())
      .filter(([, r]) => r.status === 'done')
      .map(([key, r]) => {
        const date = r.start.slice(8, 10) + '.' + r.start.slice(5, 7) + '.' + r.start.slice(0, 4);
        const stops = (r.stops || []).map((s, i) => (s ? 'T' + (i + 1) + ':' + s : '')).filter(Boolean);
        return [key, date, r.sid, ...this.totalRow(r.csv).slice(5, 16), stops.join(',')].join(';');
      })
      .join('\n');
  },
};
'MT ready';
