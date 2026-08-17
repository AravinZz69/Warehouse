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

    const { delivery_id } = await req.json();

    // Fetch delivery lines
    const { data: lines, error: lineErr } = await supabase
      .from("delivery_lines")
      .select("id, product_id, quantity, location_id")
      .eq("delivery_id", delivery_id);

    if (lineErr) throw lineErr;

    const allocations = [];
    let allAllocated = true;

    for (const line of lines) {
      // Find best location with sufficient stock
      const { data: stockLevels, error: stockErr } = await supabase
        .from("stock_levels")
        .select("location_id, quantity, reserved_quantity")
        .eq("product_id", line.product_id)
        .order("quantity", { ascending: false });

      if (stockErr) throw stockErr;

      let needed = line.quantity;
      let lineAllocated = false;

      for (const stock of stockLevels) {
        const available = stock.quantity - (stock.reserved_quantity || 0);
        if (available >= needed) {
          allocations.push({
            delivery_line_id: line.id,
            product_id: line.product_id,
            assigned_location_id: stock.location_id,
            allocated_quantity: needed
          });

          // Reserve inventory
          await supabase.rpc("reserve_inventory", {
            p_product_id: line.product_id,
            p_location_id: stock.location_id,
            p_qty: needed
          });

          // Update location on line if missing
          await supabase
            .from("delivery_lines")
            .update({ location_id: stock.location_id })
            .eq("id", line.id);

          lineAllocated = true;
          break;
        }
      }

      if (!lineAllocated) {
        allAllocated = false;
      }
    }

    const newState = allAllocated ? "ALLOCATED" : "ALLOCATION_FAILED";
    await supabase
      .from("deliveries")
      .update({ lifecycle_state: newState })
      .eq("id", delivery_id);

    if (!allAllocated) {
      await supabase.from("warehouse_exceptions").insert({
        delivery_id: delivery_id,
        exception_type: "ALLOCATION_FAILED",
        details: "One or more order items could not be allocated due to stock shortages.",
        recommended_action: "Trigger replenishment or request stock transfer from secondary warehouse."
      });
    }

    return new Response(JSON.stringify({
      success: allAllocated,
      lifecycle_state: newState,
      allocations
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
