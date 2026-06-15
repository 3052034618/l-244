const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { run, get, all, addLog } = require('../db');

const router = express.Router();

function calcMaintenanceStatus(asset, nowStr) {
  const now = new Date(nowStr);
  const statuses = [];
  let level = 'normal';
  let overdueDays = 0;
  let daysToNext = null;
  let mileageOver = 0;

  if (asset.next_maintenance_date) {
    const nextDate = new Date(asset.next_maintenance_date);
    const diffTime = nextDate.getTime() - now.getTime();
    daysToNext = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    if (daysToNext < 0) {
      statuses.push('overdue_date');
      overdueDays = Math.abs(daysToNext);
      level = 'overdue';
    } else if (daysToNext <= 7) {
      statuses.push('urgent_date');
      level = level === 'normal' ? 'urgent' : level;
    } else if (daysToNext <= 30) {
      statuses.push('soon_date');
      level = level === 'normal' ? 'soon' : level;
    }
  }

  if (asset.next_maintenance_mileage && asset.mileage !== null) {
    const diff = asset.next_maintenance_mileage - asset.mileage;
    mileageOver = diff < 0 ? Math.abs(diff) : 0;
    const mileageToNext = diff > 0 ? diff : 0;

    if (diff <= 0) {
      statuses.push('overdue_mileage');
      level = 'overdue';
    } else if (diff <= 500) {
      statuses.push('urgent_mileage');
      level = level === 'normal' ? 'urgent' : level;
    } else if (diff <= 2000) {
      statuses.push('soon_mileage');
      level = level === 'normal' ? 'soon' : level;
    }
  }

  return { statuses, level, overdueDays, daysToNext, mileageOver, mileageToNext: asset.next_maintenance_mileage ? asset.mileage ? asset.next_maintenance_mileage - asset.mileage : null : null };
}

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
    `保养登记: ${maintenance_type}${mileage_at_maintenance ? '，里程: ' + mileage_at_maintenance : ''}${content ? '，内容: ' + content : ''}`);

  const record = get('SELECT * FROM maintenance_records WHERE id = ?', [id]);
  res.status(201).json({ message: '保养记录登记成功', data: record });
});

router.get('/reminders', (req, res) => {
  const { days, category } = req.query;

  const daysAhead = parseInt(days) || 30;
  const reminderDate = new Date();
  reminderDate.setDate(reminderDate.getDate() + daysAhead);
  const reminderDateStr = reminderDate.toISOString().slice(0, 10);
  const nowStr = new Date().toISOString();

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
    const { statuses, level, overdueDays, daysToNext, mileageOver, mileageToNext } = calcMaintenanceStatus(asset, nowStr);
    const reasons = [];
    if (asset.next_maintenance_date && asset.next_maintenance_date <= reminderDateStr) {
      reasons.push(`保养日期到期: ${asset.next_maintenance_date}`);
    }
    if (asset.next_maintenance_mileage && asset.next_maintenance_mileage <= asset.mileage) {
      reasons.push(`保养里程到期: 当前${asset.mileage}，阈值${asset.next_maintenance_mileage}`);
    }
    return {
      ...asset,
      reminder_reasons: reasons,
      urgency_level: level,
      overdue_days: overdueDays,
      days_to_next: daysToNext,
      mileage_over: mileageOver,
      mileage_to_next: mileageToNext
    };
  });

  res.json({ data: reminders });
});

