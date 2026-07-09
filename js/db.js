const DB_NAME = 'TarteelDB';
const DB_VERSION = 1;
const STORE_NAME = 'api_cache';
const DEFAULT_TTL = 7 * 24 * 60 * 60 * 1000; // 7 أيام بالمللي ثانية كعمر افتراضي للكاش

// ==========================================
// 🧠 Abstraction: Cache Providers
// ==========================================

// مزود الكاش بالذاكرة (Memory Fallback)
class MemoryCacheProvider {
    constructor(maxSize = 50) {
        this.cache = new Map();
        this.maxSize = maxSize;
    }

    async get(key) {
        const cached = this.cache.get(key);
        if (cached && Date.now() - cached.timestamp <= cached.ttl) {
            return cached.payload;
        }
        if (cached) this.cache.delete(key);
        return null;
    }

    async set(key, data, ttl) {
        if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
            const firstKey = this.cache.keys().next().value;
            this.cache.delete(firstKey);
        }
        this.cache.set(key, { payload: data, timestamp: Date.now(), ttl });
    }

    async delete(key) {
        this.cache.delete(key);
    }
}

// مزود الكاش بقاعدة البيانات المحلية (IndexedDB)
class IndexedDBCacheProvider {
    constructor(dbName, version, storeName) {
        this.dbName = dbName;
        this.version = version;
        this.storeName = storeName;
        this.dbPromise = null;
    }

    initDB() {
        if (this.dbPromise) return this.dbPromise;
        this.dbPromise = new Promise((resolve, reject) => {
            try {
                const request = indexedDB.open(this.dbName, this.version);
                request.onerror = (e) => reject(e);
                request.onsuccess = (e) => resolve(e.target.result);
                request.onupgradeneeded = (e) => {
                    const db = e.target.result;
                    if (!db.objectStoreNames.contains(this.storeName)) {
                        db.createObjectStore(this.storeName);
                    }
                };
            } catch (e) {
                reject(e);
            }
        });
        return this.dbPromise;
    }

    async get(key) {
        const db = await this.initDB();
        return new Promise((resolve, reject) => {
            let request;
            try {
                request = db.transaction([this.storeName], 'readonly').objectStore(this.storeName).get(key);
            } catch (e) {
                return reject(e);
            }
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async set(key, data, ttl) {
        const db = await this.initDB();
        return new Promise((resolve, reject) => {
            const cacheObject = {
                payload: data,
                timestamp: Date.now(),
                ttl
            };
            let request;
            try {
                request = db.transaction([this.storeName], 'readwrite').objectStore(this.storeName).put(cacheObject, key);
            } catch (e) {
                return reject(e);
            }
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    async delete(key) {
        try {
            const db = await this.initDB();
            db.transaction([this.storeName], 'readwrite').objectStore(this.storeName).delete(key);
        } catch (e) {} // Silent fail on delete
    }
}

// 💡 يمكن مستقبلاً إضافة: class RedisCacheProvider { ... } بسهولة هنا

// ==========================================
// 🚀 Cache Manager
// ==========================================

class CacheManager {
    constructor() {
        this.primary = new IndexedDBCacheProvider(DB_NAME, DB_VERSION, STORE_NAME);
        this.fallback = new MemoryCacheProvider(50); // الحماية من الـ Memory Leak
        this.isPrimaryAvailable = true;
        this.warned = false;
    }

    _handleFallback() {
        if (!this.warned) {
            this.warned = true;
            console.warn("Primary Cache (IndexedDB) is unavailable. Switched to Memory Cache.");
            window.dispatchEvent(new CustomEvent('cache:unavailable'));
        }
    }

    _getTTL(key) {
        return (key.startsWith('font_') || key.startsWith('ffmpeg_')) ? (30 * 24 * 60 * 60 * 1000) : DEFAULT_TTL;
    }

    async get(key) {
        const ttl = this._getTTL(key);

        if (!this.isPrimaryAvailable) {
            this._handleFallback();
            return this.fallback.get(key);
        }

        try {
            const result = await this.primary.get(key);
            if (!result) return null;

            // دعم التخزين بنظام الـ TTL الجديد
            if (result.timestamp && result.payload !== undefined) {
                const age = Date.now() - result.timestamp;
                // Fallback للبيانات المخزنة مسبقاً قبل التعديل
                const itemTtl = result.ttl || ttl;
                if (age > itemTtl) {
                    await this.primary.delete(key);
                    return null;
                }
                return result.payload;
            }
            
            // Backward compatibility للملفات القديمة
            return result;
        } catch (e) {
            this.isPrimaryAvailable = false;
            this._handleFallback();
            return this.fallback.get(key);
        }
    }

    async set(key, data) {
        const ttl = this._getTTL(key);

        if (!this.isPrimaryAvailable) {
            this._handleFallback();
            return this.fallback.set(key, data, ttl);
        }

        try {
            await this.primary.set(key, data, ttl);
        } catch (e) {
            this.isPrimaryAvailable = false;
            this._handleFallback();
            await this.fallback.set(key, data, ttl);
        }
    }
}

const cacheManager = new CacheManager();

// ==========================================
// 🌍 Public API (لضمان عدم كسر التطبيق في أي ملف خارجي)
// ==========================================

export async function getCache(key) {
    return cacheManager.get(key);
}

export async function setCache(key, data) {
    return cacheManager.set(key, data);
}