import { PRESETS, normalizeBlueprint, referenceSheetSvg, toPolyStudioPack, styleGuideMarkdown } from './blueprint.js';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const copy = value => JSON.parse(JSON.stringify(value));
const sections = [
  ['reference', 'Channel study'], ['visual', 'Visual DNA'], ['camera', 'Camera & light'], ['world', 'Character & world'],
  ['motion', 'Motion signature'], ['shots', 'Shot grammar'], ['guardrails', 'Continuity & exclusions'], ['handoff', 'Agent handoff'],
];
const scalarIds = ['name', 'intent', 'medium', 'aspectRatio', 'lineWeight', 'lineVariation', 'texture', 'saturation', 'contrast', 'focalLength', 'cameraHeight', 'horizon', 'frameRate', 'animationStep', 'shutterAngle', 'keyAngle', 'keySoftness', 'fillRatio'];
const nestedIds = {
  characterSilhouette: ['character', 'silhouette'], characterProportions: ['character', 'proportions'], characterFaces: ['character', 'faces'], characterCostume: ['character', 'costume'],
  environmentGeometry: ['environment', 'geometry'], environmentDetail: ['environment', 'detail'], environmentAtmosphere: ['environment', 'atmosphere'], motionCadence: ['motion', 'cadence'],
  anticipationFrames: ['motion', 'anticipationFrames'], impactFrames: ['motion', 'impactFrames'], settleFrames: ['motion', 'settleFrames'], smearFrames: ['motion', 'smearFrames'],
};

