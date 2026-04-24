/* 原価計算アプリ v2.0 - main.js
   食材マスタ(価格台帳) + レシピ(1人前あたり使用g) の2層構造
*/

const LS_KEY = 'genka_v2';
const PRICE_TYPES = {
  market:   { label: '市場価格',   short: '市', color: '#3f8a5a', bg: '#e8f2ec' },
  purchase: { label: '仕入れ価格', short: '仕', color: '#3a6ba0', bg: '#e6eef7' },
  spot:     { label: '都度入力',   short: '都', color: '#c67b1d', bg: '#faefda' },
};
const INGREDIENT_CATS = ['肉','魚','野菜','調味料','皮','その他'];

const state = {
  ingredients: [],
  recipes: [],
  currentRecipeId: null,
  selectedListId: null,
  ingModalMode: 'add',
  ingModalId: null,
};

// ============ ユーティリティ ============
function uid(p){return (p||'x')+Date.now().toString(36)+Math.floor(Math.random()*1e6).toString(36);}
function num(v,d){const n=parseFloat(v);return isFinite(n)?n:(d??0);}
function fmt(n,d){if(!isFinite(n))return'0';d=d??0;return n.toLocaleString('ja-JP',{minimumFractionDigits:d,maximumFractionDigits:d});}
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function nowStamp(){const d=new Date();return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;}

// ============ 永続化 ============
function loadState(){
  try{
    const raw = localStorage.getItem(LS_KEY);
    if(raw){
      const p = JSON.parse(raw);
      state.ingredients = Array.isArray(p.ingredients)?p.ingredients:[];
      state.recipes = Array.isArray(p.recipes)?p.recipes:[];
      migrateLegacy();
    }
  }catch(e){console.warn('load failed',e);}
}

function migrateLegacy(){
  state.recipes.forEach(r => {
    // 皮を通常食材として items に追加
    if(r.skin_enabled && r.skin_ingredient_id && num(r.skin_g_per_serving) > 0){
      r.items.push(makeItem({
        ingredient_id: r.skin_ingredient_id,
        grams: num(r.skin_g_per_serving),
        multiplier: 1,
      }));
    }
    // 塩(水抜き用)を通常食材として items に追加
    if(r.auto_salt && r.salt_ingredient_id){
      const dewaterG = (r.items||[]).filter(it=>it.dewater).reduce((s,it)=>s+num(it.grams),0);
      const saltG = dewaterG * 2 * (num(r.salt_ratio_pct)/100);
      if(saltG > 0){
        r.items.push(makeItem({
          ingredient_id: r.salt_ingredient_id,
          grams: +saltG.toFixed(3),
          multiplier: 1,
        }));
      }
    }
    // 旧フィールドを削除
    delete r.auto_salt; delete r.salt_ratio_pct; delete r.salt_ingredient_id;
    delete r.skin_enabled; delete r.skin_ingredient_id; delete r.skin_g_per_serving;
    // items の x2/dewater → multiplier → yield_pct、spot_price → price_override
    (r.items||[]).forEach(it => {
      // multiplier 未設定時は x2 から暫定
      if(it.multiplier === undefined && it.yield_pct === undefined){
        it.multiplier = it.x2 ? 2 : 1;
      }
      // multiplier → yield_pct (yield_pct = 100/multiplier)
      if(it.yield_pct === undefined){
        const m = num(it.multiplier, 1);
        it.yield_pct = m > 0 ? Math.round((100/m)*10)/10 : 100;
      }
      delete it.multiplier;
      delete it.x2;
      delete it.dewater;
      if(it.spot_price !== undefined){
        if(it.price_override === undefined) it.price_override = it.spot_price;
        delete it.spot_price;
      }
      if(it.price_override === undefined) it.price_override = null;
    });
  });
}
function saveState(){
  localStorage.setItem(LS_KEY, JSON.stringify({
    ingredients: state.ingredients,
    recipes: state.recipes,
    saved_at: new Date().toISOString(),
    version: 2,
  }));
}

// ============ モデル ============
function makeIngredient(init){
  return Object.assign({
    id: uid('ing'),
    name: '',
    category: '調味料',
    price_type: 'purchase',
    kg_price: 0,
    memo: '',
    updated_at: new Date().toISOString(),
  }, init||{});
}
function makeRecipe(init){
  return Object.assign({
    id: uid('rec'),
    name: '新規レシピ',
    category: '餃子',
    per_serving_desc: '',
    items: [],
    updated_at: new Date().toISOString(),
  }, init||{});
}
function makeItem(init){
  return Object.assign({
    id: uid('it'),
    ingredient_id: null,
    grams: 0,
    yield_pct: 100, // 歩留まり(%) 100=ロスなし、50=半分ロス(実仕入は2倍必要)
    price_override: null, // このレシピでのみ適用する kg単価(null=マスタ値を使用)
  }, init||{});
}

function getIngredient(id){return state.ingredients.find(i=>i.id===id);}
function getRecipe(id){return state.recipes.find(r=>r.id===id);}
function getCurrent(){return getRecipe(state.currentRecipeId);}

// ============ 計算エンジン ============
function effectivePrice(item){
  const ing = getIngredient(item.ingredient_id);
  if(!ing) return null;
  if(item.price_override != null && item.price_override !== '') return num(item.price_override);
  return num(ing.kg_price);
}
function hasPriceOverride(item){
  return item.price_override != null && item.price_override !== '';
}

function calcRecipe(r){
  if(!r) return null;
  const items = r.items || [];
  const rows = items.map(it => {
    const ing = getIngredient(it.ingredient_id);
    const price = effectivePrice(it);
    const g = num(it.grams);
    const yp = num(it.yield_pct, 100);
    const yield_rate = yp > 0 ? yp/100 : 1; // 0%は無効扱い
    const raw_g = g / yield_rate; // 仕入が必要な量(歩留前重量)
    const has_price = price != null && ing;
    const cost = has_price ? raw_g * (price/1000) : 0;
    return { item: it, ingredient: ing, price, g, raw_g, yield_pct: yp, cost, has_price };
  });
  const ing_cost = rows.reduce((s,x)=>s+x.cost, 0);
  const total_g = rows.reduce((s,x)=>s+x.g, 0);   // 1人前出来上がり
  const mass_g = rows.reduce((s,x)=>s+x.raw_g, 0); // 1人前 仕入必要量
  const per_cost = ing_cost;
  const mass_total = mass_g || 1;
  rows.forEach(x => { x.mass_ratio = x.raw_g/mass_total; });
  return {rows, ing_cost, total_g, mass_g, per_cost};
}

