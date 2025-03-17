const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const dsteem = require('dsteem');

const db = require('./db');
const config = require('./config');

const app = express();
const port = process.env.PORT || 4000;

app.use(bodyParser.json());
app.use(cors({
    origin: config.clientUrl
}));

// Post digest comment
function PostDigest() {
  DeleteExpiredTransactions();
  console.log('\n--------------------------------------------------------------------------------\nRunning PostDigest() at ' + new Date() + '\n--------------------------------------------------------------------------------');

  if(!config.notificationEnabled) {
    console.log('Skipping notifications; disabled in config.js');
    return;
  }

  console.log('Checking for dirty txs...');
  db.query('SELECT * FROM partial_tx WHERE dirty = true', async (err, result) => {
    if (err) {
      console.error('!! Error fetching dirty txs:', err);
      return;
    }
    if (result.length == 0) {
      console.log('No dirty txs; nothing to do');
      return;
    }
    console.log(`Found ${result.length} dirty txs; generating notification...`);
    const client = new dsteem.Client(config.steemApiUrl);

    // Iterate over dirty txs building the post
    var body = '';
    for (var i = 0; i < result.length; i++) {      
      // Grab fields
      const partialTx = JSON.parse(result[i].partialTx);
      const proposer = result[i].proposer;
      const accountFrom = result[i].accountFrom;
      const accountTo = partialTx.operations[0][1].to;
      const amount = partialTx.operations[0][1].amount;
      const expiryDate = new Date(result[i].expiration);
      const signedBy = JSON.parse(result[i].signedBy);
      const weightThreshold = result[i].weightThreshold;
      const weightSigned = result[i].weightSigned;
      const expiryDateUTC = expiryDate.getUTCFullYear() + '-' + ('0' + (expiryDate.getUTCMonth()+1)).slice(-2) + '-' + ('0' + expiryDate.getUTCDate()).slice(-2) + ' ' + ('0' + expiryDate.getUTCHours()).slice(-2) + ':' + ('0' + expiryDate.getUTCMinutes()).slice(-2) + ':' + ('0' + expiryDate.getUTCSeconds()).slice(-2);
      
      // Grab account details for the multisig account      
      const accountFromUser = await client.database.getAccounts([accountFrom]);
      const active = accountFromUser[0].active.account_auths;

      // Build arrays of signed and unsigned users
      var signedAccounts = [];
      var unsignedAccounts = [];
      for (var j = 0; j < active.length; j++)
        if (signedBy.includes(active[j][0]))
          signedAccounts.push(active[j]);
        else
          unsignedAccounts.push(active[j]);

      // Generate body
      body += `### Open Transfer: ${amount} from @${accountFrom} to @${accountTo}\n`;
      body += `Proposed by @${proposer}.\nHas **${weightSigned}** of **${weightThreshold}** signing weight required to complete.\n`;
      body += `Expires at ${expiryDateUTC} UTC if uncompleted.\n\n`;

      // Now show the signed and unsigned accounts
      body += `**Signed by:** `;
      for (var j = 0; j < signedAccounts.length; j++) {
        body += `@${signedAccounts[j][0]} (weight ${signedAccounts[j][1]})`;
        if (j < signedAccounts.length - 1)
          body += ', ';
      }
      body += '\n\n';      
      body += `**Unsigned by:** `;
      for (var j = 0; j < unsignedAccounts.length; j++) {
        body += `@${unsignedAccounts[j][0]} (weight ${unsignedAccounts[j][1]})`;
        if (j < unsignedAccounts.length - 1)
          body += ', ';
      }
      body += '\n\n';
    }

    // Set dirty flag to false
    db.query('UPDATE partial_tx SET dirty = false', (err, result) => {
      if (err) {
        console.error("!! Error resetting dirty flag (refusing to post):", err);
        return;
      }
    });

    // Assemble notification post
    const title = result.length == 1 ? "Multisig Wizard Update" : "Multisig Wizard Update Digest";
    const tags = "multisig";
    const taglist = tags.split(' ');
    const json_metadata = JSON.stringify({ tags: taglist });
    const permlink = Math.random().toString(36).substring(2);

    // Broadcast it
    const privateKey = dsteem.PrivateKey.fromString(config.notificationPostingKey);
    client.broadcast.comment({
      "author": config.notificationAccount,
      "body": body,
      "json_metadata": json_metadata,
      "parent_author": '',
      "parent_permlink": taglist[0],
      "permlink": permlink,
      "title": title,
    }, privateKey).then(
      function(result) {
        console.log(`Notification included in block: ${result.block_num}. URL: https://steemit.com/${taglist[0]}/@${config.notificationAccount}/${permlink}`);
      },
      function(error) {
        console.error(`!! Error posting Steem notification: ${error}`);
      }
    );
  });
}

