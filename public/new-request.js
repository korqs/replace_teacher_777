// public/new-request.js
class NewRequestModule {
    constructor(dashboard) {
        this.dashboard = dashboard;
        this.container = null;
        this.prefill = null;
        this.lessonLocked = false;
        this.availableTeachers = [];
        this.selectedTeacher = null;
    }

    async init() {
        console.log('➕ Инициализация модуля "Новая заявка"');
        this.container = document.getElementById('newRequestFormContainer');
        this.setupUI();
        return true;
    }

    setupUI() {
        // UI будет построен при loadData
    }

    async onActingTeacherChanged() {
        this.prefill = null;
        this.lessonLocked = false;
        this.selectedTeacher = null;
        this.availableTeachers = [];
        this.renderForm();
    }

    scheduleQuery(path) {
        return this.dashboard.appendTeacherQuery(path);
    }

    getApplicantTeacher() {
        return this.dashboard.getActingTeacher();
    }

    async loadData() {
        if (!this.container) {
            this.container = document.getElementById('newRequestFormContainer');
        }

        // Подхватываем prefill из localStorage
        const stored = localStorage.getItem('prefill_lesson');
        if (stored) {
            try {
                this.prefill = JSON.parse(stored);
                if (this.prefill.date) {
                    this.prefill.date = this.fixDateForInput(this.prefill.date);
                }
                this.lessonLocked = true;
            } catch (_) {
                this.prefill = null;
            }
            localStorage.removeItem('prefill_lesson');
        } else if (!this.lessonLocked) {
            this.prefill = null;
        }

        this.renderForm();
        if (this.prefill) {
            await this.applyPrefill(this.prefill);
        }
    }

    getClassTime(classNum, dinnerType) {
        const times = {
            predlunch: {
                1: '8:30 - 10:00', 2: '10:10 - 11:40', 3: '12:25 - 13:55',
                4: '14:05 - 15:35', 5: '15:55 - 17:25'
            },
            postlunch: {
                1: '8:30 - 10:00', 2: '10:10 - 11:40', 3: '11:50 - 13:20',
                4: '14:05 - 15:35', 5: '15:55 - 17:25'
            },
            default: {
                1: '9:00 - 10:30', 2: '10:40 - 12:10', 3: '12:40 - 14:10',
                4: '14:20 - 15:50', 5: '16:00 - 17:30'
            }
        };
        return times[dinnerType]?.[classNum] || times.default[classNum] || '';
    }

    formatClassLabel(classNum, dinner, lessonMeta = null) {
        if (classNum == null || classNum === '') return '—';
        const num = Number(classNum);
        const time = this.getClassTime(num, dinner || null);
        let label = time ? `${num} пара · ${time}` : `${num} пара`;
        const type = String(lessonMeta?.type || '').trim();
        const audiense = String(lessonMeta?.audiense || '').trim();
        if (type) label += ` · ${type}`;
        if (audiense) label += ` · ${audiense}`;
        return label;
    }

    fixDateForInput(dateValue) {
        try {
            let date;
            if (typeof dateValue === 'string' && dateValue.includes('T')) {
                date = new Date(dateValue);
            } else if (typeof dateValue === 'string') {
                date = new Date(dateValue + 'T12:00:00');
            } else if (dateValue instanceof Date) {
                date = dateValue;
            } else {
                return dateValue;
            }
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            return `${year}-${month}-${day}`;
        } catch (error) {
            console.error('Ошибка при обработке даты:', error, dateValue);
            return dateValue;
        }
    }

    async prefillFromLesson(lesson) {
        if (lesson.date) {
            lesson.date = this.fixDateForInput(lesson.date);
        }
        this.lessonLocked = true;
        this.prefill = lesson;
        this.renderForm();
        await this.applyPrefill(lesson);
        try {
            this.container?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        } catch (_) {}
    }

    setLockedLessonFields(lesson) {
        const date = lesson.date ? this.fixDateForInput(lesson.date) : '';
        const classes = lesson.classes != null ? String(lesson.classes) : '';

        const dateInput = document.querySelector('input[name="request_date"]');
        const classesInput = document.querySelector('input[name="classes"]');
        const dateDisplay = document.getElementById('requestDateDisplay');
        const classesDisplay = document.getElementById('classesDisplay');

        if (dateInput) dateInput.value = date;
        if (classesInput) classesInput.value = classes;
        if (dateDisplay) dateDisplay.textContent = date ? this.formatDateForDisplay(date) : '—';
        if (classesDisplay) {
            classesDisplay.textContent = this.formatClassLabel(lesson.classes, lesson.dinner);
        }

        this.setAutoLessonFields(lesson, date);
    }

    async applyPrefill(lesson) {
        if (this.lessonLocked) {
            this.setLockedLessonFields(lesson);
            return;
        }

        const dateInput = document.getElementById('requestDate');
        if (dateInput && lesson.date) {
            dateInput.value = lesson.date;
        }
        await this.loadClasses(lesson.classes);
        if (lesson.classes != null) {
            await this.loadLessonBySlot();
        }
    }

