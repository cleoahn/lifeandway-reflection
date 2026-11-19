/* LIFE & WAY V4. Device-only temporary drafts are separate from manually saved records.
 * Requires pinned @supabase/supabase-js 2.119.0 global (window.supabase).
 * All DOM output containing diary/user data uses textContent or escaped HTML.
 */
(() => {
  'use strict';
  const ids = ['date','title','trigger','insight','experience','action','deadline','tags'];
  const TABLE = 'reflection_entries';
  const CONFIG = 'lw_autodraft_qa_v2_connection';
  const LOCAL = 'lw_autodraft_qa_v3_local_images';
  const LEGACY_LOCAL = 'lw_autodraft_qa_v2_local_explicit'; // Read-only fallback, explicit local entry only.
  const REMEMBER = 'lw_autodraft_qa_v2_remember';
  const MAX_FILE = 100 * 1024 * 1024;
  const MAX_ROWS = 5000;
  const el = id => document.getElementById(id);
  const clean = s => String(s ?? '').trim();
  const data = () => ({...Object.fromEntries(ids.map(id => [id, clean(el(id).value)])),images:editorImages.map(v=>({...v}))});
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

  // V3 private images: URLs and decoded bytes stay in memory, never in cloud rows.
  const IMAGE_BUCKET='reflection-images', IMAGE_LIMIT=1048576, BACKUP_LIMIT=100*1024*1024;
  const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const IMAGE_MIMES=['image/jpeg','image/png','image/webp'];
  let editorImages=[], imageRevision=0, imageWorking=false;
  const imageURLs=new Set(), stagedImages=new Map(), importImageStages=new Map(), pendingImageCleanup=new Set();
  function imageMeta(image,owner,portable=false) {
    if(!image||typeof image!=='object'||!UUID.test(image.id)||typeof image.name!=='string'||image.name.length>200||typeof image.caption!=='string'||image.caption.length>1000||!IMAGE_MIMES.includes(image.mime)||!Number.isInteger(image.size)||image.size<1||image.size>IMAGE_LIMIT||!Number.isInteger(image.width)||!Number.isInteger(image.height)||image.width<1||image.height<1||image.width>1600||image.height>1600)throw Error('사진 정보가 올바르지 않습니다.');
    const out={id:image.id,name:image.name,caption:image.caption,mime:image.mime,size:image.size,width:image.width,height:image.height};
    if(image.path!==undefined){
      const parts=String(image.path).split('/');
      if(parts.length!==2||!UUID.test(parts[0])||! /^[0-9a-f-]{36}\.(webp|jpg|png)$/i.test(parts[1])||!UUID.test(parts[1].split('.')[0])||(owner&&parts[0]!==owner)||!parts[1].endsWith(image.mime==='image/jpeg'?'.jpg':image.mime==='image/png'?'.png':'.webp'))throw Error('사진 저장 경로가 올바르지 않습니다.');
      out.path=image.path;
    }
    if(!portable&&!out.path)throw Error('사진 저장 경로가 없습니다.');
    return out;
  }
  function magicMime(bytes){
    if(bytes.length>=3&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'image/jpeg';
    if(bytes.length>=8&&[137,80,78,71,13,10,26,10].every((v,i)=>bytes[i]===v))return 'image/png';
    if(bytes.length>=12&&String.fromCharCode(...bytes.subarray(0,4))==='RIFF'&&String.fromCharCode(...bytes.subarray(8,12))==='WEBP')return 'image/webp';
    return null;
  }
  function dataURLBlob(value,expected){
    if(typeof value!=='string'||value.length>Math.ceil(IMAGE_LIMIT/3)*4+64)throw Error('사진 데이터가 없거나 1MiB를 초과합니다.');
    const match=/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
    if(!match||match[2].length%4!==0)throw Error('사진은 유효한 JPG, PNG, WebP 데이터만 허용됩니다. SVG·HEIC는 지원하지 않습니다.');
    const raw=atob(match[2]);const bytes=Uint8Array.from(raw,c=>c.charCodeAt(0));
    if(!bytes.length||bytes.length>IMAGE_LIMIT||magicMime(bytes)!==match[1]||(expected&&(expected.mime!==match[1]||expected.size!==bytes.length)))throw Error('사진 형식, 크기 또는 실제 파일 내용이 일치하지 않습니다.');
    return new Blob([bytes],{type:match[1]});
  }
  function validateImages(list,owner,portable=false){
    if(list===undefined)return [];
    if(!Array.isArray(list)||list.length>3)throw Error('사진은 기록마다 최대 3장입니다.');
    const seen=new Set();return list.map(image=>{const out=imageMeta(image,owner,portable);if(seen.has(out.id))throw Error('중복된 사진 ID입니다.');seen.add(out.id);if(portable){dataURLBlob(image.dataURL,out);out.dataURL=image.dataURL;delete out.path;}return out;});
  }
  function blobDataURL(blob){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(Error('사진을 읽지 못했습니다.'));reader.readAsDataURL(blob);});}
  async function decodeImage(blob){
    const url=URL.createObjectURL(blob),img=new Image();
    try{await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=()=>reject(Error('사진을 해독하지 못했습니다. 손상된 파일, SVG·HEIC는 사용할 수 없습니다.'));img.src=url;});return img;}finally{URL.revokeObjectURL(url);}
  }
  async function verifyBlob(blob,meta){
    if(blob.size!==meta.size||blob.size>IMAGE_LIMIT||magicMime(new Uint8Array(await blob.arrayBuffer()))!==meta.mime)throw Error('저장된 사진의 실제 형식 또는 크기가 다릅니다.');
    const img=await decodeImage(blob);if(img.naturalWidth!==meta.width||img.naturalHeight!==meta.height)throw Error('사진 해상도 정보가 실제 파일과 다릅니다.');return blob;
  }
  async function processImage(file){
    if(file.size>20*1024*1024)throw Error('원본 사진은 한 장당 20MB 이하로 선택해 주세요.');
    const actual=magicMime(new Uint8Array(await file.slice(0,16).arrayBuffer()));
    if(!IMAGE_MIMES.includes(file.type)||actual!==file.type||/\.(svg|heic|heif)$/i.test(file.name))throw Error('JPG, PNG, WebP 사진만 가능합니다. SVG·HEIC 또는 형식이 다른 파일은 지원하지 않습니다.');
    const img=await decodeImage(file),w=img.naturalWidth,h=img.naturalHeight;
    if(!w||!h||w*h>100000000)throw Error('너무 크거나 유효하지 않은 사진입니다. 1억 픽셀 이하 파일을 사용해 주세요.');
    const ratio=Math.min(1,1600/Math.max(w,h)),canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(w*ratio));canvas.height=Math.max(1,Math.round(h*ratio));
    const ctx=canvas.getContext('2d');if(!ctx)throw Error('이 브라우저에서 사진 변환을 지원하지 않습니다.');ctx.drawImage(img,0,0,canvas.width,canvas.height);
    const encode=(type,q)=>new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(Error('사진 변환에 실패했습니다.')),type,q));
    let blob=await encode('image/webp',0.86),mime=blob.type==='image/webp'?'image/webp':'image/jpeg';
    if(mime==='image/jpeg'){ctx.globalCompositeOperation='destination-over';ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);}
    for(const quality of [0.86,0.72,0.56,0.4,0.25]){blob=await encode(mime,quality);if(blob.size<=IMAGE_LIMIT)break;}
    if(blob.size>IMAGE_LIMIT)throw Error('1MiB 이하로 변환할 수 없는 사진입니다. 더 작은 사진을 선택해 주세요.');
    const image={id:crypto.randomUUID(),name:clean(file.name).slice(0,200)||'사진',caption:'',mime:blob.type,size:blob.size,width:canvas.width,height:canvas.height,dataURL:await blobDataURL(blob)};
    dataURLBlob(image.dataURL,image);return image;
  }
  function revokeImages(){imageRevision++;for(const url of imageURLs)URL.revokeObjectURL(url);imageURLs.clear();el('imageGallery')?.replaceChildren();el('previewGallery')?.replaceChildren();el('imageDialog')?.close();if(el('enlargedImage'))el('enlargedImage').removeAttribute('src');}
  function resetImages(list=[]){revokeImages();stagedImages.clear();editorImages=list.map(v=>({...v}));renderImages();}
  async function imageBlob(image,t){
    if(image.dataURL)return verifyBlob(dataURLBlob(image.dataURL,image),image);
    const staged=stagedImages.get(image.id);if(staged?.blob)return staged.blob;
    imageMeta(image,t.userId);
    if(!live(t)||!t.userId)throw Error('로그인이 변경되어 사진 요청을 중단했습니다.');
    const {data:blob,error}=await t.client.storage.from(IMAGE_BUCKET).download(image.path);
    if(!live(t))throw Error('계정이 변경되었습니다.');if(error||!blob)throw Error('비공개 사진을 불러오지 못했습니다. 로그인과 연결을 확인해 주세요.');
    return verifyBlob(blob,image);
  }
  function imageNotice(text){el('imageStatus').textContent=text;}
  function renderImages(){
    revokeImages();const revision=imageRevision,t=token();
    editorImages.forEach(image=>{
      const card=document.createElement('figure');card.className='image-card';const view=document.createElement('button');view.type='button';view.className='image-thumb';view.disabled=true;view.textContent='사진 불러오는 중';view.setAttribute('aria-label',image.name+' 크게 보기');
      const caption=document.createElement('input');caption.type='text';caption.maxLength=1000;caption.value=image.caption;caption.placeholder='사진 설명 (선택)';caption.setAttribute('aria-label',image.name+' 설명');caption.disabled=busy||imageWorking||!canEdit();
      caption.oninput=()=>{if(busy||imageWorking||!canEdit())return;image.caption=caption.value;dirty=true;collect();status('사진 설명 저장 전');};
      const label=document.createElement('figcaption');label.textContent=image.name+' · '+Math.ceil(image.size/1024)+'KB';
      const row=document.createElement('div');row.className='row';const save=document.createElement('button');save.type='button';save.className='btn';save.textContent='변환 사진 저장';save.disabled=true;
      const remove=document.createElement('button');remove.type='button';remove.className='btn';remove.textContent='첨부 빼기';remove.disabled=busy||imageWorking||!canEdit();remove.onclick=()=>{if(busy||imageWorking)return;editorImages=editorImages.filter(v=>v.id!==image.id);dirty=true;collect();void flushFull();status('첨부 변경 저장 전');renderImages();};row.append(save,remove);card.append(view,label,caption,row);el('imageGallery').append(card);
      imageBlob(image,t).then(blob=>{if(!live(t)||revision!==imageRevision)return;const url=URL.createObjectURL(blob);imageURLs.add(url);const img=document.createElement('img');img.src=url;img.alt=image.caption||image.name;view.replaceChildren(img);view.disabled=false;
        const enlarge=()=>{if(!live(t)||revision!==imageRevision)return;el('enlargedImage').src=url;el('enlargedImage').alt=image.caption||image.name;el('enlargedCaption').textContent=image.caption||image.name;showDialog('imageDialog');};view.onclick=enlarge;
        save.disabled=false;save.onclick=()=>{if(!live(t)||revision!==imageRevision)return;download(image.name.replace(/\.[^.]*$/,'')+(image.mime==='image/jpeg'?'.jpg':image.mime==='image/png'?'.png':'.webp'),blob,image.mime);};
        const preview=document.createElement('button');preview.type='button';preview.className='image-thumb';const copy=img.cloneNode();preview.append(copy);preview.setAttribute('aria-label',image.name+' 크게 보기');preview.onclick=enlarge;el('previewGallery').append(preview);
      }).catch(err=>{if(live(t)&&revision===imageRevision){view.textContent='사진 불러오기 실패';imageNotice(err.message+' 기록의 사진 정보는 유지됩니다.');}});
    });
    el('imageCount').textContent=editorImages.length+' / 3';el('chooseImages').disabled=!canEdit()||busy||imageWorking||editorImages.length>=3;
  }
  async function chooseImages(event){
    const files=Array.from(event.target.files||[]);event.target.value='';if(!files.length||busy||imageWorking||!canEdit())return;
    if(files.length+editorImages.length>3){imageNotice('사진은 기록마다 최대 3장입니다.');return;}
    const t=token(),revision=imageRevision;imageWorking=true;collect();lock();imageNotice('사진을 안전한 크기로 변환하고 있습니다.');
    try{const added=[];for(const file of files)added.push(await processImage(file));if(!live(t)||revision!==imageRevision)return;editorImages.push(...added);dirty=true;renderImages();imageNotice('원본 대신 최대 1600px, 1MiB 이하로 변환한 사진만 저장합니다.');}
    catch(err){if(live(t)&&revision===imageRevision)imageNotice(err.message+' 선택한 사진은 추가하지 않았습니다.');}
    finally{if(live(t)){imageWorking=false;if(!dirty&&draft?.pending){retireDraft();draftView();}else{collect();void flushFull();}lock();renderImages();}}
  }
  async function stageImages(images,t,store=stagedImages){
    const result=[];
    for(const image of images){
      if(!live(t))throw Error('계정이 변경되었습니다.');
      if(!image.dataURL){result.push(imageMeta(image,t.userId));continue;}
      let stage=store.get(image.id);
      if(stage&&stage.source!==image.dataURL){store.delete(image.id);stage=null;}
      if(!stage){const blob=await imageBlob(image,t);stage={blob,source:image.dataURL,path:t.userId+'/'+crypto.randomUUID()+(image.mime==='image/jpeg'?'.jpg':image.mime==='image/png'?'.png':'.webp'),uploaded:false,attempted:false};if(!live(t))throw Error('계정이 변경되었습니다.');store.set(image.id,stage);}
      if(!stage.uploaded){
        if(stage.attempted){const check=await t.client.storage.from(IMAGE_BUCKET).download(stage.path);if(!live(t))throw Error('계정이 변경되었습니다.');if(check.data){await verifyBlob(check.data,image);const a=new Uint8Array(await stage.blob.arrayBuffer()),b=new Uint8Array(await check.data.arrayBuffer());if(a.length!==b.length||a.some((v,i)=>v!==b[i]))throw Error('재시도 사진 내용이 다릅니다. 원본 입력은 유지됩니다.');stage.uploaded=true;}else if(String(check.error?.statusCode||check.error?.status)!=='404'&&!/not found|does not exist/i.test(check.error?.message||''))throw Error('이전 사진 업로드 상태를 확인하지 못했습니다. 같은 화면에서 다시 시도해 주세요.');}
        if(!stage.uploaded){stage.attempted=true;if(store===stagedImages&&draftOn()){collect();await flushFull();if(!live(t))throw Error('계정이 변경되었습니다.');}const reply=await t.client.storage.from(IMAGE_BUCKET).upload(stage.path,stage.blob,{contentType:image.mime,upsert:false});if(!live(t))throw Error('계정이 변경되었습니다.');if(reply.error)throw Error('사진 업로드를 확인하지 못했습니다. 경로와 변환 사진을 유지하므로 같은 화면에서 재시도해 주세요.');stage.uploaded=true;}
      }
      result.push(imageMeta({...image,path:stage.path},t.userId));
    }return result;
  }
  async function cleanupImages(previous,next,t){
    if(!live(t)||!t.userId||t.localMode)return;
    const ownerPath=path=>typeof path==='string'&&path.startsWith(t.userId+'/')&&new RegExp('^'+t.userId+'/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.(webp|jpg|png)$','i').test(path);
    for(const image of previous||[])if(ownerPath(image.path)&&!(next||[]).some(n=>n.path===image.path))pendingImageCleanup.add(image.path);
    const pending=[...pendingImageCleanup].filter(ownerPath);if(!pending.length)return;
    try{
      const fresh=await allCloud(t.client,t.userId,t);if(!live(t))return;
      const candidates=pending.filter(path=>!fresh.some(r=>!r.deletedAt&&(r.images||[]).some(i=>i.path===path)));
      const shared=pending.filter(path=>!candidates.includes(path));
      // Shared paths belong to another live record; its later removal will request GC.
      for(const path of shared)pendingImageCleanup.delete(path);
      if(!candidates.length){cloudError('기록 변경은 저장했습니다. 다른 기록에서 사용하는 사진 파일은 보존했습니다.');return;}
      if(!live(t))return;
      // Server advisory locks + reference trigger permanently retire only unreferenced
      // owner paths. Storage DELETE is permitted ONLY for these returned reservations.
      const reservation=await t.client.rpc('request_reflection_image_cleanup',{paths:candidates});
      if(!live(t))return;
      if(reservation.error||!Array.isArray(reservation.data))throw Error('사진 정리 예약을 확인하지 못했습니다. 파일 삭제는 요청하지 않았습니다.');
      if(reservation.data.some(row=>!row||!ownerPath(row.path)||!candidates.includes(row.path)))throw Error('서버의 사진 정리 응답이 요청한 계정·경로와 다릅니다. 파일 삭제는 요청하지 않았습니다.');
      const reserved=[...new Set(reservation.data.map(row=>row.path))];
      // Paths absent from the RPC result are never deleted, even if our SELECT
      // previously found no references. The RPC is the authoritative race-safe gate.
      for(const path of candidates)if(!reserved.includes(path))pendingImageCleanup.delete(path);
      if(!reserved.length){cloudError('기록 변경은 저장했습니다. 서버가 삭제를 예약하지 않은 사진 파일은 보존했습니다.');return;}
      if(!live(t))return;
      const removal=await t.client.storage.from(IMAGE_BUCKET).remove(reserved);
      if(!live(t))return;
      if(removal.error||!Array.isArray(removal.data))throw Error('사진 파일 삭제 완료를 확인하지 못했습니다. 일부 파일은 이미 삭제됐을 수 있습니다.');
      for(const path of reserved)pendingImageCleanup.delete(path);
      cloudError('기록 변경과 연결이 해제된 사진 '+reserved.length+'장의 저장소 정리를 완료했습니다.'+(shared.length?' 다른 기록에서 사용하는 사진은 보존했습니다.':''));
    }catch(err){if(live(t))cloudError('기록 변경은 저장했습니다. 사진 정리 실패: '+(err.message||'연결 오류')+' 안전하지 않은 추가 삭제는 하지 않았습니다. 같은 계정에서 지금 동기화 또는 다음 저장 시 정리를 재시도합니다.');}
  }
  async function cloneImagesForNewRecord(images,t){
    const cloned=[];
    for(const image of images||[]){
      const blob=await imageBlob(image,t);if(!live(t))throw Error('계정이 변경되어 사진 복사를 중단했습니다.');
      const dataURL=await blobDataURL(blob);if(!live(t))throw Error('계정이 변경되어 사진 복사를 중단했습니다.');
      const copy={...imageMeta(image,null,true),id:crypto.randomUUID(),dataURL};delete copy.path;cloned.push(copy);
    }
    return cloned;
  }
  async function exportBackup(){
    if(!canEdit()||busy||imageWorking)return;
    if(!confirm('JSON 백업에는 개인 일기와 비공개 사진 원본(변환본)이 포함됩니다. 안전한 개인 저장소에 보관하고 공유하거나 GitHub에 올리지 마세요. 계속할까요?'))return;
    const t=token();busy=true;lock();
    try{const output=[];let bytes=0;for(const record of visibleRecords()){
      const r={...Object.fromEntries(ids.map(k=>[k,record[k]||''])),id:record.id,createdAt:record.createdAt,updatedAt:record.updatedAt,images:[]};
      for(const image of record.images||[]){const blob=await imageBlob(image,t);if(!live(t))return;const portable={...imageMeta(image,null,true),dataURL:await blobDataURL(blob)};delete portable.path;r.images.push(portable);}
      bytes+=new Blob([JSON.stringify(r)]).size+1;if(bytes>BACKUP_LIMIT-4096)throw Error('사진을 포함한 백업이 100MB를 초과합니다. 기록을 나누어 보관해 주세요. 사진을 제외한 불완전한 백업은 만들지 않았습니다.');output.push(r);
    }if(!live(t))return;const json=JSON.stringify({app:'LIFE_AND_WAY_REFLECTION',version:3,exportedAt:new Date().toISOString(),scope:t.localMode?'local':'cloud',records:output});if(new Blob([json]).size>BACKUP_LIMIT)throw Error('JSON 백업은 최대 100MB입니다.');download('라이프앤웨이_사진포함_백업_'+today()+'.json',json,'application/json;charset=utf-8');status('사진 포함 JSON 백업 완료. 현재 불러온 기록 기준이며 최신 전체 기록은 먼저 동기화하세요.');}
    catch(err){if(live(t))cloudError('백업 실패: '+err.message+' 사진을 누락한 파일은 만들지 않았습니다.');}finally{if(live(t)){busy=false;lock();}}
  }

  // Recovery scope is installed only by verified login or explicit local entry.
  const writer=uid(); let shelf=null, draft=null, source=null, timer=0, draftReady=false, triedRestore=false, uncertainty='', listTicket=0, viewSerial=0;
  const dNote=s=>{el('draftStatus').textContent=s;};
  const draftOn=()=>el('draftOn').checked;
  function unpin(){try{shelf?.pin(writer,null);}catch(_){}}
  function ancestors(d){return d?[...(d.ancestry||[]),{id:d.id,rev:d.rev}]:[];}
  function draftView(){unpin();clearTimeout(timer);timer=0;draft=null;source=null;uncertainty='';viewSerial++;dNote(!canEdit()?'로그인 또는 로컬 모드에서 사용':!shelf?'임시저장 실패 · 기기 저장소를 확인하세요.':draftOn()?'임시저장 대기':'임시저장 꺼짐 (이 화면)');}
  function activateShelf(){try{shelf=window.LWDrafts.open(localMode?'local':config.url+'|'+user.id);}catch(_){shelf=null;}draftReady=false;triedRestore=false;draftView();}
  function hideShelf(){unpin();listTicket++;el('draftList').replaceChildren();el('draftDialog').close();shelf=null;draftReady=false;triedRestore=false;el('draftOn').checked=true;draftView();}
  function collect(){
    if(!shelf||!draftOn()||!canEdit()||(!dirty&&!imageWorking))return;
    const now=Date.now();draft={id:draft?.id||uid(),created:draft?.created||now,rev:(draft?.rev||0)+1,writer,time:now,scope:shelf.scope,gen:shelf.gen,requestId,currentId,currentBase,ancestry:ancestors(source),
      text:Object.fromEntries(ids.map(k=>[k,el(k).value])),images:editorImages.map(v=>({...v})),pending:imageWorking,uncertainty,byteSource:source?(source.journalOnly?source.byteSource:{id:source.id,rev:source.rev}):null,
      stages:editorImages.flatMap(i=>{const s=stagedImages.get(i.id);return s?.attempted?[{id:i.id,path:s.path}]:[];})};
    try{shelf.writeJournal(draft);draft.journalOK=true;}catch(e){draft.issue=e.message;}
    dNote(draft.issue?'텍스트 임시저장 실패 · '+draft.issue:imageWorking?'사진 변환 중 · 새 사진은 아직 임시저장되지 않았습니다.':'임시저장 중');
    clearTimeout(timer);timer=setTimeout(flushFull,350);
  }
  function flushFull(){
    clearTimeout(timer);timer=0;const d=draft,s=shelf;if(!d||!s||!draftOn())return Promise.resolve(false);
    if(d.job)return d.job;
    const {journalOK,issue,full,job,...row}=d;
    d.job=s.write(row).then(()=>{d.full=true;if(draft===d&&shelf===s)dNote(d.pending?'사진 변환 중 · 새 사진은 미보관':d.uncertainty?'사진 확인 필요 · '+d.uncertainty:issue?'텍스트 저널 실패 · 전체 임시본 보관됨: '+issue:'임시저장 완료 · '+new Date(d.time).toLocaleTimeString('ko-KR'));return true;},e=>{if(draft===d&&shelf===s)dNote('임시저장 실패 · '+(e.message||'기기 용량·권한을 확인하세요.')+(journalOK?' (텍스트 저널만 보관)':''));return false;});return d.job;
  }
  function boundary(){if(!draft||!shelf||!draftOn())return;try{shelf.writeJournal(draft);}catch(e){draft.journalOK=false;dNote('텍스트 임시저장 실패 · '+e.message);}void flushFull();}
  async function keepView(){
    if(!dirty)return true;const s=shelf,v=viewSerial,d=draft;
    if(!draftOn())return confirm('이 화면은 임시저장이 꺼져 있습니다. 현재 입력을 보관하지 않고 이동할까요?');
    if(!d&&source)return true;
    if(d?.job&&!d.full){await d.job;if(!d.full)delete d.job;}
    if(d!==draft||s!==shelf||v!==viewSerial)return false;
    if(!await flushFull()||d!==draft||v!==viewSerial){if(v===viewSerial)dNote('임시저장 확인 전에는 이동하지 않습니다. 저장 공간을 확인하거나 직접 기록을 저장하세요.');return false;}return true;
  }
  function retireDraft(){
    clearTimeout(timer);timer=0;const s=shelf,mine=draft,old=source;if(!s)return Promise.resolve();unpin();
    return (async()=>{if(mine?.job)await mine.job;await s.retire([...ancestors(old),...ancestors(mine)]);})().catch(()=>{if(shelf===s)cloudError('기록 처리는 완료됐지만 기기 임시본 삭제를 확인하지 못했습니다. 임시본 목록을 확인하세요.');});
  }
  function restore(d){
    if(!shelf||d.scope!==shelf.scope||d.gen!==shelf.gen)return;shelf.valid();
    if(!d.requestId||!!d.currentId!==!!d.currentBase||(d.currentId&&(d.currentBase.id!==d.currentId||!Number.isInteger(d.currentBase.version)))||(!localMode&&d.currentBase?.user_id&&d.currentBase.user_id!==user.id))throw Error('원본 버전을 확인할 수 없어 임시본을 열지 않았습니다.');
    const imgs=d.images.map(i=>{if(i.dataURL)return validateImages([i],user?.id,true)[0];return imageMeta(i,user?.id);});
    if(imgs.length>3||new Set(imgs.map(i=>i.id)).size!==imgs.length)throw Error('임시본의 사진 목록을 확인할 수 없습니다.');
    const restoreStages=new Map();if(!localMode)for(const entry of d.stages||[]){const i=imgs.find(x=>x.id===entry.id&&x.dataURL);if(i){const m=imageMeta({...i,path:entry.path},user.id);restoreStages.set(i.id,{blob:dataURLBlob(i.dataURL,i),source:i.dataURL,path:m.path,attempted:true,uploaded:false});}}
    draftView();source=d;let pinWarning='';if(imgs.some(i=>i.dataURL))try{shelf.pin(writer,d.journalOnly?d.byteSource:{id:d.id,rev:d.rev});}catch(_){pinWarning=' · 탭 간 사진 복구 보호를 확인하지 못했습니다.';}currentId=d.currentId;currentBase=d.currentBase;requestId=d.requestId;
    ids.forEach(k=>el(k).value=d.text[k]??'');resetImages(imgs);
    for(const [id,stage] of restoreStages)stagedImages.set(id,stage);
    dirty=true;uncertainty=[d.uncertainty,d.pending?'변환 중이던 사진은 다시 선택하세요.':''].filter(Boolean).join(' · ');
    el('editorTitle').textContent=currentId?'기록 수정하기':'오늘의 기록';el('deleteBtn').classList.toggle('hidden',!currentId);generate();
    dNote('임시본 복구 · '+new Date(d.time).toLocaleString('ko-KR')+(d.journalOnly?' · 최근 텍스트 저널 반영':'')+(uncertainty?' · '+uncertainty:'')+pinWarning);
    status(currentId&&!records.some(r=>r.id===currentId&&!r.deletedAt)?'원본이 목록에 없습니다. 자동으로 새 기록을 만들지 않습니다.':'복구된 입력입니다. 기록 저장은 직접 눌러 주세요.');imageNotice(uncertainty);
  }
  async function afterSync(){
    draftReady=true;if(triedRestore||!shelf)return;triedRestore=true;const s=shelf,v=viewSerial;
    try{const {items,failure}=await s.list();if(shelf!==s||viewSerial!==v||!draftOn())return;if(!dirty&&!currentId&&!imageWorking&&items[0])restore(items[0]);if(failure)cloudError(failure);}catch(e){if(s===shelf)dNote('임시본 복구 실패 · '+e.message);}
  }
  async function pickDraft(){
    if(!canEdit()||!shelf||!draftReady||busy||imageWorking)return;const s=shelf,ticket=++listTicket;const box=el('draftList');box.replaceChildren();showDialog('draftDialog');
    try{const {items,failure}=await s.list();if(s!==shelf||ticket!==listTicket)return;box.textContent=failure||(!items.length?'보관된 임시본이 없습니다.':'');
      for(const d of items){const row=document.createElement('div');row.className='draft-row';const name=document.createElement('span');name.textContent=(d.text.title||'제목 없는 기록').slice(0,60)+' · '+new Date(d.time).toLocaleString('ko-KR');const read=document.createElement('button'),del=document.createElement('button');for(const b of [read,del]){b.type='button';b.className='btn';}read.textContent='열기';del.textContent='폐기';
        read.onclick=async()=>{if(s!==shelf||busy||imageWorking||!await keepView()||s!==shelf)return;try{restore(d);el('draftDialog').close();}catch(e){dNote('임시본 복구 실패 · '+e.message);}};
        del.onclick=async()=>{if(s!==shelf||busy||imageWorking||!confirm('선택한 기기 임시본을 폐기할까요? 저장한 기록은 삭제하지 않습니다.'))return;const mine=draft;try{if(mine?.id===d.id&&mine.rev===d.rev){clearTimeout(timer);if(mine.job)await mine.job;}await s.remove(d);if(s!==shelf)return;if((draft?.id===d.id&&draft.rev===d.rev)||(!draft&&source?.id===d.id&&source.rev===d.rev))clearEditor();await pickDraft();}catch(e){if(s===shelf)box.textContent='폐기 실패 · '+e.message;}};row.append(name,read,del);box.append(row);}
    }catch(e){if(s===shelf)box.textContent='임시본 목록 실패 · '+e.message;}
  }

  function showDialog(id) { const d=el(id); if(!d.open) d.showModal(); }
  function clearConflict() {
    conflict=null;
    el('conflictLocal').textContent='';
    el('conflictRemote').textContent='';
  }
  function closeDialogs() { ['authDialog','conflictDialog','imageDialog'].forEach(id=>el(id).close()); }
  function lock() {
    const enabled=canEdit();el('draftPick').disabled=!enabled||!shelf||!draftReady||busy||imageWorking;el('draftOn').disabled=!enabled||busy||imageWorking;
    el('chooseImages').disabled=!enabled||busy||imageWorking||editorImages.length>=3;
    el('imageFile').disabled=!enabled||busy||imageWorking;
    document.querySelectorAll('#imageGallery input, #imageGallery .row button').forEach(n=>n.disabled=!enabled||busy||imageWorking);
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
    draftView();resetImages();imageNotice('');
    currentId=null; currentBase=null; requestId=uid(); dirty=false;
    ids.forEach(id=>el(id).value=''); el('date').value=today();
    el('editorTitle').textContent='오늘의 기록';
    el('deleteBtn').classList.add('hidden'); status('');
    if(canEdit()) generate(); else { el('preview').textContent='로그인하거나 이 브라우저 전용 모드를 선택해 주세요.'; el('count').textContent='0'; el('progressFill').style.width='0%'; el('progressLabel').textContent='0 / 3'; }
  }
  function scrub(preserve=true) {
    if(preserve)boundary();hideShelf();
    epoch++; imageWorking=false;importImageStages.clear();pendingImageCleanup.clear(); records=[]; user=null; localMode=false; localBaseline=null; clearConflict(); recovery=false; busy=false;
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
  function authStorageKey() { return config ? 'lw_autodraft_qa_v2_auth_'+new URL(config.url).hostname.split('.')[0] : null; }
  function clearAuthStorage() {
    const key=authStorageKey(); if(!key)return;
    for(const name of ['localStorage','sessionStorage'])try{const store=globalThis[name];store.removeItem(key);store.removeItem(key+'-code-verifier');}catch(_){}
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
      // Never await SDK auth calls within the SDK callback. Published events are
      // notifications, not authoritative identities by the time their task runs.
      setTimeout(async()=>{
        if(client!==c)return;
        if(event==='SIGNED_OUT'){await reconcileSession(c);return;}
        const id=session?.user?.id;
        if(!id||!['INITIAL_SESSION','SIGNED_IN','PASSWORD_RECOVERY','TOKEN_REFRESHED'].includes(event))return;
        if(user?.id!==id)await verifiedSession(c,id);
        if(client!==c||user?.id!==id)return;
        if(event==='PASSWORD_RECOVERY'){recovery=true;showDialog('authDialog');el('authMessage').textContent='새 비밀번호와 비밀번호 확인을 입력한 뒤 변경 버튼을 누르세요.';}
        lock();
      },0);
    });
    subscription=out.data.subscription;
    return c;
  }
  async function reconcileSession(c){
    if(!c||client!==c)return;const t=token();
    try{const {data:d,error}=await c.auth.getSession();if(!live(t))return;if(error)throw error;
      if(d?.session?.user?.id){if(user?.id!==d.session.user.id)await verifiedSession(c,d.session.user.id);return;}
      if(d&&d.session===null)scrub();
    }catch(_){if(live(t))cloudError('로그인 상태를 확인하지 못했습니다. 현재 입력을 유지했습니다. 연결을 확인하세요.');}
  }
  const verifications=new Map();
  async function verifiedSession(c,id){
    if(c!==client||!id||user?.id===id)return;
    const t=token(),key=clientGeneration+':'+epoch+':'+id;if(verifications.has(key))return verifications.get(key);
    const task=(async()=>{try{
      const {data:v,error}=await c.auth.getUser();if(!live(t))return;if(error||!v?.user)throw Error('계정 확인에 실패했습니다. 현재 입력은 유지됩니다.');
      if(v.user.id!==id)return; // stale SIGNED_IN: it must not reset even an opt-out editor
      const {data:now,error:sessionError}=await c.auth.getSession();if(!live(t))return;if(sessionError)throw sessionError;if(now?.session?.user?.id!==id)return;
      scrub();user=v.user;activateShelf();clearEditor();lock();await sync();
    }catch(e){if(live(t))cloudError(e.message||'계정 확인 실패 · 입력 유지');}finally{verifications.delete(key);}})();verifications.set(key,task);return task;
  }
  async function initialSession(){
    if(!config){lock();return;}const t0=epoch;try{const c=ensureClient(),{data:d,error}=await c.auth.getSession();if(c!==client||t0!==epoch)return;if(error)throw error;if(d.session?.user)await verifiedSession(c,d.session.user.id);}catch(e){if(t0===epoch)cloudError(e.message||'로그인 상태 확인 실패');}
  }
  function toRecord(row) {
    return {...Object.fromEntries(ids.map(k=>[k,row[k] || ''])),id:row.id,user_id:row.user_id,
      images:validateImages(row.images,row.user_id),createdAt:row.created_at,updatedAt:row.updated_at,deletedAt:row.deleted_at,version:Number(row.version)};
  }
  function toPayload(r,owner) {
    return {...Object.fromEntries(ids.map(k=>[k,typeof r[k]==='string'?r[k]:''])),date:r.date || today(),deadline:r.deadline || null,id:r.id,user_id:owner,...(Object.prototype.hasOwnProperty.call(r,'images')?{images:validateImages(r.images,owner)}:{})};
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
    if(busy || imageWorking || !user)return;
    if(!navigator.onLine){cloudError('오프라인입니다. 입력 내용은 유지되지만 클라우드에 저장되지 않습니다.');return;}
    const t=token();busy=true;lock();cloudError('');
    try {
      const fresh=await allCloud(t.client,t.userId,t);if(!live(t))return;
      records=fresh;render();
      if(currentId && !dirty) {const r=records.find(r=>r.id===currentId && !r.deletedAt); if(r)fill(r);else clearEditor();}
      el('lastSync').textContent='마지막 동기화: '+new Date().toLocaleString('ko-KR');
      cloudError('동기화 완료');
      await afterSync();if(live(t))await cleanupImages([],[],t);
    }catch(_){if(live(t))cloudError('동기화에 실패했습니다. 기존 화면과 입력은 유지됩니다. 연결·로그인·RLS 설정을 확인해 주세요.');}
    finally{if(live(t)){busy=false;lock();}}
  }
  function visibleRecords() {return records.filter(r=>!r.deletedAt);}
  function render() {
    const q=clean(el('search').value).toLowerCase(), day=el('dateFilter')?.value;
    const filtered=visibleRecords().sort((a,b)=>(b.date||'').localeCompare(a.date||'')||(b.updatedAt||'').localeCompare(a.updatedAt||'')).filter(r=>(!day||r.date===day) && [r.title,r.trigger,r.insight,r.experience,r.action,r.tags].some(x=>String(x||'').toLowerCase().includes(q)));
    el('total').textContent=visibleRecords().length+'개';
    el('entries').innerHTML=filtered.length?filtered.map(r=>'<div class="entry" role="button" tabindex="0" data-id="'+escapeHtml(r.id)+'"><span class="date">'+escapeHtml(fmtDate(r.date))+'</span><strong>'+escapeHtml(r.title||'제목 없는 기록')+'</strong>'+((r.images||[]).length?'<span class="image-indicator">사진 '+r.images.length+'장</span>':'')+'<p>'+escapeHtml((r.insight||r.trigger||'내용 없음').slice(0,90))+'</p></div>').join(''):'<div class="empty">'+(!canEdit()?'로그인 후 기록을 불러옵니다.':q||day?'검색 결과가 없습니다.':'저장된 기록이 없습니다.')+'</div>';
    el('entries').querySelectorAll('.entry').forEach(node=>{const fn=()=>openRecord(node.dataset.id);node.onclick=fn;node.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();fn();}};});
  }
  function fill(r) {
    draftView();resetImages(r.images||[]);imageNotice('');
    currentId=r.id;currentBase={...r,images:(r.images||[]).map(v=>({...v}))};requestId=r.id;
    ids.forEach(k=>el(k).value=r[k]||'');dirty=false;el('editorTitle').textContent='기록 수정하기';el('deleteBtn').classList.remove('hidden');status('');generate();
  }
  async function openRecord(id) {
    if(busy || imageWorking || !canEdit())return;
    const t=token();if(!await keepView()||!live(t)||busy||imageWorking)return;
    const r=records.find(v=>v.id===id&&!v.deletedAt);if(!r)return;fill(r);window.scrollTo({top:0,behavior:'smooth'});
  }
  async function reset() {const t=token();if(busy||imageWorking||!canEdit()||!await keepView()||!live(t)||busy||imageWorking)return;clearEditor();}
  function persistLocal(next) {
    // Never read, write, delete or automatically migrate lifeandway_reflection_v1.
    if(next.length>MAX_ROWS)throw Error('로컬 기록은 최대 5,000개입니다. 백업한 뒤 기록을 정리하거나 클라우드를 사용해 주세요.');
    const currentRaw=localStorage.getItem(LOCAL);
    if(currentRaw!==localBaseline)throw Error('다른 탭에서 로컬 기록이 변경되어 덮어쓰기를 중단했습니다. 현재 입력을 TXT로 보관하고 로컬 모드를 다시 열어 최신 기록을 확인해 주세요.');
    const nextRaw=JSON.stringify(next);
    localStorage.setItem(LOCAL,nextRaw);
    localBaseline=nextRaw;
  }
  function checkLocalBase(){const match=records.find(r=>r.id===(currentId||requestId));if(currentBase?(!match||match.updatedAt!==currentBase.updatedAt||match.version!==currentBase.version):!!match)throw Error('원본 로컬 기록이 변경 또는 삭제되어 덮어쓰지 않았습니다. 임시본과 입력은 유지됩니다.');}
  function localSave() {checkLocalBase();
    const d=data(); const now=new Date().toISOString();
    const r={...d,id:currentId || requestId,createdAt:currentBase?.createdAt||now,updatedAt:now,version:(currentBase?.version||0)+1};
    const next=records.filter(v=>v.id!==r.id).concat(r);persistLocal(next);records=next;const cleanup=retireDraft();fill(r);render();status('이 브라우저에만 저장되었습니다. 클라우드 동기화되지 않습니다.');return cleanup;
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
    if(!user || busy || imageWorking)return;
    if(!navigator.onLine){cloudError('오프라인입니다. 입력은 유지됩니다. 이 화면을 닫기 전 TXT로 보관해 주세요.');return;}
    const t=token(), mine={...data(),id:currentId||requestId};const base=currentBase?{...currentBase}:null;
    busy=true;lock();cloudError('');
    try {
      let reply;
      if(!deleting)mine.images=await stageImages(mine.images,t);
      if(!live(t))return;
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
      await retireDraft();if(!live(t))return;if(deleting)clearEditor();else fill(saved);
      render();status(deleting?'클라우드에서 삭제되었습니다.':'클라우드 저장 완료');
      el('lastSync').textContent='마지막 동기화: '+new Date().toLocaleString('ko-KR');
      await cleanupImages(base?.images,deleting?[]:saved.images,t);
    }catch(err){if(live(t)){dirty=true;status('저장 실패 · 입력 유지');cloudError((/retir|reflection_image_gc|image.*(reference|unavailable)|정리된|폐기|이미지.*참조/i.test(String(err?.message||''))?'이미 정리된 사진 경로가 포함되어 저장이 거절됐을 수 있습니다. 입력은 유지됩니다. 해당 첨부를 빼고 원본 파일을 다시 선택하거나, 충돌 창에서 사진을 복사한 새 기록으로 저장하세요. ':'')+'클라우드 저장을 확인하지 못했습니다. 입력과 사진 업로드 경로·변환본은 이 화면에 유지됩니다. 같은 화면에서 재시도해 주세요. 이미 저장됐을 가능성이 있는 사진은 삭제하지 않습니다. TXT에는 사진이 포함되지 않습니다. 새 기록은 동일 ID로 재시도합니다.');}}
    finally{if(live(t)){busy=false;lock();}}
  }
  async function save() {
    if(busy||imageWorking||!canEdit())return;
    if(uncertainty&&!confirm('복구되지 않은 사진이 있을 수 있습니다: '+uncertainty+' 현재 보이는 첨부만 기록에 저장할까요?'))return;
    const d=data();if(![d.insight,d.experience,d.action].some(Boolean)){status('성찰 질문 중 하나 이상 작성해 주세요.');return;}
    if(!validDate(d.date) || (d.deadline&&!validDate(d.deadline))){status('유효한 기록 날짜와 실행 기한을 입력해 주세요.');return;}
    if(ids.some(k=>d[k].length>200000)){status('한 입력칸은 200,000자 이내로 작성해 주세요.');return;}
    if(localMode){try{await localSave();}catch(err){status((err.message||'브라우저 저장 실패')+' · 입력 유지. TXT로 보관해 주세요.');}return;}
    await cloudWrite(false);
  }
  async function remove() {
    if(busy||imageWorking||!currentId||!canEdit()||!confirm('이 기록을 삭제할까요? 삭제 전 JSON 백업을 권장합니다.'))return;
    if(localMode){try{const next=records.filter(r=>r.id!==currentId);checkLocalBase();persistLocal(next);records=next;const cleanup=retireDraft();clearEditor();render();status('로컬 기록을 삭제했습니다.');await cleanup;}catch(err){status((err.message||'삭제 저장 실패')+' 기존 화면과 입력은 유지됩니다.');}return;}
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
      // Never silently discard an attachment, even on an otherwise invalid row.
      const images=validateImages(row?.images,null,true);
      if(!row || typeof row!=='object' || typeof row.id!=='string' || !row.id.trim() || row.id.length>200 || !validDate(row.date) || (row.deadline&&!validDate(row.deadline)) || ids.some(k=>row[k]!==undefined&&(typeof row[k]!=='string'||row[k].length>200000)) || row.deleted_at || row.deletedAt) {invalid++;continue;}
      if(seen.has(row.id)){duplicates++;continue;}seen.add(row.id);
      valid.push({...Object.fromEntries(ids.map(k=>[k,typeof row[k]==='string'?row[k]:''])),images,id:row.id,createdAt:row.createdAt||row.created_at,updatedAt:row.updatedAt||row.updated_at});
    }
    return {valid,invalid,duplicates,total:list.length};
  }
  async function importBackup(event) {
    const file=event.target.files?.[0];if(!file)return;
    event.target.value=''; if(busy||imageWorking||!canEdit())return;
    const t=token();busy=true;lock();
    let successful=0,failed=0,skipped=0;
    try {
      if(file.size>MAX_FILE)throw Error('사진 포함 JSON 백업 파일은 100MB 이하로 나누어 주세요.');
      const parsed=JSON.parse(await file.text());if(!live(t))return;
      const check=validateBackup(parsed);
      for(const row of check.valid)for(const image of row.images){await verifyBlob(dataURLBlob(image.dataURL,image),image);if(!live(t))return;}
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
          const importStages=importImageStages.get(r.id)||new Map();
          importImageStages.set(r.id,importStages);
          const prepared={...r,images:await stageImages(r.images,t,importStages)};
          if(!live(t))return;
          const {data:rows,error}=await t.client.from(TABLE).insert(toPayload(prepared,t.userId)).select('*');
          if(!live(t))return;
          if(error){if(error.code==='23505')skipped++;else failed++;}else if(rows?.[0]){records.push(toRecord(rows[0]));importImageStages.delete(r.id);successful++;}else failed++;
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
    if(!canEdit()||!confirm('로그아웃하면 이 기기·브라우저에서 현재 계정(로컬 모드는 로컬 영역)의 모든 임시본과 미저장 입력을 삭제합니다. 저장한 기록은 유지합니다. 로그아웃할까요?'))return;
    const c=client,s=shelf;const target=s?.scope??(localMode?'local':config.url+'|'+user.id);
    // Set the owner fence before scrubbing or broadcasting sign-out. Do not flush.
    let purged;try{purged=(s?s.purge():window.LWDrafts.purge(target)).then(()=>true,()=>false);}catch(_){purged=Promise.resolve(false);}
    try{localStorage.setItem('lw_autodraft_qa_v2_logout',JSON.stringify({target,nonce:uid()}));}catch(_){}
    detach();clearAuthStorage();scrub(false);cloudError('로그아웃했습니다. 기기 임시본을 정리하고 있습니다.');
    const done=await purged;if(!canEdit())cloudError(done?'로그아웃했습니다. 이 계정의 기기 임시본을 삭제했습니다.':'로그아웃했습니다. 임시본 삭제를 확인하지 못했습니다. 공용 기기에서는 브라우저의 이 사이트 데이터도 삭제하세요.');
    // Removing the persisted token and detaching events happens BEFORE any network I/O.
    if(c){try{const {error}=await c.auth.signOut({scope:'local'});if(error&&!user&&!localMode)cloudError('이 브라우저에서 로그아웃했습니다. 서버 연결 오류로 세션 만료 확인은 못 했습니다. 공용 기기에서는 브라우저 데이터도 삭제해 주세요.');}catch(_){}}
  }
  async function authAction(kind) {
    if(busy||imageWorking)return;
    let authToken=null;
    const viewToken=token();if(!await keepView()||!live(viewToken))return;
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
      const redirect=location.origin+location.pathname;
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
      if((kind==='login'||kind==='signup')&&result.data?.session?.user)await verifiedSession(c,result.data.session.user.id);
    } catch(err) {if(!authToken||live(authToken))el('authMessage').textContent=err.message || '인증에 실패했습니다.';}
    finally{if(!authToken||live(authToken)){busy=false;lock();}}
  }
  async function enterLocal() {
    if(busy||imageWorking)return;
    if(!confirm('이 모드는 클라우드 계정과 별개이며, 이 브라우저를 사용하는 사람은 로컬 기록을 다시 열 수 있습니다. 공용 기기에서는 사용하지 마세요. V3 저장소가 아직 없으면 V2 로컬 기록을 읽어오며, 처음 저장할 때 V3 전용 저장소에 복사합니다. V2 원본은 수정하거나 삭제하지 않습니다. 이후 구버전 앱의 로컬 수정은 자동 동기화되지 않습니다. V1 기록은 읽거나 업로드하지 않습니다. 계속할까요?'))return;
    const t=token();if(!await keepView()||!live(t))return;
    const previous=client;detach();clearAuthStorage();scrub();localMode=true;
    let loadedLegacy=false;
    try {
      const storedRaw=localStorage.getItem(LOCAL);
      const legacyRaw=storedRaw===null?localStorage.getItem(LEGACY_LOCAL):null;
      const raw=JSON.parse((storedRaw===null?legacyRaw:storedRaw)||'[]');
      const check=validateBackup(raw);
      if(check.invalid||check.duplicates||check.valid.length!==check.total)throw Error('손상 또는 중복된 로컬 기록');
      // Baseline always describes the new key, never the read-only V2 source.
      localBaseline=storedRaw;loadedLegacy=storedRaw===null&&legacyRaw!==null;
      const versions=new Map((Array.isArray(raw)?raw:raw.records).map(r=>[r.id,Number.isInteger(r.version)?r.version:1]));records=check.valid.map(r=>({...r,version:versions.get(r.id)}));
    }
    catch(_){cloudError('로컬 기록을 읽지 못했습니다. 기존 저장 데이터는 삭제하지 않았습니다. 백업이 필요하면 기존 파일을 보관해 주세요.');localMode=false;records=[];}
    if(localMode)activateShelf();clearEditor();render();lock();
    if(localMode)cloudError(loadedLegacy?'V2 로컬 기록을 읽었습니다. 아직 V3 저장소에 쓰지 않았습니다. 처음 저장하면 불러온 기록 전체를 V3 전용 저장소에 복사합니다. V2 원본은 보존되며 이후 구버전 앱의 로컬 수정은 자동 동기화되지 않습니다.':'V3 전용 로컬 저장소를 사용합니다. V2 원본은 보존되며 구버전 앱의 로컬 수정은 자동 동기화되지 않습니다.');
    if(localMode){await afterSync();lock();}
    if(previous)previous.auth.signOut({scope:'local'}).catch(()=>{});
  }
  function bind() {
    el('chooseImages').onclick=()=>{if(canEdit()&&!busy&&!imageWorking)el('imageFile').click();};
    el('imageFile').onchange=chooseImages;
    ids.forEach(id=>el(id).addEventListener('input',()=>{if(!canEdit())return;dirty=true;collect();status('저장 전');generate();}));
    document.querySelectorAll('[data-mode]').forEach(btn=>{btn.setAttribute('role','tab');btn.setAttribute('aria-selected',String(btn.classList.contains('active')));btn.onclick=()=>{mode=btn.dataset.mode;document.querySelectorAll('[data-mode]').forEach(b=>{b.classList.toggle('active',b===btn);b.setAttribute('aria-selected',String(b===btn));});if(canEdit())generate();};});
    document.querySelectorAll('[data-close]').forEach(button=>button.onclick=()=>{const dialog=button.closest('dialog');if(dialog){dialog.close();if(dialog.id==='conflictDialog')clearConflict();}});
    el('conflictDialog').addEventListener('cancel',clearConflict);
    el('conflictDialog').addEventListener('close',clearConflict);
    el('saveBtn').onclick=save;el('newBtn').onclick=reset;el('deleteBtn').onclick=remove;
    el('search').oninput=render;if(el('dateFilter'))el('dateFilter').oninput=render;
    el('syncBtn').onclick=sync;el('logoutBtn').onclick=logout;el('localBtn').onclick=enterLocal;
    el('authBtn').onclick=()=>{if(!config){showDialog('configDialog');return;}showDialog('authDialog');};
    el('configBtn').onclick=()=>{el('projectUrl').value=config?.url||'';el('publishableKey').value=config?.key||'';showDialog('configDialog');};
    el('configForm').onsubmit=async e=>{e.preventDefault();if(busy||imageWorking)return;try{const next=validateConfig(el('projectUrl').value,el('publishableKey').value);const t=token();if(!await keepView()||!live(t))return;const old=client;detach();clearAuthStorage();scrub();config=next;localStorage.setItem(CONFIG,JSON.stringify(config));el('configDialog').close();if(old)old.auth.signOut({scope:'local'}).catch(()=>{});cloudError('연결 설정을 저장했습니다. 로그인 후 전용 테이블과 RLS 연결을 확인하세요.');initialSession();}catch(err){el('configMessage').textContent=err.message||'설정을 저장하지 못했습니다.';}};
    el('authForm').onsubmit=e=>{e.preventDefault();authAction('login');};
    el('loginBtn').onclick=()=>authAction('login');el('signupBtn').onclick=()=>authAction('signup');el('resetPasswordBtn').onclick=()=>authAction('reset');el('updatePasswordBtn').onclick=()=>authAction('update');
    el('copyBtn').onclick=async()=>{if(!canEdit())return;const text=generate();try{await navigator.clipboard.writeText(text);status('글을 복사했습니다. 사진은 포함되지 않습니다.');}catch(_){const ta=document.createElement('textarea');ta.value=text;document.body.appendChild(ta);ta.select();const ok=document.execCommand('copy');ta.remove();status(ok?'글을 복사했습니다.':'복사가 제한되어 있습니다. 미리보기를 선택해 복사해 주세요.');}};
    el('downloadTxt').onclick=()=>{if(canEdit())download((data().title||'성찰기록').replace(/[\\/:*?"<>|]/g,'_')+'.txt',generate(),'text/plain;charset=utf-8');};
    el('exportBtn').onclick=exportBackup;
    el('importBtn').onclick=()=>{if(!busy&&canEdit())el('importFile').click();};el('importFile').onchange=importBackup;
    el('conflictCancel').onclick=()=>{el('conflictDialog').close();clearConflict();status('충돌 취소 · 입력은 유지됩니다.');};
    el('conflictLoad').onclick=async()=>{if(!conflict||conflict.epoch!==epoch||conflict.owner!==user?.id)return;const before=conflict,r=conflict.remote;if(!await keepView()||before!==conflict)return;el('conflictDialog').close();if(r&&!r.deletedAt){records=records.filter(v=>v.id!==r.id).concat(r);fill(r);}else{if(r)records=records.filter(v=>v.id!==r.id).concat(r);clearEditor();}clearConflict();render();};
    el('conflictNew').onclick=async()=>{
      if(!conflict||busy||imageWorking||conflict.epoch!==epoch||conflict.owner!==user?.id)return;
      if(!confirm('기존 서버 기록은 변경하지 않고 사진을 새로 복사해 별도 기록으로 저장할까요?'))return;
      const t=token(),originalConflict=conflict,mine=conflict.mine;let copied=null,ready=false;imageWorking=true;lock();
      try{copied=await cloneImagesForNewRecord(mine.images||[],t);if(!live(t)||conflict!==originalConflict)return;
        el('conflictDialog').close();currentId=null;currentBase=null;requestId=uid();resetImages(copied);ids.forEach(k=>el(k).value=mine[k]||'');dirty=true;clearConflict();ready=true;
      }catch(err){if(live(t)){copied=null;cloudError('새 기록의 사진 복사 실패: '+err.message+' 현재 입력은 유지됩니다. 사진이 이미 정리됐다면 해당 첨부를 빼고 파일을 다시 선택한 뒤 저장하세요.');}}
      finally{if(live(t)){imageWorking=false;lock();}}
      if(ready&&live(t)&&!conflict){collect();void flushFull();await save();}
    };
    el('draftPick').onclick=pickDraft;
    el('draftOn').onchange=()=>{if(!draftOn()&&(dirty||imageWorking)){el('draftOn').checked=true;dNote('편집 중에는 임시저장을 끌 수 없습니다. 기록을 저장하거나 임시본을 폐기한 뒤 변경하세요.');return;}if(draftOn()&&dirty)collect();else dNote(draftOn()?'임시저장 대기':'임시저장 꺼짐 (이 화면)');};
    window.addEventListener('pagehide',e=>{boundary();if(!e?.persisted)unpin();});
    document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')boundary();});
    window.addEventListener('beforeunload',e=>{if((dirty&&(!draftOn()||!(draft?draft.full&&draft.journalOK&&!draft.pending&&!draft.uncertainty:source&&!uncertainty)))||busy||imageWorking){e.preventDefault();e.returnValue='';}});
    window.addEventListener('offline',()=>cloudError('오프라인입니다. 입력은 유지되지만 클라우드 저장되지 않습니다. 화면을 닫기 전 TXT로 보관하세요.'));
    window.addEventListener('online',()=>{if(user)cloudError('인터넷이 다시 연결되었습니다. 지금 동기화를 누르세요. 미저장 입력은 자동 업로드되지 않습니다.');});
    // If another tab signs out, remove all private in-memory content here too.
    window.addEventListener('storage',e=>{if(e.key===LOCAL && localMode){cloudError('다른 탭에서 로컬 기록이 변경되었습니다. 이 화면을 덮어쓰지 않았습니다. 미저장 입력을 TXT로 보관한 뒤 로컬 모드를 다시 열어 주세요.');return;}if(shelf&&e.key===shelf.marker&&e.newValue!==shelf.lease){detach();scrub(false);cloudError('다른 탭의 명시적 로그아웃으로 잠갔습니다.');return;}let explicit=false;if(e.key==='lw_autodraft_qa_v2_logout'){try{explicit=JSON.parse(e.newValue)?.target===shelf?.scope;}catch(_){explicit=!!user;}}if(explicit){detach();scrub(false);cloudError('다른 탭에서 로그아웃되어 화면을 잠갔습니다.');}else if(e.key===authStorageKey()&&!e.newValue&&user)void reconcileSession(client);});
    window.addEventListener('pageshow',e=>{if(e.persisted && user){detach();scrub();initialSession();}});
  }
  function generate(){const filled=['insight','experience','action'].filter(k=>clean(el(k).value)).length;el('progressFill').style.width=(filled/3*100)+'%';el('progressLabel').textContent=filled+' / 3';const d=data(),t=d.title||'오늘의 성찰',i=d.insight,x=d.experience,a=d.action,s=d.trigger,deadline=d.deadline?` (실행 기한: ${fmtDate(d.deadline)})`:'';let out='';if(mode==='threads'){out=[t,s?`오늘 ${s}에서 생각이 시작됐다.`:'',i,x?`내 경험을 돌아보면, ${x}`:'',a?`그래서 나는 ${a}${deadline}`:'','내가 오늘의 생각을 기록하는 이유는, 배운 것을 내 것으로 만들기 위해서다.'].filter(Boolean).join('\n\n')}else if(mode==='linkedin'){out=[t,s?`최근 ${s}을(를) 계기로 일하는 방식을 다시 생각했습니다.`:'',i?`제가 깨달은 점은 이렇습니다.\n${i}`:'',x?`실제 경험에서도 비슷한 장면이 있었습니다.\n${x}`:'',a?`앞으로의 실행 계획은 명확합니다.\n${a}${deadline}`:'','여러분은 비슷한 경험이 있으신가요?'].filter(Boolean).join('\n\n')}else{out=[`# ${t}`,`기록일: ${fmtDate(d.date)}`,s?`## 생각의 시작\n${s}`:'',i?`## 오늘의 깨달음\n${i}`:'',x?`## 내 경험에서 발견한 장면\n${x}`:'',a?`## 앞으로의 실천\n${a}${deadline}`:'',`## 오늘의 마무리\n배운 내용을 내 언어와 행동으로 바꾸는 연습을 이어가려 한다.`].filter(Boolean).join('\n\n')}if(d.tags){out+='\n\n'+d.tags.split(',').map(v=>v.trim().replace(/^#/, '').replace(/\s+/g,'')).filter(Boolean).map(v=>'#'+v).join(' ')}el('preview').textContent=out;el('count').textContent=out.length;return out}
  try {const value=JSON.parse(localStorage.getItem(CONFIG)||'null') || window.LW_DEFAULT_CONFIG;if(value)config=validateConfig(value.url,value.key);}catch(_){config=null;}
  bind();clearEditor();render();lock();
  if(location.protocol==='file:')cloudError('클라우드 인증은 HTTPS 배포 주소에서 사용하세요. 로컬 파일은 디자인 확인용입니다.');
  if(window.__LW_ENABLE_TESTS===true)window.__LW_TEST={validateBackup,validateConfig,validDate,escapeHtml,toRecord,toPayload,imageMeta,validateImages,magicMime,dataURLBlob};
  initialSession();
})();