// Delete txs that are past expiry
function DeleteExpiredTransactions() {
  db.query('DELETE FROM partial_tx WHERE expiration < UTC_TIMESTAMP()', (err, result) => {
    if (err) {
      console.error('!! Error deleting expired partialTx:', err);
      return false;
    }
    if (result.affectedRows > 0)
      console.log(`** Deleted ${result.affectedRows} expired transactions`);
    return true;
  });
}

// Broadcast a completed tx
async function BroadcastTx(finalTx) {
  console.log('\n--------------------------------------------------------------------------------\nBroadcasting tx!\n--------------------------------------------------------------------------------');
  console.log("* Broadcast Tx: \n", finalTx);

  // Send the broadcast
  const client = new dsteem.Client(config.steemApiUrl);

  // Reformat above to use await
  try {
    const res = await client.broadcast.send(finalTx);
    console.log('Included in block: ' + res.block_num);

    return {
      'success': true,
      'message': "Transaction has been broadcast successfully. Included in block: " + res.block_num
    };
  } catch (err) {
    console.error(`!! Broadcast error: ${err}`);
    return {
      'success': false,
      'message': "Broadcast Error: " + err
    };
  }
}

// Add a sig to an existing partial tx
app.post('/addSig', async (req, res) => {
  DeleteExpiredTransactions();

  console.log('\n--------------------------------------------------------------------------------\nAdditional sig inbound!\n--------------------------------------------------------------------------------');
  //console.log("req.body: ", req.body);

  // Grab explicit fields
  const partialTx = req.body.partialTx;
  const authTx = req.body.authTx;
  const randomBytes = req.body.randomBytes;
  const signedBy = req.body.signedBy;
  const transactionId = req.body.transactionId;

  if (isNaN(transactionId)) {
    console.error('!! Bad transaction ID');
    res.status(500).send('Bad transaction ID');
    return;
  }

  // Grab tx and make sure it exists
  let alreadySignedBy = [];
  let weightSigned = 0;
  db.query('SELECT * FROM partial_tx WHERE id = ?', [transactionId], (err, result) => {
    if (err) {
      console.error('!! Error selecting partialTx:', err);
      res.status(500).send('Error getting partial transaction from database');
      return;
    }

    if (result.length == 0) {
      console.error('!! Transaction not found');
      res.status(500).send('Transaction not found');
      return;
    }

    // Grab fields
    alreadySignedBy = JSON.parse(result[0].signedBy);
    weightSigned = result[0].weightSigned;
  });

  // Signer already signed?
  if (alreadySignedBy.includes(signedBy[0])) {
    console.error('!! Signer already signed');
    res.status(500).send('This signatory has already signed this transaction');
    return;
  }

  // Pick out other stuff
  const signer = signedBy[0];
  const accountFrom = partialTx.operations[0][1].from;
  const partialExpiration = partialTx.expiration;
  const authExpiration = authTx.expiration;

  // Check auth TX: Correct signer?
  if (signer != authTx.operations[0][1].required_posting_auths[0]) {
    console.error('!! Bad authority in auth TX');
    res.status(500).send('Bad authority in auth TX; did you use the right active key?');
    return;
  }
  
  // Check auth TX: Expiries match?
  if (partialExpiration != authExpiration) {
    console.error('!! Bad expiry in auth TX');
    res.status(500).send('Bad expiry in auth TX');
    return;
  }

  // Check auth TX: Signed message body is correct?
  if (randomBytes != JSON.parse(authTx.operations[0][1].json).random_bytes) {
    console.error('!! Body mismatch in auth TX');
    res.status(500).send('Body mismatch in auth TX');
    return;
  }
  
  // Grab account details
  const client = new dsteem.Client(config.steemApiUrl);
  const accountFromUser = await client.database.getAccounts([accountFrom]);
  const signerUser = await client.database.getAccounts([signer]);

  // Signer doesn't exist?
  if (!signerUser[0]) {
    console.error('!! Signer account not found');
    res.status(500).send('Signer account not found');
    return;
  }

  // Signer is in active auth?
  const active = accountFromUser[0].active.account_auths;
  const weightThreshold = accountFromUser[0].active['weight_threshold'];
  console.log ("active: ", active);
  var found = false;
  var signerWeight = 0;
  var otherSigs = [];
  for (var i = 0; i < active.length; i++) {
    if (active[i][0] == signer) {
      signerWeight = active[i][1];
      found = true;
    } else {
      otherSigs.push(active[i]);
    }
  }
  if (!found) {
    console.error('!! Signer not found in multisig auth');
    res.status(500).send('Signer not found in multisig auth');
    return;
  }

  // Auth tx sig is OK?
  try {
    const authOK = await client.database.verifyAuthority(authTx);
  } catch (err) {
    console.error('!! Auth transaction is incorrectly signed');
    res.status(500).send('Auth transaction is incorrectly signed (did you use the correct active key?)');
    return;
  }

  // Validation looks good

  // Update weight
  const newWeightSigned = weightSigned + signerWeight;

  // Update alreadySignedBy
  alreadySignedBy.push(signer);

  // Update or broadcast the tx
  if (newWeightSigned >= weightThreshold) {
    console.log("Broadcasting tx #" + transactionId + ": " + alreadySignedBy.join(', '));
    broadcastResult = await BroadcastTx(partialTx);
    
    if (broadcastResult.success) {
      // Delete the tx from the DB
      db.query('DELETE FROM partial_tx WHERE id = ?', [transactionId], (err, result) => {
        if (err) {
          console.error('!! Error deleting partialTx:', err);
          return;
        }
        console.log(`Deleted partialTx with ID ${transactionId}`);
      });

      res.status(200).send("The multisig transaction has been completed and broadcast.");
    } else {
      res.status(500).send("Error broadcasting transaction: " + broadcastResult.message);
    }
  } else {
    // Not enough weight; update DB
    console.log("Updating tx #" + transactionId + " (" + newWeightSigned + " / " + weightThreshold + "): ", alreadySignedBy.join(', '));
    db.query('UPDATE partial_tx set signedBy = ?, partialTx = ?, weightSigned = ?, dirty = ? WHERE id = ?',
    [JSON.stringify(alreadySignedBy), JSON.stringify(partialTx), newWeightSigned, true, transactionId], (err, result) => {
      if (err) {
        console.error('!! Error updating partialTx:', err);
        res.status(500).send('Error updating partial transaction in database; please contact support');
        return;
      }
      console.log(`Updated partialTx with ID ${transactionId}`);
      res.status(200).send("You have signed this transaction. However, it still requires additional signatures to be broadcast.");
    });
  }
});