let state = copy(PRESETS['stormbound-shonen']);
let analysisResult = null;
let dirty = false, presetId = 'stormbound-shonen';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function init() {
  document.querySelector('[data-section="visual"]').before(document.querySelector('[data-section="reference"]'));
  $('#sectionNav').innerHTML = sections.map(([id, label], index) => `<button data-target="${id}" data-index="${String(index + 1).padStart(2, '0')}" class="${index ? '' : 'active'}">${label}</button>`).join('');
  $('#sectionNav').addEventListener('click', event => {
    const button = event.target.closest('[data-target]'); if (!button) return;
    document.querySelector(`[data-section="${button.dataset.target}"]`).scrollIntoView({ behavior: 'smooth' });
  });
  scalarIds.forEach(id => {
    const el = id === 'name' ? $('#styleName') : $(`#${id}`); if (!el) return;
    el.addEventListener('input', () => { state[id] = el.type === 'number' || el.type === 'range' ? Number(el.value) : el.value; if (id === 'name') state.slug = slugify(el.value); render(); });
  });
  Object.entries(nestedIds).forEach(([id, path]) => $(`#${id}`).addEventListener('input', event => { state[path[0]][path[1]] = event.target.type === 'number' ? Number(event.target.value) : event.target.value; render(); }));
  $('.workspace').addEventListener('input', () => { dirty = true; });
  $('#preset').addEventListener('change', event => {
    if (dirty && !confirm('Replace your edits with this starting system?')) { event.target.value = presetId; return; }
    presetId = event.target.value; state = copy(PRESETS[presetId]); dirty = false; hydrate(); toast('Starting system loaded');
  });
  $('#startAnalysis').addEventListener('click', runStudy);
  for (const [id, kind] of [['pickFolder', 'folder'], ['pickFile', 'file']]) $(`#${id}`).addEventListener('click', async () => {
    try {
      const r = await (await fetch('/api/pick', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind }) })).json();
      if (r.error) return toast(r.error);
      if (r.path) $('#sourceInput').value = r.path;
    } catch (error) { toast(error.message); }
  });
  $('#exportScene').addEventListener('click', () => $('#exportAikiScene').click());
  $('#palette').addEventListener('input', event => { const card = event.target.closest('[data-palette]'); if (!card) return; const index = Number(card.dataset.palette), field = event.target.dataset.field; state.palette[index][field] = field === 'share' ? Number(event.target.value) : event.target.value; render(); });
  $('#shots').addEventListener('input', event => updateShot(event));
  $('#shots').addEventListener('click', event => { const button = event.target.closest('[data-remove-shot]'); if (!button) return; state.shotGrammar.splice(Number(button.dataset.removeShot), 1); render(); });
  $('#addShot').addEventListener('click', () => { state.shotGrammar.push({ id: `shot-${state.shotGrammar.length + 1}`, label: 'New shot', size: 'medium', lensMm: state.focalLength, durationSec: 2.5, angleDeg: 0, move: 'locked', purpose: 'Describe the narrative job of this shot.' }); render(); requestAnimationFrame(() => $('#shots .shot-card:last-child input').focus()); });
  $('.workspace').addEventListener('input', event => updateList(event));
  $('.workspace').addEventListener('click', event => handleListClick(event));
  $('#copyPrompt').addEventListener('click', copyPrompt);
  $('#copyDialogPrompt').addEventListener('click', copyPrompt);
  $('#expandPrompt').addEventListener('click', openPrompt);
  $('#closeDialog').addEventListener('click', () => $('#promptDialog').close());
  $('#moreButton').addEventListener('click', () => { const menu = $('#exportMenu'), open = menu.hidden; menu.hidden = !open; $('#moreButton').setAttribute('aria-expanded', String(open)); });
  $('#exportBlueprint').addEventListener('click', async () => {
    if (analysisResult) return download(`${slugify(state.name)}.motion-style-blueprint.json`, await (await fetch(`${analysisResult.workspaceUrl}motion-style-blueprint.json`)).text(), 'application/json');
    toast('Run a measured channel study first');
  });
  $('#exportPack').addEventListener('click', exportPack);
  $('#exportGuide').addEventListener('click', () => download('style-guide.md', styleGuideMarkdown(normalizeBlueprint(state)), 'text/markdown'));
  $('#exportAikiScene').addEventListener('click', async () => {
    if (!analysisResult?.aikiSceneUrl) return toast('Run a measured channel study first');
    download(`${slugify(state.name)}.aikiscene`, await (await fetch(analysisResult.aikiSceneUrl)).text(), 'application/json');
  });
  $('#viewAikiScene3d').addEventListener('click', () => {
    if (!analysisResult?.aikiSceneUrl) return toast('Run a measured channel study first');
    window.open(`/viewer.html?scene=${encodeURIComponent(analysisResult.aikiSceneUrl)}`, '_blank', 'noopener');
  });
  $('#exportSheet').addEventListener('click', () => download(`${slugify(state.name)}.reference-sheet.svg`, referenceSheetSvg(normalizeBlueprint(state)), 'image/svg+xml'));
  $('#exportPackInline').addEventListener('click', exportPack);
  $('#copyCodex').addEventListener('click', () => copyText($('#codexCommand').textContent, 'Codex handoff copied'));
  $('#copyCli').addEventListener('click', () => copyText($('#cliCommand').textContent, 'CLI command copied'));
  const observer = new IntersectionObserver(entries => entries.forEach(entry => { if (!entry.isIntersecting) return; $$('#sectionNav button').forEach(button => button.classList.toggle('active', button.dataset.target === entry.target.dataset.section)); }), { rootMargin: '-25% 0px -65%' });
  $$('.panel').forEach(panel => observer.observe(panel));
  hydrate();
}

function hydrate() {
  $('#styleName').value = state.name; $('#intent').value = state.intent;
  scalarIds.filter(id => !['name', 'intent'].includes(id)).forEach(id => { const el = $(`#${id}`); if (el) el.value = state[id]; });
  Object.entries(nestedIds).forEach(([id, [group, field]]) => { $(`#${id}`).value = state[group][field]; });
  render();
}

function render() {
  ['lineWeight', 'lineVariation', 'texture', 'saturation', 'contrast'].forEach(id => { $(`#${id}Out`).textContent = id === 'lineWeight' ? `${state[id]} px` : `${state[id]}%`; });
  renderReference(); renderPalette(); renderShots(); renderLists(); renderRuler(); renderPreview();
}

