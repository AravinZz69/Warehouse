-- Supabase Seed File for CoreInventory

-- 1. Warehouses
INSERT INTO public.warehouses (name, short_code, address) VALUES
    ('Main Warehouse', 'WH-MAIN', '100 Industrial Parkway, Zone 1'),
    ('Annex Logistics Hub', 'WH-ANNEX', '45 Distribution Way, Zone 4')
ON CONFLICT (short_code) DO NOTHING;

-- 2. Locations
INSERT INTO public.locations (name, short_code, warehouse_id) VALUES
    ('Zone A - Shelf 1', 'LOC-A1', 1),
    ('Zone A - Shelf 2', 'LOC-A2', 1),
    ('Zone B - Rack 1', 'LOC-B1', 1),
    ('Annex Bay 1', 'LOC-ANX-1', 2)
ON CONFLICT DO NOTHING;

-- 3. Products
INSERT INTO public.products (name, sku, category, unit_of_measure, reorder_level) VALUES
    ('Ergonomic Wireless Mouse', 'SKU-MOUSE-01', 'Electronics', 'pcs', 10),
    ('Mechanical Gaming Keyboard', 'SKU-KBD-02', 'Electronics', 'pcs', 15),
    ('High-Speed USB-C Cable (2m)', 'SKU-CABLE-03', 'Accessories', 'pcs', 50),
    ('27-Inch 4K UHD Monitor', 'SKU-MON-04', 'Displays', 'pcs', 5)
ON CONFLICT (sku) DO NOTHING;

-- 4. Initial Stock Levels
INSERT INTO public.stock_levels (product_id, location_id, quantity) VALUES
    (1, 1, 45),
    (2, 1, 8),   -- Low stock (reorder level is 15)
    (3, 2, 120),
    (4, 3, 0)    -- Out of stock
ON CONFLICT (product_id, location_id) DO UPDATE SET quantity = EXCLUDED.quantity;

-- 5. Sample Initial Receipt (Draft)
INSERT INTO public.receipts (reference, supplier, scheduled_date, status, warehouse_id) VALUES
    ('WH/IN/00001', 'TechSupplies Co.', CURRENT_DATE + INTERVAL '2 days', 'draft', 1)
ON CONFLICT DO NOTHING;

INSERT INTO public.receipt_lines (receipt_id, product_id, location_id, quantity) VALUES
    (1, 1, 1, 20),
    (1, 2, 1, 30);

-- 6. Sample Initial Delivery (Ready)
INSERT INTO public.deliveries (reference, customer, scheduled_date, status, lifecycle_state, priority_score, warehouse_id) VALUES
    ('WH/OUT/00001', 'Acme Logistics Inc.', CURRENT_DATE + INTERVAL '1 day', 'ready', 'PRIORITIZED', 85, 1)
ON CONFLICT DO NOTHING;

INSERT INTO public.delivery_lines (delivery_id, product_id, location_id, quantity) VALUES
    (1, 3, 2, 10);
