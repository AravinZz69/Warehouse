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

    const { action, delivery_id, picker_id } = await req.json();

    if (action === "assign") {
      // Find picking location sequence
      const { data: lines } = await supabase
        .from("delivery_lines")
        .select("id, product_id, location_id, quantity, locations(name, short_code)")
        .eq("delivery_id", delivery_id);

      const route = (lines || []).map((l: any, idx: number) => ({
        step: idx + 1,
        location: l.locations?.name || "Default Location",
        short_code: l.locations?.short_code || `LOC-${l.location_id}`,
        product_id: l.product_id,
        quantity: l.quantity
      }));

      const { data: task, error } = await supabase
        .from("picking_tasks")
        .insert({
          delivery_id,
          picker_id,
          status: "in_progress",
          route_json: route
        })
        .select()
        .single();

      if (error) throw error;

      await supabase
        .from("deliveries")
        .update({ lifecycle_state: "PICKING" })
        .eq("id", delivery_id);

      return new Response(JSON.stringify({ success: true, task, route }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    if (action === "complete") {
      await supabase
        .from("picking_tasks")
        .update({ status: "completed" })
        .eq("delivery_id", delivery_id);

      await supabase
        .from("deliveries")
        .update({ lifecycle_state: "PICKED" })
        .eq("id", delivery_id);

      return new Response(JSON.stringify({ success: true, message: "Picking completed" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    return new Response(JSON.stringify({ success: false, message: "Unknown picking action" }), {
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
