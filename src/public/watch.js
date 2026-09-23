/**
 * Agent Watch's views: the fleet, one agent, and alerts.
 *
 * The fleet is a status board. Each row has one number allowed to be loud —
 * the agent's health — and everything else in the row is the context that
 * number needs before anyone should repeat it: how many sessions it rests on,
 * how sure it is, how much of it rests on rubrics that have been checked.
 */
import { $, el, json, usd } from './dom.js';

const watch = { window: '24h', agents: [], rubrics: [], projects: [], current: null, live: null,
  // The last filter chosen in each list, so coming back to it shows the same view.
  show: { sessions: 'all', rubric: 'failed' } };

const pct = (value) => `${Math.round(value * 100)}%`;
/** Cognigy's UUIDs read fine at eight characters; an id someone chose is kept whole. */
const shortId = (id) => (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(id) ? id.slice(0, 8) : id);
/** "1 session", "3 sessions". */
const count = (n, word, plural = `${word}s`) => `${n} ${n === 1 ? word : plural}`;
const post = (url, body) => json(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
const patch = (url, body) => json(url, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** How long ago, in words — "4 minutes ago" reads faster than a timestamp in a status board. */
function ago(iso) {
  if (!iso) return 'never';
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/**
 * The band a health figure falls in. Always shown beside the number and a
 * word, never as colour alone: two of the four status hues are below 3:1 on
 * the light surface.
 */
function band(health) {
  if (health === null || health === undefined) return { cls: 'none', word: 'no data' };
  if (health >= 0.85) return { cls: 'good', word: 'healthy' };
  if (health >= 0.7) return { cls: 'warning', word: 'watch' };
  if (health >= 0.5) return { cls: 'serious', word: 'degraded' };
  return { cls: 'critical', word: 'failing' };
}

function notice(target, message, kind = '') {
  const box = el('div', `err ${kind}`);
  box.append(el('span', 'ic', kind === 'warn' ? '!' : kind === 'ok' ? '✓' : 'x'), el('span', null, message));
  $(target).replaceChildren(box);
}

/** The health figure as it appears everywhere: number, interval, and whether it can be reported. */
function healthFigure(health, size = '') {
  const wrap = el('div', `health ${size}`);
  const { cls, word } = band(health.health);
  const number = el('span', `hnum ${cls}${health.reportable ? '' : ' indicative'}`, health.health === null ? '—' : pct(health.health));
  wrap.append(number);
  const side = el('span', 'hside');
  if (health.health !== null) {
    side.append(el('span', `hword ${cls}`, health.reportable ? word : 'indicative'));
    if (health.interval !== null) side.append(el('span', 'hint', `± ${Math.max(1, Math.round(health.interval * 100))}`));
  }
  wrap.append(side);
  return wrap;
}

function healthCaption(health) {
  if (health.sessions === 0) return 'Nothing scored in this window yet.';
  const parts = [`${health.sessions} session${health.sessions === 1 ? '' : 's'}`];
  if (!health.reportable) parts.push('too few to report as a health figure');
  parts.push(`${pct(health.verifiedShare)} resting on checked rubrics`);
  return parts.join(', ') + '.';
}

// ---------- the fleet ----------

async function loadFleet() {
  try {
    watch.agents = await json(`/api/agents?window=${watch.window}`);
  } catch (error) {
    notice('fleet-notice', `Could not load agents: ${error.message}`);
    return;
  }
  renderFleet();
}

function renderFleet() {
  const list = $('fleet-list');
  list.replaceChildren();
  if (watch.agents.length === 0) {
    const empty = el('div', 'empty');
    empty.append(
      el('strong', null, 'No agents are being watched yet'),
      el('span', null, 'Add one from a project and it will be collected, scored and alerted on in the background.'),
    );
    list.append(empty);
    openAdopt();
    return;
  }
  for (const entry of watch.agents) list.append(fleetRow(entry));
}

function fleetRow(entry) {
  const { agent, health, state, traces } = entry;
  const row = el('button', 'fleet-row');
  row.type = 'button';

  const who = el('div', 'who-block');
  who.append(el('span', 'aname', agent.name));
  const where = [agent.projectName, agent.endpoints.map((endpoint) => endpoint.name).join(', ') || 'Interaction Panel'];
  who.append(el('span', 'hint', where.join(' — ')));

  const facts = el('div', 'facts');
  facts.append(el('span', null, healthCaption(health)));
  const status = [];
  status.push(agent.enabled ? `Collected ${ago(state.lastCollectedAt)}` : 'Paused');
  if (health.alerts) status.push(count(health.alerts, 'alert'));
  status.push(traces.traces ? count(traces.traces, 'logged LLM call') : agent.trace.installs.length ? 'logging on, nothing received yet' : 'logging off');
  facts.append(el('span', 'hint', status.join(', ')));
  if (state.lastError) facts.append(el('span', 'flagc', `Last collection failed: ${state.lastError}`));
  if (entry.dataProblems) facts.append(el('span', 'flagc', `${count(entry.dataProblems, 'data problem')}, open the agent to see ${entry.dataProblems === 1 ? 'it' : 'them'}`));

  row.append(who, healthFigure(health), facts);
  row.addEventListener('click', () => openAgent(agent.id));
  return row;
}

$('fleet-window').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-window]');
  if (!button) return;
  watch.window = button.dataset.window;
  for (const other of $('fleet-window').querySelectorAll('button')) other.setAttribute('aria-pressed', String(other === button));
  void loadFleet();
});

// ---------- adopting suggested agents ----------

async function openAdopt() {
  $('adopt-panel').hidden = false;
  if (!watch.projects.length) {
    watch.projects = await json('/api/projects').catch(() => []);
    $('adopt-project').replaceChildren(...watch.projects.map((project) => new Option(project.name, project.id)));
  }
  void loadSuggestions();
}

