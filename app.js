// タップ日記 — 端末に即保存し、GitHub の非公開リポジトリへ Markdown で同期する

const SETTINGS_KEY = 'diary:settings';
const DEFAULT_TAGS = ['仕事', '勉強', '運動', '人と会った', '外出', '趣味', '家族', '一人時間', '睡眠不足', '頭痛'];

const SCALES = {
  mood:   { label: '気分',       emoji: true, opts: ['😫', '😕', '😐', '🙂', '😆'] },
  energy: { label: 'テンション', opts: ['ぐったり', '低め', 'ふつう', '高め', '絶好調'] },
  health: { label: '体調',       opts: ['不調', 'いまいち', 'ふつう', '良い', '最高'] },
};
const SLEEP = [4, 5, 6, 7, 8, 9];
const REACTIONS = [['good', '👍'], ['meh', '😐'], ['bad', '👎']];
const PROMPTS = {
  happened: ['一番印象に残ったこと', '予想外だったこと', '人とのやりとり'],
  feelings: ['うれしかった', 'モヤっとした', 'がんばった'],
  lesson:   ['次は〜する', '〜だとうまくいく', '〜は避ける'],
};

let settings = loadSettings();
let tab = 'today';
let current = dateStr(new Date());
let entry = load(current);

// ---------- 日付・保存 ----------

function dateStr(d) {
  const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return z.toISOString().slice(0, 10);
}
function shiftDate(s, n) {
  const d = new Date(s + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return dateStr(d);
}
function prettyDate(s) {
  const d = new Date(s + 'T12:00:00');
  const w = '日月火水木金土'[d.getDay()];
  const label = `${d.getMonth() + 1}月${d.getDate()}日(${w})`;
  return s === dateStr(new Date()) ? `今日 ${label}` : label;
}

function loadSettings() {
  try { return { owner: '', repo: '', branch: 'main', token: '', tags: DEFAULT_TAGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; }
  catch { return { owner: '', repo: '', branch: 'main', token: '', tags: DEFAULT_TAGS }; }
}
function emptyEntry(date) {
  return { date, mood: null, energy: null, health: null, sleep: null, tags: [], events: [],
           happened: '', feelings: '', lesson: '', updatedAt: null, syncedAt: null };
}
function load(date) {
  try { return { ...emptyEntry(date), ...JSON.parse(localStorage.getItem('diary:' + date) || '{}') }; }
  catch { return emptyEntry(date); }
}
function persist() {
  entry.updatedAt = new Date().toISOString();
  localStorage.setItem('diary:' + entry.date, JSON.stringify(entry));
  renderStatus();
}
function allDates() {
  return Object.keys(localStorage).filter(k => /^diary:\d{4}-\d{2}-\d{2}$/.test(k)).map(k => k.slice(6)).sort().reverse();
}
const isUnsynced = e => e.updatedAt && (!e.syncedAt || e.syncedAt < e.updatedAt);
const configured = () => settings.owner && settings.repo && settings.token;

// ---------- Markdown 変換（Claude Code / MUSE が読む形式） ----------

function toMarkdown(e) {
  const fm = { date: e.date, mood: e.mood, energy: e.energy, health: e.health, sleep: e.sleep,
               tags: e.tags, events: e.events, updatedAt: e.updatedAt };
  const lbl = (k) => e[k] ? `${SCALES[k].opts[e[k] - 1]}(${e[k]}/5)` : '未入力';
  const rx = Object.fromEntries(REACTIONS);
  const lines = ['---', ...Object.entries(fm).map(([k, v]) => `${k}: ${JSON.stringify(v)}`), '---', ''];
  lines.push(`# ${e.date} の日記`, '');
  lines.push(`- 気分: ${lbl('mood')} / テンション: ${lbl('energy')} / 体調: ${lbl('health')} / 睡眠: ${e.sleep ? e.sleep + '時間' : '未入力'}`);
  if (e.tags.length) lines.push(`- タグ: ${e.tags.join('、')}`);
  lines.push('', '## 予定・イベント');
  if (!e.events.length) lines.push('（なし）');
  for (const ev of e.events) {
    lines.push(`- ${ev.allDay ? '終日' : ev.start || ''} ${ev.title}${ev.reaction ? ' ' + rx[ev.reaction] : ''}${ev.note ? ' — ' + ev.note : ''}`.replace(/^- +/, '- '));
  }
  for (const [key, title] of [['happened', '出来事'], ['feelings', '感想'], ['lesson', '教訓']]) {
    lines.push('', `## ${title}`, e[key].trim() || '（なし）');
  }
  return lines.join('\n') + '\n';
}

function fromMarkdown(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return null;
  const e = emptyEntry('');
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(': ');
    if (i > 0) { try { e[line.slice(0, i)] = JSON.parse(line.slice(i + 2)); } catch { /* 手で編集された行は無視 */ } }
  }
  for (const [key, title] of [['happened', '出来事'], ['feelings', '感想'], ['lesson', '教訓']]) {
    const s = m[2].match(new RegExp(`^## ${title}\\n([\\s\\S]*?)(?=\\n## |$)`, 'm'));
    if (s) { const t = s[1].trim(); e[key] = t === '（なし）' ? '' : t; }
  }
  return e;
}

// ---------- GitHub 同期 ----------

const b64 = s => { let bin = ''; new TextEncoder().encode(s).forEach(b => bin += String.fromCharCode(b)); return btoa(bin); };
const unb64 = s => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\n/g, '')), c => c.charCodeAt(0)));
const entryPath = d => `entries/${d.slice(0, 4)}/${d.slice(5, 7)}/${d}.md`;

