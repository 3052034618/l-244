const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { run, get, all, addLog } = require('../db');

const router = express.Router();

const uploadDir = path.join(__dirname, '..', '..', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  }
});
const upload = multer({ storage });

router.post('/', (req, res) => {
  const {
    asset_code, name, category, brand, model,
    department, responsible_person, purchase_date,
    purchase_price, current_value, mileage,
    next_maintenance_date, next_maintenance_mileage
  } = req.body;

  if (!asset_code || !name || !category) {
    return res.status(400).json({ error: 'asset_code、name、category 为必填项' });
  }

  const validCategories = ['vehicle', 'equipment'];
  if (!validCategories.includes(category)) {
    return res.status(400).json({ error: 'category 必须为 vehicle 或 equipment' });
  }

  const id = uuidv4();

  try {
    run(`
      INSERT INTO assets (id, asset_code, name, category, brand, model,
        department, responsible_person, purchase_date, purchase_price,
        current_value, mileage, next_maintenance_date, next_maintenance_mileage)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [id, asset_code, name, category, brand || null, model || null,
      department || null, responsible_person || null, purchase_date || null,
      purchase_price || null, current_value || null, mileage || 0,
      next_maintenance_date || null, next_maintenance_mileage || null]);

    addLog(id, 'create', responsible_person || 'system', `创建资产 ${asset_code}`);

    const asset = get('SELECT * FROM assets WHERE id = ?', [id]);
    res.status(201).json({ message: '资产创建成功', data: asset });
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE constraint')) {
      return res.status(409).json({ error: `资产编号 ${asset_code} 已存在` });
    }
    res.status(500).json({ error: '资产创建失败', detail: err.message });
  }
});

router.post('/:id/voucher', upload.single('file'), (req, res) => {
  const { id } = req.params;
  const { voucher_type, description, uploaded_by } = req.body;

  const asset = get('SELECT * FROM assets WHERE id = ?', [id]);
  if (!asset) return res.status(404).json({ error: '资产不存在' });

  if (!voucher_type) {
    return res.status(400).json({ error: 'voucher_type 为必填项' });
  }

  const voucherId = uuidv4();
  const file = req.file;

  run(`
    INSERT INTO vouchers (id, asset_id, voucher_type, file_name, file_path, description, uploaded_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [voucherId, id, voucher_type,
    file ? file.originalname : null,
    file ? file.filename : null,
    description || null,
    uploaded_by || null]);

  addLog(id, 'upload_voucher', uploaded_by || 'system', `上传凭证 ${voucher_type}`);

  const voucher = get('SELECT * FROM vouchers WHERE id = ?', [voucherId]);
  res.status(201).json({ message: '凭证上传成功', data: voucher });
});

router.get('/available', (req, res) => {
  const { category, department, start_time, end_time } = req.query;

  let sql = 'SELECT * FROM assets WHERE status = ?';
  const params = ['idle'];

  if (category) { sql += ' AND category = ?'; params.push(category); }
  if (department) { sql += ' AND department = ?'; params.push(department); }

  let assets = all(sql, params);

  if (start_time && end_time) {
    assets = assets.filter(asset => {
      const conflict = get(`
        SELECT 1 FROM reservations
        WHERE asset_id = ? AND status IN ('pending', 'approved')
        AND start_time < ? AND end_time > ?
      `, [asset.id, end_time, start_time]);
      return !conflict;
    });
  }

  res.json({ data: assets });
});

router.get('/:id', (req, res) => {
  const asset = get('SELECT * FROM assets WHERE id = ?', [req.params.id]);
  if (!asset) return res.status(404).json({ error: '资产不存在' });
  res.json({ data: asset });
});

router.get('/', (req, res) => {
  const { category, department, status, responsible_person } = req.query;

  let sql = 'SELECT * FROM assets WHERE 1=1';
  const params = [];

  if (category) { sql += ' AND category = ?'; params.push(category); }
  if (department) { sql += ' AND department = ?'; params.push(department); }
  if (status) { sql += ' AND status = ?'; params.push(status); }
  if (responsible_person) { sql += ' AND responsible_person = ?'; params.push(responsible_person); }

  sql += ' ORDER BY created_at DESC';

  const assets = all(sql, params);
  res.json({ data: assets });
});

module.exports = router;
