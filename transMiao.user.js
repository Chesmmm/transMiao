// ==UserScript==
// @name         TransMiao网页AI翻译
// @namespace    https://github.com/transMiao
// @version      0.1.0
// @description  基于AI的网页翻译插件，支持OpenAI/Gemini格式接口，多组配置管理
// @author       Chesmmm
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @connect      *
// @run-at       document-end
// @noframes
// @license      MIT
// ==/UserScript==

'use strict';

// ====== 环境检测 ======
// 在所有逻辑之前检测运行环境，用于后续模块的降级适配
const TRANSMIAO = {
    ENV: {
        HAS_GM: typeof GM_xmlhttpRequest !== 'undefined',
        HAS_GM_STORAGE: typeof GM_getValue !== 'undefined' && typeof GM_setValue !== 'undefined',
        IS_MOBILE: /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent),
        IS_VIA: navigator.userAgent.toLowerCase().includes('via'),
    }
};

// ====== 移动端视口工具 ======

function isMobileViewport() {
    if (TRANSMIAO.ENV.IS_MOBILE) return true;
    if (window.innerWidth <= 480) return true;
    try { if (matchMedia && matchMedia('(pointer: coarse)').matches) return true; } catch (e) {}
    return false;
}

function getSafeViewportBox() {
    var vv = (typeof window.visualViewport !== 'undefined') ? window.visualViewport : null;
    if (vv) {
        return {
            left: vv.offsetLeft || 0,
            top: vv.offsetTop || 0,
            width: vv.width || window.innerWidth,
            height: vv.height || window.innerHeight,
            get right() { return this.left + this.width; },
            get bottom() { return this.top + this.height; }
        };
    }
    return {
        left: 0, top: 0,
        width: window.innerWidth, height: window.innerHeight,
        get right() { return window.innerWidth; },
        get bottom() { return window.innerHeight; }
    };
}

function clampFixedUI(el, box, padLeft, padTop, padRight, padBottom) {
    var left = Math.max((box.left + (padLeft || 4)), el.offsetLeft);
    var top = Math.max((box.top + (padTop || 4)), el.offsetTop);
    left = Math.min(box.right - (padRight || 4) - el.offsetWidth, left);
    top = Math.min(box.bottom - (padBottom || 4) - el.offsetHeight, top);
    el.style.left = left + 'px';
    el.style.top = top + 'px';
}

// ====== 防重复初始化（Via 浏览器会注入两次） ======
if (window.__transMiao_initialized) return;
window.__transMiao_initialized = true;

// ====== 存储工具函数（内部使用） ======
// 优先 GM_setValue/GM_getValue（跨域名共享），降级到 localStorage
// 所有 key 带 transmiao_ 前缀，避免与其他脚本冲突

function _get(key, defaultVal) {
    try {
        if (TRANSMIAO.ENV.HAS_GM_STORAGE) {
            var raw = GM_getValue('transmiao_' + key, null);
            if (raw !== null && raw !== '') {
                try { return JSON.parse(raw); } catch (e) { /* 非 JSON 数据，忽略 */ }
            }
        }
        if (typeof localStorage !== 'undefined') {
            var local = localStorage.getItem('transmiao_' + key);
            if (local !== null) {
                try { return JSON.parse(local); } catch (e) { /* 非 JSON 数据，忽略 */ }
            }
        }
    } catch (e) { /* 静默失败 */ }
    return defaultVal;
}

function _set(key, val) {
    try {
        var data = JSON.stringify(val);
        if (TRANSMIAO.ENV.HAS_GM_STORAGE) {
            GM_setValue('transmiao_' + key, data);
        }
        try {
            if (typeof localStorage !== 'undefined') {
                localStorage.setItem('transmiao_' + key, data);
            }
        } catch (e) { /* localStorage 已满或禁用 —— 静默忽略 */ }
    } catch (e) { /* 静默失败 */ }
}

function _delete(key) {
    try {
        if (typeof localStorage !== 'undefined') {
            localStorage.removeItem('transmiao_' + key);
        }
        if (TRANSMIAO.ENV.HAS_GM_STORAGE) {
            GM_setValue('transmiao_' + key, '');
        }
    } catch (e) { /* 静默失败 */ }
}

// ====== 工具函数 ======

function generateId() {
    return 'cfg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

/**
 * 深度合并：用 stored 中的值覆盖 defaults，缺失的字段保留 defaults 的值。
 * 仅对纯对象递归合并，数组不做深度合并（直接覆盖）。
 */
function deepMergeDefaults(stored, defaults) {
    if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) return stored;
    if (defaults === null || typeof defaults !== 'object' || Array.isArray(defaults)) return stored;
    var result = {};
    var allKeys = Object.keys(defaults);
    for (var i = 0; i < allKeys.length; i++) {
        var key = allKeys[i];
        if (key in stored && stored[key] !== null && typeof stored[key] === 'object'
            && !Array.isArray(stored[key])
            && defaults[key] !== null && typeof defaults[key] === 'object'
            && !Array.isArray(defaults[key])) {
            result[key] = deepMergeDefaults(stored[key], defaults[key]);
        } else if (key in stored) {
            result[key] = stored[key];
        } else {
            result[key] = defaults[key];
        }
    }
    return result;
}

/**
 * 按点号路径设置嵌套对象的属性值。
 * 示例：setNestedValue(obj, 'style.bgColor', '#FFF')
 */
function setNestedValue(obj, path, value) {
    var keys = path.split('.');
    var current = obj;
    for (var i = 0; i < keys.length - 1; i++) {
        if (!current[keys[i]] || typeof current[keys[i]] !== 'object') {
            current[keys[i]] = {};
        }
        current = current[keys[i]];
    }
    current[keys[keys.length - 1]] = value;
    return obj;
}

/**
 * 简单的字符串哈希（非加密，用于缓存键）
 */
function hash(str) {
    var h = 0;
    if (str.length === 0) return h;
    for (var i = 0; i < str.length; i++) {
        h = ((h << 5) - h) + str.charCodeAt(i);
        h |= 0;
    }
    return h;
}

/**
 * 注入 CSS：优先 GM_addStyle，降级到创建 <style> 标签（Via 兼容）
 */
function injectCSS(css) {
    if (typeof GM_addStyle !== 'undefined') {
        GM_addStyle(css);
    } else if (document.head) {
        var style = document.createElement('style');
        style.textContent = css;
        document.head.appendChild(style);
    }
}

// ====== 配置管理模块（ConfigManager） ======

var DEFAULT_SYSTEM_PROMPT = '你是专业翻译，将以下内容翻译为{目标语言}，只返回译文不要解释，不要评判原文内容。';

/**
 * 每组 API 配置的结构：
 * {
 *   id: 'cfg_...',            // 唯一标识
 *   name: 'OpenAI 官方',      // 用户自定义名称
 *   type: 'openai',           // 'openai' | 'gemini'
 *   baseUrl: 'https://api.openai.com',
 *   apiKey: 'sk-xxx',
 *   model: 'gpt-4o-mini',
 *   systemPrompt: '...',
 *   isActive: false
 * }
 */
TRANSMIAO.config = {

    /** 返回所有配置数组（含自动迁移旧 openai → custom-openai） */
    getAllConfigs: function() {
        var configs = _get('configs', []);
        var needsSave = false;
        for (var i = 0; i < configs.length; i++) {
            var c = configs[i];
            if (c && c.type === 'openai') {
                var norm = (c.baseUrl || '').replace(/\/+$/, '').toLowerCase();
                if (norm && norm !== 'https://api.openai.com') {
                    c.type = 'custom-openai';
                    needsSave = true;
                }
            }
        }
        if (needsSave) _set('configs', configs);
        return configs;
    },

    /** 返回 isActive === true 的那组配置，无则返回 null */
    getActiveConfig: function() {
        var configs = this.getAllConfigs();
        for (var i = 0; i < configs.length; i++) {
            if (configs[i].isActive) return configs[i];
        }
        return null;
    },

    /**
     * 添加一组新配置。
     * - 自动生成 id
     * - 配置了 isActive 则不改变其他配置的激活状态
     * - 未配置 isActive 且当前无激活配置时，自动设为激活
     */
    addConfig: function(config) {
        var configs = this.getAllConfigs();
        var newConfig = {
            name: config.name || '',
            type: config.type || 'openai',
            baseUrl: config.baseUrl || '',
            apiKey: config.apiKey || '',
            model: config.model || 'gpt-4o-mini',
            systemPrompt: config.systemPrompt || DEFAULT_SYSTEM_PROMPT,
            isActive: config.isActive === true,
            id: generateId()
        };

        var hasActive = false;
        for (var i = 0; i < configs.length; i++) {
            if (configs[i].isActive) { hasActive = true; break; }
        }

        if (newConfig.isActive) {
            // 新配置设为激活，其他全部取消激活
            for (var j = 0; j < configs.length; j++) {
                configs[j].isActive = false;
            }
        } else if (!hasActive) {
            newConfig.isActive = true;
        }

        configs.push(newConfig);
        _set('configs', configs);
        return newConfig;
    },

    /** 更新指定配置的部分字段 */
    updateConfig: function(id, updates) {
        var configs = this.getAllConfigs();
        for (var i = 0; i < configs.length; i++) {
            if (configs[i].id === id) {
                for (var key in updates) {
                    if (updates.hasOwnProperty(key) && key !== 'id') {
                        configs[i][key] = updates[key];
                    }
                }
                // 如果 updateConfig 传入了 isActive=true，确保其他配置取消激活
                if (updates.isActive === true) {
                    for (var j = 0; j < configs.length; j++) {
                        if (configs[j].id !== id) configs[j].isActive = false;
                    }
                }
                _set('configs', configs);
                return true;
            }
        }
        return false;
    },

    /**
     * 删除指定配置。
     * 如果删除的是当前激活配置，自动将剩余第一组设为激活。
     */
    deleteConfig: function(id) {
        var configs = this.getAllConfigs();
        var target = null;
        var idx = -1;
        for (var i = 0; i < configs.length; i++) {
            if (configs[i].id === id) {
                target = configs[i];
                idx = i;
                break;
            }
        }
        if (!target) return false;

        var wasActive = target.isActive;
        configs.splice(idx, 1);
        if (wasActive && configs.length > 0) {
            configs[0].isActive = true;
        }
        _set('configs', configs);
        return true;
    },

    /** 将指定 id 设为激活，其他全部设为非激活 */
    setActiveConfig: function(id) {
        var configs = this.getAllConfigs();
        var found = false;
        for (var i = 0; i < configs.length; i++) {
            if (configs[i].id === id) {
                configs[i].isActive = true;
                found = true;
            } else {
                configs[i].isActive = false;
            }
        }
        if (found) _set('configs', configs);
        return found;
    }
};

// ====== 全局设置管理 ======

var DEFAULT_SETTINGS = {
    translateMode: 'fullPage',       // 'fullPage' | 'viewport'
    skipAlreadyTargetLanguage: true,  // 跳过已是目标语言的高置信文本
    batchSize: 3000,
    displayMode: 'translationOnly',  // 'translationOnly' | 'bilingual'
    targetLang: '简体中文',
    style: {
        bgColor: '#F2F2F2',
        textColor: '#000000',
        fontSize: null               // null = 同原文
    },
    showFloatBtn: true,
    translateUI: false,
    shortcut: 'Alt+C',
    cacheLimit: 500,
    requestTimeout: 30000,
    maxRetries: 2
};

TRANSMIAO.settings = {

    /** 返回当前设置（与 DEFAULT_SETTINGS 深度合并，自动补全缺省字段） */
    getSettings: function() {
        var stored = _get('settings', {});
        return deepMergeDefaults(stored, DEFAULT_SETTINGS);
    },

    /**
     * 更新单个设置项。
     * key 支持嵌套路径，如 'style.bgColor'。
     */
    updateSetting: function(key, value) {
        var stored = _get('settings', {});
        setNestedValue(stored, key, value);
        _set('settings', stored);
    },

    /** 重置所有设置为默认值 */
    resetSettings: function() {
        _set('settings', {});
    }
};

// ====== 缓存模块（CacheManager） ======

/**
 * 两层 LRU 缓存（内存 Map + GM/localStorage 持久化）。
 *
 * 缓存键包含：规范化原文、目标语言、API 地址、模型、系统提示词 hash，
 * 确保切换配置后不会错误复用旧译文。
 *
 * 持久化使用版本化 key "cache_v2"，通过 _get/_set 读写。
 * 写入采用 500ms debounce 避免频繁同步；clear() 立即清除。
 */
function CacheManager(options) {
    options = options || {};
    this.limit = options.limit || 500;
    this._cache = new Map();            // Map<string, { result, timestamp }>
    this._pending = new Map();          // Map<string, Promise>
    this._callbacks = new Map();        // Map<string, { resolve, reject }>
    this._persistTimer = null;          // debounce 定时器

    // 启动时从持久化存储恢复
    this._loadFromStorage();
}

CacheManager.prototype = {

    /**
     * 生成细粒度缓存键：原文 + 目标语言 + API 地址 + 模型 + 提示词 hash。
     * @param {string} text       待翻译原文
     * @param {string} targetLang 目标语言
     * @param {Object} config     API 配置对象（至少含 baseUrl/model/systemPrompt）
     * @returns {string} 字符串哈希键
     */
    _makeKey: function(text, targetLang, config) {
        return JSON.stringify([
            (text || '').trim(),
            targetLang || '',
            config && config.baseUrl ? config.baseUrl.replace(/\/+$/, '').toLowerCase() : '',
            config && config.id || '',
            config && config.model || '',
            config && config.systemPrompt || ''
        ]);
    },

    /**
     * 查询缓存。命中返回译文，未命中返回 null。
     * 每次访问将条目移到 Map 末尾（LRU 策略）。
     */
    get: function(text, targetLang, config) {
        var key = this._makeKey(text, targetLang, config);
        if (!this._cache.has(key)) return null;
        // 移到末尾（最近使用）+ 更新时间戳 + 持久化
        var entry = this._cache.get(key);
        this._cache['delete'](key);
        entry.timestamp = Date.now();
        this._cache.set(key, entry);
        this._schedulePersist();
        return entry.result;
    },

    /**
     * 存入缓存。超过上限时按 LRU 淘汰最久未访问的条目。
     * 写入后延迟持久化（500ms debounce）。
     */
    set: function(text, targetLang, config, result) {
        var key = this._makeKey(text, targetLang, config);
        if (this._cache.has(key)) {
            this._cache['delete'](key);
        }
        // LRU 淘汰：删除最旧的条目
        while (this._cache.size >= this.limit) {
            var oldestKey = this._cache.keys().next().value;
            if (oldestKey === undefined) break;
            this._cache['delete'](oldestKey);
        }
        this._cache.set(key, { result: result, timestamp: Date.now() });
        // 延迟持久化
        this._schedulePersist();
    },

    /**
     * 标记指定 key 正在请求中，返回一个 Promise。
     * 其他调用方可 await 此 Promise 等待结果。
     */
    addPending: function(text, targetLang, config) {
        var key = this._makeKey(text, targetLang, config);
        if (this._pending.has(key)) return this._pending.get(key);
        var self = this;
        var promise = new Promise(function(resolve, reject) {
            self._callbacks.set(key, { resolve: resolve, reject: reject });
        });
        this._pending.set(key, promise);
        return promise;
    },

    /**
     * 请求完成，resolve 所有等待该 key 的 Promise。
     */
    resolvePending: function(text, targetLang, config, result) {
        var key = this._makeKey(text, targetLang, config);
        if (this._callbacks.has(key)) {
            this._callbacks.get(key).resolve(result);
            this._callbacks['delete'](key);
        }
        this._pending['delete'](key);
    },

    /**
     * 请求失败，reject 所有等待该 key 的 Promise。
     */
    rejectPending: function(text, targetLang, config, error) {
        var key = this._makeKey(text, targetLang, config);
        if (this._callbacks.has(key)) {
            this._callbacks.get(key).reject(error);
            this._callbacks['delete'](key);
        }
        this._pending['delete'](key);
    },

    /**
     * 返回等待队列中的 Promise（用于判断是否已有相同请求进行中）。
     * 无等待时返回 null。
     */
    getPending: function(text, targetLang, config) {
        var key = this._makeKey(text, targetLang, config);
        return this._pending.get(key) || null;
    },

    /** 清空整个缓存（内存 + 持久化） */
    clear: function() {
        this._cache.clear();
        this._pending.clear();
        this._callbacks.clear();
        if (this._persistTimer) {
            clearTimeout(this._persistTimer);
            this._persistTimer = null;
        }
        _delete('cache_v2');
    },

    /** 返回当前缓存条目数 */
    getSize: function() {
        return this._cache.size;
    },

    // ---------- 持久化内部方法 ----------

    /** 调度延迟持久化（500ms debounce） */
    _schedulePersist: function() {
        var self = this;
        if (this._persistTimer) clearTimeout(this._persistTimer);
        this._persistTimer = setTimeout(function() {
            self._saveToStorage();
            self._persistTimer = null;
        }, 500);
    },

    /** 将当前缓存序列化写入 _set('cache_v2') */
    _saveToStorage: function() {
        var arr = [];
        var self = this;
        this._cache.forEach(function(value, key) {
            arr.push({ k: key, r: value.result, t: value.timestamp });
        });
        _set('cache_v2', arr);
    },

    /** 启动时从 _get('cache_v2') 恢复缓存 */
    _loadFromStorage: function() {
        var arr = _get('cache_v2', null);
        if (!arr || !Array.isArray(arr)) return;
        var limit = this.limit;
        var entries = [];
        for (var i = 0; i < arr.length; i++) {
            var e = arr[i];
            if (e && e.k !== undefined && typeof e.r === 'string' && e.r) {
                entries.push({ key: e.k, value: { result: e.r, timestamp: e.t || Date.now() } });
            }
        }
        // 按时间戳升序（最旧在前），保留不超过 limit 条
        entries.sort(function(a, b) { return (a.value.timestamp || 0) - (b.value.timestamp || 0); });
        if (entries.length > limit) {
            entries = entries.slice(entries.length - limit);
        }
        this._cache.clear();
        for (var j = 0; j < entries.length; j++) {
            this._cache.set(entries[j].key, entries[j].value);
        }
    }
};

// 初始化：从设置读取缓存上限，从存储恢复已有缓存
var _initialCacheLimit = TRANSMIAO.settings.getSettings().cacheLimit || 500;
TRANSMIAO.cache = new CacheManager({ limit: _initialCacheLimit });

// ====== Grant 自检 ======

function checkGrants() {
    var needed = ['GM_xmlhttpRequest', 'GM_getValue', 'GM_setValue', 'GM_addStyle'];
    var missing = [];
    for (var i = 0; i < needed.length; i++) {
        var name = needed[i];
        if (typeof window[name] === 'undefined' && typeof globalThis[name] === 'undefined') {
            missing.push(name);
        }
    }
    if (missing.length > 0) {
        console.warn('[transMiao] 缺少 grant 声明:', missing.join(', '));
    }
}

// ====== 模块占位（后续 Prompt 填充） ======

// ====== 设置面板 UI ======

/**
 * 内部 DOM 创建辅助函数。
 * 所有面板元素都通过此函数创建，确保不使用 innerHTML。
 */
function _el(tag, attrs, children) {
    var el = document.createElement(tag);
    if (attrs) {
        var keys = Object.keys(attrs);
        for (var ik = 0; ik < keys.length; ik++) {
            var k = keys[ik];
            var v = attrs[k];
            if (k === 'className') { el.className = v; }
            else if (k === 'style') {
                if (typeof v === 'string') { el.style.cssText = v; }
                else {
                    var sk = Object.keys(v);
                    for (var skk = 0; skk < sk.length; skk++) {
                        el.style[sk[skk]] = v[sk[skk]];
                    }
                }
            }
            else if (k.slice(0, 2) === 'on') {
                el.addEventListener(k.slice(2).toLowerCase(), v);
            }
            else if (k === 'disabled' || k === 'readonly') {
                if (v !== false && v !== null && v !== undefined) el.setAttribute(k, '');
            }
            else {
                el.setAttribute(k, v);
            }
        }
    }
    if (children) {
        for (var ci = 0; ci < children.length; ci++) {
            var child = children[ci];
            if (child == null || child === false || child === undefined) continue;
            if (typeof child === 'string' || typeof child === 'number') {
                el.appendChild(document.createTextNode(String(child)));
            } else {
                el.appendChild(child);
            }
        }
    }
    return el;
}

