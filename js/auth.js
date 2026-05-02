import { supabaseClient, state } from './store.js';
import { UI } from './ui.js';
import { getUserCapabilities } from './permissions.js';

export let isUpdatingSession = false;

export async function checkFeaturePermission(featureName) {
    if (!supabaseClient) return false;
    const { data } = await supabaseClient.rpc('check_feature_permission', {
        feature_name: featureName
    });
    return data?.allowed === true;
}

export async function enforceSingleSession(user) {
    if (isUpdatingSession) return true;

    let localSessionId = localStorage.getItem('device_session_id');
    let localSessionVer = parseInt(localStorage.getItem('device_session_ver') || '0');
    
    const remoteSessionId = user.user_metadata?.device_session_id;
    const remoteSessionVer = parseInt(user.user_metadata?.device_session_ver || '0');

    if (!localSessionId) {
        isUpdatingSession = true;
        localSessionId = (crypto && crypto.randomUUID) ? crypto.randomUUID() : Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
        localSessionVer = remoteSessionVer + 1;
        localStorage.setItem('device_session_id', localSessionId);
        localStorage.setItem('device_session_ver', localSessionVer.toString());
        
        await supabaseClient.auth.updateUser({
            data: { device_session_id: localSessionId, device_session_ver: localSessionVer }
        }).catch(e => console.error("Session update error:", e));
        isUpdatingSession = false;
        return true;
    }

    if (remoteSessionId && remoteSessionId !== localSessionId) {
        if (remoteSessionVer >= localSessionVer) {
            isUpdatingSession = true;
            Object.keys(localStorage).forEach(k => { if(k.startsWith('sb-')) localStorage.removeItem(k); });
            localStorage.removeItem('device_session_id');
            localStorage.removeItem('device_session_ver');
            window.location.reload();
            return false;
        } else {
            if (!isUpdatingSession) {
                isUpdatingSession = true;
                await supabaseClient.auth.updateUser({
                    data: { device_session_id: localSessionId, device_session_ver: localSessionVer }
                }).catch(e => console.error("Session update error:", e));
                isUpdatingSession = false;
            }
            return true;
        }
    } else if (!remoteSessionId) {
         isUpdatingSession = true;
         await supabaseClient.auth.updateUser({
            data: { device_session_id: localSessionId, device_session_ver: localSessionVer }
        }).catch(e => console.error("Session update error:", e));
         isUpdatingSession = false;
    }
    return true;
}

export function checkAuth() {
    if (!state.user) {
        UI.loginBtn.classList.remove('hidden');
        UI.openProfileBtn.classList.add('hidden');
        state.plan = 'free';
        if (UI.lpLoginBtn) {
            UI.lpLoginBtn.classList.remove('hidden');
            UI.lpOpenProfileBtn.classList.add('hidden');
            UI.lpLoginBtn.textContent = "تسجيل الدخول";
            UI.lpLoginBtn.onclick = () => UI.authScreen.classList.remove('hidden');
        }
    } else {
        UI.loginBtn.classList.add('hidden');
        UI.openProfileBtn.classList.remove('hidden');
        updateProfileUI();
        if (UI.lpLoginBtn) {
            UI.lpLoginBtn.classList.add('hidden');
            UI.lpOpenProfileBtn.classList.remove('hidden');
        }
    }
}

export async function loadUserPlan() {
    if (!state.user || !supabaseClient) { 
        state.plan = 'free'; 
        state.planLastChecked = 0;
        state.permissions = { upload_audio: false, waveform: false, watermark: false, remove_branding: false, export_limit: 5 };
        return; 
    }
    try {
        const { data, error } = await supabaseClient.from('profiles').select('plan, plan_expires_at').eq('id', state.user.id).maybeSingle();
        if (error) throw error;
        if (data && data.plan) {
            state.plan = data.plan;
            state.planExpiresAt = data.plan_expires_at;
            if (state.plan === 'pro') {
                const { data: permissionsData, error: permissionsError } = await supabaseClient.rpc('get_pro_permissions');
                if (permissionsError) {
                    console.warn("Failed to get pro permissions, using defaults", permissionsError);
                    state.permissions = { upload_audio: true, waveform: true, watermark: true, remove_branding: true, export_limit: 9999 };
                } else {
                    state.permissions = permissionsData || { upload_audio: true, waveform: true, watermark: true, remove_branding: true, export_limit: 9999 };
                    if (state.permissions.export_limit === undefined) state.permissions.export_limit = 9999;
                }
            } else {
                state.permissions = { upload_audio: false, waveform: false, watermark: false, remove_branding: false, export_limit: 5 };
            }
        } else {
            state.plan = 'free';
            state.planExpiresAt = null;
            state.permissions = { upload_audio: false, waveform: false, watermark: false, remove_branding: false, export_limit: 5 };
        }
        state.planLastChecked = Date.now();
    } catch (e) { 
        state.planLastChecked = 0;
        console.error("Error loading plan:", e); throw e; 
    }
    updateProfileUI();
}

