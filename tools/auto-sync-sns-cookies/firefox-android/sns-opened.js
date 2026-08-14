const webext = globalThis.browser || globalThis.chrome;
webext.runtime.sendMessage({ type: 'sns-opened' }).catch(() => {});