async function loadSuggestions() {
  const projectId = $('adopt-project').value;
  const list = $('adopt-list');
  if (!projectId) return;
  list.replaceChildren(el('p', 'hint', 'Reading the project’s endpoints and Flows…'));
  let suggestions;
  try {
    suggestions = await json(`/api/agents/suggest?projectId=${encodeURIComponent(projectId)}`);
  } catch (error) {
    list.replaceChildren(el('p', 'flagc', `Could not read the project: ${error.message}`));
    return;
  }
  list.replaceChildren();
  for (const suggestion of suggestions) {
    const row = el('div', `adopt-row${suggestion.noFlow ? ' dim' : ''}`);
    const text = el('div');
    text.append(el('span', 'aname', suggestion.name));
    const detail = suggestion.noFlow
      ? 'No working Flow behind this endpoint — probably plumbing, not an agent.'
      : `${suggestion.endpoints.map((endpoint) => endpoint.name).join(', ')}. ${suggestion.llmNodes} LLM node${suggestion.llmNodes === 1 ? '' : 's'} reachable.`;
    text.append(el('span', 'hint', detail));
    const action = el('button', suggestion.ownedBy ? 'btn ghost' : 'btn', suggestion.ownedBy ? 'Already watched' : 'Watch this agent');
    action.type = 'button';
    action.disabled = Boolean(suggestion.ownedBy);
    action.addEventListener('click', async () => {
      action.disabled = true;
      try {
        const project = watch.projects.find((candidate) => candidate.id === projectId);
        const created = await post('/api/agents', {
          name: suggestion.name, projectId, projectName: project?.name, endpoints: suggestion.endpoints,
          includePanel: $('adopt-panel-traffic').checked,
        });
        notice('fleet-notice', `Now watching ${created.agent.name}. It will be collected within a minute.`, 'ok');
        await loadFleet();
        void loadSuggestions();
      } catch (error) {
        action.disabled = false;
        notice('fleet-notice', error.message);
      }
    });
    row.append(text, action);
    list.append(row);
  }
}

$('btn-add-agents').addEventListener('click', () => {
  if ($('adopt-panel').hidden) void openAdopt();
  else $('adopt-panel').hidden = true;
});
$('adopt-project').addEventListener('change', () => void loadSuggestions());

// ---------- one agent ----------

async function openAgent(id) {
  window.dispatchEvent(new CustomEvent('show-view', { detail: 'agent' }));
  for (const tab of document.querySelectorAll('.tab')) tab.classList.toggle('on', tab.dataset.view === 'fleet');
  history.replaceState(null, '', `#agent=${encodeURIComponent(id)}`);
  const page = $('agent-page');
  page.replaceChildren(el('p', 'hint pad', 'Loading…'));
  try {
    const [detail, rubrics] = await Promise.all([json(`/api/agents/${encodeURIComponent(id)}?window=${watch.window}`), json('/api/rubrics')]);
    watch.current = detail;
    watch.rubrics = rubrics;
    renderAgent();
  } catch (error) {
    page.replaceChildren(el('p', 'flagc pad', `Could not load the agent: ${error.message}`));
  }
}

function section(title, body, note) {
  const box = el('section', 'agent-section');
  const head = el('div', 'agent-section-head');
  head.append(el('h3', null, title));
  if (note) head.append(el('span', 'hint', note));
  box.append(head, body);
  return box;
}

/**
 * A section you open when you need it. Settings and the logging controls are
 * visited rarely; left open they push the health, the failing sessions and the
 * coverage gaps — the reasons to open this page — below the fold.
 */
function folded(title, body, note) {
  const box = el('details', 'agent-section folded');
  const summary = el('summary', 'agent-section-head');
  summary.append(el('h3', null, title));
  if (note) summary.append(el('span', 'hint', note));
  box.append(summary, body);
  return box;
}

function renderAgent() {
  const { agent, detail, state, traces, coverage, alerts } = watch.current;
  const page = $('agent-page');
  page.replaceChildren();

  const top = el('div', 'agent-top');
  const back = el('button', 'quiet', '← All agents');
  back.type = 'button';
  back.addEventListener('click', () => {
    history.replaceState(null, '', location.pathname);
    window.dispatchEvent(new CustomEvent('show-view', { detail: 'fleet' }));
  });
  const actions = el('div', 'watch-actions');
  const collect = el('button', 'btn', 'Collect now');
  collect.type = 'button';
  collect.addEventListener('click', async () => {
    collect.disabled = true;
    collect.textContent = 'Collecting…';
    try {
      const report = await post(`/api/agents/${agent.id}/collect`);
      const message = report.error
        ? `Collection failed: ${report.error}`
        : `Scored ${report.scored} session${report.scored === 1 ? '' : 's'} for ${usd(report.costUsd)}` +
          `${report.deferred ? `, ${report.deferred} still in progress` : ''}` +
          `${report.alertsFired ? `, ${report.alertsFired} alert${report.alertsFired === 1 ? '' : 's'} fired` : ''}.`;
      await openAgent(agent.id);
      notice('agent-notice', message, report.error ? '' : 'ok');
    } catch (error) {
      notice('agent-notice', error.message);
      collect.disabled = false;
      collect.textContent = 'Collect now';
    }
  });
  if (watch.live?.demo && agent.endpoints.some((endpoint) => endpoint.channel === 'rest' && endpoint.urlToken)) {
    const start = el('button', 'btn ghost', 'Start simulated chats');
    start.type = 'button';
    start.addEventListener('click', async () => {
      start.disabled = true;
      try {
        const { started } = await post(`/api/agents/${agent.id}/simulate`);
        notice('agent-notice', `Started ${count(started.length, 'conversation')}. Each is scored about a minute after its last message.`, 'ok');
        void pollLive();
      } catch (error) {
        notice('agent-notice', error.message);
      }
      start.disabled = false;
    });
    actions.append(start);
  }
  actions.append(collect);
  top.append(back, actions);
  page.append(top);

  const head = el('div', 'agent-head');
  const title = el('div');
  title.append(el('h2', null, agent.name));
  const every = watch.live?.demo ? 'every minute (demo)' : `every ${agent.intervalMinutes} minutes`;
  title.append(el('p', 'hint', `${agent.projectName}. ${agent.enabled ? `Collected ${every}, last ${ago(state.lastCollectedAt)}` : 'Paused'}.`));
  head.append(title, healthFigure(detail, 'large'));
  page.append(head);
  page.append(el('p', 'agent-caption', healthCaption(detail)));
  const noticeBox = el('div');
  noticeBox.id = 'agent-notice';
  page.append(noticeBox);
  const live = el('div');
  live.id = 'agent-live';
  page.append(live);
  if (state.lastError) notice('agent-notice', `The last collection failed: ${state.lastError}`);

  if (detail.trend.length > 1) page.append(section('Health by day', trendChart(detail.trend)));
  page.append(section('Rubrics', rubricTable(detail), 'open one to see its sessions'));
  const sessions = el('div');
  page.append(section('Sessions', sessions, `last ${watch.window === '24h' ? '24 hours' : watch.window === '7d' ? '7 days' : '30 days'}, newest first`));
  void renderSessionList(sessions, agent.id);
  page.append(section('Alerts', alertTable(alerts, false)));
  page.append(section('Coverage', coveragePanel(agent, coverage), 'instructions no rubric specifically checks'));
  page.append(watch.current.data.problems
    ? section('Data', dataSection(watch.current.data), `what the scores rest on, ${dataSummary(watch.current.data)}`)
    : folded('Data', dataSection(watch.current.data), dataSummary(watch.current.data)));
  page.append(folded('LLM logging', loggingPanel(agent, traces),
    traces.traces ? count(traces.traces, 'logged call') : agent.trace.installs.length ? 'on, nothing received yet' : 'off'));
  page.append(folded('Settings', settingsPanel(agent),
    `${agent.enabled ? `every ${agent.intervalMinutes} min` : 'paused'}, ${agent.alerts.webhookUrl ? 'Mac and webhook alerts' : agent.alerts.macos ? 'Mac alerts' : 'alerts in the app only'}`));
}

