'use strict';

/** UI：畫面渲染與互動（分頁、表單、課表拖拉編輯） */
const UI = (() => {
  let currentTab = 'settings';
  let scheduleView = { mode: 'class', id: null }; // mode: class | teacher | overview
  let dragPayload = null;

  const $ = sel => document.querySelector(sel);
  const el = (tag, attrs, children) => {
    const node = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(k => {
      if (k === 'class') node.className = attrs[k];
      else if (k === 'text') node.textContent = attrs[k];
      else if (k === 'html') node.innerHTML = attrs[k];
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), attrs[k]);
      else if (k === 'dataset') Object.assign(node.dataset, attrs[k]);
      else node.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(c => { if (c) node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return node;
  };

  const dayLabel = d => Store.DAY_NAMES[d] || String(d + 1);
  const periodLabel = p => Store.state.settings.periodLabels[p] || ('第 ' + (p + 1) + ' 節');
  const findById = (arr, id) => arr.find(x => x.id === id) || null;
  const nameOf = (arr, id, fallback) => (findById(arr, id) || {}).name || fallback || '';

  let toastTimer = null;
  function toast(msg, isError) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast show' + (isError ? ' error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = 'toast'; }, 3200);
  }

  /** 資料異動後統一入口：儲存 + 重繪 */
  function commit(rerenderTab) {
    Store.save();
    flashSaved();
    if (rerenderTab !== false) render();
  }

  function flashSaved() {
    const ind = $('#save-indicator');
    ind.classList.add('flash');
    setTimeout(() => ind.classList.remove('flash'), 600);
  }

  // ---------- 共用元件 ----------

  /** 時段勾選格（教師不排課、班級不上課、科目限制） */
  function slotGrid(selectedSet, onChange, opts) {
    const st = Store.state.settings;
    const o = opts || {};
    const table = el('table', { class: 'slot-grid' + (o.small ? ' small' : '') });
    const head = el('tr', null, [el('th', { text: '' })]);
    for (let d = 0; d < st.numDays; d++) head.appendChild(el('th', { text: '週' + dayLabel(d) }));
    table.appendChild(head);
    for (let p = 0; p < st.numPeriods; p++) {
      const tr = el('tr', null, [el('th', { text: periodLabel(p) })]);
      for (let d = 0; d < st.numDays; d++) {
        const key = Store.slotKey(d, p);
        const on = selectedSet.has(key);
        const td = el('td', {
          class: on ? 'sel' : '',
          text: on ? (o.markText || '✓') : '',
          onclick: () => {
            if (selectedSet.has(key)) selectedSet.delete(key); else selectedSet.add(key);
            onChange(selectedSet);
            td.classList.toggle('sel');
            td.textContent = selectedSet.has(key) ? (o.markText || '✓') : '';
          }
        });
        tr.appendChild(td);
      }
      table.appendChild(tr);
    }
    return table;
  }

  function collapsible(titleText, contentEl, startOpen) {
    const body = el('div', { class: 'collapsible-body' + (startOpen ? '' : ' hidden') }, [contentEl]);
    const btn = el('button', {
      class: 'link-btn', text: (startOpen ? '▾ ' : '▸ ') + titleText,
      onclick: () => {
        body.classList.toggle('hidden');
        btn.textContent = (body.classList.contains('hidden') ? '▸ ' : '▾ ') + titleText;
      }
    });
    return el('div', { class: 'collapsible' }, [btn, body]);
  }

  function confirmDanger(msg) { return window.confirm(msg); }

  // ---------- 分頁：基本設定 ----------

  function renderSettings(root) {
    const s = Store.state;
    const st = s.settings;

    const daysSelect = el('select', {
      onchange: e => {
        st.numDays = Number(e.target.value);
        Store.normalize(s);
        commit();
      }
    }, [5, 6, 7].map(n => {
      const opt = el('option', { value: n, text: '週一 ～ 週' + Store.DAY_NAMES[n - 1] + '（' + n + ' 天）' });
      if (st.numDays === n) opt.selected = true;
      return opt;
    }));

    const periodsInput = el('input', {
      type: 'number', min: 1, max: 14, value: st.numPeriods,
      onchange: e => {
        const v = Math.min(14, Math.max(1, Number(e.target.value) || 8));
        st.numPeriods = v;
        Store.normalize(s);
        commit();
      }
    });

    const labelRows = [];
    for (let p = 0; p < st.numPeriods; p++) {
      labelRows.push(el('div', { class: 'inline-field' }, [
        el('label', { text: (p + 1) + '.' }),
        el('input', {
          type: 'text', value: st.periodLabels[p],
          onchange: e => { st.periodLabels[p] = e.target.value || ('第 ' + (p + 1) + ' 節'); commit(false); }
        })
      ]));
    }

    const importInput = el('input', {
      type: 'file', accept: '.json,application/json', style: 'display:none',
      onchange: e => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          try {
            Store.replace(JSON.parse(reader.result));
            toast('匯入成功');
            render();
          } catch (err) {
            toast('匯入失敗：檔案格式錯誤', true);
          }
        };
        reader.readAsText(file);
      }
    });

    root.appendChild(el('div', { class: 'cards' }, [
      el('section', { class: 'card' }, [
        el('h2', { text: '時段結構' }),
        el('p', { class: 'hint', text: '設定每週上課天數與每天節數。個別班級不上課的時段（如低年級下午）請至「班級」分頁設定。' }),
        el('div', { class: 'field' }, [el('label', { text: '每週上課天數' }), daysSelect]),
        el('div', { class: 'field' }, [el('label', { text: '每天節數' }), periodsInput]),
        collapsible('節次名稱（可自訂，如「早自習」「午休後第一節」）', el('div', { class: 'label-list' }, labelRows), false)
      ]),
      el('section', { class: 'card' }, [
        el('h2', { text: '課表標題（匯出用）' }),
        el('p', { class: 'hint', text: '匯出 Word / PDF 課表時的標題資訊，組成如「永平高中111學年度第二學期課程表」。' }),
        el('div', { class: 'field' }, [el('label', { text: '學校名稱' }), el('input', {
          type: 'text', value: st.school, placeholder: '例：永平高中', class: 'grow',
          onchange: e => { st.school = e.target.value.trim(); commit(false); }
        })]),
        el('div', { class: 'field' }, [el('label', { text: '學年度' }), el('input', {
          type: 'text', value: st.schoolYear, placeholder: '例：114',
          onchange: e => { st.schoolYear = e.target.value.trim(); commit(false); }
        })]),
        el('div', { class: 'field' }, [el('label', { text: '學期' }), el('input', {
          type: 'text', value: st.term, placeholder: '例：第一學期',
          onchange: e => { st.term = e.target.value.trim(); commit(false); }
        })]),
        el('div', { class: 'field' }, [el('label', { text: '備註文字' }), el('input', {
          type: 'text', value: st.note, placeholder: '例：※ 本課表自 114.09.01 起實施。（印在課表下方，可留空）', class: 'grow',
          onchange: e => { st.note = e.target.value.trim(); commit(false); }
        })])
      ]),
      el('section', { class: 'card' }, [
        el('h2', { text: '資料管理' }),
        el('p', { class: 'hint', text: '所有資料自動儲存在這個瀏覽器中。換電腦或備份請用匯出 / 匯入。' }),
        el('div', { class: 'btn-row' }, [
          el('button', { class: 'btn', text: '⬇️ 匯出 JSON 備份', onclick: () => Store.exportJSON() }),
          el('button', { class: 'btn', text: '⬆️ 匯入 JSON', onclick: () => importInput.click() }),
          el('button', {
            class: 'btn', text: '🧪 載入範例資料',
            onclick: () => {
              if (!confirmDanger('載入範例會覆蓋目前所有資料，確定嗎？（建議先匯出備份）')) return;
              Store.replace(Store.sampleData());
              toast('已載入範例資料（國小 6 班）');
              render();
            }
          }),
          el('button', {
            class: 'btn danger', text: '🗑️ 清除全部資料',
            onclick: () => {
              if (!confirmDanger('確定要清除全部資料嗎？此動作無法復原。（建議先匯出備份）')) return;
              Store.reset();
              toast('已清除全部資料');
              render();
            }
          }),
          importInput
        ])
      ]),
      el('section', { class: 'card' }, [
        el('h2', { text: '使用流程' }),
        el('ol', { class: 'steps' }, [
          el('li', { text: '基本設定：每週天數、每天節數' }),
          el('li', { text: '建立科目、教師（含不排課時段）、專科教室、班級（含不上課時段）' }),
          el('li', { text: '授課設定：指定每班每科的任課教師、每週節數、連堂、教室與時段限制' }),
          el('li', { text: '課表編排：一鍵自動排課，再以拖拉微調；衝突會即時標示' })
        ])
      ])
    ]));
  }

  // ---------- 分頁：科目 ----------

  function renderSubjects(root) {
    const s = Store.state;
    const list = el('div', { class: 'entity-list' });

    s.subjects.forEach(sub => {
      list.appendChild(el('div', { class: 'entity-row' }, [
        el('input', {
          type: 'color', value: sub.color, title: '課表顯示顏色',
          onchange: e => { sub.color = e.target.value; commit(false); }
        }),
        el('input', {
          type: 'text', value: sub.name, class: 'grow',
          onchange: e => { sub.name = e.target.value.trim() || sub.name; commit(); }
        }),
        el('button', {
          class: 'icon-btn danger', text: '刪除', title: '刪除科目',
          onclick: () => {
            const used = s.courses.filter(c => c.subjectId === sub.id).length;
            if (!confirmDanger('刪除科目「' + sub.name + '」？' + (used ? '（將一併刪除 ' + used + ' 筆授課設定及其課表）' : ''))) return;
            s.subjects = s.subjects.filter(x => x.id !== sub.id);
            Store.normalize(s);
            commit();
          }
        })
      ]));
    });

    const nameInput = el('input', { type: 'text', placeholder: '科目名稱（如：國語、數學、體育）', class: 'grow' });
    const add = () => {
      const name = nameInput.value.trim();
      if (!name) return toast('請輸入科目名稱', true);
      s.subjects.push({ id: Store.uid(), name, color: Store.nextColor() });
      nameInput.value = '';
      commit();
    };
    nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') add(); });

    root.appendChild(el('section', { class: 'card' }, [
      el('h2', { text: '科目（' + s.subjects.length + '）' }),
      el('p', { class: 'hint', text: '科目顏色會顯示在課表方塊上，方便辨識。' }),
      list,
      el('div', { class: 'entity-add' }, [nameInput, el('button', { class: 'btn primary', text: '＋ 新增科目', onclick: add })])
    ]));
  }

  // ---------- 分頁：教師 ----------

  function renderTeachers(root) {
    const s = Store.state;
    const list = el('div', { class: 'entity-list' });

    s.teachers.forEach(t => {
      const set = new Set(t.unavailable || []);
      const grid = slotGrid(set, updated => { t.unavailable = [...updated]; commit(false); }, { small: true, markText: '✕' });
      list.appendChild(el('div', { class: 'entity-block' }, [
        el('div', { class: 'entity-row' }, [
          el('input', {
            type: 'text', value: t.name, class: 'grow',
            onchange: e => { t.name = e.target.value.trim() || t.name; commit(); }
          }),
          el('span', { class: 'badge', text: '不排課 ' + set.size + ' 節' }),
          el('button', {
            class: 'icon-btn danger', text: '刪除',
            onclick: () => {
              const used = s.courses.filter(c => c.teacherId === t.id).length;
              if (!confirmDanger('刪除教師「' + t.name + '」？' + (used ? '（將一併刪除 ' + used + ' 筆授課設定及其課表）' : ''))) return;
              s.teachers = s.teachers.filter(x => x.id !== t.id);
              Store.normalize(s);
              commit();
            }
          })
        ]),
        collapsible('不排課時段（點格子標記 ✕，例如兼行政、進修、特定日不到校）', grid, false)
      ]));
    });

    const nameInput = el('input', { type: 'text', placeholder: '教師姓名', class: 'grow' });
    const add = () => {
      const name = nameInput.value.trim();
      if (!name) return toast('請輸入教師姓名', true);
      s.teachers.push({ id: Store.uid(), name, unavailable: [] });
      nameInput.value = '';
      commit();
    };
    nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') add(); });

    root.appendChild(el('section', { class: 'card' }, [
      el('h2', { text: '教師（' + s.teachers.length + '）' }),
      el('p', { class: 'hint', text: '排課時會確保同一位教師同一時段不會有兩堂課，並避開其不排課時段。' }),
      list,
      el('div', { class: 'entity-add' }, [nameInput, el('button', { class: 'btn primary', text: '＋ 新增教師', onclick: add })])
    ]));
  }

  // ---------- 分頁：專科教室 ----------

  function renderRooms(root) {
    const s = Store.state;
    const list = el('div', { class: 'entity-list' });

    s.rooms.forEach(r => {
      list.appendChild(el('div', { class: 'entity-row' }, [
        el('input', {
          type: 'text', value: r.name, class: 'grow',
          onchange: e => { r.name = e.target.value.trim() || r.name; commit(); }
        }),
        el('button', {
          class: 'icon-btn danger', text: '刪除',
          onclick: () => {
            if (!confirmDanger('刪除教室「' + r.name + '」？（使用中的授課設定會改為不指定教室）')) return;
            s.rooms = s.rooms.filter(x => x.id !== r.id);
            Store.normalize(s);
            commit();
          }
        })
      ]));
    });

    const nameInput = el('input', { type: 'text', placeholder: '教室名稱（如：音樂教室、電腦教室、實驗室）', class: 'grow' });
    const add = () => {
      const name = nameInput.value.trim();
      if (!name) return toast('請輸入教室名稱', true);
      s.rooms.push({ id: Store.uid(), name });
      nameInput.value = '';
      commit();
    };
    nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') add(); });

    root.appendChild(el('section', { class: 'card' }, [
      el('h2', { text: '專科教室（' + s.rooms.length + '）' }),
      el('p', { class: 'hint', text: '需要共用場地的課程（音樂教室、電腦教室、實驗室等）在此建立；在「授課設定」中指定教室後，排課會確保同一時間只有一個班使用。一般班級教室不需建立。' }),
      list,
      el('div', { class: 'entity-add' }, [nameInput, el('button', { class: 'btn primary', text: '＋ 新增教室', onclick: add })])
    ]));
  }

  // ---------- 分頁：班級 ----------

  function renderClasses(root) {
    const s = Store.state;
    const st = s.settings;
    const list = el('div', { class: 'entity-list' });

    s.classes.forEach(c => {
      const set = new Set(c.blocked || []);
      const capacity = st.numDays * st.numPeriods - set.size;
      const demand = s.courses.filter(x => x.classId === c.id).reduce((sum, x) => sum + x.periods, 0);
      const over = demand > capacity;
      const grid = slotGrid(set, updated => { c.blocked = [...updated]; Store.normalize(s); commit(); }, { small: true, markText: '—' });
      const homeroomSel = el('select', {
        title: '導師（顯示於匯出課表的副標）',
        onchange: e => { c.homeroomTeacherId = e.target.value; commit(false); }
      }, [el('option', { value: '', text: '導師（未指定）' })].concat(s.teachers.map(t => {
        const opt = el('option', { value: t.id, text: '導師：' + t.name });
        if (c.homeroomTeacherId === t.id) opt.selected = true;
        return opt;
      })));
      list.appendChild(el('div', { class: 'entity-block' }, [
        el('div', { class: 'entity-row' }, [
          el('input', {
            type: 'text', value: c.name, class: 'grow',
            onchange: e => { c.name = e.target.value.trim() || c.name; commit(); }
          }),
          homeroomSel,
          el('span', {
            class: 'badge' + (over ? ' bad' : ''),
            text: '需 ' + demand + ' 節 / 可排 ' + capacity + ' 節'
          }),
          el('button', {
            class: 'icon-btn danger', text: '刪除',
            onclick: () => {
              const used = s.courses.filter(x => x.classId === c.id).length;
              if (!confirmDanger('刪除班級「' + c.name + '」？' + (used ? '（將一併刪除 ' + used + ' 筆授課設定及其課表）' : ''))) return;
              s.classes = s.classes.filter(x => x.id !== c.id);
              Store.normalize(s);
              commit();
            }
          })
        ]),
        over ? el('p', { class: 'warn-text', text: '⚠️ 此班每週需求節數超過可排節數，無法排完，請調整授課設定或不上課時段。' }) : null,
        collapsible('不上課時段（點格子標記 —，例如低年級下午不上課）', grid, false)
      ]));
    });

    const nameInput = el('input', { type: 'text', placeholder: '班級名稱（如：一年甲班、七年 3 班、高一 5 班）', class: 'grow' });
    const add = () => {
      const name = nameInput.value.trim();
      if (!name) return toast('請輸入班級名稱', true);
      s.classes.push({ id: Store.uid(), name, blocked: [] });
      nameInput.value = '';
      commit();
    };
    nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') add(); });

    root.appendChild(el('section', { class: 'card' }, [
      el('h2', { text: '班級（' + s.classes.length + '）' }),
      el('p', { class: 'hint', text: '全校各年級的班級都建立在這裡。不同年級節數不同時（例如國小低年級下午沒課），用「不上課時段」設定即可。' }),
      list,
      el('div', { class: 'entity-add' }, [nameInput, el('button', { class: 'btn primary', text: '＋ 新增班級', onclick: add })])
    ]));
  }

  // ---------- 分頁：授課設定 ----------

  function renderCourses(root) {
    const s = Store.state;

    if (!s.classes.length || !s.subjects.length) {
      root.appendChild(el('section', { class: 'card' }, [
        el('h2', { text: '授課設定' }),
        el('p', { class: 'hint', text: '請先在「科目」「教師」「班級」分頁建立基本資料，再回到這裡設定每班每科的授課內容。' })
      ]));
      return;
    }

    const makeSelect = (items, value, placeholder, onchange, allowEmpty) => {
      const sel = el('select', { onchange: e => onchange(e.target.value) });
      if (allowEmpty) sel.appendChild(el('option', { value: '', text: placeholder }));
      items.forEach(it => {
        const opt = el('option', { value: it.id, text: it.name });
        if (it.id === value) opt.selected = true;
        sel.appendChild(opt);
      });
      if (!allowEmpty && !items.some(it => it.id === value)) sel.selectedIndex = 0;
      return sel;
    };

    // 新增表單
    const form = { classId: s.classes[0].id, subjectId: s.subjects[0].id, teacherId: s.teachers.length ? s.teachers[0].id : '', roomId: '', periods: 2, doubles: 0 };
    const periodsInput = el('input', { type: 'number', min: 1, max: 30, value: form.periods, onchange: e => { form.periods = Math.max(1, Number(e.target.value) || 1); } });
    const doublesInput = el('input', { type: 'number', min: 0, max: 10, value: form.doubles, title: '需要幾組「連續兩節」', onchange: e => { form.doubles = Math.max(0, Number(e.target.value) || 0); } });

    const addForm = el('div', { class: 'course-form' }, [
      el('div', { class: 'field' }, [el('label', { text: '班級' }), makeSelect(s.classes, form.classId, '', v => { form.classId = v; })]),
      el('div', { class: 'field' }, [el('label', { text: '科目' }), makeSelect(s.subjects, form.subjectId, '', v => { form.subjectId = v; })]),
      el('div', { class: 'field' }, [el('label', { text: '任課教師' }), makeSelect(s.teachers, form.teacherId, '（未指定）', v => { form.teacherId = v; }, true)]),
      el('div', { class: 'field' }, [el('label', { text: '專科教室' }), makeSelect(s.rooms, form.roomId, '（不需要）', v => { form.roomId = v; }, true)]),
      el('div', { class: 'field narrow' }, [el('label', { text: '每週節數' }), periodsInput]),
      el('div', { class: 'field narrow' }, [el('label', { text: '連堂組數' }), doublesInput]),
      el('button', {
        class: 'btn primary', text: '＋ 新增授課',
        onclick: () => {
          if (form.doubles * 2 > form.periods) return toast('連堂組數 × 2 不可超過每週節數', true);
          const dup = s.courses.find(c => c.classId === form.classId && c.subjectId === form.subjectId);
          if (dup && !confirmDanger('這個班已有相同科目的授課設定，仍要再新增一筆嗎？')) return;
          s.courses.push({
            id: Store.uid(), classId: form.classId, subjectId: form.subjectId,
            teacherId: form.teacherId, roomId: form.roomId,
            periods: form.periods, doubles: form.doubles, allowed: []
          });
          commit();
        }
      })
    ]);

    // 依班級分組列表
    const groups = el('div');
    s.classes.forEach(cls => {
      const courses = s.courses.filter(c => c.classId === cls.id);
      if (!courses.length) return;
      const total = courses.reduce((sum, c) => sum + c.periods, 0);
      const capacity = s.settings.numDays * s.settings.numPeriods - (cls.blocked || []).length;

      const table = el('table', { class: 'course-table' });
      table.appendChild(el('tr', null, [
        el('th', { text: '科目' }), el('th', { text: '任課教師' }), el('th', { text: '教室' }),
        el('th', { text: '每週節數' }), el('th', { text: '連堂組數' }), el('th', { text: '時段限制' }), el('th', { text: '' })
      ]));

      courses.forEach(c => {
        const subject = findById(s.subjects, c.subjectId);
        const allowedSet = new Set(c.allowed || []);
        const restrictBtn = el('button', {
          class: 'link-btn',
          text: allowedSet.size ? ('限 ' + allowedSet.size + ' 時段') : '不限',
          onclick: () => openRestrictDialog(c)
        });
        table.appendChild(el('tr', null, [
          el('td', null, [el('span', { class: 'subject-chip', style: 'background:' + (subject ? subject.color : '#888'), text: subject ? subject.name : '?' })]),
          el('td', null, [makeSelect(s.teachers, c.teacherId, '（未指定）', v => { c.teacherId = v; commit(); }, true)]),
          el('td', null, [makeSelect(s.rooms, c.roomId, '（不需要）', v => { c.roomId = v; commit(); }, true)]),
          el('td', null, [el('input', {
            type: 'number', min: 1, max: 30, value: c.periods, class: 'num',
            onchange: e => { c.periods = Math.max(1, Number(e.target.value) || 1); Store.normalize(s); commit(); }
          })]),
          el('td', null, [el('input', {
            type: 'number', min: 0, max: 10, value: c.doubles, class: 'num',
            onchange: e => {
              const v = Math.max(0, Number(e.target.value) || 0);
              if (v * 2 > c.periods) { toast('連堂組數 × 2 不可超過每週節數', true); e.target.value = c.doubles; return; }
              c.doubles = v; commit();
            }
          })]),
          el('td', null, [restrictBtn]),
          el('td', null, [el('button', {
            class: 'icon-btn danger', text: '刪除',
            onclick: () => {
              if (!confirmDanger('刪除 ' + cls.name + ' 的這筆授課設定？（已排的課會一併移除）')) return;
              s.courses = s.courses.filter(x => x.id !== c.id);
              Store.normalize(s);
              commit();
            }
          })])
        ]));
      });

      groups.appendChild(el('section', { class: 'card' }, [
        el('h3', null, [
          document.createTextNode(cls.name + ' '),
          el('span', { class: 'badge' + (total > capacity ? ' bad' : ''), text: '合計 ' + total + ' 節 / 可排 ' + capacity + ' 節' })
        ]),
        el('div', { class: 'table-scroll' }, [table])
      ]));
    });

    root.appendChild(el('section', { class: 'card' }, [
      el('h2', { text: '新增授課' }),
      el('p', { class: 'hint', text: '為每個班級的每個科目設定任課教師與每週節數。「連堂組數」表示其中幾組需連續兩節（如美勞 2 節設 1 組連堂 = 排成連續兩節）。' }),
      addForm
    ]));
    root.appendChild(groups);
  }

  /** 課程時段限制編輯視窗 */
  function openRestrictDialog(course) {
    const s = Store.state;
    const subject = findById(s.subjects, course.subjectId);
    const cls = findById(s.classes, course.classId);
    const set = new Set(course.allowed || []);

    const overlay = el('div', { class: 'overlay', onclick: e => { if (e.target === overlay) close(); } });
    const close = () => overlay.remove();
    const grid = slotGrid(set, () => {}, { markText: '✓' });

    overlay.appendChild(el('div', { class: 'dialog' }, [
      el('h3', { text: (cls ? cls.name : '') + '「' + (subject ? subject.name : '') + '」時段限制' }),
      el('p', { class: 'hint', text: '勾選「允許排課」的時段；全部不勾 = 不限時段。例如體育課不排第一節，就勾選第一節以外的所有時段。' }),
      grid,
      el('div', { class: 'btn-row' }, [
        el('button', { class: 'btn', text: '全選', onclick: () => { fillAll(true); } }),
        el('button', { class: 'btn', text: '清除（不限）', onclick: () => { fillAll(false); } }),
        el('button', { class: 'btn primary', text: '儲存', onclick: () => { course.allowed = [...set]; commit(); close(); } }),
        el('button', { class: 'btn', text: '取消', onclick: close })
      ])
    ]));

    function fillAll(on) {
      set.clear();
      if (on) {
        for (let d = 0; d < s.settings.numDays; d++)
          for (let p = 0; p < s.settings.numPeriods; p++) set.add(Store.slotKey(d, p));
      }
      const fresh = slotGrid(set, () => {}, { markText: '✓' });
      grid.replaceWith(fresh);
    }

    document.body.appendChild(overlay);
  }

  // ---------- 分頁：課表編排 ----------

  function renderSchedule(root) {
    const s = Store.state;
    if (!s.courses.length) {
      root.appendChild(el('section', { class: 'card' }, [
        el('h2', { text: '課表編排' }),
        el('p', { class: 'hint', text: '尚未有授課設定。請先完成「授課設定」，或到「基本設定」載入範例資料試用。' })
      ]));
      return;
    }

    if (scheduleView.mode === 'class' && !findById(s.classes, scheduleView.id)) scheduleView.id = s.classes.length ? s.classes[0].id : null;
    if (scheduleView.mode === 'teacher' && !findById(s.teachers, scheduleView.id)) scheduleView.id = s.teachers.length ? s.teachers[0].id : null;

    const conflicts = Solver.computeConflicts(s, dayLabel, periodLabel);

    // 工具列
    const viewSelect = el('select', {
      onchange: e => {
        scheduleView.mode = e.target.value;
        scheduleView.id = null;
        render();
      }
    }, [
      ['class', '班級課表'], ['teacher', '教師課表'], ['overview', '全校總覽']
    ].map(([v, t]) => {
      const opt = el('option', { value: v, text: t });
      if (scheduleView.mode === v) opt.selected = true;
      return opt;
    }));

    let entitySelect = null;
    if (scheduleView.mode !== 'overview') {
      const items = scheduleView.mode === 'class' ? s.classes : s.teachers;
      entitySelect = el('select', { onchange: e => { scheduleView.id = e.target.value; render(); } },
        items.map(it => {
          const opt = el('option', { value: it.id, text: it.name });
          if (scheduleView.id === it.id) opt.selected = true;
          return opt;
        }));
    }

    const runAuto = (keepAll) => {
      const btnMsg = keepAll ? '補排完成' : '自動排課完成';
      toast('排課運算中…');
      setTimeout(() => {
        const result = Solver.autoSchedule(s, { keepAll, budgetMs: 4000 });
        s.placements = result.placements;
        commit();
        if (result.unplacedCount > 0) {
          toast(btnMsg + '，但有 ' + result.unplacedCount + ' 節排不進去（見下方衝突與缺排清單）', true);
        } else {
          toast(btnMsg + '，所有課程皆已排入 ✔');
        }
      }, 30);
    };

    const toolbar = el('div', { class: 'toolbar' }, [
      el('div', { class: 'toolbar-group' }, [viewSelect, entitySelect]),
      el('div', { class: 'toolbar-group' }, [
        el('button', {
          class: 'btn primary', text: '⚡ 自動排課（重排未鎖定）', title: '保留 🔒 鎖定的課，其餘全部重新排',
          onclick: () => {
            if (s.placements.some(p => !p.locked) &&
                !confirmDanger('將重新排列所有未鎖定的課程（🔒 鎖定的保留），確定嗎？')) return;
            runAuto(false);
          }
        }),
        el('button', { class: 'btn', text: '➕ 補排缺課', title: '保留現有課表，只把還沒排的節數補進空位', onclick: () => runAuto(true) }),
        el('button', {
          class: 'btn danger', text: '清空未鎖定',
          onclick: () => {
            if (!confirmDanger('移除所有未鎖定的已排課程？')) return;
            s.placements = s.placements.filter(p => p.locked);
            commit();
          }
        }),
        el('button', { class: 'btn', text: '⬇️ 匯出 Word / PDF', onclick: () => openExportDialog() }),
        el('button', { class: 'btn', text: '🖨️ 列印', title: '直接列印目前畫面', onclick: () => window.print() })
      ])
    ]);

    root.appendChild(toolbar);

    // 衝突面板
    if (conflicts.issues.length) {
      const list = el('ul', { class: 'conflict-list' },
        conflicts.issues.slice(0, 80).map(i => el('li', { class: 'conflict-' + i.type, text: i.message })));
      if (conflicts.issues.length > 80) list.appendChild(el('li', { text: '……共 ' + conflicts.issues.length + ' 項' }));
      root.appendChild(el('section', { class: 'card conflict-panel no-print' }, [
        collapsible('⚠️ 待處理事項（' + conflicts.issues.length + '）', list, true)
      ]));
    } else if (s.placements.length) {
      root.appendChild(el('section', { class: 'card ok-panel no-print' }, [
        el('p', { text: '✅ 目前課表沒有衝突，所有需求節數皆已排入。' })
      ]));
    }

    if (scheduleView.mode === 'class') renderClassSchedule(root, conflicts);
    else if (scheduleView.mode === 'teacher') renderTeacherSchedule(root, conflicts);
    else renderOverview(root, conflicts);
  }

  /** 匯出對話框：格式（Word / PDF）× 範圍（本頁 / 全部班級 / 全部教師） */
  function openExportDialog() {
    const s = Store.state;
    const choice = { format: 'docx', scope: null };

    // 預設範圍：目前檢視的班級 / 教師；總覽模式預設全部班級
    const canOne = scheduleView.mode !== 'overview' && scheduleView.id;
    choice.scope = canOne ? 'one' : 'all-class';

    const overlay = el('div', { class: 'overlay', onclick: e => { if (e.target === overlay) overlay.remove(); } });

    const radio = (name, value, label, checked, onpick) => el('label', { class: 'radio-row' }, [
      el('input', Object.assign({ type: 'radio', name, value, onchange: () => onpick(value) }, checked ? { checked: '' } : {})),
      document.createTextNode(' ' + label)
    ]);

    const currentName = canOne
      ? (scheduleView.mode === 'class' ? nameOf(s.classes, scheduleView.id) : nameOf(s.teachers, scheduleView.id))
      : '';

    const scopeRows = [];
    if (canOne) {
      scopeRows.push(radio('exp-scope', 'one',
        '目前檢視：' + (scheduleView.mode === 'class' ? '班級' : '教師') + '「' + currentName + '」',
        true, v => { choice.scope = v; }));
    }
    scopeRows.push(radio('exp-scope', 'all-class', '全部班級課表（' + s.classes.length + ' 頁，一頁一班）', !canOne, v => { choice.scope = v; }));
    scopeRows.push(radio('exp-scope', 'all-teacher', '全部教師課表（' + s.teachers.length + ' 頁，一頁一師）', false, v => { choice.scope = v; }));

    const titlePreview = (() => {
      const st = s.settings;
      const parts = [];
      if (st.school) parts.push(st.school);
      if (st.schoolYear) parts.push(st.schoolYear + '學年度');
      if (st.term) parts.push(st.term);
      parts.push('課程表');
      return parts.join('');
    })();

    overlay.appendChild(el('div', { class: 'dialog' }, [
      el('h3', { text: '匯出課表' }),
      el('p', { class: 'hint', text: '標題：「' + titlePreview + '」（可至「基本設定 → 課表標題」修改學校、學年度、學期與備註）' }),
      el('h4', { text: '檔案格式' }),
      el('div', { class: 'radio-group' }, [
        radio('exp-fmt', 'docx', 'Word（.docx）— 直接下載檔案', true, v => { choice.format = v; }),
        radio('exp-fmt', 'pdf', 'PDF — 開啟列印畫面，於對話框選「另存為 PDF」', false, v => { choice.format = v; })
      ]),
      el('h4', { text: '匯出範圍' }),
      el('div', { class: 'radio-group' }, scopeRows),
      el('div', { class: 'btn-row' }, [
        el('button', {
          class: 'btn primary', text: '匯出',
          onclick: () => {
            let kind, scope, currentId = null;
            if (choice.scope === 'one') {
              kind = scheduleView.mode === 'class' ? 'class' : 'teacher';
              scope = 'one';
              currentId = scheduleView.id;
            } else {
              kind = choice.scope === 'all-class' ? 'class' : 'teacher';
              scope = 'all';
            }
            const result = ExportKit.exportSchedules(s, kind, scope, choice.format, currentId);
            toast(result.message, !result.ok);
            if (result.ok) overlay.remove();
          }
        }),
        el('button', { class: 'btn', text: '取消', onclick: () => overlay.remove() })
      ])
    ]));
    document.body.appendChild(overlay);
  }

  function placementAt(placements, courseById, filterFn, day, period) {
    return placements.find(p => {
      if (!filterFn(courseById[p.courseId])) return false;
      return p.day === day && period >= p.period && period < p.period + p.len;
    }) || null;
  }

  /** 班級課表（可拖拉編輯） */
  function renderClassSchedule(root, conflicts) {
    const s = Store.state;
    const st = s.settings;
    const cls = findById(s.classes, scheduleView.id);
    if (!cls) return;
    const maps = Solver.buildMaps(s);
    const blocked = new Set(cls.blocked || []);
    const clsPlacements = s.placements.filter(p => maps.courseById[p.courseId] && maps.courseById[p.courseId].classId === cls.id);

    // 未排課清單（拖曳來源）
    const tray = el('div', { class: 'tray' });
    let trayCount = 0;
    s.courses.filter(c => c.classId === cls.id).forEach(c => {
      const placed = clsPlacements.filter(p => p.courseId === c.id);
      const placedPeriods = placed.reduce((sum, p) => sum + p.len, 0);
      const placedDoubles = placed.filter(p => p.len === 2).length;
      const remaining = Math.max(0, c.periods - placedPeriods);
      const doubles = Math.max(0, Math.min((c.doubles || 0) - placedDoubles, Math.floor(remaining / 2)));
      const singles = remaining - doubles * 2;
      const subject = findById(s.subjects, c.subjectId);
      const mkChip = len => {
        trayCount++;
        const chip = el('div', {
          class: 'lesson-chip tray-chip', draggable: 'true',
          style: 'background:' + (subject ? subject.color : '#888'),
          title: '拖曳到右側課表排入' + (len === 2 ? '（連堂，需兩節連續空位）' : ''),
        }, [
          el('span', { text: (subject ? subject.name : '?') + (len === 2 ? '（連堂）' : '') }),
          el('small', { text: nameOf(s.teachers, c.teacherId, '') })
        ]);
        chip.addEventListener('dragstart', e => {
          dragPayload = { kind: 'new', courseId: c.id, len };
          e.dataTransfer.effectAllowed = 'move';
        });
        chip.addEventListener('dragend', () => { dragPayload = null; });
        return chip;
      };
      for (let i = 0; i < doubles; i++) tray.appendChild(mkChip(2));
      for (let i = 0; i < singles; i++) tray.appendChild(mkChip(1));
    });

    // 課表格
    const table = el('table', { class: 'schedule-grid' });
    const head = el('tr', null, [el('th', { class: 'corner', text: cls.name })]);
    for (let d = 0; d < st.numDays; d++) head.appendChild(el('th', { text: '週' + dayLabel(d) }));
    table.appendChild(head);

    const covered = {}; // "d-p" 已被上方連堂覆蓋
    for (let p = 0; p < st.numPeriods; p++) {
      const tr = el('tr', null, [el('th', { text: periodLabel(p) })]);
      for (let d = 0; d < st.numDays; d++) {
        const key = Store.slotKey(d, p);
        if (covered[key]) continue;
        const placement = placementAt(clsPlacements, maps.courseById, () => true, d, p);
        let td;
        if (placement && placement.period === p) {
          if (placement.len === 2) covered[Store.slotKey(d, p + 1)] = true;
          td = el('td', { class: 'slot filled', rowspan: placement.len });
          td.appendChild(lessonBlock(placement, maps, conflicts, { editable: true }));
          makeDroppable(td, cls, d, p, maps, placement);
        } else if (blocked.has(key)) {
          td = el('td', { class: 'slot blocked', text: '—', title: '此班不上課時段' });
        } else {
          td = el('td', { class: 'slot empty' });
          makeDroppable(td, cls, d, p, maps, null);
        }
        tr.appendChild(td);
      }
      table.appendChild(tr);
    }

    const layout = el('div', { class: 'schedule-layout' }, [
      el('div', { class: 'tray-panel no-print' }, [
        el('h3', { text: '待排課程（' + trayCount + '）' }),
        el('p', { class: 'hint', text: trayCount ? '把方塊拖到課表空格排入。' : '此班課程已全部排入 ✔' }),
        tray
      ]),
      el('div', { class: 'grid-panel print-area' }, [
        el('div', { class: 'table-scroll' }, [table]),
        el('p', { class: 'hint no-print', text: '💡 拖曳課程方塊可移動；拖到另一堂課上會交換（限單節）。點 🔒 鎖定（自動排課不變動）、點 ✕ 移回待排。紅框 = 有衝突。' })
      ])
    ]);
    root.appendChild(layout);
  }

  /** 課程方塊 */
  function lessonBlock(placement, maps, conflicts, opts) {
    const s = Store.state;
    const c = maps.courseById[placement.courseId];
    const subject = findById(s.subjects, c.subjectId);
    const isBad = conflicts.badPlacements.has(placement.id);
    const o = opts || {};

    const block = el('div', {
      class: 'lesson-chip placed' + (isBad ? ' bad' : '') + (placement.locked ? ' locked' : ''),
      style: 'background:' + (subject ? subject.color : '#888'),
      draggable: o.editable ? 'true' : 'false',
      title: (subject ? subject.name : '?') + (c.teacherId ? '／' + nameOf(s.teachers, c.teacherId) : '') +
             (c.roomId ? '／' + nameOf(s.rooms, c.roomId) : '') + (isBad ? '\n⚠️ 此課格有衝突' : '')
    }, [
      el('span', { text: (subject ? subject.name : '?') + (placement.len === 2 ? '（連堂）' : '') }),
      el('small', { text: nameOf(s.teachers, c.teacherId, '') + (c.roomId ? '｜' + nameOf(s.rooms, c.roomId) : '') })
    ]);

    if (o.editable) {
      const actions = el('div', { class: 'chip-actions' }, [
        el('button', {
          class: 'chip-btn', text: placement.locked ? '🔒' : '🔓',
          title: placement.locked ? '已鎖定（自動排課不變動），點擊解除' : '未鎖定，點擊鎖定',
          onclick: e => { e.stopPropagation(); placement.locked = !placement.locked; commit(); }
        }),
        el('button', {
          class: 'chip-btn', text: '✕', title: '移回待排',
          onclick: e => {
            e.stopPropagation();
            Store.state.placements = Store.state.placements.filter(x => x.id !== placement.id);
            commit();
          }
        })
      ]);
      block.appendChild(actions);
      block.addEventListener('dragstart', e => {
        dragPayload = { kind: 'move', placementId: placement.id };
        e.dataTransfer.effectAllowed = 'move';
      });
      block.addEventListener('dragend', () => { dragPayload = null; });
    }
    return block;
  }

  /** 讓格子可接受拖放 */
  function makeDroppable(td, cls, day, period, maps, existingPlacement) {
    td.addEventListener('dragover', e => {
      if (!dragPayload) return;
      e.preventDefault();
      td.classList.add('drop-hover');
    });
    td.addEventListener('dragleave', () => td.classList.remove('drop-hover'));
    td.addEventListener('drop', e => {
      e.preventDefault();
      td.classList.remove('drop-hover');
      if (!dragPayload) return;
      const s = Store.state;

      if (dragPayload.kind === 'new') {
        const course = maps.courseById[dragPayload.courseId];
        if (!course || course.classId !== cls.id) return;
        dropNew(s, cls, course, day, period, dragPayload.len, existingPlacement);
      } else if (dragPayload.kind === 'move') {
        const moving = s.placements.find(p => p.id === dragPayload.placementId);
        if (!moving) return;
        dropMove(s, cls, maps, moving, day, period, existingPlacement);
      }
      dragPayload = null;
    });
  }

  function spanFree(s, cls, day, period, len, ignoreIds) {
    const st = s.settings;
    if (period + len > st.numPeriods) return false;
    const blocked = new Set(cls.blocked || []);
    const maps = Solver.buildMaps(s);
    for (let i = 0; i < len; i++) {
      const key = Store.slotKey(day, period + i);
      if (blocked.has(key)) return false;
      const occ = s.placements.find(p => {
        if (ignoreIds && ignoreIds.has(p.id)) return false;
        const c = maps.courseById[p.courseId];
        return c && c.classId === cls.id && p.day === day &&
               (period + i) >= p.period && (period + i) < p.period + p.len;
      });
      if (occ) return false;
    }
    return true;
  }

  function dropNew(s, cls, course, day, period, len, existingPlacement) {
    if (existingPlacement) return toast('該格已有課程，請先移開或拖到空格', true);
    if (!spanFree(s, cls, day, period, len)) {
      return toast(len === 2 ? '連堂需要同一天連續兩節空位' : '此位置無法排入', true);
    }
    s.placements.push({ id: Store.uid(), courseId: course.id, day, period, len, locked: false });
    commit();
    postDropWarn(s, course, day, period, len);
  }

  function dropMove(s, cls, maps, moving, day, period, existingPlacement) {
    const movingCourse = maps.courseById[moving.courseId];
    if (!movingCourse || movingCourse.classId !== cls.id) {
      return toast('只能在同一班級的課表內移動', true);
    }
    if (existingPlacement && existingPlacement.id === moving.id) return;

    if (existingPlacement) {
      // 交換（限兩者皆單節）
      if (moving.len !== 1 || existingPlacement.len !== 1) {
        return toast('連堂課請拖到連續兩節的空位（無法直接交換）', true);
      }
      const d1 = moving.day, p1 = moving.period;
      moving.day = existingPlacement.day; moving.period = existingPlacement.period;
      existingPlacement.day = d1; existingPlacement.period = p1;
      commit();
      postDropWarn(s, movingCourse, moving.day, moving.period, moving.len);
      return;
    }

    const ignore = new Set([moving.id]);
    if (!spanFree(s, cls, day, period, moving.len, ignore)) {
      return toast(moving.len === 2 ? '連堂需要同一天連續兩節空位' : '此位置無法排入', true);
    }
    moving.day = day; moving.period = period;
    commit();
    postDropWarn(s, movingCourse, day, period, moving.len);
  }

  /** 手動排入後若造成衝突，立即提醒（仍允許放置，衝突面板會標示） */
  function postDropWarn(s, course, day, period, len) {
    const msgs = [];
    const maps = Solver.buildMaps(s);
    for (let i = 0; i < len; i++) {
      const key = Store.slotKey(day, period + i);
      if (course.teacherId) {
        if (maps.teacherUnavail[course.teacherId] && maps.teacherUnavail[course.teacherId].has(key)) {
          msgs.push('教師此時段設定為不排課');
        }
        const clash = s.placements.filter(p => {
          const c = maps.courseById[p.courseId];
          return c && c.id !== course.id && c.teacherId === course.teacherId &&
                 p.day === day &&
                 (period + i) >= p.period && (period + i) < p.period + p.len;
        });
        if (clash.length) msgs.push('教師「' + nameOf(s.teachers, course.teacherId) + '」此時段已有其他班的課');
      }
      if (course.roomId) {
        const clash = s.placements.filter(p => {
          const c = maps.courseById[p.courseId];
          return c && c.id !== course.id && c.roomId === course.roomId &&
                 p.day === day && (period + i) >= p.period && (period + i) < p.period + p.len;
        });
        if (clash.length) msgs.push('教室「' + nameOf(s.rooms, course.roomId) + '」此時段已被其他班使用');
      }
      if (maps.courseAllowed[course.id] && !maps.courseAllowed[course.id].has(key)) {
        msgs.push('超出此課程的指定時段限制');
      }
    }
    if (msgs.length) toast('⚠️ 已排入，但有衝突：' + [...new Set(msgs)].join('；'), true);
  }

  /** 教師課表（唯讀） */
  function renderTeacherSchedule(root, conflicts) {
    const s = Store.state;
    const st = s.settings;
    const teacher = findById(s.teachers, scheduleView.id);
    if (!teacher) {
      root.appendChild(el('p', { class: 'hint', text: '尚未建立教師。' }));
      return;
    }
    const maps = Solver.buildMaps(s);
    const unavail = new Set(teacher.unavailable || []);
    const tPlacements = s.placements.filter(p => {
      const c = maps.courseById[p.courseId];
      return c && c.teacherId === teacher.id;
    });
    const totalPeriods = tPlacements.reduce((sum, p) => sum + p.len, 0);

    const table = el('table', { class: 'schedule-grid' });
    const head = el('tr', null, [el('th', { class: 'corner', text: teacher.name })]);
    for (let d = 0; d < st.numDays; d++) head.appendChild(el('th', { text: '週' + dayLabel(d) }));
    table.appendChild(head);

    for (let p = 0; p < st.numPeriods; p++) {
      const tr = el('tr', null, [el('th', { text: periodLabel(p) })]);
      for (let d = 0; d < st.numDays; d++) {
        const key = Store.slotKey(d, p);
        const hits = tPlacements.filter(x => x.day === d && p >= x.period && p < x.period + x.len);
        let td;
        if (hits.length) {
          td = el('td', { class: 'slot filled' + (hits.length > 1 ? ' clash' : '') });
          hits.forEach(hit => {
            const c = maps.courseById[hit.courseId];
            const subject = findById(s.subjects, c.subjectId);
            const isBad = conflicts.badPlacements.has(hit.id);
            td.appendChild(el('div', {
              class: 'lesson-chip placed mini' + (isBad ? ' bad' : ''),
              style: 'background:' + (subject ? subject.color : '#888')
            }, [
              el('span', { text: nameOf(s.classes, c.classId, '?') }),
              el('small', { text: (subject ? subject.name : '') + (c.roomId ? '｜' + nameOf(s.rooms, c.roomId) : '') })
            ]));
          });
        } else if (unavail.has(key)) {
          td = el('td', { class: 'slot blocked', text: '✕', title: '不排課時段' });
        } else {
          td = el('td', { class: 'slot empty' });
        }
        tr.appendChild(td);
      }
      table.appendChild(tr);
    }

    root.appendChild(el('div', { class: 'grid-panel print-area' }, [
      el('p', { class: 'hint' }, [document.createTextNode('本週共 ' + totalPeriods + ' 節課。教師課表為唯讀，請至班級課表調整。')]),
      el('div', { class: 'table-scroll' }, [table])
    ]));
  }

  /** 全校總覽 */
  function renderOverview(root, conflicts) {
    const s = Store.state;
    const st = s.settings;
    const maps = Solver.buildMaps(s);

    const table = el('table', { class: 'overview-grid' });
    const head1 = el('tr', null, [el('th', { rowspan: 2, text: '班級' })]);
    const head2 = el('tr');
    for (let d = 0; d < st.numDays; d++) {
      head1.appendChild(el('th', { colspan: st.numPeriods, text: '週' + dayLabel(d) }));
      for (let p = 0; p < st.numPeriods; p++) head2.appendChild(el('th', { class: 'sub', text: String(p + 1) }));
    }
    table.appendChild(head1);
    table.appendChild(head2);

    s.classes.forEach(cls => {
      const blocked = new Set(cls.blocked || []);
      const tr = el('tr', null, [el('th', { text: cls.name })]);
      const clsPlacements = s.placements.filter(p => {
        const c = maps.courseById[p.courseId];
        return c && c.classId === cls.id;
      });
      for (let d = 0; d < st.numDays; d++) {
        for (let p = 0; p < st.numPeriods; p++) {
          const key = Store.slotKey(d, p);
          const hit = clsPlacements.find(x => x.day === d && p >= x.period && p < x.period + x.len);
          if (hit) {
            const c = maps.courseById[hit.courseId];
            const subject = findById(s.subjects, c.subjectId);
            const isBad = conflicts.badPlacements.has(hit.id);
            tr.appendChild(el('td', {
              class: 'ov' + (isBad ? ' bad' : ''),
              style: 'background:' + (subject ? subject.color : '#888'),
              title: cls.name + ' 週' + dayLabel(d) + ' ' + periodLabel(p) + '：' + (subject ? subject.name : '') +
                     (c.teacherId ? '／' + nameOf(s.teachers, c.teacherId) : ''),
              text: subject ? subject.name.slice(0, 2) : '?'
            }));
          } else if (blocked.has(key)) {
            tr.appendChild(el('td', { class: 'ov off', text: '' }));
          } else {
            tr.appendChild(el('td', { class: 'ov', text: '' }));
          }
        }
      }
      table.appendChild(tr);
    });

    root.appendChild(el('div', { class: 'grid-panel print-area' }, [
      el('p', { class: 'hint no-print', text: '滑鼠移到格子上可看科目與教師。紅框 = 有衝突。' }),
      el('div', { class: 'table-scroll' }, [table])
    ]));
  }

  // ---------- 渲染主流程 ----------

  const renderers = {
    settings: renderSettings,
    subjects: renderSubjects,
    teachers: renderTeachers,
    rooms: renderRooms,
    classes: renderClasses,
    courses: renderCourses,
    schedule: renderSchedule
  };

  function render() {
    const root = $('#tab-content');
    root.innerHTML = '';
    (renderers[currentTab] || renderSettings)(root);
  }

  function init() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        currentTab = btn.dataset.tab;
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b === btn));
        render();
      });
    });
    render();
  }

  return { init, render, toast };
})();
