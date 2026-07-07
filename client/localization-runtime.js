(function () {
    'use strict';

    const STORAGE_KEY = 'drop2tunnel.language';
    const DEFAULT_LANGUAGE = 'zh-Hans';
    const LANGUAGES = [
        ['zh-Hans', '中文简体'], ['zh-Hant', '中文繁體'], ['en', 'English'],
        ['ja', '日本語'], ['fr', 'Français'], ['ru', 'Русский'], ['es', 'Español'],
        ['it', 'Italiano'], ['ko', '한국어'], ['ms', 'Bahasa Melayu'],
        ['id', 'Bahasa Indonesia'], ['vi', 'Tiếng Việt'], ['th', 'ไทย']
    ];
    const ATTRIBUTES = ['title', 'placeholder', 'aria-label'];
    const catalog = new Map();
    const reverse = new Map();
    const textSources = new WeakMap();
    const attributeSources = new WeakMap();
    let applying = false;

    const dynamicTemplates = [
        [/^(\d+)\s*个任务$/, ['{n} 個工作','{n} tasks','タスク {n} 件','{n} tâches','Задач: {n}','{n} tareas','{n} attività','작업 {n}개','{n} tugas','{n} tugas','{n} tác vụ','{n} งาน']],
        [/^进行中\s*(\d+)$/, ['進行中 {n}','{n} active','実行中 {n}','{n} en cours','Выполняется: {n}','{n} en curso','{n} in corso','진행 중 {n}','{n} aktif','{n} aktif','{n} đang chạy','กำลังทำ {n}']],
        [/^(\d+)\s*个停滞$/, ['{n} 個停滯','{n} stalled','停滞 {n} 件','{n} bloquées','Зависло: {n}','{n} detenidas','{n} bloccate','정체 {n}개','{n} terhenti','{n} terhenti','{n} bị dừng','ค้าง {n}']],
        [/^(\d+)\s*个建链中$/, ['{n} 個正在建立連線','{n} connecting','接続中 {n} 件','{n} en connexion','Подключается: {n}','{n} conectando','{n} in connessione','연결 중 {n}개','{n} menyambung','{n} menghubungkan','{n} đang kết nối','กำลังเชื่อมต่อ {n}']],
        [/^(\d+)\s*个等待$/, ['{n} 個等待','{n} waiting','待機中 {n} 件','{n} en attente','Ожидает: {n}','{n} en espera','{n} in attesa','대기 {n}개','{n} menunggu','{n} menunggu','{n} đang chờ','รอ {n}']]
    ];

    const keyOf = value => String(value || '').trim().replace(/\s+/g, '');

    Object.entries(window.Drop2TunnelI18nCatalog || {}).forEach(([source, translations]) => {
        const key = keyOf(source);
        const entry = { source, translations: translations || {} };
        catalog.set(key, entry);
        [source, ...Object.values(entry.translations)].forEach(value => {
            const reverseKey = keyOf(value);
            if (reverseKey) reverse.set(reverseKey, key);
        });
    });

    function normalizeLanguage(value) {
        const raw = String(value || '').toLowerCase();
        if (raw.startsWith('zh-tw') || raw.startsWith('zh-hk') || raw.includes('hant')) return 'zh-Hant';
        if (raw.startsWith('zh')) return DEFAULT_LANGUAGE;
        return LANGUAGES.find(([code]) => raw === code.toLowerCase())?.[0]
            || LANGUAGES.find(([code]) => raw.startsWith(code.toLowerCase().split('-')[0]))?.[0]
            || DEFAULT_LANGUAGE;
    }

    function currentLanguage() {
        return normalizeLanguage(localStorage.getItem(STORAGE_KEY) || navigator.language);
    }

    function resolve(value) {
        const normalized = keyOf(value);
        return catalog.has(normalized) ? normalized : (reverse.get(normalized) || '');
    }

    function dynamicTranslation(source, language) {
        const text = String(source || '').trim();
        for (const [pattern, values] of dynamicTemplates) {
            const match = pattern.exec(text);
            if (!match) continue;
            if (language === DEFAULT_LANGUAGE) return text;
            const languageIndex = LANGUAGES.slice(1).findIndex(([code]) => code === language);
            const template = values[languageIndex] || values[1];
            return template.replace('{n}', match[1]);
        }
        return '';
    }

    function translate(source, language = currentLanguage()) {
        const dynamic = dynamicTranslation(source, language);
        if (dynamic) return dynamic;
        const key = resolve(source);
        if (!key) return String(source ?? '');
        const entry = catalog.get(key);
        if (language === DEFAULT_LANGUAGE) return entry.source;
        return entry.translations[language] || entry.translations.en || entry.source;
    }

    function skipped(node) {
        const parent = node.parentElement;
        return !parent || !node.nodeValue?.trim() || Boolean(parent.closest(
            'script,style,code,pre,textarea,[contenteditable="true"],.message-content,.rich-message-editor'
        ));
    }

    function translateTextNode(node, language) {
        if (skipped(node)) return;
        const currentKey = resolve(node.nodeValue);
        const saved = textSources.get(node);
        if (currentKey && (!saved || resolve(saved) !== currentKey)) textSources.set(node, catalog.get(currentKey).source);
        else if (!saved && dynamicTemplates.some(([pattern]) => pattern.test(String(node.nodeValue || '').trim()))) {
            textSources.set(node, String(node.nodeValue || '').trim());
        }
        const source = textSources.get(node);
        if (!source) return;
        const leading = node.nodeValue.match(/^\s*/)?.[0] || '';
        const trailing = node.nodeValue.match(/\s*$/)?.[0] || '';
        const next = `${leading}${translate(source, language)}${trailing}`;
        if (next !== node.nodeValue) node.nodeValue = next;
    }

    function translateElementAttributes(element, language) {
        let sources = attributeSources.get(element);
        if (!sources) attributeSources.set(element, (sources = new Map()));
        ATTRIBUTES.forEach(attribute => {
            if (!element.hasAttribute(attribute)) return;
            const current = element.getAttribute(attribute) || '';
            const currentKey = resolve(current);
            const saved = sources.get(attribute);
            if (currentKey && (!saved || resolve(saved) !== currentKey)) sources.set(attribute, catalog.get(currentKey).source);
            const source = sources.get(attribute);
            if (!source) return;
            const next = translate(source, language);
            if (next !== current) element.setAttribute(attribute, next);
        });
    }

    function bindSelectors(root) {
        const selectors = root?.matches?.('#appLanguageSelect') ? [root] : [...(root?.querySelectorAll?.('#appLanguageSelect') || [])];
        selectors.forEach(select => {
            if (!select.dataset.localizationBound) {
                select.dataset.localizationBound = 'true';
                select.replaceChildren(...LANGUAGES.map(([code, label]) => new Option(label, code)));
                select.addEventListener('change', () => setLanguage(select.value));
            }
            select.value = currentLanguage();
        });
    }

    function render(root = document.body) {
        if (!root) return;
        const language = currentLanguage();
        document.documentElement.lang = language;
        applying = true;
        try {
            if (root.nodeType === Node.TEXT_NODE) {
                translateTextNode(root, language);
                return;
            }
            if (root.nodeType !== Node.ELEMENT_NODE && root !== document) return;
            if (root.nodeType === Node.ELEMENT_NODE) translateElementAttributes(root, language);
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
                acceptNode: node => skipped(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
            });
            while (walker.nextNode()) translateTextNode(walker.currentNode, language);
            root.querySelectorAll?.('[title],[placeholder],[aria-label]').forEach(element => translateElementAttributes(element, language));
            bindSelectors(root);
        } finally {
            applying = false;
        }
    }

    function setLanguage(language) {
        const normalized = normalizeLanguage(language);
        localStorage.setItem(STORAGE_KEY, normalized);
        render(document.body);
        window.dispatchEvent(new CustomEvent('drop2tunnel-language-changed', { detail: { language: normalized } }));
    }

    function start() {
        render(document.body);
        const observer = new MutationObserver(records => {
            if (applying) return;
            const roots = new Set();
            records.forEach(record => {
                if (record.type === 'characterData' || record.type === 'attributes') roots.add(record.target);
                record.addedNodes?.forEach(node => roots.add(node));
            });
            roots.forEach(render);
        });
        observer.observe(document.body, {
            childList: true, subtree: true, characterData: true,
            attributes: true, attributeFilter: ATTRIBUTES
        });
    }

    window.TunnelI18n = {
        languages: LANGUAGES,
        currentLanguage,
        setLanguage,
        t: translate,
        translate: render,
        canonicalKey: keyOf
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
})();
