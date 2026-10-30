'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const code=fs.readFileSync(require.resolve('../client/streaming-console.js'),'utf8');
const part=(from,to)=>code.slice(code.indexOf(from),code.indexOf(to,code.indexOf(from)));

test('minimize/restore keeps the constructed view and does not schedule another render',async()=>{
    const original={name:'existing view'},main={children:[original],querySelector:()=>null,contains:()=>true};let renders=0,foreground;
    const context={ui:{view:'watch',stationId:'station'},account:()=>'',main,players:new Map([['station:',{element:{},setForeground:v=>foreground=v}]]),
        ready:Promise.resolve(),root:{hidden:false,querySelector:()=>null},isOpen(){return !context.root.hidden;},ensureUi(){},render(){renders++;},sync(){},saveUi(){},global:{dispatchEvent(){}},Event:class{},
        history:{state:{streamingConsole:true},pushState(){this.state={streamingConsole:true};},replaceState(value){this.state=value;}},location:{href:'http://fixture.invalid'},document:{getElementById:()=>null}};
    vm.createContext(context);vm.runInContext(part("    let renderedIdentity =",'    function dirty()')+'renderedIdentity=viewIdentity();global.openView=open;global.minimizeView=minimize;',context);
    context.global.minimizeView();assert.equal(foreground,false);await context.global.openView();assert.equal(foreground,true);
    assert.equal(main.children[0],original);assert.equal(renders,0);
});

test('leaving a station for a list keeps one background player; choosing another station closes the old one',()=>{
    let closed=0;const players=new Map([['station-A:',{close(){closed++;}}]]),ui={view:'watch',stationId:'station-A'};
    const context={players,ui,smallWindow:null,account:()=>'',dirty:()=>false,saveUi(){},render(){}};
    vm.createContext(context);vm.runInContext(part('    function navigate(', '    function returnToList()')+'globalThis.go=navigate;',context);
    context.go('discover');assert.equal(players.size,1);assert.equal(closed,0);
    context.go('watch','station-B');assert.equal(players.size,0);assert.equal(closed,1);
});

test('an editor awaiting revision reconciliation displays a loading status until its form is ready',async()=>{
    let finish;const main={children:[],classList:{remove(){}},replaceChildren(){this.children=[];},append(node){this.children.push(node);},setAttribute(name,value){this[name]=value;}};
    const context={main,root:{querySelectorAll:()=>[],querySelector:()=>({})},banner:{},players:new Map(),ui:{view:'edit',stationId:'draft',scroll:{}},renderVersion:0,pickerVersion:0,candidateObservers:[],isOpen:()=>true,
        viewIdentity:()=> 'edit:draft:',clearWatchSchedule(){},parkPlayers(){},presentPlayers(){},account:()=>'',t:value=>value,global:{},
        document:{createElement:()=>({setAttribute(name,value){this[name]=value;},remove(){main.children=main.children.filter(node=>node!==this);}})},
        reconcileRevision:()=>new Promise(resolve=>{finish=resolve;}),editor:()=>main.append({form:true}),error:cause=>{throw cause;}};
    vm.createContext(context);vm.runInContext(part('    async function render()', '    async function accountDialog(')+'globalThis.renderPage=render;',context);
    const rendering=context.renderPage();assert.equal(main['aria-busy'],'true');assert.equal(main.children[0].role,'status');assert.match(main.children[0].textContent,/正在加载/);
    finish();await rendering;assert.equal(main['aria-busy'],'false');assert.deepEqual(main.children,[{form:true}]);
});
