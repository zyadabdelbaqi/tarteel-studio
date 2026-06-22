import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const MONTHLY_PLAN_ID = 'P-2YV16388BD324051NNI4Z2NA'
const YEARLY_PLAN_ID = 'P-0349011609406193YNI4Z3QI'

Deno.serve(async (req: Request) => {
  try {
    const payload = await req.json()
    const eventType = payload.event_type

    if (
      eventType === 'BILLING.SUBSCRIPTION.ACTIVATED' ||
      eventType === 'PAYMENT.SALE.COMPLETED' ||
      eventType === 'CHECKOUT.ORDER.APPROVED'
    ) {
      const userId = payload.resource?.custom_id

      if (!userId) {
        console.warn('No custom_id found in payload')
        return new Response(JSON.stringify({ received: true }), {
          status: 200,
        })
      }

      const expiresAt = new Date()
      const planId = payload.resource?.plan_id

      if (planId === YEARLY_PLAN_ID) {
        expiresAt.setFullYear(expiresAt.getFullYear() + 1)
        console.log(`ANNUAL subscription for ${userId}`)
      } else {
        expiresAt.setMonth(expiresAt.getMonth() + 1)
        console.log(`MONTHLY subscription for ${userId}`)
      }

      const supabase = createClient(
        Deno.env.get('SUPABASE_URL') ?? '',
                                    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
      )

      const { error } = await supabase
      .from('profiles')
      .update({
        plan: 'pro',
        plan_expires_at: expiresAt.toISOString(),
      })
      .eq('id', userId)

      if (error) throw error

        console.log(`Upgraded user ${userId} to PRO`)
    }

    return new Response(
      JSON.stringify({ received: true }),
                        { status: 200 }
    )
  } catch (err: any) {
    console.error('Webhook Error:', err.message)

    return new Response(
      JSON.stringify({ error: err.message }),
                        { status: 400 }
    )
  }
})
