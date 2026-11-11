const $ = s => document.querySelector(s);
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async r => { const j = await r.json(); if (!r.ok) throw new Error(j.error || 'Request failed'); return j; });
const sleep = ms => new Promise(r => setTimeout(r, ms));

for (const [id, kind] of [['pickFolder', 'folder'], ['pickFile', 'file']]) $(`#${id}`).addEventListener('click', async () => {
  try { const { path } = await post('/api/pick', { kind }); if (path) $('#source').value = path; }
  catch (e) { show(e.message, true); }
});

function show(text, bad = false, percent) {
  $('#progress').hidden = false; $('#msg').textContent = text; $('#msg').className = 'msg' + (bad ? ' bad' : '');
  if (percent != null) $('#bar').style.width = percent + '%';
}

$('#start').addEventListener('click', async () => {
  const source = $('#source').value.trim();
  if (!source) return show('Choose a folder or video first.', true, 0);
  const button = $('#start'); button.disabled = true; button.textContent = 'Analysing…'; $('#result').hidden = true;
  try {
    show('Starting…', false, 4);
    const started = await post('/api/analyze', { source, videoCount: Number($('#count').value) || 12, reconstructionQuality: $('#quality').value, name: 'Aiki style' });
    let status, fails = 0;
    do {
      await sleep(1500);
      try { status = await (await fetch(`/api/analyze/${started.studyId}`)).json(); fails = 0; } catch (e) { if (++fails > 4) throw e; continue; }
      if (status.state === 'running') show(status.message || 'Working…', false, status.total ? Math.max(6, Math.round(status.done / status.total * 100)) : 6);
    } while (!status || status.state === 'running');
    if (status.state !== 'done') throw new Error(status.error || 'Analysis failed');
    finish(started.studyId, status);
  } catch (e) { show(e.message, true, 0); }
  finally { button.disabled = false; button.textContent = 'Start analysis'; }
});

function finish(id, status) {
  const r = status.result || {};
  show('Done.', false, 100);
  $('#result').hidden = false;
  $('#frame').hidden = !status.evidenceUrl; if (status.evidenceUrl) $('#frame').src = status.evidenceUrl;
  $('#done').textContent = `Analysed ${r.videosAnalysed ?? '?'} video(s)${r.skipped?.length ? ` · ${r.skipped.length} skipped` : ''}`;
  $('#facts').replaceChildren(...[...(r.headline || []).slice(0, 3), ...(r.warnings || []).slice(0, 1).map(w => `⚠ ${w}`)].map(t => Object.assign(document.createElement('li'), { textContent: t })));
  const scene = status.aikiSceneUrl;
  $('#dlScene').hidden = $('#view3d').hidden = !scene;
  if (scene) { $('#dlScene').href = scene; $('#view3d').href = `/viewer.html?scene=${encodeURIComponent(scene)}`; }
  else show('Analysis finished, but no .aikiscene could be built from these videos (no separable foreground). Summary is still available.', true);
  $('#dlSummary').href = `${status.workspaceUrl}summary.md`;
  $('#where').textContent = `Saved in aiki-style-lab/workspaces/${id}/`;
  $('#result').scrollIntoView({ behavior: 'smooth' });
}
