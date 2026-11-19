async function approvedConnection(moodleOrigin, portalUrl) {
  const stored=await chrome.storage.local.get(['hustleConnections']);
  return stored.hustleConnections?.[moodleOrigin]===portalUrl;
}
async function resolveCurrentWorkspaceHeaders(portalUrl) {
  const response=await fetch(`${portalUrl}/api/workspace/session`,{credentials:'include'});
  if(!response.ok)throw new Error('Відкрий Hustle та увійди повторно.');
  const session=await response.json();
  if(!session.workspace_token)throw new Error('Не вдалося визначити навчальний простір.');
  return {'Content-Type':'application/json','X-Workspace-Token':session.workspace_token};
}
function portalFromSender(sender) {
  try {
    const url=new URL(sender.url);
    if(!sender.tab || !HUSTLE_CONFIG.portalOrigins.includes(url.origin))return null;
    if(!url.pathname.startsWith('/hustle/') && !url.pathname.startsWith('/prototype/'))return null;
    return url.origin;
  } catch {return null;}
}
chrome.runtime.onMessage.addListener((message,sender,sendResponse)=>{
  if(message?.type!=='HUSTLE_CONNECT' && message?.type!=='HUSTLE_REFRESH_SESSION')return false;
  const portal=portalFromSender(sender);
  if(!portal)return false;
  if(message.type==='HUSTLE_REFRESH_SESSION') {
    (async()=>{
      try {
        const stored=await chrome.storage.local.get(['hustleConnections']);
        const conns=stored.hustleConnections||{};
        let target=message.moodleOrigin?extractMoodleOrigin(message.moodleOrigin):null;
        if(!target)target=Object.keys(conns).find(origin=>conns[origin]===portal)||null;
        if(!target || conns[target]!==portal){sendResponse({success:false,paired:false,requiresConnection:true});return;}
        const result=await syncCookieForUrl(target,portal,true);
        sendResponse({success:Boolean(result.success),paired:Boolean(result.success),status:result.status,needsLogin:Boolean(result.needsLogin),error:result.error});
      } catch {sendResponse({success:false,paired:false});}
    })();
    return true;
  }
  const moodle=extractMoodleOrigin(message.moodleOrigin);
  if(!moodle) {sendResponse({success:false,error:'Ця LMS поки не підтримується розширенням.'});return false;}
  (async()=>{
    try {
      const stored=await chrome.storage.local.get(['hustleConnections']);
      await chrome.storage.local.set({portalUrl:portal,hustleConnections:{...stored.hustleConnections,[moodle]:portal}});
      const result=await syncCookieForUrl(moodle,portal,true);
      if(result.success)sendResponse({success:true,paired:true});
      else if (result.needsLogin || result.status === 401) {
        await chrome.tabs.create({url:`${moodle}/my/`});
        sendResponse({success:true,paired:false,requiresLogin:true});
      } else if (result.status === 502 || result.status === 403) {
        sendResponse({success:false,status:result.status,error:'Сервер університету заблокував перевірку з хмари (HTTP '+result.status+'). Відкрий курс у Moodle та синхронізуй його через кнопку розширення «До Hustle →».'});
      } else sendResponse({success:false,error:result.error||"Не вдалося перевірити сесію Moodle. Спробуй ще раз."});
    } catch {sendResponse({success:false,error:'Не вдалося підключити Moodle. Спробуй ще раз.'});}
  })();
  return true;
});
// Enable detection on Hustle tabs that were already open during installation.
chrome.runtime.onInstalled.addListener(async () => {
  for (const origin of HUSTLE_CONFIG.portalOrigins) {
    const tabs = await chrome.tabs.query({url:[origin+'/hustle/*',origin+'/prototype/*']});
    for (const tab of tabs) {
      try {await chrome.scripting.executeScript({target:{tabId:tab.id},files:['hustle-bridge.js']});} catch {}
    }
  }
});