async function gh(path, opts = {}) {
  const res = await fetch(`https://api.github.com/repos/${settings.owner}/${settings.repo}${path ? '/' + path : ''}`, {
    ...opts,
    headers: { Authorization: `Bearer ${settings.token}`, Accept: 'application/vnd.github+json',
               'X-GitHub-Api-Version': '2022-11-28', ...(opts.headers || {}) },
  });
  if (!res.ok && res.status !== 404) throw new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 120)}`);
  return res;
}
async function getFile(path) {
  const res = await gh(`contents/${path}?ref=${encodeURIComponent(settings.branch)}`);
  if (res.status === 404) return null;
  const j = await res.json();
  return { sha: j.sha, text: unb64(j.content) };
}
async function pushEntry(e) {
  const path = entryPath(e.date);
  const cur = await getFile(path);
  const body = { message: `diary: ${e.date}`, content: b64(toMarkdown(e)), branch: settings.branch };
  if (cur) body.sha = cur.sha;
  const res = await gh(`contents/${path}`, { method: 'PUT', body: JSON.stringify(body) });
  if (res.status === 404) throw new Error('リポジトリが見つかりません（設定を確認）');
  e.syncedAt = new Date().toISOString();
  localStorage.setItem('diary:' + e.date, JSON.stringify(e));
}

// カレンダー（GitHub Actions が calendar/YYYY-MM-DD.json に書き出す）とリモートの日記を取り込む
async function pull(date) {
  if (!configured()) return;
  const [cal, remote] = await Promise.all([getFile(`calendar/${date}.json`), getFile(entryPath(date))]);
  if (date !== current) return;
  let changed = false;
  if (remote) {
    const r = fromMarkdown(remote.text);
    if (r && (!entry.updatedAt || (r.updatedAt && r.updatedAt > entry.updatedAt))) {
      entry = { ...emptyEntry(date), ...r, date, syncedAt: r.updatedAt };
      changed = true;
    }
  }
  if (cal) {
    const { events = [] } = JSON.parse(cal.text);
    for (const ev of events) {
      if (!entry.events.some(x => x.id === ev.id)) {
        entry.events.push({ id: ev.id, start: ev.start, end: ev.end, allDay: ev.allDay, title: ev.title,
                            location: ev.location || '', source: 'calendar', reaction: null, note: '' });
        changed = true;
      }
    }
    entry.events.sort((a, b) => (a.allDay ? '' : a.start || '99').localeCompare(b.allDay ? '' : b.start || '99'));
  }
  if (changed) { localStorage.setItem('diary:' + date, JSON.stringify(entry)); render(); }
}

async function syncPending() {
  if (!configured() || !navigator.onLine) return;
  for (const d of allDates()) {
    const e = load(d);
    if (isUnsynced(e)) { try { await pushEntry(e); } catch { return; } }
  }
  entry = load(current);
  renderStatus();
}

// ---------- 描画 ----------

const view = document.getElementById('view');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => t.classList.remove('show'), 2400);
}

function renderStatus() {
  const s = document.getElementById('status');
  if (tab !== 'today') { s.textContent = ''; return; }
  if (!configured()) { s.textContent = '端末に保存（同期は設定から）'; s.className = 'status'; }
  else if (isUnsynced(entry)) { s.textContent = '● 未同期の変更あり'; s.className = 'status warn'; }
  else if (entry.syncedAt) { s.textContent = '✓ GitHubに同期済み'; s.className = 'status'; }
  else { s.textContent = ''; }
}

function render() {
  document.getElementById('date-label').textContent =
    tab === 'today' ? prettyDate(current) : tab === 'history' ? '履歴' : '設定';
  document.getElementById('prev').style.visibility = tab === 'today' ? 'visible' : 'hidden';
  document.getElementById('next').style.visibility = tab === 'today' ? 'visible' : 'hidden';
  document.querySelectorAll('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  view.innerHTML = tab === 'today' ? todayHTML() : tab === 'history' ? historyHTML() : settingsHTML();
  renderStatus();
}

function scaleHTML(key) {
  const s = SCALES[key];
  return `<section class="card"><h2>${s.label}</h2><div class="scale${s.emoji ? ' emoji' : ''}">` +
    s.opts.map((o, i) => `<button data-scale="${key}" data-v="${i + 1}" class="${entry[key] === i + 1 ? 'on' : ''}" aria-label="${s.label} ${i + 1}">${o}</button>`).join('') +
    `</div></section>`;
}

function todayHTML() {
  const e = entry;
  const events = e.events.map((ev, i) => `
    <div class="event">
      <div class="event-head">
        <span class="event-time">${ev.allDay ? '終日' : esc(ev.start || '')}</span>
        <span class="event-title">${esc(ev.title)}</span>
        <button class="event-del" data-del="${i}" aria-label="削除">×</button>
      </div>
      <div class="react">${REACTIONS.map(([k, em]) => `<button data-react="${i}" data-v="${k}" class="${ev.reaction === k ? 'on' : ''}">${em}</button>`).join('')}</div>
      <input data-note="${i}" value="${esc(ev.note)}" placeholder="ひとこと（任意）">
    </div>`).join('');
  const free = (key, title, ph, short) => `
    <section class="card"><h2>${title}</h2>
      <div class="prompts">${PROMPTS[key].map(p => `<button data-prompt="${key}">${p}</button>`).join('')}</div>
      <textarea class="free${short ? ' short' : ''}" data-text="${key}" placeholder="${ph}">${esc(e[key])}</textarea>
    </section>`;
  return `
    ${scaleHTML('mood')}${scaleHTML('energy')}${scaleHTML('health')}
    <section class="card"><h2>睡眠</h2><div class="chips">${SLEEP.map(h =>
      `<button data-sleep="${h}" class="${e.sleep === h ? 'on' : ''}">${h === 4 ? '〜4' : h === 9 ? '9〜' : h}時間</button>`).join('')}</div></section>
    <section class="card"><h2>タグ</h2><div class="chips">${settings.tags.map(t =>
      `<button data-tag="${esc(t)}" class="${e.tags.includes(t) ? 'on' : ''}">${esc(t)}</button>`).join('')}</div></section>
    <section class="card"><h2>予定・イベント ${configured() ? '<button class="link-btn" data-act="refresh-cal">↻ カレンダー更新</button>' : ''}</h2>
      ${events || `<p class="empty">${configured() ? 'カレンダーの予定はまだありません' : 'GitHub連携でカレンダーの予定が自動で入ります'}</p>`}
      <div class="add-row"><input id="new-event" placeholder="予定・出来事を追加"><button data-act="add-event">追加</button></div>
    </section>
    ${free('happened', '出来事', '今日あったこと（音声入力も便利）')}
    ${free('feelings', '感想', 'どう感じた？')}
    ${free('lesson', '教訓', '今日の学びを一行で', true)}
    <button class="save" data-act="save">保存して同期</button>`;
}

function historyHTML() {
  const dates = allDates();
  if (!dates.length) return '<p class="empty">まだ日記がありません</p>';
  return dates.map(d => {
    const e = load(d);
    const text = e.lesson || e.happened || e.events.map(x => x.title).join('・') || '（記録のみ）';
    return `<button class="hist-item" data-open="${d}">
      <span class="hist-mood">${e.mood ? SCALES.mood.opts[e.mood - 1] : '·'}</span>
      <span class="hist-body"><div class="hist-date">${prettyDate(d)}</div><div class="hist-text">${esc(text.split('\n')[0])}</div></span>
      ${isUnsynced(e) ? '<span class="dot" title="未同期"></span>' : ''}
    </button>`;
  }).join('');
}

function settingsHTML() {
  return `<section class="card settings">
      <h2>GitHub 同期</h2>
      <label>ユーザー名（owner）<input id="s-owner" value="${esc(settings.owner)}" autocapitalize="off" autocomplete="off"></label>
      <label>非公開リポジトリ名<input id="s-repo" value="${esc(settings.repo)}" autocapitalize="off" autocomplete="off" placeholder="my-diary"></label>
      <label>ブランチ<input id="s-branch" value="${esc(settings.branch)}" autocapitalize="off"></label>
      <label>アクセストークン（Fine-grained）<input id="s-token" type="password" value="${esc(settings.token)}" autocomplete="off"></label>
      <p class="help">日記用リポジトリだけに「Contents: Read and write」「Actions: Read and write」を許可したトークンを使ってください。トークンはこの端末にだけ保存されます。</p>
    </section>
    <section class="card settings">
      <h2>タグ</h2>
      <label>カンマ区切り<textarea id="s-tags" rows="3">${esc(settings.tags.join(', '))}</textarea></label>
    </section>
    <button class="save" data-act="save-settings">設定を保存して接続テスト</button>`;
}

// ---------- 操作 ----------

function openDate(d) {
  current = d; entry = load(d); tab = 'today';
  render(); window.scrollTo(0, 0);
  pull(d).catch(err => toast(err.message));
}

document.getElementById('prev').onclick = () => openDate(shiftDate(current, -1));
document.getElementById('next').onclick = () => openDate(shiftDate(current, 1));
document.querySelectorAll('.tabbar button').forEach(b => b.onclick = () => {
  tab = b.dataset.tab; if (tab === 'today') entry = load(current);
  render(); window.scrollTo(0, 0);
});

view.addEventListener('click', async (ev) => {
  const b = ev.target.closest('button');
  if (!b) return;
  const d = b.dataset;
  if (d.scale) { entry[d.scale] = entry[d.scale] === +d.v ? null : +d.v; persist(); render(); }
  else if (d.sleep) { entry.sleep = entry.sleep === +d.sleep ? null : +d.sleep; persist(); render(); }
  else if (d.tag) { entry.tags = entry.tags.includes(d.tag) ? entry.tags.filter(t => t !== d.tag) : [...entry.tags, d.tag]; persist(); render(); }
  else if (d.react) { const e = entry.events[+d.react]; e.reaction = e.reaction === d.v ? null : d.v; persist(); render(); }
  else if (d.del) { entry.events.splice(+d.del, 1); persist(); render(); }
  else if (d.prompt) {
    const ta = view.querySelector(`[data-text="${d.prompt}"]`);
    ta.value += (ta.value && !ta.value.endsWith('\n') ? '\n' : '') + b.textContent + '：';
    entry[d.prompt] = ta.value; persist(); ta.focus();
  }
  else if (d.open) openDate(d.open);
  else if (d.act === 'add-event') {
    const input = document.getElementById('new-event');
    const title = input.value.trim();
    if (!title) return;
    entry.events.push({ id: 'manual-' + Date.now(), start: '', allDay: false, title, source: 'manual', reaction: null, note: '' });
    persist(); render();
  }
  else if (d.act === 'refresh-cal') {
    try {
      const res = await gh('actions/workflows/calendar.yml/dispatches', { method: 'POST', body: JSON.stringify({ ref: settings.branch }) });
      if (res.status === 404) throw new Error('calendar.yml が見つかりません');
      toast('カレンダー取得を開始しました（1〜2分後に開き直すと反映）');
    } catch (err) { toast(err.message); }
  }
  else if (d.act === 'save') {
    persist();
    if (!configured()) { toast('端末に保存しました'); return; }
    b.disabled = true; b.textContent = '同期中…';
    try { await pushEntry(entry); toast('保存してGitHubに同期しました'); }
    catch (err) { toast('端末には保存済み。同期失敗: ' + err.message); }
    b.disabled = false; b.textContent = '保存して同期'; renderStatus();
  }
  else if (d.act === 'save-settings') {
    settings = {
      owner: document.getElementById('s-owner').value.trim(),
      repo: document.getElementById('s-repo').value.trim(),
      branch: document.getElementById('s-branch').value.trim() || 'main',
      token: document.getElementById('s-token').value.trim(),
      tags: document.getElementById('s-tags').value.split(/[,、\n]/).map(s => s.trim()).filter(Boolean),
    };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    if (!configured()) { toast('保存しました（同期はオフ）'); return; }
    try {
      const res = await gh('');
      toast(res.status === 404 ? 'リポジトリが見つかりません' : '接続OK！同期を開始します');
      if (res.ok) syncPending();
    } catch (err) { toast(err.message); }
  }
});

view.addEventListener('input', (ev) => {
  const t = ev.target;
  if (t.dataset.text) { entry[t.dataset.text] = t.value; persist(); }
  else if (t.dataset.note) { entry.events[+t.dataset.note].note = t.value; persist(); }
});
view.addEventListener('keydown', (ev) => {
  if (ev.target.id === 'new-event' && ev.key === 'Enter' && !ev.isComposing) view.querySelector('[data-act="add-event"]').click();
});

window.addEventListener('online', syncPending);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

openDate(current);
syncPending();
