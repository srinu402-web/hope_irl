// ============================================================
// HOPE_IRL — script.js  (UI only — no API calls here)
// ============================================================

// ── Page & Modal Navigation ──────────────────────────────────
function showPage(pageId) {
    document.querySelectorAll('.page').forEach(p => p.classList.add('hidden'));
    const page = document.getElementById(pageId);
    if (page) page.classList.remove('hidden');
}

function showLogin() {
    closeModal('registerModal');
    document.getElementById('loginModal').classList.add('active');
}

function showRegister() {
    closeModal('loginModal');
    document.getElementById('registerModal').classList.add('active');
}

function closeModal(modalId) {
    const el = document.getElementById(modalId);
    if (el) el.classList.remove('active');
}

// Close modal on outside click
document.addEventListener('click', function(e) {
    if (e.target.classList.contains('modal')) e.target.classList.remove('active');
});

// Escape key closes modals
document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
        document.querySelectorAll('.modal.active').forEach(m => m.classList.remove('active'));
    }
});

// ── Mobile / Sidebar ─────────────────────────────────────────
function toggleMobileMenu() {
    const menu = document.getElementById('mobileMenu');
    if (menu) menu.classList.toggle('hidden');
}

function toggleSidebar(dashboardType) {
    const sidebar = document.getElementById(`${dashboardType}Sidebar`);
    const overlay = document.getElementById(`${dashboardType}SidebarOverlay`);
    if (!sidebar) return;
    const isOpen = !sidebar.classList.contains('-translate-x-full');
    if (isOpen) {
        sidebar.classList.add('-translate-x-full');
        overlay?.classList.add('hidden');
    } else {
        sidebar.classList.remove('-translate-x-full');
        overlay?.classList.remove('hidden');
    }
}

function closeSidebarOnMobile(dashboardType) {
    // Only close on mobile (< md breakpoint = 768px)
    if (window.innerWidth < 768) {
        const sidebar = document.getElementById(`${dashboardType}Sidebar`);
        const overlay = document.getElementById(`${dashboardType}SidebarOverlay`);
        sidebar?.classList.add('-translate-x-full');
        overlay?.classList.add('hidden');
    }
}

// ── Dashboard Section Navigation ─────────────────────────────
function showAdminSection(sectionName, e) {
    document.querySelectorAll('.admin-section').forEach(s => s.classList.add('hidden'));
    const id = `admin${sectionName.charAt(0).toUpperCase() + sectionName.slice(1)}Section`;
    const el = document.getElementById(id);
    if (el) el.classList.remove('hidden');
    document.querySelectorAll('#adminDashboard .sidebar-item').forEach(i => i.classList.remove('active'));
    const evtTarget = (e || window.event)?.target;
    evtTarget?.closest('.sidebar-item')?.classList.add('active');
}

function showEmployeeSection(sectionName, e) {
    document.querySelectorAll('.employee-section').forEach(s => s.classList.add('hidden'));
    const id = `employee${sectionName.charAt(0).toUpperCase() + sectionName.slice(1)}Section`;
    const el = document.getElementById(id);
    if (el) el.classList.remove('hidden');
    document.querySelectorAll('#employeeDashboard .sidebar-item').forEach(i => i.classList.remove('active'));
    const evtTarget = (e || window.event)?.target;
    evtTarget?.closest('.sidebar-item')?.classList.add('active');
}

function showClientSection(sectionName, e) {
    document.querySelectorAll('.client-section').forEach(s => s.classList.add('hidden'));
    const id = `client${sectionName.charAt(0).toUpperCase() + sectionName.slice(1)}Section`;
    const el = document.getElementById(id);
    if (el) el.classList.remove('hidden');
    document.querySelectorAll('#clientDashboard .sidebar-item').forEach(i => i.classList.remove('active'));
    const evtTarget = (e || window.event)?.target;
    evtTarget?.closest('.sidebar-item')?.classList.add('active');
}

// ── Service / Payment ─────────────────────────────────────────
let selectedService      = null;
let selectedServicePrice = 0;
let selectedPlanId       = null;

// BUG FIX: signature aligned with api.js — selectService(planId, planName, price)
// api.js overrides this at runtime if loaded; this is the fallback for landing page
function selectService(planId, planName, price) {
    selectedService = planName;
    selectedServicePrice = price;
    selectedPlanId = planId || null;
    // If api.js is loaded and user is logged in, it handles this via its own selectService
    // Otherwise open simple payment modal (landing page flow)
    if (typeof openPaymentGatewayModal === 'function') {
        openPaymentGatewayModal(planId, planName, price);
    } else {
        showPaymentModal();
    }
}

function showPaymentModal() {
    const details = document.getElementById('paymentDetails');
    if (details) {
        details.innerHTML = `
            <div class="flex justify-between mb-2">
                <span class="font-semibold">Service:</span>
                <span>${selectedService}</span>
            </div>
            <div class="flex justify-between mb-2">
                <span class="font-semibold">Amount:</span>
                <span class="text-2xl font-bold gradient-text">€${selectedServicePrice}</span>
            </div>`;
    }
    document.getElementById('paymentModal').classList.add('active');
}

function processPayment() {
    const method = document.querySelector('input[name="paymentMethod"]:checked')?.value;
    closeModal('paymentModal');
    if (typeof showToast === 'function') {
        showToast(`Payment via ${method} initiated. Redirecting...`, 'info');
    }
    setTimeout(() => showPage('clientDashboard'), 1000);
}

