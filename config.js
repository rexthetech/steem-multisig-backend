module.exports = {
  // DB creds
  host: 'localhost',
  user: 'steem-multisig',
  password: 'xxxxxxxxxxxxxx',
  database: 'steem-multisig',

  // CORS permitted domain
  clientUrl: 'http://localhost:5173',

  // Steem API endpoint
  steemApiUrl: 'https://api.pennsif.net',

  // Steem deets for notification account
  notificationEnabled: false,
  notificationAccount: 'multisignotifier',
  notificationPostingKey: '5xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'  // notificationAccount's Private Posting Key
};