/** Daily health as bars, one per day. Hovering a bar gives the figure and the sample behind it. */
function trendChart(trend) {
  const width = 640;
  const height = 96;
  const gap = 4;
  const bar = Math.max(4, Math.floor((width - gap * (trend.length - 1)) / trend.length));
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height + 18}`);
  svg.setAttribute('class', 'trend');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `Daily health over ${trend.length} days`);
  trend.forEach((point, index) => {
    const h = Math.max(2, Math.round(point.health * height));
    const x = index * (bar + gap);
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', String(x));
    rect.setAttribute('y', String(height - h));
    rect.setAttribute('width', String(bar));
    rect.setAttribute('height', String(h));
    rect.setAttribute('rx', '2');
    rect.setAttribute('class', `tbar ${band(point.health).cls}`);
    const tip = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    tip.textContent = `${point.day}: ${pct(point.health)} over ${point.sessions} session${point.sessions === 1 ? '' : 's'}`;
    rect.append(tip);
    svg.append(rect);
    if (index === 0 || index === trend.length - 1) {
      const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      label.setAttribute('x', String(index === 0 ? x : x + bar));
      label.setAttribute('y', String(height + 14));
      label.setAttribute('text-anchor', index === 0 ? 'start' : 'end');
      label.setAttribute('class', 'tlabel');
      label.textContent = point.day.slice(5);
      svg.append(label);
    }
  });
  return svg;
}

function rubricTable(detail) {
  if (!detail.rubrics.length) return el('p', 'hint', 'No rubrics are switched on for this agent.');
  const table = el('table', 'agent-table rubric-health');
  const head = el('tr');
  for (const [label, cls] of [['Rubric', ''], ['Passing', 'n'], ['Sessions', 'n'], ['Validity', 'n'], ['', '']]) head.append(el('th', cls, label));
  const thead = el('thead');
  thead.append(head);
  const body = el('tbody');
  const ordered = [...detail.rubrics].sort((a, b) => (a.passRate ?? 2) - (b.passRate ?? 2));
  for (const rubric of ordered) {
    const tr = el('tr', 'open');
    tr.tabIndex = 0;
    tr.addEventListener('click', () => void openRubric(watch.current.agent.id, rubric.rubricId));
    tr.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') void openRubric(watch.current.agent.id, rubric.rubricId);
    });
    const name = el('td');
    name.append(el('span', 'rname-cell', rubric.name));
    if (rubric.kind === 'alert') name.append(el('span', 'badge alert', 'alert'));
    const passing = el('td', 'n');
    if (rubric.passRate === null) passing.append(el('span', 'muted', rubric.answered ? '—' : 'not asked'));
    else {
      const meter = el('span', 'meter');
      const bars = el('span', 'bars');
      const filled = Math.round(rubric.passRate * 10);
      bars.append(document.createTextNode('█'.repeat(filled)));
      if (filled < 10) bars.append(el('span', 'off', '█'.repeat(10 - filled)));
      meter.append(bars, el('span', 'v', pct(rubric.passRate)));
      meter.title = `passed ${rubric.passed} of ${rubric.answered} sessions`;
      passing.append(meter);
    }
    const validity = el('td', 'n', rubric.verified ? rubric.validity.toFixed(2) : 'unchecked');
    if (!rubric.verified) validity.classList.add('muted');
    tr.append(name, passing, el('td', 'n', String(rubric.answered)), validity, el('td', 'go', '›'));
    body.append(tr);
  }
  table.append(thead, body);
  return table;
}

const SESSION_FILTERS = [['all', 'All'], ['rubric_failed', 'A rubric failed'], ['call_failed', 'A tool call failed'], ['not_scored', 'Not scored']];
const VERDICT_FILTERS = [['failed', 'Failed'], ['passed', 'Passed'], ['all', 'All']];
const when = (iso) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** A segmented filter whose buttons carry their counts. */
function filterBar(options, counts, current, onPick) {
  const bar = el('div', 'seg');
  bar.setAttribute('role', 'group');
  bar.setAttribute('aria-label', 'Show');
  for (const [key, label] of options) {
    const button = el('button', null, label);
    button.type = 'button';
    button.append(el('span', 'n', String(counts[key] ?? 0)));
    button.setAttribute('aria-pressed', String(key === current));
    button.addEventListener('click', () => onPick(key));
    bar.append(button);
  }
  return bar;
}

/** Every session the agent has in the window, filterable; each opens in the drawer. */
async function renderSessionList(box, agentId) {
  // Only the newest request draws: a slow answer for an old filter must not overwrite a newer one.
  const ticket = (box.ticket = (box.ticket ?? 0) + 1);
  let data;
  try {
    data = await json(`/api/agents/${encodeURIComponent(agentId)}/sessions?window=${watch.window}&show=${watch.show.sessions}`);
  } catch (error) {
    if (ticket === box.ticket) box.replaceChildren(el('p', 'flagc', `Could not load sessions: ${error.message}`));
    return;
  }
  if (ticket !== box.ticket) return;
  const bar = filterBar(SESSION_FILTERS, data.counts, watch.show.sessions, (key) => {
    watch.show.sessions = key;
    void renderSessionList(box, agentId);
  });
  const list = el('div', 'session-list');
  if (data.sessions.length === 0) list.append(el('p', 'hint', data.counts.all ? 'No session in this window matches.' : 'No session collected in this window yet.'));
  for (const item of data.sessions) {
    const row = el('button', 'srow');
    row.type = 'button';
    const score = item.score === undefined ? el('span', 'verdict muted', item.error || item.unscoreable ? 'not scored' : '—')
      : el('span', `verdict ${band(item.score).cls}`, pct(item.score));
    const flags = el('span', 'flags');
    if (item.error) flags.append(el('span', 'bad', 'couldn’t score'));
    for (const failed of item.failedRubrics.slice(0, 2)) flags.append(el('span', 'bad', failed.name));
    if (item.failedRubrics.length > 2) flags.append(el('span', 'bad', `+${item.failedRubrics.length - 2} more`));
    if (item.failedCalls) flags.append(el('span', 'bad', count(item.failedCalls, 'tool call') + ' failed'));
    if (!flags.childElementCount) flags.append(el('span', 'muted', 'nothing failed'));
    row.append(el('span', 'sid', shortId(item.sessionId)), el('span', 'when', when(item.startedAt)), score, flags);
    row.addEventListener('click', () => void openSessionById(item.sessionId));
    list.append(row);
  }
  const head = el('div', 'list-head');
  head.append(bar);
  box.replaceChildren(head, list);
}

/**
 * One rubric under one agent: what it asks, how many sessions it passed, and
 * those sessions, failures first. Has its own address, so it can be linked to.
 */
let rubricTicket = 0;

async function openRubric(agentId, rubricId) {
  window.dispatchEvent(new CustomEvent('show-view', { detail: 'agent' }));
  history.replaceState(null, '', `#agent=${encodeURIComponent(agentId)}&rubric=${encodeURIComponent(rubricId)}`);
  const page = $('agent-page');
  const ticket = ++rubricTicket;
  let data;
  try {
    if (!watch.current || watch.current.agent.id !== agentId || watch.current.detail.window !== watch.window) {
      watch.current = await json(`/api/agents/${encodeURIComponent(agentId)}?window=${watch.window}`);
    }
    data = await json(`/api/agents/${encodeURIComponent(agentId)}/rubrics/${encodeURIComponent(rubricId)}?window=${watch.window}&show=${watch.show.rubric}`);
    // A rubric that reports answers without pass or fail has only one list to show.
    if (!data.hasVerdicts && watch.show.rubric !== 'all' && data.counts.all > 0) {
      watch.show.rubric = 'all';
      data = await json(`/api/agents/${encodeURIComponent(agentId)}/rubrics/${encodeURIComponent(rubricId)}?window=${watch.window}&show=all`);
    }
  } catch (error) {
    if (ticket === rubricTicket) page.replaceChildren(el('p', 'flagc pad', `Could not load the rubric: ${error.message}`));
    return;
  }
  if (ticket !== rubricTicket) return;
  const { rubric, health } = data;
  page.replaceChildren();
  const top = el('div', 'agent-top');
  const back = el('button', 'quiet', `← ${watch.current.agent.name}`);
  back.type = 'button';
  back.addEventListener('click', () => void openAgent(agentId));
  top.append(back);
  page.append(top);

  const head = el('div', 'rubric-head');
  const title = el('div');
  const name = el('h2', null, rubric.name);
  if (rubric.kind === 'alert' && rubric.alert) {
    name.append(el('span', 'badge alert', rubric.alert.window === 'session' ? 'alert, fires on 1 in a session' : `alert, fires on ${rubric.alert.threshold} a ${rubric.alert.window}`));
  }
  title.append(name, el('p', 'q', rubric.question));
  const rate = el('div', 'rate');
  if (health?.passRate !== null && health?.passRate !== undefined) {
    rate.append(el('span', `big ${band(health.passRate).cls}`, pct(health.passRate)), el('span', 'hint of', `passed ${health.passed} of ${health.answered} sessions`));
  } else if (data.counts.all > 0) {
    rate.append(el('span', 'hint of', `asked in ${count(data.counts.all, 'session')}; its answers carry no pass or fail`));
  } else {
    rate.append(el('span', 'hint of', 'not asked in this window'));
  }
  head.append(title, rate);
  page.append(head);

  const body = el('section', 'agent-section');
  const bar = filterBar(data.hasVerdicts ? VERDICT_FILTERS : [['all', 'All']], data.counts, watch.show.rubric, (key) => {
    watch.show.rubric = key;
    void openRubric(agentId, rubricId);
  });
  const listHead = el('div', 'list-head');
  listHead.append(bar);
  if (health && !health.verified) listHead.append(el('span', 'hint', 'validity unchecked: run a validity check before relying on this rate'));
  body.append(listHead);
  const list = el('div', 'session-list');
  if (data.sessions.length === 0) {
    list.append(el('p', 'hint', watch.show.rubric === 'failed' ? 'No session failed this rubric in this window.'
      : watch.show.rubric === 'passed' ? 'No session passed this rubric in this window.' : 'This rubric wasn’t asked in this window.'));
  }
  for (const item of data.sessions) {
    const row = el('button', 'srow');
    row.type = 'button';
    const verdict = el('span', `verdict ${item.passed === false ? 'fail' : item.passed ? 'pass' : ''}`, item.passed === false ? 'Failed' : item.passed ? 'Passed' : item.answer);
    if (item.certainty) verdict.append(el('span', 'lbl', `${item.certainty.label} ${item.certainty.value.toFixed(2)}`));
    const quote = el('span', 'quote');
    if (item.located?.quote) {
      quote.append(el('span', 'who', 'Agent'), document.createTextNode(`"${item.located.quote.replace(/\s+/g, ' ').slice(0, 140)}"`));
      if (item.located.confidence !== null) quote.append(el('span', 'p', `confidence ${item.located.confidence.toFixed(2)}`));
    } else if (item.located?.reason) {
      quote.append(el('span', 'muted', item.located.reason));
    } else {
      quote.append(el('span', 'muted', `answer: ${item.answer}`));
    }
    row.append(el('span', 'sid', shortId(item.sessionId)), el('span', 'when', when(item.startedAt)), verdict, quote);
    row.addEventListener('click', () => void openSessionById(item.sessionId, rubric.id));
    list.append(row);
  }
  body.append(list);
  page.append(body);
}

