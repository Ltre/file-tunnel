'use strict';
// Read-only UI audit by default. --rewrite-dialogs routes native dialogs through
// the shared frontend runtime without changing identifiers, arguments or data.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),acorn=require('acorn');
const dialogs=new Set(['alert','confirm','prompt']);
const calls=new Set(['t','format','showAppToast','showToast','button','action','text','label','field','createFileActionButton','createResourceBrowserButton','showBlockingProgressPanel','setStatus','pendingSaveFeedback']);
const properties=new Set(['textContent','innerText','title','placeholder','label','description','hint','ariaLabel']);
const canonical=value=>String(value).replace(/\s+/g,'');
function scan(source,{html=false,rewrite=false,uiMaps=[]}={}){
 const phrases=new Set(),edits=[],candidates=[];
 const bindings=(node,scope)=>{
  if(!node)return;if(node.type==='Identifier')scope.names.add(node.name);
  else if(node.type==='RestElement')bindings(node.argument,scope);
  else if(node.type==='AssignmentPattern')bindings(node.left,scope);
  else if(node.type==='ArrayPattern')node.elements.forEach(value=>bindings(value,scope));
  else if(node.type==='ObjectPattern')node.properties.forEach(value=>bindings(value.value||value.argument,scope));
 };
 const add=value=>{value=String(value||'').trim();if(value&&/[\u3400-\u9fff]/.test(value)&&value.length<=1000)phrases.add(value);};
 const markup=value=>{
  value=value.replace(/<(script|style|code|pre|textarea)\b[^>]*>[\s\S]*?<\/\1>/gi,'');
  for(const match of value.matchAll(/(?:title|placeholder|aria-label)=["']([^"']+)["']/g))add(match[1]);
  for(const text of value.replace(/<[^>]*>/g,'\n').split(/\n+/))add(text.replace(/&nbsp;/g,' ').trim());
 };
 const literal=node=>node?.type==='Literal'&&typeof node.value==='string'?node.value:node?.type==='TemplateLiteral'?node.quasis.map((part,n)=>part.value.cooked+(n<node.expressions.length?'{'+n+'}':'')).join(''):null;
 const ui=node=>{
  const value=literal(node);if(value!==null){value.includes('<')?markup(value):add(value);return;}
  if(node?.type==='ConditionalExpression'){ui(node.consequent);ui(node.alternate);}
  else if(node?.type==='LogicalExpression'){ui(node.left);ui(node.right);}
  else if(node?.type==='MemberExpression'&&['ObjectExpression','ArrayExpression'].includes(node.object.type))ui(node.object);
  else if(node?.type==='ObjectExpression')node.properties.forEach(property=>ui(property.value));
  else if(node?.type==='ArrayExpression')node.elements.forEach(ui);
 };
 const walk=(node,parent,scope)=>{
  if(!node||typeof node!=='object')return;
  if(node.type==='Program'||node.type==='BlockStatement'||/Function(?:Declaration|Expression)$/.test(node.type)||node.type==='ArrowFunctionExpression'||node.type==='CatchClause')scope={parent:scope,names:new Set(),windowAliases:new Set(),functionScope:node.type==='Program'||node.type.includes('Function')};
  if(node.type?.includes('Function')){
   for(const param of node.params||[])bindings(param,scope);
   if(parent?.type==='CallExpression'&&parent.callee===node)(node.params||[]).forEach((param,index)=>{if(param.type==='Identifier'&&parent.arguments[index]?.type==='Identifier'&&parent.arguments[index].name==='window')scope.windowAliases.add(param.name);});
   if(node.id?.name){scope.names.add(node.id.name);if(node.type==='FunctionDeclaration')scope.parent?.names.add(node.id.name);}
  }
  if(node.type==='CatchClause')bindings(node.param,scope);
  if(node.type==='VariableDeclarator'){
   let declaration=scope;if(parent?.kind==='var')while(declaration.parent&&!declaration.functionScope)declaration=declaration.parent;
   bindings(node.id,declaration);
   if(uiMaps.includes(node.id?.name))ui(node.init);
  }
  if(node.type==='CallExpression'){
   const right=node.callee.right;
   const wrapped=node.callee.type==='LogicalExpression'&&node.callee.operator==='||'&&dialogs.has(right?.type==='Identifier'?right.name:right?.type==='MemberExpression'?right.property.name:'')&&source.slice(node.callee.start,node.callee.end).startsWith('window.TunnelI18n?.');
   const name=node.callee.type==='Identifier'?node.callee.name:node.callee.type==='MemberExpression'&&!node.callee.computed?node.callee.property.name:'';
   if(wrapped||calls.has(name)){ui(node.arguments[0]);if(name==='text'&&/^[a-z][a-z0-9-]*$/.test(literal(node.arguments[0])||'')&&!['pre','code','textarea','script','style'].includes(literal(node.arguments[0])))ui(node.arguments[1]);}
   if(name==='setAttribute'&&['title','placeholder','aria-label'].includes(literal(node.arguments[0])))add(literal(node.arguments[1]));
   if(name==='assign'&&node.callee.object?.name==='Object'&&uiMaps.includes(node.arguments[0]?.name))node.arguments.slice(1).forEach(ui);
   if(dialogs.has(name)&&(node.callee.type==='Identifier'||node.callee.type==='MemberExpression'&&!node.callee.computed&&node.callee.object.type==='Identifier')){
    candidates.push({node,scope,name,object:node.callee.type==='MemberExpression'?node.callee.object.name:''});
   }
  }
  if(node.type==='AssignmentExpression'&&node.left.type==='MemberExpression'){
   const name=node.left.property.name,value=literal(node.right);
   if(name==='innerHTML'&&value!==null)markup(value);else if(properties.has(name)||uiMaps.includes(node.left.object?.name))ui(node.right);
  }
  if(node.type==='Property'&&!node.computed&&properties.has(node.key.name||node.key.value))add(literal(node.value));
  for(const [key,value]of Object.entries(node))if(key!=='type'){
   if(Array.isArray(value))for(const child of value)walk(child,node,scope);
   else if(value&&typeof value==='object')walk(value,node,scope);
  }
 };
 if(html){markup(source);for(const match of source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))if(match[1].trim())walk(acorn.parse(match[1],{ecmaVersion:'latest'}),null,null);}
 else walk(acorn.parse(source,{ecmaVersion:'latest',sourceType:'script'}),null,null);
 for(const {node,scope,name,object} of candidates){
  let binding,windowBinding;for(let current=scope;current;current=current.parent){if(!binding&&current.names.has(object||name))binding=current;if(current.names.has('window'))windowBinding=current;}
  const native=object?object==='window'?!binding:Boolean(binding?.windowAliases.has(object))&&!windowBinding:!binding;
  if(native){const value=literal(node.arguments[0]);if(value!==null)value.includes('<')?markup(value):add(value);if(rewrite)edits.push({start:node.callee.start,end:node.callee.end,text:'(window.TunnelI18n?.'+name+' || '+source.slice(node.callee.start,node.callee.end)+')'});}
 }
 let rewritten=source;for(const edit of edits.sort((a,b)=>b.start-a.start))rewritten=rewritten.slice(0,edit.start)+edit.text+rewritten.slice(edit.end);
 return{phrases:[...phrases],source:rewritten,rewritten:edits.length};
}
function run(){
 const root=path.resolve(__dirname,'..'),index=fs.readFileSync(path.join(root,'pages/index.html'),'utf8'),files=new Set(['app.js','pages/index.html','pages/tunnel-entry.html','client/tunnel-entry.js','pages/downloadList.html','pages/downloader.html','client/disk-error-messages.js']);
 for(const match of index.matchAll(/src=["']\/(client\/[^"'$?]+\.js)/g))if(!/i18n|vendor|qrcode/.test(match[1]))files.add(match[1]);
 const context={window:{addEventListener(){}},document:{readyState:'loading',addEventListener(){}},navigator:{language:'en'},localStorage:{getItem:()=>null}};
 vm.runInNewContext(fs.readFileSync(path.join(root,'client/i18n-catalog.js'),'utf8'),context);
 vm.runInNewContext(fs.readFileSync(path.join(root,'client/i18n.js'),'utf8'),context);
 const catalog=new Map(Object.entries(context.window.Drop2TunnelI18nCatalog).map(([key,value])=>[canonical(key),value])),found=new Map();let rewritten=0;
 const changes=[];
 for(const file of files){
  if(!fs.existsSync(path.join(root,file)))continue; // Generated vendor routes are not source UI.
  const source=fs.readFileSync(path.join(root,file),'utf8'),result=scan(source,{html:file.endsWith('.html'),rewrite:process.argv.includes('--rewrite-dialogs')&&!file.endsWith('.html'),uiMaps:file==='client/disk-error-messages.js'?['codes','reasons']:[]});
  if(result.rewritten){changes.push({file,source:result.source});rewritten+=result.rewritten;}
  for(const phrase of result.phrases){const key=canonical(phrase);if(!found.has(key))found.set(key,{phrase,files:[]});found.get(key).files.push(file);}
 }
 for(const change of changes)fs.writeFileSync(path.join(root,change.file),change.source);
 const languages=context.window.Drop2TunnelI18nConfig.languages.map(([code])=>code).filter(code=>code!=='zh-Hans');
 const report=[...found].map(([key,value])=>({...value,missing:languages.filter(language=>catalog.has(key)?!catalog.get(key)[language]:context.window.TunnelI18n.t(value.phrase,language)===value.phrase),inCatalog:catalog.has(key)}));
 const summary={files:files.size,phrases:report.length,missingCatalog:report.filter(item=>!item.inCatalog).length,missingJapanese:report.filter(item=>item.missing.includes('ja')).length,rewrittenDialogs:rewritten};
 const output=process.argv.indexOf('--output');if(output>=0)fs.writeFileSync(path.resolve(root,process.argv[output+1]),JSON.stringify({summary,phrases:report},null,2));
 console.log(JSON.stringify(summary));
 return report;
}
if(require.main===module)run();
module.exports={scan};
