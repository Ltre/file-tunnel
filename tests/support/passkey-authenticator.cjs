'use strict';
const crypto=require('node:crypto'),{encodeCBOR}=require('@levischuck/tiny-cbor');
const hash=value=>crypto.createHash('sha256').update(value).digest(),b64=value=>Buffer.from(value).toString('base64url');
module.exports=function authenticator(rpID){
    const {publicKey,privateKey}=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'}),jwk=publicKey.export({format:'jwk'}),id=crypto.randomBytes(32);
    const cose=encodeCBOR(new Map([[1,2],[3,-7],[-1,1],[-2,Buffer.from(jwk.x,'base64url')],[-3,Buffer.from(jwk.y,'base64url')]]));
    const client=(challenge,origin,type)=>Buffer.from(JSON.stringify({challenge,origin,type,crossOrigin:false}));
    const authData=(flags,counter)=>{const value=Buffer.alloc(5);value[0]=flags;value.writeUInt32BE(counter,1);return Buffer.concat([hash(rpID),value]);};
    return {id:b64(id),register(flow,origin='https://'+rpID){
        const length=Buffer.alloc(2);length.writeUInt16BE(id.length);
        const attestation=encodeCBOR(new Map([['fmt','none'],['attStmt',new Map()],['authData',Buffer.concat([authData(0x45,0),Buffer.alloc(16),length,id,cose])]]));
        return {id:b64(id),rawId:b64(id),type:'public-key',clientExtensionResults:{},response:{clientDataJSON:b64(client(flow.options.challenge,origin,'webauthn.create')),attestationObject:b64(attestation),transports:['internal']}};
    },login(flow,counter=1,origin='https://'+rpID){
        const data=client(flow.options.challenge,origin,'webauthn.get'),auth=authData(5,counter);
        return {id:b64(id),rawId:b64(id),type:'public-key',clientExtensionResults:{},response:{clientDataJSON:b64(data),authenticatorData:b64(auth),signature:b64(crypto.sign('sha256',Buffer.concat([auth,hash(data)]),privateKey)),userHandle:null}};
    }};
};
