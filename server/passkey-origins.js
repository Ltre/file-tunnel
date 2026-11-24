'use strict';

// Only deployment-controlled exact HTTPS origins can authorize cross-domain
// authentication. Never learn this allowlist from Host or a user's credentials.
function passkeyOrigins(input) {
    const values=Array.isArray(input)?input:String(input||'').split(/[\s,]+/);
    return [...new Set(values.filter(Boolean).map(value=>{
        if(typeof value!=='string'||value.length>300)throw Error('PASSKEY_ORIGIN_INVALID');
        let url;try{url=new URL(value);}catch(_){throw Error('PASSKEY_ORIGIN_INVALID');}
        if(url.protocol!=='https:'||url.origin!==value||url.username||url.password||url.hostname.includes('*'))throw Error('PASSKEY_ORIGIN_INVALID');
        return url.origin;
    }))];
}
module.exports={passkeyOrigins};
