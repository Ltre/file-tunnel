'use strict';
// Shared directory tree; callers provide their own authenticated, scoped transport.
(function () {
    const normalize = value => {
        const parts = String(value || '').replace(/\\/g, '/').split('/').map(part => part.trim()).filter(part => part && part !== '.');
        if (parts.some(part => part === '..' || part.length > 100 || /[:*?"<>|\u0000-\u001f]/.test(part)) || parts.length > 20) throw new Error('目录路径不合法：请检查名称、非法字符或目录层级');
        return parts.join('/');
    };
    const contains = (root, path) => !root || path === root || path.startsWith(root + '/');
    async function choose({ items = [], title = '移动到', confirmText = '移动', initialPath = '', rootPath = '', rootName = '根目录',
        loadDirectories, createDirectory, openDialog, installContextGesture, onCreateDirectory, onReady, controls = [], showError = error => alert(error.message) }) {
        rootPath = normalize(rootPath);
        const blocked = path => items.some(item => item.kind === 'directory' && (path === item.path || path.startsWith(item.path + '/')));
        const display = path => '/' + (rootPath ? path.slice(rootPath.length).replace(/^\//, '') : path);
        const resolve = value => normalize([rootPath, normalize(value)].filter(Boolean).join('/'));
        const root = document.createElement('div'); root.className = 'disk-destination-tree'; root.setAttribute('role', 'tree');
        const pathInput = document.createElement('input'); pathInput.maxLength = 2048;
        pathInput.placeholder = rootPath ? '/子目录/新目录（相对协同根目录）' : '/音乐/日本/专辑（全路径）';
        pathInput.setAttribute('aria-label', rootPath ? '目标目录（相对协同根目录）' : '目标目录全路径');
        const hint = document.createElement('p'); hint.textContent = '点击选择目标；右键或长按目录可新建子目录，也可使用下方按钮。';
        const create = document.createElement('button'); create.type = 'button'; create.className = 'btn'; create.textContent = '创建多级目录并选中';
        const createChild = document.createElement('button'); createChild.type = 'button'; createChild.className = 'btn'; createChild.textContent = '在所选目录新建子目录';
        const expanded = new Set([rootPath]);
        let selected = contains(rootPath, initialPath) && !blocked(initialPath) ? initialPath : rootPath;
        let busy = false, closed = false, directories = [];
        function expandParents(path) {
            let cursor = path;
            while (contains(rootPath, cursor)) { expanded.add(cursor); if (cursor === rootPath || !cursor) break; cursor = cursor.split('/').slice(0, -1).join('/'); }
        }
        expandParents(selected);
        function select(path) {
            selected = path; pathInput.value = display(path);
            root.querySelectorAll('[data-folder-path]').forEach(button => button.classList.toggle('selected', button.dataset.folderPath === path));
        }
        const errorLabel = document.createElement('p'); errorLabel.className = 'disk-folder-error'; errorLabel.setAttribute('role', 'alert');
        const error = cause => { if (!closed) { errorLabel.textContent = cause.message || '操作失败'; showError(cause); } };
        async function createDestination(path) {
            if (!contains(rootPath, path) || blocked(path)) throw new Error('不能移动到自己或子目录');
            const result = await createDirectory(path);
            if (closed) return;
            const created = normalize(result?.path || path);
            if (!contains(rootPath, created)) throw new Error('目标目录超出授权范围');
            onCreateDirectory?.(created);
            selected = created; expandParents(created); await reload();
        }
        function editChild(folder, container) {
            root.querySelector('.disk-folder-editor')?.remove();
            const row = document.createElement('div'); row.className = 'disk-folder-editor';
            const input = document.createElement('input'); input.value = '新建文件夹'; input.maxLength = 2048; input.setAttribute('aria-label', '子目录名称或多级路径');
            const save = document.createElement('button'); save.type = 'button'; save.className = 'btn'; save.textContent = '创建';
            const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'btn'; cancel.textContent = '取消'; cancel.onclick = () => row.remove();
            save.onclick = async () => {
                if (busy || !input.value.trim()) return;
                busy = true; save.disabled = true;
                try { await createDestination(normalize([folder.path, normalize(input.value)].filter(Boolean).join('/'))); }
                catch (cause) { error(cause); } finally { busy = false; save.disabled = false; }
            };
            row.onkeydown = event => {
                if (event.isComposing || !['Enter', 'Escape'].includes(event.key)) return;
                event.preventDefault(); event.stopPropagation(); if (event.key === 'Enter') save.click(); else row.remove();
            };
            row.append('📁', input, save, cancel); container.prepend(row); input.focus(); input.select();
        }
        async function reload() {
            const data = await loadDirectories();
            if (closed) return;
            directories = data.directories.filter(folder => contains(rootPath, folder.path) && !blocked(folder.path));
            root.replaceChildren();
            const children = new Map();
            for (const folder of directories) {
                if (folder.path === rootPath) continue;
                const parent = folder.path.split('/').slice(0, -1).join('/');
                if (!children.has(parent)) children.set(parent, []); children.get(parent).push(folder);
            }
            function branch(folder) {
                const details = document.createElement('details'); details.className = 'disk-folder-branch'; details.open = expanded.has(folder.path);
                const summary = document.createElement('summary');
                const target = document.createElement('button'); target.type = 'button'; target.className = 'disk-folder-target'; target.dataset.folderPath = folder.path; target.textContent = '📁 ' + folder.name;
                target.onclick = event => { event.preventDefault(); select(folder.path); details.open = true; expanded.add(folder.path); };
                const nested = document.createElement('div'); nested.className = 'disk-folder-children'; nested.setAttribute('role', 'group');
                summary.append(target); details.append(summary, nested);
                details.ontoggle = () => { if (details.open) expanded.add(folder.path); else expanded.delete(folder.path); };
                for (const entry of children.get(folder.path) || []) nested.append(branch(entry));
                const showChild = event => {
                    if (closed) return;
                    event.preventDefault();
                    root.querySelector('.disk-tree-menu')?.remove(); select(folder.path);
                    const menu = document.createElement('div'); menu.className = 'disk-tree-menu';
                    const child = document.createElement('button'); child.type = 'button'; child.textContent = '新建子目录';
                    const rect = root.getBoundingClientRect();
                    menu.style.left = Math.max(0, Math.min(rect.width - 150, event.clientX - rect.left)) + 'px';
                    menu.style.top = Math.max(0, Math.min(rect.height - 44, event.clientY - rect.top)) + root.scrollTop + 'px';
                    child.onclick = () => { menu.remove(); details.open = true; expanded.add(folder.path); editChild(folder, nested); };
                    menu.append(child); root.append(menu);
                };
                if (installContextGesture) installContextGesture(target, showChild);
                else {
                    target.addEventListener('contextmenu', showChild);
                    let timer, start;
                    target.addEventListener('touchstart', event => {
                        if (event.touches.length !== 1) return;
                        const point = event.touches[0]; start = { x: point.clientX, y: point.clientY };
                        timer = setTimeout(() => showChild({ clientX: start.x, clientY: start.y, preventDefault() {} }), 500);
                    }, { passive: true });
                    target.addEventListener('touchmove', event => { const point = event.touches[0]; if (!point || !start || Math.hypot(point.clientX - start.x, point.clientY - start.y) > 8) clearTimeout(timer); }, { passive: true });
                    for (const type of ['touchend', 'touchcancel']) target.addEventListener(type, () => clearTimeout(timer));
                }
                return details;
            }
            if (selected !== rootPath && !directories.some(folder => folder.path === selected)) selected = rootPath;
            root.append(branch({ path: rootPath, name: rootName })); select(selected);
        }
        root.addEventListener('click', event => { if (!event.target.closest('.disk-tree-menu')) root.querySelector('.disk-tree-menu')?.remove(); });
        create.onclick = async () => {
            if (busy) return; busy = true; create.disabled = true;
            try { await createDestination(resolve(pathInput.value)); } catch (cause) { error(cause); }
            finally { busy = false; create.disabled = false; }
        };
        createChild.onclick = () => {
            const branch = [...root.querySelectorAll('[data-folder-path]')].find(node => node.dataset.folderPath === selected)?.closest('.disk-folder-branch');
            if (branch) { branch.open = true; editChild({ path: selected }, branch.querySelector('.disk-folder-children')); }
        };
        await reload();
        onReady?.(reload);
        try {
            return await openDialog({ title, body: [...controls, hint, root, pathInput, create, createChild, errorLabel], confirmText, historyEntry: true, dismissOnBackdrop: true, validate: async () => {
                if (busy) throw new Error('正在创建目录，请稍候');
                const safe = resolve(pathInput.value);
                if (blocked(safe)) throw new Error('不能移动到自己或子目录');
                const data = await loadDirectories();
                if (safe !== rootPath && !data.directories.some(folder => folder.path === safe)) throw new Error('目标目录不存在，请先点击“创建多级目录并选中”');
                return safe;
            } });
        } finally { closed = true; }
    }
    window.DiskDirectoryPicker = { choose, normalize, contains };
})();
