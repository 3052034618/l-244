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
      'reservation': ['reserve', 'approve', 'reject', 'return', 'cancel', 'reservation_cancelled'],
      'maintenance': ['maintenance', 'maintenance_todo'],
      'disposal': ['dispose', 'dispose_approve', 'disposal_request', 'disposal_approved', 'disposal_rejected']
    };
    const actions = typeMap[event_type];
    if (actions) {
      if (event_type === 'disposal') {
        sql += ` AND (al.action IN (${actions.map(() => '?').join(', ')}) OR (al.action = 'status_change' AND al.detail LIKE '%处置%'))`;
      } else if (event_type === 'reservation') {
        sql += ` AND (al.action IN (${actions.map(() => '?').join(', ')}) OR (al.action = 'status_change' AND al.detail LIKE '%预约%'))`;
      } else if (event_type === 'maintenance') {
        sql += ` AND (al.action IN (${actions.map(() => '?').join(', ')}) OR (al.action = 'status_change' AND al.detail LIKE '%保养%'))`;
      } else {
        sql += ` AND al.action IN (${actions.map(() => '?').join(', ')})`;
      }
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
      let triggerType = null;
      if (log.detail) {
        if (log.detail.includes('保养') || log.detail.includes('maintenance')) triggerType = 'maintenance';
        else if (log.detail.includes('处置') || log.detail.includes('dispose')) triggerType = 'disposal';
        else if (log.detail.includes('预约') || log.detail.includes('审批') || log.detail.includes('归还')) triggerType = 'reservation';
        else if (log.detail.includes('手动')) triggerType = 'manual';
        else triggerType = 'system';
      }

      let relatedRecord = null;
      let relatedRecordType = null;
      const related = extractRelatedRecord(log, triggerType);
      if (related.related_record) {
        relatedRecord = related.related_record;
        relatedRecordType = related.related_record_type;
      }

      stateTransitions.unshift({
        log_id: log.id,
        from_status: m[1],
        to_status: m[2],
        operator: log.operator,
        timestamp: log.created_at,
        reason: log.detail,
        trigger_type: triggerType,
        related_record: relatedRecord,
        related_record_type: relatedRecordType
      });
    }
  }

  function extractRelatedRecord(log, eventCategory) {
    const result = { related_record: null, related_record_type: null };

    const idMatches = log.detail ? [...log.detail.matchAll(/([0-9a-fA-F-]{36})/g)] : [];
    const ids = idMatches.map(m => m[1]).filter((v, i, a) => a.indexOf(v) === i);

    for (const id of ids) {
      if (eventCategory === 'reservation' || (eventCategory === 'status_change' && log.detail && (log.detail.includes('预约') || log.detail.includes('关联预约')))) {
        const reservation = get(`
          SELECT id, asset_id, applicant, department, purpose, start_time, end_time,
                 status, approved_by, approved_at, returned_at
          FROM reservations WHERE id = ?
        `, [id]);
        if (reservation) {
          result.related_record = reservation;
          result.related_record_type = 'reservation';
          return result;
        }
      }

      if (eventCategory === 'disposal' || (eventCategory === 'status_change' && log.detail && (log.detail.includes('处置') || log.detail.includes('处置申请ID')))) {
        const disposal = get(`
          SELECT id, asset_id, disposal_type, reason, applicant, department,
                 status, approved_by, approved_at
          FROM disposal_requests WHERE id = ?
        `, [id]);
        if (disposal) {
          result.related_record = disposal;
          result.related_record_type = 'disposal_request';
          return result;
        }
      }
    }

    if (eventCategory === 'maintenance') {
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
          result.related_record = matching;
          result.related_record_type = 'maintenance_record';
          return result;
        }
      }
    }

    return result;
  }

  const enrichedLogs = rawLogs.map(log => {
    const eventCategory = classifyEvent(log.action);
    const enriched = {
      ...log,
      event_category: eventCategory,
      related_record: null,
      related_record_type: null,
      status_change: null,
      trigger_type: null
    };

    const m = log.detail && log.detail.match(/状态变更: (\w+) -> (\w+)/);
    if (m) {
      enriched.status_change = {
        from_status: m[1],
        to_status: m[2]
      };
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

    const related = extractRelatedRecord(log, eventCategory);
    if (related.related_record) {
      enriched.related_record = related.related_record;
      enriched.related_record_type = related.related_record_type;
    }

    if (eventCategory === 'status_change' && enriched.trigger_type && !enriched.related_record) {
      const related2 = extractRelatedRecord(log, enriched.trigger_type);
      if (related2.related_record) {
        enriched.related_record = related2.related_record;
        enriched.related_record_type = related2.related_record_type;
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
  if (['reserve', 'approve', 'reject', 'return', 'cancel', 'reservation_cancelled'].includes(action)) return 'reservation';
  if (['maintenance', 'maintenance_todo'].includes(action)) return 'maintenance';
  if (['dispose', 'dispose_approve', 'disposal_request', 'disposal_approved', 'disposal_rejected'].includes(action)) return 'disposal';
  if (['register', 'update', 'voucher_upload'].includes(action)) return 'asset_info';
  return 'other';
}

module.exports = router;
