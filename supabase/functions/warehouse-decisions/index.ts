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

    const { delivery_id, event_type } = await req.json();

    const { data: delivery, error: delErr } = await supabase
      .from("deliveries")
      .select("*, delivery_lines(*, products(*))")
      .eq("id", delivery_id)
      .single();

    if (delErr || !delivery) throw new Error(`Delivery ${delivery_id} not found`);

    let nextState = delivery.lifecycle_state || "CREATED";
    let priorityScore = delivery.priority_score || 50;
    let recommendation = "";

    // 1. Priority calculation based on SLA date
    if (delivery.scheduled_date) {
      const scheduled = new Date(delivery.scheduled_date);
      const now = new Date();
      const diffHours = (scheduled.getTime() - now.getTime()) / (1000 * 3600);
      if (diffHours < 24) priorityScore = 95; // Urgent SLA risk
      else if (diffHours < 48) priorityScore = 75;
      else priorityScore = 50;
    }

    // 2. State Machine Transitions
    if (nextState === "CREATED" || event_type === "PRIORITIZE") {
      nextState = "PRIORITIZED";
      recommendation = `Priority set to ${priorityScore}. Proceeding to inventory check.`;
    } else if (nextState === "PRIORITIZED" || event_type === "CHECK_INVENTORY") {
      nextState = "INVENTORY_CHECK";
      let shortItems = 0;
      for (const line of delivery.delivery_lines) {
        const { data: stock } = await supabase
          .from("stock_levels")
          .select("quantity")
          .eq("product_id", line.product_id);
        const total = (stock || []).reduce((acc: number, curr: any) => acc + curr.quantity, 0);
        if (total < line.quantity) shortItems++;
      }

      if (shortItems > 0) {
        nextState = "CREATED"; // Hold in created/draft state
        await supabase.from("warehouse_exceptions").insert({
          delivery_id,
          exception_type: "OUT_OF_STOCK",
          details: `${shortItems} line item(s) short of total requested quantity.`,
          recommended_action: "Split delivery order or issue automated purchase order."
        });
        recommendation = "Stock shortage detected. Exception ticket raised.";
      } else {
        recommendation = "Inventory verified available across locations.";
      }
    }

    await supabase
      .from("deliveries")
      .update({
        lifecycle_state: nextState,
        priority_score: priorityScore
      })
      .eq("id", delivery_id);

    return new Response(JSON.stringify({
      success: true,
      delivery_id,
      lifecycle_state: nextState,
      priority_score: priorityScore,
      recommendation
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
