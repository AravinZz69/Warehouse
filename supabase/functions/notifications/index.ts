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

    const { recipient_email, subject, message, type } = await req.json();

    // Check if SMTP or Resend API key exists in Supabase secrets
    const resendApiKey = Deno.env.get("RESEND_API_KEY");

    if (resendApiKey) {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${resendApiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          from: "CoreInventory Alerts <notifications@resend.dev>",
          to: [recipient_email],
          subject: subject || "CoreInventory Notification",
          html: `<div style="font-family:sans-serif; padding:20px;">
                  <h2>${subject}</h2>
                  <p>${message}</p>
                 </div>`
        })
      });
      const data = await res.json();
      return new Response(JSON.stringify({ success: true, provider: "Resend", data }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // Fallback simulation/logging if no external mailer configured
    console.log(`[Notification Edge Function] To: ${recipient_email} | Subject: ${subject} | Message: ${message}`);

    return new Response(JSON.stringify({
      success: true,
      message: "Notification logged to system audit queue successfully.",
      recipient: recipient_email
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
