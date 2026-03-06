-- ============================================================
-- HOPE_IRL - Career Support Platform
-- Database Schema (PostgreSQL)
-- ============================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- USERS TABLE (core authentication)
-- ============================================================
CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email           VARCHAR(255) UNIQUE NOT NULL,
    password_hash   TEXT NOT NULL,           -- bcrypt hash, min cost 12
    role            VARCHAR(20) NOT NULL CHECK (role IN ('admin', 'employee', 'client')),
    full_name       VARCHAR(255) NOT NULL,
    phone           VARCHAR(30),
    avatar_url      TEXT,
    is_active       BOOLEAN DEFAULT TRUE,
    is_verified     BOOLEAN DEFAULT FALSE,
    last_login_at   TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_users_email   ON users(email);
CREATE INDEX idx_users_role    ON users(role);

-- ============================================================
-- REFRESH TOKENS (JWT rotation)
-- ============================================================
CREATE TABLE refresh_tokens (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash      TEXT NOT NULL UNIQUE,    -- SHA-256 hash of the token
    expires_at      TIMESTAMPTZ NOT NULL,
    revoked         BOOLEAN DEFAULT FALSE,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_refresh_tokens_user_id ON refresh_tokens(user_id);

-- ============================================================
-- EMAIL VERIFICATION TOKENS
-- ============================================================
CREATE TABLE email_verifications (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token           VARCHAR(64) NOT NULL UNIQUE,
    expires_at      TIMESTAMPTZ NOT NULL,
    used            BOOLEAN DEFAULT FALSE,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- PASSWORD RESET TOKENS
-- ============================================================
CREATE TABLE password_resets (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash      TEXT NOT NULL UNIQUE,
    expires_at      TIMESTAMPTZ NOT NULL,
    used            BOOLEAN DEFAULT FALSE,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- CLIENT PROFILES
-- ============================================================
CREATE TABLE client_profiles (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    nationality     VARCHAR(100),
    current_location VARCHAR(255),
    target_location  VARCHAR(255),          -- e.g. "Dublin, Ireland"
    job_title       VARCHAR(255),           -- desired job title
    years_exp       SMALLINT,
    linkedin_url    TEXT,
    cv_url          TEXT,                   -- stored in S3/Cloudflare R2
    languages       TEXT[],                 -- e.g. ['English','Hindi']
    notes           TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- SUBSCRIPTIONS / SERVICE PLANS
-- ============================================================
CREATE TABLE service_plans (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(50) NOT NULL UNIQUE,   -- 'Basic','Professional','Premium'
    price_eur       NUMERIC(10,2) NOT NULL,
    applications_per_day SMALLINT NOT NULL,
    features        JSONB NOT NULL DEFAULT '{}',
    is_active       BOOLEAN DEFAULT TRUE,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE subscriptions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id       UUID NOT NULL REFERENCES client_profiles(id) ON DELETE CASCADE,
    plan_id         UUID NOT NULL REFERENCES service_plans(id),
    payment_id      UUID,                               -- FK added below after payments table
    status          VARCHAR(20) NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','active','paused','cancelled','expired')),
    starts_at       TIMESTAMPTZ,
    ends_at         TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_subscriptions_client ON subscriptions(client_id);
CREATE INDEX idx_subscriptions_status ON subscriptions(status);

-- ============================================================
-- PAYMENTS
-- ============================================================
CREATE TABLE payments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subscription_id UUID NOT NULL REFERENCES subscriptions(id),
    client_id       UUID NOT NULL REFERENCES client_profiles(id),
    amount_eur      NUMERIC(10,2) NOT NULL,
    currency        VARCHAR(3) DEFAULT 'EUR',
    method          VARCHAR(30) CHECK (method IN ('stripe','paypal','bank_transfer','cash')),
    gateway_ref     TEXT,                   -- Stripe charge ID / PayPal transaction
    status          VARCHAR(20) NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','paid','failed','refunded')),
    paid_at         TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_payments_client    ON payments(client_id);
CREATE INDEX idx_payments_status    ON payments(status);

-- BUG FIX: Add payment_id FK to subscriptions after payments table is created
ALTER TABLE subscriptions ADD CONSTRAINT fk_subscriptions_payment
    FOREIGN KEY (payment_id) REFERENCES payments(id) ON DELETE SET NULL;

-- ============================================================
-- EMPLOYEE PROFILES
-- ============================================================
CREATE TABLE employee_profiles (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    department      VARCHAR(100),
    hire_date       DATE,
    max_clients     SMALLINT DEFAULT 15,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- CLIENT ↔ EMPLOYEE ASSIGNMENTS
-- ============================================================
CREATE TABLE client_assignments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id       UUID NOT NULL REFERENCES client_profiles(id) ON DELETE CASCADE,
    employee_id     UUID NOT NULL REFERENCES employee_profiles(id),
    assigned_at     TIMESTAMPTZ DEFAULT NOW(),
    unassigned_at   TIMESTAMPTZ,
    is_active       BOOLEAN DEFAULT TRUE,
    UNIQUE(client_id, employee_id, is_active)
);

CREATE INDEX idx_assignments_employee ON client_assignments(employee_id);
CREATE INDEX idx_assignments_client   ON client_assignments(client_id);

-- ============================================================
-- JOB APPLICATIONS
-- ============================================================
CREATE TABLE job_applications (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id       UUID NOT NULL REFERENCES client_profiles(id) ON DELETE CASCADE,
    employee_id     UUID REFERENCES employee_profiles(id),
    company_name    VARCHAR(255) NOT NULL,
    job_title       VARCHAR(255) NOT NULL,
    job_url         TEXT,
    location        VARCHAR(255),
    salary_range    VARCHAR(100),
    portal          VARCHAR(100),           -- 'LinkedIn','Indeed','Glassdoor', etc.
    applied_at      DATE NOT NULL DEFAULT CURRENT_DATE,
    status          VARCHAR(20) NOT NULL DEFAULT 'applied'
                        CHECK (status IN ('applied','viewed','interview','offer','rejected','withdrawn')),
    notes           TEXT,
    follow_up_at    DATE,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_applications_client   ON job_applications(client_id);
CREATE INDEX idx_applications_employee ON job_applications(employee_id);
CREATE INDEX idx_applications_status   ON job_applications(status);
CREATE INDEX idx_applications_date     ON job_applications(applied_at);

-- ============================================================
-- INTERVIEW TRACKER
-- ============================================================
CREATE TABLE interviews (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    application_id  UUID NOT NULL REFERENCES job_applications(id) ON DELETE CASCADE,
    round           SMALLINT DEFAULT 1,
    interview_type  VARCHAR(50) CHECK (interview_type IN ('phone','video','onsite','technical','hr')),
    scheduled_at    TIMESTAMPTZ,
    interviewer     VARCHAR(255),
    feedback        TEXT,
    outcome         VARCHAR(20) CHECK (outcome IN ('pending','passed','failed','no_show')),
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- DOCUMENTS (CVs, Cover Letters, etc.)
-- ============================================================
CREATE TABLE documents (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    doc_type        VARCHAR(50) CHECK (doc_type IN ('cv','cover_letter','portfolio','certificate','other')),
    file_name       TEXT NOT NULL,
    storage_path    TEXT NOT NULL,          -- S3/R2 object key
    mime_type       VARCHAR(100),
    size_bytes      BIGINT,
    ats_score       SMALLINT,               -- 0-100
    is_primary      BOOLEAN DEFAULT FALSE,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_documents_user ON documents(user_id);

-- ============================================================
-- NOTIFICATIONS
-- ============================================================
CREATE TABLE notifications (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type            VARCHAR(50) NOT NULL,    -- 'application_update','payment','message', etc.
    title           VARCHAR(255) NOT NULL,
    body            TEXT,
    is_read         BOOLEAN DEFAULT FALSE,
    metadata        JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_notifications_user   ON notifications(user_id);
CREATE INDEX idx_notifications_unread ON notifications(user_id) WHERE is_read = FALSE;

-- ============================================================
-- AUDIT LOG (immutable security trail)
-- ============================================================
CREATE TABLE audit_logs (
    id              BIGSERIAL PRIMARY KEY,
    user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
    action          VARCHAR(100) NOT NULL,   -- 'login','logout','update_profile', etc.
    table_name      VARCHAR(100),
    record_id       TEXT,
    old_values      JSONB,
    new_values      JSONB,
    ip_address      INET,
    user_agent      TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_audit_user    ON audit_logs(user_id);
CREATE INDEX idx_audit_action  ON audit_logs(action);
CREATE INDEX idx_audit_created ON audit_logs(created_at);

-- ============================================================
-- ROW LEVEL SECURITY (RLS) POLICIES
-- ============================================================

ALTER TABLE users               ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_profiles     ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_applications    ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents           ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications       ENABLE ROW LEVEL SECURITY;

-- Users can only see their own profile
CREATE POLICY users_self_select ON users
    FOR SELECT USING (id = current_setting('app.current_user_id')::UUID);

-- Clients see only their own applications
CREATE POLICY apps_client_select ON job_applications
    FOR SELECT USING (
        client_id IN (
            SELECT id FROM client_profiles
            WHERE user_id = current_setting('app.current_user_id')::UUID
        )
    );

-- Employees see only their assigned clients' applications
CREATE POLICY apps_employee_select ON job_applications
    FOR SELECT USING (
        employee_id IN (
            SELECT id FROM employee_profiles
            WHERE user_id = current_setting('app.current_user_id')::UUID
        )
    );

-- ============================================================
-- UPDATED_AT TRIGGER
-- ============================================================
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_client_profiles_updated_at
    BEFORE UPDATE ON client_profiles
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_subscriptions_updated_at
    BEFORE UPDATE ON subscriptions
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_applications_updated_at
    BEFORE UPDATE ON job_applications
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- SEED: Service Plans
-- ============================================================
INSERT INTO service_plans (name, price_eur, applications_per_day, features) VALUES
('Basic',        99.00,  5,  '{"cv_review":false,"cover_letter":false,"ats_check":true,"support":"email"}'),
('Professional', 179.00, 10, '{"cv_review":true,"cover_letter":true,"ats_check":true,"support":"whatsapp"}'),
('Premium',      249.00, 15, '{"cv_review":true,"cover_letter":true,"ats_check":true,"support":"dedicated","linkedin_optimisation":true}');
