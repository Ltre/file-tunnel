(function (global) {
    'use strict';
    // The existing homepage scanner, shared by the lightweight and full routes.
    let scanner = null, generation = 0;
    function close() {
        generation++;
        if (!scanner) return;
        clearInterval(scanner.timer);
        scanner.stream?.getTracks?.().forEach(track => track.stop());
        scanner.layer.remove(); scanner = null;
    }
    async function open(onScan) {
        close(); const opening = generation;
        if (!('BarcodeDetector' in global)) throw new Error('当前浏览器不支持二维码扫描，请使用支持 BarcodeDetector 的 Chromium 浏览器');
        const detector = new BarcodeDetector({ formats: ['qr_code'] });
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
        if (opening !== generation) { stream.getTracks().forEach(track => track.stop()); return; }
        const layer = document.createElement('div'); layer.dataset.tunnelCodeScanner = '';
        layer.style.cssText = 'position:fixed;inset:0;z-index:2147483100;background:#05070a;color:#fff;display:flex;flex-direction:column;padding:max(14px,env(safe-area-inset-top)) 14px 18px;';
        layer.innerHTML = '<div style="display:flex;align-items:center;gap:12px"><strong style="flex:1">扫描隧道码</strong><button data-close type="button" style="border:0;border-radius:999px;width:38px;height:38px;font-size:22px">×</button></div><div style="flex:1;min-height:0;display:grid;place-items:center"><video data-video playsinline muted style="width:min(92vw,680px);max-height:72vh;border-radius:18px;background:#000;object-fit:cover"></video></div><div data-status style="text-align:center;color:#cbd5e1">将隧道二维码置于扫描框内</div>';
        const landing = document.getElementById('sessionLanding');
        (landing && !landing.hidden ? landing : document.body).appendChild(layer);
        const video = layer.querySelector('[data-video]'); video.srcObject = stream;
        const current = scanner = { layer, stream, timer: null, detecting: false };
        layer.querySelector('[data-close]').onclick = close;
        try { await video.play(); } catch (error) { if (scanner === current) close(); throw error; }
        if (scanner !== current) return;
        current.timer = setInterval(async () => {
            if (scanner !== current || video.readyState < 2 || current.detecting) return;
            current.detecting = true;
            try {
                const results = await detector.detect(video);
                if (scanner !== current) return;
                for (const result of results || []) if (await onScan(result.rawValue)) { if (scanner === current) close(); return; }
            } catch (_) {} finally { current.detecting = false; }
        }, 180);
    }
    global.addEventListener('pagehide', close);
    global.TunnelCodeScanner = { open, close };
})(window);