function renderReference() {
  $('#analysisClock')?.setAttribute('data-fps', '30');
}

function renderPalette() {
  $('#palette').innerHTML = state.palette.map((swatch, index) => `<div class="swatch" data-palette="${index}"><input class="swatch-color" data-field="value" type="color" value="${swatch.value}" aria-label="${swatch.role} colour"><div class="swatch-fields"><input data-field="role" value="${escapeAttr(swatch.role)}" aria-label="Palette role"><input data-field="share" type="number" min="0" max="100" value="${swatch.share}" aria-label="Palette share"></div></div>`).join('');
  const total = state.palette.reduce((sum, item) => sum + Number(item.share), 0); $('#paletteTotal').textContent = total === 100 ? '100%' : `${total}% entered · scaled to 100% on export`;
}

function renderShots() {
  $('#shots').innerHTML = state.shotGrammar.map((shot, index) => `<article class="shot-card" data-shot="${index}"><div class="shot-card-head"><span class="eyebrow">${String(index + 1).padStart(2, '0')}</span><input data-shot-field="label" value="${escapeAttr(shot.label)}" aria-label="Shot label"><button data-remove-shot="${index}" aria-label="Remove ${escapeAttr(shot.label)}">Remove</button></div><div class="shot-fields"><label>Purpose<input data-shot-field="purpose" value="${escapeAttr(shot.purpose)}"></label><label>Size<select data-shot-field="size">${['wide','medium','close','insert'].map(value => `<option ${value === shot.size ? 'selected' : ''}>${value}</option>`).join('')}</select></label><label>Lens<input data-shot-field="lensMm" type="number" min="14" max="200" value="${shot.lensMm}"><em>mm</em></label><label>Duration<input data-shot-field="durationSec" type="number" min="0.2" max="30" step="0.05" value="${shot.durationSec}"><em>s</em></label><label>Angle<input data-shot-field="angleDeg" type="number" min="-90" max="90" value="${shot.angleDeg}"><em>°</em></label><label>Movement<input data-shot-field="move" value="${escapeAttr(shot.move)}"></label></div></article>`).join('');
}

function renderLists() {
  [['continuity', state.continuity], ['avoid', state.avoid]].forEach(([id, items]) => { $(`#${id}`).innerHTML = items.map((item, index) => `<div class="list-row" data-list="${id}" data-list-index="${index}"><input value="${escapeAttr(item)}" aria-label="${id} item ${index + 1}"><button class="remove-item" data-remove-list="${id}" data-index="${index}" aria-label="Remove item">×</button></div>`).join(''); });
}

function renderRuler() {
  const values = [['anticipate', state.motion.anticipationFrames], ['impact', state.motion.impactFrames], ['settle', state.motion.settleFrames]];
  $('#rulerTrack').innerHTML = values.flatMap(([className, count]) => Array.from({ length: Math.min(24, count) }, () => `<i class="${className}"></i>`)).join('');
}

