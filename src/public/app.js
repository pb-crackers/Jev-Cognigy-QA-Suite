/**
 * Front end. Reads state from the API and renders it; computes nothing about
 * cost or scores itself, so the numbers on screen and the numbers in the
 * database cannot drift apart.
 *
 * The one thing it does compute locally is the composite score preview when a
 * weight slider moves, because that is the whole point of storing raw results —
 * re-weighting has to feel instant and must not cost an API call.
 */
import { $, el, json, usd } from './dom.js';

const state = {
  projects: [],
  /** Channel breakdown from the last preview, and which labels are switched on. */
  channels: [],
  excluded: new Set(),
  rubrics: [],
  run: null,
  sessions: [],
  weights: new Map(),
  editing: null,
};

const TYPE_CLASS = { boolean: 'noul', score: 'score', choice: 'choice' };
/** Kinds for the labels the server can produce, so a chip styles without a round trip. */
const KIND_BY_LABEL = new Map([
  ['Voice', 'voice'],
  ['Interaction Panel', 'panel'],
  ['REST API', 'text'],
  ['Webchat', 'text'],
  ['WhatsApp', 'text'],
  ['Facebook', 'text'],
  ['Microsoft Teams', 'text'],
  ['Slack', 'text'],
  ['Genesys', 'text'],
  ['Twilio', 'text'],
  ['Socket.IO', 'text'],
  ['Webhook', 'text'],
]);
const TYPE_LABEL = { boolean: 'True/false', score: 'Score', choice: 'Choice' };

// ---------- navigation ----------

function show(view) {
  for (const section of document.querySelectorAll('.view')) {
    section.hidden = section.id !== `view-${view}`;
  }
  for (const tab of document.querySelectorAll('.tab')) {
    tab.classList.toggle('on', tab.dataset.view === view);
  }
  // Agent Watch's views live in their own module and refresh when shown.
  window.dispatchEvent(new CustomEvent('view-shown', { detail: view }));
}
window.addEventListener('show-view', (event) => show(event.detail));

$('tabs').addEventListener('click', (event) => {
  const tab = event.target.closest('.tab');
  if (tab) show(tab.dataset.view);
});

// ---------- rubric editor drawer ----------

function openSessionDrawer() {
  $('session-drawer').classList.add('open');
  $('scrim').hidden = false;
}

function closeSessionDrawer() {
  $('session-drawer').classList.remove('open');
  $('scrim').hidden = true;
}

function openDrawer() {
  $('drawer').classList.add('open');
  $('scrim').hidden = false;
  $('r-name').focus();
}

function closeDrawer() {
  $('drawer').classList.remove('open');
  $('scrim').hidden = true;
  state.editing = null;
  renderRubrics();
}

$('btn-scores-info').addEventListener('click', (event) => {
  const info = $('scores-info');
  info.hidden = !info.hidden;
  event.currentTarget.setAttribute('aria-expanded', String(!info.hidden));
});

/**
 * Two disclosures, both remembered.
 *
 * The page exists to be read, not configured: the query that produced the table
 * is a line you open when you want to change it, and the ten weight sliders —
 * which were the largest thing on the page — sit behind a control. Both states
 * persist, so the layout matches how you actually use it rather than resetting
 * to the busiest arrangement every visit.
 */
function disclose(button, panel, key, labels) {
  const set = (open) => {
    panel.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    if (labels) button.textContent = open ? labels.open : labels.shut;
    try {
      localStorage.setItem(key, open ? 'open' : 'shut');
    } catch {
      // Storage refused; the disclosure still works for this visit.
    }
  };

  let initial = false;
  try {
    initial = localStorage.getItem(key) === 'open';
  } catch {
    initial = false;
  }
  set(initial);
  button.addEventListener('click', () => set(panel.hidden));
}

disclose($('btn-setup'), $('setup-panel'), 'setup-open');
disclose($('btn-weights'), $('weights-panel'), 'weights-open', {
  open: 'Hide weights',
  shut: 'Adjust weights',
});

$('btn-close-drawer').addEventListener('click', closeDrawer);
$('btn-close-session').addEventListener('click', closeSessionDrawer);
$('scrim').addEventListener('click', () => {
  closeDrawer();
  closeSessionDrawer();
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if ($('drawer').classList.contains('open')) closeDrawer();
  if ($('session-drawer').classList.contains('open')) closeSessionDrawer();
});

// ---------- run ----------

function isoStart(value) {
  return `${value}T00:00:00Z`;
}
function isoEnd(value) {
  return `${value}T23:59:59Z`;
}

/** Raw channel values for every label currently switched on, or undefined for all. */
function selectedChannels() {
  if (state.channels.length === 0 || state.excluded.size === 0) return undefined;
  return state.channels
    .filter((entry) => !state.excluded.has(entry.label))
    .flatMap((entry) => entry.raws);
}

/**
 * Dark unless the reader says otherwise.
 *
 * Deliberately not matched to `prefers-color-scheme`: two of the four status
 * colours are below 3:1 on the light surface, so dark is the ground this
 * palette was built for. The choice, once made, is remembered.
 */
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $('btn-theme').textContent = theme === 'light' ? '\u25D0 dark' : '\u25D0 light';
  try {
    localStorage.setItem('theme', theme);
  } catch {
    // Private browsing refuses storage; the theme still applies for this visit.
  }
}

