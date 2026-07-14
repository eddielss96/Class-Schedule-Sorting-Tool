'use strict';

/**
 * Solver：自動排課（隨機化回溯搜尋 + 貪婪備援）與衝突檢查
 *
 * 硬性條件：
 *  - 同一班級同一時段只有一堂課，且不排在班級「不上課時段」
 *  - 同一教師同一時段只教一堂課，且不排在教師「不排課時段」
 *  - 同一專科教室同一時段只有一個班使用
 *  - 課程若有「指定時段限制」，只能排在限制內
 *  - 連堂課需佔用同日連續兩節
 * 軟性偏好：
 *  - 同一課程盡量分散在不同天
 */
const Solver = (() => {
  const slotKey = (d, p) => d + '-' + p;
  const parseSlot = k => {
    const parts = k.split('-').map(Number);
    return { day: parts[0], period: parts[1] };
  };

  function buildMaps(state) {
    const courseById = {};
    state.courses.forEach(c => { courseById[c.id] = c; });
    const classBlocked = {};
    state.classes.forEach(c => { classBlocked[c.id] = new Set(c.blocked || []); });
    const teacherUnavail = {};
    state.teachers.forEach(t => { teacherUnavail[t.id] = new Set(t.unavailable || []); });
    const courseAllowed = {};
    state.courses.forEach(c => {
      courseAllowed[c.id] = (c.allowed && c.allowed.length) ? new Set(c.allowed) : null;
    });
    return { courseById, classBlocked, teacherUnavail, courseAllowed };
  }

  // ---------- 自動排課 ----------

  function makeCtx(state, maps, fixedPlacements) {
    const ctx = {
      state, maps,
      occCls: {}, occTeacher: {}, occRoom: {},
      dayCount: {},   // courseId -> [每天已排區塊數]
      placed: []
    };
    fixedPlacements.forEach(p => occupy(ctx, p, false));
    return ctx;
  }

  function occupy(ctx, p, track) {
    const c = ctx.maps.courseById[p.courseId];
    for (let i = 0; i < p.len; i++) {
      const k = slotKey(p.day, p.period + i);
      (ctx.occCls[c.classId] || (ctx.occCls[c.classId] = {}))[k] = p;
      if (c.teacherId) (ctx.occTeacher[c.teacherId] || (ctx.occTeacher[c.teacherId] = {}))[k] = p;
      if (c.roomId) (ctx.occRoom[c.roomId] || (ctx.occRoom[c.roomId] = {}))[k] = p;
    }
    const dc = ctx.dayCount[p.courseId] || (ctx.dayCount[p.courseId] = new Array(ctx.state.settings.numDays).fill(0));
    dc[p.day]++;
    if (track) ctx.placed.push(p);
  }

  function release(ctx, p) {
    const c = ctx.maps.courseById[p.courseId];
    for (let i = 0; i < p.len; i++) {
      const k = slotKey(p.day, p.period + i);
      delete ctx.occCls[c.classId][k];
      if (c.teacherId) delete ctx.occTeacher[c.teacherId][k];
      if (c.roomId) delete ctx.occRoom[c.roomId][k];
    }
    ctx.dayCount[p.courseId][p.day]--;
    const idx = ctx.placed.indexOf(p);
    if (idx >= 0) ctx.placed.splice(idx, 1);
  }

  function canPlace(ctx, course, day, period, len) {
    const st = ctx.state.settings;
    if (period + len > st.numPeriods) return false;
    const allowed = ctx.maps.courseAllowed[course.id];
    for (let i = 0; i < len; i++) {
      const k = slotKey(day, period + i);
      if (ctx.maps.classBlocked[course.classId].has(k)) return false;
      if (ctx.occCls[course.classId] && ctx.occCls[course.classId][k]) return false;
      if (course.teacherId) {
        if (ctx.maps.teacherUnavail[course.teacherId] &&
            ctx.maps.teacherUnavail[course.teacherId].has(k)) return false;
        if (ctx.occTeacher[course.teacherId] && ctx.occTeacher[course.teacherId][k]) return false;
      }
      if (course.roomId && ctx.occRoom[course.roomId] && ctx.occRoom[course.roomId][k]) return false;
      if (allowed && !allowed.has(k)) return false;
    }
    return true;
  }

  function candidates(ctx, block) {
    const st = ctx.state.settings;
    const out = [];
    for (let d = 0; d < st.numDays; d++) {
      for (let p = 0; p + block.len <= st.numPeriods; p++) {
        if (canPlace(ctx, block.course, d, p, block.len)) out.push({ day: d, period: p });
      }
    }
    return out;
  }

  /** 需要排入的區塊（扣除已鎖定的部分） */
  function buildBlocks(state, maps, fixedPlacements) {
    const blocks = [];
    state.courses.forEach(c => {
      const fixed = fixedPlacements.filter(p => p.courseId === c.id);
      const fixedPeriods = fixed.reduce((s, p) => s + p.len, 0);
      const fixedDoubles = fixed.filter(p => p.len === 2).length;
      const remaining = Math.max(0, c.periods - fixedPeriods);
      let doubles = Math.max(0, Math.min((c.doubles || 0) - fixedDoubles, Math.floor(remaining / 2)));
      const singles = remaining - doubles * 2;
      for (let i = 0; i < doubles; i++) blocks.push({ course: c, len: 2 });
      for (let i = 0; i < singles; i++) blocks.push({ course: c, len: 1 });
    });
    return blocks;
  }

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  /** 候選排序：優先選同課程當天尚未排過的時段（分散到不同天），再加隨機性 */
  function orderCandidates(ctx, block, cands) {
    shuffle(cands);
    const dc = ctx.dayCount[block.course.id];
    cands.sort((a, b) => {
      const pa = dc ? dc[a.day] : 0;
      const pb = dc ? dc[b.day] : 0;
      return pa - pb;
    });
    return cands;
  }

  function makePlacement(state, block, cand) {
    return {
      id: 'plc' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      courseId: block.course.id,
      day: cand.day,
      period: cand.period,
      len: block.len,
      locked: false
    };
  }

  function backtrack(ctx, blocks, limits) {
    if (!blocks.length) return true;
    if (++limits.nodes > limits.maxNodes || Date.now() > limits.deadline) return false;

    // MRV：先排候選時段最少的區塊
    let bestIdx = 0, bestCands = null;
    for (let i = 0; i < blocks.length; i++) {
      const cands = candidates(ctx, blocks[i]);
      if (bestCands === null || cands.length < bestCands.length) {
        bestIdx = i; bestCands = cands;
        if (cands.length === 0) break;
      }
    }
    if (!bestCands.length) return false;

    const block = blocks[bestIdx];
    const rest = blocks.slice();
    rest.splice(bestIdx, 1);
    orderCandidates(ctx, block, bestCands);

    // 限制分支數，配合多次重啟達到隨機化搜尋
    const branch = Math.min(bestCands.length, 6);
    for (let i = 0; i < branch; i++) {
      const p = makePlacement(ctx.state, block, bestCands[i]);
      occupy(ctx, p, true);
      if (backtrack(ctx, rest, limits)) return true;
      release(ctx, p);
    }
    return false;
  }

  /** 貪婪備援：盡量排入，排不進的回報為未排 */
  function greedy(ctx, blocks) {
    const unplaced = [];
    const queue = blocks.slice();
    while (queue.length) {
      // 每輪挑候選最少的先排
      let bestIdx = 0, bestCands = null;
      for (let i = 0; i < queue.length; i++) {
        const cands = candidates(ctx, queue[i]);
        if (bestCands === null || cands.length < bestCands.length) {
          bestIdx = i; bestCands = cands;
          if (!cands.length) break;
        }
      }
      const block = queue.splice(bestIdx, 1)[0];
      if (!bestCands.length) { unplaced.push(block); continue; }
      orderCandidates(ctx, block, bestCands);
      occupy(ctx, makePlacement(ctx.state, block, bestCands[0]), true);
    }
    return unplaced;
  }

  /**
   * 自動排課主流程。keepAll=true 保留所有已排課（只補空缺）；
   * 否則只保留鎖定的課，其餘重排。
   * 回傳 { placements, unplacedCount, unplacedList }
   */
  function autoSchedule(state, options) {
    const opts = options || {};
    const maps = buildMaps(state);
    const fixed = state.placements.filter(p => opts.keepAll ? true : p.locked);
    const blocks = buildBlocks(state, maps, fixed);
    if (!blocks.length) {
      return { placements: fixed.slice(), unplacedCount: 0, unplacedList: [] };
    }

    const budgetMs = opts.budgetMs || 4000;
    const t0 = Date.now();
    let best = null;

    while (Date.now() - t0 < budgetMs) {
      const ctx = makeCtx(state, maps, fixed);
      const limits = {
        nodes: 0,
        maxNodes: 40000,
        deadline: Math.min(t0 + budgetMs, Date.now() + 1500)
      };
      const ok = backtrack(ctx, shuffle(blocks.slice()), limits);
      if (ok) {
        best = { placed: ctx.placed.slice(), unplaced: [] };
        break;
      }
      // 回溯失敗：改用貪婪法取得「最佳可行」結果
      const gctx = makeCtx(state, maps, fixed);
      const unplaced = greedy(gctx, shuffle(blocks.slice()));
      if (!best || unplaced.length < best.unplaced.length) {
        best = { placed: gctx.placed.slice(), unplaced };
      }
      if (!unplaced.length) break;
    }

    return {
      placements: fixed.concat(best.placed),
      unplacedCount: best.unplaced.length,
      unplacedList: best.unplaced
    };
  }

  // ---------- 衝突檢查 ----------

  /**
   * 回傳 { issues: [{type, message}], badPlacements: Set(placementId) }
   */
  function computeConflicts(state, dayLabel, periodLabel) {
    const maps = buildMaps(state);
    const issues = [];
    const bad = new Set();
    const teacherName = id => (state.teachers.find(t => t.id === id) || {}).name || '?';
    const roomName = id => (state.rooms.find(r => r.id === id) || {}).name || '?';
    const className = id => (state.classes.find(c => c.id === id) || {}).name || '?';
    const subjectName = id => (state.subjects.find(s => s.id === id) || {}).name || '?';
    const courseLabel = c => className(c.classId) + '「' + subjectName(c.subjectId) + '」';
    const slotLabel = (d, p) => '週' + dayLabel(d) + ' ' + periodLabel(p);

    // 依教師 / 教室 / 班級建立時段對照
    const byTeacher = {}, byRoom = {}, byClass = {};
    state.placements.forEach(p => {
      const c = maps.courseById[p.courseId];
      if (!c) return;
      for (let i = 0; i < p.len; i++) {
        const k = slotKey(p.day, p.period + i);
        if (c.teacherId) ((byTeacher[c.teacherId] || (byTeacher[c.teacherId] = {}))[k] || (byTeacher[c.teacherId][k] = [])).push(p);
        if (c.roomId) ((byRoom[c.roomId] || (byRoom[c.roomId] = {}))[k] || (byRoom[c.roomId][k] = [])).push(p);
        ((byClass[c.classId] || (byClass[c.classId] = {}))[k] || (byClass[c.classId][k] = [])).push(p);
      }
    });

    const clashScan = (map, label, nameFn) => {
      Object.keys(map).forEach(id => {
        Object.keys(map[id]).forEach(k => {
          const list = map[id][k];
          if (list.length > 1) {
            const { day, period } = parseSlot(k);
            const names = list.map(p => courseLabel(maps.courseById[p.courseId])).join('、');
            issues.push({ type: 'clash', message: label + '「' + nameFn(id) + '」在' + slotLabel(day, period) + '同時有：' + names });
            list.forEach(p => bad.add(p.id));
          }
        });
      });
    };
    clashScan(byTeacher, '教師', teacherName);
    clashScan(byRoom, '教室', roomName);
    clashScan(byClass, '班級', className);

    // 個別課格違規：教師不排課時段、班級不上課時段、科目時段限制
    state.placements.forEach(p => {
      const c = maps.courseById[p.courseId];
      if (!c) return;
      const allowed = maps.courseAllowed[c.id];
      for (let i = 0; i < p.len; i++) {
        const k = slotKey(p.day, p.period + i);
        if (c.teacherId && maps.teacherUnavail[c.teacherId] && maps.teacherUnavail[c.teacherId].has(k)) {
          issues.push({ type: 'unavailable', message: courseLabel(c) + '排在教師「' + teacherName(c.teacherId) + '」的不排課時段（' + slotLabel(p.day, p.period + i) + '）' });
          bad.add(p.id);
        }
        if (maps.classBlocked[c.classId] && maps.classBlocked[c.classId].has(k)) {
          issues.push({ type: 'blocked', message: courseLabel(c) + '排在班級不上課時段（' + slotLabel(p.day, p.period + i) + '）' });
          bad.add(p.id);
        }
        if (allowed && !allowed.has(k)) {
          issues.push({ type: 'restricted', message: courseLabel(c) + '排在指定時段限制之外（' + slotLabel(p.day, p.period + i) + '）' });
          bad.add(p.id);
        }
      }
    });

    // 容量預檢：需求超過可用節數時，排課必定失敗，直接指出原因
    const totalSlots = state.settings.numDays * state.settings.numPeriods;
    state.teachers.forEach(t => {
      const load = state.courses.filter(c => c.teacherId === t.id).reduce((s2, c) => s2 + c.periods, 0);
      const avail = totalSlots - (t.unavailable || []).length;
      if (load > avail) {
        issues.push({ type: 'capacity', message: '教師「' + t.name + '」授課共 ' + load + ' 節，超過其可排節數 ' + avail + ' 節，請調整授課設定或不排課時段' });
      }
    });
    state.rooms.forEach(r => {
      const load = state.courses.filter(c => c.roomId === r.id).reduce((s2, c) => s2 + c.periods, 0);
      if (load > totalSlots) {
        issues.push({ type: 'capacity', message: '教室「' + r.name + '」每週被需求 ' + load + ' 節，超過一週總節數 ' + totalSlots + ' 節，無法全部排入' });
      }
    });
    state.classes.forEach(cl => {
      const demand = state.courses.filter(c => c.classId === cl.id).reduce((s2, c) => s2 + c.periods, 0);
      const avail = totalSlots - (cl.blocked || []).length;
      if (demand > avail) {
        issues.push({ type: 'capacity', message: '班級「' + cl.name + '」每週需求 ' + demand + ' 節，超過可排節數 ' + avail + ' 節' });
      }
    });

    // 節數統計：不足 / 超出、連堂數不足
    state.courses.forEach(c => {
      const placed = state.placements.filter(p => p.courseId === c.id);
      const total = placed.reduce((s, p) => s + p.len, 0);
      if (total < c.periods) {
        issues.push({ type: 'count', message: courseLabel(c) + '已排 ' + total + ' 節，尚缺 ' + (c.periods - total) + ' 節（需 ' + c.periods + ' 節）' });
      } else if (total > c.periods) {
        issues.push({ type: 'count', message: courseLabel(c) + '已排 ' + total + ' 節，超出需求 ' + (total - c.periods) + ' 節（需 ' + c.periods + ' 節）' });
        placed.forEach(p => bad.add(p.id));
      }
      const doubles = placed.filter(p => p.len === 2).length;
      if (c.doubles && doubles < c.doubles) {
        issues.push({ type: 'double', message: courseLabel(c) + '連堂數不足：已排 ' + doubles + ' 組，需 ' + c.doubles + ' 組' });
      }
    });

    return { issues, badPlacements: bad };
  }

  return { autoSchedule, computeConflicts, buildMaps, canPlace };
})();

// Node.js 測試用
if (typeof module !== 'undefined' && module.exports) {
  module.exports = Solver;
}
