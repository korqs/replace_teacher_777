// public/schedule.js
class ScheduleModule {
    constructor(dashboard) {
        this.dashboard = dashboard;
        this.currentDate = new Date();
        this.weekStart = new Date();
        this.availableDates = [];
        this.viewMode = 'day';
    }

    formatDateLocal(date) {
        if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }

    normalizeDateString(value) {
        if (value == null || value === '') return null;
        if (typeof value === 'string') {
            const match = value.match(/^(\d{4}-\d{2}-\d{2})/);
            return match ? match[1] : null;
        }
        if (value instanceof Date) {
            return this.formatDateLocal(value);
        }
        return null;
    }

    parseDateLocal(dateStr) {
        return new Date(`${dateStr}T12:00:00`);
    }

    getTodayStr() {
        return this.formatDateLocal(new Date());
    }

    getWeekStart(date) {
        const d = new Date(date);
        const dow = d.getDay();
        const diff = dow === 0 ? -6 : 1 - dow;
        d.setDate(d.getDate() + diff);
        return d;
    }

    addDays(date, days) {
        const d = new Date(date);
        d.setDate(d.getDate() + days);
        return d;
    }

    formatWeekRange(weekStart) {
        const end = this.addDays(weekStart, 5);
        const opts = { day: 'numeric', month: 'short' };
        const startStr = weekStart.toLocaleDateString('ru-RU', opts);
        const endStr = end.toLocaleDateString('ru-RU', { ...opts, year: 'numeric' });
        return `${startStr} – ${endStr}`;
    }

    getClassTime(classNum, dinnerType) {
        const times = {
            predlunch: {
                1: '8:30 - 10:00', 2: '10:10 - 11:40', 3: '12:25 - 13:55',
                4: '14:05 - 15:35', 5: '15:55 - 17:25', 6: '17:35 - 19:05', 7: '19:15 - 20:45'
            },
            postlunch: {
                1: '8:30 - 10:00', 2: '10:10 - 11:40', 3: '11:50 - 13:20',
                4: '14:05 - 15:35', 5: '15:55 - 17:25', 6: '17:35 - 19:05', 7: '19:15 - 20:45'
            },
            default: {
                1: '8:30 - 10:00', 2: '10:10 - 11:40', 3: '11:50 - 13:55',
                4: '14:05 - 15:35', 5: '15:55 - 17:25', 6: '17:35 - 19:05', 7: '19:15 - 20:45'
            }
        };
        return times[dinnerType]?.[classNum] || times.default[classNum] || `${classNum} пара`;
    }

    getDinnerText(dinnerType) {
        switch (dinnerType) {
            case 'predlunch': return 'Обед перед 3 парой';
            case 'postlunch': return 'Обед после 3 пары';
            default: return '';
        }
    }

    buildReplacementNote(lesson) {
        if (!lesson.is_replacement) return '';
        if (lesson.replaced_by) {
            return `<span><i class="fas fa-user-check"></i> Заменяет: ${lesson.replaced_by}</span>`;
        }
        if (lesson.covers_for) {
            return `<span><i class="fas fa-user-friends"></i> Замена вместо: ${lesson.covers_for}</span>`;
        }
        return `<span><i class="fas fa-exchange-alt"></i> Замена</span>`;
    }

    formatLessonMetaHtml(lesson) {
        const parts = [];
        const type = String(lesson?.type || '').trim();
        const audiense = String(lesson?.audiense || '').trim();

        if (type) {
            parts.push(`<span><i class="fas fa-chalkboard"></i> ${this.escapeHtml(type)}</span>`);
        }
        if (audiense) {
            parts.push(`<span><i class="fas fa-door-open"></i> ${this.escapeHtml(audiense)}</span>`);
        }
        return parts.join('');
    }

    escapeHtml(str) {
        return String(str)
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;');
    }

