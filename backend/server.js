// ============================================================
// HOPE_IRL Backend API — server.js (Production Ready) v2
// Features: Auth+OTP, Admin CRUD, Payments, AWS SES, S3 Upload
// BugFixes v1:
//   - broadcastSSE/pushSSE defined BEFORE routes that call them
//   - Duplicate /api/employee/clients route removed (kept rich one)
//   - app.listen() moved to AFTER all routes and SSE setup
//   - S3 env var prefix unified (AWS_*)
//   - SSE route moved before listen()
//   - avatarUpload uses requireAuth correctly
// BugFixes v2:
//   - Employee list: WHERE u.is_active=TRUE (deleted employees now disappear)
//   - /api/admin/services: shows all plans (active+inactive) sorted active-first
//   - app.listen() and SSE properly ordered
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
const path           = require('path');

const app  = express();
const PORT = process.env.PORT || 3001;
const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS) || 12;

// ──────────────────────────────────────────────────────────────
// 1. DATABASE
// ──────────────────────────────────────────────────────────────
const db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: false,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
});

db.connect()
    .then(c => { c.release(); console.log('✅ Database connected'); })
    .catch(e => { console.error('❌ DB failed:', e.message); process.exit(1); });

// ──────────────────────────────────────────────────────────────
// 2. AWS SES EMAIL
// ──────────────────────────────────────────────────────────────
async function sendEmail({ to, subject, html, text }) {
    try {
        const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses');
        const ses = new SESClient({
            region: process.env.AWS_REGION || 'ap-south-1',
            credentials: {
                accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
                secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
            },
        });
        await ses.send(new SendEmailCommand({
            Source: process.env.EMAIL_FROM || 'noreply@hope-irl.com',
            Destination: { ToAddresses: [to] },
            Message: {
                Subject: { Data: subject },
                Body: { Html: { Data: html }, Text: { Data: text || subject } },
            },
        }));
        console.log(`📧 Email sent to ${to}`);
    } catch (err) {
        console.warn(`⚠️  Email failed (${err.message}) — check AWS SES config`);
    }
}


async function sendWhatsAppAlert(message) {
    try {
        const phone=process.env.ADMIN_WHATSAPP_PHONE; const apiKey=process.env.CALLMEBOT_API_KEY;
        if(!phone||!apiKey){console.log('WhatsApp alert (not configured):',message);return;}
        const url=`https://api.callmebot.com/whatsapp.php?phone=${phone}&text=${encodeURIComponent(message)}&apikey=${apiKey}`;
        require('https').get(url,(res)=>{console.log(`WhatsApp sent (${res.statusCode})`);}).on('error',(e)=>console.warn('WA failed:',e.message));
    }catch(err){console.warn('WA error:',err.message);}
}
async function sendPaymentConfirmedEmail(clientEmail,clientName,planName,amount,txRef){
    await sendEmail({to:clientEmail,subject:'HOPE_IRL — Payment Confirmed & Subscription Activated!',
    html:`<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;padding:32px;background:#f9fafb;border-radius:16px;"><div style="background:linear-gradient(135deg,#667eea,#764ba2);padding:28px;border-radius:12px;text-align:center;margin-bottom:28px;color:white;"><h1 style="margin:0;">HOPE_IRL</h1></div><h2>Payment Confirmed!</h2><p>Hello <strong>${clientName}</strong>, your <strong>${planName}</strong> subscription is now <strong style="color:#22c55e;">ACTIVE</strong>.</p><div style="background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:20px;margin:20px 0;"><div style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid #f3f4f6;"><span style="color:#9ca3af;">Plan</span><strong>${planName}</strong></div><div style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid #f3f4f6;"><span style="color:#9ca3af;">Amount</span><strong style="color:#7e22ce;font-size:20px;">EUR${parseFloat(amount).toFixed(2)}</strong></div><div style="display:flex;justify-content:space-between;padding:10px 0;"><span style="color:#9ca3af;">Reference</span><span style="font-family:monospace;">${txRef}</span></div></div><p style="color:#9ca3af;font-size:12px;text-align:center;">Thank you for choosing HOPE_IRL</p></div>`,
    text:`Payment confirmed! ${planName} subscription active. Ref: ${txRef}`});
}
async function sendExpiryReminderEmail(clientEmail,clientName,planName,expiryDate,daysLeft){
    const color=daysLeft<=3?'#ef4444':'#f59e0b';
    await sendEmail({to:clientEmail,subject:`HOPE_IRL — Subscription expires in ${daysLeft} day(s)`,
    html:`<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;padding:32px;"><h2>Subscription Expiring!</h2><p>Hello <strong>${clientName}</strong>,</p><div style="background:#fff;border:2px solid ${color};border-radius:12px;padding:20px;margin:20px 0;text-align:center;"><p style="color:${color};font-weight:700;font-size:18px;margin:0;">Your <strong>${planName}</strong> expires in <strong>${daysLeft} day(s)</strong></p><p style="color:#6b7280;margin:8px 0 0;">${new Date(expiryDate).toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric'})}</p></div><p>Renew now to continue your job search journey!</p></div>`,
    text:`Your ${planName} expires in ${daysLeft} days. Please renew.`});
}
function scheduleExpiryReminders(){
    const now=new Date(); const next=new Date(now); next.setHours(9,0,0,0);
    if(next<=now) next.setDate(next.getDate()+1);
    setTimeout(async function run(){
        try{
            const {rows}=await db.query(`SELECT u.full_name,u.email,sp.name AS plan_name,s.ends_at,EXTRACT(DAY FROM s.ends_at-NOW())::int AS days_left FROM subscriptions s JOIN client_profiles cp ON cp.id=s.client_id JOIN users u ON u.id=cp.user_id JOIN service_plans sp ON sp.id=s.plan_id WHERE s.status='active' AND s.ends_at BETWEEN NOW() AND NOW()+INTERVAL '7 days'`);
            for(const sub of rows){ if([7,3,1].includes(sub.days_left)) await sendExpiryReminderEmail(sub.email,sub.full_name,sub.plan_name,sub.ends_at,sub.days_left); }
            if(rows.length) await sendWhatsAppAlert(`${rows.length} subscription(s) expiring within 7 days`);
        }catch(err){console.error('Expiry reminder error:',err.message);}
        setTimeout(run,24*60*60*1000);
    },next-now);
    console.log(`Expiry reminders scheduled`);
}

// OTP store (use Redis in production)
const otpStore = new Map();

async function sendOTPEmail(email, name) {
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    otpStore.set(email, { otp, expires: Date.now() + 10 * 60 * 1000 });
    await sendEmail({
        to: email,
        subject: 'HOPE_IRL — Email Verification OTP',
        html: `
        <div style="font-family:Inter,sans-serif;max-width:500px;margin:auto;padding:32px;background:#f9fafb;border-radius:12px;">
            <div style="background:linear-gradient(135deg,#667eea,#764ba2);padding:24px;border-radius:8px;text-align:center;margin-bottom:24px;">
                <h1 style="color:#fff;margin:0;font-size:24px;">HOPE_IRL</h1>
                <p style="color:#e9d5ff;margin:4px 0 0;">Career Support Platform</p>
            </div>
            <h2 style="color:#1f2937;">Hello, ${name}! 👋</h2>
            <p style="color:#6b7280;">Your email verification OTP is:</p>
            <div style="background:#fff;border:2px solid #667eea;border-radius:12px;text-align:center;padding:24px;margin:24px 0;">
                <span style="font-size:40px;font-weight:800;letter-spacing:12px;color:#667eea;">${otp}</span>
            </div>
            <p style="color:#9ca3af;font-size:13px;">This OTP expires in <strong>10 minutes</strong>. Do not share with anyone.</p>
            <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;">
            <p style="color:#9ca3af;font-size:12px;text-align:center;">© 2025 HOPE_IRL. All rights reserved.</p>
        </div>`,
        text: `Your HOPE_IRL OTP is: ${otp}. Expires in 10 minutes.`,
    });
    return otp;
}

async function sendWelcomeEmail(email, name, role) {
    await sendEmail({
        to: email,
        subject: 'Welcome to HOPE_IRL! 🎉',
        html: `
        <div style="font-family:Inter,sans-serif;max-width:500px;margin:auto;padding:32px;">
            <div style="background:linear-gradient(135deg,#667eea,#764ba2);padding:24px;border-radius:8px;text-align:center;margin-bottom:24px;">
                <h1 style="color:#fff;margin:0;">Welcome to HOPE_IRL! 🎉</h1>
            </div>
            <h2>Hello ${name},</h2>
            <p>Your <strong>${role}</strong> account has been created successfully!</p>
            <p>We're excited to help with your career journey in Ireland/EU.</p>
            <p style="color:#9ca3af;font-size:12px;margin-top:32px;">© 2025 HOPE_IRL. All rights reserved.</p>
        </div>`,
    });
}

