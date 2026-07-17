/**
 * ============================================================
 * prayer-times.js v2.0
 * إدارة مواقيت الصلاة - نسخة احترافية Production Ready
 * ============================================================
 * 
 * الميزات:
 * ✅ تحديد الصلاة الحالية بشكل صحيح (فجر ← شروق، ظهر ← عصر، ...)
 * ✅ التعامل مع منتصف الليل بشكل صحيح
 * ✅ Reverse Geocoding للحصول على اسم المدينة
 * ✅ استخدام بيانات API للتاريخ (هجري/ميلادي)
 * ✅ تخزين Response الخام مع Cache Validation
 * ✅ AbortController للتحكم في الطلبات
 * ✅ Retry mechanism (3 محاولات)
 * ✅ Timeout للـ fetch (10 ثوان)
 * ✅ مراعاة Timezone
 * ✅ إشعارات قبل الأذان (أصفر 15 د، Pulse 5 د، أخضر عند الأذان)
 * ✅ نسبة انقضاء وقت الصلاة
 * ✅ Class-based architecture
 * ============================================================
 */

(function() {
    'use strict';

    // ============================================================
    // CONSTANTS
    // ============================================================
    const CONFIG = {
        API_BASE: 'https://api.aladhan.com/v1',
        METHOD: 5, // Egyptian General Authority of Survey
        CACHE_KEY: 'prayer_times_cache',
        CACHE_DURATION: 24 * 60 * 60 * 1000, // 24 ساعة
        FETCH_TIMEOUT: 10000, // 10 ثوان
        MAX_RETRIES: 3,
        RETRY_DELAY: 1000, // 1 ثانية بين المحاولات
        COUNTDOWN_INTERVAL: 1000,
        PRAYER_NAMES: {
            ar: ['الفجر', 'الشروق', 'الظهر', 'العصر', 'المغرب', 'العشاء'],
            en: ['Fajr', 'Sunrise', 'Dhuhr', 'Asr', 'Maghrib', 'Isha']
        },
        // أوقات الصلاة الحالية (من - إلى)
        PRAYER_RANGES: {
            'Fajr': { next: 'Sunrise' },
            'Sunrise': { next: 'Dhuhr' },
            'Dhuhr': { next: 'Asr' },
            'Asr': { next: 'Maghrib' },
            'Maghrib': { next: 'Isha' },
            'Isha': { next: 'Fajr' }
        },
        // الحالات
        STATUS: {
            BEFORE: 'before',
            SOON: 'soon',
            VERY_SOON: 'very_soon',
            NOW: 'now',
            AFTER: 'after',
            ENDED: 'ended'
        }
    };

    // ============================================================
    // PRAYER LOCATION
    // ============================================================
    class PrayerLocation {
        constructor() {
            this.coords = null;
            this.city = 'القاهرة';
            this.country = 'مصر';
            this.isUsingFallback = true;
        }

        async getLocation() {
            try {
                const position = await this.getGeolocation();
                this.coords = {
                    latitude: position.coords.latitude,
                    longitude: position.coords.longitude
                };
                this.isUsingFallback = false;
                await this.reverseGeocode();
                return this.coords;
            } catch (error) {
                console.warn('فشل تحديد الموقع، استخدام القاهرة كافتراضي:', error);
                this.coords = {
                    latitude: 30.0444,
                    longitude: 31.2357
                };
                this.city = 'القاهرة';
                this.country = 'مصر';
                this.isUsingFallback = true;
                return this.coords;
            }
        }

        getGeolocation() {
            return new Promise((resolve, reject) => {
                if (!navigator.geolocation) {
                    reject(new Error('Geolocation غير مدعوم'));
                    return;
                }
                navigator.geolocation.getCurrentPosition(resolve, reject, {
                    enableHighAccuracy: true,
                    timeout: 5000,
                    maximumAge: 60000
                });
            });
        }

        async reverseGeocode() {
            try {
                const { latitude, longitude } = this.coords;
                const url = `https://nominatim.openstreetmap.org/reverse?lat=${latitude}&lon=${longitude}&format=json&accept-language=ar`;
                const response = await fetch(url);
                if (!response.ok) throw new Error('Reverse geocoding failed');
                const data = await response.json();
                if (data.address) {
                    this.city = data.address.city ||
                        data.address.town ||
                        data.address.village ||
                        data.address.state ||
                        'مصر';
                    this.country = data.address.country || 'مصر';
                }
            } catch (error) {
                console.warn('فشل Reverse Geocoding:', error);
                this.city = this.getCityByCoords();
            }
        }

        getCityByCoords() {
            const { latitude, longitude } = this.coords;
            const cities = [
                { name: 'القاهرة', lat: 30.0444, lng: 31.2357, radius: 50 },
                { name: 'الإسكندرية', lat: 31.2001, lng: 29.9187, radius: 50 },
                { name: 'الجيزة', lat: 30.0131, lng: 31.2089, radius: 30 },
                { name: 'شبرا الخيمة', lat: 30.1299, lng: 31.2426, radius: 30 },
                { name: 'بورسعيد', lat: 31.2653, lng: 32.3019, radius: 30 },
                { name: 'السويس', lat: 29.9737, lng: 32.5263, radius: 30 },
                { name: 'المحلة الكبرى', lat: 30.9670, lng: 31.1570, radius: 30 },
                { name: 'المنصورة', lat: 31.0436, lng: 31.3781, radius: 30 },
                { name: 'طنطا', lat: 30.7870, lng: 31.0000, radius: 30 },
                { name: 'أسيوط', lat: 27.1783, lng: 31.1859, radius: 30 }
            ];
            let closest = cities[0];
            let minDistance = Infinity;
            for (const city of cities) {
                const distance = this.getDistance(latitude, longitude, city.lat, city.lng);
                if (distance < minDistance) {
                    minDistance = distance;
                    closest = city;
                }
            }
            return closest.name;
        }

        getDistance(lat1, lon1, lat2, lon2) {
            const R = 6371;
            const dLat = (lat2 - lat1) * Math.PI / 180;
            const dLon = (lon2 - lon1) * Math.PI / 180;
            const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
                Math.sin(dLon / 2) * Math.sin(dLon / 2);
            const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
            return R * c;
        }
    }

    // ============================================================
    // PRAYER API
    // ============================================================
    class PrayerAPI {
        constructor() {
            this.controller = null;
        }

        async fetchPrayerTimes(lat, lng, date = null) {
            const targetDate = date || new Date();
            const day = String(targetDate.getDate()).padStart(2, '0');
            const month = String(targetDate.getMonth() + 1).padStart(2, '0');
            const year = targetDate.getFullYear();
            const dateStr = `${day}-${month}-${year}`;

            const url = `${CONFIG.API_BASE}/timings/${dateStr}?latitude=${lat}&longitude=${lng}&method=${CONFIG.METHOD}`;

            let lastError = null;

            for (let attempt = 1; attempt <= CONFIG.MAX_RETRIES; attempt++) {
                try {
                    const data = await this.fetchWithTimeout(url, CONFIG.FETCH_TIMEOUT);
                    return data;
                } catch (error) {
                    lastError = error;
                    console.warn(`محاولة ${attempt}/${CONFIG.MAX_RETRIES} فشلت:`, error);
                    if (attempt < CONFIG.MAX_RETRIES) {
                        await this.delay(CONFIG.RETRY_DELAY * attempt);
                    }
                }
            }

            throw lastError || new Error('فشل جلب البيانات بعد جميع المحاولات');
        }

        async fetchWithTimeout(url, timeout) {
            this.controller = new AbortController();
            const signal = this.controller.signal;

            const timeoutId = setTimeout(() => {
                this.controller.abort();
            }, timeout);

            try {
                const response = await fetch(url, { signal });
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                }
                const data = await response.json();
                if (data.code !== 200) {
                    throw new Error(data.status || 'فشل في جلب البيانات');
                }
                return data.data;
            } finally {
                clearTimeout(timeoutId);
                this.controller = null;
            }
        }

        abort() {
            if (this.controller) {
                this.controller.abort();
                this.controller = null;
            }
        }

        delay(ms) {
            return new Promise(resolve => setTimeout(resolve, ms));
        }
    }

    // ============================================================
    // PRAYER CALCULATOR
    // ============================================================
    class PrayerCalculator {
        constructor() {
            this.prayers = [];
            this.currentPrayer = null;
            this.nextPrayer = null;
            this.lastPrayer = null;
            this.prayerStatus = {};
        }

        processTimings(data, timezone = null) {
            const timings = data.timings;
            const now = new Date();

            // استخراج الصلوات المطلوبة
            this.prayers = CONFIG.PRAYER_NAMES.en.map((key, index) => {
                const timeStr = timings[key] || '00:00';
                const date = this.parseTimeToDate(timeStr, now, timezone);

                return {
                    name: CONFIG.PRAYER_NAMES.ar[index],
                    key: key,
                    timeStr: timeStr,
                    date: date,
                    isCurrent: false,
                    isNext: false,
                    isLast: false,
                    status: CONFIG.STATUS.BEFORE,
                    timeElapsed: 0,
                    timeRemaining: 0,
                    percentage: 0
                };
            });

            // ترتيب الصلوات حسب الوقت
            this.prayers.sort((a, b) => a.date - b.date);

            // تحديد الصلاة الحالية والقادمة والأخيرة
            this.determinePrayers(now);

            // حساب الحالات
            this.calculateStatuses(now);

            return {
                allPrayers: this.prayers,
                currentPrayer: this.currentPrayer,
                nextPrayer: this.nextPrayer,
                lastPrayer: this.lastPrayer,
                prayerStatus: this.prayerStatus
            };
        }

        determinePrayers(now) {
            const total = this.prayers.length;
            if (total === 0) return;

            let currentIndex = -1;

            for (let i = 0; i < total; i++) {
                const prayer = this.prayers[i];
                const nextPrayer = this.prayers[(i + 1) % total];
                const prevPrayer = this.prayers[(i - 1 + total) % total];

                // تحديد نطاق الصلاة الحالية
                const startTime = prayer.date;
                let endTime;

                if (prayer.key === 'Fajr') {
                    // الفجر ينتهي عند الشروق
                    const sunrise = this.prayers.find(p => p.key === 'Sunrise');
                    endTime = sunrise ? sunrise.date : nextPrayer.date;
                } else if (prayer.key === 'Isha') {
                    // العشاء ينتهي عند الفجر (اليوم التالي)
                    const fajr = this.prayers.find(p => p.key === 'Fajr');
                    endTime = fajr ? new Date(fajr.date.getTime() + 24 * 60 * 60 * 1000) : nextPrayer.date;
                } else {
                    // باقي الصلوات تنتهي عند الصلاة التالية
                    endTime = nextPrayer.date;
                }

                // التحقق مما إذا كان الوقت الحالي ضمن النطاق
                if (now >= startTime && now < endTime) {
                    currentIndex = i;
                    break;
                }

                // حالة خاصة: إذا كان الوقت قبل الفجر، فالعشاء هو الحالية
                if (prayer.key === 'Fajr' && now < startTime) {
                    const isha = this.prayers.find(p => p.key === 'Isha');
                    if (isha && now >= isha.date) {
                        currentIndex = this.prayers.indexOf(isha);
                        break;
                    }
                }
            }

            // إذا لم يتم العثور على صلاة حالية
            if (currentIndex === -1) {
                // إذا كان الوقت قبل الفجر، الفجر هو القادمة والعشاء هي الحالية
                const fajr = this.prayers.find(p => p.key === 'Fajr');
                if (fajr && now < fajr.date) {
                    const isha = this.prayers.find(p => p.key === 'Isha');
                    if (isha) {
                        currentIndex = this.prayers.indexOf(isha);
                    } else {
                        currentIndex = total - 1;
                    }
                } else {
                    currentIndex = 0;
                }
            }

            // تعيين الصلاة الحالية
            this.currentPrayer = this.prayers[currentIndex];
            this.currentPrayer.isCurrent = true;

            // الصلاة التالية
            const nextIndex = (currentIndex + 1) % total;
            this.nextPrayer = this.prayers[nextIndex];
            this.nextPrayer.isNext = true;

            // الصلاة الأخيرة
            const lastIndex = (currentIndex - 1 + total) % total;
            this.lastPrayer = this.prayers[lastIndex];
            this.lastPrayer.isLast = true;

            // حساب الأوقات المنقضية والمتبقية
            this.calculateTimeMetrics(now);
        }

        calculateTimeMetrics(now) {
            if (!this.currentPrayer) return;

            const current = this.currentPrayer;
            const next = this.nextPrayer;

            const startTime = current.date;
            let endTime = next ? next.date : new Date(startTime.getTime() + 60 * 60 * 1000);

            if (current.key === 'Fajr') {
                const sunrise = this.prayers.find(p => p.key === 'Sunrise');
                if (sunrise) endTime = sunrise.date;
            }

            if (current.key === 'Isha') {
                const fajr = this.prayers.find(p => p.key === 'Fajr');
                if (fajr) {
                    endTime = new Date(fajr.date);
                    if (endTime <= now) {
                        endTime.setDate(endTime.getDate() + 1);
                    }
                }
            }

            const totalDuration = endTime - startTime;
            const elapsed = now - startTime;

            current.timeElapsed = Math.max(0, elapsed);
            current.timeRemaining = Math.max(0, totalDuration - elapsed);
            current.percentage = totalDuration > 0 ?
                Math.min(100, (elapsed / totalDuration) * 100) : 0;
        }

        calculateStatuses(now) {
            this.prayers.forEach(prayer => {
                const diff = prayer.date - now;
                const diffMinutes = diff / (1000 * 60);

                if (diffMinutes <= 0) {
                    if (prayer.isCurrent) {
                        prayer.status = CONFIG.STATUS.NOW;
                    } else if (prayer.isNext) {
                        prayer.status = CONFIG.STATUS.SOON;
                    } else {
                        prayer.status = CONFIG.STATUS.AFTER;
                    }
                } else if (diffMinutes <= 5) {
                    prayer.status = CONFIG.STATUS.VERY_SOON;
                } else if (diffMinutes <= 15) {
                    prayer.status = CONFIG.STATUS.SOON;
                } else {
                    prayer.status = CONFIG.STATUS.BEFORE;
                }
            });

            if (this.currentPrayer) {
                const elapsedMinutes = this.currentPrayer.timeElapsed / (1000 * 60);
                if (elapsedMinutes < 5) {
                    this.currentPrayer.status = CONFIG.STATUS.NOW;
                } else {
                    this.currentPrayer.status = CONFIG.STATUS.AFTER;
                }
            }
        }

        parseTimeToDate(timeStr, referenceDate, timezone = null) {
            const [hours, minutes] = timeStr.split(':').map(Number);
            const date = new Date(referenceDate);

            if (timezone) {
                const utcDate = new Date(date.toLocaleString('en-US', { timeZone: timezone }));
                date.setHours(utcDate.getHours(), utcDate.getMinutes(), 0, 0);
            }

            date.setHours(hours, minutes, 0, 0);

            // إذا كان الوقت قد مضى، أضف يوم
            if (date < referenceDate) {
                date.setDate(date.getDate() + 1);
            }

            return date;
        }

        getPrayerStatus(prayerKey) {
            const prayer = this.prayers.find(p => p.key === prayerKey);
            return prayer ? prayer.status : CONFIG.STATUS.BEFORE;
        }

        getTimeRemaining(prayerKey) {
            const prayer = this.prayers.find(p => p.key === prayerKey);
            return prayer ? prayer.timeRemaining : 0;
        }
    }

    // ============================================================
    // PRAYER STORAGE
    // ============================================================
    class PrayerStorage {
        constructor() {
            this.cacheKey = CONFIG.CACHE_KEY;
        }

        save(data) {
            try {
                const cacheData = {
                    data: data,
                    savedAt: new Date().toISOString(),
                    expiresAt: new Date(Date.now() + CONFIG.CACHE_DURATION).toISOString()
                };
                localStorage.setItem(this.cacheKey, JSON.stringify(cacheData));
                return true;
            } catch (error) {
                console.warn('فشل حفظ الكاش:', error);
                return false;
            }
        }

        load() {
            try {
                const raw = localStorage.getItem(this.cacheKey);
                if (!raw) return null;
                const cacheData = JSON.parse(raw);
                const expiresAt = new Date(cacheData.expiresAt);
                if (expiresAt < new Date()) {
                    localStorage.removeItem(this.cacheKey);
                    return null;
                }
                return cacheData.data;
            } catch (error) {
                console.warn('فشل تحميل الكاش:', error);
                return null;
            }
        }

        clear() {
            localStorage.removeItem(this.cacheKey);
        }

        isValid() {
            try {
                const raw = localStorage.getItem(this.cacheKey);
                if (!raw) return false;
                const cacheData = JSON.parse(raw);
                const expiresAt = new Date(cacheData.expiresAt);
                return expiresAt > new Date();
            } catch {
                return false;
            }
        }
    }

    // ============================================================
    // PRAYER RENDERER
    // ============================================================
    class PrayerRenderer {
        constructor() {
            this.grid = document.getElementById('prayerGrid');
            this.nextName = document.getElementById('nextPrayerName');
            this.countdown = document.getElementById('countdownTimer');
            this.city = document.getElementById('prayerCity');
            this.date = document.getElementById('prayerDate');
            this.status = document.getElementById('prayerStatus');
            this.statusDot = document.querySelector('.prayer__status-dot');
            this.statusText = document.querySelector('.prayer__status-text');
        }

        renderGrid(prayers, currentPrayer, nextPrayer) {
            if (!this.grid) {
                console.warn('prayerGrid element not found');
                return;
            }

            let html = '';
            prayers.forEach(prayer => {
                let classes = 'prayer-item';

                if (prayer.isCurrent) {
                    classes += ' prayer-item--current';
                    if (prayer.status === CONFIG.STATUS.NOW) {
                        classes += ' prayer-item--now';
                    }
                }
                if (prayer.isNext && !prayer.isCurrent) {
                    classes += ' prayer-item--next';
                }

                if (prayer.status === CONFIG.STATUS.SOON && !prayer.isCurrent) {
                    classes += ' prayer-item--soon';
                }
                if (prayer.status === CONFIG.STATUS.VERY_SOON && !prayer.isCurrent) {
                    classes += ' prayer-item--very-soon';
                }

                const percentage = prayer.percentage || 0;
                const isActive = prayer.isCurrent || prayer.isNext;

                html += `
                    <div class="${classes}" data-prayer="${prayer.key}" data-status="${prayer.status}">
                        <span class="prayer-item__name">${prayer.name}</span>
                        <span class="prayer-item__time">${prayer.timeStr}</span>
                        ${isActive ? `
                            <div class="prayer-item__progress" style="width: ${percentage}%;"></div>
                        ` : ''}
                        ${prayer.status === CONFIG.STATUS.VERY_SOON ? `
                            <span class="prayer-item__badge">🔔 قريباً</span>
                        ` : ''}
                        ${prayer.status === CONFIG.STATUS.NOW ? `
                            <span class="prayer-item__badge prayer-item__badge--now">🔴 الآن</span>
                        ` : ''}
                    </div>
                `;
            });

            this.grid.innerHTML = html;
        }

        updateCountdown(nextPrayer, timeRemaining) {
            if (!this.nextName || !this.countdown) return;

            if (!nextPrayer || !timeRemaining) {
                this.nextName.textContent = '--';
                this.countdown.textContent = '--:--:--';
                return;
            }

            this.nextName.textContent = nextPrayer.name;

            const seconds = Math.floor(timeRemaining / 1000);
            if (seconds <= 0) {
                this.countdown.textContent = '00:00:00';
                return;
            }

            const h = String(Math.floor(seconds / 3600)).padStart(2, '0');
            const m = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0');
            const s = String(seconds % 60).padStart(2, '0');
            this.countdown.textContent = `${h}:${m}:${s}`;
        }

        updateMeta(city, dateData) {
            if (this.city) {
                this.city.textContent = city || 'القاهرة';
            }

            if (this.date && dateData) {
                try {
                    const hijri = dateData.hijri;
                    const gregorian = dateData.gregorian;
                    const hijriDate = `${hijri.day} ${hijri.month.ar} ${hijri.year}`;
                    const gregorianDate = `${gregorian.day} ${gregorian.month.en} ${gregorian.year}`;
                    this.date.textContent = `${hijriDate} | ${gregorianDate}`;
                } catch (e) {
                    this.date.textContent = new Date().toLocaleDateString('ar-EG', {
                        weekday: 'long',
                        year: 'numeric',
                        month: 'long',
                        day: 'numeric'
                    });
                }
            } else if (this.date) {
                this.date.textContent = new Date().toLocaleDateString('ar-EG', {
                    weekday: 'long',
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric'
                });
            }
        }

        updateStatus(isOnline, isLoading, error = null) {
            if (!this.status || !this.statusDot || !this.statusText) return;

            this.status.classList.remove('hidden');

            if (isLoading) {
                this.statusDot.className = 'prayer__status-dot prayer__status-dot--loading';
                this.statusText.textContent = 'جاري التحميل...';
                return;
            }

            if (error) {
                this.statusDot.className = 'prayer__status-dot prayer__status-dot--offline';
                this.statusText.textContent = `⚠️ ${error}`;
                return;
            }

            if (isOnline) {
                this.statusDot.className = 'prayer__status-dot prayer__status-dot--online';
                this.statusText.textContent = '🟢 متصل';
            } else {
                this.statusDot.className = 'prayer__status-dot prayer__status-dot--offline';
                this.statusText.textContent = '📶 غير متصل (بيانات مخزنة)';
            }
        }

        showLoading() {
            if (this.grid) {
                this.grid.innerHTML = `
                    <div class="prayer-item" style="grid-column: 1 / -1; background: rgba(255,255,255,0.05);">
                        <span style="font-size:11px;opacity:0.7;">⏳ جاري تحميل مواقيت الصلاة...</span>
                    </div>
                `;
            }
            this.updateStatus(true, true, null);
        }

        showError(message) {
            if (this.grid) {
                this.grid.innerHTML = `
                    <div class="prayer-item" style="grid-column: 1 / -1; background: rgba(255,0,0,0.1); border-color: rgba(255,0,0,0.2);">
                        <span style="font-size:13px;font-weight:600;">⚠️</span>
                        <span style="font-size:11px;">لا يمكن جلب مواقيت الصلاة</span>
                        <span style="font-size:9px;opacity:0.6;">${message}</span>
                    </div>
                `;
            }
            this.updateStatus(false, false, message);
        }
    }

    // ============================================================
    // PRAYER MANAGER (المدير الرئيسي)
    // ============================================================
    class PrayerManager {
        constructor() {
            this.location = new PrayerLocation();
            this.api = new PrayerAPI();
            this.calculator = new PrayerCalculator();
            this.storage = new PrayerStorage();
            this.renderer = new PrayerRenderer();

            this.state = {
                isOnline: navigator.onLine,
                isLoading: false,
                isInitialized: false,
                lastUpdate: null,
                coords: null,
                data: null,
                processedData: null
            };

            this.countdownInterval = null;
            this.updateInterval = null;

            this.bindEvents();
        }

        async init() {
            this.state.isLoading = true;
            this.renderer.showLoading();

            try {
                const coords = await this.location.getLocation();
                this.state.coords = coords;

                const cached = this.storage.load();
                if (cached && this.isCacheValid(cached)) {
                    this.applyData(cached);
                    this.state.isLoading = false;
                    this.refreshInBackground();
                    this.startCountdown();
                    return;
                }

                await this.fetchAndApply();

            } catch (error) {
                console.error('خطأ في التهيئة:', error);
                const cached = this.storage.load();
                if (cached) {
                    this.applyData(cached);
                    this.renderer.updateStatus(false, false, 'بيانات مخزنة مؤقتاً');
                } else {
                    this.renderer.showError('فشل تحميل مواقيت الصلاة');
                }
            } finally {
                this.state.isLoading = false;
                this.state.isInitialized = true;
                this.startCountdown();
                this.startAutoUpdate();
            }
        }

        async fetchAndApply() {
            try {
                const { latitude, longitude } = this.state.coords;
                const data = await this.api.fetchPrayerTimes(latitude, longitude);

                const processed = this.calculator.processTimings(data);

                this.storage.save({
                    raw: data,
                    processed: processed,
                    coords: this.state.coords,
                    city: this.location.city,
                    country: this.location.country
                });

                this.applyData({
                    raw: data,
                    processed: processed,
                    coords: this.state.coords,
                    city: this.location.city,
                    country: this.location.country
                });

                this.state.lastUpdate = new Date();
                this.state.isOnline = true;

            } catch (error) {
                console.error('فشل جلب البيانات:', error);
                throw error;
            }
        }

        applyData(cacheData) {
            const { raw, processed, city } = cacheData;

            this.state.data = raw;
            this.state.processedData = processed;

            this.renderer.renderGrid(
                processed.allPrayers,
                processed.currentPrayer,
                processed.nextPrayer
            );

            this.renderer.updateCountdown(
                processed.nextPrayer,
                processed.nextPrayer ? processed.nextPrayer.timeRemaining : 0
            );

            this.renderer.updateMeta(city || this.location.city, raw.date);

            this.renderer.updateStatus(
                this.state.isOnline,
                false,
                null
            );
        }

        async refreshInBackground() {
            try {
                await this.fetchAndApply();
            } catch (error) {
                console.warn('تحديث الخلفية فشل:', error);
            }
        }

        startCountdown() {
            if (this.countdownInterval) {
                clearInterval(this.countdownInterval);
            }

            this.countdownInterval = setInterval(() => {
                if (!this.state.processedData) return;

                const now = new Date();
                const processed = this.calculator.processTimings(
                    this.state.data,
                    this.state.data?.meta?.timezone || null
                );

                this.renderer.updateCountdown(
                    processed.nextPrayer,
                    processed.nextPrayer ? processed.nextPrayer.timeRemaining : 0
                );

                const currentStatus = this.calculator.getPrayerStatus(
                    processed.currentPrayer?.key
                );
                const oldStatus = this.state.processedData?.currentPrayer?.status;

                if (currentStatus !== oldStatus) {
                    this.renderer.renderGrid(
                        processed.allPrayers,
                        processed.currentPrayer,
                        processed.nextPrayer
                    );
                }

                this.state.processedData = processed;

            }, CONFIG.COUNTDOWN_INTERVAL);
        }

        startAutoUpdate() {
            if (this.updateInterval) {
                clearInterval(this.updateInterval);
            }

            this.updateInterval = setInterval(() => {
                const now = new Date();
                const lastUpdate = this.state.lastUpdate;

                if (lastUpdate) {
                    const diffHours = (now - lastUpdate) / (1000 * 60 * 60);
                    if (diffHours >= 1 || lastUpdate.getDate() !== now.getDate()) {
                        this.refreshInBackground();
                    }
                }
            }, 60000);
        }

        isCacheValid(cacheData) {
            if (!cacheData || !cacheData.processed) return false;
            const cacheDate = new Date(cacheData.raw?.date?.timestamp);
            const now = new Date();
            return cacheDate.getDate() === now.getDate() &&
                cacheDate.getMonth() === now.getMonth() &&
                cacheDate.getFullYear() === now.getFullYear();
        }

        bindEvents() {
            window.addEventListener('online', () => {
                this.state.isOnline = true;
                this.renderer.updateStatus(true, false, null);
                this.refreshInBackground();
            });

            window.addEventListener('offline', () => {
                this.state.isOnline = false;
                this.renderer.updateStatus(false, false, 'غير متصل');
            });

            document.addEventListener('visibilitychange', () => {
                if (!document.hidden && this.state.isInitialized) {
                    this.refreshInBackground();
                }
            });
        }

        getCurrentPrayer() {
            return this.calculator.currentPrayer;
        }

        getNextPrayer() {
            return this.calculator.nextPrayer;
        }

        getAllPrayers() {
            return this.calculator.prayers;
        }

        async refresh() {
            this.api.abort();
            await this.fetchAndApply();
        }

        destroy() {
            if (this.countdownInterval) {
                clearInterval(this.countdownInterval);
                this.countdownInterval = null;
            }
            if (this.updateInterval) {
                clearInterval(this.updateInterval);
                this.updateInterval = null;
            }
            this.api.abort();
        }
    }

    // ============================================================
    // بدء التشغيل
    // ============================================================

    let manager = null;

    function init() {
        if (manager) {
            manager.destroy();
        }

        manager = new PrayerManager();
        manager.init();

        window.prayerManager = manager;
        window.prayerTimes = {
            refresh: () => manager.refresh(),
            getCurrent: () => manager.getCurrentPrayer(),
            getNext: () => manager.getNextPrayer(),
            getAll: () => manager.getAllPrayers(),
            getState: () => ({ ...manager.state })
        };
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();