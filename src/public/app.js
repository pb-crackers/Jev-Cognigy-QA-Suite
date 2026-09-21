/**
 * Front end. Reads state from the API and renders it; computes nothing about
 * cost or scores itself, so the numbers on screen and the numbers in the
 * database cannot drift apart.
 *
 * The one thing it does compute locally is the composite score preview when a
 * weight slider moves, because that is the whole point of storing raw results —
 * re-weighting has to feel instant and must not cost an API call.
 */
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const $ = (id) => document.getElementById(id);
const usd = (n) => `$${n < 0.01 ? n.toFixed(6) : n.toFixed(2)}`;
const json = async (url, options) => {
  const response = await fetch(url, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
};

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
}

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

$('btn-weights-info').addEventListener('click', (event) => {
  const info = $('weights-info');
  info.hidden = !info.hidden;
  event.currentTarget.setAttribute('aria-expanded', String(!info.hidden));
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
    skipScored: $('skip').value === 'yes',
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

async function preview() {
  const request = runRequest();
  if (!request.projectId) return;
  $('preview').textContent = 'Counting sessions…';
  try {
    const result = await json('/api/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
    state.channels = result.byChannel ?? [];
    renderChannelFilter();

    const parts = [
      `${result.matched} session${result.matched === 1 ? '' : 's'} match`,
      result.alreadyScored ? `${result.alreadyScored} already scored` : null,
      `${result.toScore} to score`,
      `${result.records} records`,
      result.masked ? `${result.masked} masked` : null,
      result.excludedByChannel
        ? `${result.excludedByChannel} excluded by filter, never fetched`
        : null,
    ].filter(Boolean);
    $('preview').textContent =
      state.channels.length > 0 && state.excluded.size === state.channels.length
        ? 'No channels selected — nothing to score. Turn at least one back on.'
        : parts.join(' · ');
    $('btn-run').disabled = result.toScore === 0;
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
  const modality = modalityOf(session.channelKind);
  return modality === undefined || !rubric.appliesTo || rubric.appliesTo === modality;
}

/** The scope pill shown beside a rubric that has one. Unscoped rubrics get none. */
function scopePill(rubric) {
  if (!rubric.appliesTo) return null;
  const pill = el('span', `scope ${rubric.appliesTo}`);
  pill.append(el('span', 'dot'), document.createTextNode(MODALITY_LABEL[rubric.appliesTo]));
  pill.title = `Only asked of ${rubric.appliesTo === 'voice' ? 'voice calls' : 'text conversations'}.`;
  return pill;
}

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
    const type = el('td');
    type.append(pill(rubric.type));
    tr.append(name, type, el('td', 'n', String(rubric.weight)));
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

function rawLabel(rubric, result) {
  if (rubric.type === 'boolean') return Number(result.raw) >= 0.5 ? 'yes' : 'no';
  if (rubric.type === 'score') return Number(result.raw).toFixed(1);
  return String(result.raw);
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
    tr.append(el('td', 'when', new Date(session.startedAt).toLocaleString()));
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
      const track = el('div', 'track');
      const fill = el('div', 'fill');
      fill.style.width = `${((score ?? 0) / 5) * 100}%`;
      track.append(fill);
      meter.append(track, el('span', null, score === undefined ? '—' : score.toFixed(1)));
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

    tr.addEventListener('click', () => openSession(session));
    body.append(tr);
  }

  table.append(thead, body);
  $('results-table').replaceChildren(table);

  const flagged = state.sessions.filter((session) => session.flagged.length > 0).length;
  const skipped = state.sessions.filter((session) => session.unscoreable).length;
  $('results-foot').textContent =
    `${state.sessions.length} sessions · ${flagged} flagged · ${skipped} skipped · ` +
    `${usd(state.run.costUsd)} · ${(state.run.ms / 1000).toFixed(1)}s · ` +
    'click a row for the transcript and its scores';
}

async function loadRuns(selectId) {
  const runs = await json('/api/runs');
  const select = $('run-select');
  select.replaceChildren();
  for (const run of runs) {
    const when = new Date(run.startedAt).toLocaleString();
    select.append(new Option(`${run.projectName} · ${run.endpointLabel} · ${when}`, run.id));
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

  const cheapest = payload.comparison[0];
  $('results-meta').textContent = cheapest
    ? `Equivalent on ${cheapest.label} ≈ ${usd(cheapest.uncachedUsd)}`
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

function openSession(session) {
  if (session.unscoreable) return;

  const meta = $('session-meta');
  meta.replaceChildren(
    document.createTextNode(`${session.sessionId.slice(0, 8)} `),
    channelChip(session),
    document.createTextNode(
      ` · ${session.turns} turns · ${session.endpointLabel}` +
        (session.chunks > 1 ? ` · split into ${session.chunks} chunks` : ''),
    ),
  );

  const transcript = $('session-transcript');
  transcript.replaceChildren();
  for (const turn of JSON.parse(session.transcript)) {
    const row = el('div', `turn ${turn.role}`);
    row.append(
      el('span', 'who', turn.role === 'user' ? 'User' : turn.role === 'agent' ? 'Agent' : ''),
      el('span', null, turn.text),
    );
    transcript.append(row);
  }

  const panel = $('session-rubrics');
  panel.replaceChildren();

  for (const rubric of state.rubrics) {
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
      missing.append(
        el('div', 'meta', applies(rubric, session)
          ? 'Asked, but no answer came back.'
          : `This rubric only applies to ${rubric.appliesTo === 'voice' ? 'voice calls' : 'text conversations'}. It was never asked, so nothing was paid for it.`),
      );
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
      meta.append(el('span', 'certainty', `probability ${Number(result.raw).toFixed(2)}`));
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
void preview();
// Show the most recent run straight away: a tool that opens on an empty form
// tells you nothing about what it does.
void loadRuns();
