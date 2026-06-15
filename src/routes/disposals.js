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

function cancelPendingAndFutureReservations(assetId, reason, operator) {
  const now = new Date().toISOString();
  const affected = all(`
    SELECT * FROM reservations
    WHERE asset_id = ? AND status IN ('pending', 'approved')
    AND end_time > ?
  `, [assetId, now]);

  if (affected.length === 0) return [];

  run(`
    UPDATE reservations
    SET status = 'cancelled', updated_at = datetime('now')
    WHERE asset_id = ? AND status IN ('pending', 'approved')
    AND end_time > ?
  `, [assetId, now]);

  for (const r of affected) {
    addLog(assetId, 'reservation_cancelled', operator || 'system',
      `预约${r.status === 'approved' ? '审批通过' : '待审批'}已取消，原因: ${reason}，原时段: ${r.start_time} ~ ${r.end_time}`);
  }

  return affected;
}

router.post('/', (req, res) => {
  const { asset_id, disposal_type, reason, applicant, department } = req.body;

  if (!asset_id || !disposal_type || !applicant || !department) {
    return res.status(400).json({ error: 'asset_id、disposal_type、applicant、department 为必填项' });
  }

  const validTypes = ['scrap', 'transfer'];
  if (!validTypes.includes(disposal_type)) {
    return res.status(400).json({ error: 'disposal_type 必须为 scrap 或 transfer' });
  }

  const asset = get('SELECT * FROM assets WHERE id = ?', [asset_id]);
  if (!asset) return res.status(404).json({ error: '资产不存在' });

  if (asset.status === 'disposed') {
    return res.status(400).json({ error: '资产已处置' });
  }

  const existing = get(
    `SELECT 1 FROM disposal_requests WHERE asset_id = ? AND status = 'pending'`,
    [asset_id]
  );
  if (existing) {
    return res.status(409).json({ error: '该资产已有待审批处置申请' });
  }

  const id = uuidv4();
  run(`
    INSERT INTO disposal_requests (id, asset_id, disposal_type, reason, applicant, department)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [id, asset_id, disposal_type, reason || null, applicant, department]);

  addLog(asset_id, 'disposal_request', applicant,
    `发起${disposal_type === 'scrap' ? '报废' : '转让'}申请${reason ? '，原因: ' + reason : ''}`);

  const request = get('SELECT * FROM disposal_requests WHERE id = ?', [id]);
  res.status(201).json({ message: '处置申请提交成功', data: request });
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

  const request = get('SELECT * FROM disposal_requests WHERE id = ?', [id]);
  if (!request) {
    return res.status(404).json({
      error: '处置申请不存在',
      code: 'REQUEST_NOT_FOUND'
    });
  }

  if (request.status !== 'pending') {
    return res.status(400).json({
      error: '状态错误',
      detail: `仅待审批(pending)的处置申请可操作，当前状态: ${request.status}`,
      code: 'INVALID_STATUS'
    });
  }

  const newStatus = approved ? 'approved' : 'rejected';
  let cancelledReservations = [];

  if (approved) {
    const activeOccupation = hasActiveOccupation(request.asset_id);
    if (activeOccupation) {
      return res.status(400).json({
        error: '存在生效占用',
        detail: `资产当前正在被使用（预约 ${activeOccupation.id}），请先归还再处置`,
        code: 'ACTIVE_OCCUPATION_EXISTS',
        current_occupation: {
          reservation_id: activeOccupation.id,
          applicant: activeOccupation.applicant,
          start_time: activeOccupation.start_time,
          end_time: activeOccupation.end_time
        }
      });
    }

    const asset = get('SELECT * FROM assets WHERE id = ?', [request.asset_id]);
    const disposalName = request.disposal_type === 'scrap' ? '报废' : '转让';

    cancelledReservations = cancelPendingAndFutureReservations(
      request.asset_id,
      `资产已${disposalName}（处置申请 ${id}）`,
      approved_by
    );

    run(`UPDATE assets SET status = 'disposed', updated_at = datetime('now') WHERE id = ?`, [request.asset_id]);

    addLog(request.asset_id, 'status_change', approved_by || 'system',
      `状态变更: ${asset.status} -> disposed，原因: ${disposalName}处置${remark ? '，备注: ' + remark : ''}`);
  }

  run(`
    UPDATE disposal_requests
    SET status = ?, approved_by = ?, approved_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ?
  `, [newStatus, approved_by || null, id]);

  const disposalName = request.disposal_type === 'scrap' ? '报废' : '转让';
  addLog(request.asset_id, approved ? 'disposal_approved' : 'disposal_rejected',
    approved_by || 'system',
    `处置${approved ? '通过' : '拒绝'}: ${disposalName}${remark ? '，备注: ' + remark : ''}`);

  const updated = get('SELECT * FROM disposal_requests WHERE id = ?', [id]);
  res.json({
    message: approved ? '处置审批通过' : '处置审批拒绝',
    data: updated,
    affected: {
      cancelled_reservations: cancelledReservations
    }
  });
});

router.get('/', (req, res) => {
  const { asset_id, department, status, disposal_type } = req.query;

  let sql = 'SELECT * FROM disposal_requests WHERE 1=1';
  const params = [];

  if (asset_id) { sql += ' AND asset_id = ?'; params.push(asset_id); }
  if (department) { sql += ' AND department = ?'; params.push(department); }
  if (status) { sql += ' AND status = ?'; params.push(status); }
  if (disposal_type) { sql += ' AND disposal_type = ?'; params.push(disposal_type); }

  sql += ' ORDER BY created_at DESC';

  const requests = all(sql, params);
  res.json({ data: requests });
});

module.exports = router;
