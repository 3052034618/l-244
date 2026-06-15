const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { run, get, all, addLog } = require('../db');

const router = express.Router();

router.post('/', (req, res) => {
  const { asset_id, applicant, department, purpose, start_time, end_time } = req.body;

  if (!asset_id || !applicant || !department || !start_time || !end_time) {
    return res.status(400).json({ error: 'asset_id、applicant、department、start_time、end_time 为必填项' });
  }

  if (new Date(start_time) >= new Date(end_time)) {
    return res.status(400).json({ error: '结束时间必须晚于开始时间' });
  }

  const asset = get('SELECT * FROM assets WHERE id = ?', [asset_id]);
  if (!asset) return res.status(404).json({ error: '资产不存在' });

  if (asset.status === 'disposed') {
    return res.status(400).json({ error: '已处置资产不可预约' });
  }

  const conflict = get(`
    SELECT 1 FROM reservations
    WHERE asset_id = ? AND status IN ('pending', 'approved')
    AND start_time < ? AND end_time > ?
  `, [asset_id, end_time, start_time]);

  if (conflict) {
    return res.status(409).json({ error: '该时段资产已被预约' });
  }

  const id = uuidv4();
  run(`
    INSERT INTO reservations (id, asset_id, applicant, department, purpose, start_time, end_time)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [id, asset_id, applicant, department, purpose || null, start_time, end_time]);

  addLog(asset_id, 'reserve', applicant, `提交预约 ${start_time} ~ ${end_time}`);

  const reservation = get('SELECT * FROM reservations WHERE id = ?', [id]);
  res.status(201).json({ message: '预约提交成功', data: reservation });
});

router.put('/:id/approve', (req, res) => {
  const { id } = req.params;
  const { approved, approved_by, remark } = req.body;

  if (typeof approved !== 'boolean') {
    return res.status(400).json({ error: 'approved (boolean) 为必填项' });
  }

  const reservation = get('SELECT * FROM reservations WHERE id = ?', [id]);
  if (!reservation) return res.status(404).json({ error: '预约不存在' });

  if (reservation.status !== 'pending') {
    return res.status(400).json({ error: '仅待审批预约可操作' });
  }

  const newStatus = approved ? 'approved' : 'rejected';
  run(`
    UPDATE reservations
    SET status = ?, approved_by = ?, approved_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ?
  `, [newStatus, approved_by || null, id]);

  if (approved) {
    run(`UPDATE assets SET status = 'in_use', updated_at = datetime('now') WHERE id = ?`, [reservation.asset_id]);
  }

  addLog(reservation.asset_id, approved ? 'approve' : 'reject', approved_by || 'system',
    `预约${approved ? '通过' : '拒绝'}: ${id}${remark ? '，备注: ' + remark : ''}`);

  const updated = get('SELECT * FROM reservations WHERE id = ?', [id]);
  res.json({ message: approved ? '审批通过' : '审批拒绝', data: updated });
});

router.put('/:id/return', (req, res) => {
  const { id } = req.params;
  const { operator, return_remark } = req.body;

  const reservation = get('SELECT * FROM reservations WHERE id = ?', [id]);
  if (!reservation) return res.status(404).json({ error: '预约不存在' });

  if (reservation.status !== 'approved') {
    return res.status(400).json({ error: '仅已通过预约可归还' });
  }

  run(`
    UPDATE reservations
    SET status = 'returned', returned_at = datetime('now'),
        return_remark = ?, updated_at = datetime('now')
    WHERE id = ?
  `, [return_remark || null, id]);

  run(`UPDATE assets SET status = 'idle', updated_at = datetime('now') WHERE id = ?`, [reservation.asset_id]);

  addLog(reservation.asset_id, 'return', operator || 'system',
    `归还资产${return_remark ? '，备注: ' + return_remark : ''}`);

  const updated = get('SELECT * FROM reservations WHERE id = ?', [id]);
  res.json({ message: '归还登记成功', data: updated });
});

router.get('/', (req, res) => {
  const { asset_id, applicant, department, status } = req.query;

  let sql = 'SELECT * FROM reservations WHERE 1=1';
  const params = [];

  if (asset_id) { sql += ' AND asset_id = ?'; params.push(asset_id); }
  if (applicant) { sql += ' AND applicant = ?'; params.push(applicant); }
  if (department) { sql += ' AND department = ?'; params.push(department); }
  if (status) { sql += ' AND status = ?'; params.push(status); }

  sql += ' ORDER BY created_at DESC';

  const reservations = all(sql, params);
  res.json({ data: reservations });
});

module.exports = router;
