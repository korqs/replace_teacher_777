// public/auth.js - УПРОЩЕННАЯ ВЕРСИЯ
class AuthSystem {
    constructor() {
        this.apiBaseUrl = window.location.origin;
        this.token = localStorage.getItem('token');
        this.user = JSON.parse(localStorage.getItem('user') || 'null');
    }

    // Вход в систему
    async login(email, password) {
        try {
            console.log('Попытка входа для:', email);
            
            const response = await fetch('/api/auth/login', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ email, password })
            });

            let data;
            try {
                data = await response.json();
            } catch (_) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            if (data.success) {
                this.token = data.token;
                this.user = data.user;
                
                localStorage.setItem('token', data.token);
                localStorage.setItem('user', JSON.stringify(data.user));
                
                console.log('Вход успешен!');
                return { success: true, data };
            } else {
                console.log('Ошибка входа:', data.message);
                return { 
                    success: false, 
                    message: data.message || 'Неверный email или пароль' 
                };
            }
        } catch (error) {
            console.error('Ошибка при входе:', error);
            const isNetworkError = error instanceof TypeError && /fetch|network|failed/i.test(error.message);
            return { 
                success: false, 
                message: isNetworkError
                    ? 'Ошибка соединения с сервером. Проверьте, что сервер запущен.'
                    : (error.message || 'Ошибка соединения с сервером')
            };
        }
    }

    // Проверка авторизации
    isAuthenticated() {
        const token = localStorage.getItem('token');
        const user = localStorage.getItem('user');
        if (!token || !user) {
            return false;
        }
        return this.isTokenNotExpired(token);
    }

    isTokenNotExpired(token) {
        try {
            const base64 = token.split('.')[1]?.replace(/-/g, '+').replace(/_/g, '/');
            if (!base64) {
                return false;
            }
            const payload = JSON.parse(atob(base64));
            if (payload.exp && payload.exp * 1000 <= Date.now()) {
                return false;
            }
            return true;
        } catch (_) {
            return false;
        }
    }

    clearStoredAuth(message) {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
        this.token = null;
        this.user = null;
        if (message) {
            sessionStorage.setItem('auth_message', message);
        }
    }

    async validateSession() {
        const token = localStorage.getItem('token');
        if (!token || !localStorage.getItem('user')) {
            return false;
        }

        if (!this.isTokenNotExpired(token)) {
            this.clearStoredAuth('Сессия истекла. Войдите снова.');
            return false;
        }

        try {
            const response = await fetch('/api/profile', {
                headers: { Authorization: `Bearer ${token}` }
            });

            if (response.status === 401) {
                this.clearStoredAuth('Сессия истекла. Войдите снова.');
                return false;
            }

            return response.ok;
        } catch (_) {
            return true;
        }
    }

    // Получение информации о текущем пользователе
    getCurrentUser() {
        const userStr = localStorage.getItem('user');
        return userStr ? JSON.parse(userStr) : null;
    }

    // Выход из системы
    logout() {
        console.log('Выход из системы');
        localStorage.removeItem('token');
        localStorage.removeItem('user');
        this.token = null;
        this.user = null;
        
        // Немедленно перенаправляем на главную
        window.location.href = '/';
    }
}

// Глобальный экземпляр
window.auth = new AuthSystem();

// ================================================
// ОБРАБОТКА ФОРМЫ ВХОДА (ТОЛЬКО ДЛЯ index.html)
// ================================================
document.addEventListener('DOMContentLoaded', async function() {
    // Проверяем, находимся ли мы на странице входа
    const loginForm = document.getElementById('loginForm');
    const errorMessage = document.getElementById('errorMessage');
    
    if (!loginForm) {
        console.log('Не на странице входа, пропускаем инициализацию формы');
        return;
    }
    
    console.log('Инициализация формы входа...');

    function showError(message) {
        if (!errorMessage) return;

        const errorText = document.getElementById('errorText');
        if (errorText) {
            errorText.textContent = message;
        }
        errorMessage.style.display = 'flex';

        setTimeout(() => {
            errorMessage.style.display = 'none';
        }, 5000);
    }

    const authNotice = sessionStorage.getItem('auth_message');
    if (authNotice) {
        sessionStorage.removeItem('auth_message');
        showError(authNotice);
    }
    
    // Если уже авторизован и на странице входа - перенаправляем на dashboard
    if (window.auth.isAuthenticated()) {
        const valid = await window.auth.validateSession();
        if (valid) {
            console.log('Уже авторизован, перенаправляем на dashboard');
            window.location.href = '/dashboard';
            return;
        }
    }
    
    // Обработчик отправки формы
    loginForm.addEventListener('submit', async function(e) {
        e.preventDefault();
        
        const email = document.getElementById('email').value.trim();
        const password = document.getElementById('password').value;
        
        // Скрываем предыдущие ошибки
        if (errorMessage) {
            errorMessage.style.display = 'none';
        }
        
        // Валидация
        if (!email || !password) {
            showError('Заполните все поля');
            return;
        }
        
        // Показываем загрузку
        const submitBtn = loginForm.querySelector('button[type="submit"]');
        const originalText = submitBtn.innerHTML;
        submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Вход...';
        submitBtn.disabled = true;
        
        try {
            const result = await window.auth.login(email, password);
            
            if (result.success) {
                console.log('Вход успешен! Перенаправляем...');
                
                // Небольшая задержка для UX
                setTimeout(() => {
                    window.location.href = '/dashboard';
                }, 500);
                
            } else {
                showError(result.message || 'Ошибка входа');
            }
        } catch (error) {
            console.error('Ошибка:', error);
            showError('Ошибка соединения с сервером');
        } finally {
            // Восстанавливаем кнопку
            submitBtn.innerHTML = originalText;
            submitBtn.disabled = false;
        }
    });
    
    // Автозаполнение тестовых данных
    document.querySelectorAll('.account-card').forEach(card => {
        card.addEventListener('click', function() {
            const email = this.getAttribute('data-email');
            const password = this.getAttribute('data-password');
            
            if (email && password) {
                document.getElementById('email').value = email;
                document.getElementById('password').value = password;
                
                // Показываем уведомление
                const notification = document.createElement('div');
                notification.style.cssText = `
                    position: fixed;
                    top: 20px;
                    right: 20px;
                    background: #27ae60;
                    color: white;
                    padding: 10px 20px;
                    border-radius: 8px;
                    z-index: 1000;
                    animation: slideIn 0.3s ease-out;
                    display: flex;
                    align-items: center;
                    gap: 10px;
                `;
                notification.innerHTML = `<i class="fas fa-check"></i> Данные заполнены!`;
                document.body.appendChild(notification);
                
                setTimeout(() => {
                    notification.remove();
                }, 2000);
            }
        });
    });
    
    // Добавляем стили для анимации
    if (!document.getElementById('auth-styles')) {
        const style = document.createElement('style');
        style.id = 'auth-styles';
        style.textContent = `
            @keyframes slideIn {
                from { transform: translateX(100%); opacity: 0; }
                to { transform: translateX(0); opacity: 1; }
            }
        `;
        document.head.appendChild(style);
    }
    
    console.log('Форма входа инициализирована');
});