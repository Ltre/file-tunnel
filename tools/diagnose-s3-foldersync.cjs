'use strict';
const crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path');
const {canonicalUri,canonicalQuery,signingKey,sha256}=require('../server/s3/sigv4');
function signed(method,address,credential,body=Buffer.alloc(0),region='us-east-1'){
    const url=new URL(address),date=new Date().toISOString().replace(/[-:]/g,'').replace(/\.\d+Z$/,'Z'),scope=`${date.slice(0,8)}/${region}/s3/aws4_request`,payload=sha256(body);
    const headers={host:url.host,'x-amz-content-sha256':payload,'x-amz-date':date},names=Object.keys(headers).sort();
    const canonical=[method,canonicalUri(url.pathname),canonicalQuery(url.search),names.map(name=>`${name}:${headers[name]}\n`).join(''),names.join(';'),payload].join('\n');
    const signature=crypto.createHmac('sha256',signingKey(credential.secretAccessKey,date.slice(0,8),region)).update(`AWS4-HMAC-SHA256\n${date}\n${scope}\n${sha256(canonical)}`).digest('hex');
    return {headers:{...headers,authorization:`AWS4-HMAC-SHA256 Credential=${credential.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`},method,...(method==='PUT'?{body}:{}),redirect:'manual',signal:AbortSignal.timeout(20000)};
}
async function probe({endpoint,bucket,credential,region='us-east-1',write=false}){
    const base=new URL(endpoint);if(base.username||base.password||base.search||base.hash||!['http:','https:'].includes(base.protocol))throw new Error('请填写无查询参数、凭据和片段的 Endpoint');
    if(base.protocol!=='https:'&&!['127.0.0.1','localhost','[::1]'].includes(base.hostname))throw new Error('公网 Endpoint 必须使用 HTTPS');
    const root=base.href.replace(/\/$/,''),url= root+'/'+encodeURIComponent(bucket),report=[];
    const send=async(stage,method,address,body)=>{const start=Date.now();try{const response=await fetch(address,signed(method,address,credential,body,region));let text='',truncated=false;
        if(response.body){const reader=response.body.getReader(),decoder=new TextDecoder();try{while(text.length<8192){const {value,done}=await reader.read();if(done)break;text+=decoder.decode(value,{stream:true});}if(text.length>=8192){truncated=true;text=text.slice(0,8192);await reader.cancel();}else text+=decoder.decode();}finally{reader.releaseLock();}}
        const record={stage,method,url:address,status:response.status,contentType:response.headers.get('content-type'),requestId:response.headers.get('x-amz-request-id'),ms:Date.now()-start,body:text,truncated};report.push(record);return record;
    }catch(error){report.push({stage,method,url:address,ms:Date.now()-start,error:error.cause?.code||error.name});return null;}};
    await send('service-head','HEAD',root);await send('buckets','GET',root);await send('bucket-head','HEAD',url);
    await send('objects-v1','GET',url+'?delimiter=%2F&max-keys=5');await send('objects-v2','GET',url+'?list-type=2&delimiter=%2F&max-keys=5');
    if(write){const marker='__foldersync_probe_'+crypto.randomUUID()+'/',target=url+'/'+marker;
        const made=await send('create-empty-directory','PUT',target,Buffer.alloc(0));
        if(made?.status===200){await send('list-empty-directory','GET',url+'?list-type=2&delimiter=%2F&prefix='+encodeURIComponent(marker));await send('remove-probe-directory','DELETE',target);}
    }
    return {endpoint:root,bucket,region,writeProbe:write,results:report,notice:'不含密钥与认证头；响应可能含文件名，请仅分享必要的脱敏片段。带 Bucket 的 Endpoint 若重复拼接，应以实际 App 请求为准，不自动改写。'};
}
async function main(){const args=process.argv.slice(2),options={};for(let i=0;i<args.length;i++){if(args[i]==='--probe-write')options.write=true;else{const name=args[i];if(!['--endpoint','--bucket','--access-key','--data-dir','--output','--region'].includes(name)||!args[i+1])throw new Error('参数无效；见 tools/diagnose-s3-foldersync.md');options[name.slice(2)]=args[++i];}}
    if(!options.endpoint||!options.bucket||!options['access-key'])throw new Error('必须指定 --endpoint、--bucket、--access-key');
    const dir=path.resolve(options['data-dir']||'.tunnel-data');for(const name of ['s3-credentials.json','s3-secret.key'])if(!fs.existsSync(path.join(dir,name)))throw new Error('当前数据目录缺少 S3 配置：'+name);
    const credential=require('../server/s3/credentials').createS3Credentials(dir).find(options['access-key']);if(!credential)throw new Error('Access Key 不存在或已停用');
    if(!credential.bucketMappings.some(item=>item.bucket===options.bucket))throw new Error('Bucket 不属于此凭据');
    const result=await probe({...options,credential});const output=path.resolve(options.output||path.join(dir,'diagnostics','s3-foldersync-'+Date.now()+'.json'));fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(result,null,2),{mode:0o600});console.log(JSON.stringify({output,results:result.results.map(({stage,status,error})=>({stage,status,error}))},null,2));}
module.exports={signed,probe};if(require.main===module)main().catch(error=>{console.error('S3 检查失败：'+error.message);process.exitCode=1;});