    normalizeNumDen(value) {
        const key = String(value ?? '').trim().toLowerCase();
        if (key === 'num' || key === 'числитель') return 'num';
        if (key === 'den' || key === 'знаменатель') return 'den';
        return null;
    }

    resolveWeekAndNumDen(weekNum, numDen) {
        const week = parseInt(weekNum, 10);
        if (!Number.isInteger(week) || week < 1) {
            return { week_num: null, num_den: null };
        }

        return {
            week_num: week,
            num_den: week % 2 === 1 ? 'num' : 'den'
        };
    }

    numDenLabel(value) {
        const normalized = this.normalizeNumDen(value);
        if (normalized === 'den') return 'Знаменатель';
        if (normalized === 'num') return 'Числитель';
        return '—';
    }

    setWeekAndNumDen(weekNum, numDen) {
        const resolved = this.resolveWeekAndNumDen(weekNum, numDen);
        const weekInput = document.querySelector('input[name="week_num"]');
        const numDenInput = document.querySelector('input[name="num_den"]');
        const weekDisplay = document.getElementById('weekNumDisplay');
        const numDenDisplay = document.getElementById('numDenDisplay');

        const hasWeek = resolved.week_num != null;
        const hasNumDen = resolved.num_den === 'num' || resolved.num_den === 'den';

        if (weekInput) weekInput.value = hasWeek ? String(resolved.week_num) : '';
        if (numDenInput) numDenInput.value = hasNumDen ? resolved.num_den : '';
        if (weekDisplay) weekDisplay.textContent = hasWeek ? String(resolved.week_num) : '—';
        if (numDenDisplay) numDenDisplay.textContent = hasNumDen ? this.numDenLabel(resolved.num_den) : '—';
    }

    setSubjectTeamFields(lesson) {
        const subject = String(lesson?.subject || '').trim();
        const team = String(lesson?.team || '').trim();

        const subjectInput = document.querySelector('input[name="subject"]');
        const teamInput = document.querySelector('input[name="team"]');
        const subjectDisplay = document.getElementById('subjectDisplay');
        const teamDisplay = document.getElementById('teamDisplay');

        if (subjectInput) subjectInput.value = subject;
        if (teamInput) teamInput.value = team;
        if (subjectDisplay) subjectDisplay.textContent = subject || '—';
        if (teamDisplay) teamDisplay.textContent = team || '—';

        this.setLessonMetaFields(lesson);
    }

    setLessonMetaFields(lesson) {
        const type = String(lesson?.type || '').trim();
        const audiense = String(lesson?.audiense || '').trim();
        const typeDisplay = document.getElementById('typeDisplay');
        const audienseDisplay = document.getElementById('audienseDisplay');

        if (typeDisplay) typeDisplay.textContent = type || '—';
        if (audienseDisplay) audienseDisplay.textContent = audiense || '—';
    }

    clearLessonMetaFields() {
        this.setLessonMetaFields({});
    }

    clearSubjectTeamFields() {
        this.setSubjectTeamFields({});
    }

    clearWeekAndNumDen() {
        this.setWeekAndNumDen(null, null);
    }

    setAutoLessonFields(lesson, date) {
        this.setSubjectTeamFields(lesson);
        const dateValue = date || document.querySelector('input[name="request_date"]')?.value || '';
        if (lesson?.week_num != null && lesson?.week_num !== '') {
            this.setWeekAndNumDen(lesson.week_num, lesson.num_den);
        } else if (dateValue) {
            this.setWeekFromDate(dateValue);
        }
    }

    async setWeekFromDate(date) {
        if (!date) {
            this.clearWeekAndNumDen();
            return;
        }

        try {
            const data = await this.dashboard.apiRequest(
                this.scheduleQuery(`/schedule/my-classes?date=${encodeURIComponent(date)}`)
            );
            if (data?.success) {
                this.setWeekAndNumDen(data.week_num, data.num_den);
            }
        } catch (error) {
            console.error('❌ Ошибка загрузки недели по дате:', error);
        }
    }

    clearAutoLessonFields() {
        this.clearSubjectTeamFields();
        this.clearWeekAndNumDen();
    }

    async loadClasses(selectedClass) {
        const date = document.getElementById('requestDate')?.value;
        const classesSelect = document.getElementById('classes');

        if (!classesSelect) return;

        if (!date) {
            classesSelect.innerHTML = '<option value="">Сначала выберите дату</option>';
            classesSelect.disabled = true;
            this.clearAutoLessonFields();
            return;
        }

        classesSelect.disabled = true;
        classesSelect.innerHTML = '<option value="">Загрузка...</option>';

        try {
            const data = await this.dashboard.apiRequest(this.scheduleQuery(`/schedule/my-classes?date=${encodeURIComponent(date)}`));
            if (!data?.success) {
                classesSelect.innerHTML = '<option value="">Ошибка загрузки</option>';
                return;
            }

            if (data.classes.length === 0) {
                classesSelect.innerHTML = '<option value="">Нет пар в этот день</option>';
                this.clearSubjectTeamFields();
                this.clearWeekAndNumDen();
                return;
            }

            this.setWeekAndNumDen(data.week_num, data.num_den);

            classesSelect.innerHTML = '<option value="">Выберите пару</option>';
            data.classes.forEach((item) => {
                const cls = typeof item === 'object' ? item.classes : item;
                const dinner = typeof item === 'object' ? item.dinner : null;
                const option = document.createElement('option');
                option.value = cls;
                option.textContent = this.formatClassLabel(cls, dinner, item);
                if (dinner) option.dataset.dinner = dinner;
                classesSelect.appendChild(option);
            });
            classesSelect.disabled = false;

            if (selectedClass) {
                classesSelect.value = String(selectedClass);
                const option = classesSelect.selectedOptions[0];
                this.updateClassesTimeHint(selectedClass, option?.dataset.dinner || null);
                await this.loadLessonBySlot();
            } else {
                this.clearSubjectTeamFields();
                this.updateClassesTimeHint(null, null);
            }
        } catch (error) {
            console.error('❌ Ошибка загрузки пар:', error);
            classesSelect.innerHTML = '<option value="">Ошибка загрузки</option>';
        }
    }

