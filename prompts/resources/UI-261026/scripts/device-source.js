function renderDeviceRow(device, options = {}) {
    const normalized = normalizeContactProfile(device);
    const isSelf = normalized.deviceId === state.deviceId;
    const isCacheNode = normalized.clientType === 'vclient';
    const dataChannelId = device.id || normalized.deviceId;
    const recipients = mediaController?.intercom?.recipients || [];
    const directIntercomTargetId = recipients.length === 1 ? recipients[0] : null;
    const el = document.createElement('div');
    el.className = options.contact ? 'contact-item device-item' : 'device-item';
    el.innerHTML = `
        <div class="icon">${isSelf ? '👤' : '📱'}</div>
        <div class="info">
            <div class="name"></div>
            <div class="status"></div>
        </div>
    `;
    const name = el.querySelector('.name');
    const localRemark = isSelf ? '' : getLocalDeviceRemark(normalized.deviceId)?.remark;
    name.textContent = `${getDeviceDisplayName(normalized, { isSelf })}${isSelf ? ' (我)' : ''}`;
    if (localRemark) name.title = `设备原名：${normalized.name || normalized.deviceId}`;
    makeDeviceNameInteractive(name, normalized);
    const status = el.querySelector('.status');
    status.textContent = isSelf
        ? '在线'
        : isCacheNode
            ? '缓存节点 · 在线（Socket.IO 中继）'
        : (options.contact
            ? `${normalized.model || '未知设备'} · ${normalized.deviceId.slice(0, 8)}...`
            : `在线 · P2P${state.dataChannels.has(dataChannelId) ? '已连接' : '连接中'}`);

    if (!isSelf && !isCacheNode) {
        const actions = document.createElement('div');
        actions.className = 'device-actions';
        const voiceButton = document.createElement('button');
        voiceButton.className = 'icon-action';
        voiceButton.type = 'button';
        voiceButton.title = '发起语音通话（不受隧道限制）';
        voiceButton.setAttribute('aria-label', `向 ${getDeviceDisplayName(normalized)} 发起语音通话`);
        voiceButton.textContent = '☎';
        voiceButton.addEventListener('click', () => startContactVoiceCall(normalized));
        const intercomButton = document.createElement('button');
        intercomButton.className = 'icon-action';
        intercomButton.type = 'button';
        intercomButton.title = `${normalized.deviceId === directIntercomTargetId ? '关闭' : '发起'}对讲`;
        intercomButton.textContent = normalized.deviceId === directIntercomTargetId ? '×' : '📢';
        intercomButton.addEventListener('click', () => startIntercomWithDevice(normalized));
        actions.append(voiceButton, intercomButton);
        el.appendChild(actions);
    }
    return el;
}
