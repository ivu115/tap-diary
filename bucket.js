// やりたいこと100個 — 項目マスタ（bucketlist/items.json）と達成状態（bucketlist/state.json）は
// 非公開の diary-data に置く（公開リポジトリには本人の文面を入れない）。端末に即保存してから GitHub に同期する。

const BK_ITEMS_PATH = 'bucketlist/items.json';
const BK_STATE_PATH = 'bucketlist/state.json';
const BK_CATS = ['日本文化・伝統', '家族・つながり', '生き方・人間性', '仕事・スキル・お金', '体験・遊び・暮らし'];
const BK_FILTERS = [['all', 'すべて'], ['left', '残りだけ'], ['lifelong', '一生ものだけ']];

let bkMaster = bkLoadLocal('bucket:items');
let bkState = bkLoadLocal('bucket:state');
let bkFilter = 'all';
let bkForm = null; // 追加・編集フォームの中身 {id?, text, category, type}
let bkPushTimer = null;
let bkPulling = null;

function bkLoadLocal(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
}
// 初期状態はマスタの state（93番の達成）をそのまま引き継ぐ
function bkInitState(master) {
  return { done: JSON.parse(JSON.stringify(master.state || {})), addedItems: [], nextId: 101, updatedAt: null, syncedAt: null };
}
function bkSaveLocal() { localStorage.setItem('bucket:state', JSON.stringify(bkState)); }
function bkPersist() {
  bkState.updatedAt = new Date().toISOString();
  bkSaveLocal();
  bkSchedulePush();
}
const bkUnsynced = () => bkState?.updatedAt && (!bkState.syncedAt || bkState.syncedAt < bkState.updatedAt);

// 元の100個は文面・番号をマスタのまま使い、追加項目だけ state 側から足す
function bkItems() {
  if (!bkMaster || !bkState) return [];
  const base = bkMaster.items.map(({ id, text, category, type }) => ({ id, text, category, type, added: false }));
  return [...base, ...bkState.addedItems.map(x => ({ ...x, added: true }))];
}
const bkDone = id => !!bkState.done[id];

async function bkPull() {
  if (!configured()) return;
  if (bkPulling) return bkPulling;
  bkPulling = (async () => {
    const [items, state] = await Promise.all([getFile(BK_ITEMS_PATH), getFile(BK_STATE_PATH)]);
    if (items) { bkMaster = JSON.parse(items.text); localStorage.setItem('bucket:items', items.text); }
    if (!bkMaster) return;
    if (state) {
      const r = JSON.parse(state.text);
      if (!bkState || !bkState.updatedAt || (r.updatedAt && r.updatedAt > bkState.updatedAt)) {
        bkState = { ...bkInitState(bkMaster), ...r, syncedAt: r.updatedAt };
        bkSaveLocal();
      }
    }
    if (!bkState) { bkState = bkInitState(bkMaster); bkPersist(); }   // state.json がまだ無ければ作る
    else if (bkUnsynced()) bkSchedulePush(0);
  })().finally(() => { bkPulling = null; });
  return bkPulling;
}

function bkSchedulePush(delay = 1500) {
  if (!configured()) return;
  clearTimeout(bkPushTimer);
  bkPushTimer = setTimeout(bkPush, delay);  // 連続タップを1コミットにまとめる
}
async function bkPush() {
  const { syncedAt, ...data } = bkState;
  try {
    const cur = await getFile(BK_STATE_PATH);
    const body = { message: 'bucketlist: 更新', content: b64(JSON.stringify(data, null, 2) + '\n'), branch: settings.branch };
    if (cur) body.sha = cur.sha;
    const res = await gh(`contents/${BK_STATE_PATH}`, { method: 'PUT', body: JSON.stringify(body) });
    if (res.status === 404) throw new Error('リポジトリが見つかりません（設定を確認）');
    bkState.syncedAt = data.updatedAt;
    bkSaveLocal();
    if (tab === 'bucket') renderStatus();
  } catch (err) { toast('やりたいことの同期に失敗: ' + err.message); }
}

// ---------- 描画 ----------

