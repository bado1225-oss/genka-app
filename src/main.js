/* 原価計算アプリ - main.js */

const LS_KEY = 'genka_v1';
const state = {
  recipes: [],
  currentId: null,
  selectedListId: null,
};

// ============ ユーティリティ ============
function uid(prefix) { return (prefix||'x') + Date.now().toString(36) + Math.floor(Math.random()*1e4).toString(36); }
function num(v, d) { const n = parseFloat(v); return isFinite(n) ? n : (d ?? 0); }
function round(n, d) { const p = Math.pow(10, d||0); return Math.round(n * p) / p; }
function fmt(n, d) { if (!isFinite(n)) return '0'; d = d ?? 0; return n.toLocaleString('ja-JP', {minimumFractionDigits: d, maximumFractionDigits: d}); }
function today() { const d = new Date(); return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`; }

// ============ 永続化 ============
function loadState() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      state.recipes = Array.isArray(parsed.recipes) ? parsed.recipes : [];
    }
  } catch (e) { console.warn('load failed', e); }
}
function saveState() {
  localStorage.setItem(LS_KEY, JSON.stringify({recipes: state.recipes, saved_at: new Date().toISOString()}));
}

// ============ レシピ モデル ============
function makeRecipe(init) {
  return Object.assign({
    id: uid('r'),
    name: '新規レシピ',
    category: '餃子',
    unit_weight_g: 17,
    quantity: 100,
    use_skin: 1,
    skin_g: 10,
    skin_kg_price: 965,
    salt_ratio_pct: 2,
    salt_kg_price: 108,
    ingredients: [],
    updated_at: new Date().toISOString(),
  }, init||{});
}
function makeIngredient(init) {
  return Object.assign({
    id: uid('i'),
    name: '',
    base_g: 0,
    kg_price: 0,
    x2: 0,
    dewater: 0,
  }, init||{});
}

// ============ 計算エンジン ============
function calcRecipe(r) {
  const ings = r.ingredients || [];
  const total_base = ings.reduce((s,i)=>s+num(i.base_g),0);
  const target_total_g = num(r.unit_weight_g) * num(r.quantity);
  const rows = ings.map(i => {
    const base = num(i.base_g);
    const ratio = total_base > 0 ? base / total_base : 0;
    const scaled_g = target_total_g * ratio;
    const g_price = num(i.kg_price) / 1000;
    const mul = i.x2 ? 2 : 1;
    const cost = scaled_g * g_price * mul;
    return { ing: i, base, ratio, scaled_g, g_price, cost };
  });
  // 塩(水抜き用)
  const dewater_scaled = rows.filter(x => x.ing.dewater).reduce((s,x)=>s+x.scaled_g, 0);
  const salt_g = dewater_scaled * 2 * (num(r.salt_ratio_pct) / 100);
  const salt_cost = salt_g * (num(r.salt_kg_price) / 1000);
  // 皮
  const skin_total_g = r.use_skin ? num(r.skin_g) * num(r.quantity) : 0;
  const skin_cost = r.use_skin ? skin_total_g * (num(r.skin_kg_price) / 1000) : 0;
  const skin_per = (r.use_skin && num(r.quantity) > 0) ? skin_cost / num(r.quantity) : 0;

  const ing_cost = rows.reduce((s,x)=>s+x.cost, 0);
  const total_cost = ing_cost + salt_cost + skin_cost;
  const per_cost = num(r.quantity) > 0 ? total_cost / num(r.quantity) : 0;

  // 比率(重量ベース)の分母
  const mass_total = rows.reduce((s,x)=>s+(x.scaled_g*(x.ing.x2?2:1)),0) + salt_g + skin_total_g;

  const out_rows = rows.map(x => {
    const mass = x.scaled_g * (x.ing.x2?2:1);
    const mass_ratio = mass_total > 0 ? mass / mass_total : 0;
    const per_unit = num(r.quantity) > 0 ? x.cost / num(r.quantity) : 0;
    return { ...x, mass, mass_ratio, per_unit };
  });

  return {
    rows: out_rows,
    total_base,
    target_total_g,
    dewater_scaled,
    salt_g,
    salt_cost,
    skin_total_g,
    skin_cost,
    skin_per,
    ing_cost,
    total_cost,
    per_cost,
    mass_total,
  };
}

// ============ 画面制御 ============
function showTab(tab) {
  document.querySelectorAll('.main-segment-btn').forEach(b => b.classList.remove('active'));
  const map = { recipes: 'seg-recipes', tools: 'seg-tools', settings: 'seg-settings' };
  const segId = map[tab];
  if (segId) document.getElementById(segId).classList.add('active');
  document.getElementById('view-recipes').style.display = tab === 'recipes' ? '' : 'none';
  document.getElementById('view-tools').style.display = tab === 'tools' ? '' : 'none';
  document.getElementById('view-settings').style.display = tab === 'settings' ? '' : 'none';
  if (tab === 'recipes') {
    backToList();
  }
  if (tab === 'tools') {
    calcScrap();
    calcDewater();
    calcEmulsion();
  }
}

function renderHero() {
  const total = state.recipes.length;
  const cats = {};
  state.recipes.forEach(r => { cats[r.category] = (cats[r.category]||0) + 1; });
  const costs = state.recipes.map(r => calcRecipe(r).per_cost).filter(n => n>0);
  const avg = costs.length ? costs.reduce((a,b)=>a+b,0)/costs.length : 0;
  const max = costs.length ? Math.max(...costs) : 0;
  const kpis = document.getElementById('dashboard-kpis');
  kpis.innerHTML = `
    <div class="kpi"><div class="kpi-label">登録レシピ</div><div class="kpi-value">${total}</div></div>
    <div class="kpi"><div class="kpi-label">カテゴリ</div><div class="kpi-value">${Object.keys(cats).length}</div></div>
    <div class="kpi"><div class="kpi-label">平均1個原価</div><div class="kpi-value accent">¥${fmt(avg,1)}</div></div>
    <div class="kpi"><div class="kpi-label">最高1個原価</div><div class="kpi-value accent">¥${fmt(max,1)}</div></div>
  `;
  document.getElementById('hero-stamp').textContent = total ? `${total}件 / 最終更新 ${today()}` : 'レシピ未登録';
}

function renderCategoryFilter() {
  const sel = document.getElementById('filter-category');
  const cats = Array.from(new Set(state.recipes.map(r => r.category))).sort();
  const cur = sel.value || 'all';
  sel.innerHTML = '<option value="all">カテゴリ: すべて</option>' + cats.map(c => `<option value="${c}">カテゴリ: ${c}</option>`).join('');
  sel.value = cur;
}

function renderRecipeList() {
  const cat = document.getElementById('filter-category').value;
  const q = document.getElementById('search-recipe').value.trim().toLowerCase();
  const list = state.recipes.filter(r =>
    (cat === 'all' || r.category === cat) &&
    (!q || r.name.toLowerCase().includes(q))
  );
  const wrap = document.getElementById('recipe-list');
  if (!list.length) {
    wrap.innerHTML = '<div class="empty-note">レシピがありません。「＋ 新規レシピ」または 設定から「炭火焼鶏餃子 を追加」してください。</div>';
    return;
  }
  wrap.innerHTML = list.map(r => {
    const c = calcRecipe(r);
    const selected = state.selectedListId === r.id ? ' selected' : '';
    return `<div class="recipe-card${selected}" onclick="openRecipe('${r.id}')" oncontextmenu="selectRecipeInList(event,'${r.id}')">
      <div class="rc-cat">${r.category || '-'}</div>
      <div class="rc-name">${escapeHtml(r.name||'(無題)')}</div>
      <div class="rc-stats">
        <div>個数 <b>${fmt(num(r.quantity))}</b></div>
        <div>1個原価 <b>¥${fmt(c.per_cost,1)}</b></div>
        <div>総原価 <b>¥${fmt(c.total_cost,0)}</b></div>
      </div>
    </div>`;
  }).join('');
  document.getElementById('btn-duplicate').disabled = !state.selectedListId;
}

function selectRecipeInList(e, id) {
  e.preventDefault();
  state.selectedListId = state.selectedListId === id ? null : id;
  renderRecipeList();
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

// ============ レシピ編集 ============
function newRecipe() {
  const r = makeRecipe();
  state.recipes.push(r);
  saveState();
  state.currentId = r.id;
  renderHero();
  renderCategoryFilter();
  openRecipe(r.id);
}

function duplicateSelected() {
  const src = state.recipes.find(r => r.id === state.selectedListId);
  if (!src) return;
  const copy = makeRecipe(JSON.parse(JSON.stringify(src)));
  copy.id = uid('r');
  copy.name = src.name + ' (複製)';
  copy.ingredients = copy.ingredients.map(i => Object.assign({}, i, { id: uid('i') }));
  state.recipes.push(copy);
  saveState();
  renderHero();
  renderRecipeList();
  openRecipe(copy.id);
}

function openRecipe(id) {
  const r = state.recipes.find(x => x.id === id);
  if (!r) return;
  state.currentId = id;
  document.getElementById('recipe-list-pane').style.display = 'none';
  document.getElementById('recipe-edit-pane').style.display = '';
  document.getElementById('edit-name').value = r.name;
  document.getElementById('edit-category').value = r.category;
  document.getElementById('edit-unit-weight').value = r.unit_weight_g;
  document.getElementById('edit-quantity').value = r.quantity;
  document.getElementById('edit-use-skin').value = r.use_skin ? '1' : '0';
  document.getElementById('edit-salt-ratio').value = r.salt_ratio_pct;
  document.getElementById('edit-skin-g').value = r.skin_g;
  document.getElementById('edit-skin-price').value = r.skin_kg_price;
  document.getElementById('save-stamp').textContent = '最終保存 ' + (r.updated_at ? new Date(r.updated_at).toLocaleString('ja-JP') : '未保存');
  renderIngredients();
  toggleSkin();
  recompute();
}

function backToList() {
  state.currentId = null;
  document.getElementById('recipe-list-pane').style.display = '';
  document.getElementById('recipe-edit-pane').style.display = 'none';
  renderHero();
  renderCategoryFilter();
  renderRecipeList();
}

function deleteCurrent() {
  const r = getCurrent(); if (!r) return;
  if (!confirm(`「${r.name}」を削除しますか？`)) return;
  state.recipes = state.recipes.filter(x => x.id !== r.id);
  saveState();
  backToList();
}

function saveCurrent() {
  const r = getCurrent(); if (!r) return;
  writeBackForm(r);
  r.updated_at = new Date().toISOString();
  saveState();
  document.getElementById('save-stamp').textContent = '保存しました ' + today();
}

function getCurrent() { return state.recipes.find(x => x.id === state.currentId); }

function writeBackForm(r) {
  r.name = document.getElementById('edit-name').value || '(無題)';
  r.category = document.getElementById('edit-category').value;
  r.unit_weight_g = num(document.getElementById('edit-unit-weight').value);
  r.quantity = num(document.getElementById('edit-quantity').value);
  r.use_skin = document.getElementById('edit-use-skin').value === '1' ? 1 : 0;
  r.salt_ratio_pct = num(document.getElementById('edit-salt-ratio').value);
  r.skin_g = num(document.getElementById('edit-skin-g').value);
  r.skin_kg_price = num(document.getElementById('edit-skin-price').value);
  // ingredients are already mutated in place
}

function toggleSkin() {
  const on = document.getElementById('edit-use-skin').value === '1';
  document.getElementById('skin-card').style.display = on ? '' : 'none';
}

function addIngredient() {
  const r = getCurrent(); if (!r) return;
  r.ingredients.push(makeIngredient());
  renderIngredients();
  recompute();
}

function removeIngredient(id) {
  const r = getCurrent(); if (!r) return;
  r.ingredients = r.ingredients.filter(i => i.id !== id);
  renderIngredients();
  recompute();
}

function renderIngredients() {
  const r = getCurrent(); if (!r) return;
  const tbody = document.getElementById('ing-tbody');
  tbody.innerHTML = r.ingredients.map(i => `
    <tr data-id="${i.id}">
      <td class="col-name"><input class="name-input" type="text" value="${escapeHtml(i.name)}" onchange="updateIng('${i.id}','name',this.value)"></td>
      <td class="col-g"><input type="number" step="0.1" value="${i.base_g}" onchange="updateIng('${i.id}','base_g',this.value)"></td>
      <td class="col-scaled">–</td>
      <td class="col-price"><input type="number" step="1" value="${i.kg_price}" onchange="updateIng('${i.id}','kg_price',this.value)"></td>
      <td class="col-cost">–</td>
      <td class="col-per">–</td>
      <td class="col-ratio">–</td>
      <td class="col-x2"><input type="checkbox" ${i.x2?'checked':''} onchange="updateIng('${i.id}','x2',this.checked?1:0)"></td>
      <td class="col-dewater"><input type="checkbox" ${i.dewater?'checked':''} onchange="updateIng('${i.id}','dewater',this.checked?1:0)"></td>
      <td class="col-del"><button onclick="removeIngredient('${i.id}')" title="削除">🗑</button></td>
    </tr>
  `).join('');
}

function updateIng(id, key, value) {
  const r = getCurrent(); if (!r) return;
  const i = r.ingredients.find(x => x.id === id); if (!i) return;
  if (key === 'name') i[key] = value;
  else if (key === 'x2' || key === 'dewater') i[key] = value ? 1 : 0;
  else i[key] = num(value);
  recompute();
}

function recompute() {
  const r = getCurrent(); if (!r) return;
  writeBackForm(r);
  const c = calcRecipe(r);
  // rows
  const tbody = document.getElementById('ing-tbody');
  c.rows.forEach(row => {
    const tr = tbody.querySelector(`tr[data-id="${row.ing.id}"]`);
    if (!tr) return;
    tr.querySelector('.col-scaled').textContent = fmt(row.scaled_g, 1);
    tr.querySelector('.col-cost').textContent = '¥' + fmt(row.cost, 1);
    tr.querySelector('.col-per').textContent = '¥' + fmt(row.per_unit, 2);
    tr.querySelector('.col-ratio').textContent = fmt(row.mass_ratio*100, 1) + '%';
  });
  // footer
  const tfoot = document.getElementById('ing-tfoot');
  tfoot.innerHTML = `
    <tr>
      <td style="text-align:left">合計(材料)</td>
      <td>${fmt(c.total_base,0)}</td>
      <td>${fmt(c.rows.reduce((s,x)=>s+x.scaled_g,0),1)}</td>
      <td></td>
      <td>¥${fmt(c.ing_cost,1)}</td>
      <td>¥${fmt(c.ing_cost/Math.max(1,num(r.quantity)),2)}</td>
      <td></td>
      <td colspan="3"></td>
    </tr>
    ${c.salt_g > 0 ? `<tr>
      <td style="text-align:left">塩(水抜き用) ${fmt(r.salt_ratio_pct,1)}%</td>
      <td></td>
      <td>${fmt(c.salt_g,1)}</td>
      <td>${fmt(num(r.salt_kg_price),0)}</td>
      <td>¥${fmt(c.salt_cost,1)}</td>
      <td>¥${fmt(c.salt_cost/Math.max(1,num(r.quantity)),2)}</td>
      <td colspan="4"></td>
    </tr>` : ''}
  `;
  // skin per
  document.getElementById('edit-skin-per').value = '¥' + fmt(c.skin_per, 2);
  // summary
  document.getElementById('sum-total-g').textContent = fmt(c.target_total_g + c.salt_g + c.skin_total_g, 1);
  document.getElementById('sum-quantity').textContent = fmt(num(r.quantity), 0);
  document.getElementById('sum-total-cost').textContent = '¥' + fmt(c.total_cost, 0);
  document.getElementById('sum-per-cost').textContent = '¥' + fmt(c.per_cost, 2);
  const parts = [];
  parts.push(`材料 ¥${fmt(c.ing_cost,0)}`);
  if (c.salt_cost > 0) parts.push(`塩 ¥${fmt(c.salt_cost,1)}`);
  if (c.skin_cost > 0) parts.push(`皮 ¥${fmt(c.skin_cost,0)}`);
  document.getElementById('sum-note').textContent = `内訳: ${parts.join(' + ')}`;
}

// ============ 補助ツール ============
function calcScrap() {
  const unit = num(document.getElementById('tool-scrap-unit').value, 17);
  const a = num(document.getElementById('tool-scrap-a').value, 2650);
  const total = num(document.getElementById('tool-scrap-total').value, 15120);
  const tbody = document.getElementById('scrap-tbody');
  const multipliers = [1,2,3,4,5,6];
  const out = multipliers.map(m => {
    const scrap = 500 * m;
    const anRatio = a > 0 ? (total - a) / a : 0;
    const an = scrap * anRatio;
    const count = (scrap + an) / unit;
    return `<tr><td>${fmt(scrap,0)}</td><td>${fmt(an,0)}</td><td>${fmt(count,1)}</td></tr>`;
  }).join('');
  tbody.innerHTML = out;
}

function calcDewater() {
  const mode = document.getElementById('tool-dw-mode').value;
  const ratio = num(document.getElementById('tool-dw-ratio').value, 1.89);
  const rows = document.querySelectorAll('#dw-tbody tr');
  let sumBefore = 0, sumAfter = 0, sumS1 = 0, sumS2 = 0;
  rows.forEach(tr => {
    const v = num(tr.querySelector('.dw-input').value);
    let before, after;
    if (mode === 'before') { before = v; after = ratio > 0 ? v / ratio : 0; }
    else { after = v; before = v * ratio; }
    const s1 = before * 0.01;
    const s2 = before * 0.02;
    tr.querySelector('.dw-before').textContent = fmt(before,1);
    tr.querySelector('.dw-after').textContent = fmt(after,1);
    tr.querySelector('.dw-s1').textContent = fmt(s1,2);
    tr.querySelector('.dw-s2').textContent = fmt(s2,2);
    sumBefore += before; sumAfter += after; sumS1 += s1; sumS2 += s2;
  });
  document.getElementById('dw-sum-before').textContent = fmt(sumBefore,1);
  document.getElementById('dw-sum-after').textContent = fmt(sumAfter,1);
  document.getElementById('dw-sum-s1').textContent = fmt(sumS1,2);
  document.getElementById('dw-sum-s2').textContent = fmt(sumS2,2);
}

function calcEmulsion() {
  const veg = num(document.getElementById('emu-veg').value);
  const e = num(document.getElementById('emu-ratio-e').value, 58);
  const v = num(document.getElementById('emu-ratio-v').value, 42);
  const result = v > 0 ? (veg * e) / v : 0;
  document.getElementById('emu-out').value = fmt(result, 1) + ' g';
}

// ============ 設定 ============
function exportAll() {
  const data = { version: 1, recipes: state.recipes, exported_at: new Date().toISOString() };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `genka-recipes-${new Date().toISOString().slice(0,10)}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

function importAll(ev) {
  const file = ev.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const parsed = JSON.parse(e.target.result);
      const recipes = Array.isArray(parsed.recipes) ? parsed.recipes : [];
      if (!recipes.length) { alert('レシピが含まれていません'); return; }
      if (!confirm(`${recipes.length}件のレシピをインポートします。既存データに追加しますか？（キャンセルで上書き）`)) {
        state.recipes = recipes;
      } else {
        state.recipes = state.recipes.concat(recipes.map(r => Object.assign(makeRecipe(), r, {id: uid('r')})));
      }
      saveState();
      renderHero(); renderCategoryFilter(); renderRecipeList();
      alert('読み込み完了');
    } catch (err) {
      alert('読み込みに失敗: ' + err.message);
    }
  };
  reader.readAsText(file);
  ev.target.value = '';
}

