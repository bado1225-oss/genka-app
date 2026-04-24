/* 原価計算アプリ v2.0 - main.js
   食材マスタ(価格台帳) + レシピ(1人前あたり使用g) の2層構造
*/

const LS_KEY = 'genka_v2';
const SCHEMA_VERSION = 3;
const PRICE_TYPES = {
  market:   { label: '市場価格',   short: '市', color: '#3f8a5a', bg: '#e8f2ec' },
  purchase: { label: '仕入れ価格', short: '仕', color: '#3a6ba0', bg: '#e6eef7' },
  spot:     { label: '都度入力',   short: '都', color: '#c67b1d', bg: '#faefda' },
  fixed:    { label: '固定価格',   short: '固', color: '#6b4fa0', bg: '#eee8f5' },
};
const INGREDIENT_CATS = ['肉','魚','野菜','調味料','皮','その他'];
const UNITS = ['kg','L','個','枚','本','袋'];
const STALE_DAYS = 30; // 価格未更新の日数閾値

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
  // 食材マスタの v3 フィールド補完
  state.ingredients.forEach(i => {
    if(i.standard_price === undefined) i.standard_price = num(i.kg_price, 0);
    if(i.actual_purchase_price === undefined) i.actual_purchase_price = i.standard_price;
    if(i.unit === undefined) i.unit = 'kg';
    if(i.yield_rate === undefined) i.yield_rate = 1.0;
    if(i.loss_rate === undefined) i.loss_rate = 0;
    if(i.supplier_name === undefined) i.supplier_name = '';
    if(i.last_updated === undefined) i.last_updated = i.updated_at || new Date().toISOString();
    if(i.is_variable_price === undefined) i.is_variable_price = (i.price_type === 'spot');
    if(!Array.isArray(i.price_history)) i.price_history = [];
    // kg_price ↔ actual_purchase_price 同期(後方互換)
    if(num(i.actual_purchase_price,0) === 0 && num(i.kg_price,0) > 0){
      i.actual_purchase_price = num(i.kg_price);
    }
    if(num(i.standard_price,0) === 0 && num(i.kg_price,0) > 0){
      i.standard_price = num(i.kg_price);
    }
  });
  // v4 レシピ簡素化: per_serving_desc → servings/notes, target_cost_ratio → target_food_cost_rate
  state.recipes.forEach(r => {
    if(r.selling_price === undefined) r.selling_price = 0;
    // servings: per_serving_desc "5個" 等から抽出試行、なければ 1
    if(r.servings === undefined){
      const pieces = parsePiecesFromDesc(r.per_serving_desc);
      r.servings = 1; // デフォルト 1人前/皿
      if(pieces && !r.notes){
        r.notes = r.per_serving_desc || '';
      }
    }
    if(r.target_food_cost_rate === undefined){
      r.target_food_cost_rate = num(r.target_cost_ratio, 30);
    }
    if(r.notes === undefined) r.notes = r.per_serving_desc || '';
    if(r.category === undefined) r.category = '';
    // 旧フィールドは保持しない(消去)
    delete r.per_serving_desc;
    delete r.target_cost_ratio;
    delete r.target_margin;
    delete r.piece_weight_g;
    delete r.skin_weight_per_piece;
    delete r.labor_prep_cost;
    delete r.labor_cook_cost;
    delete r.utility_cost;
    delete r.other_cost;
    delete r.oil_cost_per_plate;
    delete r.sauce_cost_per_plate;
    // items: grams → quantity, unit 追加、yield_pct/price_override は保持(UI非表示)
    (r.items||[]).forEach(it => {
      if(it.quantity === undefined){
        it.quantity = num(it.grams, 0);
      }
      if(it.unit === undefined) it.unit = 'g';
      delete it.grams;
    });
  });
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
      // selected_category を導出
      if(it.selected_category === undefined){
        const ing = getIngredient(it.ingredient_id);
        it.selected_category = ing ? ing.category : null;
      }
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
  const now = new Date().toISOString();
  return Object.assign({
    id: uid('ing'),
    name: '',
    category: '調味料',
    price_type: 'purchase',
    kg_price: 0,               // 後方互換: standard_price と連動
    // v3 拡張フィールド
    supplier_name: '',         // 仕入先名
    standard_price: 0,         // 基準価格(マスタ定価)
    actual_purchase_price: 0,  // 実仕入価格(ユーザー実績)
    unit: 'kg',                // 購入単位
    yield_rate: 1.0,           // 標準歩留まり(0-1)
    loss_rate: 0,              // 標準ロス率(0-1) 搬送・保管ロス
    last_updated: now,         // 価格最終更新日時
    memo: '',
    is_variable_price: false,  // true=変動大・都度確認必要
    price_history: [],         // [{date,from,to,supplier,memo}]
    updated_at: now,
  }, init||{});
}
function makeRecipe(init){
  return Object.assign({
    id: uid('rec'),
    name: '新規レシピ',
    category: '',                   // 任意(和食/中華/麺類等)
    servings: 1,                    // 何人前/1皿(sharing dishで>1)
    selling_price: 0,               // 店内販売価格(1皿)
    target_food_cost_rate: 30,      // 目標原価率(%)
    notes: '',                      // フリーメモ
    items: [],
    updated_at: new Date().toISOString(),
  }, init||{});
}
function makeItem(init){
  const base = {
    id: uid('it'),
    ingredient_id: null,
    quantity: 0,             // 使用量 (unit に応じた数値)
    unit: 'g',               // g / ml / 個
    selected_category: null, // UI: カテゴリ選択状態(食材選択時に自動セット)
  };
  const obj = Object.assign(base, init||{});
  if(obj.ingredient_id && !obj.selected_category){
    const ing = getIngredient(obj.ingredient_id);
    if(ing) obj.selected_category = ing.category;
  }
  return obj;
}