router.get('/todo-list', (req, res) => {
  const { group_by, department, responsible_person, category, level } = req.query;

  const nowStr = new Date().toISOString();
  const now = new Date();

  let sql = `
    SELECT * FROM assets
    WHERE status != 'disposed'
    AND (next_maintenance_date IS NOT NULL OR next_maintenance_mileage IS NOT NULL)
  `;
  const params = [];

  if (category) { sql += ' AND category = ?'; params.push(category); }
  if (department) { sql += ' AND department = ?'; params.push(department); }
  if (responsible_person) { sql += ' AND responsible_person = ?'; params.push(responsible_person); }

  sql += ' ORDER BY next_maintenance_date ASC, mileage DESC';

  const assets = all(sql, params);

  const items = assets.map(asset => {
    const status = calcMaintenanceStatus(asset, nowStr);
    const needsAttention = status.statuses.length > 0;

    if (level && status.level !== level) {
      return null;
    }

    const reasons = [];
    if (status.statuses.includes('overdue_date')) {
      reasons.push(`日期已逾期 ${status.overdueDays} 天（应于 ${asset.next_maintenance_date}）`);
    }
    if (status.statuses.includes('urgent_date')) {
      reasons.push(`日期即将到期（${status.daysToNext} 天后，${asset.next_maintenance_date}）`);
    }
    if (status.statuses.includes('soon_date')) {
      reasons.push(`日期快到期（${status.daysToNext} 天后，${asset.next_maintenance_date}）`);
    }
    if (status.statuses.includes('overdue_mileage')) {
      reasons.push(`里程已超 ${status.mileageOver} km（当前 ${asset.mileage}，阈值 ${asset.next_maintenance_mileage}）`);
    }
    if (status.statuses.includes('urgent_mileage')) {
      reasons.push(`里程即将到达（还差 ${status.mileage_to_next} km，当前 ${asset.mileage}）`);
    }
    if (status.statuses.includes('soon_mileage')) {
      reasons.push(`里程快到期（还差 ${status.mileage_to_next} km，当前 ${asset.mileage}）`);
    }

    return {
      asset_id: asset.id,
      asset_code: asset.asset_code,
      name: asset.name,
      category: asset.category,
      brand: asset.brand,
      department: asset.department,
      responsible_person: asset.responsible_person,
      status: asset.status,
      mileage: asset.mileage,
      next_maintenance_date: asset.next_maintenance_date,
      next_maintenance_mileage: asset.next_maintenance_mileage,
      urgency_level: status.level,
      needs_attention: needsAttention,
      todo_reasons: reasons,
      overdue_days: status.overdueDays,
      days_to_next: status.daysToNext,
      mileage_over: status.mileageOver,
      mileage_to_next: status.mileage_to_next
    };
  }).filter(x => x !== null);

  const urgentItems = items.filter(x => x.urgency_level === 'urgent').sort((a, b) => {
    if (a.overdue_days > 0 && b.overdue_days <= 0) return -1;
    if (b.overdue_days > 0 && a.overdue_days <= 0) return 1;
    if (a.overdue_days > 0) return b.overdue_days - a.overdue_days;
    if (a.days_to_next !== null && b.days_to_next !== null) return a.days_to_next - b.days_to_next;
    return 0;
  });
  const overdueItems = items.filter(x => x.urgency_level === 'overdue').sort((a, b) => b.overdue_days - a.overdue_days);
  const soonItems = items.filter(x => x.urgency_level === 'soon').sort((a, b) => {
    if (a.days_to_next !== null && b.days_to_next !== null) return a.days_to_next - b.days_to_next;
    if (a.mileage_to_next !== null && b.mileage_to_next !== null) return a.mileage_to_next - b.mileage_to_next;
    return 0;
  });
  const normalItems = items.filter(x => x.urgency_level === 'normal');

  const grouped = {
    by_level: {
      overdue: overdueItems,
      urgent: urgentItems,
      soon: soonItems,
      normal: normalItems
    },
    counts: {
      total: items.length,
      needs_attention: items.filter(x => x.needs_attention).length,
      overdue: overdueItems.length,
      urgent: urgentItems.length,
      soon: soonItems.length,
      normal: normalItems.length
    }
  };

  if (group_by === 'department') {
    const deptMap = new Map();
    for (const item of items) {
      const dept = item.department || '未分配';
      if (!deptMap.has(dept)) {
        deptMap.set(dept, {
          department: dept,
          total: 0,
          overdue: 0,
          urgent: 0,
          soon: 0,
          normal: 0,
          items: []
        });
      }
      const d = deptMap.get(dept);
      d.total++;
      d[item.urgency_level]++;
      d.items.push(item);
    }
    grouped.by_department = Array.from(deptMap.values());
  }

  if (group_by === 'person') {
    const personMap = new Map();
    for (const item of items) {
      const person = item.responsible_person || '未分配';
      if (!personMap.has(person)) {
        personMap.set(person, {
          responsible_person: person,
          department: item.department,
          total: 0,
          overdue: 0,
          urgent: 0,
          soon: 0,
          normal: 0,
          items: []
        });
      }
      const p = personMap.get(person);
      p.total++;
      p[item.urgency_level]++;
      p.items.push(item);
    }
    grouped.by_person = Array.from(personMap.values());
  }

  res.json({ data: grouped });
});

router.post('/:asset_id/resolve', (req, res) => {
  const { asset_id } = req.params;
  const { operator, action, remark, next_date, next_mileage } = req.body;

  const asset = get('SELECT * FROM assets WHERE id = ?', [asset_id]);
  if (!asset) {
    return res.status(404).json({
      error: '资产不存在',
      code: 'ASSET_NOT_FOUND'
    });
  }

  const validActions = ['scheduled', 'deferred', 'completed'];
  if (!action || !validActions.includes(action)) {
    return res.status(400).json({
      error: 'action 无效',
      detail: 'action 必须为 scheduled（已安排）、deferred（暂缓）、completed（已完成）',
      code: 'INVALID_ACTION'
    });
  }

  const nowStr = new Date().toISOString();
  const status = calcMaintenanceStatus(asset, nowStr);

  let updateFields = [];
  let updateParams = [];

  if (next_date) {
    updateFields.push('next_maintenance_date = ?');
    updateParams.push(next_date);
  }
  if (next_mileage) {
    updateFields.push('next_maintenance_mileage = ?');
    updateParams.push(next_mileage);
  }

  if (updateFields.length > 0) {
    updateFields.push(`updated_at = datetime('now')`);
    updateParams.push(asset_id);
    run(`UPDATE assets SET ${updateFields.join(', ')} WHERE id = ?`, updateParams);
  }

  let actionText = '';
  if (action === 'scheduled') actionText = '保养已安排';
  else if (action === 'deferred') actionText = '保养暂缓处理';
  else if (action === 'completed') actionText = '保养已完成';

  const detail = `${actionText}${remark ? '，备注: ' + remark : ''}${next_date ? '，下次保养日期: ' + next_date : ''}${next_mileage ? '，下次保养里程: ' + next_mileage : ''}`;

  addLog(asset_id, 'maintenance_todo', operator || 'system', detail);

  const updated = get('SELECT * FROM assets WHERE id = ?', [asset_id]);
  const newStatus = calcMaintenanceStatus(updated, nowStr);

  res.json({
    message: '处理结果已记录',
    data: {
      asset: updated,
      previous_urgency: status.level,
      new_urgency: newStatus.level,
      action: action
    }
  });
});

router.get('/:asset_id', (req, res) => {
  const { asset_id } = req.params;

  const asset = get('SELECT * FROM assets WHERE id = ?', [asset_id]);
  if (!asset) return res.status(404).json({ error: '资产不存在' });

  const records = all(
    'SELECT * FROM maintenance_records WHERE asset_id = ? ORDER BY created_at DESC',
    [asset_id]
  );

  const nowStr = new Date().toISOString();
  const status = calcMaintenanceStatus(asset, nowStr);

  res.json({
    data: records,
    maintenance_status: status
  });
});

module.exports = router;
