const express = require('express');
const { get, all } = require('../db');

const router = express.Router();

router.get('/department-occupancy', (req, res) => {
  const { category } = req.query;

  let assetFilter = '';
  const filterParams = [];
  if (category) { assetFilter = ' AND category = ?'; filterParams.push(category); }

  const departments = all(
    `SELECT DISTINCT department FROM assets WHERE department IS NOT NULL${assetFilter}`,
    filterParams
  );

  const result = departments.map(({ department }) => {
    const params = [department, ...filterParams];
    const total = get(
      `SELECT COUNT(*) as count FROM assets WHERE department = ?${assetFilter}`, params
    ).count;

    const inUse = get(
      `SELECT COUNT(*) as count FROM assets WHERE department = ? AND status = 'in_use'${assetFilter}`, params
    ).count;

    const idle = get(
      `SELECT COUNT(*) as count FROM assets WHERE department = ? AND status = 'idle'${assetFilter}`, params
    ).count;

    const maintenance = get(
      `SELECT COUNT(*) as count FROM assets WHERE department = ? AND status = 'maintenance'${assetFilter}`, params
    ).count;

    const disposed = get(
      `SELECT COUNT(*) as count FROM assets WHERE department = ? AND status = 'disposed'${assetFilter}`, params
    ).count;

    return {
      department,
      total,
      in_use: inUse,
      idle,
      maintenance,
      disposed,
      occupancy_rate: total > 0 ? parseFloat(((inUse / total) * 100).toFixed(2)) : 0
    };
  });

  result.sort((a, b) => b.occupancy_rate - a.occupancy_rate);

  res.json({ data: result });
});

router.get('/person-assets', (req, res) => {
  const { person, department } = req.query;

  if (!person && !department) {
    return res.status(400).json({ error: 'person 或 department 至少填一项' });
  }

  let sql = `
    SELECT a.id, a.asset_code, a.name, a.category, a.brand, a.model,
      a.department, a.responsible_person, a.status, a.purchase_date,
      a.mileage, a.next_maintenance_date, a.next_maintenance_mileage,
      a.created_at, a.updated_at
    FROM assets a
    WHERE 1=1
  `;
  const params = [];

  if (person) { sql += ' AND a.responsible_person = ?'; params.push(person); }
  if (department) { sql += ' AND a.department = ?'; params.push(department); }

  sql += ' ORDER BY a.status, a.updated_at DESC';

  const assets = all(sql, params);

  const result = assets.map(asset => {
    const activeReservations = all(`
      SELECT id, start_time, end_time, status
      FROM reservations
      WHERE asset_id = ? AND status IN ('pending', 'approved')
    `, [asset.id]);

    return { ...asset, active_reservations: activeReservations };
  });

  res.json({ data: result });
});

router.get('/asset-logs', (req, res) => {
  const { asset_id, action, operator, start_date, end_date, limit, offset } = req.query;

  let sql = `SELECT al.*, a.asset_code, a.name as asset_name
    FROM asset_logs al LEFT JOIN assets a ON al.asset_id = a.id WHERE 1=1`;
  const params = [];

  if (asset_id) { sql += ' AND al.asset_id = ?'; params.push(asset_id); }
  if (action) { sql += ' AND al.action = ?'; params.push(action); }
  if (operator) { sql += ' AND al.operator = ?'; params.push(operator); }
  if (start_date) { sql += ' AND al.created_at >= ?'; params.push(start_date); }
  if (end_date) { sql += ' AND al.created_at <= ?'; params.push(end_date); }

  sql += ' ORDER BY al.created_at DESC';

  const lim = parseInt(limit) || 100;
  const off = parseInt(offset) || 0;
  sql += ' LIMIT ? OFFSET ?';
  params.push(lim, off);

  const logs = all(sql, params);

  res.json({
    data: logs,
    pagination: { limit: lim, offset: off }
  });
});

module.exports = router;