    async loadLessonBySlot() {
        const date = document.getElementById('requestDate')?.value;
        const classes = document.getElementById('classes')?.value;

        if (!date || !classes) {
            this.clearSubjectTeamFields();
            return;
        }

        try {
            const params = new URLSearchParams({ date, classes });
            const data = await this.dashboard.apiRequest(
                this.scheduleQuery(`/schedule/my-lesson?${params}`)
            );

            if (!data?.success || !data.lesson) {
                this.clearSubjectTeamFields();
                this.dashboard.showError('Занятие не найдено в расписании на выбранную дату и пару');
                return;
            }

            this.setSubjectTeamFields(data.lesson);
            this.updateClassesTimeHint(data.lesson.classes, data.lesson.dinner, data.lesson);
        } catch (error) {
            console.error('❌ Ошибка загрузки занятия:', error);
            this.clearSubjectTeamFields();
        }
    }

    updateClassesTimeHint(classNum, dinner, lessonMeta = null) {
        const hint = document.getElementById('classesTimeHint');
        if (!hint) return;
        if (classNum == null || classNum === '') {
            hint.textContent = '';
            return;
        }
        hint.textContent = this.formatClassLabel(classNum, dinner, lessonMeta);
    }

    async loadAvailableTeachers(date, classes, subject) {
        try {
            console.log('🔍 Поиск преподавателей:', { date, classes, subject });
            const formattedDate = this.fixDateForInput(date);
            const applicant = this.getApplicantTeacher();
            let url = `/teachers/available?date=${encodeURIComponent(formattedDate)}&classes=${encodeURIComponent(classes)}&subject=${encodeURIComponent(subject)}`;
            if (applicant) {
                url += `&applicant=${encodeURIComponent(applicant)}`;
            }
            const data = await this.dashboard.apiRequest(url);
            if (data && data.success) {
                console.log('✅ Найдено преподавателей:', data.teachers.length);
                this.availableTeachers = data.teachers;
                return data.teachers;
            } else {
                console.error('❌ Ошибка при поиске преподавателей:', data?.message);
                return [];
            }
        } catch (error) {
            console.error('❌ Ошибка загрузки преподавателей:', error);
            return [];
        }
    }

