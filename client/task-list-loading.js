(function (global) {
    'use strict';
    // Presentation only. Preserve the page's existing pause and request revision rules.
    global.TaskListLoading = {
        wrap(load, { list, paused, buttons }) {
            let clicked = null, active = null;
            for (const button of buttons) button.addEventListener('click', () => {
                clicked = button;
                setTimeout(() => { if (clicked === button) clicked = null; }, 0);
            }, true);
            return async function (options = {}) {
                const button = clicked; clicked = null;
                if (!button) { if (active) return; return load(options); }
                if (!options.force && paused()) return load(options);
                active?.finish();
                const content = [...button.childNodes];
                const spinner = document.createElement('span'); spinner.className = 'task-loading-spinner';
                spinner.setAttribute('aria-hidden', 'true');
                let finished = false;
                const token = { finish() {
                    if (finished) return; finished = true;
                    button.replaceChildren(...content); button.removeAttribute('aria-busy');
                    if (active !== token) return;
                    active = null; list.classList.remove('task-list-loading'); list.removeAttribute('aria-busy');
                } };
                active = token; button.replaceChildren(spinner); button.setAttribute('aria-busy', 'true');
                list.classList.add('task-list-loading'); list.setAttribute('aria-busy', 'true');
                try { return await load(options); } finally { token.finish(); }
            };
        }
    };
})(window);