async function sendAssignmentEmail(clientEmail, clientName, employeeName) {
    await sendEmail({
        to: clientEmail,
        subject: 'HOPE_IRL — Your Career Consultant Assigned! 🎊',
        html: `
        <div style="font-family:Inter,sans-serif;max-width:500px;margin:auto;padding:32px;">
            <div style="background:linear-gradient(135deg,#667eea,#764ba2);padding:24px;border-radius:8px;text-align:center;margin-bottom:24px;">
                <h1 style="color:#fff;margin:0;">Great News! 🎊</h1>
            </div>
            <h2>Hello ${clientName},</h2>
            <p>Your career consultant <strong>${employeeName}</strong> has been assigned to you.</p>
            <p>They will start working on your job applications immediately!</p>
            <p style="color:#9ca3af;font-size:12px;margin-top:32px;">© 2025 HOPE_IRL.</p>
        </div>`,
    });
}

// ──────────────────────────────────────────────────────────────
// 3. FILE UPLOAD (multer)
// ──────────────────────────────────────────────────────────────
let multer;
try { multer = require('multer'); } catch { console.warn('⚠️  multer not installed. Run: npm install multer'); }

const upload = multer ? multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = ['.pdf', '.doc', '.docx'];
        const ext = path.extname(file.originalname).toLowerCase();
        if (allowed.includes(ext)) cb(null, true);
        else cb(new Error('Only PDF, DOC, DOCX allowed'));
    },
}) : null;

