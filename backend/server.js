// ============================================================
// HOPE_IRL Backend API — server.js
// Stack: Node.js + Express + PostgreSQL + JWT
// ============================================================
require('dotenv').config();


const express        = require('express');
const helmet         = require('helmet');
const cors           = require('cors');
const rateLimit      = require('express-rate-limit');
const { Pool }       = require('pg');
const bcrypt         = require('bcrypt');
const jwt            = require('jsonwebtoken');
const crypto         = require('crypto');
const { z }          = require('zod');

const app  = express();
const PORT = process.env.PORT || 3001;

// ──────────────────────────────────────────────────────────────
// 1. DATABASE POOL
// ──────────────────────────────────────────────────────────────
const db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: false,
    max:             10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
});

// Test connection on startup
db.connect()
    .then(client => { client.release(); console.log('✅ Database connected'); })
    .catch(err   => { console.error('❌ DB connection failed:', err.message); process.exit(1); });

// ──────────────────────────────────────────────────────────────
// 2. SECURITY MIDDLEWARE
// ──────────────────────────────────────────────────────────────

// Helmet: sets secure HTTP headers
app.use(helmet());

// CORS — restrict to your frontend domain in production
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000').split(',');
app.use(cors({
    origin: (origin, cb) => {
        // Allow requests with no origin (file://, curl, Postman) in development
        if (!origin) {
            if (process.env.NODE_ENV !== 'production') return cb(null, true);
            return cb(new Error('CORS blocked: no origin'));
        }
        if (allowedOrigins.includes(origin)) return cb(null, true);
        return cb(new Error(`CORS blocked: ${origin}`));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
}));

// Parse JSON with size limit
app.use(express.json({ limit: '16kb' }));

// Global rate limiter — 100 req / 15 min per IP
const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please slow down.' },
});
app.use(globalLimiter);

// Stricter limiter for auth endpoints — 10 req / 15 min
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { error: 'Too many login attempts. Try again later.' },
});

// ──────────────────────────────────────────────────────────────
// 3. HELPERS
// ──────────────────────────────────────────────────────────────
const BCRYPT_ROUNDS  = 12;
const JWT_ACCESS_TTL = '15m';
const JWT_REFRESH_TTL = 7 * 24 * 60 * 60; // 7 days in seconds

function signAccessToken(payload) {
    return jwt.sign(payload, process.env.JWT_ACCESS_SECRET, { expiresIn: JWT_ACCESS_TTL });
}

function signRefreshToken(payload) {
    return jwt.sign(payload, process.env.JWT_REFRESH_SECRET, { expiresIn: JWT_REFRESH_TTL });
}

function sha256(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
}

