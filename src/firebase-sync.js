/* Firebase 同期モジュール (genka-app v4)
   - Auth: Google サインイン
   - Firestore: users/{uid}/data/main ドキュメントに ingredients/recipes を保存
   - 同期方針: 最終更新タイムスタンプで比較、Firestore onSnapshot でリアルタイム取得
   - config は localStorage に保存(キー: genka_fb_config)、端末間は手動設定
*/

const FB_CONFIG_KEY = 'genka_fb_config';
const fbState = {
  configured: false,
  initialized: false,
  user: null,
  syncStatus: 'idle', // 'idle'|'syncing'|'error'|'offline'|'nologin'|'unconfigured'
  lastSyncAt: null,
  pushTimer: null,
  applyingRemote: false,
  unsubscribe: null,
};

// JS オブジェクト記法 / JSON どちらも許容
function parseFbConfig(text){
  if(!text) return null;
  const s = text.trim();
  if(!s) return null;
  // JSON 試行
  try { return JSON.parse(s); } catch(e) {}
  // const firebaseConfig = {...}; 形式を抽出
  const m = s.match(/\{[\s\S]*\}/);
  if(!m) return null;
  try {
    // eslint-disable-next-line no-new-func
    const obj = Function('"use strict"; return ('+m[0]+')')();
    if(obj && typeof obj === 'object') return obj;
  } catch(e) {}
  return null;
}

function getStoredConfig(){
  try {
    const raw = localStorage.getItem(FB_CONFIG_KEY);
    if(!raw) return null;
    return JSON.parse(raw);
  } catch(e) { return null; }
}

function renderFbStatus(){
  const dot = document.getElementById('fb-dot');
  const txt = document.getElementById('fb-status-text');
  const userInfo = document.getElementById('fb-user-info');
  const emailEl = document.getElementById('fb-user-email');
  const signinBtn = document.getElementById('fb-signin-btn');
  const headerBtn = document.getElementById('sync-status-btn');
  if(!dot) return;
  let emoji='🔵', text='未設定', tip='同期(未設定)';
  if(fbState.syncStatus === 'unconfigured'){ emoji='🔵'; text='未設定: 下に Firebase config を貼り付けてください'; tip='同期(未設定)'; }
  else if(fbState.syncStatus === 'nologin'){ emoji='🔵'; text='Firebase 設定済 / サインインしてください'; tip='同期(ログイン必要)'; }
  else if(fbState.syncStatus === 'idle'){ emoji='🟢'; text='同期中: '+(fbState.user?.email||''); tip='同期OK'; }
  else if(fbState.syncStatus === 'syncing'){ emoji='🟡'; text='保存中...'; tip='同期中'; }
  else if(fbState.syncStatus === 'offline'){ emoji='🟡'; text='オフライン: 復帰時に自動同期'; tip='オフライン'; }
  else if(fbState.syncStatus === 'error'){ emoji='🔴'; text='同期エラー: コンソール確認'; tip='エラー'; }
  dot.textContent = emoji;
  txt.textContent = text;
  if(headerBtn){ headerBtn.textContent = emoji; headerBtn.dataset.tip = tip; }
  if(fbState.user){
    userInfo.style.display = '';
    emailEl.textContent = fbState.user.email || fbState.user.displayName || '';
    if(signinBtn) signinBtn.style.display = 'none';
  } else {
    userInfo.style.display = 'none';
    if(signinBtn) signinBtn.style.display = fbState.configured ? '' : 'none';
  }
  if(fbState.syncStatus === 'idle' && fbState.lastSyncAt){
    txt.textContent += ` (${new Date(fbState.lastSyncAt).toLocaleTimeString('ja-JP')})`;
  }
}

function fbInit(){
  const cfg = getStoredConfig();
  if(!cfg || !cfg.apiKey || !cfg.projectId){
    fbState.syncStatus = 'unconfigured';
    renderFbStatus();
    return;
  }
  if(typeof firebase === 'undefined'){
    console.warn('Firebase SDK not loaded yet, retrying...');
    setTimeout(fbInit, 300);
    return;
  }
  try {
    if(!firebase.apps.length) firebase.initializeApp(cfg);
    fbState.configured = true;
    fbState.initialized = true;
    const db = firebase.firestore();
    db.enablePersistence({synchronizeTabs:true}).catch(()=>{});
    firebase.auth().onAuthStateChanged(user => {
      fbState.user = user;
      if(user){
        fbState.syncStatus = navigator.onLine ? 'idle' : 'offline';
        startSync();
      } else {
        fbState.syncStatus = 'nologin';
        stopSync();
      }
      renderFbStatus();
    });
    window.addEventListener('online', () => { if(fbState.user){ fbState.syncStatus='idle'; renderFbStatus(); } });
    window.addEventListener('offline', () => { fbState.syncStatus='offline'; renderFbStatus(); });
  } catch(e){
    console.warn('firebase init failed', e);
    fbState.syncStatus = 'error';
    renderFbStatus();
  }
}

