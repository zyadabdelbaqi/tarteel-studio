export const EXPORT_ERRORS = {
    CANCELLED: 'EXPORT_CANCELLED'
};

export class ExportQueue {
    constructor() {
        this.queue = [];
        this.isProcessing = false;
        this.isPaused = false;
        this.activeJob = null;
        this.isCancelled = false;
        this.completedCount = 0;
        this.onProgress = null; // Callback: (completed, total, label) => {}
        this.onQueueStart = null; // Callback: () => {}
        this.onQueueEnd = null; // Callback: () => {}
        this.SMART_DELAY_MIN = 300;
        this.SMART_DELAY_MAX = 500;
        this.DEFAULT_RETRIES = 2; // حد أقصى افتراضي للمحاولات
        this.processingPromise = null;
        this.processId = 0;
    }

    add(job, label = '', maxRetries = this.DEFAULT_RETRIES) {
        if (this.queue.length > 50) {
            console.warn("Queue limit reached");
            return Promise.reject(new Error("Queue limit reached"));
        }
        
        if (!this.isProcessing) {
            this.isCancelled = false;
            this.onQueueStart?.();
        }

        return new Promise((resolve, reject) => {
            this.queue.push({ 
                job, 
                label,
                maxRetries,
                resolve, 
                reject
            });
            this.process();
        });
    }

    // إيقاف مؤقت
    pause() {
        this.isPaused = true;
    }

    // استئناف
    resume() {
        if (this.isPaused && this.isProcessing) {
            this.isPaused = false;
        }
    }

    // إلغاء الكل
    cancelAll() {
        if (!this.isProcessing && this.queue.length === 0) return;

        this.isCancelled = true;
        this.onProgress?.(this.completedCount, this.completedCount, 'Cancelled');
        
        // رفض جميع الوظائف المعلقة
        this.queue.forEach(item => item.reject(new Error(EXPORT_ERRORS.CANCELLED)));
        this.queue = [];
        
        // 🛡️ Safeguard: تصفير الحالة فوراً للسماح بإضافة مهام جديدة مباشرة بدون تعارض
        this.processId++; // 🛡️ إنهاء صلاحية أي عملية سابقة (Generation Lock)
        this.isProcessing = false;
        this.activeJob = null;
        this.processingPromise = null;

        this.notifyCancelled?.();
        this.onQueueEnd?.(); // ضمان إغلاق دورة حياة الطابور لتحديث الواجهة فوراً
    }

    clear() {
        this.queue = [];
        this.isProcessing = false;
        this.isPaused = false;
        this.activeJob = null;
        this.isCancelled = false;
        this.completedCount = 0;
    }

    // تأخير ذكي بين التصديرات
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    process() {
        if (this.processingPromise) return this.processingPromise;

        this.isProcessing = true; // 🔥 تفعيل القفل فوراً وبشكل متزامن (Synchronously) قبل الدخول في الـ Async
        const myId = ++this.processId;
        const myPromise = (async () => {
            this.completedCount = 0;
            this.isCancelled = false;

            try {
                while (this.queue.length > 0) {
                    // ✅ التحقق من الإلغاء وإنهاء الحلقة فوراً
                    if (!this.isProcessing || this.isCancelled) break;

                    // التحقق من الإيقاف المؤقت
                    while (this.isPaused && !this.isCancelled) {
                        await this.delay(100);
                    }
                    if (this.isCancelled) break;

                    const job = this.queue.shift();
                    this.activeJob = job;
                    
                    let attempt = 0;
                    let success = false;
                    let lastError = null;

                    const currentProgress = this.completedCount + 1;
                    const currentTotal = this.completedCount + this.queue.length + 1;

                    while (attempt <= job.maxRetries && !success && !this.isCancelled) {
                        try {
                            if (this.onProgress) {
                                const retryMsg = attempt > 0 ? ` (إعادة محاولة ${attempt}/${job.maxRetries})...` : '';
                                this.onProgress(currentProgress, currentTotal, job.label + retryMsg);
                            }
                            
                            await job.job();
                            if (this.isCancelled) throw new Error(EXPORT_ERRORS.CANCELLED);

                            success = true;
                            this.completedCount++;
                            job.resolve();
                            
                            await this.delay(this.SMART_DELAY_MIN + Math.random() * (this.SMART_DELAY_MAX - this.SMART_DELAY_MIN));
                        } catch (e) {
                            lastError = e;
                            
                            if (e.message === EXPORT_ERRORS.CANCELLED) {
                                break; 
                            }

                            attempt++;
                            if (attempt <= job.maxRetries && !this.isCancelled) {
                                console.warn(`Export failed, retrying (${attempt}/${job.maxRetries}) for: ${job.label}`, e);
                                await this.delay(1000 * attempt);
                            }
                        }
                    }

                    if (!success) {
                        if (lastError && lastError.message !== EXPORT_ERRORS.CANCELLED) {
                            console.error(`Export permanently failed after ${job.maxRetries} retries:`, lastError);
                        }
                        job.reject(lastError || new Error(EXPORT_ERRORS.CANCELLED));
                        this.completedCount++;
                    }

                    if (this.activeJob === job) {
                        this.activeJob = null;
                    }
                }
            } finally {
                // 🛡️ Generation Lock: التأكد من أننا ننظف حالة العملية الحالية فقط
                if (this.processId === myId) {
                    const wasCancelled = this.isCancelled;
                    this.isProcessing = false;
                    this.isPaused = false;
                    this.completedCount = 0;
                    this.isCancelled = false;
                    this.processingPromise = null;
                    
                    // لو الطابور خلص طبيعي ننادي الحدث بعد تصفير الحالة
                    if (!wasCancelled) {
                        this.onQueueEnd?.();
                    }
                }
            }
        })();

        this.processingPromise = myPromise;
        return this.processingPromise;
    }

    get queuedCount() {
        return this.queue.length;
    }

    get progress() {
        const currentTotal = this.completedCount + this.queue.length + (this.activeJob ? 1 : 0);
        return `${this.completedCount}/${currentTotal}`;
    }

    get isActive() {
        return this.isProcessing;
    }

    get isPausedState() {
        return this.isPaused;
    }
}

export const exportQueue = new ExportQueue();

export function isExporting() {
    return exportQueue.isActive;
}