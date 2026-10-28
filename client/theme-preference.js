// Application documents share only the saved visual preference.
// This intentionally does not select accounts, start tasks, or write preferences.
(() => {
    'use strict';
    const standalone = Boolean(document.body?.dataset.themePage);

    function syncThemePreference() {
        let theme = null;
        try { theme = window.localStorage.getItem('uiTheme'); } catch (_) {}
        if (!document.body) return;
        if (theme === 'lumen' || theme === 'orbit') {
            document.body.dataset.theme = theme;
        } else if (standalone) {
            delete document.body.dataset.theme;
        }
    }

    syncThemePreference();
    if (standalone) {
        window.addEventListener('storage', event => {
            if (event.key === 'uiTheme' || event.key === null) syncThemePreference();
        });
    }
})();
