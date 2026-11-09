(function () {
    'use strict';

    const STORAGE_KEY = 'drop2tunnel.language';
    const DEFAULT_LANG = 'zh-Hans';
    const SUPPORTED_LANGUAGES = window.Drop2TunnelI18nConfig?.languages || [];
    if (window.__drop2TunnelLegacyCatalogOnly || window.TunnelI18n?.initialized) return;

    const CATALOG = new Map();
    const REVERSE_CATALOG = new Map();
    const TEXT_SOURCES = new WeakMap();
    const ATTRIBUTE_SOURCES = new WeakMap();
    const TEXT_RENDERED = new WeakMap();
    const TEXT_SPACING = new WeakMap();
    const ATTRIBUTE_RENDERED = new WeakMap();
    const PROTECTED_ATTRIBUTES = 'script,style,code,pre,[data-i18n-raw],[translate="no"]:not(html):not(body),.message-content,.file-name,.collection-file-name,.telegram-drive-item-name,.web-tree-name,.web-draft-title>strong,.file-preview-title-name,.remote-preview-file-name:not([data-i18n-ui]),.remote-preview-device-name,#remotePreviewControlTitle,.disk-editor-preview,#diskPreviewName,#richViewerContent';
    const PROTECTED_CONTENT = 'textarea,[contenteditable="true"],.rich-message-editor,' + PROTECTED_ATTRIBUTES;
    let applyingTranslations = false;
    const DYNAMIC_LANGUAGES = window.Drop2TunnelI18nConfig?.dynamicLanguages || [];
    const DYNAMIC_TEMPLATES = window.Drop2TunnelI18nConfig?.templates || [];
    const TEXT_PATTERNS = window.Drop2TunnelI18nConfig?.textPatterns || [];
    const TEMPLATE_LABELS = window.Drop2TunnelI18nConfig?.templateLabels || {};

    function canonicalKey(value) {
        return String(value || '').trim().replace(/\s+/g, '');
    }

    function registerCatalog(source, entries) {
        Object.entries(entries || {}).forEach(([rawKey, translations]) => {
            const key = canonicalKey(rawKey);
            if (!key) return;
            const simplified = translations?.['zh-Hans'] || rawKey;
            const previous = CATALOG.get(key);
            const translatedValues = Object.fromEntries(Object.entries(translations || {}).filter(([, value]) => value));
            const entry = { source: simplified, translations: { ...(previous?.translations || {}), ...translatedValues } };
            CATALOG.set(key, entry);
            [simplified, ...Object.values(entry.translations)].forEach(value => {
                const reverseKey = canonicalKey(value);
                if (reverseKey) REVERSE_CATALOG.set(reverseKey, key);
            });
        });
    }

    registerCatalog('catalog', window.Drop2TunnelI18nCatalog || {});
    const formattedSources = new Map();
    const parameterized = [...CATALOG.values()].filter(entry => /\{\d+\}/.test(entry.source) && /[\u3400-\u9fff].*[\u3400-\u9fff]/.test(entry.source) && !TEXT_PATTERNS.some(rule=>rule.key===entry.source)).map(entry => {
        const indices = [...entry.source.matchAll(/\{(\d+)\}/g)].map(match => Number(match[1]));
        const parts = entry.source.split(/(\{\d+\})/);
        const pattern = parts.map((part,index) => /^\{\d+\}$/.test(part) ? '([\\s\\S]*?)' : /^\s+$/.test(part) && /^\{\d+\}$/.test(parts[index-1] || '') && /^\{\d+\}$/.test(parts[index+1] || '') ? '\\s+' : part.replace(/[.*+?^${}()|[\]\\]/g,'\\$&').replace(/\s+/g,'\\s*')).join('');
        return { entry, indices, pattern:new RegExp('^'+pattern+'$') };
    }).sort((a,b) => b.entry.source.length-a.entry.source.length);

    function parameterizedText(text, lang) {
        for (const {entry,indices,pattern} of parameterized) {
            const match = pattern.exec(text); if (!match) continue;
            const values = new Map(); let consistent = true;
            indices.forEach((index,n) => { if (values.has(index) && values.get(index)!==match[n+1]) consistent=false; values.set(index,match[n+1]); });
            if (!consistent) continue;
            for (const index of TEMPLATE_LABELS[entry.source] || []) {
                const value = values.get(index);
                if (resolveCatalogKey(value)) values.set(index,translateText(value,lang));
            }
            const template = lang===DEFAULT_LANG ? entry.source : entry.translations[lang] || entry.translations.en || entry.source;
            return template.replace(/\{(\d+)\}/g,(_all,index) => values.get(Number(index)) ?? _all);
        }
        return '';
    }

    function normalizeLanguage(value) {
        const raw = String(value || '').toLowerCase();
        if (raw.startsWith('zh-tw') || raw.startsWith('zh-hk') || raw.includes('hant')) return 'zh-Hant';
        if (raw.startsWith('zh')) return 'zh-Hans';
        const direct = SUPPORTED_LANGUAGES.find(([code]) => code.toLowerCase() === raw);
        if (direct) return direct[0];
        const prefix = SUPPORTED_LANGUAGES.find(([code]) => raw.startsWith(code.toLowerCase().split('-')[0]));
        return prefix ? prefix[0] : 'en';
    }

    function languagePreference() {
        let saved; try { saved = localStorage.getItem(STORAGE_KEY); } catch (_) {}
        return SUPPORTED_LANGUAGES.some(([code]) => code === saved) ? saved : 'system';
    }

    function currentLanguage() {
        const preference = languagePreference();
        return preference === 'system' ? normalizeLanguage(navigator.language || navigator.languages?.[0] || 'en') : preference;
    }

    function resolveCatalogKey(value) {
        const normalized = canonicalKey(value);
        return CATALOG.has(normalized) ? normalized : (REVERSE_CATALOG.get(normalized) || '');
    }

    function translateDynamic(source, lang) {
        const text = String(source || '').trim();
        for (const {pattern,key,labels=[],optionalLabels=[]} of TEXT_PATTERNS) {
            const match=pattern.exec(text); if(!match)continue;
            const values=match.slice(1);
            // Only named system-label slots are translated. Error codes,
            // paths and all other parameter values are kept verbatim.
            let recognized=true;
            for (const index of [...labels,...optionalLabels]) {
                const value=values[index] || '', translated=translateText(value,lang);
                if (!resolveCatalogKey(value) && translated===value) {
                    if(labels.includes(index))recognized=false;
                    continue;
                }
                values[index]=(value.match(/^\s*/)?.[0] || '')+translated.trim()+(value.match(/\s*$/)?.[0] || '');
            }
            if(!recognized)continue;
            return translateText(key,lang).replace(/\{(\d+)\}/g,(_all,index)=>values[Number(index)]??_all);
        }
        for (const [pattern, values, labels = []] of DYNAMIC_TEMPLATES) {
            const match = pattern.exec(text);
            if (!match) continue;
            if (lang === DEFAULT_LANG) return text;
            const template = values[DYNAMIC_LANGUAGES.indexOf(lang)] || values[1];
            const localizeCapture = value => {
                const key = resolveCatalogKey(value);
                if (!key) return value;
                const entry = CATALOG.get(key);
                return entry.translations[lang] || entry.translations.en || entry.source;
            };
            return template.replace(/\{(raw)?(\d+|n)\}/g, (_, raw, index) => {
                const capture = index === 'n' ? 1 : Number(index);
                const value = match[capture] || '';
                return raw || !labels.includes(capture) ? value : localizeCapture(value);
            });
        }
        return '';
    }

    function translateText(source, lang = currentLanguage()) {
        const original = String(source ?? '');
        const text = formattedSources.get(original.trim()) || original;
        if (!text.trim()) return text;
        const key = resolveCatalogKey(text);
        if (key) {
            const entry = CATALOG.get(key);
            if (lang === DEFAULT_LANG) return entry.source;
            return entry.translations[lang] || translateDynamic(entry.source,lang) || entry.translations.en || entry.source;
        }
        if (lang === DEFAULT_LANG) return original;
        // Unknown numeric progress, filenames and technical identifiers cannot
        // match Chinese UI templates. Avoid scanning every template per tick.
        if (!/[\u3400-\u9fff]/.test(text)) return original;
        return translateDynamic(text,lang) || parameterizedText(text.trim(),lang) || original;
    }

    function formatText(source, ...values) {
        const entry = CATALOG.get(resolveCatalogKey(source));
        const localizedValues = values.map((value,index) => (TEMPLATE_LABELS[entry?.source || source] || []).includes(index) && resolveCatalogKey(value) ? translateText(value) : value);
        const substitute = (template,args) => template.replace(/\{(\d+)\}/g,(_all,index) => String(args[Number(index)] ?? _all));
        const text = substitute(translateText(source),localizedValues), original = substitute(String(source),values);
        if (formattedSources.size>=2048) formattedSources.delete(formattedSources.keys().next().value);
        formattedSources.set(text,original);
        return text;
    }

    function dialog(kind,args) {
        const defaults = window.Drop2TunnelI18nConfig?.promptDefaults?.[canonicalKey(args[0])];
        if (kind==='prompt' && defaults?.includes(args[1])) args[1]=translateText(args[1]);
        if (typeof args[0]==='string') args[0]=translateText(args[0]);
        return window[kind](...args);
    }

    function shouldSkipTextNode(node) {
        const parent = node.parentElement;
        return !parent || !node.nodeValue?.trim() || Boolean(parent.closest(PROTECTED_CONTENT));
    }

    function rememberTextSource(node) {
        const saved = TEXT_SOURCES.get(node);
        if (saved && node.nodeValue===TEXT_RENDERED.get(node)) return saved;
        // Preserve whitespace authored by the caller, not whitespace inserted
        // by our previous translation. Otherwise a padded label can grow on
        // every MutationObserver pass and keep the renderer permanently busy.
        TEXT_SPACING.set(node, {
            leading: node.nodeValue.match(/^\s*/)?.[0] || '',
            trailing: node.nodeValue.match(/\s*$/)?.[0] || ''
        });
        const current = formattedSources.get(node.nodeValue.trim()) || node.nodeValue;
        const currentKey = resolveCatalogKey(current);
        const source=currentKey ? CATALOG.get(currentKey).source : current.trim();
        TEXT_SOURCES.set(node,source);
        return source;
    }

    function translateTextNode(node, lang) {
        if (shouldSkipTextNode(node)) return;
        const source = rememberTextSource(node);
        // Dynamic system labels retain their source across language switches,
        // just as catalog entries do. Authored content is still skipped above.
        const { leading, trailing } = TEXT_SPACING.get(node);
        const next = `${leading}${translateText(source.trim(), lang)}${trailing}`;
        if (node.nodeValue !== next) node.nodeValue = next;
        TEXT_RENDERED.set(node,next);
    }

    function translateAttributes(element, lang) {
        if (element.closest(PROTECTED_ATTRIBUTES)) return;
        const editor=element.closest('[contenteditable="true"],.rich-message-editor');
        if(editor&&editor!==element)return;
        let sources = ATTRIBUTE_SOURCES.get(element);
        if (!sources) {
            sources = new Map();
            ATTRIBUTE_SOURCES.set(element, sources);
        }
        let rendered=ATTRIBUTE_RENDERED.get(element);
        if(!rendered){rendered=new Map();ATTRIBUTE_RENDERED.set(element,rendered);}
        ['title', 'placeholder', 'aria-label'].forEach(attr => {
            if (!element.hasAttribute(attr)) return;
            const current = element.getAttribute(attr) || '';
            const saved = sources.get(attr);
            if (!saved || current!==rendered.get(attr)) {
                const original=formattedSources.get(current)||current,key=resolveCatalogKey(original);
                sources.set(attr,key?CATALOG.get(key).source:original);
            }
            const source = sources.get(attr) || current;
            const next = translateText(source, lang);
            if (next !== current) element.setAttribute(attr, next);
            rendered.set(attr,next);
        });
    }

    function translateNode(root) {
        if (!root) return;
        const lang = currentLanguage();
        document.documentElement.lang = lang;
        document.documentElement.dir = lang === 'fa' ? 'rtl' : 'ltr';
        applyingTranslations = true;
        if (root.nodeType === Node.TEXT_NODE) {
            try { translateTextNode(root, lang); } finally { applyingTranslations = false; }
            return;
        }
        if (root.nodeType !== Node.ELEMENT_NODE && root !== document) {
            applyingTranslations = false;
            return;
        }
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                return shouldSkipTextNode(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
            }
        });
        const nodes = [];
        while (walker.nextNode()) nodes.push(walker.currentNode);
        try {
            nodes.forEach(node => translateTextNode(node, lang));
            if (root.nodeType === Node.ELEMENT_NODE) translateAttributes(root, lang);
            root.querySelectorAll?.('[title], [placeholder], [aria-label]').forEach(el => translateAttributes(el, lang));
            bindLanguageSelect(root);
        } finally {
            applyingTranslations = false;
        }
    }

    function bindLanguageSelect(root) {
        const select = (root || document).querySelector?.('#appLanguageSelect');
        if (!select) return;
        if (select.dataset.i18nBound === 'true') {
            const system = select.querySelector('option[value="system"]');
            if (system) system.textContent = translateText('使用系统语言');
            select.value = languagePreference();
            return;
        }
        select.dataset.i18nBound = 'true';
        select.replaceChildren();
        select.add(new Option(translateText('使用系统语言'), 'system'));
        SUPPORTED_LANGUAGES.forEach(([code, label]) => select.add(new Option(label, code)));
        select.value = languagePreference();
        select.addEventListener('change', () => setLanguage(select.value));
    }

    function setLanguage(lang) {
        const preference = lang === 'system' ? 'system' : normalizeLanguage(lang);
        localStorage.setItem(STORAGE_KEY, preference);
        translateNode(document.body);
        translateNode(document.querySelector('title'));
        document.querySelectorAll('#appLanguageSelect').forEach(select => { select.value = preference; });
        window.dispatchEvent(new CustomEvent('drop2tunnel-language-changed', { detail: { language: currentLanguage(), preference } }));
    }

    let observer = null;
    function start() {
        translateNode(document.body);
        const pageTitle = document.querySelector('title');
        translateNode(pageTitle);
        observer = new MutationObserver(records => {
            if (applyingTranslations) return;
            const roots = new Set();
            for (const record of records) {
                if (record.type === 'characterData') roots.add(record.target);
                if (record.type === 'attributes') roots.add(record.target);
                record.addedNodes.forEach(node => roots.add(node));
            }
            roots.forEach(translateNode);
        });
        observer.observe(document.body, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
            attributeFilter: ['title', 'placeholder', 'aria-label']
        });
        if (pageTitle) observer.observe(pageTitle, { childList:true, subtree:true, characterData:true });
    }

    window.TunnelI18n = {
        initialized: true,
        languages: SUPPORTED_LANGUAGES,
        currentLanguage,
        languagePreference,
        setLanguage,
        t: translateText,
        format: formatText,
        alert: (...args) => dialog('alert',args),
        confirm: (...args) => dialog('confirm',args),
        prompt: (...args) => dialog('prompt',args),
        translate: translateNode,
        bindLanguageSelect,
        canonicalKey
    };
    window.addEventListener('languagechange', () => {
        if (languagePreference() !== 'system') return;
        translateNode(document.body);
        translateNode(document.querySelector('title'));
        window.dispatchEvent(new CustomEvent('drop2tunnel-language-changed', { detail:{ language:currentLanguage(), preference:'system' } }));
    });
    window.addEventListener('storage', event => {
        if (event.key !== STORAGE_KEY && event.key !== null) return;
        translateNode(document.body);
        translateNode(document.querySelector('title'));
        window.dispatchEvent(new CustomEvent('drop2tunnel-language-changed', { detail:{ language:currentLanguage(), preference:languagePreference() } }));
    });

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
})();
