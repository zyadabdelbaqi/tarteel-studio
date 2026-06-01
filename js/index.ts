import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

Deno.serve(async (req: Request) => {
  try {
    // 1. استلام البيانات من PayPal
    const payload = await req.json()
    const eventType = payload.event_type

    // 2. التحقق من نوع الحدث (نجاح الدفع أو الاشتراك)
    if (eventType === 'BILLING.SUBSCRIPTION.ACTIVATED' || eventType === 'PAYMENT.SALE.COMPLETED' || eventType === 'CHECKOUT.ORDER.APPROVED') {
      
      // استخراج الـ User ID الذي أرسلناه مسبقاً (custom_id)
      let userId = payload.resource?.custom_id;
      
      // في بعض ردود PayPal قد يكون الـ custom_id بداخل مسار آخر
      if (!userId && payload.resource?.custom) {
         userId = payload.resource.custom;
      }

      if (userId && typeof userId === 'string') {
        // فصل المعرف عن نوع الخطة (شهري أو سنوي)
        const parts = userId.split('|');
        const actualUserId = parts[0];
        const planType = parts.length > 1 ? parts[1] : 'monthly';

        // 3. الاتصال بقاعدة بيانات Supabase بصلاحيات الأدمن
        const supabase = createClient(
          Deno.env.get('SUPABASE_URL') ?? '',
          Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
        )

        // حساب تاريخ الانتهاء بناءً على نوع الخطة
        const expiresAt = new Date()
        if (planType === 'annual') {
          expiresAt.setFullYear(expiresAt.getFullYear() + 1)
        } else {
          expiresAt.setMonth(expiresAt.getMonth() + 1)
        }

        // 4. تحديث حالة المستخدم في جدول profiles
        const { error } = await supabase
          .from('profiles')
          .update({ 
            plan: 'pro', 
            plan_expires_at: expiresAt.toISOString() 
          })
          .eq('id', actualUserId)

        if (error) throw error;
        
        console.log(`User ${actualUserId} successfully upgraded to PRO (${planType}).`)
      } else {
        console.warn('No custom_id found in the payload.', payload);
      }
    }

    return new Response(JSON.stringify({ received: true }), { status: 200 })
  } catch (err: any) {
    console.error('Webhook Error:', err.message)
    return new Response(JSON.stringify({ error: err.message }), { status: 400 })
  }
})