// ====== 设置面板 CSS ======

var SETTINGS_PANEL_CSS = '\
.transmiao-panel {\
    position: fixed;\
    width: 380px;\
    max-height: 520px;\
    background: #fff;\
    border-radius: 10px;\
    box-shadow: 0 4px 24px rgba(0,0,0,0.18);\
    z-index: 2147483647;\
    display: flex;\
    flex-direction: column;\
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;\
    font-size: 13px;\
    color: #333;\
    overflow: hidden;\
    animation: transmiao-slide-up 0.2s ease-out;\
}\
@keyframes transmiao-slide-up {\
    from { opacity: 0; transform: translateY(10px); }\
    to { opacity: 1; transform: translateY(0); }\
}\
.transmiao-panel-header {\
    display: flex;\
    align-items: center;\
    justify-content: space-between;\
    padding: 10px 14px;\
    background: #4A90D9;\
    color: #fff;\
    font-weight: 600;\
    font-size: 14px;\
    flex-shrink: 0;\
}\
.transmiao-panel-close {\
    cursor: pointer;\
    font-size: 16px;\
    opacity: 0.85;\
    padding: 2px 4px;\
    line-height: 1;\
}\
.transmiao-panel-close:hover {\
    opacity: 1;\
}\
.transmiao-panel-backdrop {\
    position: fixed;\
    z-index: 2147483646;\
    background: rgba(0,0,0,0.18);\
    display: none;\
}\
.transmiao-panel-mobile {\
    box-sizing: border-box;\
}\
.transmiao-panel-mobile .transmiao-panel-body {\
    flex: 1 1 auto;\
    overflow-y: auto;\
    -webkit-overflow-scrolling: touch;\
    min-height: 0;\
}\
.transmiao-tab-bar {\
    display: flex;\
    border-bottom: 1px solid #e8e8e8;\
    flex-shrink: 0;\
}\
.transmiao-tab {\
    flex: 1;\
    text-align: center;\
    padding: 8px 6px;\
    cursor: pointer;\
    font-size: 12px;\
    color: #666;\
    border-bottom: 2px solid transparent;\
    transition: color 0.15s, border-color 0.15s;\
    user-select: none;\
}\
.transmiao-tab:hover {\
    color: #333;\
}\
.transmiao-tab.active {\
    color: #4A90D9;\
    border-bottom-color: #4A90D9;\
    font-weight: 600;\
}\
.transmiao-panel-body {\
    flex: 0 1 auto;\
    overflow-y: auto;\
    padding: 10px 14px;\
    min-height: 0;\
}\
.transmiao-tab-content {\
    display: none;\
}\
.transmiao-tab-content.active {\
    display: block;\
}\
.transmiao-config-empty {\
    text-align: center;\
    padding: 30px 10px;\
    color: #999;\
    font-size: 13px;\
    line-height: 2;\
}\
.transmiao-config-item {\
    border: 1px solid #e8e8e8;\
    border-radius: 8px;\
    padding: 10px 12px;\
    margin-bottom: 8px;\
    cursor: pointer;\
    transition: border-color 0.15s, box-shadow 0.15s;\
    position: relative;\
}\
.transmiao-config-item:hover {\
    border-color: #4A90D9;\
    box-shadow: 0 1px 6px rgba(74,144,217,0.12);\
}\
.transmiao-config-item.active {\
    border-color: #4A90D9;\
    background: #f6faff;\
}\
.transmiao-config-item-header {\
    display: flex;\
    align-items: center;\
    justify-content: space-between;\
}\
.transmiao-config-item-name {\
    font-weight: 600;\
    font-size: 13px;\
}\
.transmiao-config-item-actions {\
    display: flex;\
    gap: 4px;\
    flex-shrink: 0;\
}\
.transmiao-config-item-actions button {\
    padding: 2px 8px;\
    font-size: 11px;\
    border: 1px solid #d0d0d0;\
    border-radius: 4px;\
    background: #fff;\
    cursor: pointer;\
    color: #555;\
    line-height: 1.6;\
}\
.transmiao-config-item-actions button:hover {\
    background: #f0f0f0;\
}\
.transmiao-config-item-actions .btn-edit {\
    color: #4A90D9;\
    border-color: #4A90D9;\
}\
.transmiao-config-item-actions .btn-delete {\
    color: #e74c3c;\
    border-color: #e74c3c;\
}\
.transmiao-config-item-meta {\
    font-size: 11px;\
    color: #999;\
    margin-top: 4px;\
}\
.transmiao-config-item-meta span {\
    display: inline-block;\
    margin-right: 8px;\
}\
.transmiao-config-item-model {\
    font-size: 11px;\
    color: #999;\
    margin-top: 2px;\
}\
.transmiao-config-item-status {\
    font-size: 11px;\
    color: #52c41a;\
    margin-top: 2px;\
    font-weight: 500;\
}\
.transmiao-config-form {\
    padding: 0;\
}\
.transmiao-config-form-title {\
    font-size: 14px;\
    font-weight: 600;\
    margin-bottom: 12px;\
}\
.transmiao-form-group {\
    margin-bottom: 10px;\
}\
.transmiao-form-label {\
    display: block;\
    font-size: 12px;\
    color: #555;\
    margin-bottom: 3px;\
    font-weight: 500;\
}\
.transmiao-form-input,\
.transmiao-form-select,\
.transmiao-form-textarea {\
    width: 100%;\
    padding: 6px 8px;\
    border: 1px solid #d0d0d0;\
    border-radius: 4px;\
    font-size: 13px;\
    color: #333;\
    background: #fff;\
    box-sizing: border-box;\
    font-family: inherit;\
}\
.transmiao-form-input:focus,\
.transmiao-form-select:focus,\
.transmiao-form-textarea:focus {\
    outline: none;\
    border-color: #4A90D9;\
    box-shadow: 0 0 0 2px rgba(74,144,217,0.15);\
}\
.transmiao-form-textarea {\
    resize: vertical;\
    min-height: 50px;\
}\
.transmiao-form-row {\
    display: flex;\
    gap: 8px;\
    align-items: center;\
}\
.transmiao-form-row .transmiao-form-input {\
    flex: 1;\
}\
.transmiao-btn {\
    padding: 6px 14px;\
    border: 1px solid #d0d0d0;\
    border-radius: 4px;\
    font-size: 12px;\
    cursor: pointer;\
    background: #fff;\
    color: #333;\
    transition: background 0.15s;\
    line-height: 1.6;\
    font-family: inherit;\
}\
.transmiao-btn:hover {\
    background: #f0f0f0;\
}\
.transmiao-btn-primary {\
    background: #4A90D9;\
    color: #fff;\
    border-color: #4A90D9;\
}\
.transmiao-btn-primary:hover {\
    background: #3a7bc8;\
}\
.transmiao-btn-danger {\
    color: #e74c3c;\
    border-color: #e74c3c;\
}\
.transmiao-btn-danger:hover {\
    background: #fff1f0;\
}\
.transmiao-btn-sm {\
    padding: 3px 10px;\
    font-size: 11px;\
}\
.transmiao-btn-block {\
    width: 100%;\
    margin-top: 8px;\
}\
.transmiao-btn:disabled {\
    opacity: 0.6;\
    cursor: not-allowed;\
}\
.transmiao-btn-group {\
    display: flex;\
    gap: 8px;\
    margin-top: 14px;\
}\
.transmiao-form-hint {\
    font-size: 11px;\
    color: #999;\
    margin-top: 3px;\
}\
.transmiao-form-warning {\
    font-size: 11px;\
    color: #e67e22;\
    margin-top: 3px;\
    background: #fef9e7;\
    padding: 4px 8px;\
    border-radius: 3px;\
    border: 1px solid #f5d76e;\
}\
.transmiao-setting-group {\
    margin-bottom: 16px;\
}\
.transmiao-setting-group-title {\
    font-size: 12px;\
    font-weight: 600;\
    color: #999;\
    text-transform: uppercase;\
    letter-spacing: 0.5px;\
    margin-bottom: 8px;\
    padding-bottom: 4px;\
    border-bottom: 1px solid #eee;\
}\
.transmiao-setting-row {\
    display: flex;\
    align-items: center;\
    justify-content: space-between;\
    padding: 5px 0;\
    min-height: 32px;\
}\
.transmiao-setting-label {\
    font-size: 12px;\
    color: #555;\
    flex-shrink: 0;\
    margin-right: 8px;\
}\
.transmiao-setting-control {\
    display: flex;\
    align-items: center;\
    gap: 4px;\
}\
.transmiao-setting-control select,\
.transmiao-setting-control input[type="number"],\
.transmiao-setting-control input[type="text"] {\
    padding: 4px 6px;\
    border: 1px solid #d0d0d0;\
    border-radius: 4px;\
    font-size: 12px;\
    color: #333;\
    background: #fff;\
    max-width: 160px;\
    box-sizing: border-box;\
    font-family: inherit;\
}\
.transmiao-setting-control select:focus,\
.transmiao-setting-control input:focus {\
    outline: none;\
    border-color: #4A90D9;\
}\
.transmiao-setting-control input[type="number"] {\
    width: 70px;\
    text-align: center;\
}\
.transmiao-setting-control input[type="color"] {\
    width: 32px;\
    height: 28px;\
    padding: 1px;\
    border: 1px solid #d0d0d0;\
    border-radius: 4px;\
    cursor: pointer;\
    background: none;\
}\
.transmiao-color-preview {\
    width: 20px;\
    height: 20px;\
    border-radius: 3px;\
    border: 1px solid #d0d0d0;\
    flex-shrink: 0;\
}\
.transmiao-toast {\
    position: fixed;\
    top: 50%;\
    left: 50%;\
    transform: translate(-50%, -50%);\
    padding: 12px 24px;\
    background: rgba(0,0,0,0.78);\
    color: #fff;\
    border-radius: 8px;\
    font-size: 14px;\
    z-index: 2147483647;\
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;\
    pointer-events: none;\
    animation: transmiao-fade-in 0.15s ease-out;\
}\
.transmiao-toast-error {\
    background: #e74c3c !important;\
    color: #fff;\
}\
@keyframes transmiao-fade-in {\
    from { opacity: 0; }\
    to { opacity: 1; }\
}\
.transmiao-form-model-row {\
    display: flex;\
    gap: 6px;\
    align-items: stretch;\
}\
.transmiao-form-model-row .transmiao-form-select,\
.transmiao-form-model-row .transmiao-form-input {\
    flex: 1;\
    min-width: 0;\
}\
@media (max-width: 480px) {\
    .transmiao-panel {\
        width: 300px;\
        max-height: 90vh;\
        font-size: 12px;\
    }\
    .transmiao-panel-body {\
        padding: 8px 10px;\
    }\
    .transmiao-setting-control select,\
    .transmiao-setting-control input {\
        font-size: 12px;\
    }\
}';

// ====== 状态变量 ======

var _panelOpen = false;
var _currentTabIdx = 0;
var _configFormMode = 'add'; // 'add' | 'edit'
var _editingConfigId = null;  // 编辑模式下的配置 ID

// DOM 元素引用（由 createSettingsPanel 赋值）
var _panel = null;
var _headerTitle = null;
var _tab1Body = null;
var _tab2Body = null;
var _configListEl = null;
var _configFormEl = null;
var _configFormInner = null;
var _addBtnArea = null;

// 配置表单字段引用
var _formTitleEl = null;
var _cfgNameInput = null;
var _cfgTypeSelect = null;
var _cfgBaseUrlInput = null;
var _cfgApiKeyInput = null;
var _cfgModelSelect = null;
var _cfgModelInput = null;
var _cfgPromptTextarea = null;
var _modelFetchBtn = null;
var _modelWarningEl = null;
var _modelRowContainer = null;
var _modelTestBtn = null;

// ====== 简单 Toast ======

