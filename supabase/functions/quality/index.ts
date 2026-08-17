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

    const { delivery_id, passed, notes } = await req.json();

    const { data: qc, error } = await supabase
      .from("quality_checks")
      .insert({
        delivery_id,
        passed,
        inspection_notes: notes ?? "Routine inspection"
      })
      .select()
      .single();

    if (error) throw error;

    if (passed) {
      await supabase
        .from("deliveries")
        .update({ lifecycle_state: "READY_FOR_DISPATCH" })
        .eq("id", delivery_id);

      return new Response(JSON.stringify({ success: true, qc, message: "Quality inspection passed" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    } else {
      await supabase.from("warehouse_exceptions").insert({
        delivery_id,
        exception_type: "QUALITY_FAILED",
        details: notes ?? "Items failed quality verification.",
        recommended_action: "Return order to PICKING for re-picking and re-inspection."
      });

      await supabase
        .from("deliveries")
        .update({ lifecycle_state: "PICKING" })
        .eq("id", delivery_id);

      return new Response(JSON.stringify({
        success: false,
        qc,
        message: "Quality inspection failed. Exception logged; order set back to PICKING."
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

  } catch (err: any) {
    return new Response(JSON.stringify({ success: false, message: err.message }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500
    });
  }
});