function storedTheme() {
  try {
    return localStorage.getItem('theme') === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

applyTheme(storedTheme());
$('btn-theme').addEventListener('click', () =>
  applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'),
);

function renderChannelFilter() {
  const box = $('chan-filter');
  box.replaceChildren(el('span', 'lead', 'Include'));

  if (state.channels.length === 0) {
    box.hidden = true;
    return;
  }
  box.hidden = false;

  for (const entry of state.channels) {
    const on = !state.excluded.has(entry.label);
    const button = el('button', `chan-toggle ${entry.kind}`);
    button.type = 'button';
    button.setAttribute('aria-pressed', String(on));
    if (!entry.known) button.title = `Unrecognised channel: ${entry.raws.join(', ')}`;
    button.append(
      el('span', 'dot'),
      document.createTextNode(entry.label),
      el('span', 'n', String(entry.sessions)),
    );
    button.addEventListener('click', () => {
      if (state.excluded.has(entry.label)) state.excluded.delete(entry.label);
      else state.excluded.add(entry.label);
      renderChannelFilter();
      void preview();
    });
    box.append(button);
  }
}

function runRequest() {
  const project = state.projects.find((candidate) => candidate.id === $('project').value);
  const endpoint = $('endpoint').value;
  return {
    projectId: project?.id,
    projectName: project?.name ?? '',
    endpointName: endpoint === '*' ? undefined : endpoint === '' ? null : endpoint,
    channels: selectedChannels(),
    from: isoStart($('from').value),
    to: isoEnd($('to').value),
    limit: Number($('limit').value),
    skipScored: $('skip').checked,
  };
}

async function loadEndpoints() {
  const select = $('endpoint');
  select.replaceChildren(new Option('Any', '*'));
  const projectId = $('project').value;
  if (!projectId) return;

  const endpoints = await json(`/api/endpoints?projectId=${encodeURIComponent(projectId)}`);
  // A session with no endpoint came from the Interaction Panel. Those are most
  // of the data in a trial environment, so they get an explicit option rather
  // than being quietly unreachable.
  select.append(new Option('Interaction Panel (no endpoint)', ''));
  for (const endpoint of endpoints) select.append(new Option(endpoint.name, endpoint.name));
}

/**
 * The one-line answer to "what am I looking at".
 *
 * Deliberately not a breadcrumb of field values: it names the project and the
 * range in the words you would use out loud, and says nothing about fields you
 * have left alone.
 */
function describeRun() {
  const project = $('project').selectedOptions[0]?.textContent?.trim();
  if (!project) {
    $('setup-what').textContent = 'Choose a project';
    return;
  }

  const endpoint = $('endpoint').selectedOptions[0]?.textContent?.trim();
  const short = (value) => {
    const date = new Date(`${value}T00:00:00`);
    return Number.isNaN(date.getTime())
      ? value
      : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  };

  const parts = [project];
  if (endpoint && !/^any/i.test(endpoint)) parts.push(endpoint);
  if ($('from').value && $('to').value) {
    parts.push(`${short($('from').value)} to ${short($('to').value)}`);
  }
  if (state.excluded.size > 0) {
    const kept = state.channels.filter((channel) => !state.excluded.has(channel.raws[0]));
    parts.push(kept.map((channel) => channel.label.toLowerCase()).join(' and ') || 'nothing');
  }
  $('setup-what').textContent = parts.join(', ');
}

async function preview() {
  const request = runRequest();
  if (!request.projectId) return;
  describeRun();
  $('preview').textContent = 'counting…';
  try {
    const result = await json('/api/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
    state.channels = result.byChannel ?? [];
    renderChannelFilter();

    describeRun();

    const nothingIncluded =
      state.channels.length > 0 && state.excluded.size === state.channels.length;
    const sessions = `${result.matched} session${result.matched === 1 ? '' : 's'}`;

    // Written as a sentence rather than a row of counts joined by dots: the
    // reader wants to know whether there is anything to do, not five numbers.
    let line;
    if (nothingIncluded) line = 'no channels included, so nothing will be pulled';
    else if (result.matched === 0) line = 'no sessions in this range';
    else if (result.toScore === 0) line = `${sessions}, all scored already`;
    else if (result.alreadyScored === 0) line = `${sessions}, none scored yet`;
    else line = `${sessions}, ${result.toScore} still to score`;
    if (result.masked) line += `, ${result.masked} masked`;
    $('preview').textContent = line;

    $('btn-run').disabled = result.toScore === 0;
    // A button says what pressing it will do.
    $('btn-run').textContent =
      result.toScore > 0
        ? `Score ${result.toScore} session${result.toScore === 1 ? '' : 's'}`
        : 'Nothing to score';
  } catch (error) {
    $('preview').textContent = '';
    showError('run-error', error.message);
  }
}

function showError(target, message, kind = '') {
  const box = el('div', `err ${kind}`);
  box.append(el('span', 'ic', kind === 'warn' ? '!' : 'x'), el('span', null, message));
  $(target).replaceChildren(box);
}

$('btn-preview').addEventListener('click', () => void preview());

// Changing the range used to leave the previous range's counts on screen. That
// was cosmetic while the count was a sentence; now that the counts are the
// filter, a stale one would exclude the wrong sessions. Debounced so typing a
// date does not fire a query per keystroke.
let previewTimer;
const schedulePreview = () => {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => void preview(), 400);
};
for (const id of ['from', 'to', 'limit']) {
  $(id).addEventListener('change', schedulePreview);
}
// Date fields also fire `input` while being typed into; the debounce is what
// keeps that from becoming a query per keystroke.
for (const id of ['from', 'to']) {
  $(id).addEventListener('input', schedulePreview);
}
$('project').addEventListener('change', async () => {
  await loadEndpoints();
  await preview();
});
$('endpoint').addEventListener('change', () => void preview());

$('btn-run').addEventListener('click', async () => {
  const request = runRequest();
  $('run-error').replaceChildren();
  $('btn-run').disabled = true;
  $('progress').hidden = false;

  // The run streams progress, so it is read as an event stream rather than a
  // single response; a batch is paced by Cognigy's rate limits and can take a while.
  const response = await fetch('/api/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      const name = frame.match(/^event: (.+)$/m)?.[1];
      const data = JSON.parse(frame.match(/^data: (.+)$/m)?.[1] ?? '{}');

      if (name === 'progress') {
        const pct = data.total ? (data.done / data.total) * 100 : 0;
        $('progress-bar').style.width = `${pct}%`;
        $('progress-text').textContent =
          `${data.done} of ${data.total} · ${usd(data.costUsd)} spent` +
          (data.chunksSplit ? ` · ${data.chunksSplit} split` : '');
      } else if (name === 'done') {
        $('progress-bar').style.width = '100%';
        $('progress-text').textContent =
          `Scored ${data.sessions} session${data.sessions === 1 ? '' : 's'} · ` +
          `${usd(data.costUsd)} · ${(data.ms / 1000).toFixed(1)}s`;
        await loadRuns(data.id);
        // Results live under the form now, so bring them into view instead of
        // sending the user somewhere else to find them.
        $('results-region').scrollIntoView({ behavior: 'smooth', block: 'start' });
      } else if (name === 'failed') {
        showError('run-error', data.error);
      }
    }
  }
  $('btn-run').disabled = false;
});

// ---------- rubrics ----------

function pill(type) {
  const span = el('span', 'pill');
  const swatch = el('span', `sw ${TYPE_CLASS[type]}`);
  span.append(swatch, document.createTextNode(TYPE_LABEL[type]));
  return span;
}

const MODALITY_LABEL = { voice: 'Voice', text: 'Text' };

/**
 * The modality of a session, mirroring modalityOf() on the server. `undefined`
 * means it could not be established, and such a session is asked everything.
 */
function modalityOf(kind) {
  if (kind === 'voice') return 'voice';
  if (kind === 'text' || kind === 'panel') return 'text';
  return undefined;
}

/** Whether a rubric was asked of this session. Derived, never stored. */
function applies(rubric, session) {
  return notApplicableBecause(rubric, session) === null;
}

/**
 * Why a rubric was not asked of a session, or null when it was. Mirrors the
 * server: modality scoping, and trace rubrics needing full logging coverage.
 */
function notApplicableBecause(rubric, session) {
  const modality = modalityOf(session.channelKind);
  if (modality !== undefined && rubric.appliesTo && rubric.appliesTo !== modality) {
    return `This rubric only applies to ${rubric.appliesTo === 'voice' ? 'voice calls' : 'text conversations'}. It was never asked, so nothing was paid for it.`;
  }
  if (rubric.requiresTrace && session.traceCoverage !== 'full') {
    return session.traceCoverage === 'partial'
      ? "This rubric needs the agent's logged LLM calls for the whole conversation, and only part of it was logged, so it was not asked."
      : "This rubric needs the agent's logged LLM calls, and none were received for this conversation, so it was not asked.";
  }
  return null;
}

/** The scope pill shown beside a rubric that has one. Unscoped rubrics get none. */
function scopePill(rubric) {
  if (!rubric.appliesTo) return null;
  const pill = el('span', `scope ${rubric.appliesTo}`);
  pill.append(el('span', 'dot'), document.createTextNode(MODALITY_LABEL[rubric.appliesTo]));
  pill.title = `Only asked of ${rubric.appliesTo === 'voice' ? 'voice calls' : 'text conversations'}.`;
  return pill;
}

/**
 * A rubric's validity: the score when it has been checked, and why it is not
 * higher on hover. Unchecked reads as such — it counts at half weight in health.
 */
function validityCell(report) {
  const cell = el('td', 'n validity');
  if (!report) {
    cell.append(el('span', 'muted', 'unchecked'));
    return cell;
  }
  const score = el('span', report.warnings.length ? 'v warn' : 'v', report.validity.toFixed(2));
  cell.append(score);
  if (report.warnings.length) {
    cell.title = report.warnings.map((warning) => `• ${warning}`).join('\n');
    cell.append(el('span', 'wcount', `${report.warnings.length} note${report.warnings.length === 1 ? '' : 's'}`));
  }
  return cell;
}

async function loadValidity() {
  state.validity = await json('/api/validity').catch(() => ({}));
  renderRubrics();
}

$('btn-check-validity').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = 'Checking…';
  try {
    const result = await json('/api/validity', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stability: true }),
    });
    state.validity = Object.fromEntries(result.reports.map((report) => [report.rubricId, report]));
    renderRubrics();
    $('rubric-hint').textContent = `Checked ${result.reports.length} rubrics for ${usd(result.costUsd)}`;
  } catch (error) {
    $('rubric-hint').textContent = `Validity check failed: ${error.message}`;
  } finally {
    button.disabled = false;
    button.textContent = 'Check validity';
  }
});

