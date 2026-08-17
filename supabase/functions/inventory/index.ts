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

    const authHeader = req.headers.get("Authorization");
    let userId: string | null = null;
    if (authHeader) {
      const token = authHeader.replace("Bearer ", "");
      const { data: { user } } = await supabase.auth.getUser(token);
      userId = user?.id ?? null;
    }

    const { action, product_id, location_id, new_quantity, reason } = await req.json();

    if (action === "adjust") {
      const { data: result, error } = await supabase.rpc("adjust_stock", {
        p_product_id: product_id,
        p_location_id: location_id,
        p_new_quantity: new_quantity,
        p_reason: reason ?? "Stock adjustment",
        p_user_id: userId
      });

      if (error) throw error;

      return new Response(JSON.stringify({ success: true, data: result }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200
      });
    }

    if (action === "check_availability") {
      const { data: stock, error } = await supabase
        .from("stock_levels")
        .select("quantity, reserved_quantity")
        .eq("product_id", product_id)
        .eq("location_id", location_id)
        .single();

      if (error && error.code !== "PGRST116") throw error;

      const onHand = stock?.quantity ?? 0;
      const reserved = stock?.reserved_quantity ?? 0;

      return new Response(JSON.stringify({
        success: true,
        data: {
          product_id,
          location_id,
          on_hand: onHand,
          reserved: reserved,
          available: Math.max(0, onHand - reserved)
        }
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    return new Response(JSON.stringify({ success: false, message: "Invalid action" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 400
    });

  } catch (err: any) {
    return new Response(JSON.stringify({ success: false, message: err.message }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500
    });
  }
});