function _showToast(msg, type) {
    type = type || 'info';
    var toast = _el('div', {
        className: 'transmiao-toast' + (type === 'error' ? ' transmiao-toast-error' : '')
    }, [msg]);
    document.body.appendChild(toast);
    setTimeout(function() {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 3000);
}

// ====== 面板创建 ======

function createSettingsPanel() {
    // --- 面板 ---
    _headerTitle = _el('span', { className: 'transmiao-panel-title' }, ['API 配置']);

    var closeBtn = _el('span', {
        className: 'transmiao-panel-close',
        onClick: closePanel
    }, ['✕']);

    var tab0 = _el('span', {
        className: 'transmiao-tab active',
        onClick: function() { switchTab(0); }
    }, ['📡 API 配置']);
    var tab1 = _el('span', {
        className: 'transmiao-tab',
        onClick: function() { switchTab(1); }
    }, ['⚙ 翻译设置']);

    // 配置列表容器
    _configListEl = _el('div', { className: 'transmiao-config-list' });

    // 配置表单容器
    _configFormEl = _el('div', { className: 'transmiao-config-form', style: { display: 'none' } });

    // 添加配置按钮
    _addBtnArea = _el('button', {
        className: 'transmiao-btn transmiao-btn-primary transmiao-btn-block',
        onClick: showAddConfigForm
    }, ['+ 添加配置']);

    _tab1Body = _el('div', { className: 'transmiao-tab-content active' }, [
        _configListEl,
        _configFormEl,
        _addBtnArea
    ]);

    _tab2Body = _el('div', { className: 'transmiao-tab-content' });

    _panel = _el('div', { className: 'transmiao-panel', style: { display: 'none' } }, [
        _el('div', { className: 'transmiao-panel-header' }, [
            _headerTitle,
            closeBtn
        ]),
        _el('div', { className: 'transmiao-tab-bar' }, [tab0, tab1]),
        _el('div', { className: 'transmiao-panel-body' }, [
            _tab1Body,
            _tab2Body
        ])
    ]);
    document.body.appendChild(_panel);
    _panel.setAttribute('data-transmiao-ui', 'true');

    // 初始化渲染
    renderConfigList();
    renderSettingsTab();
}

// ====== 面板开关与标签切换 ======

var _panelBackdrop = null;
var _panelResizeHandlers = null;

function _positionDesktopPanel() {
    if (!_launcherBtn) return;
    var lb = _launcherBtn.getBoundingClientRect();
    var pw = 380;
    var ph = 520;
    if (window.innerWidth <= 480) pw = 300;
    var panelLeft = (lb.left + lb.width / 2) < window.innerWidth / 2
        ? lb.right + 4
        : lb.left - pw - 4;
    var panelTop = lb.bottom + ph > window.innerHeight && lb.top - ph > 0
        ? lb.top - ph
        : lb.bottom + 4;
    var panelHeight = Math.min(ph, window.innerHeight - 8);
    panelLeft = Math.max(4, Math.min(window.innerWidth - pw - 4, panelLeft));
    panelTop = Math.max(4, Math.min(window.innerHeight - panelHeight - 4, panelTop));
    _panel.style.left = panelLeft + 'px';
    _panel.style.top = panelTop + 'px';
    _panel.style.right = 'auto';
    _panel.style.bottom = 'auto';
}

function _positionMobilePanel() {
    var box = getSafeViewportBox();
    var pad = 6;
    var w = box.width - pad * 2;
    var h = box.height - pad * 2;
    _panel.style.left = (box.left + pad) + 'px';
    _panel.style.top = (box.top + pad) + 'px';
    _panel.style.width = w + 'px';
    _panel.style.maxHeight = h + 'px';
    _panel.style.right = 'auto';
    _panel.style.bottom = 'auto';
    if (_panelBackdrop) {
        _panelBackdrop.style.left = box.left + 'px';
        _panelBackdrop.style.top = box.top + 'px';
        _panelBackdrop.style.width = box.width + 'px';
        _panelBackdrop.style.height = box.height + 'px';
    }
}

function _onPanelResize() {
    if (!_panelOpen || !isMobileViewport()) return;
    requestAnimationFrame(function() { _positionMobilePanel(); });
}

function _bindPanelResizeListeners() {
    _unbindPanelResizeListeners();
    if (typeof window.visualViewport !== 'undefined') {
        window.visualViewport.addEventListener('resize', _onPanelResize);
        window.visualViewport.addEventListener('scroll', _onPanelResize);
    }
    window.addEventListener('resize', _onPanelResize);
    _panel.addEventListener('focusin', function(e) {
        if (isMobileViewport()) {
            setTimeout(function() {
                _positionMobilePanel();
                if (e.target && e.target.scrollIntoView) {
                    try { e.target.scrollIntoView({ block: 'nearest' }); } catch (ignore) {}
                }
            }, 80);
        }
    });
}

function _unbindPanelResizeListeners() {
    if (typeof window.visualViewport !== 'undefined') {
        window.visualViewport.removeEventListener('resize', _onPanelResize);
        window.visualViewport.removeEventListener('scroll', _onPanelResize);
    }
    window.removeEventListener('resize', _onPanelResize);
}

function _showPanelBackdrop() {
    if (!_panelBackdrop) {
        _panelBackdrop = document.createElement('div');
        _panelBackdrop.className = 'transmiao-panel-backdrop';
        _panelBackdrop.setAttribute('data-transmiao-ui', 'true');
        _panelBackdrop.addEventListener('pointerdown', closePanel);
        document.body.appendChild(_panelBackdrop);
    }
    var box = getSafeViewportBox();
    _panelBackdrop.style.left = box.left + 'px';
    _panelBackdrop.style.top = box.top + 'px';
    _panelBackdrop.style.width = box.width + 'px';
    _panelBackdrop.style.height = box.height + 'px';
    _panelBackdrop.style.display = '';
}

function _hidePanelBackdrop() {
    if (_panelBackdrop) _panelBackdrop.style.display = 'none';
}

function openPanel() {
    if (_panelOpen) return;
    _panelOpen = true;
    renderConfigList();
    refreshSettingsControls();
    // 清除之前可能的 inline 定位残留
    _panel.style.width = '';
    _panel.style.maxHeight = '';

    if (isMobileViewport()) {
        _panel.classList.add('transmiao-panel-mobile');
        _positionMobilePanel();
        _showPanelBackdrop();
        _bindPanelResizeListeners();
    } else {
        _panel.classList.remove('transmiao-panel-mobile');
        _positionDesktopPanel();
    }
    _panel.style.display = 'flex';
}

function closePanel() {
    if (!_panelOpen) return;
    _panelOpen = false;
    _panel.style.display = 'none';
    _panel.classList.remove('transmiao-panel-mobile');
    // 清除临时 inline 定位
    _panel.style.left = '';
    _panel.style.top = '';
    _panel.style.width = '';
    _panel.style.maxHeight = '';
    _panel.style.right = '';
    _panel.style.bottom = '';
    _unbindPanelResizeListeners();
    _hidePanelBackdrop();
}

function togglePanel() {
    if (_panelOpen) {
        closePanel();
    } else {
        openPanel();
    }
}

function switchTab(idx) {
    _currentTabIdx = idx;
    var tabs = _panel.querySelectorAll('.transmiao-tab');
    for (var i = 0; i < tabs.length; i++) {
        tabs[i].className = 'transmiao-tab' + (i === idx ? ' active' : '');
    }
    var contents = _panel.querySelectorAll('.transmiao-tab-content');
    for (var j = 0; j < contents.length; j++) {
        contents[j].className = 'transmiao-tab-content' + (j === idx ? ' active' : '');
    }
    _headerTitle.textContent = idx === 0 ? 'API 配置' : '翻译设置';
}

// ====== Tab 1: API 配置管理 ======

function renderConfigList() {
    var configs = TRANSMIAO.config.getAllConfigs();
    // 安全清空（避免 TrustedHTML 警告）
    while (_configListEl.firstChild) {
        _configListEl.removeChild(_configListEl.firstChild);
    }

    if (!configs || configs.length === 0) {
        _configListEl.appendChild(
            _el('div', { className: 'transmiao-config-empty' }, [
                '还没有 API 配置',
                _el('br'),
                '点击「+ 添加配置」开始设置'
            ])
        );
        return;
    }

    for (var ci = 0; ci < configs.length; ci++) {
        var cfg = configs[ci];
        var typeLabel = cfg.type === 'gemini' ? 'Gemini' : 'OpenAI';

        var item = _el('div', {
            className: 'transmiao-config-item' + (cfg.isActive ? ' active' : ''),
            onClick: function(id) {
                return function() {
                    TRANSMIAO.config.setActiveConfig(id);
                    renderConfigList();
                };
            }(cfg.id)
        }, [
            _el('div', { className: 'transmiao-config-item-header' }, [
                _el('span', { className: 'transmiao-config-item-name' }, [
                    (cfg.isActive ? '🟢 ' : '⚪ ') + (cfg.name || '未命名配置')
                ]),
                _el('div', { className: 'transmiao-config-item-actions' }, [
                    _el('button', {
                        className: 'btn-edit',
                        onClick: function(id) {
                            return function(e) { e.stopPropagation(); showEditConfigForm(id); };
                        }(cfg.id)
                    }, ['编辑']),
                    _el('button', {
                        className: 'btn-delete',
                        onClick: function(id) {
                            return function(e) { e.stopPropagation(); deleteConfigWithConfirm(id); };
                        }(cfg.id)
                    }, ['删除'])
                ])
            ]),
            _el('div', { className: 'transmiao-config-item-model' }, [
                cfg.model || '未设置模型', ' | ', cfg.baseUrl || '未设置地址'
            ]),
            _el('div', { className: 'transmiao-config-item-meta' }, [
                _el('span', {}, ['类型: ' + typeLabel])
            ]),
            cfg.isActive ? _el('div', { className: 'transmiao-config-item-status' }, ['✓ 已激活']) : null
        ]);
        _configListEl.appendChild(item);
    }
}

function showAddConfigForm() {
    _configFormMode = 'add';
    _configListEl.style.display = 'none';
    _addBtnArea.style.display = 'none';
    _configFormEl.style.display = 'block';
    buildConfigForm(null);
}

function showEditConfigForm(id) {
    _configFormMode = 'edit';
    _editingConfigId = id;
    var configs = TRANSMIAO.config.getAllConfigs();
    var cfg = null;
    for (var i = 0; i < configs.length; i++) {
        if (configs[i].id === id) { cfg = configs[i]; break; }
    }
    if (!cfg) return;
    _configListEl.style.display = 'none';
    _addBtnArea.style.display = 'none';
    _configFormEl.style.display = 'block';
    buildConfigForm(cfg);
}

function cancelConfigForm() {
    _configListEl.style.display = '';
    _addBtnArea.style.display = '';
    _configFormEl.style.display = 'none';
}

function buildConfigForm(existing) {
    // 安全清空（避免 TrustedHTML 警告）
    while (_configFormEl.firstChild) {
        _configFormEl.removeChild(_configFormEl.firstChild);
    }
    _configFormInner = _el('div', {});

    var isEdit = existing !== null;
    _formTitleEl = _el('div', { className: 'transmiao-config-form-title' }, [
        isEdit ? '编辑配置' : '新增配置'
    ]);
    _configFormInner.appendChild(_formTitleEl);

    // 配置名称
    _configFormInner.appendChild(_el('div', { className: 'transmiao-form-group' }, [
        _el('label', { className: 'transmiao-form-label' }, ['配置名称']),
        _cfgNameInput = _el('input', {
            className: 'transmiao-form-input',
            type: 'text',
            placeholder: '如：OpenAI 官方'
        }),
        (isEdit && existing.name ? (function(v) { _cfgNameInput.value = v; })(existing.name) : '')
    ]));

    // 接口类型
    _configFormInner.appendChild(_el('div', { className: 'transmiao-form-group' }, [
        _el('label', { className: 'transmiao-form-label' }, ['接口类型']),
        _cfgTypeSelect = _el('select', {
            className: 'transmiao-form-select',
            onChange: function() {
                var v = _cfgTypeSelect.value;
                if (v === 'openai') {
                    _cfgBaseUrlInput.value = 'https://api.openai.com';
                } else if (v === 'gemini') {
                    _cfgBaseUrlInput.value = 'https://generativelanguage.googleapis.com';
                }
            }
        }, [
            _el('option', { value: 'openai' }, ['OpenAI']),
            _el('option', { value: 'gemini' }, ['Google Gemini']),
            _el('option', { value: 'custom-openai' }, ['自定义（OpenAI 兼容）'])
        ]),
        (isEdit && existing.type ? (function(v) { _cfgTypeSelect.value = v; })(existing.type) : '')
    ]));

    // API 地址
    _configFormInner.appendChild(_el('div', { className: 'transmiao-form-group' }, [
        _el('label', { className: 'transmiao-form-label' }, ['API 地址']),
        _cfgBaseUrlInput = _el('input', {
            className: 'transmiao-form-input',
            type: 'text',
            placeholder: 'https://api.openai.com'
        }),
        (function() {
            if (existing && existing.baseUrl) _cfgBaseUrlInput.value = existing.baseUrl;
            else if (!existing) _cfgBaseUrlInput.value = 'https://api.openai.com';
        })()
    ]));

    // API Key
    _configFormInner.appendChild(_el('div', { className: 'transmiao-form-group' }, [
        _el('label', { className: 'transmiao-form-label' }, ['API Key']),
        _cfgApiKeyInput = _el('input', {
            className: 'transmiao-form-input',
            type: 'password',
            placeholder: 'sk-...'
        }),
        (isEdit && existing.apiKey ? (function(v) { _cfgApiKeyInput.value = v; })(existing.apiKey) : '')
    ]));

    // 模型名称 + 获取模型列表
    _configFormInner.appendChild(_el('div', { className: 'transmiao-form-group' }, [
        _el('label', { className: 'transmiao-form-label' }, ['模型名称']),
        _modelRowContainer = _el('div', { className: 'transmiao-form-model-row' }, [
            _cfgModelSelect = _el('select', { className: 'transmiao-form-select' }, [
                _el('option', { value: '' }, ['-- 点击获取模型列表或手动输入 --'])
            ]),
            _cfgModelInput = _el('input', {
                className: 'transmiao-form-input',
                type: 'text',
                placeholder: '手动输入模型名称',
                style: { display: 'none' }
            }),
            _modelFetchBtn = _el('button', {
                className: 'transmiao-btn transmiao-btn-sm',
                onClick: handleFetchModels
            }, ['获取模型列表']),
            _modelTestBtn = _el('button', {
                className: 'transmiao-btn transmiao-btn-sm',
                onClick: handleTestConnection,
                style: { color: '#52c41a', borderColor: '#52c41a' }
            }, ['测试连接'])
        ]),
        _modelWarningEl = _el('div', { className: 'transmiao-form-warning', style: { display: 'none' } }),
        (function() {
            if (isEdit && existing.model) {
                // 编辑模式下预填模型
                // 先尝试加到 select，但 select 是空的不太方便，直接填入 input
                _cfgModelInput.value = existing.model;
                _cfgModelInput.style.display = '';
                _cfgModelSelect.style.display = 'none';
            }
        })()
    ]));

    // 系统提示词
    var defaultPrompt = isEdit && existing.systemPrompt ? existing.systemPrompt : DEFAULT_SYSTEM_PROMPT;
    _configFormInner.appendChild(_el('div', { className: 'transmiao-form-group' }, [
        _el('label', { className: 'transmiao-form-label' }, ['系统提示词']),
        _cfgPromptTextarea = _el('textarea', {
            className: 'transmiao-form-textarea',
            rows: '3',
            placeholder: '翻译提示词...'
        }),
        (function() { _cfgPromptTextarea.value = defaultPrompt; })()
    ]));

    // 按钮组
    _configFormInner.appendChild(_el('div', { className: 'transmiao-btn-group' }, [
        _el('button', {
            className: 'transmiao-btn transmiao-btn-primary',
            onClick: handleConfigFormSave
        }, ['保存']),
        _el('button', {
            className: 'transmiao-btn',
            onClick: cancelConfigForm
        }, ['取消'])
    ]));

    _configFormEl.appendChild(_configFormInner);
}

function handleConfigFormSave() {
    var name = _cfgNameInput.value.trim();
    var type = _cfgTypeSelect.value;
    var baseUrl = _cfgBaseUrlInput.value.trim();
    var apiKey = _cfgApiKeyInput.value.trim();

    // 判断模型值：取 select 或 input 的值
    var model = '';
    if (_cfgModelSelect.style.display !== 'none' && _cfgModelSelect.value) {
        model = _cfgModelSelect.value;
    } else if (_cfgModelInput.value.trim()) {
        model = _cfgModelInput.value.trim();
    }

    var systemPrompt = _cfgPromptTextarea.value.trim();

    // 验证
    if (!name) { _showToast('请填写配置名称'); return; }
    if (!baseUrl) { _showToast('请填写 API 地址'); return; }
    if (!apiKey) { _showToast('请填写 API Key'); return; }
    if (!model) { _showToast('请选择或填写模型名称'); return; }

    var cfgData = {
        name: name,
        type: type,
        baseUrl: baseUrl.replace(/\/+$/, ''), // 去掉尾部斜杠
        apiKey: apiKey,
        model: model,
        systemPrompt: systemPrompt
    };

    if (_configFormMode === 'edit') {
        if (_editingConfigId) {
            TRANSMIAO.config.updateConfig(_editingConfigId, cfgData);
        }
    } else {
        TRANSMIAO.config.addConfig(cfgData);
    }

    // 返回列表
    cancelConfigForm();
    renderConfigList();
}

function deleteConfigWithConfirm(id) {
    var configs = TRANSMIAO.config.getAllConfigs();
    var cfg = null;
    for (var i = 0; i < configs.length; i++) {
        if (configs[i].id === id) { cfg = configs[i]; break; }
    }
    if (!cfg) return;
    if (!confirm('确认删除配置「' + (cfg.name || '未命名') + '」吗？')) return;
    TRANSMIAO.config.deleteConfig(id);
    renderConfigList();
}

function handleFetchModels() {
    var baseUrl = _cfgBaseUrlInput.value.trim();
    var apiKey = _cfgApiKeyInput.value.trim();
    var type = _cfgTypeSelect.value || 'openai';

    if (!baseUrl) {
        _showToast('请先填写 API 地址');
        return;
    }
    if (!apiKey) {
        _showToast('请先填写 API Key');
        return;
    }

    _modelFetchBtn.textContent = '获取中...';
    _modelFetchBtn.disabled = true;
    if (_modelWarningEl) _modelWarningEl.style.display = 'none';

    var isGemini = (type === 'gemini');
    var url = baseUrl.replace(/\/+$/, '');
    var method = 'GET';
    var headers = {};
    if (isGemini) {
        url = url + '/v1beta/models?key=' + encodeURIComponent(apiKey);
    } else {
        url = url + '/v1/models';
        headers = { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' };
    }

    gmRequest({
        method: method,
        url: url,
        headers: headers,
        timeout: 10000
    })
    .then(function(responseText) {
        var data = JSON.parse(responseText);
        var models = [];
        if (isGemini) {
            if (data && data.models && Array.isArray(data.models)) {
                for (var mi = 0; mi < data.models.length; mi++) {
                    var m = data.models[mi];
                    var name = m.name;
                    // 筛选：如有 supportedGenerationMethods 字段则只保留 generateContent
                    if (m.supportedGenerationMethods && Array.isArray(m.supportedGenerationMethods)) {
                        var canGenerate = false;
                        for (var si = 0; si < m.supportedGenerationMethods.length; si++) {
                            if (m.supportedGenerationMethods[si] === 'generateContent') {
                                canGenerate = true;
                                break;
                            }
                        }
                        if (!canGenerate) continue;
                    }
                    if (name) {
                        // 去掉 "models/" 前缀
                        if (name.indexOf('models/') === 0) name = name.slice(7);
                        models.push(name);
                    }
                }
            }
        } else {
            if (data && data.data && Array.isArray(data.data)) {
                for (var mi = 0; mi < data.data.length; mi++) {
                    if (data.data[mi].id) models.push(data.data[mi].id);
                }
            }
        }
        if (models.length === 0) {
            throw new Error('未找到模型');
        }
        models.sort();
        while (_cfgModelSelect.firstChild) {
            _cfgModelSelect.removeChild(_cfgModelSelect.firstChild);
        }
        for (var mj = 0; mj < models.length; mj++) {
            _cfgModelSelect.appendChild(_el('option', { value: models[mj] }, [models[mj]]));
        }
        _cfgModelSelect.style.display = '';
        _cfgModelInput.style.display = 'none';
        if (_modelWarningEl) _modelWarningEl.style.display = 'none';
        _modelFetchBtn.textContent = '获取模型列表';
        _modelFetchBtn.disabled = false;
    })
    .catch(function(err) {
        _cfgModelSelect.style.display = 'none';
        _cfgModelInput.style.display = '';
        if (_modelWarningEl) {
            _modelWarningEl.textContent = '获取模型列表失败，请手动填写模型名称（如 gpt-4o-mini）';
            _modelWarningEl.style.display = '';
        }
        _modelFetchBtn.textContent = '重试获取';
        _modelFetchBtn.disabled = false;
    });
}

function handleTestConnection() {
    var baseUrl = _cfgBaseUrlInput.value.trim();
    var apiKey = _cfgApiKeyInput.value.trim();
    var type = _cfgTypeSelect.value || 'openai';

    if (!baseUrl) {
        _showToast('请先填写 API 地址');
        return;
    }
    if (!apiKey) {
        _showToast('请先填写 API Key');
        return;
    }

    _modelTestBtn.textContent = '测试中...';
    _modelTestBtn.disabled = true;

    var isGemini = (type === 'gemini');
    var url, method, headers, body;
    if (isGemini) {
        var model = _cfgModelInput.value.trim() || _cfgModelSelect.value || 'gemini-pro';
        url = baseUrl.replace(/\/+$/, '') + '/v1beta/models/' + model + ':generateContent?key=' + encodeURIComponent(apiKey);
        method = 'POST';
        headers = { 'Content-Type': 'application/json' };
        body = JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
            generationConfig: { temperature: 0.3, maxOutputTokens: 5 }
        });
    } else {
        url = baseUrl.replace(/\/+$/, '') + '/v1/chat/completions';
        method = 'POST';
        headers = { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' };
        body = JSON.stringify({
            model: _cfgModelInput.value.trim() || _cfgModelSelect.value || 'gpt-4o-mini',
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 5
        });
    }

    gmRequest({
        method: method,
        url: url,
        headers: headers,
        body: body,
        timeout: 15000
    })
    .then(function() {
        _showToast('连接成功', 'info');
        _modelTestBtn.textContent = '测试连接';
        _modelTestBtn.disabled = false;
    })
    .catch(function(err) {
        var msg = err.message || '未知错误';
        _showToast('连接失败: ' + msg, 'error');
        _modelTestBtn.textContent = '测试连接';
        _modelTestBtn.disabled = false;
    });
}

// ====== Tab 2: 翻译设置 ======

// 保存设置控件的引用，用于刷新
var _settingsControls = {};

function renderSettingsTab() {
    // 安全清空（避免 TrustedHTML 警告）
    while (_tab2Body.firstChild) {
        _tab2Body.removeChild(_tab2Body.firstChild);
    }
    _settingsControls = {};
    var s = TRANSMIAO.settings.getSettings();

    // ====== 分组 A: 翻译 ======
    var groupA = _el('div', { className: 'transmiao-setting-group' }, [
        _el('div', { className: 'transmiao-setting-group-title' }, ['翻译'])
    ]);

    // 目标语言
    var langRow = _el('div', { className: 'transmiao-setting-row' });
    langRow.appendChild(_el('span', { className: 'transmiao-setting-label' }, ['目标语言']));
    var langCtrl = _el('div', { className: 'transmiao-setting-control' });

    var langSelect = _el('select', {
        className: 'transmiao-lang-select',
        onChange: function() {
            if (langSelect.value === '__custom__') {
                langCustomInput.style.display = '';
                TRANSMIAO.settings.updateSetting('targetLang', langCustomInput.value.trim() || '简体中文');
            } else {
                langCustomInput.style.display = 'none';
                TRANSMIAO.settings.updateSetting('targetLang', langSelect.value);
            }
        }
    });
    var languages = ['简体中文', '繁體中文', 'English', '日本語', '한국어', 'Français', 'Deutsch', 'Español', 'Русский'];
    for (var li = 0; li < languages.length; li++) {
        var opt = _el('option', { value: languages[li] }, [languages[li]]);
        if (s.targetLang === languages[li]) opt.selected = true;
        langSelect.appendChild(opt);
    }
    // 自定义选项
    var customOpt = _el('option', { value: '__custom__' }, ['自定义']);
    if (languages.indexOf(s.targetLang) === -1 && s.targetLang) customOpt.selected = true;
    langSelect.appendChild(customOpt);

    var langCustomInput = _el('input', {
        type: 'text',
        className: 'transmiao-form-input',
        placeholder: '输入目标语言',
        style: { display: 'none', width: '100px' },
        onInput: function() {
            TRANSMIAO.settings.updateSetting('targetLang', langCustomInput.value.trim() || '简体中文');
        }
    });
    if (languages.indexOf(s.targetLang) === -1 && s.targetLang) {
        langCustomInput.style.display = '';
        langCustomInput.value = s.targetLang;
    }

    langCtrl.appendChild(langSelect);
    langCtrl.appendChild(langCustomInput);
    langRow.appendChild(langCtrl);
    groupA.appendChild(langRow);

    // 展示模式
    groupA.appendChild(makeSettingRow('展示模式', 'displayMode', 'select', {
        options: [
            { value: 'translationOnly', label: '仅译文' },
            { value: 'bilingual', label: '双语对照' }
        ]
    }, s));

    // 翻译模式
    var tmRow = _el('div', { className: 'transmiao-setting-row' });
    tmRow.appendChild(_el('span', { className: 'transmiao-setting-label' }, ['翻译模式']));
    var tmCtrl = _el('div', { className: 'transmiao-setting-control' });
    var tmSelect = _el('select', {
        onChange: function() { TRANSMIAO.settings.updateSetting('translateMode', tmSelect.value); }
    });
    tmSelect.appendChild(_el('option', { value: 'fullPage' }, ['整页一次性翻译']));
    tmSelect.appendChild(_el('option', { value: 'viewport' }, ['可见区域翻译']));
    tmSelect.value = s.translateMode === 'viewport' ? 'viewport' : 'fullPage';
    tmCtrl.appendChild(tmSelect);
    tmRow.appendChild(tmCtrl);
    groupA.appendChild(tmRow);

    // 跳过已是目标语言的文本
    groupA.appendChild(makeSettingRow('跳过目标文本', 'skipAlreadyTargetLanguage', 'select', {
        options: [
            { value: 'true', label: '开启（保守）' },
            { value: 'false', label: '关闭' }
        ],
        transform: {
            toSetting: function(v) { return v === 'true'; },
            toDisplay: function(v) { return String(v); }
        }
    }, s));

    _tab2Body.appendChild(groupA);

    // ====== 分组 B: 译文样式 ======
    var groupB = _el('div', { className: 'transmiao-setting-group' }, [
        _el('div', { className: 'transmiao-setting-group-title' }, ['译文样式'])
    ]);

    // 背景色
    groupB.appendChild(makeColorSettingRow('背景色', 'style.bgColor', s));
    // 文字颜色
    groupB.appendChild(makeColorSettingRow('文字颜色', 'style.textColor', s));

    _tab2Body.appendChild(groupB);

    // ====== 分组 C: 交互 ======
    var groupC = _el('div', { className: 'transmiao-setting-group' }, [
        _el('div', { className: 'transmiao-setting-group-title' }, ['交互'])
    ]);

    // 快捷键
    var scRow = _el('div', { className: 'transmiao-setting-row' });
    scRow.appendChild(_el('span', { className: 'transmiao-setting-label' }, ['快捷键']));
    var scCtrl = _el('div', { className: 'transmiao-setting-control', style: { flexDirection: 'column', alignItems: 'flex-start' } });
    var scInput = _el('input', {
        type: 'text',
        className: 'transmiao-form-input',
        placeholder: '按下组合键',
        readonly: '',
        value: s.shortcut || 'Alt+C',
        style: { width: '120px', cursor: 'pointer' },
        onFocus: function() {
            scInput.value = '...按下按键...';
            scInput._capturing = true;
        },
        onBlur: function() {
            scInput._capturing = false;
            if (!scInput.value || scInput.value === '...按下按键...') {
                scInput.value = TRANSMIAO.settings.getSettings().shortcut || 'Alt+C';
            }
        },
        onKeyDown: function(e) {
            if (!scInput._capturing) return;
            e.preventDefault();
            e.stopPropagation();
            // 忽略单独按修饰键
            if (['Control', 'Alt', 'Shift', 'Meta'].indexOf(e.key) !== -1) return;
            var parts = [];
            if (e.ctrlKey) parts.push('Ctrl');
            if (e.altKey) parts.push('Alt');
            if (e.shiftKey) parts.push('Shift');
            if (e.metaKey) parts.push('Meta');
            var key = e.key;
            if (key === ' ') key = 'Space';
            else if (key.length === 1) key = key.toUpperCase();
            parts.push(key);
            var combo = parts.join('+');
            scInput.value = combo;
            scInput._capturing = false;
            scInput.blur();
            TRANSMIAO.settings.updateSetting('shortcut', combo);
        }
    });
    scCtrl.appendChild(scInput);
    scCtrl.appendChild(_el('div', { className: 'transmiao-form-hint' }, ['点击后按下组合键设置']));
    scRow.appendChild(scCtrl);
    groupC.appendChild(scRow);

    // 浮动按钮
    groupC.appendChild(makeSettingRow('启动器显示', 'showFloatBtn', 'select', {
        options: [
            { value: 'true', label: '显示' },
            { value: 'false', label: '隐藏' }
        ],
        transform: {
            toSetting: function(v) { return v === 'true'; },
            toDisplay: function(v) { return String(v); }
        },
        onChangeExtra: function() { applyLauncherVisibility(); }
    }, s));

    _tab2Body.appendChild(groupC);

    // ====== 分组 D: 高级 ======
    var groupD = _el('div', { className: 'transmiao-setting-group' }, [
        _el('div', { className: 'transmiao-setting-group-title' }, ['高级'])
    ]);

    // 每批最大字符数
    groupD.appendChild(makeSettingRow('每批最大字符', 'batchSize', 'number', {
        min: 500, max: 10000, step: 100, unit: ''
    }, s));
    // 缓存上限
    groupD.appendChild(makeSettingRow('缓存上限', 'cacheLimit', 'select', {
        options: [
            { value: '500', label: '500 段' },
            { value: '1000', label: '1000 段' },
            { value: '2000', label: '2000 段' }
        ],
        transform: {
            toSetting: function(v) { return parseInt(v, 10); },
            toDisplay: function(v) { return String(v); }
        },
        onChangeExtra: function(v) {
            TRANSMIAO.cache.limit = parseInt(v, 10);
        }
    }, s));
    // 请求超时
    groupD.appendChild(makeSettingRow('请求超时', 'requestTimeout', 'number', {
        min: 5, max: 120, step: 5, unit: '秒'
    }, s));
    // 最大重试次数
    groupD.appendChild(makeSettingRow('最大重试', 'maxRetries', 'number', {
        min: 0, max: 5, step: 1, unit: '次'
    }, s));
    // UI 文案翻译
    groupD.appendChild(makeSettingRow('UI 文案翻译', 'translateUI', 'select', {
        options: [
            { value: 'false', label: '关闭' },
            { value: 'true', label: '开启' }
        ],
        transform: {
            toSetting: function(v) { return v === 'true'; },
            toDisplay: function(v) { return String(v); }
        }
    }, s));

    // 清空缓存按钮
    var clearRow = _el('div', { className: 'transmiao-setting-row' });
    clearRow.appendChild(_el('span', { className: 'transmiao-setting-label' }, ['缓存']));
    var clearCtrl = _el('div', { className: 'transmiao-setting-control' });
    var clearBtn = _el('button', {
        className: 'transmiao-btn transmiao-btn-danger transmiao-btn-sm',
        onClick: function() {
            TRANSMIAO.cache.clear();
            _showToast('缓存已清空');
        }
    }, ['一键清空缓存']);
    clearCtrl.appendChild(clearBtn);
    clearRow.appendChild(clearCtrl);
    groupD.appendChild(clearRow);

    // 翻译本页按钮
    var translateRow = _el('div', { className: 'transmiao-setting-row' });
    var translateBtn = _el('button', {
        className: 'transmiao-btn transmiao-btn-primary',
        style: { width: '100%', padding: '8px', fontSize: '13px' },
        onClick: function() { closePanel(); _startTranslation(); }
    }, ['立即翻译本页']);
    translateRow.appendChild(translateBtn);
    groupD.appendChild(translateRow);

    _tab2Body.appendChild(groupD);
}

/**
 * 创建设置行（选择器/数字输入）
 */
function makeSettingRow(label, key, type, opts, settings) {
    var row = _el('div', { className: 'transmiao-setting-row' });
    row.appendChild(_el('span', { className: 'transmiao-setting-label' }, [label]));

    var ctrl = _el('div', { className: 'transmiao-setting-control' });
    var currentVal = getNestedValue(settings, key);

    if (type === 'select') {
        var sel = _el('select', {
            onChange: function() {
                var rawVal = sel.value;
                var finalVal = (opts.transform && opts.transform.toSetting) ? opts.transform.toSetting(rawVal) : rawVal;
                TRANSMIAO.settings.updateSetting(key, finalVal);
                if (opts.onChangeExtra) opts.onChangeExtra(finalVal);
            }
        });
        for (var oi = 0; oi < opts.options.length; oi++) {
            var opt = opts.options[oi];
            var optEl = _el('option', { value: opt.value }, [opt.label]);
            var displayCurrent = (opts.transform && opts.transform.toDisplay) ? opts.transform.toDisplay(currentVal) : String(currentVal);
            if (opt.value === displayCurrent) optEl.selected = true;
            sel.appendChild(optEl);
        }
        ctrl.appendChild(sel);
    } else if (type === 'number') {
        var numInput = _el('input', {
            type: 'number',
            className: 'transmiao-form-input',
            min: String(opts.min || 0),
            max: String(opts.max || 99999),
            step: String(opts.step || 1),
            value: String(currentVal),
            onInput: function() {
                var v = parseInt(numInput.value, 10) || opts.min || 0;
                if (v < (opts.min || 0)) v = opts.min || 0;
                if (v > (opts.max || 99999)) v = opts.max || 99999;
                TRANSMIAO.settings.updateSetting(key, v);
            }
        });
        ctrl.appendChild(numInput);
        ctrl.appendChild(_el('span', { style: { fontSize: '11px', color: '#999' } }, [opts.unit || '']));
    }

    row.appendChild(ctrl);
    return row;
}

/**
 * 创建颜色选择行
 */
function makeColorSettingRow(label, key, settings) {
    var row = _el('div', { className: 'transmiao-setting-row' });
    row.appendChild(_el('span', { className: 'transmiao-setting-label' }, [label]));

    var ctrl = _el('div', { className: 'transmiao-setting-control' });
    var currentVal = getNestedValue(settings, key) || '';

    var preview = _el('div', { className: 'transmiao-color-preview', style: { backgroundColor: currentVal } });
    var colorInput = _el('input', {
        type: 'color',
        value: currentVal,
        onInput: function() {
            preview.style.backgroundColor = colorInput.value;
            TRANSMIAO.settings.updateSetting(key, colorInput.value);
        }
    });

    ctrl.appendChild(preview);
    ctrl.appendChild(colorInput);
    row.appendChild(ctrl);
    return row;
}

/**
 * 从嵌套对象中取值（如 'style.bgColor'）
 */
function getNestedValue(obj, path) {
    var keys = path.split('.');
    var cur = obj;
    for (var ki = 0; ki < keys.length; ki++) {
        if (cur == null || typeof cur !== 'object') return undefined;
        cur = cur[keys[ki]];
    }
    return cur;
}

/**
 * 刷新设置控件的值（打开面板时调用）
 */
function refreshSettingsControls() {
    // 简单实现：重新渲染整个 Tab 2
    renderSettingsTab();
}

// ====== API 请求适配层 ======

/* ========== 1. GM_xmlhttpRequest Promise 封装 ========== */

/**
 * 将 GM_xmlhttpRequest 封装为 Promise。
 * 支持超时、错误体解析、Via 降级（fetch）。
 */
function gmRequest(options) {
    var signal = options.signal;
    var aborted = false;

    function abortRequest() {
        if (aborted) return;
        aborted = true;
        var err = new Error('请求已取消');
        err.statusCode = 0;
        err.aborted = true;
        return err;
    }

    // 信号已触发则立即取消
    if (signal && signal.aborted) {
        return Promise.reject(abortRequest());
    }

    return new Promise(function(resolve, reject) {
        var timeout = options.timeout || 30000;
        var url = options.url;
        var method = options.method || 'POST';
        var headers = options.headers || {};
        var body = options.body || '';

        // 保底超时
        var timer = setTimeout(function() {
            if (aborted) return;
            var err = new Error('请求超时');
            err.statusCode = 0;
            reject(err);
        }, timeout + 1000);

        if (TRANSMIAO.ENV.HAS_GM) {
            var xhrHandle = GM_xmlhttpRequest({
                method: method,
                url: url,
                headers: headers,
                data: body,
                timeout: timeout,
                onload: function(resp) {
                    clearTimeout(timer);
                    if (aborted) return;
                    if (resp.status >= 200 && resp.status < 300) {
                        resolve(resp.responseText);
                    } else {
                        var errMsg = 'HTTP ' + resp.status;
                        var openAIErr = '';
                        try {
                            var errBody = JSON.parse(resp.responseText);
                            if (errBody.error && errBody.error.message) {
                                openAIErr = errBody.error.message;
                                errMsg = openAIErr;
                            }
                        } catch (e) { /* 非 JSON 错误体，忽略 */ }
                        var err = new Error(errMsg);
                        err.statusCode = resp.status;
                        err.openAIError = openAIErr;
                        reject(err);
                    }
                },
                onerror: function() {
                    clearTimeout(timer);
                    if (aborted) return;
                    var err = new Error('网络请求失败');
                    err.statusCode = 0;
                    reject(err);
                },
                ontimeout: function() {
                    clearTimeout(timer);
                    if (aborted) return;
                    var err = new Error('请求超时');
                    err.statusCode = 0;
                    reject(err);
                }
            });
            // 注册信号取消
            if (signal) {
                signal.addEventListener('abort', function() {
                    clearTimeout(timer);
                    if (xhrHandle && xhrHandle.abort) xhrHandle.abort();
                    reject(abortRequest());
                });
            }
        } else {
            // Via 降级：fetch
            var controller = new AbortController();
            // 如果有外部信号，父信号取消时也取消 fetch
            if (signal) {
                signal.addEventListener('abort', function() {
                    controller.abort();
                    clearTimeout(timer);
                    reject(abortRequest());
                });
            }
            var fetchTimer = setTimeout(function() { controller.abort(); }, timeout);

            fetch(url, {
                method: method,
                headers: headers,
                body: method === 'GET' ? undefined : body,
                signal: controller.signal
            })
            .then(function(response) {
                clearTimeout(fetchTimer);
                clearTimeout(timer);
                if (aborted) return;
                return response.text().then(function(text) {
                    if (response.ok) {
                        resolve(text);
                    } else {
                        var errMsg = 'HTTP ' + response.status;
                        var openAIErr = '';
                        try {
                            var errBody = JSON.parse(text);
                            if (errBody.error && errBody.error.message) {
                                openAIErr = errBody.error.message;
                                errMsg = openAIErr;
                            }
                        } catch (e) { /* 非 JSON 错误体，忽略 */ }
                        var err = new Error(errMsg);
                        err.statusCode = response.status;
                        err.openAIError = openAIErr;
                        reject(err);
                    }
                });
            })
            .catch(function(fetchErr) {
                clearTimeout(fetchTimer);
                clearTimeout(timer);
                if (aborted) return;
                if (fetchErr.name === 'AbortError') {
                    var err = new Error('请求超时');
                    err.statusCode = 0;
                    reject(err);
                } else {
                    var err = new Error('网络请求失败');
                    err.statusCode = 0;
                    reject(err);
                }
            });
        }
    });
}

/* ========== 2. OpenAI 格式翻译请求 ========== */

/**
 * 向 OpenAI 兼容接口发送翻译请求。
 * systemPrompt 中的 {目标语言} 会被替换为当前设置的目标语言。
 * 返回译文纯文本。
 */
async function callOpenAI(config, text, signal) {
    var settings = TRANSMIAO.settings.getSettings();
    var targetLang = settings.targetLang || '简体中文';
    var systemPrompt = (config.systemPrompt || DEFAULT_SYSTEM_PROMPT)
        .replace(/\{目标语言\}/g, targetLang);

    var baseUrl = (config.baseUrl || '').replace(/\/+$/, '');
    var url = baseUrl + '/v1/chat/completions';

    var requestBody = {
        model: config.model || 'gpt-4o-mini',
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: text }
        ],
        temperature: 0.3,
        max_tokens: 4096
    };

    var responseText;
    try {
        responseText = await gmRequest({
            method: 'POST',
            url: url,
            headers: {
                'Authorization': 'Bearer ' + (config.apiKey || ''),
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(requestBody),
            timeout: settings.requestTimeout || 30000,
            signal: signal
        });
    } catch (err) {
        // abort 不弹错误 toast
        if (!err.aborted) handleAPIError(err);
        throw err;
    }

    // 解析 JSON 响应
    var data;
    try {
        data = JSON.parse(responseText);
    } catch (e) {
        var parseErr = new Error('JSON 解析失败');
        parseErr.statusCode = 0;
        handleAPIError(parseErr);
        throw parseErr;
    }

    // 提取译文
    var result = null;
    try {
        result = data.choices[0].message.content;
    } catch (e) { /* choices 结构不完整 */ }

    if (typeof result !== 'string' || !result.trim()) {
        var emptyErr = new Error('AI 返回数据异常，未找到译文内容');
        emptyErr.statusCode = 0;
        handleAPIError(emptyErr);
        throw emptyErr;
    }

    return result.trim();
}