// ============ 炭火焼鶏餃子 サンプル ============
function seedGyoza() {
  const r = makeRecipe({
    name: '炭火焼鶏餃子',
    category: '餃子',
    unit_weight_g: 17,
    quantity: 333,
    use_skin: 1,
    skin_g: 10,
    skin_kg_price: 965,
    salt_ratio_pct: 2,
    salt_kg_price: 108,
    ingredients: [
      { id: uid('i'), name: '炭火焼鶏',       base_g: 2650, kg_price: 1012, x2: 0, dewater: 0 },
      { id: uid('i'), name: '豚ミンチ2mm',     base_g: 3000, kg_price: 1080, x2: 0, dewater: 0 },
      { id: uid('i'), name: 'キャベツ',        base_g: 4320, kg_price: 397,  x2: 1, dewater: 1 },
      { id: uid('i'), name: '玉ねぎ',          base_g: 580,  kg_price: 430,  x2: 1, dewater: 1 },
      { id: uid('i'), name: 'ニラ',            base_g: 180,  kg_price: 1728, x2: 1, dewater: 1 },
      { id: uid('i'), name: 'コンソメ(スープ用)', base_g: 48, kg_price: 972,  x2: 0, dewater: 0 },
      { id: uid('i'), name: '水',              base_g: 3000, kg_price: 0,    x2: 0, dewater: 0 },
      { id: uid('i'), name: 'にんにく',        base_g: 430,  kg_price: 670,  x2: 0, dewater: 0 },
      { id: uid('i'), name: 'しょうが',        base_g: 144,  kg_price: 734,  x2: 0, dewater: 0 },
      { id: uid('i'), name: 'オイスター',      base_g: 156,  kg_price: 998,  x2: 0, dewater: 0 },
      { id: uid('i'), name: '醤油',            base_g: 156,  kg_price: 386,  x2: 0, dewater: 0 },
      { id: uid('i'), name: '味の素',          base_g: 96,   kg_price: 1004, x2: 0, dewater: 0 },
      { id: uid('i'), name: 'コンソメ',        base_g: 84,   kg_price: 972,  x2: 0, dewater: 0 },
      { id: uid('i'), name: 'ごま油',          base_g: 84,   kg_price: 1040, x2: 0, dewater: 0 },
      { id: uid('i'), name: '砂糖',            base_g: 72,   kg_price: 324,  x2: 0, dewater: 0 },
    ],
  });
  state.recipes.push(r);
  saveState();
  renderHero(); renderCategoryFilter(); renderRecipeList();
  alert('「炭火焼鶏餃子」を追加しました');
}

// ============ 起動 ============
function init() {
  loadState();
  renderHero();
  renderCategoryFilter();
  renderRecipeList();
  calcScrap(); calcDewater(); calcEmulsion();
  // SW
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(()=>{});
  }
}
document.addEventListener('DOMContentLoaded', init);