    renderForm() {
        if (!this.container) return;

        const locked = this.lessonLocked && this.prefill;
        const p = this.prefill || {};
        const needsTeacher = this.dashboard.needsTeacherSelection() && !this.getApplicantTeacher();
        const adminHint = needsTeacher
            ? `<div style="margin-bottom:16px;padding:14px 16px;background:#fef3c7;border-radius:8px;color:#92400e;font-size:14px;">
                    <i class="fas fa-info-circle"></i> Сначала выберите преподавателя в списке выше — заявка будет создана от его имени.
               </div>`
            : '';
        const dateValue = p.date ? this.fixDateForInput(p.date) : '';
        const classesValue = p.classes != null ? String(p.classes) : '';
        const subjectValue = String(p.subject || '').trim();
        const teamValue = String(p.team || '').trim();
        const resolvedMeta = this.resolveWeekAndNumDen(p.week_num, p.num_den);
        const weekNumValue = resolvedMeta.week_num ?? '';
        const numDenValue = resolvedMeta.num_den || '';
        const numDenText = numDenValue ? this.numDenLabel(numDenValue) : '—';
        const weekNumText = weekNumValue !== '' ? String(weekNumValue) : '—';
        const dateDisplayText = dateValue ? this.formatDateForDisplay(dateValue) : '—';
        const typeValue = String(p.type || '').trim();
        const audienseValue = String(p.audiense || '').trim();
        const classesDisplayText = classesValue
            ? this.formatClassLabel(classesValue, p.dinner, p)
            : '—';
        const lockHint = '<div style="font-size:12px;color:#6b7280;margin-top:4px;"><i class="fas fa-lock"></i> Занятие выбрано из расписания, изменить нельзя</div>';
        const autoHint = '<div style="font-size:12px;color:#6b7280;margin-top:4px;"><i class="fas fa-magic"></i> Подставляется из расписания автоматически</div>';
        const lessonMetaFieldsHtml = `
                        <div style="display:flex;flex-direction:column;gap:8px;">
                            <label style="font-weight:600;color:#334155;font-size:14px;">
                                <i class="fas fa-chalkboard" style="margin-right:8px;color:#4f46e5;"></i>
                                Тип занятия
                            </label>
                            <div id="typeDisplay" class="form-input form-input-readonly">${this.escapeHtml(typeValue || '—')}</div>
                            ${locked ? lockHint : autoHint}
                        </div>

                        <div style="display:flex;flex-direction:column;gap:8px;">
                            <label style="font-weight:600;color:#334155;font-size:14px;">
                                <i class="fas fa-door-open" style="margin-right:8px;color:#4f46e5;"></i>
                                Аудитория
                            </label>
                            <div id="audienseDisplay" class="form-input form-input-readonly">${this.escapeHtml(audienseValue || '—')}</div>
                            ${locked ? lockHint : autoHint}
                        </div>
        `;
        const subtitle = locked
            ? 'Занятие выбрано из расписания. Найдите и выберите замещающего преподавателя.'
            : 'Выберите дату и пару — предмет, группа, неделя и числитель/знаменатель подставятся автоматически.';

        const autoFieldsHtml = `
                        <div style="display:flex;flex-direction:column;gap:8px;">
                            <label style="font-weight:600;color:#334155;font-size:14px;">
                                <i class="fas fa-book" style="margin-right:8px;color:#4f46e5;"></i>
                                Предмет *
                            </label>
                            <div id="subjectDisplay" class="form-input form-input-readonly">${this.escapeHtml(subjectValue || '—')}</div>
                            <input type="hidden" name="subject" id="subject" value="${this.escapeAttr(subjectValue)}">
                            ${autoHint}
                        </div>

                        <div style="display:flex;flex-direction:column;gap:8px;">
                            <label style="font-weight:600;color:#334155;font-size:14px;">
                                <i class="fas fa-users" style="margin-right:8px;color:#4f46e5;"></i>
                                Группа *
                            </label>
                            <div id="teamDisplay" class="form-input form-input-readonly">${this.escapeHtml(teamValue || '—')}</div>
                            <input type="hidden" name="team" id="requestTeam" value="${this.escapeAttr(teamValue)}">
                            ${autoHint}
                        </div>

                        ${lessonMetaFieldsHtml}
        `;

        const lessonFieldsHtml = locked ? `
                        <div style="display:flex;flex-direction:column;gap:8px;">
                            <label style="font-weight:600;color:#334155;font-size:14px;">
                                <i class="fas fa-calendar-alt" style="margin-right:8px;color:#4f46e5;"></i>
                                Дата *
                            </label>
                            <div id="requestDateDisplay" class="form-input form-input-readonly">${this.escapeHtml(dateDisplayText)}</div>
                            <input type="hidden" name="request_date" id="requestDate" value="${this.escapeAttr(dateValue)}">
                            ${lockHint}
                        </div>

                        <div style="display:flex;flex-direction:column;gap:8px;">
                            <label style="font-weight:600;color:#334155;font-size:14px;">
                                <i class="fas fa-clock" style="margin-right:8px;color:#4f46e5;"></i>
                                Пара (номер) *
                            </label>
                            <div id="classesDisplay" class="form-input form-input-readonly">${this.escapeHtml(classesDisplayText)}</div>
                            <input type="hidden" name="classes" id="classes" value="${this.escapeAttr(classesValue)}">
                            ${lockHint}
                        </div>

                        <div style="display:flex;flex-direction:column;gap:8px;">
                            <label style="font-weight:600;color:#334155;font-size:14px;">
                                <i class="fas fa-book" style="margin-right:8px;color:#4f46e5;"></i>
                                Предмет *
                            </label>
                            <div id="subjectDisplay" class="form-input form-input-readonly">${this.escapeHtml(subjectValue || '—')}</div>
                            <input type="hidden" name="subject" id="subject" value="${this.escapeAttr(subjectValue)}">
                            ${lockHint}
                        </div>

                        <div style="display:flex;flex-direction:column;gap:8px;">
                            <label style="font-weight:600;color:#334155;font-size:14px;">
                                <i class="fas fa-users" style="margin-right:8px;color:#4f46e5;"></i>
                                Группа *
                            </label>
                            <div id="teamDisplay" class="form-input form-input-readonly">${this.escapeHtml(teamValue || '—')}</div>
                            <input type="hidden" name="team" id="requestTeam" value="${this.escapeAttr(teamValue)}">
                            ${lockHint}
                        </div>

                        ${lessonMetaFieldsHtml}
        ` : `
                        <div style="display:flex;flex-direction:column;gap:8px;">
                            <label style="font-weight:600;color:#334155;font-size:14px;">
                                <i class="fas fa-calendar-alt" style="margin-right:8px;color:#4f46e5;"></i>
                                Дата *
                            </label>
                            <input type="date" name="request_date" required value="${this.escapeAttr(dateValue)}"
                                   style="padding:12px;border-radius:8px;border:1px solid #d1d5db;font-size:14px;"
                                   id="requestDate" class="form-input">
                            <div style="font-size:12px;color:#6b7280;margin-top:4px;">
                                <i class="fas fa-info-circle"></i> Выберите дату занятия
                            </div>
                        </div>

                        <div style="display:flex;flex-direction:column;gap:8px;">
                            <label style="font-weight:600;color:#334155;font-size:14px;">
                                <i class="fas fa-clock" style="margin-right:8px;color:#4f46e5;"></i>
                                Пара (номер) *
                            </label>
                            <select name="classes" required
                                    style="padding:12px;border-radius:8px;border:1px solid #d1d5db;font-size:14px;background:white;"
                                    id="classes" class="form-input" disabled>
                                <option value="">Сначала выберите дату</option>
                            </select>
                            <div id="classesTimeHint" style="font-size:13px;color:#475569;font-weight:600;margin-top:4px;"></div>
                            <div style="font-size:12px;color:#6b7280;margin-top:4px;">
                                <i class="fas fa-info-circle"></i> Только пары из вашего расписания
                            </div>
                        </div>

                        ${autoFieldsHtml}
        `;

        this.container.innerHTML = `
            <div class="card" style="max-width:900px;margin:0 auto;">
                ${adminHint}
                <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:20px;">
                    <div>
                        <div style="font-size:24px;font-weight:800;color:#2c3e50;margin-bottom:8px;">
                            <i class="fas fa-file-alt" style="margin-right:10px;color:#4f46e5;"></i>
                            Создание заявки на замену
                        </div>
                        <div style="color:#64748b;font-size:14px;">
                            ${subtitle}
                        </div>
                    </div>
                    <button class="nav-btn" style="border-color:#e2e8f0" onclick="dashboard.showSection('schedule')">
                        <i class="fas fa-arrow-left"></i> К расписанию
                    </button>
                </div>

                <form id="newRequestForm" style="margin-top:18px;">
                    <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(250px, 1fr));gap:16px;margin-bottom:24px;">
                        ${lessonFieldsHtml}

                        <div style="display:flex;flex-direction:column;gap:8px;">
                            <label style="font-weight:600;color:#334155;font-size:14px;">
                                <i class="fas fa-calendar-week" style="margin-right:8px;color:#4f46e5;"></i>
                                Неделя
                            </label>
                            <div id="weekNumDisplay" class="form-input form-input-readonly">${this.escapeHtml(weekNumText)}</div>
                            <input type="hidden" name="week_num" value="${this.escapeAttr(weekNumValue)}">
                            <div style="font-size:12px;color:#6b7280;margin-top:4px;">
                                <i class="fas fa-lock"></i> Нечётная неделя — числитель, чётная — знаменатель
                            </div>
                        </div>

                        <div style="display:flex;flex-direction:column;gap:8px;">
                            <label style="font-weight:600;color:#334155;font-size:14px;">
                                <i class="fas fa-exchange-alt" style="margin-right:8px;color:#4f46e5;"></i>
                                Числитель/Знаменатель
                            </label>
                            <div id="numDenDisplay" class="form-input form-input-readonly">${this.escapeHtml(numDenText)}</div>
                            <input type="hidden" name="num_den" value="${this.escapeAttr(numDenValue)}">
                            <div style="font-size:12px;color:#6b7280;margin-top:4px;">
                                <i class="fas fa-lock"></i> Нечётная неделя — числитель, чётная — знаменатель
                            </div>
                        </div>
                    </div>

                    <div style="margin:24px 0;text-align:center;">
                        <button type="button" class="search-teachers-btn" onclick="dashboard.modules['new-request'].searchTeachers()">
                            <i class="fas fa-search" style="margin-right:8px;"></i>
                            Найти доступных преподавателей
                        </button>
                    </div>

                    <div style="grid-column:1/-1;display:none;" id="teachersListContainer">
                        <div style="font-size:18px;font-weight:700;color:#334155;margin-bottom:16px;padding-bottom:12px;border-bottom:2px solid #e2e8f0;">
                            <i class="fas fa-chart-line" style="margin-right:10px;color:#4f46e5;"></i>
                            Доступные преподаватели
                            <span id="teachersCount" style="font-size:14px;color:#64748b;margin-left:8px;"></span>
                        </div>
                        <div id="teachersList" style="display:grid;gap:12px;margin-bottom:24px;"></div>
                    </div>

                    <div style="display:none;margin:24px 0;padding:20px;background:#f0f9ff;border-radius:12px;border:2px solid #dbeafe;" id="selectedTeacherContainer">
                        <div style="display:flex;align-items:center;gap:16px;">
                            <i class="fas fa-check-circle" style="font-size:32px;color:#16a34a;"></i>
                            <div style="flex-grow:1;">
                                <div style="font-weight:700;color:#1e40af;font-size:18px;">
                                    Выбран преподаватель: <span id="selectedTeacherName"></span>
                                </div>
                                <div style="color:#4a5568;font-size:14px;margin-top:4px;">
                                    Теперь вы можете отправить заявку на замену
                                </div>
                            </div>
                            <button type="button" class="nav-btn" onclick="dashboard.modules['new-request'].clearSelection()">
                                <i class="fas fa-times"></i> Изменить выбор
                            </button>
                        </div>
                    </div>

                    <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:24px;padding-top:20px;border-top:1px solid #e2e8f0;">
                        <button type="button" class="submit-btn" style="display:none;" id="submitBtn" onclick="dashboard.modules['new-request'].submitRequest()">
                            <i class="fas fa-paper-plane" style="margin-right:8px;"></i>
                            Отправить заявку
                        </button>
                        <button type="button" class="clear-btn" onclick="dashboard.modules['new-request'].clearForm()">
                            <i class="fas fa-eraser" style="margin-right:8px;"></i>
                            Очистить форму
                        </button>
                        <div id="newRequestHint" style="color:#64748b;font-size:14px;margin-left:auto;"></div>
                    </div>
                </form>
            </div>

            <style>
                .form-input {
                    transition: all 0.2s ease;
                }
                .form-input:focus {
                    outline: none;
                    border-color: #4f46e5;
                    box-shadow: 0 0 0 3px rgba(79, 70, 229, 0.1);
                }
                .form-input-readonly {
                    padding: 12px;
                    border-radius: 8px;
                    border: 1px solid #e2e8f0;
                    font-size: 14px;
                    background: #f8fafc;
                    color: #334155;
                    font-weight: 600;
                }
                .search-teachers-btn {
                    background: linear-gradient(135deg, #4f46e5, #7c3aed);
                    color: white;
                    border: none;
                    padding: 14px 28px;
                    border-radius: 10px;
                    font-weight: 600;
                    font-size: 16px;
                    cursor: pointer;
                    transition: all 0.3s ease;
                    box-shadow: 0 4px 6px rgba(79, 70, 229, 0.2);
                }
                .search-teachers-btn:hover {
                    transform: translateY(-2px);
                    box-shadow: 0 6px 12px rgba(79, 70, 229, 0.3);
                }
                .search-teachers-btn:active {
                    transform: translateY(0);
                }
                .search-teachers-btn:disabled {
                    background: #94a3b8;
                    cursor: not-allowed;
                    transform: none;
                }
                .submit-btn {
                    background: linear-gradient(135deg, #059669, #10b981);
                    color: white;
                    border: none;
                    padding: 14px 28px;
                    border-radius: 10px;
                    font-weight: 600;
                    font-size: 16px;
                    cursor: pointer;
                    transition: all 0.3s ease;
                    box-shadow: 0 4px 6px rgba(5, 150, 105, 0.2);
                }
                .submit-btn:hover {
                    transform: translateY(-2px);
                    box-shadow: 0 6px 12px rgba(5, 150, 105, 0.3);
                }
                .clear-btn {
                    background: #f1f5f9;
                    color: #64748b;
                    border: 1px solid #cbd5e1;
                    padding: 14px 28px;
                    border-radius: 10px;
                    font-weight: 600;
                    font-size: 16px;
                    cursor: pointer;
                    transition: all 0.2s ease;
                }
                .clear-btn:hover {
                    background: #e2e8f0;
                }
                .teacher-card {
                    padding: 16px;
                    border-radius: 10px;
                    border-left: 4px solid;
                    background: white;
                    box-shadow: 0 2px 4px rgba(0,0,0,0.05);
                    transition: all 0.2s ease;
                }
                .teacher-card:hover {
                    transform: translateY(-2px);
                    box-shadow: 0 4px 8px rgba(0,0,0,0.1);
                }
                .coefficient-badge {
                    padding: 4px 10px;
                    border-radius: 20px;
                    font-size: 12px;
                    font-weight: 600;
                    margin-right: 8px;
                }
                .available-badge {
                    padding: 4px 10px;
                    border-radius: 20px;
                    font-size: 12px;
                    font-weight: 600;
                }
            </style>
        `;

        const hint = document.getElementById('newRequestHint');
        if (hint && locked) {
            hint.innerHTML = `<i class="fas fa-lock" style="margin-right:6px;"></i> Параметры занятия зафиксированы`;
        }

        if (!locked) {
            const inputs = this.container.querySelectorAll('.form-input');
            inputs.forEach((input) => {
                input.addEventListener('change', () => this.resetTeacherSearch());
                input.addEventListener('input', () => this.resetTeacherSearch());
            });

            const dateInput = document.getElementById('requestDate');
            const classesSelect = document.getElementById('classes');

            if (dateInput) {
                dateInput.addEventListener('change', async () => {
                    await this.loadClasses();
                });
            }
            if (classesSelect) {
                classesSelect.addEventListener('change', async () => {
                    const option = classesSelect.selectedOptions[0];
                    if (option?.value) {
                        this.updateClassesTimeHint(option.value, option.dataset.dinner || null);
                    } else {
                        this.updateClassesTimeHint(null, null);
                    }
                    await this.loadLessonBySlot();
                });
            }
        }
    }