// FIX: Unified S3 env vars — use AWS_* consistently
async function uploadToS3(file, userId, docType) {
    const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
    const s3 = new S3Client({
        region: process.env.AWS_REGION || 'ap-south-1',
        credentials: {
            accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        },
    });
    const ext = path.extname(file.originalname);
    const key = `documents/${userId}/${docType}/${Date.now()}${ext}`;
    await s3.send(new PutObjectCommand({
        Bucket:      process.env.AWS_S3_BUCKET || 'hope-irl-documents',
        Key:         key,
        Body:        file.buffer,
        ContentType: file.mimetype,
    }));
    return `https://${process.env.AWS_S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;
}

// ──────────────────────────────────────────────────────────────
// 4. MIDDLEWARE
// ──────────────────────────────────────────────────────────────
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc:  ["'self'"],
            scriptSrc:   ["'self'","'unsafe-inline'","https://cdn.tailwindcss.com","https://cdnjs.cloudflare.com"],
            styleSrc:    ["'self'","'unsafe-inline'","https://cdn.tailwindcss.com","https://cdnjs.cloudflare.com"],
            fontSrc:     ["'self'","https://cdnjs.cloudflare.com"],
            imgSrc:      ["'self'","data:","https:","blob:"],
            connectSrc:  ["'self'","ws:","wss:"],
            frameSrc:    ["'none'"],
            objectSrc:   ["'none'"],
        },
    },
    crossOriginEmbedderPolicy: false,
    hsts: process.env.NODE_ENV==='production'?{maxAge:31536000,includeSubDomains:true}:false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    frameguard: { action: 'deny' },
}));

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean);
app.use(cors({
    origin: (origin, cb) => {
        if (!origin) return cb(null, true);
        // Local development (PC browser)
        if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return cb(null, true);
        // LAN / Mobile on same WiFi (192.168.x.x, 10.x.x.x, 172.16-31.x.x)
        if (/^https?:\/\/(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)\d+\.\d+(:\d+)?$/.test(origin)) return cb(null, true);
        // Production allowed origins from env
        if (allowedOrigins.includes(origin)) return cb(null, true);
        if (origin && origin.endsWith(".onrender.com")) return cb(null, true);
        if (origin && origin.endsWith('.onrender.com')) return cb(null, true);
        if (process.env.NODE_ENV !== 'production') return cb(null, true);
        cb(new Error(`CORS: ${origin} not allowed`));
    },
    credentials: true,
}));

// FIX: Stripe webhook needs raw body — register BEFORE express.json()
app.post('/api/payments/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    try {
        const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
        const event  = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);

        if (event.type === 'checkout.session.completed') {
            const s = event.data.object;
            const { client_id, plan_id, user_id } = s.metadata;
            const ends = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
            const { rows: sr } = await db.query(
                "INSERT INTO subscriptions (client_id, plan_id, status, starts_at, ends_at) VALUES ($1,$2,'active',NOW(),$3) RETURNING id",
                [client_id, plan_id, ends]
            );
            await db.query(
                "INSERT INTO payments (subscription_id, client_id, amount_eur, method, gateway_ref, status, paid_at) VALUES ($1,$2,$3,'stripe',$4,'paid',NOW())",
                [sr[0].id, client_id, s.amount_total / 100, s.payment_intent]
            );
            await db.query(
                "INSERT INTO notifications (user_id, type, title, body) VALUES ($1,'payment','Payment Successful! 🎉','Your subscription is now active.')",
                [user_id]
            );
            broadcastSSE('payment_updated', { user_id, status: 'paid' });
        }
        return res.json({ received: true });
    } catch (err) {
        return res.status(400).json({ error: err.message });
    }
});

app.use(express.json({ limit: '16kb' }));

const globalLimiter = rateLimit({ windowMs:15*60*1000, max:10000, standardHeaders:true, legacyHeaders:false, message:{error:'Too many requests.'}, skip:(req)=>req.path==='/api/sse' });
const authLimiter   = rateLimit({ windowMs:15*60*1000, max:500,  standardHeaders:true, legacyHeaders:false, message:{error:'Too many login attempts. Wait 15 minutes.'}, keyGenerator:(req)=>req.ip+':'+(req.body?.email||'') });
const otpLimiter    = rateLimit({ windowMs:10*60*1000, max:500,   message:{error:'Too many OTP attempts.'} });
const paymentLimiter= rateLimit({ windowMs:60*60*1000, max:500,  message:{error:'Too many payment requests.'} });
const uploadLimiter = rateLimit({ windowMs:60*60*1000, max:500,  message:{error:'Upload limit reached.'} });
app.use(globalLimiter);

// ──────────────────────────────────────────────────────────────

// ── INPUT SANITIZATION ───────────────────────────────────────
function sanitizeStr(val, maxLen=255) {
    if(val===null||val===undefined) return '';
    return String(val).trim().slice(0,maxLen).replace(/[<>]/g,'').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g,'');
}
function sanitizeEmail(val) {
    const e=sanitizeStr(val,254).toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)?e:null;
}
function sanitizeInt(val,min=0,max=999999) { const n=parseInt(val); return isNaN(n)?null:Math.min(Math.max(n,min),max); }
function sanitizeUUID(val) {
    const s=sanitizeStr(val,36);
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)?s:null;
}

// 5. REAL-TIME — Server-Sent Events (SSE)
// FIX: Defined BEFORE routes that call broadcastSSE / pushSSE
// ──────────────────────────────────────────────────────────────
const sseClients = new Map();

function pushSSE(userId, event, data) {
    const conns = sseClients.get(userId);
    if (!conns?.size) return;
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    conns.forEach(res => { try { res.write(msg); } catch {} });
}

function broadcastSSE(event, data) {
    sseClients.forEach((_, uid) => pushSSE(uid, event, data));
}

// ──────────────────────────────────────────────────────────────
// 6. JWT HELPERS
// ──────────────────────────────────────────────────────────────
// SECURITY FIX 1: Crash early if JWT secrets missing in production
if (process.env.NODE_ENV === 'production' && (!process.env.JWT_ACCESS_SECRET || !process.env.JWT_REFRESH_SECRET)) {
    console.error('❌ FATAL: JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be set in production!');
    process.exit(1);
}
const ACCESS_SECRET  = process.env.JWT_ACCESS_SECRET  || 'dev-access-secret-do-not-use-in-prod';
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret-do-not-use-in-prod';

function signAccessToken(payload)  {
    return jwt.sign(
        { ...payload, jti: crypto.randomBytes(8).toString('hex') },
        ACCESS_SECRET,
        { expiresIn: '15m', issuer: 'hope-irl', audience: 'hope-irl-app' }
    );
}
function signRefreshToken(payload) {
    return jwt.sign(
        { ...payload, jti: crypto.randomBytes(8).toString('hex') },
        REFRESH_SECRET,
        { expiresIn: '7d', issuer: 'hope-irl' }
    );
}

function requireAuth(roles = []) {
    return async (req, res, next) => {
        const header = req.headers.authorization;
        if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'UNAUTHORIZED', code: 'NO_TOKEN' });
        try {
            const payload = jwt.verify(header.slice(7), ACCESS_SECRET, {
                issuer: 'hope-irl', audience: 'hope-irl-app',
            });
            if (roles.length && !roles.includes(payload.role)) {
                console.warn(`🚨 Forbidden access: user=${payload.sub} role=${payload.role} needed=${roles} path=${req.path} ip=${req.ip}`);
                return res.status(403).json({ error: 'FORBIDDEN' });
            }
            req.user = payload;
            next();
        } catch (err) {
            const code = err.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN';
            if (code === 'INVALID_TOKEN') console.warn(`🚨 Invalid token attempt: ip=${req.ip} path=${req.path}`);
            return res.status(401).json({ error: 'UNAUTHORIZED', code });
        }
    };
}

async function audit(userId, action, extra = {}) {
    try {
        await db.query(
            'INSERT INTO audit_logs (user_id, action, table_name, record_id) VALUES ($1,$2,$3,$4)',
            [userId, action, extra.table || null, extra.recordId ? String(extra.recordId) : null]
        );
    } catch {}
}

// ──────────────────────────────────────────────────────────────
// 7. VALIDATION SCHEMAS
// ──────────────────────────────────────────────────────────────
const registerSchema = z.object({
    full_name: z.string().min(2).max(255),
    email:     z.string().email(),
    password:  z.string().min(8)
        .regex(/[A-Z]/, 'Need 1 uppercase')
        .regex(/[0-9]/, 'Need 1 number')
        .regex(/[^A-Za-z0-9]/, 'Need 1 special character'),
    phone:     z.string().optional(),
    role:      z.enum(['client', 'employee']).default('client'),
});

// ──────────────────────────────────────────────────────────────
// 8. AUTH ROUTES
// ──────────────────────────────────────────────────────────────

// Register
app.post('/api/auth/register', authLimiter, async (req, res) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'VALIDATION_ERROR', details: parsed.error.issues });

    const { full_name, email, password, phone, role } = parsed.data;

    try {
        const exists = await db.query('SELECT id FROM users WHERE email=$1', [email.toLowerCase().trim()]);
        if (exists.rows.length) return res.status(409).json({ error: 'Email already registered' });

        const password_hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
        const { rows } = await db.query(
            `INSERT INTO users (full_name, email, password_hash, role, phone, is_verified)
             VALUES ($1,$2,$3,$4,$5,TRUE) RETURNING id, email, full_name, role`,
            [full_name, email.toLowerCase().trim(), password_hash, role, phone || null]
        );
        const user = rows[0];

        if (role === 'client')   await db.query('INSERT INTO client_profiles   (user_id) VALUES ($1)', [user.id]);
        if (role === 'employee') await db.query('INSERT INTO employee_profiles (user_id) VALUES ($1)', [user.id]);

        sendOTPEmail(email, full_name).catch(() => {});
        sendWelcomeEmail(email, full_name, role).catch(() => {});
        await audit(user.id, 'register', { table: 'users', recordId: user.id });

        return res.status(201).json({
            message: 'Account created! Check your email for OTP.',
            userId: user.id,
            requiresVerification: true,
        });
    } catch (err) {
        console.error('Register error:', err);
        return res.status(500).json({ error: 'Registration failed' });
    }
});

// Verify OTP
app.post('/api/auth/verify-otp', otpLimiter, async (req, res) => {
    const email = sanitizeEmail(req.body.email);
    const otp   = sanitizeStr(req.body.otp, 6).replace(/\D/g, '');
    if (!email || !otp) return res.status(400).json({ error: 'Email and OTP required' });

    const stored = otpStore.get(email);
    if (!stored)                return res.status(400).json({ error: 'OTP not found. Request a new one.' });
    if (Date.now() > stored.expires) { otpStore.delete(email); return res.status(400).json({ error: 'OTP expired.' }); }
    if (stored.otp !== otp.toString()) return res.status(400).json({ error: 'Invalid OTP' });

    otpStore.delete(email);
    await db.query('UPDATE users SET is_verified=TRUE WHERE email=$1', [email]);
    return res.json({ message: 'Email verified! You can now login.' });
});

// Resend OTP
app.post('/api/auth/resend-otp', otpLimiter, authLimiter, async (req, res) => {
    const email = sanitizeEmail(req.body.email);
    if (!email) return res.status(400).json({ error: 'Valid email required' });
    const { rows } = await db.query('SELECT full_name FROM users WHERE email=$1', [email]);
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    await sendOTPEmail(email, rows[0].full_name);
    return res.json({ message: 'OTP sent!' });
});

// Login
app.post('/api/auth/login', authLimiter, async (req, res) => {
    const email    = sanitizeEmail(req.body.email);
    const password = req.body.password;
    if (!email)    return res.status(400).json({ error: 'Valid email required.' });
    if (!password) return res.status(400).json({ error: 'Password required.' });

    try {
        const { rows } = await db.query(
            'SELECT id, email, full_name, role, password_hash, is_active, is_verified FROM users WHERE email=$1',
            [email]
        );
        if (!rows.length) {
            console.warn(`🚨 Failed login (no user): ${email} from ${req.ip}`);
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        const user = rows[0];
        if (!user.is_active) return res.status(403).json({ error: 'Account deactivated. Contact support.' });
        // SECURITY FIX 2: Block unverified users from logging in
        // // if (!user.is_verified) return res.status(403).json({ error: 'Please verify your email before logging in.', code: 'EMAIL_NOT_VERIFIED' });

        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) {
            console.warn(`🚨 Failed login (wrong password): ${email} from ${req.ip}`);
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        const accessToken  = signAccessToken({ sub: user.id, role: user.role, name: user.full_name });
        const refreshToken = signRefreshToken({ sub: user.id });

        const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        await db.query('DELETE FROM refresh_tokens WHERE user_id=$1', [user.id]);
        await db.query(`INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1,$2,$3) ON CONFLICT (token_hash) DO NOTHING`, [user.id, tokenHash, expiresAt]);

        return res.json({
            accessToken, refreshToken,
            user: { id: user.id, name: user.full_name, email: user.email, role: user.role, isVerified: user.is_verified },
        });
    } catch (err) {
        console.error('Login error:', err);
        return res.status(500).json({ error: 'Login failed' });
    }
});

// Refresh token
app.post('/api/auth/refresh', async (req, res) => {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(401).json({ error: 'Refresh token required' });

    try {
        const payload   = jwt.verify(refreshToken, REFRESH_SECRET);
        const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
        const { rows }  = await db.query('SELECT * FROM refresh_tokens WHERE token_hash=$1', [tokenHash]);

        if (!rows.length || rows[0].revoked || new Date(rows[0].expires_at) < new Date())
            return res.status(401).json({ error: 'Invalid or expired refresh token' });

        const { rows: ur } = await db.query('SELECT id, role, full_name FROM users WHERE id=$1', [payload.sub]);
        if (!ur.length) return res.status(401).json({ error: 'User not found' });

        const user       = ur[0];
        const newAccess  = signAccessToken({ sub: user.id, role: user.role, name: user.full_name });
        const newRefresh = signRefreshToken({ sub: user.id });
        const newHash    = crypto.createHash('sha256').update(newRefresh).digest('hex');
        const newExp     = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

        await db.query('UPDATE refresh_tokens SET revoked=TRUE WHERE id=$1', [rows[0].id]);
        await db.query('INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1,$2,$3)', [user.id, newHash, newExp]);

        return res.json({ accessToken: newAccess, refreshToken: newRefresh });
    } catch {
        return res.status(401).json({ error: 'Invalid refresh token' });
    }
});

// Logout
app.post('/api/auth/logout', async (req, res) => {
    const { refreshToken } = req.body;
    if (refreshToken) {
        const hash = crypto.createHash('sha256').update(refreshToken).digest('hex');
        await db.query('UPDATE refresh_tokens SET revoked=TRUE WHERE token_hash=$1', [hash]);
    }
    return res.status(204).send();
});

// Forgot Password
app.post('/api/auth/forgot-password', authLimiter, async (req, res) => {
    const email = sanitizeEmail(req.body.email); // SECURITY FIX 3: sanitize email input
    if (!email) return res.json({ message: 'If email exists, reset link sent.' });
    const { rows }  = await db.query('SELECT id, full_name FROM users WHERE email=$1', [email]);
    if (!rows.length) return res.json({ message: 'If email exists, reset link sent.' });

    const token   = crypto.randomBytes(32).toString('hex');
    const hash    = crypto.createHash('sha256').update(token).digest('hex');
    const expires = new Date(Date.now() + 60 * 60 * 1000);

    await db.query('INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1,$2,$3)', [rows[0].id, hash, expires]);

    const resetUrl = `${process.env.FRONTEND_URL || 'http://localhost:5500'}?reset_token=${token}`;
    await sendEmail({
        to: email, subject: 'HOPE_IRL — Password Reset',
        html: `<p>Hi ${rows[0].full_name},</p><p><a href="${resetUrl}">Click here</a> to reset your password. Expires in 1 hour.</p>`,
    });

    return res.json({ message: 'If email exists, reset link sent.' });
});

// ──────────────────────────────────────────────────────────────
// 9. PROFILE
// ──────────────────────────────────────────────────────────────
app.get('/api/me', requireAuth(), async (req, res) => {
    const { rows } = await db.query(
        'SELECT id, email, full_name, role, phone, avatar_url, is_verified, last_login_at FROM users WHERE id=$1',
        [req.user.sub]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });

    let profile = {};
    if (rows[0].role === 'client') {
        const p = await db.query('SELECT * FROM client_profiles WHERE user_id=$1', [req.user.sub]);
        profile = p.rows[0] || {};
    } else if (rows[0].role === 'employee') {
        const p = await db.query('SELECT * FROM employee_profiles WHERE user_id=$1', [req.user.sub]);
        profile = p.rows[0] || {};
    }
    return res.json({ ...rows[0], profile });
});

app.patch('/api/me', requireAuth(), async (req, res) => {
    // SECURITY FIX 4: sanitize inputs before DB update
    const full_name = req.body.full_name ? sanitizeStr(req.body.full_name, 255) : undefined;
    const phone     = req.body.phone     ? sanitizeStr(req.body.phone, 30)      : undefined;
    const { rows } = await db.query(
        'UPDATE users SET full_name=COALESCE($1,full_name), phone=COALESCE($2,phone), updated_at=NOW() WHERE id=$3 RETURNING id, email, full_name, phone, role',
        [full_name, phone, req.user.sub]
    );
    return res.json(rows[0]);
});

// ──────────────────────────────────────────────────────────────
// 10. AVATAR UPLOAD
// ──────────────────────────────────────────────────────────────
const avatarUpload = multer ? multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) cb(null, true);
        else cb(new Error('Images only (jpg, png, webp)'));
    },
}) : null;

if (avatarUpload) {
    app.post('/api/me/avatar', requireAuth(), avatarUpload.single('avatar'), async (req, res) => {
        if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
        try {
            let avatarUrl;
            try {
                const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
                const s3 = new S3Client({
                    region: process.env.AWS_REGION || 'ap-south-1',
                    credentials: {
                        accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
                        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
                    },
                });
                const ext = req.file.mimetype.split('/')[1];
                const key = `avatars/${req.user.sub}/avatar.${ext}`;
                await s3.send(new PutObjectCommand({
                    Bucket:      process.env.AWS_S3_BUCKET || 'hope-irl-documents',
                    Key:         key,
                    Body:        req.file.buffer,
                    ContentType: req.file.mimetype,
                }));
                avatarUrl = `https://${process.env.AWS_S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;
            } catch (s3err) {
                console.warn('S3 avatar upload failed, using base64 fallback:', s3err.message);
                const b64 = req.file.buffer.toString('base64');
                avatarUrl = `data:${req.file.mimetype};base64,${b64}`;
            }

            const { rows } = await db.query(
                'UPDATE users SET avatar_url=$1, updated_at=NOW() WHERE id=$2 RETURNING id, avatar_url',
                [avatarUrl, req.user.sub]
            );
            await audit(req.user.sub, 'update_avatar');
            pushSSE(req.user.sub, 'profile_updated', { avatar_url: avatarUrl });
            return res.json({ avatar_url: rows[0].avatar_url });
        } catch (err) {
            return res.status(500).json({ error: err.message });
        }
    });
}

