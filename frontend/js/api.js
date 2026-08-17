// Supabase Client and API Abstraction Layer for CoreInventory

function getSupabaseClient() {
    if (window.supabaseClient) {
        return window.supabaseClient;
    }

    const url = (typeof process !== 'undefined' && process.env?.VITE_SUPABASE_URL)
        ? process.env.VITE_SUPABASE_URL
        : (window.VITE_SUPABASE_URL || "https://your-supabase-project.supabase.co");

    const anonKey = (typeof process !== 'undefined' && process.env?.VITE_SUPABASE_ANON_KEY)
        ? process.env.VITE_SUPABASE_ANON_KEY
        : (window.VITE_SUPABASE_ANON_KEY || "your-supabase-anon-key");

    if (window.supabase && typeof window.supabase.createClient === 'function') {
        window.supabaseClient = window.supabase.createClient(url, anonKey);
        return window.supabaseClient;
    }
    return null;
}

// Unified API Adapter over Supabase Database & Edge Functions
async function apiFetch(endpoint, options = {}) {
    const sb = getSupabaseClient();
    if (!sb) {
        console.warn("Supabase client not initialized yet.");
        return { success: false, message: "Supabase client not initialized. Please set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env" };
    }

    const method = options.method || "GET";
    const body = options.body ? JSON.parse(options.body) : {};

    try {
        // --- 1. Dashboard Stats ---
        if (endpoint === "/api/dashboard/stats") {
            const { count: totalProducts } = await sb.from("products").select("*", { count: 'exact', head: true });

            const { data: stockData } = await sb.from("products").select("id, name, sku, reorder_level, stock_levels(quantity)");

            let lowStockCount = 0;
            let outOfStockCount = 0;
            const lowStockProductsList = [];

            (stockData || []).forEach(p => {
                const totalQty = (p.stock_levels || []).reduce((sum, item) => sum + (item.quantity || 0), 0);
                if (totalQty === 0) {
                    outOfStockCount++;
                } else if (p.reorder_level > 0 && totalQty <= p.reorder_level) {
                    lowStockCount++;
                    lowStockProductsList.push({
                        id: p.id,
                        name: p.name,
                        sku: p.sku,
                        on_hand: totalQty,
                        reorder_level: p.reorder_level
                    });
                }
            });

            const pendingStatuses = ['draft', 'waiting', 'ready'];
            const { count: pendingReceipts } = await sb.from("receipts").select("*", { count: 'exact', head: true }).in("status", pendingStatuses);
            const { count: pendingDeliveries } = await sb.from("deliveries").select("*", { count: 'exact', head: true }).in("status", pendingStatuses);

            const today = new Date().toISOString().split('T')[0];
            const { count: lateReceipts } = await sb.from("receipts").select("*", { count: 'exact', head: true }).in("status", pendingStatuses).lt("scheduled_date", today);
            const { count: operatingReceipts } = await sb.from("receipts").select("*", { count: 'exact', head: true }).eq("status", "ready");
            const { count: waitingReceipts } = await sb.from("receipts").select("*", { count: 'exact', head: true }).eq("status", "waiting");

            const { count: lateDeliveries } = await sb.from("deliveries").select("*", { count: 'exact', head: true }).in("status", pendingStatuses).lt("scheduled_date", today);
            const { count: operatingDeliveries } = await sb.from("deliveries").select("*", { count: 'exact', head: true }).eq("status", "ready");
            const { count: waitingDeliveries } = await sb.from("deliveries").select("*", { count: 'exact', head: true }).eq("status", "waiting");

            return {
                success: true,
                data: {
                    total_products: totalProducts || 0,
                    low_stock_count: lowStockCount,
                    out_of_stock_count: outOfStockCount,
                    pending_receipts: pendingReceipts || 0,
                    pending_deliveries: pendingDeliveries || 0,
                    late_receipts: lateReceipts || 0,
                    operating_receipts: operatingReceipts || 0,
                    waiting_receipts: waitingReceipts || 0,
                    late_deliveries: lateDeliveries || 0,
                    operating_deliveries: operatingDeliveries || 0,
                    waiting_deliveries: waitingDeliveries || 0,
                    low_stock_products: lowStockProductsList
                }
            };
        }

        // --- 2. Products ---
        if (endpoint.startsWith("/api/products")) {
            if (endpoint.includes("/stock")) {
                const parts = endpoint.split("/");
                const productId = parseInt(parts[3]);
                const { data } = await sb
                    .from("stock_levels")
                    .select("quantity, location_id, locations(id, name, warehouses(name))")
                    .eq("product_id", productId);

                const breakdown = (data || []).map(item => ({
                    location_id: item.locations?.id,
                    location_name: item.locations?.name || "Unknown",
                    warehouse_name: item.locations?.warehouses?.name || "Main Warehouse",
                    quantity: item.quantity
                }));

                return { success: true, data: breakdown };
            }

            if (method === "GET") {
                const { data: products } = await sb.from("products").select("*, stock_levels(quantity)");
                const results = (products || []).map(p => {
                    const onHand = (p.stock_levels || []).reduce((acc, curr) => acc + (curr.quantity || 0), 0);
                    return {
                        id: p.id,
                        name: p.name,
                        sku: p.sku,
                        category: p.category,
                        unit_of_measure: p.unit_of_measure,
                        reorder_level: p.reorder_level,
                        created_at: p.created_at,
                        on_hand: onHand
                    };
                });
                return { success: true, data: results };
            }

            if (method === "POST") {
                const { data, error } = await sb.from("products").insert(body).select().single();
                if (error) return { success: false, message: error.message };
                return { success: true, data: { ...data, on_hand: 0 } };
            }

            if (method === "PUT") {
                const id = parseInt(endpoint.split("/").pop());
                const { data, error } = await sb.from("products").update(body).eq("id", id).select().single();
                if (error) return { success: false, message: error.message };
                return { success: true, data };
            }
        }

        // --- 3. Warehouses & Locations ---
        if (endpoint.startsWith("/api/warehouses")) {
            if (method === "GET") {
                const { data: warehouses } = await sb.from("warehouses").select("*, locations(*)");
                return { success: true, data: warehouses || [] };
            }

            if (method === "POST") {
                const { data, error } = await sb.from("warehouses").insert(body).select().single();
                if (error) return { success: false, message: error.message };
                return { success: true, data: { ...data, locations: [] } };
            }

            if (method === "PUT") {
                const id = parseInt(endpoint.split("/").pop());
                const { data, error } = await sb.from("warehouses").update(body).eq("id", id).select().single();
                if (error) return { success: false, message: error.message };
                return { success: true, data };
            }
        }

        if (endpoint === "/api/locations" && method === "POST") {
            const { data, error } = await sb.from("locations").insert(body).select().single();
            if (error) return { success: false, message: error.message };
            return { success: true, data };
        }

        // --- 4. Receipts ---
        if (endpoint.startsWith("/api/receipts")) {
            if (endpoint.endsWith("/validate")) {
                const id = parseInt(endpoint.split("/")[3]);
                const { data: session } = await sb.auth.getSession();
                const userId = session?.session?.user?.id;
                const { data, error } = await sb.rpc("validate_receipt", { p_receipt_id: id, p_user_id: userId });
                if (error) return { success: false, message: error.message };
                return { success: true, data };
            }

            if (endpoint.endsWith("/cancel")) {
                const id = parseInt(endpoint.split("/")[3]);
                const { error } = await sb.from("receipts").update({ status: "cancelled" }).eq("id", id);
                if (error) return { success: false, message: error.message };
                return { success: true, message: "Receipt cancelled" };
            }

            if (method === "GET" && endpoint === "/api/receipts") {
                const { data: receipts } = await sb.from("receipts").select("*, warehouses(name), receipt_lines(count)").order("created_at", { ascending: false });
                const list = (receipts || []).map(r => ({
                    id: r.id,
                    reference: r.reference,
                    supplier: r.supplier,
                    scheduled_date: r.scheduled_date,
                    status: r.status,
                    warehouse_id: r.warehouse_id,
                    warehouse_name: r.warehouses?.name,
                    created_at: r.created_at,
                    line_count: r.receipt_lines?.[0]?.count || 0
                }));
                return { success: true, data: list };
            }

            if (method === "GET" && endpoint.match(/\/api\/receipts\/\d+$/)) {
                const id = parseInt(endpoint.split("/").pop());
                const { data: receipt } = await sb.from("receipts").select("*, warehouses(name), receipt_lines(*, products(name), locations(name))").eq("id", id).single();
                if (!receipt) return { success: false, message: "Receipt not found" };

                const formatted = {
                    id: receipt.id,
                    reference: receipt.reference,
                    supplier: receipt.supplier,
                    scheduled_date: receipt.scheduled_date,
                    status: receipt.status,
                    warehouse_id: receipt.warehouse_id,
                    warehouse_name: receipt.warehouses?.name,
                    created_at: receipt.created_at,
                    lines: (receipt.receipt_lines || []).map(l => ({
                        id: l.id,
                        receipt_id: l.receipt_id,
                        product_id: l.product_id,
                        location_id: l.location_id,
                        quantity: l.quantity,
                        product_name: l.products?.name,
                        location_name: l.locations?.name
                    }))
                };
                return { success: true, data: formatted };
            }

            if (method === "POST") {
                const { lines, ...header } = body;
                if (!header.reference) {
                    const { count } = await sb.from("receipts").select("*", { count: 'exact', head: true });
                    header.reference = `WH/IN/${String((count || 0) + 1).padStart(5, '0')}`;
                }
                const { data: rec, error } = await sb.from("receipts").insert(header).select().single();
                if (error) return { success: false, message: error.message };

                if (lines && lines.length > 0) {
                    const linePayloads = lines.map(l => ({ ...l, receipt_id: rec.id }));
                    await sb.from("receipt_lines").insert(linePayloads);
                }
                return { success: true, data: { id: rec.id } };
            }
        }

        // --- 5. Deliveries ---
        if (endpoint.startsWith("/api/deliveries")) {
            if (endpoint.endsWith("/validate")) {
                const id = parseInt(endpoint.split("/")[3]);
                const { data: session } = await sb.auth.getSession();
                const userId = session?.session?.user?.id;
                const { data, error } = await sb.rpc("validate_delivery", { p_delivery_id: id, p_user_id: userId });
                if (error) return { success: false, message: error.message };
                return { success: true, data };
            }

            if (endpoint.endsWith("/cancel")) {
                const id = parseInt(endpoint.split("/")[3]);
                const { error } = await sb.from("deliveries").update({ status: "cancelled" }).eq("id", id);
                if (error) return { success: false, message: error.message };
                return { success: true, message: "Delivery cancelled" };
            }

            if (method === "GET" && endpoint === "/api/deliveries") {
                const { data: deliveries } = await sb.from("deliveries").select("*, warehouses(name), delivery_lines(count)").order("created_at", { ascending: false });
                const list = (deliveries || []).map(d => ({
                    id: d.id,
                    reference: d.reference,
                    customer: d.customer,
                    scheduled_date: d.scheduled_date,
                    status: d.status,
                    warehouse_id: d.warehouse_id,
                    warehouse_name: d.warehouses?.name,
                    created_at: d.created_at,
                    line_count: d.delivery_lines?.[0]?.count || 0
                }));
                return { success: true, data: list };
            }

            if (method === "GET" && endpoint.match(/\/api\/deliveries\/\d+$/)) {
                const id = parseInt(endpoint.split("/").pop());
                const { data: delivery } = await sb.from("deliveries").select("*, warehouses(name), delivery_lines(*, products(name), locations(name))").eq("id", id).single();
                if (!delivery) return { success: false, message: "Delivery not found" };

                const formatted = {
                    id: delivery.id,
                    reference: delivery.reference,
                    customer: delivery.customer,
                    scheduled_date: delivery.scheduled_date,
                    status: delivery.status,
                    warehouse_id: delivery.warehouse_id,
                    warehouse_name: delivery.warehouses?.name,
                    created_at: delivery.created_at,
                    lines: (delivery.delivery_lines || []).map(l => ({
                        id: l.id,
                        delivery_id: l.delivery_id,
                        product_id: l.product_id,
                        location_id: l.location_id,
                        quantity: l.quantity,
                        product_name: l.products?.name,
                        location_name: l.locations?.name
                    }))
                };
                return { success: true, data: formatted };
            }

            if (method === "POST") {
                const { lines, ...header } = body;
                if (!header.reference) {
                    const { count } = await sb.from("deliveries").select("*", { count: 'exact', head: true });
                    header.reference = `WH/OUT/${String((count || 0) + 1).padStart(5, '0')}`;
                }
                const { data: del, error } = await sb.from("deliveries").insert(header).select().single();
                if (error) return { success: false, message: error.message };

                if (lines && lines.length > 0) {
                    const linePayloads = lines.map(l => ({ ...l, delivery_id: del.id }));
                    await sb.from("delivery_lines").insert(linePayloads);
                }
                return { success: true, data: { id: del.id } };
            }
        }

        // --- 6. Transfers ---
        if (endpoint.startsWith("/api/transfers")) {
            if (endpoint.endsWith("/validate")) {
                const id = parseInt(endpoint.split("/")[3]);
                const { data: session } = await sb.auth.getSession();
                const userId = session?.session?.user?.id;
                const { data, error } = await sb.rpc("validate_transfer", { p_transfer_id: id, p_user_id: userId });
                if (error) return { success: false, message: error.message };
                return { success: true, data };
            }

            if (method === "GET" && endpoint === "/api/transfers") {
                const { data: transfers } = await sb.from("internal_transfers").select("*, internal_transfer_lines(count)").order("created_at", { ascending: false });
                const list = (transfers || []).map(t => ({
                    id: t.id,
                    reference: t.reference,
                    scheduled_date: t.scheduled_date,
                    status: t.status,
                    source_warehouse_id: t.source_warehouse_id,
                    destination_warehouse_id: t.destination_warehouse_id,
                    created_at: t.created_at,
                    line_count: t.internal_transfer_lines?.[0]?.count || 0
                }));
                return { success: true, data: list };
            }
        }

        // --- 7. Adjustments ---
        if (endpoint === "/api/adjustments" && method === "POST") {
            const { data: session } = await sb.auth.getSession();
            const userId = session?.session?.user?.id;
            const { data, error } = await sb.rpc("adjust_stock", {
                p_product_id: body.product_id,
                p_location_id: body.location_id,
                p_new_quantity: body.new_quantity,
                p_reason: body.reason || "Manual adjustment",
                p_user_id: userId
            });
            if (error) return { success: false, message: error.message };
            return { success: true, message: data.message, previous_quantity: data.previous_quantity, new_quantity: data.new_quantity };
        }

        // --- 8. Moves & Logs ---
        if (endpoint === "/api/moves") {
            const { data: moves } = await sb.from("stock_moves").select("*, products(name)").order("created_at", { ascending: false }).limit(100);
            const list = (moves || []).map(m => ({
                id: m.id,
                created_at: m.created_at,
                product_name: m.products?.name,
                quantity: m.quantity,
                move_type: m.move_type,
                reference_id: m.reference_id
            }));
            return { success: true, data: list };
        }

        if (endpoint === "/api/logs") {
            const { data: logs } = await sb.from("operation_logs").select("*, profiles(name)").order("timestamp", { ascending: false }).limit(100);
            const list = (logs || []).map(l => ({
                id: l.id,
                operation_type: l.operation_type,
                operation_id: l.operation_id,
                action: l.action,
                user_name: l.profiles?.name || "System User",
                timestamp: l.timestamp
            }));
            return { success: true, data: list };
        }

        // --- 9. Users / Approvals ---
        if (endpoint === "/api/users/pending") {
            const { data: users } = await sb.from("profiles").select("*").eq("is_approved", false);
            return { success: true, data: users || [] };
        }

        if (endpoint.includes("/approve")) {
            const id = endpoint.split("/")[3];
            const { data, error } = await sb.from("profiles").update({ is_approved: true }).eq("id", id).select().single();
            if (error) return { success: false, message: error.message };
            return { success: true, data, message: "User approved successfully" };
        }

        if (endpoint.includes("/reject")) {
            const id = endpoint.split("/")[3];
            const { error } = await sb.from("profiles").delete().eq("id", id);
            if (error) return { success: false, message: error.message };
            return { success: true, message: "User registration rejected" };
        }

        return { success: true, message: "Request processed" };

    } catch (err) {
        console.error("Supabase API Fetch Error:", err);
        return { success: false, message: err.message || "Network error" };
    }
}

// Global exposure
window.getSupabaseClient = getSupabaseClient;
window.apiFetch = apiFetch;
