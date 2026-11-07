// The studio's home: a splash while the projects load, then the picker. A project opens in its editor at /p/<name>/
// (projects and their agents remain open when another is selected).
import './storage.js';
import { linkFetch, LinkEvents } from './link.js';
import { TRACK_COLOURS } from './colours.js';
import { startTips } from './tips.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const open = (name) => { location.href = `/p/${encodeURIComponent(name)}/`; };

function ago(iso) {
  if (!iso) return 'never edited';
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return 'edited just now';
  const [n, u] = s < 3600 ? [s / 60, 'minute'] : s < 86400 ? [s / 3600, 'hour'] : s < 86400 * 30 ? [s / 86400, 'day'] : [s / (86400 * 30), 'month'];
  const k = Math.floor(n);
  return `edited ${k} ${u}${k === 1 ? '' : 's'} ago`;
}
const clock = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

const shown = Date.now();
const [studio, projects] = await Promise.all([linkFetch('/api/studio').then((r) => r.json()), linkFetch('/api/projects').then((r) => r.json())]);
$('#splashVersion').textContent = studio.engine ? `Ephemeris ${studio.engine}` : '';
$('#version').textContent = studio.engine ?? '';
$('#version').hidden = !studio.engine;

// each film a colour of its own, as a clip's (from its name, so it keeps it)
const colour = (name) => TRACK_COLOURS[[...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % TRACK_COLOURS.length];
// the film's main timeline drawn small, when it has no frame to show: its cues over its tracks' clips
function arrangement(p) {
  const span = p.duration, at = ([a, b]) => `left:${(100 * a / span).toFixed(2)}%;width:${Math.max(0.8, 100 * (b - a) / span).toFixed(2)}%`;
  const lanes = (p.map?.tracks ?? []).filter((t) => t.length).slice(0, 5);
  if (!span || (!lanes.length && !p.map?.cues?.length)) return `<i>${esc(p.name[0].toUpperCase())}</i>`;
  const lane = (cls, spans) => `<span class="lane ${cls}">${spans.map((s) => `<i style="${at(s)}"></i>`).join('')}</span>`;
  return `<span class="arr">${p.map.cues.length ? lane('cues', p.map.cues) : ''}${lanes.map((t) => lane('', t)).join('')}</span>`;
}
const cell = (v, unit) => `<span class="cell">${v}${unit ? `<small>${unit}</small>` : ''}</span>`;

$('#count').textContent = projects.length || '';
$('#empty').hidden = projects.length > 0;
$('#grid').innerHTML = projects.map((p) => `
  <button class="card${p.open ? ' open' : ''}" style="--c:${colour(p.name)}" data-name="${esc(p.name)}" title="Open ${esc(p.name)}">
    <span class="clip-head"><span class="state"></span><b>${esc(p.name)}</b><span class="project-activity" data-project="${esc(p.name)}"></span></span>
    <span class="poster">${p.poster ? `<img src="${esc(p.poster)}" alt="" loading="lazy">` : arrangement(p)}</span>
    <span class="card-text">
      ${[p.duration ? cell(clock(p.duration)) : null, p.fps ? cell(p.fps, 'fps') : null, p.cues ? cell(p.cues, p.cues === 1 ? 'cue' : 'cues') : null, p.timelines > 1 ? cell(p.timelines, 'timelines') : null].filter(Boolean).join('')}
      <span class="when">${ago(p.edited)}</span>
    </span>
  </button>`).join('');
for (const c of document.querySelectorAll('.card')) c.onclick = () => open(c.dataset.name);
const shownCards = () => [...document.querySelectorAll('.card:not([hidden])')];

// ---------- search: the projects whose names hold every word typed
const find = $('#find');
find.oninput = () => {
  const words = find.value.toLowerCase().split(/\s+/).filter(Boolean);
  for (const c of document.querySelectorAll('.card')) c.hidden = !words.every((w) => c.dataset.name.toLowerCase().includes(w));
  const n = shownCards().length;
  $('#count').textContent = words.length ? `${n} / ${projects.length}` : projects.length || '';
  $('#none').hidden = n > 0 || !projects.length;
  $('#none').textContent = `No project matches “${find.value.trim()}”.`;
};
find.onkeydown = (e) => {
  if (e.key === 'Escape') { e.stopPropagation(); if (find.value) { find.value = ''; find.oninput(); } else find.blur(); }
  else if (e.key === 'Enter') { const c = shownCards()[0]; if (c) open(c.dataset.name); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); shownCards()[0]?.focus(); }
};

// the splash stays long enough to read, then gives way to the picker
setTimeout(() => { document.body.classList.add('ready'); document.querySelector('.card')?.focus(); }, Math.max(0, 700 - (Date.now() - shown)));

// ---------- a new project
const sheet = $('#newSheet'), form = $('#newForm');
function newProject() { sheet.hidden = false; $('#newError').hidden = true; form.name.value = ''; form.name.focus(); }
$('#newBtn').onclick = newProject;
sheet.onclick = (e) => { if (e.target === sheet || e.target.dataset.close != null) sheet.hidden = true; };
form.onsubmit = async (e) => {
  e.preventDefault();
  const name = form.name.value.trim(), btn = form.querySelector('[type=submit]');
  btn.disabled = true; btn.textContent = 'Creating…';
  const r = await linkFetch('/api/projects', { method: 'POST', body: JSON.stringify({ name }) });
  const b = await r.json().catch(() => ({}));
  if (r.ok) return open(b.name);
  btn.disabled = false; btn.textContent = 'Create and open';
  $('#newError').textContent = b.error || 'Could not make it'; $('#newError').hidden = false;
};

// ---------- keys: arrows move between projects, Enter opens, N makes one, / or Ctrl+F searches
addEventListener('keydown', (e) => {
  if (!sheet.hidden) { if (e.key === 'Escape') sheet.hidden = true; return; }
  if (e.target === find) return;
  if (e.key === '/' || ((e.ctrlKey || e.metaKey) && e.key === 'f')) { e.preventDefault(); find.focus(); return find.select(); }
  if (e.key === 'n' || e.key === 'N') { e.preventDefault(); return newProject(); }
  const cards = shownCards(), i = cards.indexOf(document.activeElement);
  if (!cards.length || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
  e.preventDefault();
  const per = Math.max(1, Math.round($('#grid').clientWidth / cards[0].offsetWidth));
  const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -per, ArrowDown: per }[e.key];
  cards[Math.max(0, Math.min(cards.length - 1, (i < 0 ? 0 : i) + step))].focus();
});

// Activity is pushed by the studio; no polling of every conversation's transcript.
const activity = new LinkEvents('/api/events');
activity.addEventListener('projects', (e) => {
  const open = new Map(JSON.parse(e.data).projects.map((p) => [p.name, p]));
  for (const el of document.querySelectorAll('.project-activity')) {
    const agents = open.get(el.dataset.project)?.agents ?? [];
    const busy = agents.filter((a) => a.busy && !a.waiting).length, waiting = agents.filter((a) => a.waiting).length;
    el.textContent = [busy && `${busy} working`, waiting && `${waiting} waiting for you`].filter(Boolean).join(' · ');
  }
});

startTips(addEventListener);