function getIngredient(id){return state.ingredients.find(i=>i.id===id);}
function getRecipe(id){return state.recipes.find(r=>r.id===id);}
function getCurrent(){return getRecipe(state.currentRecipeId);}

// ============ 計算エンジン ============
function effectivePrice(item){
  const ing = getIngredient(item.ingredient_id);
  if(!ing) return null;
  if(item.price_override != null && item.price_override !== '') return num(item.price_override);
  // 実仕入価格 > 基準価格 > 旧kg_price の順にフォールバック
  if(num(ing.actual_purchase_price,0) > 0) return num(ing.actual_purchase_price);
  if(num(ing.standard_price,0) > 0) return num(ing.standard_price);
  return num(ing.kg_price);
}
function hasPriceOverride(item){
  return item.price_override != null && item.price_override !== '';
}

function parsePiecesFromDesc(desc){
  // "5個" "10個入り" "3ピース" 等から個数を抽出
  if(!desc) return null;
  const m = String(desc).match(/(\d+(?:\.\d+)?)\s*(個|ピース|枚|粒)/);
  return m ? parseFloat(m[1]) : null;
}

function calcRecipe(r){
  if(!r) return null;
  const items = r.items || [];
  const rows = items.map(it => {
    const ing = getIngredient(it.ingredient_id);
    const price = effectivePrice(it); // kg単価 (円/kg 想定)
    const qty = num(it.quantity, 0);
    const unit = it.unit || 'g';
    const yp = num(it.yield_pct, 100);
    const yield_rate = yp > 0 ? yp/100 : 1;
    const raw_qty = qty / yield_rate;
    const has_price = price != null && ing;
    // unit に応じた原価: g/ml は kg単価/1000, 個 は kg単価=個単価 として扱う
    const unitPrice = (unit === '個' || unit === '枚' || unit === '本') ? num(price) : num(price)/1000;
    const cost = has_price ? raw_qty * unitPrice : 0;
    return { item: it, ingredient: ing, price, qty, unit, raw_qty, yield_pct: yp, cost, has_price };
  });
  const ing_cost = rows.reduce((s,x)=>s+x.cost, 0);
  const total_qty = rows.reduce((s,x)=>s + (x.unit==='個'||x.unit==='枚'||x.unit==='本'?0:x.qty), 0);
  const raw_total = rows.reduce((s,x)=>s + (x.unit==='個'||x.unit==='枚'||x.unit==='本'?0:x.raw_qty), 0);
  rows.forEach(x => {
    x.cost_ratio_of_total = ing_cost > 0 ? x.cost / ing_cost : 0;
  });
  const servings = Math.max(1, num(r.servings, 1));
  const per_plate_cost = ing_cost;            // 1皿原価(材料のみ)
  const per_serving_cost = ing_cost / servings; // 1人前原価
  const selling = num(r.selling_price, 0);
  const target_rate = num(r.target_food_cost_rate, 30) / 100;
  const cost_ratio = selling > 0 ? per_plate_cost / selling : 0;
  const margin = selling - per_plate_cost;
  const margin_ratio = selling > 0 ? margin / selling : 0;
  const suggested_price = target_rate > 0 ? per_plate_cost / target_rate : 0;
  const over_target = selling > 0 && cost_ratio > target_rate;
  return {
    rows, ing_cost, total_qty, raw_total,
    servings, per_plate_cost, per_serving_cost,
    selling, cost_ratio, margin, margin_ratio,
    suggested_price, target_rate, over_target,
  };
}

