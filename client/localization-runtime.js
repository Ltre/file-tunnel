// Compatibility loader: the only frontend translation runtime is i18n.js.
(function (global) {
    if (global.TunnelI18n?.initialized) return;
    const script = document.createElement('script');
    script.src = '/client/i18n.js';
    document.head.appendChild(script);
})(window);
