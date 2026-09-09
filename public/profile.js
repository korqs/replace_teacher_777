// public/profile.js
class ProfileModule {
    constructor(dashboard) {
        this.dashboard = dashboard;
        this.container = null;
    }

    async init() {
        console.log('👤 Инициализация модуля профиля');
        this.container = document.getElementById('profileContainer');
        this.setupUI();
        return true;
    }

    setupUI() {
        // UI строим при loadData()
    }

    async loadData() {
        if (!this.container) {
            this.container = document.getElementById('profileContainer');
        }

        this.container.innerHTML = `
            <div class="loading-schedule">
                <i class="fas fa-spinner fa-spin"></i>
                <p>Загрузка профиля...</p>
            </div>
        `;

        const data = await this.dashboard.apiRequest('/profile');

        if (!data || !data.success) {
            this.container.innerHTML = `
                <div class="empty-state">
                    <i class="fas fa-exclamation-triangle"></i>
                    <p>${data?.message || 'Не удалось загрузить профиль'}</p>
                    <button class="btn btn-primary" onclick="dashboard.modules.profile.loadData()">
                        <i class="fas fa-redo"></i> Попробовать снова
                    </button>
                </div>
            `;
            return;
        }

        const u = data.user || {};
        this.renderProfile(u);
    }

    renderProfile(u) {
        const roleLabel = (u.role === 'admin')
            ? (u.teacher_name ? 'Администратор / Преподаватель' : 'Администратор')
            : 'Преподаватель';

        this.container.innerHTML = `
            <div class="card" style="max-width:900px;">
                <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:flex-start;">
                    <div>
                        <div style="font-size:22px;font-weight:900;color:#2c3e50;display:flex;gap:10px;flex-wrap:wrap;align-items:center;">
                            <span>${this.escapeHtml(u.full_name || u.teacher_name || u.email || '')}</span>
                            <span class="user-role">${roleLabel}</span>
                        </div>
                        <div style="margin-top:8px;color:#475569;display:flex;gap:14px;flex-wrap:wrap;">
                            <span><i class="fas fa-envelope"></i> ${this.escapeHtml(u.email || '')}</span>
                            ${u.teacher_name ? `<span><i class="fas fa-chalkboard-teacher"></i> ${this.escapeHtml(u.teacher_name)}</span>` : ''}
                            ${u.created_at ? `<span><i class="fas fa-calendar-plus"></i> Создан: ${this.formatDateTime(u.created_at)}</span>` : ''}
                        </div>
                    </div>
                </div>

                <div style="margin-top:18px;display:grid;grid-template-columns:1fr 1fr;gap:14px;">
                    <div style="display:flex;flex-direction:column;gap:6px;">
                        <label style="font-weight:700;color:#334155;">Телефон</label>
                        <input id="profilePhone" type="text" value="${this.escapeAttr(u.phone || '')}"
                               placeholder="+7 (999) 123-45-67"
                               style="padding:12px;border-radius:10px;border:2px solid #e2e8f0;">
                        <div style="color:#64748b;font-size:13px;">
                            * Сохраняется в таблице преподавателей (teachers.phone)
                        </div>
                    </div>

                    <div style="display:flex;flex-direction:column;gap:6px;">
                        <label style="font-weight:700;color:#334155;">Роль</label>
                        <input type="text" value="${this.escapeAttr(roleLabel)}" disabled
                               style="padding:12px;border-radius:10px;border:2px solid #e2e8f0;background:#f8fafc;">
                        <div style="color:#64748b;font-size:13px;">
                            * Роль меняет только администратор (в этой версии — без UI)
                        </div>
                    </div>
                </div>

                <div style="margin-top:18px;display:flex;gap:12px;flex-wrap:wrap;">
                    <button class="logout-btn" style="background:#2563eb" onclick="dashboard.modules.profile.saveProfile()">
                        <i class="fas fa-save"></i> Сохранить
                    </button>
                    <button class="nav-btn" onclick="dashboard.modules.profile.loadData()">
                        <i class="fas fa-rotate-right"></i> Обновить
                    </button>
                </div>
            </div>
        `;
    }

    async saveProfile() {
        const phoneEl = document.getElementById('profilePhone');
        const phone = phoneEl ? phoneEl.value : '';

        const data = await this.dashboard.apiRequest('/profile', {
            method: 'PUT',
            body: JSON.stringify({ phone })
        });

        if (data && data.success) {
            this.dashboard.showSuccess('Профиль сохранён');
            // обновим локально user (чтобы header не лагал)
            if (data.user) {
                localStorage.setItem('user', JSON.stringify({
                    ...(this.dashboard.user || {}),
                    ...data.user,
                    full_name: data.user.full_name || this.dashboard.user?.full_name
                }));
                this.dashboard.user = JSON.parse(localStorage.getItem('user'));
                this.dashboard.displayUserInfo();
            }
            await this.loadData();
        } else {
            this.dashboard.showError(data?.message || 'Не удалось сохранить профиль');
        }
    }

    formatDateTime(d) {
        try {
            const dt = new Date(d);
            return dt.toLocaleString('ru-RU');
        } catch (_) {
            return String(d);
        }
    }

    escapeHtml(str) {
        return String(str)
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;')
            .replaceAll("'", '&#39;');
    }

    escapeAttr(value) {
        return this.escapeHtml(value);
    }
}

window.ProfileModule = ProfileModule;