/**
 * Opens one of the current agent's sessions in the session drawer — focused on
 * a rubric when opened from one, so the drawer can pin it and find its message.
 */
async function openSessionById(sessionId, focusRubric) {
  try {
    const session = await json(`/api/sessions/${encodeURIComponent(sessionId)}?agentId=${encodeURIComponent(watch.current.agent.id)}`);
    window.dispatchEvent(new CustomEvent('open-session', { detail: focusRubric ? { ...session, focusRubric } : session }));
  } catch (error) {
    notice('agent-notice', error.message);
  }
}

/** A link that opens a session, written as the sentence it sits in needs. */
function sessionLink(sessionId, text) {
  const link = el('button', 'link', text);
  link.type = 'button';
  link.addEventListener('click', () => void openSessionById(sessionId));
  return link;
}

/**
 * Whether the scores can be trusted: what they rest on, and what went wrong
 * getting there. Open only when something did.
 */
function dataSection(data) {
  const list = el('ul', 'data-health');
  const line = (key, bad, ...value) => {
    const item = el('li');
    const v = el('span', `v${bad ? ' bad' : ''}`);
    v.append(...value.map((part) => (typeof part === 'string' ? document.createTextNode(part) : part)));
    item.append(el('span', 'k', key), v);
    list.append(item);
  };
  const num = (n) => el('span', 'num', String(n));
  const scored = data.sessions - data.failed.count;

  const { full, partial, none } = data.logged;
  line('LLM calls logged', false, num(full), ` of ${scored} session${scored === 1 ? '' : 's'} fully logged`,
    partial ? `, ${partial} partly` : '', none ? `, ${none} not at all` : '',
    partial || none ? '. Rubrics that need the logs were left out where they were missing.' : '.');

  if (data.failed.count) {
    const latest = data.failed.latest[0];
    line("Couldn't score", true, num(data.failed.count), ` session${data.failed.count === 1 ? '' : 's'}. Latest: ${latest.error.replace(/\.?$/, '.')} `,
      sessionLink(latest.sessionId, latest.attempts < 3 ? 'Retrying' : 'Tried 3 times, open it'), '.');
  } else {
    line("Couldn't score", false, num(0), '. Every session was scored.');
  }

  if (data.drift.sessions) {
    const paths = data.drift.paths.slice(0, 3);
    line('Unexpected payloads', true, num(data.drift.sessions), ` session${data.drift.sessions === 1 ? '' : 's'} had fields in a new shape: `,
      ...paths.flatMap((path, index) => [el('code', null, path), index < paths.length - 1 ? ', ' : '']),
      data.drift.paths.length > 3 ? ` and ${data.drift.paths.length - 3} more` : '', '. They were read as missing, not guessed at.');
  }

  if (data.gaps.sessions) {
    line('Missing turns', true, num(data.gaps.sessions), ` session${data.gaps.sessions === 1 ? ' has' : 's have'} logged replies the transcript lacks, starting with `,
      sessionLink(data.gaps.sessionIds[0], shortId(data.gaps.sessionIds[0])), '.');
  } else {
    line('Missing turns', false, num(0), '. Every logged reply is in the transcript.');
  }
  return list;
}