// 原価率の絶対色分け (≤30 緑 / 30-35 黄 / >35 赤)
function costRateClass(cost_ratio){
  const p = cost_ratio * 100;
  if(p <= 30) return 'cr-low';
  if(p <= 35) return 'cr-mid';
  return 'cr-high';
}

// ============ タブ制御 ============
function showTab(tab){
  const tabs = ['recipes','master','settings'];
  tabs.forEach(t => {
    const seg = document.getElementById('seg-'+t);
    if(seg) seg.classList.toggle('active', t===tab);
    const view = document.getElementById('view-'+t);
    if(view) view.style.display = t===tab ? '' : 'none';
  });
  if(tab==='recipes'){ backToList(); }
  if(tab==='master'){ renderMaster(); }
  renderHero();
}

function renderHero(){
  const recipes = state.recipes.length;
  const ings = state.ingredients.length;
  const calcs = state.recipes.map(r=>({r, c:calcRecipe(r)})).filter(x=>x.c);
  const withSelling = calcs.filter(x=>x.c.selling>0);
  const avgCR = withSelling.length ? withSelling.reduce((s,x)=>s+x.c.cost_ratio,0)/withSelling.length : 0;
  // 原価率が35%超(赤)のメニュー (色分け基準に合わせる)
  const highCR = withSelling.filter(x => x.c.cost_ratio*100 > 35);
  const top5CR = [...withSelling].sort((a,b)=>b.c.cost_ratio-a.c.cost_ratio).slice(0,5);
  const top5MarginHigh = [...withSelling].sort((a,b)=>b.c.margin-a.c.margin).slice(0,5);
  const top5MarginLow = [...withSelling].sort((a,b)=>a.c.margin-b.c.margin).slice(0,5);
  // よく使う食材TOP10
  const usageCount = {};
  state.recipes.forEach(r => (r.items||[]).forEach(it => {
    if(it.ingredient_id) usageCount[it.ingredient_id] = (usageCount[it.ingredient_id]||0) + 1;
  }));
  const top10Usage = Object.entries(usageCount)
    .sort((a,b) => b[1]-a[1]).slice(0,10)
    .map(([id,count]) => ({ing: getIngredient(id), count}))
    .filter(x => x.ing);
  const staleThreshold = Date.now() - STALE_DAYS*24*3600*1000;
  const stale = state.ingredients.filter(i => {
    const t = Date.parse(i.last_updated || i.updated_at || 0);
    return isFinite(t) && t < staleThreshold;
  });

  document.getElementById('dashboard-kpis').innerHTML = `
    <div class="kpi"><div class="kpi-label">登録メニュー</div><div class="kpi-value">${recipes}</div></div>
    <div class="kpi"><div class="kpi-label">食材マスタ</div><div class="kpi-value">${ings}</div></div>
    <div class="kpi"><div class="kpi-label">平均原価率</div><div class="kpi-value ${avgCR>0.35?'warn':'accent'}">${withSelling.length?fmt(avgCR*100,1)+'%':'–'}</div></div>
    <div class="kpi"><div class="kpi-label">要改善(35%超)</div><div class="kpi-value ${highCR.length?'warn':''}">${highCR.length}</div></div>
    <div class="kpi"><div class="kpi-label">価格更新必要</div><div class="kpi-value ${stale.length?'warn':''}">${stale.length}</div></div>
  `;
  const extraWrap = document.getElementById('dashboard-extra');
  if(extraWrap){
    const highCRBlock = highCR.length ? `<div class="dash-block">
      <div class="dash-block-title">⚠ 原価率35%超のメニュー (${highCR.length})</div>
      <ul class="dash-list">${highCR.slice(0,8).map(x=>`<li><a onclick="openRecipe('${x.r.id}')">${esc(x.r.name)}</a><span class="dash-val warn">${fmt(x.c.cost_ratio*100,1)}%</span></li>`).join('')}${highCR.length>8?`<li class="muted">他 ${highCR.length-8}件</li>`:''}</ul>
    </div>` : '';
    const marginHighBlock = top5MarginHigh.length ? `<div class="dash-block">
      <div class="dash-block-title">💰 粗利額が高いメニュー TOP5</div>
      <ol class="dash-list">${top5MarginHigh.map(x=>`<li><a onclick="openRecipe('${x.r.id}')">${esc(x.r.name)}</a><span class="dash-val accent">¥${fmt(x.c.margin,0)}</span></li>`).join('')}</ol>
    </div>` : '';
    const marginLowBlock = top5MarginLow.length ? `<div class="dash-block">
      <div class="dash-block-title">📉 粗利額が低いメニュー TOP5</div>
      <ol class="dash-list">${top5MarginLow.map(x=>`<li><a onclick="openRecipe('${x.r.id}')">${esc(x.r.name)}</a><span class="dash-val ${x.c.margin<0?'warn':'muted'}">¥${fmt(x.c.margin,0)}</span></li>`).join('')}</ol>
    </div>` : '';
    const usageBlock = top10Usage.length ? `<div class="dash-block">
      <div class="dash-block-title">📋 よく使う食材 TOP10</div>
      <ol class="dash-list">${top10Usage.map(x=>`<li><a onclick="openIngModal('${x.ing.id}')">${esc(x.ing.name)}</a><span class="dash-val muted">${x.count}件</span></li>`).join('')}</ol>
    </div>` : '';
    const staleBlock = stale.length ? `<div class="dash-block">
      <div class="dash-block-title">⏰ 価格更新が必要な食材 (${STALE_DAYS}日以上)</div>
      <ul class="dash-list">${stale.slice(0,8).map(i=>`<li><a onclick="openIngModal('${i.id}')">${esc(i.name)}</a><span class="dash-val muted">${daysAgo(i.last_updated)}日前</span></li>`).join('')}${stale.length>8?`<li class="muted">他 ${stale.length-8}件</li>`:''}</ul>
    </div>` : '';
    extraWrap.innerHTML = highCRBlock + marginHighBlock + marginLowBlock + usageBlock + staleBlock;
  }
  document.getElementById('hero-stamp').textContent = recipes ? `${recipes}メニュー / ${ings}食材 / ${nowStamp()}` : 'データ未登録';
}

