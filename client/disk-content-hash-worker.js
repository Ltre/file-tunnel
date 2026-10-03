'use strict';
// Incremental SHA-256: at most one 1 MiB Blob slice is read at a time. This
// worker never copies a multi-gigabyte file into a single ArrayBuffer.
const K=new Uint32Array([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
const rotate=(x,n)=>(x>>>n)|(x<<(32-n));
class Sha256 {
    constructor(){this.h=new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);this.tail=new Uint8Array(64);this.used=0;this.length=0;this.w=new Uint32Array(64);}
    block(bytes,offset){
        const w=this.w;
        for(let i=0;i<16;i++){const p=offset+i*4;w[i]=(bytes[p]<<24)|(bytes[p+1]<<16)|(bytes[p+2]<<8)|bytes[p+3];}
        for(let i=16;i<64;i++){const a=w[i-15],b=w[i-2];w[i]=w[i-16]+(rotate(a,7)^rotate(a,18)^(a>>>3))+w[i-7]+(rotate(b,17)^rotate(b,19)^(b>>>10));}
        let [a,b,c,d,e,f,g,h]=this.h;
        for(let i=0;i<64;i++){const t1=(h+(rotate(e,6)^rotate(e,11)^rotate(e,25))+((e&f)^(~e&g))+K[i]+w[i])>>>0,t2=((rotate(a,2)^rotate(a,13)^rotate(a,22))+((a&b)^(a&c)^(b&c)))>>>0;h=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;}
        [a,b,c,d,e,f,g,h].forEach((v,i)=>{this.h[i]+=v;});
    }
    update(bytes){this.length+=bytes.length;let p=0;if(this.used){const count=Math.min(64-this.used,bytes.length);this.tail.set(bytes.subarray(0,count),this.used);this.used+=count;p=count;if(this.used===64){this.block(this.tail,0);this.used=0;}}
        while(p+64<=bytes.length){this.block(bytes,p);p+=64;}if(p<bytes.length){this.tail.set(bytes.subarray(p),0);this.used=bytes.length-p;}return this;}
    digest(){const tail=new Uint8Array(this.used<56?64:128);tail.set(this.tail.subarray(0,this.used));tail[this.used]=128;const view=new DataView(tail.buffer),bits=this.length*8;view.setUint32(tail.length-8,Math.floor(bits/4294967296));view.setUint32(tail.length-4,bits>>>0);for(let p=0;p<tail.length;p+=64)this.block(tail,p);return Array.from(this.h,v=>v.toString(16).padStart(8,'0')).join('');}
}
if(typeof module!=='undefined') module.exports={Sha256};
if(typeof self!=='undefined') self.onmessage=async event=>{
    try {const file=event.data.file,digest=new Sha256();let last=0;
        for(let offset=0;offset<file.size;offset+=1048576){digest.update(new Uint8Array(await file.slice(offset,offset+1048576).arrayBuffer()));if(Date.now()-last>250){self.postMessage({bytes:Math.min(file.size,offset+1048576)});last=Date.now();}}
        self.postMessage({sha256:digest.digest()});
    }catch(error){self.postMessage({error:error.message});}
};