$('r-kind').addEventListener('change', () => {
  $('alert-rule').hidden = $('r-kind').value !== 'alert';
  // An alert is a yes/no question by definition.
  if ($('r-kind').value === 'alert') {
    $('r-type').value = 'boolean';
    $('r-type').dispatchEvent(new Event('change'));
  }
});

function renderRubrics() {
  const rows = $('rubric-rows');
  rows.replaceChildren();

  for (const rubric of state.rubrics) {
    const tr = el('tr', `click${state.editing?.id === rubric.id ? ' sel' : ''}`);
    const name = el('td');
    const heading = el('div', 'rname');
    heading.append(el('b', null, rubric.name));
    const scope = scopePill(rubric);
    if (scope) heading.append(scope);
    name.append(heading, el('div', 'rd', rubric.question));
    // Most rubrics ship with the tool, so the badge marks the exception: ones written here.
    if (rubric.origin === 'custom') heading.append(el('span', 'badge', 'custom'));
    if (rubric.kind === 'alert') {
      const rule = rubric.alert;
      heading.append(el('span', 'badge alert',
        rule && rule.threshold > 1 ? `alert at ${rule.threshold} per ${rule.window}` : 'alert'));
    }
    if (rubric.requiresTrace) heading.append(el('span', 'badge', 'needs logging'));
    const type = el('td');
    type.append(pill(rubric.type));
    tr.append(name, type, el('td', 'n', String(rubric.weight)), validityCell(state.validity?.[rubric.id]));
    tr.addEventListener('click', () => editRubric(rubric));
    rows.append(tr);
  }
  $('rubric-count').textContent =
    `Rubrics (${state.rubrics.length})`;
  $('rubric-hint').textContent = 'Every rubric is answered in the same request';
}

function editRubric(rubric) {
  state.editing = rubric;
  $('rubric-error').replaceChildren();
  $('editor-title').textContent = rubric ? 'Edit rubric' : 'New rubric';
  $('btn-delete').hidden = !rubric;
  $('r-name').value = rubric?.name ?? '';
  $('r-question').value = rubric?.question ?? '';
  $('r-type').value = rubric?.type ?? 'boolean';
  $('r-applies').value = rubric?.appliesTo ?? '';
  $('r-note-voice').value = rubric?.notes?.voice ?? '';
  $('r-note-text').value = rubric?.notes?.text ?? '';
  $('r-weight').value = rubric?.weight ?? 1;
  $('r-invert').value = rubric?.invert ? 'yes' : 'no';
  $('r-kind').value = rubric?.kind === 'alert' ? 'alert' : 'quality';
  $('r-threshold').value = rubric?.alert?.threshold ?? 1;
  $('r-window').value = rubric?.alert?.window ?? 'session';
  $('r-intent').value = rubric?.intent ?? '';
  $('r-trace').checked = Boolean(rubric?.requiresTrace);
  $('r-general').checked = Boolean(rubric?.general);
  $('alert-rule').hidden = $('r-kind').value !== 'alert';
  $('r-true').value = rubric?.trueMeans ?? '';
  $('r-false').value = rubric?.falseMeans ?? '';
  renderLevels(rubric?.levels ?? ['', '']);
  renderOptions(
    Object.entries(rubric?.options ?? { '': '' }).map(([key, description]) => ({
      key,
      description,
      goodness: rubric?.optionScores?.[key] ?? 1,
    })),
  );
  syncTypeFields();
  syncModalityFields();
  renderRubrics();
  openDrawer();
}

/**
 * Score levels and choice options are repeated inputs rather than a formatted
 * textarea: one box per item, added and removed on demand, so nobody has to
 * remember a delimiter.
 */
function removeButton(onClick) {
  const button = el('button', 'btn rm', '\u00d7');
  button.type = 'button';
  button.title = 'Remove';
  button.addEventListener('click', onClick);
  return button;
}

