'use strict';

// Focal-post data only. Pictures, playable videos and inventory are kept separate:
// a preview or a successful HTTP/extractor response is not a complete media list.
function mediaUrl(value, host) {
    try {
        const url=new URL(String(value||''));
        return url.protocol==='https:' && url.hostname===host && !url.username && !url.password && !url.port && url.href.length<=4096 ? url.href : '';
    } catch (_) { return ''; }
}
function photos(values) {
    return [...new Set(values.map(item=>mediaUrl(item.media_url_https||item.url,'pbs.twimg.com')).filter(value=>value && new URL(value).pathname.startsWith('/media/')))];
}
function authorInfo(user = {}) {
    const name = user.core?.name || user.legacy?.name || user.name;
    const rawHandle = String(user.core?.screen_name || user.legacy?.screen_name || user.screen_name || '').replace(/^@/, '');
    const handle = /^[a-zA-Z0-9_]{1,15}$/.test(rawHandle) ? rawHandle : '';
    const rawAvatar = user.avatar?.image_url || user.legacy?.profile_image_url_https || user.profile_image_url_https;
    const avatar = mediaUrl(rawAvatar, 'pbs.twimg.com') || mediaUrl(rawAvatar, 'abs.twimg.com');
    const safeAvatar = avatar && (/^\/profile_images\//.test(new URL(avatar).pathname) && new URL(avatar).hostname === 'pbs.twimg.com' ||
        /^\/sticky\/default_profile_images\//.test(new URL(avatar).pathname) && new URL(avatar).hostname === 'abs.twimg.com') ? avatar : '';
    return { author: typeof name === 'string' ? name.slice(0, 1000) : '', authorHandle: handle,
        authorUrl: handle ? 'https://x.com/' + handle : '', authorAvatar: safeAvatar };
}

function authorFromMetadata(metadata = {}) {
    let handle = '';
    try {
        const url = new URL(metadata.uploader_url || metadata.channel_url);
        if (url.protocol === 'https:' && /^(?:(?:www|mobile|m)\.)?(?:x|twitter)\.com$/i.test(url.hostname)) handle = url.pathname.match(/^\/([a-zA-Z0-9_]{1,15})\/?$/)?.[1] || '';
    } catch (_) {}
    // Some extractors expose a numeric account ID as uploader_id, not a handle.
    if (!handle && /[a-zA-Z_@]/.test(metadata.uploader_id || '')) handle = metadata.uploader_id;
    return authorInfo({ name: metadata.uploader || metadata.channel || metadata.creator, screen_name: handle,
        profile_image_url_https: metadata.uploader_avatar || metadata.uploader_thumbnail });
}
function videoId(value) {
    return String(value||'').replace(/^\d+_/, '');
}
function videoMeta(item,index) {
    const variants=item.video_info?.variants||item.variants||[],formats=[];
    for(const variant of variants) {
        const url=mediaUrl(variant.url||variant.src,'video.twimg.com');
        const type=String(variant.content_type||variant.type||'');
        if(!url || !(/video\/mp4|application\/x-mpegURL|application\/vnd.apple.mpegurl/i.test(type)||/\.(?:mp4|m3u8)(?:\?|$)/i.test(url)))continue;
        formats.push({url,ext:'mp4',protocol:/\.m3u8(?:\?|$)/i.test(url)?'m3u8_native':'https',vcodec:'h264',acodec:item.type==='animated_gif'?'none':'aac',tbr:Math.max(0,Number(variant.bitrate)||0)/1000});
    }
    if(!formats.length)return null;
    formats.sort((a,b)=>b.tbr-a.tbr);const best=formats.find(format=>format.protocol==='https')||formats[0];
    return {id:videoId(item.id_str||item.id||item.media_key)||'video-'+index,_type:'video',url:best.url,webpage_url:best.url,ext:'mp4',formats,
        duration:Math.max(0,Number(item.video_info?.duration_millis)||0)/1000,thumbnail:mediaUrl(item.media_url_https,'pbs.twimg.com')};
}
function fromPost(raw,id,verified=false) {
    const post=raw?.tweet||raw;
    if(!post || (!verified && String(post.rest_id||post.id_str||'')!==id))return null;
    if(post.__typename==='TweetUnavailable' && post.unavailable_reason==='Suspended')throw Error('SNS_X_AUTHOR_SUSPENDED');
    if(post.__typename==='TweetTombstone') {
        if(/from a suspended account/i.test(post.tombstone?.text?.text||''))throw Error('SNS_X_AUTHOR_SUSPENDED');
        return {images:[],videoMetas:[],videoIds:[],inventoryKnown:false,requiresLogin:/log\s*in|sign\s*in|age.restricted/i.test(post.tombstone?.text?.text||'')};
    }
    if(String(post.rest_id||post.id_str||'')!==id || post.__typename && post.__typename!=='Tweet')return null;
    const legacy=post.legacy||post;
    const collections=[post.media_entities2,post.mediaDetails,legacy.extended_entities?.media,legacy.entities?.media,post.photos].filter(Array.isArray);
    const items=collections.flatMap(collection=>collection===post.photos?collection.map(item=>({type:'photo',...item})):collection);
    if(post.video && !items.some(item=>item.type==='video'||item.type==='animated_gif'))items.push({type:'video',...post.video});
    const pictures=items.filter(item=>item.type==='photo');
    const videos=items.filter(item=>item.type==='video'||item.type==='animated_gif');
    if(photos(pictures).length>20)throw Error('SNS_POST_IMAGE_LIMIT');
    if(new Set(videos.map((item,index)=>videoId(item.id_str||item.id||item.media_key)||'video-'+index)).size>40)throw Error('SNS_POST_MEDIA_LIMIT');
    const body=String(post.note_tweet?.note_tweet_results?.result?.text||post.details?.full_text||legacy.full_text||post.text||'').trim().slice(0,100000);
    return {images:photos(pictures),videoMetas:videos.map(videoMeta).filter(Boolean),videoIds:videos.map((item,index)=>videoId(item.id_str||item.id||item.media_key)||'video-'+index),
        inventoryKnown:collections.length>0,requiresLogin:false,body,structuredBody:Boolean(body),
        ...authorInfo(post.core?.user_results?.result || post.user || {})};
}
function playableEntries(metadata) {
    return (Array.isArray(metadata?.entries)?metadata.entries:[metadata]).filter(Boolean).filter(entry=>
        (entry.formats||[]).some(format=>format.vcodec && format.vcodec!=='none'||format.acodec && format.acodec!=='none'||Number(format.height)>0) ||
        /^https?:\/\//i.test(entry.url||'') && /^(?:mp4|webm|mov|mkv|m4a|mp3|aac|flac|opus|ogg)$/i.test(entry.ext||''));
}
function directVideoUrl(entry) {
    const formats=(entry.formats||[]).filter(format=>mediaUrl(format.url,'video.twimg.com') && /\.mp4(?:\?|$)/i.test(format.url) && format.vcodec!=='none');
    formats.sort((a,b)=>(Number(b.height)||0)-(Number(a.height)||0)||(Number(b.tbr)||Number(b.bitrate)||0)-(Number(a.tbr)||Number(a.bitrate)||0));
    return formats[0]?.url || (/\.mp4(?:\?|$)/i.test(entry.url||'')?mediaUrl(entry.url,'video.twimg.com'):'');
}
async function downloadWithFallback(direct,original,playlistItem,read) {
    const target=directVideoUrl({url:direct});
    if(!target)return read(original,playlistItem);
    try{return await read(target,0);}
    catch(error){if(/cancelled|canceled|aborted/i.test(error.message||''))throw error;return read(original,playlistItem);}
}
function identity(entry) {
    const url=(entry.formats||[]).map(format=>format.url).concat(entry.url||'').find(value=>/\/(?:amplify_video|ext_tw_video)\/\d+\//.test(value||''));
    return url?.match(/\/(?:amplify_video|ext_tw_video)\/(\d+)\//)?.[1] || videoId(entry.id) || entry.url || entry.webpage_url || JSON.stringify(entry.formats||[]);
}
function mergeMetas(...groups) {
    const result=new Map();
    for(const group of groups)for(const entry of group||[]) {
        const key=identity(entry);if(!key)continue;
        const previous=result.get(key);
        if(!previous){result.set(key,entry);continue;}
        const formats=new Map();for(const format of [...(previous.formats||[]),...(entry.formats||[])])formats.set(format.url||JSON.stringify(format),format);
        result.set(key,{...entry,...previous,formats:[...formats.values()],duration:previous.duration||entry.duration});
    }
    return [...result.values()];
}
function missingVideos(post,entries) {
    const have=new Set(entries.map(identity));
    return (post.videoIds||[]).filter(id=>!have.has(videoId(id)));
}
function mergeParts(parts) {
    const usable=parts.filter(Boolean),known=usable.filter(part=>part.inventoryKnown),pictures=new Map();
    for(const part of known.length?known:usable.filter(part=>!part.requiresLogin))for(const image of part.images||[]) {
        const key=new URL(image).pathname.replace(/\.(?:jpg|jpeg|png|webp|avif)$/i,'');if(!pictures.has(key))pictures.set(key,image);
    }
    if(pictures.size>20)throw Error('SNS_POST_IMAGE_LIMIT');
    const text=usable.find(part=>part.structuredBody)||usable.find(part=>part.body)||usable[0]||{};
    const author=usable.find(part=>part.authorHandle&&part.authorAvatar)||usable.find(part=>part.authorHandle)||usable.find(part=>part.authorAvatar);
    return {...text,...(author?{author:author.author||text.author||'',authorHandle:author.authorHandle||'',authorUrl:author.authorUrl||'',authorAvatar:author.authorAvatar||''}:{}),
        images:[...pictures.values()],videoMetas:mergeMetas(...usable.map(part=>part.videoMetas)),videoIds:[...new Set(usable.flatMap(part=>part.videoIds||[]))],
        inventoryKnown:known.length>0,structuredImages:known.length>0,requiresLogin:!known.length && usable.some(part=>part.requiresLogin)};
}
function fromJson(payload,id) {
    if(!id)return null;
    const found=[];let budget=10000;
    function visit(value,depth=0) {
        if(!value||typeof value!=='object'||depth>20||--budget<0)return;
        const focal=value.tweet_result_by_rest_id;
        if(focal){if(String(focal.rest_id||'')===id)found.push(fromPost(focal.result,id,true));return;}
        if(String(value.rest_id||value.id_str||'')===id && (value.__typename==='Tweet'||value.legacy||value.mediaDetails||value.photos||value.tweet)) {found.push(fromPost(value,id));return;}
        for(const item of Object.values(value))visit(item,depth+1);
    }
    visit(payload);return found.some(Boolean)?mergeParts(found):null;
}
function fromHtml(html,id) {
    if(!id)return null;
    const found=[];
    for(const script of String(html).matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
        for(const match of script[1].matchAll(/\bvalue\s*:\s*("(?:[^"\\]|\\[\s\S])*")/g)) {
            let payload;try{payload=JSON.parse(JSON.parse(match[1]));}catch(_){continue;}
            const focal=payload?.data?.tweet_result_by_rest_id;
            if(String(focal?.rest_id||'')!==id)continue;
            const post=fromPost(focal.result,id,true);if(post)found.push(post);
        }
    }
    return found.length?mergeParts(found):null;
}
module.exports={fromPost,fromJson,fromHtml,mergeParts,playableEntries,mergeMetas,missingVideos,directVideoUrl,downloadWithFallback,authorInfo,authorFromMetadata};