function dataSummary(data) {
  if (data.problems) return count(data.problems, 'problem');
  if (data.sessions === 0) return 'nothing collected yet';
  return 'every session scored, nothing missing';
}

function loggingPanel(agent, traces) {
  const box = el('div', 'logging');
  const summary = traces.traces
    ? `${count(traces.traces, 'logged LLM call')} across ${count(traces.sessions, 'session')}, the latest ${ago(traces.lastReceivedAt)}.`
    : 'No logged LLM calls received yet. Without them, rubrics that need the agent’s instructions or tool calls are not asked.';
  box.append(el('p', null, summary));
  const nodes = el('div', 'nodes');
  nodes.append(el('p', 'hint', 'Checking the agent’s nodes in Cognigy…'));
  box.append(nodes);
  void (async () => {
    let status;
    try {
      status = await json(`/api/agents/${agent.id}/logging`);
    } catch (error) {
      nodes.replaceChildren(el('p', 'flagc', `Could not read the nodes: ${error.message}`));
      return;
    }
    nodes.replaceChildren();
    if (!status.publicUrl) {
      // A setup step, not a failure — said calmly, with what to do.
      const setup = el('p', 'setup-note');
      setup.append(
        document.createTextNode('Cognigy needs a public address to post to. Start a tunnel, set '),
        el('code', null, 'AGENT_WATCH_PUBLIC_URL'),
        document.createTextNode(' in .env to its URL, and restart. Until then, logging can be read here but not switched on.'),
      );
      nodes.append(setup);
    }
    if (!status.nodes.length) nodes.append(el('p', 'hint', 'No AI Agent or LLM Prompt node is reachable from this agent’s endpoints.'));
    for (const node of status.nodes) {
      const row = el('div', 'node-row');
      const label = el('div');
      label.append(el('span', 'aname', node.nodeLabel || node.nodeType), el('span', 'hint', `${node.flowName}, ${node.nodeType}`));
      const state = { ours: 'logging here', other: 'logging elsewhere', off: 'logging off' }[node.state];
      const badge = el('span', `badge ${node.state}`, state);
      if (node.currentUrl) badge.title = node.currentUrl;
      row.append(label, badge);
      nodes.append(row);
    }
    const buttons = el('div', 'watch-actions');
    const anyOff = status.nodes.some((node) => node.state === 'off');
    const anyOther = status.nodes.some((node) => node.state === 'other');
    const install = async (takeOver) => {
      try {
        const report = await post(`/api/agents/${agent.id}/logging`, { takeOver });
        const parts = [`${report.installed.length} installed`];
        if (report.skipped.length) parts.push(`${report.skipped.length} left alone because they log elsewhere`);
        if (report.failed.length) parts.push(`${report.failed.length} failed: ${report.failed.map((f) => f.error).join('; ')}`);
        await openAgent(agent.id);
        notice('agent-notice', `Logging: ${parts.join(', ')}.`, report.failed.length ? 'warn' : 'ok');
      } catch (error) {
        notice('agent-notice', error.message);
      }
    };
    if (status.publicUrl && anyOff) {
      const button = el('button', 'btn', 'Turn logging on');
      button.type = 'button';
      button.addEventListener('click', () => void install(false));
      buttons.append(button);
    }
    if (status.publicUrl && anyOther) {
      const button = el('button', 'btn ghost', 'Take over from the other webhook');
      button.type = 'button';
      button.title = 'A node has one webhook. Pointing it here stops whatever received it before; removing it later puts that back.';
      button.addEventListener('click', () => {
        if (confirm('This stops those nodes posting to their current webhook until logging is removed here. Continue?')) void install(true);
      });
      buttons.append(button);
    }
    if (status.installs.length) {
      const button = el('button', 'btn ghost', 'Remove logging');
      button.type = 'button';
      button.addEventListener('click', async () => {
        try {
          const report = await json(`/api/agents/${agent.id}/logging`, { method: 'DELETE' });
          await openAgent(agent.id);
          notice('agent-notice', `Logging removed from ${report.restored.length} node${report.restored.length === 1 ? '' : 's'}, each restored to exactly what it was.`, 'ok');
        } catch (error) {
          notice('agent-notice', error.message);
        }
      });
      buttons.append(button);
    }
    if (buttons.childElementCount) nodes.append(buttons);
  })();
  return box;
}

