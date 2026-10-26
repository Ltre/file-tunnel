// Design review only. Keep the existing tunnel-list scrolling controls usable.
(()=>{const list=document.getElementById('sessionSwitcherList');if(!list)return;
const buttons=[...document.querySelectorAll('.session-switch-scroll')];
const refresh=()=>{const overflow=list.scrollHeight>list.clientHeight+2;buttons.forEach(b=>{b.hidden=!overflow;});};
buttons.forEach(b=>b.addEventListener('click',()=>list.scrollBy({top:Number(b.dataset.scroll)*Math.max(120,list.clientHeight*.75),behavior:'smooth'})));
requestAnimationFrame(refresh);window.addEventListener('resize',refresh);
})();
