    (function() {
        'use strict';
        var ua = navigator.userAgent || navigator.vendor || window.opera;
        var isInApp = (ua.indexOf("FBAN") > -1) || (ua.indexOf("FBAV") > -1) || (ua.indexOf("Instagram") > -1) || (ua.indexOf("TikTok") > -1) || (ua.indexOf("Bytedance") > -1) || (ua.indexOf("Snapchat") > -1) || (ua.indexOf("Twitter") > -1) || (ua.indexOf("LinkedIn") > -1);

        if (isInApp) {
            var overlay = document.getElementById('inAppOverlay');
            if (overlay) {
                overlay.classList.remove('hidden');
                overlay.classList.add('flex');
                document.body.style.overflow = 'hidden'; // منع التمرير
            }
            
            var btn = document.getElementById('openExternalBtn');
            if (btn) {
                btn.addEventListener('click', function() {
                    var currentUrl = window.location.href;
                    // محاولة توجيه أندرويد لفتح كروم إجبارياً
                    if (/android/i.test(ua)) {
                        var noHttp = currentUrl.replace(/^https?:\/\//, '');
                        window.location.href = 'intent://' + noHttp + '#Intent;scheme=https;package=com.android.chrome;end';
                    } else {
                        // في الآيفون لا يمكن الإجبار برمجياً بسهولة، لكن نعطي تنبيه للمستخدم
                        alert('يرجى الضغط على النقاط الثلاث (...) في أعلى أو أسفل الشاشة واختيار "Open in Browser" أو "فتح في المتصفح"');
                    }
                });
            }
        }
    })();
