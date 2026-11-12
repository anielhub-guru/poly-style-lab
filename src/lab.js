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
  const style = status.styleUrl;
  $('#dlStyle').hidden = $('#styleSteps').hidden = !style;
  if (style) $('#dlStyle').href = style;
  const scene = status.aikiSceneUrl;
  $('#dlScene').hidden = $('#view3d').hidden = $('#sceneSteps').hidden = !scene;
  if (scene) { $('#dlScene').href = scene; $('#view3d').href = `/viewer.html?scene=${encodeURIComponent(scene)}`; }
  else if (!style) show('Analysis finished. The summary is available.', false, 100);
  $('#dlSummary').href = `${status.workspaceUrl}summary.md`;
  $('#where').textContent = `Saved in aiki-style-lab/workspaces/${id}/`;
  $('#result').scrollIntoView({ behavior: 'smooth' });
}

// Drag & drop: browsers hide real file paths, so dropped videos are copied into a local upload folder and that folder is analysed.
const drop = $('#drop');
['dragenter', 'dragover'].forEach(t => window.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(t => window.addEventListener(t, e => { e.preventDefault(); if (t === 'drop' || !e.relatedTarget) drop.classList.remove('over'); }));
window.addEventListener('drop', async e => {
  const files = [...e.dataTransfer.files].filter(f => /\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(f.name));
  if (!files.length) return show('No video files in that drop. Use mp4, mov, m4v, webm, mkv or avi.', true, 0);
  const batch = [...crypto.getRandomValues(new Uint8Array(4))].map(b => b.toString(16).padStart(2, '0')).join('');
  try {
    let folder;
    for (const [i, f] of files.entries()) {
      show(`Copying ${i + 1} of ${files.length}: ${f.name}`, false, Math.round(i / files.length * 100));
      const r = await fetch(`/api/upload?batch=${batch}&name=${encodeURIComponent(f.name)}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: f });
      const j = await r.json(); if (!r.ok) throw new Error(j.error); folder = j.folder;
    }
    $('#source').value = folder; show(`${files.length} video(s) ready. Press Start analysis.`, false, 0);
  } catch (err) { show(err.message, true, 0); }
});
