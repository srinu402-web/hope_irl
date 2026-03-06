// ============================================================
// HOPE_IRL — api.js (All API + UI Logic)
// BugFixes v1:
//   - loadEmployeeDashboard: removed reference to undefined `data` variable
//   - loadEmployeeDashboard: removed duplicate/nested clientMap block
//   - Removed Express server code (app.post) pasted at bottom
//   - Removed duplicate uploadAvatar function
//   - Payment success toast: uses 'success' not 'warning' type
//   - confirmDelete: removed spurious double setTimeout refresh
//   - Employee clients grid now uses loadEmployeeClients() cleanly
//   - selectService params unified (planId, planName, price)
// BugFixes v2:
//   - BUG 1: empTotalClients now uses assignedClients.length (not Set from apps)
//            Clients with 0 applications are now visible in employee dashboard
//   - BUG 1: loadEmployeeClients() accepts prefetchedClients to avoid double API call
//   - BUG 4: 15s polling for employee client grid (real-time assignment feeling)
//   - BUG 5: Payment success triggers immediate loadClientDashboard() at 1s
//   - MEDIUM: API_BASE auto-detects production vs localhost correctly
// BugFixes v3:
//   - confirmAssignment: console.log debug shows client_profile_id and employee_profile_id
//   - loadClientDashboard: renders clientRecentApps (real recent apps list)
//   - loadClientDashboard: calls checkAndRefreshSubscription for clientSubBadge/Status/Limit
//   - checkAndRefreshSubscription: targets new HTML IDs (clientSubBadge, clientSubStatus, clientAppsLimit)
// ============================================================

// ── API Base URL — smart detection ───────────────────────────
// Override at any time by setting: window.HOPE_API_URL = "https://your-api.com/api"
// before this script loads (e.g. in a <script> tag above api.js in index.html)
const API_BASE = (() => {
    // 1. Explicit override (highest priority)
    if (typeof window !== 'undefined' && window.HOPE_API_URL) return window.HOPE_API_URL;
    if (typeof location === 'undefined') return 'http://localhost:3001/api';
    const h = location.hostname;
    // 2. Local development (PC browser)
    if (!h || h === 'localhost' || h === '127.0.0.1') return 'http://localhost:3001/api';
    if (h === 'hope-irl-frontend.onrender.com') return 'https://hope-irl.onrender.com/api';
    // 3. LAN / Mobile on same WiFi (192.168.x.x, 10.x.x.x, 172.16-31.x.x)
    //    Live Server runs frontend on :5500, but Express backend runs on :3001
    //    Mobile needs to hit the PC IP on port 3001 directly
    if (/^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(h)) {
        return 'http://' + h + ':3001/api';
    }
    // 4. Production: same origin (nginx proxies /api → backend)
    return location.protocol + '//' + h + '/api';
})();

// ── Token Storage ─────────────────────────────────────────────
let _accessToken  = null;
let _refreshToken = null;
let _currentUser  = null;
let _pendingEmail = null;

function setTokens(at, rt) { _accessToken = at; _refreshToken = rt; }
function clearTokens()     { _accessToken = null; _refreshToken = null; _currentUser = null; }
function getCurrentUser()  { return _currentUser; }

// ── Core API Fetch ────────────────────────────────────────────
async function apiCall(path, options = {}) {
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    if (_accessToken) headers['Authorization'] = `Bearer ${_accessToken}`;

    const res = await fetch(`${API_BASE}${path}`, {
        ...options,
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
    });

    // Auto-refresh on token expiry
    if (res.status === 401 && _refreshToken) {
        const refreshed = await attemptRefresh();
        if (refreshed) {
            headers['Authorization'] = `Bearer ${_accessToken}`;
            const retry = await fetch(`${API_BASE}${path}`, {
                ...options, headers,
                body: options.body ? JSON.stringify(options.body) : undefined,
            });
            if (!retry.ok) throw await buildError(retry);
            if (retry.status === 204) return null;
            return retry.json();
        } else {
            clearTokens();
            showPage('landingPage');
            showToast('Session expired. Please log in again.', 'error');
            throw new Error('Session expired');
        }
    }

    if (!res.ok) throw await buildError(res);
    if (res.status === 204) return null;
    return res.json();
}

async function apiUpload(path, formData) {
    const headers = {};
    if (_accessToken) headers['Authorization'] = `Bearer ${_accessToken}`;
    const res = await fetch(`${API_BASE}${path}`, { method: 'POST', headers, body: formData });
    if (!res.ok) throw await buildError(res);
    return res.json();
}

async function buildError(res) {
    let body = {};
    try { body = await res.json(); } catch {}
    const err = new Error(body.error || `HTTP ${res.status}`);
    err.status  = res.status;
    err.details = body.details;
    return err;
}

async function attemptRefresh() {
    try {
        const data = await fetch(`${API_BASE}/auth/refresh`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refreshToken: _refreshToken }),
        }).then(r => r.json());
        if (data.accessToken) { setTokens(data.accessToken, data.refreshToken); return true; }
        return false;
    } catch { return false; }
}

// ── Toast ─────────────────────────────────────────────────────
function showToast(message, type = 'success') {
    document.querySelectorAll('.hope-toast').forEach(t => t.remove());
    const colors = { success: '#22c55e', error: '#dc2626', info: '#667eea', warning: '#f59e0b' };
    const toast = document.createElement('div');
    toast.className = 'hope-toast';
    toast.style.cssText = `position:fixed;bottom:1.5rem;right:1.5rem;z-index:9999;
        background:${colors[type] || colors.info};color:#fff;padding:.875rem 1.25rem;
        border-radius:.75rem;font-weight:600;font-size:.9rem;max-width:360px;
        box-shadow:0 8px 24px rgba(0,0,0,.2);animation:fadeIn .2s ease;`;
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
}

