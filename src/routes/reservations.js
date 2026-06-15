const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { run, get, all, addLog } = require('../db');

const router = express.Router();

function hasActiveOccupation(assetId) {
  const now = new Date().toISOString();
  return get(`
    SELECT r.* FROM reservations r
    WHERE r.asset_id = ? AND r.status = 'approved'
    AND r.start_time <= ? AND r.end_time >= ?
  `, [assetId, now, now]);
}

function updateAssetStatusByReservations(assetId) {
  const now = new Date().toISOString();

  const active = get(`
    SELECT 1 FROM reservations r
    WHERE r.asset_id = ? AND r.status = 'approved'
    AND r.start_time <= ? AND r.end_time >= ?
  `, [assetId, now, now]);

  const asset = get('SELECT status FROM assets WHERE id = ?', [assetId]);
  if (!asset || asset.status === 'maintenance' || asset.status === 'disposed') {
    return;
  }

  const newStatus = active ? 'in_use' : 'idle';
  if (asset.status !== newStatus) {
    run(`UPDATE assets SET status = ?, updated_at = datetime('now') WHERE id = ?`, [newStatus, assetId]);
  }
}

function generateConflictSuggestions(assetId, asset, requestedStart, requestedEnd, conflicts, requestDepartment) {
  const requestedStartDate = new Date(requestedStart);
  const requestedEndDate = new Date(requestedEnd);
  const durationMs = requestedEndDate.getTime() - requestedStartDate.getTime();
  const durationMins = Math.round(durationMs / (1000 * 60));

  const alternativeTimes = [];

  const sortedConflicts = [...conflicts].sort((a, b) =>
    new Date(a.start_time).getTime() - new Date(b.start_time).getTime()
  );

  const firstConflictStart = new Date(sortedConflicts[0].start_time);
  const gapBefore = firstConflictStart.getTime() - requestedStartDate.getTime();
  if (gapBefore >= durationMs) {
    const altEnd = new Date(firstConflictStart.getTime());
    const altStart = new Date(altEnd.getTime() - durationMs);
    alternativeTimes.push({
      type: 'before_conflict',
      start_time: altStart.toISOString(),
      end_time: altEnd.toISOString(),
      description: '冲突前可预约时段',
      available: true
    });
  }

  for (let i = 0; i < sortedConflicts.length - 1; i++) {
    const currentEnd = new Date(sortedConflicts[i].end_time);
    const nextStart = new Date(sortedConflicts[i + 1].start_time);
    const gap = nextStart.getTime() - currentEnd.getTime();
    if (gap >= durationMs) {
      const altStart = new Date(currentEnd.getTime());
      const altEnd = new Date(altStart.getTime() + durationMs);
      alternativeTimes.push({
        type: 'between_conflicts',
        start_time: altStart.toISOString(),
        end_time: altEnd.toISOString(),
        description: '冲突间隔可预约时段',
        available: true
      });
    }
  }

  const lastConflictEnd = new Date(sortedConflicts[sortedConflicts.length - 1].end_time);
  const altStartAfter = new Date(lastConflictEnd.getTime());
  const altEndAfter = new Date(altStartAfter.getTime() + durationMs);
  alternativeTimes.push({
    type: 'after_conflict',
    start_time: altStartAfter.toISOString(),
    end_time: altEndAfter.toISOString(),
    description: '冲突后可预约时段',
    available: true
  });

  const nextDaySameTime = new Date(requestedStartDate);
  nextDaySameTime.setDate(nextDaySameTime.getDate() + 1);
  const nextDayEnd = new Date(nextDaySameTime.getTime() + durationMs);
  alternativeTimes.push({
    type: 'next_day_same_time',
    start_time: nextDaySameTime.toISOString(),
    end_time: nextDayEnd.toISOString(),
    description: '次日同一时段（建议先校验可用性）',
    available: null
  });

  let alternativeAssets = [];
  try {
    const dept = requestDepartment || asset.department;
    let sameDeptAssets = [];

    if (dept && dept !== '???' && dept.trim().length > 0) {
      sameDeptAssets = all(`
        SELECT * FROM assets
        WHERE status NOT IN ('maintenance', 'disposed')
        AND id != ?
        AND department = ?
        ORDER BY department, asset_code
        LIMIT 10
      `, [assetId, dept]);
    }

    if (sameDeptAssets.length === 0) {
      sameDeptAssets = all(`
        SELECT * FROM assets
        WHERE status NOT IN ('maintenance', 'disposed')
        AND id != ?
        ORDER BY department, asset_code
        LIMIT 10
      `, [assetId]);
    }

    for (const altAsset of sameDeptAssets) {
      const altConflicts = all(`
        SELECT 1 FROM reservations r
        WHERE r.asset_id = ? AND r.status IN ('pending', 'approved')
        AND r.start_time < ? AND r.end_time > ?
        LIMIT 1
      `, [altAsset.id, requestedEnd, requestedStart]);

      alternativeAssets.push({
        asset_id: altAsset.id,
        asset_code: altAsset.asset_code,
        name: altAsset.name,
        category: altAsset.category,
        department: altAsset.department,
        status: altAsset.status,
        available_in_requested_time: altConflicts.length === 0,
        is_same_department: dept && altAsset.department === dept
      });
    }

    alternativeAssets.sort((a, b) => {
      if (a.available_in_requested_time !== b.available_in_requested_time) {
        return a.available_in_requested_time ? -1 : 1;
      }
      if (a.is_same_department !== b.is_same_department) {
        return a.is_same_department ? -1 : 1;
      }
      return 0;
    });
  } catch (e) {
    console.error('查询替代资产失败:', e);
  }

  return {
    requested_duration_minutes: durationMins,
    alternative_times: alternativeTimes.slice(0, 6),
    alternative_assets: alternativeAssets,
    tips: [
      `建议选择上述推荐时段或资产，也可调整预约时长（当前 ${durationMins} 分钟）`,
      '点击推荐时段可直接尝试再次预约，二次提交前会重新校验可用性'
    ]
  };
}