function coveragePanel(agent, coverage) {
  const box = el('div', 'coverage');
  const run = el('button', 'btn ghost', coverage ? 'Check again' : 'Check coverage');
  run.type = 'button';
  run.addEventListener('click', async () => {
    run.disabled = true;
    run.textContent = 'Checking…';
    try {
      await post(`/api/agents/${agent.id}/coverage`);
      await openAgent(agent.id);
    } catch (error) {
      notice('agent-notice', error.message);
      run.disabled = false;
      run.textContent = 'Check coverage';
    }
  });
  if (!coverage) {
    box.append(el('p', 'hint', 'Reads the agent’s instructions from its newest logged call and asks which rubric, if any, checks each one.'), run);
    return box;
  }
  const names = new Map(watch.rubrics.map((rubric) => [rubric.id, rubric.name]));
  const general = coverage.general?.map((id) => `“${names.get(id) ?? id}”`).join(' and ');
  box.append(el('p', null,
    `${coverage.covered} of ${coverage.constraints.length} instructions have a rubric that checks them specifically.` +
    (coverage.gaps ? ` ${coverage.gaps} do not${general ? `; only ${general} watches those, and only in general` : ''}.` : '')));
  // The first few gaps say enough to act on; the rest are one click away.
  const SHOWN = 6;
  const gaps = coverage.constraints.filter((constraint) => !constraint.rubricId);
  const list = el('ul', 'gaps');
  for (const item of gaps.slice(0, SHOWN)) list.append(el('li', null, item.text));
  if (list.childElementCount) box.append(list);
  if (gaps.length > SHOWN) {
    const more = el('details', 'covered');
    more.append(el('summary', null, `Show the other ${gaps.length - SHOWN} gaps`));
    const rest = el('ul', 'gaps');
    for (const item of gaps.slice(SHOWN)) rest.append(el('li', null, item.text));
    more.append(rest);
    box.append(more);
  }
  const covered = el('details', 'covered');
  covered.append(el('summary', null, `Show the ${coverage.covered} that are covered`));
  const coveredList = el('ul');
  for (const item of coverage.constraints.filter((constraint) => constraint.rubricId)) {
    const li = el('li');
    li.append(el('span', null, item.text), el('span', 'hint', ` — ${names.get(item.rubricId) ?? item.rubricId}`));
    coveredList.append(li);
  }
  covered.append(coveredList);
  box.append(covered, el('p', 'hint', `Instructions read ${ago(coverage.instructionsAt)}.`), run);
  return box;
}