function renderPreview() {
  const blueprint = normalizeBlueprint(state);
  $('#previewLens').textContent = `${blueprint.camera.defaultLensMm} MM`; $('#previewAspect').textContent = blueprint.canvas.aspectRatio; $('#previewFps').textContent = `${blueprint.canvas.frameRate} FPS / ${blueprint.canvas.animationStep}s`;
  $('#framePreview').style.aspectRatio = blueprint.canvas.aspectRatio.replace(':', '/');
  $('#specStrip').innerHTML = `<div><b>${blueprint.rendering.lineWeightPxAt1080p}px</b><small>ink weight</small></div><div><b>${blueprint.lighting.fillToKeyRatio}</b><small>fill : key</small></div><div><b>${blueprint.shotGrammar.length}</b><small>shot patterns</small></div>`;
  $('#palettePreview').innerHTML = blueprint.palette.map(swatch => `<i style="background:${swatch.value};width:${swatch.share}%" title="${escapeAttr(swatch.role)} ${swatch.share}%"></i>`).join('');
  $('#promptText').textContent = blueprint.promptContract.master; $('#fullPrompt').textContent = `${blueprint.promptContract.master}\n\nAVOID: ${blueprint.promptContract.negative}`;
  $('#schemaBadge').textContent = blueprint.schema.split('/').at(-1);
  const referenceData = analysisResult?.evidenceUrl || blueprint.reference?.source?.dataUrl;
  $('#referenceThumbWrap').hidden = !referenceData; if (referenceData) $('#referenceThumb').src = referenceData;
  const valid = Boolean(analysisResult) && blueprint.shotGrammar.length > 0 && blueprint.continuityLocks.length > 0 && blueprint.negativeConstraints.length > 0 && blueprint.metadata.intent.length > 10;
  $('#validation').classList.toggle('invalid', !valid); $('#validation').innerHTML = valid ? '<span>✓</span><p><b>Measured blueprint ready</b><br>30 FPS evidence is available for PolyStudio.</p>' : '<span>!</span><p><b>Study not measured</b><br>Add a channel and run the 10–20 Shorts analysis.</p>';
  $('#completion').textContent = valid ? 'Measured blueprint ready' : 'Channel study required';
  document.documentElement.style.setProperty('--orange', blueprint.palette.find(item => item.role === 'hero')?.value || blueprint.palette[1]?.value || '#eb6a32');
}

function updateShot(event) {
  const card = event.target.closest('[data-shot]'); if (!card || !event.target.dataset.shotField) return;
  const shot = state.shotGrammar[Number(card.dataset.shot)], field = event.target.dataset.shotField;
  shot[field] = event.target.type === 'number' ? Number(event.target.value) : event.target.value;
  if (field === 'label') shot.id = slugify(event.target.value); renderPreview();
}

function updateList(event) {
  const row = event.target.closest('[data-list]'); if (!row || event.target.tagName !== 'INPUT') return;
  state[row.dataset.list][Number(row.dataset.listIndex)] = event.target.value; renderPreview();
}

function handleListClick(event) {
  const add = event.target.closest('[data-add-list]');
  if (add) { state[add.dataset.addList].push(add.dataset.addList === 'continuity' ? 'Define a measurable continuity lock.' : 'Define a visual or content exclusion.'); render(); return; }
  const remove = event.target.closest('[data-remove-list]'); if (!remove) return;
  state[remove.dataset.removeList].splice(Number(remove.dataset.index), 1); render();
}

