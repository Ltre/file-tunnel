// Render local demo data and compare the skin's geometry with the copied source CSS.
const fs=require('node:fs');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {chromium}=require('C:/Users/Dell/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

(async()=>{
  const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--disable-gpu','--no-first-run','--disable-background-networking']});
  const url=pathToFileURL(path.join(__dirname,'tunnel-prototype.html')).href;
  const screenshotDir=path.join(__dirname,'screenshots');
  fs.mkdirSync(screenshotDir,{recursive:true});
  const report={geometry:[],wide:null,dropdown:null,topbar:[],mobileHeaders:[],mobileFocus:[],controlCenter:null,previewStyles:null,fullscreenStyles:null,errors:[]};
  const open=async(width,height,query='')=>{const p=await browser.newPage({viewport:{width,height},deviceScaleFactor:1});p.on('pageerror',error=>report.errors.push(error.message));await p.goto(url+query);await p.evaluate(()=>document.fonts.ready);await p.waitForTimeout(450);return p;};
  const measure=p=>p.evaluate(()=>({
    topbar:Array.from(document.querySelectorAll('#tunnelTopbar,#tunnelTopbar *')).map(el=>{const s=getComputedStyle(el);return [s.backgroundColor,s.backgroundImage,s.color,s.borderColor,s.boxShadow];}),
    elements:Array.from(document.querySelectorAll('#tunnelTopbar,#tunnelTopbar *,#appShell,#appShell *')).map((el,index)=>{
      const s=getComputedStyle(el),r=el.getBoundingClientRect();if(s.display==='none'||!r.width||!r.height)return null;
      return {index,tag:el.tagName,id:el.id,rect:[r.x,r.y,r.width,r.height],radius:s.borderRadius,border:s.borderWidth,padding:s.padding,margin:s.margin,font:s.font};
    }).filter(Boolean)
  }));
  try{
    for(const [width,height,view] of [[1920,1080,'chat'],[1538,1023,'chat'],[1200,900,'chat'],[1024,900,'chat'],[390,844,'chat'],[390,844,'devices'],[390,844,'editor']]){
      const reference=await open(width,height,'?view='+view),base=await open(width,height,'?base=1&view='+view);
      const [a,b]=await Promise.all([measure(reference),measure(base)]);
      let differences=0;const bm=new Map(b.elements.map(value=>[value.index,value]));
      for(const item of a.elements){const other=bm.get(item.index);if(!other||item.tag!==other.tag||item.id!==other.id||item.radius!==other.radius||item.border!==other.border||item.padding!==other.padding||item.margin!==other.margin||item.font!==other.font||item.rect.some((x,i)=>Math.abs(x-other.rect[i])>.25))differences++;}
      differences+=b.elements.filter(item=>!a.elements.some(value=>value.index===item.index)).length;
      report.geometry.push({width,height,view,compared:a.elements.length,differences});
      const topbarOtherStyles=items=>items.map((item,index)=>index===0?[item[0],...item.slice(2)]:item);
      report.topbar.push({width,view,
        backgroundChanged:a.topbar[0][1]!==b.topbar[0][1],
        transparent:a.topbar[0][0]==='rgba(0, 0, 0, 0)'&&a.topbar[0][1]==='none',
        otherStylesSame:JSON.stringify(topbarOtherStyles(a.topbar))===JSON.stringify(topbarOtherStyles(b.topbar))
      });
      if(width===390){
        const mobile=await reference.evaluate(view=>{
          const top=getComputedStyle(document.querySelector('#tunnelTopbar'));
          const selected=getComputedStyle(document.querySelector('.mobile-workspace-button.active')).backgroundImage;
          const nav=getComputedStyle(document.querySelector('.mobile-workspace-nav')).backgroundColor;
          const header=view==='devices'?document.querySelector('.left-panel .panel-header'):view==='editor'?document.querySelector('.right-panel .panel-header'):null;
          const headerStyle=header?getComputedStyle(header):null;
          const panelStyle=header?getComputedStyle(header.closest('.panel')):null;
          return {headerMatches:header?headerStyle.backgroundImage===top.backgroundImage&&headerStyle.backgroundColor===top.backgroundColor:null,panelTransparent:panelStyle?panelStyle.backgroundImage==='none'&&panelStyle.backgroundColor==='rgba(0, 0, 0, 0)':null,focusGradient:selected,focusFadesToNav:selected.includes(nav+' 85%')};
        },view);
        if(mobile.headerMatches!==null)report.mobileHeaders.push({view,same:mobile.headerMatches,panelTransparent:mobile.panelTransparent});
        report.mobileFocus.push({view,radial:mobile.focusGradient.startsWith('radial-gradient'),fadesToNav:mobile.focusFadesToNav});
      }
      if(width===1920){
        report.wide=await reference.evaluate(()=>{const r=document.querySelector('#appShell').getBoundingClientRect();return {width:r.width,left:r.left,right:innerWidth-r.right};});
        await reference.screenshot({path:path.join(screenshotDir,'tunnel-wide.png')});
      }
      if(width===1538){
        report.palette=await reference.evaluate(()=>{
          const header=getComputedStyle(document.querySelector('.center-panel .panel-header'));
          const send=['#sendTextBtn','#sendRichBtn'].map(selector=>{const s=getComputedStyle(document.querySelector(selector));return {background:s.backgroundImage,color:s.color};});
          return {headerBackground:header.backgroundImage,headerColor:header.color,send};
        });
        await reference.screenshot({path:path.join(screenshotDir,'tunnel-home.png')});
        await require('./vector-prototype.cjs')(reference);
        await reference.locator('#shortCodeSwitchBtn').click();
        await base.locator('#shortCodeSwitchBtn').click();
        const dropdown=await reference.evaluate(()=>{const button=document.querySelector('#shortCodeSwitchBtn').getBoundingClientRect(),menu=document.querySelector('#shortCodeSwitchMenu').getBoundingClientRect();return {menuVisible:!document.querySelector('#shortCodeSwitchMenu').hidden,buttonBottom:button.bottom,menuTop:menu.top,centerOverlayCount:document.querySelectorAll('.control-center-overlay').length};});
        const baseMenu=await base.locator('#shortCodeSwitchMenu').boundingBox(),refMenu=await reference.locator('#shortCodeSwitchMenu').boundingBox();
        dropdown.sameGeometry=['x','y','width','height'].every(key=>Math.abs(baseMenu[key]-refMenu[key])<.25);
        report.dropdown=dropdown;
        await reference.screenshot({path:path.join(screenshotDir,'tunnel-dropdown.png')});
        await reference.locator('#shortCodeSwitchBtn').click();
        await base.locator('#shortCodeSwitchBtn').click();
        const previewStyle=page=>page.evaluate(()=>{
          const viewer=document.querySelector('#filePreviewViewer');viewer.classList.add('active');
          const result=['#filePreviewViewer','.file-preview-modal','.file-preview-header','.file-preview-header h3','.file-preview-close-btn','.file-preview-content','.file-preview-actions'].map(selector=>{const s=getComputedStyle(document.querySelector(selector));return [s.backgroundColor,s.backgroundImage,s.color,s.borderColor,s.boxShadow,s.borderRadius,s.padding,s.font];});
          viewer.classList.remove('active');return result;
        });
        const previewRef=await previewStyle(reference),previewBase=await previewStyle(base);
        report.previewStyles=JSON.stringify(previewRef)===JSON.stringify(previewBase);
        report.previewStyleDiff=previewRef.map((value,index)=>({index,ref:value,base:previewBase[index]})).filter(value=>JSON.stringify(value.ref)!==JSON.stringify(value.base));
        const fullscreenStyle=page=>page.evaluate(()=>{
          const viewer=document.querySelector('#mediaFullscreenViewer');viewer.classList.add('active');
          const result=['#mediaFullscreenViewer','.media-fullscreen-topbar','#mediaFullscreenTitle','#mediaFullscreenContent','#mediaFullscreenCloseBtn'].map(selector=>{const s=getComputedStyle(document.querySelector(selector));return [s.backgroundColor,s.backgroundImage,s.color,s.borderColor,s.boxShadow,s.borderRadius,s.padding,s.font];});
          viewer.classList.remove('active');return result;
        });
        const fullscreenRef=await fullscreenStyle(reference),fullscreenBase=await fullscreenStyle(base);
        report.fullscreenStyles=JSON.stringify(fullscreenRef)===JSON.stringify(fullscreenBase);
        report.fullscreenStyleDiff=fullscreenRef.map((value,index)=>({index,ref:value,base:fullscreenBase[index]})).filter(value=>JSON.stringify(value.ref)!==JSON.stringify(value.base));
        await reference.locator('#tunnelSettingsBtn').click();await reference.screenshot({path:path.join(screenshotDir,'tunnel-settings.png')});
        await reference.locator('#closeTunnelSettingsBtn').click();
        await reference.locator('.message-record-menu-trigger').first().click();await reference.screenshot({path:path.join(screenshotDir,'tunnel-record-menu.png')});
        await reference.locator('.message-record-action-menu .history-action').filter({hasText:'详情'}).click();
        await reference.screenshot({path:path.join(screenshotDir,'tunnel-details.png')});
        await reference.locator('.transfer-record-details-close').click();
        await reference.locator('#connectionHeaderMenuBtn').click();
        await reference.locator('#connectionResourceBrowserBtn').click();
        await reference.waitForTimeout(350);
        await reference.screenshot({path:path.join(screenshotDir,'tunnel-resources.png')});
        await reference.locator('.resource-browser-close').click();
        await reference.locator('#deviceList .name').click();
        await reference.locator('#closeDeviceProfileBtn').waitFor({state:'visible'});
        await reference.waitForTimeout(350);
        report.profileButtons=await reference.evaluate(()=>['#closeDeviceProfileBtn','#followDeviceBtn'].map(selector=>{const el=document.querySelector(selector),s=getComputedStyle(el),r=el.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {selector,rect:[r.x,r.y,r.width,r.height],color:s.color,background:s.backgroundColor,visibility:s.visibility,opacity:s.opacity,hit:hit?.id||hit?.className};}));
        await reference.screenshot({path:path.join(screenshotDir,'tunnel-device.png')});
        await reference.locator('#closeDeviceProfileBtn').click();
        await reference.locator('#connectionHeaderMenuBtn').click();await reference.locator('#notificationCenterBtn').click();
        await reference.screenshot({path:path.join(screenshotDir,'tunnel-notifications.png')});
        await reference.locator('[data-notification-close]').click();
        await reference.locator('#tunnelSettingsBtn').click();
        await reference.locator('#historyBackupBtn').click();
        await reference.screenshot({path:path.join(screenshotDir,'tunnel-backup.png')});
        await reference.locator('.send-mode-overlay').click({position:{x:5,y:5}});
        await reference.locator('#tunnelSettingsBtn').click();
        await reference.locator('#garbageCleanupBtn').click();
        await reference.screenshot({path:path.join(screenshotDir,'tunnel-cleanup.png')});
        await reference.locator('#cancelGarbageCleanup').click();
        await reference.locator('[data-demo-record="rich"] .rich-preview').click();
        await reference.waitForTimeout(350);
        report.richButtons=await reference.evaluate(()=>['#richHistoryBtn','#editRichMessageBtn','#closeRichViewer'].map(selector=>{const el=document.querySelector(selector),s=getComputedStyle(el),r=el.getBoundingClientRect();return {selector,display:s.display,visibility:s.visibility,opacity:s.opacity,color:s.color,background:s.backgroundColor,backgroundImage:s.backgroundImage,rect:[r.x,r.y,r.width,r.height]};}));
        await reference.screenshot({path:path.join(screenshotDir,'tunnel-rich.png')});
      }
      if(width===390){
        await reference.screenshot({path:path.join(screenshotDir,'mobile-'+view+'.png')});
        if(view==='chat'){
          await reference.locator('.mobile-workspace-button[data-mobile-view="chat"]').click();await reference.waitForTimeout(100);
          report.controlCenter=await reference.evaluate(()=>{const list=document.querySelector('.session-switcher-list'),rows=[...list.querySelectorAll('.session-switch-item')].map(el=>el.getBoundingClientRect()),buttons=[...document.querySelectorAll('.session-switch-scroll')];return {vertical:rows.every((r,i)=>!i||r.top>=rows[i-1].bottom),fullWidth:rows.every(r=>Math.abs(r.width-list.clientWidth+4)<2),overflow:list.scrollHeight>list.clientHeight+2,buttonsVisible:buttons.every(b=>!b.hidden)};});
          await reference.screenshot({path:path.join(screenshotDir,'mobile-control-center.png')});
          await reference.locator('.session-switcher-close').click();
          await reference.locator('.message-record-menu-trigger').first().click();await reference.screenshot({path:path.join(screenshotDir,'mobile-record-menu.png')});
          await reference.locator('.message-record-action-menu .history-action').filter({hasText:'详情'}).click();await reference.screenshot({path:path.join(screenshotDir,'mobile-details.png')});
        }
        if(view==='devices'){
          await reference.locator('#connectionHeaderMenuBtn').click();await reference.screenshot({path:path.join(screenshotDir,'mobile-menu.png')});
          await reference.locator('#connectionResourceBrowserBtn').click();await reference.screenshot({path:path.join(screenshotDir,'mobile-resources.png')});
          await reference.locator('.resource-browser-close').click();await reference.locator('#connectionHeaderMenuBtn').click();await reference.locator('#notificationCenterBtn').click();await reference.screenshot({path:path.join(screenshotDir,'mobile-notifications.png')});
          await reference.locator('[data-notification-close]').click();await reference.locator('#tunnelSettingsBtn').click();await reference.screenshot({path:path.join(screenshotDir,'mobile-settings.png')});
        }
      }
      if(width===1024)await reference.screenshot({path:path.join(screenshotDir,'tablet.png')});
      await reference.close();await base.close();
    }
    const svgPage=await browser.newPage({viewport:{width:1538,height:1023},deviceScaleFactor:1});
    svgPage.on('pageerror',error=>report.errors.push(error.message));
    await svgPage.goto(pathToFileURL(path.join(__dirname,'tunnel-home.svg')).href);
    await svgPage.waitForTimeout(200);
    await svgPage.screenshot({path:path.join(screenshotDir,'tunnel-home-svg.png')});await svgPage.close();
    if(report.geometry.some(item=>item.differences)||report.wide.width!==1400||Math.abs(report.wide.left-report.wide.right)>.25||report.topbar.some(item=>!item.backgroundChanged||!item.transparent||!item.otherStylesSame)||report.mobileHeaders.some(item=>!item.same||!item.panelTransparent)||report.mobileFocus.some(item=>!item.radial||!item.fadesToNav)||!report.palette.headerBackground.includes('rgb(65, 51, 202)')||report.palette.headerColor!=='rgb(255, 255, 255)'||report.palette.send.some(item=>!item.background.includes('linear-gradient')||item.color!=='rgb(255, 255, 255)')||report.profileButtons.some(item=>item.visibility!=='visible')||report.richButtons.some(item=>item.visibility!=='visible'||item.display==='none')||!report.dropdown.menuVisible||!report.dropdown.sameGeometry||report.dropdown.menuTop<report.dropdown.buttonBottom||report.dropdown.centerOverlayCount||!report.controlCenter.vertical||!report.controlCenter.fullWidth||report.controlCenter.overflow!==report.controlCenter.buttonsVisible||!report.previewStyles||!report.fullscreenStyles||report.errors.length)throw Error('原型几何、配色或交互检查失败');
    // Keep the generated screenshots separate from the original reference image,
    // then update the previous locations for existing links.
    const screenshots=['tunnel-home.png','tunnel-home-svg.png','tunnel-wide.png','tunnel-dropdown.png','tunnel-settings.png','tunnel-record-menu.png','tunnel-details.png','tunnel-resources.png','tunnel-device.png','tunnel-notifications.png','tunnel-backup.png','tunnel-cleanup.png','tunnel-rich.png','tablet.png','mobile-chat.png','mobile-devices.png','mobile-editor.png','mobile-control-center.png','mobile-details.png','mobile-menu.png','mobile-record-menu.png','mobile-resources.png','mobile-settings.png','mobile-notifications.png'];
    const syncErrors=[];
    for(const name of screenshots){
      let error;
      for(let attempt=0;attempt<3;attempt++){
        try{fs.copyFileSync(path.join(screenshotDir,name),path.join(__dirname,name));error=null;break;}
        catch(failure){error=failure;await new Promise(resolve=>setTimeout(resolve,500));}
      }
      if(error)syncErrors.push({name,code:error.code});
    }
    report.screenshotSync={count:screenshots.length,errors:syncErrors};
    fs.writeFileSync(path.join(__dirname,'prototype-check.json'),JSON.stringify(report,null,2));
    if(syncErrors.length)throw Error('部分旧位置截图同步失败：'+JSON.stringify(syncErrors));
    console.log(JSON.stringify(report,null,2));
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