/* ========== 3. 单段翻译（带缓存 + 请求去重） ========== */

/**
 * 翻译单段文本。
 * 1. 查缓存 → 命中直接返回
 * 2. 查进行中的相同请求 → await 等待
 * 3. 发起新请求 → 结果缓存 + resolve 等待者
 */
async function translateSingle(config, text, targetLang, signal) {
    if (!text || !text.trim()) return '';
    text = text.trim();

    // 1. 查缓存（使用全配置作为缓存键，区分 API 地址/模型/提示词）
    var cached = TRANSMIAO.cache.get(text, targetLang, config);
    if (cached !== null) return cached;

    // 2. 查重复请求
    var pending = TRANSMIAO.cache.getPending(text, targetLang, config);
    if (pending) {
        return await pending;
    }

    // 3. 发起新请求（标记去重）
    var promise = TRANSMIAO.cache.addPending(text, targetLang, config);

    try {
        var result = (config.type === 'gemini')
            ? await callGemini(config, text, signal)
            : await callOpenAI(config, text, signal);
        // 缓存成功结果
        TRANSMIAO.cache.set(text, targetLang, config, result);
        TRANSMIAO.cache.resolvePending(text, targetLang, config, result);
        return result;
    } catch (err) {
        // 失败：reject 等待者，让它们也感知到错误
        // abort 错误直接向上抛，不缓存
        TRANSMIAO.cache.rejectPending(text, targetLang, config, err);
        throw err;
    }
}

/* ========== 4. 批量翻译（JSON 协议） ========== */

/**
 * 向 OpenAI 发送批量翻译请求，要求 AI 返回 JSON 数组。
 * 请求指令明确要求只返回 JSON，不返回 Markdown、说明或额外文本。
 */
async function callBatchOpenAI(config, items, targetLang, signal) {
    var systemPrompt = (config.systemPrompt || DEFAULT_SYSTEM_PROMPT)
        .replace(/\{目标语言\}/g, targetLang);

    var itemsJson = JSON.stringify(items);

    var userPrompt = 'Translate each of the following texts to ' + targetLang
        + '.\nReturn ONLY a valid JSON array (no markdown, no code fences, no extra text).\n'
        + 'Each element must have "id" and "translation" keys.\n'
        + 'Input: ' + itemsJson;

    var url = (config.baseUrl || '').replace(/\/+$/, '') + '/v1/chat/completions';
    var requestBody = {
        model: config.model || 'gpt-4o-mini',
        messages: [
            { role: 'system', content: systemPrompt + '\nYou must respond with ONLY a valid JSON array. No markdown, no explanations.' },
            { role: 'user', content: userPrompt }
        ],
        temperature: 0.3,
        max_tokens: 4096
    };

    var settings = TRANSMIAO.settings.getSettings();
    var responseText = await gmRequest({
        method: 'POST',
        url: url,
        headers: {
            'Authorization': 'Bearer ' + (config.apiKey || ''),
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody),
        timeout: settings.requestTimeout || 30000,
        signal: signal
    });

    return responseText;
}

/* ========== Gemini 格式翻译请求 ========== */

async function callGemini(config, text, signal) {
    var settings = TRANSMIAO.settings.getSettings();
    var targetLang = settings.targetLang || '简体中文';
    var systemPrompt = (config.systemPrompt || DEFAULT_SYSTEM_PROMPT)
        .replace(/\{目标语言\}/g, targetLang);

    var baseUrl = (config.baseUrl || '').replace(/\/+$/, '');
    var model = config.model || 'gemini-pro';
    var url = baseUrl + '/v1beta/models/' + model + ':generateContent?key=' + encodeURIComponent(config.apiKey || '');

    // Gemini 不支持独立 system 角色，拼到 user message
    var requestBody = {
        contents: [
            { role: 'user', parts: [{ text: 'system: ' + systemPrompt + '\n\n' + text }] }
        ],
        generationConfig: {
            temperature: 0.3,
            maxOutputTokens: 4096
        }
    };

    var responseText;
    try {
        responseText = await gmRequest({
            method: 'POST',
            url: url,
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(requestBody),
            timeout: settings.requestTimeout || 30000,
            signal: signal
        });
    } catch (err) {
        if (!err.aborted) handleAPIError(err);
        throw err;
    }

    var data;
    try {
        data = JSON.parse(responseText);
    } catch (e) {
        var parseErr = new Error('JSON 解析失败');
        parseErr.statusCode = 0;
        handleAPIError(parseErr);
        throw parseErr;
    }

    var result = null;
    try {
        result = data.candidates[0].content.parts[0].text;
    } catch (e) { /* 结构不完整 */ }

    if (typeof result !== 'string' || !result.trim()) {
        var emptyErr = new Error('AI 返回数据异常，未找到译文内容');
        emptyErr.statusCode = 0;
        handleAPIError(emptyErr);
        throw emptyErr;
    }

    return result.trim();
}

/* ========== Gemini 批量翻译（JSON 协议） ========== */

async function callBatchGemini(config, items, targetLang, signal) {
    var systemPrompt = (config.systemPrompt || DEFAULT_SYSTEM_PROMPT)
        .replace(/\{目标语言\}/g, targetLang);

    var itemsJson = JSON.stringify(items);

    var userPrompt = 'Translate each of the following texts to ' + targetLang
        + '.\nReturn ONLY a valid JSON array (no markdown, no code fences, no extra text).\n'
        + 'Each element must have "id" and "translation" keys.\n'
        + 'Input: ' + itemsJson;

    var baseUrl = (config.baseUrl || '').replace(/\/+$/, '');
    var model = config.model || 'gemini-pro';
    var url = baseUrl + '/v1beta/models/' + model + ':generateContent?key=' + encodeURIComponent(config.apiKey || '');

    var requestBody = {
        contents: [
            { role: 'user', parts: [{ text: 'system: ' + systemPrompt + '\n\n' + userPrompt }] }
        ],
        generationConfig: {
            temperature: 0.3,
            maxOutputTokens: 4096
        }
    };

    var settings = TRANSMIAO.settings.getSettings();
    var responseText = await gmRequest({
        method: 'POST',
        url: url,
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody),
        timeout: settings.requestTimeout || 30000,
        signal: signal
    });

    // 解析 Gemini JSON 包裹，提取内层文本（parseBatchResponse 期望 JSON 数组文本）
    var data;
    try {
        data = JSON.parse(responseText);
    } catch (e) {
        var parseErr = new Error('JSON 解析失败');
        parseErr.statusCode = 0;
        throw parseErr;
    }
    var innerText;
    try {
        innerText = data.candidates[0].content.parts[0].text;
    } catch (e) { /* 结构不完整 */ }
    if (typeof innerText !== 'string' || !innerText.trim()) {
        var emptyErr = new Error('AI 返回数据异常，未找到译文内容');
        emptyErr.statusCode = 0;
        throw emptyErr;
    }
    return innerText.trim();
}