function settingsPanel(agent) {
  const form = el('form', 'settings');
  const field = (labelText, control, help) => {
    const wrap = el('label', 'f');
    wrap.append(el('span', 'f-label', labelText), control);
    if (help) wrap.append(el('span', 'help', help));
    return wrap;
  };

  const enabled = el('input');
  enabled.type = 'checkbox';
  enabled.checked = agent.enabled;
  const enabledRow = el('label', 'check');
  enabledRow.append(enabled, el('span', null, 'Watch this agent — collect and score it on a schedule'));

  const interval = el('select', 'ctl');
  for (const minutes of [15, 30, 60, 180, 300, 720, 1440]) {
    const label = minutes < 60 ? `every ${minutes} minutes` : minutes === 60 ? 'every hour' : minutes === 1440 ? 'once a day' : `every ${minutes / 60} hours`;
    interval.append(new Option(label, String(minutes), false, minutes === agent.intervalMinutes));
  }

  const panel = el('input');
  panel.type = 'checkbox';
  panel.checked = agent.includePanel;
  const panelRow = el('label', 'check');
  panelRow.append(panel, el('span', null, `Include Interaction Panel sessions in ${agent.flowNames?.length ? agent.flowNames.join(', ') : 'the agent’s Flows'}`));

  const macos = el('input');
  macos.type = 'checkbox';
  macos.checked = agent.alerts.macos;
  const macosRow = el('label', 'check');
  macosRow.append(macos, el('span', null, 'Show a notification on this Mac when an alert fires'));

  const webhook = el('input', 'ctl');
  webhook.type = 'url';
  webhook.placeholder = 'https://hooks.slack.com/services/…';
  webhook.value = agent.alerts.webhookUrl ?? '';

  const rubrics = el('div', 'toggles');
  const switches = new Map();
  for (const rubric of watch.rubrics.filter((candidate) => candidate.enabled)) {
    const on = agent.rubrics[rubric.id] ?? rubric.origin === 'library';
    const box = el('input');
    box.type = 'checkbox';
    box.checked = on;
    switches.set(rubric.id, box);
    const row = el('label', 'check');
    row.append(box, el('span', null, rubric.name));
    if (rubric.kind === 'alert') row.append(el('span', 'badge alert', 'alert'));
    rubrics.append(row);
  }

  const save = el('button', 'btn', 'Save settings');
  save.type = 'submit';
  const remove = el('button', 'btn ghost danger', 'Stop watching and delete');
  remove.type = 'button';
  remove.addEventListener('click', async () => {
    const logging = agent.trace.installs.length ? ' Its logging will be removed from Cognigy first.' : '';
    if (!confirm(`Delete ${agent.name}? Scored sessions are kept.${logging}`)) return;
    try {
      await json(`/api/agents/${agent.id}`, { method: 'DELETE' });
      history.replaceState(null, '', location.pathname);
      window.dispatchEvent(new CustomEvent('show-view', { detail: 'fleet' }));
    } catch (error) {
      notice('agent-notice', error.message);
    }
  });

  form.append(
    enabledRow,
    field('How often', interval),
    panelRow,
    el('h4', null, 'Alerts'),
    macosRow,
    field('Also post alerts to a webhook', webhook, 'Slack and Teams incoming webhooks both work.'),
    el('h4', null, 'Rubrics this agent is graded on'),
    rubrics,
  );
  const end = el('div', 'rowend');
  end.append(remove, save);
  form.append(end);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await patch(`/api/agents/${agent.id}`, {
        enabled: enabled.checked,
        intervalMinutes: Number(interval.value),
        includePanel: panel.checked,
        // An empty string, not undefined: JSON drops undefined, and the server's
        // merge would then keep the old webhook, making it impossible to remove.
        alerts: { macos: macos.checked, webhookUrl: webhook.value.trim() },
        rubrics: Object.fromEntries([...switches].map(([id, box]) => [id, box.checked])),
      });
      await openAgent(agent.id);
      notice('agent-notice', 'Settings saved.', 'ok');
    } catch (error) {
      notice('agent-notice', error.message);
    }
  });
  return form;
}

// ---------- alerts ----------

function alertTable(alerts, withAgent) {
  if (!alerts.length) return el('p', 'hint', 'No alert has fired.');
  const names = new Map(watch.rubrics.map((rubric) => [rubric.id, rubric.name]));
  const table = el('table', 'agent-table');
  const head = el('tr');
  const columns = [['Happened', ''], ...(withAgent ? [['Agent', '']] : []), ['What', ''], ['Count', 'n'], ['Sessions', ''], ['Delivered', '']];
  for (const [label, cls] of columns) head.append(el('th', cls, label));
  const thead = el('thead');
  thead.append(head);
  const body = el('tbody');
  for (const alert of alerts) {
    const tr = el('tr');
    const when = el('td', 'when', new Date(alert.happenedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }));
    const lateMs = Date.parse(alert.detectedAt) - Date.parse(alert.happenedAt);
    if (lateMs > 2 * 3_600_000) {
      const late = el('span', 'badge warn', 'late');
      late.title = `Detected ${new Date(alert.detectedAt).toLocaleString()}`;
      when.append(late);
    }
    tr.append(when);
    if (withAgent) {
      const agent = el('td');
      const link = el('button', 'quiet', alert.agentName ?? alert.agentId);
      link.type = 'button';
      link.addEventListener('click', () => openAgent(alert.agentId));
      agent.append(link);
      tr.append(agent);
    }
    tr.append(
      el('td', null, alert.rubricName ?? names.get(alert.rubricId) ?? alert.rubricId),
      el('td', 'n', String(alert.count)),
      el('td', 'sid', alert.sessions.slice(0, 3).map(shortId).join(', ') + (alert.sessions.length > 3 ? ` +${alert.sessions.length - 3}` : '')),
    );
    const delivered = Object.entries(alert.delivered)
      .filter(([, outcome]) => outcome !== 'off')
      .map(([channel, outcome]) => {
        const name = channel === 'macos' ? 'Mac notification' : channel;
        return outcome === 'ok' ? name : `${name} failed`;
      });
    const cell = el('td', delivered.some((text) => text.includes('failed')) ? 'flagc' : 'hint', delivered.join(', ') || 'in the app only');
    const errors = Object.values(alert.delivered).filter((outcome) => outcome.startsWith('error'));
    if (errors.length) cell.title = errors.join('\n');
    tr.append(cell);
    body.append(tr);
  }
  table.append(thead, body);
  return table;
}

async function loadAlerts() {
  try {
    const [alerts, rubrics] = await Promise.all([json('/api/alerts'), json('/api/rubrics')]);
    watch.rubrics = rubrics;
    $('alerts-list').replaceChildren(alertTable(alerts, true));
    updateAlertCount(alerts);
  } catch (error) {
    $('alerts-list').replaceChildren(el('p', 'flagc pad', `Could not load alerts: ${error.message}`));
  }
}

