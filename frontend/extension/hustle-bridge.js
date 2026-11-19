(() => {
  if (window.__hustleBridgeReady) return;
  window.__hustleBridgeReady = true;
  const respond = (id, data) => window.postMessage({source:'hustle-extension',id,...data},location.origin);
  window.addEventListener('message', event => {
    const message=event.data;
    if(event.source!==window || event.origin!==location.origin || message?.source!=='hustle-page' || typeof message.id!=='string')return;
    if(message.type==='PING') {respond(message.id,{success:true,version:chrome.runtime.getManifest().version});return;}
    const map={CONNECT:'HUSTLE_CONNECT',REFRESH_SESSION:'HUSTLE_REFRESH_SESSION',MOODLE_COURSES:'HUSTLE_MOODLE_COURSES',MOODLE_SYNC_COURSE:'HUSTLE_MOODLE_SYNC_COURSE'};
    const action=map[message.type];
    if(!action)return;
    chrome.runtime.sendMessage({type:action,moodleOrigin:message.moodleOrigin,courseId:message.courseId,courseTitle:message.courseTitle,shortname:message.shortname}, result => {
      if(chrome.runtime.lastError)respond(message.id,{success:false,error:'Онови сторінку після встановлення розширення.'});
      else respond(message.id,result || {success:false,error:'Не вдалося підключитися.'});
    });
  });
})();