/**
 * 解析 AI 返回的 JSON 数组响应。
 * 可剥离外层 Markdown 代码围栏。
 *
 * 严格校验：
 * - 未知 ID、重复 ID、缺失 ID → error
 * - 空/非字符串 translation → error
 * - 不允许重复 ID 被静默覆盖或未知 ID 被静默忽略
 *
 * @param {string} responseText    AI 原始返回文本
 * @param {Array}  expectedItems   请求时发送的 items（含 id）
 * @returns {{ success: boolean, results: Object<string,string>, error: ?string }}
 */
function parseBatchResponse(responseText, expectedItems) {
    var result = { success: false, results: {}, error: null };
    var text = (responseText || '').trim();

    // 剥离外层 Markdown 代码围栏 ```json ... ```
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

    var data;
    try {
        data = JSON.parse(text);
    } catch (e) {
        result.error = 'JSON 解析失败';
        return result;
    }

    if (!Array.isArray(data)) {
        result.error = '返回数据不是数组';
        return result;
    }

    // 收集期望的 ID
    var expectedIds = {};
    for (var ei = 0; ei < expectedItems.length; ei++) {
        expectedIds[expectedItems[ei].id] = true;
    }

    // 解析返回条目（含严格校验）
    var seenIds = {};
    var foundIds = {};

    for (var di = 0; di < data.length; di++) {
        var entry = data[di];
        if (!entry || typeof entry !== 'object') continue;

        var id = entry.id;
        var translation = entry.translation;

        // 未知 ID
        if (id === undefined || id === null || !expectedIds[id]) {
            result.error = '协议异常：返回了未知 ID';
            continue;
        }

        // 重复 ID
        if (seenIds[id]) {
            result.error = '协议异常：返回了重复 ID ' + id;
            continue;
        }
        seenIds[id] = true;

        // 空/非字符串 translation
        if (typeof translation !== 'string' || !translation.trim()) {
            result.error = '协议异常：ID ' + id + ' 的 translation 为空或非字符串';
            continue;
        }

        result.results[id] = translation.trim();
        foundIds[id] = true;
    }

    // 判断是否全部命中
    var allFound = true;
    for (var id in expectedIds) {
        if (!foundIds[id]) { allFound = false; break; }
    }

    result.success = allFound && !result.error;
    if (!allFound && !result.error) {
        result.error = '协议异常：缺少部分 ID';
    }
    return result;
}

/**
 * 批量翻译多段文本（JSON 数组协议）。
 *
 * 流程：
 * 1. 查持久化/内存缓存，收集未命中项；
 * 2. 对未命中项按原文去重（相同文本只请求一次）；
 * 3. 生成唯一 item ID，按 batchSize 分批；
 * 4. 每批调 callBatchOpenAI，解析 JSON 响应；
 * 5. 格式异常时按重试设置重试；耗尽后对缺失项逐条降级；
 * 6. 每条成功结果立即写入缓存。
 */
async function translateBatch(config, textArray, signal) {
    if (!textArray || textArray.length === 0) return [];
    if (textArray.length === 1) {
        var singleResult = await translateSingle(
            config, textArray[0], TRANSMIAO.settings.getSettings().targetLang, signal
        );
        return [singleResult];
    }

    var settings = TRANSMIAO.settings.getSettings();
    var targetLang = settings.targetLang || '简体中文';
    var maxBatchSize = settings.batchSize || 3000;

    // ---- 1. 查缓存 ----
    var results = new Array(textArray.length);
    var uncachedIndices = [];
    var uncachedTexts = [];

    for (var vi = 0; vi < textArray.length; vi++) {
        var rawText = (textArray[vi] || '').trim();
        if (!rawText) {
            results[vi] = '';
            continue;
        }
        var cached = TRANSMIAO.cache.get(rawText, targetLang, config);
        if (cached !== null) {
            results[vi] = cached;
        } else {
            uncachedIndices.push(vi);
            uncachedTexts.push(rawText);
        }
    }

    // 全部命中 → 直接返回
    if (uncachedTexts.length === 0) return results;

    // ---- 2. 按原文去重（无原型链） ----
    var uniqueMap = Object.create(null);
    var uniqueTexts = [];
    for (var ui = 0; ui < uncachedTexts.length; ui++) {
        var t = uncachedTexts[ui];
        if (!uniqueMap[t]) {
            uniqueMap[t] = [];
            uniqueTexts.push(t);
        }
        uniqueMap[t].push(uncachedIndices[ui]);
    }

    // ---- 3. 按 batchSize 分批 ----
    var batches = [];
    var currentBatch = [];
    var currentSize = 0;
    var safetyMargin = 300; // JSON 序列化 + 指令开销余量

    function estimateItemSize(text) {
        return text.length + 60; // {"id":"i_N","text":"..."} 的近似长度
    }

    for (var ti = 0; ti < uniqueTexts.length; ti++) {
        var ut = uniqueTexts[ti];
        var itemSize = estimateItemSize(ut);
        if (currentSize + itemSize + safetyMargin > maxBatchSize && currentBatch.length > 0) {
            batches.push(currentBatch);
            currentBatch = [];
            currentSize = 0;
        }
        currentBatch.push(ut);
        currentSize += itemSize;
    }
    if (currentBatch.length > 0) batches.push(currentBatch);

    // ---- 4. 逐批发送 JSON 格式请求 ----
    for (var bi = 0; bi < batches.length; bi++) {
        var batch = batches[bi];
        // 生成唯一 ID
        var batchItems = batch.map(function(t, idx) {
            return { id: 'i_' + (bi * 1000 + idx), text: t };
        });

        var batchResultMap = {};
        // retryCount = 0 时真的不重试（|| 2 在 0 时会错）
        var retryCount = settings.maxRetries;
        if (retryCount === undefined || retryCount === null) retryCount = 2;

        // 剩余未完成的 items（初始为全部，每次部分成功后过滤）
        var remainingItems = batchItems.slice();

        // 批量请求 + 重试
        for (var attempt = 0; attempt <= retryCount; attempt++) {
            if (remainingItems.length === 0) break;
            try {
                var respText = (config.type === 'gemini')
                    ? await callBatchGemini(config, remainingItems, targetLang, signal)
                    : await callBatchOpenAI(config, remainingItems, targetLang, signal);
                var parsed = parseBatchResponse(respText, remainingItems);
                // 积累已解析的结果
                for (var rid in parsed.results) {
                    batchResultMap[rid] = parsed.results[rid];
                }
                if (parsed.success) {
                    // 当前剩余全部解析成功
                    break;
                }
                // 部分成功或格式错误：过滤出尚未完成的 item
                remainingItems = remainingItems.filter(function(item) {
                    return !batchResultMap[item.id];
                });
                if (remainingItems.length === 0) break;
                if (attempt < retryCount) {
                    await new Promise(function(r) { setTimeout(r, 1000 * Math.pow(2, attempt)); });
                }
            } catch (err) {
                if (err.aborted) throw err;
                if (attempt < retryCount) {
                    await new Promise(function(r) { setTimeout(r, 1000 * Math.pow(2, attempt)); });
                }
            }
        }

        // ---- 5. 处理每个 item：成功则缓存，失败则逐条降级 ----
        for (var ii = 0; ii < batchItems.length; ii++) {
            var item = batchItems[ii];
            var originalText = item.text;
            var translation = batchResultMap[item.id];

            if (translation) {
                // 缓存成功结果
                TRANSMIAO.cache.set(originalText, targetLang, config, translation);
                // 映射到所有相同原文的位置
                var positions = uniqueMap[originalText] || [];
                for (var pi = 0; pi < positions.length; pi++) {
                    results[positions[pi]] = translation;
                }
            } else {
                // 逐条降级
                try {
                    var fb = await translateSingle(config, originalText, targetLang, signal);
                    // translateSingle 已自动缓存
                    var positions2 = uniqueMap[originalText] || [];
                    for (var pi2 = 0; pi2 < positions2.length; pi2++) {
                        results[positions2[pi2]] = fb;
                    }
                } catch (e) {
                    if (e.aborted) throw e;
                    // 彻底失败 → 原文保底
                    var positions3 = uniqueMap[originalText] || [];
                    for (var pi3 = 0; pi3 < positions3.length; pi3++) {
                        results[positions3[pi3]] = originalText;
                    }
                }
            }
        }
    }

    return results;
}

/* ========== 5. 带重试的翻译入口 ========== */

/**
 * 带指数退避重试的翻译。
 * @param {Object}  config  激活的 API 配置
 * @param {string|string[]} text  待翻译文本（isBatch=true 时为数组）
 * @param {boolean} isBatch  是否批量翻译
 */
async function translateWithRetry(config, text, isBatch) {
    var maxRetries = TRANSMIAO.settings.getSettings().maxRetries;
    if (maxRetries === undefined || maxRetries === null) maxRetries = 2;
    var lastError;

    for (var attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            if (isBatch) {
                var textArray = Array.isArray(text) ? text : [text];
                return await translateBatch(config, textArray);
            } else {
                var targetLang = TRANSMIAO.settings.getSettings().targetLang || '简体中文';
                return await translateSingle(config, text, targetLang);
            }
        } catch (err) {
            if (err.aborted) throw err;
            lastError = err;
            if (attempt < maxRetries) {
                // 非最后一次 — 指数退避等待 1s, 2s, 4s...
                var delay = 1000 * Math.pow(2, attempt);
                await new Promise(function(r) { setTimeout(r, delay); });
            }
        }
    }

    // 所有重试耗尽，已在 callOpenAI 中 toast 过，无需重复
    throw lastError;
}

// 导出到 TRANSMIAO 名称空间（控制台调试可用）
TRANSMIAO.gmRequest = gmRequest;
TRANSMIAO.callOpenAI = callOpenAI;
TRANSMIAO.callGemini = callGemini;
TRANSMIAO.callBatchOpenAI = callBatchOpenAI;
TRANSMIAO.callBatchGemini = callBatchGemini;
TRANSMIAO.translateSingle = translateSingle;
TRANSMIAO.translateBatch = translateBatch;
TRANSMIAO.translateWithRetry = translateWithRetry;

// ====== 错误处理（Toast） ======

/**
 * 统一 API 错误处理。
 * 根据错误状态码和消息匹配预定义的错误提示，显示红色 Toast。
 * @param {Error} err  错误对象（应含 statusCode 可选属性）
 * @returns {string}  展示的错误消息
 */
function handleAPIError(err) {
    var msg = err && err.message ? err.message : String(err || '未知错误');
    var statusCode = err.statusCode || 0;
    var toastMsg = '';

    if (statusCode === 400) {
        toastMsg = 'API Key 或模型名称无效（400）';
    } else if (statusCode === 401) {
        toastMsg = 'API Key 无效（401），请检查密钥';
    } else if (statusCode === 404) {
        toastMsg = '接口地址或模型不存在（404）';
    } else if (statusCode === 429) {
        toastMsg = '请求过于频繁（429），请稍后重试';
    } else if (statusCode >= 500) {
        toastMsg = '服务器错误（' + statusCode + '），请稍后重试';
    } else if (msg.indexOf('网络请求失败') !== -1) {
        toastMsg = '网络请求失败，请检查网络连接';
    } else if (msg.indexOf('超时') !== -1 || msg.indexOf('timeout') !== -1 || msg.indexOf('Abort') !== -1) {
        toastMsg = '请求超时，请稍后重试或增加超时时间';
    } else if (msg.indexOf('JSON') !== -1 || msg.indexOf('parse') !== -1 || msg.indexOf('解析') !== -1) {
        toastMsg = 'AI 返回数据异常，请检查 API 地址';
    } else if (msg.indexOf('译文内容') !== -1 || msg.indexOf('未找到') !== -1) {
        toastMsg = 'AI 返回数据异常，未找到译文内容';
    } else {
        // 兜底：使用错误消息本身，截断过长
        toastMsg = msg.length > 60 ? msg.slice(0, 60) + '...' : msg;
    }

    // 如果有 OpenAI 原始错误信息且有富余空间，追加补充
    if (err.openAIError && err.openAIError !== msg && toastMsg.length < 50) {
        var extra = err.openAIError.length > 40 ? err.openAIError.slice(0, 40) + '...' : err.openAIError;
        toastMsg = toastMsg + '（' + extra + '）';
    }

    _showToast(toastMsg, 'error');
    return toastMsg;
}

// ====== 整页翻译模块 ======

/* ========== 翻译专用 CSS ========== */

var TRANSLATE_CSS = '\
.transmiao-translated {\
    cursor: pointer;\
    border-radius: 2px;\
    padding: 0 1px;\
    transition: background 0.2s;\
}\
.transmiao-translated:hover {\
    opacity: 0.85;\
}\
.transmiao-tl-text {}\
.transmiao-original-text {\
    font-size: 0.85em;\
    color: #888;\
    margin-top: 2px;\
}\
.transmiao-bilingual .transmiao-original-text {\
    border-top: 1px dashed #ddd;\
    padding-top: 2px;\
}\
.transmiao-bar {\
    position: fixed;\
    top: 0;\
    left: 0;\
    right: 0;\
    z-index: 2147483646;\
    background: #4A90D9;\
    color: #fff;\
    padding: 8px 16px;\
    display: flex;\
    align-items: center;\
    gap: 12px;\
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;\
    font-size: 13px;\
    box-shadow: 0 2px 8px rgba(0,0,0,0.15);\
    animation: transmiao-bar-slide 0.25s ease-out;\
}\
@keyframes transmiao-bar-slide {\
    from { transform: translateY(-100%); }\
    to { transform: translateY(0); }\
}\
.transmiao-bar-text {\
    flex: 1;\
}\
.transmiao-bar-btn {\
    cursor: pointer;\
    text-decoration: underline;\
    opacity: 0.9;\
    white-space: nowrap;\
}\
.transmiao-bar-btn:hover {\
    opacity: 1;\
}\
.transmiao-bar-close {\
    cursor: pointer;\
    opacity: 0.7;\
    font-size: 14px;\
    padding: 0 4px;\
}\
.transmiao-bar-close:hover {\
    opacity: 1;\
}\
.transmiao-word-tag {\
    position: fixed;\
    z-index: 2147483647;\
    background: #fff;\
    border: 1px solid #4A90D9;\
    color: #4A90D9;\
    border-radius: 4px;\
    padding: 1px 6px;\
    font-size: 12px;\
    cursor: pointer;\
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;\
    box-shadow: 0 1px 6px rgba(0,0,0,0.12);\
    user-select: none;\
    line-height: 1.5;\
    display: none;\
    transition: background 0.15s;\
}\
.transmiao-word-tag:hover {\
    background: #4A90D9;\
    color: #fff;\
}\
.transmiao-word-tag.transmiao-word-tag-visible {\
    display: block;\
}\
.transmiao-word-bubble {\
    position: fixed;\
    z-index: 2147483647;\
    background: #fff;\
    border-radius: 8px;\
    box-shadow: 0 4px 16px rgba(0,0,0,0.16);\
    padding: 10px 14px;\
    max-width: 320px;\
    max-height: 200px;\
    overflow-y: auto;\
    font-size: 14px;\
    color: #333;\
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;\
    line-height: 1.6;\
    display: none;\
    word-break: break-word;\
    animation: transmiao-fade-in 0.12s ease-out;\
}\
.transmiao-word-bubble.transmiao-word-bubble-visible {\
    display: block;\
}\
.transmiao-launcher {\
    position: fixed;\
    z-index: 2147483647;\
    width: 44px;\
    height: 44px;\
    border-radius: 50%;\
    background: #4A90D9;\
    color: #fff;\
    font-size: 18px;\
    cursor: pointer;\
    display: flex;\
    align-items: center;\
    justify-content: center;\
    box-shadow: 0 2px 12px rgba(0,0,0,0.22);\
    opacity: 0.45;\
    transition: opacity 0.25s, box-shadow 0.2s;\
    user-select: none;\
    touch-action: none;\
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;\
    line-height: 1;\
}\
.transmiao-launcher:hover,\
.transmiao-launcher-dragging {\
    opacity: 1;\
    box-shadow: 0 4px 16px rgba(0,0,0,0.3);\
}\
.transmiao-launcher-menu {\
    position: fixed;\
    z-index: 2147483647;\
    background: #fff;\
    border-radius: 8px;\
    box-shadow: 0 4px 20px rgba(0,0,0,0.18);\
    padding: 4px 0;\
    min-width: 130px;\
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;\
    font-size: 13px;\
    color: #333;\
    display: none;\
    overflow: hidden;\
    animation: transmiao-fade-in 0.12s ease-out;\
}\
.transmiao-launcher-menu.transmiao-launcher-menu-visible {\
    display: block;\
}\
.transmiao-launcher-menu-item {\
    padding: 8px 14px;\
    cursor: pointer;\
    display: flex;\
    align-items: center;\
    gap: 6px;\
    transition: background 0.1s;\
    white-space: nowrap;\
}\
.transmiao-launcher-menu-item:hover {\
    background: #f0f4ff;\
    color: #4A90D9;\
}\
.transmiao-launcher-menu-item.disabled {\
    opacity: 0.5;\
    cursor: default;\
}\
.transmiao-launcher-menu-item .launcher-progress {\
    font-size: 11px;\
    color: #888;\
}\
@media (max-width: 480px) {\
    .transmiao-launcher {\
        width: 40px;\
        height: 40px;\
        font-size: 16px;\
    }\
}';

/* ========== 进度 Toast 追踪 ========== */

var _progressToast = null;

function _updateProgressToast(msg) {
    if (_progressToast && _progressToast.parentNode) {
        _progressToast.textContent = msg;
    } else {
        _progressToast = document.createElement('div');
        _progressToast.className = 'transmiao-toast';
        _progressToast.textContent = msg;
        document.body.appendChild(_progressToast);
    }
}

function _clearProgressToast() {
    if (_progressToast && _progressToast.parentNode) {
        _progressToast.parentNode.removeChild(_progressToast);
    }
    _progressToast = null;
}

/* ========== 可见性检测 ========== */

function isVisible(el) {
    if (!el || !el.parentNode) return false;
    try {
        var style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
            return false;
        }
        if (el.offsetWidth === 0 && el.offsetHeight === 0) {
            // 允许零宽但单行的情况（如换行符文本节点的父级）
            if (el.offsetParent === null && el !== document.body && el !== document.documentElement) {
                return false;
            }
        }
    } catch (e) { return false; }
    return true;
}

/* ========== 文字节点提取 ========== */

/**
 * 检查节点或其祖先是否在 transMiao UI 内部。
 * 用 closest 的降级实现（循环 parentElement）。
 */
function insideTransMiaoUI(node) {
    var el = node.nodeType === 1 ? node : (node.parentElement || null);
    while (el) {
        if (el.classList) {
            for (var ci = 0; ci < el.classList.length; ci++) {
                var cls = el.classList[ci];
                if (cls.indexOf('transmiao-') === 0) return true;
            }
        }
        if (el.id && el.id.indexOf('transmiao-') === 0) return true;
        el = el.parentElement;
    }
    return false;
}

/**
 * 提取文档中所有需要翻译的文字节点。
 */
function getTextNodes(root) {
    var results = [];
    var EXCLUDED_TAGS = {
        'script': true, 'style': true, 'code': true, 'pre': true,
        'textarea': true, 'input': true, 'select': true, 'option': true,
        'noscript': true, 'svg': true, 'math': true
    };

    var walker = document.createTreeWalker(
        root,
        NodeFilter.SHOW_TEXT,
        {
            acceptNode: function(node) {
                // 排除空白文本
                if (!node.textContent || !node.textContent.trim()) {
                    return NodeFilter.FILTER_REJECT;
                }
                var parent = node.parentElement;
                if (!parent) return NodeFilter.FILTER_REJECT;
                // 排除特定标签
                var tag = parent.tagName ? parent.tagName.toLowerCase() : '';
                if (EXCLUDED_TAGS[tag]) return NodeFilter.FILTER_REJECT;
                // 排除不可见元素
                if (!isVisible(parent)) return NodeFilter.FILTER_REJECT;
                // 排除 transMiao UI
                if (insideTransMiaoUI(node)) return NodeFilter.FILTER_REJECT;
                return NodeFilter.FILTER_ACCEPT;
            }
        },
        false
    );

    var node;
    while (node = walker.nextNode()) {
        results.push(node);
    }
    return results;
}

