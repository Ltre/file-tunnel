// Self-contained SVG with the actual HTML/CSS as foreignObject; the interface
// remains CSS/vector text and geometry. The reference thumbnails are bitmap.
const fs=require('node:fs');
const path=require('node:path');
module.exports=async function writeVector(page){
  const css=['base-notification-center.css','base-themes-legacy.css','base-index.css','base-themes.css','tunnel-prototype.css'].map(name=>fs.readFileSync(path.join(__dirname,name),'utf8')).join('\n');
  const photo=fs.readFileSync(path.join(__dirname,'index.jpg')).toString('base64');
  const maps={};
  for(const [name,viewBox] of [['sample-document-a.svg','465 132 160 125'],['sample-document-b.svg','625 132 195 125'],['sample-document-c.svg','465 257 160 137'],['sample-document-d.svg','625 257 195 137'],['sample-photo.svg','445 618 226 204']]){
    const svg='<svg xmlns="http://www.w3.org/2000/svg" viewBox="'+viewBox+'"><image href="data:image/jpeg;base64,'+photo+'" width="1538" height="1023"/></svg>';
    maps[name]='data:image/svg+xml;base64,'+Buffer.from(svg).toString('base64');
  }
  maps['streaming.png']='data:image/png;base64,'+fs.readFileSync(path.join(__dirname,'streaming.png')).toString('base64');
  const markup=await page.evaluate(({css,maps})=>{
    const html=document.documentElement.cloneNode(true);
    html.querySelectorAll('script,link').forEach(node=>node.remove());
    const style=document.createElement('style');style.textContent=css;html.querySelector('head').append(style);
    html.querySelectorAll('[src]').forEach(node=>{const src=node.getAttribute('src');if(maps[src])node.setAttribute('src',maps[src]);});
    return new XMLSerializer().serializeToString(html);
  },{css,maps});
  const svg='<svg xmlns="http://www.w3.org/2000/svg" width="1538" height="1023" viewBox="0 0 1538 1023"><title>隧道三栏首页 Lusns 主题原型</title><foreignObject width="1538" height="1023">'+markup+'</foreignObject></svg>';
  fs.writeFileSync(path.join(__dirname,'tunnel-home.svg'),svg);
};