function renderLevels(levels) {
  const list = $('levels-list');
  list.replaceChildren();

  levels.forEach((level, index) => {
    const row = el('div', 'row-item level');
    const input = el('input', 'ctl');
    input.value = level;
    input.placeholder = index === 0 ? 'Worst outcome' : 'What this level looks like';
    row.append(
      el('span', 'idx', String(index)),
      input,
      // Two levels is the minimum a score can have, so the control disappears there.
      levels.length > 2
        ? removeButton(() => renderLevels(readLevels().filter((_, i) => i !== index)))
        : el('span'),
    );
    list.append(row);
  });
}

function readLevels() {
  return [...$('levels-list').querySelectorAll('input')].map((input) => input.value);
}

function renderOptions(options) {
  const list = $('options-list');
  list.replaceChildren();

  options.forEach((option, index) => {
    const row = el('div', 'row-item option');
    const key = el('input', 'ctl');
    key.value = option.key;
    key.placeholder = 'e.g. too_late';
    const description = el('input', 'ctl');
    description.value = option.description;
    description.placeholder = 'When the model should pick this option';
    const goodness = el('input', 'ctl');
    goodness.type = 'number';
    goodness.min = '0';
    goodness.max = '1';
    goodness.step = '0.25';
    goodness.value = String(option.goodness);
    goodness.title = 'How much this outcome counts: 1 is the best, 0 the worst';

    description.className = 'ctl desc';
    // DOM order is column order here, so it must match the header: option,
    // what it means, counts as, remove.
    row.append(
      key,
      description,
      goodness,
      options.length > 2
        ? removeButton(() => renderOptions(readOptions().filter((_, i) => i !== index)))
        : el('span'),
    );
    list.append(row);
  });
}

function readOptions() {
  // Read by role rather than by position: the stacked layout puts the
  // description last in the DOM but first in meaning.
  return [...$('options-list').querySelectorAll('.row-item')].map((row) => {
    const inputs = [...row.querySelectorAll('input')];
    const description = row.querySelector('.desc');
    const goodness = row.querySelector('input[type=number]');
    const key = inputs.find((input) => input !== description && input !== goodness);
    return {
      key: key?.value.trim() ?? '',
      description: description?.value.trim() ?? '',
      goodness: goodness?.value === '' ? 1 : Number(goodness?.value ?? 1),
    };
  });
}

$('add-level').addEventListener('click', () => renderLevels([...readLevels(), '']));
$('add-option').addEventListener('click', () =>
  renderOptions([...readOptions(), { key: '', description: '', goodness: 1 }]),
);

function syncTypeFields() {
  const type = $('r-type').value;
  $('type-boolean').hidden = type !== 'boolean';
  $('type-score').hidden = type !== 'score';
  $('type-choice').hidden = type !== 'choice';
}

/**
 * A note for a modality the rubric never runs on would never be sent, so the
 * field goes away rather than sitting there inviting text that is discarded.
 */
function syncModalityFields() {
  const scope = $('r-applies').value;
  $('note-voice').hidden = scope === 'text';
  $('note-text').hidden = scope === 'voice';
}

$('r-type').addEventListener('change', syncTypeFields);
$('r-applies').addEventListener('change', syncModalityFields);
$('btn-new-rubric').addEventListener('click', () => editRubric(null));

$('rubric-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const type = $('r-type').value;
  const rubric = {
    id: state.editing?.id,
    name: $('r-name').value.trim(),
    question: $('r-question').value.trim(),
    type,
    weight: Number($('r-weight').value),
    enabled: true,
    invert: $('r-invert').value === 'yes',
    kind: $('r-kind').value,
    alert: $('r-kind').value === 'alert'
      ? { threshold: Number($('r-threshold').value) || 1, window: $('r-window').value }
      : undefined,
    intent: $('r-intent').value.trim() || undefined,
    requiresTrace: $('r-trace').checked || undefined,
    general: $('r-general').checked || undefined,
    appliesTo: $('r-applies').value || undefined,
    notes: {
      voice: $('r-note-voice').value.trim() || undefined,
      text: $('r-note-text').value.trim() || undefined,
    },
  };

  if (type === 'boolean') {
    rubric.trueMeans = $('r-true').value.trim() || undefined;
    rubric.falseMeans = $('r-false').value.trim() || undefined;
  } else if (type === 'score') {
    rubric.levels = readLevels().map((level) => level.trim()).filter(Boolean);
    if (rubric.levels.length < 2) {
      showError('rubric-error', 'A score rubric needs at least two levels.');
      return;
    }
  } else {
    rubric.options = {};
    rubric.optionScores = {};
    for (const option of readOptions()) {
      if (!option.key) continue;
      rubric.options[option.key] = option.description || option.key;
      rubric.optionScores[option.key] = option.goodness;
    }
    if (Object.keys(rubric.options).length < 2) {
      showError('rubric-error', 'A choice rubric needs at least two options.');
      return;
    }
  }

  await json('/api/rubrics', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(rubric),
  });
  state.rubrics = await json('/api/rubrics');
  closeDrawer();
});

$('btn-delete').addEventListener('click', async () => {
  if (!state.editing) return;
  await json(`/api/rubrics/${state.editing.id}`, { method: 'DELETE' });
  state.rubrics = await json('/api/rubrics');
  closeDrawer();
});

// ---------- results ----------

/**
 * Composite from stored raw values and the current weights. Mirrors the
 * server's normalisation so a slider is instant; the server remains the source
 * of truth for what was stored.
 */
function composite(session) {
  let weighted = 0;
  let total = 0;
  let counted = 0;
  for (const rubric of state.rubrics) {
    const result = session.results[rubric.id];
    if (!result || result.normalized === undefined || result.normalized === null) continue;
    const weight = state.weights.get(rubric.id) ?? rubric.weight;
    weighted += result.normalized * weight;
    total += weight;
    counted++;
  }
  // The count travels with the score because a scoped rubric can shrink the
  // basis: two sessions can both read 4.2 and not be measuring the same thing.
  return { score: total > 0 ? (weighted / total) * 5 : undefined, counted };
}