    async loadAvailableDates() {
        if (this.dashboard.needsTeacherSelection() && !this.dashboard.getActingTeacher()) {
            this.availableDates = [];
            return this.availableDates;
        }

        const data = await this.dashboard.apiRequest(
            this.dashboard.appendTeacherQuery('/schedule/available-dates')
        );
        if (!data || !data.success) {
            throw new Error(data?.message || 'Не удалось загрузить список дат расписания');
        }
        const raw = Array.isArray(data.dates) ? data.dates : [];
        this.availableDates = [...new Set(
            raw.map((d) => this.normalizeDateString(d)).filter(Boolean)
        )].sort();
        return this.availableDates;
    }

    showNoDatesAvailable() {
        const currentDateEl = document.getElementById('currentDate');
        const weekRangeEl = document.getElementById('currentWeekRange');
        if (currentDateEl) currentDateEl.textContent = 'Нет дат в расписании';
        if (weekRangeEl) weekRangeEl.textContent = 'Нет дат в расписании';

        ['prevDateBtn', 'nextDateBtn', 'todayBtn', 'prevWeekBtn', 'nextWeekBtn', 'todayWeekBtn'].forEach((id) => {
            const btn = document.getElementById(id);
            if (btn) {
                btn.disabled = true;
                btn.style.opacity = '0.5';
                btn.style.cursor = 'not-allowed';
            }
        });

        const message = this.dashboard.needsTeacherSelection() && !this.dashboard.getActingTeacher()
            ? 'Выберите преподавателя в списке выше, чтобы просмотреть расписание.'
            : 'В базе нет занятий для выбранного преподавателя. Обратитесь к администратору или обновите расписание.';

        this.showEmpty(message);
    }

    async onActingTeacherChanged() {
        this.availableDates = [];
        await this.loadAvailableDates();

        if (this.availableDates.length === 0) {
            this.showNoDatesAvailable();
            return;
        }

        this.setInitialDate();
        this.weekStart = this.getWeekStart(this.currentDate);
        this.updateDateDisplay();
        await this.loadData();
    }

    async init() {
        try {
            this.setupUI();
            await this.loadAvailableDates();

            if (this.availableDates.length === 0) {
                this.showNoDatesAvailable();
                return true;
            }

            this.setInitialDate();
            this.weekStart = this.getWeekStart(this.currentDate);
            this.updateDateDisplay();
            await this.loadData();
            return true;
        } catch (error) {
            this.showError('Ошибка инициализации: ' + error.message);
            return false;
        }
    }

    setInitialDate() {
        if (!this.availableDates.length) return;

        const todayStr = this.getTodayStr();
        const todayIndex = this.availableDates.indexOf(todayStr);

        if (todayIndex !== -1) {
            this.currentDate = this.parseDateLocal(todayStr);
        } else {
            let nearestDate = null;
            let nearestDiff = Infinity;
            const today = new Date();

            for (const dateStr of this.availableDates) {
                const diff = this.parseDateLocal(dateStr) - today;
                if (diff >= 0 && diff < nearestDiff) {
                    nearestDiff = diff;
                    nearestDate = dateStr;
                }
            }
            if (!nearestDate) {
                nearestDate = this.availableDates[this.availableDates.length - 1];
            }
            this.currentDate = this.parseDateLocal(nearestDate);
        }
    }

    setupUI() {
        this.setupViewToggle();
        this.setupDateNavigation();
        this.setupWeekNavigation();
    }