router.post('/', (req, res) => {
  const { asset_id, applicant, department, purpose, start_time, end_time } = req.body;

  if (!asset_id || !applicant || !department || !start_time || !end_time) {
    return res.status(400).json({
      error: '参数缺失',
      detail: 'asset_id、applicant、department、start_time、end_time 为必填项',
      code: 'MISSING_PARAMS'
    });
  }

  const start = new Date(start_time);
  const end = new Date(end_time);

  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    return res.status(400).json({
      error: '时间格式错误',
      detail: 'start_time 和 end_time 必须是有效的 ISO 时间字符串（如 2026-06-20T09:00:00）',
      code: 'INVALID_TIME_FORMAT'
    });
  }

  if (start >= end) {
    return res.status(400).json({
      error: '时间范围错误',
      detail: 'end_time 必须严格晚于 start_time',
      code: 'INVALID_TIME_RANGE'
    });
  }

  if (end.getTime() - start.getTime() < 5 * 60 * 1000) {
    return res.status(400).json({
      error: '时间范围过短',
      detail: '预约时长不能少于 5 分钟',
      code: 'TIME_RANGE_TOO_SHORT'
    });
  }

  const asset = get('SELECT * FROM assets WHERE id = ?', [asset_id]);
  if (!asset) {
    return res.status(404).json({
      error: '资产不存在',
      detail: `未找到 ID 为 ${asset_id} 的资产`,
      code: 'ASSET_NOT_FOUND'
    });
  }

  if (asset.status === 'disposed') {
    return res.status(400).json({
      error: '资产已处置',
      detail: `资产 ${asset.asset_code} 已处置，不可预约`,
      code: 'ASSET_DISPOSED'
    });
  }

  if (asset.status === 'maintenance') {
    return res.status(400).json({
      error: '资产保养中',
      detail: `资产 ${asset.asset_code} 正在保养，暂不可预约`,
      code: 'ASSET_MAINTENANCE'
    });
  }

  const conflicts = all(`
    SELECT r.* FROM reservations r
    WHERE r.asset_id = ? AND r.status IN ('pending', 'approved')
    AND r.start_time < ? AND r.end_time > ?
    ORDER BY r.start_time ASC
  `, [asset_id, end_time, start_time]);

  if (conflicts.length > 0) {
    const suggestions = generateConflictSuggestions(asset_id, asset, start_time, end_time, conflicts, department);

    return res.status(409).json({
      error: '时段冲突',
      detail: `资产 ${asset.asset_code} 在申请时段内已有 ${conflicts.length} 个预约/审批`,
      code: 'TIME_CONFLICT',
      conflicts: conflicts.map(c => ({
        reservation_id: c.id,
        start_time: c.start_time,
        end_time: c.end_time,
        status: c.status,
        applicant: c.applicant,
        purpose: c.purpose
      })),
      suggestions: suggestions
    });
  }

  const id = uuidv4();
  run(`
    INSERT INTO reservations (id, asset_id, applicant, department, purpose, start_time, end_time)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [id, asset_id, applicant, department, purpose || null, start_time, end_time]);

  addLog(asset_id, 'reserve', applicant,
    `提交预约 ${start_time} ~ ${end_time}${purpose ? '，用途: ' + purpose : ''}`);

  const reservation = get('SELECT * FROM reservations WHERE id = ?', [id]);
  res.status(201).json({ message: '预约提交成功', data: reservation });
});

router.put('/:id/approve', (req, res) => {
  const { id } = req.params;
  const { approved, approved_by, remark } = req.body;

  if (typeof approved !== 'boolean') {
    return res.status(400).json({
      error: '参数错误',
      detail: 'approved (boolean) 为必填项',
      code: 'INVALID_PARAMS'
    });
  }

  const reservation = get('SELECT * FROM reservations WHERE id = ?', [id]);
  if (!reservation) {
    return res.status(404).json({
      error: '预约不存在',
      code: 'RESERVATION_NOT_FOUND'
    });
  }

  if (reservation.status !== 'pending') {
    return res.status(400).json({
      error: '状态错误',
      detail: `仅待审批(pending)的预约可操作，当前状态: ${reservation.status}`,
      code: 'INVALID_STATUS'
    });
  }

  const asset = get('SELECT status FROM assets WHERE id = ?', [reservation.asset_id]);
  if (!asset || asset.status === 'disposed' || asset.status === 'maintenance') {
    return res.status(400).json({
      error: '资产状态异常',
      detail: `资产当前状态为 ${asset ? asset.status : '不存在'}，无法审批`,
      code: 'ASSET_STATUS_INVALID'
    });
  }

  const newStatus = approved ? 'approved' : 'rejected';
  run(`
    UPDATE reservations
    SET status = ?, approved_by = ?, approved_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ?
  `, [newStatus, approved_by || null, id]);

  if (approved) {
    updateAssetStatusByReservations(reservation.asset_id);
  }

  addLog(reservation.asset_id, approved ? 'approve' : 'reject', approved_by || 'system',
    `预约${approved ? '通过' : '拒绝'}: ${id}${remark ? '，备注: ' + remark : ''}`);

  const updated = get('SELECT * FROM reservations WHERE id = ?', [id]);
  res.json({ message: approved ? '审批通过' : '审批拒绝', data: updated });
});

router.put('/:id/return', (req, res) => {
  const { id } = req.params;
  const { operator, return_remark, return_time } = req.body;

  const reservation = get('SELECT * FROM reservations WHERE id = ?', [id]);
  if (!reservation) {
    return res.status(404).json({
      error: '预约不存在',
      code: 'RESERVATION_NOT_FOUND'
    });
  }

  if (reservation.status !== 'approved') {
    return res.status(400).json({
      error: '状态错误',
      detail: `仅已通过(approved)的预约可归还，当前状态: ${reservation.status}`,
      code: 'INVALID_STATUS'
    });
  }

  const now = new Date();
  const resStart = new Date(reservation.start_time);
  const resEnd = new Date(reservation.end_time);
  const nowIso = return_time || now.toISOString();

  if (now < resStart) {
    return res.status(400).json({
      error: '归还过早',
      detail: `预约尚未开始（开始时间: ${reservation.start_time}）`,
      code: 'TOO_EARLY_TO_RETURN'
    });
  }

  const actualReturnTime = new Date(nowIso);
  const isLate = actualReturnTime > resEnd;

  run(`
    UPDATE reservations
    SET status = 'returned', returned_at = ?,
        return_remark = ?, updated_at = datetime('now')
    WHERE id = ?
  `, [nowIso, return_remark || null, id]);

  updateAssetStatusByReservations(reservation.asset_id);

  const remark = return_remark ? `，备注: ${return_remark}` : '';
  const lateRemark = isLate ? `，逾期归还（应还: ${reservation.end_time}）` : '';
  addLog(reservation.asset_id, 'return', operator || 'system',
    `归还资产${remark}${lateRemark}`);

  const updated = get('SELECT * FROM reservations WHERE id = ?', [id]);
  res.json({
    message: '归还登记成功',
    data: {
      ...updated,
      is_late: isLate
    }
  });
});

router.get('/', (req, res) => {
  const { asset_id, applicant, department, status, start_from, end_before } = req.query;

  let sql = 'SELECT * FROM reservations WHERE 1=1';
  const params = [];

  if (asset_id) { sql += ' AND asset_id = ?'; params.push(asset_id); }
  if (applicant) { sql += ' AND applicant = ?'; params.push(applicant); }
  if (department) { sql += ' AND department = ?'; params.push(department); }
  if (status) { sql += ' AND status = ?'; params.push(status); }
  if (start_from) { sql += ' AND start_time >= ?'; params.push(start_from); }
  if (end_before) { sql += ' AND end_time <= ?'; params.push(end_before); }

  sql += ' ORDER BY start_time DESC';

  const reservations = all(sql, params);
  res.json({ data: reservations });
});

router.get('/calendar', (req, res) => {
  const { asset_id, department, asset_department, applicant, start_date, end_date } = req.query;

  if (!start_date || !end_date) {
    return res.status(400).json({
      error: '参数缺失',
      detail: 'start_date 和 end_date 为必填项',
      code: 'MISSING_PARAMS'
    });
  }

  const start = new Date(start_date);
  const end = new Date(end_date);
  if (isNaN(start.getTime()) || isNaN(end.getTime()) || start >= end) {
    return res.status(400).json({
      error: '时间范围无效',
      code: 'INVALID_TIME_RANGE'
    });
  }

  let filterType = 'all';
  if (asset_department && department) filterType = 'both';
  else if (asset_department) filterType = 'asset_department';
  else if (department) filterType = 'request_department';

  let assetSql = 'SELECT * FROM assets WHERE status != ?';
  let assetParams = ['disposed'];
  if (asset_id) { assetSql += ' AND id = ?'; assetParams.push(asset_id); }
  if (asset_department) { assetSql += ' AND department = ?'; assetParams.push(asset_department); }
  else if (department && filterType === 'request_department') {
  }
  assetSql += ' ORDER BY department, asset_code';

  const assets = all(assetSql, assetParams);

  let resSql = `
    SELECT r.*, a.asset_code, a.name as asset_name, a.category, a.department as asset_department
    FROM reservations r LEFT JOIN assets a ON r.asset_id = a.id
    WHERE r.start_time < ? AND r.end_time > ?
    AND r.status IN ('pending', 'approved', 'returned')
  `;
  const resParams = [end_date, start_date];

  if (asset_id) { resSql += ' AND r.asset_id = ?'; resParams.push(asset_id); }
  if (asset_department) {
    resSql += ' AND a.department = ?';
    resParams.push(asset_department);
  }
  if (department) {
    resSql += ' AND r.department = ?';
    resParams.push(department);
  }
  if (applicant) { resSql += ' AND r.applicant = ?'; resParams.push(applicant); }
  resSql += ' ORDER BY r.start_time ASC';

  const reservations = all(resSql, resParams);

  const assetMap = new Map();
  for (const asset of assets) {
    const assetReservations = reservations.filter(r => r.asset_id === asset.id);
    assetMap.set(asset.id, {
      asset_id: asset.id,
      asset_code: asset.asset_code,
      name: asset.name,
      category: asset.category,
      asset_department: asset.department,
      status: asset.status,
      responsible_person: asset.responsible_person,
      events: assetReservations.map(r => ({
        id: r.id,
        title: `${r.applicant}${r.purpose ? ' - ' + r.purpose : ''}`,
        start: r.start_time,
        end: r.end_time,
        status: r.status,
        applicant: r.applicant,
        request_department: r.department,
        asset_department: r.asset_department,
        purpose: r.purpose,
        backgroundColor: r.status === 'approved' ? '#3b82f6'
          : r.status === 'pending' ? '#f59e0b'
          : r.status === 'returned' ? '#10b981'
          : r.status === 'rejected' ? '#ef4444'
          : '#6b7280',
        borderColor: 'transparent',
        allDay: false,
        extendedProps: {
          asset_code: r.asset_code,
          asset_name: r.asset_name
        }
      }))
    });
  }

  const calendarEvents = reservations.map(r => ({
    id: r.id,
    title: `${r.asset_code} - ${r.applicant}${r.purpose ? ' - ' + r.purpose : ''}`,
    start: r.start_time,
    end: r.end_time,
    status: r.status,
    asset_id: r.asset_id,
    asset_code: r.asset_code,
    asset_name: r.asset_name,
    applicant: r.applicant,
    request_department: r.department,
    asset_department: r.asset_department,
    purpose: r.purpose,
    backgroundColor: r.status === 'approved' ? '#3b82f6'
      : r.status === 'pending' ? '#f59e0b'
      : r.status === 'returned' ? '#10b981'
      : r.status === 'rejected' ? '#ef4444'
      : '#6b7280',
    borderColor: 'transparent',
    allDay: false
  }));

  res.json({
    range: { start: start_date, end: end_date },
    filter_type: filterType,
    asset_department: asset_department || null,
    request_department: department || null,
    assets: Array.from(assetMap.values()),
    events: calendarEvents,
    summary: {
      total_assets: assets.length,
      total_events: reservations.length,
      approved: reservations.filter(r => r.status === 'approved').length,
      pending: reservations.filter(r => r.status === 'pending').length,
      returned: reservations.filter(r => r.status === 'returned').length
    }
  });
});

module.exports = router;
