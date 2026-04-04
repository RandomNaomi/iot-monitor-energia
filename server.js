const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const app = express();


app.use(express.json());
app.use(require('cors')());

const db = new sqlite3.Database('./energia.db');

// Criar tabela
db.run(`
CREATE TABLE IF NOT EXISTS dados (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  voltage REAL,
  current REAL,
  power REAL,
  energy REAL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)
`);

// Receber dados do ESP32
app.post('/energia', (req, res) => {
  const { voltage, current, power, energy } = req.body;

  db.run(
    `INSERT INTO dados (voltage, current, power, energy) VALUES (?, ?, ?, ?)`,
    [voltage, current, power, energy]
  );

  res.json({ status: 'ok' });
});

// Buscar dados
app.get('/energia', (req, res) => {
  const { inicio, fim } = req.query;

  let query = `SELECT * FROM dados`;
  let params = [];

  if (inicio && fim) {
    query += ` WHERE DATE(created_at) BETWEEN ? AND ?`;
    params.push(inicio, fim);
  }

  query += ` ORDER BY created_at DESC LIMIT 100`;

  db.all(query, params, (err, rows) => {
    res.json(rows);
  });
});

app.listen(3000, () => console.log('Servidor rodando na porta 3000'));

setInterval(() => {
  location.reload();
}, 6000);