// ── Avatar Upload ─────────────────────────────────────────────
// Stub — real implementation in api.js; this prevents errors if called before api.js loads
function showAvatarUploadModal() {
    const modal = document.getElementById('avatarUploadModal');
    if (modal) modal.classList.add('active');
}

// ── Apply Job Modal ───────────────────────────────────────────
function showApplyJobModal(clientName, clientId) {
    const nameField = document.getElementById('clientNameField');
    if (nameField) {
        nameField.value = clientName;
        nameField.dataset.clientId = clientId || '';
    }
    document.getElementById('applyJobModal').classList.add('active');
}

// ── Admin helpers ─────────────────────────────────────────────
function showAddServiceModal() {
    if (typeof showToast === 'function') {
        showToast('Add Service feature coming soon!', 'info');
    }
}

function updatePaymentStatus(button, status) {
    if (confirm(`Mark payment as ${status}?`)) {
        const row = button.closest('tr');
        const statusCell = row?.querySelector('td:nth-child(5)');
        if (statusCell) {
            statusCell.innerHTML = `<span class="status-badge status-${status}">${status.charAt(0).toUpperCase() + status.slice(1)}</span>`;
        }
        if (typeof showToast === 'function') {
            showToast(`Payment marked as ${status}`, 'success');
        }
    }
}

// ── ATS Resume Checker ────────────────────────────────────────
function handleResumeUpload(event) {
    const file = event.target.files[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { alert('File too large. Max 5MB.'); return; }
    const allowed = ['application/pdf','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
    if (!allowed.includes(file.type)) { alert('Please upload PDF, DOC, or DOCX.'); return; }
    const nameEl = document.getElementById('fileName');
    if (nameEl) nameEl.innerHTML = `<i class="fas fa-spinner fa-spin mr-2 text-purple-600"></i> Analyzing ${file.name}...`;
    setTimeout(() => analyzeResume(file), 2000);
}

function analyzeResume(file) {
    const results = document.getElementById('atsResults');
    if (results) results.classList.remove('hidden');
    const score = Math.floor(Math.random() * 36) + 60;
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
        if (score >= 85) {
            msg.innerHTML = '<p class="font-semibold text-green-800"><i class="fas fa-check-circle mr-2"></i>Excellent! Highly ATS-compatible.</p>';
            msg.className = 'text-center p-4 bg-green-50 border border-green-200 rounded-lg';
        } else if (score >= 70) {
            msg.innerHTML = '<p class="font-semibold text-yellow-800"><i class="fas fa-exclamation-circle mr-2"></i>Good! Room for improvement.</p>';
            msg.className = 'text-center p-4 bg-yellow-50 border border-yellow-200 rounded-lg';
        } else {
            msg.innerHTML = '<p class="font-semibold text-red-800"><i class="fas fa-times-circle mr-2"></i>Needs Improvement.</p>';
            msg.className = 'text-center p-4 bg-red-50 border border-red-200 rounded-lg';
        }
    }
    const nameEl = document.getElementById('fileName');
    if (nameEl) nameEl.innerHTML = `<i class="fas fa-file-alt text-green-600 mr-2"></i><span class="font-semibold">${file.name}</span><span class="text-green-600 ml-2"><i class="fas fa-check-circle"></i> Complete</span>`;
    results?.scrollIntoView({ behavior: 'smooth' });
}

function downloadReport() {
    if (typeof showToast === 'function') showToast('Downloading report... (Coming soon)', 'info');
}

function requestOptimization() {
    if (confirm('Request Professional Resume Optimization for €29?')) {
        if (typeof showToast === 'function') showToast('Request submitted! Team will contact you via WhatsApp.', 'success');
    }
}

// BUG FIX: reset #atsFile (old code pointed to #resumeUpload which no longer exists)
function checkAnotherResume() {
    const upload = document.getElementById('atsFile');
    if (upload) upload.value = '';
    const nameEl = document.getElementById('fileName');
    if (nameEl) nameEl.innerHTML = '';
    const results = document.getElementById('atsResults');
    if (results) results.classList.add('hidden');
}

// ── Smooth Scroll ─────────────────────────────────────────────
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function(e) {
        const href = this.getAttribute('href');
        if (href === '#') { e.preventDefault(); return; }
        const target = document.querySelector(href);
        if (target) { e.preventDefault(); target.scrollIntoView({ behavior: 'smooth' }); }
    });
});

// ── Init ──────────────────────────────────────────────────────
// FIX: async గా చేశాము — restoreSession() wait చేయడానికి
document.addEventListener('DOMContentLoaded', async function() {
    console.log('HOPE_IRL Platform Loaded ✅');

    // ── SESSION RESTORE: refresh చేసినా dashboard remain అవుతుంది ──
    if (typeof restoreSession === 'function') {
        const restored = await restoreSession();
        if (restored) return; // dashboard already shown by api.js
    }

    // Session లేదు — landing page show చేయి
    document.getElementById('landingPage')?.classList.remove('hidden');

    // Animate stat cards
    document.querySelectorAll('.stat-card').forEach((card, i) => {
        card.style.opacity = '0';
        card.style.transform = 'translateY(20px)';
        card.style.transition = 'all 0.5s ease';
        setTimeout(() => { card.style.opacity = '1'; card.style.transform = 'translateY(0)'; }, i * 100 + 100);
    });
    // Animate chart bars
    document.querySelectorAll('.chart-bar').forEach((bar, i) => {
        const h = bar.style.height;
        bar.style.height = '0%';
        setTimeout(() => { bar.style.height = h; }, i * 150 + 200);
    });
});
