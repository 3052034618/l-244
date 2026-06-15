const express = require('express');
const { run, get, all, addLog } = require('../db');

const router = express.Router();

const VALID_STATUSES = ['idle', 'in_use', 'maintenance', 'disposed'];

function hasActiveOccupation(assetId) {
  const now = new Date().toISOString();
  return get(`
    SELECT r.* FROM reservations r
    WHERE r.asset_id = ? AND r.status = 'approved'
    AND r.start_time <= ? AND r.end_time >= ?
  `, [assetId, now, now]);
}

function hasFutureApprovedReservations(assetId) {
  const now = new Date().toISOString();
  return get(`
    SELECT 1 FROM reservations r
    WHERE r.asset_id = ? AND r.status = 'approved'
    AND r.start_time > ?
  `, [assetId, now]);
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

router.put('/:id/status', (req, res) => {
  const { id } = req.params;
  const { status, operator, remark } = req.body;

  if (!status || !VALID_STATUSES.includes(status)) {
    return res.status(400).json({
      error: '状态无效',
      detail: `status 必须为 ${VALID_STATUSES.join(', ')} 之一`,
      code: 'INVALID_STATUS'
    });
  }

  const asset = get('SELECT * FROM assets WHERE id = ?', [id]);
  if (!asset) {
    return res.status(404).json({
      error: '资产不存在',
      code: 'ASSET_NOT_FOUND'
    });
  }

  const oldStatus = asset.status;
  if (oldStatus === status) {
    return res.status(400).json({
      error: '状态未变化',
      code: 'NO_STATUS_CHANGE'
    });
  }

  if (oldStatus === 'disposed') {
    return res.status(400).json({
      error: '已处置资产不可变更状态',
      code: 'ASSET_DISPOSED'
    });
  }

  const activeOccupation = hasActiveOccupation(id);

  if (status === 'idle') {
    if (activeOccupation) {
      return res.status(400).json({
        error: '存在生效占用',
        detail: `资产 ${asset.asset_code} 当前正在被使用（预约 ${activeOccupation.id}，${activeOccupation.start_time} ~ ${activeOccupation.end_time}），不能直接置为空闲`,
        code: 'ACTIVE_OCCUPATION_EXISTS',
        current_occupation: {
          reservation_id: activeOccupation.id,
          applicant: activeOccupation.applicant,
          start_time: activeOccupation.start_time,
          end_time: activeOccupation.end_time
        }
      });
    }

    const futureApproved = hasFutureApprovedReservations(id);
    if (futureApproved) {
      return res.status(400).json({
        error: '存在未来审批通过的预约',
        detail: '资产有已审批但未开始的预约，不能直接置为空闲，请先取消相关预约',
        code: 'FUTURE_APPROVED_EXISTS'
      });
    }
  }

  if (status === 'in_use') {
    if (oldStatus === 'maintenance') {
      return res.status(400).json({
        error: '保养中资产不可直接置为使用中',
        detail: '请先将资产状态改为 idle 后再处理',
        code: 'INVALID_TRANSITION'
      });
    }
  }

  let cancelledReservations = [];

  if (status === 'maintenance') {
    cancelledReservations = cancelPendingAndFutureReservations(
      id,
      `资产进入保养（${remark || '维护'}）`,
      operator
    );
  }

  if (status === 'disposed') {
    if (activeOccupation) {
      return res.status(400).json({
        error: '存在生效占用',
        detail: `资产 ${asset.asset_code} 当前正在被使用，请先归还再处置`,
        code: 'ACTIVE_OCCUPATION_EXISTS',
        current_occupation: {
          reservation_id: activeOccupation.id,
          applicant: activeOccupation.applicant
        }
      });
    }

    cancelledReservations = cancelPendingAndFutureReservations(
      id,
      `资产已${remark || '处置'}`,
      operator
    );
  }

  run(`UPDATE assets SET status = ?, updated_at = datetime('now') WHERE id = ?`, [status, id]);

  if (status !== 'maintenance' && status !== 'disposed') {
    updateAssetStatusByReservations(id);
  }

  let detail = `状态变更: ${oldStatus} -> ${status}${remark ? '，备注: ' + remark : ''}`;
  if (cancelledReservations.length > 0) {
    const pending = cancelledReservations.filter(r => r.status === 'pending').length;
    const approved = cancelledReservations.filter(r => r.status === 'approved').length;
    detail += `，已取消 ${pending} 个待审批、${approved} 个已通过预约`;
  }

  addLog(id, 'status_change', operator || 'system', detail);

  const updated = get('SELECT * FROM assets WHERE id = ?', [id]);

  res.json({
    message: '状态变更成功',
    data: updated,
    affected: {
      cancelled_reservations: cancelledReservations
    }
  });
});

module.exports = router;