export function updateProfileUI() {
    if (!state.user) return;
    const name = state.user.user_metadata?.full_name || state.user.email.split('@')[0];
    const avatarUrl = state.user.user_metadata?.avatar_url || state.user.user_metadata?.picture;
    
    UI.profileName.textContent = name; UI.profileEmail.textContent = state.user.email;

    UI.profileAvatar.textContent = ''; // تنظيف القديم
    if (avatarUrl) {
        const img = document.createElement('img');
        img.src = avatarUrl;
        img.alt = name;
        img.className = "w-full h-full rounded-full object-cover";
        img.referrerPolicy = "no-referrer";
        img.crossOrigin = "anonymous";
        UI.profileAvatar.appendChild(img);
    } else {
        UI.profileAvatar.textContent = name.charAt(0).toUpperCase();
    }

    UI.profileAvatar.className = "w-24 h-24 rounded-full mx-auto mb-4 flex items-center justify-center text-4xl font-bold text-white shadow-xl transition-all duration-500 overflow-hidden";
    const modalCard = UI.profileModal.querySelector('.modal-card');
    modalCard.style.borderColor = ''; modalCard.style.boxShadow = '';

    const caps = getUserCapabilities();
    if (!caps.isFree) {
        UI.planName.textContent = '';
        const planSpan = document.createElement('span');
        planSpan.className = "text-transparent bg-clip-text bg-gradient-to-r from-amber-500 to-orange-600 font-black text-xl";
        planSpan.textContent = "عضو محترف⚡";
        UI.planName.appendChild(planSpan);

        UI.planStatus.className = "px-4 py-1.5 bg-gradient-to-r from-amber-500 to-orange-600 text-white text-xs font-bold rounded-full shadow-lg shadow-orange-500/30 flex items-center gap-1 mx-auto w-fit";
        UI.planStatus.textContent = '';
        
        const starIcon = document.createElement('i');
        starIcon.setAttribute('data-lucide', 'star');
        starIcon.className = "w-3 h-3 fill-white";
        UI.planStatus.appendChild(starIcon);
        
        const statusSpan = document.createElement('span');
        if (state.planExpiresAt) {
            statusSpan.dir = "ltr";
            statusSpan.textContent = `ينتهي: ${new Date(state.planExpiresAt).toLocaleDateString('ar-EG')}`;
        } else {
            statusSpan.textContent = "اشتراك نشط";
        }
        UI.planStatus.appendChild(statusSpan);
        UI.profileAvatar.classList.add('bg-gradient-to-tr', 'from-amber-400', 'to-orange-600', 'shadow-orange-500/40', 'ring-4', 'ring-orange-500/20');
        modalCard.style.borderColor = 'rgba(245, 158, 11, 0.5)'; modalCard.style.boxShadow = '0 25px 50px -12px rgba(245, 158, 11, 0.2)';
        UI.upgradeBtn.classList.add('hidden');
    } else {
        UI.planName.textContent = "مجانية (Free)";
        UI.planStatus.className = "px-3 py-1 bg-zinc-500/10 text-zinc-500 text-xs font-bold rounded-full";
        UI.planStatus.textContent = "نشط";
        UI.profileAvatar.classList.add('bg-gradient-to-tr', 'from-[#007AFF]', 'to-cyan-400');
        UI.upgradeBtn.classList.remove('hidden');
    }
    if (window.lucide) window.lucide.createIcons();
}

