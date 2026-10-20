// Core booking transactions shared by the two static sites. Security Rules are
// authoritative; client checks improve feedback but grant no write permission.
export const BOOKING_ROOT = 'artifacts/ibsh-pta-v2';
const P = {config:BOOKING_ROOT+'/public/system_settings',events:BOOKING_ROOT+'/events',
    teachers:BOOKING_ROOT+'/public/data/teachers',bookings:BOOKING_ROOT+'/private_bookings',
    profiles:BOOKING_ROOT+'/private_profiles',ledgers:BOOKING_ROOT+'/booking_ledgers',
    guards:BOOKING_ROOT+'/schedule_guards',receipts:BOOKING_ROOT+'/operation_receipts',
    accounts:BOOKING_ROOT+'/account_states',outbox:BOOKING_ROOT+'/notification_outbox'};
const requireValue = (ok,message) => { if(!ok)throw Error(message); };
const id = value => { requireValue(typeof value==='string'&&/^[A-Za-z0-9_-]{1,120}$/.test(value),'Invalid identifier');return value; };
export async function bookingHash(value) {
    const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));
    return Array.from(new Uint8Array(bytes),n=>n.toString(16).padStart(2,'0')).join('');
}
function decode(value) {
    if('nullValue' in value)return null;
    if('stringValue' in value)return value.stringValue;
    if('booleanValue' in value)return value.booleanValue;
    if('integerValue' in value)return Number(value.integerValue);
    if('doubleValue' in value)return value.doubleValue;
    if('timestampValue' in value)return value.timestampValue;
    if('arrayValue' in value)return (value.arrayValue.values||[]).map(decode);
    if('mapValue' in value)return decodeFields(value.mapValue.fields||{});
    throw Error('Unsupported configuration value');
}
function decodeFields(fields) { return Object.fromEntries(Object.entries(fields||{}).map(([key,value])=>[key,decode(value)])); }
function isAdmin(claims) { return claims.email_verified===true&&claims.firebase?.sign_in_provider==='google.com'&&['ptaopenhour@ibsh.tw','pta.admin@ibsh.tw'].includes(claims.email); }

