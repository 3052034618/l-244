const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { run, get, all, addLog } = require('../db');

const router = express.Router();

router.post('/', (req, res) => {
  const {
    asset_id, maintenance_type, mileage_at_maintenance,
    cost, content, next_date, next_mileage, performed_by
  } = req.body;

  if (!asset_id || !maintenance_type) {
    return res.status(400).json({ error: 'asset_id、maintenance_type 为必填项' });
  }

  const asset = get('SELECT * FROM assets WHERE id = ?', [asset_id]);
  if (!asset) return res.status(404).json({ error: '资产不存在' });

  const id = uuidv4();
  run(`
    INSERT INTO maintenance_records (id, asset_id, maintenance_type, mileage_at_maintenance,
      cost, content, next_date, next_mileage, performed_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [id, asset_id, maintenance_type,
    mileage_at_maintenance || null, cost || null, content || null,
    next_date || null, next_mileage || null, performed_by || null]);

  if (mileage_at_maintenance) {
    run(`UPDATE assets SET mileage = ?, updated_at = datetime('now') WHERE id = ?`,
      [mileage_at_maintenance, asset_id]);
  }

  if (next_date || next_mileage) {
    run(`
      UPDATE assets SET next_maintenance_date = ?, next_maintenance_mileage = ?,
        updated_at = datetime('now') WHERE id = ?
    `, [next_date || asset.next_maintenance_date,
      next_mileage || asset.next_maintenance_mileage, asset_id]);
  }

  addLog(asset_id, 'maintenance', performed_by || 'system',
    `保养登记: ${maintenance_type}${mileage_at_maintenance ? '，里程: ' + mileage_at_maintenance : ''}`);

  const record = get('SELECT * FROM maintenance_records WHERE id = ?', [id]);
  res.status(201).json({ message: '保养记录登记成功', data: record });
});

router.get('/reminders', (req, res) => {
  const { days, category } = req.query;

  const daysAhead = parseInt(days) || 30;
  const reminderDate = new Date();
  reminderDate.setDate(reminderDate.getDate() + daysAhead);
  const reminderDateStr = reminderDate.toISOString().slice(0, 10);

  let sql = `
    SELECT * FROM assets
    WHERE status != 'disposed'
    AND (next_maintenance_date <= ? OR next_maintenance_mileage <= mileage)
  `;
  const params = [reminderDateStr];

  if (category) { sql += ' AND category = ?'; params.push(category); }

  sql += ' ORDER BY next_maintenance_date ASC';

  const assets = all(sql, params);

  const reminders = assets.map(asset => {
    const reasons = [];
    if (asset.next_maintenance_date && asset.next_maintenance_date <= reminderDateStr) {
      reasons.push(`保养日期到期: ${asset.next_maintenance_date}`);
    }
    if (asset.next_maintenance_mileage && asset.next_maintenance_mileage <= asset.mileage) {
      reasons.push(`保养里程到期: 当前${asset.mileage}，阈值${asset.next_maintenance_mileage}`);
    }
    return { ...asset, reminder_reasons: reasons };
  });

  res.json({ data: reminders });
});

router.get('/:asset_id', (req, res) => {
  const { asset_id } = req.params;

  const asset = get('SELECT * FROM assets WHERE id = ?', [asset_id]);
  if (!asset) return res.status(404).json({ error: '资产不存在' });

  const records = all(
    'SELECT * FROM maintenance_records WHERE asset_id = ? ORDER BY created_at DESC',
    [asset_id]
  );

  res.json({ data: records });
});

module.exports = router;