function renderWeights() {
  const box = $('weights');
  box.replaceChildren();

  for (const rubric of state.rubrics) {
    const wrap = el('label', 'w');
    const label = el('span', 'wl');
    const value = el('b', null, String(state.weights.get(rubric.id) ?? rubric.weight));
    label.append(el('span', null, rubric.name), value);
    const slider = el('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '5';
    slider.step = '1';
    slider.value = String(state.weights.get(rubric.id) ?? rubric.weight);
    slider.addEventListener('input', () => {
      state.weights.set(rubric.id, Number(slider.value));
      value.textContent = slider.value;
      renderTable();
    });
    wrap.append(label, slider);
    box.append(wrap);
  }

  const note = el('span', 'wnote',
    'Re-ranks instantly — weights are applied to stored scores, nothing is re-scored.');
  box.append(note);
}

/** The channel label for a stored session, falling back to its raw value. */
function channelChip(session) {
  const label = session.channelLabel ?? session.channel ?? 'Unknown';
  const kind = KIND_BY_LABEL.get(label) ?? (session.channelLabel ? 'text' : 'unknown');
  const chip = el('span', `chan ${kind}`);
  chip.append(el('span', 'dot'), document.createTextNode(label));
  if (session.channel && session.channel !== label) chip.title = `channel: ${session.channel}`;
  return chip;
}

function channelCell(session) {
  const cell = el('td');
  cell.append(channelChip(session));
  return cell;
}

/**
 * How likely Jev's yes/no answer is — the probability of the answer shown, so a
 * "no" reads "probability 0.62", never the 0.38 chance of yes.
 */
function answerProbability(result) {
  const yes = Number(result.raw);
  return yes >= 0.5 ? yes : 1 - yes;
}

function rawLabel(rubric, result) {
  if (rubric.type === 'boolean') return Number(result.raw) >= 0.5 ? 'yes' : 'no';
  if (rubric.type === 'score') return Number(result.raw).toFixed(1);
  return String(result.raw);
}

/**
 * A score as filled and unfilled block characters.
 *
 * Block characters rather than a div so the bar sits on the same monospace grid
 * as the number beside it: the column stays aligned without either element
 * knowing the other's width.
 */
/**
 * A timestamp as a fixed-width `MM-DD HH:MM`.
 *
 * `toLocaleString` is the right thing for a single date on its own, but down a
 * column its width varies with the hour and the meridiem, so the column stops
 * lining up. The year is in the run's own date range above the table.
 */
function stamp(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const METER_CELLS = 10;

function bars(score) {
  const filled = score === undefined ? 0 : Math.round((score / 5) * METER_CELLS);
  const span = el('span', 'bars');
  span.append(document.createTextNode('\u2588'.repeat(filled)));
  if (filled < METER_CELLS) {
    span.append(el('span', 'off', '\u2588'.repeat(METER_CELLS - filled)));
  }
  return span;
}

function renderTable() {
  const scored = state.sessions
    .map((session) => ({ session, ...composite(session) }))
    .sort((a, b) => (a.score ?? -1) - (b.score ?? -1));

  const table = el('table');
  const head = el('tr');
  head.append(
    el('th', null, 'Session'),
    el('th', null, 'Channel'),
    el('th', null, 'When'),
    el('th', null, 'Endpoint'),
    el('th', 'n', 'Turns'),
    el('th', 'n', 'Overall'),
    el('th', null, 'Review'),
  );
  const thead = el('thead');
  thead.append(head);

  const body = el('tbody');
  for (const { session, score, counted } of scored) {
    const tr = el('tr', 'click');
    tr.append(el('td', 'sid', session.sessionId.slice(0, 8)));
    tr.append(channelCell(session));
    tr.append(el('td', 'when', stamp(session.startedAt)));
    tr.append(el('td', 'flow', session.flowName ?? session.endpointLabel));
    tr.append(el('td', 'n', String(session.turns)));

    if (session.unscoreable) {
      const cell = el('td', 'rd');
      cell.colSpan = 2;
      cell.textContent =
        session.unscoreable === 'masked'
          ? 'Not scoreable — transcript is masked (PII redaction)'
          : 'Not scoreable — no conversation content';
      tr.append(cell);
    } else {
      const overall = el('td', 'n');
      const meter = el('div', 'meter wide');
      meter.append(bars(score), el('span', 'v', score === undefined ? '—' : score.toFixed(1)));
      overall.append(meter);
      const asked = state.rubrics.filter((rubric) => applies(rubric, session)).length;
      const basis = el('span', 'basis', `${counted} of ${state.rubrics.length} rubrics`);
      basis.title =
        asked < state.rubrics.length
          ? `${state.rubrics.length - asked} rubric(s) do not apply to this conversation.`
          : 'Every rubric in the library applies to this conversation.';
      overall.append(basis);
      tr.append(overall);

      const review = el('td');
      if (session.flagged.length > 0) {
        const flag = el('span', 'flag', `${session.flagged.length} low confidence`);
        flag.title = state.rubrics
          .filter((rubric) => session.flagged.includes(rubric.id))
          .map((rubric) => rubric.name)
          .join(', ');
        review.append(flag);
      }
      tr.append(review);
    }

    tr.addEventListener('click', async () => {
      // An agent's session has its tool calls in their own records; fetch them with it.
      if (!state.run?.agentId) return openSession(session);
      try {
        openSession(await json(`/api/sessions/${encodeURIComponent(session.sessionId)}?agentId=${encodeURIComponent(state.run.agentId)}`));
      } catch {
        openSession(session);
      }
    });
    body.append(tr);
  }

  table.append(thead, body);
  $('results-table').replaceChildren(table);

  const flagged = state.sessions.filter((session) => session.flagged.length > 0).length;
  const skipped = state.sessions.filter((session) => session.unscoreable).length;
  const notes = [
    flagged ? `${flagged} flagged for review` : null,
    skipped ? `${skipped} could not be scored` : null,
  ].filter(Boolean);
  $('results-foot').textContent =
    `${state.sessions.length} session${state.sessions.length === 1 ? '' : 's'}` +
    `${notes.length ? `, ${notes.join(' and ')}` : ''}. ` +
    `Scored in ${(state.run.ms / 1000).toFixed(1)}s for ${usd(state.run.costUsd)}` +
    `${state.comparison ? ` — ${state.comparison}` : ''}. ` +
    'Open a row to read the transcript.';
}

async function loadRuns(selectId) {
  const runs = await json('/api/runs');
  const select = $('run-select');
  select.replaceChildren();
  for (const run of runs) {
    const at = new Date(run.startedAt);
    const when = at.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) +
      ' ' + at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    select.append(new Option(`${run.projectName}, ${when}`, run.id));
  }
  if (runs.length === 0) {
    $('results-region').hidden = true;
    return;
  }
  $('results-region').hidden = false;
  select.value = selectId ?? runs[0].id;
  await loadRun(select.value);
}

async function loadRun(runId) {
  const payload = await json(`/api/runs/${runId}`);
  state.run = payload.run;
  state.rubrics = payload.rubrics;
  state.sessions = payload.sessions;
  state.weights = new Map(payload.rubrics.map((rubric) => [rubric.id, rubric.weight]));

  // Kept as a fact about the run, reported in the footer beside what it cost,
  // rather than as a headline above the table.
  const cheapest = payload.comparison[0];
  state.comparison = cheapest
    ? `the same tokens on ${cheapest.label} would have cost ${usd(cheapest.uncachedUsd)}`
    : '';
  renderWeights();
  renderTable();
}

$('run-select').addEventListener('change', (event) => void loadRun(event.target.value));

// ---------- briefing ----------

/**
 * A synthesised write-up of the run, for handing to a coding agent or reading
 * directly. Markdown rather than JSON, because the audience is a reader.
 */
async function fetchBriefing() {
  const response = await fetch(`/api/runs/${state.run.id}/briefing`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

$('btn-copy-brief').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  const original = button.textContent;
  try {
    await navigator.clipboard.writeText(await fetchBriefing());
    button.textContent = 'Copied';
  } catch {
    // Clipboard access can be refused; downloading always works.
    button.textContent = 'Copy blocked — use Download';
  }
  setTimeout(() => {
    button.textContent = original;
  }, 2200);
});

$('btn-download-brief').addEventListener('click', async () => {
  const markdown = await fetchBriefing();
  const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown' }));
  const link = el('a');
  link.href = url;
  link.download = `qa-briefing-${state.run.projectName.replace(/\W+/g, '-').toLowerCase()}.md`;
  link.click();
  URL.revokeObjectURL(url);
});

// ---------- session drill-down ----------

// Agent Watch opens a session from an agent's failing list with the same drawer.
window.addEventListener('open-session', (event) => openSession(event.detail));

// ---------- tool calls in the transcript ----------
//
// Each call sits on a rail between the customer's message and the reply it
// produced. A passing call is one quiet line; a failed check names the problem
// in words and marks the rail. Placement comes from the server — the same
// placement the grader read the calls in.

/** Failed checks in the order their words should win: the most basic problem first. */
const CALL_PROBLEMS = [
  ['args_parse', 'Unreadable arguments'],
  ['known_tool', 'Unknown tool'],
  ['schema', 'Invalid arguments'],
  ['tool_error', null],
  ['has_result', 'No result'],
];

function callStatus(call) {
  const failed = new Map(call.checks.filter((check) => check.outcome === 'fail').map((check) => [check.id, check]));
  for (const [id, word] of CALL_PROBLEMS) {
    if (!failed.has(id)) continue;
    // A tool that answered with a refusal said no; one that errored broke.
    const refused = id === 'tool_error' && /^status /.test(failed.get(id).detail ?? '');
    return { word: word ?? (refused ? 'Rejected' : 'Error'), bad: true };
  }
  if (failed.has('repeat')) return { word: 'Repeat', bad: false };
  return { word: 'OK', bad: false };
}

const showValue = (value) => (typeof value === 'string' ? value : JSON.stringify(value));

/** The first few arguments, required ones first — enough to tell two calls apart. */
function keyArgs(call) {
  const args = call.args ?? {};
  const required = call.definition?.parameters?.required ?? [];
  const keys = [...required.filter((key) => key in args), ...Object.keys(args).filter((key) => !required.includes(key))];
  return keys.slice(0, 3).map((key) => `${key} ${showValue(args[key])}`).join(', ');
}

/** Whole seconds between the model deciding to call and the result being read: as precise as the logs are. */
function seconds(from, to) {
  if (!from || !to) return '';
  const ms = Date.parse(to) - Date.parse(from);
  return Number.isFinite(ms) && ms >= 0 ? `≈${Math.max(1, Math.round(ms / 1000))} s` : '';
}

function schemaNote(schema, required) {
  if (!schema) return required ? 'required' : '';
  if (Array.isArray(schema.enum)) return `one of ${schema.enum.join(', ')}`;
  const type = Array.isArray(schema.type) ? schema.type.join(' or ') : schema.type;
  return [type, required ? 'required' : ''].filter(Boolean).join(', ');
}

function callDetail(call, times) {
  const box = el('div', 'detail');
  const failure = call.checks.find((check) => check.id === 'tool_error' && check.outcome === 'fail');
  if (failure) box.append(el('div', 'callout', `The tool refused the call: ${failure.detail}`));

  const schema = call.definition?.parameters;
  const args = el('div');
  args.append(el('h4', null, schema ? "Arguments, checked against the tool's schema" : 'Arguments'));
  if (call.args === null) {
    args.append(el('pre', 'result', call.argsRaw));
  } else {
    const issues = call.checks.find((check) => check.id === 'schema')?.issues ?? [];
    const table = el('div', 'kv');
    const required = schema?.required ?? [];
    const keys = [...new Set([...Object.keys(call.args), ...required])];
    if (keys.length === 0) table.append(el('span', 'k', '(none)'));
    for (const key of keys) {
      const problem = issues.find((issue) => issue.path === key || issue.path.startsWith(`${key}.`) || issue.path.startsWith(`${key}[`));
      table.append(
        el('span', 'k', key),
        el('span', 'v', key in call.args ? JSON.stringify(call.args[key]) : 'missing'),
        el('span', `s${problem ? ' bad' : ''}`, problem ? problem.message : schemaNote(schema?.properties?.[key], required.includes(key))),
      );
    }
    args.append(table);
  }
  box.append(args);

  const result = el('div');
  result.append(el('h4', null, 'Result'));
  result.append(call.result === undefined
    ? el('p', 'hint', 'No result was logged for this call.')
    : el('pre', 'result', call.resultJson !== undefined ? JSON.stringify(call.resultJson) : call.result));
  box.append(result);

  const checks = el('div');
  checks.append(el('h4', null, 'Checks'));
  const list = el('ul', 'checks');
  for (const check of call.checks) {
    const word = check.outcome === 'fail' ? 'Failed' : check.outcome === 'unchecked' ? 'Not checked' : 'Passed';
    const item = el('li');
    const label = el('span', null, check.label);
    if (check.detail && check.id !== 'tool_error') label.append(el('span', 'hint', ` ${check.detail}`));
    item.append(el('span', `v ${check.outcome === 'fail' ? 'bad' : check.outcome === 'unchecked' ? 'unk' : ''}`, word), label);
    list.append(item);
  }
  checks.append(list);
  box.append(checks);

  const foot = el('div', 'foot');
  if (times > 1) foot.append(el('span', null, `called ${times} times with these arguments`));
  if (call.llm) {
    foot.append(el('span', null, `${call.llm.tokens.input.toLocaleString()} tokens in, ${call.llm.tokens.output.toLocaleString()} out`));
    if (call.llm.finishReason) foot.append(el('span', null, call.llm.finishReason === 'tool_calls' ? 'stopped for a tool call' : `stopped: ${call.llm.finishReason}`));
    if (call.llm.modelVersion || call.llm.model) foot.append(el('span', null, call.llm.modelVersion ?? call.llm.model));
  }
  if (foot.childElementCount) box.append(foot);
  return box;
}

function callRow(call, times = 1) {
  const status = callStatus(call);
  const row = el('details', `call${status.bad ? ' bad' : ''}`);
  const summary = el('summary');
  const name = el('span', 'name', call.name);
  name.append(document.createTextNode(' '), el('span', 'args', keyArgs(call)));
  const end = el('span', 'end');
  if (times > 1) end.append(el('span', 'times', `×${times}`));
  end.append(el('span', 'dur', seconds(call.calledAt, call.resultAt)));
  summary.append(el('span', 'call-chev', '›'), el('span', `status${status.bad ? ' bad' : status.word === 'Repeat' ? ' warn' : ''}`, status.word), name, end);
  row.append(summary);
  // Built when first opened: most calls are never expanded.
  row.addEventListener('toggle', () => {
    if (row.open && !row.querySelector('.detail')) row.append(callDetail(call, times));
  });
  return row;
}

/** One input's calls. Identical calls fold into ×N; three or more rows become a group that opens itself on a failure. */
function callsBlock(calls) {
  const folded = [];
  const bySignature = new Map();
  for (const call of calls) {
    const signature = `${call.name}\u0000${call.argsRaw}`;
    const same = bySignature.get(signature);
    if (same) same.times++;
    else {
      const entry = { call, times: 1 };
      bySignature.set(signature, entry);
      folded.push(entry);
    }
  }
  const block = el('div', 'calls');
  if (folded.length < 3) {
    for (const entry of folded) block.append(callRow(entry.call, entry.times));
    return block;
  }
  const failed = folded.filter((entry) => callStatus(entry.call).bad).length;
  const repeated = calls.length - folded.length;
  const group = el('details', `call group${failed ? ' bad' : ''}`);
  group.open = failed > 0;
  const summary = el('summary');
  const label = [`${calls.length} tool calls`, repeated ? `${repeated} repeated` : '', failed ? `${failed} failed` : ''].filter(Boolean).join(', ');
  const end = el('span', 'end');
  end.append(el('span', 'dur', seconds(calls[0].calledAt, calls.at(-1).resultAt)));
  summary.append(el('span', 'call-chev', '›'), el('span', `status${failed ? ' bad' : ''}`, failed ? 'Failed' : 'OK'), el('span', 'name', label), end);
  const inner = el('div', 'inner');
  for (const entry of folded) inner.append(callRow(entry.call, entry.times));
  group.append(summary, inner);
  block.append(group);
  return block;
}

function turnRow(turn, preamble = false) {
  const row = el('div', `turn ${turn.role}${turn.tool ? ' tool' : ''}${preamble ? ' preamble' : ''}`);
  row.append(
    el('span', 'who', turn.tool ? 'Tool' : turn.role === 'user' ? 'User' : turn.role === 'agent' ? 'Agent' : ''),
    el('span', null, turn.tool ? turn.text.replace(/^\[|\]$/g, '') : turn.text),
  );
  return row;
}

function renderTranscript(session) {
  const transcript = $('session-transcript');
  transcript.replaceChildren();
  // Sessions scored before tool calls had records carry them as lines in the transcript itself.
  const timeline = session.timeline ?? JSON.parse(session.transcript).map((turn) => ({ kind: 'turn', turn }));
  timeline.forEach((item, index) => {
    if (item.kind === 'calls') {
      transcript.append(callsBlock(item.calls));
      return;
    }
    // What the agent said just before calling reached the customer on its own; it reads as a lead-in.
    const next = timeline[index + 1];
    const preamble = item.turn.role === 'agent' && next?.kind === 'calls' && next.inputId === item.turn.inputId;
    transcript.append(turnRow(item.turn, preamble));
  });
}

// ---------- the rubric a session was opened from ----------
//
// Pinned above the scores, with each number on its own labelled line: the
// probability (or confidence) of Jev's answer, and its confidence about which
// agent message the answer rests on. That message is found on request — one
// Jev question, stored afterwards — then marked in the transcript.

function factRow(list, term, value, label) {
  list.append(el('dt', null, term), el('dd', null, value));
  const note = el('dd', 'lbl');
  if (label) note.append(label);
  list.append(note);
  return note;
}

/** The Nth agent message in the transcript as shown, counting from 1. */
function agentRow(message) {
  return [...document.querySelectorAll('#session-transcript .turn.agent')][message - 1];
}

function markMessage(message, rubric, confidence, passed) {
  const row = agentRow(message);
  if (!row) return undefined;
  row.classList.add('pointed');
  if (passed) row.classList.add('pass');
  const chip = el('span', 'score-chip');
  chip.append(el('span', 'name', rubric.name), el('span', 'value', `confidence ${confidence.toFixed(2)}`));
  const text = row.lastElementChild;
  text.prepend(chip, el('br'));
  row.scrollIntoView({ block: 'center' });
  return row;
}

function pinnedRubric(session, rubric) {
  const result = session.results[rubric.id];
  const passed = result.normalized === undefined ? null : result.normalized >= 0.5;
  const box = el('div', `pinned${passed === false ? '' : ' neutral'}`);
  const head = el('div', 'rh');
  head.append(el('span', 'rn', rubric.name), el('span', `rv${passed === false ? ' fail' : passed ? ' pass' : ''}`,
    passed === false ? 'Failed' : passed ? 'Passed' : rawLabel(rubric, result)));
  const facts = el('dl', 'facts');
  factRow(facts, 'Answer', rawLabel(rubric, result), rubric.type === 'boolean'
    ? `probability ${answerProbability(result).toFixed(2)}`
    : result.confidence === null ? 'no confidence reported' : `confidence ${result.confidence.toFixed(2)}`);
  const where = factRow(facts, 'Message', '…', 'finding the message…');
  box.append(head, facts);

  const whereValue = where.previousElementSibling;
  json(`/api/sessions/${encodeURIComponent(session.sessionId)}/locate`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agentId: session.agentId, rubricId: rubric.id }),
  }).then((located) => {
    where.replaceChildren();
    if (located.message === null || located.turnIndex === null) {
      whereValue.textContent = located.message === null ? 'none' : `#${located.message}?`;
      where.append(located.reason ?? 'no single message decides this one');
      return;
    }
    whereValue.textContent = `#${located.message}`;
    where.append(`confidence ${located.confidence.toFixed(2)} `);
    const row = markMessage(located.message, rubric, located.confidence, passed === true);
    if (row) {
      const jump = el('button', 'jump', 'Go to it');
      jump.type = 'button';
      jump.addEventListener('click', () => row.scrollIntoView({ block: 'center', behavior: 'smooth' }));
      where.append(jump);
    }
  }).catch((error) => {
    whereValue.textContent = '—';
    where.replaceChildren(`couldn’t find it: ${error.message}`);
  });
  return box;
}

