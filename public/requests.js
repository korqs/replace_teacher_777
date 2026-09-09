// public/requests.js
class RequestsModule {
    constructor(dashboard) {
        this.dashboard = dashboard;
        this.container = null;
    }

    async init() {
        console.log('📋 Инициализация модуля "Мои заявки"');
        this.container = document.getElementById('requestsContainer');
        this.setupUI();
        return true;
    }

    setupUI() {
        // Можно добавить фильтры/поиск позже. Сейчас — минимально и стабильно.
    }

    async loadData() {
        if (!this.container) {
            this.container = document.getElementById('requestsContainer');
        }

        this.container.innerHTML = `
            <div class="loading-schedule">
                <i class="fas fa-spinner fa-spin"></i>
                <p>Загрузка заявок...</p>
            </div>
        `;

        const data = await this.dashboard.apiRequest('/requests/my');

        if (!data || !data.success) {
            const msg = data?.message || 'Не удалось загрузить заявки';
            this.container.innerHTML = `
                <div class="empty-state">
                    <i class="fas fa-exclamation-triangle"></i>
                    <p>${msg}</p>
                    <button class="btn btn-primary" onclick="dashboard.modules.requests.loadData()">
                        <i class="fas fa-redo"></i> Попробовать снова
                    </button>
                </div>
            `;
            return;
        }

        const requests = Array.isArray(data.requests) ? data.requests : [];

        if (requests.length === 0) {
            this.container.innerHTML = `
                <div class="empty-state">
                    <i class="fas fa-inbox"></i>
                    <p>У вас пока нет заявок на замену</p>
                    <p>Создайте заявку из расписания или через раздел «Новая заявка»</p>
                </div>
            `;
            return;
        }

        this.container.innerHTML = requests.map(r => this.renderRequestCard(r)).join('');
    }

    renderRequestCard(r) {
        const statusInfo = this.getStatusInfo(r.status);
        const dateStr = this.formatDate(r.request_date);
        const numDenText = r.num_den_text || (r.num_den === 'den' ? 'знаменатель' : 'числитель');
        const lessonMeta = this.formatLessonMetaSpans(r);
    
        // Определяем тип заявки
        const requestType = r.request_type || 'owner';
        const isOwnerRequest = requestType === 'owner';
        const isReplacementRequest = requestType === 'replacement';

        // Можно отменять только свои pending заявки
        const canCancel = isOwnerRequest && (r.status === 'pending');
    
        // Можно принимать/отклонять заявки на замену если они pending
        const canRespondToReplacement = isReplacementRequest && (r.status === 'pending');

        return `
            <div class="card" style="border-left: 5px solid ${statusInfo.color};">
                <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;">
                    <div style="flex-grow:1;">
                        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px;">
                            <div style="font-size:18px;font-weight:700;color:#2c3e50;">
                                ${r.subject}
                            </div>
                            <span class="user-role" style="background:${statusInfo.bg};color:${statusInfo.color};">${statusInfo.label}</span>
                        
                            ${isReplacementRequest ? `
                                <span class="user-role" style="background:#e0f2fe;color:#0369a1;">
                                    <i class="fas fa-user-friends"></i> Вас выбрали для замены
                                </span>
                            ` : ''}
                        
                            ${isOwnerRequest ? `
                                <span class="user-role" style="background:#f0f9ff;color:#0c4a6e;">
                                    <i class="fas fa-user"></i> Ваша заявка
                                </span>
                            ` : ''}
                        </div>
                    
                        <div style="margin-top:6px;color:#4a5568;display:flex;gap:14px;flex-wrap:wrap;">
                            <span><i class="fas fa-calendar"></i> ${dateStr}</span>
                            <span><i class="fas fa-clock"></i> ${r.classes} пара</span>
                            <span><i class="fas fa-users"></i> ${r.team}</span>
                            <span><i class="fas fa-book"></i> ${numDenText}</span>
                            ${lessonMeta}
                        </div>
                    
                        <div style="margin-top:10px;color:#2c3e50;">
                            <i class="fas fa-chalkboard-teacher"></i> Преподаватель: <b>${r.teacher_name}</b>
                        </div>
                    
                        ${r.replacing_teacher ? `
                            <div style="margin-top:6px;color:#2c3e50;">
                                <i class="fas fa-user-check"></i> Замещающий преподаватель: <b>${r.replacing_teacher}</b>
                            </div>
                        ` : ''}
                    
                        ${r.admin_comment ? `
                            <div style="margin-top:10px;color:#2c3e50;background:#f8fafc;padding:8px;border-radius:6px;border-left:3px solid #4f46e5;">
                                <i class="fas fa-comment-dots"></i> <strong>Комментарий администратора:</strong><br>
                                ${this.escapeHtml(r.admin_comment)}
                            </div>
                        ` : ''}
                    
                        ${!r.replacing_teacher && isOwnerRequest && r.status === 'pending' ? `
                            <div style="margin-top:10px;color:#dc2626;font-size:14px;">
                                <i class="fas fa-exclamation-triangle"></i> Замещающий преподаватель еще не выбран
                            </div>
                        ` : ''}
                    </div>

                    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
                        ${canCancel ? `
                            <button class="logout-btn" style="background:#6b7280" onclick="dashboard.modules.requests.cancelRequest(${r.id})">
                                <i class="fas fa-ban"></i> Отменить
                            </button>
                        ` : ''}
                    
                        ${canRespondToReplacement ? `
                            <div style="display:flex;gap:8px;">
                                <button class="logout-btn" style="background:#10b981" onclick="dashboard.modules.requests.respondToRequest(${r.id}, 'accept')">
                                    <i class="fas fa-check"></i> Принять
                                </button>
                                <button class="logout-btn" style="background:#ef4444" onclick="dashboard.modules.requests.respondToRequest(${r.id}, 'reject')">
                                    <i class="fas fa-times"></i> Отклонить
                                </button>
                            </div>
                        ` : ''}
                    </div>
                </div>
            </div>
        `;
    }