function bucketHTML() {
  if (!bkMaster || !bkState) {
    if (configured()) bkPull().then(() => tab === 'bucket' && render()).catch(err => toast(err.message));
    return `<p class="empty center-pad">${configured() ? '読み込み中…' : '設定タブで GitHub 同期をつなぐと、やりたいこと100個が表示されます'}</p>`;
  }
  const items = bkItems();
  const normal = items.filter(x => x.type === 'normal');
  const doneCount = normal.filter(x => bkDone(x.id)).length;
  const lifelong = items.filter(x => x.type === 'lifelong');
  const visible = items.filter(x =>
    bkFilter === 'all' || (bkFilter === 'lifelong' ? x.type === 'lifelong' : x.type === 'normal' && !bkDone(x.id)));

  const row = x => {
    const life = x.type === 'lifelong';
    const done = !life && bkDone(x.id);
    const doneAt = done && bkState.done[x.id].doneAt;
    const body = `<span class="bk-num">${x.id}</span><span class="bk-text">${esc(x.text)}</span>` +
      (life ? '<span class="bk-badge">一生もの</span>' : done ? `<span class="bk-check">✓${doneAt ? ' ' + doneAt.slice(5).replace('-', '/') : ''}</span>` : '<span class="bk-box"></span>');
    return `<div class="bk-row${life ? ' lifelong' : ''}${done ? ' done' : ''}">
      ${life ? `<div class="bk-main">${body}</div>` : `<button class="bk-main" data-bk-toggle="${x.id}" aria-pressed="${done}">${body}</button>`}
      ${x.added ? `<button class="bk-edit" data-bk-edit="${x.id}" aria-label="編集">✎</button>` : ''}
    </div>`;
  };
  const sections = BK_CATS.map(cat => {
    const list = visible.filter(x => x.category === cat).sort((a, b) => a.id - b.id);
    return list.length ? `<section class="card bk-section"><h2>${cat} <span class="h2-sub">${list.length}個</span></h2>${list.map(row).join('')}</section>` : '';
  }).join('');

  return `
    <section class="card bk-head">
      <div class="bk-left">残り<b>${normal.length - doneCount}</b>個</div>
      <div class="meter"><div class="meter-fill" style="width:${normal.length ? doneCount / normal.length * 100 : 0}%"></div></div>
      <div class="bk-sub"><span>達成 ${doneCount} / ${normal.length}</span><span class="bk-life-count">一生もの ${lifelong.length}個</span></div>
    </section>
    <div class="seg wide bk-filter">${BK_FILTERS.map(([k, l]) => `<button data-bk-filter="${k}" class="${bkFilter === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    ${bkForm ? bkFormHTML() : '<button class="bk-add" data-bk-act="new">＋ 追加</button>'}
    ${sections || `<p class="empty center-pad">${bkFilter === 'left' ? '残りはありません。全部達成！' : '表示する項目がありません'}</p>`}`;
}

function bkFormHTML() {
  const f = bkForm;
  return `<section class="card bk-form">
    <h2>${f.id ? `${f.id}番を編集` : 'やりたいことを追加'}</h2>
    <textarea id="bk-text" rows="2" placeholder="やりたいこと">${esc(f.text)}</textarea>
    <div class="chips">${BK_CATS.map(c => `<button data-bk-cat="${c}" class="${f.category === c ? 'on' : ''}">${c}</button>`).join('')}</div>
    <div class="seg wide bk-type">
      <button data-bk-type="normal" class="${f.type === 'normal' ? 'on' : ''}">通常（達成で打ち消し）</button>
      <button data-bk-type="lifelong" class="${f.type === 'lifelong' ? 'on' : ''}">一生もの</button>
    </div>
    <div class="bk-form-actions">
      ${f.id ? '<button class="btn-sub bk-del" data-bk-act="delete">削除</button>' : ''}
      <button class="btn-sub" data-bk-act="cancel">キャンセル</button>
      <button class="bk-save" data-bk-act="save">${f.id ? '保存' : '追加'}</button>
    </div>
  </section>`;
}

// ---------- 操作 ----------

view.addEventListener('click', (ev) => {
  if (tab !== 'bucket') return;
  const b = ev.target.closest('button');
  if (!b) return;
  const d = b.dataset;
  if (d.bkToggle) {
    const id = +d.bkToggle;
    if (bkDone(id)) delete bkState.done[id];
    else bkState.done[id] = { doneAt: dateStr(new Date()) };
    bkPersist(); render();
  }
  else if (d.bkFilter) { bkFilter = d.bkFilter; render(); }
  else if (d.bkEdit) {
    const x = bkState.addedItems.find(x => x.id === +d.bkEdit);
    bkForm = { ...x }; render(); window.scrollTo(0, 0);
  }
  else if (d.bkCat) { bkForm.category = d.bkCat; bkSyncForm(); }
  else if (d.bkType) { bkForm.type = d.bkType; bkSyncForm(); }
  else if (d.bkAct === 'new') { bkForm = { text: '', category: null, type: 'normal' }; render(); document.getElementById('bk-text')?.focus(); }
  else if (d.bkAct === 'cancel') { bkForm = null; render(); }
  else if (d.bkAct === 'save') {
    const text = bkForm.text.trim();
    if (!text) { toast('やりたいことを入力してください'); return; }
    if (!bkForm.category) { toast('カテゴリを選んでください'); return; }
    if (bkForm.id) {
      Object.assign(bkState.addedItems.find(x => x.id === bkForm.id), { text, category: bkForm.category, type: bkForm.type });
      if (bkForm.type === 'lifelong') delete bkState.done[bkForm.id];
    } else {
      // 追加項目は101から連番。削除しても番号は使い回さない
      const id = Math.max(bkState.nextId || 101, ...bkState.addedItems.map(x => x.id + 1));
      bkState.addedItems.push({ id, text, category: bkForm.category, type: bkForm.type, addedAt: dateStr(new Date()) });
      bkState.nextId = id + 1;
      toast(`${id}番として追加しました`);
    }
    bkForm = null; bkPersist(); render();
  }
  else if (d.bkAct === 'delete') {
    if (!confirm(`${bkForm.id}番「${bkForm.text}」を削除しますか？`)) return;
    bkState.addedItems = bkState.addedItems.filter(x => x.id !== bkForm.id);
    delete bkState.done[bkForm.id];
    bkForm = null; bkPersist(); render();
  }
});
view.addEventListener('input', (ev) => {
  if (tab === 'bucket' && ev.target.id === 'bk-text') bkForm.text = ev.target.value;
});
// フォームの選択だけ切り替える（入力中の文面を消さないよう全体は描き直さない）
function bkSyncForm() {
  view.querySelectorAll('[data-bk-cat]').forEach(x => x.classList.toggle('on', x.dataset.bkCat === bkForm.category));
  view.querySelectorAll('[data-bk-type]').forEach(x => x.classList.toggle('on', x.dataset.bkType === bkForm.type));
}