/** In place of scores: why there are none, and what happens next. */
function notScored(session) {
  const box = el('div', 'notscored');
  if (!session.error) {
    box.append(el('strong', null, 'Not scored'), el('p', null, session.unscoreable));
    return box;
  }
  const attempts = session.attempts ?? 1;
  box.append(
    el('strong', null, 'Not scored yet'),
    el('p', null, `Scoring failed: ${session.error}`),
    el('p', null, attempts < 3
      ? `Tried ${attempts} of 3 times. The next collection tries again.`
      : 'Tried 3 times, so it won’t be retried on its own.'),
  );
  if (session.agentId) {
    const retry = el('button', 'btn ghost', 'Score it now');
    retry.type = 'button';
    retry.addEventListener('click', async () => {
      retry.disabled = true;
      retry.textContent = 'Scoring…';
      try {
        await json(`/api/agents/${encodeURIComponent(session.agentId)}/retry`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: session.sessionId }),
        });
        openSession(await json(`/api/sessions/${encodeURIComponent(session.sessionId)}?agentId=${encodeURIComponent(session.agentId)}`));
      } catch (error) {
        retry.disabled = false;
        retry.textContent = 'Score it now';
        box.append(el('p', 'flagc', error.message));
      }
    });
    box.append(retry);
  }
  return box;
}

