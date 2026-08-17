import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const supabase = createClient(supabaseUrl, supabaseKey);

    const { delivery_id, carrier, tracking_number } = await req.json();

    const authHeader = req.headers.get("Authorization");
    let userId: string | null = null;
    if (authHeader) {
      const token = authHeader.replace("Bearer ", "");
      const { data: { user } } = await supabase.auth.getUser(token);
      userId = user?.id ?? null;
    }

    const { data: dispatch, error } = await supabase
      .from("dispatches")
      .insert({
        delivery_id,
        carrier: carrier ?? "Express Shipping",
        tracking_number: tracking_number ?? `TRK-${Date.now()}`,
        status: "dispatched"
      })
      .select()
      .single();

    if (error) throw error;

    // Trigger transactional validate_delivery RPC to update actual stock levels and ledger!
    const { data: rpcRes, error: rpcErr } = await supabase.rpc("validate_delivery", {
      p_delivery_id: delivery_id,
      p_user_id: userId
    });

    if (rpcErr) throw rpcErr;

    await supabase
      .from("deliveries")
      .update({ lifecycle_state: "DISPATCHED" })
      .eq("id", delivery_id);

    return new Response(JSON.stringify({
      success: true,
      dispatch,
      rpcRes,
      message: "Order dispatched and inventory updated in database ledger"
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });

  } catch (err: any) {
    return new Response(JSON.stringify({ success: false, message: err.message }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500
    });
  }
});