    formatLessonMetaSpans(item) {
        const parts = [];
        const type = String(item?.type || '').trim();
        const audiense = String(item?.audiense || '').trim();
        if (type) parts.push(`<span><i class="fas fa-chalkboard"></i> ${this.escapeHtml(type)}</span>`);
        if (audiense) parts.push(`<span><i class="fas fa-door-open"></i> ${this.escapeHtml(audiense)}</span>`);
        return parts.join('');
    }

    getStatusInfo(status) {
        switch (status) {
            case 'confirmed':
                return { label: 'Подтверждена', color: '#16a34a', bg: '#dcfce7' };
            case 'rejected':
                return { label: 'Отклонена', color: '#dc2626', bg: '#fee2e2' };
            case 'cancelled':
                return { label: 'Отменена', color: '#6b7280', bg: '#f1f5f9' };
            case 'pending':
            default:
                return { label: 'На рассмотрении', color: '#2563eb', bg: '#dbeafe' };
        }
    }

    async cancelRequest(id) {
        if (!confirm('Отменить эту заявку?')) return;

        const data = await this.dashboard.apiRequest(`/requests/${id}/cancel`, {
            method: 'PUT'
        });

        if (data && data.success) {
            this.dashboard.showSuccess('Заявка отменена');
            await this.loadData();
        } else {
            this.dashboard.showError(data?.message || 'Не удалось отменить заявку');
        }
    }

    formatDate(d) {
        try {
            const dt = new Date(d);
            return dt.toLocaleDateString('ru-RU', { year: 'numeric', month: '2-digit', day: '2-digit' });
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

    // Добавьте эти методы в класс RequestsModule

    async respondToRequest(id, action) {
        const actionText = action === 'accept' ? 'принять' : 'отклонить';
    
        if (!confirm(`Вы уверены, что хотите ${actionText} эту заявку на замену?`)) return;

        const data = await this.dashboard.apiRequest(`/requests/${id}/respond`, {
            method: 'PUT',
            body: JSON.stringify({ action })
        });

        if (data && data.success) {
            this.dashboard.showSuccess(`Заявка ${action === 'accept' ? 'принята' : 'отклонена'}`);
            await this.loadData();
        } else {
            this.dashboard.showError(data?.message || `Не удалось ${actionText} заявку`);
        }
    }

    // Также добавьте метод для детального просмотра заявки
    async viewRequestDetails(id) {
        const data = await this.dashboard.apiRequest(`/requests/${id}`);
    
        if (data && data.success) {
            // Можно показать модальное окно с деталями
            this.showRequestModal(data.request);
        } else {
            this.dashboard.showError(data?.message || 'Не удалось загрузить детали заявки');
        }
    }
}

window.RequestsModule = RequestsModule;