// ============ タブ制御 ============
function showTab(tab){
  const tabs = ['recipes','master','tools','settings'];
  tabs.forEach(t => {
    const seg = document.getElementById('seg-'+t);
    if(seg) seg.classList.toggle('active', t===tab);
    const view = document.getElementById('view-'+t);
    if(view) view.style.display = t===tab ? '' : 'none';
  });
  if(tab==='recipes'){ backToList(); }
  if(tab==='master'){ renderMaster(); }
  if(tab==='tools'){ calcScrap(); calcDewater(); calcEmulsion(); }
  if(tab==='settings'){}
  renderHero();
}

function renderHero(){
  const recipes = state.recipes.length;
  const ings = state.ingredients.length;
  const costs = state.recipes.map(r=>calcRecipe(r).per_cost).filter(n=>n>0);
  const avg = costs.length?costs.reduce((a,b)=>a+b,0)/costs.length:0;
  const max = costs.length?Math.max(...costs):0;
  document.getElementById('dashboard-kpis').innerHTML = `
    <div class="kpi"><div class="kpi-label">レシピ</div><div class="kpi-value">${recipes}</div></div>
    <div class="kpi"><div class="kpi-label">登録食材</div><div class="kpi-value">${ings}</div></div>
    <div class="kpi"><div class="kpi-label">平均1人前</div><div class="kpi-value accent">¥${fmt(avg,0)}</div></div>
    <div class="kpi"><div class="kpi-label">最高1人前</div><div class="kpi-value accent">¥${fmt(max,0)}</div></div>
  `;
  document.getElementById('hero-stamp').textContent = recipes ? `${recipes}レシピ / ${ings}食材 / ${nowStamp()}` : 'データ未登録';
}

// ============ レシピ一覧 ============
function renderRecipeCategoryFilter(){
  const sel = document.getElementById('filter-recipe-category');
  const cats = Array.from(new Set(state.recipes.map(r=>r.category))).sort();
  const cur = sel.value || 'all';
  sel.innerHTML = '<option value="all">カテゴリ: すべて</option>' + cats.map(c=>`<option value="${esc(c)}">カテゴリ: ${esc(c)}</option>`).join('');
  sel.value = cur;
}

function renderRecipeList(){
  renderRecipeCategoryFilter();
  const cat = document.getElementById('filter-recipe-category').value;
  const q = document.getElementById('search-recipe').value.trim().toLowerCase();
  const list = state.recipes.filter(r =>
    (cat==='all'||r.category===cat) &&
    (!q || (r.name||'').toLowerCase().includes(q))
  );
  const wrap = document.getElementById('recipe-list');
  if(!list.length){
    wrap.innerHTML = '<div class="empty-note">レシピがありません。「＋ 新規レシピ」または 設定タブから「炭火焼鶏餃子 一式」を追加してください。</div>';
    return;
  }
  wrap.innerHTML = list.map(r => {
    const c = calcRecipe(r);
    const sel = state.selectedListId===r.id?' selected':'';
    const unit = r.per_serving_desc ? `/${esc(r.per_serving_desc)}` : '/人前';
    return `<div class="recipe-card${sel}" onclick="openRecipe('${r.id}')" oncontextmenu="selectInList(event,'${r.id}')">
      <div class="rc-cat">${esc(r.category||'-')}</div>
      <div class="rc-name">${esc(r.name||'(無題)')}</div>
      <div class="rc-stats">
        <div>材料 <b>${r.items.length}</b></div>
        <div>1人前 <b>¥${fmt(c.per_cost,0)}</b>${unit}</div>
        <div>重量 <b>${fmt(c.total_g,1)}g</b></div>
      </div>
    </div>`;
  }).join('');
  document.getElementById('btn-duplicate').disabled = !state.selectedListId;
}

function selectInList(e,id){
  e.preventDefault();
  state.selectedListId = state.selectedListId===id?null:id;
  renderRecipeList();
}

function newRecipe(){
  const r = makeRecipe();
  state.recipes.push(r);
  saveState();
  openRecipe(r.id);
  renderHero();
}

function duplicateSelected(){
  const src = getRecipe(state.selectedListId);
  if(!src) return;
  const copy = JSON.parse(JSON.stringify(src));
  copy.id = uid('rec');
  copy.name = src.name + ' (複製)';
  copy.items = copy.items.map(it => Object.assign({}, it, {id: uid('it')}));
  state.recipes.push(copy);
  saveState();
  renderRecipeList();
  openRecipe(copy.id);
}

// ============ レシピ編集 ============
function openRecipe(id){
  const r = getRecipe(id);
  if(!r) return;
  state.currentRecipeId = id;
  document.getElementById('recipe-list-pane').style.display = 'none';
  document.getElementById('recipe-edit-pane').style.display = '';
  document.getElementById('edit-name').value = r.name;
  document.getElementById('edit-category').value = r.category;
  document.getElementById('edit-serving-desc').value = r.per_serving_desc||'';
  document.getElementById('scale-servings').value = 1;
  document.getElementById('save-stamp').textContent = r.updated_at ? `最終保存 ${new Date(r.updated_at).toLocaleString('ja-JP')}` : '';
  renderItems();
  recompute();
}

function backToList(){
  state.currentRecipeId = null;
  document.getElementById('recipe-list-pane').style.display = '';
  document.getElementById('recipe-edit-pane').style.display = 'none';
  renderRecipeList();
  renderHero();
}

function deleteCurrent(){
  const r = getCurrent(); if(!r) return;
  if(!confirm(`「${r.name}」を削除しますか？`)) return;
  state.recipes = state.recipes.filter(x=>x.id!==r.id);
  saveState();
  backToList();
}

