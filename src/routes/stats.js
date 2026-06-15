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

router.get('/audit-trail', (req, res) => {
  const { asset_id, start_date, end_date, event_type, limit, offset } = req.query;

  if (!asset_id) {
    return res.status(400).json({
      error: '参数缺失',
      detail: 'asset_id 为必填项',
      code: 'MISSING_PARAMS'
    });
  }

  const asset = get('SELECT * FROM assets WHERE id = ?', [asset_id]);
  if (!asset) {
    return res.status(404).json({
      error: '资产不存在',
      code: 'ASSET_NOT_FOUND'
    });
  }

  let sql = `SELECT al.*, a.asset_code, a.name as asset_name
    FROM asset_logs al LEFT JOIN assets a ON al.asset_id = a.id
    WHERE al.asset_id = ?`;
  const params = [asset_id];

  if (event_type) {
    const typeMap = {
      'status_change': ['status_change'],
      'reservation': ['reserve', 'approve', 'reject', 'return', 'cancel'],
      'maintenance': ['maintenance', 'maintenance_todo'],
      'disposal': ['dispose']
    };
    const actions = typeMap[event_type];
    if (actions) {
      sql += ` AND al.action IN (${actions.map(() => '?').join(', ')})`;
      params.push(...actions);
    }
  }

  if (start_date) { sql += ' AND al.created_at >= ?'; params.push(start_date); }
  if (end_date) { sql += ' AND al.created_at <= ?'; params.push(end_date); }

  sql += ' ORDER BY al.created_at DESC';

  const lim = parseInt(limit) || 100;
  const off = parseInt(offset) || 0;
  sql += ' LIMIT ? OFFSET ?';
  params.push(lim, off);

  const rawLogs = all(sql, params);

  const stateTransitions = [];
  let lastStatus = null;
  for (let i = rawLogs.length - 1; i >= 0; i--) {
    const log = rawLogs[i];
    const m = log.detail && log.detail.match(/状态变更: (\w+) -> (\w+)/);
    if (m) {
      stateTransitions.unshift({
        log_id: log.id,
        from_status: m[1],
        to_status: m[2],
        operator: log.operator,
        timestamp: log.created_at,
        reason: log.detail,
        related_record: null,
        related_record_type: null
      });
    }
  }

  const enrichedLogs = rawLogs.map(log => {
    const enriched = {
      ...log,
      event_category: classifyEvent(log.action),
      related_record: null,
      related_record_type: null,
      status_change: null
    };

    const m = log.detail && log.detail.match(/状态变更: (\w+) -> (\w+)/);
    if (m) {
      enriched.status_change = {
        from_status: m[1],
        to_status: m[2]
      };
      enriched.event_category = 'status_change';
    }

    if (enriched.event_category === 'reservation') {
      const reservationIdMatch = log.detail && log.detail.match(/([0-9a-fA-F-]{36})/);
      if (reservationIdMatch) {
        const reservationId = reservationIdMatch[1];
        const reservation = get(`
          SELECT id, asset_id, applicant, department, purpose, start_time, end_time,
                 status, approved_by, approved_at, returned_at
          FROM reservations WHERE id = ?
        `, [reservationId]);
        if (reservation) {
          enriched.related_record = reservation;
          enriched.related_record_type = 'reservation';
        }
      }
    } else if (enriched.event_category === 'maintenance') {
      const maintenanceRecords = all(`
        SELECT id, asset_id, maintenance_type, mileage_at_maintenance, cost,
               content, next_date, next_mileage, performed_by, created_at
        FROM maintenance_records WHERE asset_id = ?
        ORDER BY created_at DESC
        LIMIT 5
      `, [asset_id]);
      if (maintenanceRecords.length > 0) {
        const matching = maintenanceRecords.find(r =>
          Math.abs(new Date(r.created_at).getTime() - new Date(log.created_at).getTime()) < 5000
        );
        if (matching) {
          enriched.related_record = matching;
          enriched.related_record_type = 'maintenance_record';
        }
      }
    } else if (enriched.event_category === 'disposal') {
      const disposalIdMatch = log.detail && log.detail.match(/([0-9a-fA-F-]{36})/);
      if (disposalIdMatch) {
        const disposalId = disposalIdMatch[1];
        const disposal = get(`
          SELECT id, asset_id, disposal_type, reason, applicant, department,
                 status, approved_by, approved_at
          FROM disposal_requests WHERE id = ?
        `, [disposalId]);
        if (disposal) {
          enriched.related_record = disposal;
          enriched.related_record_type = 'disposal_request';
        }
      }
    }

    if (enriched.event_category === 'status_change' && log.detail) {
      if (log.detail.includes('保养') || log.detail.includes('maintenance')) {
        enriched.trigger_type = 'maintenance';
      } else if (log.detail.includes('处置') || log.detail.includes('dispose')) {
        enriched.trigger_type = 'disposal';
      } else if (log.detail.includes('预约') || log.detail.includes('审批') || log.detail.includes('归还') || log.detail.includes('reservation')) {
        enriched.trigger_type = 'reservation';
      } else if (log.detail.includes('手动') || log.detail.includes('operator')) {
        enriched.trigger_type = 'manual';
      } else {
        enriched.trigger_type = 'system';
      }
    }

    return enriched;
  });

  res.json({
    data: {
      asset: {
        id: asset.id,
        asset_code: asset.asset_code,
        name: asset.name,
        current_status: asset.status,
        department: asset.department,
        responsible_person: asset.responsible_person
      },
      state_transitions: stateTransitions,
      audit_logs: enrichedLogs,
      summary: {
        total_events: rawLogs.length,
        status_changes: enrichedLogs.filter(l => l.event_category === 'status_change').length,
        reservation_events: enrichedLogs.filter(l => l.event_category === 'reservation').length,
        maintenance_events: enrichedLogs.filter(l => l.event_category === 'maintenance').length,
        disposal_events: enrichedLogs.filter(l => l.event_category === 'disposal').length
      }
    },
    pagination: { limit: lim, offset: off }
  });
});

function classifyEvent(action) {
  if (action === 'status_change') return 'status_change';
  if (['reserve', 'approve', 'reject', 'return', 'cancel'].includes(action)) return 'reservation';
  if (['maintenance', 'maintenance_todo'].includes(action)) return 'maintenance';
  if (['dispose', 'dispose_approve'].includes(action)) return 'disposal';
  if (['register', 'update', 'voucher_upload'].includes(action)) return 'asset_info';
  return 'other';
}

module.exports = router;
