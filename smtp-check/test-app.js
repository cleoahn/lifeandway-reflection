/* LIFE & WAY V2. No cloud diary content is cached in browser storage.
 * Requires pinned @supabase/supabase-js 2.119.0 global (window.supabase).
 * All DOM output containing diary/user data uses textContent or escaped HTML.
 */
(() => {
  'use strict';
  const ids = ['date','title','trigger','insight','experience','action','deadline','tags'];
  const TABLE = 'reflection_entries';
  const CONFIG = 'lw_smtp_check_connection';
  const LOCAL = 'lw_smtp_check_local_explicit';
  const REMEMBER = 'lw_smtp_check_remember';
  const MAX_FILE = 10 * 1024 * 1024;
  const MAX_ROWS = 5000;
  const el = id => document.getElementById(id);
  const clean = s => String(s ?? '').trim();
  const data = () => Object.fromEntries(ids.map(id => [id, clean(el(id).value)]));
  const today = () => { const d = new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); };
  const fmtDate = s => s ? s.replaceAll('-','. ') : '';
  const escapeHtml = s => String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const uid = () => crypto.randomUUID ? crypto.randomUUID() : String(Date.now())+'-'+Math.random().toString(36).slice(2);
  let records = [], currentId = null, currentBase = null, mode = 'threads', dirty = false;
  let client = null, subscription = null, user = null, localMode = false, epoch = 0, busy = false;
  let config = null, conflict = null, recovery = false, clientGeneration = 0;
  let localBaseline = null;
  let requestId = uid(); // stable while retrying an uncertain INSERT
  const status = text => { el('status').textContent = text; };
  const cloudError = text => { el('cloudError').textContent = text; };
  const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
  const canEdit = () => localMode || !!user;
  const token = () => ({epoch, userId:user?.id ?? null, localMode, client});
  const live = t => t.epoch === epoch && t.userId === (user?.id ?? null) && t.localMode === localMode && t.client === client;
  function showDialog(id) { const d=el(id); if(!d.open) d.showModal(); }
  function clearConflict() {
    conflict=null;
    el('conflictLocal').textContent='';
    el('conflictRemote').textContent='';
  }
  function closeDialogs() { ['authDialog','conflictDialog'].forEach(id=>el(id).close()); }
  function lock() {
    const enabled=canEdit();
    ids.forEach(id=>el(id).disabled=!enabled || busy);
    ['saveBtn','newBtn','deleteBtn','importBtn'].forEach(id=>el(id).disabled=!enabled || busy);
    ['syncBtn'].forEach(id=>el(id).disabled=!user || busy);
    ['authBtn','localBtn','configBtn','configSave','loginBtn','signupBtn','resetPasswordBtn','updatePasswordBtn'].forEach(id=>el(id).disabled=busy);
    el('exportBtn').disabled=!enabled || busy;
    el('logoutBtn').disabled=!enabled;
    el('copyBtn').disabled=!enabled;
    el('downloadTxt').disabled=!enabled;
    el('cloudStatus').textContent = busy ? '처리 중' : user ? '클라우드 연결 · '+(user.email || '로그인됨') : localMode ? '이 브라우저 전용 · 동기화 안 됨' : '로그인 필요';
    el('logoutBtn').classList.toggle('hidden', !enabled);
    el('updatePasswordBtn').classList.toggle('hidden', !recovery);
  }
  function clearEditor() {
    currentId=null; currentBase=null; requestId=uid(); dirty=false;
    ids.forEach(id=>el(id).value=''); el('date').value=today();
    el('editorTitle').textContent='오늘의 기록';
    el('deleteBtn').classList.add('hidden'); status('');
    if(canEdit()) generate(); else { el('preview').textContent='로그인하거나 이 브라우저 전용 모드를 선택해 주세요.'; el('count').textContent='0'; el('progressFill').style.width='0%'; el('progressLabel').textContent='0 / 3'; }
  }
  function scrub() {
    epoch++; records=[]; user=null; localMode=false; localBaseline=null; clearConflict(); recovery=false; busy=false;
    clearEditor(); el('search').value=''; if(el('dateFilter'))el('dateFilter').value='';
    el('lastSync').textContent='아직 동기화하지 않음'; el('importReport').textContent='';
    el('password').value=''; el('passwordConfirm').value=''; el('email').value='';
    closeDialogs(); render(); lock();
  }
  function detach() {
    clientGeneration++;
    subscription?.unsubscribe(); subscription=null;
    if(client) client.auth.stopAutoRefresh();
    client=null;
  }
  function authStorageKey() { return config ? 'lw_smtp_check_auth_'+new URL(config.url).hostname.split('.')[0] : null; }
  function clearAuthStorage() {
    const key=authStorageKey(); if(!key)return;
    [localStorage, sessionStorage].forEach(store=> { try { store.removeItem(key); store.removeItem(key+'-code-verifier'); } catch (_) {} });
  }
  const storage = {
    getItem(key) { try { return (localStorage.getItem(REMEMBER)==='yes' ? localStorage : sessionStorage).getItem(key); } catch (_) { return null; } },
    setItem(key,value) { (localStorage.getItem(REMEMBER)==='yes' ? localStorage : sessionStorage).setItem(key,value); },
    removeItem(key) { [localStorage,sessionStorage].forEach(s=> { try{s.removeItem(key);}catch(_){} }); }
  };
  function validateConfig(url, key) {
    let u; try {u=new URL(clean(url));}catch(_){throw Error('올바른 Project URL을 입력해 주세요.');}
    if(u.protocol!=='https:' || !/^[a-z0-9-]+\.supabase\.co$/.test(u.hostname) || u.username || u.password || u.port || (u.pathname!=='/' && u.pathname!=='') || u.search || u.hash) throw Error('https://프로젝트ID.supabase.co 형식의 전용 Project URL만 허용됩니다.');
    const k=clean(key);
    if(!/^sb_publishable_[A-Za-z0-9_-]+$/.test(k)) throw Error('Publishable key(sb_publishable_로 시작)만 입력해 주세요. Secret / service_role / 구형 JWT 키는 허용하지 않습니다.');
    return {url:u.origin,key:k};
  }
  function ensureClient() {
    if(client)return client;
    if(!config)throw Error('먼저 Supabase 연결 설정을 입력해 주세요.');
    if(!window.supabase?.createClient)throw Error('인증 라이브러리를 불러오지 못했습니다. 인터넷 연결을 확인하고 새로고침해 주세요.');
    const generation=++clientGeneration;
    const timedFetch=async (input,init={})=>{
      const controller=new AbortController();const external=init.signal;
      const abort=()=>controller.abort();
      if(external?.aborted)controller.abort();else external?.addEventListener('abort',abort,{once:true});
      const timer=setTimeout(abort,20000);
      try{return await fetch(input,{...init,signal:controller.signal});}
      finally{clearTimeout(timer);external?.removeEventListener('abort',abort);}
    };
    const isolatedStorage={getItem:key=>generation===clientGeneration?storage.getItem(key):null,setItem:(key,value)=>{if(generation===clientGeneration)storage.setItem(key,value);},removeItem:key=>{if(generation===clientGeneration)storage.removeItem(key);}};
    client=window.supabase.createClient(config.url,config.key,{global:{fetch:timedFetch},auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true,storage:isolatedStorage,storageKey:authStorageKey()}});
    const c=client;
    const out=c.auth.onAuthStateChange((event,session)=>{
      // Never await another Supabase auth call within this callback.
      setTimeout(async()=>{
        if(client!==c)return;
        if(event==='SIGNED_OUT') {scrub();return;}
        if(session?.user && ['INITIAL_SESSION','SIGNED_IN','PASSWORD_RECOVERY','TOKEN_REFRESHED'].includes(event)) {
          if(event==='PASSWORD_RECOVERY'){recovery=true;showDialog('authDialog');el('authMessage').textContent='새 비밀번호와 비밀번호 확인을 입력한 뒤 변경 버튼을 누르세요.';}
          if(user?.id===session.user.id){lock();return;}
          const keepRecovery=recovery;
          scrub(); recovery=keepRecovery; user=session.user; localMode=false;clearEditor();lock();
          if(recovery)showDialog('authDialog');
          await sync();
        }
      },0);
    });
    subscription=out.data.subscription;
    return c;
  }
  async function initialSession() {
    if(!config){lock();return;}
    try {const c=ensureClient();const t=token(); const {data:d,error}=await c.auth.getSession();if(error)throw error;
      if(!live(t))return;
      if(d.session?.user) {
        const {data:v,error:verifyError}=await c.auth.getUser();
        if(!live(t))return;
        if(verifyError || !v.user)throw Error('세션을 확인할 수 없습니다. 다시 로그인해 주세요.');
        if(!user) {user=v.user;clearEditor();lock();await sync();}
      }
    } catch(err) {cloudError(err.message || '로그인 상태를 확인하지 못했습니다.');}
  }
  function toRecord(row) {
    return {...Object.fromEntries(ids.map(k=>[k,row[k] || ''])),id:row.id,user_id:row.user_id,
      createdAt:row.created_at,updatedAt:row.updated_at,deletedAt:row.deleted_at,version:Number(row.version)};
  }
  function toPayload(r,owner) {
    return {...Object.fromEntries(ids.map(k=>[k,typeof r[k]==='string'?r[k]:''])),date:r.date || today(),deadline:r.deadline || null,id:r.id,user_id:owner};
  }
  async function allCloud(c,owner,t) {
    const out=[];
    for(let start=0;;start+=500) {
      const {data:rows,error}=await c.from(TABLE).select('*').eq('user_id',owner).order('id',{ascending:true}).range(start,start+499);
      if(!live(t))throw Error('계정 또는 연결이 변경되어 요청을 중단했습니다.');
      if(error)throw error;
      out.push(...rows.map(toRecord)); if(rows.length<500)break;
    }
    return out;
  }
  async function sync() {
    if(busy || !user)return;
    if(!navigator.onLine){cloudError('오프라인입니다. 입력 내용은 유지되지만 클라우드에 저장되지 않습니다.');return;}
    const t=token();busy=true;lock();cloudError('');
    try {
      const fresh=await allCloud(t.client,t.userId,t);if(!live(t))return;
      records=fresh;render();
      if(currentId && !dirty) {const r=records.find(r=>r.id===currentId && !r.deletedAt); if(r)fill(r);else clearEditor();}
      el('lastSync').textContent='마지막 동기화: '+new Date().toLocaleString('ko-KR');
      cloudError('동기화 완료');
    }catch(_){if(live(t))cloudError('동기화에 실패했습니다. 기존 화면과 입력은 유지됩니다. 연결·로그인·RLS 설정을 확인해 주세요.');}
    finally{if(live(t)){busy=false;lock();}}
  }
  function visibleRecords() {return records.filter(r=>!r.deletedAt);}
  function render() {
    const q=clean(el('search').value).toLowerCase(), day=el('dateFilter')?.value;
    const filtered=visibleRecords().sort((a,b)=>(b.date||'').localeCompare(a.date||'')||(b.updatedAt||'').localeCompare(a.updatedAt||'')).filter(r=>(!day||r.date===day) && [r.title,r.trigger,r.insight,r.experience,r.action,r.tags].some(x=>String(x||'').toLowerCase().includes(q)));
    el('total').textContent=visibleRecords().length+'개';
    el('entries').innerHTML=filtered.length?filtered.map(r=>'<div class="entry" role="button" tabindex="0" data-id="'+escapeHtml(r.id)+'"><span class="date">'+escapeHtml(fmtDate(r.date))+'</span><strong>'+escapeHtml(r.title||'제목 없는 기록')+'</strong><p>'+escapeHtml((r.insight||r.trigger||'내용 없음').slice(0,90))+'</p></div>').join(''):'<div class="empty">'+(!canEdit()?'로그인 후 기록을 불러옵니다.':q||day?'검색 결과가 없습니다.':'저장된 기록이 없습니다.')+'</div>';
    el('entries').querySelectorAll('.entry').forEach(node=>{const fn=()=>openRecord(node.dataset.id);node.onclick=fn;node.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();fn();}};});
  }
  function fill(r) {
    currentId=r.id;currentBase={...r};requestId=r.id;
    ids.forEach(k=>el(k).value=r[k]||'');dirty=false;el('editorTitle').textContent='기록 수정하기';el('deleteBtn').classList.remove('hidden');status('');generate();
  }
  function openRecord(id) {
    if(busy || !canEdit())return;
    if(dirty&&!confirm('저장하지 않은 입력을 버리고 다른 기록을 열까요? 먼저 TXT로 보관할 수 있습니다.'))return;
    const r=records.find(v=>v.id===id&&!v.deletedAt);if(!r)return;fill(r);window.scrollTo({top:0,behavior:'smooth'});
  }
  function reset() {if(busy||!canEdit())return;if(dirty&&!confirm('저장하지 않은 입력을 버리고 새 기록을 시작할까요?'))return;clearEditor();}
  function persistLocal(next) {
    // Never read, write, delete or automatically migrate lifeandway_reflection_v1.
    if(next.length>MAX_ROWS)throw Error('로컬 기록은 최대 5,000개입니다. 백업한 뒤 기록을 정리하거나 클라우드를 사용해 주세요.');
    const currentRaw=localStorage.getItem(LOCAL);
    if(currentRaw!==localBaseline)throw Error('다른 탭에서 로컬 기록이 변경되어 덮어쓰기를 중단했습니다. 현재 입력을 TXT로 보관하고 로컬 모드를 다시 열어 최신 기록을 확인해 주세요.');
    const nextRaw=JSON.stringify(next);
    localStorage.setItem(LOCAL,nextRaw);
    localBaseline=nextRaw;
  }
  function localSave() {
    const d=data(); const now=new Date().toISOString();
    const r={...d,id:currentId || requestId,createdAt:currentBase?.createdAt||now,updatedAt:now,version:(currentBase?.version||0)+1};
    const next=records.filter(v=>v.id!==r.id).concat(r);persistLocal(next);records=next;fill(r);render();status('이 브라우저에만 저장되었습니다. 클라우드 동기화되지 않습니다.');
  }
  function compareConflict(mine,remote,operation) {
    conflict={mine:{...mine},remote:remote?{...remote}:null,operation,owner:user?.id,epoch};
    el('conflictLocal').textContent=JSON.stringify(mine,null,2);
    el('conflictRemote').textContent=remote?remote.deletedAt?'다른 기기에서 삭제된 기록입니다.\n'+JSON.stringify(remote,null,2):JSON.stringify(remote,null,2):'서버에 기록이 없거나 접근할 수 없습니다.';
    showDialog('conflictDialog');
  }
  async function findRemote(t,id) {
    const {data:r,error}=await t.client.from(TABLE).select('*').eq('user_id',t.userId).eq('id',id).maybeSingle();
    if(!live(t))return null;if(error)throw error;return r?toRecord(r):null;
  }
  async function cloudWrite(deleting=false) {
    if(!user || busy)return;
    if(!navigator.onLine){cloudError('오프라인입니다. 입력은 유지됩니다. 이 화면을 닫기 전 TXT로 보관해 주세요.');return;}
    const t=token(), mine={...data(),id:currentId||requestId};const base=currentBase?{...currentBase}:null;
    busy=true;lock();cloudError('');
    try {
      let reply;
      if(base) {
        const changes=deleting?{deleted_at:new Date().toISOString()}:toPayload(mine,t.userId);
        reply=await t.client.from(TABLE).update(changes).eq('user_id',t.userId).eq('id',base.id).eq('version',base.version).is('deleted_at',null).select('*');
      } else {
        if(deleting)return;
        reply=await t.client.from(TABLE).insert(toPayload(mine,t.userId)).select('*');
      }
      if(!live(t))return;
      if(reply.error) {
        if(reply.error.code==='23505') {const remote=await findRemote(t,mine.id);if(live(t))compareConflict(mine,remote,deleting?'delete':'save');return;}
        throw reply.error;
      }
      if(!reply.data?.length) {const remote=await findRemote(t,mine.id);if(live(t))compareConflict(mine,remote,deleting?'delete':'save');return;}
      const saved=toRecord(reply.data[0]);records=records.filter(r=>r.id!==saved.id).concat(saved);
      if(deleting)clearEditor();else fill(saved);
      render();status(deleting?'클라우드에서 삭제되었습니다.':'클라우드 저장 완료');
      el('lastSync').textContent='마지막 동기화: '+new Date().toLocaleString('ko-KR');
    }catch(_){if(live(t)){dirty=true;status('저장 실패 · 입력 유지');cloudError('클라우드 저장을 확인하지 못했습니다. 입력은 유지됩니다. 다시 시도하거나 TXT로 보관해 주세요. 새 기록의 재시도는 동일 ID를 사용합니다.');}}
    finally{if(live(t)){busy=false;lock();}}
  }
  async function save() {
    if(busy||!canEdit())return;
    const d=data();if(![d.insight,d.experience,d.action].some(Boolean)){status('성찰 질문 중 하나 이상 작성해 주세요.');return;}
    if(!validDate(d.date) || (d.deadline&&!validDate(d.deadline))){status('유효한 기록 날짜와 실행 기한을 입력해 주세요.');return;}
    if(ids.some(k=>d[k].length>200000)){status('한 입력칸은 200,000자 이내로 작성해 주세요.');return;}
    if(localMode){try{localSave();}catch(err){status((err.message||'브라우저 저장 실패')+' · 입력 유지. TXT로 보관해 주세요.');}return;}
    await cloudWrite(false);
  }
  async function remove() {
    if(busy||!currentId||!canEdit()||!confirm('이 기록을 삭제할까요? 삭제 전 JSON 백업을 권장합니다.'))return;
    if(localMode){try{const next=records.filter(r=>r.id!==currentId);persistLocal(next);records=next;clearEditor();render();status('로컬 기록을 삭제했습니다.');}catch(err){status((err.message||'삭제 저장 실패')+' 기존 화면과 입력은 유지됩니다.');}return;}
    await cloudWrite(true);
  }
  function download(name,text,mime) {
    const blob=new Blob([text],{type:mime}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1500);
  }
  function validateBackup(parsed) {
    const list=Array.isArray(parsed)?parsed:parsed?.records;
    if(!Array.isArray(list)||list.length>MAX_ROWS)throw Error('배열 형식의 records가 필요하며, 한 번에 5,000개까지 가져올 수 있습니다.');
    const valid=[], seen=new Set();let invalid=0,duplicates=0;
    for(const row of list) {
      if(!row || typeof row!=='object' || typeof row.id!=='string' || !row.id.trim() || row.id.length>200 || !validDate(row.date) || (row.deadline&&!validDate(row.deadline)) || ids.some(k=>row[k]!==undefined&&(typeof row[k]!=='string'||row[k].length>200000)) || row.deleted_at || row.deletedAt) {invalid++;continue;}
      if(seen.has(row.id)){duplicates++;continue;}seen.add(row.id);
      valid.push({...Object.fromEntries(ids.map(k=>[k,typeof row[k]==='string'?row[k]:''])),id:row.id,createdAt:row.createdAt||row.created_at,updatedAt:row.updatedAt||row.updated_at});
    }
    return {valid,invalid,duplicates,total:list.length};
  }
  async function importBackup(event) {
    const file=event.target.files?.[0];if(!file)return;
    event.target.value=''; if(busy||!canEdit())return;
    const t=token();busy=true;lock();
    let successful=0,failed=0,skipped=0;
    try {
      if(file.size>MAX_FILE)throw Error('백업 파일은 10MB 이하로 나누어 주세요.');
      const parsed=JSON.parse(await file.text());if(!live(t))return;
      const check=validateBackup(parsed);
      if(!check.valid.length)throw Error('가져올 수 있는 유효한 기록이 없습니다. 원본 파일은 그대로 보관해 주세요.');
      if(!localMode) {if(!navigator.onLine)throw Error('클라우드 가져오기는 인터넷 연결이 필요합니다.');records=await allCloud(t.client,t.userId,t);if(!live(t))return;render();}
      const before=visibleRecords().length,existing=new Set(records.map(r=>r.id));
      const incoming=check.valid.filter(r=>{if(existing.has(r.id)){skipped++;return false;}return true;});
      const target=localMode?'이 브라우저 전용 저장소':('클라우드 계정 '+user.email);
      const description='원본 '+check.total+'개 / 형식 오류·삭제 기록 '+check.invalid+'개 / 파일 내부 중복 '+check.duplicates+'개 / 기존 ID 중복 '+skipped+'개 / 신규 '+incoming.length+'개.\n대상: '+target+'\n중복 ID는 덮어쓰지 않습니다. 원본 백업은 삭제하지 않습니다. 업로드할까요?';
      el('importReport').textContent=description;
      if(!incoming.length||!confirm(description))return;
      if(!localMode && prompt('잘못된 계정으로 업로드하는 것을 막기 위해 현재 계정 이메일을 정확히 입력해 주세요.', '')!==user.email) {el('importReport').textContent='이메일이 일치하지 않아 업로드를 취소했습니다.';return;}
      if(!live(t))return;
      if(localMode) {
        const now=new Date().toISOString();const added=incoming.map(r=>({...r,createdAt:typeof r.createdAt==='string'?r.createdAt:now,updatedAt:now,version:1}));
        const next=records.concat(added);persistLocal(next);records=next;successful=added.length;
      } else {
        for(const r of incoming) {
          if(!live(t))return;
          const {data:rows,error}=await t.client.from(TABLE).insert(toPayload(r,t.userId)).select('*');
          if(!live(t))return;
          if(error){if(error.code==='23505')skipped++;else failed++;}else if(rows?.[0]){records.push(toRecord(rows[0]));successful++;}else failed++;
        }
      }
      if(!live(t))return;
      render();
      el('importReport').textContent='이전 결과: 원본 '+check.total+'개 · 이전 '+before+'개 → 현재 확인 '+visibleRecords().length+'개 · 성공 '+successful+'개 · 실패 '+failed+'개 · 기존 ID 중복 '+skipped+'개 · 파일 내부 중복 '+check.duplicates+'개 · 오류/삭제 '+check.invalid+'개. 원본 파일은 그대로 보관하세요.';
      if(!localMode && !failed)el('lastSync').textContent='마지막 이전: '+new Date().toLocaleString('ko-KR');
    } catch(err) {if(live(t))el('importReport').textContent='가져오기 중단: '+(err instanceof SyntaxError?'JSON 형식이 올바르지 않습니다.':err.message || '연결 또는 저장 오류')+' 성공 '+successful+'개 / 실패 '+failed+'개. 원본 파일과 현재 입력은 유지됩니다.';}
    finally {if(live(t)){busy=false;lock();}}
  }
  async function logout() {
    if(dirty&&!confirm('로그아웃하면 저장하지 않은 입력은 이 화면에서 지워집니다. 먼저 TXT로 보관하시겠어요? 취소하면 계속 편집할 수 있습니다.'))return;
    try{localStorage.setItem('lw_smtp_check_logout',String(Date.now())+'-'+uid());}catch(_){}
    const c=client;detach();clearAuthStorage();scrub();cloudError('로그아웃되었습니다. 이 화면의 클라우드 기록과 입력을 지웠습니다.');
    // Removing the persisted token and detaching events happens BEFORE any network I/O.
    if(c){try{const {error}=await c.auth.signOut({scope:'local'});if(error&&!user&&!localMode)cloudError('이 브라우저에서 로그아웃했습니다. 서버 연결 오류로 세션 만료 확인은 못 했습니다. 공용 기기에서는 브라우저 데이터도 삭제해 주세요.');}catch(_){}}
  }
  async function authAction(kind) {
    if(busy)return;
    let authToken=null;
    if(dirty&&!confirm('로그인 과정에서 편집 중 입력이 지워질 수 있습니다. 먼저 저장 또는 TXT 보관 후 진행하세요. 계속할까요?'))return;
    const email=clean(el('email').value),password=el('password').value, confirmation=el('passwordConfirm').value;
    if(!email && kind!=='update'){el('authMessage').textContent='이메일을 입력해 주세요.';return;}
    if(['signup','update'].includes(kind) && (password.length<12 || password!==confirmation)){el('authMessage').textContent='12자 이상 비밀번호와 동일한 비밀번호 확인을 입력해 주세요.';return;}
    if(kind==='login'&&!password){el('authMessage').textContent='비밀번호를 입력해 주세요.';return;}
    try {
      const c=ensureClient();const t=token();authToken=t;busy=true;lock();el('authMessage').textContent='처리 중입니다.';
      if(kind==='login'||kind==='signup') {
        // Recreate storage placement only at an explicit sign-in/up operation.
        const remember=el('remember').checked;
        if(kind==='login'||kind==='signup')clearAuthStorage();
        localStorage.setItem(REMEMBER,remember?'yes':'no');
      }
      const redirect="https://cleoahn.github.io/lifeandway-reflection/";
      let result;
      if(kind==='login')result=await c.auth.signInWithPassword({email,password});
      if(kind==='signup')result=await c.auth.signUp({email,password,options:{emailRedirectTo:redirect}});
      if(kind==='reset')result=await c.auth.resetPasswordForEmail(email,{redirectTo:redirect});
      if(kind==='update')result=await c.auth.updateUser({password});
      if(!live(t))return;
      if(result.error)throw Error('인증 요청을 완료하지 못했습니다. 이메일 인증 여부, 입력값, 전송 제한, 프로젝트 인증 URL 설정을 확인해 주세요.');
      el('password').value='';el('passwordConfirm').value='';
      el('authMessage').textContent=kind==='signup'?'인증 이메일을 확인해 주세요. 이메일이 도착하지 않으면 스팸함과 발송 제한을 확인하세요.':kind==='reset'?'계정이 존재하면 비밀번호 재설정 메일이 전송됩니다.':kind==='update'?'비밀번호를 변경했습니다.':'로그인되었습니다.';
      if(kind==='update'){recovery=false;el('authDialog').close();}
      // Auth state subscription performs scoped scrubbing and fetching.
      if(kind==='login' && result.data?.user) { const keep=recovery; scrub();user=result.data.user;recovery=keep;clearEditor();lock();await sync(); }
      if(kind==='signup'&&result.data?.session?.user){scrub();user=result.data.session.user;clearEditor();lock();await sync();}
    } catch(err) {if(!authToken||live(authToken))el('authMessage').textContent=err.message || '인증에 실패했습니다.';}
    finally{if(!authToken||live(authToken)){busy=false;lock();}}
  }
  function enterLocal() {
    if(busy)return;
    if(!confirm('이 모드는 클라우드 계정과 별개이며, 이 브라우저를 사용하는 사람은 로컬 기록을 다시 열 수 있습니다. 공용 기기에서는 사용하지 마세요. 기존 V1 기록은 자동으로 불러오거나 업로드하지 않습니다. 계속할까요?'))return;
    if(dirty&&!confirm('현재 저장하지 않은 입력을 버릴까요?'))return;
    const previous=client;detach();clearAuthStorage();scrub();localMode=true;
    try {const storedRaw=localStorage.getItem(LOCAL);const raw=JSON.parse(storedRaw||'[]');const check=validateBackup(raw);if(check.invalid||check.duplicates||check.valid.length!==check.total)throw Error('손상 또는 중복된 로컬 기록');localBaseline=storedRaw;records=check.valid.map(r=>({...r,version:1}));}
    catch(_){cloudError('로컬 기록을 읽지 못했습니다. 기존 저장 데이터는 삭제하지 않았습니다. 백업이 필요하면 기존 파일을 보관해 주세요.');localMode=false;records=[];}
    clearEditor();render();lock();
    if(previous)previous.auth.signOut({scope:'local'}).catch(()=>{});
  }
  function bind() {
    ids.forEach(id=>el(id).addEventListener('input',()=>{if(!canEdit())return;dirty=true;status('저장 전');generate();}));
    document.querySelectorAll('[data-mode]').forEach(btn=>{btn.setAttribute('role','tab');btn.setAttribute('aria-selected',String(btn.classList.contains('active')));btn.onclick=()=>{mode=btn.dataset.mode;document.querySelectorAll('[data-mode]').forEach(b=>{b.classList.toggle('active',b===btn);b.setAttribute('aria-selected',String(b===btn));});if(canEdit())generate();};});
    document.querySelectorAll('[data-close]').forEach(button=>button.onclick=()=>{const dialog=button.closest('dialog');if(dialog){dialog.close();if(dialog.id==='conflictDialog')clearConflict();}});
    el('conflictDialog').addEventListener('cancel',clearConflict);
    el('conflictDialog').addEventListener('close',clearConflict);
    el('saveBtn').onclick=save;el('newBtn').onclick=reset;el('deleteBtn').onclick=remove;
    el('search').oninput=render;if(el('dateFilter'))el('dateFilter').oninput=render;
    el('syncBtn').onclick=sync;el('logoutBtn').onclick=logout;el('localBtn').onclick=enterLocal;
    el('authBtn').onclick=()=>{if(!config){showDialog('configDialog');return;}showDialog('authDialog');};
    el('configBtn').onclick=()=>{el('projectUrl').value=config?.url||'';el('publishableKey').value=config?.key||'';showDialog('configDialog');};
    el('configForm').onsubmit=e=>{e.preventDefault();if(busy)return;try{const next=validateConfig(el('projectUrl').value,el('publishableKey').value);if(dirty&&!confirm('연결 변경 시 저장하지 않은 입력이 지워집니다. 계속할까요?'))return;const old=client;detach();clearAuthStorage();scrub();config=next;localStorage.setItem(CONFIG,JSON.stringify(config));el('configDialog').close();if(old)old.auth.signOut({scope:'local'}).catch(()=>{});cloudError('연결 설정을 저장했습니다. 로그인 후 전용 테이블과 RLS 연결을 확인하세요.');initialSession();}catch(err){el('configMessage').textContent=err.message||'설정을 저장하지 못했습니다.';}};
    el('authForm').onsubmit=e=>{e.preventDefault();authAction('login');};
    el('loginBtn').onclick=()=>authAction('login');el('signupBtn').onclick=()=>authAction('signup');el('resetPasswordBtn').onclick=()=>authAction('reset');el('updatePasswordBtn').onclick=()=>authAction('update');
    el('copyBtn').onclick=async()=>{if(!canEdit())return;const text=generate();try{await navigator.clipboard.writeText(text);status('글을 복사했습니다.');}catch(_){const ta=document.createElement('textarea');ta.value=text;document.body.appendChild(ta);ta.select();const ok=document.execCommand('copy');ta.remove();status(ok?'글을 복사했습니다.':'복사가 제한되어 있습니다. 미리보기를 선택해 복사해 주세요.');}};
    el('downloadTxt').onclick=()=>{if(canEdit())download((data().title||'성찰기록').replace(/[\\/:*?"<>|]/g,'_')+'.txt',generate(),'text/plain;charset=utf-8');};
    el('exportBtn').onclick=()=>{if(!canEdit()||busy)return;download('라이프앤웨이_성찰기록_백업_'+today()+'.json',JSON.stringify({app:'LIFE_AND_WAY_REFLECTION',version:2,exportedAt:new Date().toISOString(),scope:localMode?'local':'cloud',records:visibleRecords().map(r=>({...Object.fromEntries(ids.map(k=>[k,r[k]||''])),id:r.id,createdAt:r.createdAt,updatedAt:r.updatedAt}))},null,2),'application/json;charset=utf-8');status('현재 불러온 기록을 백업했습니다. 최신 전체 기록은 먼저 동기화 후 백업하세요.');};
    el('importBtn').onclick=()=>{if(!busy&&canEdit())el('importFile').click();};el('importFile').onchange=importBackup;
    el('conflictCancel').onclick=()=>{el('conflictDialog').close();clearConflict();status('충돌 취소 · 입력은 유지됩니다.');};
    el('conflictLoad').onclick=()=>{if(!conflict||conflict.epoch!==epoch||conflict.owner!==user?.id)return;const r=conflict.remote;if(dirty&&!confirm('현재 입력을 버리고 서버 버전을 열까요? 먼저 TXT로 보관할 수 있습니다.'))return;el('conflictDialog').close();if(r&&!r.deletedAt){records=records.filter(v=>v.id!==r.id).concat(r);fill(r);}else{if(r)records=records.filter(v=>v.id!==r.id).concat(r);clearEditor();}clearConflict();render();};
    el('conflictNew').onclick=async()=>{if(!conflict||busy||conflict.epoch!==epoch||conflict.owner!==user?.id)return;if(!confirm('기존 서버 기록은 변경하지 않고 현재 입력을 별도 새 기록으로 저장할까요?'))return;const mine=conflict.mine;el('conflictDialog').close();currentId=null;currentBase=null;requestId=uid();ids.forEach(k=>el(k).value=mine[k]||'');dirty=true;clearConflict();await save();};
    window.addEventListener('beforeunload',e=>{if(dirty||busy){e.preventDefault();e.returnValue='';}});
    window.addEventListener('offline',()=>cloudError('오프라인입니다. 입력은 유지되지만 클라우드 저장되지 않습니다. 화면을 닫기 전 TXT로 보관하세요.'));
    window.addEventListener('online',()=>{if(user)cloudError('인터넷이 다시 연결되었습니다. 지금 동기화를 누르세요. 미저장 입력은 자동 업로드되지 않습니다.');});
    // If another tab signs out, remove all private in-memory content here too.
    window.addEventListener('storage',e=>{if(e.key===LOCAL && localMode){cloudError('다른 탭에서 로컬 기록이 변경되었습니다. 이 화면을 덮어쓰지 않았습니다. 미저장 입력을 TXT로 보관한 뒤 로컬 모드를 다시 열어 주세요.');return;}if(((e.key===authStorageKey() && !e.newValue)||e.key==='lw_smtp_check_logout') && user){detach();scrub();cloudError('다른 탭에서 로그아웃되어 화면을 잠갔습니다.');}});
    window.addEventListener('pageshow',e=>{if(e.persisted && user){detach();scrub();initialSession();}});
  }
  function generate(){const filled=['insight','experience','action'].filter(k=>clean(el(k).value)).length;el('progressFill').style.width=(filled/3*100)+'%';el('progressLabel').textContent=filled+' / 3';const d=data(),t=d.title||'오늘의 성찰',i=d.insight,x=d.experience,a=d.action,s=d.trigger,deadline=d.deadline?` (실행 기한: ${fmtDate(d.deadline)})`:'';let out='';if(mode==='threads'){out=[t,s?`오늘 ${s}에서 생각이 시작됐다.`:'',i,x?`내 경험을 돌아보면, ${x}`:'',a?`그래서 나는 ${a}${deadline}`:'','내가 오늘의 생각을 기록하는 이유는, 배운 것을 내 것으로 만들기 위해서다.'].filter(Boolean).join('\n\n')}else if(mode==='linkedin'){out=[t,s?`최근 ${s}을(를) 계기로 일하는 방식을 다시 생각했습니다.`:'',i?`제가 깨달은 점은 이렇습니다.\n${i}`:'',x?`실제 경험에서도 비슷한 장면이 있었습니다.\n${x}`:'',a?`앞으로의 실행 계획은 명확합니다.\n${a}${deadline}`:'','여러분은 비슷한 경험이 있으신가요?'].filter(Boolean).join('\n\n')}else{out=[`# ${t}`,`기록일: ${fmtDate(d.date)}`,s?`## 생각의 시작\n${s}`:'',i?`## 오늘의 깨달음\n${i}`:'',x?`## 내 경험에서 발견한 장면\n${x}`:'',a?`## 앞으로의 실천\n${a}${deadline}`:'',`## 오늘의 마무리\n배운 내용을 내 언어와 행동으로 바꾸는 연습을 이어가려 한다.`].filter(Boolean).join('\n\n')}if(d.tags){out+='\n\n'+d.tags.split(',').map(v=>v.trim().replace(/^#/, '').replace(/\s+/g,'')).filter(Boolean).map(v=>'#'+v).join(' ')}el('preview').textContent=out;el('count').textContent=out.length;return out}
  try {const value=JSON.parse(localStorage.getItem(CONFIG)||'null') || window.LW_DEFAULT_CONFIG;if(value)config=validateConfig(value.url,value.key);}catch(_){config=null;}
  bind();clearEditor();render();lock();
  if(location.protocol==='file:')cloudError('클라우드 인증은 HTTPS 배포 주소에서 사용하세요. 로컬 파일은 디자인 확인용입니다.');
  if(window.__LW_ENABLE_TESTS===true)window.__LW_TEST={validateBackup,validateConfig,validDate,escapeHtml,toRecord,toPayload};
  initialSession();
})();
