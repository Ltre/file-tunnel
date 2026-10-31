// Self-contained SVG with the actual HTML/CSS as foreignObject; the interface
// remains CSS/vector text and geometry. The reference thumbnails are bitmap.
const fs=require('node:fs');
const path=require('node:path');
module.exports=async function writeVector(page){
  const css=['base-notification-center.css','base-themes-legacy.css','base-index.css','base-themes.css','tunnel-prototype.css'].map(name=>fs.readFileSync(path.join(__dirname,name),'utf8')).join('\n');
  const maps={};
  for(const name of ['sample-document-a.svg','sample-document-b.svg','sample-document-c.svg','sample-document-d.svg','sample-photo.svg']){
    maps[name]='data:image/svg+xml;base64,'+fs.readFileSync(path.join(__dirname,name)).toString('base64');
  }
  maps['streaming.png']='data:image/png;base64,'+fs.readFileSync(path.join(__dirname,'streaming.png')).toString('base64');
  const markup=await page.evaluate(({css,maps})=>{
    const html=document.documentElement.cloneNode(true);
    html.querySelectorAll('script,link').forEach(node=>node.remove());
    const style=document.createElement('style');style.textContent=css;html.querySelector('head').append(style);
    html.querySelectorAll('[src]').forEach(node=>{const src=node.getAttribute('src');if(maps[src])node.setAttribute('src',maps[src]);});
    return new XMLSerializer().serializeToString(html);
  },{css,maps});
  const svg='<svg xmlns="http://www.w3.org/2000/svg" width="1538" height="1023" viewBox="0 0 1538 1023"><title>隧道三栏首页 blamen 主题原型</title><foreignObject width="1538" height="1023">'+markup+'</foreignObject></svg>';
  fs.writeFileSync(path.join(__dirname,'tunnel-home.svg'),svg);
};