async function exportPack() {
  // after a measured study the pack carries the measured motion rules; before it, the authored visual style
  if (analysisResult) return download('pack.json', await (await fetch(`${analysisResult.workspaceUrl}pack/pack.json`)).text(), 'application/json');
  download('pack.json', JSON.stringify(toPolyStudioPack(normalizeBlueprint(state)), null, 2), 'application/json');
}
function openPrompt() { $('#promptDialog').showModal(); }
async function runStudy() {
  const source = $('#sourceInput').value.trim();
  if (!source) return toast('Add a YouTube channel, shorts URL, video, or local folder');
  const button = $('#startAnalysis');
  button.disabled = true; button.textContent = 'Measuring…';
  const setProgress = (label, percent, detail) => { $('#analysisState').textContent = label; $('#analysisBar').style.width = `${percent}%`; $('#analysisDetail').textContent = detail; };
  $('#analysisProgress').classList.add('running'); setProgress('STARTING', 4, 'Checking tools and listing videos…');
  try {
    const start = await fetch('/api/analyze', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source, videoCount: Number($('#videoCount').value) || 12, reconstructionQuality: $('#reconstructionQuality').value, name: state.name }) });
    const started = await start.json();
    if (!start.ok) throw new Error(started.error || 'Could not start the study');
    let status, failures = 0;
    do {
      await sleep(1500);
      try { status = await (await fetch(`/api/analyze/${started.studyId}`)).json(); failures = 0; } catch (error) { if (++failures > 4) throw error; continue; }
      if (status.state === 'running') setProgress('ANALYSIS RUNNING', status.total ? Math.max(6, Math.round(status.done / status.total * 100)) : 6, status.message || 'Working…');
    } while (!status || status.state === 'running');
    if (status.state !== 'done') throw new Error(status.error || 'Analysis failed');
    const result = analysisResult = { ...status.result, workspaceUrl: status.workspaceUrl, evidenceUrl: status.evidenceUrl, reconstructionUrl: status.reconstructionUrl, reconstructionBlueprintUrl: status.reconstructionBlueprintUrl, aikiSceneUrl: status.aikiSceneUrl };
    const skipped = result.skipped?.length ? ` · ${result.skipped.length} skipped` : '';
    setProgress('MEASURED BLUEPRINT READY', 100, `${result.videosAnalysed} videos analysed${skipped}. ${result.headline.slice(0, 2).join(' ')}${result.warnings?.length ? ` ⚠ ${result.warnings[0]}` : ''}`);
    if (result.evidenceUrl) {
      $('#evidenceView').hidden = false; $('#evidenceImage').src = result.evidenceUrl;
      $('#evidenceTitle').textContent = result.evidence?.source?.title || 'Representative analysed frame';
      $('#evidenceTime').textContent = `${result.evidenceFrame.timeSec.toFixed(2)}s · frame ${result.evidenceFrame.frame}`;
    }
    if (result.reconstructionUrl) {
      const metrics = result.reconstruction.metrics;
      $('#reconstructionView').hidden = false; $('#reconstructionImage').src = result.reconstructionUrl;
      $('#reconstructionMetrics').textContent = `SSIM ${metrics.structuralSimilarity.toFixed(3)} · edge ${metrics.edgeF1.toFixed(3)} · ${result.reconstruction.complexity.assetBytes.value} bytes`;
    }
    renderPreview(); toast('Measured blueprint and reconstruction ready');
  } catch (error) {
    setProgress('ANALYSIS FAILED', 0, error.message);
  } finally { button.disabled = false; button.textContent = 'Start measured study'; $('#analysisProgress').classList.remove('running'); }
}
async function copyPrompt() { await navigator.clipboard.writeText(`${normalizeBlueprint(state).promptContract.master}\n\nAVOID: ${normalizeBlueprint(state).promptContract.negative}`); toast('Master prompt copied'); }
async function copyText(value, message) { await navigator.clipboard.writeText(value); toast(message); }
function ensureReference() { if (!state.reference) state.reference = { name: 'Primary style reference', purpose: 'Primary visual reference for style, composition and finish.', observations: [], source: {} }; return state.reference; }
function loadReference(file) {
  if (!file.type.startsWith('image/')) return toast('Choose an image file');
  const reader = new FileReader(); reader.onload = () => {
    const image = new Image(); image.onload = () => { state.reference = { name: file.name.replace(/\.[^.]+$/, ''), purpose: 'Primary visual reference for style, composition and finish.', observations: ['Identify the dominant line treatment and silhouette logic.', 'Record the palette hierarchy and lighting direction.', 'Measure the framing, lens feel and depth layering.'], source: { dataUrl: reader.result, mimeType: file.type, sizeBytes: file.size, width: image.naturalWidth, height: image.naturalHeight } }; render(); toast('Primary reference attached'); };
    image.src = reader.result;
  }; reader.readAsDataURL(file);
}
function download(filename, content, type) { const url = URL.createObjectURL(new Blob([content], { type })), anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); toast(`${filename} exported`); }
function toast(message) { const el = $('#toast'); el.textContent = message; el.classList.add('show'); clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove('show'), 2200); }
function slugify(value) { return String(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'untitled-style'; }
function escapeAttr(value) { return String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'); }

init();
