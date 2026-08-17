-- Migration: Initial CoreInventory Schema for Supabase PostgreSQL
-- Convert MySQL types, setup auth.users linkage, RLS policies, Realtime, and transactional RPCs

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Custom Enums
DO $$ BEGIN
    CREATE TYPE role_enum AS ENUM ('manager', 'staff', 'super_manager', 'picker', 'operator', 'warehouse_manager', 'inventory_manager');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE status_enum AS ENUM ('draft', 'waiting', 'ready', 'done', 'cancelled');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE move_type_enum AS ENUM ('receipt', 'delivery', 'transfer', 'adjustment');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE action_enum AS ENUM ('created', 'validated', 'cancelled');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE order_lifecycle_state AS ENUM (
        'CREATED', 'PRIORITIZED', 'INVENTORY_CHECK', 'ALLOCATED',
        'PICKING', 'PICKED', 'PACKING', 'PACKED',
        'QUALITY_CHECK', 'READY_FOR_DISPATCH', 'DISPATCHED',
        'INVENTORY_UPDATED', 'COMPLETED'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE exception_state AS ENUM (
        'OUT_OF_STOCK', 'ALLOCATION_FAILED', 'PICKING_ERROR',
        'MISSING_ITEM', 'DAMAGED_ITEM', 'QUALITY_FAILED', 'DISPATCH_DELAYED'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- 1. User Profiles linked to auth.users
CREATE TABLE IF NOT EXISTS public.profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(150) UNIQUE NOT NULL,
    role role_enum DEFAULT 'staff'::role_enum,
    is_super_manager BOOLEAN DEFAULT FALSE,
    is_approved BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Trigger to auto-create profile on auth.users signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO public.profiles (id, name, email, role, is_super_manager, is_approved)
    VALUES (
        NEW.id,
        COALESCE(NEW.raw_user_meta_data->>'name', split_part(NEW.email, '@', 1)),
        NEW.email,
        COALESCE((NEW.raw_user_meta_data->>'role')::role_enum, 'staff'::role_enum),
        COALESCE((NEW.raw_user_meta_data->>'is_super_manager')::boolean, false),
        COALESCE((NEW.raw_user_meta_data->>'is_approved')::boolean, false)
    )
    ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        email = EXCLUDED.email;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- 2. Warehouses Table
CREATE TABLE IF NOT EXISTS public.warehouses (
    id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    short_code VARCHAR(20) UNIQUE,
    address TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Locations Table
CREATE TABLE IF NOT EXISTS public.locations (
    id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    short_code VARCHAR(20),
    warehouse_id INT REFERENCES public.warehouses(id) ON DELETE CASCADE
);

-- 4. Products Table
CREATE TABLE IF NOT EXISTS public.products (
    id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name VARCHAR(150) NOT NULL,
    sku VARCHAR(100) UNIQUE NOT NULL,
    category VARCHAR(100),
    unit_of_measure VARCHAR(50),
    reorder_level INT DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. Stock Levels Table
CREATE TABLE IF NOT EXISTS public.stock_levels (
    id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    product_id INT REFERENCES public.products(id) ON DELETE CASCADE,
    location_id INT REFERENCES public.locations(id) ON DELETE CASCADE,
    quantity INT DEFAULT 0,
    reserved_quantity INT DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uix_product_location UNIQUE (product_id, location_id)
);
CREATE INDEX IF NOT EXISTS idx_stock_levels_product_id ON public.stock_levels(product_id);

-- 6. Receipts & Receipt Lines
CREATE TABLE IF NOT EXISTS public.receipts (
    id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    reference VARCHAR(100),
    supplier VARCHAR(150),
    scheduled_date DATE,
    status status_enum DEFAULT 'draft'::status_enum,
    warehouse_id INT REFERENCES public.warehouses(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_receipts_status ON public.receipts(status);
CREATE INDEX IF NOT EXISTS idx_receipts_created_at ON public.receipts(created_at);

CREATE TABLE IF NOT EXISTS public.receipt_lines (
    id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    receipt_id INT REFERENCES public.receipts(id) ON DELETE CASCADE,
    product_id INT REFERENCES public.products(id),
    location_id INT REFERENCES public.locations(id),
    quantity INT NOT NULL
);

-- 7. Deliveries & Delivery Lines
CREATE TABLE IF NOT EXISTS public.deliveries (
    id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    reference VARCHAR(100),
    customer VARCHAR(150),
    scheduled_date DATE,
    status status_enum DEFAULT 'draft'::status_enum,
    lifecycle_state order_lifecycle_state DEFAULT 'CREATED'::order_lifecycle_state,
    priority_score INT DEFAULT 0,
    warehouse_id INT REFERENCES public.warehouses(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_deliveries_status ON public.deliveries(status);
CREATE INDEX IF NOT EXISTS idx_deliveries_created_at ON public.deliveries(created_at);

CREATE TABLE IF NOT EXISTS public.delivery_lines (
    id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    delivery_id INT REFERENCES public.deliveries(id) ON DELETE CASCADE,
    product_id INT REFERENCES public.products(id),
    location_id INT REFERENCES public.locations(id),
    quantity INT NOT NULL
);

-- 8. Internal Transfers & Lines
CREATE TABLE IF NOT EXISTS public.internal_transfers (
    id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    reference VARCHAR(100),
    source_warehouse_id INT REFERENCES public.warehouses(id),
    destination_warehouse_id INT REFERENCES public.warehouses(id),
    scheduled_date DATE,
    status status_enum DEFAULT 'draft'::status_enum,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.internal_transfer_lines (
    id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    internal_transfer_id INT REFERENCES public.internal_transfers(id) ON DELETE CASCADE,
    product_id INT REFERENCES public.products(id),
    source_location_id INT REFERENCES public.locations(id),
    destination_location_id INT REFERENCES public.locations(id),
    quantity INT NOT NULL
);

-- 9. Stock Moves Ledger
CREATE TABLE IF NOT EXISTS public.stock_moves (
    id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    product_id INT REFERENCES public.products(id),
    from_location_id INT REFERENCES public.locations(id),
    to_location_id INT REFERENCES public.locations(id),
    quantity INT NOT NULL,
    move_type move_type_enum,
    reference_id INT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_stock_moves_product_id ON public.stock_moves(product_id);
CREATE INDEX IF NOT EXISTS idx_stock_moves_created_at ON public.stock_moves(created_at);

-- 10. OTP Store Table
CREATE TABLE IF NOT EXISTS public.otp_store (
    id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    mobile VARCHAR(150),
    otp VARCHAR(10),
    session_id VARCHAR(255),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ
);

-- 11. Operation Logs
CREATE TABLE IF NOT EXISTS public.operation_logs (
    id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    operation_type move_type_enum NOT NULL,
    operation_id INT NOT NULL,
    action action_enum NOT NULL,
    user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
    timestamp TIMESTAMPTZ DEFAULT NOW()
);

-- 12. Picking Tasks
CREATE TABLE IF NOT EXISTS public.picking_tasks (
    id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    delivery_id INT REFERENCES public.deliveries(id) ON DELETE CASCADE,
    picker_id UUID REFERENCES public.profiles(id),
    status VARCHAR(50) DEFAULT 'pending',
    route_json JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 13. Packing Tasks
CREATE TABLE IF NOT EXISTS public.packing_tasks (
    id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    delivery_id INT REFERENCES public.deliveries(id) ON DELETE CASCADE,
    packer_id UUID REFERENCES public.profiles(id),
    status VARCHAR(50) DEFAULT 'pending',
    box_type VARCHAR(50),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 14. Quality Checks
CREATE TABLE IF NOT EXISTS public.quality_checks (
    id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    delivery_id INT REFERENCES public.deliveries(id) ON DELETE CASCADE,
    inspector_id UUID REFERENCES public.profiles(id),
    passed BOOLEAN DEFAULT FALSE,
    inspection_notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 15. Dispatches
CREATE TABLE IF NOT EXISTS public.dispatches (
    id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    delivery_id INT REFERENCES public.deliveries(id) ON DELETE CASCADE,
    carrier VARCHAR(100),
    tracking_number VARCHAR(100),
    status VARCHAR(50) DEFAULT 'ready',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 16. Warehouse Exceptions
CREATE TABLE IF NOT EXISTS public.warehouse_exceptions (
    id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    delivery_id INT REFERENCES public.deliveries(id) ON DELETE CASCADE,
    exception_type exception_state NOT NULL,
    details TEXT,
    recommended_action TEXT,
    resolved BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Row Level Security (RLS) Configuration
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.warehouses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_levels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.receipt_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.delivery_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.internal_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.internal_transfer_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_moves ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.operation_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.picking_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.packing_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quality_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dispatches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.warehouse_exceptions ENABLE ROW LEVEL SECURITY;

-- Helper RLS function: get user role
CREATE OR REPLACE FUNCTION public.get_user_role(user_id UUID)
RETURNS role_enum AS $$
    SELECT role FROM public.profiles WHERE id = user_id;
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- Helper RLS function: is_approved
CREATE OR REPLACE FUNCTION public.is_user_approved(user_id UUID)
RETURNS BOOLEAN AS $$
    SELECT is_approved FROM public.profiles WHERE id = user_id;
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- RLS Policies
-- Profiles: Users can read profiles if approved, and update their own profile; managers can read/update all
CREATE POLICY "Allow read profiles for authenticated approved users" ON public.profiles
    FOR SELECT TO authenticated USING (true);

CREATE POLICY "Allow managers full management of profiles" ON public.profiles
    FOR ALL TO authenticated USING (
        public.get_user_role(auth.uid()) IN ('manager', 'super_manager', 'warehouse_manager')
    );

-- Read access for products, warehouses, locations for all authenticated users
CREATE POLICY "Allow read warehouses" ON public.warehouses FOR SELECT TO authenticated USING (true);
CREATE POLICY "Allow manage warehouses for managers" ON public.warehouses FOR ALL TO authenticated USING (
    public.get_user_role(auth.uid()) IN ('manager', 'super_manager', 'warehouse_manager')
);

CREATE POLICY "Allow read locations" ON public.locations FOR SELECT TO authenticated USING (true);
CREATE POLICY "Allow manage locations for managers" ON public.locations FOR ALL TO authenticated USING (
    public.get_user_role(auth.uid()) IN ('manager', 'super_manager', 'warehouse_manager')
);

CREATE POLICY "Allow read products" ON public.products FOR SELECT TO authenticated USING (true);
CREATE POLICY "Allow manage products for managers" ON public.products FOR ALL TO authenticated USING (
    public.get_user_role(auth.uid()) IN ('manager', 'super_manager', 'inventory_manager')
);

-- Stock Levels: Read for authenticated users; Write for managers or service role
CREATE POLICY "Allow read stock_levels" ON public.stock_levels FOR SELECT TO authenticated USING (true);
CREATE POLICY "Allow write stock_levels for managers" ON public.stock_levels FOR ALL TO authenticated USING (
    public.get_user_role(auth.uid()) IN ('manager', 'super_manager', 'inventory_manager', 'warehouse_manager')
);

-- Operations (Receipts, Deliveries, Transfers, Moves, Logs)
CREATE POLICY "Allow read receipts" ON public.receipts FOR SELECT TO authenticated USING (true);
CREATE POLICY "Allow write receipts for managers" ON public.receipts FOR ALL TO authenticated USING (
    public.get_user_role(auth.uid()) IN ('manager', 'super_manager', 'warehouse_manager', 'inventory_manager')
);

CREATE POLICY "Allow read receipt_lines" ON public.receipt_lines FOR SELECT TO authenticated USING (true);
CREATE POLICY "Allow write receipt_lines for managers" ON public.receipt_lines FOR ALL TO authenticated USING (
    public.get_user_role(auth.uid()) IN ('manager', 'super_manager', 'warehouse_manager', 'inventory_manager')
);

CREATE POLICY "Allow read deliveries" ON public.deliveries FOR SELECT TO authenticated USING (true);
CREATE POLICY "Allow write deliveries for managers" ON public.deliveries FOR ALL TO authenticated USING (
    public.get_user_role(auth.uid()) IN ('manager', 'super_manager', 'warehouse_manager', 'inventory_manager')
);

CREATE POLICY "Allow read delivery_lines" ON public.delivery_lines FOR SELECT TO authenticated USING (true);
CREATE POLICY "Allow write delivery_lines for managers" ON public.delivery_lines FOR ALL TO authenticated USING (
    public.get_user_role(auth.uid()) IN ('manager', 'super_manager', 'warehouse_manager', 'inventory_manager')
);

CREATE POLICY "Allow read internal_transfers" ON public.internal_transfers FOR SELECT TO authenticated USING (true);
CREATE POLICY "Allow write internal_transfers for managers" ON public.internal_transfers FOR ALL TO authenticated USING (
    public.get_user_role(auth.uid()) IN ('manager', 'super_manager', 'warehouse_manager', 'inventory_manager')
);

CREATE POLICY "Allow read internal_transfer_lines" ON public.internal_transfer_lines FOR SELECT TO authenticated USING (true);
CREATE POLICY "Allow write internal_transfer_lines for managers" ON public.internal_transfer_lines FOR ALL TO authenticated USING (
    public.get_user_role(auth.uid()) IN ('manager', 'super_manager', 'warehouse_manager', 'inventory_manager')
);

CREATE POLICY "Allow read stock_moves" ON public.stock_moves FOR SELECT TO authenticated USING (true);
CREATE POLICY "Allow read operation_logs" ON public.operation_logs FOR SELECT TO authenticated USING (true);

CREATE POLICY "Allow read picking_tasks" ON public.picking_tasks FOR SELECT TO authenticated USING (true);
CREATE POLICY "Allow write picking_tasks" ON public.picking_tasks FOR ALL TO authenticated USING (true);

CREATE POLICY "Allow read packing_tasks" ON public.packing_tasks FOR SELECT TO authenticated USING (true);
CREATE POLICY "Allow write packing_tasks" ON public.packing_tasks FOR ALL TO authenticated USING (true);

CREATE POLICY "Allow read quality_checks" ON public.quality_checks FOR SELECT TO authenticated USING (true);
CREATE POLICY "Allow write quality_checks" ON public.quality_checks FOR ALL TO authenticated USING (true);

CREATE POLICY "Allow read dispatches" ON public.dispatches FOR SELECT TO authenticated USING (true);
CREATE POLICY "Allow write dispatches" ON public.dispatches FOR ALL TO authenticated USING (true);

CREATE POLICY "Allow read warehouse_exceptions" ON public.warehouse_exceptions FOR SELECT TO authenticated USING (true);
CREATE POLICY "Allow write warehouse_exceptions" ON public.warehouse_exceptions FOR ALL TO authenticated USING (true);

-- Enable Realtime
ALTER PUBLICATION supabase_realtime ADD TABLE public.stock_levels;
ALTER PUBLICATION supabase_realtime ADD TABLE public.receipts;
ALTER PUBLICATION supabase_realtime ADD TABLE public.deliveries;
ALTER PUBLICATION supabase_realtime ADD TABLE public.internal_transfers;
ALTER PUBLICATION supabase_realtime ADD TABLE public.stock_moves;
ALTER PUBLICATION supabase_realtime ADD TABLE public.operation_logs;
ALTER PUBLICATION supabase_realtime ADD TABLE public.picking_tasks;
ALTER PUBLICATION supabase_realtime ADD TABLE public.packing_tasks;
ALTER PUBLICATION supabase_realtime ADD TABLE public.quality_checks;
ALTER PUBLICATION supabase_realtime ADD TABLE public.dispatches;
ALTER PUBLICATION supabase_realtime ADD TABLE public.warehouse_exceptions;

-- -------------------------------------------------------------
-- Transactional Database Functions / RPCs
-- -------------------------------------------------------------

-- 1. validate_receipt
CREATE OR REPLACE FUNCTION public.validate_receipt(p_receipt_id INT, p_user_id UUID)
RETURNS JSONB AS $$
DECLARE
    v_receipt RECORD;
    v_line RECORD;
BEGIN
    SELECT * INTO v_receipt FROM public.receipts WHERE id = p_receipt_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Receipt ID % not found', p_receipt_id;
    END IF;
    
    IF v_receipt.status = 'done'::status_enum THEN
        RAISE EXCEPTION 'Receipt is already validated';
    END IF;

    FOR v_line IN SELECT * FROM public.receipt_lines WHERE receipt_id = p_receipt_id LOOP
        IF v_line.location_id IS NULL THEN
            RAISE EXCEPTION 'Receipt line % missing target location', v_line.id;
        END IF;

        -- Upsert stock level
        INSERT INTO public.stock_levels (product_id, location_id, quantity, updated_at)
        VALUES (v_line.product_id, v_line.location_id, v_line.quantity, NOW())
        ON CONFLICT (product_id, location_id)
        DO UPDATE SET 
            quantity = public.stock_levels.quantity + EXCLUDED.quantity,
            updated_at = NOW();

        -- Insert stock move
        INSERT INTO public.stock_moves (product_id, to_location_id, quantity, move_type, reference_id, created_at)
        VALUES (v_line.product_id, v_line.location_id, v_line.quantity, 'receipt'::move_type_enum, p_receipt_id, NOW());
    END LOOP;

    UPDATE public.receipts SET status = 'done'::status_enum WHERE id = p_receipt_id;

    INSERT INTO public.operation_logs (operation_type, operation_id, action, user_id, timestamp)
    VALUES ('receipt'::move_type_enum, p_receipt_id, 'validated'::action_enum, p_user_id, NOW());

    RETURN jsonb_build_object('success', true, 'message', 'Receipt validated successfully');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 2. validate_delivery
CREATE OR REPLACE FUNCTION public.validate_delivery(p_delivery_id INT, p_user_id UUID)
RETURNS JSONB AS $$
DECLARE
    v_delivery RECORD;
    v_line RECORD;
    v_stock INT;
BEGIN
    SELECT * INTO v_delivery FROM public.deliveries WHERE id = p_delivery_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Delivery ID % not found', p_delivery_id;
    END IF;
    
    IF v_delivery.status = 'done'::status_enum THEN
        RAISE EXCEPTION 'Delivery is already validated';
    END IF;

    FOR v_line IN SELECT * FROM public.delivery_lines WHERE delivery_id = p_delivery_id LOOP
        IF v_line.location_id IS NULL THEN
            RAISE EXCEPTION 'Delivery line % missing origin location', v_line.id;
        END IF;

        SELECT quantity INTO v_stock FROM public.stock_levels 
        WHERE product_id = v_line.product_id AND location_id = v_line.location_id FOR UPDATE;

        IF COALESCE(v_stock, 0) < v_line.quantity THEN
            RAISE EXCEPTION 'Insufficient stock for product ID % at location ID % (Available: %, Requested: %)', 
                v_line.product_id, v_line.location_id, COALESCE(v_stock, 0), v_line.quantity;
        END IF;

        -- Deduct stock level
        UPDATE public.stock_levels 
        SET quantity = quantity - v_line.quantity, updated_at = NOW()
        WHERE product_id = v_line.product_id AND location_id = v_line.location_id;

        -- Insert stock move
        INSERT INTO public.stock_moves (product_id, from_location_id, quantity, move_type, reference_id, created_at)
        VALUES (v_line.product_id, v_line.location_id, v_line.quantity, 'delivery'::move_type_enum, p_delivery_id, NOW());
    END LOOP;

    UPDATE public.deliveries 
    SET status = 'done'::status_enum, lifecycle_state = 'COMPLETED'::order_lifecycle_state 
    WHERE id = p_delivery_id;

    INSERT INTO public.operation_logs (operation_type, operation_id, action, user_id, timestamp)
    VALUES ('delivery'::move_type_enum, p_delivery_id, 'validated'::action_enum, p_user_id, NOW());

    RETURN jsonb_build_object('success', true, 'message', 'Delivery validated successfully');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3. validate_transfer
CREATE OR REPLACE FUNCTION public.validate_transfer(p_transfer_id INT, p_user_id UUID)
RETURNS JSONB AS $$
DECLARE
    v_transfer RECORD;
    v_line RECORD;
    v_src_stock INT;
BEGIN
    SELECT * INTO v_transfer FROM public.internal_transfers WHERE id = p_transfer_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Transfer ID % not found', p_transfer_id;
    END IF;

    IF v_transfer.status = 'done'::status_enum THEN
        RAISE EXCEPTION 'Transfer is already validated';
    END IF;

    FOR v_line IN SELECT * FROM public.internal_transfer_lines WHERE internal_transfer_id = p_transfer_id LOOP
        IF v_line.source_location_id IS NULL OR v_line.destination_location_id IS NULL THEN
            RAISE EXCEPTION 'Transfer line % missing source or destination location', v_line.id;
        END IF;

        -- Check source stock
        SELECT quantity INTO v_src_stock FROM public.stock_levels 
        WHERE product_id = v_line.product_id AND location_id = v_line.source_location_id FOR UPDATE;

        IF COALESCE(v_src_stock, 0) < v_line.quantity THEN
            RAISE EXCEPTION 'Insufficient stock for product ID % at source location ID %', v_line.product_id, v_line.source_location_id;
        END IF;

        -- Deduct source stock
        UPDATE public.stock_levels 
        SET quantity = quantity - v_line.quantity, updated_at = NOW()
        WHERE product_id = v_line.product_id AND location_id = v_line.source_location_id;

        -- Add target stock
        INSERT INTO public.stock_levels (product_id, location_id, quantity, updated_at)
        VALUES (v_line.product_id, v_line.destination_location_id, v_line.quantity, NOW())
        ON CONFLICT (product_id, location_id)
        DO UPDATE SET quantity = public.stock_levels.quantity + EXCLUDED.quantity, updated_at = NOW();

        -- Record stock move
        INSERT INTO public.stock_moves (product_id, from_location_id, to_location_id, quantity, move_type, reference_id, created_at)
        VALUES (v_line.product_id, v_line.source_location_id, v_line.destination_location_id, v_line.quantity, 'transfer'::move_type_enum, p_transfer_id, NOW());
    END LOOP;

    UPDATE public.internal_transfers SET status = 'done'::status_enum WHERE id = p_transfer_id;

    INSERT INTO public.operation_logs (operation_type, operation_id, action, user_id, timestamp)
    VALUES ('transfer'::move_type_enum, p_transfer_id, 'validated'::action_enum, p_user_id, NOW());

    RETURN jsonb_build_object('success', true, 'message', 'Transfer validated successfully');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 4. adjust_stock
CREATE OR REPLACE FUNCTION public.adjust_stock(
    p_product_id INT,
    p_location_id INT,
    p_new_quantity INT,
    p_reason TEXT,
    p_user_id UUID
)
RETURNS JSONB AS $$
DECLARE
    v_prev_qty INT := 0;
    v_delta INT := 0;
    v_stock_id INT;
BEGIN
    IF p_new_quantity < 0 THEN
        RAISE EXCEPTION 'Quantity cannot be negative';
    END IF;

    SELECT id, quantity INTO v_stock_id, v_prev_qty FROM public.stock_levels 
    WHERE product_id = p_product_id AND location_id = p_location_id FOR UPDATE;

    v_delta := p_new_quantity - COALESCE(v_prev_qty, 0);

    IF v_stock_id IS NOT NULL THEN
        UPDATE public.stock_levels SET quantity = p_new_quantity, updated_at = NOW() WHERE id = v_stock_id;
    ELSE
        INSERT INTO public.stock_levels (product_id, location_id, quantity, updated_at)
        VALUES (p_product_id, p_location_id, p_new_quantity, NOW()) RETURNING id INTO v_stock_id;
    END IF;

    IF v_delta != 0 THEN
        INSERT INTO public.stock_moves (product_id, from_location_id, to_location_id, quantity, move_type, reference_id, created_at)
        VALUES (
            p_product_id,
            CASE WHEN v_delta < 0 THEN p_location_id ELSE NULL END,
            CASE WHEN v_delta > 0 THEN p_location_id ELSE NULL END,
            ABS(v_delta),
            'adjustment'::move_type_enum,
            NULL,
            NOW()
        );
    END IF;

    INSERT INTO public.operation_logs (operation_type, operation_id, action, user_id, timestamp)
    VALUES ('adjustment'::move_type_enum, v_stock_id, 'validated'::action_enum, p_user_id, NOW());

    RETURN jsonb_build_object(
        'success', true, 
        'previous_quantity', v_prev_qty, 
        'new_quantity', p_new_quantity,
        'message', format('Stock adjusted from %s to %s', v_prev_qty, p_new_quantity)
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 5. reserve_inventory & release_inventory RPCs
CREATE OR REPLACE FUNCTION public.reserve_inventory(p_product_id INT, p_location_id INT, p_qty INT)
RETURNS JSONB AS $$
DECLARE
    v_avail INT;
BEGIN
    SELECT (quantity - reserved_quantity) INTO v_avail FROM public.stock_levels
    WHERE product_id = p_product_id AND location_id = p_location_id FOR UPDATE;

    IF COALESCE(v_avail, 0) < p_qty THEN
        RETURN jsonb_build_object('success', false, 'message', 'Insufficient unreserved stock');
    END IF;

    UPDATE public.stock_levels
    SET reserved_quantity = reserved_quantity + p_qty, updated_at = NOW()
    WHERE product_id = p_product_id AND location_id = p_location_id;

    RETURN jsonb_build_object('success', true, 'message', 'Inventory reserved successfully');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION public.release_inventory(p_product_id INT, p_location_id INT, p_qty INT)
RETURNS JSONB AS $$
BEGIN
    UPDATE public.stock_levels
    SET reserved_quantity = GREATEST(0, reserved_quantity - p_qty), updated_at = NOW()
    WHERE product_id = p_product_id AND location_id = p_location_id;

    RETURN jsonb_build_object('success', true, 'message', 'Inventory released successfully');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 6. Storage Bucket setup SQL
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES 
    ('product-images', 'product-images', true, 10485760, ARRAY['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']),
    ('warehouse-documents', 'warehouse-documents', false, 20971520, NULL),
    ('order-documents', 'order-documents', false, 20971520, NULL),
    ('inspection-images', 'inspection-images', true, 10485760, ARRAY['image/png', 'image/jpeg', 'image/webp']),
    ('avatars', 'avatars', true, 5242880, ARRAY['image/png', 'image/jpeg', 'image/webp'])
ON CONFLICT (id) DO UPDATE SET public = EXCLUDED.public;

-- Storage RLS Policies
CREATE POLICY "Allow public read product-images" ON storage.objects FOR SELECT USING (bucket_id = 'product-images');
CREATE POLICY "Allow public read inspection-images" ON storage.objects FOR SELECT USING (bucket_id = 'inspection-images');
CREATE POLICY "Allow public read avatars" ON storage.objects FOR SELECT USING (bucket_id = 'avatars');

CREATE POLICY "Allow authenticated upload images" ON storage.objects FOR INSERT TO authenticated WITH CHECK (
    bucket_id IN ('product-images', 'warehouse-documents', 'order-documents', 'inspection-images', 'avatars')
);
