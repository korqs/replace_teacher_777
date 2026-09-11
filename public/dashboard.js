class DashboardApp {
    constructor() {
        this.modules = {};
        this.currentSection = 'schedule';
        this.token = localStorage.getItem('token');
        this.user = JSON.parse(localStorage.getItem('user') || 'null');
        this.isAdmin = this.user?.role === 'admin';
        this.adminActingTeacher = localStorage.getItem('admin_acting_teacher') || '';
        this.adminSections = ['admin-requests', 'admin-history', 'admin-archive'];
    }
    
    handleSessionExpired(message) {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
        sessionStorage.setItem(
            'auth_message',
            message || 'Сессия истекла. Войдите снова.'
        );
        window.location.href = `${window.BASE_PATH || ''}/`;
    }

    async init() {
        console.log('🚀 Инициализация Dashboard...');
        
        // Проверка авторизации
        if (!this.token || !this.user) {
            window.location.href = `${window.BASE_PATH || ''}/`;
            return;
        }

        const sessionValid = await this.verifySession();
        if (!sessionValid) {
            return;
        }

        if (this.isAdmin) {
            this.currentSection = 'admin-requests';
        }
        
        // Настройка базового интерфейса
        this.setupBaseUI();

        if (this.isAdmin) {
            await this.setupAdminTeacherSelector();
        }
        
        // Инициализируем модули
        await this.initModules();
        
        // Загружаем данные для активного раздела
        await this.loadCurrentSectionData();
        
        console.log('✅ Dashboard инициализирован');
    }
    
    setupBaseUI() {
        console.log('⚙️ Настройка базового UI...');
        
        // Отображаем информацию о пользователе
        this.displayUserInfo();
        
        // Навигация по секциям
        document.querySelectorAll('.nav-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                const section = e.currentTarget.dataset.section;
                this.showSection(section);
            });
        });
        
        // Кнопка выхода
        const logoutBtn = document.getElementById('logoutBtn');
        if (logoutBtn) {
            logoutBtn.addEventListener('click', () => this.logout());
        }
    }
    
    displayUserInfo() {
        const userNameEl = document.getElementById('userName');
        const userRoleEl = document.getElementById('userRole');
        const welcomeTextEl = document.getElementById('welcomeText');
        
        if (userNameEl) {
            userNameEl.textContent = this.user.full_name || this.user.email;
        }
        
        if (userRoleEl) {
            if (this.isAdmin) {
                userRoleEl.textContent = 'Администратор';
            } else {
                userRoleEl.textContent = 'Преподаватель';
            }
        }
        
        if (welcomeTextEl) {
            if (this.isAdmin) {
                welcomeTextEl.textContent =
                    'Панель администратора: управление заявками и создание заявок от имени преподавателей.';
            } else {
                welcomeTextEl.textContent = 
                    `Приветствуем, ${this.user.full_name || this.user.email}! Вы вошли как преподаватель.`;
            }
        }

        if (this.isAdmin) {
            this.setupAdminLayout();
        }
    }

    setupAdminLayout() {
        document.querySelectorAll('.admin-only').forEach((el) => {
            el.classList.remove('hidden');
        });

        document.querySelectorAll('.teacher-only').forEach((el) => {
            el.classList.remove('hidden');
            if (el.classList.contains('content-section') && el.id !== 'admin-requests-section') {
                el.classList.remove('active');
                el.style.display = 'none';
            }
        });

        const adminRequestsSection = document.getElementById('admin-requests-section');
        if (adminRequestsSection) {
            adminRequestsSection.classList.add('active');
            adminRequestsSection.style.display = 'block';
        }
    }

    needsTeacherSelection() {
        return this.isAdmin;
    }

    getActingTeacher() {
        if (!this.isAdmin) {
            return this.user?.teacher_name || null;
        }
        return this.adminActingTeacher || null;
    }

    setActingTeacher(teacherName) {
        this.adminActingTeacher = String(teacherName || '').trim();
        if (this.adminActingTeacher) {
            localStorage.setItem('admin_acting_teacher', this.adminActingTeacher);
        } else {
            localStorage.removeItem('admin_acting_teacher');
        }
    }

    appendTeacherQuery(url) {
        const teacher = this.getActingTeacher();
        if (!teacher) {
            return url;
        }
        const separator = url.includes('?') ? '&' : '?';
        return `${url}${separator}teacher=${encodeURIComponent(teacher)}`;
    }

    async loadTeachersList() {
        if (!this.isAdmin) {
            return [];
        }
        const data = await this.apiRequest('/teachers/list');
        return data?.success ? data.teachers : [];
    }

    async setupAdminTeacherSelector() {
        const bar = document.getElementById('adminTeacherBar');
        const select = document.getElementById('adminActingTeacherSelect');
        if (!bar || !select) {
            return;
        }

        bar.style.display = 'block';
        bar.classList.remove('hidden');

        const teachers = await this.loadTeachersList();
        select.innerHTML = '<option value="">— Выберите преподавателя —</option>';
        teachers.forEach((teacher) => {
            const option = document.createElement('option');
            option.value = teacher.name;
            option.textContent = teacher.name;
            select.appendChild(option);
        });

        if (this.adminActingTeacher) {
            select.value = this.adminActingTeacher;
        }

        select.addEventListener('change', async () => {
            this.setActingTeacher(select.value);
            const scheduleModule = this.modules.schedule;
            const newRequestModule = this.modules['new-request'];
            if (scheduleModule?.onActingTeacherChanged) {
                await scheduleModule.onActingTeacherChanged();
            }
            if (newRequestModule?.onActingTeacherChanged) {
                await newRequestModule.onActingTeacherChanged();
            }
            if (this.currentSection === 'schedule' || this.currentSection === 'new-request') {
                await this.loadCurrentSectionData();
            }
        });
    }

    isAdminSection(section) {
        return this.adminSections.includes(section);
    }

    toggleAdminFilters(section) {
        const filtersPanel = document.getElementById('adminFiltersPanel');
        if (!filtersPanel || !this.isAdmin) {
            return;
        }

        if (this.isAdminSection(section)) {
            filtersPanel.classList.remove('hidden');
        } else {
            filtersPanel.classList.add('hidden');
        }
    }
    
    async initModules() {
        console.log('📦 Инициализация модулей...');
        
        try {
            if (this.isAdmin) {
                if (typeof AdminModule !== 'undefined') {
                    this.modules.admin = new AdminModule(this);
                    await this.modules.admin.init();
                }
            }

            this.modules.schedule = new ScheduleModule(this);
            await this.modules.schedule.init();
            
            if (typeof RequestsModule !== 'undefined') {
                this.modules.requests = new RequestsModule(this);
                await this.modules.requests.init();
            }
            
            if (typeof NewRequestModule !== 'undefined') {
                this.modules['new-request'] = new NewRequestModule(this);
                await this.modules['new-request'].init();
            }
            
            if (typeof ProfileModule !== 'undefined') {
                this.modules.profile = new ProfileModule(this);
                await this.modules.profile.init();
            }
            
        } catch (error) {
            console.error('❌ Ошибка инициализации модулей:', error);
        }
    }
    
    async loadCurrentSectionData() {
        console.log(`📊 Загрузка данных для раздела: ${this.currentSection}`);
        
        if (this.isAdminSection(this.currentSection) && this.modules.admin) {
            try {
                await this.modules.admin.loadData();
            } catch (error) {
                console.error('❌ Ошибка загрузки данных админки:', error);
                this.showError(`Не удалось загрузить данные: ${error.message}`);
            }
            return;
        }

        const module = this.modules[this.currentSection];
        if (module && typeof module.loadData === 'function') {
            try {
                await module.loadData();
            } catch (error) {
                console.error(`❌ Ошибка загрузки данных для ${this.currentSection}:`, error);
                this.showError(`Не удалось загрузить данные для ${this.currentSection}: ${error.message}`);
            }
        }
    }
    
    async showSection(section) {
        console.log(`🔄 Переключение на раздел: ${section}`);

        // Повторный клик по вкладке — перезагрузить данные
        if (this.currentSection === section) {
            await this.loadCurrentSectionData();
            return;
        }

        this.toggleAdminFilters(section);
        
        // Скрываем текущий раздел
        const currentSectionEl = document.getElementById(`${this.currentSection}-section`);
        const currentNavBtn = document.querySelector(`.nav-btn[data-section="${this.currentSection}"]`);
        
        if (currentSectionEl) {
            currentSectionEl.classList.remove('active');
            currentSectionEl.style.display = 'none';
        }
        if (currentNavBtn) currentNavBtn.classList.remove('active');
        
        // Показываем новый раздел
        this.currentSection = section;
        
        const newSectionEl = document.getElementById(`${section}-section`);
        const newNavBtn = document.querySelector(`.nav-btn[data-section="${section}"]`);
        
        if (newSectionEl) {
            newSectionEl.classList.add('active');
            newSectionEl.style.display = 'block';
        }
        if (newNavBtn) newNavBtn.classList.add('active');
        
        // Загружаем данные для нового раздела
        await this.loadCurrentSectionData();
    }
    
    async verifySession() {
        const profile = await this.apiRequest('/profile', {}, { skipAuthRedirect: true });
        if (profile?.success) {
            if (profile.user) {
                this.user = { ...this.user, ...profile.user };
                localStorage.setItem('user', JSON.stringify(this.user));
            }
            return true;
        }

        this.handleSessionExpired(
            profile?.message?.includes('токен')
                ? 'Сессия истекла. Войдите снова.'
                : (profile?.message || 'Не удалось проверить сессию. Войдите снова.')
        );
        return false;
    }

    // API запросы - ИСПРАВЛЕННАЯ ВЕРСИЯ
    async apiRequest(endpoint, options = {}, requestOptions = {}) {
        console.log(`🌐 API запрос: ${endpoint}`);
        
        const defaultOptions = {
            headers: {
                'Authorization': `Bearer ${this.token}`,
                'Content-Type': 'application/json'
            }
        };
        
        try {
             const basePath = window.BASE_PATH || '';
                const fullUrl = endpoint.startsWith('/api') 
                ? `${basePath}${endpoint}` 
                : `${basePath}/api${endpoint}`;
            
            console.log(`🌐 Полный URL: ${fullUrl}`);
            
            const response = await fetch(fullUrl, {
                ...defaultOptions,
                ...options
            });
            
            console.log(`📊 Статус ответа: ${response.status} для ${fullUrl}`);
            
            // Читаем как текст ВСЕГДА
            const responseText = await response.text();
            console.log(`📄 Ответ сервера (первые 200 символов):`, responseText.substring(0, 200));
            
            // Если ответ пустой
            if (!responseText.trim()) {
                console.warn('⚠️ Пустой ответ от сервера');
                return {
                    success: false,
                    message: `Пустой ответ от сервера (статус: ${response.status})`
                };
            }
            
            // Пробуем парсить JSON
            let data;
            try {
                data = JSON.parse(responseText);
            } catch (parseError) {
                console.error('❌ Ошибка парсинга JSON:', parseError);
                
                // Если это HTML ошибка
                if (responseText.includes('<!DOCTYPE') || responseText.includes('<html>')) {
                    return {
                        success: false,
                        message: `Ошибка сервера: получен HTML вместо JSON (статус: ${response.status})`
                    };
                }
                
                return {
                    success: false,
                    message: `Ошибка парсинка ответа (статус: ${response.status})`,
                    rawResponse: responseText.substring(0, 100)
                };
            }
            
            // Если статус ошибки
            if (!response.ok) {
                if (response.status === 401 && !requestOptions.skipAuthRedirect) {
                    this.handleSessionExpired(
                        data.message?.includes('токен')
                            ? 'Сессия истекла. Войдите снова.'
                            : (data.message || 'Требуется повторный вход')
                    );
                }

                return {
                    success: false,
                    message: data.message || `Ошибка ${response.status}: ${response.statusText}`,
                    ...data
                };
            }
            
            return data;
            
        } catch (error) {
            console.error('❌ Ошибка API запроса:', error);
            return {
                success: false,
                message: error.message || 'Ошибка сети',
                error: error.toString()
            };
        }
    }
    
    logout() {
        console.log('👋 Выход из системы');
        
        if (confirm('Вы уверены, что хотите выйти?')) {
            localStorage.removeItem('token');
            localStorage.removeItem('user');
            window.location.href = `${window.BASE_PATH || ''}/`;
        }
    }
    
    // Утилиты
    showError(message) {
        console.error('❌ Ошибка:', message);
        
        const errorEl = document.createElement('div');
        errorEl.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            background: #e74c3c;
            color: white;
            padding: 15px 25px;
            border-radius: 8px;
            z-index: 1000;
            animation: slideIn 0.3s ease;
            display: flex;
            align-items: center;
            gap: 10px;
            box-shadow: 0 4px 12px rgba(231, 76, 60, 0.3);
        `;
        errorEl.innerHTML = `<i class="fas fa-exclamation-circle"></i> ${message}`;
        document.body.appendChild(errorEl);
        
        setTimeout(() => {
            errorEl.style.animation = 'slideOut 0.3s ease';
            setTimeout(() => errorEl.remove(), 300);
        }, 5000);
    }
    
    showSuccess(message) {
        console.log('✅ Успех:', message);
        
        const successEl = document.createElement('div');
        successEl.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            background: #27ae60;
            color: white;
            padding: 15px 25px;
            border-radius: 8px;
            z-index: 1000;
            animation: slideIn 0.3s ease;
            display: flex;
            align-items: center;
            gap: 10px;
            box-shadow: 0 4px 12px rgba(39, 174, 96, 0.3);
        `;
        successEl.innerHTML = `<i class="fas fa-check-circle"></i> ${message}`;
        document.body.appendChild(successEl);
        
        setTimeout(() => {
            successEl.style.animation = 'slideOut 0.3s ease';
            setTimeout(() => successEl.remove(), 300);
        }, 3000);
    }
}

// Запуск при загрузке страницы
document.addEventListener('DOMContentLoaded', () => {
    console.log('📄 DOM загружен, запускаем Dashboard...');
    window.dashboard = new DashboardApp();
    window.dashboard.init().catch(error => {
        console.error('❌ Критическая ошибка инициализации Dashboard:', error);
        alert('Ошибка загрузки панели управления. Проверьте консоль для подробностей.');
    });
});