export function createFirestoreBookingAPI({db,auth,sdk,fetchImpl=globalThis.fetch,projectId=db?.app?.options?.projectId}) {
    const {doc,runTransaction,serverTimestamp,deleteField}=sdk;
    const ref=path=>doc(db,path);
    const readMany=async(tx,paths)=>new Map(await Promise.all([...new Set(paths)].map(async path=>{
        const snapshot=await tx.get(ref(path));return [path,snapshot.exists()?snapshot.data():null];
    })));
    async function actor() {
        const user=auth.currentUser;requireValue(user,'Sign in first');
        const {claims}=await user.getIdTokenResult();return {uid:user.uid,claims,email:claims.verifiedEmail,admin:isAdmin(claims)};
    }
    async function parentIdentity(a) {
        requireValue(typeof a.email==='string'&&a.email===a.email.toLowerCase().trim(),'Verify your email again');
        const key=await bookingHash(a.email);
        requireValue(a.claims.parentAccountKey===key&&a.claims.parentAccountVersion,'Verify your email again');return key;
    }
    function active(state,a) { requireValue(state?.status==='active'&&state.version===a.claims.parentAccountVersion,'Account access ended. Please verify your email again'); }
    function replay(receipt,fingerprint) {
        if(!receipt)return null;
        requireValue(receipt.fingerprint===fingerprint,'Request ID already used for another operation');return receipt.result;
    }
    function notice(tx,booking,kind,recipient,noticeId,now) {
        tx.set(ref(P.outbox+'/'+noticeId),{id:noticeId,email:booking.email,recipient,bookingId:booking.id,eventId:booking.eventId,
            kind,payload:booking,status:'pending',attempts:0,createdAt:now,nextAttemptAt:0,committedAt:serverTimestamp()});
    }
    function complete(tx,a,data,fingerprint,result,accountKey,operation,booking,now) {
        tx.set(ref(P.receipts+'/'+operation.receiptId),{uid:a.uid,accountKey,createdAt:now,fingerprint,result,
            kind:data.action,bookingId:booking.id,requestId:data.requestId,committedAt:serverTimestamp()});
    }
    async function book(data) {
        ['requestId','eventId','teacherId','slotId','childId','parentId'].forEach(key=>id(data[key]));
        const a=await actor(),key=await parentIdentity(a),receiptId=await bookingHash(a.uid+'|'+data.requestId),fingerprint=await bookingHash(JSON.stringify(data));
        const ledgerId=await bookingHash([data.eventId,a.email,data.childId].join('|'));
        const paths={account:P.accounts+'/'+key,receipt:P.receipts+'/'+receiptId,event:P.events+'/'+data.eventId,
            teacher:P.teachers+'/'+data.teacherId,slot:P.teachers+'/'+data.teacherId+'/slots/'+data.slotId,
            profile:P.profiles+'/'+a.email,guard:P.guards+'/'+data.teacherId};
        return runTransaction(db,async tx=>{
            const cache=await readMany(tx,[P.config,...Object.values(paths)]);active(cache.get(paths.account),a);
            const existing=replay(cache.get(paths.receipt),fingerprint);if(existing)return existing;
            const config=cache.get(P.config),event=cache.get(paths.event),teacher=cache.get(paths.teacher),slot=cache.get(paths.slot),profile=cache.get(paths.profile);
            requireValue(config?.apiVersion===3&&config.eventId===data.eventId,'Activity changed; refresh the page');
            // Server time and the window are enforced by Security Rules at commit.
            requireValue(config.enabled===true&&event?.enabled===true,'Booking is paused');
            requireValue(teacher,'Teacher not found');
            requireValue(slot?.eventId===data.eventId&&slot.status==='available'&&!slot.bookingRef,'This slot is no longer available');
            requireValue(profile,'Add child and parent profiles first');
            const childIndex=profile.children.findIndex(child=>child.id===data.childId),parentIndex=profile.parents.findIndex(parent=>parent.id===data.parentId);
            requireValue(childIndex>=0&&parentIndex>=0,'Selected child or parent does not belong to this account');
            const child=profile.children[childIndex],parent=profile.parents[parentIndex];
            const now=Date.now(),bookingId=receiptId,notificationId=data.sendReminder===true?bookingId+'-confirmation':null;
            const booking={id:bookingId,schemaVersion:3,eventId:data.eventId,uid:a.uid,email:a.email,childId:child.id,parentId:parent.id,
                student:child.name,grade:child.grade||'',parent:parent.name,parentRelation:parent.relation||'',teacherId:data.teacherId,
                teacherName:teacher.name,teacherEmail:teacher.email||'',location:teacher.location||'',slotId:data.slotId,slotDate:slot.date,slotTime:slot.time,
                message:String(data.message||'').trim().slice(0,300),sendReminder:data.sendReminder===true,createdAt:new Date(now).toISOString(),notificationId,
                requestId:data.requestId,childIndex,parentIndex,committedAt:serverTimestamp()};
            const operation={kind:'book',teacherId:data.teacherId,bookingId,requestId:data.requestId};
            // Merge only this teacher entry. Rules inspect the real before/after
            // map for uniqueness and the ten-teacher limit. No quota read is
            // exposed to the browser, including pre-lifecycle private ledgers.
            tx.set(ref(P.ledgers+'/'+ledgerId),{teachers:{[data.teacherId]:bookingId},accountKey:key,operation,committedAt:serverTimestamp()},{merge:true});
            tx.set(ref(paths.guard),{version:(cache.get(paths.guard)?.version||0)+1,operation,committedAt:serverTimestamp()});
            tx.set(ref(P.bookings+'/'+bookingId),booking);
            tx.set(ref(paths.slot),{...slot,status:'booked',bookingRef:bookingId,bookedAt:now,lockedAt:null,lockedBy:null,committedAt:serverTimestamp()});
            if(notificationId)notice(tx,booking,'confirmation',a.email,notificationId,now);
            const result={bookingId,notificationId,notificationStatus:notificationId?'pending':'not_requested',accountKey:key};
            complete(tx,a,data,fingerprint,result,key,{receiptId},booking,now);return result;
        });
    }
    async function cancel(data) {
        id(data.requestId);id(data.bookingId);
        const a=await actor(),key=a.admin?null:await parentIdentity(a),receiptId=await bookingHash(a.uid+'|'+data.requestId),fingerprint=await bookingHash(JSON.stringify(data));
        return runTransaction(db,async tx=>{
            const first=[P.receipts+'/'+receiptId,P.bookings+'/'+data.bookingId];if(key)first.push(P.accounts+'/'+key);
            const cache=await readMany(tx,first);if(key)active(cache.get(P.accounts+'/'+key),a);
            const existing=replay(cache.get(P.receipts+'/'+receiptId),fingerprint);if(existing)return existing;
            const booking=cache.get(P.bookings+'/'+data.bookingId);requireValue(booking,'Booking no longer exists; refresh the list');
            requireValue(a.admin||booking.email===a.email,'This booking does not belong to you');
            requireValue(booking.schemaVersion===3&&booking.id===data.bookingId&&booking.eventId&&booking.childId,'Legacy booking requires review before cancellation');
            const accountKey=await bookingHash(booking.email),lp=P.ledgers+'/'+await bookingHash([booking.eventId,booking.email,booking.childId].join('|')),
                sp=P.teachers+'/'+id(booking.teacherId)+'/slots/'+id(booking.slotId),gp=P.guards+'/'+booking.teacherId;
            const more=await readMany(tx,[sp,gp,...(booking.notificationId?[P.outbox+'/'+booking.notificationId]:[])]);
            const slot=more.get(sp),confirmation=booking.notificationId?more.get(P.outbox+'/'+booking.notificationId):null;
            requireValue(slot?.status==='booked'&&slot.bookingRef===booking.id&&slot.eventId===booking.eventId,'Slot ownership changed; contact the school');
            const now=Date.now(),operation={kind:'cancel',teacherId:booking.teacherId,bookingId:booking.id,requestId:data.requestId};
            tx.set(ref(lp),{teachers:{[booking.teacherId]:deleteField()},accountKey,operation,committedAt:serverTimestamp()},{merge:true});
            tx.set(ref(gp),{version:(more.get(gp)?.version||0)+1,operation,committedAt:serverTimestamp()});
            tx.set(ref(sp),{...slot,status:'available',bookingRef:null,bookedAt:null,lockedAt:null,lockedBy:null,committedAt:serverTimestamp()});
            tx.delete(ref(P.bookings+'/'+booking.id));
            if(confirmation&&['pending','deferred'].includes(confirmation.status))tx.set(ref(P.outbox+'/'+booking.notificationId),{...confirmation,status:'superseded'});
            const notificationId=booking.id+'-cancellation';notice(tx,booking,'cancellation',booking.email,notificationId,now);
            if(booking.teacherEmail)notice(tx,booking,'teacherCancellation',booking.teacherEmail,booking.id+'-teacher-cancellation',now);
            const result={cancelled:true,notificationId,notificationStatus:'pending',accountKey};
            complete(tx,a,data,fingerprint,result,accountKey,{receiptId},booking,now);return result;
        });
    }
    async function status(data={}) {
        requireValue(auth.currentUser&&projectId,'Sign in first');let eventId=data.eventId;
        for(let attempt=0;attempt<3;attempt++){
            const names=[P.config,...(eventId?[P.events+'/'+id(eventId)]:[])];
            const token=await auth.currentUser.getIdToken(),prefix='projects/'+projectId+'/databases/(default)/documents/';
            const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),15000);
            let rows;
            try{
                const response=await fetchImpl('https://firestore.googleapis.com/v1/projects/'+projectId+'/databases/(default)/documents:batchGet',{
                    method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},
                    body:JSON.stringify({documents:names.map(name=>prefix+name)}),signal:controller.signal});
                requireValue(response.ok,'Unable to verify availability. Please retry.');rows=await response.json();
            }finally{clearTimeout(timeout);}
            requireValue(Array.isArray(rows)&&rows.length===names.length,'Unable to verify availability. Please retry.');
            const docs=new Map(rows.filter(row=>row.found).map(row=>[row.found.name.slice(prefix.length),decodeFields(row.found.fields)]));
            const config=docs.get(P.config);requireValue(config?.apiVersion===3&&config.eventId,'Booking setup incomplete; contact the school');
            if(config.eventId!==eventId){eventId=id(config.eventId);continue;}
            const event=docs.get(P.events+'/'+eventId),serverNow=Math.max(...rows.map(row=>Date.parse(row.readTime)));
            requireValue(event?.schemaVersion===3&&Number.isFinite(serverNow),'Unable to verify the server time. Please retry.');
            const paused=config.enabled===false&&event.enabled===false,ended=Number.isFinite(event.endMs)&&serverNow>=event.endMs;
            return {eventId,serverNow,open:config.enabled===true&&event.enabled===true&&Number.isFinite(event.startMs)&&Number.isFinite(event.endMs)&&event.startMs<=serverNow&&serverNow<event.endMs,
                start:config.start,end:config.end,announcement:config.announcement,accountDeletionAllowed:paused&&ended,
                accountDeletionReason:paused&&ended?'':'Account deletion requires bookings to be Paused AND the registration deadline to have passed.'};
        }
        throw Error('Activity changed; refresh the page');
    }
    return async data=>{
        try{
            requireValue(['book','cancel','status'].includes(data.action),'Unsupported direct booking action');
            const result=await ({book,cancel,status}[data.action])(data);return {ok:true,apiVersion:3,...result};
        }catch(error){
            const uncertain=['unavailable','deadline-exceeded','unknown'].includes(error.code);
            return {ok:false,apiVersion:3,uncertain,code:error.code,error:error.code==='permission-denied'?
                'The booking was not changed. Refresh My Bookings and availability; the booking window, slot, or child\'s teacher limit may have changed.':
                uncertain?'Connection interrupted. Refresh your bookings before retrying the same operation.':error.message};
        }
    };
}

export async function directFirestoreAPI(db,auth) {
    const sdk=await import('https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js');
    return createFirestoreBookingAPI({db,auth,sdk});
}