    resetTeacherSearch() {
        const container = document.getElementById('teachersListContainer');
        if (container) container.style.display = 'none';
        const selectedContainer = document.getElementById('selectedTeacherContainer');
        if (selectedContainer) selectedContainer.style.display = 'none';
        const submitBtn = document.getElementById('submitBtn');
        if (submitBtn) submitBtn.style.display = 'none';
        this.selectedTeacher = null;
    }

    async searchTeachers() {
        if (this.dashboard.needsTeacherSelection() && !this.getApplicantTeacher()) {
            this.dashboard.showError('Сначала выберите преподавателя в списке выше');
            return;
        }

        const dateInput = document.getElementById('requestDate');
        const classesInput = document.getElementById('classes');
        const subjectSelect = document.getElementById('subject');

        const date = dateInput.value;
        const classes = classesInput.value;
        const subject = subjectSelect.value;

        const team = document.getElementById('requestTeam')?.value;

        if (!date || !classes) {
            this.dashboard.showError('Выберите дату и пару из расписания');
            return;
        }
        if (!subject || !team) {
            this.dashboard.showError('Дождитесь автоматической подстановки предмета и группы');
            return;
        }

        const selectedDate = new Date(date);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        
        if (selectedDate < today) {
            if (!confirm('Выбранная дата уже прошла. Вы уверены, что хотите создать заявку на прошедшую дату?')) {
                return;
            }
        }

        const container = document.getElementById('teachersListContainer');
        const list = document.getElementById('teachersList');
        const countSpan = document.getElementById('teachersCount');
        
        container.style.display = 'block';
        list.innerHTML = `
            <div style="text-align:center;padding:40px;">
                <i class="fas fa-spinner fa-spin" style="font-size:32px;color:#4f46e5;margin-bottom:16px;"></i>
                <div style="color:#64748b;font-size:16px;">
                    Ищем доступных преподавателей...
                </div>
            </div>
        `;

        const fixedDate = this.fixDateForInput(date);
        const teachers = await this.loadAvailableTeachers(fixedDate, classes, subject);
        this.availableTeachers = teachers;

        if (teachers.length === 0) {
            list.innerHTML = `
                <div class="teacher-card" style="border-left-color:#ef4444;text-align:center;padding:40px;">
                    <i class="fas fa-user-slash" style="font-size:48px;color:#ef4444;margin-bottom:16px;"></i>
                    <div style="font-weight:700;color:#374151;font-size:18px;margin-bottom:8px;">
                        Нет доступных преподавателей
                    </div>
                    <div style="color:#6b7280;font-size:14px;">
                        На ${this.formatDateForDisplay(date)} (${classes} пара) по предмету "${subject}"<br>
                        не найдено свободных преподавателей
                    </div>
                    <div style="margin-top:16px;">
                        <button class="nav-btn" onclick="dashboard.modules['new-request'].clearForm()">
                            <i class="fas fa-edit" style="margin-right:6px;"></i>
                            Изменить параметры поиска
                        </button>
                    </div>
                </div>
            `;
            if (countSpan) countSpan.textContent = '(0 найдено)';
            return;
        }

        teachers.sort((a, b) => b.coefficient - a.coefficient);

        if (countSpan) countSpan.textContent = `(${teachers.length} найдено, отсортированы по коэффициенту)`;

        list.innerHTML = teachers.map((teacher, index) => {
            const isTop3 = index < 3;
            const borderColor = isTop3 ? 
                ['#f59e0b', '#10b981', '#3b82f6'][index] : '#d1d5db';
            
            const availabilityColor = teacher.is_available ? '#10b981' : '#f59e0b';
            const availabilityText = teacher.is_available ? 'Свободен' : 'Занят в это время';
            
            return `
                <div class="teacher-card" style="border-left-color:${borderColor};${isTop3 ? 'background:#f8fafc;' : ''}">
                    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap;">
                        <div style="flex-grow:1;">
                            <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;">
                                <div style="font-size:18px;font-weight:700;color:#1f2937;">
                                    ${teacher.name}
                                    ${isTop3 ? `<span style="background:${borderColor};color:white;padding:2px 8px;border-radius:12px;font-size:12px;margin-left:8px;">Топ-${index + 1}</span>` : ''}
                                </div>
                            </div>
                            
                            <div style="display:flex;flex-wrap:wrap;gap:12px;margin-bottom:16px;">
                                <div style="display:flex;align-items:center;gap:6px;color:#4b5563;">
                                    <i class="fas fa-envelope" style="font-size:14px;"></i>
                                    <span style="font-size:14px;">${teacher.email}</span>
                                </div>
                                <div style="display:flex;align-items:center;gap:6px;color:#4b5563;">
                                    <i class="fas fa-phone" style="font-size:14px;"></i>
                                    <span style="font-size:14px;">${teacher.phone}</span>
                                </div>
                            </div>
                            
                            <div style="display:flex;gap:8px;flex-wrap:wrap;">
                                <div class="coefficient-badge" style="background:${this.getCoefficientBackground(teacher.coefficient)};color:${this.getCoefficientColor(teacher.coefficient)};">
                                    <i class="fas fa-chart-line" style="margin-right:4px;"></i>
                                    Коэффициент: ${teacher.coefficient.toFixed(3)}
                                </div>
                                <div class="available-badge" style="background:${teacher.is_available ? '#d1fae5' : '#fef3c7'};color:${teacher.is_available ? '#065f46' : '#92400e'};">
                                    <i class="fas ${teacher.is_available ? 'fa-check-circle' : 'fa-exclamation-triangle'}" style="margin-right:4px;"></i>
                                    ${availabilityText}
                                </div>
                            </div>
                        </div>
                        
                        <button type="button" class="select-teacher-btn" 
                                onclick="dashboard.modules['new-request'].selectTeacher('${this.escapeAttr(teacher.name)}')"
                                ${!teacher.is_available ? 'disabled' : ''}
                                style="background:${teacher.is_available ? '#4f46e5' : '#9ca3af'};color:white;border:none;padding:10px 20px;border-radius:8px;font-weight:600;cursor:${teacher.is_available ? 'pointer' : 'not-allowed'};transition:all 0.2s ease;">
                            <i class="fas ${teacher.is_available ? 'fa-check' : 'fa-ban'}" style="margin-right:8px;"></i>
                            ${teacher.is_available ? 'Выбрать' : 'Недоступен'}
                        </button>
                    </div>
                </div>
            `;
        }).join('');
    }