function openSession(session) {
  const calls = session.toolCalls?.length ?? 0;
  const meta = $('session-meta');
  meta.replaceChildren(
    document.createTextNode(`${session.sessionId.slice(0, 8)} `),
    channelChip(session),
    document.createTextNode(
      ` ${session.turns} turns, ${session.endpointLabel}` +
        (calls ? `, ${calls} tool call${calls === 1 ? '' : 's'}` : '') +
        (session.chunks > 1 ? `, split into ${session.chunks} chunks` : ''),
    ),
  );

  renderTranscript(session);

  const panel = $('session-rubrics');
  panel.replaceChildren();
  if (session.error || session.unscoreable) {
    panel.append(notScored(session));
    // A failed re-score leaves the earlier answers standing; health still counts them, so they show.
    if (session.unscoreable || Object.keys(session.results).length === 0) {
      openSessionDrawer();
      return;
    }
    panel.append(el('p', 'hint', 'Scores from an earlier attempt:'));
  }

  // A session from an agent lists that agent's rubrics; an ad-hoc run's, every rubric.
  const listed = session.rubricIds ? state.rubrics.filter((rubric) => session.rubricIds.includes(rubric.id) || session.results[rubric.id]) : state.rubrics;
  const focused = session.focusRubric ? state.rubrics.find((rubric) => rubric.id === session.focusRubric) : undefined;
  if (focused && session.results[focused.id]) panel.append(pinnedRubric(session, focused));

  for (const rubric of listed) {
    if (rubric === focused && session.results[rubric.id]) continue;
    const result = session.results[rubric.id];

    // Two different silences, and conflating them hides a real problem. A rubric
    // scoped away from this modality was never asked and nothing was paid for
    // it; a rubric that was asked and came back empty is worth investigating.
    if (!result) {
      const missing = el('div', applies(rubric, session) ? 'r none' : 'r na');
      const head = el('div', 'rh');
      const name = el('span', 'rn');
      name.append(document.createTextNode(rubric.name));
      const scope = scopePill(rubric);
      if (scope) name.append(scope);
      head.append(name, el('span', 'rv', applies(rubric, session) ? '—' : 'Not applicable'));
      missing.append(head, el('div', 'rq', rubric.question));
      missing.append(el('div', 'meta', notApplicableBecause(rubric, session) ?? 'Asked, but no answer came back.'));
      panel.append(missing);
      continue;
    }

    const row = el('div', 'r');
    const header = el('div', 'rh');
    const rubricName = el('span', 'rn');
    rubricName.append(document.createTextNode(rubric.name));
    const namePill = scopePill(rubric);
    if (namePill) rubricName.append(namePill);
    header.append(rubricName, el('span', 'rv', rawLabel(rubric, result)));

    // The question is the only thing that makes a number interpretable.
    const question = el('div', 'rq', rubric.question);

    const meta = el('div', 'meta');
    meta.append(pill(rubric.type));

    // Jev reports a confidence for score and option questions but not for yes/no
    // ones, where the probability itself is the certainty. Saying which is which
    // is clearer than a line that silently changes shape between rubrics.
    if (rubric.type === 'boolean') {
      meta.append(el('span', 'certainty', `probability ${answerProbability(result).toFixed(2)}`));
      const distance = Math.abs(Number(result.raw) - 0.5);
      if (distance < 0.15) {
        const flag = el('span', 'flag', 'close to 50/50');
        flag.title = 'The model could not clearly tell either way on this one.';
        meta.append(flag);
      }
    } else if (result.confidence === null || result.confidence === undefined) {
      meta.append(el('span', 'certainty', 'no confidence reported'));
    } else {
      meta.append(el('span', 'certainty', `confidence ${result.confidence.toFixed(2)}`));
      if (result.lowConfidence) {
        const flag = el('span', 'flag', 'low');
        flag.title = 'Flagged for a human to read — the model was not certain.';
        meta.append(flag);
      }
    }

    if (result.chunks > 1) {
      meta.append(el('span', null, `${result.chunks} chunks, combined by ${rubric.combine}`));
    }

    row.append(header, question, meta);
    panel.append(row);
  }

  // Ratings are rare, so this appears only when the session actually has one.
  if (session.rating !== null) {
    const box = el('div', 'warnbox');
    const agrees = session.results.helped
      ? (Number(session.results.helped.raw) >= 0.5) === (session.rating > 0)
      : null;
    box.append(
      el('span', null, session.rating > 0 ? 'up' : 'down'),
      el('span', null,
        `End user rated this session ${session.rating > 0 ? 'positively' : 'negatively'}` +
        (agrees === null ? '.' : agrees ? ' — which agrees with the score.' : ' — which disagrees with the score.') +
        (session.ratingComment ? ` “${session.ratingComment}”` : '')),
    );
    panel.append(box);
  }

  openSessionDrawer();
}

// ---------- boot ----------

const today = new Date();
const weekAgo = new Date(today.getTime() - 7 * 86_400_000);
$('to').value = today.toISOString().slice(0, 10);
$('from').value = weekAgo.toISOString().slice(0, 10);

const [config, projects, rubrics] = await Promise.all([
  json('/api/config'),
  json('/api/projects'),
  json('/api/rubrics'),
]);

state.projects = projects;
state.rubrics = rubrics;
$('env').textContent = new URL(config.apiBase).host;
$('project').replaceChildren(...projects.map((project) => new Option(project.name, project.id)));
if (config.projectId && projects.some((project) => project.id === config.projectId)) {
  $('project').value = config.projectId;
}
await loadEndpoints();
renderRubrics();
void loadValidity();
void preview();
// Show the most recent run straight away: a tool that opens on an empty form
// tells you nothing about what it does.
void loadRuns();
