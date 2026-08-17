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

    const { action, delivery_id, box_type } = await req.json();

    if (action === "start") {
      await supabase.from("packing_tasks").insert({
        delivery_id,
        box_type: box_type || "Standard Carton",
        status: "in_progress"
      });

      await supabase
        .from("deliveries")
        .update({ lifecycle_state: "PACKING" })
        .eq("id", delivery_id);

      return new Response(JSON.stringify({ success: true, message: "Packing started" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    if (action === "complete") {
      await supabase
        .from("packing_tasks")
        .update({ status: "completed" })
        .eq("delivery_id", delivery_id);

      await supabase
        .from("deliveries")
        .update({ lifecycle_state: "PACKED" })
        .eq("id", delivery_id);

      return new Response(JSON.stringify({ success: true, message: "Packing completed" }), {
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