/* ========== 文字节点分组 ========== */

/**
 * 找到最近的块级祖先（display: block|flex|grid|table|list-item）。
 */
function getBlockAncestor(node) {
    var el = node.parentElement;
    while (el && el !== document.body && el !== document.documentElement) {
        try {
            var display = window.getComputedStyle(el).display;
            if (display === 'block' || display === 'flex' || display === 'grid'
                || display === 'table' || display === 'table-row' || display === 'list-item'
                || display === 'flow-root') {
                return el;
            }
        } catch (e) { return document.body; }
        el = el.parentElement;
    }
    return document.body;
}

/**
 * 将相邻文本节点分组为段落。
 */
function groupTextNodes(textNodes) {
    var groups = [];
    var currentGroup = [];
    var currentBlock = null;

    for (var i = 0; i < textNodes.length; i++) {
        var node = textNodes[i];
        var block = getBlockAncestor(node);

        if (currentBlock !== null && currentBlock !== block) {
            // 块级边界 → 提交当前组
            _finalizeGroup(groups, currentGroup);
            currentGroup = [];
        }
        currentBlock = block;
        currentGroup.push(node);
    }
    // 最后一批
    _finalizeGroup(groups, currentGroup);

    return groups;
}

function _finalizeGroup(groups, nodes) {
    if (nodes.length === 0) return;
    var parts = [];
    for (var i = 0; i < nodes.length; i++) {
        var t = nodes[i].textContent;
        if (t.trim()) parts.push(t);
    }
    var joined = parts.join(' ').replace(/\s+/g, ' ').trim();
    // 过滤：太短、纯数字/标点
    if (joined.length < 2) return;
    var puncOnly = true;
    for (var ci = 0; ci < joined.length; ci++) {
        var ch = joined[ci];
        if (ch !== ' ' && ch !== '\t' && ch !== '\n' && ch !== '\r'
            && !(ch >= '0' && ch <= '9')
            && !(ch >= 'a' && ch <= 'z')
            && !(ch >= 'A' && ch <= 'Z')
            && !(ch >= '一' && ch <= '鿿')
            && !(ch >= '぀' && ch <= 'ヿ')
            && !(ch >= '가' && ch <= '힯')) {
            // 标点符号，继续
            continue;
        }
        puncOnly = false;
        break;
    }
    if (puncOnly && joined.replace(/[\s\d]/g, '').length <= 2) return;
    // 排除纯数字
    if (/^\d+$/.test(joined.replace(/\s/g, ''))) return;

    groups.push({
        text: joined,
        nodes: nodes.slice()
    });
}

/* ========== 分批 ========== */

function splitIntoBatches(groups, batchSize) {
    if (!batchSize || batchSize <= 0) batchSize = 3000;
    var batches = [];
    var currentBatch = [];
    var currentSize = 0;

    for (var i = 0; i < groups.length; i++) {
        var g = groups[i];
        var len = g.text.length;
        if (currentSize + len > batchSize && currentBatch.length > 0) {
            batches.push(currentBatch);
            currentBatch = [g];
            currentSize = len;
        } else {
            currentBatch.push(g);
            currentSize += len;
        }
    }
    if (currentBatch.length > 0) {
        batches.push(currentBatch);
    }
    return batches;
}

/* ========== 顶栏（隐藏/复用） ========== */

var _transBar = null;

function hideTranslationBar() {
    if (_transBar && _transBar.parentNode) {
        _transBar.parentNode.removeChild(_transBar);
    }
    _transBar = null;
}

/* ========== 整页翻译任务控制器 ========== */

/**
 * 单一页面翻译任务状态。
 * 所有全页翻译入口统一调用 startPageTranslation()，
 * 保证同时只有一个活动任务。
 */
var _pageTask = {
    id: 0,              // 单调递增任务 ID（判断晚到结果）
    running: false,     // 是否正在运行
    stopped: false,     // 是否已请求停止
    total: 0,           // 总待翻段数
    done: 0,            // 已完成段数
    cached: 0,          // 缓存命中段数
    skipped: 0,         // 跳过段数（已是目标语言）
    segmentMap: {},     // id → segment 快照
    _controller: null   // AbortController（中止当前 HTTP）
};

function stopPageTranslation() {
    if (!_pageTask.running) return;
    _pageTask.stopped = true;
    // 中止当前 HTTP 请求
    if (_pageTask._controller) {
        _pageTask._controller.abort();
        _pageTask._controller = null;
    }
    // 立即更新顶部栏
    _updatePageBar('stopped', _pageTask.done, _pageTask.total, _pageTask.cached);
}

function isPageTaskActive() {
    return (_pageTask.running && !_pageTask.stopped) || (_viewportTask.running && !_viewportTask.stopped);
}

/* ========== 安全的 Text 节点段落模型 ========== */

/**
 * 从 TreeWalker 提取的 Text 节点构建独立段落。
 * 每个 Text 节点生成一个 segment，不合并、不删除 DOM。
 * 相同文本的去重由缓存/批量层完成。
 */