function daysAgo(iso){
  const t = Date.parse(iso||0);
  if(!isFinite(t)) return '?';
  return Math.max(0, Math.floor((Date.now()-t)/(24*3600*1000)));
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
    const crClass = c.selling>0 ? costRateClass(c.cost_ratio) : '';
    const crBadge = c.selling>0
      ? `<div class="rc-cr-badge ${crClass}">${fmt(c.cost_ratio*100,1)}%</div>`
      : '<div class="rc-cr-badge muted">–</div>';
    const marginInfo = c.selling>0
      ? `<div>粗利 <b>¥${fmt(c.margin,0)}</b></div>`
      : '';
    return `<div class="recipe-card${sel}${c.over_target?' over-target':''}" onclick="openRecipe('${r.id}')" oncontextmenu="selectInList(event,'${r.id}')">
      <div class="rc-top-row">
        <div class="rc-cat">${esc(r.category||'-')}</div>
        ${crBadge}
      </div>
      <div class="rc-name">${esc(r.name||'(無題)')}</div>
      <div class="rc-stats">
        <div>材料 <b>${r.items.length}</b></div>
        <div>1皿 <b>¥${fmt(c.per_plate_cost,0)}</b></div>
        ${marginInfo}
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
  showTab('recipes');
  state.currentRecipeId = id;
  document.getElementById('recipe-list-pane').style.display = 'none';
  document.getElementById('recipe-edit-pane').style.display = '';
  document.getElementById('edit-name').value = r.name;
  document.getElementById('edit-category').value = r.category || '';
  document.getElementById('edit-servings').value = num(r.servings, 1);
  document.getElementById('edit-notes').value = r.notes || '';
  document.getElementById('edit-selling-price').value = num(r.selling_price, 0);
  document.getElementById('edit-target-cr').value = num(r.target_food_cost_rate, 30);
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
  r.category = document.getElementById('edit-category').value || '';
  r.servings = Math.max(1, num(document.getElementById('edit-servings').value, 1));
  r.notes = document.getElementById('edit-notes').value || '';
  r.selling_price = num(document.getElementById('edit-selling-price').value, 0);
  r.target_food_cost_rate = num(document.getElementById('edit-target-cr').value, 30);
}

function buildIngredientOptionsFiltered(category){
  if(!category) return '';
  const list = state.ingredients
    .filter(i => i.category === category)
    .sort((a,b) => (a.name||'').localeCompare(b.name||'','ja'));
  return list.map(i => `<option value="${i.id}">${esc(i.name)}</option>`).join('');
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
  const category = it.selected_category || (ing ? ing.category : '');
  const catOpts = INGREDIENT_CATS.map(c => `<option value="${c}"${category===c?' selected':''}>${c}</option>`).join('');
  const ingOpts = buildIngredientOptionsFiltered(category);
  const ingOptsWithSelected = it.ingredient_id
    ? ingOpts.replace(`value="${it.ingredient_id}"`, `value="${it.ingredient_id}" selected`)
    : ingOpts;
  const price = effectivePrice(it);
  const qty = num(it.quantity, 0);
  const unit = it.unit || 'g';
  const yp = num(it.yield_pct, 100);
  const yield_rate = yp > 0 ? yp/100 : 1;
  const raw_qty = qty / yield_rate;
  const unitPrice = (unit === '個' || unit === '枚' || unit === '本') ? num(price) : num(price)/1000;
  const cost = (price!=null && ing) ? (raw_qty * unitPrice) : 0;
  const unitOpts = ['g','ml','個','枚','本'].map(u => `<option value="${u}"${unit===u?' selected':''}>${u}</option>`).join('');
  const priceInfo = ing ? priceInfoHtml(ing) : '<span class="muted">未選択</span>';
  return `<div class="item-card" data-id="${it.id}">
    <div class="item-row-main">
      <div class="item-selects-wrap">
        <select class="item-cat-select" onchange="updateItem('${it.id}','selected_category',this.value)">
          <option value="">カテゴリ</option>
          ${catOpts}
        </select>
        <select class="item-ing-select" onchange="updateItem('${it.id}','ingredient_id',this.value)" ${!category?'disabled':''}>
          <option value="">${category?'(食材を選択)':'(先にカテゴリを選択)'}</option>
          ${ingOptsWithSelected}
        </select>
      </div>
      <button class="icon-del" onclick="removeItem('${it.id}')" title="削除">🗑</button>
    </div>
    <div class="item-row-fields">
      <label class="inline-field qty">
        <span>使用量</span>
        <input type="number" step="0.1" value="${qty}" onchange="updateItem('${it.id}','quantity',this.value)">
      </label>
      <label class="inline-field unit">
        <span>単位</span>
        <select onchange="updateItem('${it.id}','unit',this.value)">${unitOpts}</select>
      </label>
    </div>
    <div class="item-row-info">
      ${priceInfo}
      <span class="item-cost">原価 <b>¥${fmt(cost,2)}</b></span>
    </div>
  </div>`;
}

function priceInfoHtml(ing){
  const t = PRICE_TYPES[ing.price_type]||{};
  const master = num(ing.kg_price);
  const u = ing.unit || 'kg';
  return `<span class="price-badge" style="background:${t.bg};color:${t.color}">${t.short||''}</span> ¥${fmt(master,0)}/${u}`;
}

function updateItem(id, key, value){
  const r = getCurrent(); if(!r) return;
  const it = r.items.find(x=>x.id===id); if(!it) return;
  if(key==='ingredient_id'){
    it.ingredient_id = value || null;
    const ing = getIngredient(value);
    if(ing){
      it.selected_category = ing.category;
      // 食材の基準単位に応じて unit をデフォルト
      if(ing.unit === 'kg' || ing.unit === 'L' || !ing.unit) it.unit = it.unit || 'g';
      else it.unit = ing.unit;
    }
  } else if(key==='selected_category'){
    it.selected_category = value || null;
    const ing = getIngredient(it.ingredient_id);
    if(ing && ing.category !== it.selected_category){
      it.ingredient_id = null;
    }
  } else if(key==='quantity'){
    it.quantity = value==='' ? 0 : num(value);
  } else if(key==='unit'){
    it.unit = value || 'g';
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
  renderBigKPI(r, c);
  renderCostDetail(r, c);
}

function renderBigKPI(r, c){
  const crClass = c.selling>0 ? costRateClass(c.cost_ratio) : 'muted';
  const setText = (id, v, cls) => { const el=document.getElementById(id); if(el){ el.textContent = v; if(cls!==undefined) el.className = cls; } };
  // プロミネント 3大指標
  const plateBig = document.getElementById('plate-cost-big');
  if(plateBig){ plateBig.textContent = '¥'+fmt(c.per_plate_cost,0); plateBig.className = 'big-metric '+crClass; }
  const crBig = document.getElementById('cr-big');
  if(crBig){ crBig.textContent = c.selling>0 ? fmt(c.cost_ratio*100,1)+'%' : '–'; crBig.className = 'big-metric '+crClass; }
  const marginBig = document.getElementById('margin-big');
  if(marginBig){ marginBig.textContent = c.selling>0 ? '¥'+fmt(c.margin,0) : '–'; marginBig.className = 'big-metric '+(c.selling<=0?'muted':(c.margin<0?'cr-high':'accent')); }
  // サブ: 1人前原価
  setText('sub-per-serving', '¥'+fmt(c.per_serving_cost,1));
  setText('sub-servings', fmt(c.servings,0));
  setText('sub-margin-ratio', c.selling>0 ? fmt(c.margin_ratio*100,1)+'%' : '–');
  setText('sub-selling', c.selling>0?'¥'+fmt(c.selling,0):'未設定');
  setText('sub-suggested', c.suggested_price>0?'¥'+fmt(c.suggested_price,0):'–');
  const warnEl = document.getElementById('sim-warning');
  if(warnEl){
    if(c.over_target){
      warnEl.style.display = '';
      warnEl.textContent = `⚠ 原価率が目標(${fmt(c.target_rate*100,1)}%)を超えています。推奨販売価格: ¥${fmt(c.suggested_price,0)}`;
    } else {
      warnEl.style.display = 'none';
    }
  }
}

// 原価詳細: 材料別原価・構成比
function renderCostDetail(r, c){
  const wrap = document.getElementById('cost-detail-tbody');
  if(!wrap) return;
  if(!c.rows.length){
    wrap.innerHTML = '<tr><td colspan="5" class="muted" style="text-align:center">材料がありません</td></tr>';
  } else {
    wrap.innerHTML = c.rows.map(x => {
      const name = x.ingredient ? esc(x.ingredient.name) : '<span class="muted">(未選択)</span>';
      return `<tr>
        <td style="text-align:left">${name}</td>
        <td>${fmt(x.qty,1)} ${esc(x.unit||'g')}</td>
        <td>${fmt(x.raw_qty,1)}</td>
        <td>¥${fmt(x.cost,2)}</td>
        <td>${fmt(x.cost_ratio_of_total*100,1)}%</td>
      </tr>`;
    }).join('');
  }
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
  const actual = num(i.actual_purchase_price, i.kg_price||0);
  const std = num(i.standard_price, i.kg_price||0);
  const priceText = (actual !== std && std>0)
    ? `<span class="ing-price">¥${fmt(actual,0)}/${i.unit||'kg'}</span><span class="muted-sub">(基準¥${fmt(std,0)})</span>`
    : `<span class="ing-price">¥${fmt(actual||std,0)}/${i.unit||'kg'}</span>`;
  const days = daysAgo(i.last_updated);
  const stale = (typeof days==='number' && days >= STALE_DAYS);
  const variable = i.is_variable_price ? '<span class="variable-tag">変動大</span>' : '';
  const supplier = i.supplier_name ? `<span class="ing-supplier">📦 ${esc(i.supplier_name)}</span>` : '';
  return `<div class="ing-row${stale?' stale':''}">
    <div class="ing-row-main">
      <span class="price-badge" style="background:${t.bg};color:${t.color}">${t.short||''}</span>
      <span class="ing-name">${esc(i.name)}</span>
      ${variable}
    </div>
    <div class="ing-row-meta">
      ${priceText}
      ${supplier}
      ${i.memo?`<span class="ing-memo">${esc(i.memo)}</span>`:''}
      <span class="ing-updated${stale?' warn':''}">${isFinite(days)?days+'日前':'–'}</span>
      ${used>0?`<span class="ing-used">使用中 ${used}件</span>`:'<span class="ing-unused">未使用</span>'}
    </div>
    <div class="ing-row-actions">
      <button class="ghost-btn small" onclick="openIngModal('${i.id}')">編集</button>
      <button class="danger-btn small" onclick="deleteIngredient('${i.id}')">削除</button>
    </div>
  </div>`;
}

function fillIngModal(i){
  document.getElementById('ing-name').value = i?.name || '';
  document.getElementById('ing-category').value = i?.category || '野菜';
  document.getElementById('ing-type').value = i?.price_type || 'market';
  document.getElementById('ing-supplier').value = i?.supplier_name || '';
  document.getElementById('ing-unit').value = i?.unit || 'kg';
  document.getElementById('ing-standard').value = i?.standard_price ?? (i?.kg_price ?? '');
  document.getElementById('ing-actual').value = i?.actual_purchase_price ?? (i?.kg_price ?? '');
  document.getElementById('ing-yield').value = i ? Math.round((i.yield_rate ?? 1)*1000)/10 : 100;
  document.getElementById('ing-loss').value = i ? Math.round((i.loss_rate ?? 0)*1000)/10 : 0;
  document.getElementById('ing-variable').checked = !!(i?.is_variable_price);
  document.getElementById('ing-memo').value = i?.memo || '';
  document.getElementById('ing-last-updated').textContent = i?.last_updated ? new Date(i.last_updated).toLocaleString('ja-JP') : '(新規)';
  renderPriceHistory(i);
}

function renderPriceHistory(i){
  const wrap = document.getElementById('ing-history-list');
  if(!wrap) return;
  const hist = (i?.price_history||[]).slice().reverse();
  if(!hist.length){
    wrap.innerHTML = '<div class="muted small">価格変更履歴はまだありません</div>';
    return;
  }
  wrap.innerHTML = hist.slice(0,10).map(h => `<div class="history-row">
    <span class="hist-date">${esc(new Date(h.date).toLocaleDateString('ja-JP'))}</span>
    <span class="hist-change">¥${fmt(h.from,0)} → <b>¥${fmt(h.to,0)}</b></span>
    ${h.supplier?`<span class="hist-supplier">${esc(h.supplier)}</span>`:''}
    ${h.memo?`<span class="hist-memo">${esc(h.memo)}</span>`:''}
  </div>`).join('');
}

function addIngredient(){
  state.ingModalMode = 'add';
  state.ingModalId = null;
  document.getElementById('ing-modal-title').textContent = '食材を追加';
  fillIngModal(null);
  document.getElementById('ing-modal').style.display = 'flex';
  setTimeout(()=>document.getElementById('ing-name').focus(), 50);
}

function openIngModal(id){
  const i = getIngredient(id); if(!i) return;
  state.ingModalMode = 'edit';
  state.ingModalId = id;
  showTab('master');
  document.getElementById('ing-modal-title').textContent = '食材を編集';
  fillIngModal(i);
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
  const now = new Date().toISOString();
  const data = {
    name,
    category: document.getElementById('ing-category').value,
    price_type: document.getElementById('ing-type').value,
    supplier_name: document.getElementById('ing-supplier').value.trim(),
    unit: document.getElementById('ing-unit').value,
    standard_price: num(document.getElementById('ing-standard').value, 0),
    actual_purchase_price: num(document.getElementById('ing-actual').value, 0),
    yield_rate: Math.max(0, Math.min(1, num(document.getElementById('ing-yield').value, 100)/100)),
    loss_rate: Math.max(0, Math.min(1, num(document.getElementById('ing-loss').value, 0)/100)),
    is_variable_price: !!document.getElementById('ing-variable').checked,
    memo: document.getElementById('ing-memo').value.trim(),
    updated_at: now,
  };
  // 後方互換: kg_price も同期
  data.kg_price = data.actual_purchase_price || data.standard_price;

  if(state.ingModalMode==='edit' && state.ingModalId){
    const i = getIngredient(state.ingModalId);
    if(i){
      const oldActual = num(i.actual_purchase_price, i.kg_price);
      const newActual = data.actual_purchase_price;
      if(oldActual !== newActual && oldActual > 0){
        // #4 価格履歴に記録
        i.price_history = i.price_history || [];
        i.price_history.push({
          date: now,
          from: oldActual,
          to: newActual,
          supplier: data.supplier_name,
          memo: data.memo,
        });
        data.last_updated = now;
      } else if(!i.last_updated){
        data.last_updated = i.updated_at || now;
      } else {
        data.last_updated = i.last_updated;
      }
      Object.assign(i, data);
    }
  } else {
    data.last_updated = now;
    state.ingredients.push(makeIngredient(data));
  }
  saveState();
  closeIngModal();
  renderMaster();
  renderHero();
  if(getCurrent()){
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

// ============ 設定 ============
function downloadBlob(blob, filename){
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

function csvCell(v){
  if(v==null) return '';
  const s = String(v);
  return /[,"\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
}
function csvLine(arr){ return arr.map(csvCell).join(','); }

function exportAll(){
  const data = {version:SCHEMA_VERSION,ingredients:state.ingredients,recipes:state.recipes,exported_at:new Date().toISOString()};
  const blob = new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
  downloadBlob(blob, `genka-${new Date().toISOString().slice(0,10)}.json`);
}

function exportIngredientsCSV(){
  const header = ['id','name','category','price_type','supplier_name','unit','standard_price','actual_purchase_price','yield_rate','loss_rate','is_variable_price','last_updated','memo'];
  const lines = [csvLine(header)];
  state.ingredients.forEach(i => {
    lines.push(csvLine([
      i.id, i.name, i.category, i.price_type, i.supplier_name||'',
      i.unit||'kg',
      num(i.standard_price, i.kg_price||0).toFixed(3),
      num(i.actual_purchase_price, i.kg_price||0).toFixed(3),
      num(i.yield_rate,1).toFixed(3),
      num(i.loss_rate,0).toFixed(3),
      i.is_variable_price ? 'true':'false',
      i.last_updated||'',
      i.memo||'',
    ]));
  });
  const blob = new Blob(['\uFEFF'+lines.join('\n')], {type:'text/csv;charset=utf-8'});
  downloadBlob(blob, `ingredients-${new Date().toISOString().slice(0,10)}.csv`);
}

function exportRecipesCSV(){
  const header = ['recipe_id','recipe_name','category','servings','selling_price','target_food_cost_rate','notes','item_id','ingredient_name','quantity','unit'];
  const lines = [csvLine(header)];
  state.recipes.forEach(r => {
    if(!r.items.length){
      lines.push(csvLine([r.id,r.name,r.category||'',num(r.servings,1),num(r.selling_price,0),num(r.target_food_cost_rate,30),r.notes||'','','','','']));
      return;
    }
    r.items.forEach(it => {
      const ing = getIngredient(it.ingredient_id);
      lines.push(csvLine([
        r.id, r.name, r.category||'', num(r.servings,1),
        num(r.selling_price,0), num(r.target_food_cost_rate,30), r.notes||'',
        it.id, ing?ing.name:'', num(it.quantity,0).toFixed(3), it.unit||'g',
      ]));
    });
  });
  const blob = new Blob(['\uFEFF'+lines.join('\n')], {type:'text/csv;charset=utf-8'});
  downloadBlob(blob, `recipes-${new Date().toISOString().slice(0,10)}.csv`);
}

function exportCostResultsCSV(){
  const header = ['recipe_id','recipe_name','category','servings','per_plate_cost','per_serving_cost','selling_price','cost_ratio_pct','margin','margin_ratio_pct','suggested_price','target_rate_pct','over_target'];
  const lines = [csvLine(header)];
  state.recipes.forEach(r => {
    const c = calcRecipe(r);
    lines.push(csvLine([
      r.id, r.name, r.category||'', num(c.servings,1),
      num(c.per_plate_cost,0).toFixed(2),
      num(c.per_serving_cost,0).toFixed(2),
      num(c.selling,0),
      num(c.cost_ratio*100,0).toFixed(1),
      num(c.margin,0).toFixed(2),
      num(c.margin_ratio*100,0).toFixed(1),
      num(c.suggested_price,0).toFixed(0),
      num(c.target_rate*100,0).toFixed(1),
      c.over_target?'true':'false',
    ]));
  });
  const blob = new Blob(['\uFEFF'+lines.join('\n')], {type:'text/csv;charset=utf-8'});
  downloadBlob(blob, `cost-results-${new Date().toISOString().slice(0,10)}.csv`);
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
      // 重複チェック: 食材名/レシピ名で突合
      const existingIngNames = new Set(state.ingredients.map(i=>i.name));
      const existingRecNames = new Set(state.recipes.map(r=>r.name));
      const dupIngs = ings.filter(i=>existingIngNames.has(i.name));
      const dupRecs = recs.filter(r=>existingRecNames.has(r.name));
      const preview = [
        `📥 読み込みプレビュー`,
        ``,
        `食材: ${ings.length}件 (重複 ${dupIngs.length}件)`,
        dupIngs.length ? ` 重複例: ${dupIngs.slice(0,3).map(i=>i.name).join(', ')}${dupIngs.length>3?' ...':''}` : '',
        `レシピ: ${recs.length}件 (重複 ${dupRecs.length}件)`,
        dupRecs.length ? ` 重複例: ${dupRecs.slice(0,3).map(r=>r.name).join(', ')}${dupRecs.length>3?' ...':''}` : '',
        ``,
        `OK = 既存に追加 (重複はスキップ)`,
        `キャンセル = 全て上書き(既存データは削除)`,
      ].filter(Boolean).join('\n');
      const addMode = confirm(preview);
      if(addMode){
        // 重複スキップで追加
        let addI=0, addR=0;
        ings.forEach(i => {
          if(!existingIngNames.has(i.name)){ state.ingredients.push(i); addI++; }
        });
        recs.forEach(r => {
          if(!existingRecNames.has(r.name)){ state.recipes.push(r); addR++; }
        });
        migrateLegacy();
        saveState();
        renderHero(); renderMaster(); renderRecipeList();
        alert(`読み込み完了\n食材: ${addI}件追加 (${ings.length-addI}件スキップ)\nレシピ: ${addR}件追加 (${recs.length-addR}件スキップ)`);
      } else {
        if(!confirm('⚠ 既存データを全て削除して上書きします。本当によろしいですか？')){ return; }
        state.ingredients = ings;
        state.recipes = recs;
        migrateLegacy();
        saveState();
        renderHero(); renderMaster(); renderRecipeList();
        alert(`上書き完了\n食材: ${ings.length}件 / レシピ: ${recs.length}件`);
      }
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
    return makeItem({ingredient_id: ing?.id || null, quantity: +(ri.base*ratio).toFixed(3), unit: 'g', yield_pct: ri.yield_pct});
  });
  const skin = byName['餃子の皮 10cm'];
  const salt = byName['塩(水抜き用)'];
  if(skin) items.push(makeItem({ingredient_id: skin.id, quantity: 50, unit: 'g'}));
  if(salt) items.push(makeItem({ingredient_id: salt.id, quantity: 1.15, unit: 'g'}));
  const recipe = makeRecipe({
    name:'炭火焼鶏餃子',
    category:'中華',
    servings: 1,
    notes:'5個入り',
    selling_price: 500,
    target_food_cost_rate: 30,
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
  if('serviceWorker' in navigator){
    navigator.serviceWorker.register('sw.js').catch(()=>{});
  }
}
document.addEventListener('DOMContentLoaded', init);