    getCoefficientBackground(coefficient) {
        if (coefficient > 0.7) return '#d1fae5';
        if (coefficient > 0.4) return '#fef3c7';
        return '#fee2e2';
    }

    getCoefficientColor(coefficient) {
        if (coefficient > 0.7) return '#065f46';
        if (coefficient > 0.4) return '#92400e';
        return '#991b1b';
    }

    formatDateForDisplay(dateString) {
        try {
            const date = new Date(dateString);
            return date.toLocaleDateString('ru-RU', {
                day: '2-digit',
                month: '2-digit',
                year: 'numeric'
            });
        } catch (error) {
            return dateString;
        }
    }

    selectTeacher(teacherName) {
        this.selectedTeacher = teacherName;
        
        const container = document.getElementById('teachersListContainer');
        const selectedContainer = document.getElementById('selectedTeacherContainer');
        const selectedName = document.getElementById('selectedTeacherName');
        const submitBtn = document.getElementById('submitBtn');
        
        if (selectedContainer && selectedName) {
            selectedName.textContent = teacherName;
            selectedContainer.style.display = 'block';
            submitBtn.style.display = 'flex';
            selectedContainer.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        
        this.dashboard.showSuccess(`Выбран преподаватель: ${teacherName}`);
    }

    clearSelection() {
        this.selectedTeacher = null;
        const selectedContainer = document.getElementById('selectedTeacherContainer');
        const submitBtn = document.getElementById('submitBtn');
        
        if (selectedContainer) selectedContainer.style.display = 'none';
        if (submitBtn) submitBtn.style.display = 'none';
    }

    async submitRequest() {
        if (this.dashboard.needsTeacherSelection() && !this.getApplicantTeacher()) {
            this.dashboard.showError('Сначала выберите преподавателя в списке выше');
            return;
        }

        if (!this.selectedTeacher) {
            this.dashboard.showError('Выберите преподавателя для замены');
            return;
        }

        const form = document.getElementById('newRequestForm');
        const fd = new FormData(form);

        let requestDate = fd.get('request_date');
        requestDate = this.fixDateForInput(requestDate);

        const payload = {
            request_date: requestDate,
            classes: Number(fd.get('classes')),
            subject: String(fd.get('subject') || '').trim(),
            team: String(fd.get('team') || '').trim(),
            replacing_teacher: this.selectedTeacher
        };

        const weekNum = fd.get('week_num');
        const numDen = fd.get('num_den');

        if (weekNum) payload.week_num = Number(weekNum);
        if (numDen) payload.num_den = String(numDen);

        if (this.dashboard.isAdmin) {
            payload.teacher_name = this.getApplicantTeacher();
        }

        const submitBtn = document.getElementById('submitBtn');
        if (submitBtn) {
            submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Отправка...';
            submitBtn.disabled = true;
        }

        const data = await this.dashboard.apiRequest('/requests', {
            method: 'POST',
            body: JSON.stringify(payload)
        });

        if (submitBtn) {
            submitBtn.innerHTML = '<i class="fas fa-paper-plane" style="margin-right:8px;"></i> Отправить заявку';
            submitBtn.disabled = false;
        }

        if (data && data.success) {
            this.dashboard.showSuccess('Заявка успешно отправлена!');
            this.clearForm();
            setTimeout(() => {
                this.dashboard.showSection('requests');
            }, 1500);
        } else {
            this.dashboard.showError(data?.message || 'Не удалось создать заявку');
        }
    }

    clearForm() {
        this.prefill = null;
        this.lessonLocked = false;
        this.selectedTeacher = null;
        this.availableTeachers = [];

        const container = document.getElementById('teachersListContainer');
        const selectedContainer = document.getElementById('selectedTeacherContainer');
        const submitBtn = document.getElementById('submitBtn');

        if (container) container.style.display = 'none';
        if (selectedContainer) selectedContainer.style.display = 'none';
        if (submitBtn) submitBtn.style.display = 'none';

        this.renderForm();
        this.dashboard.showSuccess('Форма очищена');
    }

    escapeHtml(value) {
        return String(value ?? '')
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;');
    }

    escapeAttr(value) {
        return String(value ?? '')
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;')
            .replaceAll("'", '&#39;');
    }
}

window.NewRequestModule = NewRequestModule;
