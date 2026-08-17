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

    const { action, order_type, id, data } = await req.json();

    if (action === "validate") {
      if (!id || !order_type) {
        return new Response(JSON.stringify({ success: false, message: "Missing order id or type" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 400
        });
      }

      let rpcName = "";
      if (order_type === "receipt") rpcName = "validate_receipt";
      else if (order_type === "delivery") rpcName = "validate_delivery";
      else if (order_type === "transfer") rpcName = "validate_transfer";
      else {
        return new Response(JSON.stringify({ success: false, message: "Invalid order type" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 400
        });
      }

      const paramKey = order_type === "receipt" ? "p_receipt_id" : order_type === "delivery" ? "p_delivery_id" : "p_transfer_id";
      const { data: result, error } = await supabase.rpc(rpcName, {
        [paramKey]: id,
        p_user_id: userId
      });

      if (error) throw error;

      return new Response(JSON.stringify({ success: true, data: result }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200
      });
    }

    if (action === "cancel") {
      const table = order_type === "receipt" ? "receipts" : order_type === "delivery" ? "deliveries" : "internal_transfers";
      const { error } = await supabase.from(table).update({ status: "cancelled" }).eq("id", id);
      if (error) throw error;

      return new Response(JSON.stringify({ success: true, message: "Order cancelled" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    return new Response(JSON.stringify({ success: false, message: "Unknown action" }), {
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