/** The tab shows how many alerts fired in the last day, so a glance at the header is enough. */
function updateAlertCount(alerts) {
  const recent = alerts.filter((alert) => Date.now() - Date.parse(alert.happenedAt) < 86_400_000).length;
  $('alert-count').hidden = recent === 0;
  $('alert-count').textContent = String(recent);
}

// ---------- live activity (demo mode) ----------

/**
 * What is happening right now: the conversations being held with an agent,
 * and each collection as it lands. Shown only in demo mode, where collection
 * runs every minute and there is something to watch.
 */
function livePanel(live, agentId) {
  const feed = live.feed.filter((turn) => !agentId || turn.agentId === agentId).slice(0, 14);
  // A collection that found nothing is the normal case between chats; listing each one buries the ones that did.
  const recent = live.recent.filter((report) => (!agentId || report.agentId === agentId) && (report.found || report.error)).slice(0, 6);
  const box = el('section', 'agent-section live');
  const head = el('div', 'agent-section-head');
  head.append(el('h3', null, 'Live'));
  head.append(el('span', `hint live-status${live.scheduler.collecting ? ' busy' : ''}`,
    live.scheduler.collecting ? 'Collecting now…' : 'Collecting every minute'));
  box.append(head);

  const grid = el('div', 'live-grid');
  const talk = el('div', 'live-col');
  talk.append(el('h4', null, 'Conversations'));
  if (feed.length === 0) talk.append(el('p', 'hint', agentId ? 'Nothing yet. Start simulated chats to have customers talk to this agent.' : 'Nothing yet. Open an agent and start simulated chats.'));
  for (const turn of feed) {
    const line = el('div', 'live-turn');
    line.append(el('span', 'live-who', turn.persona), el('span', 'live-time hint', ago(turn.at)));
    line.append(el('p', 'live-said', turn.said));
    if (turn.error) line.append(el('p', 'flagc', turn.error));
    else if (turn.replies.length) line.append(el('p', 'live-reply', plain(turn.replies.join(' '))));
    talk.append(line);
  }

  const runs = el('div', 'live-col');
  runs.append(el('h4', null, 'Collections'));
  if (recent.length === 0) runs.append(el('p', 'hint', 'Nothing collected yet. A chat is scored about a minute after its last message.'));
  for (const report of recent) {
    const line = el('div', 'live-run');
    const what = report.error ? `failed: ${report.error}`
      : report.scored ? `scored ${count(report.scored, 'session')} for ${usd(report.costUsd)}`
      : report.deferred ? `${count(report.deferred, 'conversation')} still going` : 'nothing new';
    line.append(el('span', null, `${agentId ? '' : `${report.agentName}: `}${what}`));
    if (report.alertsFired) line.append(el('span', 'flagc', count(report.alertsFired, 'alert') + ' fired'));
    line.append(el('span', 'hint', ago(report.at)));
    runs.append(line);
  }
  grid.append(talk, runs);
  box.append(grid);
  return box;
}

/** Agent replies are Markdown; in a one-line preview the markers are noise. */
const plain = (text) => text.replace(/\*\*|__|`/g, '').replace(/^#+\s*/gm, '').replace(/\s+/g, ' ');

/** The newest collection that scored something; when it changes, the figures on screen are stale. */
const lastScored = (live) => live?.recent.find((report) => report.scored || report.alertsFired)?.at;

async function pollLive() {
  let live;
  try {
    live = await json('/api/watch');
  } catch {
    return;
  }
  const stale = watch.live && lastScored(live) !== lastScored(watch.live);
  watch.live = live;
  if (!live.demo) return;
  if (!$('view-fleet').hidden) {
    if (stale) await loadFleet();
    $('fleet-live').replaceChildren(livePanel(live));
  }
  if (!$('view-agent').hidden && watch.current) {
    if (stale) {
      await openAgent(watch.current.agent.id);
      json('/api/alerts').then(updateAlertCount).catch(() => {});
    }
    $('agent-live')?.replaceChildren(livePanel(live, watch.current.agent.id));
  }
}

/** Demo mode only: one press starts every agent's customers at once. */
function addFleetSimulate() {
  if ($('btn-simulate-fleet')) return;
  const button = el('button', 'btn ghost', 'Start simulated chats');
  button.id = 'btn-simulate-fleet';
  button.type = 'button';
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const { started } = await post('/api/simulate');
      const total = started.reduce((sum, run) => sum + (run.started?.length ?? 0), 0);
      notice('fleet-notice', `Started ${count(total, 'conversation')} across ${count(started.length, 'agent')}. Each is scored about a minute after its last message.`, 'ok');
      void pollLive();
    } catch (error) {
      notice('fleet-notice', error.message);
    }
    button.disabled = false;
  });
  $('btn-add-agents').before(button);
}

// ---------- routing ----------

window.addEventListener('view-shown', (event) => {
  if (event.detail === 'fleet') void loadFleet().then(pollLive);
  if (event.detail === 'alerts') void loadAlerts();
});

// A link from an alert opens that agent; otherwise the fleet leads when there is one.
const deepLink = location.hash.match(/^#agent=([\w-]+)(?:&rubric=([^&]+))?/);
const initial = await json('/api/agents?window=24h').catch(() => []);
watch.live = await json('/api/watch').catch(() => null);
watch.agents = initial;
json('/api/alerts').then(updateAlertCount).catch(() => {});
if (deepLink?.[2]) void openRubric(decodeURIComponent(deepLink[1]), decodeURIComponent(deepLink[2]));
else if (deepLink) void openAgent(decodeURIComponent(deepLink[1]));
else if (initial.length) window.dispatchEvent(new CustomEvent('show-view', { detail: 'fleet' }));

// Keep the board current while it is open; the collector writes in the background.
setInterval(() => {
  if (!$('view-fleet').hidden) void loadFleet();
  if (!$('view-alerts').hidden) void loadAlerts();
}, 60_000);
// In demo mode the board is meant to be watched, so it follows along closely.
if (watch.live?.demo) {
  addFleetSimulate();
  setInterval(() => void pollLive(), 5_000);
}