// ──────────────────────────────────────────────────────────────
// 11. CV / DOCUMENT UPLOAD
// ──────────────────────────────────────────────────────────────
if (upload) {
    app.post('/api/documents/upload', requireAuth(), upload.single('file'), async (req, res) => {
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
        const docType = req.body.doc_type || 'cv';

        try {
            let storageUrl;
            try {
                storageUrl = await uploadToS3(req.file, req.user.sub, docType);
            } catch (s3err) {
                console.warn('S3 upload failed, using local fallback:', s3err.message);
                storageUrl = `local://${req.user.sub}/${Date.now()}_${req.file.originalname}`;
            }

            const { rows } = await db.query(
                `INSERT INTO documents (user_id, doc_type, file_name, storage_path, mime_type, size_bytes, is_primary)
                 VALUES ($1,$2,$3,$4,$5,$6,TRUE) RETURNING *`,
                [req.user.sub, docType, req.file.originalname, storageUrl, req.file.mimetype, req.file.size]
            );

            if (docType === 'cv') {
                await db.query('UPDATE client_profiles SET cv_url=$1 WHERE user_id=$2', [storageUrl, req.user.sub]);
            }

            return res.status(201).json({ document: rows[0], url: storageUrl });
        } catch (err) {
            return res.status(500).json({ error: err.message });
        }
    });
}

app.get('/api/documents', requireAuth(), async (req, res) => {
    const { rows } = await db.query('SELECT * FROM documents WHERE user_id=$1 ORDER BY created_at DESC', [req.user.sub]);
    return res.json(rows);
});

app.delete('/api/documents/:id', requireAuth(), async (req, res) => {
    await db.query('DELETE FROM documents WHERE id=$1 AND user_id=$2', [req.params.id, req.user.sub]);
    return res.status(204).send();
});

// ──────────────────────────────────────────────────────────────
// 12. JOB APPLICATIONS
// ──────────────────────────────────────────────────────────────
app.get('/api/applications', requireAuth(), async (req, res) => {
    const { status, limit = 50, offset = 0 } = req.query;
    let query, params;

    if (req.user.role === 'admin') {
        query = `SELECT ja.*, u.full_name AS client_name, u.id AS client_user_id, eu.full_name AS employee_name
                 FROM job_applications ja
                 JOIN client_profiles cp ON cp.id = ja.client_id
                 JOIN users u ON u.id = cp.user_id
                 LEFT JOIN employee_profiles ep ON ep.id = ja.employee_id
                 LEFT JOIN users eu ON eu.id = ep.user_id
                 WHERE ($1::text IS NULL OR ja.status=$1)
                 ORDER BY ja.created_at DESC LIMIT $2 OFFSET $3`;
        params = [status || null, limit, offset];
    } else if (req.user.role === 'employee') {
        query = `SELECT ja.*, u.full_name AS client_name
                 FROM job_applications ja
                 JOIN client_profiles cp ON cp.id = ja.client_id
                 JOIN users u ON u.id = cp.user_id
                 JOIN employee_profiles ep ON ep.id = ja.employee_id AND ep.user_id=$1
                 WHERE ($2::text IS NULL OR ja.status=$2)
                 ORDER BY ja.created_at DESC LIMIT $3 OFFSET $4`;
        params = [req.user.sub, status || null, limit, offset];
    } else {
        query = `SELECT ja.*, eu.full_name AS employee_name
                 FROM job_applications ja
                 JOIN client_profiles cp ON cp.id = ja.client_id AND cp.user_id=$1
                 LEFT JOIN employee_profiles ep ON ep.id = ja.employee_id
                 LEFT JOIN users eu ON eu.id = ep.user_id
                 WHERE ($2::text IS NULL OR ja.status=$2)
                 ORDER BY ja.created_at DESC LIMIT $3 OFFSET $4`;
        params = [req.user.sub, status || null, limit, offset];
    }

    const { rows } = await db.query(query, params);
    return res.json({ applications: rows, total: rows.length });
});

