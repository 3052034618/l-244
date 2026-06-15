const express = require('express');
const { run, get, addLog } = require('../db');

const router = express.Router();

const VALID_STATUSES = ['idle', 'in_use', 'maintenance', 'disposed'];

router.put('/:id/status', (req, res) => {
  const { id } = req.params;
  const { status, operator, remark } = req.body;

  if (!status || !VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status 必须为 ${VALID_STATUSES.join(', ')} 之一` });
  }

  const asset = get('SELECT * FROM assets WHERE id = ?', [id]);
  if (!asset) return res.status(404).json({ error: '资产不存在' });

  const oldStatus = asset.status;
  if (oldStatus === status) {
    return res.status(400).json({ error: '状态未变化' });
  }

  if (oldStatus === 'disposed') {
    return res.status(400).json({ error: '已处置资产不可变更状态' });
  }

  run(`UPDATE assets SET status = ?, updated_at = datetime('now') WHERE id = ?`, [status, id]);

  addLog(id, 'status_change', operator || 'system',
    `状态变更: ${oldStatus} -> ${status}${remark ? '，备注: ' + remark : ''}`);

  const updated = get('SELECT * FROM assets WHERE id = ?', [id]);
  res.json({ message: '状态变更成功', data: updated });
});

module.exports = router;
