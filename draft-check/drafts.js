/* Device-only drafts. No SDK, auth material, cloud writes, or background upload. */
(() => {
  'use strict';
  const PREFIX='lw_autodraft_qa_v4:', MAX=24, LIMIT=14*1024*1024;
  const fields=['date','title','trigger','insight','experience','action','deadline','tags'];
  const pick=(o,keys)=>Object.fromEntries(keys.filter(k=>o?.[k]!==undefined).map(k=>[k,o[k]]));
  const meta=i=>pick(i,['id','name','caption','mime','size','width','height','path']);
  const head=d=>pick(d,['scope','gen','id','writer','rev','time','created','requestId','currentId','pending','uncertainty','byteSource','stages']);
  function journal(d){
    const b=d.currentBase;
    return {...head(d),text:pick(d.text,fields),currentBase:b?{...pick(b,['id','version','createdAt','updatedAt']),images:(b.images||[]).map(meta)}:null,images:d.images.map(meta)};
  }
  let opening;
  function db(){
    if(!opening)opening=new Promise((ok,no)=>{
      const q=indexedDB.open('lw_autodraft_qa_db_v4',1);
      q.onupgradeneeded=()=>q.result.createObjectStore('drafts',{keyPath:['scope','gen','id']}).createIndex('scope','scope');
      q.onblocked=()=>no(Error('다른 탭의 임시저장소를 닫은 뒤 다시 시도하세요.'));
      q.onerror=()=>no(q.error);q.onsuccess=()=>{q.result.onversionchange=()=>{q.result.close();opening=null;};ok(q.result);};
    }).catch(e=>{opening=null;throw e;});return opening;
  }
  async function tx(mode,work){
    const database=await db();return new Promise((ok,no)=>{
      const t=database.transaction('drafts',mode), s=t.objectStore('drafts');let value, cause;
      const guard=fn=>(...args)=>{try{fn(...args);}catch(e){cause=e;t.abort();}};
      t.oncomplete=()=>ok(value);t.onabort=()=>no(cause||t.error||Error('기기 저장 실패'));t.onerror=()=>{};
      guard(work)(s,guard,v=>{value=v;});
    });
  }
  const prefixOf=scope=>PREFIX+encodeURIComponent(scope)+':';
  const keys=pre=>{const a=[];for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i);if(k?.startsWith(pre))a.push(k);}return a;};
  // The first fixed-width lease maps to generation 0 for existing V4 drafts.
  // Its random identity (not just the logical generation) guards each old handle.
  const logical=lease=>lease?.startsWith('!')?'0':lease;
  const revoked=new Map();
  async function purgeScope(scope,previous){
    const prefix=prefixOf(scope),marker=prefix+'generation',next=crypto.randomUUID();
    let old=previous, fenced=false, unlinked=false, journalOK=true;
    try{old=localStorage.getItem(marker)??old;}catch(_){}
    revoked.set(scope,old); // synchronous, including any other handles in this page
    const fence=()=>{try{localStorage.setItem(marker,next);fenced=localStorage.getItem(marker)===next;}catch(_){};};
    const sweep=()=>{try{for(const k of keys(prefix)){if(k===marker)continue;let active=null;try{active=localStorage.getItem(marker);}catch(_){}if(active&&active!==old&&k.startsWith(prefix+logical(active)+':'))continue;try{localStorage.removeItem(k);}catch(_){journalOK=false;}}}catch(_){journalOK=false;}};
    fence();sweep(); // if quota prevented fencing, reclaim only this owner's journals first
    if(!fenced){fence();if(!fenced){try{localStorage.removeItem(marker);unlinked=localStorage.getItem(marker)===null;}catch(_){};}sweep();}
    // Independent of every Web Storage operation above. A persistent IDB tombstone
    // blocks stale full writes even when a broken storage backend cannot rotate its lease.
    await tx('readwrite',(s,guard)=>{const q=s.index('scope').openCursor(scope);q.onsuccess=guard(()=>{const c=q.result;if(!c){if(!fenced&&!unlinked&&old)s.put({scope,gen:logical(old),id:'!revoked'});return;}
      let active=null;try{active=localStorage.getItem(marker);}catch(_){}if(!active||active===old||c.value.gen!==logical(active))c.delete();c.continue();});});
    if(!fenced||!journalOK)throw Error('기기 저장 차단으로 모든 임시본 삭제를 확인하지 못했습니다.');
  }
  function open(scope){
    const prefix=prefixOf(scope), marker=prefix+'generation';let lease=localStorage.getItem(marker);
    if(!lease){lease='!'+crypto.randomUUID().slice(1);localStorage.setItem(marker,lease);lease=localStorage.getItem(marker);}
    if(!lease)throw Error('기기 임시저장 세션을 만들지 못했습니다.');
    const gen=logical(lease),start=prefix+gen+':';let closed=false;
    const valid=()=>{if(closed||revoked.get(scope)===lease||localStorage.getItem(marker)!==lease)throw Error('로그아웃된 임시저장 세션입니다.');};
    const key=d=>start+d.id+':'+d.rev;
    function writeJournal(d){
      valid();const k=key(d), mine=start+d.id+':';const ks=keys(start);
      if(!ks.some(v=>v.startsWith(mine)) && new Set(ks.map(v=>v.slice(0,v.lastIndexOf(':')))).size>=MAX)throw Error('임시본 24개 한도입니다. 목록에서 직접 정리하세요.');
      const raw=JSON.stringify(journal(d));if(raw.length>1800000)throw Error('텍스트 임시저장 한도를 초과했습니다.');
      localStorage.setItem(k,raw);try{valid();}catch(e){localStorage.removeItem(k);throw e;}
      for(const v of ks)if(v.startsWith(mine)&&v!==k&&Number(v.slice(mine.length))<d.rev)localStorage.removeItem(v);
    }
    function write(d){
      return tx('readwrite',(s,guard)=>{valid();if(d.scope!==scope||d.gen!==gen)throw Error('임시본 소유자가 다릅니다.');
        if(JSON.stringify(d).length>LIMIT)throw Error('임시본 크기 한도를 초과했습니다.');
        const gate=s.get([scope,gen,'!revoked']);gate.onsuccess=guard(()=>{valid();if(gate.result)throw Error('로그아웃된 임시저장 세션입니다.');const q=s.get([scope,gen,d.id]);q.onsuccess=guard(()=>{valid();if(q.result?.rev>=d.rev)return;
          if(q.result){s.put(d);return;}
          const n=s.index('scope').count(scope);n.onsuccess=guard(()=>{valid();if(n.result>=MAX)throw Error('임시본 24개 한도입니다. 목록에서 직접 정리하세요.');s.put(d);});
        });});});
    }
    async function list(){
      valid();let rows=[],failure='';try{rows=await tx('readonly',(s,guard,set)=>{const q=s.index('scope').getAll(scope);q.onsuccess=guard(()=>set(q.result));});}catch(e){failure='사진 임시저장소를 읽지 못했습니다.';}
      valid();if(rows.some(d=>d.gen===gen&&d.id==='!revoked'))throw Error('로그아웃된 임시저장 세션입니다.');const full=new Map(rows.filter(d=>d.gen===gen&&d.scope===scope).map(d=>[d.id,d])),map=new Map(full);
      for(const k of keys(start)){try{const j=JSON.parse(localStorage.getItem(k));if(j?.scope!==scope||j.gen!==gen||key(j)!==k)continue;
        const f=map.get(j.id);if(f&&f.rev>=j.rev)continue;
        const origin=full.get(j.byteSource?.id), backup=origin?.rev===j.byteSource?.rev?origin:null, bytes=full.get(j.id)||backup;
        const images=[],missing=[];for(const m of j.images){const saved=bytes?.images.find(i=>i.id===m.id&&i.mime===m.mime&&i.size===m.size&&i.width===m.width&&i.height===m.height);if(saved?.dataURL)images.push({...m,dataURL:saved.dataURL});else if(m.path)images.push(m);else missing.push(m.name);}
        // Journal owns the target. Null means a deliberate save-as-new transition.
        // Only enrich the same original ID + optimistic version; never infer a base.
        let currentBase=j.currentBase??null;
        if(j.currentId!=null&&currentBase?.id===j.currentId&&bytes?.currentBase?.id===j.currentId&&bytes.currentBase.version===currentBase.version)currentBase=bytes.currentBase;
        map.set(j.id,{...j,images,currentBase,byteSource:bytes?{id:bytes.id,rev:bytes.rev}:null,uncertainty:[j.uncertainty,...missing.map(n=>'복구되지 않은 사진: '+n)].filter(Boolean).join(' · '),journalOnly:true});
      }catch(_){failure='일부 텍스트 임시본을 읽지 못했습니다. 원본은 그대로 두었습니다.';}}
      return {items:[...map.values()].sort((a,b)=>b.time-a.time),failure};
    }
    async function remove(d){
      valid();await tx('readwrite',(s,guard)=>{valid();const pk=[scope,gen,d.id],q=s.get(pk);q.onsuccess=guard(()=>{valid();if(q.result&&q.result.rev<=d.rev)s.delete(pk);});});
      valid();for(const k of keys(start+d.id+':'))if(Number(k.slice(k.lastIndexOf(':')+1))<=d.rev)localStorage.removeItem(k);
    }
    function purge(){closed=true;return purgeScope(scope,lease);}
    return {scope,gen,lease,marker,valid,writeJournal,write,list,remove,purge};
  }
  window.LWDrafts=Object.freeze({open,purge:purgeScope});
})();
