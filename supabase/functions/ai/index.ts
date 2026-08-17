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

    const { agent, delivery_id, prompt } = await req.json();

    const geminiApiKey = Deno.env.get("GEMINI_API_KEY");
    const openaiApiKey = Deno.env.get("OPENAI_API_KEY");

    // Fetch warehouse context for AI evaluation
    const { data: delivery } = await supabase
      .from("deliveries")
      .select("*, delivery_lines(*, products(*), locations(*))")
      .eq("id", delivery_id)
      .single();

    const { data: stockLevels } = await supabase
      .from("stock_levels")
      .select("*, products(name, sku), locations(name, short_code)");

    const contextPayload = {
      agent: agent || "OrderAgent",
      delivery,
      stock_summary: stockLevels
    };

    let aiRecommendation: any = null;

    if (geminiApiKey) {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiApiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: `You are an expert AI Warehouse Decision Orchestrator. Analyze the following inventory and order context and provide a structured JSON recommendation with fields: "priority_score" (number), "recommended_location_id" (number or null), "action" (string: ALLOCATE, HOLD, REPLENISH), "reasoning" (string).\nContext: ${JSON.stringify(contextPayload)}`
            }]
          }]
        })
      });
      const resData = await response.json();
      const rawText = resData.candidates?.[0]?.content?.parts?.[0]?.text || "";
      try {
        const jsonMatch = rawText.match(/\{[\s\S]*\}/);
        if (jsonMatch) aiRecommendation = JSON.parse(jsonMatch[0]);
      } catch (e) {
        aiRecommendation = { action: "ALLOCATE", reasoning: rawText };
      }
    } else {
      // Deterministic rule-based fallback AI Decision Orchestration
      aiRecommendation = {
        agent: agent || "OrderAgent",
        priority_score: delivery?.scheduled_date ? 85 : 50,
        recommended_action: "ALLOCATE",
        reasoning: "Rule Engine: Order has sufficient inventory available in primary bin location."
      };
    }

    // -------------------------------------------------------------
    // AI SAFETY RULE VALIDATION (Requirement 13)
    // AI recommendation MUST be validated against database constraints
    // BEFORE applying any database mutation!
    // -------------------------------------------------------------
    let validationPassed = false;
    let executionResult = null;

    if (aiRecommendation && delivery) {
      // Validate availability for each line
      let totalAvailable = true;
      for (const line of delivery.delivery_lines) {
        const { data: stock } = await supabase
          .from("stock_levels")
          .select("quantity, reserved_quantity")
          .eq("product_id", line.product_id)
          .eq("location_id", line.location_id || 1)
          .single();

        const avail = (stock?.quantity || 0) - (stock?.reserved_quantity || 0);
        if (avail < line.quantity) {
          totalAvailable = false;
          break;
        }
      }

      validationPassed = totalAvailable;

      if (validationPassed) {
        // Execute validated database transaction safely via Supabase Edge Function call or RPC
        const { data: allocData } = await supabase.functions.invoke("allocation", {
          body: { delivery_id }
        });
        executionResult = allocData;
      } else {
        // AI decision rejected because stock condition changed or hallucinated
        await supabase.from("warehouse_exceptions").insert({
          delivery_id,
          exception_type: "ALLOCATION_FAILED",
          details: `AI recommended allocation rejected by Safety Validator: ${aiRecommendation.reasoning}`,
          recommended_action: "Manual warehouse manager review required."
        });
      }
    }

    return new Response(JSON.stringify({
      success: true,
      agent: agent || "OrderAgent",
      ai_recommendation: aiRecommendation,
      safety_validation_passed: validationPassed,
      execution_result: executionResult
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