// Write to audit log (non-blocking)
async function audit(userId, action, meta = {}) {
    try {
        await db.query(
            `INSERT INTO audit_logs (user_id, action, table_name, record_id, new_values, ip_address)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [userId, action, meta.table || null, meta.recordId || null,
             meta.data ? JSON.stringify(meta.data) : null, meta.ip || null]
        );
    } catch (_) { /* don't crash on audit failure */ }
}

// ──────────────────────────────────────────────────────────────
// 4. VALIDATION SCHEMAS (Zod)
// ──────────────────────────────────────────────────────────────
const RegisterSchema = z.object({
    full_name: z.string().min(2).max(255),
    email:     z.string().email().toLowerCase(),
    password:  z.string().min(8).max(72)
                 .regex(/[A-Z]/, 'Must contain uppercase')
                 .regex(/[0-9]/, 'Must contain a number')
                 .regex(/[^A-Za-z0-9]/, 'Must contain special char'),
    role:      z.enum(['client', 'employee']).default('client'),
    phone:     z.string().optional(),
});

const LoginSchema = z.object({
    email:    z.string().email().toLowerCase(),
    password: z.string().min(1),
});

const ApplicationSchema = z.object({
    company_name: z.string().min(1).max(255),
    job_title:    z.string().min(1).max(255),
    job_url:      z.string().url().optional().or(z.literal('')),
    location:     z.string().max(255).optional(),
    salary_range: z.string().max(100).optional(),
    portal:       z.string().max(100).optional(),
    notes:        z.string().max(2000).optional(),
    status:       z.enum(['applied','viewed','interview','offer','rejected','withdrawn']).default('applied'),
});

// ──────────────────────────────────────────────────────────────
// 5. AUTH MIDDLEWARE
// ──────────────────────────────────────────────────────────────
function requireAuth(roles = []) {
    return async (req, res, next) => {
        const authHeader = req.headers.authorization;
        if (!authHeader?.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'No token provided' });
        }
        const token = authHeader.split(' ')[1];
        try {
            const payload = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
            req.user = payload;

            if (roles.length > 0 && !roles.includes(payload.role)) {
                return res.status(403).json({ error: 'Insufficient permissions' });
            }

            // Set RLS context for PostgreSQL (session-level, since pool queries aren't in a shared transaction)
            await db.query(`SET app.current_user_id = '${payload.sub}'`);
            next();
        } catch (err) {
            if (err.name === 'TokenExpiredError') {
                return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
            }
            return res.status(401).json({ error: 'Invalid token' });
        }
    };
}

// ──────────────────────────────────────────────────────────────
// 6. AUTH ROUTES
// ──────────────────────────────────────────────────────────────

// POST /api/auth/register
app.post('/api/auth/register', authLimiter, async (req, res) => {
    try {
        const data = RegisterSchema.parse(req.body);

        // Check duplicate email
        const existing = await db.query('SELECT id FROM users WHERE email = $1', [data.email]);
        if (existing.rowCount > 0) {
            return res.status(409).json({ error: 'Email already registered' });
        }

        // Hash password
        const password_hash = await bcrypt.hash(data.password, BCRYPT_ROUNDS);

        // Insert user
        const { rows } = await db.query(
            `INSERT INTO users (full_name, email, password_hash, role, phone)
             VALUES ($1,$2,$3,$4,$5) RETURNING id, role, full_name, email`,
            [data.full_name, data.email, password_hash, data.role, data.phone || null]
        );
        const user = rows[0];

        // Create role profile
        if (data.role === 'client') {
            await db.query('INSERT INTO client_profiles (user_id) VALUES ($1)', [user.id]);
        } else if (data.role === 'employee') {
            await db.query('INSERT INTO employee_profiles (user_id) VALUES ($1)', [user.id]);
        }

        await audit(user.id, 'register', { ip: req.ip });

        return res.status(201).json({ message: 'Registration successful', userId: user.id });
    } catch (err) {
        if (err instanceof z.ZodError) {
            return res.status(422).json({ error: 'Validation failed', details: err.errors });
        }
        console.error('Register error:', err.message);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/auth/login
app.post('/api/auth/login', authLimiter, async (req, res) => {
    try {
        const { email, password } = LoginSchema.parse(req.body);

        const { rows } = await db.query(
            'SELECT id, email, password_hash, role, full_name, is_active FROM users WHERE email = $1',
            [email]
        );

        // Constant-time comparison to prevent user enumeration
        const user = rows[0];
        const dummyHash = '$2b$12$invalidhashfortimingprotection00000000000000000000000';
        const passwordMatch = await bcrypt.compare(password, user?.password_hash || dummyHash);

        if (!user || !passwordMatch) {
            await audit(null, 'login_failed', { ip: req.ip, data: { email } });
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        if (!user.is_active) {
            return res.status(403).json({ error: 'Account is deactivated' });
        }

        // Generate tokens
        const accessToken  = signAccessToken({ sub: user.id, role: user.role, name: user.full_name });
        const refreshToken = signRefreshToken({ sub: user.id });

        // Store hashed refresh token
        const expiresAt = new Date(Date.now() + JWT_REFRESH_TTL * 1000);
        await db.query(
            'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1,$2,$3)',
            [user.id, sha256(refreshToken), expiresAt]
        );

        // Update last login
        await db.query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);
        await audit(user.id, 'login', { ip: req.ip });

        return res.json({
            accessToken,
            refreshToken,
            user: { id: user.id, name: user.full_name, email: user.email, role: user.role },
        });
    } catch (err) {
        if (err instanceof z.ZodError) {
            return res.status(422).json({ error: 'Validation failed', details: err.errors });
        }
        console.error('Login error:', err.message);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/auth/refresh
app.post('/api/auth/refresh', async (req, res) => {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(400).json({ error: 'Refresh token required' });

    try {
        const payload = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
        const hash    = sha256(refreshToken);

        const { rows } = await db.query(
            `SELECT id FROM refresh_tokens
             WHERE token_hash = $1 AND revoked = FALSE AND expires_at > NOW()`,
            [hash]
        );

        if (rows.length === 0) {
            return res.status(401).json({ error: 'Invalid or expired refresh token' });
        }

        // Rotate: revoke old, issue new
        await db.query('UPDATE refresh_tokens SET revoked = TRUE WHERE token_hash = $1', [hash]);

        const { rows: userRows } = await db.query(
            'SELECT id, role, full_name FROM users WHERE id = $1 AND is_active = TRUE',
            [payload.sub]
        );
        if (!userRows[0]) return res.status(401).json({ error: 'User not found' });
        const user = userRows[0];

        const newAccess  = signAccessToken({ sub: user.id, role: user.role, name: user.full_name });
        const newRefresh = signRefreshToken({ sub: user.id });
        const expiresAt  = new Date(Date.now() + JWT_REFRESH_TTL * 1000);

        await db.query(
            'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1,$2,$3)',
            [user.id, sha256(newRefresh), expiresAt]
        );

        return res.json({ accessToken: newAccess, refreshToken: newRefresh });
    } catch (_) {
        return res.status(401).json({ error: 'Invalid refresh token' });
    }
});

// POST /api/auth/logout
app.post('/api/auth/logout', requireAuth(), async (req, res) => {
    const { refreshToken } = req.body;
    if (refreshToken) {
        await db.query('UPDATE refresh_tokens SET revoked = TRUE WHERE token_hash = $1', [sha256(refreshToken)]);
    }
    await audit(req.user.sub, 'logout', { ip: req.ip });
    return res.json({ message: 'Logged out' });
});

// ──────────────────────────────────────────────────────────────
// 7. USER / PROFILE ROUTES
// ──────────────────────────────────────────────────────────────

// GET /api/me — current user
app.get('/api/me', requireAuth(), async (req, res) => {
    const { rows } = await db.query(
        `SELECT u.id, u.full_name, u.email, u.role, u.phone, u.avatar_url, u.last_login_at,
                cp.nationality, cp.current_location, cp.target_location, cp.job_title,
                cp.years_exp, cp.linkedin_url, cp.cv_url
         FROM users u
         LEFT JOIN client_profiles cp ON cp.user_id = u.id
         WHERE u.id = $1`,
        [req.user.sub]
    );
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    return res.json(rows[0]);
});

// PATCH /api/me — update profile
app.patch('/api/me', requireAuth(), async (req, res) => {
    const { full_name, phone, nationality, current_location, target_location, job_title, years_exp, linkedin_url } = req.body;

    await db.query(
        `UPDATE users SET full_name = COALESCE($1, full_name), phone = COALESCE($2, phone)
         WHERE id = $3`,
        [full_name, phone, req.user.sub]
    );

    if (req.user.role === 'client') {
        await db.query(
            `UPDATE client_profiles
             SET nationality      = COALESCE($1, nationality),
                 current_location = COALESCE($2, current_location),
                 target_location  = COALESCE($3, target_location),
                 job_title        = COALESCE($4, job_title),
                 years_exp        = COALESCE($5, years_exp),
                 linkedin_url     = COALESCE($6, linkedin_url)
             WHERE user_id = $7`,
            [nationality, current_location, target_location, job_title, years_exp, linkedin_url, req.user.sub]
        );
    }

    await audit(req.user.sub, 'update_profile', { ip: req.ip });
    return res.json({ message: 'Profile updated' });
});

// ──────────────────────────────────────────────────────────────
// 8. JOB APPLICATION ROUTES
// ──────────────────────────────────────────────────────────────

// GET /api/applications — list with optional filters
app.get('/api/applications', requireAuth(), async (req, res) => {
  try {
    const { status, from, to, limit = 50, offset = 0 } = req.query;

    let baseQuery = `
        SELECT ja.*, u.full_name as employee_name
        FROM job_applications ja
        LEFT JOIN employee_profiles ep ON ep.id = ja.employee_id
        LEFT JOIN users u ON u.id = ep.user_id
    `;

    const conditions = [];
    const params     = [];

    if (req.user.role === 'client') {
        const { rows: cp } = await db.query('SELECT id FROM client_profiles WHERE user_id=$1', [req.user.sub]);
        params.push(cp[0]?.id);
        conditions.push(`ja.client_id = $${params.length}`);
    } else if (req.user.role === 'employee') {
        const { rows: ep } = await db.query('SELECT id FROM employee_profiles WHERE user_id=$1', [req.user.sub]);
        params.push(ep[0]?.id);
        conditions.push(`ja.employee_id = $${params.length}`);
    }

    if (status) { params.push(status); conditions.push(`ja.status = $${params.length}`); }
    if (from)   { params.push(from);   conditions.push(`ja.applied_at >= $${params.length}`); }
    if (to)     { params.push(to);     conditions.push(`ja.applied_at <= $${params.length}`); }

    if (conditions.length) baseQuery += ' WHERE ' + conditions.join(' AND ');

    baseQuery += ` ORDER BY ja.applied_at DESC, ja.created_at DESC`;

    params.push(Math.min(parseInt(limit), 200));
    params.push(parseInt(offset));
    baseQuery += ` LIMIT $${params.length - 1} OFFSET $${params.length}`;

    const { rows } = await db.query(baseQuery, params);
    return res.json({ applications: rows, count: rows.length });
  } catch (err) {
    console.error('GET /applications error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/applications — create
app.post('/api/applications', requireAuth(['employee', 'admin']), async (req, res) => {
    try {
        const data = ApplicationSchema.parse(req.body);
        const { client_id } = req.body;

        const { rows: ep } = await db.query(
            'SELECT id FROM employee_profiles WHERE user_id = $1', [req.user.sub]
        );
        const employeeId = ep[0]?.id || null;

        const { rows } = await db.query(
            `INSERT INTO job_applications
             (client_id, employee_id, company_name, job_title, job_url, location, salary_range, portal, notes, status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
             RETURNING *`,
            [client_id, employeeId, data.company_name, data.job_title,
             data.job_url || null, data.location || null, data.salary_range || null,
             data.portal || null, data.notes || null, data.status]
        );

        // Notify client
        await db.query(
            `INSERT INTO notifications (user_id, type, title, body)
             SELECT u.id, 'application_update',
                    'New Application Submitted',
                    $1
             FROM client_profiles cp JOIN users u ON u.id = cp.user_id
             WHERE cp.id = $2`,
            [`Applied to ${data.job_title} at ${data.company_name}`, client_id]
        );

        await audit(req.user.sub, 'create_application', { table: 'job_applications', recordId: rows[0].id });
        return res.status(201).json(rows[0]);
    } catch (err) {
        if (err instanceof z.ZodError) return res.status(422).json({ error: err.errors });
        console.error(err);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

// PATCH /api/applications/:id/status
app.patch('/api/applications/:id/status', requireAuth(['employee', 'admin']), async (req, res) => {
    const { status } = req.body;
    const validStatuses = ['applied','viewed','interview','offer','rejected','withdrawn'];
    if (!validStatuses.includes(status)) {
        return res.status(400).json({ error: 'Invalid status' });
    }

    const { rows } = await db.query(
        'UPDATE job_applications SET status=$1 WHERE id=$2 RETURNING *',
        [status, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Application not found' });

    await audit(req.user.sub, 'update_application_status', { recordId: req.params.id, data: { status } });
    return res.json(rows[0]);
});

// ──────────────────────────────────────────────────────────────
// 9. ADMIN ROUTES
// ──────────────────────────────────────────────────────────────

// GET /api/admin/stats
app.get('/api/admin/stats', requireAuth(['admin']), async (req, res) => {
  try {
    const [clients, employees, applications, revenue] = await Promise.all([
        db.query("SELECT COUNT(*) FROM client_profiles"),
        db.query("SELECT COUNT(*) FROM employee_profiles"),
        db.query("SELECT COUNT(*), status FROM job_applications GROUP BY status"),
        db.query("SELECT COALESCE(SUM(amount_eur),0) AS total FROM payments WHERE status='paid'"),
    ]);

    return res.json({
        totalClients:      parseInt(clients.rows[0].count),
        totalEmployees:    parseInt(employees.rows[0].count),
        applicationsByStatus: applications.rows,
        totalRevenue:      parseFloat(revenue.rows[0].total),
    });
  } catch (err) {
    console.error('GET /admin/stats error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/admin/clients
app.get('/api/admin/clients', requireAuth(['admin']), async (req, res) => {
  try {
    const { rows } = await db.query(`
        SELECT u.id, u.full_name, u.email, u.phone, u.is_active, u.created_at,
               cp.target_location, cp.job_title, cp.years_exp,
               s.status AS subscription_status,
               sp.name  AS plan_name
        FROM users u
        JOIN client_profiles cp ON cp.user_id = u.id
        LEFT JOIN subscriptions s ON s.client_id = cp.id AND s.status = 'active'
        LEFT JOIN service_plans sp ON sp.id = s.plan_id
        WHERE u.role = 'client'
        ORDER BY u.created_at DESC
    `);
    return res.json(rows);
  } catch (err) {
    console.error('GET /admin/clients error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/admin/assign
app.post('/api/admin/assign', requireAuth(['admin']), async (req, res) => {
  try {
    const { client_profile_id, employee_profile_id } = req.body;
    if (!client_profile_id || !employee_profile_id) {
        return res.status(400).json({ error: 'Both IDs required' });
    }

    // Deactivate current assignment
    await db.query(
        `UPDATE client_assignments SET is_active=FALSE, unassigned_at=NOW()
         WHERE client_id=$1 AND is_active=TRUE`,
        [client_profile_id]
    );

    const { rows } = await db.query(
        `INSERT INTO client_assignments (client_id, employee_id)
         VALUES ($1,$2) RETURNING *`,
        [client_profile_id, employee_profile_id]
    );

    await audit(req.user.sub, 'assign_client', { recordId: rows[0].id });
    return res.status(201).json(rows[0]);
  } catch (err) {
    console.error('POST /admin/assign error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ──────────────────────────────────────────────────────────────
// 10. NOTIFICATIONS
// ──────────────────────────────────────────────────────────────

app.get('/api/notifications', requireAuth(), async (req, res) => {
  try {
    const { rows } = await db.query(
        `SELECT * FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50`,
        [req.user.sub]
    );
    return res.json(rows);
  } catch (err) {
    console.error('GET /notifications error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.patch('/api/notifications/:id/read', requireAuth(), async (req, res) => {
  try {
    await db.query(
        'UPDATE notifications SET is_read=TRUE WHERE id=$1 AND user_id=$2',
        [req.params.id, req.user.sub]
    );
    return res.json({ message: 'Marked as read' });
  } catch (err) {
    console.error('PATCH /notifications error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ──────────────────────────────────────────────────────────────
// 11. HEALTH CHECK
// ──────────────────────────────────────────────────────────────
app.get('/health', async (_req, res) => {
    try {
        await db.query('SELECT 1');
        return res.json({ status: 'ok', timestamp: new Date().toISOString() });
    } catch {
        return res.status(503).json({ status: 'db_down' });
    }
});

// 404 handler
app.use((_req, res) => res.status(404).json({ error: 'Route not found' }));

// Global error handler
app.use((err, _req, res, _next) => {
    console.error('Unhandled error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => console.log(`🚀 HOPE_IRL API running on port ${PORT}`));

module.exports = app;