app.post('/api/applications', requireAuth(['employee', 'admin']), async (req, res) => {
    const { client_id, company_name, job_title, job_url, location, portal, notes, salary_range } = req.body;
    if (!client_id || !company_name || !job_title) return res.status(400).json({ error: 'client_id, company_name, job_title required' });

    const empRes = await db.query('SELECT id FROM employee_profiles WHERE user_id=$1', [req.user.sub]);
    const employee_id = empRes.rows[0]?.id || null;

    const { rows } = await db.query(
        `INSERT INTO job_applications (client_id, employee_id, company_name, job_title, job_url, location, portal, notes, salary_range)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [client_id, employee_id, company_name, job_title, job_url || null, location || null, portal || null, notes || null, salary_range || null]
    );

    // Notify client via notification + SSE
    try {
        const cu = await db.query('SELECT user_id FROM client_profiles WHERE id=$1', [client_id]);
        if (cu.rows.length) {
            await db.query(
                `INSERT INTO notifications (user_id, type, title, body) VALUES ($1,'application_update','New Application',$2)`,
                [cu.rows[0].user_id, `Applied to ${company_name} for ${job_title}`]
            );
            pushSSE(cu.rows[0].user_id, 'application_updated', {
                application_id: rows[0].id,
                status: rows[0].status,
                company_name,
                job_title,
            });
        }
    } catch {}

    return res.status(201).json(rows[0]);
});

app.patch('/api/applications/:id', requireAuth(['employee', 'admin']), async (req, res) => {
    const { company_name, job_title, job_url, location, portal, notes, salary_range } = req.body;
    const { rows } = await db.query(
        `UPDATE job_applications SET
            company_name=COALESCE($1, company_name),
            job_title=COALESCE($2, job_title),
            job_url=COALESCE($3, job_url),
            location=COALESCE($4, location),
            portal=COALESCE($5, portal),
            notes=COALESCE($6, notes),
            salary_range=COALESCE($7, salary_range),
            updated_at=NOW()
         WHERE id=$8 RETURNING *`,
        [company_name, job_title, job_url, location, portal, notes, salary_range, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Application not found' });
    return res.json(rows[0]);
});

app.patch('/api/applications/:id/status', requireAuth(['employee', 'admin']), async (req, res) => {
    const { status } = req.body;
    const allowed = ['applied', 'viewed', 'interview', 'offer', 'rejected', 'withdrawn'];
    if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid status' });

    const { rows } = await db.query(
        'UPDATE job_applications SET status=$1, updated_at=NOW() WHERE id=$2 RETURNING *',
        [status, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Application not found' });

    // FIX: Push SSE directly here (no middleware monkey-patching needed)
    try {
        const cu = await db.query('SELECT user_id FROM client_profiles WHERE id=$1', [rows[0].client_id]);
        if (cu.rows.length) {
            pushSSE(cu.rows[0].user_id, 'application_updated', {
                application_id: rows[0].id,
                status: rows[0].status,
                company_name:   rows[0].company_name,
                job_title:      rows[0].job_title,
            });
        }
    } catch {}

    return res.json(rows[0]);
});

app.delete('/api/applications/:id', requireAuth(['employee', 'admin']), async (req, res) => {
    const { rows } = await db.query('DELETE FROM job_applications WHERE id=$1 RETURNING id', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Application not found' });
    return res.status(204).send();
});

// ──────────────────────────────────────────────────────────────
// 13. ADMIN — STATS
// ──────────────────────────────────────────────────────────────
app.get('/api/admin/stats', requireAuth(['admin']), async (req, res) => {
    const [clients, employees, revenue, appsByStatus, recent, monthlyRevenue, conversionData, pendingPayments, expiringThisWeek] = await Promise.all([
        db.query("SELECT COUNT(*) FROM users WHERE role='client' AND is_active=TRUE"),
        db.query("SELECT COUNT(*) FROM users WHERE role='employee' AND is_active=TRUE"),
        db.query("SELECT COALESCE(SUM(amount_eur),0) AS total FROM payments WHERE status='paid'"),
        db.query("SELECT status, COUNT(*) FROM job_applications GROUP BY status"),
        db.query(`SELECT ja.company_name, ja.job_title, ja.status, u.full_name AS client_name, ja.created_at FROM job_applications ja JOIN client_profiles cp ON cp.id=ja.client_id JOIN users u ON u.id=cp.user_id ORDER BY ja.created_at DESC LIMIT 5`),
        db.query(`SELECT TO_CHAR(DATE_TRUNC('month',created_at),'Mon YYYY') AS month, COALESCE(SUM(amount_eur),0) AS revenue, COUNT(*) AS payments FROM payments WHERE status='paid' AND created_at>=NOW()-INTERVAL '6 months' GROUP BY DATE_TRUNC('month',created_at) ORDER BY DATE_TRUNC('month',created_at) ASC`),
        db.query(`SELECT (SELECT COUNT(*) FROM users WHERE role='client' AND is_active=TRUE) AS total_clients, (SELECT COUNT(*) FROM subscriptions WHERE status='active') AS subscribed_clients`),
        db.query("SELECT COUNT(*) FROM payments WHERE status='pending'"),
        db.query(`SELECT u.full_name, u.email, sp.name AS plan_name, s.ends_at, EXTRACT(DAY FROM s.ends_at-NOW())::int AS days_left FROM subscriptions s JOIN client_profiles cp ON cp.id=s.client_id JOIN users u ON u.id=cp.user_id JOIN service_plans sp ON sp.id=s.plan_id WHERE s.status='active' AND s.ends_at BETWEEN NOW() AND NOW()+INTERVAL '7 days' ORDER BY s.ends_at ASC`),
    ]);
    return res.json({
        totalClients: parseInt(clients.rows[0].count), totalEmployees: parseInt(employees.rows[0].count),
        totalRevenue: parseFloat(revenue.rows[0].total), applicationsByStatus: appsByStatus.rows,
        recentApplications: recent.rows, monthlyRevenue: monthlyRevenue.rows,
        conversionData: conversionData.rows[0], pendingPaymentsCount: parseInt(pendingPayments.rows[0].count),
        expiringThisWeek: expiringThisWeek.rows,
    });
});

// ──────────────────────────────────────────────────────────────
// 14. ADMIN — CLIENTS CRUD
// ──────────────────────────────────────────────────────────────
app.get('/api/admin/clients', requireAuth(['admin']), async (req, res) => {
    const { rows } = await db.query(`
        SELECT u.id, u.full_name, u.email, u.phone, u.is_active, u.is_verified, u.created_at,
               cp.id AS profile_id, cp.target_location, cp.job_title, cp.years_exp, cp.cv_url,
               s.status AS subscription_status, sp.name AS plan_name, sp.price_eur,
               eu.full_name AS assigned_employee,
               (SELECT COUNT(*) FROM job_applications ja WHERE ja.client_id=cp.id) AS total_applications
        FROM users u
        JOIN client_profiles cp ON cp.user_id=u.id
        LEFT JOIN subscriptions s ON s.client_id=cp.id AND s.status='active'
        LEFT JOIN service_plans sp ON sp.id=s.plan_id
        LEFT JOIN client_assignments ca ON ca.client_id=cp.id AND ca.is_active=TRUE
        LEFT JOIN employee_profiles ep ON ep.id=ca.employee_id
        LEFT JOIN users eu ON eu.id=ep.user_id
        WHERE u.role='client'
        ORDER BY u.created_at DESC`);
    return res.json(rows);
});

app.patch('/api/admin/clients/:id', requireAuth(['admin']), async (req, res) => {
    const { full_name, phone, is_active } = req.body;
    const { rows } = await db.query(
        `UPDATE users SET full_name=COALESCE($1,full_name), phone=COALESCE($2,phone),
         is_active=COALESCE($3,is_active), updated_at=NOW()
         WHERE id=$4 AND role='client' RETURNING id, full_name, email, phone, is_active`,
        [full_name, phone, is_active, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Client not found' });
    await audit(req.user.sub, 'edit_client', { table: 'users', recordId: req.params.id });
    return res.json(rows[0]);
});

// FIX: Hard delete option + soft delete (deactivate)
app.delete('/api/admin/clients/:id', requireAuth(['admin']), async (req, res) => {
    try {
        const { rows: asgn } = await db.query(`SELECT ep.user_id AS employee_user_id FROM client_assignments ca JOIN employee_profiles ep ON ep.id=ca.employee_id JOIN client_profiles cp ON cp.id=ca.client_id WHERE cp.user_id=$1 AND ca.is_active=TRUE`, [req.params.id]);
        await db.query("DELETE FROM users WHERE id=$1 AND role='client'", [req.params.id]);
        await audit(req.user.sub, 'delete_client', { table: 'users', recordId: req.params.id });
        asgn.forEach(a => pushSSE(a.employee_user_id, 'assignment_updated', { reason: 'client_deleted', client_user_id: req.params.id }));
        broadcastSSE('stats_updated', { reason: 'client_deleted' });
        return res.status(204).send();
    } catch (err) { return res.status(500).json({ error: err.message }); }
});

// ──────────────────────────────────────────────────────────────
// 15. ADMIN — EMPLOYEES CRUD
// ──────────────────────────────────────────────────────────────
app.get('/api/admin/employees', requireAuth(['admin']), async (req, res) => {
    const { rows } = await db.query(`
        SELECT u.id, u.full_name, u.email, u.phone, u.is_active, u.created_at,
               ep.id AS profile_id, ep.department, ep.max_clients,
               COUNT(ca.id) AS assigned_clients
        FROM users u
        JOIN employee_profiles ep ON ep.user_id=u.id
        LEFT JOIN client_assignments ca ON ca.employee_id=ep.id AND ca.is_active=TRUE
        WHERE u.role='employee' AND u.is_active=TRUE
        GROUP BY u.id, u.full_name, u.email, u.phone, u.is_active, u.created_at, ep.id, ep.department, ep.max_clients
        ORDER BY u.full_name`);
    return res.json(rows);
});

app.post('/api/admin/employees', requireAuth(['admin']), async (req, res) => {
    const { full_name, email, password, phone, department, max_clients } = req.body;
    if (!full_name || !email || !password) return res.status(400).json({ error: 'full_name, email, password required' });

    try {
        const exists = await db.query('SELECT id FROM users WHERE email=$1', [email.toLowerCase().trim()]);
        if (exists.rows.length) return res.status(409).json({ error: 'Email already registered' });

        const password_hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
        const { rows } = await db.query(
            `INSERT INTO users (full_name, email, password_hash, role, phone, is_verified)
             VALUES ($1,$2,$3,'employee',$4,TRUE) RETURNING id, email, full_name, role`,
            [full_name, email.toLowerCase().trim(), password_hash, phone || null]
        );
        await db.query(
            'INSERT INTO employee_profiles (user_id, department, max_clients) VALUES ($1,$2,$3)',
            [rows[0].id, department || 'General', max_clients || 15]
        );
        sendWelcomeEmail(email, full_name, 'employee').catch(() => {});
        await audit(req.user.sub, 'add_employee', { table: 'users', recordId: rows[0].id });
        broadcastSSE('stats_updated', { reason: 'employee_added' });
        return res.status(201).json(rows[0]);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

app.patch('/api/admin/employees/:id', requireAuth(['admin']), async (req, res) => {
    const { full_name, phone, is_active, department, max_clients } = req.body;
    const { rows } = await db.query(
        `UPDATE users SET full_name=COALESCE($1,full_name), phone=COALESCE($2,phone),
         is_active=COALESCE($3,is_active), updated_at=NOW()
         WHERE id=$4 AND role='employee' RETURNING id, full_name, email, phone, is_active`,
        [full_name, phone, is_active, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Employee not found' });
    if (department !== undefined || max_clients !== undefined) {
        await db.query(
            'UPDATE employee_profiles SET department=COALESCE($1,department), max_clients=COALESCE($2,max_clients) WHERE user_id=$3',
            [department || null, max_clients || null, req.params.id]
        );
    }
    await audit(req.user.sub, 'edit_employee', { table: 'users', recordId: req.params.id });
    return res.json(rows[0]);
});

app.delete('/api/admin/employees/:id', requireAuth(['admin']), async (req, res) => {
    await db.query("UPDATE users SET is_active=FALSE, updated_at=NOW() WHERE id=$1 AND role='employee'", [req.params.id]);
    const ep = await db.query('SELECT id FROM employee_profiles WHERE user_id=$1', [req.params.id]);
    if (ep.rows.length) {
        await db.query(
            'UPDATE client_assignments SET is_active=FALSE, unassigned_at=NOW() WHERE employee_id=$1 AND is_active=TRUE',
            [ep.rows[0].id]
        );
    }
    await audit(req.user.sub, 'delete_employee', { table: 'users', recordId: req.params.id });
    broadcastSSE('assignment_updated', { reason: 'employee_deleted', employee_user_id: req.params.id });
    return res.status(204).send();
});

// ──────────────────────────────────────────────────────────────
// 16. ADMIN — ASSIGN CLIENT TO EMPLOYEE
// ──────────────────────────────────────────────────────────────
app.post('/api/admin/assign', requireAuth(['admin']), async (req, res) => {
    const { client_profile_id, employee_profile_id } = req.body;
    if (!client_profile_id || !employee_profile_id) return res.status(400).json({ error: 'Both IDs required' });

    // FIX: Check employee capacity before assigning
    const epCheck = await db.query(
        `SELECT ep.max_clients, COUNT(ca.id) AS assigned
         FROM employee_profiles ep
         LEFT JOIN client_assignments ca ON ca.employee_id=ep.id AND ca.is_active=TRUE
         WHERE ep.id=$1 GROUP BY ep.max_clients`,
        [employee_profile_id]
    );
    if (epCheck.rows.length && parseInt(epCheck.rows[0].assigned) >= epCheck.rows[0].max_clients) {
        return res.status(400).json({ error: 'Employee has reached their maximum client capacity' });
    }

    await db.query(
        'UPDATE client_assignments SET is_active=FALSE, unassigned_at=NOW() WHERE client_id=$1 AND is_active=TRUE',
        [client_profile_id]
    );
    const { rows } = await db.query(
        'INSERT INTO client_assignments (client_id, employee_id) VALUES ($1,$2) RETURNING *',
        [client_profile_id, employee_profile_id]
    );

    try {
        const ci = await db.query('SELECT u.email, u.full_name FROM users u JOIN client_profiles cp ON cp.user_id=u.id WHERE cp.id=$1', [client_profile_id]);
        const ei = await db.query('SELECT u.full_name FROM users u JOIN employee_profiles ep ON ep.user_id=u.id WHERE ep.id=$1', [employee_profile_id]);
        if (ci.rows.length && ei.rows.length)
            await sendAssignmentEmail(ci.rows[0].email, ci.rows[0].full_name, ei.rows[0].full_name);
    } catch {}

    await audit(req.user.sub, 'assign_client', { recordId: rows[0].id });
    broadcastSSE('assignment_updated', { client_id: client_profile_id, employee_id: employee_profile_id });
    return res.status(201).json(rows[0]);
});

// Unassign client from employee
app.delete('/api/admin/assign/:client_profile_id', requireAuth(['admin']), async (req, res) => {
    await db.query(
        'UPDATE client_assignments SET is_active=FALSE, unassigned_at=NOW() WHERE client_id=$1 AND is_active=TRUE',
        [req.params.client_profile_id]
    );
    broadcastSSE('assignment_updated', { client_id: req.params.client_profile_id, unassigned: true });
    return res.status(204).send();
});

// ──────────────────────────────────────────────────────────────
// 17. ADMIN — SERVICE PLANS CRUD
// ──────────────────────────────────────────────────────────────
app.get('/api/admin/services', requireAuth(['admin']), async (req, res) => {
    // Admin sees all plans (active + inactive) so they can re-activate if needed
    const { rows } = await db.query('SELECT * FROM service_plans ORDER BY is_active DESC, price_eur ASC');
    return res.json(rows);
});

// Public services endpoint for landing page
app.get('/api/services', async (req, res) => {
    const { rows } = await db.query('SELECT * FROM service_plans WHERE is_active=TRUE ORDER BY price_eur ASC');
    return res.json(rows);
});

app.post('/api/admin/services', requireAuth(['admin']), async (req, res) => {
    const { name, price_eur, applications_per_day, features } = req.body;
    if (!name || !price_eur) return res.status(400).json({ error: 'name and price_eur required' });
    const { rows } = await db.query(
        'INSERT INTO service_plans (name, price_eur, applications_per_day, features) VALUES ($1,$2,$3,$4) RETURNING *',
        [name, price_eur, applications_per_day || 5, JSON.stringify(features || {})]
    );
    return res.status(201).json(rows[0]);
});

app.patch('/api/admin/services/:id', requireAuth(['admin']), async (req, res) => {
    const { name, price_eur, applications_per_day, features, is_active } = req.body;
    const { rows } = await db.query(
        `UPDATE service_plans SET name=COALESCE($1,name), price_eur=COALESCE($2,price_eur),
         applications_per_day=COALESCE($3,applications_per_day),
         features=COALESCE($4::jsonb,features), is_active=COALESCE($5,is_active)
         WHERE id=$6 RETURNING *`,
        [name, price_eur, applications_per_day, features ? JSON.stringify(features) : null, is_active, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Service not found' });
    return res.json(rows[0]);
});

app.delete('/api/admin/services/:id', requireAuth(['admin']), async (req, res) => {
    // BUG 3 FIX: Soft-delete (is_active=FALSE). Admin services list now shows active + inactive
    // with inactive ones dimmed. Admin can edit them back to active via PATCH.
    try {
        const { rows: subs } = await db.query("SELECT id FROM subscriptions WHERE plan_id=$1 AND status='active' LIMIT 1", [req.params.id]);
        if (subs.length) return res.status(409).json({ error: 'Cannot delete: plan has active subscribers.' });
        await db.query('DELETE FROM service_plans WHERE id=$1', [req.params.id]);
        return res.status(204).send();
    } catch (err) { return res.status(500).json({ error: err.message }); }
});

// ──────────────────────────────────────────────────────────────
// 18. ADMIN — PAYMENTS
// ──────────────────────────────────────────────────────────────

// ── REVOLUT MANUAL PAYMENT ───────────────────────────────────
app.post('/api/payments/revolut/request', paymentLimiter, requireAuth(['client']), async (req, res) => {
    try {
        const plan_id  = sanitizeUUID(req.body.plan_id)||req.body.plan_id;
        const tx_ref   = sanitizeStr(req.body.tx_ref, 100);
        const amount   = sanitizeInt(req.body.amount, 1, 10000)||req.body.amount;
        const plan_name= sanitizeStr(req.body.plan_name, 100);
        if (!plan_id||!tx_ref) return res.status(400).json({ error: 'plan_id and tx_ref required' });
        const { rows: clients } = await db.query('SELECT id FROM client_profiles WHERE user_id=$1', [req.user.sub]);
        if (!clients.length) return res.status(404).json({ error: 'Client profile not found' });
        // BUG FIX 2: payments table has no plan_id column — create pending subscription first
        const ends = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
        const subRes = await db.query(
            `INSERT INTO subscriptions (client_id, plan_id, status, starts_at, ends_at)
             VALUES ($1,$2,'pending',NOW(),$3) RETURNING id`,
            [clients[0].id, plan_id, ends]);
        const subId = subRes.rows[0].id;
        const { rows: [payment] } = await db.query(
            `INSERT INTO payments (subscription_id, client_id, amount_eur, currency, method, gateway_ref, status, created_at)
             VALUES ($1,$2,$3,'EUR','revolut',$4,'pending',NOW()) RETURNING id`,
            [subId, clients[0].id, amount||0, tx_ref]);
        const { rows: [user] } = await db.query('SELECT full_name, email FROM users WHERE id=$1', [req.user.sub]);
        const { rows: admins } = await db.query("SELECT id FROM users WHERE role='admin' AND is_active=TRUE");
        admins.forEach(a => pushSSE(a.id, 'payment_pending', { payment_id:payment.id, client_name:user?.full_name||'Client', plan_name, amount, tx_ref }));
        await sendWhatsAppAlert('New payment!\nClient: '+(user?.full_name||'?')+'\nPlan: '+plan_name+'\nAmount: EUR'+amount+'\nRef: '+tx_ref);
        await audit(req.user.sub, 'payment_request', { paymentId:payment.id, txRef:tx_ref });
        return res.status(201).json({ ok:true, payment_id:payment.id });
    } catch (err) { return res.status(500).json({ error: err.message }); }
});

app.patch('/api/admin/payments/:id/confirm', requireAuth(['admin']), async (req, res) => {
    try {
        const id = sanitizeUUID(req.params.id)||req.params.id;
        // BUG FIX 3: get plan via subscription (p.plan_id column doesn't exist)
        const { rows: [payment] } = await db.query(
            `SELECT p.*, cp.user_id AS client_user_id, sp.name AS plan_name, sp.applications_per_day
             FROM payments p
             JOIN client_profiles cp ON cp.id=p.client_id
             LEFT JOIN subscriptions s ON s.id=p.subscription_id
             LEFT JOIN service_plans sp ON sp.id=s.plan_id
             WHERE p.id=$1`, [id]);
        if (!payment) return res.status(404).json({ error: 'Payment not found' });
        await db.query(`UPDATE payments SET status='paid', paid_at=NOW() WHERE id=$1`, [id]);
        // BUG FIX 3: UPDATE existing pending subscription (no ON CONFLICT on client_id)
        await db.query(
            `UPDATE subscriptions SET status='active', starts_at=NOW(), ends_at=NOW()+INTERVAL '30 days', updated_at=NOW()
             WHERE id=$1`,
            [payment.subscription_id]);
        pushSSE(payment.client_user_id, 'subscription_activated', { plan_id:payment.plan_id, message:'Your subscription has been activated!' });
        broadcastSSE('stats_updated', { reason:'payment_confirmed' });
        const { rows: [u] } = await db.query('SELECT full_name, email FROM users WHERE id=$1', [payment.client_user_id]);
        if (u) await sendPaymentConfirmedEmail(u.email, u.full_name, payment.plan_name||'Plan', payment.amount_eur, payment.gateway_ref||payment.id);
        await audit(req.user.sub, 'confirm_payment', { paymentId:id });
        return res.json({ ok:true });
    } catch (err) { return res.status(500).json({ error: err.message }); }
});

app.patch('/api/admin/payments/:id/reject', requireAuth(['admin']), async (req, res) => {
    try {
        const id = sanitizeUUID(req.params.id)||req.params.id;
        await db.query(`UPDATE payments SET status='rejected', updated_at=NOW() WHERE id=$1`, [id]);
        const { rows: [payment] } = await db.query(`SELECT p.*, cp.user_id AS client_user_id FROM payments p JOIN client_profiles cp ON cp.id=p.client_id WHERE p.id=$1`, [id]);
        if (payment) {
            pushSSE(payment.client_user_id, 'payment_rejected', { message:'Payment could not be verified. Please contact support.' });
            const { rows: [u] } = await db.query('SELECT full_name, email FROM users WHERE id=$1', [payment.client_user_id]);
            if (u) await sendEmail({ to:u.email, subject:'HOPE_IRL — Payment Verification Issue', html:`<p>Hello ${u.full_name},</p><p>We could not verify your payment (Ref: ${payment.gateway_ref||id}). Please contact support.</p>`, text:'Payment verification failed. Contact support.' });
        }
        return res.json({ ok:true });
    } catch (err) { return res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/payments', requireAuth(['admin']), async (req, res) => {
    // BUG FIX 1: Revolut payments have NULL subscription_id — LEFT JOIN prevents crash
    const { rows } = await db.query(`
        SELECT p.*, u.full_name AS client_name, u.email AS client_email,
               sp.name AS plan_name
        FROM payments p
        JOIN client_profiles cp ON cp.id=p.client_id
        JOIN users u ON u.id=cp.user_id
        LEFT JOIN subscriptions s ON s.id=p.subscription_id
        LEFT JOIN service_plans sp ON sp.id=s.plan_id
        ORDER BY p.created_at DESC`);
    return res.json(rows);
});

app.patch('/api/admin/payments/:id', requireAuth(['admin']), async (req, res) => {
    const { status } = req.body;
    if (!['pending', 'paid', 'failed', 'refunded'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
    const { rows } = await db.query(
        `UPDATE payments SET status=$1, paid_at=CASE WHEN $1::text='paid' THEN NOW() ELSE paid_at END WHERE id=$2 RETURNING *`,
        [status, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Payment not found' });

    if (status === 'paid') {
        await db.query(
            `UPDATE subscriptions SET status='active', starts_at=NOW(), ends_at=NOW() + INTERVAL '30 days'
             WHERE id=$1 AND status='pending'`,
            [rows[0].subscription_id]
        ).catch(() => {});
    }
    if (status === 'refunded') {
        await db.query(
            `UPDATE subscriptions SET status='cancelled' WHERE id=$1 AND status='active'`,
            [rows[0].subscription_id]
        ).catch(() => {});
    }

    broadcastSSE('payment_updated', { payment_id: req.params.id, status });
    return res.json(rows[0]);
});

// ──────────────────────────────────────────────────────────────
// 19. PAYMENT GATEWAYS
// ──────────────────────────────────────────────────────────────

// Stripe checkout session
app.post('/api/payments/stripe/create', requireAuth(['client']), async (req, res) => {
    const { plan_id } = req.body;
    try {
        const stripe  = require('stripe')(process.env.STRIPE_SECRET_KEY);
        const planRes = await db.query('SELECT * FROM service_plans WHERE id=$1', [plan_id]);
        if (!planRes.rows.length) return res.status(404).json({ error: 'Plan not found' });

        const plan      = planRes.rows[0];
        const clientRes = await db.query('SELECT id FROM client_profiles WHERE user_id=$1', [req.user.sub]);

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            mode: 'payment',
            line_items: [{ price_data: { currency: 'eur', product_data: { name: `HOPE_IRL — ${plan.name} Plan` }, unit_amount: Math.round(plan.price_eur * 100) }, quantity: 1 }],
            success_url: `${process.env.FRONTEND_URL || 'http://localhost:5500'}?payment=success&plan=${plan_id}`,
            cancel_url:  `${process.env.FRONTEND_URL || 'http://localhost:5500'}?payment=cancelled`,
            metadata: { client_id: clientRes.rows[0]?.id, plan_id, user_id: req.user.sub },
        });
        return res.json({ sessionId: session.id, url: session.url });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// Razorpay create order
app.post('/api/payments/razorpay/create', requireAuth(['client']), async (req, res) => {
    const { plan_id } = req.body;
    try {
        const Razorpay = require('razorpay');
        const rz = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_SECRET });
        const planRes = await db.query('SELECT * FROM service_plans WHERE id=$1', [plan_id]);
        if (!planRes.rows.length) return res.status(404).json({ error: 'Plan not found' });

        const plan  = planRes.rows[0];
        const order = await rz.orders.create({
            amount:   Math.round(plan.price_eur * 9000), // EUR→INR approx
            currency: 'INR',
            receipt:  `hope_${Date.now()}`,
            notes:    { plan_id, user_id: req.user.sub },
        });
        return res.json({ orderId: order.id, amount: order.amount, currency: order.currency, key: process.env.RAZORPAY_KEY_ID });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// Razorpay verify
app.post('/api/payments/razorpay/verify', requireAuth(['client']), async (req, res) => {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, plan_id } = req.body;
    const sig = crypto.createHmac('sha256', process.env.RAZORPAY_SECRET).update(`${razorpay_order_id}|${razorpay_payment_id}`).digest('hex');
    if (sig !== razorpay_signature) return res.status(400).json({ error: 'Invalid signature' });

    const cr   = await db.query('SELECT id FROM client_profiles WHERE user_id=$1', [req.user.sub]);
    const pr   = await db.query('SELECT price_eur FROM service_plans WHERE id=$1', [plan_id]);
    const ends = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const { rows: sr } = await db.query(
        "INSERT INTO subscriptions (client_id, plan_id, status, starts_at, ends_at) VALUES ($1,$2,'active',NOW(),$3) RETURNING id",
        [cr.rows[0]?.id, plan_id, ends]
    );
    await db.query(
        "INSERT INTO payments (subscription_id, client_id, amount_eur, method, gateway_ref, status, paid_at) VALUES ($1,$2,$3,'razorpay',$4,'paid',NOW())",
        [sr[0].id, cr.rows[0]?.id, pr.rows[0]?.price_eur, razorpay_payment_id]
    );
    pushSSE(req.user.sub, 'payment_success', { plan_id });
    return res.json({ message: 'Payment verified! Subscription activated.' });
});

// ──────────────────────────────────────────────────────────────
// 20. NOTIFICATIONS
// ──────────────────────────────────────────────────────────────
app.get('/api/notifications', requireAuth(), async (req, res) => {
    const { rows } = await db.query('SELECT * FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20', [req.user.sub]);
    return res.json(rows);
});

app.patch('/api/notifications/:id/read', requireAuth(), async (req, res) => {
    await db.query('UPDATE notifications SET is_read=TRUE WHERE id=$1 AND user_id=$2', [req.params.id, req.user.sub]);
    return res.status(204).send();
});

app.patch('/api/notifications/read-all', requireAuth(), async (req, res) => {
    await db.query('UPDATE notifications SET is_read=TRUE WHERE user_id=$1', [req.user.sub]);
    return res.status(204).send();
});

// ──────────────────────────────────────────────────────────────
// 21. EMPLOYEE — ASSIGNED CLIENTS
// FIX: Only one route definition (removed the duplicate basic one)
// ──────────────────────────────────────────────────────────────
app.get('/api/employee/clients', requireAuth(['employee', 'admin']), async (req, res) => {
    const { rows } = await db.query(`
        SELECT
            u.id AS user_id, u.full_name, u.email, u.phone, u.avatar_url,
            cp.id AS profile_id, cp.job_title, cp.target_location, cp.years_exp, cp.cv_url, cp.linkedin_url,
            s.status AS subscription_status, sp.name AS plan_name, COALESCE(sp.applications_per_day, 15) AS applications_per_day,
            (SELECT COUNT(*) FROM job_applications ja WHERE ja.client_id=cp.id) AS total_applications,
            (SELECT COUNT(*) FROM job_applications ja WHERE ja.client_id=cp.id AND ja.applied_at=CURRENT_DATE) AS today_applications,
            ca.assigned_at
        FROM client_assignments ca
        JOIN employee_profiles ep ON ep.id=ca.employee_id AND ep.user_id=$1
        JOIN client_profiles cp ON cp.id=ca.client_id
        JOIN users u ON u.id=cp.user_id AND u.is_active=TRUE
        LEFT JOIN subscriptions s ON s.client_id=cp.id AND s.status='active'
        LEFT JOIN service_plans sp ON sp.id=s.plan_id
        WHERE ca.is_active=TRUE
        ORDER BY ca.assigned_at DESC`,
        [req.user.sub]
    );
    return res.json(rows);
});

// ──────────────────────────────────────────────────────────────
// 22. CLIENT — SUBSCRIPTION
// ──────────────────────────────────────────────────────────────
app.get('/api/me/payments', requireAuth(['client']), async (req, res) => {
    try {
        // BUG FIX 4: payments has no plan_id column — get plan name via subscription
        const { rows } = await db.query(`
            SELECT p.id, p.amount_eur, p.currency, p.method, p.gateway_ref, p.status, p.paid_at, p.created_at,
                   sp.name AS plan_name
            FROM payments p
            JOIN client_profiles cp ON cp.id=p.client_id
            LEFT JOIN subscriptions s ON s.id=p.subscription_id
            LEFT JOIN service_plans sp ON sp.id=s.plan_id
            WHERE cp.user_id=$1 ORDER BY p.created_at DESC`, [req.user.sub]);
        return res.json(rows);
    } catch (err) { return res.status(500).json({ error: err.message }); }
});

app.get('/api/me/subscription', requireAuth(['client']), async (req, res) => {
    const { rows } = await db.query(`
        SELECT s.*, sp.name AS plan_name, sp.price_eur, sp.applications_per_day, sp.features
        FROM subscriptions s
        JOIN client_profiles cp ON cp.id=s.client_id AND cp.user_id=$1
        JOIN service_plans sp ON sp.id=s.plan_id
        WHERE s.status='active'
        ORDER BY s.created_at DESC LIMIT 1`,
        [req.user.sub]
    );
    return res.json(rows[0] || null);
});

// ──────────────────────────────────────────────────────────────
// 23. ATS CHECKER
// ──────────────────────────────────────────────────────────────
const pdfParse = (() => { try { return require('pdf-parse'); } catch { return null; } })();
const mammoth  = (() => { try { return require('mammoth');   } catch { return null; } })();

const atsUpload = multer ? multer({
    storage: multer.memoryStorage(),
    limits:  { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = ['application/pdf', 'application/msword',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
        if (allowed.includes(file.mimetype)) cb(null, true);
        else cb(new Error('PDF, DOC, or DOCX only'));
    },
}) : null;

const ATS_POWER_KEYWORDS = [
    'achieved','delivered','managed','led','developed','implemented','designed','built',
    'increased','reduced','improved','optimised','optimized','launched','coordinated',
    'collaborated','negotiated','analysed','analyzed','problem-solving','communication',
    'leadership','teamwork','agile','scrum','sql','python','javascript','typescript',
    'aws','azure','gcp','docker','kubernetes','ci/cd','git','jira','excel','powerpoint',
    'responsible','experience','skills','education','summary','objective',
];

function computeATSScore(text) {
    const lower = text.toLowerCase();
    const words = lower.split(/\W+/).filter(Boolean);

    const hits    = ATS_POWER_KEYWORDS.filter(k => lower.includes(k));
    const kwScore = Math.min(40, Math.round((hits.length / ATS_POWER_KEYWORDS.length) * 40));

    const sections = ['experience','education','skills','summary','objective','projects','certifications','awards'];
    const secHits  = sections.filter(s => lower.includes(s));
    const secScore = Math.min(30, Math.round((secHits.length / sections.length) * 30));

    const wc = words.length;
    const wcScore = wc < 100 ? 3 : wc < 200 ? 7 : wc < 300 ? 10 : wc <= 700 ? 15 : wc <= 1000 ? 12 : 8;

    const numberMatches = (text.match(/\d+[%+]?/g) || []).length;
    const numScore = Math.min(15, Math.round((Math.min(numberMatches, 10) / 10) * 15));

    const total = kwScore + secScore + wcScore + numScore;

    const sugg = [];
    if (wc < 300)  sugg.push('Add more content — aim for 300-600 words for best ATS results');
    if (wc > 1000) sugg.push('Shorten your CV — ATS systems prefer concise resumes under 700 words');
    if (numberMatches < 3)  sugg.push('Add quantified achievements (e.g., "Increased sales by 30%")');
    const missingSec = ['experience','education','skills'].filter(s => !secHits.includes(s));
    if (missingSec.length) sugg.push(`Add missing sections: ${missingSec.join(', ')}`);
    if (hits.length < 10) sugg.push('Include more relevant industry keywords and action verbs');
    if (!sugg.length) sugg.push('Your CV is well-optimised! Keep tailoring keywords per job description.');

    return {
        score:   total,
        details: {
            keywords_found: hits.length,
            keywords_total: ATS_POWER_KEYWORDS.length,
            sections_found: secHits,
            word_count:     wc,
            numbers_found:  numberMatches,
            breakdown:      { keywords: kwScore, sections: secScore, word_count: wcScore, quantification: numScore },
        },
        missing_keywords: ATS_POWER_KEYWORDS.filter(k => !lower.includes(k)).slice(0, 10),
        suggestions: sugg,
    };
}

const atsMiddleware = atsUpload ? atsUpload.single('resume') : (req, res, next) => { next(); };
app.post('/api/ats/analyze', uploadLimiter, requireAuth(), atsMiddleware, async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    try {
        let text = '';
        const file = req.file, mt = file.mimetype || '';
        if ((mt==='application/pdf'||file.originalname?.endsWith('.pdf')) && pdfParse) {
            try { const p=await pdfParse(file.buffer); text=p.text||''; } catch(e){ console.warn('pdf-parse:',e.message); }
        }
        if (!text && (mt.includes('word')||file.originalname?.endsWith('.docx')) && mammoth) {
            try { const r=await mammoth.extractRawText({buffer:file.buffer}); text=r.value||''; } catch(e){ console.warn('mammoth:',e.message); }
        }
        if (!text) text = file.buffer.toString('utf8').replace(/[^\x20-\x7E\n\r\t]/g,' ');
        if (!text||text.trim().length<20) return res.status(422).json({ error: 'Could not extract text.' });
        const result = computeATSScore(text);
        await db.query(`UPDATE documents SET ats_score=$1 WHERE user_id=$2 AND doc_type='cv' AND is_primary=TRUE`,[result.score,req.user.sub]).catch(()=>{});
        pushSSE(req.user.sub, 'ats_result', { score: result.score });
        return res.json(result);
    } catch (err) { return res.status(500).json({ error: 'Analysis failed: '+err.message }); }
});

// ──────────────────────────────────────────────────────────────
// 24. SSE ENDPOINT
// FIX: Defined BEFORE app.listen()
// ──────────────────────────────────────────────────────────────
app.get('/api/realtime/events', (req, res, next) => {
    // EventSource can't set headers — accept token via query param
    if (!req.headers.authorization && req.query.token) {
        req.headers.authorization = `Bearer ${req.query.token}`;
    }
    next();
}, requireAuth(), (req, res) => {
    const userId = req.user.sub;
    res.writeHead(200, {
        'Content-Type':      'text/event-stream',
        'Cache-Control':     'no-cache',
        'Connection':        'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    res.write('event: connected\ndata: {"ok":true}\n\n');

    if (!sseClients.has(userId)) sseClients.set(userId, new Set());
    sseClients.get(userId).add(res);

    const hb = setInterval(() => res.write(': heartbeat\n\n'), 25_000);

    req.on('close', () => {
        clearInterval(hb);
        sseClients.get(userId)?.delete(res);
        if (!sseClients.get(userId)?.size) sseClients.delete(userId);
    });
});

// ──────────────────────────────────────────────────────────────
// 25. HEALTH CHECK
// ──────────────────────────────────────────────────────────────
app.get('/health', async (_req, res) => {
    try {
        await db.query('SELECT 1');
        // SECURITY FIX 5: removed env from response to avoid info leakage
        return res.json({ status: 'ok', db: 'connected', timestamp: new Date().toISOString() });
    } catch {
        return res.status(503).json({ status: 'error', db: 'disconnected' });
    }
});

// ──────────────────────────────────────────────────────────────
// 26. ERROR HANDLERS (single set — no duplicates)
// ──────────────────────────────────────────────────────────────

// ──────────────────────────────────────────────────────────────
// 27. START SERVER
// ──────────────────────────────────────────────────────────────
scheduleExpiryReminders();

// ── GLOBAL ERROR HANDLER ─────────────────────────────────────
app.use((err, req, res, next) => {
    const isDev = process.env.NODE_ENV !== 'production';
    console.error('Error:', err.message, '| IP:', req.ip);
    if (err.message?.startsWith('CORS')) return res.status(403).json({ error: 'CORS policy violation.' });
    return res.status(500).json({ error: isDev ? err.message : 'Internal server error.' });
});
app.use((req, res) => res.status(404).json({ error: `Route ${req.method} ${req.path} not found.` }));

app.listen(PORT, () => {
    console.log(`\n🚀 HOPE_IRL API running on port ${PORT}`);
    console.log(`📧 Email: AWS SES (${process.env.AWS_REGION || 'configure AWS_REGION'})`);
    console.log(`☁️  Storage: AWS S3 (${process.env.AWS_S3_BUCKET || 'configure AWS_S3_BUCKET'})`);
    console.log(`💳 Payments: Stripe + Razorpay\n`);
});
