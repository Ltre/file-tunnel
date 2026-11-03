
        function getRuntimeConfig() {
            return window.TUNNEL_CONFIG || {};
        }

        function buildSocketServerUrl() {
            const runtimeConfig = getRuntimeConfig();

            if (runtimeConfig.SOCKET_SERVER) {
                return runtimeConfig.SOCKET_SERVER;
            }

            return window.location.origin;
        }

        const socket = io(buildSocketServerUrl(), {
            transports: ['websocket', 'polling']
        });
        document.getElementById('adminLogoutBtn')?.addEventListener('click', async () => {
            await fetch('/api/admin/auth/logout', { method: 'POST' });
            window.location.replace('/admin-auth');
        });
        const SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]{8,64}$/;
        
        // 加载数据
        async function loadData() {
            try {
                // 从服务器获取会话信息
                const sessionsResponse = await fetch('/api/sessions');
                const data = await sessionsResponse.json();
                const sessions = (data.sessions || [])
                    .filter(session => isValidSessionId(session.id))
                    .map(session => ({
                        ...session,
                        source: 'server',
                        messageCount: Number(session.messageCount) || 0,
                        fileCount: Number(session.fileCount) || 0,
                        activeDeviceCount: Number(session.activeDeviceCount) || 0,
                        realActiveDeviceCount: Number(session.realActiveDeviceCount) || 0,
                        historicalDeviceCount: Number(session.historicalDeviceCount) || 0,
                        historicalAllDeviceCount: Number(session.historicalAllDeviceCount) || 0,
                        totalFileSize: Number(session.totalFileSize) || 0
                    }));
                updateStats({
                    sessions,
                    totalDevices: data.totalDevices ?? 0,
                    totalMessages: sessions.reduce((total, session) => total + (session.messageCount || 0), 0),
                    totalFiles: sessions.reduce((total, session) => total + (session.fileCount || 0), 0)
                });
                renderSessions(sessions);

                
                document.getElementById('lastUpdate').textContent = 
                    '更新于: ' + new Date().toLocaleTimeString('zh-CN');
            } catch (err) {
                console.error('Failed to load data:', err);
                // 如果API不可用，从本地存储读取
                loadFromLocalStorage();
            }
        }

        function isValidSessionId(id) {
            return typeof id === 'string' && SESSION_ID_PATTERN.test(id);
        }

        function makeSessionUrl(sessionId) {
            return `${window.location.origin}/#${sessionId}`;
        }

        function escapeHtml(value) {
            return String(value).replace(/[&<>"']/g, char => ({
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;',
                '"': '&quot;',
                "'": '&#39;'
            }[char]));
        }

        function formatBytes(value) {
            let size = Math.max(0, Number(value) || 0);
            const units = ['B', 'KB', 'MB', 'GB', 'TB'];
            let unit = 0;
            while (size >= 1024 && unit < units.length - 1) {
                size /= 1024;
                unit++;
            }
            return `${unit && size < 10 ? size.toFixed(1) : Math.round(size)} ${units[unit]}`;
        }

        function openTunnelDb() {
            return new Promise((resolve) => {
                if (!window.indexedDB) {
                    resolve(null);
                    return;
                }

                const request = indexedDB.open('TunnelDB');
                request.onerror = () => resolve(null);
                request.onblocked = () => resolve(null);
                request.onsuccess = (event) => resolve(event.target.result);
            });
        }

        function readAllFromDb(db, storeName) {
            return new Promise((resolve) => {
                if (!db || !db.objectStoreNames.contains(storeName)) {
                    resolve([]);
                    return;
                }

                try {
                    const transaction = db.transaction([storeName], 'readonly');
                    const request = transaction.objectStore(storeName).getAll();
                    request.onsuccess = () => resolve(request.result || []);
                    request.onerror = () => resolve([]);
                } catch (err) {
                    console.warn(`Failed to read ${storeName}:`, err);
                    resolve([]);
                }
            });
        }

        function deleteLocalSessionHistory(sessionId) {
            return new Promise(async (resolve) => {
                const db = await openTunnelDb();
                if (!db) {
                    resolve(false);
                    return;
                }

                const stores = ['sessions', 'messages', 'files', 'editorContent']
                    .filter(storeName => db.objectStoreNames.contains(storeName));
                if (!stores.length) {
                    db.close();
                    resolve(false);
                    return;
                }

                try {
                    const transaction = db.transaction(stores, 'readwrite');
                    if (stores.includes('sessions')) {
                        transaction.objectStore('sessions').delete(sessionId);
                    }
                    if (stores.includes('messages')) {
                        const store = transaction.objectStore('messages');
                        const request = store.getAll();
                        request.onsuccess = () => {
                            (request.result || [])
                                .filter(item => item.sessionId === sessionId)
                                .forEach(item => store.delete(item.id));
                        };
                    }
                    if (stores.includes('files')) {
                        const store = transaction.objectStore('files');
                        const request = store.getAll();
                        request.onsuccess = () => {
                            (request.result || [])
                                .filter(item => item.sessionId === sessionId)
                                .forEach(item => store.delete(item.id));
                        };
                    }
                    if (stores.includes('editorContent')) {
                        const store = transaction.objectStore('editorContent');
                        const request = store.get('current');
                        request.onsuccess = () => {
                            if (request.result?.sessionId === sessionId) store.delete('current');
                        };
                    }
                    transaction.oncomplete = () => {
                        db.close();
                        resolve(true);
                    };
                    transaction.onerror = () => {
                        db.close();
                        resolve(false);
                    };
                } catch (err) {
                    console.warn('Failed to delete local session history:', err);
                    db.close();
                    resolve(false);
                }
            });
        }

        function upsertLocalSession(sessionMap, sessionId, timestamp) {
            if (!isValidSessionId(sessionId)) return;

            const time = Number(timestamp) || Date.now();
            const current = sessionMap.get(sessionId);
            if (!current) {
                sessionMap.set(sessionId, {
                    id: sessionId,
                    deviceCount: 0,
                    createdAt: time,
                    lastActivity: time,
                    isActive: false,
                    isLocalHistory: true,
                    messageCount: 0,
                    fileCount: 0
                });
                return;
            }

            current.createdAt = Math.min(current.createdAt || time, time);
            current.lastActivity = Math.max(current.lastActivity || time, time);
        }

        async function loadLocalHistory() {
            const db = await openTunnelDb();
            if (!db) {
                return { sessions: [], totalMessages: 0, totalFiles: 0 };
            }

            try {
                const [storedSessions, messages, files, editorContents] = await Promise.all([
                    readAllFromDb(db, 'sessions'),
                    readAllFromDb(db, 'messages'),
                    readAllFromDb(db, 'files'),
                    readAllFromDb(db, 'editorContent')
                ]);

                const sessionMap = new Map();
                storedSessions.forEach(item => {
                    upsertLocalSession(sessionMap, item.sessionId, item.lastActive || item.createdAt);
                    const session = sessionMap.get(item.sessionId);
                    if (session && item.deviceId) {
                        session.deviceCount = Math.max(session.deviceCount, 1);
                    }
                });

                messages.forEach(message => {
                    upsertLocalSession(sessionMap, message.sessionId, message.timestamp);
                    const session = sessionMap.get(message.sessionId);
                    if (session) session.messageCount += 1;
                });

                files.forEach(file => {
                    upsertLocalSession(sessionMap, file.sessionId, file.timestamp || file.lastModified);
                    const session = sessionMap.get(file.sessionId);
                    if (session) session.fileCount += 1;
                });

                editorContents.forEach(content => {
                    upsertLocalSession(sessionMap, content.sessionId, content.updatedAt || content.timestamp);
                });

                return {
                    sessions: Array.from(sessionMap.values()),
                    totalMessages: messages.length,
                    totalFiles: files.length
                };
            } finally {
                db.close();
            }
        }

        function mergeSessions(serverSessions, localSessions) {
            const sessionMap = new Map();

            serverSessions.forEach(session => {
                if (!isValidSessionId(session.id)) return;
                sessionMap.set(session.id, {
                    ...session,
                    isLocalHistory: false,
                    messageCount: Number(session.messageCount) || 0,
                    fileCount: Number(session.fileCount) || 0
                });
            });

            localSessions.forEach(localSession => {
                if (!isValidSessionId(localSession.id)) return;

                const existing = sessionMap.get(localSession.id);
                if (existing) {
                    existing.createdAt = Math.min(existing.createdAt || localSession.createdAt, localSession.createdAt);
                    existing.lastActivity = Math.max(existing.lastActivity || localSession.lastActivity, localSession.lastActivity);
                    existing.messageCount = Math.max(Number(existing.messageCount) || 0, Number(localSession.messageCount) || 0);
                    existing.fileCount = Math.max(Number(existing.fileCount) || 0, Number(localSession.fileCount) || 0);
                    existing.hasLocalHistory = true;
                    return;
                }

                sessionMap.set(localSession.id, {
                    ...localSession,
                    isActive: false,
                    isLocalHistory: true
                });
            });

            return Array.from(sessionMap.values())
                .sort((a, b) => Number(b.isOnline) - Number(a.isOnline) || (b.lastActivity || 0) - (a.lastActivity || 0));
        }
        
        // 从本地存储加载（备用）
        async function loadFromLocalStorage() {
            try {
                const localData = await loadLocalHistory();
                const sessions = localData.sessions;
                
                // 从消息中提取会话
                for (let i = 0; i < localStorage.length; i++) {
                    const key = localStorage.key(i);
                    if (key && key.startsWith('tunnel_')) {
                        try {
                            const data = JSON.parse(localStorage.getItem(key));
                            if (data && isValidSessionId(data.sessionId) && !sessions.some(session => session.id === data.sessionId)) {
                                sessions.push({
                                    id: data.sessionId,
                                    deviceCount: 1,
                                    createdAt: data.timestamp || Date.now(),
                                    lastActivity: data.timestamp || Date.now(),
                                    isActive: false,
                                    isLocalHistory: true,
                                    messageCount: 0,
                                    fileCount: 0
                                });
                            }
                        } catch (e) {}
                    }
                }

                sessions.sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0));
                updateStats({
                    sessions,
                    totalDevices: 0,
                    totalMessages: localData.totalMessages,
                    totalFiles: localData.totalFiles
                });
                renderSessions(sessions);
                renderDevices([]);
                renderMagnets([]);
            } catch (err) {
                console.error('Failed to load from localStorage:', err);
            }
        }
        
        // 更新统计
        function updateStats(data) {
            if (!document.getElementById('totalSessions')) return;
            document.getElementById('totalSessions').textContent = data.sessions?.length || 0;
            document.getElementById('totalDevices').textContent = data.totalDevices || 0;
            document.getElementById('totalMessages').textContent = data.totalMessages || 0;
            document.getElementById('totalFiles').textContent = data.totalFiles || 0;
        }
        
        let allSessionsForFilter = [];
        function applySessionFilters() { renderSessions(allSessionsForFilter); }
        function sessionMatchesFilters(session, filters) {
            return (filters.active === 'all' || Boolean(session.isActive) === (filters.active === 'yes')) &&
                (filters.online === 'all' || (session.isOnline === true) === (filters.online === 'yes')) &&
                (filters.records === 'all' || (Number(session.messageCount) > 0) === (filters.records === 'yes'));
        }
        // 渲染隧道列表（会话列表）
        function renderSessions(sessions) {
            const container = document.getElementById('sessionList');
            if (!container) return;
            allSessionsForFilter = sessions || [];
            const filters = { active: document.getElementById('sessionActiveFilter')?.value || 'all', online: document.getElementById('sessionOnlineFilter')?.value || 'all', records: document.getElementById('sessionRecordsFilter')?.value || 'all' };
            sessions = allSessionsForFilter.filter(session => sessionMatchesFilters(session,filters));
            const summary = document.getElementById('sessionFilterSummary');
            if (summary) summary.textContent = (window.TunnelI18n?.t('符合条件：{0} / {1}') || '符合条件：{0} / {1}').replace('{0}', sessions.length).replace('{1}', allSessionsForFilter.length);
            
            if (!sessions || sessions.length === 0) {
                container.innerHTML = `
                    <div class="empty-state">
                        <div class="empty-state-icon">📭</div>
                        <div>暂无会话</div>
                    </div>
                `;
                return;
            }
            
            container.innerHTML = sessions.map(session => {
                const safeId = escapeHtml(session.id);
                const safeShortCode = escapeHtml(session.shortCode || '-----');
                const safeRemark = escapeHtml(String(session.remark || '').trim());
                const shortId = escapeHtml(session.id.substring(0, 8) + '...');
                const createdTime = new Date(session.createdAt || Date.now()).toLocaleString('zh-CN');
                const lastActivity = new Date(session.lastActivity || session.createdAt || Date.now()).toLocaleString('zh-CN');
                const isActive = session.isActive === true;
                const isOnline = session.isOnline === true;
                const isDeleted = session.isDeleted === true;
                const statusClass = isOnline ? 'status-active' : (session.isLocalHistory ? 'status-local' : 'status-inactive');
                const statusText = isDeleted ? '已删除（审计留痕）' : (isOnline ? '真实设备在线' : (session.isLocalHistory ? '离线历史' : '真实设备离线'));
                const activityText = isActive ? '活跃' : '非活跃';
                const cacheEnabled = session.cacheNodeEnabled === true;
                const cacheOnline = session.cacheNodeOnline === true;
                const cacheState = escapeHtml({
                    disabled: '未启用', starting: '正在启动', 'waiting-process': '等待独立进程',
                    syncing: '正在同步', active: '运行中', reconnecting: '正在重连',
                    stopping: '正在停止', stopped: '已停止', error: '异常'
                }[session.cacheNodeState] || session.cacheNodeState || '未启用');
                const showCacheDetails = cacheEnabled || Number(session.cacheNodeCachedFiles) > 0 || !['', 'disabled'].includes(session.cacheNodeState || '');
                const cacheAction = !isDeleted ? `<button class="btn ${cacheEnabled ? 'btn-danger' : 'btn-cache'}" onclick="toggleCacheNode('${safeId}', ${cacheEnabled ? 'false' : 'true'})">
                                <span>${cacheEnabled ? '停止缓存节点' : '启用缓存节点'}</span>
                            </button>` : '';
                const cacheView = showCacheDetails ? `<a class="btn btn-secondary" href="/vclient?sessionId=${encodeURIComponent(session.id)}">
                                <span>查看缓存节点</span>
                            </a>` : '';
                
                return `
                    <div class="session-item" data-session-id="${safeId}">
                        <div class="session-icon">🔗</div>
                        <div class="session-info">
                            <div class="session-id">
                                隧道 ${shortId}
                                <span class="status-badge status-local">短码 ${safeShortCode}</span>
                                <span class="status-badge ${statusClass}">
                                    ${statusText}
                                </span>
                                <span class="status-badge ${isActive ? 'status-active' : 'status-inactive'}">
                                    ${activityText}
                                </span>
                            </div>
                            <div class="session-meta">
                                <div>隧道备注：${safeRemark || '未设置'}</div>
                                <div><span>创建设备</span>：${session.ownerDeviceId ? escapeHtml(session.ownerDeviceName || session.ownerDeviceId) + (session.ownerDeviceName ? ' · <code>' + escapeHtml(session.ownerDeviceId) + '</code>' : '') : '<span>无</span> <button type="button" class="session-owner-info" aria-label="查看创建者说明" onclick="showSessionCreatorInfo()">i</button>'}</div>
                                <div>5 位短码：<code>${safeShortCode}</code></div>
                                <div>隧道 ID：<code>${safeId}</code></div>
                                <div>活跃设备：<span class="device-count">📱 ${Number(session.activeDeviceCount) || 0} 台</span>（真实设备 ${Number(session.realActiveDeviceCount) || 0}${cacheOnline ? '，缓存节点在线' : ''}）</div>
                                <div>历史总设备：${Number(session.historicalAllDeviceCount) || Number(session.historicalDeviceCount) || 0}（真实设备 ${Number(session.historicalDeviceCount) || 0}）</div>
                                <div>缓存节点：${cacheState}${session.cacheNodeError ? ` · ${escapeHtml(session.cacheNodeError)}` : ''}</div>
                                <div>创建时间：${createdTime}</div>
                                <div>最后活动：${lastActivity}</div>
                                <div>传输记录：${Number(session.messageCount) || 0}</div>
                                <div>传输文件：${Number(session.fileCount) || 0}</div>
                                <div>唯一文件：${Number(session.uniqueFileCount) || 0}</div>
                                <div>文件占用总大小：${formatBytes(session.totalFileSize)}</div>
                            </div>
                        </div>
                        <div class="session-actions">
                            ${isDeleted ? '' : `<a href="/api/sessions/${safeId}/enter" target="_blank" rel="noopener noreferrer" class="btn btn-primary">
                                <span>🔗</span>
                                <span>进入隧道</span>
                            </a>`}
                            ${isDeleted ? '' : `<button class="btn btn-secondary" onclick="copyLink('${safeId}')">
                                <span>📋</span>
                                <span>复制链接</span>
                            </button>`}
                            ${cacheAction}
                            ${cacheView}
                            ${isDeleted ? '' : `<a class="btn btn-secondary" href="/admin/tunnel-permissions?session=${safeId}">设备权限</a>`}
                            ${isDeleted ? '' : `<button class="btn" onclick="rotateSessionCode('${safeId}')">修改短码</button>`}
                            ${isDeleted ? '' : `<button class="btn btn-danger" onclick="deleteSession('${safeId}')">
                                <span>删除</span>
                            </button>`}
                        </div>
                    </div>
                `;
            }).join('');
        }

        function renderDevices(devices) {
            const container = document.getElementById('deviceList');
            if (!container) return;

            if (!devices || devices.length === 0) {
                container.innerHTML = `
                    <div class="empty-state">
                        <div class="empty-state-icon">📱</div>
                        <div>暂无访问设备</div>
                    </div>
                `;
                return;
            }

            container.innerHTML = devices.map(device => {
                const deviceId = escapeHtml(device.deviceId || device.key || 'unknown');
                const shortId = escapeHtml(deviceId.length > 18 ? `${deviceId.slice(0, 18)}...` : deviceId);
                const sessionId = device.sessionId ? escapeHtml(device.sessionId) : '未加入';
                const ip = escapeHtml(device.ip || device.externalIp || 'unknown');
                const localIp = escapeHtml(device.localIp || '-');
                const model = escapeHtml(device.deviceModel || device.userAgent || '-');
                const name = escapeHtml(device.deviceName || '未命名设备');
                const lastAccess = new Date(device.lastAccess || Date.now()).toLocaleString('zh-CN');
                const statusClass = device.online ? 'status-active' : 'status-inactive';
                const activeClass = device.active ? 'status-active' : 'status-inactive';
                const statusText = device.online ? '在线' : '离线';
                const activeText = device.active ? '活跃' : '不活跃';

                return `
                    <div class="device-item" data-device-id="${deviceId}">
                        <div>
                            <div class="device-title">
                                ${name} · ${shortId}
                                <span class="status-badge ${statusClass}">${statusText}</span>
                                <span class="status-badge ${activeClass}">${activeText}</span>
                            </div>
                            <div class="device-meta">
                                <div>所在隧道: ${sessionId}</div>
                                <div>外网/IP: ${ip} · 内网: ${localIp}</div>
                                <div>型号/UA: ${model}</div>
                                <div>最后访问: ${lastAccess}</div>
                            </div>
                        </div>
                    </div>
                `;
            }).join('');
        }

        function formatFileSize(bytes) {
            const value = Number(bytes) || 0;
            if (value <= 0) return '0 B';
            const units = ['B', 'KB', 'MB', 'GB'];
            const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
            return `${(value / Math.pow(1024, index)).toFixed(index ? 2 : 0)} ${units[index]}`;
        }

        function renderMagnets(magnets) {
            const container = document.getElementById('magnetList');
            if (!container) return;

            if (!magnets || magnets.length === 0) {
                container.innerHTML = `
                    <div class="empty-state">
                        <div class="empty-state-icon">🧲</div>
                        <div>暂无已分享磁链</div>
                    </div>
                `;
                return;
            }

            container.innerHTML = magnets.map(magnet => {
                const asset = magnet.asset || {};
                const id = escapeHtml(magnet.id);
                const name = escapeHtml(asset.name || magnet.assetId || '未命名文件');
                const url = escapeHtml(magnet.url || makeMagnetUrl(magnet.id));
                const sessionId = escapeHtml(magnet.sessionId || '-');
                const size = formatFileSize(asset.size);
                const type = escapeHtml(asset.type || 'application/octet-stream');
                const createdAt = new Date(magnet.createdAt || Date.now()).toLocaleString('zh-CN');
                const creator = escapeHtml(magnet.createdByDeviceName || magnet.createdByDeviceId || '-');
                const seedCount = Number(magnet.seedCount) || 0;

                return `
                    <div class="magnet-item" data-magnet-id="${id}">
                        <div>
                            <div class="magnet-title">${name}</div>
                            <div class="magnet-meta">
                                <div>大小: ${size} · 类型: ${type} · 在线种子: ${seedCount}</div>
                                <div>隧道: ${sessionId}</div>
                                <div>分享设备: ${creator} · 创建: ${createdAt}</div>
                                <div>${url}</div>
                            </div>
                        </div>
                        <div class="session-actions">
                            <a class="btn btn-primary" href="${url}" target="_blank">打开</a>
                            <button class="btn btn-secondary" onclick="copyMagnetLink('${id}', '${url}')">复制磁链</button>
                        </div>
                    </div>
                `;
            }).join('');
        }

        function makeMagnetUrl(magnetId) {
            return `${window.location.origin}/magnet/${encodeURIComponent(magnetId)}`;
        }

        async function copyPlainText(text) {
            if (navigator.clipboard?.writeText && window.isSecureContext) {
                await navigator.clipboard.writeText(text);
                return true;
            }
            const textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.readOnly = true;
            textarea.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
            document.body.appendChild(textarea);
            textarea.focus();
            textarea.select();
            const copied = document.execCommand('copy');
            document.body.removeChild(textarea);
            return copied;
        }

        async function copyMagnetLink(magnetId, url) {
            try {
                if (!await copyPlainText(url)) throw new Error('copy failed');
                alert('磁链已复制: ' + url);
            } catch (err) {
                window.prompt('请手动复制磁链', url);
            }
        }
        
        // 复制链接
        async function copyLink(sessionId) {
            if (!isValidSessionId(sessionId)) return;

            const url = makeSessionUrl(sessionId);
            if (navigator.clipboard?.writeText && window.isSecureContext) {
                try {
                    await navigator.clipboard.writeText(url);
                    alert('链接已复制: ' + url);
                    return;
                } catch (err) {
                    console.warn('Clipboard API copy failed, trying legacy copy:', err);
                }
            }

            try {
                const textarea = document.createElement('textarea');
                textarea.value = url;
                textarea.readOnly = true;
                textarea.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
                document.body.appendChild(textarea);
                textarea.focus();
                textarea.select();
                const copied = document.execCommand('copy');
                document.body.removeChild(textarea);
                if (!copied) throw new Error('Legacy copy command was rejected');
                alert('链接已复制: ' + url);
            } catch (err) {
                console.error('Fallback copy failed:', err);
                window.prompt('浏览器未授予剪贴板权限，请手动复制此链接：', url);
            }
        }

        async function rotateSessionCode(sessionId){const shortCode=prompt('新 5 位短码（旧短码失效，已加入设备不受影响）');if(shortCode===null)return;const response=await fetch('/api/sessions/'+encodeURIComponent(sessionId)+'/short-code',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({shortCode})});const value=await response.json();if(!response.ok)return alert(value.error||'修改失败');await loadData();}
        async function deleteSession(sessionId) {
            if (!isValidSessionId(sessionId) || !confirm(`删除会话 ${sessionId}？这会断开在线设备，并释放对应的隧道暗号。`)) return;
            try {
                const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
                if (!response.ok && response.status !== 404) throw new Error('删除会话失败');
                await deleteLocalSessionHistory(sessionId);
                await loadData();
            } catch (err) {
                alert(err.message);
            }
        }

        async function toggleCacheNode(sessionId, enable) {
            if (!isValidSessionId(sessionId)) return;
            const prompt = enable
                ? `为隧道 ${sessionId} 启用缓存节点？\n\n独立 VClient 进程将加入隧道并缓存可获取的历史及后续文件。`
                : `停止隧道 ${sessionId} 的缓存节点？\n\n节点会退出隧道，但已缓存的记录和文件不会删除；若其他真实供源全部离线，尚未缓存完成的文件可能暂时无法获取。`;
            if (!confirm(prompt)) return;
            try {
                const action = enable ? 'enable' : 'disable';
                const response = await fetch(`/api/vclient/tunnels/${encodeURIComponent(sessionId)}/${action}`, { method: 'POST' });
                const data = await response.json().catch(() => ({}));
                if (!response.ok) throw new Error(data.error || `缓存节点${enable ? '启用' : '停止'}失败`);
                if (enable && !data.processOnline) {
                    alert('启用意图已保存；当前独立 VClient 进程尚未连接。请启动 npm run vclient，连接后会自动加入该隧道。');
                }
                await loadData();
            } catch (error) {
                alert(error.message);
            }
        }
        
        // 导出隧道列表（会话列表）
        function exportSessions() {
            const sessions = [];
            document.querySelectorAll('.session-item').forEach(item => {
                const id = item.dataset.sessionId;
                if (id) {
                    sessions.push({
                        id: id,
                        url: makeSessionUrl(id)
                    });
                }
            });
            
            const data = JSON.stringify(sessions, null, 2);
            const blob = new Blob([data], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `sessions-${new Date().toISOString().split('T')[0]}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }
        
        for (const id of ['sessionActiveFilter','sessionOnlineFilter','sessionRecordsFilter']) document.getElementById(id)?.addEventListener('change',applySessionFilters);
        function showSessionCreatorInfo() { const message = '该隧道尚未记录创建设备，属于早期创建的隧道。此后首个进入该隧道的设备将自动成为创建者。'; alert(window.TunnelI18n?.t(message) || message); }
        // 初始加载
        loadData();
        
        // 自动刷新（每30秒）
        setInterval(loadData, 30000);