export async function loadTestimonials() {
    if (!supabaseClient || !UI.testimonialsGrid) return;
    try {
        const { data, error } = await supabaseClient.from('testimonials').select('*').eq('is_approved', true).order('created_at', { ascending: false }).limit(6);
        if (error) throw error;
        
        if (data && data.length > 0) {
            UI.testimonialsGrid.textContent = '';
            data.forEach(t => {
                const card = document.createElement('div');
                card.className = "p-8 rounded-3xl bg-[var(--panel-bg)]/50 backdrop-blur-sm border border-[var(--border-color)] flex flex-col h-full hover:border-[#007AFF]/30 transition-colors";

                const content = document.createElement('p');
                content.className = "text-sm text-zinc-400 mb-6 leading-relaxed flex-1";
                content.textContent = `"${t.content}"`;

                const userDiv = document.createElement('div');
                userDiv.className = "flex items-center gap-3 mt-auto";

                if (t.avatar_url) {
                    const img = document.createElement('img');
                    img.className = "w-10 h-10 rounded-full bg-zinc-700 object-cover border border-[var(--border-color)]";
                    img.src = t.avatar_url;
                    img.alt = t.name;
                    img.crossOrigin = "anonymous";
                    userDiv.appendChild(img);
                } else {
                    const avatarFallback = document.createElement('div');
                    avatarFallback.className = "w-10 h-10 rounded-full bg-gradient-to-tr from-[#007AFF] to-cyan-400 flex items-center justify-center text-white font-bold text-sm shadow-md";
                    avatarFallback.textContent = t.name ? t.name.charAt(0).toUpperCase() : '?';
                    userDiv.appendChild(avatarFallback);
                }

                const nameWrapper = document.createElement('div');
                const nameHeading = document.createElement('h4');
                nameHeading.className = "font-bold text-sm text-[var(--text-main)]";
                nameHeading.textContent = t.name;
                nameWrapper.appendChild(nameHeading);

                userDiv.appendChild(nameWrapper);
                card.appendChild(content);
                card.appendChild(userDiv);
                
                UI.testimonialsGrid.appendChild(card);
            });
        } else {
            UI.testimonialsGrid.textContent = '';
            const fallbackP = document.createElement('p');
            fallbackP.className = "text-center text-zinc-500 col-span-full py-8 text-sm";
            fallbackP.textContent = "كن أول من يشاركنا رأيه في الأداة!";
            UI.testimonialsGrid.appendChild(fallbackP);
        }
        if (window.lucide) window.lucide.createIcons();
    } catch (e) { console.error("Error loading testimonials:", e); }
}

export async function signInWithGoogle() {
    if (!supabaseClient) return alert('خطأ في الاتصال بالخادم.');
    if (window.location.protocol === 'file:') return alert('لا يمكن تسجيل الدخول عبر ملفات النظام مباشرة. يرجى رفعه أو تشغيل سيرفر محلي.');
    
    // إظهار شاشة التحميل لمنع المستخدم من التفاعل أثناء انتظار التحويل
    if (UI.globalLoader) {
        if (UI.globalLoaderText) UI.globalLoaderText.textContent = "جاري تحويلك لتسجيل الدخول...";
        UI.globalLoader.classList.remove('hidden');
        setTimeout(() => { 
            UI.globalLoader.style.opacity = '1'; 
            UI.globalLoader.style.pointerEvents = 'auto'; 
        }, 10);
    }

    localStorage.removeItem('device_session_id'); localStorage.removeItem('device_session_ver');
    const { data, error } = await supabaseClient.auth.signInWithOAuth({ 
        provider: 'google', 
        options: { 
            redirectTo: window.location.origin + window.location.pathname,
            queryParams: {
                prompt: 'select_account' // إجبار ظهور شاشة اختيار الحساب
            }
        } 
    });
    if (error) {
        if (UI.globalLoader) {
            UI.globalLoader.style.opacity = '0';
            UI.globalLoader.style.pointerEvents = 'none';
            setTimeout(() => UI.globalLoader.classList.add('hidden'), 500);
        }
        alert("فشل تسجيل الدخول: " + error.message);
    }
}