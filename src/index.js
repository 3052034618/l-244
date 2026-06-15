const express = require('express');
const { initDatabase, saveDb } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/api/assets', require('./routes/assets'));
app.use('/api/assets', require('./routes/status'));
app.use('/api/reservations', require('./routes/reservations'));
app.use('/api/maintenance', require('./routes/maintenance'));
app.use('/api/disposals', require('./routes/disposals'));
app.use('/api/stats', require('./routes/stats'));

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use((err, req, res, _next) => {
  console.error(err.stack);
  if (err.name === 'MulterError') {
    return res.status(400).json({ error: '文件上传失败', detail: err.message });
  }
  res.status(500).json({ error: '服务内部错误' });
});

app.use((req, res) => {
  res.status(404).json({ error: '接口不存在' });
});

async function start() {
  await initDatabase();

  process.on('SIGINT', () => {
    saveDb();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    saveDb();
    process.exit(0);
  });

  app.listen(PORT, () => {
    console.log(`企业资产管理服务已启动: http://localhost:${PORT}`);
    console.log(`接口概览:`);
    console.log(`  [资产登记] POST   /api/assets            - 按编号创建资产`);
    console.log(`             POST   /api/assets/:id/voucher - 上传凭证信息`);
    console.log(`             GET    /api/assets/available   - 查询可用资源`);
    console.log(`             GET    /api/assets             - 资产列表`);
    console.log(`             GET    /api/assets/:id         - 资产详情`);
    console.log(`  [状态变更] PUT    /api/assets/:id/status   - 变更资产状态`);
    console.log(`  [预约占用] POST   /api/reservations        - 提交预约`);
    console.log(`             PUT    /api/reservations/:id/approve - 审批占用`);
    console.log(`             PUT    /api/reservations/:id/return  - 登记归还`);
    console.log(`             GET    /api/reservations        - 预约列表`);
    console.log(`  [保养提醒] POST   /api/maintenance         - 记录保养里程`);
    console.log(`             GET    /api/maintenance/reminders  - 到期提醒`);
    console.log(`             GET    /api/maintenance/:asset_id  - 保养记录`);
    console.log(`  [处置申请] POST   /api/disposals           - 发起报废/转让`);
    console.log(`             PUT    /api/disposals/:id/approve  - 审批处置`);
    console.log(`             GET    /api/disposals           - 处置列表`);
    console.log(`  [统计查询] GET    /api/stats/department-occupancy - 部门占用率`);
    console.log(`             GET    /api/stats/person-assets       - 人员追踪`);
    console.log(`             GET    /api/stats/asset-logs          - 资产流水`);
  });
}

start().catch(err => {
  console.error('服务启动失败:', err);
  process.exit(1);
});