function saveCurrent(){
  const r = getCurrent(); if(!r) return;
  writeBackForm(r);
  r.updated_at = new Date().toISOString();
  saveState();
  document.getElementById('save-stamp').textContent = '保存しました '+nowStamp();
  renderHero();
}

function writeBackForm(r){
  r.name = document.getElementById('edit-name').value || '(無題)';
  r.category = document.getElementById('edit-category').value;
  r.per_serving_desc = document.getElementById('edit-serving-desc').value || '';
}

function buildIngredientOptions(){
  const groups = {};
  INGREDIENT_CATS.forEach(c=>groups[c]=[]);
  state.ingredients.forEach(i => (groups[i.category]||groups['その他']).push(i));
  // 各グループ内は名前順にソート
  Object.values(groups).forEach(arr => arr.sort((a,b)=>(a.name||'').localeCompare(b.name||'','ja')));
  let html = '';
  INGREDIENT_CATS.forEach(c=>{
    if(!groups[c].length) return;
    html += `<optgroup label="${c}">`;
    groups[c].forEach(i=>{
      html += `<option value="${i.id}">${esc(i.name)}</option>`;
    });
    html += `</optgroup>`;
  });
  return html;
}

// ----- 材料行 -----
function renderItems(){
  const r = getCurrent(); if(!r) return;
  const wrap = document.getElementById('item-list');
  if(!r.items.length){
    wrap.innerHTML = '<div class="empty-note small">材料がありません。「＋ 材料追加」から追加してください。</div>';
    return;
  }
  wrap.innerHTML = r.items.map((it,idx)=>renderItemCard(it,idx)).join('');
}

function renderItemCard(it, idx){
  const ing = getIngredient(it.ingredient_id);
  const optsAll = buildIngredientOptions();
  const selOpts = `<option value="">(食材を選択)</option>` + optsAll;
  const priceInfo = ing ? priceBadgeHtml(ing, it) : '<span class="muted">未選択</span>';
  const price = effectivePrice(it);
  const yp = num(it.yield_pct, 100);
  const yield_rate = yp > 0 ? yp/100 : 1;
  const raw_g = num(it.grams) / yield_rate;
  const cost = (price!=null && ing) ? (raw_g * price/1000) : 0;
  const masterPrice = ing ? num(ing.kg_price) : null;
  const overridden = hasPriceOverride(it);
  const priceVal = overridden ? it.price_override : (masterPrice!=null ? masterPrice : '');
  const resetBtn = overridden
    ? `<button type="button" class="reset-link" onclick="updateItem('${it.id}','price_override',null)" title="マスタ単価に戻す">↺</button>`
    : '';
  const yieldNote = yp < 100 ? `<span class="yield-hint">仕入必要 ${fmt(raw_g,1)}g</span>` : '';
  return `<div class="item-card${overridden?' has-override':''}" data-id="${it.id}">
    <div class="item-row-main">
      <select class="item-ing-select" onchange="updateItem('${it.id}','ingredient_id',this.value)">
        ${selOpts.replace(`value="${it.ingredient_id}"`, `value="${it.ingredient_id}" selected`)}
      </select>
      <button class="icon-del" onclick="removeItem('${it.id}')" title="削除">🗑</button>
    </div>
    <div class="item-row-fields">
      <label class="inline-field">
        <span>使用g</span>
        <input type="number" step="0.1" value="${it.grams}" onchange="updateItem('${it.id}','grams',this.value)">
      </label>
      <label class="inline-field price ${overridden?'override':''}">
        <span>kg単価¥ ${resetBtn}</span>
        <input type="number" step="1" value="${priceVal}" placeholder="${masterPrice!=null?fmt(masterPrice,0):'(食材未選択)'}" onchange="updateItem('${it.id}','price_override',this.value)" title="このレシピだけで使う kg単価。空欄でマスタ値に戻ります">
      </label>
      <label class="inline-field yield">
        <span>歩留まり(%)</span>
        <input type="number" step="0.1" min="0" max="100" value="${yp}" onchange="updateItem('${it.id}','yield_pct',this.value)" title="100=ロスなし / 80=20%ロス / 50=半分ロス(実仕入は使用gの2倍必要)">
      </label>
    </div>
    <div class="item-row-info">
      ${priceInfo}
      ${yieldNote}
      <span class="item-cost">原価 <b>¥${fmt(cost,2)}</b></span>
    </div>
  </div>`;
}

function priceBadgeHtml(ing, it){
  const t = PRICE_TYPES[ing.price_type]||{};
  const master = num(ing.kg_price);
  if(hasPriceOverride(it)){
    const ov = num(it.price_override);
    return `<span class="price-badge" style="background:${t.bg};color:${t.color}">${t.short||''}</span>
      <span class="price-master-note">マスタ¥${fmt(master,0)}/kg</span>
      <span class="price-override-note">→ このレシピ ¥${fmt(ov,0)}/kg</span>`;
  }
  return `<span class="price-badge" style="background:${t.bg};color:${t.color}">${t.short||''}</span> ¥${fmt(master,0)}/kg <span class="muted-sub">(マスタ値)</span>`;
}

function updateItem(id, key, value){
  const r = getCurrent(); if(!r) return;
  const it = r.items.find(x=>x.id===id); if(!it) return;
  if(key==='ingredient_id'){
    it.ingredient_id = value || null;
    it.price_override = null;
  } else if(key==='grams'){
    it.grams = value==='' ? 0 : num(value);
  } else if(key==='price_override'){
    if(value === null || value === '' || value === undefined){
      it.price_override = null;
    } else {
      it.price_override = num(value);
    }
  } else if(key==='yield_pct'){
    if(value==='' || value===null) it.yield_pct = 100;
    else {
      const v = num(value, 100);
      it.yield_pct = Math.max(0, Math.min(100, v));
    }
  }
  renderItems();
  recompute();
}

function addItem(){
  const r = getCurrent(); if(!r) return;
  r.items.push(makeItem());
  renderItems();
  recompute();
}

function removeItem(id){
  const r = getCurrent(); if(!r) return;
  r.items = r.items.filter(i=>i.id!==id);
  renderItems();
  recompute();
}

