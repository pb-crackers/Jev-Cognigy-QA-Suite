/**
 * Agent Watch's views: the fleet, one agent, and alerts.
 *
 * The fleet is a status board. Each row has one number allowed to be loud —
 * the agent's health — and everything else in the row is the context that
 * number needs before anyone should repeat it: how many sessions it rests on,
 * how sure it is, how much of it rests on rubrics that have been checked.
 */
import { $, el, json, usd } from './dom.js';

const watch = { window: '24h', agents: [], rubrics: [], projects: [], current: null };

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
  actions.append(collect);
  top.append(back, actions);
  page.append(top);

  const head = el('div', 'agent-head');
  const title = el('div');
  title.append(el('h2', null, agent.name));
  title.append(el('p', 'hint', `${agent.projectName}. ${agent.enabled ? `Collected every ${agent.intervalMinutes} minutes, last ${ago(state.lastCollectedAt)}` : 'Paused'}.`));
  head.append(title, healthFigure(detail, 'large'));
  page.append(head);
  page.append(el('p', 'agent-caption', healthCaption(detail)));
  const noticeBox = el('div');
  noticeBox.id = 'agent-notice';
  page.append(noticeBox);
  if (state.lastError) notice('agent-notice', `The last collection failed: ${state.lastError}`);

  if (detail.trend.length > 1) page.append(section('Health by day', trendChart(detail.trend)));
  page.append(section('Rubrics', rubricTable(detail), 'weight × validity is what each rubric counts for'));
  page.append(section('Failing sessions', failingList(detail), detail.failing.length ? 'worst first' : undefined));
  page.append(section('Alerts', alertTable(alerts, false)));
  page.append(section('Coverage', coveragePanel(agent, coverage), 'instructions no rubric specifically checks'));
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
  for (const [label, cls] of [['Rubric', ''], ['Passing', 'n'], ['Answered', 'n'], ['Weight', 'n'], ['Validity', 'n']]) head.append(el('th', cls, label));
  const thead = el('thead');
  thead.append(head);
  const body = el('tbody');
  const ordered = [...detail.rubrics].sort((a, b) => (a.passRate ?? 2) - (b.passRate ?? 2));
  for (const rubric of ordered) {
    const tr = el('tr');
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
      passing.append(meter);
    }
    const validity = el('td', 'n', rubric.verified ? rubric.validity.toFixed(2) : 'unchecked');
    if (!rubric.verified) validity.classList.add('muted');
    tr.append(name, passing, el('td', 'n', String(rubric.answered)), el('td', 'n', String(rubric.weight)), validity);
    body.append(tr);
  }
  table.append(thead, body);
  return table;
}

function failingList(detail) {
  if (!detail.failing.length) return el('p', 'hint', 'No session in this window scored below 60% of the ideal.');
  const names = new Map(watch.rubrics.map((rubric) => [rubric.id, rubric.name]));
  const list = el('div', 'failing');
  for (const item of detail.failing) {
    const row = el('button', 'failing-row');
    row.type = 'button';
    row.append(
      el('span', 'sid', shortId(item.sessionId)),
      el('span', 'when', new Date(item.startedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })),
      el('span', `score ${band(item.composite).cls}`, pct(item.composite)),
      el('span', 'hint', item.worst.slice(0, 3).map((id) => names.get(id) ?? id).join(', ') || '—'),
    );
    row.addEventListener('click', async () => {
      try {
        const session = await json(`/api/sessions/${encodeURIComponent(item.sessionId)}?agentId=${encodeURIComponent(watch.current.agent.id)}`);
        window.dispatchEvent(new CustomEvent('open-session', { detail: session }));
      } catch (error) {
        notice('agent-notice', error.message);
      }
    });
    list.append(row);
  }
  return list;
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

// ---------- routing ----------

window.addEventListener('view-shown', (event) => {
  if (event.detail === 'fleet') void loadFleet();
  if (event.detail === 'alerts') void loadAlerts();
});

// A link from an alert opens that agent; otherwise the fleet leads when there is one.
const deepLink = location.hash.match(/^#agent=([\w-]+)/);
const initial = await json('/api/agents?window=24h').catch(() => []);
watch.agents = initial;
json('/api/alerts').then(updateAlertCount).catch(() => {});
if (deepLink) void openAgent(decodeURIComponent(deepLink[1]));
else if (initial.length) window.dispatchEvent(new CustomEvent('show-view', { detail: 'fleet' }));

// Keep the board current while it is open; the collector writes in the background.
setInterval(() => {
  if (!$('view-fleet').hidden) void loadFleet();
  if (!$('view-alerts').hidden) void loadAlerts();
}, 60_000);