    setupViewToggle() {
        const toggle = document.getElementById('scheduleViewToggle');
        if (!toggle) return;

        toggle.querySelectorAll('.view-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                const mode = btn.dataset.view;
                if (mode && mode !== this.viewMode) {
                    this.setViewMode(mode);
                }
            });
        });
    }

    setViewMode(mode) {
        this.viewMode = mode;

        document.querySelectorAll('#scheduleViewToggle .view-btn').forEach((btn) => {
            btn.classList.toggle('active', btn.dataset.view === mode);
        });

        const dayView = document.getElementById('day-schedule');
        const weekView = document.getElementById('week-schedule');
        const dayNav = document.getElementById('dayNavControls');
        const weekNav = document.getElementById('weekNavControls');

        if (dayView) dayView.style.display = mode === 'day' ? 'block' : 'none';
        if (weekView) weekView.style.display = mode === 'week' ? 'block' : 'none';
        if (dayNav) dayNav.style.display = mode === 'day' ? 'flex' : 'none';
        if (weekNav) weekNav.style.display = mode === 'week' ? 'flex' : 'none';

        if (mode === 'week') {
            this.weekStart = this.getWeekStart(this.currentDate);
        }

        this.updateDateDisplay();
        this.loadData();
    }

    setupDateNavigation() {
        document.getElementById('prevDateBtn')?.addEventListener('click', () => this.navigateDate(-1));
        document.getElementById('nextDateBtn')?.addEventListener('click', () => this.navigateDate(1));
        document.getElementById('todayBtn')?.addEventListener('click', () => this.goToToday());
    }

    setupWeekNavigation() {
        document.getElementById('prevWeekBtn')?.addEventListener('click', () => this.navigateWeek(-1));
        document.getElementById('nextWeekBtn')?.addEventListener('click', () => this.navigateWeek(1));
        document.getElementById('todayWeekBtn')?.addEventListener('click', () => this.goToCurrentWeek());
    }

    navigateDate(step) {
        if (!this.availableDates.length) return;

        const currentDateStr = this.formatDateLocal(this.currentDate);
        let currentIndex = this.availableDates.indexOf(currentDateStr);
        if (currentIndex === -1) {
            currentIndex = this.findNearestDateIndex(currentDateStr);
        }

        const newIndex = currentIndex + step;
        if (newIndex >= 0 && newIndex < this.availableDates.length) {
            this.currentDate = this.parseDateLocal(this.availableDates[newIndex]);
            this.updateDateDisplay();
            this.loadData();
        }
    }

    navigateWeek(step) {
        this.weekStart = this.addDays(this.weekStart, step * 7);
        this.updateDateDisplay();
        this.loadData();
    }

    findNearestDateIndex(dateStr) {
        const targetDate = this.parseDateLocal(dateStr);
        let nearestIndex = 0;
        let nearestDiff = Infinity;

        for (let i = 0; i < this.availableDates.length; i++) {
            const diff = Math.abs(this.parseDateLocal(this.availableDates[i]) - targetDate);
            if (diff < nearestDiff) {
                nearestDiff = diff;
                nearestIndex = i;
            }
        }
        return nearestIndex;
    }

    goToToday() {
        if (!this.availableDates.length) return;

        const todayStr = this.getTodayStr();
        const index = this.availableDates.indexOf(todayStr);

        if (index !== -1) {
            this.currentDate = this.parseDateLocal(todayStr);
        } else {
            let nearestDate = null;
            let nearestDiff = Infinity;
            const today = new Date();

            for (const dateStr of this.availableDates) {
                const diff = this.parseDateLocal(dateStr) - today;
                if (diff >= 0 && diff < nearestDiff) {
                    nearestDiff = diff;
                    nearestDate = dateStr;
                }
            }
            if (!nearestDate) nearestDate = this.availableDates[0];
            this.currentDate = this.parseDateLocal(nearestDate);
        }

        this.updateDateDisplay();
        this.loadData();
    }

    goToCurrentWeek() {
        this.weekStart = this.getWeekStart(new Date());
        this.currentDate = this.parseDateLocal(this.getTodayStr());
        this.updateDateDisplay();
        this.loadData();
    }

    updateNavigationButtons() {
        if (!this.availableDates.length) return;

        const currentDateStr = this.formatDateLocal(this.currentDate);
        const currentIndex = this.availableDates.indexOf(currentDateStr);

        const prevBtn = document.getElementById('prevDateBtn');
        const nextBtn = document.getElementById('nextDateBtn');

        if (prevBtn) {
            const isDisabled = currentIndex <= 0;
            prevBtn.disabled = isDisabled;
            prevBtn.style.opacity = isDisabled ? '0.5' : '1';
            prevBtn.style.cursor = isDisabled ? 'not-allowed' : 'pointer';
        }
        if (nextBtn) {
            const isDisabled = currentIndex >= this.availableDates.length - 1;
            nextBtn.disabled = isDisabled;
            nextBtn.style.opacity = isDisabled ? '0.5' : '1';
            nextBtn.style.cursor = isDisabled ? 'not-allowed' : 'pointer';
        }
    }

    updateDateDisplay() {
        if (this.viewMode === 'week') {
            const weekRangeEl = document.getElementById('currentWeekRange');
            if (weekRangeEl) {
                weekRangeEl.textContent = this.formatWeekRange(this.weekStart);
            }
            return;
        }

        const dateStr = this.formatDateLocal(this.currentDate);
        const formattedDate = this.currentDate.toLocaleDateString('ru-RU', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric'
        });

        const currentDateEl = document.getElementById('currentDate');
        if (currentDateEl) {
            currentDateEl.textContent = formattedDate;
        }
        this.updateNavigationButtons();
    }

    async loadData() {
        if (this.viewMode === 'week') {
            await this.loadWeekData();
        } else {
            await this.loadDayData();
        }
    }

    async loadDayData() {
        const dateStr = this.formatDateLocal(this.currentDate);

        if (this.dashboard.needsTeacherSelection() && !this.dashboard.getActingTeacher()) {
            this.showEmpty('Выберите преподавателя в списке выше, чтобы просмотреть расписание.');
            return;
        }

        try {
            this.showLoading();

            const data = await this.dashboard.apiRequest(
                this.dashboard.appendTeacherQuery(`/schedule?date=${dateStr}`)
            );

            if (data && data.success) {
                this.displayDaySchedule(data);
            } else {
                const message = data?.message || data?.error || 'Не удалось загрузить расписание';
                this.showEmpty(message);
            }
        } catch (error) {
            this.showError('Ошибка загрузки расписания: ' + error.message);
        }
    }

    async loadWeekData() {
        const startStr = this.formatDateLocal(this.weekStart);

        if (this.dashboard.needsTeacherSelection() && !this.dashboard.getActingTeacher()) {
            this.showWeekEmpty('Выберите преподавателя в списке выше, чтобы просмотреть расписание.');
            return;
        }

        try {
            this.showWeekLoading();

            const data = await this.dashboard.apiRequest(
                this.dashboard.appendTeacherQuery(`/schedule/week?start=${startStr}`)
            );

            if (data && data.success) {
                this.displayWeekSchedule(data);
            } else {
                const message = data?.message || 'Не удалось загрузить расписание на неделю';
                this.showWeekEmpty(message);
            }
        } catch (error) {
            this.showWeekError('Ошибка загрузки: ' + error.message);
        }
    }

    displayDaySchedule(data) {
        const container = document.getElementById('dayScheduleContainer');
        if (!container) {
            this.showError('Ошибка отображения: контейнер не найден');
            return;
        }

        if (!data.schedule || data.schedule.length === 0) {
            this.showEmpty('На выбранную дату занятий нет', container);
            return;
        }

        container.innerHTML = data.schedule.map((lesson) => this.renderDayLesson(lesson)).join('');
        this.updateNavigationButtons();
    }

    displayWeekSchedule(data) {
        const container = document.getElementById('weekScheduleContainer');
        if (!container) return;

        const todayStr = this.getTodayStr();
        const dayShort = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

        container.innerHTML = data.days.map((day) => {
            const isToday = day.date === todayStr;
            const dateObj = this.parseDateLocal(day.date);
            const headerDate = dateObj.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
            const lessonsHtml = day.schedule.length
                ? day.schedule.map((l) => this.renderWeekLesson(l)).join('')
                : '<p class="week-day-empty">Нет пар</p>';

            return `
                <div class="day-column${isToday ? ' today' : ''}" data-date="${day.date}">
                    <div class="day-header">
                        <div class="day-name">${dayShort[day.day_of_week] || day.day_name}</div>
                        <div class="day-date">${headerDate}</div>
                    </div>
                    <div class="day-lessons">${lessonsHtml}</div>
                </div>
            `;
        }).join('');

        container.querySelectorAll('.day-column').forEach((col) => {
            col.addEventListener('click', (e) => {
                if (e.target.closest('.week-replace-btn')) return;
                const date = col.dataset.date;
                if (date) {
                    this.currentDate = this.parseDateLocal(date);
                    this.setViewMode('day');
                }
            });
        });
    }

    renderDayLesson(lesson) {
        const isReplacement = lesson.is_replacement;
        const canRequest = lesson.can_request_replacement;
        const classTime = this.getClassTime(lesson.classes, lesson.dinner);
        const dinnerText = this.getDinnerText(lesson.dinner);
        const replacementNote = this.buildReplacementNote(lesson);
        const lessonMeta = this.formatLessonMetaHtml(lesson);
        const lessonJson = JSON.stringify(lesson).replace(/"/g, '&quot;');

        return `
            <div class="schedule-item ${isReplacement ? 'replacement' : ''}">
                <div class="schedule-time">
                    <span class="class-number">${lesson.classes}</span>
                    ${classTime}
                </div>
                <div class="schedule-details">
                    <div class="schedule-subject">${this.escapeHtml(lesson.subject)}</div>
                    <div class="schedule-meta">
                        <span><i class="fas fa-users"></i> ${this.escapeHtml(lesson.team)}</span>
                        <span><i class="fas fa-book"></i> ${lesson.num_den_text || ''}</span>
                        ${lessonMeta}
                        ${dinnerText ? `<span><i class="fas fa-utensils"></i> ${dinnerText}</span>` : ''}
                        ${replacementNote}
                    </div>
                </div>
                <div class="schedule-actions">
                    ${canRequest ? `
                        <button type="button" class="request-replacement-btn"
                                onclick="dashboard.modules.schedule.requestReplacement(${lessonJson})">
                            <i class="fas fa-exchange-alt"></i> Замена
                        </button>
                    ` : `
                        <button type="button" class="request-replacement-btn" disabled title="Недоступно для замены">
                            <i class="fas fa-ban"></i> Недоступно
                        </button>
                    `}
                </div>
            </div>
        `;
    }

    renderWeekLesson(lesson) {
        const classTime = this.getClassTime(lesson.classes, lesson.dinner);
        const replacementClass = lesson.is_replacement ? ' replacement' : '';
        const lessonJson = JSON.stringify(lesson).replace(/"/g, '&quot;');
        let replaceBtn = '';

        if (lesson.can_request_replacement) {
            replaceBtn = `
                <button type="button" class="week-replace-btn" title="Запросить замену"
                        onclick="event.stopPropagation(); dashboard.modules.schedule.requestReplacement(${lessonJson})">
                    <i class="fas fa-exchange-alt"></i>
                </button>
            `;
        }

        return `
            <div class="week-lesson${replacementClass}">
                <div class="week-lesson-top">
                    <span class="time">${lesson.classes} пара · ${classTime}</span>
                    ${replaceBtn}
                </div>
                <div class="subject">${this.escapeHtml(lesson.subject)}</div>
                <div class="week-lesson-meta">${this.formatWeekLessonMetaText(lesson)}</div>
            </div>
        `;
    }

    formatWeekLessonMetaText(lesson) {
        const parts = [lesson.team].filter(Boolean);
        if (lesson.type) parts.push(lesson.type);
        if (lesson.audiense) parts.push(lesson.audiense);
        return parts.map((p) => this.escapeHtml(p)).join(' · ');
    }

    async requestReplacement(lesson) {
        try {
            const confirmMessage = `Перейти к созданию заявки на замену?\n\nПредмет: ${lesson.subject}\nГруппа: ${lesson.team}\nПара: ${lesson.classes}${lesson.type ? `\nТип: ${lesson.type}` : ''}${lesson.audiense ? `\nАудитория: ${lesson.audiense}` : ''}\nДата: ${lesson.date}`;

            if (!confirm(confirmMessage)) return;

            const newReqModule = this.dashboard?.modules?.['new-request'];
            if (newReqModule?.prefillFromLesson) {
                if (this.dashboard?.showSection) {
                    await this.dashboard.showSection('new-request');
                }
                await newReqModule.prefillFromLesson(lesson);
            } else {
                localStorage.setItem('prefill_lesson', JSON.stringify(lesson));
                if (this.dashboard?.showSection) {
                    await this.dashboard.showSection('new-request');
                }
            }
        } catch (error) {
            this.dashboard.showError('Ошибка перехода к созданию заявки: ' + error.message);
        }
    }

    showLoading() {
        const container = document.getElementById('dayScheduleContainer');
        if (container) {
            container.innerHTML = `
                <div class="loading-schedule">
                    <i class="fas fa-spinner fa-spin"></i>
                    <p>Загрузка расписания...</p>
                </div>
            `;
        }
    }

    showWeekLoading() {
        const container = document.getElementById('weekScheduleContainer');
        if (container) {
            container.innerHTML = `
                <div class="loading-schedule">
                    <i class="fas fa-spinner fa-spin"></i>
                    <p>Загрузка расписания на неделю...</p>
                </div>
            `;
        }
    }

    showEmpty(message, container = null) {
        const targetContainer = container || document.getElementById('dayScheduleContainer');
        if (targetContainer) {
            targetContainer.innerHTML = `
                <div class="empty-state">
                    <i class="fas fa-calendar-times"></i>
                    <p>${this.escapeHtml(message)}</p>
                </div>
            `;
        }
    }

    showWeekEmpty(message) {
        const container = document.getElementById('weekScheduleContainer');
        if (container) {
            container.innerHTML = `
                <div class="empty-state">
                    <i class="fas fa-calendar-times"></i>
                    <p>${this.escapeHtml(message)}</p>
                </div>
            `;
        }
    }

    showError(message) {
        const container = document.getElementById('dayScheduleContainer');
        if (container) {
            container.innerHTML = `
                <div class="empty-state">
                    <i class="fas fa-exclamation-triangle"></i>
                    <p>${this.escapeHtml(message)}</p>
                    <button type="button" class="btn btn-primary" onclick="dashboard.modules.schedule.retryInit()">
                        <i class="fas fa-redo"></i> Попробовать снова
                    </button>
                </div>
            `;
        }
    }

    showWeekError(message) {
        const container = document.getElementById('weekScheduleContainer');
        if (container) {
            container.innerHTML = `
                <div class="empty-state">
                    <i class="fas fa-exclamation-triangle"></i>
                    <p>${this.escapeHtml(message)}</p>
                    <button type="button" class="btn btn-primary" onclick="dashboard.modules.schedule.retryInit()">
                        <i class="fas fa-redo"></i> Попробовать снова
                    </button>
                </div>
            `;
        }
    }

    async retryInit() {
        if (this.viewMode === 'week') {
            this.showWeekLoading();
        } else {
            this.showLoading();
        }

        try {
            await this.loadAvailableDates();
            if (this.availableDates.length === 0) {
                this.showNoDatesAvailable();
                return;
            }
            this.setInitialDate();
            this.weekStart = this.getWeekStart(this.currentDate);
            this.updateDateDisplay();
            await this.loadData();
        } catch (error) {
            if (this.viewMode === 'week') {
                this.showWeekError('Ошибка загрузки: ' + error.message);
            } else {
                this.showError('Ошибка загрузки: ' + error.message);
            }
        }
    }
}

window.ScheduleModule = ScheduleModule;