function recompute(){
  const r = getCurrent(); if(!r) return;
  writeBackForm(r);
  const c = calcRecipe(r);
  document.getElementById('sum-per-cost').textContent = fmt(c.per_cost,0);
  document.getElementById('sum-total-g').textContent = fmt(c.total_g,1);
  document.getElementById('sum-item-count').textContent = r.items.length;
  document.getElementById('sum-mass-g').textContent = fmt(c.mass_g,1);
  const unlinked = c.rows.filter(x=>!x.ingredient).length;
  const nopriceCnt = c.rows.filter(x=>!x.has_price).length;
  const note = [`合計 ¥${fmt(c.per_cost,2)}`];
  if(unlinked) note.push(`⚠ 未選択 ${unlinked}件`);
  document.getElementById('sum-note').textContent = note.join(' / ');

  const servings = num(document.getElementById('scale-servings').value, 1);
  document.getElementById('scale-total-g').value = fmt(c.total_g*servings,1) + ' g';
  document.getElementById('scale-total-cost').value = '¥'+fmt(c.per_cost*servings,0);
}

// ============ 食材マスタ ============
function renderMaster(){
  const cat = document.getElementById('filter-master-category').value;
  const type = document.getElementById('filter-master-type').value;
  const q = document.getElementById('search-master').value.trim().toLowerCase();
  const list = state.ingredients
    .filter(i => (cat==='all'||i.category===cat))
    .filter(i => (type==='all'||i.price_type===type))
    .filter(i => !q || (i.name||'').toLowerCase().includes(q));
  const wrap = document.getElementById('master-list');
  if(!list.length){
    wrap.innerHTML = '<div class="empty-note small">食材がありません。「＋ 食材を追加」または「サンプル食材一括追加」で登録してください。</div>';
    return;
  }
  const grouped = {};
  INGREDIENT_CATS.forEach(c=>grouped[c]=[]);
  list.forEach(i => (grouped[i.category]||grouped['その他']).push(i));
  const rendered = INGREDIENT_CATS.filter(c=>grouped[c].length).map(c => {
    return `<div class="master-group">
      <div class="master-group-title">${c} <span class="group-count">${grouped[c].length}</span></div>
      ${grouped[c].map(i=>renderIngredientRow(i)).join('')}
    </div>`;
  }).join('');
  wrap.innerHTML = rendered;
}

function renderIngredientRow(i){
  const t = PRICE_TYPES[i.price_type]||{};
  const used = state.recipes.reduce((s,r)=>s+r.items.filter(it=>it.ingredient_id===i.id).length, 0);
  return `<div class="ing-row">
    <div class="ing-row-main">
      <span class="price-badge" style="background:${t.bg};color:${t.color}">${t.short||''}</span>
      <span class="ing-name">${esc(i.name)}</span>
    </div>
    <div class="ing-row-meta">
      <span class="ing-price">¥${fmt(i.kg_price,0)}/kg</span>
      ${i.memo?`<span class="ing-memo">${esc(i.memo)}</span>`:''}
      ${used>0?`<span class="ing-used">使用中 ${used}件</span>`:'<span class="ing-unused">未使用</span>'}
    </div>
    <div class="ing-row-actions">
      <button class="ghost-btn small" onclick="openIngModal('${i.id}')">編集</button>
      <button class="danger-btn small" onclick="deleteIngredient('${i.id}')">削除</button>
    </div>
  </div>`;
}

function addIngredient(){
  state.ingModalMode = 'add';
  state.ingModalId = null;
  document.getElementById('ing-modal-title').textContent = '食材を追加';
  document.getElementById('ing-name').value = '';
  document.getElementById('ing-category').value = '野菜';
  document.getElementById('ing-type').value = 'market';
  document.getElementById('ing-price').value = '';
  document.getElementById('ing-memo').value = '';
  document.getElementById('ing-modal').style.display = 'flex';
  setTimeout(()=>document.getElementById('ing-name').focus(), 50);
}

function openIngModal(id){
  const i = getIngredient(id); if(!i) return;
  state.ingModalMode = 'edit';
  state.ingModalId = id;
  document.getElementById('ing-modal-title').textContent = '食材を編集';
  document.getElementById('ing-name').value = i.name;
  document.getElementById('ing-category').value = i.category;
  document.getElementById('ing-type').value = i.price_type;
  document.getElementById('ing-price').value = i.kg_price;
  document.getElementById('ing-memo').value = i.memo||'';
  document.getElementById('ing-modal').style.display = 'flex';
}

function closeIngModal(){
  document.getElementById('ing-modal').style.display = 'none';
}
function closeIngModalBg(e){
  if(e.target.id==='ing-modal') closeIngModal();
}

function saveIngModal(){
  const name = document.getElementById('ing-name').value.trim();
  if(!name){ alert('食材名を入力してください'); return; }
  const data = {
    name,
    category: document.getElementById('ing-category').value,
    price_type: document.getElementById('ing-type').value,
    kg_price: num(document.getElementById('ing-price').value),
    memo: document.getElementById('ing-memo').value.trim(),
    updated_at: new Date().toISOString(),
  };
  if(state.ingModalMode==='edit' && state.ingModalId){
    const i = getIngredient(state.ingModalId);
    if(i) Object.assign(i, data);
  } else {
    state.ingredients.push(makeIngredient(data));
  }
  saveState();
  closeIngModal();
  renderMaster();
  renderHero();
  if(getCurrent()){
    populateIngredientSelects();
    renderItems();
    recompute();
  }
}

function deleteIngredient(id){
  const i = getIngredient(id); if(!i) return;
  const used = state.recipes.reduce((s,r)=>s+r.items.filter(it=>it.ingredient_id===id).length, 0);
  const msg = used>0
    ? `「${i.name}」は${used}件のレシピで使用中です。削除するとそれらの行は未選択になります。削除しますか？`
    : `「${i.name}」を削除しますか？`;
  if(!confirm(msg)) return;
  state.ingredients = state.ingredients.filter(x=>x.id!==id);
  state.recipes.forEach(r => {
    r.items.forEach(it => { if(it.ingredient_id===id) it.ingredient_id = null; });
    if(r.salt_ingredient_id===id) r.salt_ingredient_id = null;
    if(r.skin_ingredient_id===id) r.skin_ingredient_id = null;
  });
  saveState();
  renderMaster();
  renderHero();
}

