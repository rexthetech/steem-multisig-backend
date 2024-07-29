const mysql = require('mysql');
const config = require('./config');

const connection = mysql.createConnection(config);

connection.connect((err) => {
  if (err) {
    console.error('Error connecting to database:', err);
    return;
  }
  console.log('Connected to database!');
});

module.exports = connection;

