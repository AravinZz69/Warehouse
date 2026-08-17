document.addEventListener("DOMContentLoaded", async () => {
    // 1. Load layout shell
    window.loadLayout("Dashboard");

    const spinner = document.getElementById("spinner");
    const statsGrid = document.getElementById("stats-grid");
    const summaryRow = document.getElementById("summary-row");
    const lowStockBanner = document.getElementById("low-stock-banner");
    const bannerText = document.getElementById("banner-text");

    async function loadDashboardStats() {
        try {
            const res = await window.apiFetch("/api/dashboard/stats");

            if (res && res.success) {
                const d = res.data;

                // Populate KPIs
                document.getElementById("kpi-products").textContent = d.total_products;
                document.getElementById("kpi-low-stock").textContent = d.low_stock_count;
                document.getElementById("kpi-out-of-stock").textContent = d.out_of_stock_count;
                document.getElementById("kpi-receipts-pending").textContent = d.pending_receipts;
                document.getElementById("kpi-deliveries-pending").textContent = d.pending_deliveries;

                // Populate Summaries
                document.getElementById("sum-rec-late").textContent = d.late_receipts;
                document.getElementById("sum-rec-operating").textContent = d.operating_receipts;
                document.getElementById("sum-rec-waiting").textContent = d.waiting_receipts;
                document.getElementById("sum-del-late").textContent = d.late_deliveries;
                document.getElementById("sum-del-operating").textContent = d.operating_deliveries;
                document.getElementById("sum-del-waiting").textContent = d.waiting_deliveries;

                // Show Banner if needed
                if (d.low_stock_count > 0 || d.out_of_stock_count > 0) {
                    let msg = [];
                    if (d.out_of_stock_count > 0) msg.push(`⚠️ ${d.out_of_stock_count} item(s) out of stock.`);
                    if (d.low_stock_count > 0) msg.push(`⚠️ ${d.low_stock_count} item(s) running low.`);
                    bannerText.textContent = msg.join(" ");
                    lowStockBanner.style.display = "flex";

                    const bannerLink = document.getElementById("banner-link");
                    if (bannerLink) {
                        bannerLink.href = d.out_of_stock_count > 0
                            ? "products.html?filter=out_of_stock"
                            : "products.html?filter=low_stock";
                    }
                } else {
                    lowStockBanner.style.display = "none";
                }

                // Hide spinner, show content
                spinner.style.display = "none";
                statsGrid.style.display = "grid";
                summaryRow.style.display = "flex";

                // Render Low Stock Products table
                if (d.low_stock_products && d.low_stock_products.length > 0) {
                    const lowStockSection = document.getElementById("low-stock-section");
                    const lowStockTbody = document.getElementById("low-stock-tbody");
                    lowStockSection.style.display = "block";
                    lowStockTbody.innerHTML = "";
                    d.low_stock_products.forEach(p => {
                        const pct = Math.round((p.on_hand / p.reorder_level) * 100);
                        const severity = pct <= 25 ? "#dc2626" : pct <= 50 ? "#ca8a04" : "#f97316";
                        const tr = document.createElement("tr");
                        tr.innerHTML = `
                            <td><a href="product-stock.html?id=${p.id}" style="color:var(--primary); font-weight:600;">${p.name}</a></td>
                            <td style="font-family:monospace; color:var(--text-muted)">${p.sku}</td>
                            <td style="font-weight:bold; color: ${severity}">${p.on_hand}</td>
                            <td>${p.reorder_level}</td>
                            <td><span style="background:${severity}; color:#fff; padding:2px 8px; border-radius:4px; font-size:0.75rem; font-weight:600;">${pct}%</span></td>
                        `;
                        lowStockTbody.appendChild(tr);
                    });
                }

                // RBAC Enforcement
                const userRole = localStorage.getItem("user_role");
                if (userRole !== "manager") {
                    lowStockBanner.style.display = "none";
                    document.getElementById("kpi-out-of-stock").parentElement.style.display = "none";
                    document.getElementById("kpi-receipts-pending").parentElement.style.display = "none";
                    document.getElementById("kpi-deliveries-pending").parentElement.style.display = "none";

                    const dbNewReceiptBtn = document.getElementById("db-new-receipt-btn");
                    if (dbNewReceiptBtn) dbNewReceiptBtn.style.display = "none";

                    const dbNewDeliveryBtn = document.getElementById("db-new-delivery-btn");
                    if (dbNewDeliveryBtn) dbNewDeliveryBtn.style.display = "none";
                }

            } else {
                console.error("Dashboard failed to load stats.");
                spinner.innerHTML = `<p style="color:var(--accent)">Failed to load dashboard data.</p>`;
            }

        } catch (e) {
            console.error(e);
            spinner.innerHTML = `<p style="color:var(--accent)">Connection error.</p>`;
        }
    }

    await loadDashboardStats();

    // Setup Supabase Realtime Subscriptions for live updates without polling
    if (window.supabaseClient) {
        window.supabaseClient
            .channel('dashboard-realtime')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'stock_levels' }, () => loadDashboardStats())
            .on('postgres_changes', { event: '*', schema: 'public', table: 'receipts' }, () => loadDashboardStats())
            .on('postgres_changes', { event: '*', schema: 'public', table: 'deliveries' }, () => loadDashboardStats())
            .on('postgres_changes', { event: '*', schema: 'public', table: 'warehouse_exceptions' }, () => loadDashboardStats())
            .subscribe();
    }
});