// ============ 補助ツール ============
function calcScrap(){
  const unit = num(document.getElementById('tool-scrap-unit').value,17);
  const a = num(document.getElementById('tool-scrap-a').value,2650);
  const total = num(document.getElementById('tool-scrap-total').value,15000);
  const tb = document.getElementById('scrap-tbody');
  const out = [1,2,3,4,5,6].map(m=>{
    const scrap = 500*m;
    const anRatio = a>0 ? (total-a)/a : 0;
    const an = scrap*anRatio;
    const count = (scrap+an)/unit;
    return `<tr><td>${fmt(scrap,0)}</td><td>${fmt(an,0)}</td><td>${fmt(count,1)}</td></tr>`;
  }).join('');
  tb.innerHTML = out;
}

function calcDewater(){
  const mode = document.getElementById('tool-dw-mode').value;
  const ratio = num(document.getElementById('tool-dw-ratio').value,1.89);
  const rows = document.querySelectorAll('#dw-tbody tr');
  let sB=0,sA=0,s1=0,s2=0;
  rows.forEach(tr=>{
    const v = num(tr.querySelector('.dw-input').value);
    let before,after;
    if(mode==='before'){before=v;after=ratio>0?v/ratio:0;}
    else{after=v;before=v*ratio;}
    const _s1 = before*0.01, _s2 = before*0.02;
    tr.querySelector('.dw-before').textContent=fmt(before,1);
    tr.querySelector('.dw-after').textContent=fmt(after,1);
    tr.querySelector('.dw-s1').textContent=fmt(_s1,2);
    tr.querySelector('.dw-s2').textContent=fmt(_s2,2);
    sB+=before;sA+=after;s1+=_s1;s2+=_s2;
  });
  document.getElementById('dw-sum-before').textContent=fmt(sB,1);
  document.getElementById('dw-sum-after').textContent=fmt(sA,1);
  document.getElementById('dw-sum-s1').textContent=fmt(s1,2);
  document.getElementById('dw-sum-s2').textContent=fmt(s2,2);
}

function calcEmulsion(){
  const veg = num(document.getElementById('emu-veg').value);
  const e = num(document.getElementById('emu-ratio-e').value,58);
  const v = num(document.getElementById('emu-ratio-v').value,42);
  const out = v>0 ? (veg*e)/v : 0;
  document.getElementById('emu-out').value = fmt(out,1)+' g';
}