// Add a new partial tx
app.post('/partialTx', async (req, res) => {
  DeleteExpiredTransactions();

  console.log('\n--------------------------------------------------------------------------------\nPartial TX inbound!\n--------------------------------------------------------------------------------');
  
  // Grab explicit fields
  const partialTx = req.body.partialTx;
  const authTx = req.body.authTx;
  const randomBytes = req.body.randomBytes;
  const signedBy = req.body.signedBy;

  // Pick out other stuff
  const proposer = signedBy[0]; // Proposer is always first
  const accountFrom = partialTx.operations[0][1].from;
  const accountTo = partialTx.operations[0][1].to;
  const amount = partialTx.operations[0][1].amount;
  const expiration = partialTx.expiration;

  // Check auth TX: Signer is the same account as proposer?
  if (proposer != authTx.operations[0][1].required_posting_auths[0]) {
    console.error('!! Bad authority in auth TX');
    res.status(500).send('Bad authority in auth TX; did you use the right active key?');
    return;
  }

  // Check auth TX: Expiries match?
  if (expiration != authTx.expiration) {
    console.error('!! Bad expiry in auth TX');
    res.status(500).send('Bad expiry in auth TX');
    return;
  }
  
  // Check auth TX: Signed message body is correct?
  if (randomBytes != JSON.parse(authTx.operations[0][1].json).random_bytes) {
    console.error('!! Body mismatch in auth TX');
    res.status(500).send('Body mismatch in auth TX');
    return;
  }
  
  // Grab account details
  const client = new dsteem.Client(config.steemApiUrl);
  const accountFromUser = await client.database.getAccounts([accountFrom]);
  const accountToUser = await client.database.getAccounts([accountTo]);
  const proposerUser = await client.database.getAccounts([proposer]);

  // Anyone doesn't exist?
  if (!accountFromUser[0]) {
    console.error('!! Originating account not found');
    res.status(500).send('Originating account not found');
    return;
  }
  if (!accountToUser[0]) {
    console.error('!! Recipient account not found');
    res.status(500).send('Recipient account not found');
    return;
  }
  if (!proposerUser[0]) {
    console.error('!! Proposer account not found');
    res.status(500).send('Proposer account not found');
    return;
  }
  
  // Proposer is in active auth?
  const active = accountFromUser[0].active.account_auths;
  const weightThreshold = accountFromUser[0].active['weight_threshold'];
  console.log ("active: ", active);
  var found = false;
  var proposerWeight = 0;
  var otherSigs = [];
  for (var i = 0; i < active.length; i++) {
    if (active[i][0] == proposer) {
      proposerWeight = active[i][1];
      found = true;
    } else {
      otherSigs.push(active[i]);
    }
  }
  if (!found) {
    console.error('!! Proposer not found in multisig auth');
    res.status(500).send('Proposer not found in multisig auth');
    return;
  }

  // Alright, auth stuff looks ok, but is it signed?
  try {
    const authOK = await client.database.verifyAuthority(authTx);
  } catch (err) {
    console.error('!! Auth transaction is incorrectly signed');
    res.status(500).send('Auth transaction is incorrectly signed (did you use the correct active key?)');
    return;
  }

  // OK, validation looks good. Let's broadcast or insert it...
  if (proposerWeight >= weightThreshold) {
    broadcastResult = await BroadcastTx(partialTx);
   
    if (broadcastResult.success) {
      res.status(200).send("As your signature had sufficient weight to complete this transaction, it has been broadcast straight away.<br><br>" + broadcastResult);
    } else {
      res.status(500).send("Error broadcasting transaction: " + broadcastResult.message);
    }
  } else {
    // Not enough weight; insert into DB
    db.query('INSERT INTO partial_tx (proposer, accountFrom, expiration, signedBy, partialTx, weightThreshold, weightSigned, dirty) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [proposer, accountFrom, expiration, JSON.stringify(signedBy), JSON.stringify(partialTx), weightThreshold, proposerWeight, true], (err, result) => {
      if (err) {
        console.error('!! Error inserting partialTx:', err);
        res.status(500).send('Error inserting partial transaction into database; please contact support');
        return;
      }
      console.log(`Inserted partialTx with ID ${result.insertId}`);
      res.status(200).send("The partial transaction has been created and stored in the database. Please ask the other signatories to sign it.<br><br>They will be mentioned in an on-chain notification post in the next few minutes.<br><br><strong>Note that if the transaction is not signed within the next 60 minutes, it will expire;</strong> this is Steem blockchain protocol limitation.");
    });
  }
});

// Get current partial tx for given originating multisig account
app.get('/partialTx/:accountFrom', (req, res) => {
  DeleteExpiredTransactions();
  
  const accountFrom = req.params.accountFrom;
  db.query('SELECT * FROM partial_tx WHERE accountFrom = ?', [accountFrom], (err, results) => {
    if (err) {
      console.error('!! Error selecting partialTx:', err);
      res.status(500).send('Error getting partial transactions from database; please contact support');
      return;
    }
    res.status(200).send(results);
  });
});

// Entrypoint
app.listen(port, () => {
  console.log("================================================================================");
  console.log("Steem Multisig Wizard API Service");
  console.log("================================================================================");
  console.log(`Listening on port ${port}`);
  setTimeout(PostDigest, 4000);     // Wait a few secs for DB to connect then post digest
  setInterval(PostDigest, 360000);  // Post digest every 6 minutes
});