function buildPageSegments(textNodes) {
    var segments = [];
    var segId = 0;
    var settings = TRANSMIAO.settings.getSettings();
    var skipEnabled = settings.skipAlreadyTargetLanguage !== false;
    var targetLang = settings.targetLang || '';
    for (var si = 0; si < textNodes.length; si++) {
        var node = textNodes[si];
        var text = node.textContent;
        var trimmed = text.trim();
        if (trimmed.length < 2) continue;
        // 排除纯数字/标点
        if (/^[\d\s.,!?;:…\-—()\[\]{}'""・、。！？；：（）【】「」『』]+$/.test(trimmed)) continue;
        // 跳过已是目标语言的高置信文本（全页/可见区域模式）
        if (skipEnabled && shouldSkipTranslation(trimmed, targetLang, true)) {
            _pageTask.skipped++;
            continue;
        }

        segments.push({
            id: 'seg_' + (segId++),
            node: node,
            originalText: text,
            normalized: trimmed,
            translatedText: null,
            rendered: false
        });
    }
    return segments;
}

/* ========== 目标语言跳过 helper ========== */

var SKIP_NON_LANG = /^[\s\d.,!?;:…\-—()\[\]{}'"@＃#=%+\/*<>^_`~|\\&，。！？；：、～（）【】「」『』《》〈〉]+$/;
var SKIP_URL = /^(https?:\/\/|ftp:\/\/|mailto:|www\.)[^\s]+$/i;
var SKIP_EMAIL = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
var SKIP_VERSION = /^v?\d+\.\d+(\.\d+)?([0-9a-zA-Z._+-]+)?$/;
var SKIP_UUID = /^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$/;
var SKIP_HEX = /^[0-9a-fA-F]{32,}$/;

var CJK_SIMPLIFIED_FEATURES = /[这那们会是了不的一上在有人个到们我他就你出的和时说也要为生可]|什么|没有|怎么|可以|因为|所以|但是|如果|虽然|而且|或者|已经|起来|之后|东西|这里|时候/;
var CJK_TRADITIONAL_FEATURES = /[這那是會議們為個來對現發關學開時後國長動從當無機體點關係與會後員對應實經驗選舉認證據標準聯繫權利義務發表]/;
var JA_KANA = /[぀-ゟ゠-ヿ]/;
var KO_HANGUL = /[가-힯]/;
var CJK_RANGE = /[一-鿿]/;
var EN_COMMON_WORDS = /\b(the|and|that|have|for|not|with|you|this|but|his|from|they|are|was|were|been|will|would|could|should|has|had|been|their|there|these|those|about|which|what|when|where|more|some|about|into|over|after|before|then|think|know|like|just|also|because|between|through|being|doing|going)\b/gi;

function normalizeTargetLanguage(targetLang) {
    var s = (targetLang || '').trim();
    if (/(简体中文|简中|Simplified Chinese|zh-cn)/i.test(s)) return 'zh-CN';
    if (/(繁體中文|繁体中文|Traditional Chinese|zh-tw|zh-hk)/i.test(s)) return 'zh-TW';
    if (/(日本語|日语|Japanese|ja)/i.test(s)) return 'ja';
    if (/(한국어|韩语|Korean|ko)/i.test(s)) return 'ko';
    if (/(English|英语|en)/i.test(s)) return 'en';
    if (/(Français|法语|fr)/i.test(s)) return 'fr';
    if (/(Deutsch|德语|de)/i.test(s)) return 'de';
    if (/(Español|西班牙语|es)/i.test(s)) return 'es';
    return null;
}

function shouldSkipTranslation(text, targetLang, enabled) {
    // 划词模式或开关关闭 → 不跳过
    if (!enabled) return false;
    if (!targetLang) return false;

    var s = (text || '').trim();
    if (s.length === 0) return true;

    // 始终跳过的非语言内容
    if (SKIP_NON_LANG.test(s)) return true;
    if (SKIP_URL.test(s)) return true;
    if (SKIP_EMAIL.test(s)) return true;
    if (SKIP_VERSION.test(s)) return true;
    if (SKIP_UUID.test(s)) return true;
    if (SKIP_HEX.test(s)) return true;

    var lang = normalizeTargetLanguage(targetLang);

    // 未知语言：只跳过上面的非语言内容
    if (!lang) return false;

    // CJK 规则
    if (lang === 'zh-CN') {
        var cjk = (s.match(CJK_RANGE) || []).length;
        var total = s.replace(/\s/g, '').length;
        if (cjk === 0 || total === 0) return false;
        // 出现假名或韩文 → 不跳过
        if (JA_KANA.test(s)) return false;
        if (KO_HANGUL.test(s)) return false;
        // 汉字未占绝对多数 → 不跳过
        if (cjk / total < 0.6) return false;
        // 必须含简体特征字
        return CJK_SIMPLIFIED_FEATURES.test(s);
    }

    if (lang === 'zh-TW') {
        var cjk2 = (s.match(CJK_RANGE) || []).length;
        var total2 = s.replace(/\s/g, '').length;
        if (cjk2 === 0 || total2 === 0) return false;
        if (JA_KANA.test(s)) return false;
        if (KO_HANGUL.test(s)) return false;
        if (cjk2 / total2 < 0.6) return false;
        return CJK_TRADITIONAL_FEATURES.test(s);
    }

    if (lang === 'ja') {
        // 只有出现并占主导的假名才跳过
        var kana = (s.match(JA_KANA) || []).length;
        var cjkCount = (s.match(CJK_RANGE) || []).length;
        var len = s.replace(/\s/g, '').length;
        if (kana > 0 && kana / len >= 0.15) return true;
        // 纯汉字不跳过
        return false;
    }

    if (lang === 'ko') {
        var hangul = (s.match(KO_HANGUL) || []).length;
        var len2 = s.replace(/\s/g, '').length;
        if (len2 === 0) return false;
        // 韩文占主导才跳过
        return hangul / len2 >= 0.3;
    }

    // 拉丁语言 (en/fr/de/es)
    if (/^(en|fr|de|es)$/.test(lang)) {
        var words = s.split(/\s+/);
        if (words.length < 4) return false;
        var commonMatch = (s.match(EN_COMMON_WORDS) || []).length;
        // 至少 2 个常见功能词 + 主要内容为拉丁字母
        var ascii = (s.match(/[a-zA-Z]/g) || []).length;
        var len3 = s.replace(/\s/g, '').length;
        if (len3 === 0) return false;
        if (ascii / len3 < 0.7) return false;
        return commonMatch >= 2;
    }

    return false;
}

/* ========== 可逆渲染 — 仅译文 ========== */

function renderSegmentTranslation(segment) {
    if (!segment.translatedText || !segment.node || !segment.node.parentNode) return;
    var settings = TRANSMIAO.settings.getSettings();
    var bgColor = (settings.style && settings.style.bgColor) || '#F2F2F2';
    var textColor = (settings.style && settings.style.textColor) || '#000000';

    // 安全检查：原文未被外部改动
    if (segment.node.textContent !== segment.originalText) return;

    var wrapper = document.createElement('span');
    wrapper.className = 'transmiao-translated';
    wrapper.setAttribute('data-seg-id', segment.id);
    wrapper.setAttribute('data-original', segment.originalText);
    wrapper.setAttribute('data-translated', segment.translatedText);
    wrapper.textContent = segment.translatedText;
    wrapper.style.backgroundColor = bgColor;
    wrapper.style.color = textColor;
    wrapper.addEventListener('click', function() { toggleSegmentTranslation(this); });

    try {
        segment.node.parentNode.replaceChild(wrapper, segment.node);
        segment.rendered = true;
    } catch (e) { /* 节点被移除或其他异常，跳过 */ }
}

/* ========== 可逆渲染 — 双语对照 ========== */

function renderSegmentBilingual(segment) {
    if (!segment.translatedText || !segment.node || !segment.node.parentNode) return;
    var settings = TRANSMIAO.settings.getSettings();
    var bgColor = (settings.style && settings.style.bgColor) || '#F2F2F2';
    var textColor = (settings.style && settings.style.textColor) || '#000000';

    if (segment.node.textContent !== segment.originalText) return;

    // 使用 inline-block 容器 + block 子 span（避免 div 闯入 inline 上下文）
    var wrapper = document.createElement('span');
    wrapper.className = 'transmiao-translated transmiao-bilingual';
    wrapper.setAttribute('data-seg-id', segment.id);
    wrapper.setAttribute('data-original', segment.originalText);
    wrapper.setAttribute('data-translated', segment.translatedText);
    wrapper.style.backgroundColor = bgColor;
    wrapper.style.color = textColor;
    wrapper.style.display = 'inline-block';
    wrapper.addEventListener('click', function() { toggleSegmentTranslation(this); });

    var tlSpan = document.createElement('span');
    tlSpan.className = 'transmiao-tl-text';
    tlSpan.style.display = 'block';
    tlSpan.textContent = segment.translatedText;

    var origSpan = document.createElement('span');
    origSpan.className = 'transmiao-original-text';
    origSpan.style.display = 'block';
    origSpan.style.fontSize = '0.85em';
    origSpan.style.color = '#888';
    origSpan.style.marginTop = '2px';
    origSpan.style.borderTop = '1px dashed #ddd';
    origSpan.style.paddingTop = '2px';
    origSpan.textContent = segment.originalText;

    wrapper.appendChild(tlSpan);
    wrapper.appendChild(origSpan);

    try {
        segment.node.parentNode.replaceChild(wrapper, segment.node);
        segment.rendered = true;
    } catch (e) { /* 节点被移除，跳过 */ }
}

/* ========== 切换原文/译文 ========== */

function toggleSegmentTranslation(wrapper) {
    if (!wrapper || !wrapper.getAttribute) return;
    var original = wrapper.getAttribute('data-original');
    var translated = wrapper.getAttribute('data-translated');
    if (!translated || !original) return;

    if (wrapper.classList.contains('transmiao-bilingual')) {
        // 双语模式：切换原文行显隐
        var origSpan = wrapper.querySelector('.transmiao-original-text');
        if (origSpan) {
            origSpan.style.display = (origSpan.style.display === 'none') ? '' : 'none';
        }
    } else {
        // 仅译文模式：切换译文/原文
        if (wrapper.textContent === translated) {
            wrapper.textContent = original;
        } else {
            wrapper.textContent = translated;
        }
    }
}

/* ========== 还原全部译文 ========== */

function restoreAllPageTranslations() {
    var wrappers = document.querySelectorAll('.transmiao-translated');
    for (var wi = wrappers.length - 1; wi >= 0; wi--) {
        restoreSegmentTranslation(wrappers[wi]);
    }
}

function restoreSegmentTranslation(wrapper) {
    if (!wrapper || !wrapper.parentNode) return;
    var original = wrapper.getAttribute('data-original');
    if (original === null || original === undefined) return;
    // 替换回精确原文的 Text 节点
    var textNode = document.createTextNode(original);
    try {
        wrapper.parentNode.replaceChild(textNode, wrapper);
    } catch (e) { /* 忽略 */ }
}

/* ========== 进度条（支持停止按钮） ========== */

function _updatePageBar(state, count, total, cached) {
    hideTranslationBar();

    var bar = document.createElement('div');
    bar.className = 'transmiao-bar';
    bar.setAttribute('data-transmiao-ui', 'true');

    var skipped = _pageTask.skipped + _viewportTask.skipped;
    var skipSuffix = skipped > 0 ? '，跳过 ' + skipped + ' 段' : '';

    if (state === 'running') {
        var txt1 = document.createElement('span');
        txt1.className = 'transmiao-bar-text';
        txt1.textContent = '翻译中 ' + count + '/' + total + (cached ? '（缓存 ' + cached + '）' : '') + skipSuffix;

        var stopBtn = document.createElement('span');
        stopBtn.className = 'transmiao-bar-btn';
        stopBtn.textContent = '[停止翻译]';
        stopBtn.addEventListener('click', function() { _stopTranslation(); });

        bar.appendChild(txt1);
        bar.appendChild(stopBtn);
    } else if (state === 'stopped') {
        var txt2 = document.createElement('span');
        txt2.className = 'transmiao-bar-text';
        txt2.textContent = '翻译已停止，已完成 ' + count + '/' + total + ' 段' + skipSuffix;

        var restoreBtn = document.createElement('span');
        restoreBtn.className = 'transmiao-bar-btn';
        restoreBtn.textContent = '[还原全部]';
        restoreBtn.addEventListener('click', function() { restoreAllPageTranslations(); hideTranslationBar(); });

        var closeBtn = document.createElement('span');
        closeBtn.className = 'transmiao-bar-close';
        closeBtn.textContent = '[✕]';
        closeBtn.addEventListener('click', hideTranslationBar);

        bar.appendChild(txt2);
        bar.appendChild(restoreBtn);
        bar.appendChild(closeBtn);
    } else if (state === 'done') {
        var txt3 = document.createElement('span');
        txt3.className = 'transmiao-bar-text';
        txt3.textContent = '已翻译 ' + count + ' 段' + skipSuffix;

        var restoreBtn2 = document.createElement('span');
        restoreBtn2.className = 'transmiao-bar-btn';
        restoreBtn2.textContent = '[还原全部]';
        restoreBtn2.addEventListener('click', function() { restoreAllPageTranslations(); hideTranslationBar(); });

        var closeBtn2 = document.createElement('span');
        closeBtn2.className = 'transmiao-bar-close';
        closeBtn2.textContent = '[✕]';
        closeBtn2.addEventListener('click', hideTranslationBar);

        bar.appendChild(txt3);
        bar.appendChild(restoreBtn2);
        bar.appendChild(closeBtn2);

        // 5 秒自动消失
        setTimeout(function() {
            if (_transBar === bar) hideTranslationBar();
        }, 5000);
    }

    document.body.appendChild(bar);
    _transBar = bar;
}

/* ========== 主入口 ========== */

/**
 * 启动页面翻译。
 * - 若已有任务运行，先停止旧任务（不等待旧 HTTP 完成）
 * - 提取 segments → 查缓存 → 分批 → 逐批请求 + 渲染
 * - 每批完成后检查任务状态，停止/跳过晚到结果
 */
async function startPageTranslation() {
    // 1. 停止已有任务（互斥：全页与可见区域不能同时运行）
    if (_pageTask.running) stopPageTranslation();
    if (_viewportTask.running) stopViewportTranslation();

    // 2. 检查激活配置
    var config = TRANSMIAO.config.getActiveConfig();
    if (!config) {
        _showToast('请先在设置中添加并激活 API 配置', 'error');
        return;
    }

    var settings = TRANSMIAO.settings.getSettings();

    // 3. 提取并构建 segments
    var allNodes;
    try {
        allNodes = getTextNodes(document.body);
    } catch (e) {
        _showToast('提取页面文字失败', 'error');
        return;
    }

    var segments = buildPageSegments(allNodes);
    if (segments.length === 0) {
        _showToast('未找到需要翻译的文本', 'info');
        return;
    }

    // 启动新任务
    var taskId = ++_pageTask.id;
    _pageTask.running = true;
    _pageTask.stopped = false;
    _pageTask.total = segments.length;
    _pageTask.done = 0;
    _pageTask.cached = 0;
    _pageTask.skipped = 0;
    _pageTask.segmentMap = {};
    // 新任务的 AbortController
    if (_pageTask._controller) _pageTask._controller.abort();
    _pageTask._controller = new AbortController();
    var taskSignal = _pageTask._controller.signal;
    for (var sgi = 0; sgi < segments.length; sgi++) {
        _pageTask.segmentMap[segments[sgi].id] = segments[sgi];
    }

    // 4. 先查缓存：命中则立即渲染并计入缓存命中
    var uncachedSegments = [];
    for (var csi = 0; csi < segments.length; csi++) {
        // 旧任务晚到 → 静默退出，绝不碰全局状态
        if (_pageTask.id !== taskId) return;
        if (_pageTask.stopped) {
            _pageTask.running = false;
            _pageTask._controller = null;
            _updatePageBar('stopped', _pageTask.done, _pageTask.total, _pageTask.cached);
            return;
        }
        var seg = segments[csi];
        var cached = TRANSMIAO.cache.get(seg.normalized, settings.targetLang || '简体中文', config);
        if (cached !== null) {
            seg.translatedText = cached;
            if (settings.displayMode === 'bilingual') {
                renderSegmentBilingual(seg);
            } else {
                renderSegmentTranslation(seg);
            }
            _pageTask.cached++;
            _pageTask.done++;
        } else {
            uncachedSegments.push(seg);
        }
        // 每处理 20 个缓存命中刷新一次进度
        if ((_pageTask.done % 20) === 0 || _pageTask.done === segments.length) {
            _updatePageBar('running', _pageTask.done, _pageTask.total, _pageTask.cached);
        }
    }

    // 全部缓存命中
    if (uncachedSegments.length === 0) {
        if (_pageTask.id !== taskId) return;
        _pageTask.running = false;
        _pageTask._controller = null;
        _updatePageBar('done', _pageTask.total, _pageTask.total, _pageTask.cached);
        return;
    }

    _updatePageBar('running', _pageTask.done, _pageTask.total, _pageTask.cached);

    // 5. 分 batches（取 normalized 文本）
    var textArray = uncachedSegments.map(function(s) { return s.normalized; });
    var maxBatchSize = settings.batchSize || 3000;

    var batches = [];
    var currentBatch = [];
    var currentSize = 0;
    var safetyMargin = 300;
    for (var ti = 0; ti < textArray.length; ti++) {
        var tLen = textArray[ti].length + 60;
        if (currentSize + tLen + safetyMargin > maxBatchSize && currentBatch.length > 0) {
            batches.push(currentBatch);
            currentBatch = [];
            currentSize = 0;
        }
        currentBatch.push(ti);
        currentSize += tLen;
    }
    if (currentBatch.length > 0) batches.push(currentBatch);

    // 6. 逐批翻译 + 渲染
    try {
        for (var bi = 0; bi < batches.length; bi++) {
            // 检查停止：先 taskId 再全局
            if (_pageTask.id !== taskId) return;
            if (_pageTask.stopped) {
                _pageTask.running = false;
                _pageTask._controller = null;
                _updatePageBar('stopped', _pageTask.done, _pageTask.total, _pageTask.cached);
                return;
            }

            var batch = batches[bi];
            var batchTexts = batch.map(function(idx) { return textArray[idx]; });

            var translations = await translateBatch(config, batchTexts, taskSignal);

            // 再次检查（HTTP 返回时可能已被停止）
            if (_pageTask.id !== taskId) return;
            if (_pageTask.stopped) {
                _pageTask.running = false;
                _pageTask._controller = null;
                _updatePageBar('stopped', _pageTask.done, _pageTask.total, _pageTask.cached);
                return;
            }

            // 映射结果并渲染
            for (var ri = 0; ri < batch.length; ri++) {
                var segIdx = batch[ri];
                var seg = uncachedSegments[segIdx];
                if (!seg) continue;
                // 安全检查：原文未被外部改动
                if (seg.node && seg.node.textContent === seg.originalText) {
                    seg.translatedText = (ri < translations.length && translations[ri]) ? translations[ri] : seg.normalized;
                    if (settings.displayMode === 'bilingual') {
                        renderSegmentBilingual(seg);
                    } else {
                        renderSegmentTranslation(seg);
                    }
                }
                _pageTask.done++;
            }

            _updatePageBar('running', _pageTask.done, _pageTask.total, _pageTask.cached);

            // 小批量调度避免长页面阻塞
            if (batches.length > 1) {
                await new Promise(function(r) { requestAnimationFrame(r); });
            }
        }

        if (_pageTask.id !== taskId) return;
        _pageTask.running = false;
        _pageTask._controller = null;

        if (_pageTask.stopped) {
            _updatePageBar('stopped', _pageTask.done, _pageTask.total, _pageTask.cached);
        } else {
            _updatePageBar('done', _pageTask.total, _pageTask.total, _pageTask.cached);
        }

    } catch (err) {
        if (_pageTask.id !== taskId) return;
        _pageTask.running = false;
        _pageTask._controller = null;
        if (!err.aborted && !_pageTask.stopped) {
            _showToast('翻译失败: ' + (err.message || '未知错误'), 'error');
        }
    }
}

// 导出
TRANSMIAO.startPageTranslation = startPageTranslation;
TRANSMIAO.stopPageTranslation = stopPageTranslation;
TRANSMIAO.restoreAllPageTranslations = restoreAllPageTranslations;

/* ========== 可见区域翻译（IntersectionObserver） ========== */

/**
 * 提取页面上符合语义的可翻译容器。
 */
function getViewportContainers(root) {
    var containers = [];
    if (!root || !root.querySelectorAll) return containers;
    // 语义块级元素
    var selectors = 'p, h1, h2, h3, h4, h5, h6, li, td, th, blockquote, figcaption, dt, dd';
    var all;
    try { all = root.querySelectorAll(selectors); } catch (e) { return containers; }
    for (var ci = 0; ci < all.length; ci++) {
        var el = all[ci];
        if (!el.textContent.trim()) continue;
        if (insideTransMiaoUI(el)) continue;
        // 排除不可见
        if (el.offsetWidth === 0 && el.offsetHeight === 0) continue;
        containers.push(el);
    }
    return containers;
}

/** 可见区域翻译任务状态（单位：独立 Text segment） */
var _viewportTask = {
    id: 0,
    running: false,
    stopped: false,
    total: 0,               // 已发现的 segment 数
    done: 0,                // 已处理（缓存+翻译）的 segment 数
    cached: 0,              // 缓存命中的 segment 数
    skipped: 0,             // 跳过段数（已是目标语言）
    _observer: null,        // IntersectionObserver
    _mutationObs: null,     // MutationObserver
    _controller: null,      // AbortController
    _pendingSegments: [],   // 未命中缓存、等待 API 的 segments
    _processing: false,     // 批量调度中
    _seenNodes: null,       // WeakSet：任务级 Text node 去重（防嵌套容器重复）
    _knownContainers: null, // Set：已观察的容器（防 MutationObserver 重复观察）
    _segCounter: 0          // segment id 计数器
};

/* ========== segment 收集：容器 → 独立 Text node segments ========== */

/**
 * 从容器中收集可翻译 Text node，生成与全页翻译完全兼容的 segment。
 * 使用任务级 WeakSet 去重：同一 Text node 只处理一次（li/p/td 嵌套不重复）。
 * 不清空容器、不修改 DOM。
 */
function _viewportCollectSegments(el) {
    var out = [];
    if (!el || !el.isConnected) return out;
    var settings = TRANSMIAO.settings.getSettings();
    var skipEnabled = settings.skipAlreadyTargetLanguage !== false;
    var targetLang = settings.targetLang || '';
    var EXCLUDED_TAGS = { 'script': true, 'style': true, 'code': true, 'pre': true, 'textarea': true, 'input': true, 'select': true, 'option': true, 'noscript': true, 'svg': true, 'math': true };
    var walker;
    try {
        walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
            acceptNode: function(n) {
                if (!n.textContent || !n.textContent.trim()) return NodeFilter.FILTER_REJECT;
                var p2 = n.parentElement;
                while (p2 && p2 !== el) {
                    var tag2 = p2.tagName ? p2.tagName.toLowerCase() : '';
                    if (EXCLUDED_TAGS[tag2]) return NodeFilter.FILTER_REJECT;
                    p2 = p2.parentElement;
                }
                if (insideTransMiaoUI(n)) return NodeFilter.FILTER_REJECT;
                return NodeFilter.FILTER_ACCEPT;
            }
        }, false);
    } catch (e) { return out; }
    var node;
    while (node = walker.nextNode()) {
        if (_viewportTask._seenNodes.has(node)) continue;
        var text = node.textContent;
        var trimmed = text.trim();
        if (trimmed.length < 2) continue;
        if (/^[\d\s.,!?;:…\-—()\[\]{}'""・、。！？；：（）【】「」『』]+$/.test(trimmed)) continue;
        // 跳过已是目标语言的高置信文本
        if (skipEnabled && shouldSkipTranslation(trimmed, targetLang, true)) {
            _viewportTask._seenNodes.add(node);
            _viewportTask.skipped++;
            continue;
        }
        _viewportTask._seenNodes.add(node);
        out.push({
            id: 'vseg_' + (_viewportTask._segCounter++),
            node: node,
            originalText: text,
            normalized: trimmed,
            translatedText: null,
            rendered: false
        });
    }
    return out;
}

/* ========== 单个 segment 的安全渲染（仅当仍在 DOM 且原文未变） ========== */

function _viewportRender(seg, displayMode) {
    if (!seg || seg.rendered) return;
    if (!seg.node || !seg.node.parentNode) { seg.rendered = true; return; }
    if (seg.node.textContent !== seg.originalText) { seg.rendered = true; return; }
    if (!seg.translatedText) return;
    if (displayMode === 'bilingual') renderSegmentBilingual(seg);
    else renderSegmentTranslation(seg);
}

/* ========== 容器进入视口后的处理：查缓存 / 入队 ========== */

function _viewportHandleContainer(el, config, settings) {
    if (_viewportTask.stopped || !el || !el.isConnected) return;
    var segments = _viewportCollectSegments(el);
    if (segments.length === 0) return;
    var displayMode = settings.displayMode === 'bilingual' ? 'bilingual' : 'translationOnly';
    var targetLang = settings.targetLang || '简体中文';
    var hasPending = false;
    for (var i = 0; i < segments.length; i++) {
        var seg = segments[i];
        _viewportTask.total++;
        var cached = TRANSMIAO.cache.get(seg.normalized, targetLang, config);
        if (cached !== null) {
            // 缓存命中：立即渲染，不请求 API
            seg.translatedText = cached;
            _viewportRender(seg, displayMode);
            _viewportTask.cached++;
            _viewportTask.done++;
        } else {
            _viewportTask._pendingSegments.push(seg);
            hasPending = true;
        }
    }
    // 总是刷新进度条
    _updatePageBar('running', _viewportTask.done, _viewportTask.total, _viewportTask.cached);
    if (hasPending) {
        _viewportKickBatch(config, settings);
    } else {
        // 全部缓存命中或纯标点容器：补一次 idle 检查
        _viewportTryShowIdle();
    }
}

/* ========== 全部缓存命中时的 idle 兜底 ========== */

function _viewportTryShowIdle() {
    if (_viewportTask._pendingSegments.length > 0 || _viewportTask._processing) return;
    if (_viewportTask.stopped) return;
    _viewportShowIdle();
}

async function startViewportTranslation() {
    // 互斥：先停止另一模式与本模式的旧任务
    if (_viewportTask.running) stopViewportTranslation();
    if (_pageTask.running) stopPageTranslation();

    var config = TRANSMIAO.config.getActiveConfig();
    if (!config) {
        _showToast('请先在设置中添加并激活 API 配置', 'error');
        return;
    }

    var settings = TRANSMIAO.settings.getSettings();

    // 提取语义容器（仅作为 IntersectionObserver 触发单位）
    var containers = getViewportContainers(document.body);
    if (containers.length === 0) {
        _showToast('未找到需要翻译的文本', 'info');
        return;
    }

    // 初始化任务（segment 为单位计数）
    var taskId = ++_viewportTask.id;
    _viewportTask.running = true;
    _viewportTask.stopped = false;
    _viewportTask.total = 0;
    _viewportTask.done = 0;
    _viewportTask.cached = 0;
    _viewportTask.skipped = 0;
    _viewportTask._pendingSegments = [];
    _viewportTask._processing = false;
    _viewportTask._seenNodes = new WeakSet();
    _viewportTask._knownContainers = new Set();
    _viewportTask._segCounter = 0;

    if (_viewportTask._controller) _viewportTask._controller.abort();
    _viewportTask._controller = new AbortController();
    var taskSignal = _viewportTask._controller.signal;

    _updatePageBar('running', 0, 0, 0);

    // 观察所有初始容器（IntersectionObserver 会对当前已可见者立即触发回调，
    // 回调内才查缓存/渲染，因此缓存命中也不会提前显示）
    _setupViewportObservers(containers, config, settings, taskId, taskSignal);
}

/* ========== 观察器设置（IntersectionObserver 触发 + MutationObserver SPA） ========== */

function _setupViewportObservers(containers, config, settings, taskId, taskSignal) {
    if (_viewportTask._observer) { try { _viewportTask._observer.disconnect(); } catch(e){} }

    // IntersectionObserver：容器进入视口（提前 100px）→ unobserve → 处理其 segments
    _viewportTask._observer = new IntersectionObserver(function(entries) {
        if (_viewportTask.id !== taskId || _viewportTask.stopped) return;
        for (var ei = 0; ei < entries.length; ei++) {
            if (entries[ei].isIntersecting) {
                var el = entries[ei].target;
                try { _viewportTask._observer.unobserve(el); } catch(e) {}
                _viewportHandleContainer(el, config, settings);
            }
        }
    }, { rootMargin: '100px', threshold: 0 });

    for (var oi = 0; oi < containers.length; oi++) {
        _viewportTask._knownContainers.add(containers[oi]);
        try { _viewportTask._observer.observe(containers[oi]); } catch(e) {}
    }

    // MutationObserver：SPA 新增容器 → 加入观察（去重由 _knownContainers 保证）
    if (_viewportTask._mutationObs) { try { _viewportTask._mutationObs.disconnect(); } catch(e){} }
    var mutTimer = null;
    _viewportTask._mutationObs = new MutationObserver(function() {
        if (_viewportTask.id !== taskId || _viewportTask.stopped) return;
        if (mutTimer) return;
        mutTimer = setTimeout(function() {
            mutTimer = null;
            if (_viewportTask.id !== taskId || _viewportTask.stopped) return;
            var newContainers = getViewportContainers(document.body);
            for (var ni = 0; ni < newContainers.length; ni++) {
                var nc = newContainers[ni];
                if (_viewportTask._knownContainers.has(nc)) continue;
                _viewportTask._knownContainers.add(nc);
                try { _viewportTask._observer.observe(nc); } catch(e) {}
            }
        }, 300);
    });
    try { _viewportTask._mutationObs.observe(document.body, { childList: true, subtree: true }); } catch(e) {}
}

/* ========== 批量调度（200ms 防抖 + 串行处理） ========== */

var _viewportKickTimer = null;
function _viewportKickBatch(config, settings) {
    if (_viewportKickTimer || _viewportTask._processing) return;
    _viewportKickTimer = setTimeout(function() {
        _viewportKickTimer = null;
        _scheduleViewportBatch(config, settings, _viewportTask.id, _viewportTask._controller ? _viewportTask._controller.signal : null);
    }, 200);
}

async function _scheduleViewportBatch(config, settings, taskId, taskSignal) {
    if (_viewportTask._processing) return;
    _viewportTask._processing = true;
    var displayMode = settings.displayMode === 'bilingual' ? 'bilingual' : 'translationOnly';
    var maxBatchSize = settings.batchSize || 3000;

    try {
        while (_viewportTask.id === taskId && !_viewportTask.stopped) {
            // 组一批：数量 ≤ 20 且 字符 ≤ batchSize（避免 JSON 过大）
            var batchSegs = [];
            var texts = [];
            var chars = 0;
            while (_viewportTask._pendingSegments.length > 0 && batchSegs.length < 20) {
                var seg = _viewportTask._pendingSegments[0];
                if (chars + seg.normalized.length > maxBatchSize && batchSegs.length > 0) break;
                _viewportTask._pendingSegments.shift();
                batchSegs.push(seg);
                texts.push(seg.normalized);
                chars += seg.normalized.length;
            }
            if (batchSegs.length === 0) break;

            _updatePageBar('running', _viewportTask.done, _viewportTask.total, _viewportTask.cached);

            var translations;
            try {
                translations = await translateBatch(config, texts, taskSignal);
            } catch (err) {
                if (err.aborted || _viewportTask.id !== taskId || _viewportTask.stopped) break;
                translations = [];
            }

            // 请求返回后先检查任务状态，再渲染
            if (_viewportTask.id !== taskId || _viewportTask.stopped) break;

            for (var i = 0; i < batchSegs.length; i++) {
                var seg = batchSegs[i];
                var t = (i < translations.length && translations[i]) ? translations[i] : null;
                if (t) {
                    seg.translatedText = t;
                    _viewportRender(seg, displayMode);
                }
                _viewportTask.done++;
            }
            _updatePageBar('running', _viewportTask.done, _viewportTask.total, _viewportTask.cached);
        }
    } finally {
        _viewportTask._processing = false;
    }

    // 队列清空 → 显示“继续滚动”提示（观察器保持存活）
    if (_viewportTask.id === taskId && !_viewportTask.stopped) {
        _viewportShowIdle();
    }
}

/* ========== 完成提示（保持观察器存活） ========== */

function _viewportShowIdle() {
    hideTranslationBar();
    var bar = document.createElement('div');
    bar.className = 'transmiao-bar';
    bar.setAttribute('data-transmiao-ui', 'true');
    var txt = document.createElement('span');
    txt.className = 'transmiao-bar-text';
    var skipSuffix = _viewportTask.skipped > 0 ? '，跳过 ' + _viewportTask.skipped + ' 段' : '';
    txt.textContent = '当前可见内容已翻译（' + _viewportTask.done + ' 段，缓存 ' + _viewportTask.cached + '）' + skipSuffix + '，继续滚动将自动翻译新内容';
    var stopBtn = document.createElement('span');
    stopBtn.className = 'transmiao-bar-btn';
    stopBtn.textContent = '[停止翻译]';
    stopBtn.addEventListener('click', function() { stopViewportTranslation(); });
    bar.appendChild(txt);
    bar.appendChild(stopBtn);
    document.body.appendChild(bar);
    _transBar = bar;
}

/* ========== 停止（真正 abort 当前请求并断开观察器） ========== */

function stopViewportTranslation() {
    if (!_viewportTask.running && !_viewportTask.stopped) return;
    _viewportTask.stopped = true;
    _viewportTask.running = false;
    if (_viewportKickTimer) { clearTimeout(_viewportKickTimer); _viewportKickTimer = null; }
    if (_viewportTask._controller) {
        _viewportTask._controller.abort();
        _viewportTask._controller = null;
    }
    if (_viewportTask._observer) { try { _viewportTask._observer.disconnect(); } catch(e){} _viewportTask._observer = null; }
    if (_viewportTask._mutationObs) { try { _viewportTask._mutationObs.disconnect(); } catch(e){} _viewportTask._mutationObs = null; }
    _viewportTask._pendingSegments = [];
    _updatePageBar('stopped', _viewportTask.done, _viewportTask.total, _viewportTask.cached);
}

/** 根据 translateMode 分发翻译/停止 */
function _startTranslation() {
    var mode = TRANSMIAO.settings.getSettings().translateMode;
    if (mode === 'viewport') startViewportTranslation();
    else startPageTranslation();
}

function _stopTranslation() {
    stopPageTranslation();
    stopViewportTranslation();
}

TRANSMIAO.startViewportTranslation = startViewportTranslation;
TRANSMIAO.stopViewportTranslation = stopViewportTranslation;

// ====== 划词翻译模块（快照 + pointerdown 触发） ======

/* ========== 状态变量 ========== */

var _wordTag = null;            // [译] 标签 DOM 元素
var _wordBubble = null;         // 译文浮层 DOM 元素
var _wordSnapshot = null;       // { text, x, y } 选区快照
var _wordTimer = null;          // 防抖定时器
var _wordInteractionUntil = 0;  // 交互锁时间戳
var _wordInputType = '';        // 'mouse' | 'touch'（[译] 点击后 500ms 内不响应 selectionchange）

/* ========== 判断节点是否在 transMiao 脚本 UI 内 ========== */

function isInsideScriptUI(node) {
    var el = node && node.nodeType === 1 ? node : (node ? node.parentElement : null);
    while (el) {
        // 所有脚本 UI 元素标 data-transmiao-ui="true"
        if (el.getAttribute && el.getAttribute('data-transmiao-ui') === 'true') return true;
        var tag = el.tagName ? el.tagName.toLowerCase() : '';
        if (tag === 'body' || tag === 'html') break;
        el = el.parentElement;
    }
    return false;
}

/* ========== 标签创建与显示 ========== */

function getWordTag() {
    if (!_wordTag) {
        _wordTag = document.createElement('div');
        _wordTag.className = 'transmiao-word-tag';
        _wordTag.textContent = '译';
        _wordTag.setAttribute('data-transmiao-ui', 'true');
        // pointerdown 触发，避免浏览器在点击时清空选区
        _wordTag.addEventListener('pointerdown', function(e) {
            e.stopPropagation();
            e.preventDefault();
            // 锁住后续 500ms 内的 selectionchange（防迟到事件关闭 bubble）
            _wordInteractionUntil = Date.now() + 500;
            if (_wordSnapshot) translateWord(_wordSnapshot.text);
        });
        document.body.appendChild(_wordTag);
    }
    return _wordTag;
}

function showWordTag(rect, text) {
    var tag = getWordTag();
    // 保存快照（与实时 Selection 解耦）
    _wordSnapshot = { text: text, x: rect.right, y: rect.bottom };

    // 移动端/触摸：避开 Android 原生选区手柄
    if (isMobileViewport() || _wordInputType === 'touch') {
        _positionWordTagTouch(tag, rect);
    } else {
        _positionWordTagDesktop(tag, rect);
    }
    tag.classList.add('transmiao-word-tag-visible');
    // 打开后 clamp 确保不跑出屏幕
    var tagRect = tag.getBoundingClientRect();
    var box = getSafeViewportBox();
    if (tagRect.right > box.right) {
        tag.style.left = (box.right - tagRect.width - 4) + 'px';
    }
    if (tagRect.bottom > box.bottom) {
        tag.style.top = Math.max(box.top, tagRect.top - tagRect.height - 4) + 'px';
    }
    if (tagRect.left < box.left) {
        tag.style.left = (box.left + 4) + 'px';
    }
    if (tagRect.top < box.top) {
        tag.style.top = (box.top + 4) + 'px';
    }
}

function _positionWordTagDesktop(tag, rect) {
    tag.style.left = Math.max(0, rect.right + 4) + 'px';
    tag.style.top = Math.max(0, rect.bottom + 2) + 'px';
}

function _positionWordTagTouch(tag, rect) {
    var box = getSafeViewportBox();
    var tw = 36; // 标签估算宽度
    var th = 22; // 标签估算高度
    var handleGap = 28; // 与选区手柄的避让间距

    // 优先放在选区上方居中偏右
    var top = rect.top - th - handleGap;
    var left = rect.left + (rect.width - tw) / 2;

    if (top < box.top + 4) {
        // 上方没空间 → 放选区下方（留出手柄间距）
        top = rect.bottom + handleGap;
    }
    if (left < box.left) left = box.left + 4;
    if (left + tw > box.right) left = box.right - tw - 4;
    if (top < box.top) top = box.top + 4;
    if (top + th > box.bottom) top = box.bottom - th - 4;

    tag.style.left = left + 'px';
    tag.style.top = top + 'px';
}

function hideWordTag() {
    _wordSnapshot = null;
    if (_wordTag) _wordTag.classList.remove('transmiao-word-tag-visible');
}

/* ========== 浮层 ========== */

function getWordBubble() {
    if (!_wordBubble) {
        _wordBubble = document.createElement('div');
        _wordBubble.className = 'transmiao-word-bubble';
        _wordBubble.setAttribute('data-transmiao-ui', 'true');
        document.body.appendChild(_wordBubble);

        // 一次性注册全局关闭监听（不重复添加/移除）
        document.addEventListener('pointerdown', function(e) {
            if (_wordBubble && _wordBubble.classList.contains('transmiao-word-bubble-visible')
                && !_wordBubble.contains(e.target)
                && (!_wordTag || !_wordTag.contains(e.target))) {
                closeWordBubble();
            }
        });
        document.addEventListener('keydown', function(e) {
            if (e.key === 'Escape' && _wordBubble && _wordBubble.classList.contains('transmiao-word-bubble-visible')) {
                closeWordBubble();
            }
        });
    }
    return _wordBubble;
}

function showWordBubble(content) {
    var bubble = getWordBubble();
    bubble.textContent = content;
    bubble.classList.add('transmiao-word-bubble-visible');

    var box = getSafeViewportBox();
    var maxW = Math.min(320, box.width - 8);
    var maxH = Math.min(200, box.height - 8);
    bubble.style.maxWidth = maxW + 'px';
    bubble.style.maxHeight = maxH + 'px';

    if (_wordTag && _wordTag.classList.contains('transmiao-word-tag-visible')) {
        var tagRect = _wordTag.getBoundingClientRect();
        var left = tagRect.left;
        var top = tagRect.bottom + 4;
        if (left + 320 > box.right) {
            left = Math.max(box.left + 4, box.right - 324);
        }
        if (top + 200 > box.bottom) {
            top = tagRect.top - Math.min(bubble.scrollHeight || 60, 200) - 4;
        }
        bubble.style.left = Math.max(box.left, left) + 'px';
        bubble.style.top = Math.max(box.top, top) + 'px';
    }
}

function closeWordBubble() {
    if (_wordBubble) _wordBubble.classList.remove('transmiao-word-bubble-visible');
    hideWordTag();
}

/* ========== 选中处理（快照模式） ========== */

function handleSelection() {
    try {
        // 交互锁期内不响应（防止 [译] click 后的迟到事件关闭 bubble）
        if (Date.now() < _wordInteractionUntil) return;

        // 如果浮层开着，关闭（用户重新选择其他文字）
        if (_wordBubble && _wordBubble.classList.contains('transmiao-word-bubble-visible')) {
            closeWordBubble();
        }

        var sel = window.getSelection();
        if (!sel || sel.isCollapsed || !sel.toString().trim()) {
            hideWordTag();
            return;
        }

        var text = sel.toString().trim();
        if (text.length < 2) {
            hideWordTag();
            return;
        }

        // 排除脚本 UI 内部（含 data-transmiao-ui 属性）
        if (sel.anchorNode && isInsideScriptUI(sel.anchorNode)) {
            hideWordTag();
            return;
        }
        // 也检查 focusNode
        if (sel.focusNode && isInsideScriptUI(sel.focusNode)) {
            hideWordTag();
            return;
        }

        // 获取选区末尾坐标：优先 getClientRects（支持多行），
        // 从末尾找最后一个非零 rect，fallback 到 getBoundingClientRect
        try {
            var rangeCount = sel.rangeCount;
            var range = sel.getRangeAt(rangeCount - 1);
            var rects = range.getClientRects();
            var rect = null;
            if (rects && rects.length > 0) {
                for (var ri = rects.length - 1; ri >= 0; ri--) {
                    if (rects[ri].width > 0 && rects[ri].height > 0) {
                        rect = rects[ri];
                        break;
                    }
                }
            }
            if (!rect) rect = range.getBoundingClientRect();
            if (!rect || (rect.width === 0 && rect.height === 0)) {
                hideWordTag();
                return;
            }
            showWordTag(rect, text);
        } catch (e) {
            hideWordTag();
        }
    } catch (e) {
        console.error('[transMiao] 划词处理失败:', e);
    }
}

/* ========== 选中事件监听 ========== */

var _onWordEvent = function() {
    clearTimeout(_wordTimer);
    var delay = 120;
    if (_wordInputType === 'touch') delay = 220;
    _wordTimer = setTimeout(handleSelection, delay);
};

document.addEventListener('mouseup', function() {
    _wordInputType = 'mouse';
    _onWordEvent();
});
document.addEventListener('touchend', function() {
    _wordInputType = 'touch';
    _onWordEvent();
});
document.addEventListener('selectionchange', function() {
    _onWordEvent();
});

/* ========== 翻译执行（使用快照文本） ========== */

async function translateWord(text) {
    if (!text || !text.trim()) return;

    var config = TRANSMIAO.config.getActiveConfig();
    if (!config) {
        _showToast('请先在设置中添加并激活 API 配置', 'error');
        return;
    }

    showWordBubble('翻译中...');

    try {
        var targetLang = TRANSMIAO.settings.getSettings().targetLang || '简体中文';
        var result = await translateSingle(config, text, targetLang);
        showWordBubble(result || '（译文为空）');
    } catch (err) {
        showWordBubble('翻译失败: ' + (err.message || '未知错误'));
    }
}

// ====== 统一启动器模块 ======

// ====== 统一启动器模块 ======

/* ========== 状态 ========== */

var _launcherBtn = null;
var _launcherDragData = null;
var _launcherMenu = null;
var _launcherMenuVisible = false;

/* ========== 创建 ========== */

function createLauncher() {
    if (_launcherBtn) return;

    var btn = document.createElement('div');
    btn.className = 'transmiao-launcher';
    btn.textContent = '译';
    btn.setAttribute('data-transmiao-ui', 'true');
    btn.addEventListener('pointerdown', onLauncherPointerDown);
    document.body.appendChild(btn);
    _launcherBtn = btn;

    // 创建菜单
    _launcherMenu = document.createElement('div');
    _launcherMenu.className = 'transmiao-launcher-menu';
    _launcherMenu.setAttribute('data-transmiao-ui', 'true');
    document.body.appendChild(_launcherMenu);

    // 从存储恢复位置
    var pos = _get('launcher_pos', null);
    if (pos && typeof pos.left === 'number' && typeof pos.top === 'number') {
        btn.style.left = pos.left + 'px';
        btn.style.top = pos.top + 'px';
    } else {
        btn.style.left = (window.innerWidth - 54) + 'px';
        btn.style.top = (window.innerHeight - 54) + 'px';
    }

    applyLauncherVisibility();

    // resize 时重新吸附
    window.addEventListener('resize', function() {
        if (_launcherBtn && _launcherBtn.style.display !== 'none') {
            snapLauncher();
        }
    });

    // 点击菜单外部关闭
    document.addEventListener('pointerdown', function(e) {
        if (_launcherMenuVisible && _launcherBtn && !_launcherBtn.contains(e.target)
            && _launcherMenu && !_launcherMenu.contains(e.target)) {
            hideLauncherMenu();
        }
    });
}

function _saveLauncherPos() {
    if (!_launcherBtn) return;
    var rect = _launcherBtn.getBoundingClientRect();
    _set('launcher_pos', { left: Math.round(rect.left), top: Math.round(rect.top) });
}

function applyLauncherVisibility() {
    if (!_launcherBtn) return;
    var settings = TRANSMIAO.settings.getSettings();
    var show = settings && settings.showFloatBtn !== false;
    _launcherBtn.style.display = show ? '' : 'none';
    if (!show) hideLauncherMenu();
}

/* ========== 菜单 ========== */

function buildLauncherMenu() {
    if (!_launcherMenu || !_launcherBtn) return;
    while (_launcherMenu.firstChild) {
        _launcherMenu.removeChild(_launcherMenu.firstChild);
    }

    var settings = TRANSMIAO.settings.getSettings();

    // 检查翻译状态
    var hasTranslations = document.querySelectorAll('.transmiao-translated').length > 0;
    var isRunning = isPageTaskActive();

    // 定位菜单：在按钮上方或下方，不超出屏幕
    var btnRect = _launcherBtn.getBoundingClientRect();
    var menuAbove = btnRect.top > 160;
    if (menuAbove) {
        _launcherMenu.style.bottom = (window.innerHeight - btnRect.top + 4) + 'px';
        _launcherMenu.style.top = 'auto';
    } else {
        _launcherMenu.style.top = (btnRect.bottom + 4) + 'px';
        _launcherMenu.style.bottom = 'auto';
    }
    var menuLeft = Math.min(btnRect.left, window.innerWidth - 150);
    _launcherMenu.style.left = Math.max(4, menuLeft) + 'px';

    // 菜单项
    if (isRunning) {
        addMenuItem('⏳ 翻译中 ' + (_pageTask.running ? _pageTask.done + '/' + _pageTask.total : _viewportTask.done + '/' + _viewportTask.total), null, 'disabled');
        addMenuItem('⏹ 停止翻译', function() { _stopTranslation(); hideLauncherMenu(); });
    } else {
        addMenuItem('▶ 开始翻译', function() { _startTranslation(); hideLauncherMenu(); });
    }
    addMenuItem('⚙ 设置', function() { hideLauncherMenu(); openPanel(); });
    if (hasTranslations && !isRunning) {
        addMenuItem('↩ 还原全部', function() { restoreAllPageTranslations(); hideLauncherMenu(); });
    }

    _launcherMenu.classList.add('transmiao-launcher-menu-visible');
    _launcherMenuVisible = true;
}

function addMenuItem(label, onClick, className) {
    var item = document.createElement('div');
    item.className = 'transmiao-launcher-menu-item' + (className ? ' ' + className : '');
    item.textContent = label;
    if (onClick) {
        item.addEventListener('pointerdown', function(e) { e.stopPropagation(); e.preventDefault(); onClick(); });
    }
    _launcherMenu.appendChild(item);
}

function hideLauncherMenu() {
    if (_launcherMenu) _launcherMenu.classList.remove('transmiao-launcher-menu-visible');
    _launcherMenuVisible = false;
}

function toggleLauncherMenu() {
    if (_launcherMenuVisible) {
        hideLauncherMenu();
    } else {
        buildLauncherMenu();
    }
}

/* ========== 拖动（Pointer Events） ========== */

function onLauncherPointerDown(e) {
    e.preventDefault();
    // 安全保护：Via/WebView 可能不支持 Pointer Events
    if (_launcherBtn.setPointerCapture && e.pointerId != null) {
        try { _launcherBtn.setPointerCapture(e.pointerId); } catch (ignore) {}
    }

    var rect = _launcherBtn.getBoundingClientRect();

    _launcherDragData = {
        startX: e.clientX,
        startY: e.clientY,
        startLeft: rect.left,
        startTop: rect.top,
        moved: false,
        movedDistance: 0
    };

    _launcherBtn.classList.add('transmiao-launcher-dragging');
    _launcherBtn.addEventListener('pointermove', onLauncherPointerMove);
    _launcherBtn.addEventListener('pointerup', onLauncherPointerUp);
    _launcherBtn.addEventListener('pointercancel', onLauncherPointerCancel);
}

function onLauncherPointerMove(e) {
    if (!_launcherDragData) return;
    e.preventDefault();

    var dx = e.clientX - _launcherDragData.startX;
    var dy = e.clientY - _launcherDragData.startY;
    var dist = Math.sqrt(dx * dx + dy * dy);

    _launcherDragData.movedDistance = dist;
    if (dist > 6) _launcherDragData.moved = true;

    _launcherBtn.style.transition = 'none';

    var newLeft = _launcherDragData.startLeft + dx;
    var newTop = _launcherDragData.startTop + dy;

    var w = _launcherBtn.offsetWidth;
    var h = _launcherBtn.offsetHeight;
    newLeft = Math.max(0, Math.min(window.innerWidth - w, newLeft));
    newTop = Math.max(0, Math.min(window.innerHeight - h, newTop));

    _launcherBtn.style.left = newLeft + 'px';
    _launcherBtn.style.top = newTop + 'px';

    // 拖动时关闭菜单
    if (_launcherMenuVisible && dist > 10) hideLauncherMenu();
}

function onLauncherPointerUp(e) {
    cleanupLauncherDrag();

    if (!_launcherDragData) return;

    if (!_launcherDragData.moved) {
        // 单击 → 切换菜单
        toggleLauncherMenu();
    } else {
        // 拖动 → 吸附边缘 + 保存位置
        snapLauncher();
        _saveLauncherPos();
    }

    _launcherDragData = null;
}

function onLauncherPointerCancel(e) {
    cleanupLauncherDrag();
    _launcherDragData = null;
}

function cleanupLauncherDrag() {
    if (!_launcherBtn) return;
    _launcherBtn.removeEventListener('pointermove', onLauncherPointerMove);
    _launcherBtn.removeEventListener('pointerup', onLauncherPointerUp);
    _launcherBtn.removeEventListener('pointercancel', onLauncherPointerCancel);
    _launcherBtn.classList.remove('transmiao-launcher-dragging');
    // pointer capture 在 pointerup/pointercancel 时浏览器自动释放，此处仅清理监听
}

/* ========== 吸附边缘 ========== */

function snapLauncher() {
    if (!_launcherBtn) return;

    var rect = _launcherBtn.getBoundingClientRect();
    var w = rect.width;
    var vw = window.innerWidth;
    var margin = 4;

    var distLeft = rect.left;
    var distRight = vw - (rect.left + w);
    var snapLeft = distLeft <= distRight;
    var snapTop = rect.top;

    _launcherBtn.style.transition = 'left 0.25s ease-out';

    if (snapLeft) {
        _launcherBtn.style.left = margin + 'px';
    } else {
        _launcherBtn.style.left = (vw - w - margin) + 'px';
    }
    _launcherBtn.style.top = snapTop + 'px';

    setTimeout(function() {
        if (_launcherBtn) _launcherBtn.style.transition = '';
    }, 260);
}

// ====== 基础样式 ======

var BASE_CSS = '\
.transmiao *,\
.transmiao *::before,\
.transmiao *::after {\
    box-sizing: border-box;\
}\
.transmiao,\
.transmiao-panel,\
.transmiao-launcher,\
.transmiao-bubble,\
.transmiao-toast {\
    z-index: 2147483647;\
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,\
        "Helvetica Neue", Arial, "Noto Sans", sans-serif;\
    line-height: 1.5;\
    font-size: 14px;\
    color: #333333;\
}';

// ====== 初始化入口 ======

function init() {
    // 1. Grant 自检（开发辅助）
    checkGrants();

    // 2. 注入基础样式与面板样式
    injectCSS(BASE_CSS);
    injectCSS(SETTINGS_PANEL_CSS);
    injectCSS(TRANSLATE_CSS);

    // 3. 创建设置面板
    createSettingsPanel();

    // 4. 创建统一启动器
    createLauncher();

    // 5. 检查激活配置
    var activeConfig = TRANSMIAO.config.getActiveConfig();
    if (activeConfig) {
        console.log('[transMiao] 初始化完成');
        console.log('[transMiao] 已激活配置:', activeConfig.name);
    } else {
        console.log('[transMiao] 初始化完成');
        console.warn('[transMiao] 未检测到激活的 API 配置，请在设置中添加 API 配置');
    }

    // 5. 绑定快捷键（动态读取设置）
    document.addEventListener('keydown', function(e) {
        var s = TRANSMIAO.settings.getSettings();
        var shortcut = (s && s.shortcut) || 'Alt+C';
        var parts = shortcut.split('+');
        var mods = { Ctrl: false, Alt: false, Shift: false, Meta: false };
        var keyName = '';
        for (var pi = 0; pi < parts.length; pi++) {
            var p = parts[pi].trim();
            if (p === 'Ctrl') mods.Ctrl = true;
            else if (p === 'Alt') mods.Alt = true;
            else if (p === 'Shift') mods.Shift = true;
            else if (p === 'Meta') mods.Meta = true;
            else keyName = p;
        }
        if (e.ctrlKey === mods.Ctrl &&
            e.altKey === mods.Alt &&
            e.shiftKey === mods.Shift &&
            e.metaKey === mods.Meta &&
            keyName &&
            e.key.toUpperCase() === keyName.toUpperCase()) {
            e.preventDefault();
            _startTranslation();
        }
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