// ============ 設定 ============
function exportAll(){
  const data = {version:2,ingredients:state.ingredients,recipes:state.recipes,exported_at:new Date().toISOString()};
  const blob = new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href=url; a.download=`genka-${new Date().toISOString().slice(0,10)}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

function importAll(ev){
  const file = ev.target.files[0]; if(!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try{
      const p = JSON.parse(e.target.result);
      const ings = Array.isArray(p.ingredients)?p.ingredients:[];
      const recs = Array.isArray(p.recipes)?p.recipes:[];
      if(!ings.length && !recs.length){ alert('有効なデータが見つかりません'); return; }
      if(!confirm(`食材${ings.length}件 / レシピ${recs.length}件 を読み込みます。既存データに追加しますか？(キャンセルで上書き)`)){
        state.ingredients = ings;
        state.recipes = recs;
      } else {
        state.ingredients = state.ingredients.concat(ings);
        state.recipes = state.recipes.concat(recs);
      }
      saveState();
      renderHero(); renderMaster(); renderRecipeList();
      alert('読み込み完了');
    }catch(err){alert('読み込み失敗: '+err.message);}
  };
  reader.readAsText(file);
  ev.target.value = '';
}

function resetAll(){
  if(!confirm('食材マスタとレシピを全て削除します。よろしいですか？')) return;
  if(!confirm('本当にすべて削除しますか？(この操作は元に戻せません)')) return;
  state.ingredients = [];
  state.recipes = [];
  saveState();
  renderHero(); renderMaster(); renderRecipeList();
}

// ============ シード(餃子一式) ============
const SEED_INGREDIENTS = [
  {name:'地頭鶏(炭火焼)',    category:'肉',    price_type:'purchase', kg_price:1012, memo:'炭火焼後の端材'},
  {name:'豚ミンチ2mm',       category:'肉',    price_type:'purchase', kg_price:1080, memo:''},
  {name:'キャベツ',          category:'野菜',  price_type:'market',   kg_price:397,  memo:''},
  {name:'玉ねぎ',            category:'野菜',  price_type:'market',   kg_price:430,  memo:''},
  {name:'ニラ',              category:'野菜',  price_type:'market',   kg_price:1728, memo:''},
  {name:'にんにく',          category:'野菜',  price_type:'market',   kg_price:670,  memo:''},
  {name:'しょうが',          category:'野菜',  price_type:'market',   kg_price:734,  memo:''},
  {name:'コンソメ(スープ用)',category:'調味料', price_type:'purchase', kg_price:972,  memo:''},
  {name:'コンソメ',          category:'調味料', price_type:'purchase', kg_price:972,  memo:''},
  {name:'水',                category:'調味料', price_type:'purchase', kg_price:0,    memo:''},
  {name:'オイスターソース',  category:'調味料', price_type:'purchase', kg_price:998,  memo:''},
  {name:'醤油',              category:'調味料', price_type:'purchase', kg_price:386,  memo:''},
  {name:'味の素',            category:'調味料', price_type:'purchase', kg_price:1004, memo:''},
  {name:'ごま油',            category:'調味料', price_type:'purchase', kg_price:1040, memo:''},
  {name:'砂糖',              category:'調味料', price_type:'purchase', kg_price:324,  memo:''},
  {name:'塩(水抜き用)',      category:'調味料', price_type:'purchase', kg_price:108,  memo:'野菜の塩水抜き用'},
  {name:'餃子の皮 10cm',     category:'皮',    price_type:'purchase', kg_price:965,  memo:'伸和食品 1.0mm 10.5g/枚'},
];

function seedMaster(){
  const added = [];
  SEED_INGREDIENTS.forEach(s => {
    if(state.ingredients.some(i=>i.name===s.name)) return;
    const ing = makeIngredient(s);
    state.ingredients.push(ing);
    added.push(ing);
  });
  saveState();
  renderMaster();
  renderHero();
  alert(`食材マスタに${added.length}件追加しました(既存重複はスキップ)`);
}

// ============ 野菜価格マスター(27件) 一括取り込み ============
const VEGETABLE_MASTER = [
  {id:'V001',name:'キャベツ',     sub:'葉物',    kg:92,   yield:0.85,memo:'市場価格ベース'},
  {id:'V002',name:'はくさい',     sub:'葉物',    kg:56,   yield:0.85,memo:'市場価格ベース'},
  {id:'V003',name:'だいこん',     sub:'根菜',    kg:74,   yield:0.90,memo:'市場価格ベース'},
  {id:'V004',name:'にんじん',     sub:'根菜',    kg:192,  yield:0.90,memo:'市場価格ベース'},
  {id:'V005',name:'たまねぎ',     sub:'根菜',    kg:245,  yield:0.90,memo:'市場価格ベース'},
  {id:'V006',name:'じゃがいも',   sub:'芋類',    kg:293,  yield:0.90,memo:'市場価格ベース'},
  {id:'V007',name:'さつまいも',   sub:'芋類',    kg:284,  yield:0.90,memo:'市場価格ベース'},
  {id:'V008',name:'ねぎ',         sub:'香味野菜',kg:341,  yield:0.85,memo:'市場価格ベース'},
  {id:'V009',name:'にら',         sub:'香味野菜',kg:618,  yield:0.85,memo:'市場価格ベース'},
  {id:'V010',name:'ほうれんそう', sub:'葉物',    kg:496,  yield:0.85,memo:'市場価格ベース'},
  {id:'V011',name:'小松菜',       sub:'葉物',    kg:275,  yield:0.85,memo:'市場価格ベース'},
  {id:'V012',name:'水菜',         sub:'葉物',    kg:317,  yield:0.85,memo:'市場価格ベース'},
  {id:'V013',name:'レタス',       sub:'葉物',    kg:167,  yield:0.85,memo:'市場価格ベース'},
  {id:'V014',name:'きゅうり',     sub:'果菜',    kg:397,  yield:0.95,memo:'市場価格ベース'},
  {id:'V015',name:'なす',         sub:'果菜',    kg:478,  yield:0.95,memo:'市場価格ベース'},
  {id:'V016',name:'トマト',       sub:'果菜',    kg:430,  yield:0.95,memo:'市場価格ベース'},
  {id:'V017',name:'ミニトマト',   sub:'果菜',    kg:624,  yield:0.95,memo:'市場価格ベース'},
  {id:'V018',name:'ピーマン',     sub:'果菜',    kg:704,  yield:0.95,memo:'市場価格ベース'},
  {id:'V019',name:'ごぼう',       sub:'根菜',    kg:380,  yield:0.85,memo:'市場価格ベース'},
  {id:'V020',name:'れんこん',     sub:'根菜',    kg:369,  yield:0.85,memo:'市場価格ベース'},
  {id:'V021',name:'ブロッコリー', sub:'その他',  kg:424,  yield:0.80,memo:'花蕾類/市場価格ベース'},
  {id:'V022',name:'かぼちゃ',     sub:'果菜',    kg:245,  yield:0.80,memo:'市場価格ベース'},
  {id:'V023',name:'にんにく',     sub:'香味野菜',kg:1567, yield:0.90,memo:'輸入物中心で価格変動大/市場価格ベース'},
  {id:'V024',name:'しょうが',     sub:'香味野菜',kg:1198, yield:0.90,memo:'市場価格ベース'},
  {id:'V025',name:'生しいたけ',   sub:'きのこ',  kg:1017, yield:0.95,memo:'市場価格ベース'},
  {id:'V026',name:'えのきだけ',   sub:'きのこ',  kg:288,  yield:0.95,memo:'市場価格ベース'},
  {id:'V027',name:'しめじ',       sub:'きのこ',  kg:399,  yield:0.95,memo:'市場価格ベース'},
];

function seedVegetables(){
  let added = 0, skipped = 0;
  VEGETABLE_MASTER.forEach(v => {
    if(state.ingredients.some(i=>i.name===v.name)){ skipped++; return; }
    state.ingredients.push(makeIngredient({
      name: v.name,
      category: '野菜',
      price_type: 'market',
      kg_price: v.kg,
      memo: `[${v.id}] ${v.sub} / 歩留${Math.round(v.yield*100)}% / ${v.memo}`,
    }));
    added++;
  });
  saveState();
  renderMaster(); renderHero();
  alert(`野菜マスター: ${added}件 追加 / ${skipped}件 既存スキップ`);
}

// ============ 魚マスター(20件) 一括取り込み ============
const FISH_MASTER = [
  {id:'F001',name:'アジ',             sub:'魚（青魚）',price:800,  yield:0.60, note:'丸魚'},
  {id:'F002',name:'イワシ',           sub:'魚（青魚）',price:600,  yield:0.50, note:'丸魚'},
  {id:'F003',name:'サバ',             sub:'魚（青魚）',price:700,  yield:0.60, note:'丸魚〜三枚おろし'},
  {id:'F004',name:'タイ',             sub:'魚（白身）',price:2000, yield:0.65, note:'三枚おろし'},
  {id:'F005',name:'ヒラメ',           sub:'魚（白身）',price:2500, yield:0.65, note:'三枚おろし'},
  {id:'F006',name:'カレイ',           sub:'魚（白身）',price:1500, yield:0.65, note:'三枚おろし'},
  {id:'F007',name:'マグロ(赤身)',     sub:'高級魚',    price:2500, yield:0.85, note:'ブロック/切り身'},
  {id:'F008',name:'サーモン',         sub:'高級魚',    price:2000, yield:0.85, note:'フィレ'},
  {id:'F009',name:'ブリ',             sub:'高級魚',    price:1800, yield:0.65, note:'三枚おろし'},
  {id:'F010',name:'うなぎ',           sub:'高級魚',    price:4000, yield:0.60, note:'活鰻想定'},
  {id:'F011',name:'あさり',           sub:'貝類',      price:800,  yield:0.30, note:'殻付き'},
  {id:'F012',name:'しじみ',           sub:'貝類',      price:700,  yield:0.30, note:'殻付き'},
  {id:'F013',name:'ホタテ',           sub:'貝類',      price:2000, yield:0.50, note:'殻付き想定'},
  {id:'F014',name:'エビ',             sub:'甲殻類',    price:1800, yield:0.55, note:'殻付き'},
  {id:'F015',name:'ブラックタイガー', sub:'甲殻類',    price:2000, yield:0.55, note:'殻付き'},
  {id:'F016',name:'カニ',             sub:'甲殻類',    price:4000, yield:0.40, note:'殻付き丸ごと'},
  {id:'F017',name:'イカ',             sub:'その他',    price:1200, yield:0.80, note:'内臓処理後'},
  {id:'F018',name:'タコ',             sub:'その他',    price:1800, yield:0.80, note:'下処理後'},
  {id:'F019',name:'ちくわ',           sub:'加工品',    price:800,  yield:1.00, note:'加工品は全量可食'},
  {id:'F020',name:'かまぼこ',         sub:'加工品',    price:1000, yield:1.00, note:'加工品は全量可食'},
];

function seedFish(){
  let added = 0, skipped = 0;
  FISH_MASTER.forEach(v => {
    if(state.ingredients.some(i=>i.name===v.name)){ skipped++; return; }
    state.ingredients.push(makeIngredient({
      name: v.name,
      category: '魚',
      price_type: 'spot', // 季節変動大のためレシピ側で都度価格上書き推奨
      kg_price: v.price,
      memo: `[${v.id}] ${v.sub} / 歩留${Math.round(v.yield*100)}% / ${v.note} / 業務用平均価格・季節変動大`,
    }));
    added++;
  });
  saveState();
  renderMaster(); renderHero();
  alert(`魚マスター: ${added}件 追加 / ${skipped}件 既存スキップ`);
}

// ============ 肉マスター(19件) 一括取り込み ============
const MEAT_MASTER = [
  {id:'M001',name:'牛こま肉',   sub:'牛肉',   price:1800, yield:0.90},
  {id:'M002',name:'牛バラ肉',   sub:'牛肉',   price:2200, yield:0.85},
  {id:'M003',name:'牛ロース',   sub:'牛肉',   price:3500, yield:0.90},
  {id:'M004',name:'牛ヒレ',     sub:'牛肉',   price:6000, yield:0.85},
  {id:'M005',name:'牛すじ',     sub:'牛肉',   price:900,  yield:0.85},
  {id:'M006',name:'豚こま肉',   sub:'豚肉',   price:900,  yield:0.90},
  {id:'M007',name:'豚バラ肉',   sub:'豚肉',   price:1200, yield:0.90},
  {id:'M008',name:'豚ロース',   sub:'豚肉',   price:1300, yield:0.90},
  {id:'M009',name:'豚ヒレ',     sub:'豚肉',   price:1500, yield:0.90},
  {id:'M010',name:'豚ミンチ',   sub:'豚肉',   price:800,  yield:1.00},
  {id:'M011',name:'鶏もも肉',   sub:'鶏肉',   price:800,  yield:0.90},
  {id:'M012',name:'鶏むね肉',   sub:'鶏肉',   price:600,  yield:0.90},
  {id:'M013',name:'鶏ささみ',   sub:'鶏肉',   price:900,  yield:0.90},
  {id:'M014',name:'鶏ミンチ',   sub:'鶏肉',   price:700,  yield:1.00},
  {id:'M015',name:'手羽先',     sub:'鶏肉',   price:700,  yield:0.70},
  {id:'M016',name:'手羽元',     sub:'鶏肉',   price:650,  yield:0.70},
  {id:'M017',name:'ベーコン',   sub:'加工肉', price:1400, yield:0.98},
  {id:'M018',name:'ハム',       sub:'加工肉', price:1200, yield:0.98},
  {id:'M019',name:'ウインナー', sub:'加工肉', price:1000, yield:0.98},
];

function seedMeats(){
  let added = 0, skipped = 0;
  MEAT_MASTER.forEach(v => {
    if(state.ingredients.some(i=>i.name===v.name)){ skipped++; return; }
    state.ingredients.push(makeIngredient({
      name: v.name,
      category: '肉',
      price_type: 'purchase',
      kg_price: v.price,
      memo: `[${v.id}] ${v.sub} / 歩留${Math.round(v.yield*100)}% / 業務用平均価格 / 部位により変動`,
    }));
    added++;
  });
  saveState();
  renderMaster(); renderHero();
  alert(`肉マスター: ${added}件 追加 / ${skipped}件 既存スキップ`);
}

// ============ 調味料マスター(32件) 一括取り込み ============
const SEASONING_MASTER = [
  {id:'S001',name:'食塩',             sub:'基本調味料', unit:'kg', price:120,  yield:1.00},
  {id:'S002',name:'上白糖',           sub:'甘味料',    unit:'kg', price:250,  yield:1.00},
  {id:'S003',name:'グラニュー糖',     sub:'甘味料',    unit:'kg', price:280,  yield:1.00},
  {id:'S004',name:'三温糖',           sub:'甘味料',    unit:'kg', price:300,  yield:1.00},
  {id:'S005',name:'濃口醤油',         sub:'和風調味料',unit:'L',  price:300,  yield:1.00},
  {id:'S006',name:'薄口醤油',         sub:'和風調味料',unit:'L',  price:320,  yield:1.00},
  {id:'S007',name:'みりん',           sub:'和風調味料',unit:'L',  price:400,  yield:1.00},
  {id:'S008',name:'料理酒',           sub:'和風調味料',unit:'L',  price:300,  yield:1.00},
  {id:'S009',name:'穀物酢',           sub:'基本調味料',unit:'L',  price:250,  yield:1.00},
  {id:'S010',name:'米酢',             sub:'基本調味料',unit:'L',  price:400,  yield:1.00},
  {id:'S011',name:'味噌(赤)',         sub:'発酵調味料',unit:'kg', price:500,  yield:0.98},
  {id:'S012',name:'味噌(白)',         sub:'発酵調味料',unit:'kg', price:550,  yield:0.98},
  {id:'S013',name:'味噌(合わせ)',     sub:'発酵調味料',unit:'kg', price:520,  yield:0.98},
  {id:'S014',name:'サラダ油',         sub:'油脂',      unit:'L',  price:300,  yield:1.00},
  {id:'S015',name:'ごま油',           sub:'油脂',      unit:'L',  price:800,  yield:1.00},
  {id:'S016',name:'オリーブオイル',   sub:'油脂',      unit:'L',  price:1200, yield:1.00},
  {id:'S017',name:'バター',           sub:'油脂',      unit:'kg', price:1200, yield:0.95},
  {id:'S018',name:'マーガリン',       sub:'油脂',      unit:'kg', price:600,  yield:0.95},
  {id:'S019',name:'マヨネーズ',       sub:'洋風調味料',unit:'kg', price:500,  yield:0.98},
  {id:'S020',name:'ケチャップ',       sub:'洋風調味料',unit:'kg', price:400,  yield:0.98},
  {id:'S021',name:'ウスターソース',   sub:'洋風調味料',unit:'L',  price:350,  yield:1.00},
  {id:'S022',name:'中濃ソース',       sub:'洋風調味料',unit:'L',  price:350,  yield:1.00},
  {id:'S023',name:'めんつゆ',         sub:'和風調味料',unit:'L',  price:400,  yield:1.00},
  {id:'S024',name:'白だし',           sub:'和風調味料',unit:'L',  price:500,  yield:1.00},
  {id:'S025',name:'鶏ガラスープの素', sub:'中華調味料',unit:'kg', price:1000, yield:1.00},
  {id:'S026',name:'コンソメ',         sub:'洋風調味料',unit:'kg', price:1200, yield:1.00},
  {id:'S027',name:'豆板醤',           sub:'中華調味料',unit:'kg', price:900,  yield:0.98},
  {id:'S028',name:'甜麺醤',           sub:'中華調味料',unit:'kg', price:900,  yield:0.98},
  {id:'S029',name:'コチュジャン',     sub:'中華調味料',unit:'kg', price:700,  yield:0.98},
  {id:'S030',name:'にんにくチューブ', sub:'その他',    unit:'kg', price:800,  yield:0.98},
  {id:'S031',name:'しょうがチューブ', sub:'その他',    unit:'kg', price:800,  yield:0.98},
  {id:'S032',name:'はちみつ',         sub:'甘味料',    unit:'kg', price:1200, yield:0.98},
];

function seedSeasonings(){
  let added = 0, skipped = 0;
  SEASONING_MASTER.forEach(v => {
    if(state.ingredients.some(i=>i.name===v.name)){ skipped++; return; }
    state.ingredients.push(makeIngredient({
      name: v.name,
      category: '調味料',
      price_type: 'purchase',
      kg_price: v.price,
      memo: `[${v.id}] ${v.sub} / 単位${v.unit} / 歩留${Math.round(v.yield*100)}% / 業務用平均価格`,
    }));
    added++;
  });
  saveState();
  renderMaster(); renderHero();
  alert(`調味料マスター: ${added}件 追加 / ${skipped}件 既存スキップ`);
}

function seedAll(){
  // まずマスタ投入(重複スキップ)
  SEED_INGREDIENTS.forEach(s => {
    if(!state.ingredients.some(i=>i.name===s.name)) state.ingredients.push(makeIngredient(s));
  });
  const byName = Object.fromEntries(state.ingredients.map(i=>[i.name,i]));
  // レシピ生成: 1人前 = 5個 (5×17=85g)
  const recipeItems = [
    {name:'地頭鶏(炭火焼)',     base:2650, yield_pct:100},
    {name:'豚ミンチ2mm',        base:3000, yield_pct:100},
    {name:'キャベツ',           base:4320, yield_pct:50},  // 塩水抜きで半分ロス
    {name:'玉ねぎ',             base:580,  yield_pct:50},
    {name:'ニラ',               base:180,  yield_pct:50},
    {name:'コンソメ(スープ用)', base:48,   yield_pct:100},
    {name:'水',                 base:3000, yield_pct:100},
    {name:'にんにく',           base:430,  yield_pct:100},
    {name:'しょうが',           base:144,  yield_pct:100},
    {name:'オイスターソース',   base:156,  yield_pct:100},
    {name:'醤油',               base:156,  yield_pct:100},
    {name:'味の素',             base:96,   yield_pct:100},
    {name:'コンソメ',           base:84,   yield_pct:100},
    {name:'ごま油',             base:84,   yield_pct:100},
    {name:'砂糖',               base:72,   yield_pct:100},
  ];
  const total_base = recipeItems.reduce((s,x)=>s+x.base,0); // 15000
  const per_serving_g = 5 * 17; // 85g
  const ratio = per_serving_g / total_base;
  const items = recipeItems.map(ri => {
    const ing = byName[ri.name];
    return makeItem({ingredient_id: ing?.id || null, grams: +(ri.base*ratio).toFixed(3), yield_pct: ri.yield_pct});
  });
  const skin = byName['餃子の皮 10cm'];
  const salt = byName['塩(水抜き用)'];
  if(skin) items.push(makeItem({ingredient_id: skin.id, grams: 50, yield_pct: 100}));
  if(salt) items.push(makeItem({ingredient_id: salt.id, grams: 1.15, yield_pct: 100}));
  const recipe = makeRecipe({
    name:'炭火焼鶏餃子',
    category:'餃子',
    per_serving_desc:'5個',
    items,
  });
  state.recipes.push(recipe);
  saveState();
  renderHero(); renderMaster(); renderRecipeList();
  alert('炭火焼鶏餃子 一式を追加しました');
}

// ============ 起動 ============
function init(){
  loadState();
  renderHero();
  renderRecipeList();
  calcScrap(); calcDewater(); calcEmulsion();
  if('serviceWorker' in navigator){
    navigator.serviceWorker.register('sw.js').catch(()=>{});
  }
}
document.addEventListener('DOMContentLoaded', init);
