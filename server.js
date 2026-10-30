
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');

const app = express();
const db = new sqlite3.Database('./energia.db');

app.use(express.json());
app.use(cors());
app.use(express.static(__dirname));

// SQLite helpers
const dbRun = (sql, params = []) => new Promise((resolve, reject) => {
  db.run(sql, params, function (err) {
    err ? reject(err) : resolve(this);
  });
});

const dbGet = (sql, params = []) => new Promise((resolve, reject) => {
  db.get(sql, params, (err, row) =>
    err ? reject(err) : resolve(row)
  );
});

const dbAll = (sql, params = []) => new Promise((resolve, reject) => {
  db.all(sql, params, (err, rows) =>
    err ? reject(err) : resolve(rows)
  );
});

// Database initialization and migration
async function initializeDatabase() {
  await dbRun(`
    CREATE TABLE IF NOT EXISTS sensores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS dados (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      voltage REAL,
      current REAL,
      power REAL,
      energy REAL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const columns = await dbAll('PRAGMA table_info(dados)');
  const columnNames = columns.map(column => column.name);

  if (!columnNames.includes('sensor_id')) {
    await dbRun('ALTER TABLE dados ADD COLUMN sensor_id INTEGER');
  }

  if (!columnNames.includes('energy_kwh_interval')) {
    await dbRun('ALTER TABLE dados ADD COLUMN energy_kwh_interval REAL');
  }

  let defaultSensor = await dbGet(
    'SELECT id FROM sensores ORDER BY id LIMIT 1'
  );

  if (!defaultSensor) {
    const result = await dbRun(
      'INSERT INTO sensores (name) VALUES (?)',
      ['Sensor principal']
    );

    defaultSensor = { id: result.lastID };
  }

  // Preserve and associate existing historical readings.
  await dbRun(
    'UPDATE dados SET sensor_id = ? WHERE sensor_id IS NULL',
    [defaultSensor.id]
  );

  await dbRun(`
    CREATE INDEX IF NOT EXISTS idx_dados_sensor_date
    ON dados(sensor_id, created_at)
  `);
}

// ============================
// SENSOR MANAGEMENT
// ============================

// List sensors
app.get('/sensores', async (req, res) => {
  try {
    res.json(await dbAll(
      'SELECT id, name, created_at FROM sensores ORDER BY id'
    ));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create sensor
app.post('/sensores', async (req, res) => {
  const name = String(req.body.name || '').trim();

  if (!name) {
    return res.status(400).json({
      error: 'Informe um nome para o sensor.'
    });
  }

  try {
    const result = await dbRun(
      'INSERT INTO sensores (name) VALUES (?)',
      [name]
    );

    res.status(201).json({
      id: result.lastID,
      name
    });
  } catch (err) {
    res.status(
      err.code === 'SQLITE_CONSTRAINT' ? 409 : 500
    ).json({
      error: err.code === 'SQLITE_CONSTRAINT'
        ? 'Já existe um sensor com esse nome.'
        : err.message
    });
  }
});

// Rename sensor
app.patch('/sensores/:id', async (req, res) => {
  const name = String(req.body.name || '').trim();

  if (!name) {
    return res.status(400).json({
      error: 'Informe um nome para o sensor.'
    });
  }

  try {
    const result = await dbRun(
      'UPDATE sensores SET name = ? WHERE id = ?',
      [name, req.params.id]
    );

    if (!result.changes) {
      return res.status(404).json({
        error: 'Sensor não encontrado.'
      });
    }

    res.json({
      id: Number(req.params.id),
      name
    });
  } catch (err) {
    res.status(
      err.code === 'SQLITE_CONSTRAINT' ? 409 : 500
    ).json({
      error: err.code === 'SQLITE_CONSTRAINT'
        ? 'Já existe um sensor com esse nome.'
        : err.message
    });
  }
});

// Delete sensor only if it has no readings
app.delete('/sensores/:id', async (req, res) => {
  try {
    const count = await dbGet(
      'SELECT COUNT(*) AS total FROM dados WHERE sensor_id = ?',
      [req.params.id]
    );

    if (count.total > 0) {
      return res.status(409).json({
        error: 'Este sensor possui histórico. Renomeie-o em vez de excluí-lo.'
      });
    }

    const result = await dbRun(
      'DELETE FROM sensores WHERE id = ?',
      [req.params.id]
    );

    if (!result.changes) {
      return res.status(404).json({
        error: 'Sensor não encontrado.'
      });
    }

    res.json({ status: 'ok' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================
// ENERGY READINGS
// ============================

// Receive instantaneous power and optional interval energy.
// If interval energy is omitted, estimate it from consecutive
// power readings for the same sensor, up to a 10-minute gap.
app.post('/energia', async (req, res) => {
  const {
    voltage,
    current,
    power,
    sensorId,
    energyKwh
  } = req.body;

  if (
    voltage === undefined ||
    current === undefined ||
    power === undefined ||
    !Number.isFinite(Number(voltage)) ||
    !Number.isFinite(Number(current)) ||
    !Number.isFinite(Number(power))
  ) {
    return res.status(400).json({
      error: 'Envie voltage, current e power como números.'
    });
  }

  try {
    const selectedSensorId = Number(sensorId) || 1;

    const sensor = await dbGet(
      'SELECT id FROM sensores WHERE id = ?',
      [selectedSensorId]
    );

    if (!sensor) {
      return res.status(400).json({
        error: 'Sensor não encontrado. Envie um sensorId válido.'
      });
    }

    let intervalKwh = null;
    let energySource = 'not_calculated';

    if (
      energyKwh !== undefined &&
      energyKwh !== null &&
      energyKwh !== ''
    ) {
      intervalKwh = Number(energyKwh);

      if (!Number.isFinite(intervalKwh) || intervalKwh < 0) {
        return res.status(400).json({
          error: 'energyKwh deve ser um número não negativo em kWh.'
        });
      }

      energySource = 'provided';
    } else {
      const previous = await dbGet(
        `SELECT power, created_at
         FROM dados
         WHERE sensor_id = ?
         ORDER BY id DESC LIMIT 1`,
        [sensor.id]
      );

      if (previous && Number.isFinite(Number(previous.power))) {
        const previousDate = new Date(
          previous.created_at.replace(' ', 'T') + 'Z'
        );

        const elapsedHours =
          (Date.now() - previousDate.getTime()) / 3600000;

        if (elapsedHours > 0 && elapsedHours <= (10 / 60)) {
          intervalKwh =
            ((Number(previous.power) + Number(power)) / 2) *
            elapsedHours / 1000;

          energySource = 'estimated_from_power';
        }
      }
    }

    const result = await dbRun(
      `INSERT INTO dados
       (sensor_id, voltage, current, power, energy_kwh_interval)
       VALUES (?, ?, ?, ?, ?)`,
      [
        sensor.id,
        Number(voltage),
        Number(current),
        Number(power),
        intervalKwh
      ]
    );

    res.status(201).json({
      status: 'ok',
      id: result.lastID,
      sensorId: sensor.id,
      energyKwhInterval: intervalKwh,
      energySource
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Retrieve readings
app.get('/energia', async (req, res) => {
  const { inicio, fim, sensorId, limit } = req.query;

  let query = `
    SELECT d.*, s.name AS sensor_name
    FROM dados d
    LEFT JOIN sensores s ON s.id = d.sensor_id
    WHERE 1=1
  `;

  const params = [];

  if (inicio) {
    query += ' AND DATE(d.created_at) >= DATE(?)';
    params.push(inicio);
  }

  if (fim) {
    query += ' AND DATE(d.created_at) <= DATE(?)';
    params.push(fim);
  }

  if (sensorId) {
    query += ' AND d.sensor_id = ?';
    params.push(Number(sensorId));
  }

  query += ' ORDER BY d.created_at DESC LIMIT ?';

  params.push(
    Math.min(Math.max(Number(limit) || 1000, 1), 20000)
  );

  try {
    res.json(await dbAll(query, params));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================
// CONSUMPTION COMPARISON
// ============================

app.get('/comparacao', async (req, res) => {
  const {
    inicio,
    fim,
    sensorIds,
    periodo = 'day'
  } = req.query;

  const formats = {
    day: '%Y-%m-%d',
    week: '%Y-W%W',
    month: '%Y-%m'
  };

  if (!formats[periodo]) {
    return res.status(400).json({
      error: 'periodo deve ser day, week ou month.'
    });
  }

  if (!inicio || !fim) {
    return res.status(400).json({
      error: 'Informe inicio e fim.'
    });
  }

  let sensorFilter = '';
  const queryParams = [
    formats[periodo],
    inicio,
    fim
  ];

  if (sensorIds) {
    const ids = String(sensorIds)
      .split(',')
      .map(Number)
      .filter(Number.isInteger);

    if (ids.length) {
      sensorFilter = ` AND d.sensor_id IN (${ids.map(() => '?').join(',')})`;
      queryParams.push(...ids);
    }
  }

  queryParams.push(formats[periodo]);

  const sql = `
    SELECT
      strftime(?, d.created_at) AS periodo,
      d.sensor_id,
      s.name AS sensor_name,
      COALESCE(SUM(d.energy_kwh_interval), 0) AS consumption_kwh,
      COUNT(d.energy_kwh_interval) AS readings_with_energy
    FROM dados d
    JOIN sensores s ON s.id = d.sensor_id
    WHERE DATE(d.created_at) BETWEEN DATE(?) AND DATE(?)
    ${sensorFilter}
    GROUP BY strftime(?, d.created_at), d.sensor_id
    ORDER BY periodo, s.name
  `;

  try {
    res.json(await dbAll(sql, queryParams));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================
// START SERVER
// ============================

initializeDatabase()
  .then(() => {
    app.listen(3000, () => {
      console.log('Servidor rodando na porta 3000');
    });
  })
  .catch(err => {
    console.error('Erro ao inicializar banco de dados:', err);
    process.exit(1);
  });
