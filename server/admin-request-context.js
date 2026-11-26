'use strict';
const net=require('node:net');
const address=value=>String(value||'').replace(/^::ffff:/i,'');
const privateIp=value=>{
    const ip=address(value);
    if(net.isIP(ip)===4){const [a,b]=ip.split('.').map(Number);return a===10||a===172&&b>=16&&b<=31||a===192&&b===168;}
    return net.isIP(ip)===6&&/^f[cd]/i.test(ip);
};
const loopback=value=>['127.0.0.1','::1'].includes(address(value));
function host(req){
    const raw=String(req.get?.('host')||req.headers?.host||'');
    if(!/^[\w.:[\]-]+$/.test(raw))return null;
    try{const url=new URL('http://'+raw);return {raw,hostname:url.hostname.replace(/^\[|\]$/g,'').toLowerCase()};}catch(_){return null;}
}
const forwarded=req=>Object.keys(req.headers||{}).some(name=>/^(forwarded|x-forwarded-.+|x-real-ip|cf-connecting-ip)$/i.test(name));
function requestOrigin(req){
    const target=host(req);if(!target)return '';
    const testHost=target.hostname==='localhost'||loopback(target.hostname)||privateIp(target.hostname);
    return (testHost&&req.protocol==='http'&&!forwarded(req)?'http':'https')+'://'+target.raw;
}
function localTestAllowed(req){
    const target=host(req);if(!target||forwarded(req))return false;
    const remote=address(req.socket?.remoteAddress),local=address(req.socket?.localAddress);
    const isLoop=target.hostname==='localhost'||loopback(target.hostname);
    if(isLoop){if(req.protocol!=='http'||!loopback(remote))return false;}
    else if(!privateIp(target.hostname)||target.hostname!==local||!(privateIp(remote)||loopback(remote)))return false;
    const origin=req.get?.('origin')||req.headers?.origin||'';
    return !origin||origin===requestOrigin(req);
}
module.exports={requestOrigin,localTestAllowed,privateIp,host};
