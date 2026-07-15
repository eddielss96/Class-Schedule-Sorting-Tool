'use strict';

/**
 * ExportKit：課表匯出（Word .docx 與 PDF）
 *
 * .docx：純前端組出 OOXML（WordprocessingML），以未壓縮 ZIP 打包下載，
 *        不需任何外部套件。格式仿照一般學校課程表：
 *        標題（學校＋學年度＋學期＋課程表）、副標（班級／導師 或 教師）、
 *        節次 × 星期表格（每格：科目＋教師 或 班級＋科目）、備註。
 * PDF：產生同樣排版的列印頁面並開啟列印對話框，於對話框選「另存為 PDF」。
 */
const ExportKit = (() => {

  // ---------- ZIP（stored，無壓縮） ----------

  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function makeZip(files) { // files: [{name, text}]
    const enc = new TextEncoder();
    const parts = [];
    const central = [];
    let offset = 0;
    const u16 = v => new Uint8Array([v & 0xFF, (v >>> 8) & 0xFF]);
    const u32 = v => new Uint8Array([v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF]);

    files.forEach(f => {
      const nameBytes = enc.encode(f.name);
      const data = enc.encode(f.text);
      const crc = crc32(data);
      const header = [
        u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(0x21),
        u32(crc), u32(data.length), u32(data.length),
        u16(nameBytes.length), u16(0)
      ];
      const localSize = 30 + nameBytes.length + data.length;
      central.push({ nameBytes, crc, size: data.length, offset });
      header.forEach(h => parts.push(h));
      parts.push(nameBytes, data);
      offset += localSize;
    });

    const cdStart = offset;
    central.forEach(e => {
      [
        u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0x21),
        u32(e.crc), u32(e.size), u32(e.size),
        u16(e.nameBytes.length), u16(0), u16(0), u16(0), u16(0),
        u32(0), u32(e.offset)
      ].forEach(h => parts.push(h));
      parts.push(e.nameBytes);
      offset += 46 + e.nameBytes.length;
    });
    [
      u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length),
      u32(offset - cdStart), u32(cdStart), u16(0)
    ].forEach(h => parts.push(h));

    return new Blob(parts, { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  }

  // ---------- 課表資料整理 ----------

  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

  const nameOf = (arr, id, fb) => {
    const x = (arr || []).find(i => i.id === id);
    return x ? x.name : (fb || '');
  };

  function mainTitle(state) {
    const st = state.settings;
    const parts = [];
    if (st.school) parts.push(st.school);
    if (st.schoolYear) parts.push(st.schoolYear + '學年度');
    if (st.term) parts.push(st.term);
    parts.push('課程表');
    return parts.join('');
  }

  /**
   * 通用課表格資料。
   * 回傳 rows[periodIdx] = cells[dayIdx]，cell = { lines:[], merge:null|'restart'|'cont', off:bool }
   */
  function buildGrid(state, placementsFilterFn, cellLinesFn, offSet) {
    const st = state.settings;
    const maps = Solver.buildMaps(state);
    const list = state.placements.filter(p => {
      const c = maps.courseById[p.courseId];
      return c && placementsFilterFn(c);
    });
    const rows = [];
    for (let p = 0; p < st.numPeriods; p++) {
      const cells = [];
      for (let d = 0; d < st.numDays; d++) {
        const hits = list.filter(x => x.day === d && p >= x.period && p < x.period + x.len);
        const cell = { lines: [], merge: null, off: offSet.has(d + '-' + p) };
        if (hits.length === 1 && hits[0].len === 2) {
          cell.merge = (hits[0].period === p) ? 'restart' : 'cont';
        }
        if (!(cell.merge === 'cont')) {
          hits.forEach(h => { cell.lines.push(...cellLinesFn(maps.courseById[h.courseId])); });
        }
        cells.push(cell);
      }
      rows.push(cells);
    }
    return rows;
  }

  /** 單一課表頁的資料 */
  function schedulePage(state, kind, entity) {
    const st = state.settings;
    if (kind === 'class') {
      const homeroom = entity.homeroomTeacherId ? nameOf(state.teachers, entity.homeroomTeacherId) : '';
      return {
        title: mainTitle(state),
        subtitle: '班級：' + entity.name + (homeroom ? '　　　導師：' + homeroom : ''),
        rows: buildGrid(
          state,
          c => c.classId === entity.id,
          c => {
            const lines = [nameOf(state.subjects, c.subjectId, '?')];
            const t = c.teacherId ? nameOf(state.teachers, c.teacherId) : '';
            if (t) lines.push(t);
            return lines;
          },
          new Set(entity.blocked || [])
        ),
        note: st.note || ''
      };
    }
    // teacher
    return {
      title: mainTitle(state),
      subtitle: '教師：' + entity.name,
      rows: buildGrid(
        state,
        c => c.teacherId === entity.id,
        c => {
          const lines = [nameOf(state.classes, c.classId, '?'), nameOf(state.subjects, c.subjectId, '?')];
          if (c.roomId) lines.push(nameOf(state.rooms, c.roomId));
          return lines;
        },
        new Set(entity.unavailable || [])
      ),
      note: st.note || ''
    };
  }

  function collectPages(state, kind, scope, currentId) {
    const source = kind === 'class' ? state.classes : state.teachers;
    const items = scope === 'all' ? source : source.filter(x => x.id === currentId);
    return items.map(e => schedulePage(state, kind, e));
  }

  // ---------- DOCX 產生 ----------

  const FONT = '標楷體';

  function wRun(text, opts) {
    const o = opts || {};
    return '<w:r><w:rPr>' +
      '<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="' + FONT + '"/>' +
      (o.bold ? '<w:b/>' : '') +
      '<w:sz w:val="' + (o.size || 22) + '"/><w:szCs w:val="' + (o.size || 22) + '"/>' +
      '</w:rPr><w:t xml:space="preserve">' + esc(text) + '</w:t></w:r>';
  }

  function wPara(runs, opts) {
    const o = opts || {};
    return '<w:p><w:pPr>' +
      '<w:jc w:val="' + (o.align || 'center') + '"/>' +
      '<w:spacing w:before="' + (o.before || 0) + '" w:after="' + (o.after || 0) + '" w:line="240" w:lineRule="auto"/>' +
      '</w:pPr>' + runs + '</w:p>';
  }

  function wCell(width, paras, opts) {
    const o = opts || {};
    return '<w:tc><w:tcPr>' +
      '<w:tcW w:w="' + width + '" w:type="dxa"/>' +
      (o.merge === 'restart' ? '<w:vMerge w:val="restart"/>' : o.merge === 'cont' ? '<w:vMerge/>' : '') +
      (o.shaded ? '<w:shd w:val="clear" w:color="auto" w:fill="D9D9D9"/>' : '') +
      '<w:vAlign w:val="center"/>' +
      '</w:tcPr>' + (paras || wPara(wRun(''))) + '</w:tc>';
  }

  function docxBody(pages, state) {
    const st = state.settings;
    const usable = 11906 - 720 * 2; // A4 直式 - 左右邊界
    const timeW = 1500;
    const dayW = Math.floor((usable - timeW) / st.numDays);
    const out = [];

    pages.forEach((page, pi) => {
      out.push(wPara(wRun(page.title, { bold: true, size: 36 }), { after: 120 }));
      out.push(wPara(wRun(page.subtitle, { size: 26 }), { after: 120 }));

      const trs = [];
      // 表頭
      let head = wCell(timeW, wPara(wRun('節次', { bold: true, size: 24 })));
      for (let d = 0; d < st.numDays; d++) {
        head += wCell(dayW, wPara(wRun('星期' + Store.DAY_NAMES[d], { bold: true, size: 24 })));
      }
      trs.push('<w:tr><w:trPr><w:trHeight w:val="480"/></w:trPr>' + head + '</w:tr>');
      // 各節次
      for (let p = 0; p < st.numPeriods; p++) {
        let tds = wCell(timeW, wPara(wRun(st.periodLabels[p] || ('第 ' + (p + 1) + ' 節'), { size: 22 })));
        page.rows[p].forEach(cell => {
          const paras = cell.lines.length
            ? cell.lines.map(line => wPara(wRun(line, { size: 22 }))).join('')
            : wPara(wRun(''));
          tds += wCell(dayW, paras, { merge: cell.merge, shaded: cell.off });
        });
        trs.push('<w:tr><w:trPr><w:trHeight w:val="740"/></w:trPr>' + tds + '</w:tr>');
      }

      const border = t => '<w:' + t + ' w:val="single" w:sz="8" w:space="0" w:color="000000"/>';
      out.push(
        '<w:tbl><w:tblPr>' +
        '<w:tblW w:w="' + usable + '" w:type="dxa"/>' +
        '<w:jc w:val="center"/>' +
        '<w:tblBorders>' + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(border).join('') + '</w:tblBorders>' +
        '</w:tblPr>' +
        '<w:tblGrid><w:gridCol w:w="' + timeW + '"/>' +
        Array.from({ length: st.numDays }, () => '<w:gridCol w:w="' + dayW + '"/>').join('') +
        '</w:tblGrid>' + trs.join('') + '</w:tbl>'
      );

      if (page.note) out.push(wPara(wRun(page.note, { size: 22 }), { align: 'left', before: 120 }));
      if (pi < pages.length - 1) out.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
    });

    out.push('<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
      '<w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720" w:header="420" w:footer="420"/></w:sectPr>');
    return out.join('');
  }

  function buildDocx(pages, state) {
    const documentXml =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:body>' + docxBody(pages, state) + '</w:body></w:document>';

    return makeZip([
      {
        name: '[Content_Types].xml',
        text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
          '</Types>'
      },
      {
        name: '_rels/.rels',
        text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
          '</Relationships>'
      },
      {
        name: 'word/_rels/document.xml.rels',
        text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>'
      },
      { name: 'word/document.xml', text: documentXml }
    ]);
  }

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  // ---------- PDF（列印另存） ----------

  function printPages(pages, state, docName) {
    const st = state.settings;
    const old = document.getElementById('print-export');
    if (old) old.remove();

    const wrap = document.createElement('div');
    wrap.id = 'print-export';

    pages.forEach(page => {
      const pageDiv = document.createElement('div');
      pageDiv.className = 'print-page';

      const h = document.createElement('h2');
      h.textContent = page.title;
      pageDiv.appendChild(h);
      const sub = document.createElement('p');
      sub.className = 'print-subtitle';
      sub.textContent = page.subtitle;
      pageDiv.appendChild(sub);

      const table = document.createElement('table');
      table.className = 'export-table';
      const headTr = document.createElement('tr');
      const th0 = document.createElement('th');
      th0.textContent = '節次';
      headTr.appendChild(th0);
      for (let d = 0; d < st.numDays; d++) {
        const th = document.createElement('th');
        th.textContent = '星期' + Store.DAY_NAMES[d];
        headTr.appendChild(th);
      }
      table.appendChild(headTr);

      for (let p = 0; p < st.numPeriods; p++) {
        const tr = document.createElement('tr');
        const th = document.createElement('th');
        th.textContent = st.periodLabels[p] || ('第 ' + (p + 1) + ' 節');
        tr.appendChild(th);
        page.rows[p].forEach(cell => {
          if (cell.merge === 'cont') return; // 由上方 rowspan 覆蓋
          const td = document.createElement('td');
          if (cell.merge === 'restart') td.rowSpan = 2;
          if (cell.off) td.className = 'off';
          cell.lines.forEach(line => {
            const div = document.createElement('div');
            div.textContent = line;
            td.appendChild(div);
          });
          tr.appendChild(td);
        });
        table.appendChild(tr);
      }
      pageDiv.appendChild(table);

      if (page.note) {
        const note = document.createElement('p');
        note.className = 'print-note';
        note.textContent = page.note;
        pageDiv.appendChild(note);
      }
      wrap.appendChild(pageDiv);
    });

    document.body.appendChild(wrap);
    document.body.classList.add('export-mode');
    const oldTitle = document.title;
    document.title = docName; // 另存 PDF 時的預設檔名

    const cleanup = () => {
      document.body.classList.remove('export-mode');
      document.title = oldTitle;
      wrap.remove();
      window.removeEventListener('afterprint', cleanup);
    };
    window.addEventListener('afterprint', cleanup);
    setTimeout(() => window.print(), 60);
  }

  // ---------- 對外介面 ----------

  /**
   * kind: 'class' | 'teacher'；scope: 'one' | 'all'；format: 'docx' | 'pdf'
   * currentId：scope='one' 時要匯出的班級／教師 id
   */
  function exportSchedules(state, kind, scope, format, currentId) {
    const pages = collectPages(state, kind, scope, currentId);
    if (!pages.length) return { ok: false, message: '沒有可匯出的' + (kind === 'class' ? '班級' : '教師') };

    const kindName = kind === 'class' ? '班級課表' : '教師課表';
    const entityName = scope === 'one'
      ? nameOf(kind === 'class' ? state.classes : state.teachers, currentId)
      : '';
    const base = scope === 'all' ? ('全部' + kindName) : (kindName + '_' + entityName);

    if (format === 'docx') {
      download(buildDocx(pages, state), base + '.docx');
      return { ok: true, message: '已下載 ' + base + '.docx（共 ' + pages.length + ' 頁）' };
    }
    printPages(pages, state, base);
    return { ok: true, message: '已開啟列印畫面，請在對話框中選「另存為 PDF」' };
  }

  return { exportSchedules, schedulePage, buildDocx, collectPages };
})();

// Node.js 測試用
if (typeof module !== 'undefined' && module.exports) {
  module.exports = ExportKit;
}
