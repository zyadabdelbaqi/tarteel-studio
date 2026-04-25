import { supabaseClient, state } from './store.js';
import { UI } from './ui.js';

export let isUpdatingSession = false;

function setText(el, value) {
    if (el) el.textContent = value || '';
}

function safeURL(url) {
    if (!url) return '';
    try {
        const u = new URL(url);
        return ['http:', 'https:'].includes(u.protocol) ? url : '';
    } catch {
        return '';
    }
}

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
            UI.lpLoginBtn.innerText = "تسجيل الدخول";
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
                if (permissionsError) throw permissionsError;
                else {
                    state.permissions = permissionsData || {};
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
    const safeAvatar = safeURL(avatarUrl);
    
    setText(UI.profileName, name);
    setText(UI.profileEmail, state.user.email);
    if (safeAvatar) {
        UI.profileAvatar.innerHTML = '';
        const img = document.createElement('img');
        img.src = safeAvatar;
        img.alt = name;
        img.className = "w-full h-full rounded-full object-cover";
        img.setAttribute('referrerpolicy', 'no-referrer');
        UI.profileAvatar.appendChild(img);
    } else {
        setText(UI.profileAvatar, name.charAt(0).toUpperCase());
    }

    UI.profileAvatar.className = "w-24 h-24 rounded-full mx-auto mb-4 flex items-center justify-center text-4xl font-bold text-white shadow-xl transition-all duration-500 overflow-hidden";
    const modalCard = UI.profileModal.querySelector('.modal-card');
    modalCard.style.borderColor = ''; modalCard.style.boxShadow = '';

    if (state.plan === 'pro') {
        UI.planName.innerHTML = `<span class="text-transparent bg-clip-text bg-gradient-to-r from-amber-500 to-orange-600 font-black text-xl">عضو محترف⚡</span>`;
        UI.planStatus.className = "px-4 py-1.5 bg-gradient-to-r from-amber-500 to-orange-600 text-white text-xs font-bold rounded-full shadow-lg shadow-orange-500/30 flex items-center gap-1 mx-auto w-fit";
        UI.planStatus.innerHTML = state.planExpiresAt ? `<i data-lucide="star" class="w-3 h-3 fill-white"></i> <span dir="ltr">ينتهي: ${new Date(state.planExpiresAt).toLocaleDateString('ar-EG')}</span>` : '<i data-lucide="star" class="w-3 h-3 fill-white"></i> <span>اشتراك نشط</span>';
        UI.profileAvatar.classList.add('bg-gradient-to-tr', 'from-amber-400', 'to-orange-600', 'shadow-orange-500/40', 'ring-4', 'ring-orange-500/20');
        modalCard.style.borderColor = 'rgba(245, 158, 11, 0.5)'; modalCard.style.boxShadow = '0 25px 50px -12px rgba(245, 158, 11, 0.2)';
        UI.upgradeBtn.classList.add('hidden');
    } else {
        setText(UI.planName, "مجانية (Free)");
        UI.planStatus.className = "px-3 py-1 bg-zinc-500/10 text-zinc-500 text-xs font-bold rounded-full";
        setText(UI.planStatus, "نشط");
        UI.profileAvatar.classList.add('bg-gradient-to-tr', 'from-[#007AFF]', 'to-cyan-400');
        UI.upgradeBtn.classList.remove('hidden');
    }
    if (window.lucide) window.lucide.createIcons();
}

function createTestimonialCard(t) {
    const safeContent = t.content || '';
    const safeName = t.name || 'مستخدم غير معروف';
    const safeAvatar = safeURL(t.avatar_url);
    
    const card = document.createElement('div');
    card.className = "p-8 rounded-3xl bg-[var(--panel-bg)]/50 backdrop-blur-sm border border-[var(--border-color)] flex flex-col h-full hover:border-[#007AFF]/30 transition-colors";
    
    const contentP = document.createElement('p');
    contentP.className = "text-sm text-zinc-400 mb-6 leading-relaxed flex-1";
    setText(contentP, `"${safeContent}"`);
    
    const userDiv = document.createElement('div');
    userDiv.className = "flex items-center gap-3 mt-auto";
    
    let avatarEl;
    if (safeAvatar) {
        avatarEl = document.createElement('img');
        avatarEl.src = safeAvatar;
        avatarEl.alt = safeName;
        avatarEl.className = "w-10 h-10 rounded-full bg-zinc-700 object-cover border border-[var(--border-color)]";
    } else {
        avatarEl = document.createElement('div');
        avatarEl.className = "w-10 h-10 rounded-full bg-gradient-to-tr from-[#007AFF] to-cyan-400 flex items-center justify-center text-white font-bold text-sm shadow-md";
        setText(avatarEl, safeName.charAt(0).toUpperCase());
    }
    
    const nameWrapper = document.createElement('div');
    const nameH4 = document.createElement('h4');
    nameH4.className = "font-bold text-sm text-[var(--text-main)]";
    setText(nameH4, safeName);
    nameWrapper.appendChild(nameH4);
    
    userDiv.appendChild(avatarEl);
    userDiv.appendChild(nameWrapper);
    card.appendChild(contentP);
    card.appendChild(userDiv);
    
    return card;
}

export async function loadTestimonials() {
    if (!supabaseClient || !UI.testimonialsGrid) return;
    try {
        const { data, error } = await supabaseClient.from('testimonials').select('*').eq('is_approved', true).order('created_at', { ascending: false }).limit(6);
        if (error) throw error;
        
        if (data && data.length > 0) {
            UI.testimonialsGrid.innerHTML = '';
            const fragment = document.createDocumentFragment();
            data.forEach(t => {
                fragment.appendChild(createTestimonialCard(t));
            });
            UI.testimonialsGrid.appendChild(fragment);
        } else {
            UI.testimonialsGrid.innerHTML = '<p class="text-center text-zinc-500 col-span-full py-8 text-sm">كن أول من يشاركنا رأيه في الأداة!</p>';
        }
        if (window.lucide) window.lucide.createIcons();
    } catch (e) { console.error("Error loading testimonials:", e); }
}

export async function signInWithGoogle() {
    if (!supabaseClient) return alert('خطأ في الاتصال بالخادم.');
    if (window.location.protocol === 'file:') return alert('لا يمكن تسجيل الدخول عبر ملفات النظام مباشرة. يرجى رفعه أو تشغيل سيرفر محلي.');
    
    // إظهار شاشة التحميل لمنع المستخدم من التفاعل أثناء انتظار التحويل
    if (UI.globalLoader) {
        if (UI.globalLoaderText) UI.globalLoaderText.innerText = "جاري تحويلك لتسجيل الدخول...";
        UI.globalLoader.classList.remove('hidden');
        setTimeout(() => { 
            UI.globalLoader.style.opacity = '1'; 
            UI.globalLoader.style.pointerEvents = 'auto'; 
        }, 10);
    }

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