// ── AUTH ──────────────────────────────────────────────────────
async function handleLogin(e) {
    e.preventDefault();
    const email    = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;
    if (!email || !password) return showToast('Please enter email and password.', 'error');

    const btn = e.target.querySelector('button[type="submit"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Signing in...'; }

    try {
        const data = await apiCall('/auth/login', { method: 'POST', body: { email, password } });
        setTokens(data.accessToken, data.refreshToken);
        _currentUser = data.user;

        closeModal('loginModal');
        showToast(`Welcome back, ${data.user.name}! 👋`, 'success');

        const pages = { admin: 'adminDashboard', employee: 'employeeDashboard', client: 'clientDashboard' };
        setTimeout(() => {
            showPage(pages[data.user.role] || 'clientDashboard');
            updateUserDisplay(data.user);
            if (data.user.role === 'admin')    loadAdminDashboard();
            if (data.user.role === 'employee') loadEmployeeDashboard();
            if (data.user.role === 'client')   loadClientDashboard();
            loadNotifications();
            // Start real-time SSE
            setTimeout(connectSSE, 300);
        }, 300);
    } catch (err) {
        showToast(err.message || 'Login failed.', 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Sign In'; }
    }
}

function updateUserDisplay(user) {
    const initials = user.name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
    document.querySelectorAll('.user-name-display').forEach(el => el.textContent = user.name);
    document.querySelectorAll('.user-email-display').forEach(el => el.textContent = user.email);
    document.querySelectorAll('.user-initials').forEach(el => el.textContent = initials);
}

async function handleRegister(e) {
    e.preventDefault();
    const full_name = document.getElementById('registerName')?.value?.trim();
    const email     = document.getElementById('registerEmail').value.trim();
    const password  = document.getElementById('registerPassword').value;
    const phone     = document.getElementById('registerPhone')?.value?.trim();

    const btn = e.target.querySelector('button[type="submit"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Creating account...'; }

    try {
        await apiCall('/auth/register', {
            method: 'POST',
            body: { full_name, email, password, phone, role: 'client' },
        });

        _pendingEmail = email;
        closeModal('registerModal');

        const otpEmailEl = document.getElementById('otpEmailDisplay');
        if (otpEmailEl) otpEmailEl.textContent = email;
        const otpModal = document.getElementById('otpModal');
        if (otpModal) otpModal.classList.add('active');
        showToast('Account created! Check your email for OTP.', 'success');
    } catch (err) {
        if (err.details) showToast(err.details.map(d => d.message).join(', '), 'error');
        else showToast(err.message || 'Registration failed.', 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Create Account'; }
    }
}

async function verifyOTP() {
    const otp   = document.getElementById('otpInput')?.value?.trim();
    const email = _pendingEmail;
    if (!otp || otp.length !== 6) return showToast('Enter 6-digit OTP.', 'error');
    if (!email) return showToast('Email not found. Please register again.', 'error');

    try {
        await apiCall('/auth/verify-otp', { method: 'POST', body: { email, otp } });
        closeModal('otpModal');
        showToast('Email verified! Please login.', 'success');
        setTimeout(() => showLogin(), 500);
    } catch (err) {
        showToast(err.message, 'error');
    }
}

async function resendOTP() {
    if (!_pendingEmail) return showToast('Email not found.', 'error');
    try {
        await apiCall('/auth/resend-otp', { method: 'POST', body: { email: _pendingEmail } });
        showToast('OTP resent to your email!', 'success');
    } catch (err) {
        showToast(err.message, 'error');
    }
}

async function logout() {
    if (!confirm('Are you sure you want to logout?')) return;
    disconnectSSE();
    try { await apiCall('/auth/logout', { method: 'POST', body: { refreshToken: _refreshToken } }); } catch {}
    clearTokens();
    showPage('landingPage');
    showToast('Logged out successfully.', 'info');
}

// ── ADMIN STATS ───────────────────────────────────────────────
async function loadAdminStats() {
    try {
        const s = await apiCall('/admin/stats');
        const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
        set('adminTotalClients',   s.totalClients);
        set('adminTotalEmployees', s.totalEmployees);
        set('adminTotalRevenue',   `€${Number(s.totalRevenue).toLocaleString()}`);
        const total = (s.applicationsByStatus || []).reduce((a, r) => a + parseInt(r.count), 0);
        set('adminTotalApps', total);
        loadAdminAnalytics(s);
        return s;
    } catch { return null; }
}

// ── ADMIN DASHBOARD ───────────────────────────────────────────
async function loadAdminDashboard() {
    const s = await loadAdminStats();

    const div = document.getElementById('adminRecentActivity');
    if (div) {
        const recent = s?.recentApplications || [];
        div.innerHTML = recent.length ? recent.map(a => `
            <div class="flex items-center p-3 bg-gray-50 rounded-lg">
                <div class="w-10 h-10 bg-blue-100 rounded-full flex items-center justify-center mr-3 flex-shrink-0">
                    <i class="fas fa-paper-plane text-blue-600 text-sm"></i>
                </div>
                <div class="flex-1 min-w-0">
                    <div class="font-semibold text-sm truncate">${a.job_title} — ${a.company_name}</div>
                    <div class="text-xs text-gray-500">Client: ${a.client_name}</div>
                </div>
                <span class="status-badge status-${a.status} flex-shrink-0 ml-2">${a.status}</span>
            </div>`).join('')
        : `<div class="text-center text-gray-400 py-6">
            <i class="fas fa-inbox text-3xl mb-2"></i><p>No recent applications</p>
           </div>`;
    }

    await Promise.all([
        loadAdminClients(),
        loadAdminEmployees(),
        loadAdminServices(),
        loadAdminPayments(),
    ]);
}

// ── ADMIN CLIENTS TABLE ───────────────────────────────────────
async function loadAdminClients() {
    try {
        const clients = await apiCall('/admin/clients');
        const tbody   = document.getElementById('clientsTableBody');
        if (!tbody) return;
        tbody.innerHTML = clients.length ? clients.map(c => `
            <tr id="client-row-${c.id}" class="border-b hover:bg-gray-50 transition-all duration-300">
                <td class="p-4">
                    <div class="font-semibold">${escHtml(c.full_name)}</div>
                    <div class="text-xs text-gray-500">${c.is_verified ? '✅ Verified' : '⚠️ Unverified'}</div>
                </td>
                <td class="p-4 text-sm">${escHtml(c.email)}</td>
                <td class="p-4">${c.plan_name || '<span class="text-gray-400">No Plan</span>'}</td>
                <td class="p-4"><span class="status-badge ${c.is_active ? 'status-paid' : 'status-rejected'}">${c.is_active ? 'Active' : 'Inactive'}</span></td>
                <td class="p-4">${c.assigned_employee ? escHtml(c.assigned_employee) : '<span class="text-gray-400">Unassigned</span>'}</td>
                <td class="p-4 font-semibold">${c.total_applications || 0}</td>
                <td class="p-4 flex items-center gap-2">
                    <button
                        data-client-id="${c.id}"
                        data-client-name="${escAttr(c.full_name)}"
                        data-client-phone="${escAttr(c.phone || '')}"
                        data-client-active="${c.is_active}"
                        onclick="editClientFromBtn(this)"
                        class="text-blue-600 hover:text-blue-800 p-1" title="Edit">
                        <i class="fas fa-edit"></i>
                    </button>
                    <button onclick="deleteClient('${c.id}','${escAttr(c.full_name)}')"
                        class="text-red-600 hover:text-red-800 p-1" title="Delete">
                        <i class="fas fa-trash"></i>
                    </button>
                    <button onclick="assignClient('${c.profile_id}')"
                        class="text-purple-600 hover:text-purple-800 p-1" title="Assign Employee">
                        <i class="fas fa-user-plus"></i>
                    </button>
                </td>
            </tr>`).join('')
        : `<tr><td colspan="7" class="p-6 text-center text-gray-500">No clients found</td></tr>`;
    } catch (err) { showToast('Clients load failed: ' + err.message, 'error'); }
}

// ── ADMIN EMPLOYEES GRID ──────────────────────────────────────
async function loadAdminEmployees() {
    try {
        const emps = await apiCall('/admin/employees');
        const grid = document.getElementById('adminEmployeesGrid');
        if (!grid) return;
        grid.innerHTML = emps.length ? emps.map(e => {
            const initials = e.full_name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
            const pct = Math.min(100, Math.round((parseInt(e.assigned_clients) / e.max_clients) * 100));
            return `
            <div id="employee-card-${e.id}" class="border rounded-xl p-6 hover:shadow-lg transition-all duration-300">
                <div class="flex justify-between items-start mb-4">
                    <div class="flex items-center">
                        <div class="w-14 h-14 bg-purple-100 rounded-full flex items-center justify-center text-purple-600 font-bold text-lg mr-3">${initials}</div>
                        <div>
                            <div class="font-bold">${escHtml(e.full_name)}</div>
                            <div class="text-sm text-gray-600">${escHtml(e.email)}</div>
                            <div class="text-xs text-gray-400">${escHtml(e.department || 'General')}</div>
                        </div>
                    </div>
                    <div class="flex gap-2">
                        <button
                            data-emp-id="${e.id}"
                            data-emp-name="${escAttr(e.full_name)}"
                            data-emp-phone="${escAttr(e.phone || '')}"
                            data-emp-dept="${escAttr(e.department || '')}"
                            data-emp-max="${e.max_clients}"
                            data-emp-active="${e.is_active}"
                            onclick="editEmployeeFromBtn(this)"
                            class="text-blue-600 hover:text-blue-800 p-1" title="Edit">
                            <i class="fas fa-edit"></i>
                        </button>
                        <button onclick="deleteEmployee('${e.id}','${escAttr(e.full_name)}')"
                            class="text-red-600 hover:text-red-800 p-1" title="Delete">
                            <i class="fas fa-trash"></i>
                        </button>
                    </div>
                </div>
                <div class="space-y-2 text-sm">
                    <div class="flex justify-between">
                        <span class="text-gray-600">Assigned Clients:</span>
                        <span class="font-semibold">${e.assigned_clients} / ${e.max_clients}</span>
                    </div>
                    <div class="w-full bg-gray-200 rounded-full h-2">
                        <div class="gradient-bg rounded-full h-2" style="width:${pct}%"></div>
                    </div>
                    <span class="status-badge ${e.is_active ? 'status-paid' : 'status-rejected'}">${e.is_active ? 'Active' : 'Inactive'}</span>
                </div>
            </div>`;
        }).join('')
        : `<div class="col-span-3 p-6 text-center text-gray-500">No employees found</div>`;
    } catch (err) { showToast('Employees load failed: ' + err.message, 'error'); }
}

// ── ADMIN SERVICES GRID ───────────────────────────────────────
async function loadAdminServices() {
    try {
        const services = await apiCall('/admin/services');
        const grid = document.getElementById('servicesGrid');
        if (!grid) return;
        grid.innerHTML = services.length ? services.map(s => `
            <div class="border rounded-xl p-6 ${s.is_active ? '' : 'opacity-50'}">
                <div class="flex justify-between items-start mb-4">
                    <h3 class="text-xl font-bold">${escHtml(s.name)}</h3>
                    <div class="flex gap-2">
                        <button
                            data-service-id="${s.id}"
                            data-service-name="${escAttr(s.name)}"
                            data-service-price="${s.price_eur}"
                            data-service-apps="${s.applications_per_day}"
                            onclick="editServiceFromBtn(this)"
                            class="text-blue-600 hover:text-blue-800 p-1" title="Edit">
                            <i class="fas fa-edit"></i>
                        </button>
                        <button onclick="showDeleteModal('${s.id}','service','${escAttr(s.name)}')"
                            class="text-red-600 hover:text-red-800 p-1" title="Delete">
                            <i class="fas fa-trash"></i>
                        </button>
                    </div>
                </div>
                <div class="text-3xl font-bold gradient-text mb-2">€${s.price_eur}</div>
                <div class="text-sm text-gray-600 mb-3">${s.applications_per_day} applications/day</div>
                <div class="flex flex-wrap gap-1 mb-3">
                    ${s.features?.list?.length ? s.features.list.map(f => `<span class="text-xs bg-purple-50 text-purple-700 px-2 py-0.5 rounded-full">${escHtml(f)}</span>`).join('') : ''}
                </div>
                <div class="text-xs font-semibold ${s.is_active ? 'text-green-600' : 'text-red-500'}">${s.is_active ? '✅ Active' : '❌ Inactive'}</div>
            </div>`).join('')
        : `<div class="col-span-3 p-6 text-center text-gray-500">No services found</div>`;
    } catch (err) { showToast('Services load failed: ' + err.message, 'error'); }
}

// ── ADMIN PAYMENTS TABLE ──────────────────────────────────────
async function loadAdminPayments() { return loadAdminPaymentsEnhanced(); }
async function _loadAdminPaymentsOriginal() {
    try {
        const payments = await apiCall('/admin/payments');
        const tbody = document.getElementById('paymentsTableBody');
        if (!tbody) return;
        tbody.innerHTML = payments.length ? payments.map(p => `
            <tr class="border-b hover:bg-gray-50">
                <td class="p-4">
                    <div class="font-semibold">${escHtml(p.client_name)}</div>
                    <div class="text-xs text-gray-400">${escHtml(p.client_email || '')}</div>
                </td>
                <td class="p-4 font-semibold">€${parseFloat(p.amount_eur).toFixed(2)}</td>
                <td class="p-4">${escHtml(p.plan_name || '—')}</td>
                <td class="p-4 capitalize">${p.method || '—'}</td>
                <td class="p-4 text-sm text-gray-600">${new Date(p.created_at).toLocaleDateString('en-GB')}</td>
                <td class="p-4"><span class="status-badge status-${p.status}">${p.status.charAt(0).toUpperCase() + p.status.slice(1)}</span></td>
                <td class="p-4">
                    ${p.status === 'pending' ? `
                        <button onclick="adminUpdatePayment('${p.id}','paid')" class="text-green-600 hover:text-green-800 mr-2" title="Mark Paid"><i class="fas fa-check-circle text-lg"></i></button>
                        <button onclick="adminUpdatePayment('${p.id}','failed')" class="text-red-600 hover:text-red-800" title="Mark Failed"><i class="fas fa-times-circle text-lg"></i></button>
                    ` : p.status === 'paid' ? `
                        <button onclick="adminUpdatePayment('${p.id}','refunded')" class="text-yellow-600 hover:text-yellow-800" title="Mark Refunded"><i class="fas fa-undo text-lg"></i></button>
                    ` : '<span class="text-gray-300">—</span>'}
                </td>
            </tr>`).join('')
        : `<tr><td colspan="7" class="p-6 text-center text-gray-500">No payments found</td></tr>`;
    } catch (err) { showToast('Payments load failed: ' + err.message, 'error'); }
}

// ── ADMIN CRUD HELPERS ────────────────────────────────────────

function showAddEmployeeModal() {
    ['empName','empEmail','empPassword','empPhone','empDepartment'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    const mc = document.getElementById('empMaxClients');
    if (mc) mc.value = 15;
    document.getElementById('addEmployeeModal')?.classList.add('active');
}

async function addEmployee() {
    const body = {
        full_name:   document.getElementById('empName')?.value?.trim(),
        email:       document.getElementById('empEmail')?.value?.trim(),
        password:    document.getElementById('empPassword')?.value,
        phone:       document.getElementById('empPhone')?.value?.trim(),
        department:  document.getElementById('empDepartment')?.value?.trim(),
        max_clients: parseInt(document.getElementById('empMaxClients')?.value) || 15,
    };
    if (!body.full_name || !body.email || !body.password) return showToast('Name, Email, Password required.', 'error');

    const btn = document.querySelector('#addEmployeeModal button[onclick="addEmployee()"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Adding...'; }

    try {
        await apiCall('/admin/employees', { method: 'POST', body });
        showToast('Employee added successfully! ✅', 'success');
        closeModal('addEmployeeModal');
        loadAdminEmployees();
        loadAdminStats();
    } catch (err) {
        showToast(err.message, 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Add Employee'; }
    }
}

// Edit Client
function editClient(id, name, phone, isActive) {
    const el = v => document.getElementById(v);
    if (el('editClientId'))     el('editClientId').value     = id;
    if (el('editClientName'))   el('editClientName').value   = name;
    if (el('editClientPhone'))  el('editClientPhone').value  = phone;
    if (el('editClientStatus')) el('editClientStatus').value = (isActive === true || isActive === 'true') ? 'true' : 'false';
    document.getElementById('editClientModal')?.classList.add('active');
}

function editClientFromBtn(btn) {
    editClient(btn.dataset.clientId, btn.dataset.clientName, btn.dataset.clientPhone, btn.dataset.clientActive);
}

async function saveEditClient() {
    const id = document.getElementById('editClientId')?.value;
    if (!id) return showToast('No client selected.', 'error');
    const body = {
        full_name:  document.getElementById('editClientName')?.value?.trim(),
        phone:      document.getElementById('editClientPhone')?.value?.trim() || null,
        is_active:  document.getElementById('editClientStatus')?.value === 'true',
    };

    const btn = document.querySelector('#editClientModal button[onclick="saveEditClient()"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }

    try {
        await apiCall(`/admin/clients/${id}`, { method: 'PATCH', body });
        showToast('Client updated! ✅', 'success');
        closeModal('editClientModal');
        loadAdminClients();
    } catch (err) {
        showToast(err.message, 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Save Changes'; }
    }
}

// Edit Employee
function editEmployee(id, name, phone, dept, maxClients, isActive) {
    const el = v => document.getElementById(v);
    if (el('editEmployeeId'))     el('editEmployeeId').value     = id;
    if (el('editEmployeeName'))   el('editEmployeeName').value   = name;
    if (el('editEmployeePhone'))  el('editEmployeePhone').value  = phone;
    if (el('editEmployeeDept'))   el('editEmployeeDept').value   = dept;
    if (el('editEmployeeMax'))    el('editEmployeeMax').value    = maxClients;
    if (el('editEmployeeStatus')) el('editEmployeeStatus').value = (isActive === true || isActive === 'true') ? 'true' : 'false';
    document.getElementById('editEmployeeModal')?.classList.add('active');
}

function editEmployeeFromBtn(btn) {
    editEmployee(
        btn.dataset.empId,
        btn.dataset.empName,
        btn.dataset.empPhone,
        btn.dataset.empDept,
        btn.dataset.empMax,
        btn.dataset.empActive
    );
}

async function saveEditEmployee() {
    const id = document.getElementById('editEmployeeId')?.value;
    if (!id) return showToast('No employee selected.', 'error');
    const body = {
        full_name:   document.getElementById('editEmployeeName')?.value?.trim(),
        phone:       document.getElementById('editEmployeePhone')?.value?.trim() || null,
        department:  document.getElementById('editEmployeeDept')?.value?.trim(),
        max_clients: parseInt(document.getElementById('editEmployeeMax')?.value) || 15,
        is_active:   document.getElementById('editEmployeeStatus')?.value === 'true',
    };

    const btn = document.querySelector('#editEmployeeModal button[onclick="saveEditEmployee()"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }

    try {
        await apiCall(`/admin/employees/${id}`, { method: 'PATCH', body });
        showToast('Employee updated! ✅', 'success');
        closeModal('editEmployeeModal');
        loadAdminEmployees();
    } catch (err) {
        showToast(err.message, 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Save Changes'; }
    }
}

// Services
function showAddServiceModal() {
    const el = v => document.getElementById(v);
    if (el('serviceId'))     el('serviceId').value     = '';
    if (el('serviceModalTitle')) el('serviceModalTitle').textContent = 'Add Service Plan';
    ['serviceName','servicePrice','serviceAppsPerDay','serviceFeatures'].forEach(id => {
        const e = document.getElementById(id);
        if (e) e.value = '';
    });
    document.getElementById('serviceModal')?.classList.add('active');
}

function editService(id, name, price, appsPerDay) {
    const el = v => document.getElementById(v);
    if (el('serviceId'))          el('serviceId').value          = id;
    if (el('serviceModalTitle'))  el('serviceModalTitle').textContent = 'Edit Service Plan';
    if (el('serviceName'))        el('serviceName').value        = name;
    if (el('servicePrice'))       el('servicePrice').value       = price;
    if (el('serviceAppsPerDay'))  el('serviceAppsPerDay').value  = appsPerDay;
    document.getElementById('serviceModal')?.classList.add('active');
}

function editServiceFromBtn(btn) {
    editService(btn.dataset.serviceId, btn.dataset.serviceName, btn.dataset.servicePrice, btn.dataset.serviceApps);
}

async function saveService() {
    const id = document.getElementById('serviceId')?.value;
    const featuresRaw = document.getElementById('serviceFeatures')?.value || '';
    const body = {
        name:                 document.getElementById('serviceName')?.value?.trim(),
        price_eur:            parseFloat(document.getElementById('servicePrice')?.value),
        applications_per_day: parseInt(document.getElementById('serviceAppsPerDay')?.value) || 5,
        features:             { list: featuresRaw.split(',').map(s => s.trim()).filter(Boolean) },
    };
    if (!body.name || !body.price_eur) return showToast('Name and price required.', 'error');

    const btn = document.querySelector('#serviceModal button[onclick="saveService()"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }

    try {
        if (id) {
            await apiCall(`/admin/services/${id}`, { method: 'PATCH', body });
            showToast('Service updated! ✅', 'success');
        } else {
            await apiCall('/admin/services', { method: 'POST', body });
            showToast('Service added! ✅', 'success');
        }
        closeModal('serviceModal');
        loadAdminServices();
    } catch (err) {
        showToast(err.message, 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
    }
}

// Delete modal
function showDeleteModal(id, type, name) {
    const el = v => document.getElementById(v);
    if (el('deleteId'))      el('deleteId').value      = id;
    if (el('deleteType'))    el('deleteType').value    = type;
    if (el('deleteMessage')) el('deleteMessage').textContent = `Are you sure you want to delete "${name}"? This cannot be undone.`;
    document.getElementById('deleteModal')?.classList.add('active');
}

async function confirmDelete() {
    const id   = document.getElementById('deleteId')?.value;
    const type = document.getElementById('deleteType')?.value;
    if (!id || !type) return;

    const endpoints = {
        client:   `/admin/clients/${id}`,
        employee: `/admin/employees/${id}`,
        service:  `/admin/services/${id}`,
    };
    if (!endpoints[type]) return;

    const btn = document.querySelector('#deleteModal button[onclick="confirmDelete()"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Deleting...'; }

    try {
        await apiCall(endpoints[type], { method: 'DELETE' });
        showToast(`${type.charAt(0).toUpperCase() + type.slice(1)} deleted successfully ✅`, 'success');
        closeModal('deleteModal');
        // FIX: Single refresh call, no duplicate setTimeout
        if (type === 'client')   { loadAdminClients(); loadAdminStats(); }
        if (type === 'employee') { loadAdminEmployees(); loadAdminStats(); }
        if (type === 'service')  loadAdminServices();
    } catch (err) {
        showToast(err.message, 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Delete'; }
    }
}

async function adminUpdatePayment(id, status) {
    try {
        await apiCall(`/admin/payments/${id}`, { method: 'PATCH', body: { status } });
        showToast(`Payment marked as ${status.charAt(0).toUpperCase() + status.slice(1)} ✅`, 'success');
        loadAdminPayments();
        if (status === 'paid' || status === 'refunded') loadAdminStats();
    } catch (err) { showToast(err.message, 'error'); }
}

// ── ASSIGN CLIENT ─────────────────────────────────────────────
async function showAssignJobModal() {
    document.getElementById('assignJobModal')?.classList.add('active');
    try {
        const clients = await apiCall('/admin/clients');
        const sel = document.getElementById('assignClientSelect');
        if (sel) sel.innerHTML = '<option value="">-- Select Client --</option>' +
            clients.map(c => `<option value="${c.profile_id}">${escHtml(c.full_name)} (${escHtml(c.email)})</option>`).join('');
    } catch {}
    try {
        const emps = await apiCall('/admin/employees');
        const sel = document.getElementById('assignEmployeeSelect');
        if (sel) sel.innerHTML = '<option value="">-- Select Employee --</option>' +
            emps.map(e => `<option value="${e.profile_id}">${escHtml(e.full_name)} (${e.assigned_clients}/${e.max_clients} clients)</option>`).join('');
    } catch {}
}

function assignClient(profileId) {
    showAssignJobModal();
    setTimeout(() => {
        const sel = document.getElementById('assignClientSelect');
        if (sel) sel.value = profileId;
    }, 500);
}

async function confirmAssignment() {
    const clientId   = document.getElementById('assignClientSelect')?.value;
    const employeeId = document.getElementById('assignEmployeeSelect')?.value;

    // 🔍 DEBUG: Verify IDs before sending — check console to confirm profile IDs not user IDs
    console.log('🔍 Assignment debug → client_profile_id:', clientId, '| employee_profile_id:', employeeId);

    if (!clientId || !employeeId) return showToast('Select both client and employee.', 'error');

    const btn = document.querySelector('#assignJobModal button[onclick="confirmAssignment()"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Assigning...'; }

    try {
        await apiCall('/admin/assign', { method: 'POST', body: { client_profile_id: clientId, employee_profile_id: employeeId } });
        showToast('Client assigned successfully! Email sent to client ✅', 'success');
        closeModal('assignJobModal');
        loadAdminClients();
        loadAdminEmployees();
    } catch (err) {
        showToast(err.message, 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Assign Client'; }
    }
}

// ── EMPLOYEE DASHBOARD ────────────────────────────────────────
// BUG 1 FIX: assignedClients fetched from /employee/clients (NOT derived from apps)
// Clients with 0 applications were completely invisible before this fix
async function loadEmployeeDashboard() {
    const dateEl = document.getElementById('empTodayDate');
    if (dateEl) dateEl.textContent = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' });

    // Fetch assigned clients FIRST — independent of whether they have applications
    let assignedClients = [];
    try {
        assignedClients = await apiCall('/employee/clients');
    } catch (err) {
        console.error('Could not load assigned clients:', err.message);
    }

    try {
        // Fetch applications separately
        const appData = await apiCall('/applications');
        const apps    = appData.applications || [];
        const today   = new Date().toISOString().split('T')[0];
        const todayApps = apps.filter(a => a.applied_at?.startsWith(today));

        const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
        set('empTotalApps',    apps.length);
        set('empTodayApps',    todayApps.length);
        // FIX: Real client count from assignedClients, not a Set derived from apps
        set('empTotalClients', assignedClients.length);

        // Today's applications list
        const todayList = document.getElementById('empTodayTasksList');
        if (todayList) {
            todayList.innerHTML = todayApps.length
                ? todayApps.map(a => `
                    <div class="flex items-center justify-between p-3 border rounded-lg">
                        <div class="flex items-center flex-1 min-w-0">
                            <div class="w-9 h-9 bg-purple-100 rounded-full flex items-center justify-center mr-3 flex-shrink-0">
                                <i class="fas fa-building text-purple-600 text-xs"></i>
                            </div>
                            <div class="min-w-0">
                                <div class="font-semibold text-sm truncate">${escHtml(a.job_title)} — ${escHtml(a.company_name)}</div>
                                <div class="text-xs text-gray-500">Client: ${escHtml(a.client_name || '-')} · ${escHtml(a.portal || 'Direct')}</div>
                            </div>
                        </div>
                        <span class="status-badge status-${a.status} flex-shrink-0 ml-2">${a.status.charAt(0).toUpperCase() + a.status.slice(1)}</span>
                    </div>`).join('')
                : `<div class="text-center text-gray-400 py-8">
                    <i class="fas fa-check-circle text-3xl mb-2 text-green-300"></i>
                    <p class="font-semibold">No applications today yet</p>
                    <p class="text-sm">Go to Clients tab to start applying</p>
                   </div>`;
        }

        const todayStr  = new Date().toISOString().split('T')[0];
        const thisMonth = new Date().toISOString().slice(0, 7);
        const monthApps  = apps.filter(a => a.applied_at?.startsWith(thisMonth));
        const todayApps2 = apps.filter(a => a.applied_at?.startsWith(todayStr));
        const monthTotal = monthApps.length;
        const monthPct   = Math.min(100, Math.round((monthTotal/300)*100));
        const setEl2 = (id,v) => { const el=document.getElementById(id); if(el) el.textContent=v; };
        setEl2('empAppMonthTotal',monthTotal); setEl2('empAppTodayTotal',todayApps2.length);
        setEl2('empAppInterviews',apps.filter(a=>a.status==='interview').length);
        setEl2('empAppOffers',apps.filter(a=>a.status==='offer').length);
        setEl2('empAppMonthPct',monthPct);
        const bar=document.getElementById('empAppMonthBar'); if(bar) bar.style.width=monthPct+'%';
        const daywise={};
        apps.forEach(a=>{ const d=(a.applied_at||'').split('T')[0]||'Unknown'; if(!daywise[d])daywise[d]=[]; daywise[d].push(a); });
        const container=document.getElementById('empAppsDaywise');
        if(container){ if(!apps.length){ container.innerHTML=`<div class="text-center py-12 text-gray-400"><i class="fas fa-paper-plane text-4xl mb-3 block text-gray-300"></i><p>No applications yet</p></div>`; }
        else{ container.innerHTML=Object.keys(daywise).sort((a,b)=>b.localeCompare(a)).map(day=>{
            const dl=day===todayStr?'📅 Today':new Date(day).toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short',year:'numeric'});
            return `<div class="mb-6"><div class="flex items-center justify-between mb-3 sticky top-0 bg-white py-2 border-b-2 border-purple-100 z-10">
                <span class="font-bold text-gray-800">${dl}</span>
                <span class="text-xs bg-purple-100 text-purple-700 px-2 py-0.5 rounded-full font-semibold">${daywise[day].length} applications</span></div>
                <div class="space-y-2">${daywise[day].map(a=>`
                <div id="app-row-${a.id}" class="flex flex-col md:flex-row md:items-center justify-between p-3 border border-gray-100 rounded-xl hover:bg-gray-50 transition gap-3">
                    <div class="flex items-center gap-3 flex-1 min-w-0">
                        <div class="w-10 h-10 bg-purple-100 rounded-full flex items-center justify-center flex-shrink-0"><i class="fas fa-building text-purple-600 text-sm"></i></div>
                        <div class="min-w-0"><div class="font-semibold text-sm">${escHtml(a.job_title)} @ ${escHtml(a.company_name)}</div>
                        <div class="text-xs text-gray-500">👤 ${escHtml(a.client_name||'-')}</div></div>
                    </div>
                    <div class="flex items-center gap-2 flex-shrink-0">
                        <select onchange="updateApplicationStatus(this)" data-application-id="${a.id}" class="status-badge status-${a.status} border-0 cursor-pointer text-xs rounded-full px-3 py-1">
                            <option value="applied" ${a.status==='applied'?'selected':''}>Applied</option>
                            <option value="viewed" ${a.status==='viewed'?'selected':''}>Viewed</option>
                            <option value="interview" ${a.status==='interview'?'selected':''}>Interview</option>
                            <option value="offer" ${a.status==='offer'?'selected':''}>Offer</option>
                            <option value="rejected" ${a.status==='rejected'?'selected':''}>Rejected</option>
                            <option value="withdrawn" ${a.status==='withdrawn'?'selected':''}>Withdrawn</option>
                        </select>
                        <button onclick="deleteApplication('${a.id}')" class="p-1.5 text-red-500 hover:bg-red-50 rounded-lg"><i class="fas fa-trash text-sm"></i></button>
                    </div>
                </div>`).join('')}</div></div>`;
        }).join(''); } }
    } catch (err) {
        showToast('Dashboard load failed: ' + err.message, 'error');
    }

    // Render assigned clients grid using already-fetched assignedClients (no extra API call)
    await loadEmployeeClients(assignedClients);
}

// ── EMPLOYEE ASSIGNED CLIENTS GRID ───────────────────────────
// BUG 1 FIX: accepts pre-fetched clients to avoid double API call when called from loadEmployeeDashboard
// When called standalone (SSE refresh / polling), fetches fresh data itself
async function loadEmployeeClients(prefetchedClients = null) {
    const grid = document.getElementById('empClientsGrid');
    if (!grid) return;

    try {
        const clients = prefetchedClients !== null ? prefetchedClients : await apiCall('/employee/clients');
        grid.innerHTML = clients.length ? clients.map(c => {
            const initials  = c.full_name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
            const todayApps = parseInt(c.today_applications) || 0;
            const totalApps = parseInt(c.total_applications) || 0;
            const limit     = parseInt(c.applications_per_day) || 15;
            const pct       = Math.min(100, Math.round((todayApps / limit) * 100));
            return `
            <div id="emp-client-card-${c.id}" class="border rounded-xl p-6 hover:shadow-lg transition-all duration-300">
                <div class="flex justify-between items-start mb-4">
                    <div class="flex items-center gap-3">
                        ${c.avatar_url
                            ? `<img src="${c.avatar_url}" class="w-12 h-12 rounded-full object-cover">`
                            : `<div class="w-12 h-12 bg-purple-100 rounded-full flex items-center justify-center text-purple-600 font-bold">${initials}</div>`}
                        <div>
                            <h3 class="font-bold">${escHtml(c.full_name)}</h3>
                            <p class="text-xs text-gray-500">${escHtml(c.email)}</p>
                            ${c.job_title ? `<p class="text-xs text-purple-600">${escHtml(c.job_title)}</p>` : ''}
                        </div>
                    </div>
                    <span class="status-badge ${c.subscription_status === 'active' ? 'status-paid' : 'status-pending'}">
                        ${escHtml(c.plan_name || 'No Plan')}
                    </span>
                </div>
                <div class="space-y-2 text-sm mb-4">
                    <div class="flex justify-between">
                        <span class="text-gray-600">Today's Applications:</span>
                        <span class="font-semibold ${todayApps >= limit ? 'text-red-600' : 'text-green-600'}">${todayApps} / ${limit}</span>
                    </div>
                    <div class="w-full bg-gray-200 rounded-full h-2">
                        <div class="gradient-bg rounded-full h-2" style="width:${pct}%"></div>
                    </div>
                    <div class="flex justify-between">
                        <span class="text-gray-600">Total Applications:</span>
                        <span class="font-semibold">${totalApps}</span>
                    </div>
                    ${c.target_location ? `<div class="text-xs text-gray-500"><i class="fas fa-map-marker-alt mr-1"></i>${escHtml(c.target_location)}</div>` : ''}
                </div>
                <div class="flex gap-2">
                    <button onclick="showApplyJobModal('${escAttr(c.full_name)}','${c.profile_id}')"
                        class="${todayApps >= limit ? 'bg-gray-300 cursor-not-allowed' : 'gradient-bg'} text-white py-2 px-3 rounded-lg text-sm font-semibold flex-1"
                        ${todayApps >= limit ? 'disabled title="Daily limit reached"' : ''}>
                        <i class="fas fa-plus mr-1"></i>Apply Jobs
                    </button>
                    ${c.cv_url ? `<a href="${c.cv_url}" target="_blank" class="text-purple-600 border border-purple-300 py-2 px-3 rounded-lg text-sm flex items-center" title="View CV"><i class="fas fa-file-pdf"></i></a>` : ''}
                </div>
            </div>`;
        }).join('')
        : `<div class="col-span-2 p-8 text-center text-gray-400">
            <i class="fas fa-users text-4xl mb-3"></i>
            <p class="font-semibold">No clients assigned yet</p>
            <p class="text-sm">Contact your admin to get clients assigned</p>
           </div>`;
    } catch (err) {
        showToast('Could not load clients: ' + err.message, 'error');
        grid.innerHTML = `<div class="col-span-2 p-4 text-center text-red-500">Failed to load clients. Please refresh.</div>`;
    }
}

// ── CLIENT DASHBOARD ──────────────────────────────────────────
async function loadClientDashboard() {
    try {
        const appData = await apiCall('/applications');
        const apps    = appData.applications || [];
        const today   = new Date().toISOString().split('T')[0];

        const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
        set('clientTotalApps',  apps.length);
        set('clientInterviews', apps.filter(a => a.status === 'interview').length);
        set('clientOffers',     apps.filter(a => a.status === 'offer').length);

        // ── Recent Applications — client dashboard overview (clientRecentApps)
        const recentAppsEl = document.getElementById('clientRecentApps');
        if (recentAppsEl) {
            const recent = apps.slice(0, 5); // show last 5
            recentAppsEl.innerHTML = recent.length ? recent.map(a => `
                <div class="flex items-center justify-between p-3 border rounded-lg hover:bg-gray-50">
                    <div class="flex items-center gap-3">
                        <div class="w-9 h-9 bg-blue-100 rounded-full flex items-center justify-center flex-shrink-0">
                            <i class="fas fa-building text-blue-600 text-xs"></i>
                        </div>
                        <div>
                            <div class="font-semibold text-sm">${escHtml(a.job_title)}</div>
                            <div class="text-xs text-gray-500">${escHtml(a.company_name)} · ${new Date(a.applied_at).toLocaleDateString('en-GB')}</div>
                        </div>
                    </div>
                    <span class="status-badge status-${a.status} flex-shrink-0">${a.status.charAt(0).toUpperCase() + a.status.slice(1)}</span>
                </div>`).join('')
            : `<div class="text-center text-gray-400 py-6">
                <i class="fas fa-paper-plane text-3xl mb-2 text-gray-300"></i>
                <p>No applications yet — your consultant is getting started!</p>
               </div>`;
        }

        // ── Full applications table
        const tbody = document.getElementById('clientApplicationsTableBody');
        if (tbody) {
            tbody.innerHTML = apps.length ? apps.map(a => `
                <tr class="border-b hover:bg-gray-50">
                    <td class="p-4 font-semibold">${escHtml(a.company_name)}</td>
                    <td class="p-4">${escHtml(a.job_title)}</td>
                    <td class="p-4">${escHtml(a.location || '-')}</td>
                    <td class="p-4">${new Date(a.applied_at).toLocaleDateString('en-GB')}</td>
                    <td class="p-4"><span class="status-badge status-${a.status}">${a.status.charAt(0).toUpperCase() + a.status.slice(1)}</span></td>
                </tr>`).join('')
            : `<tr><td colspan="5" class="p-6 text-center text-gray-500">No applications yet. Your consultant will apply on your behalf.</td></tr>`;
        }

        // ── Refresh subscription badge (clientSubBadge, clientSubStatus, clientAppsLimit)
        await checkAndRefreshSubscription();
    } catch (err) { showToast('Dashboard load failed: ' + err.message, 'error'); }
}

// ── APPLICATIONS CRUD ─────────────────────────────────────────
async function submitJobApplication() {
    const clientId = document.getElementById('clientNameField')?.dataset?.clientId;
    const company  = document.getElementById('jobCompany')?.value?.trim();
    const title    = document.getElementById('jobTitle')?.value?.trim();
    const url      = document.getElementById('jobUrl')?.value?.trim();
    const location = document.getElementById('jobLocation')?.value?.trim();
    const portal   = document.getElementById('jobPortal')?.value?.trim();
    const notes    = document.getElementById('jobNotes')?.value?.trim();

    if (!company || !title) return showToast('Company and Job Title required.', 'error');
    if (!clientId)          return showToast('No client selected.', 'error');

    const btn = document.querySelector('#applyJobModal button[onclick="submitJobApplication()"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Submitting...'; }

    try {
        await apiCall('/applications', {
            method: 'POST',
            body: { client_id: clientId, company_name: company, job_title: title, job_url: url, location, portal, notes },
        });
        showToast('Application submitted! ✅', 'success');
        closeModal('applyJobModal');
        // Clear fields
        ['jobCompany','jobTitle','jobUrl','jobLocation','jobPortal','jobNotes'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.value = '';
        });
        loadEmployeeDashboard();
    } catch (err) {
        showToast(err.message, 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Submit Application'; }
    }
}

async function updateApplicationStatus(selectEl) {
    const id     = selectEl.dataset.applicationId;
    const status = selectEl.value;
    if (!id) return;
    try {
        await apiCall(`/applications/${id}/status`, { method: 'PATCH', body: { status } });
        showToast(`Status updated → "${status}" ✅`, 'success');
        selectEl.className = `status-badge status-${status} border-0 cursor-pointer text-xs`;
    } catch (err) {
        showToast(err.message, 'error');
        // Revert select
        loadEmployeeDashboard();
    }
}

async function deleteApplication(id) {
    if (!confirm('Delete this application?')) return;
    try {
        await apiCall(`/applications/${id}`, { method: 'DELETE' });
        const row=document.getElementById(`app-row-${id}`);
        if(row){row.style.transition='all 0.3s ease';row.style.opacity='0';row.style.transform='translateX(20px)';setTimeout(()=>{row.remove();loadEmployeeDashboard();},300);}
        else loadEmployeeDashboard();
        showToast('Application deleted ✅', 'success');
    } catch (err) { showToast(err.message, 'error'); }
}

// ── CV UPLOAD ─────────────────────────────────────────────────
function showCVUploadModal() {
    const inp = document.getElementById('cvFileInput');
    if (inp) inp.value = '';
    const nm = document.getElementById('cvFileName');
    if (nm) nm.textContent = '';
    document.getElementById('cvUploadModal')?.classList.add('active');
}

function cvFileSelected(input) {
    const file = input.files[0];
    if (file) {
        const nm = document.getElementById('cvFileName');
        if (nm) nm.innerHTML = `<i class="fas fa-file-pdf mr-1"></i>${escHtml(file.name)}`;
    }
}

async function uploadCV() {
    const input   = document.getElementById('cvFileInput');
    const docType = document.getElementById('cvDocType')?.value || 'cv';
    const file    = input?.files?.[0];
    if (!file) return showToast('Please select a file.', 'error');

    const btn = document.querySelector('#cvUploadModal button[onclick="uploadCV()"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Uploading...'; }

    const formData = new FormData();
    formData.append('file', file);
    formData.append('doc_type', docType);

    try {
        showToast('Uploading...', 'info');
        const result = await apiUpload('/documents/upload', formData);
        showToast('File uploaded successfully! ✅', 'success');
        closeModal('cvUploadModal');
        console.log('Uploaded:', result.url);
    } catch (err) {
        showToast(err.message || 'Upload failed', 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Upload'; }
    }
}

// ── PAYMENT GATEWAY ───────────────────────────────────────────
let _selectedPlanId    = null;
let _selectedPlanName  = null;
let _selectedPlanPrice = null;

// FIX: unified function signature (planId, planName, price)
function selectService(planId, planName, price) {
    _selectedPlanId    = planId;
    _selectedPlanName  = planName;
    _selectedPlanPrice = price;

    const nameEl  = document.getElementById('gatewayPlanName');
    const priceEl = document.getElementById('gatewayPlanPrice');
    if (nameEl)  nameEl.textContent  = planName;
    if (priceEl) priceEl.textContent = `€${price}`;

    document.getElementById('paymentGatewayModal')?.classList.add('active');
}

async function payWithStripe() {
    if (!_selectedPlanId) return showToast('No plan selected.', 'error');
    if (!_accessToken)    return showToast('Please log in first.', 'error');
    try {
        showToast('Redirecting to Stripe...', 'info');
        const data = await apiCall('/payments/stripe/create', { method: 'POST', body: { plan_id: _selectedPlanId } });
        window.location.href = data.url;
    } catch (err) { showToast(err.message, 'error'); }
}

async function payWithRazorpay() {
    if (!_selectedPlanId) return showToast('No plan selected.', 'error');
    if (!_accessToken)    return showToast('Please log in first.', 'error');
    try {
        const data = await apiCall('/payments/razorpay/create', { method: 'POST', body: { plan_id: _selectedPlanId } });

        const options = {
            key:         data.key,
            amount:      data.amount,
            currency:    data.currency,
            name:        'HOPE_IRL',
            description: _selectedPlanName,
            order_id:    data.orderId,
            handler: async function(response) {
                try {
                    await apiCall('/payments/razorpay/verify', {
                        method: 'POST',
                        body: {
                            razorpay_order_id:   response.razorpay_order_id,
                            razorpay_payment_id: response.razorpay_payment_id,
                            razorpay_signature:  response.razorpay_signature,
                            plan_id:             _selectedPlanId,
                        },
                    });
                    showToast('Payment successful! Subscription activated. 🎉', 'success');
                    closeModal('paymentGatewayModal');
                    loadClientDashboard();
                } catch (err) { showToast('Payment verification failed: ' + err.message, 'error'); }
            },
            theme: { color: '#667eea' },
        };

        const rzp = new Razorpay(options);
        rzp.open();
    } catch (err) { showToast(err.message, 'error'); }
}

function requestBankTransfer() {
    closeModal('paymentGatewayModal');
    showToast('Bank transfer details will be sent to your email. Contact support@hope-irl.com', 'info');
}

// ── SUBSCRIPTION ──────────────────────────────────────────────
async function checkAndRefreshSubscription() {
    try {
        const sub = await apiCall('/me/subscription');
        if (sub) {
            const subBadge = document.getElementById('clientSubBadge');
            if (subBadge) { subBadge.textContent = sub.plan_name; subBadge.className = 'status-badge status-paid'; }
            const subStatus = document.getElementById('clientSubStatus');
            if (subStatus) subStatus.textContent = `${sub.plan_name} — Active until ${new Date(sub.ends_at).toLocaleDateString('en-GB')}`;
            const appsLimit = document.getElementById('clientAppsLimit');
            if (appsLimit) appsLimit.textContent = `${sub.applications_per_day} applications/day`;
        }
    } catch {}
}

// ── NOTIFICATIONS ─────────────────────────────────────────────
async function loadNotifications() {
    try {
        const notifs = await apiCall('/notifications');
        const unread = notifs.filter(n => !n.is_read).length;
        const badge  = document.getElementById('notifBadge');
        if (badge) badge.textContent = unread > 0 ? unread : '';
    } catch {}
}

// ── AVATAR UPLOAD ─────────────────────────────────────────────
function showAvatarUploadModal() {
    const inp = document.getElementById('avatarUploadInput');
    if (inp) inp.value = '';
    const preview = document.getElementById('avatarPreview');
    if (preview) { preview.src = ''; preview.classList.add('hidden'); }
    const placeholder = document.getElementById('avatarPlaceholder');
    if (placeholder) placeholder.style.display = '';
    document.getElementById('avatarUploadModal')?.classList.add('active');
}

function avatarFileSelected(input) {
    const file = input.files[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { showToast('Image must be under 5MB', 'error'); return; }
    const reader = new FileReader();
    reader.onload = e => {
        const preview     = document.getElementById('avatarPreview');
        const placeholder = document.getElementById('avatarPlaceholder');
        if (preview)     { preview.src = e.target.result; preview.classList.remove('hidden'); }
        if (placeholder)   placeholder.style.display = 'none';
    };
    reader.readAsDataURL(file);
}

async function uploadAvatar() {
    const input = document.getElementById('avatarUploadInput');
    const file  = input?.files?.[0];
    if (!file) return showToast('Please select an image.', 'error');

    const btn = document.querySelector('#avatarUploadModal button[onclick="uploadAvatar()"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Uploading...'; }

    const formData = new FormData();
    formData.append('avatar', file);

    try {
        showToast('Uploading avatar...', 'info');
        const result = await apiUpload('/me/avatar', formData);
        document.querySelectorAll('.user-avatar-img').forEach(img => {
            img.src = result.avatar_url;
            img.classList.remove('hidden');
        });
        document.querySelectorAll('.user-initials-avatar').forEach(el => el.classList.add('hidden'));
        showToast('Profile picture updated! ✅', 'success');
        closeModal('avatarUploadModal');
    } catch (err) {
        showToast(err.message || 'Upload failed', 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Upload'; }
    }
}

// ── ATS BACKEND ANALYZER ──────────────────────────────────────
async function analyzeResumeBackend(file) {
    const formData = new FormData();
    formData.append('resume', file);

    const results = document.getElementById('atsResults');
    const nameEl  = document.getElementById('fileName');
    if (nameEl) nameEl.innerHTML = `<i class="fas fa-spinner fa-spin mr-2 text-purple-600"></i> Analyzing ${escHtml(file.name)}...`;

    try {
        const data = await apiUpload('/ats/analyze', formData);

        if (results) results.classList.remove('hidden');

        const score   = data.score;
        const scoreEl = document.getElementById('scoreValue');
        if (scoreEl) scoreEl.textContent = score + '%';

        const circle = document.getElementById('scoreCircle');
        if (circle) {
            const circumference = 2 * Math.PI * 56;
            circle.style.strokeDashoffset = circumference - (score / 100) * circumference;
            circle.style.stroke = score >= 85 ? '#22c55e' : score >= 70 ? '#eab308' : '#ef4444';
        }

        const msg = document.getElementById('scoreMessage');
        if (msg) {
            const color = score >= 85 ? 'green' : score >= 70 ? 'yellow' : 'red';
            const icon  = score >= 85 ? 'check-circle' : score >= 70 ? 'exclamation-circle' : 'times-circle';
            const label = score >= 85 ? 'Excellent! Highly ATS-compatible.' : score >= 70 ? 'Good! Room for improvement.' : 'Needs Improvement.';
            msg.innerHTML = `
                <p class="font-semibold text-${color}-800"><i class="fas fa-${icon} mr-2"></i>${label}</p>
                ${data.suggestions?.length ? `<ul class="mt-2 text-sm text-${color}-700 list-disc list-inside">${data.suggestions.map(s => `<li>${escHtml(s)}</li>`).join('')}</ul>` : ''}
                ${data.details ? `<div class="mt-3 grid grid-cols-2 gap-2 text-xs text-gray-600">
                    <span>Keywords: ${data.details.keywords_found}/${data.details.keywords_total}</span>
                    <span>Word Count: ${data.details.word_count}</span>
                    <span>Sections: ${data.details.sections_found?.length || 0}/8</span>
                    <span>Numbers: ${data.details.numbers_found}</span>
                </div>` : ''}
                ${data.missing_keywords?.length ? `<div class="mt-2 text-xs text-gray-500">Missing keywords: ${data.missing_keywords.map(escHtml).join(', ')}</div>` : ''}`;
            msg.className = `text-left p-4 bg-${color}-50 border border-${color}-200 rounded-lg`;
        }

        if (nameEl) nameEl.innerHTML = `<i class="fas fa-file-alt text-green-600 mr-2"></i><span class="font-semibold">${escHtml(file.name)}</span><span class="text-green-600 ml-2"><i class="fas fa-check-circle"></i> Analyzed</span>`;
        results?.scrollIntoView({ behavior: 'smooth' });
    } catch (err) {
        showToast('ATS analysis failed: ' + err.message, 'error');
        if (nameEl) nameEl.innerHTML = '';
    }
}

// Override handleResumeUpload to use backend when logged in
window.handleResumeUpload = function(event) {
    const file = event.target.files[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { alert('File too large. Max 5MB.'); return; }
    const allowed = ['application/pdf','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
    if (!allowed.includes(file.type)) { alert('Please upload PDF, DOC, or DOCX.'); return; }

    if (_accessToken) {
        analyzeResumeBackend(file);
    } else {
        // Fall back to UI-only mock from script.js
        const nameEl = document.getElementById('fileName');
        if (nameEl) nameEl.innerHTML = `<i class="fas fa-spinner fa-spin mr-2 text-purple-600"></i> Analyzing ${escHtml(file.name)}...`;
        setTimeout(() => analyzeResume?.(file), 2000);
    }
};

// ── REAL-TIME SSE ─────────────────────────────────────────────
let _sseSource  = null;
let _sseRetries = 0;

function connectSSE() {
    if (!_accessToken) return;
    if (_sseSource) { _sseSource.close(); _sseSource = null; }

    const url = `${API_BASE}/realtime/events?token=${encodeURIComponent(_accessToken)}`;
    _sseSource = new EventSource(url);

    _sseSource.addEventListener('connected', () => {
        _sseRetries = 0;
        console.log('🔴 Real-time SSE connected');
        const ind = document.getElementById('realtimeIndicator');
        if (ind) ind.style.display = 'block';
    });

    _sseSource.addEventListener('application_updated', (e) => {
        const data = JSON.parse(e.data);
        showToast(`📬 ${data.company_name} → "${data.status}"`, 'info');
        if (_currentUser?.role === 'client')   loadClientDashboard();
        if (_currentUser?.role === 'employee') loadEmployeeDashboard();
        if (_currentUser?.role === 'admin')    loadAdminStats();
    });

    _sseSource.addEventListener('assignment_updated', (e) => {
        let data={}; try{data=JSON.parse(e.data);}catch{}
        if(_currentUser?.role==='admin'){loadAdminClients();loadAdminEmployees();showToast('📋 Client assignment updated','info');}
        if(_currentUser?.role==='employee'){
            if(data.reason==='client_deleted'&&data.client_user_id){
                const card=document.getElementById(`emp-client-card-${data.client_user_id}`);
                if(card){card.style.transition='all 0.3s ease';card.style.opacity='0';card.style.transform='scale(0.9)';setTimeout(()=>{card.remove();},300);showToast('A client was removed from your list','info');}
                else loadEmployeeClients();
            } else loadEmployeeClients();
        }
    });

    _sseSource.addEventListener('payment_updated', () => {
        if (_currentUser?.role === 'admin') {
            loadAdminPayments();
            loadAdminStats();
        }
        if (_currentUser?.role === 'client') checkAndRefreshSubscription();
    });

    _sseSource.addEventListener('payment_success', () => {
        if (_currentUser?.role === 'client') {
            showToast('🎉 Payment successful! Subscription activated.', 'success');
            loadClientDashboard();
        }
    });

    _sseSource.addEventListener('profile_updated', (e) => {
        const data = JSON.parse(e.data);
        if (data.avatar_url) {
            document.querySelectorAll('.user-avatar-img').forEach(img => {
                img.src = data.avatar_url;
                img.classList.remove('hidden');
            });
            document.querySelectorAll('.user-initials-avatar').forEach(el => el.classList.add('hidden'));
        }
    });

    _sseSource.addEventListener('ats_result', (e) => {
        const data = JSON.parse(e.data);
        showToast(`ATS Score: ${data.score}/100`, data.score >= 70 ? 'success' : 'warning');
    });

    setupPaymentSSEHandlers();
    _sseSource.addEventListener('stats_updated', () => {
        if (_currentUser?.role === 'admin') loadAdminStats();
    });

    _sseSource.onerror = () => {
        _sseSource.close();
        _sseSource = null;
        const ind = document.getElementById('realtimeIndicator');
        if (ind) ind.style.display = 'none';
        _sseRetries++;
        const delay = Math.min(30_000, 2000 * Math.pow(2, _sseRetries));
        setTimeout(connectSSE, delay);
    };
}

function disconnectSSE() {
    if (_sseSource) { _sseSource.close(); _sseSource = null; }
}

// ── HTML ESCAPE HELPERS ───────────────────────────────────────
function escHtml(str) {
    return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function escAttr(str) {
    return String(str || '').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ── INIT ──────────────────────────────────────────────────────

// ════════════════════════════════════════════════════════════════
// FEATURE FUNCTIONS — all consolidated
// ════════════════════════════════════════════════════════════════

function formatFeatureKey(k) {
    const abbrevs={'ats':'ATS','cv':'CV','linkedin':'LinkedIn','whatsapp':'WhatsApp'};
    return k.replace(/_/g,' ').split(' ').map(w=>abbrevs[w.toLowerCase()]||(w.charAt(0).toUpperCase()+w.slice(1).toLowerCase())).join(' ');
}

async function deleteClient(id,name){
    if(!confirm(`Delete client "${name}"?`)) return;
    try{
        await apiCall(`/admin/clients/${id}`,{method:'DELETE'});
        const row=document.getElementById(`client-row-${id}`);
        if(row){row.style.transition='all 0.3s ease';row.style.opacity='0';row.style.transform='translateX(20px)';setTimeout(()=>{row.remove();loadAdminStats();},300);}
        showToast(`"${name}" deleted ✅`,'success');
    }catch(err){showToast(err.message,'error');}
}
async function deleteEmployee(id,name){
    if(!confirm(`Delete employee "${name}"?`)) return;
    try{
        await apiCall(`/admin/employees/${id}`,{method:'DELETE'});
        const card=document.getElementById(`employee-card-${id}`);
        if(card){card.style.transition='all 0.3s ease';card.style.opacity='0';card.style.transform='scale(0.9)';setTimeout(()=>{card.remove();loadAdminStats();},300);}
        showToast(`"${name}" deleted ✅`,'success');
    }catch(err){showToast(err.message,'error');}
}

// Landing Services
const FALLBACK_SERVICES=[
    {id:'f1',name:'Basic',price_eur:99,applications_per_day:5,features:{list:['CV Review','ATS Check','Email Support']}},
    {id:'f2',name:'Professional',price_eur:179,applications_per_day:10,features:{list:['CV Review','Cover Letter','ATS Check','WhatsApp Support']}},
    {id:'f3',name:'Premium',price_eur:249,applications_per_day:15,features:{list:['CV Review','Cover Letter','ATS Check','Dedicated Support','LinkedIn Optimisation']}},
];
function renderLandingServiceCards(services){
    return services.map((s,i)=>{
        let fl=[];
        if(s.features?.list?.length) fl=s.features.list;
        else if(s.features&&typeof s.features==='object') fl=Object.entries(s.features).filter(([,v])=>v===true).map(([k])=>formatFeatureKey(k));
        return `<div class="bg-white p-6 md:p-8 rounded-xl ${i===0?'shadow-xl border-4 border-purple-500 relative':'shadow-lg'} hover:shadow-xl transition">
            ${i===0?'<div class="absolute top-0 right-0 bg-purple-500 text-white px-3 py-1 rounded-bl-lg rounded-tr-lg text-xs font-semibold">MOST POPULAR</div>':''}
            <div class="text-center mb-6"><h3 class="text-xl md:text-2xl font-bold mb-2">${escHtml(s.name)}</h3>
            <div class="text-4xl md:text-5xl font-bold gradient-text mb-2">€${parseFloat(s.price_eur).toFixed(0)}</div>
            <div class="text-gray-500 text-sm">${s.applications_per_day} applications/day</div></div>
            <ul class="space-y-3 mb-6 md:mb-8 min-h-[100px]">${fl.map(f=>`<li class="flex items-start text-sm md:text-base"><i class="fas fa-check text-green-500 mt-1 mr-3 flex-shrink-0"></i><span>${escHtml(f)}</span></li>`).join('')}</ul>
            <button onclick="selectService('${s.id}','${escAttr(s.name)}',${s.price_eur})" class="w-full gradient-bg text-white py-3 rounded-lg font-semibold hover:opacity-90">Choose Plan</button>
        </div>`;
    }).join('');
}
async function loadLandingServices(){
    const grid=document.getElementById('landingServicesGrid'); if(!grid) return;
    grid.innerHTML=renderLandingServiceCards(FALLBACK_SERVICES);
    try{ const ctrl=new AbortController(); const t=setTimeout(()=>ctrl.abort(),4000); const res=await fetch(`${API_BASE}/services`,{signal:ctrl.signal}); clearTimeout(t); if(res.ok){const svcs=await res.json();if(svcs?.length)grid.innerHTML=renderLandingServiceCards(svcs);} }catch{}
}

// Revolut Payment
function selectService(planId,planName,price){
    _selectedPlanId=planId; _selectedPlanName=planName; _selectedPlanPrice=price;
    const nameEl=document.getElementById('gatewayPlanName'); const priceEl=document.getElementById('gatewayPlanPrice');
    if(nameEl) nameEl.textContent=planName; if(priceEl) priceEl.textContent=`€${price}`;
    const payLink=document.getElementById('revolutPayLink');
    if(payLink) payLink.href=`https://revolut.me/subrah2xwv?amount=${price}`;
    const refInput=document.getElementById('revolutTxRef'); if(refInput) refInput.value='';
    if(!_accessToken){ closeModal('paymentGatewayModal'); showToast('Please login first.','error'); showLogin(); return; }
    document.getElementById('paymentGatewayModal')?.classList.add('active');
}
async function submitRevolutPayment(){
    if(!_selectedPlanId) return showToast('No plan selected.','error');
    if(!_accessToken) return showToast('Please log in first.','error');
    const txRef=document.getElementById('revolutTxRef')?.value?.trim();
    if(!txRef) return showToast('Please enter your Revolut transaction reference.','error');
    const btn=document.querySelector('#paymentGatewayModal button[onclick="submitRevolutPayment()"]');
    if(btn){btn.disabled=true;btn.innerHTML='<i class="fas fa-spinner fa-spin mr-2"></i>Submitting...';}
    try{
        await apiCall('/payments/revolut/request',{method:'POST',body:{plan_id:_selectedPlanId,tx_ref:txRef,amount:_selectedPlanPrice,plan_name:_selectedPlanName}});
        closeModal('paymentGatewayModal');
        const setPl=(id,v)=>{const el=document.getElementById(id);if(el)el.textContent=v;};
        setPl('submittedPlanName',_selectedPlanName); setPl('submittedPlanDetail',_selectedPlanName);
        setPl('submittedAmountDetail',`€${_selectedPlanPrice}`); setPl('submittedRefDetail',txRef);
        document.getElementById('paymentSubmittedModal')?.classList.add('active');
    }catch(err){showToast('Submission failed: '+err.message,'error');}
    finally{if(btn){btn.disabled=false;btn.innerHTML='<i class="fas fa-paper-plane mr-2"></i>Submit Payment Request';}}
}
async function confirmRevolutPayment(paymentId){
    if(!confirm('Confirm this payment and activate subscription?')) return;
    try{
        await apiCall(`/admin/payments/${paymentId}/confirm`,{method:'PATCH'});
        const row=document.getElementById(`payment-row-${paymentId}`);
        if(row){row.style.transition='all 0.3s';row.style.opacity='0';setTimeout(()=>{row.remove();loadAdminPayments();loadAdminStats();},300);}
        showToast('Payment confirmed ✅ Email sent to client!','success');
    }catch(err){showToast('Error: '+err.message,'error');}
}
async function rejectRevolutPayment(paymentId){
    if(!confirm('Reject this payment?')) return;
    try{
        await apiCall(`/admin/payments/${paymentId}/reject`,{method:'PATCH'});
        const row=document.getElementById(`payment-row-${paymentId}`);
        if(row){row.style.transition='all 0.3s';row.style.opacity='0';setTimeout(()=>{row.remove();loadAdminPayments();},300);}
        showToast('Payment rejected ❌','info');
    }catch(err){showToast('Error: '+err.message,'error');}
}

// Payment table with Revolut rows
async function loadAdminPaymentsEnhanced(){
    try{
        const payments=await apiCall('/admin/payments');
        const tbody=document.getElementById('paymentsTableBody'); if(!tbody) return;
        const pendingCount=payments.filter(p=>p.status==='pending'&&p.method==='revolut').length;
        const badge=document.getElementById('pendingPaymentsBadge');
        if(badge){badge.textContent=pendingCount||'';badge.style.display=pendingCount?'inline-flex':'none';}
        tbody.innerHTML=payments.length?payments.map(p=>`
            <tr id="payment-row-${p.id}" class="border-b hover:bg-gray-50 ${p.status==='pending'?'bg-yellow-50':''}">
                <td class="p-4"><div class="font-semibold">${escHtml(p.client_name)}</div><div class="text-xs text-gray-400">${escHtml(p.client_email||'')}</div></td>
                <td class="p-4 font-semibold">€${parseFloat(p.amount_eur||0).toFixed(2)}</td>
                <td class="p-4">${escHtml(p.plan_name||'—')}</td>
                <td class="p-4">${p.method==='revolut'?'<span class="inline-flex items-center gap-1 text-xs bg-purple-100 text-purple-700 px-2 py-1 rounded-full font-semibold"><i class="fas fa-mobile-alt"></i> Revolut</span>':`<span class="capitalize">${p.method||'—'}</span>`}
                    ${p.gateway_ref?`<div class="text-xs text-gray-400 font-mono mt-1">${escHtml(p.gateway_ref)}</div>`:''}</td>
                <td class="p-4 text-sm text-gray-600">${new Date(p.created_at).toLocaleDateString('en-GB')}</td>
                <td class="p-4"><span class="status-badge status-${p.status}">${p.status.charAt(0).toUpperCase()+p.status.slice(1)}</span></td>
                <td class="p-4">${p.status==='pending'&&p.method==='revolut'?`
                    <div class="flex gap-2">
                        <button onclick="confirmRevolutPayment('${p.id}')" class="bg-green-500 text-white px-3 py-1.5 rounded-lg text-xs font-bold hover:bg-green-600"><i class="fas fa-check mr-1"></i>Confirm</button>
                        <button onclick="rejectRevolutPayment('${p.id}')" class="bg-red-500 text-white px-3 py-1.5 rounded-lg text-xs font-bold hover:bg-red-600"><i class="fas fa-times mr-1"></i>Reject</button>
                    </div>`:p.status==='pending'?`<button onclick="adminUpdatePayment('${p.id}','paid')" class="text-green-600 hover:text-green-800 mr-2"><i class="fas fa-check-circle text-lg"></i></button><button onclick="adminUpdatePayment('${p.id}','failed')" class="text-red-600 hover:text-red-800"><i class="fas fa-times-circle text-lg"></i></button>`:p.status==='paid'?`<button onclick="adminUpdatePayment('${p.id}','refunded')" class="text-yellow-600 hover:text-yellow-800"><i class="fas fa-undo text-lg"></i></button>`:'<span class="text-gray-300">—</span>'}</td>
            </tr>`).join('')
        :`<tr><td colspan="7" class="p-6 text-center text-gray-500">No payments found</td></tr>`;
    }catch(err){showToast('Payments load failed: '+err.message,'error');}
}

// Client Payment Section
async function loadClientPayment(){
    const c=document.getElementById('clientPaymentContent'); if(!c) return;
    c.innerHTML=`<div class="text-center py-8"><i class="fas fa-spinner fa-spin text-2xl text-purple-400"></i></div>`;
    try{
        const [sub,payments]=await Promise.all([apiCall('/me/subscription').catch(()=>null),apiCall('/me/payments').catch(()=>[])]);
        const pmts=Array.isArray(payments)?payments:[];
        if(!sub&&!pmts.length){c.innerHTML=`<div class="text-center py-12"><div class="w-20 h-20 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-4"><i class="fas fa-credit-card text-gray-400 text-3xl"></i></div><h3 class="text-xl font-bold text-gray-700 mb-2">No Active Subscription</h3><p class="text-gray-500 mb-4">Choose a plan to get started</p><button onclick="showClientSection('plans')" class="gradient-bg text-white px-6 py-2 rounded-xl font-semibold">View Plans</button></div>`;return;}
        const sh=sub?`<div class="bg-gradient-to-r from-purple-600 to-purple-800 rounded-xl p-6 text-white mb-6"><div class="flex justify-between items-start mb-4"><div><div class="text-sm opacity-75 mb-1">Current Plan</div><div class="text-2xl font-bold">${escHtml(sub.plan_name)}</div></div><span class="bg-green-400 text-white px-4 py-1.5 rounded-full text-sm font-bold">${(sub.status||'').toUpperCase()}</span></div><div class="grid grid-cols-2 gap-4"><div><div class="text-sm opacity-75">Amount Paid</div><div class="text-2xl font-bold">€${parseFloat(sub.price_eur||0).toFixed(2)}</div></div><div class="text-right"><div class="text-sm opacity-75">Valid Until</div><div class="text-lg font-semibold">${new Date(sub.ends_at).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'})}</div></div></div></div>`:'';
        const hh=pmts.length?`<h3 class="font-bold text-gray-700 mb-3 mt-2">Payment History</h3><div class="space-y-3">${pmts.map(p=>`<div class="flex items-center justify-between p-4 border border-gray-200 rounded-xl hover:bg-gray-50 transition"><div class="flex items-center gap-3"><div class="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 ${p.status==='paid'?'bg-green-100':p.status==='pending'?'bg-yellow-100':'bg-red-100'}"><i class="fas ${p.status==='paid'?'fa-check text-green-600':p.status==='pending'?'fa-clock text-yellow-600':'fa-times text-red-600'}"></i></div><div><div class="font-semibold text-sm">${escHtml(p.plan_name||'Subscription')}</div><div class="text-xs text-gray-500">${new Date(p.created_at).toLocaleDateString('en-GB')}</div>${p.gateway_ref?`<div class="text-xs text-gray-400 font-mono">Ref: ${escHtml(String(p.gateway_ref).slice(0,20))}</div>`:''}</div></div><div class="flex items-center gap-3"><div class="text-right"><div class="font-bold">€${parseFloat(p.amount_eur).toFixed(2)}</div><span class="text-xs font-semibold px-2 py-0.5 rounded-full ${p.status==='paid'?'bg-green-100 text-green-700':p.status==='pending'?'bg-yellow-100 text-yellow-700':'bg-red-100 text-red-600'}">${(p.status||'').toUpperCase()}</span></div>${p.status==='paid'?`<button onclick="downloadReceipt('${p.id}')" class="p-2 text-purple-600 hover:bg-purple-50 rounded-lg"><i class="fas fa-download"></i></button>`:''}</div></div>`).join('')}</div>`:'';
        c.innerHTML=sh+hh;
    }catch{c.innerHTML=`<div class="text-center py-8 text-red-500"><p>Could not load payment details.</p></div>`;}
}
async function downloadReceipt(paymentId){
    try{
        showToast('Preparing receipt...','info');
        const payments=await apiCall('/me/payments'); const p=payments.find(x=>x.id===paymentId);
        if(!p) return showToast('Payment not found','error');
        const html=`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>HOPE_IRL Receipt</title><style>body{font-family:Arial,sans-serif;max-width:600px;margin:40px auto;color:#1f2937}.hdr{background:linear-gradient(135deg,#667eea,#764ba2);padding:32px;border-radius:12px;color:white;margin-bottom:32px}.row{display:flex;justify-content:space-between;padding:14px 0;border-bottom:1px solid #e5e7eb}.lbl{color:#6b7280}.val{font-weight:600}.amt{font-size:28px;font-weight:800;color:#7e22ce}.ftr{text-align:center;color:#9ca3af;font-size:12px;margin-top:32px}</style></head><body><div class="hdr"><h1>🎯 HOPE_IRL</h1><p>Official Receipt</p></div><div class="row"><span class="lbl">Plan</span><span class="val">${escHtml(p.plan_name||'Subscription')}</span></div><div class="row"><span class="lbl">Amount</span><span class="amt">€${parseFloat(p.amount_eur).toFixed(2)}</span></div><div class="row"><span class="lbl">Date</span><span class="val">${new Date(p.created_at).toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric'})}</span></div><div class="row"><span class="lbl">Ref</span><span class="val" style="font-family:monospace;font-size:13px">${escHtml(p.gateway_ref||p.id)}</span></div><div class="ftr">Thank you for choosing HOPE_IRL 🚀</div></body></html>`;
        const blob=new Blob([html],{type:'text/html'}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=`Receipt_${String(p.id).slice(0,8)}.html`; a.click();
        showToast('Receipt downloaded! ✅','success');
    }catch(err){showToast('Download failed: '+err.message,'error');}
}

// Client Plans Section
async function loadClientPlans(){
    const grid=document.getElementById('clientPlansGrid'); if(!grid) return;
    try{
        const sub=await apiCall('/me/subscription').catch(()=>null);
        const banner=document.getElementById('clientCurrentPlanBanner');
        if(sub&&sub.status==='active'&&banner){
            banner.classList.remove('hidden');
            const s=(id,v)=>{const el=document.getElementById(id);if(el)el.textContent=v;};
            s('clientActivePlanName',sub.plan_name||'—');
            s('clientActivePlanApps',sub.applications_per_day||'—');
            s('clientActivePlanExpiry',sub.ends_at?new Date(sub.ends_at).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'}):'—');
            // Expiry warning
            const daysLeft=Math.ceil((new Date(sub.ends_at)-new Date())/(1000*60*60*24));
            if(daysLeft<=7){
                const warn=document.getElementById('clientExpiryWarning');
                if(warn){warn.classList.remove('hidden');warn.querySelector('#expiryDaysLeft').textContent=daysLeft;}
            }
        }
    }catch{}
    try{
        const ctrl=new AbortController(); const t=setTimeout(()=>ctrl.abort(),4000);
        const res=await fetch(`${API_BASE}/services`,{signal:ctrl.signal}); clearTimeout(t);
        if(res.ok){const plans=await res.json();if(plans?.length){renderClientPlans(grid,plans);return;}}
    }catch{}
    renderClientPlans(grid,FALLBACK_SERVICES);
}
function renderClientPlans(grid,plans){
    const activeName=document.getElementById('clientActivePlanName')?.textContent||'';
    grid.innerHTML=plans.map((s,i)=>{
        const isActive=activeName&&s.name===activeName;
        let fl=[];
        if(s.features?.list?.length) fl=s.features.list;
        else if(s.features&&typeof s.features==='object') fl=Object.entries(s.features).filter(([,v])=>v===true).map(([k])=>formatFeatureKey(k));
        return `<div class="relative bg-white rounded-2xl border-2 ${isActive?'border-green-500 shadow-xl':i===1?'border-purple-400 shadow-lg':'border-gray-200 shadow-sm'} p-6 hover:shadow-xl transition-all duration-300">
            ${isActive?'<div class="absolute -top-3 left-1/2 -translate-x-1/2 bg-green-500 text-white text-xs font-bold px-4 py-1 rounded-full">✓ CURRENT PLAN</div>':i===1?'<div class="absolute -top-3 left-1/2 -translate-x-1/2 gradient-bg text-white text-xs font-bold px-4 py-1 rounded-full">MOST POPULAR</div>':''}
            <div class="text-center mb-5 pt-2">
                <h3 class="text-xl font-bold mb-1">${escHtml(s.name)}</h3>
                <div class="text-4xl font-extrabold ${isActive?'text-green-600':'gradient-text'} mb-1">€${parseFloat(s.price_eur).toFixed(0)}</div>
                <div class="text-sm text-gray-500">${s.applications_per_day} applications/day</div>
            </div>
            <ul class="space-y-2 mb-6 min-h-[80px]">${fl.map(f=>`<li class="flex items-center gap-2 text-sm"><i class="fas fa-check text-green-500 flex-shrink-0"></i><span>${escHtml(f)}</span></li>`).join('')}</ul>
            ${isActive?`<div class="w-full text-center bg-green-50 text-green-700 py-3 rounded-xl font-bold text-sm border border-green-200"><i class="fas fa-check-circle mr-2"></i>Active Plan</div>`
            :`<button onclick="selectService('${s.id}','${escAttr(s.name)}',${s.price_eur})" class="w-full gradient-bg text-white py-3 rounded-xl font-bold hover:opacity-90 transition text-sm">${activeName?'Switch to this Plan':'Choose Plan'}</button>`}
        </div>`;
    }).join('');
}

// SSE handlers for new events
function setupPaymentSSEHandlers(){
    if(!_sseSource) return;
    _sseSource.addEventListener('payment_pending',(e)=>{
        let data={}; try{data=JSON.parse(e.data);}catch{}
        if(_currentUser?.role==='admin'){
            showToast(`💰 New payment from ${data.client_name} — €${data.amount} (${data.plan_name})`,'success');
            loadAdminPaymentsEnhanced();
        }
    });
    _sseSource.addEventListener('subscription_activated',(e)=>{
        let data={}; try{data=JSON.parse(e.data);}catch{}
        if(_currentUser?.role==='client'){
            showToast(data.message||'Subscription activated! 🎉','success');
            loadClientDashboard();
        }
    });
    _sseSource.addEventListener('payment_rejected',(e)=>{
        let data={}; try{data=JSON.parse(e.data);}catch{}
        if(_currentUser?.role==='client') showToast(data.message||'Payment issue. Contact support.','error');
    });
}

// Enhanced admin dashboard with analytics
async function loadAdminAnalytics(stats){
    if(!stats) return;
    // Monthly revenue chart
    const chartEl=document.getElementById('adminRevenueChart');
    if(chartEl&&stats.monthlyRevenue?.length){
        const labels=stats.monthlyRevenue.map(r=>r.month);
        const data=stats.monthlyRevenue.map(r=>parseFloat(r.revenue));
        chartEl.innerHTML='';
        const maxVal=Math.max(...data,1);
        chartEl.innerHTML=`<div class="flex items-end gap-3 h-32 px-2">${data.map((v,i)=>`
            <div class="flex-1 flex flex-col items-center gap-1">
                <span class="text-xs text-gray-500 font-semibold">€${v>999?(v/1000).toFixed(1)+'k':v.toFixed(0)}</span>
                <div class="w-full rounded-t-lg gradient-bg transition-all" style="height:${Math.max(4,Math.round((v/maxVal)*100))}px;opacity:${0.5+0.5*(v/maxVal)}"></div>
                <span class="text-xs text-gray-400">${labels[i]}</span>
            </div>`).join('')}</div>`;
    }
    // Conversion rate
    const convEl=document.getElementById('adminConversionRate');
    if(convEl&&stats.conversionData){
        const total=parseInt(stats.conversionData.total_clients)||1;
        const subscribed=parseInt(stats.conversionData.subscribed_clients)||0;
        const rate=Math.round((subscribed/total)*100);
        convEl.innerHTML=`
            <div class="text-3xl font-extrabold gradient-text">${rate}%</div>
            <div class="text-xs text-gray-500 mt-1">Conversion Rate</div>
            <div class="text-xs text-gray-400">${subscribed}/${total} clients subscribed</div>
            <div class="w-full bg-gray-100 rounded-full h-2 mt-2">
                <div class="gradient-bg rounded-full h-2" style="width:${rate}%"></div>
            </div>`;
    }
    // Expiring subscriptions alert
    if(stats.expiringThisWeek?.length){
        const alertEl=document.getElementById('adminExpiryAlert');
        if(alertEl){
            alertEl.classList.remove('hidden');
            alertEl.innerHTML=`<div class="flex items-center gap-3 p-4 bg-yellow-50 border border-yellow-200 rounded-xl mb-4">
                <i class="fas fa-clock text-yellow-500 text-xl flex-shrink-0"></i>
                <div><div class="font-semibold text-yellow-800">${stats.expiringThisWeek.length} subscription(s) expiring this week</div>
                <div class="text-xs text-yellow-600 mt-1">${stats.expiringThisWeek.map(s=>`${s.full_name} (${s.days_left}d)`).join(', ')}</div></div>
            </div>`;
        }
    }
    // Pending payments badge
    if(stats.pendingPaymentsCount>0){
        const badge=document.getElementById('pendingPaymentsBadge');
        if(badge){badge.textContent=stats.pendingPaymentsCount;badge.style.display='inline-flex';}
    }
}

// showClientSection hook
const _origCS=window.showClientSection;
window.showClientSection=function(section,e){
    if(typeof _origCS==='function') _origCS(section,e);
    if(section==='payment') loadClientPayment();
    if(section==='plans') loadClientPlans();
};

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('loginForm')?.addEventListener('submit', handleLogin);
    loadLandingServices();
    document.getElementById('registerForm')?.addEventListener('submit', handleRegister);

    // Notification polling every 60s when logged in
    setInterval(() => { if (_accessToken) loadNotifications(); }, 60_000);

    // BUG 4 FIX: Employee clients refresh at 15s — real-time feeling for new assignments
    // Admin/client refresh at 30s (heavier queries, less urgency)
    setInterval(() => {
        if (!_accessToken) return;
        if (_currentUser?.role === 'employee') {
            // Lightweight: only refresh clients grid (assignments can change any time)
            loadEmployeeClients();
        }
    }, 15_000);

    // Full dashboard refresh every 30s for all roles
    setInterval(() => {
        if (!_accessToken) return;
        if (_currentUser?.role === 'admin')    loadAdminDashboard();
        if (_currentUser?.role === 'employee') loadEmployeeDashboard();
        if (_currentUser?.role === 'client')   loadClientDashboard();
    }, 30_000);

    // BUG 5 FIX: Handle post-Stripe-redirect — immediate dashboard reflect
    const params = new URLSearchParams(window.location.search);
    if (params.get('payment') === 'success') {
        showToast('Payment successful! Subscription activated. 🎉', 'success');
        history.replaceState({}, '', window.location.pathname);
        // Immediate reload at 1s so subscription badge updates before user notices
        setTimeout(() => {
            if (_currentUser?.role === 'client') {
                loadClientDashboard();          // refreshes apps + sub badge
                checkAndRefreshSubscription();  // explicitly refreshes plan info
            }
            if (_currentUser?.role === 'admin') {
                loadAdminPayments();
                loadAdminStats();
            }
        }, 1000);
    } else if (params.get('payment') === 'cancelled') {
        showToast('Payment cancelled.', 'warning');
        history.replaceState({}, '', window.location.pathname);
    }
});
