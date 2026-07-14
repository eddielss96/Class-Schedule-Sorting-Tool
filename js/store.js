'use strict';

/**
 * Store：資料模型與持久化（localStorage + JSON 匯出入）
 *
 * 資料結構：
 *  settings   : { numDays, numPeriods, periodLabels[] }
 *  subjects[] : { id, name, color }
 *  teachers[] : { id, name, unavailable[]("day-period") }   不排課時段
 *  rooms[]    : { id, name }                                 專科教室
 *  classes[]  : { id, name, blocked[]("day-period") }        不上課時段
 *  courses[]  : { id, classId, subjectId, teacherId, roomId,
 *                 periods(每週節數), doubles(連堂數), allowed[]("day-period", 空=不限) }
 *  placements[]: { id, courseId, day, period, len(1|2), locked }
 */
const Store = (() => {
  const KEY = 'class-schedule-tool-v1';
  const DAY_NAMES = ['一', '二', '三', '四', '五', '六', '日'];

  const PALETTE = [
    '#4E79A7', '#F28E2B', '#59A14F', '#E15759', '#B07AA1',
    '#76B7B2', '#EDC948', '#FF9DA7', '#9C755F', '#86BCB6',
    '#D37295', '#8CD17D', '#F1CE63', '#A0CBE8', '#FABFD2',
    '#B6992D', '#499894', '#E58606', '#5D69B1', '#52BCA3'
  ];

  let state = defaultState();

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function defaultState() {
    return {
      version: 1,
      settings: {
        numDays: 5,
        numPeriods: 8,
        periodLabels: makePeriodLabels(8)
      },
      subjects: [],
      teachers: [],
      rooms: [],
      classes: [],
      courses: [],
      placements: []
    };
  }

  function makePeriodLabels(n) {
    return Array.from({ length: n }, (_, i) => '第 ' + (i + 1) + ' 節');
  }

  function slotKey(day, period) { return day + '-' + period; }

  function parseSlot(key) {
    const [d, p] = key.split('-').map(Number);
    return { day: d, period: p };
  }

  /** 修正資料，移除超出範圍或參照失效的內容 */
  function normalize(s) {
    const st = s.settings;
    st.numDays = Math.min(7, Math.max(1, st.numDays | 0 || 5));
    st.numPeriods = Math.min(14, Math.max(1, st.numPeriods | 0 || 8));
    if (!Array.isArray(st.periodLabels)) st.periodLabels = [];
    while (st.periodLabels.length < st.numPeriods) {
      st.periodLabels.push('第 ' + (st.periodLabels.length + 1) + ' 節');
    }
    st.periodLabels = st.periodLabels.slice(0, st.numPeriods);

    const inRange = key => {
      const { day, period } = parseSlot(key);
      return day >= 0 && day < st.numDays && period >= 0 && period < st.numPeriods;
    };
    s.teachers.forEach(t => { t.unavailable = (t.unavailable || []).filter(inRange); });
    s.classes.forEach(c => { c.blocked = (c.blocked || []).filter(inRange); });

    const subjectIds = new Set(s.subjects.map(x => x.id));
    const teacherIds = new Set(s.teachers.map(x => x.id));
    const roomIds = new Set(s.rooms.map(x => x.id));
    const classIds = new Set(s.classes.map(x => x.id));

    s.courses = s.courses.filter(c =>
      classIds.has(c.classId) && subjectIds.has(c.subjectId) &&
      (!c.teacherId || teacherIds.has(c.teacherId))
    );
    s.courses.forEach(c => {
      if (c.roomId && !roomIds.has(c.roomId)) c.roomId = '';
      c.periods = Math.max(1, c.periods | 0 || 1);
      c.doubles = Math.max(0, Math.min(Math.floor(c.periods / 2), c.doubles | 0 || 0));
      c.allowed = (c.allowed || []).filter(inRange);
    });

    const courseIds = new Set(s.courses.map(x => x.id));
    const classBlocked = {};
    s.classes.forEach(c => { classBlocked[c.id] = new Set(c.blocked); });
    const courseById = {};
    s.courses.forEach(c => { courseById[c.id] = c; });

    s.placements = s.placements.filter(p => {
      if (!courseIds.has(p.courseId)) return false;
      p.len = p.len === 2 ? 2 : 1;
      if (p.day < 0 || p.day >= st.numDays) return false;
      if (p.period < 0 || p.period + p.len > st.numPeriods) return false;
      const blocked = classBlocked[courseById[p.courseId].classId];
      for (let i = 0; i < p.len; i++) {
        if (blocked.has(slotKey(p.day, p.period + i))) return false;
      }
      return true;
    });
    return s;
  }

  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
      return true;
    } catch (e) {
      console.error('儲存失敗', e);
      return false;
    }
  }

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) state = normalize(Object.assign(defaultState(), JSON.parse(raw)));
    } catch (e) {
      console.error('讀取失敗，使用空白資料', e);
      state = defaultState();
    }
    return state;
  }

  function replace(newState) {
    state = normalize(Object.assign(defaultState(), newState));
    save();
    return state;
  }

  function reset() {
    state = defaultState();
    save();
    return state;
  }

  function nextColor() {
    return PALETTE[state.subjects.length % PALETTE.length];
  }

  function exportJSON() {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    const name = `課表資料-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.json`;
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  }

  /** 範例資料：國小 6 個班（一～三年級各 2 班） */
  function sampleData() {
    const s = defaultState();
    s.settings.numDays = 5;
    s.settings.numPeriods = 7;
    s.settings.periodLabels = ['第 1 節', '第 2 節', '第 3 節', '第 4 節', '第 5 節', '第 6 節', '第 7 節'];

    const subj = (name, i) => ({ id: 'sub' + i, name, color: PALETTE[i % PALETTE.length] });
    const subjectNames = ['國語', '數學', '英語', '自然', '社會', '體育', '音樂', '美勞', '電腦'];
    s.subjects = subjectNames.map(subj);
    const S = {};
    s.subjects.forEach(x => { S[x.name] = x.id; });

    s.rooms = [
      { id: 'room1', name: '音樂教室' },
      { id: 'room2', name: '電腦教室' }
    ];

    const classNames = ['一年甲班', '一年乙班', '二年甲班', '二年乙班', '三年甲班', '三年乙班'];
    // 低年級（一年級）週三、週五下午不上課
    const lowGradeBlocked = [];
    [2, 4].forEach(d => { [4, 5, 6].forEach(p => lowGradeBlocked.push(slotKey(d, p))); });
    s.classes = classNames.map((name, i) => ({
      id: 'cls' + i,
      name,
      blocked: i < 2 ? lowGradeBlocked.slice() : []
    }));

    const homeroomNames = ['陳老師', '林老師', '黃老師', '張老師', '李老師', '王老師'];
    s.teachers = homeroomNames.map((name, i) => ({ id: 'tch' + i, name, unavailable: [] }));
    s.teachers.push({ id: 'tchEng', name: '英語科任（吳老師）', unavailable: [0, 1, 2, 3, 4, 5, 6].map(p => slotKey(2, p)) });
    s.teachers.push({ id: 'tchSci', name: '自然科任（劉老師）', unavailable: [] });
    s.teachers.push({ id: 'tchPE', name: '體育科任（蔡老師）', unavailable: [] });
    s.teachers.push({ id: 'tchMus', name: '音樂科任（許老師）', unavailable: [] });
    s.teachers.push({ id: 'tchCom', name: '電腦科任（鄭老師）', unavailable: [] });

    let n = 0;
    const course = (classId, subjectId, teacherId, periods, doubles, roomId, allowed) => ({
      id: 'crs' + (n++), classId, subjectId, teacherId,
      roomId: roomId || '', periods, doubles: doubles || 0, allowed: allowed || []
    });

    // 體育不排第 1 節
    const peAllowed = [];
    for (let d = 0; d < 5; d++) for (let p = 1; p < 7; p++) peAllowed.push(slotKey(d, p));

    s.classes.forEach((cls, i) => {
      const homeroom = 'tch' + i;
      s.courses.push(
        course(cls.id, S['國語'], homeroom, 5, 0),
        course(cls.id, S['數學'], homeroom, 4, 0),
        course(cls.id, S['社會'], homeroom, 2, 0),
        course(cls.id, S['美勞'], homeroom, 2, 1),
        course(cls.id, S['英語'], 'tchEng', 2, 0),
        course(cls.id, S['自然'], 'tchSci', 2, 1),
        course(cls.id, S['體育'], 'tchPE', 2, 0, '', peAllowed),
        course(cls.id, S['音樂'], 'tchMus', 1, 0, 'room1'),
        course(cls.id, S['電腦'], 'tchCom', 1, 0, 'room2')
      );
    });
    return s;
  }

  return {
    get state() { return state; },
    DAY_NAMES, PALETTE,
    uid, slotKey, parseSlot,
    load, save, replace, reset, normalize,
    nextColor, exportJSON, sampleData, makePeriodLabels
  };
})();