function fbSaveConfig(){
  const text = document.getElementById('fb-config-input').value;
  const cfg = parseFbConfig(text);
  if(!cfg || !cfg.apiKey || !cfg.projectId){
    alert('config を解析できませんでした。Firebase Console の設定オブジェクトをそのまま貼り付けてください。');
    return;
  }
  localStorage.setItem(FB_CONFIG_KEY, JSON.stringify(cfg));
  alert('Firebase 設定を保存しました。ページを再読み込みします。');
  location.reload();
}

function fbClearConfig(){
  if(!confirm('Firebase 設定を削除しますか?(クラウド側のデータは残ります)')) return;
  localStorage.removeItem(FB_CONFIG_KEY);
  try {
    if(firebase?.auth) firebase.auth().signOut();
  } catch(e){}
  alert('設定を削除しました。ページを再読み込みします。');
  location.reload();
}

async function fbSignIn(){
  if(!fbState.initialized) return;
  try {
    const provider = new firebase.auth.GoogleAuthProvider();
    await firebase.auth().signInWithPopup(provider);
  } catch(e){
    console.warn('signin failed', e);
    alert('サインイン失敗: '+e.message);
  }
}

async function fbSignOut(){
  if(!fbState.initialized) return;
  try { await firebase.auth().signOut(); } catch(e){}
}

function docRef(){
  if(!fbState.initialized || !fbState.user) return null;
  return firebase.firestore()
    .collection('users').doc(fbState.user.uid)
    .collection('data').doc('main');
}

function startSync(){
  stopSync();
  const ref = docRef(); if(!ref) return;
  fbState.unsubscribe = ref.onSnapshot(snapshot => {
    if(snapshot.metadata.hasPendingWrites) return; // 自分の書き込みはスキップ
    const data = snapshot.data();
    if(!data){
      // リモート未作成 → 初回プッシュ
      scheduleFbPush(true);
      return;
    }
    const remoteSaved = data.saved_at || '';
    let localSaved = '';
    try { localSaved = JSON.parse(localStorage.getItem(LS_KEY)||'{}').saved_at || ''; } catch(e) {}
    // リモートの方が新しければ適用
    if(remoteSaved > localSaved){
      fbState.applyingRemote = true;
      try {
        state.ingredients = data.ingredients || [];
        state.recipes = data.recipes || [];
        migrateLegacy();
        // ローカルにも保存(push を抑止)
        localStorage.setItem(LS_KEY, JSON.stringify({
          ingredients: state.ingredients, recipes: state.recipes,
          saved_at: remoteSaved, version: 3
        }));
        renderHero(); renderRecipeList();
        if(typeof renderMaster === 'function') renderMaster();
      } finally {
        fbState.applyingRemote = false;
      }
      fbState.lastSyncAt = Date.now();
      fbState.syncStatus = 'idle';
      renderFbStatus();
    } else if(localSaved > remoteSaved){
      // ローカルの方が新しい → push
      scheduleFbPush(true);
    }
  }, err => {
    console.warn('firestore snapshot error', err);
    fbState.syncStatus = 'error';
    renderFbStatus();
  });
}

function stopSync(){
  if(fbState.unsubscribe){ fbState.unsubscribe(); fbState.unsubscribe = null; }
}

function scheduleFbPush(immediate){
  if(!fbState.user || fbState.applyingRemote) return;
  clearTimeout(fbState.pushTimer);
  fbState.pushTimer = setTimeout(fbDoPush, immediate?100:1500);
}

async function fbDoPush(){
  const ref = docRef(); if(!ref) return;
  fbState.syncStatus = 'syncing';
  renderFbStatus();
  try {
    await ref.set({
      ingredients: state.ingredients || [],
      recipes: state.recipes || [],
      saved_at: new Date().toISOString(),
      pushed_at: firebase.firestore.FieldValue.serverTimestamp(),
    }, {merge:false});
    fbState.syncStatus = 'idle';
    fbState.lastSyncAt = Date.now();
  } catch(e){
    console.warn('firestore push error', e);
    fbState.syncStatus = navigator.onLine ? 'error' : 'offline';
  }
  renderFbStatus();
}

// 保存済み config を UI に反映
function fbLoadConfigToUI(){
  const cfg = getStoredConfig();
  const ta = document.getElementById('fb-config-input');
  if(ta && cfg) ta.value = JSON.stringify(cfg, null, 2);
}

document.addEventListener('DOMContentLoaded', () => {
  fbLoadConfigToUI();
  fbInit();
});
