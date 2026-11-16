(function (global) {
    'use strict';
    const deleting = new WeakMap();
    // Presentation only. Preserve the page's existing pause and request revision rules.
    global.TaskListLoading = {
        busy(list) { return Boolean(deleting.get(list)); },
        async remove(button, card, work) {
            if (!card?.parentElement) return work();
            const list = card.parentElement, content = [...button.childNodes];
            const label = button.getAttribute('aria-label');button.setAttribute('aria-label',button.textContent);
            const spinner = document.createElement('span'); spinner.className = 'task-loading-spinner';
            spinner.setAttribute('aria-hidden', 'true');
            deleting.set(list, (deleting.get(list) || 0) + 1);
            button.replaceChildren(spinner); button.setAttribute('aria-busy', 'true');
            try {
                await work();
                if (card.isConnected) {
                    if (card.animate && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
                        await card.animate([{ transform: 'translateX(0)', opacity: 1 }, { transform: 'translateX(60px)', opacity: 0 }], { duration: 240, easing: 'ease-in', fill: 'forwards' }).finished.catch(()=>{});
                    }
                    card.remove();
                }
            } finally {
                deleting.set(list, Math.max(0, deleting.get(list) - 1));
                button.replaceChildren(...content); button.removeAttribute('aria-busy');
                if(label===null)button.removeAttribute('aria-label');else button.setAttribute('aria-label',label);
            }
        },
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
